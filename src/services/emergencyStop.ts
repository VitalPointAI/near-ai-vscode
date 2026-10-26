import { EventEmitter } from 'node:events';
import * as vscode from 'vscode';

const STATE_KEY = 'nearAi.emergencyStop';
// A Node emitter, so importing this module needs no VS Code API until activation.
const changes = new EventEmitter();
let memento: vscode.Memento | undefined;

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
  sync(isEmergencyStopped());
  context.subscriptions.push(item, onDidChangeEmergencyStop(sync));
}

export function isEmergencyStopped(): boolean {
  return memento?.get<boolean>(STATE_KEY, false) ?? false;
}

export async function setEmergencyStop(engaged: boolean): Promise<void> {
  await memento?.update(STATE_KEY, engaged);
  changes.emit('change', engaged);
}
