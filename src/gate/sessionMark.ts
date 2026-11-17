// The session route (CLAS-06, D-31): the context every model request runs inside, read at the one place content leaves for a model
// (NearAiClient.request). It follows withSpendTag (src/services/spendLedger.ts): an AsyncLocalStorage carries the route of the run, the sub-agent, the
// attachment read or the participant turn that made the request, so parallel sessions each read their own. No vscode import.
//
// A route names the session's mark (an empty mark means the policy's default label), the policy it is decided by, who is acting, and where its records go.
// A request made outside any route is decided with the default route (setDefaultSessionRoute), which the gate's activation sets; with none set, the route is
// failed closed, which routes the default label exactly as today and keeps anything labelled on this computer (D-53).
import { AsyncLocalStorage } from 'node:async_hooks';
import { SHIPPED_DEFAULT_LABEL, failedClosed } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import type { ActorRef, DecisionSink, GateRuntime } from '../domain/gate/decide';
import type { Mark } from '../domain/gate/dominance';
import type { Label } from '../domain/gate/labels';
import { routingWhileFailedClosed } from '../domain/gate/routing';
import type { RoutingTable } from '../domain/gate/routing';

/** Shared by a chat and every route it builds, so a failed answer check stops attested-cloud for the chat and its helpers alike (plan 25 sets it). */
export interface RouteAttestation {
  failed: boolean;
}

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
}

/** The empty mark: the session has read nothing above the policy's default label. */
const EMPTY_MARK: Mark = Object.freeze([]);

/**
 * The route of one run, from its gate runtime: the runtime's policy, actor, sink and clock. `markOf` defaults to the empty mark (the default label);
 * plan 22 gives a chat's runs the chat's mark. `attestation` is the chat's shared object, so a sub-agent and its parent share one route state.
 */
export function sessionRouteFrom(runtime: GateRuntime, options: { markOf?: () => Mark; attestation?: RouteAttestation } = {}): SessionRoute {
  return {
    markOf: options.markOf ?? (() => EMPTY_MARK),
    bundleState: runtime.bundleState,
    actor: runtime.actor,
    sink: runtime.sink,
    ...(runtime.clock === undefined ? {} : { clock: runtime.clock }),
    ...(runtime.newRecordId === undefined ? {} : { newRecordId: runtime.newRecordId }),
    ...(runtime.productVersion === undefined ? {} : { productVersion: runtime.productVersion }),
    attestation: options.attestation ?? { failed: false }
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

/** Sets (or, with undefined, clears) the route a request outside every route is decided with. The gate's activation sets the host's. */
export function setDefaultSessionRoute(route: SessionRoute | undefined): void {
  fallback = route;
}

/** The route a request outside every route is decided with: the one the activation set, or a failed-closed route that records nowhere. */
export function defaultSessionRoute(): SessionRoute {
  return fallback ?? NO_HOST_ROUTE;
}
