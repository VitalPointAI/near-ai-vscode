import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider.js';
import type { interfaces } from '@theia/core/shared/inversify';

/**
 * Binds the browser-side proxy of a Sterling backend service (D-15): `id` resolves to an RPC proxy for `path`, the same id and path the
 * backend binds with bindBackendService. Results arrive as the plain data the service returned, refusals included (D-16).
 *
 * With `client` (Phase 33 D-52), the object built from the container is passed to the backend as this tab's client: the backend calls its
 * `on*` methods as notifications.
 */
export function bindFrontendService<T extends object>(bind: interfaces.Bind, id: symbol, path: string, client?: (context: interfaces.Context) => object): void {
  bind(id).toDynamicValue(context => ServiceConnectionProvider.createProxy<T>(context.container, path, client?.(context))).inSingletonScope();
}
