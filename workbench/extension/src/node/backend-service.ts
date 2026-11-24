import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging/index.js';
import type { interfaces } from '@theia/core/shared/inversify';

/**
 * Binds one Sterling backend service and its RPC endpoint (D-15): `id` to the service `make` builds (one per backend), and one
 * ConnectionHandler at `path` whose target is that service, resolved only when a browser first connects. The frontend side is
 * bindFrontendService in browser/frontend-service.ts with the same id and path.
 *
 * Rule for every service bound here (D-16): an expected refusal is a returned value (a ServiceResult `refused`, or the service's own
 * plain-data result type) carrying the engine's own message; a method throws only for programming errors.
 */
export function bindBackendService<T extends object>(bind: interfaces.Bind, id: symbol, path: string, make: (context: interfaces.Context) => T): void {
  bind(id).toDynamicValue(make).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(context => new RpcConnectionHandler<T>(path, () => context.container.get<T>(id))).inSingletonScope();
}
