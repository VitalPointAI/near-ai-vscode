import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider.js';
import type { interfaces } from '@theia/core/shared/inversify';

/**
 * Binds the browser-side proxy of a Sterling backend service (D-15): `id` resolves to an RPC proxy for `path`, the same id and path the
 * backend binds with bindBackendService. Results arrive as the plain data the service returned, refusals included (D-16).
 */
export function bindFrontendService<T extends object>(bind: interfaces.Bind, id: symbol, path: string): void {
  bind(id).toDynamicValue(context => ServiceConnectionProvider.createProxy<T>(context.container, path)).inSingletonScope();
}
