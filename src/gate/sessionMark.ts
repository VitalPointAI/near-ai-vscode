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
import type { CheckRecordFamilies, DecisionRecord, PolicyRecordVersion } from '../domain/gate/record';
import { ROUTE_REFUSALS, notAccreditedText, routingWhileFailedClosed, thisComputerOnlyLabelOf, tierForLabel } from '../domain/gate/routing';
import { labelKeyShown } from '../domain/gate/labelAlgebra';
import type { RouteDecision, RouteEventId, RouteFacts, RoutePolicy, RoutingTable, VerifiedAuthorization } from '../domain/gate/routing';
import { verifyAuthorization } from '../domain/gate/authorizations';
import type { BundleIssuer } from '../domain/gate/bundle';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import type { PolicyLayersView } from './organizationStore';
import { clearancesInForce } from './clearances';
import type { ClearanceWalletView } from './clearances';
import type { InferTier } from '../domain/gate/vocabulary';
import type { ReevaluationTrigger, UseTier } from '../domain/gate/models';
import { passportTriggeredText } from '../domain/gate/passportStep';
import { raiseUseTier, useTierFor } from '../domain/gate/useTier';
import type { UseInput } from '../domain/gate/useTier';
import { recordLaneOf } from '../domain/gate/researchLane';

/**
 * Shared by a chat and every route it builds, so a failed answer check stops attested-cloud for the chat and its helpers alike (D-55). `closed` is set when
 * the chat is closed or replaced: a check that settles after that sets nothing on it.
 */
export interface RouteAttestation {
  failed: boolean;
  closed?: boolean;
  /** Set once this chat has said, and recorded, that classified work runs on a computer not recorded as accredited (coherence review S2): once per chat. */
  notAccreditedTold?: boolean;
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
  /** Shows a chat notice (coherence review S2). Never awaited, and a notice that cannot be shown never changes a request. */
  readonly onNotice?: (text: string) => void;
  /** The effective policy's inputs to each request's route decision, from the route's own host (GateRuntime.routePolicy, D-36). */
  readonly routePolicy?: GateRuntime['routePolicy'];
  /**
   * The local facts of the session's use (74.1 D-13): its tools, writes, checking job, lane, project and feature. Read at each request; the route's mark
   * is added by the client. Absent: chat you review, raised only by the mark.
   */
  readonly useOf?: () => UseInput;
  /** A checking route's families (74.1 D-19, D-23): the writers' and the checker's, which every record of the route names. */
  readonly checkFamilies?: CheckRecordFamilies;
}

/** The empty mark: the session has read nothing above the policy's default label. */
const EMPTY_MARK: Mark = Object.freeze([]);

/**
 * The route of one run, from its gate runtime: the runtime's policy, actor, sink and clock. `markOf` defaults to the empty mark (the default label);
 * plan 22 gives a chat's runs the chat's mark. `attestation` is the chat's shared object, so a sub-agent and its parent share one route state.
 */
export function sessionRouteFrom(
  runtime: GateRuntime,
  options: { markOf?: () => Mark; attestation?: RouteAttestation; onAnswerChecked?: AnswerCheckListener; onNotice?: (text: string) => void; use?: UseInput | (() => UseInput); parent?: SessionRoute; checkFamilies?: CheckRecordFamilies } = {}
): SessionRoute {
  // 74.1 D-13: the runtime's context and the project's facts, then the caller's own facts, which can only add to them (useTierFor takes the highest row).
  const own = options.use;
  const project = runtime.project?.kind === undefined ? {} : { project: { kind: runtime.project.kind, ...(runtime.project.exercise === true ? { exercise: true } : {}) } };
  const route: SessionRoute = {
    markOf: options.markOf ?? (() => EMPTY_MARK),
    bundleState: runtime.bundleState,
    actor: runtime.actor,
    sink: runtime.sink,
    ...(runtime.clock === undefined ? {} : { clock: runtime.clock }),
    ...(runtime.newRecordId === undefined ? {} : { newRecordId: runtime.newRecordId }),
    ...(runtime.productVersion === undefined ? {} : { productVersion: runtime.productVersion }),
    ...(runtime.routePolicy === undefined ? {} : { routePolicy: runtime.routePolicy }),
    attestation: options.attestation ?? { failed: false },
    ...(options.onAnswerChecked === undefined ? {} : { onAnswerChecked: options.onAnswerChecked }),
    ...(options.onNotice === undefined ? {} : { onNotice: options.onNotice }),
    useOf: () => ({ context: runtime.context, ...project, ...(typeof own === 'function' ? own() : own ?? {}) }),
    ...(options.checkFamilies === undefined ? {} : { checkFamilies: options.checkFamilies })
  };
  // A sub-agent's route starts at the use its parent is at now: the highest it has asked for, or what its own facts give.
  if (options.parent !== undefined) raiseSessionUse(route, parentUse(options.parent));
  return route;
}

/** The use a parent route passes to a child: its high-water raised by what its own facts and mark give now; operational work if they cannot be read. */
function parentUse(parent: SessionRoute): UseTier {
  const held = useHighWater.get(parent) ?? 'T0';
  try {
    const own = parent.useOf?.() ?? {};
    const mark = parent.markOf().map((label) => ({ scale: label.scale, level: label.level }));
    return raiseUseTier(held, useTierFor({ ...own, mark: [...(own.mark ?? []), ...mark] }));
  } catch {
    return 'T3';
  }
}

// ---- The use of a session (74.1 D-13) ----

/** The highest use each route has asked for, kept on the route object itself: a session's use only rises, so a later request never checks lower. */
const useHighWater = new WeakMap<SessionRoute, UseTier>();

/** Raises `route`'s use to at least `use` and returns the use its next request is checked at: the higher of the two. */
export function raiseSessionUse(route: SessionRoute, use: UseTier): UseTier {
  const held = useHighWater.get(route);
  const raised = held === undefined ? use : raiseUseTier(held, use);
  useHighWater.set(route, raised);
  return raised;
}

/** The highest use `route` has asked for so far, or undefined before its first request. A sub-agent's route starts at its parent's (74.1-03). */
export function sessionUseOf(route: SessionRoute): UseTier | undefined {
  return useHighWater.get(route);
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

/**
 * Runs `work` as a checking job (74.1 D-16, D-19): in a route that is the current one (or the default one outside every route) with `checkingJob: true`
 * added to its use facts, starting at the use the current route is at. A checker's requests are then checked as agent work and, under enforce, need your
 * organization's evaluation of the checking model.
 */
export function withCheckingJob<T>(work: () => T): T {
  const parent = currentSessionRoute() ?? defaultSessionRoute();
  const route: SessionRoute = { ...parent, useOf: () => ({ ...(parent.useOf?.() ?? {}), checkingJob: true }) };
  const held = useHighWater.get(parent);
  if (held !== undefined) raiseSessionUse(route, held);
  return withSessionRoute(route, work);
}

// ---- The private floor (coherence review S4) ----

const privateOnly = new AsyncLocalStorage<boolean>();
let privateOnlySetting: (() => boolean) | undefined;

/**
 * Runs `work` with the private floor on: every model request it makes, however deep, counts as private only when the gate's own check passes (a model on
 * this computer, or a private model on NEAR AI Cloud over a connection proven to end inside its private hardware). A private team or member runs this way.
 * Nesting never turns the floor off.
 */
export function withPrivateOnly<T>(work: () => T): T {
  return privateOnly.run(true, work);
}

/**
 * Sets (or clears) the setting that turns the floor on for every request (nearAi.privacyMode tee-only). The returned function clears it only while it is
 * still the one set.
 */
export function setPrivateOnlySetting(read: (() => boolean) | undefined): () => void {
  privateOnlySetting = read;
  return () => { if (privateOnlySetting === read) privateOnlySetting = undefined; };
}

/** True when the request running now must use verified private hardware or this computer. A setting that cannot be read leaves the floor on (fail closed). */
export function privateOnlyNow(): boolean {
  if (privateOnly.getStore() === true) return true;
  if (privateOnlySetting === undefined) return false;
  try {
    return privateOnlySetting() === true;
  } catch {
    return true;
  }
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

// ---- The effective policy of a route (FND-03 to FND-06, D-15, D-36) ----

/** A route policy as a host gives it: the effective policy's inputs and the version every record of the request names (D-10). */
export type RoutePolicyNow = RoutePolicy & { readonly policyVersion: PolicyRecordVersion };

/** How long a verified list of one effective policy's authorizations is reused: a minute, so one that starts later counts soon after it starts. */
const VERIFIED_KEPT_MS = 60_000;
const verifiedByPolicy = new WeakMap<PolicyDocument, { readonly at: number; readonly source: string; readonly found: readonly VerifiedAuthorization[] }>();

/**
 * The authorizations of the effective policy that verify now against exactly one key source (D-15, T-41-132): your organization's signers when its layer is
 * in force (this device counts only when it is one of them), otherwise this device's own key alone, so what it signed reads as self-signed. One that does
 * not verify is left out. Each list is reused for a minute per effective policy; whether an authorization covers a request (its dates included) is still
 * judged at every decision.
 */
function verifiedAuthorizations(effective: PolicyDocument, organization: PolicyDocument | undefined, device: BundleIssuer | undefined, now: number): readonly VerifiedAuthorization[] {
  const envelopes = effective.authorizations ?? [];
  if (envelopes.length === 0) return Object.freeze([]);
  const signers = organization === undefined ? undefined : organization.people?.signers ?? [];
  const thisDevice = device === undefined ? undefined : { fingerprint: device.fingerprint, publicKey: device.publicKey };
  const source = `${signers === undefined ? 'device' : signers.map((signer) => signer.fingerprint).join(',')}:${thisDevice?.fingerprint ?? ''}`;
  const held = verifiedByPolicy.get(effective);
  if (held !== undefined && held.source === source && now >= held.at && now - held.at < VERIFIED_KEPT_MS) return held.found;
  const found: VerifiedAuthorization[] = [];
  for (const envelope of envelopes) {
    const verdict = verifyAuthorization(envelope, { ...(signers === undefined ? {} : { signers }), ...(thisDevice === undefined ? {} : { thisDevice }), now });
    if (verdict.ok) found.push(Object.freeze({ body: verdict.body, selfSigned: verdict.selfSigned }));
  }
  const list = Object.freeze(found);
  verifiedByPolicy.set(effective, { at: now, source, found: list });
  return list;
}

/**
 * The route policy of a request decided at `now` from the layers a host holds (D-36): undefined unless an effective policy is in force (never for a
 * failed-closed state), so the request is then decided as the safety patch did. `organization` is true only for a valid organization layer; the
 * accredited-device switch comes from the effective agents section and the clearances from its people section; `deviceId` is this device's fingerprint,
 * and this device's key is the personal layer's issuer, since only this device signs that layer. The project is left out: a route does not know its
 * project yet, so an authorization scoped to projects covers nothing (D-54, fail closed).
 */
export function routePolicyFor(
  layers: PolicyLayersView, now: number, deviceFingerprint: string, policyVersion: PolicyRecordVersion, wallet?: ClearanceWalletView
): RoutePolicyNow | undefined {
  const effective = layers.effective;
  if (effective === undefined || layers.failedLayer !== undefined || layers.organization.state === 'failed') return undefined;
  const organization = layers.organization.state === 'valid' ? layers.organization.document : undefined;
  return Object.freeze({
    endpoints: effective.endpoints ?? [],
    authorizations: verifiedAuthorizations(effective, organization, layers.personal?.document.issuer, now),
    ...(effective.residency === undefined ? {} : { residency: effective.residency }),
    ...(effective.models === undefined ? {} : { models: effective.models }),
    scales: effective.labels.scales,
    mappings: effective.labels.mappings,
    // Phase 71 (D-19): from the verified wallet when your organization's policy carries credentials@1, else the declared ones (clearances.ts).
    clearances: clearancesInForce(effective, organization, wallet).clearances,
    organization: organization !== undefined,
    requireAccreditedDevice: effective.agents.requireAccreditedDevice === true,
    deviceId: deviceFingerprint,
    ...securityContactOf(effective),
    now,
    policyVersion
  });
}

/** The first security contact of the effective policy, which every passport refusal names (74.1 D-11). */
function securityContactOf(effective: PolicyDocument): { readonly contact?: { readonly name: string; readonly how: string } } {
  const contact = effective.onboarding?.contacts.find((entry) => entry.topic === 'security');
  return contact === undefined ? {} : { contact: Object.freeze({ name: contact.name, how: contact.how }) };
}

// ---- The report-only notice (74.1 D-22) ----

/** Told once per would-refuse of route.passport (report mode): the notice service listens. A listener that throws never changes a request. */
export const passportReportListeners = new Set<() => void>();

function notePassportReport(): void {
  for (const listener of [...passportReportListeners]) {
    try { listener(); } catch { /* a notice never changes a request */ }
  }
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
  /** An any-cloud request pinned to the proven connection that met another key and was sent unpinned instead (owner, 2026-11-18). */
  readonly connectionFallback?: 'unpinned';
  /** The version of the policy that decided the request (D-10): bundle-2 under a version 2 policy; absent is bundle-1. */
  readonly policyVersion?: PolicyRecordVersion;
}

/**
 * The infer record of one model request, built the way a tool call's record is (product version, clock and record id from the route): the capability
 * `infer` with the tier, provider and model, the model as the resource, the outcome and the rule, the policy's hash. A routine allowed request (route.any-cloud,
 * or route.default-session outside every route) gets the short record: no reason, the model and the policy's hash written once each, and, while the mark is
 * the default label, no label. The connection state is kept only when the tier read it (attested-cloud). Never a host, a URL, a path or a fingerprint: the facts' host and binding fingerprint are not read here.
 */
export function routeRecordFor(route: SessionRoute, decision: RouteDecision, facts: RouteFacts, request: RouteRequest, context: RouteRecordContext): DecisionRecord {
  // 74.1 D-22: every model request's decision passes here once; one route.passport would-refuse raises the report-only notice for the session.
  if (decision.allowed && decision.wouldRefuse?.includes('route.passport') === true) notePassportReport();
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
    ...(decision.tier === 'attested-cloud' ? { connection: facts.binding?.state ?? 'unknown' } : {}),
    ...(context.connectionFallback === undefined ? {} : { connectionFallback: context.connectionFallback }),
    ...(context.policyVersion === undefined ? {} : { policyVersion: context.policyVersion }),
    // The report-only rules that would have refused (D-34, D-42), kept so a later version can say what your organization's switch would change.
    ...(decision.wouldRefuse === undefined ? {} : { wouldRefuse: decision.wouldRefuse }),
    // The use, the passport by id and hash, and the gap the passport step found (74.1 D-23).
    ...(decision.useTier === undefined ? {} : { useTier: decision.useTier }),
    ...(decision.passport === undefined ? {} : { passport: decision.passport }),
    ...(decision.passportGap === undefined ? {} : { passportGap: decision.passportGap }),
    // The families of a check (74.1 D-23): the writers' and the checker's, so the record shows no work was checked by its own family.
    ...(route.checkFamilies === undefined ? {} : { checkFamilies: route.checkFamilies }),
    // The research workspace's requests say so in every record (74.1 D-17).
    ...(laneOf(route) === undefined ? {} : { lane: 't0' as const })
  });
}

/** The record lane of a route: `t0` when its use facts say the research lane; none when they cannot be read. */
function laneOf(route: SessionRoute): 't0' | undefined {
  try {
    return recordLaneOf(route.useOf?.());
  } catch {
    return undefined;
  }
}

/** Why an answer sent at attested-cloud could not be checked at all (PR #89 review): recorded as unavailable, so no such answer goes unrecorded. */
export const UNCHECKABLE_ANSWER_REASONS = Object.freeze({
  'no-signature-id': 'NEAR AI returned no signature id for this answer, so it could not be checked; nothing changed.',
  'no-hashes': 'The editor kept no hashes of this answer to check it with, so it could not be checked; nothing changed.'
} as const);

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
export function routeEventRecordFor(route: SessionRoute, event: RouteEventId, request: { readonly model?: string; readonly attestation: 'verified' | 'failed' | 'unavailable'; readonly reason?: string }): DecisionRecord {
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
    reason: event === 'route.attestation-cleared' ? 'A person\'s Check again passed, so NEAR AI Cloud\'s models count as private for this chat again.' : request.reason ?? ANSWER_CHECK_REASONS[request.attestation],
    bundleHash,
    ...(mark.length === 0 ? {} : { mark }),
    attestation: request.attestation
  });
}

/**
 * The record that a re-evaluation trigger ended a model's approval (`route.passport-triggered`, 74.1 D-15): written once per passport hash and trigger,
 * beside the request's own record. It refuses nothing itself; the passport step does. The capability's tier is the one the model's place serves (this
 * computer, private hardware, or the cloud). Names the passport by id and hash, never a host or a path.
 */
export function passportTriggeredRecordFor(
  route: SessionRoute,
  request: { readonly model: string; readonly provider: 'near-ai' | 'local' | 'unknown'; readonly privacyBoundary?: string; readonly passport: { readonly id: string; readonly hash: string }; readonly trigger: ReevaluationTrigger }
): DecisionRecord {
  const recordId = (route.newRecordId ?? randomUUID)();
  const model = recordedModelName(request.model);
  const tier: InferTier = request.privacyBoundary === 'local' ? 'local-only' : request.privacyBoundary === 'tee' ? 'attested-cloud' : 'any-cloud';
  let bundleHash = '';
  try { bundleHash = routingOf(route).bundleHash; } catch { /* no policy hash then */ }
  return buildDecisionRecord({
    recordId,
    sequence: 0,
    time: clockOf(route),
    productVersion: route.productVersion ?? UNKNOWN_PRODUCT_VERSION,
    actor: route.actor,
    model: { name: model, provider: request.provider },
    callId: `route.passport-triggered-${recordId}`,
    capability: { verb: 'infer', tier, provider: request.provider, model },
    resource: { name: model, type: 'model' },
    outcome: 'allowed',
    rule: 'route.passport-triggered',
    reason: passportTriggeredText(model, request.trigger),
    bundleHash,
    passport: request.passport,
    passportGap: 'expired'
  });
}

/**
 * The record that classified work ran on a computer not recorded as accredited (`route.not-accredited`, coherence review S2): written once per chat, beside
 * the allowed request's own record. It refuses nothing. The label is the one that needs an accredited system; never a host or a path.
 */
export function notAccreditedRecordFor(route: SessionRoute, decision: RouteDecision, facts: RouteFacts, request: RouteRequest, context: RouteRecordContext & { readonly label: Label; readonly reason: string }): DecisionRecord {
  const recordId = (route.newRecordId ?? randomUUID)();
  const provider = facts.clientRoute === 'local' ? 'local' : facts.clientRoute === 'near' ? 'near-ai' : 'unknown';
  const model = recordedModelName(request.model);
  const asked: InferTier = decision.tier === 'deny' ? 'local-only' : decision.tier;
  return buildDecisionRecord({
    recordId,
    sequence: 0,
    time: clockOf(route),
    productVersion: route.productVersion ?? UNKNOWN_PRODUCT_VERSION,
    actor: route.actor,
    model: { name: model, provider },
    callId: `route.not-accredited-${recordId}`,
    capability: { verb: 'infer', tier: asked, provider, model },
    resource: { name: model, type: 'model' },
    outcome: 'allowed',
    rule: 'route.not-accredited',
    reason: context.reason,
    bundleHash: context.bundleHash,
    label: context.label,
    ...(isDefaultMark(context.mark, context.defaultLabel) ? {} : { mark: context.mark }),
    ...(context.policyVersion === undefined ? {} : { policyVersion: context.policyVersion })
  });
}

/**
 * Coherence review S2 (report mode): when an allowed request carries content at a level that belongs only on an accredited system (Protected C, classified,
 * NATO Confidential and above), the chat says once that this computer is not recorded as accredited, and the decision log records route.not-accredited
 * once. Nothing is refused. A notice or record that cannot be made never changes the request (D-21).
 */
export function noteNotAccredited(route: SessionRoute, decision: RouteDecision, facts: RouteFacts, model: string | undefined, context: { readonly mark: Mark; readonly defaultLabel: Label; readonly bundleHash: string; readonly routing: RoutingTable }): void {
  try {
    // A decision made with a policy names the label itself (D-34): none when an accredited-device authorization covers this device. Without a policy, the
    // safety patch's own rule.
    const label = decision.allowedBy !== undefined ? decision.notAccredited : thisComputerOnlyLabelOf(context.mark, context.defaultLabel);
    if (label === undefined || route.attestation.notAccreditedTold === true) return;
    route.attestation.notAccreditedTold = true;
    const reason = notAccreditedText(labelKeyShown(label));
    try { route.sink?.record(notAccreditedRecordFor(route, decision, facts, model === undefined ? {} : { model }, { ...context, label, reason })); } catch { /* D-21 */ }
    try { route.onNotice?.(reason); } catch { /* a notice never changes a request */ }
  } catch { /* D-21 */ }
}

/**
 * A request your organization's rules pin to a server (D-26) whose connection matched none of the pins: nothing was written over it. The refusal is
 * recorded beside the request's own record, and the refusing decision returned. A record that cannot be kept never changes the refusal (D-21).
 */
export function endpointPinRefusal(route: SessionRoute, decision: RouteDecision, facts: RouteFacts, context: RouteRecordContext): RouteDecision {
  const refused: RouteDecision = { allowed: false, tier: decision.tier, rule: 'route.endpoint-pin', reason: ROUTE_REFUSALS['route.endpoint-pin'] };
  try { route.sink?.record(routeRecordFor(route, refused, facts, facts.model === undefined ? {} : { model: facts.model.id }, context)); } catch { /* D-21 */ }
  return refused;
}

function clockOf(route: SessionRoute): number {
  try {
    const now = route.clock?.();
    if (typeof now === 'number' && Number.isFinite(now)) return Math.floor(now);
  } catch { /* the system clock below */ }
  return Date.now();
}
