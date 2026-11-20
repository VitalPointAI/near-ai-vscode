// The private route of a request (FND-06, D-36, D-37): the inputs of one request's route decision that the client gathers. The facts the client knows
// before sending (its route, host, the model's catalogue entry, the binding fact held in memory, the clock), read here so the client's one choke point
// stays small. No vscode import and no network call: everything here is read from memory.
import { isNearCloudEndpoint } from '../domain/config';
import type { ConnectionBindingFact, RouteFacts } from '../domain/gate/routing';
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
    sessionless: input.sessionless
  };
  return facts;
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
