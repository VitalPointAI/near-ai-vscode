import { EventEmitter } from 'node:events';
import * as vscode from 'vscode';

const STATE_KEY = 'nearAi.emergencyStop';
// A Node emitter, so importing this module needs no VS Code API until activation.
const changes = new EventEmitter();
let memento: vscode.Memento | undefined;
/** The state this window last announced, so a change made in another window is noticed and announced once. */
let announced = false;
/** Global state is shared by every window, but VS Code tells only the window that wrote it, so the others check it on this interval. */
const OTHER_WINDOWS_CHECK_MS = 2_000;

/** Fires with the new state whenever the emergency stop is engaged or released. */
export function onDidChangeEmergencyStop(listener: (engaged: boolean) => unknown, thisArgs?: unknown, disposables?: vscode.Disposable[]): vscode.Disposable {
  const handler = (engaged: boolean) => { void listener.call(thisArgs, engaged); };
  changes.on('change', handler);
  const disposable = { dispose: () => { changes.off('change', handler); } };
  disposables?.push(disposable);
  return disposable;
}

/** Stored in global state so a stop survives reloads until the user resumes. */
export function initEmergencyStop(context: vscode.ExtensionContext): void {
  memento = context.globalState;
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  item.text = '$(debug-stop) NEAR AI stopped';
  item.tooltip = 'Emergency stop is on: NEAR AI sends nothing and runs nothing. Click to resume.';
  item.command = 'nearAi.resume';
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  const sync = (engaged: boolean) => { if (engaged) item.show(); else item.hide(); };
  announced = isEmergencyStopped();
  sync(announced);
  // A stop pressed in another window stops this window's runs too, within a couple of seconds, and shows the status item here.
  const watch = setInterval(() => {
    const engaged = isEmergencyStopped();
    if (engaged === announced) return;
    announced = engaged;
    changes.emit('change', engaged);
  }, OTHER_WINDOWS_CHECK_MS);
  watch.unref?.();
  context.subscriptions.push(item, onDidChangeEmergencyStop(sync), { dispose: () => clearInterval(watch) });
}

export function isEmergencyStopped(): boolean {
  return memento?.get<boolean>(STATE_KEY, false) ?? false;
}

export async function setEmergencyStop(engaged: boolean): Promise<void> {
  // Recorded as announced BEFORE the write, so the other-window check cannot see the new value first and announce it a second time.
  announced = engaged;
  await memento?.update(STATE_KEY, engaged);
  changes.emit('change', engaged);
}
