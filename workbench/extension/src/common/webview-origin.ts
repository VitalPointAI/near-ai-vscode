/**
 * The host the extension's webviews (Chat, Team Studio, Agent Activity, Governance) are served under. Theia gives each webview its own
 * origin from THEIA_WEBVIEW_EXTERNAL_ENDPOINT, by default `{{uuid}}.webview.{{hostname}}`, with the page's host and port as {{hostname}}.
 * For a page at 127.0.0.1 that is `<uuid>.webview.127.0.0.1:<port>`, which is no valid URL host (its last label is a number, so it must be
 * an IPv4 address), and the browser refuses the frame: the page stays blank. Under 127.0.0.1 or [::1] the webviews use localhost on the
 * same port instead. Browsers serve every *.localhost name from loopback, Theia's backend serves any *.webview.* host, and each webview
 * origin still differs from the page's own. Any other host is used as given.
 */
const LOOPBACK_ADDRESS = /^(?:127\.0\.0\.1|\[::1\])(?=:\d+$|$)/;

export function webviewParentHost(pageHost: string): string {
  return pageHost.replace(LOOPBACK_ADDRESS, 'localhost');
}
