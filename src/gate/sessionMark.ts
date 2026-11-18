// The session route (CLAS-06, D-31): the context every model request runs inside, read at the one place content leaves for a model
// (NearAiClient.request). It follows withSpendTag (src/services/spendLedger.ts): an AsyncLocalStorage carries the route of the run, the sub-agent, the
// attachment read or the participant turn that made the request, so parallel sessions each read their own. No vscode import.
//
// A route names the session's mark (an empty mark means the policy's default label), the policy it is decided by, who is acting, and where its records go.
// A request made outside any route is decided with the default route (setDefaultSessionRoute), which the gate's activation sets; with none set, the route is
// failed closed, which routes the default label exactly as today and keeps anything labelled on this computer (D-53).
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { SHIPPED_DEFAULT_LABEL, failedClosed } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import type { ActorRef, DecisionSink, GateRuntime } from '../domain/gate/decide';
import type { Mark } from '../domain/gate/dominance';
import { labelKey } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { buildDecisionRecord } from '../domain/gate/record';
import type { DecisionRecord } from '../domain/gate/record';
import { routingWhileFailedClosed, tierForLabel } from '../domain/gate/routing';
import type { RouteDecision, RouteEventId, RouteFacts, RoutingTable } from '../domain/gate/routing';
import type { InferTier } from '../domain/gate/vocabulary';

/**
 * Shared by a chat and every route it builds, so a failed answer check stops attested-cloud for the chat and its helpers alike (D-55). `closed` is set when
 * the chat is closed or replaced: a check that settles after that sets nothing on it.
 */
export interface RouteAttestation {
  failed: boolean;
  closed?: boolean;
}

/**
 * What an answer check found: every field the chat shows and keeps, declared here so the gate side never casts (this folder imports nothing from services;
 * the client's VerificationResult has exactly this shape).
 */
export interface AnswerCheckResult {
  readonly outcome: 'signed' | 'failed' | 'unavailable';
  readonly summary: string;
  readonly signingAddress?: string;
  readonly signer?: 'model' | 'gateway';
  readonly checks: Readonly<Record<string, boolean | undefined>>;
  readonly notChecked: readonly string[];
  /** The signed text and signature NEAR AI returned, when it did (Show full attestation, CLAS-08). */
  readonly signed?: { readonly text: string; readonly signature: string };
  /** The attestation report the check verified or reused, in memory only (Show full attestation, CLAS-08). */
  readonly report?: unknown;
}

/** The hashes an answer check works from (the client's ResponseEvidence): no prompt or answer text. */
export interface AnswerEvidence {
  readonly chatId: string;
  readonly requestHash: string;
  readonly responseHash: string;
}

/** What the client tells a route when the check after one of its answers settles: the answer's chat id, the result, and what was checked. */
export type AnswerCheckListener = (chatId: string, result: AnswerCheckResult, checked: { readonly model: string; readonly evidence: AnswerEvidence }) => void;

export interface SessionRoute {
  /** The session's mark now. An empty mark means the policy's default label. */
  readonly markOf: () => Mark;
  /** The policy the route is decided by, read at each decision. */
  readonly bundleState: () => BundleState;
  readonly actor: ActorRef;
  /** Where the route's records go. None means the decisions are made and not recorded. */
  readonly sink?: DecisionSink;
  readonly clock?: () => number;
  readonly newRecordId?: () => string;
  readonly productVersion?: string;
  readonly attestation: RouteAttestation;
  /** Told when the check after an answer at attested-cloud settles (D-36). Never awaited by a request. */
  readonly onAnswerChecked?: AnswerCheckListener;
}

/** The empty mark: the session has read nothing above the policy's default label. */
const EMPTY_MARK: Mark = Object.freeze([]);

/**
 * The route of one run, from its gate runtime: the runtime's policy, actor, sink and clock. `markOf` defaults to the empty mark (the default label);
 * plan 22 gives a chat's runs the chat's mark. `attestation` is the chat's shared object, so a sub-agent and its parent share one route state.
 */
export function sessionRouteFrom(runtime: GateRuntime, options: { markOf?: () => Mark; attestation?: RouteAttestation; onAnswerChecked?: AnswerCheckListener } = {}): SessionRoute {
  return {
    markOf: options.markOf ?? (() => EMPTY_MARK),
    bundleState: runtime.bundleState,
    actor: runtime.actor,
    sink: runtime.sink,
    ...(runtime.clock === undefined ? {} : { clock: runtime.clock }),
    ...(runtime.newRecordId === undefined ? {} : { newRecordId: runtime.newRecordId }),
    ...(runtime.productVersion === undefined ? {} : { productVersion: runtime.productVersion }),
    attestation: options.attestation ?? { failed: false },
    ...(options.onAnswerChecked === undefined ? {} : { onAnswerChecked: options.onAnswerChecked })
  };
}

/** The policy a route reads now, or a failed-closed one when it cannot be read: a state that throws is never treated as valid. */
export function bundleStateOf(route: SessionRoute): BundleState {
  try {
    return route.bundleState();
  } catch {
    return failedClosed('unavailable', 'The policy could not be read for this request.');
  }
}

/**
 * The routing table and default label a route is decided by: the policy's own while it is valid; while it is failed closed, the shipped table with every
 * tier above any-cloud raised to local-only and the shipped default label (D-53), so a broken policy never sends labelled content off this computer.
 */
export function routingOf(route: SessionRoute): { readonly routing: RoutingTable; readonly defaultLabel: Label; readonly bundleHash: string } {
  const state = bundleStateOf(route);
  if (state.state === 'valid') return { routing: state.bundle.routing, defaultLabel: state.bundle.defaultLabel, bundleHash: state.hash };
  return { routing: routingWhileFailedClosed(), defaultLabel: SHIPPED_DEFAULT_LABEL, bundleHash: '' };
}

const routes = new AsyncLocalStorage<SessionRoute>();

/** Runs `work` inside `route`; every model request it makes, however deep, is decided and recorded with it. */
export function withSessionRoute<T>(route: SessionRoute, work: () => T): T {
  return routes.run(route, work);
}

/** The route of the work running now, or undefined outside every route. */
export function currentSessionRoute(): SessionRoute | undefined {
  return routes.getStore();
}

/** The route of a window with no gate host: failed closed (no policy is known), recorded nowhere, a person with no session. */
const NO_HOST_ROUTE: SessionRoute = Object.freeze({
  markOf: () => EMPTY_MARK,
  bundleState: () => failedClosed('unavailable', 'No gate host has started in this window.'),
  actor: Object.freeze({ kind: 'person', deviceFingerprint: 'device-unknown', sessionId: 'no-session' }) as ActorRef,
  attestation: { failed: false }
});

let fallback: SessionRoute | undefined;

/**
 * Sets (or, with undefined, clears) the route a request outside every route is decided with. The gate's activation sets the host's and disposes the returned
 * function at deactivation (PR 4a review). The function clears the route only while it is still the one set, so a host that was replaced never clears its
 * replacement's.
 */
export function setDefaultSessionRoute(route: SessionRoute | undefined): () => void {
  fallback = route;
  return () => { if (fallback === route) fallback = undefined; };
}

/** The route a request outside every route is decided with: the one the activation set, or a failed-closed route that records nowhere. */
export function defaultSessionRoute(): SessionRoute {
  return fallback ?? NO_HOST_ROUTE;
}

// ---- The record of a model request (GATE-07, D-20, D-52) ----

/** The rules of a routine allowed request, whose record is the short one: no reason, no tier beside the capability's, and no label at the default mark. */
const ROUTINE_RULES: ReadonlySet<string> = new Set(['route.any-cloud', 'route.default-session']);
const UNKNOWN_PRODUCT_VERSION = '0.0.0';
const UNKNOWN_MODEL = 'unknown-model';
/** The request id of a short record: the model request has no id of its own before it is sent, and the record id already identifies the record. */
const SHORT_CALL_ID = 'infer';

/** What the request was, beside the decision and its facts. */
export interface RouteRequest {
  /** The model id the request names; absent for a request that names none. */
  readonly model?: string;
}

/**
 * The name a record keeps for a model id: the id itself, except that an id that is a path or an address (a local runtime may name a model by its file) is
 * kept as its last part, so a record never carries a host, a URL or a folder of this computer (D-52).
 */
export function recordedModelName(id: string | undefined): string {
  const text = (id ?? '').trim();
  if (text === '') return UNKNOWN_MODEL;
  const looksLikePlace = text.includes('://') || text.includes('\\') || text.startsWith('/') || text.startsWith('~') || /^[A-Za-z]:/.test(text);
  if (!looksLikePlace) return text.slice(0, 128);
  const last = text.split(/[\\/]/).filter((part) => part !== '').pop() ?? '';
  return (last === '' || last.includes(':') ? UNKNOWN_MODEL : last).slice(0, 128);
}

/** True when the mark says no more than the policy's default label: empty, or exactly that one label. */
export function isDefaultMark(mark: Mark, defaultLabel: Label): boolean {
  return mark.length === 0 || (mark.length === 1 && mark[0] !== undefined && labelKey(mark[0]) === labelKey(defaultLabel)
    && mark[0].compartments.length === 0 && mark[0].releasability.length === 0 && mark[0].handling.length === 0);
}

/**
 * The label that decided a refusal: the policy's default label when the mark is empty (nothing raised it), otherwise the first label of the mark whose own
 * tier is the decision's tier. Undefined when none can be named, which only a routing table that cannot be read leaves.
 */
function decidingLabel(mark: Mark, routing: RoutingTable, defaultLabel: Label, tier: RouteDecision['tier']): Label | undefined {
  if (mark.length === 0) return defaultLabel;
  try {
    return mark.find((label) => tierForLabel(label, routing) === tier);
  } catch {
    return undefined;
  }
}

export interface RouteRecordContext {
  readonly mark: Mark;
  readonly defaultLabel: Label;
  readonly bundleHash: string;
  /** The routing the decision used, to name the label that decided a refusal. */
  readonly routing: RoutingTable;
  /** True when the route could not be worked out at all: refused with a fixed reason, and no label decided it. */
  readonly checkFailed?: boolean;
}

/**
 * The infer record of one model request, built the way a tool call's record is (product version, clock and record id from the route): the capability
 * `infer` with the tier, provider and model, the model as the resource, the outcome and the rule, the policy's hash. A routine allowed request (route.any-cloud,
 * or route.default-session outside every route) gets the short record: no reason, the model and the policy's hash written once each, and, while the mark is
 * the default label, no label. The connection state is kept only when the tier read it (attested-cloud). Never a host, a URL, a path or a fingerprint: the facts' host and binding fingerprint are not read here.
 */
export function routeRecordFor(route: SessionRoute, decision: RouteDecision, facts: RouteFacts, request: RouteRequest, context: RouteRecordContext): DecisionRecord {
  const recordId = (route.newRecordId ?? randomUUID)();
  const provider = facts.clientRoute === 'local' ? 'local' : facts.clientRoute === 'near' ? 'near-ai' : 'unknown';
  const model = recordedModelName(request.model);
  // `deny` is a decision, not a tier a request can ask for: the capability names the strictest requestable tier, and the record's tier says deny.
  const asked: InferTier = decision.tier === 'deny' ? 'local-only' : decision.tier;
  const routine = decision.allowed && ROUTINE_RULES.has(decision.rule);
  const marked = !isDefaultMark(context.mark, context.defaultLabel);
  // A refusal always names the label that decided it (PR 4a review), the default label included; a route that could not be worked out names none.
  const decided = decision.allowed || context.checkFailed === true ? undefined : decidingLabel(context.mark, context.routing, context.defaultLabel, decision.tier);
  return buildDecisionRecord({
    recordId,
    // The log numbers each line as it writes it; this is replaced there.
    sequence: 0,
    time: clockOf(route),
    productVersion: route.productVersion ?? UNKNOWN_PRODUCT_VERSION,
    actor: route.actor,
    // The short record names the model and provider once, in the capability (owner decision after PR 4a's measurement): no agent model entry, no
    // resource entry, no policy uid beside the bundle hash, and no request id that only repeats the record id.
    ...(routine ? {} : { model: { name: model, provider } }),
    callId: routine ? SHORT_CALL_ID : `infer-${recordId}`,
    capability: { verb: 'infer', tier: asked, provider, model },
    resource: { name: model, type: 'model' },
    ...(routine ? { short: true } : {}),
    outcome: decision.allowed ? 'allowed' : 'denied',
    rule: decision.rule,
    ...(decision.reason === undefined || routine ? {} : { reason: decision.reason }),
    bundleHash: context.bundleHash,
    ...(routine || decision.tier === asked ? {} : { tier: decision.tier }),
    ...(decided === undefined ? {} : { label: decided }),
    ...(marked ? { mark: context.mark } : {}),
    ...(decision.tier === 'attested-cloud' ? { connection: facts.binding?.state ?? 'unknown' } : {})
  });
}

/** The fixed reason of each answer-check record: plain words, never a signing address, a report or a fingerprint. */
const ANSWER_CHECK_REASONS: Readonly<Record<'verified' | 'failed' | 'unavailable', string>> = Object.freeze({
  verified: 'The answer\'s signature and NEAR AI Cloud\'s attestation were checked after the answer and verified.',
  failed: 'The answer\'s signature or NEAR AI Cloud\'s attestation did not check out, so NEAR AI Cloud\'s models do not count as private for this chat until Check again passes.',
  unavailable: 'The answer\'s signature and attestation could not be checked (for example offline), so nothing changed.'
});

/**
 * The record of an event about a session's routing (GATE-07): `route.attestation-checked` when the check after an answer at attested-cloud settles, and
 * `route.attestation-cleared` when a person's Check again clears a failed one. The capability is `infer` at attested-cloud on NEAR AI Cloud with the
 * model; `attestation` says what was found. Never a host, a signing address, a report or a fingerprint.
 */
export function routeEventRecordFor(route: SessionRoute, event: RouteEventId, request: { readonly model?: string; readonly attestation: 'verified' | 'failed' | 'unavailable' }): DecisionRecord {
  const recordId = (route.newRecordId ?? randomUUID)();
  const model = recordedModelName(request.model);
  let bundleHash = '';
  try { bundleHash = routingOf(route).bundleHash; } catch { /* no policy hash then */ }
  const mark = (() => { try { return route.markOf(); } catch { return EMPTY_MARK; } })();
  return buildDecisionRecord({
    recordId,
    sequence: 0,
    time: clockOf(route),
    productVersion: route.productVersion ?? UNKNOWN_PRODUCT_VERSION,
    actor: route.actor,
    model: { name: model, provider: 'near-ai' },
    callId: `${event}-${recordId}`,
    capability: { verb: 'infer', tier: 'attested-cloud', provider: 'near-ai', model },
    resource: { name: model, type: 'model' },
    outcome: 'allowed',
    rule: event,
    reason: event === 'route.attestation-cleared' ? 'A person\'s Check again passed, so NEAR AI Cloud\'s models count as private for this chat again.' : ANSWER_CHECK_REASONS[request.attestation],
    bundleHash,
    ...(mark.length === 0 ? {} : { mark }),
    attestation: request.attestation
  });
}

function clockOf(route: SessionRoute): number {
  try {
    const now = route.clock?.();
    if (typeof now === 'number' && Number.isFinite(now)) return Math.floor(now);
  } catch { /* the system clock below */ }
  return Date.now();
}
