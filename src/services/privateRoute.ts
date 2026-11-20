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
