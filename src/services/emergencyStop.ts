import { EventEmitter } from 'node:events';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const STATE_KEY = 'nearAi.emergencyStop';
// A Node emitter, so importing this module needs no VS Code API until activation.
const changes = new EventEmitter();
let memento: vscode.Memento | undefined;
/**
 * Where every window shares the stop. globalState is per-window in memory and VS Code does not promise to refresh it from another window's write, so it
 * cannot carry a safety signal across windows. A small file in the extension's global storage folder (one folder for every window) can: each window reads
 * it directly.
 */
let sharedFile: string | undefined;
/** This window's state: what isEmergencyStopped answers, and what it last announced. */
let current = false;
/** True while this window is writing a change, so the check never reads a half-finished write and announces the opposite state. */
let writing = false;
/** How often a window checks the shared file for a stop or resume pressed in another window. */
const OTHER_WINDOWS_CHECK_MS = 2_000;

/** Fires with the new state whenever the emergency stop is engaged or released. */
export function onDidChangeEmergencyStop(listener: (engaged: boolean) => unknown, thisArgs?: unknown, disposables?: vscode.Disposable[]): vscode.Disposable {
  const handler = (engaged: boolean) => { void listener.call(thisArgs, engaged); };
  changes.on('change', handler);
  const disposable = { dispose: () => { changes.off('change', handler); } };
  disposables?.push(disposable);
  return disposable;
}

/** The stop as the shared file records it, or undefined when there is no readable file yet. */
function readShared(): boolean | undefined {
  if (!sharedFile) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(sharedFile, 'utf8')) as { engaged?: unknown };
    return typeof parsed.engaged === 'boolean' ? parsed.engaged : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the shared file whole (temp, then rename), so another window never reads half of it. */
function writeShared(engaged: boolean): void {
  if (!sharedFile) return;
  mkdirSync(path.dirname(sharedFile), { recursive: true });
  const temporary = `${sharedFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ engaged, at: new Date().toISOString() }));
  renameSync(temporary, sharedFile);
}

/** Removes temporary files a crashed window left beside the shared file (older than a minute, so a write in progress elsewhere is never touched). */
function sweepTemporaries(): void {
  if (!sharedFile) return;
  const dir = path.dirname(sharedFile);
  const prefix = `${path.basename(sharedFile)}.`;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const file = path.join(dir, name);
      try { if (Date.now() - statSync(file).mtimeMs > 60_000) unlinkSync(file); } catch { /* gone already, or in use */ }
    }
  } catch { /* no folder yet */ }
}

/** Stored in global state and in the shared file, so a stop survives reloads until the user resumes and reaches every open window. */
export function initEmergencyStop(context: vscode.ExtensionContext): void {
  memento = context.globalState;
  sharedFile = context.globalStorageUri ? path.join(context.globalStorageUri.fsPath, 'emergency-stop.json') : undefined;
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  item.text = '$(debug-stop) NEAR AI stopped';
  item.tooltip = 'Emergency stop is on: NEAR AI sends nothing and runs nothing. Click to resume.';
  item.command = 'nearAi.resume';
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  const sync = (engaged: boolean) => { if (engaged) item.show(); else item.hide(); };
  sweepTemporaries();
  // The shared file is the newest word from any window, so it wins over global state when both exist: this window's copy of global state can be stale
  // (another window resumed, and VS Code does not promise to refresh it here). Global state covers a machine that stopped before the file existed.
  const shared = readShared();
  current = shared ?? memento.get<boolean>(STATE_KEY, false) ?? false;
  // A stop recorded only in global state (before the shared file existed) is written out, so the other open windows learn of it too.
  if (shared === undefined && current) { try { writeShared(true); } catch { /* this window still stops */ } }
  sync(current);
  const watch = setInterval(checkOtherWindows, OTHER_WINDOWS_CHECK_MS);
  watch.unref?.();
  context.subscriptions.push(item, onDidChangeEmergencyStop(sync), { dispose: () => clearInterval(watch) });
}

/**
 * Picks up a stop or resume pressed in another window: it stops this window's runs too (chat and every page listen to the same change), and shows or
 * hides the status item here. Exported for tests; runs on a timer after initEmergencyStop.
 */
export function checkOtherWindows(): void {
  if (writing) return;
  const shared = readShared();
  if (shared === undefined || shared === current) return;
  current = shared;
  void memento?.update(STATE_KEY, shared).then(undefined, () => undefined);
  changes.emit('change', shared);
}

export function isEmergencyStopped(): boolean {
  return current;
}

export async function setEmergencyStop(engaged: boolean): Promise<void> {
  writing = true;
  try {
    current = engaged;
    // The file first: it is what other windows read, and a stop should reach them even if the global-state write is slow.
    try { writeShared(engaged); } catch { /* other windows will not see it; this window still stops, and global state still records it */ }
    await memento?.update(STATE_KEY, engaged);
  } finally {
    writing = false;
  }
  changes.emit('change', engaged);
}
