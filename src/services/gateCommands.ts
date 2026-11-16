// The activation adapter of the gate (GATE-04, OFFL-02): builds the GateHost from the editor's own storage and secret store, starts it, and hands it back so
// the chat can give each conversation its runtime. It never throws out of activation: whatever goes wrong in the policy check leaves the gate failed-closed
// (only reading and planning run) with a plain message, and the rest of the extension starts normally.
//
// It also owns what the person sees of the policy (OFFL-02, D-13, D-33, D-41): the status bar item, NEAR AI: Show Policy (a read-only virtual document, so
// nothing is ever written by looking).
import * as vscode from 'vscode';
import { CAPABILITY_VERBS } from '../domain/gate/vocabulary';
import type { BundleState } from '../domain/gate/bundle';
import { CLEARANCE_SELF_ASSERTED_TEXT, SCALE_PRESETS_CAVEAT_TEXT, labelKey } from '../domain/gate/labels';
import { GateHost } from '../gate/host';
import type { SecretStorageLike } from './auth';
import { SHOW_POLICY_COMMAND, createGateStatusBar, expiryDate, policyProblem } from './gateStatusBar';

export const POLICY_SCHEME = 'near-ai-policy';
export const POLICY_DOCUMENT_URI = `${POLICY_SCHEME}:/NEAR-AI-Policy.txt`;

/** Shown above the scales, clearances and routing: this version stores them and does not use them yet. Plan 21 removes it when they are live. */
export const POLICY_LABELS_NOT_USED_TEXT =
  'This version does not use the scales, clearances and routing below yet. They are kept so your policy file does not change when it does.';

export interface GateActivationContext {
  readonly globalStorageUri: { readonly fsPath: string };
  readonly secrets: SecretStorageLike;
  readonly extension?: { readonly packageJSON?: { readonly version?: string } };
  /** Where the commands, the status bar and the setup step are kept so the editor disposes them. Optional so a test context can leave it out. */
  readonly subscriptions?: { push(...items: Array<{ dispose(): unknown }>): unknown };
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The read-only view

function sectionList(lines: readonly string[]): string[] {
  return lines.length === 0 ? ['  none'] : lines.map((line) => `  ${line}`);
}

/**
 * The plain-words view of a policy followed by its exact stored form. Pure. It states the state and the fix when the policy failed, and for a valid policy
 * the ceiling, the scales, clearances and routing it holds and the reserved fields. The scales, clearances and routing are marked as not used by this
 * version, and the clearance is marked as self-declared (D-27), wherever they appear.
 */
export function policyDocumentText(state: BundleState | undefined, now: number): string {
  const lines: string[] = ['Your NEAR AI policy', ''];
  if (state === undefined) {
    lines.push('NEAR AI is checking your policy file. Open this view again in a moment.');
    return lines.join('\n');
  }
  lines.push('This view only shows your policy. Editing it changes nothing. To change the policy file itself, run NEAR AI: Reset Policy to Defaults.', '');
  const problem = policyProblem(state, now);
  if (problem !== undefined || state.state !== 'valid') {
    lines.push('State: not usable, so only reading and planning are allowed', problem ?? '');
    return lines.join('\n');
  }
  const bundle = state.bundle;
  lines.push(
    `State: ${state.renewDue ? 'valid, close to its end and renewed the next time NEAR AI starts' : 'valid'}`,
    `Valid until: ${expiryDate(state.expiresAt)} (${state.expiresAt})`,
    `Signed at: ${bundle.issuedAt}`,
    `Issuer key fingerprint: ${bundle.issuer.fingerprint}`,
    `Policy hash: ${state.hash}`,
    '',
    'The ceiling (the most your policy allows; your settings can only narrow it)',
    '  Highest approval mode in each context:'
  );
  for (const context of Object.keys(bundle.ceiling.maxMode).sort()) {
    lines.push(`    ${context}: ${bundle.ceiling.maxMode[context as keyof typeof bundle.ceiling.maxMode]}`);
  }
  lines.push('  Where each kind of action may run:');
  for (const verb of CAPABILITY_VERBS) {
    const contexts = bundle.ceiling.contexts[verb];
    lines.push(`    ${verb}: ${contexts === undefined || contexts.length === 0 ? 'nowhere' : contexts.join(', ')}`);
  }
  lines.push(
    `  Add-on servers allowed in runs with nobody present: ${bundle.ceiling.unattendedMcp.length === 0 ? 'none' : bundle.ceiling.unattendedMcp.join(', ')}`,
    '',
    POLICY_LABELS_NOT_USED_TEXT,
    '',
    'Scales',
    `  ${SCALE_PRESETS_CAVEAT_TEXT}`,
    ...Object.keys(bundle.scales).sort().map((id) => `  ${id}: ${(bundle.scales[id]?.levels ?? []).join(', ')} (lowest first)`),
    `  Mappings between scales: ${bundle.mappings.length === 0 ? 'none' : String(bundle.mappings.length)}`,
    '',
    'Clearances',
    `  ${CLEARANCE_SELF_ASSERTED_TEXT}`,
    ...sectionList(bundle.clearances.map((clearance) => `${labelKey(clearance)}${clearance.expiresAt === undefined ? '' : `, until ${clearance.expiresAt}`}`)),
    '',
    'Routing tiers (which kind of model each level may be sent to)',
    ...sectionList(Object.keys(bundle.routing.levels).sort().map((key) => `${key}: ${bundle.routing.levels[key] as string}`)),
    '',
    'Reserved fields (read for shape and not used by this version)',
    `  anchorRoots: ${String(bundle.anchorRoots.length)}`,
    `  statusLists: ${String(bundle.statusLists.length)}`,
    `  maxOfflineAge: ${Object.keys(bundle.maxOfflineAge).length === 0 ? 'none' : JSON.stringify(bundle.maxOfflineAge)}`,
    '',
    'The policy as stored (JSON)',
    JSON.stringify(bundle, null, 2)
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Activation

/** Starts the gate. Returns at once with the host; its check finishes in the background and `host.state()` waits for it. */
export function registerGate(context: GateActivationContext, options: RegisterGateOptions = {}): GateHost {
  const notify = options.notify ?? warn;
  const tell = (message: string): void => {
    try { notify(message); } catch { /* a message that cannot be shown never fails activation */ }
  };
  const clock = (): number => {
    try { return (options.now?.() ?? new Date()).getTime(); } catch { return Date.now(); }
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
  registerPolicySurfaces(context, host, tell, clock);
  void host.start().then((state) => {
    if (state.state === 'failed-closed') tell(state.sentence);
  }).catch(() => undefined);
  return host;
}

// The status bar, the two commands and the setup step. Each is set up on its own, so one that cannot be (a command id already taken, a status bar that
// the editor refuses) never stops the gate or the rest of activation.
function registerPolicySurfaces(context: GateActivationContext, host: GateHost, tell: (message: string) => void, clock: () => number): void {
  const keep = (item: { dispose(): unknown }): void => { try { context.subscriptions?.push(item); } catch { /* the editor owns disposal; a test context may not */ } };
  const attempt = (what: string, run: () => void): void => {
    try { run(); } catch { try { tell(`NEAR AI could not set up ${what}.`); } catch { /* ignored */ } }
  };
  attempt('the policy status', () => {
    const bar = createGateStatusBar();
    keep({ dispose: () => { bar.dispose(); } });
    keep({ dispose: host.onDidChange(() => { bar.update(host.bundleState(), clock()); }) });
  });
  attempt('the policy view', () => {
    const changed = new vscode.EventEmitter<vscode.Uri>();
    const provider: vscode.TextDocumentContentProvider = {
      onDidChange: changed.event,
      provideTextDocumentContent: async () => {
        await host.state();
        return policyDocumentText(host.bundleState(), clock());
      }
    };
    keep(vscode.workspace.registerTextDocumentContentProvider(POLICY_SCHEME, provider));
    keep({ dispose: host.onDidChange(() => { changed.fire(vscode.Uri.parse(POLICY_DOCUMENT_URI)); }) });
    keep(vscode.commands.registerCommand(SHOW_POLICY_COMMAND, async () => {
      try {
        await host.state();
        const uri = vscode.Uri.parse(POLICY_DOCUMENT_URI);
        changed.fire(uri);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
      } catch {
        tell('NEAR AI could not open your policy.');
      }
    }));
  });
}
