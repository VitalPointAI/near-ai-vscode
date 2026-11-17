// The activation adapter of the gate (GATE-04, OFFL-02): builds the GateHost from the editor's own storage and secret store, starts it, and hands it back so
// the chat can give each conversation its runtime. It never throws out of activation: whatever goes wrong in the policy check leaves the gate failed-closed
// (only reading and planning run) with a plain message, and the rest of the extension starts normally.
//
// It also owns what the person sees of the policy (OFFL-02, D-13, D-33, D-41): the status bar item, NEAR AI: Show Policy (a read-only virtual document, so
// nothing is ever written by looking), NEAR AI: Reset Policy to Defaults (confirmed in a modal, recorded, the only path that re-signs a bundle that failed
// verification) and the Policy step in the setup view.
import { readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CAPABILITY_VERBS } from '../domain/gate/vocabulary';
import type { BundleState } from '../domain/gate/bundle';
import { CLEARANCE_SELF_ASSERTED_TEXT, HANDLING_FLAGS, LABELS_NOT_ACCREDITATION_TEXT, LABEL_TOKEN_PATTERN, SCALE_PRESETS_CAVEAT_TEXT, labelKey, parseLabel } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { dominates, raiseMark } from '../domain/gate/dominance';
import { labelMapKey, setLabelEntry, setProjectLabel } from '../domain/gate/labelMap';
import { BundleStoreError, POLICY_DRAFT_BASE_FILE, POLICY_DRAFT_FILE, gateDir } from '../gate/bundleStore';
import { writeFileAtomic } from '../team/teamFile';
import { GateHost } from '../gate/host';
import { LABEL_MAP_RESIGN_QUESTION, LABEL_MAP_RESTORE_QUESTION, LabelMapError } from '../gate/labelMapStore';
import { setDefaultSessionRoute } from '../gate/sessionMark';
import type { SecretStorageLike } from './auth';
import { SHOW_POLICY_COMMAND, createGateStatusBar, expiryDate, policyProblem } from './gateStatusBar';
import type { GateStatusTimers } from './gateStatusBar';
import { registerSetupStep } from './setupSteps';
import type { SetupStep } from './setupSteps';

export const RESET_POLICY_COMMAND = 'nearAi.policy.reset';
export const SET_LABEL_COMMAND = 'nearAi.label.set';
export const EDIT_POLICY_COMMAND = 'nearAi.policy.edit';
export const APPLY_POLICY_DRAFT_COMMAND = 'nearAi.policy.applyDraft';
export const APPLY_DRAFT_ACTION = 'Apply';
export const DISCARD_DRAFT_ACTION = 'Discard';

/** Pitfall 14: unlabelled content takes the default label, so a policy with no clearance on that scale cannot read it. */
export function unlabelledDefaultText(defaultLabel: Label): string {
  return `Content with no label takes your policy's default label, ${labelKey(defaultLabel)}, so a policy with no clearance on the ${defaultLabel.scale} scale cannot read it.`;
}

/** What Edit Policy says beside the draft it opens (D-27, D-41, CLAS-07). */
export function editPolicyNotice(defaultLabel: Label): string {
  return `Your policy draft is open. Change it, then choose Apply, or run NEAR AI: Apply Policy Draft. NEAR AI signs and records the change and sets the signer and the dates itself. ${unlabelledDefaultText(defaultLabel)} ${CLEARANCE_SELF_ASSERTED_TEXT} ${LABELS_NOT_ACCREDITATION_TEXT}`;
}

export const POLICY_APPLIED_TEXT = `Your policy was changed, signed with this computer's key and recorded. ${CLEARANCE_SELF_ASSERTED_TEXT}`;
export const NO_DRAFT_TEXT = 'There is no policy draft to apply. Run NEAR AI: Edit Policy first.';
export const POLICY_SCHEME = 'near-ai-policy';
export const POLICY_DOCUMENT_URI = `${POLICY_SCHEME}:/NEAR-AI-Policy.txt`;

/**
 * Shown above the scales, clearances and routing. From PR 4a the routing is used: every model request is checked against it, at the default label because
 * nothing can be labelled yet. The scales and clearances are stored and not used yet. Plan 21 removes the rest of this line when they are live.
 */
export const POLICY_LABELS_NOT_USED_TEXT =
  'This version checks every model request against the routing below, at your policy\'s default label, because nothing can be labelled yet. It does not use the scales and clearances below yet. They are kept so your policy file does not change when it does.';

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
  // It is cleared at deactivation (the context's subscriptions are disposed then), and only while it is still this host's (PR 4a review).
  const clearDefaultRoute = setDefaultSessionRoute(host.sessionRouteWithoutContext());
  try { context.subscriptions?.push({ dispose: clearDefaultRoute }); } catch { /* an editor that cannot take it still replaces the route at the next activation */ }
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
  attempt('Edit Policy', () => {
    keep(vscode.commands.registerCommand(EDIT_POLICY_COMMAND, () => editPolicy(host, context.globalStorageUri.fsPath).catch(() => { tell('NEAR AI could not open a policy draft.'); return undefined; })));
    keep(vscode.commands.registerCommand(APPLY_POLICY_DRAFT_COMMAND, () => applyPolicyDraftCommand(host, context.globalStorageUri.fsPath)));
  });
  attempt('Set Label', () => {
    keep(vscode.commands.registerCommand(SET_LABEL_COMMAND, async (uri?: unknown) => {
      const target = await labelTargetOf(uri);
      if (target === undefined) {
        tell('Open a folder first: labels are kept in the project.');
        return false;
      }
      return setLabel(host, target);
    }));
  });
  attempt('label rename tracking', () => {
    keep(vscode.workspace.onDidRenameFiles((event) => followRenames(host, event.files)));
  });
  attempt('the policy setup step', () => {
    keep(registerSetupStep(policySetupStep(host, clock)));
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Set Label (CLAS-01, CLAS-02, CLAS-07, D-25, D-27, D-33, GATE-07)

/** The scales whose levels come from secondary copies or a reading of their families, which the caveat is shown beside (D-23). */
const CAVEAT_SCALES: ReadonlySet<string> = new Set(['ca-protected', 'ca-classified', 'nato']);

export const REMOVE_LABEL_ITEM = 'Remove this label';
export const SIGN_AGAIN_ACTION = 'Sign Again';
export const LOWER_REASON_PROMPT = 'This lowers the label. Say why, in a few words. The reason is kept in this project\'s decision record.';
export const COMPARTMENTS_PROMPT = 'Compartments (optional): capital letters and digits, separated by spaces. Leave empty for none.';
export const HANDLING_PLACEHOLDER = 'Handling (optional): local-only keeps it on this computer, no-agent-tools keeps agents from reading it.';

/** The words of the refusal when the person's own clearance does not cover the label they chose (D-27). */
export function notYourClearanceText(label: Label): string {
  return `You cannot set ${labelKey(label)}: your policy gives you no clearance that covers it, so you could not read what you label. Add a clearance with NEAR AI: Edit Policy first. ${CLEARANCE_SELF_ASSERTED_TEXT}`;
}

/** What Set Label acts on: a project, and a project-relative path in it (a folder ends with `/`, the project itself is the empty path). */
export interface LabelTarget {
  readonly root: string;
  readonly path: string;
}

function labelShown(label: Label): string {
  const parts = [labelKey(label)];
  if (label.compartments.length > 0) parts.push(`compartments ${label.compartments.join(', ')}`);
  if (label.handling.length > 0) parts.push(label.handling.join(', '));
  return parts.join(', ');
}

/** True when `next` is lower than `current` on some scale: raising `next` by every label of `current` changes it. */
function lowers(current: readonly Label[], next: Label | undefined, scales: Parameters<typeof raiseMark>[2]): boolean {
  if (next === undefined) return current.length > 0;
  let raised: readonly Label[] = [next];
  for (const label of current) raised = raiseMark(raised, label, scales);
  return JSON.stringify(raised) !== JSON.stringify([next]);
}

/**
 * NEAR AI: Set Label. Before the first pick the person sees LABELS_NOT_ACCREDITATION_TEXT (CLAS-07), and beside the government and NATO scales the scales
 * caveat (CLAS-02). The person picks a scale, a level, optional compartments and handling flags. A label their own clearance does not cover is refused with
 * the Edit Policy hint (D-27); lowering a label asks for a reason. The change is signed into the project's label file and recorded as label.set.
 * Returns true when a label was set or removed.
 */
export async function setLabel(host: GateHost, target: LabelTarget): Promise<boolean> {
  await host.state();
  const policy = host.labelPolicy();
  const key = target.path === '' ? '' : labelMapKey(target.path.replace(/\/$/, ''), target.path.endsWith('/'));
  if (typeof key !== 'string' && !key.ok) {
    void Promise.resolve(vscode.window.showWarningMessage('NEAR AI cannot label that path. Pick a file or folder inside the project.')).catch(() => undefined);
    return false;
  }
  const keyText = typeof key === 'string' ? key : key.value;
  const view = await host.labelsFor(target.root).view(policy.scales);
  const current = view.resolve(keyText, policy.defaultLabel);
  const own = current.origin === (keyText === '' ? 'project' : keyText.endsWith('/') ? 'folder' : 'file');
  const shownTarget = keyText === '' ? 'this project' : keyText;
  type ScaleItem = vscode.QuickPickItem & { readonly scale?: string; readonly remove?: true };
  const scaleItems: ScaleItem[] = Object.keys(policy.scales).sort().map((scale) => ({
    label: scale,
    description: policy.scales[scale]?.name ?? scale,
    ...(CAVEAT_SCALES.has(scale) ? { detail: SCALE_PRESETS_CAVEAT_TEXT } : {}),
    scale
  }));
  if (own) scaleItems.push({ label: REMOVE_LABEL_ITEM, description: `now ${labelShown(current.mark[0]!)}`, remove: true });
  // CLAS-07: the not-accreditation words come before the first choice, even on a fresh install with no label anywhere.
  const scalePick = await vscode.window.showQuickPick(scaleItems, { title: `Set the label of ${shownTarget}`, placeHolder: LABELS_NOT_ACCREDITATION_TEXT });
  if (scalePick === undefined) return false;
  let label: Label | undefined;
  if (scalePick.remove !== true) {
    const scale = scalePick.scale!;
    const levels = policy.scales[scale]?.levels ?? [];
    const levelPick = await vscode.window.showQuickPick(levels.map((level) => ({ label: level })), { title: `Level on ${scale}`, placeHolder: CAVEAT_SCALES.has(scale) ? SCALE_PRESETS_CAVEAT_TEXT : 'Pick a level, lowest first.' });
    if (levelPick === undefined) return false;
    const typed = await vscode.window.showInputBox({ prompt: COMPARTMENTS_PROMPT, title: 'Compartments', validateInput: (value: string) => (value.trim() === '' || value.trim().split(/\s+/).every((token) => LABEL_TOKEN_PATTERN.test(token)) ? undefined : 'Use capital letters and digits, with - or _ after the first one, up to 32 characters each.') });
    if (typed === undefined) return false;
    const compartments = [...new Set(typed.trim() === '' ? [] : typed.trim().split(/\s+/))].sort();
    const handlingPick = await vscode.window.showQuickPick(HANDLING_FLAGS.map((flag) => ({ label: flag })), { title: 'Handling', placeHolder: HANDLING_PLACEHOLDER, canPickMany: true });
    if (handlingPick === undefined) return false;
    const handling = (handlingPick as readonly vscode.QuickPickItem[]).map((item) => item.label).sort();
    const parsed = parseLabel({ scale, level: levelPick.label, compartments, releasability: [], handling }, policy.scales);
    if (!parsed.ok) {
      void Promise.resolve(vscode.window.showWarningMessage('Nothing was changed: that label is not one your policy knows.')).catch(() => undefined);
      return false;
    }
    label = parsed.value;
    // D-27: a person labels only what their own clearance covers, so they never lock themselves out of their own files by mistake.
    const context = { scales: policy.scales, mappings: policy.mappings, now: host.now() };
    if (!policy.valid || !policy.clearances.some((clearance) => dominates(clearance, label!, context))) {
      void Promise.resolve(vscode.window.showWarningMessage(notYourClearanceText(label))).catch(() => undefined);
      return false;
    }
  }
  let reason: string | undefined;
  if (lowers(current.origin === 'default' ? [] : current.mark, label, policy.scales)) {
    const given = await vscode.window.showInputBox({ prompt: LOWER_REASON_PROMPT, title: `Lower the label of ${shownTarget}`, validateInput: (value: string) => (value.trim() === '' ? 'A reason is needed to lower a label.' : undefined) });
    if (given === undefined || given.trim() === '') return false;
    reason = given.trim();
  }
  const confirm = async (question: 'resign' | 'restore'): Promise<boolean> => {
    const text = question === 'resign' ? LABEL_MAP_RESIGN_QUESTION : LABEL_MAP_RESTORE_QUESTION;
    const detail = question === 'resign'
      ? 'The label file is not signed by this computer. Signing it again keeps the labels this computer checked, plus only the labels in the file that are stricter.'
      : 'The label file is missing, older than the one this computer last checked, or cannot be read. Signing again writes the labels this computer last checked.';
    return (await vscode.window.showWarningMessage(text, { modal: true, detail }, SIGN_AGAIN_ACTION)) === SIGN_AGAIN_ACTION;
  };
  try {
    await host.changeLabels(target.root, (map) => (keyText === '' ? setProjectLabel(map, label) : setLabelEntry(map, keyText, label)), confirm);
  } catch (error) {
    void Promise.resolve(vscode.window.showWarningMessage(error instanceof LabelMapError ? error.message : 'Nothing was changed: NEAR AI could not save the label.')).catch(() => undefined);
    return false;
  }
  host.recordLabelEvent(target.root, { event: 'label.set', path: keyText, ...(label === undefined ? {} : { label }), ...(reason === undefined ? {} : { reason }) });
  void Promise.resolve(vscode.window.showInformationMessage(label === undefined ? `The label of ${shownTarget} was removed.` : `${shownTarget} is labelled ${labelShown(label)}.`)).catch(() => undefined);
  return true;
}

/** The project and project-relative path of what the Explorer gave (a file or a folder), or the open project from the Command Palette. */
async function labelTargetOf(uri: unknown): Promise<LabelTarget | undefined> {
  const fsPath = typeof uri === 'object' && uri !== null && typeof (uri as { fsPath?: unknown }).fsPath === 'string' ? (uri as { fsPath: string }).fsPath : undefined;
  if (fsPath === undefined) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root === undefined ? undefined : { root, path: '' };
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri as vscode.Uri);
  if (folder === undefined) return undefined;
  const relative = path.relative(folder.uri.fsPath, fsPath).split(path.sep).join('/');
  if (relative === '') return { root: folder.uri.fsPath, path: '' };
  const isFolder = (await stat(fsPath).catch(() => undefined))?.isDirectory() === true;
  return { root: folder.uri.fsPath, path: isFolder ? `${relative}/` : relative };
}

/** Labels follow renames and moves made in VS Code (D-26): each rename inside a project moves its entry, a folder its whole subtree. */
async function followRenames(host: GateHost, files: ReadonlyArray<{ readonly oldUri: vscode.Uri; readonly newUri: vscode.Uri }>): Promise<void> {
  for (const file of files) {
    const folder = vscode.workspace.getWorkspaceFolder(file.newUri);
    if (folder === undefined) continue;
    const from = path.relative(folder.uri.fsPath, file.oldUri.fsPath).split(path.sep).join('/');
    const to = path.relative(folder.uri.fsPath, file.newUri.fsPath).split(path.sep).join('/');
    if (from === '' || to === '' || from.startsWith('..') || to.startsWith('..')) continue;
    const isFolder = (await stat(file.newUri.fsPath).catch(() => undefined))?.isDirectory() === true;
    await host.followRename(folder.uri.fsPath, isFolder ? `${from}/` : from, isFolder ? `${to}/` : to);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Edit Policy and Apply Policy Draft (D-41, D-53)

function draftFiles(globalStorageDir: string): { readonly draft: string; readonly base: string } {
  return { draft: path.join(gateDir(globalStorageDir), POLICY_DRAFT_FILE), base: path.join(gateDir(globalStorageDir), POLICY_DRAFT_BASE_FILE) };
}

/**
 * NEAR AI: Edit Policy. Writes the policy in force, pretty-printed and unsigned, to this extension's storage (never the project) with the hash of that
 * policy beside it, opens it, and says what Apply does, with the self-declared clearance words. Show Policy stays read-only. Returns the draft's path.
 */
export async function editPolicy(host: GateHost, globalStorageDir: string): Promise<string | undefined> {
  await host.state();
  const state = host.bundleState();
  if (state.state !== 'valid') {
    void Promise.resolve(vscode.window.showWarningMessage(`Your policy cannot be edited while it cannot be trusted. ${state.sentence}`)).catch(() => undefined);
    return undefined;
  }
  const files = draftFiles(globalStorageDir);
  await writeFileAtomic(files.draft, `${JSON.stringify(state.bundle, null, 2)}\n`);
  await writeFileAtomic(files.base, `${state.hash}\n`);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(files.draft)), { preview: false });
  void Promise.resolve(vscode.window.showInformationMessage(editPolicyNotice(state.bundle.defaultLabel), APPLY_DRAFT_ACTION, DISCARD_DRAFT_ACTION)).then(async (answer) => {
    if (answer === APPLY_DRAFT_ACTION) await applyPolicyDraftCommand(host, globalStorageDir);
    else if (answer === DISCARD_DRAFT_ACTION) await discardDraft(globalStorageDir);
  }).catch(() => undefined);
  return files.draft;
}

async function discardDraft(globalStorageDir: string): Promise<void> {
  const files = draftFiles(globalStorageDir);
  await rm(files.draft, { force: true });
  await rm(files.base, { force: true });
}

/**
 * NEAR AI: Apply Policy Draft. Reads the draft and the hash it was made from and hands them to the host, which applies it only when it was made from the
 * policy in force (D-53). A refused draft shows the plain reasons and changes nothing; an applied one is signed, recorded as policy.edit and its draft files
 * are removed. Returns true when the policy changed.
 */
export async function applyPolicyDraftCommand(host: GateHost, globalStorageDir: string): Promise<boolean> {
  const files = draftFiles(globalStorageDir);
  // A draft open in the editor with changes not yet saved is saved first, so what is applied is what the person sees.
  try {
    const open = vscode.workspace.textDocuments?.find((document) => document.uri.fsPath === files.draft);
    if (open?.isDirty === true) await open.save();
  } catch { /* the saved draft on disk is applied */ }
  let draft: string;
  let base: string;
  try {
    draft = await readFile(files.draft, 'utf8');
    base = (await readFile(files.base, 'utf8')).trim();
  } catch {
    void Promise.resolve(vscode.window.showWarningMessage(NO_DRAFT_TEXT)).catch(() => undefined);
    return false;
  }
  try {
    const result = await host.applyPolicyDraft(draft, base);
    if (result.state.state !== 'valid') {
      void Promise.resolve(vscode.window.showWarningMessage(result.state.sentence)).catch(() => undefined);
      return false;
    }
  } catch (error) {
    void Promise.resolve(vscode.window.showWarningMessage(error instanceof BundleStoreError ? error.message : 'Nothing was changed: NEAR AI could not apply your policy draft.')).catch(() => undefined);
    return false;
  }
  await discardDraft(globalStorageDir).catch(() => undefined);
  void Promise.resolve(vscode.window.showInformationMessage(POLICY_APPLIED_TEXT)).catch(() => undefined);
  return true;
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
