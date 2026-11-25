import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { layoutProbeAsset, layoutProbeTag, registerLayoutProbe, sharedMedia } from '../layoutProbe';

// The start of the webview kit (DEVELOPER-STRUCTURE section 2); new pages use it, existing pages move later.
// Copied from mcpView.ts: one content security policy that loads nothing by default, styles only from the extension, and scripts only with a fresh
// nonce; the shared base.css before the page's own stylesheet; the layout probe under the extension-host tests. The page builds everything else with
// textContent from the messages its host posts.

export interface PanelSpec {
  /** The panel's view type, unique to the page. */
  readonly viewType: string;
  /** The tab title, with no brand prefix (GLOSSARY section 5 rule 3). */
  readonly title: string;
  /** The page's folder under media/. */
  readonly folder: string;
  /** The page script's file name in that folder. */
  readonly script: string;
  /** The page stylesheet's file name in that folder. */
  readonly style: string;
  /** Static HTML the host writes into the body; never built from data. */
  readonly body: string;
  /** The page's name for the layout probe. */
  readonly probe: string;
  /** Keep the page alive while its tab is hidden. */
  readonly retain?: boolean;
  /** Scripts of another page's folder this page reuses, as `folder/file` under media/ (the research workspace loads the chat's Markdown renderer). */
  readonly shared?: readonly string[];
}

/** A tab title with a brand prefix ("NEAR AI:", "Near AI:", "SovAI:"): the title says what the page is, never whose it is. */
export const BRANDED_TITLE = /^(NEAR AI|Near AI|SovAI)\s*:/i;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * A command handler that opens a page (D-12, the #162 reviews). It returns undefined, so the page's panel never goes back to the command's caller, and a
 * failure to open, thrown or (should an opener become async) rejected, is told to the person in one sentence instead of being lost.
 */
export function panelCommand(open: () => unknown, what: string): () => undefined {
  const report = (error: unknown): void => {
    void vscode.window.showErrorMessage(`${what} could not open: ${error instanceof Error ? error.message : String(error)}`);
  };
  return () => {
    try {
      const opened = open();
      if (opened instanceof Promise) opened.catch(report);
    } catch (error) {
      report(error);
    }
    return undefined;
  };
}

/** Opens one webview page. Throws for a branded title, a programming error, before any panel is made. */
export function openPanel(context: { readonly extensionUri: vscode.Uri }, spec: PanelSpec): vscode.WebviewPanel {
  if (BRANDED_TITLE.test(spec.title)) throw new Error(`The panel title "${spec.title}" has a brand prefix; say what the page is.`);
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', spec.folder);
  const shared = sharedMedia(context.extensionUri);
  const reused = (spec.shared ?? []).map((file) => vscode.Uri.joinPath(context.extensionUri, 'media', ...file.split('/')));
  const reusedRoots = [...new Set((spec.shared ?? []).map((file) => file.split('/')[0] as string))].map((folder) => vscode.Uri.joinPath(context.extensionUri, 'media', folder));
  const view = vscode.window.createWebviewPanel(spec.viewType, spec.title, vscode.ViewColumn.Active, {
    enableScripts: true, localResourceRoots: [media, shared, ...reusedRoots], retainContextWhenHidden: spec.retain === true
  });
  view.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  const base = view.webview.asWebviewUri(vscode.Uri.joinPath(shared, 'base.css')).toString();
  view.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${base}"><link rel="stylesheet" href="${asset(spec.style)}"><title>${escapeHtml(spec.title)}</title></head><body>
${spec.body}
${layoutProbeTag(nonce, layoutProbeAsset(view.webview, shared))}${reused.map((uri) => `<script nonce="${nonce}" src="${view.webview.asWebviewUri(uri).toString()}"></script>`).join('')}<script nonce="${nonce}" src="${asset(spec.script)}"></script></body></html>`;
  registerLayoutProbe(spec.probe, view.webview);
  return view;
}
