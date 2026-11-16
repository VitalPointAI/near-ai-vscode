// The activation adapter of the gate (GATE-04, OFFL-02): builds the GateHost from the editor's own storage and secret store, starts it, and hands it back so
// the chat can give each conversation its runtime. It never throws out of activation: whatever goes wrong in the policy check leaves the gate failed-closed
// (only reading and planning run) with a plain message, and the rest of the extension starts normally.
import * as vscode from 'vscode';
import { GateHost } from '../gate/host';
import type { SecretStorageLike } from './auth';

export interface GateActivationContext {
  readonly globalStorageUri: { readonly fsPath: string };
  readonly secrets: SecretStorageLike;
  readonly extension?: { readonly packageJSON?: { readonly version?: string } };
}

export interface RegisterGateOptions {
  /** Shows a plain message to the person. Defaults to a VS Code warning. */
  readonly notify?: (message: string) => void;
  /** The clock for the policy check, for tests. */
  readonly now?: () => Date;
}

function warn(message: string): void {
  void Promise.resolve(vscode.window.showWarningMessage(message)).catch(() => undefined);
}

/** Starts the gate. Returns at once with the host; its check finishes in the background and `host.state()` waits for it. */
export function registerGate(context: GateActivationContext, options: RegisterGateOptions = {}): GateHost {
  const notify = options.notify ?? warn;
  const tell = (message: string): void => {
    try { notify(message); } catch { /* a message that cannot be shown never fails activation */ }
  };
  let projectRoot: string | undefined;
  try {
    projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  } catch {
    projectRoot = undefined;
  }
  const host = new GateHost({
    globalStorageDir: context.globalStorageUri.fsPath,
    secrets: context.secrets,
    productVersion: String(context.extension?.packageJSON?.version ?? '0.0.0'),
    ...(projectRoot === undefined ? {} : { projectRoot }),
    onProblem: tell,
    ...(options.now === undefined ? {} : { now: options.now })
  });
  void host.start().then((state) => {
    if (state.state === 'failed-closed') tell(state.sentence);
  }).catch(() => undefined);
  return host;
}
