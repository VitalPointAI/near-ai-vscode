// The private route of a request (FND-06, D-36, D-37): the inputs of one request's route decision that the client gathers. The facts the client knows
// before sending (its route, host, the model's catalogue entry, the binding fact held in memory, the clock), read here so the client's one choke point
// stays small. No vscode import and no network call: everything here is read from memory.
import { isNearCloudEndpoint } from '../domain/config';
import { ConnectionNotBoundError, NEAR_TLS_FINGERPRINT_KIND, pinnedFetch } from './connectionBinding';
import { TIER_ORDER } from '../domain/gate/routing';
import type { ConnectionBindingFact, RouteDecision, RouteFacts, RoutingTier } from '../domain/gate/routing';
import { trustFactsFor } from '../domain/gate/trust';
import type { TrustContext, TrustFacts } from '../domain/gate/trust';
import type { ModelInfo } from '../domain/provider/messages';

/** What the client knows about one content request when its route is decided. */
export interface RouteFactsInput {
  readonly clientRoute: RouteFacts['clientRoute'];
  readonly host: string;
  /** The model's entry in the client's own cached catalog; undefined when the model is unknown or the catalog has not loaded. */
  readonly info: Pick<ModelInfo, 'id' | 'privacyBoundary'> | undefined;
  /** The answer-check state of the route: failed, unproven or ok. */
  readonly attestation: 'ok' | 'failed' | 'unproven';
  readonly fact: ConnectionBindingFact;
  readonly now: number;
  readonly localModelAvailable: boolean;
  readonly sessionless: boolean;
  /** Team Mode's allowed models, from the floor (D-37); absent is no filter. */
  readonly allowedModels?: readonly string[];
}

/** The RouteFacts of one request, from what the client read (CLAS-06, D-36). */
export function routeFactsFor(input: RouteFactsInput): RouteFacts {
  const { clientRoute, host, info, attestation, fact, now } = input;
  const facts: RouteFacts = {
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
    ...(input.allowedModels === undefined ? {} : { allowedModels: input.allowedModels })
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
