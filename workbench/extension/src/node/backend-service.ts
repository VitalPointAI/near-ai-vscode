import { ConnectionHandler, RpcConnectionHandler, type RpcProxy } from '@theia/core/lib/common/messaging/index.js';
import type { interfaces } from '@theia/core/shared/inversify';

/**
 * Binds one Sterling backend service and its RPC endpoint (D-15): `id` to the service `make` builds (one per backend), and one
 * ConnectionHandler at `path` whose target is that service, resolved only when a browser first connects. The frontend side is
 * bindFrontendService in browser/frontend-service.ts with the same id and path.
 *
 * With `withClient` (Phase 33 D-52), every connecting browser tab passes a client object: `withClient(service, client)` is called with the
 * service and that tab's client proxy, whose `on*` and `notify*` methods Theia sends as notifications. The service keeps its clients and drops
 * one when `client.onDidCloseConnection` fires. Without it the helper behaves as before.
 *
 * Rule for every service bound here (D-16): an expected refusal is a returned value (a ServiceResult `refused`, or the service's own
 * plain-data result type) carrying the engine's own message; a method throws only for programming errors.
 */
export function bindBackendService<T extends object, C extends object = object>(
  bind: interfaces.Bind, id: symbol, path: string, make: (context: interfaces.Context) => T, withClient?: (service: T, client: RpcProxy<C>) => void,
): void {
  bind(id).toDynamicValue(make).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(context => new RpcConnectionHandler<C>(path, client => {
    const service = context.container.get<T>(id);
    if (withClient !== undefined) withClient(service, client);
    return service;
  })).inSingletonScope();
}
