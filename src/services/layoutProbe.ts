import * as vscode from 'vscode';

/**
 * Test-only layout measurement for the extension-host tests (NEAR_AI_E2E=1). When the variable is
 * not set, nothing here does anything: pages get no extra script, no webview is registered, and the
 * script itself (media/shared/layout-probe.js) is left out of the published extension.
 */
export interface LayoutReport {
  type: 'layout-probe-result';
  /** The page's own width in CSS pixels: the panel's width. */
  width: number;
  scrollWidth: number;
  clientWidth: number;
  bodyScrollWidth: number;
  bodyClientWidth: number;
  /** Elements reaching past the right edge of the page, outside any box that scrolls or clips on purpose. */
  offenders: string[];
  /** Boxes that scroll sideways themselves, other than code, diffs and the chat's own tab strip and tables. */
  scrollers: string[];
}

export function layoutProbeEnabled(): boolean {
  return process.env.NEAR_AI_E2E === '1';
}

/** The folder holding the stylesheet every page shares (and, under test, the layout probe). */
export function sharedMedia(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'media', 'shared');
}

/** The probe's script URL for a page's HTML, or undefined outside the extension-host tests. */
export function layoutProbeAsset(webview: Pick<vscode.Webview, 'asWebviewUri'>, shared: vscode.Uri): string | undefined {
  return layoutProbeEnabled() ? webview.asWebviewUri(vscode.Uri.joinPath(shared, 'layout-probe.js')).toString() : undefined;
}

/** The `<script>` tag that loads the probe, or nothing outside the extension-host tests. */
export function layoutProbeTag(nonce: string, src: string | undefined): string {
  return src ? `<script nonce="${nonce}" src="${src}"></script>\n` : '';
}

type ProbedWebview = Pick<vscode.Webview, 'postMessage' | 'onDidReceiveMessage'>;
const views = new Map<string, ProbedWebview>();

/** Makes a page measurable by name; a no-op outside the extension-host tests. */
export function registerLayoutProbe(name: string, webview: ProbedWebview): void {
  if (layoutProbeEnabled()) views.set(name, webview);
}

/** Sends a registered page a message as its host would (the tests use it to show sample data). */
export async function postToPage(name: string, message: unknown): Promise<void> {
  const webview = views.get(name);
  if (!webview) throw new Error(`No page named ${name} is open for layout checks.`);
  await webview.postMessage(message);
}

/** Asks a registered page to measure its layout and waits for the answer. */
export async function probeLayout(name: string, timeoutMs = 10_000): Promise<LayoutReport> {
  const webview = views.get(name);
  if (!webview) throw new Error(`No page named ${name} is open for layout checks.`);
  return new Promise<LayoutReport>((resolve, reject) => {
    const timer = setTimeout(() => { listener.dispose(); reject(new Error(`The ${name} page did not report its layout.`)); }, timeoutMs);
    const listener = webview.onDidReceiveMessage((message: unknown) => {
      if ((message as { type?: string } | undefined)?.type !== 'layout-probe-result') return;
      clearTimeout(timer);
      listener.dispose();
      resolve(message as LayoutReport);
    });
    void webview.postMessage({ type: 'layout-probe' });
  });
}
