// The activation adapter of the gate (GATE-04, OFFL-02): builds the GateHost from the editor's own storage and secret store, starts it, and hands it back so
// the chat can give each conversation its runtime. It never throws out of activation: whatever goes wrong in the policy check leaves the gate failed-closed
// (only reading and planning run) with a plain message, and the rest of the extension starts normally.
//
// It also owns what the person sees of the policy (OFFL-02, D-13, D-33, D-41): the status bar item, NEAR AI: Show Policy (a read-only virtual document, so
// nothing is ever written by looking), NEAR AI: Reset Policy to Defaults (confirmed in a modal, recorded, the only path that re-signs a bundle that failed
// verification) and the Policy step in the setup view.
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { CAPABILITY_VERBS } from '../domain/gate/vocabulary';
import type { BundleState } from '../domain/gate/bundle';
import { CLEARANCE_SELF_ASSERTED_TEXT, SCALE_PRESETS_CAVEAT_TEXT, labelKey } from '../domain/gate/labels';
import { BundleStoreError } from '../gate/bundleStore';
import { GateHost } from '../gate/host';
import { setDefaultSessionRoute } from '../gate/sessionMark';
import type { SecretStorageLike } from './auth';
import { SHOW_POLICY_COMMAND, createGateStatusBar, expiryDate, policyProblem } from './gateStatusBar';
import type { GateStatusTimers } from './gateStatusBar';
import { registerSetupStep } from './setupSteps';
import type { SetupStep } from './setupSteps';

export const RESET_POLICY_COMMAND = 'nearAi.policy.reset';
export const POLICY_SCHEME = 'near-ai-policy';
export const POLICY_DOCUMENT_URI = `${POLICY_SCHEME}:/NEAR-AI-Policy.txt`;

/** Shown above the scales, clearances and routing: this version stores them and does not use them yet. Plan 21 removes it when they are live. */
export const POLICY_LABELS_NOT_USED_TEXT =
  'This version does not use the scales, clearances and routing below yet. They are kept so your policy file does not change when it does.';

export const RESET_CONFIRM_ACTION = 'Reset Policy';
export const RESET_TITLE = 'Reset your policy to the default?';
export const RESET_DETAIL =
  "This replaces your policy file with the default policy and signs it with this computer's key. Your current file is kept beside it. Anything your policy narrowed is allowed again, up to what your settings allow.";
export const RESET_DONE_TEXT = 'Your policy was reset to the default. Your old policy file was kept beside the new one.';
export const RESET_FAILED_TEXT = 'Nothing was changed: NEAR AI could not reset your policy.';

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
  /** The timers the policy status bar refreshes itself with, for tests. */
  readonly statusTimers?: GateStatusTimers;
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
    lines.push('State: not usable, so only reading and planning are allowed');
    // The sentence is its own line when there is one; a state with none adds nothing, not a blank line.
    if (problem) lines.push(problem);
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
// The setup step

/** The fixed words of the Policy step. `policySetupStep` adds what depends on the gate's state. */
export const POLICY_SETUP_STEP = Object.freeze({
  id: 'policy',
  label: 'Check your policy',
  icon: 'shield',
  command: SHOW_POLICY_COMMAND
});

const POLICY_STEP_VALID_DETAIL = 'Your policy is signed and valid. You can read it here.';

/** The step is done when the policy is valid, and shows the status bar's own sentence when it is not (D-13). */
export function policySetupStep(host: GateHost, now: () => number = () => host.now()): SetupStep {
  return {
    ...POLICY_SETUP_STEP,
    get detail(): string {
      return policyProblem(host.bundleState(), now()) ?? POLICY_STEP_VALID_DETAIL;
    },
    async isDone(): Promise<boolean> {
      await host.state();
      return policyProblem(host.bundleState(), now()) === undefined;
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Activation

/** Starts the gate. Returns at once with the host; its check finishes in the background and `host.state()` waits for it. */
export function registerGate(context: GateActivationContext, options: RegisterGateOptions = {}): GateHost {
  const notify = options.notify ?? warn;
  const tell = (message: string): void => {
    try { notify(message); } catch { /* a message that cannot be shown never fails activation */ }
  };
  // Asked when each record is written, so a folder opened, closed or changed after activation is followed: the policy's events go to the folder that is open
  // then, and to the install-level log always.
  const projectRoot = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const host = new GateHost({
    globalStorageDir: context.globalStorageUri.fsPath,
    secrets: context.secrets,
    productVersion: String(context.extension?.packageJSON?.version ?? '0.0.0'),
    // The floor reads shell commands for the credential stores in the person's home folder (D-16); it only resolves paths, it never opens one.
    home: homedir(),
    projectRoot,
    onProblem: tell,
    ...(options.now === undefined ? {} : { now: options.now })
  });
  // Every surface reads the host's own time (the later of the clock and the latest time it has seen), so none shows a policy as valid that a decision refuses
  // after the clock was set back.
  const clock = (): number => {
    try { return host.now(); } catch { return Date.now(); }
  };
  registerPolicySurfaces(context, host, tell, clock, options.statusTimers);
  // CLAS-06: a model request made outside every session route is still decided by this host's policy and recorded in the open project's log.
  setDefaultSessionRoute(host.sessionRouteWithoutContext());
  // A closed folder's decision log is let go when the window's folders change, so a long session does not keep one per folder it ever opened.
  try {
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      try { host.retainProjectLogs((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)); } catch { /* the cap still bounds the logs */ }
    });
    context.subscriptions?.push(subscription);
  } catch { /* an editor with no folder events still has the cap (MAX_PROJECT_LOGS) */ }
  void host.start().then((state) => {
    if (state.state === 'failed-closed') tell(state.sentence);
  }).catch(() => undefined);
  return host;
}

// The status bar, the two commands and the setup step. Each is set up on its own, so one that cannot be (a command id already taken, a status bar that
// the editor refuses) never stops the gate or the rest of activation.
function registerPolicySurfaces(context: GateActivationContext, host: GateHost, tell: (message: string) => void, clock: () => number, statusTimers?: GateStatusTimers): void {
  const keep = (item: { dispose(): unknown }): void => { try { context.subscriptions?.push(item); } catch { /* the editor owns disposal; a test context may not */ } };
  const attempt = (what: string, run: () => void): void => {
    try { run(); } catch { try { tell(`NEAR AI could not set up ${what}.`); } catch { /* ignored */ } }
  };
  attempt('the policy status', () => {
    // The bar reads the host again when its words are due to change (the renewal window opening, the policy ending), so it never waits for a host change.
    const bar = createGateStatusBar({ read: () => ({ state: host.bundleState(), now: clock() }), ...(statusTimers === undefined ? {} : { timers: statusTimers }) });
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
  attempt('Reset Policy to Defaults', () => {
    keep(vscode.commands.registerCommand(RESET_POLICY_COMMAND, () => resetPolicy(host)));
  });
  attempt('the policy setup step', () => {
    keep(registerSetupStep(policySetupStep(host, clock)));
  });
}

/** The only path that re-signs a bundle that failed verification: a modal the person confirms, then host.reset(), which records policy.reset. */
export async function resetPolicy(host: GateHost): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(RESET_TITLE, { modal: true, detail: RESET_DETAIL }, RESET_CONFIRM_ACTION);
  if (answer !== RESET_CONFIRM_ACTION) return false;
  try {
    const result = await host.reset();
    if (result.state.state === 'valid') {
      void Promise.resolve(vscode.window.showInformationMessage(RESET_DONE_TEXT)).catch(() => undefined);
      return true;
    }
    void Promise.resolve(vscode.window.showWarningMessage(result.state.sentence)).catch(() => undefined);
    return false;
  } catch (error) {
    const message = error instanceof BundleStoreError ? error.message : RESET_FAILED_TEXT;
    void Promise.resolve(vscode.window.showErrorMessage(message)).catch(() => undefined);
    return false;
  }
}
