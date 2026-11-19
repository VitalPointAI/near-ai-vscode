// The Staff Room panel (UX concept 4, 5 and 12; owner direction 2026-11-18; WP-ROOM): one editor panel for a staff run, with a workspace per section
// and the war room for the full staff, sharing one map, the product ledger, the human decisions and one clock.
//
// The host builds the whole picture (src/domain/staff/staffRoom.ts) from the staff host's ledger and events and the files under .planning/staff/, and
// sends it with the hand-offs the new events stand for. It listens to the staff host's events and to changes under .planning/staff/, coalescing them to
// at most four pictures a second, and nothing while the panel is hidden; shown again, it sends the whole picture, so a page VS Code kept alive or one
// rebuilt after a reload draws the same thing. Every message from the page is validated (src/staff/staffRoomHost.ts), and a decision button only runs a
// person-only staff command, which asks who the person is, confirms in a modal dialog and signs.
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OPEN_STAFF_ROOM_COMMAND } from '../domain/staff/commands';
import type { StaffEvent } from '../domain/staff/events';
import { buildStaffRoomModel, handoffsFor, STAFF_ROOM_MESSAGE } from '../domain/staff/staffRoom';
import type { StaffRoomModel } from '../domain/staff/staffRoom';
import { loadStaffRoomInput } from '../staff/staffRoomData';
import { handleStaffRoomMessage } from '../staff/staffRoomHost';
import { staffHostFor } from '../staff/staffHost';
import { layoutProbeAsset, layoutProbeTag, registerLayoutProbe, sharedMedia } from './layoutProbe';

const MIN_GAP_MS = 250;

let panel: vscode.WebviewPanel | undefined;

/** Set by the extension-host tests to observe the page's messages in both directions. */
export const staffRoomTap: { toView?: (message: unknown) => void; fromView?: (message: unknown) => void } = {};

export function registerStaffRoom(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(OPEN_STAFF_ROOM_COMMAND, () => openStaffRoom(context)));
}

export function openStaffRoom(context: vscode.ExtensionContext): void {
  if (panel) { panel.reveal(); return; }
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'staffRoom');
  const view = vscode.window.createWebviewPanel('nearAiStaffRoom', 'Staff Room', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media, sharedMedia(context.extensionUri)] });
  panel = view;
  view.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  view.webview.html = staffRoomHtml(view.webview, media);
  registerLayoutProbe('staff-room', view.webview);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let wantedRun: string | undefined;
  let model: StaffRoomModel | undefined;
  let pending: StaffEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSent = 0;
  let listening: Array<{ dispose(): void }> = [];
  const post = (message: Record<string, unknown>) => { staffRoomTap.toView?.(message); void view.webview.postMessage(message); };

  const send = async () => {
    timer = undefined;
    lastSent = Date.now();
    if (!root) { post({ type: 'staff-room-empty', reason: 'Open the project folder of a staff team to see its Staff Room.' }); return; }
    const host = staffHostFor(root);
    const fresh = pending;
    pending = [];
    try {
      const input = await loadStaffRoomInput(host, root, Date.now(), wantedRun);
      model = buildStaffRoomModel(input);
      post({ type: STAFF_ROOM_MESSAGE, model, cues: handoffsFor(input.settings, fresh, input.registry) });
    } catch (error) {
      post({ type: 'staff-room-empty', reason: `The Staff Room could not read this project: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  const schedule = () => {
    if (!listening.length || timer) return;
    timer = setTimeout(() => void send(), Math.max(30, MIN_GAP_MS - (Date.now() - lastSent)));
  };
  const start = () => {
    if (listening.length || !root) { if (!root) void send(); return; }
    const host = staffHostFor(root);
    if (host) listening.push({ dispose: host.onEvent((event) => { pending.push(event); if (pending.length > 50) pending = pending.slice(-50); schedule(); }) });
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '.planning/{staff/**,.near-ai/project.json}'));
    watcher.onDidChange(schedule); watcher.onDidCreate(schedule); watcher.onDidDelete(schedule);
    listening.push(watcher);
    void send();
  };
  const stop = () => {
    for (const item of listening) item.dispose();
    listening = [];
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  view.onDidChangeViewState((event) => { if (!event.webviewPanel.visible) stop(); else start(); }, undefined, context.subscriptions);
  view.webview.onDidReceiveMessage(async (raw: unknown) => {
    staffRoomTap.fromView?.(raw);
    await handleStaffRoomMessage(raw, {
      model: () => model,
      runCommand: (command, args) => Promise.resolve(args === undefined ? vscode.commands.executeCommand(command) : vscode.commands.executeCommand(command, args)),
      openFile: async (relative) => {
        if (!root) return;
        const file = path.join(root, relative);
        try { await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true }); } catch { post({ type: 'notice', text: `${relative} is not there.` }); }
      },
      selectRun: (run) => { wantedRun = run; void send(); },
      refresh: () => { if (!listening.length) start(); else void send(); },
      notice: (text) => post({ type: 'notice', text })
    });
  }, undefined, context.subscriptions);
  view.onDidDispose(() => { stop(); panel = undefined; }, undefined, context.subscriptions);
  start();
}

export function staffRoomHtml(webview: Pick<vscode.Webview, 'asWebviewUri' | 'cspSource'>, media: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  const shared = vscode.Uri.joinPath(media, '..', 'shared');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(shared, 'base.css')).toString()}">
<link rel="stylesheet" href="${asset('staffRoom.css')}"><title>Staff Room</title></head><body>
<div id="app" class="app"></div>
<div id="announce" class="visually-hidden" role="status" aria-live="polite"></div>
<div id="alert" class="visually-hidden" role="alert" aria-live="assertive"></div>
${layoutProbeTag(nonce, layoutProbeAsset(webview, shared))}<script nonce="${nonce}" src="${asset('staffMap.js')}"></script>
<script nonce="${nonce}" src="${asset('staffRoom.js')}"></script></body></html>`;
}
