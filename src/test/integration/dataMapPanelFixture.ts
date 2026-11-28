import { randomBytes } from 'node:crypto';
import type { DataMapSnapshot } from './dataMapFixture';

interface Subscription { dispose(): void }

interface DataMapPanel {
  readonly webview: {
    html: string;
    onDidReceiveMessage?(callback: (message: unknown) => void | Promise<void>): Subscription;
  };
  onDidDispose(callback: () => void): unknown;
}

interface DataMapPanelDependencies<Registration> {
  register(command: string, open: () => Promise<void>): Registration;
  createPanel(): DataMapPanel;
  /** The extension host owns the session transport. No endpoint or credential is sent to the webview. */
  read?: () => Promise<DataMapSnapshot>;
  onDidChangeScope?(callback: () => void | Promise<void>): Subscription;
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function page(content: string, retry = false): string {
  const nonce = retry ? randomBytes(16).toString('base64') : undefined;
  const scriptPolicy = nonce ? ` script-src 'nonce-${nonce}';` : '';
  const controls = nonce ? `<button id="data-map-retry" type="button" autofocus>Try again</button>
<script nonce="${nonce}">
const host = acquireVsCodeApi();
document.getElementById('data-map-retry').addEventListener('click', () => host.postMessage({ type: 'retry' }));
</script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';${scriptPolicy}"><title>Data Management</title></head>
<body><main><h1>Data Management</h1>${content}${controls}</main></body></html>`;
}

function catalogue(snapshot: DataMapSnapshot): string {
  if (snapshot.items.length === 0) return '<p role="status">No data sources are available.</p>';
  const items = snapshot.items.map(({ name, label }) => `<li>${escapeText(name)} <span>${escapeText(label.level)}</span></li>`);
  return `<ul aria-label="Available data">${items.join('')}</ul>`;
}

/** The command is an extension-host bridge. Plan 07 exposes it on the Workbench rail. */
export function registerDataMapPanel<Registration>(deps: DataMapPanelDependencies<Registration>): Registration {
  return deps.register('nearAi.openDataMap', async () => {
    const panel = deps.createPanel();
    let closed = false;
    let generation = 0;
    let canRetry = false;
    const unavailable = '<p role="status">Data Management is unavailable.</p>';
    const read = deps.read;

    async function refresh() {
      if (closed) return;
      const request = ++generation;
      canRetry = false;
      if (!read) {
        panel.webview.html = page(unavailable);
        return;
      }

      panel.webview.html = page('<p role="status">Loading data…</p>');
      let content: string;
      let disconnected = false;
      try { content = catalogue(await read()); } catch {
        content = unavailable;
        disconnected = true;
      }
      if (closed || request !== generation) return;
      canRetry = disconnected && panel.webview.onDidReceiveMessage !== undefined;
      panel.webview.html = page(content, canRetry);
    }

    const messages = panel.webview.onDidReceiveMessage?.((message) => {
      if (canRetry && typeof message === 'object' && message !== null &&
          Object.keys(message).length === 1 && 'type' in message && message.type === 'retry') return refresh();
    });
    const scope = deps.onDidChangeScope?.(refresh);
    panel.onDidDispose(() => {
      closed = true;
      messages?.dispose();
      scope?.dispose();
    });
    await refresh();
  });
}
