// The Staff Room panel (UX concept 4, 5 and 12; owner direction 2026-11-18; WP-ROOM): one editor panel for a staff run, with a workspace per section
// and the war room for the full staff, sharing one map, the product ledger, the human decisions and one clock.
//
// The host builds the whole picture (src/domain/staff/staffRoom.ts) from the staff host's ledger and events and the files under .planning/staff/, and
// sends it with the hand-offs the new events stand for. It listens to the staff host's events and to changes under .planning/staff/, coalescing them to
// at most four pictures a second, and nothing while the panel is hidden; shown again, it sends the whole picture, so a page VS Code kept alive or one
// rebuilt after a reload draws the same thing. Every message from the page is validated (src/staff/staffRoomHost.ts), and a decision button only runs a
// person-only staff command, which asks who the person is, confirms in a modal dialog and signs.
//
// The map (WP-COP): the page embeds the COP map component (media/staff/copMap.js, MapLibre and milsymbol vendored under media/vendor) through its
// interface, and falls back to its SVG map with the reason when WebGL or the library is not there. The host sends the COP picture beside the model,
// only when it changed (or the page asked for everything), built from the scenario, the product layers and the observations the person's clearance
// covers (src/staff/staffRoomPicture.ts). The page's policy is the COP map's (src/staff/copMapWebview.ts copMapCsp): scripts only by nonce, the worker
// from a blob, fetches only from the extension; no 'unsafe-eval', no 'unsafe-inline', no remote source.
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { OPEN_STAFF_ROOM_COMMAND } from '../domain/staff/commands';
import type { StaffEvent } from '../domain/staff/events';
import { buildStaffRoomModel, handoffsFor, STAFF_ROOM_MESSAGE, staffRoomWorkspaceOf } from '../domain/staff/staffRoom';
import type { StaffRoomModel, StaffRoomWorkspace } from '../domain/staff/staffRoom';
import { labelRecordFilter } from '../agent/gateLabels';
import type { GateHost } from '../gate/host';
import { copMapCsp, copMapResources } from '../staff/copMapWebview';
import { observationStoreFor } from '../staff/observationStore';
import type { ObsReader } from '../staff/observationStore';
import { loadStaffRoomInput } from '../staff/staffRoomData';
import { staffRoomPicture } from '../staff/staffRoomPicture';
import { currentFeedRuntime } from './staffSimCommand';

/** How often the open Staff Room runs the store's track decay, in milliseconds. */
export const ROOM_TICK_EVERY_MS = 10_000;
import { handleStaffRoomMessage } from '../staff/staffRoomHost';
import { staffHostFor } from '../staff/staffHost';
import { attend } from '../staff/watchAttendance';
import { watchHostFor } from '../staff/watchHost';
import { layoutProbeAsset, layoutProbeTag, registerLayoutProbe, sharedMedia } from './layoutProbe';

const MIN_GAP_MS = 250;

let panel: vscode.WebviewPanel | undefined;

/** Set by the extension-host tests to observe the page's messages in both directions. */
export const staffRoomTap: { toView?: (message: unknown) => void; fromView?: (message: unknown) => void } = {};

export function registerStaffRoom(context: vscode.ExtensionContext, gate?: Pick<GateHost, 'runtimeFor'>): void {
  // An optional argument opens the room on one workspace ('j5', 'j3', ...); anything else is ignored and the room opens where the person left it.
  context.subscriptions.push(vscode.commands.registerCommand(OPEN_STAFF_ROOM_COMMAND, (workspace?: unknown) => openStaffRoom(context, gate, staffRoomWorkspaceOf(workspace))));
}

/** The folders the page may load from: its own, the shared stylesheet, the COP map component and the vendored map libraries. Nothing else. */
export function staffRoomResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'media', 'staffRoom'), sharedMedia(extensionUri), vscode.Uri.joinPath(extensionUri, 'media', 'staff'), vscode.Uri.joinPath(extensionUri, 'media', 'vendor')];
}

/**
 * Whether the person at this window may read an observation's label: the gate's own check for a person in an interactive session, the one the
 * observation tools use. No gate host means no reader, and then no observation is read.
 */
async function personReader(gate: Pick<GateHost, 'runtimeFor'> | undefined, root: string): Promise<ObsReader | undefined> {
  if (!gate) return undefined;
  try {
    return labelRecordFilter(await gate.runtimeFor({ root, actor: { kind: 'person', sessionId: 'staff-room' }, presence: 'person', context: 'interactive' }));
  } catch {
    return undefined;
  }
}

export function openStaffRoom(context: vscode.ExtensionContext, gate?: Pick<GateHost, 'runtimeFor'>, workspace?: StaffRoomWorkspace): void {
  if (panel) { panel.reveal(); if (workspace) void panel.webview.postMessage({ type: 'show-workspace', workspace }); return; }
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'staffRoom');
  const view = vscode.window.createWebviewPanel('nearAiStaffRoom', 'Staff Room', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: staffRoomResourceRoots(context.extensionUri) });
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
  /** The picture last sent, as text: an unchanged picture is not sent again until the page asks for everything. */
  let lastPicture: string | undefined;
  /** The workspace the open command asked for, shown once the page has its first picture. */
  let showFirst = workspace;
  const post = (message: Record<string, unknown>) => { staffRoomTap.toView?.(message); void view.webview.postMessage(message); };

  const send = async () => {
    timer = undefined;
    lastSent = Date.now();
    if (!root) { post({ type: 'staff-room-empty', reason: 'Open the project folder of a staff team to see its Staff Room.' }); return; }
    const host = staffHostFor(root);
    const fresh = pending;
    pending = [];
    try {
      const store = observationStoreFor(root);
      const reader = await personReader(gate, root);
      // The J2 workspace's live reports: the store's rows the person's clearance covers, read through the same reader view as the map's.
      const view = store && reader ? await store.view(reader).catch(() => undefined) : undefined;
      const input = await loadStaffRoomInput(host, root, Date.now(), wantedRun, view?.ok ? { live: view.value.rows } : {});
      model = buildStaffRoomModel(input);
      const cop = await staffRoomPicture(root, { ...(store ? { store } : {}), reader });
      const text = cop.picture ? JSON.stringify(cop.picture) : `problem:${cop.problem ?? ''}`;
      const changed = text !== lastPicture;
      lastPicture = text;
      post({
        type: STAFF_ROOM_MESSAGE, model, cues: handoffsFor(input.settings, fresh, input.registry), pictureNow: cop.now,
        ...(changed ? (cop.picture ? { picture: cop.picture } : { pictureProblem: cop.problem }) : {})
      });
      if (showFirst) { post({ type: 'show-workspace', workspace: showFirst }); showFirst = undefined; }
    } catch (error) {
      post({ type: 'staff-room-empty', reason: `The Staff Room could not read this project: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
  const schedule = () => {
    if (!listening.length || timer) return;
    timer = setTimeout(() => void send(), Math.max(30, MIN_GAP_MS - (Date.now() - lastSent)));
  };
  const start = () => {
    lastPicture = undefined;
    if (listening.length || !root) { if (!root) void send(); return; }
    const host = staffHostFor(root);
    if (host) listening.push({ dispose: host.onEvent((event) => { pending.push(event); if (pending.length > 50) pending = pending.slice(-50); schedule(); }) });
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '.planning/{staff/**,.near-ai/project.json}'));
    watcher.onDidChange(schedule); watcher.onDidCreate(schedule); watcher.onDidDelete(schedule);
    listening.push(watcher);
    // Track decay while the room is open: tracks go stale, then lost, even when no report arrives. A running simulation's feed runtime ticks the same
    // store on its own timer; a decay pass records each change once, so two passes never double an event.
    const ticker = setInterval(() => {
      const runtime = currentFeedRuntime();
      const store = observationStoreFor(root);
      void (runtime ? runtime.tick() : store?.tick())?.then(() => schedule(), () => undefined);
    }, ROOM_TICK_EVERY_MS);
    listening.push({ dispose: () => clearInterval(ticker) });
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
      refresh: () => { lastPicture = undefined; if (!listening.length) start(); else void send(); },
      notice: (text) => post({ type: 'notice', text })
    });
  }, undefined, context.subscriptions);
  // An open Staff Room is a person attending the project: its standing watches run while it is open, and pause when nothing attends (WP-WATCH, Q5).
  if (root) watchHostFor(root);
  const releaseAttendance = root ? attend(root, { kind: 'staff-room', id: 'panel' }) : () => undefined;
  view.onDidDispose(() => { stop(); releaseAttendance(); panel = undefined; }, undefined, context.subscriptions);
  start();
}

export function staffRoomHtml(webview: Pick<vscode.Webview, 'asWebviewUri' | 'cspSource'>, media: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  const shared = vscode.Uri.joinPath(media, '..', 'shared');
  const cop = copMapResources((file) => webview.asWebviewUri(vscode.Uri.joinPath(media, '..', ...file.split('/'))).toString());
  const attribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${copMapCsp(webview.cspSource, nonce)}">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(shared, 'base.css')).toString()}">
<link rel="stylesheet" href="${cop.maplibreStyle}"><link rel="stylesheet" href="${cop.style}">
<link rel="stylesheet" href="${asset('staffRoom.css')}"><title>Staff Room</title></head><body>
<div id="app" class="app" data-cop-resources="${attribute(JSON.stringify({ maplibre: cop.maplibre, worker: cop.worker, milsymbol: cop.milsymbol }))}"></div>
<div id="announce" class="visually-hidden" role="status" aria-live="polite"></div>
<div id="alert" class="visually-hidden" role="alert" aria-live="assertive"></div>
${layoutProbeTag(nonce, layoutProbeAsset(webview, shared))}<script nonce="${nonce}" src="${cop.declutter}"></script>
<script nonce="${nonce}" src="${cop.script}"></script>
<script nonce="${nonce}" src="${asset('staffMap.js')}"></script>
<script nonce="${nonce}" src="${asset('staffWorkspaces.js')}"></script>
<script nonce="${nonce}" src="${asset('staffRoom.js')}"></script></body></html>`;
}
