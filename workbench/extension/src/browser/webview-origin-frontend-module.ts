import { ContainerModule, injectable } from '@theia/core/shared/inversify';
import { Endpoint } from '@theia/core/lib/browser/endpoint.js';
import { WebviewEnvironment } from '@theia/plugin-ext/lib/main/browser/webview/webview-environment.js';
import { webviewParentHost } from '../common/webview-origin.js';

/** Theia's webview environment with the page host from common/webview-origin.ts in place of the page's own host. */
@injectable()
class SterlingWebviewEnvironment extends WebviewEnvironment {
  protected override async doInit(): Promise<void> {
    this._hostPatternPromise = this.getHostPattern();
    try {
      const pattern = await this.hostPatternPromise;
      this.externalEndpointHost.resolve(pattern.replace('{{hostname}}', webviewParentHost(new Endpoint().host)));
    } catch (error) {
      this.externalEndpointHost.reject(error);
    }
  }
}

/**
 * The Sterling modules load before @theia/plugin-ext binds WebviewEnvironment (the extension declares only @theia/core; declaring plugin-ext
 * would move every Sterling module, backend middleware included, after it), so the binding cannot be rebound here. A container activation
 * applies to the binding whenever it is made, and its result is the singleton every webview uses.
 */
export default new ContainerModule((_bind, _unbind, _isBound, _rebind, _unbindAsync, onActivation) => {
  onActivation(WebviewEnvironment, (context) => context.container.resolve(SterlingWebviewEnvironment));
});
