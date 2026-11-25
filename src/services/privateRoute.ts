// The private route of a request (FND-06, D-36, D-37): the inputs of one request's route decision that the client gathers. The facts the client knows
// before sending (its route, host, the model's catalogue entry, the binding fact held in memory, the clock), read here so the client's one choke point
// stays small. No vscode import and no network call: everything here is read from memory.
import { isNearCloudEndpoint } from '../domain/config';
import { ConnectionNotBoundError, NEAR_TLS_FINGERPRINT_KIND, pinnedFetch } from './connectionBinding';
import { TIER_ORDER, decideRoute } from '../domain/gate/routing';
import type { ConnectionBindingFact, RouteDecision, RouteFacts, RoutingTier } from '../domain/gate/routing';
import { trustFactsFor } from '../domain/gate/trust';
import type { TrustContext, TrustFacts } from '../domain/gate/trust';
import type { ModelInfo } from '../domain/provider/messages';
import type { UseTier } from '../domain/gate/models';
import { useTierFor } from '../domain/gate/useTier';
import type { UseInput } from '../domain/gate/useTier';
import { currentSessionRoute, defaultSessionRoute, passportTriggeredRecordFor, raiseSessionUse, routingOf } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { JOB_MINIMUM_TIER, resolvePassport } from '../domain/gate/models';
import type { ModelJob } from '../domain/gate/models';
import { SHIPPED_REPORT_MODELS } from '../domain/gate/passportStep';
import { passportState } from '../domain/gate/passportState';
import type { ObservedPlace } from '../domain/gate/passportState';
import { passportTriggerLog } from '../gate/passportTriggers';

/** What the client knows about one content request when its route is decided. */
export interface RouteFactsInput {
  readonly clientRoute: RouteFacts['clientRoute'];
  readonly host: string;
  /** The model's entry in the client's own cached catalog; undefined when the model is unknown or the catalog has not loaded. */
  readonly info: Pick<ModelInfo, 'id' | 'privacyBoundary' | 'forwardedTo'> | undefined;
  /** The answer-check state of the route: failed, unproven or ok. */
  readonly attestation: 'ok' | 'failed' | 'unproven';
  readonly fact: ConnectionBindingFact;
  readonly now: number;
  readonly localModelAvailable: boolean;
  readonly sessionless: boolean;
  /** Team Mode's allowed models, from the floor (D-37); absent is no filter. */
  readonly allowedModels?: readonly string[];
  /** The client's cached catalogue, so a passport refusal can name the models that would go instead (74.1 D-14). */
  readonly catalog?: { values(): Iterable<Pick<ModelInfo, 'id' | 'privacyBoundary'>> };
}

/**
 * The use of the request running now (74.1 D-13): from the current session route's own facts and its mark, by the shipped tables, never below the highest
 * use the route has asked for (which it then raises). Outside every route it is chat you review, as before. Facts that cannot be read give the highest
 * use for this request, never a lower one (fail closed).
 */
function requestUse(): { readonly use: UseTier; readonly useInput?: UseInput } {
  const route = currentSessionRoute();
  if (route === undefined) return { use: 'T1' };
  let useInput: UseInput;
  try {
    const own = route.useOf?.() ?? {};
    const mark = route.markOf().map((label) => ({ scale: label.scale, level: label.level }));
    useInput = { ...own, mark: [...(own.mark ?? []), ...mark] };
  } catch {
    return { use: 'T3' };
  }
  return { use: raiseSessionUse(route, useTierFor(useInput)), useInput };
}

/**
 * What was observed about the passport of the request's model (74.1 D-15): the place first seen for its hash and the place now (the catalogue's
 * `privacyBoundary` and `forwardedTo`), and the triggers fired for it. A trigger the place fires now is kept once in the trigger log and recorded once as
 * `route.passport-triggered` through the route's sink. Only with a route policy (step 7 runs only then) and the log set at activation; anything that cannot
 * be read leaves nothing observed, so the passport decides alone (never more than it would).
 */
function observedFor(input: RouteFactsInput): Pick<RouteFacts, 'observed'> {
  const log = passportTriggerLog();
  const info = input.info;
  if (log === undefined || info === undefined) return {};
  try {
    const route = currentSessionRoute() ?? defaultSessionRoute();
    const policy = route.routePolicy?.(input.now);
    if (policy === undefined) return {};
    const resolved = resolvePassport(policy.models ?? SHIPPED_REPORT_MODELS, info.id, input.now);
    if (resolved === undefined) return {};
    // A catalogue that has not said where the model runs (its privacy list not loaded) says nothing about a change of place: nothing is kept or compared.
    const current: ObservedPlace | undefined = info.privacyBoundary === undefined ? undefined : { privacyBoundary: info.privacyBoundary, ...(info.forwardedTo === undefined ? {} : { forwardedTo: info.forwardedTo }) };
    const place = current === undefined ? {} : { firstSeen: log.seen(resolved.hash, current), current };
    const state = passportState(resolved, { ...place, fired: log.fired(resolved.hash) }, input.now);
    if (state.state === 'expired' && state.reason !== 'date' && log.fire(resolved.hash, state.reason)) {
      const provider = input.clientRoute === 'local' ? 'local' : input.clientRoute === 'near' ? 'near-ai' : 'unknown';
      try {
        route.sink?.record(passportTriggeredRecordFor(route, {
          model: info.id, provider, ...(info.privacyBoundary === undefined ? {} : { privacyBoundary: info.privacyBoundary }),
          passport: { id: resolved.passport.id, hash: resolved.hash }, trigger: state.reason
        }));
      } catch { /* D-21: a record that cannot be kept never changes the request */ }
    }
    return { observed: Object.freeze({ passportHash: resolved.hash, ...place, fired: log.fired(resolved.hash) }) };
  } catch {
    return {};
  }
}

/** The RouteFacts of one request, from what the client read (CLAS-06, D-36), and the use of the session it runs in (74.1 D-13). */
export function routeFactsFor(input: RouteFactsInput): RouteFacts {
  const { clientRoute, host, info, attestation, fact, now } = input;
  const facts: RouteFacts = {
    ...requestUse(),
    clientRoute,
    host,
    nearEndpoint: isNearCloudEndpoint(host),
    model: info === undefined ? undefined : { id: info.id, ...(info.privacyBoundary === undefined ? {} : { privacyBoundary: info.privacyBoundary }) },
    attestationFailed: attestation === 'failed',
    // An unproven answer-check state is never proof of a private connection: no binding counts for it (D-50).
    binding: attestation === 'unproven' ? { state: 'unknown', host } : fact,
    now,
    localModelAvailable: input.localModelAvailable,
    sessionless: input.sessionless,
    ...(input.allowedModels === undefined ? {} : { allowedModels: input.allowedModels }),
    ...observedFor(input),
    ...(input.catalog === undefined ? {} : { candidates: Object.freeze([...input.catalog.values()].map((entry) => Object.freeze({ id: entry.id, ...(entry.privacyBoundary === undefined ? {} : { privacyBoundary: entry.privacyBoundary }) }))) })
  };
  return facts;
}

/**
 * The TrustFacts of an allowed request (D-38), for the answer's badge: `{ trust }`, or nothing when they cannot be worked out, which never changes the
 * request (the badge then says what allowed it was not recorded).
 */
export function requestTrust(decision: RouteDecision, facts: RouteFacts, context: TrustContext, forwardedTo: string | undefined): { readonly trust?: TrustFacts } {
  if (!decision.allowed) return {};
  try {
    return { trust: trustFactsFor(decision, facts, context, forwardedTo === undefined ? undefined : { forwardedTo }) };
  } catch {
    return {};
  }
}

// ---- The gate's preview of a job's model (74.1 D-18, D-19) ----
/** Where a run's requests go, for the preview: the run's route (its policy and mark), the client's kind and host, and the floor. */
export interface GateAllowsInput {
  readonly route: SessionRoute;
  readonly catalog: ReadonlyArray<{ readonly id: string; readonly privacyBoundary?: string }>;
  readonly clientRoute: 'near' | 'local' | undefined;
  readonly host: string;
  readonly floor?: RoutingTier;
  readonly now?: number;
}

/**
 * Whether the gate would let a model do a job now (74.1 D-18, D-19): decideRoute itself, at the job's minimum use (the safety job as a checking job), with
 * the run's mark, routing and policy. A preview: it records nothing, raises no session's use and keeps no trigger. The connection's proof is not known
 * here, so a refusal only for an unproven connection previews as allowed: the request itself decides that one before anything is sent. Anything that
 * cannot be read previews as refused.
 */
export function gateAllows(input: GateAllowsInput): (modelId: string, job: ModelJob) => boolean {
  return (modelId, job) => {
    try {
      const now = input.now ?? Date.now();
      const entry = input.catalog.find((candidate) => candidate.id === modelId);
      if (entry === undefined) return false;
      const { routing, defaultLabel } = routingOf(input.route);
      const mark = input.route.markOf();
      const own = input.route.useOf?.() ?? {};
      const facts: RouteFacts = {
        clientRoute: input.clientRoute, host: input.host, nearEndpoint: isNearCloudEndpoint(input.host),
        model: { id: entry.id, ...(entry.privacyBoundary === undefined ? {} : { privacyBoundary: entry.privacyBoundary }) },
        attestationFailed: input.route.attestation.failed, binding: { state: 'unknown', host: input.host }, now, localModelAvailable: input.clientRoute === 'local',
        use: JOB_MINIMUM_TIER[job], useInput: { ...own, mark: [...(own.mark ?? []), ...mark.map((label) => ({ scale: label.scale, level: label.level }))], ...(job === 'safety' ? { checkingJob: true } : {}) }
      };
      const decision = decideRoute(mark, routing, facts, defaultLabel, input.floor, input.route.routePolicy?.(now));
      return decision.allowed || decision.rule === 'route.connection-not-bound';
    } catch {
      return false;
    }
  };
}

// ---- A connection held to your organization's pins (D-26) ----

function notBound(error: unknown): boolean {
  return error instanceof ConnectionNotBoundError || (error as { cause?: unknown } | undefined)?.cause instanceof ConnectionNotBoundError;
}

/**
 * A fetch held to one of a place's TLS pins (D-26, T-41-130): each pin in order, as an SPKI SHA-256 hash (the form tlsPins hold). A connection that presents
 * another key is refused by the pinned fetch before a byte is written, so only then is the next pin tried; the last such error is thrown. Any other error
 * stops at once. With no pin nothing is sent. `connect` is the pinned fetch of one pin (tests give their own).
 */
export function pinnedFetchAny(pins: readonly string[], connect: (pin: string) => typeof fetch = (pin) => pinnedFetch(pin, NEAR_TLS_FINGERPRINT_KIND)): typeof fetch {
  const held = [...pins];
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let last: unknown = new ConnectionNotBoundError('Your organization\'s rules give no pin for this server, so nothing was sent.');
    for (const pin of held) {
      try {
        return await connect(pin)(input, init);
      } catch (error) {
        if (!notBound(error)) throw error;
        last = error;
      }
    }
    throw last;
  }) as typeof fetch;
}

// ---- One private floor (D-37) ----

/** The floor of a request: a tier it must reach at least, and Team Mode's allowed models. Each is absent when nothing asks for it. */
export interface PrivateFloor {
  readonly tier?: RoutingTier;
  readonly allowedModels?: readonly string[];
}

/** What can ask for private-only work, gathered for floorFor. */
export interface FloorInputs {
  /**
   * privateOnlyNow(): nearAi.privacyMode tee-only, or a private member or agent team (withPrivateOnly, coherence review S4). A setting that cannot be read
   * already reads as true there (fail closed).
   */
  readonly privateOnly?: boolean;
  /** Team Mode's inputs (teamRouteInputs): teeOnly raises the floor, a non-empty allowedModels list filters the models. */
  readonly team?: { readonly teeOnly: boolean; readonly allowedModels: readonly string[] };
}

/**
 * The one floor every way of asking for private-only work gives (D-37): attested-cloud for privateOnly or Team Mode's teeOnly, so a model counts as private
 * only when decideRoute's own check passes (verified private hardware over a proven connection, or this computer); Team Mode's allowedModels as a filter,
 * an empty list being no filter. decideRoute reads the tier as its floor and the list through RouteFacts.allowedModels.
 */
export function floorFor(inputs: FloorInputs): PrivateFloor {
  const tier: RoutingTier | undefined = inputs.privateOnly === true || inputs.team?.teeOnly === true ? 'attested-cloud' : undefined;
  const allowedModels = inputs.team?.allowedModels ?? [];
  return Object.freeze({ ...(tier === undefined ? {} : { tier }), ...(allowedModels.length === 0 ? {} : { allowedModels: Object.freeze([...allowedModels]) }) });
}

/**
 * Whether a catalogue entry can meet the floor, for a choice made before anything is sent (Team Studio's model, the picker): a tier of attested-cloud or
 * above admits only TEE and local entries; a list admits only its ids. The client still decides each send with decideRoute.
 */
export function floorAllowsModel(floor: PrivateFloor, model: { readonly id: string; readonly privacyBoundary?: string }): boolean {
  if (floor.tier !== undefined && TIER_ORDER[floor.tier] >= TIER_ORDER['attested-cloud'] && model.privacyBoundary !== 'tee' && model.privacyBoundary !== 'local') return false;
  return floor.allowedModels === undefined || floor.allowedModels.includes(model.id);
}

/** The client a run sends every request through: NEAR AI Cloud (with or without checkable attestation) or a local runtime. */
export interface PrivateRoute { kind: 'near' | 'local'; attestation: boolean }

/** Whether a `privacy: private` member may run on this catalog entry over this route. Anything unknown is refused. */
export function routeAllows(route: PrivateRoute | undefined, model: { privacyBoundary?: string } | undefined): boolean {
  if (!route || !model) return false;
  if (route.kind === 'local') return model.privacyBoundary === 'local';
  return route.kind === 'near' && route.attestation && model.privacyBoundary === 'tee';
}

export function privateRefusal(label: string, tier: string | undefined, route: PrivateRoute | undefined): string {
  const fix = `To let ${label} use any model instead, change its line to privacy: any.`;
  if (!route) return `${label} must run on a private model (its team file says privacy: private), but this run did not say which route it uses, so no model can be confirmed private. ${fix}`;
  if (route.kind === 'local') return `${label} must run on a private model (its team file says privacy: private). This run uses your local runtime, and none of its models are offered to this run. Add a local model, or start the run on a local model, then run again. ${fix}`;
  if (!route.attestation) return `${label} must run on a private model (its team file says privacy: private), but this run's endpoint is not NEAR AI Cloud, so a TEE model's attestation cannot be checked. Use NEAR AI Cloud, or start the run on a local model, then run again. ${fix}`;
  return `${label} must run on a private model (its team file says privacy: private), and none of the models this run may use runs in a NEAR TEE or on this machine. Choose a NEAR TEE model for the ${tier ?? 'deep'} tier (setting nearAi.agent.${tier ?? 'deep'}Model), or add a local model, then run again. ${fix}`;
}
