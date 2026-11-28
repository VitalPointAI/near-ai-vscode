// The activation adapter of the gate (GATE-04, OFFL-02): builds the GateHost from the editor's own storage and secret store, starts it, and hands it back so
// the chat can give each conversation its runtime. It never throws out of activation: whatever goes wrong in the policy check leaves the gate failed-closed
// (only reading and planning run) with a plain message, and the rest of the extension starts normally.
//
// It also owns what the person sees of the policy (OFFL-02, D-13, D-33, D-41): the status bar item, SovAI: Show Policy (a read-only virtual document, so
// nothing is ever written by looking), SovAI: Reset Policy to Defaults (confirmed in a modal, recorded, the only path that re-signs a bundle that failed
// verification) and the Policy step in the setup view.
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CAPABILITY_VERBS } from '../domain/gate/vocabulary';
import { UPDATE_REASONS } from '../domain/gate/bundle';
import type { BundleState } from '../domain/gate/bundle';
import { CLEARANCE_SELF_ASSERTED_TEXT, HANDLING_FLAGS, LABELS_NOT_ACCREDITATION_TEXT, LABEL_TOKEN_PATTERN, RESERVED_EXPORT_COMPARTMENTS, SCALE_PRESETS_CAVEAT_TEXT, exportMarkingsShown, labelKey, parseLabel } from '../domain/gate/labels';
import type { Clearance, Label } from '../domain/gate/labels';
import { dominates, raiseMark, sameMark } from '../domain/gate/dominance';
import type { Mark } from '../domain/gate/dominance';
import { chatInView, isChatInView, onChatInViewChange, queueChatNotice } from './chatInView';
import type { ChatInView } from './chatInView';
import { holdsReads, labelMapKey, resolveLabel, setLabelEntry, setProjectLabel } from '../domain/gate/labelMap';
import type { LabelMapPayload } from '../domain/gate/labelMap';
import { BundleStoreError } from '../gate/bundleStore';
import { writeFileAtomic } from '../team/teamFile';
import { GateHost } from '../gate/host';
import { LABEL_MAP_RESIGN_QUESTION, LABEL_MAP_RESTORE_QUESTION, LabelMapError, USE_BRANCH_LABELS_ACTION } from '../gate/labelMapStore';
import type { LabelMapQuestion } from '../gate/labelMapStore';
import type { LabelMapState } from '../domain/gate/labelMap';
import { setDefaultSessionRoute, setPrivateOnlySetting } from '../gate/sessionMark';
import { labelKeyShown, levelShown, scaleShown, setActiveScaleSource } from '../domain/gate/labelAlgebra';
import { localHostPatternNotice, patternLocalHosts } from '../domain/gate/routing';
import type { SecretStorageLike } from './auth';
import { SHOW_POLICY_COMMAND, createGateStatusBar, expiryDate, policyProblem, standingOrdersInstructions } from './gateStatusBar';
import type { GateStatusTimers } from './gateStatusBar';
import { ADD_ORGANIZATION_RULES_COMMAND, addOrganizationRules, startNotices } from './organizationRules';
import type { NoticeMemento } from './organizationRules';
import { SELF_SIGNED_TEXT } from '../domain/gate/authorizations';
import { contactShown } from '../domain/gate/enrolment';
import type { PolicyLayersView } from '../gate/organizationStore';
import { OPEN_FAILED_TEXT, defaultPolicyEditorPort, discardDraft, draftFiles, policyEditorDeps, proposeDraft } from './policyEditorWiring';
import type { PolicyEditorPort } from './policyEditorWiring';
export type { PolicyEditorPort } from './policyEditorWiring';
export { NO_DRAFT_TEXT, POLICY_APPLIED_TEXT } from './policyEditorWiring';
import { DEVICE_IDENTITY_TEXT, SHOW_DEVICE_IDENTITY_COMMAND, thisComputerIdentity } from '../gate/deviceIdentityCommand';
import { registerSetupStep } from './setupSteps';
import type { SetupStep } from './setupSteps';

export const RESET_POLICY_COMMAND = 'nearAi.policy.reset';
export const SET_LABEL_COMMAND = 'nearAi.label.set';
export const EDIT_POLICY_COMMAND = 'nearAi.policy.edit';
export const APPLY_POLICY_DRAFT_COMMAND = 'nearAi.policy.applyDraft';
/** SovAI: Policy, the editor page (D-44); Show Policy opens it too, and Show Policy as Stored keeps the read-only text view. */
export const OPEN_POLICY_COMMAND = 'nearAi.policy.open';
export const SHOW_POLICY_AS_STORED_COMMAND = 'nearAi.policy.showAsStored';
export const APPLY_DRAFT_ACTION = 'Apply';
export const DISCARD_DRAFT_ACTION = 'Discard';

/** Pitfall 14: unlabelled content takes the default label, so a policy with no clearance on that scale cannot read it. */
export function unlabelledDefaultText(defaultLabel: Label): string {
  return `Content with no label takes your policy's default label, ${labelKeyShown(defaultLabel)}, so a policy with no clearance on the ${scaleShown(defaultLabel.scale)} scale cannot read it.`;
}

/** What Edit Policy says beside the draft it opens (D-27, D-41, CLAS-07). */
export function editPolicyNotice(defaultLabel: Label): string {
  return `Your Standing Orders draft is open. Change it, then choose Apply, or Apply my draft in SovAI: Standing Orders. SovAI signs and records the change and sets the signer and the dates itself. ${unlabelledDefaultText(defaultLabel)} ${CLEARANCE_SELF_ASSERTED_TEXT} ${LABELS_NOT_ACCREDITATION_TEXT}`;
}

export const POLICY_SCHEME = 'near-ai-policy';
export const POLICY_DOCUMENT_URI = `${POLICY_SCHEME}:/NEAR-AI-Policy.txt`;

/**
 * Shown above the scales, clearances and routing (D-49, D-50): from PR 4c each chat's label, which rises with what its agents read, decides where its content
 * is sent. It replaced POLICY_ROUTING_NOT_LIVE_TEXT (PR 4b) when routing by label went live (plan 24).
 */
export const POLICY_ROUTING_TEXT =
  "This version checks the clearances below when an agent reads a labelled file. Each chat's label decides where its content is sent, by the routing tiers below. Levels that need an attested cloud go to a private NEAR AI Cloud model only over a connection proven to end inside its private hardware; otherwise they stay on this computer.";

export const RESET_CONFIRM_ACTION = 'Reset Standing Orders';
export const RESET_TITLE = 'Reset your Standing Orders to the defaults?';
export const RESET_DETAIL =
  "This replaces your Standing Orders with the defaults and signs them with this computer's key. Your current file is kept beside the new one. Anything your Standing Orders narrowed is allowed again, up to what your settings allow.";
export const RESET_DETAIL_ORGANIZATION =
  "This replaces your own settings on this computer with the starting rules and signs them with this computer's key. Your organization's Standing Orders stay as they are. Your current file is kept beside the new one.";
export const RESET_DONE_TEXT = 'Your Standing Orders were reset to the defaults. Your old file was kept beside the new one.';
export const RESET_FAILED_TEXT = 'SovAI could not reset your Standing Orders. Nothing was changed.';

export interface GateActivationContext {
  readonly globalStorageUri: { readonly fsPath: string };
  readonly secrets: SecretStorageLike;
  readonly extension?: { readonly packageJSON?: { readonly version?: string } };
  /** Where the commands, the status bar and the setup step are kept so the editor disposes them. Optional so a test context can leave it out. */
  readonly subscriptions?: { push(...items: Array<{ dispose(): unknown }>): unknown };
  /** Where the one-time policy notices remember what they told (D-20, D-27); without it each is told at every start. */
  readonly globalState?: NoticeMemento;
  /** The extension's folder, for the policy editor page (D-44); without it the policy commands open the stored view. */
  readonly extensionUri?: vscode.Uri;
}

export interface RegisterGateOptions {
  /** Shows a plain message to the person. Defaults to a VS Code warning. */
  readonly notify?: (message: string) => void;
  /** The clock for the policy check, for tests. */
  readonly now?: () => Date;
  /** The timers the policy status bar refreshes itself with, for tests. */
  readonly statusTimers?: GateStatusTimers;
  /** The policy editor page (D-44); by default the real page when the context has an extension folder. */
  readonly policyEditor?: PolicyEditorPort;
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
 * the ceiling, the default label (with what it means for unlabelled content, Pitfall 14), the scales, clearances and routing it holds and the reserved
 * fields. What this version uses of them is said above them, and the clearance is marked as self-declared (D-27), wherever they appear.
 */
/** The MCP label ceilings in plain words (WP-GATE): one line per named server, or one line saying none is set, so every server keeps today's behaviour. */
function mcpCeilingLines(ceilings: Readonly<Record<string, Clearance>> | undefined): string[] {
  const ids = ceilings === undefined ? [] : Object.keys(ceilings).sort();
  if (ceilings === undefined || ids.length === 0) return ['  Highest label each add-on server may receive: none set, so no server is limited by label'];
  return ['  Highest label each add-on server may receive (a call from a chat above it is refused):', ...ids.map((id) => {
    const ceiling = ceilings[id] as Clearance;
    const extra = [
      ...(ceiling.compartments.length ? [`compartments ${ceiling.compartments.join(', ')}`] : []),
      ...(ceiling.releasability.length ? [`releasable to ${ceiling.releasability.join(', ')}`] : []),
      ...(ceiling.expiresAt === undefined ? [] : [`until ${ceiling.expiresAt}`])
    ];
    return `    ${id}: ${labelKey(ceiling)}${extra.length ? ` (${extra.join('; ')})` : ''}`;
  })];
}

export function policyDocumentText(state: BundleState | undefined, now: number, layers?: PolicyLayersView): string {
  const lines: string[] = ['Your Standing Orders', ''];
  // D-23: who set the rules, only when the layers are known and the policy is usable; D-21: your organization's failure is fixed by its contact, never Reset.
  const organization = layers?.organization;
  if (organization !== undefined && state?.state === 'valid' && policyProblem(state, now, layers) === undefined) {
    lines.push(organization.state === 'valid'
      ? `Rules from: your organization${organization.name === undefined ? '' : ` (${organization.name})`}. Your settings on this computer can only narrow them.`
      : `Rules from: this computer (${SELF_SIGNED_TEXT}).`, '');
  }
  const organizationFailed = layers?.failedLayer === 'organization' && state?.state === 'failed-closed';
  if (state === undefined) {
    lines.push('SovAI is checking your Standing Orders. Open this view again in a moment.');
    return lines.join('\n');
  }
  const problem = policyProblem(state, now, layers);
  const usable = problem === undefined && state.state === 'valid';
  // Edit Policy works only on a policy that can be trusted, so a failed one names only the reset (D-41).
  // A policy written for a newer version is fixed by updating, never by a reset that would discard its rules (coherence review S6).
  // An unknown setting in a policy only this install's keys signed may be the person's own hand edit (PR #143 review): it names both ways on, and Reset only
  // for that own policy, saying what it discards. A policy any other key signed is never offered Reset.
  const needsUpdate = state.state === 'failed-closed' && (UPDATE_REASONS.has(state.reason) || (state.reason === 'unknown-field' && state.ownPolicy !== true));
  const ownUnknownField = state.state === 'failed-closed' && state.reason === 'unknown-field' && state.ownPolicy === true;
  lines.push(organizationFailed
    ? `This view only shows your Standing Orders. Editing it changes nothing. Ask ${contactShown(organization?.state === 'failed' ? organization.contacts : undefined)} about your organization's Standing Orders.`
    : usable
    ? 'This view only shows your Standing Orders. Editing it changes nothing. Open SovAI: Standing Orders and choose Edit my Standing Orders to change them. Reset my Standing Orders restores only your own defaults.'
    : ownUnknownField
      ? 'This view only shows your Standing Orders. Editing it changes nothing. The policy file has a setting this version does not know. If a newer version of SovAI wrote it, update the extension. This computer signed the file. If you changed it by hand, Reset my Standing Orders in SovAI: Standing Orders signs fresh defaults for your own rules and keeps the old file beside it. Your changes are discarded.'
      : needsUpdate
        ? 'This view only shows your Standing Orders. Editing it changes nothing. Update the extension to read Standing Orders written for a newer version of SovAI. Resetting would discard every rule they hold.'
        : 'This view only shows your Standing Orders. Editing it changes nothing. Open SovAI: Standing Orders and choose Reset my Standing Orders to restore only your own defaults.', '');
  if (!usable || state.state !== 'valid') {
    lines.push('State: not usable, so only reading and planning are allowed');
    // The sentence is its own line when there is one; a state with none adds nothing, not a blank line.
    if (problem) lines.push(problem);
    return lines.join('\n');
  }
  const bundle = state.bundle;
  lines.push(
    `State: ${state.renewDue ? 'valid, close to its end and renewed the next time SovAI starts' : 'valid'}`,
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
    ...mcpCeilingLines(bundle.ceiling.mcpLabelCeilings),
    '',
    POLICY_ROUTING_TEXT,
    '',
    `Default label: ${labelKey(bundle.defaultLabel)}`,
    `  ${unlabelledDefaultText(bundle.defaultLabel)}`,
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
  label: 'Check your Standing Orders',
  icon: 'shield',
  command: SHOW_POLICY_COMMAND
});

const POLICY_STEP_VALID_DETAIL = 'Your Standing Orders are signed and valid. You can read them here.';

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
    onLabelNotice: (root, state, message) => { void labelNotice(host, root, state, message, tell).catch(() => undefined); },
    onLabelRaiseRefused: (root, message) => { void labelRaiseRefused(host, root, message).catch(() => undefined); },
    onLoweringRejected: (chatId, sentence) => { queueChatNotice(chatId, sentence); },
    ...(options.now === undefined ? {} : { now: options.now })
  });
  // Every surface reads the host's own time (the later of the clock and the latest time it has seen), so none shows a policy as valid that a decision refuses
  // after the clock was set back.
  const clock = (): number => {
    try { return host.now(); } catch { return Date.now(); }
  };
  registerPolicySurfaces(context, host, tell, clock, options);
  // CLAS-06: a model request made outside every session route is still decided by this host's policy and recorded in the open project's log.
  // It is cleared at deactivation (the context's subscriptions are disposed then), and only while it is still this host's (PR 4a review).
  const clearDefaultRoute = setDefaultSessionRoute(host.sessionRouteWithoutContext());
  // Coherence review S7: every label ranking (the staff checks, a chat's label) reads this host's policy scales, the presets only while it failed closed.
  const clearScales = setActiveScaleSource(() => host.labelPolicy().scales);
  // Coherence review S4: TEE-only mode puts the private floor on every model request, so the gate's own check decides what counts as private.
  const clearPrivateOnly = setPrivateOnlySetting(() => vscode.workspace.getConfiguration('nearAi').get<string>('privacyMode') === 'tee-only');
  try { context.subscriptions?.push({ dispose: clearScales }, { dispose: clearPrivateOnly }); } catch { /* replaced at the next activation */ }
  // Coherence review S1: a policy whose local hosts hold a *. pattern is told once in this window what changed and how to fix the entry.
  // D-20, D-27: the one-time notices first; the migration notice names the same hosts, so the pattern notice waits for the next window after it.
  void host.state().then(async (state) => {
    const shown = await startNotices(host, context, tell).catch(() => ({ migrationShown: false }));
    const patterns = state.state === 'valid' ? patternLocalHosts(state.bundle.routing) : [];
    if (patterns.length > 0 && !shown.migrationShown) tell(localHostPatternNotice(patterns));
  }).catch(() => undefined);
  // D-58: every thread merge in this window judges signed lowerings with this host's key sources, and each is recorded once.
  try { context.subscriptions?.push({ dispose: host.registerLabelLowerings() }); } catch { /* with no judge every lowering from another copy is rejected */ }
  try { context.subscriptions?.push({ dispose: clearDefaultRoute }); } catch { /* an editor that cannot take it still replaces the route at the next activation */ }
  // A closed folder's decision log is let go when the window's folders change, so a long session does not keep one per folder it ever opened.
  try {
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      try { host.retainProjectLogs((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)); } catch { /* the cap still bounds the logs */ }
    });
    context.subscriptions?.push(subscription);
  } catch { /* an editor with no folder events still has the cap (MAX_PROJECT_LOGS) */ }
  void host.start().then((state) => {
    if (state.state === 'failed-closed') tell(standingOrdersInstructions(state.sentence));
  }).catch(() => undefined);
  return host;
}

// The status bar, the two commands and the setup step. Each is set up on its own, so one that cannot be (a command id already taken, a status bar that
// the editor refuses) never stops the gate or the rest of activation.
function registerPolicySurfaces(context: GateActivationContext, host: GateHost, tell: (message: string) => void, clock: () => number, options: RegisterGateOptions): void {
  const statusTimers = options.statusTimers;
  const keep = (item: { dispose(): unknown }): void => { try { context.subscriptions?.push(item); } catch { /* the editor owns disposal; a test context may not */ } };
  const attempt = (what: string, run: () => void): void => {
    try { run(); } catch { try { tell(`SovAI could not set up ${what}.`); } catch { /* ignored */ } }
  };
  attempt('the policy status', () => {
    // The bar reads the host again when its words are due to change (the renewal window opening, the policy ending), so it never waits for a host change.
    const chatMark = (): { mark: Mark; defaultLabel: Label } | undefined => {
      const chat = chatInView();
      const mark = chat?.mark()?.current();
      return chat === undefined || mark === undefined ? undefined : { mark, defaultLabel: chat.defaultLabel() };
    };
    const bar = createGateStatusBar({ read: () => ({ state: host.bundleState(), now: clock(), layers: host.policyLayers() }), chatMark, ...(statusTimers === undefined ? {} : { timers: statusTimers }) });
    const refresh = (): void => { bar.update(host.bundleState(), clock(), host.policyLayers()); };
    keep({ dispose: () => { bar.dispose(); } });
    keep({ dispose: host.onDidChange(refresh) });
    // D-33: the item shows the label of the chat in view, so it changes when another chat is shown or that chat's label changes.
    keep({ dispose: onChatInViewChange(refresh) });
  });
  let showStored = async (): Promise<void> => { tell(OPEN_FAILED_TEXT); };
  attempt('the policy view', () => {
    const changed = new vscode.EventEmitter<vscode.Uri>();
    const provider: vscode.TextDocumentContentProvider = {
      onDidChange: changed.event,
      provideTextDocumentContent: async () => {
        await host.state();
        return policyDocumentText(host.bundleState(), clock(), host.policyLayers());
      }
    };
    keep(vscode.workspace.registerTextDocumentContentProvider(POLICY_SCHEME, provider));
    keep({ dispose: host.onDidChange(() => { changed.fire(vscode.Uri.parse(POLICY_DOCUMENT_URI)); }) });
    showStored = async () => {
      try {
        await host.state();
        const uri = vscode.Uri.parse(POLICY_DOCUMENT_URI);
        changed.fire(uri);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
      } catch {
        tell(OPEN_FAILED_TEXT);
      }
    };
    keep(vscode.commands.registerCommand(SHOW_POLICY_AS_STORED_COMMAND, () => showStored()));
  });
  // D-44: the editor page is the front door; Show Policy (the status bar, the setup step) opens it too. Without a page the stored view opens instead.
  const port = options.policyEditor ?? defaultPolicyEditorPort(context);
  attempt('the policy editor', () => {
    if (port !== undefined) {
      const dir = context.globalStorageUri.fsPath;
      const ownRules = { globalStorageDir: dir, edit: () => editPolicy(host, dir, port), applyDraft: () => applyPolicyDraftCommand(host, dir, port) };
      const wiring = policyEditorDeps(host, { secrets: context.secrets, reset: () => resetPolicy(host), showStored: () => showStored(), ownRules });
      keep({ dispose: wiring.dispose });
      keep(port.register(wiring.deps));
    }
    const open = async (): Promise<void> => {
      try { await host.state(); if (port === undefined) await showStored(); else port.open(); } catch { tell(OPEN_FAILED_TEXT); }
    };
    keep(vscode.commands.registerCommand(OPEN_POLICY_COMMAND, open));
    keep(vscode.commands.registerCommand(SHOW_POLICY_COMMAND, open));
  });
  attempt("Add Your Organization's Rules", () => {
    keep(vscode.commands.registerCommand(ADD_ORGANIZATION_RULES_COMMAND, () => addOrganizationRules(host, { globalStorageDir: context.globalStorageUri.fsPath, secrets: context.secrets, now: clock, tell, ...(context.globalState === undefined ? {} : { memento: context.globalState }) })));
  });
  attempt('this computer\'s identity', () => {
    keep(vscode.commands.registerCommand(SHOW_DEVICE_IDENTITY_COMMAND, async () => {
      const view = await thisComputerIdentity(context.secrets).catch(() => undefined);
      if (view === undefined) {
        void Promise.resolve(vscode.window.showInformationMessage(DEVICE_IDENTITY_TEXT.none)).catch(() => undefined);
        return;
      }
      const choice = await vscode.window.showInformationMessage(view.message, DEVICE_IDENTITY_TEXT.copy);
      if (choice === DEVICE_IDENTITY_TEXT.copy) {
        await vscode.env.clipboard.writeText(view.didKey);
        void Promise.resolve(vscode.window.showInformationMessage(DEVICE_IDENTITY_TEXT.copied)).catch(() => undefined);
      }
    }));
  });
  attempt('the policy reset', () => {
    keep(vscode.commands.registerCommand(RESET_POLICY_COMMAND, () => resetPolicy(host)));
  });
  attempt('policy drafts', () => {
    keep(vscode.commands.registerCommand(EDIT_POLICY_COMMAND, () => editPolicy(host, context.globalStorageUri.fsPath, port).catch(() => { tell('SovAI could not open a policy draft.'); return undefined; })));
    keep(vscode.commands.registerCommand(APPLY_POLICY_DRAFT_COMMAND, () => applyPolicyDraftCommand(host, context.globalStorageUri.fsPath, port)));
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
  attempt('Lower This Chat\'s Label', () => {
    // The chat page passes its own chat (its label chip, a refusal's button); the Command Palette passes nothing, so it acts on the chat in view.
    keep(vscode.commands.registerCommand(LOWER_CHAT_LABEL_COMMAND, (chat?: unknown) => lowerChatLabel(host, isChatInView(chat) ? chat : chatInView())));
  });
  attempt('label rename tracking', () => {
    keep(vscode.workspace.onDidRenameFiles((event) => followRenames(host, event.files)));
  });
  attempt('the policy setup step', () => {
    keep(registerSetupStep(policySetupStep(host, clock)));
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Lower This Chat's Label (CLAS-04, D-29, D-58, GATE-07)

export const LOWER_CHAT_LABEL_COMMAND = 'nearAi.label.lowerChat';
/** The button that runs Lower This Chat's Label wherever a message names it (owner, after the 0.4.31 check: the command was hard to find). */
export const LOWER_CHAT_LABEL_ACTION = "Lower This Chat's Label";
/**
 * Said when the person lowers a file's label with Set Label while the chat in view holds that file's old label: the chat keeps its label, since a chat's
 * label only rises on its own, from what its agents read (D-29). Shown with LOWER_CHAT_LABEL_ACTION.
 */
export const CHAT_KEEPS_LABEL_TEXT = "That label is lower now, but the chat in view keeps its own label: a chat's label only rises on its own, from what its agents read. If what this chat read allows it, lower the chat's label too.";
export const NO_CHAT_IN_VIEW_TEXT = "Nothing was changed: open the chat whose label you want to lower in the SovAI chat view first.";
/** Said for a chat in view that has not run yet: it has no label of its own, and its first run starts at the project's label (PR #87 review). */
export const CHAT_NOT_RUN_TEXT = "Nothing was changed: this chat has not run yet, so it has no label of its own. Its first run starts at the project's label, and a chat is never lowered below its project.";
export const NOTHING_LOWER_TEXT = "Nothing was changed: this chat's label is already the project's label, and a chat is never lowered below its project.";
export const LOWERING_NOT_SIGNED_TEXT = "This chat's label was lowered on this computer, but SovAI could not sign the lowering, so it will not reach your other computers: they keep the higher label.";
/** Said with every lowering: other computers cannot check this computer's key yet (owner answer, verified devices come later), so they keep the higher label. */
export const LOWERED_HERE_ONLY_TEXT = "Your other computers cannot check this computer's key yet, so the copies of this chat there keep the higher label until you lower it there too.";
export const LOWER_CHAT_REASON_PROMPT = "Why may this chat's content now go where a lower label allows? The reason is kept with the chat, and travels with its encrypted metadata to your other computers.";

/** A chat's mark as the label screens show it (D-62): each label as labelShown gives it. */
export function labelsShown(mark: Mark): string {
  return mark.map((label) => labelShown(label)).join(', ');
}

/** `next` is lower than `mark`: raising it by every label of `mark` gives `mark` back, and it is not `mark` itself. */
function isLowerMark(next: Mark, mark: Mark, scales: Parameters<typeof raiseMark>[2]): boolean {
  let raised: Mark = next;
  for (const label of mark) raised = raiseMark(raised, label, scales);
  return sameMark(raised, mark) && !sameMark(next, mark);
}

/**
 * Whether Set Label tells the chat in view that it keeps its label (PR #89 review): the chat held the file's old label, and the new label is absent or does
 * not cover the chat's mark. A new label that covers the chat's mark (a raise) leaves nothing for the chat to keep, so nothing is said.
 */
export function chatKeepsLabel(held: Mark, oldMark: Mark, newLabel: Label | undefined, scales: Parameters<typeof raiseMark>[2]): boolean {
  if (!coversProject(held, oldMark, scales)) return false;
  return newLabel === undefined || !coversProject([newLabel], held, scales);
}

/** `mark` holds the project's label: raising it by the project's labels changes nothing (a chat is never lowered below its project). */
function coversProject(mark: Mark, project: Mark, scales: Parameters<typeof raiseMark>[2]): boolean {
  let raised: Mark = mark;
  for (const label of project) raised = raiseMark(raised, label, scales);
  return sameMark(raised, mark);
}

/** The labels a chat at `mark` may be lowered to: each lower level of each of its scales (compartments dropped), and the project's own label, never below it. */
export function lowerChoices(mark: Mark, project: Mark, scales: Parameters<typeof raiseMark>[2]): Mark[] {
  const out: Mark[] = [];
  const add = (next: Mark): void => {
    if (!isLowerMark(next, mark, scales) || !coversProject(next, project, scales)) return;
    if (out.some((known) => sameMark(known, next))) return;
    out.push(next);
  };
  for (const held of mark) {
    const levels = scales[held.scale]?.levels ?? [];
    for (let index = levels.indexOf(held.level); index >= 0; index -= 1) {
      const lowered: Label = { scale: held.scale, level: levels[index]!, compartments: [], releasability: [], handling: [] };
      add(Object.freeze(mark.map((label) => (label === held ? lowered : label))));
    }
  }
  add(project);
  return out;
}

/**
 * SovAI: Lower This Chat's Label (CLAS-04, D-29): the only way a person lowers a chat's mark. It acts on the chat in view, offers only labels below its
 * mark down to the project's label, requires a non-empty reason, lowers the mark, saves the lowering with the chat and records label.declassify with the old
 * label, the new one and the reason. Returns true when the label was lowered.
 */
export async function lowerChatLabel(host: GateHost, chat: ChatInView | undefined = chatInView()): Promise<boolean> {
  const mark = chat?.mark();
  if (chat === undefined || mark === undefined) {
    void Promise.resolve(vscode.window.showInformationMessage(chat === undefined ? NO_CHAT_IN_VIEW_TEXT : CHAT_NOT_RUN_TEXT)).catch(() => undefined);
    return false;
  }
  await host.state();
  const policy = host.labelPolicy();
  const view = await host.labelsFor(chat.root).view(policy.scales);
  const project = view.resolve('', policy.defaultLabel).mark;
  const current = mark.current();
  const choices = lowerChoices(current, project, policy.scales);
  if (choices.length === 0) {
    void Promise.resolve(vscode.window.showInformationMessage(NOTHING_LOWER_TEXT)).catch(() => undefined);
    return false;
  }
  type Item = vscode.QuickPickItem & { readonly mark: Mark };
  const items: Item[] = choices.map((choice) => ({ label: labelsShown(choice), ...(sameMark(choice, project) ? { description: "the project's label" } : {}), mark: choice }));
  const picked = await vscode.window.showQuickPick(items, { title: `Lower this chat's label from ${labelsShown(current)}`, placeHolder: LABELS_NOT_ACCREDITATION_TEXT });
  if (picked === undefined) return false;
  const given = await vscode.window.showInputBox({ prompt: LOWER_CHAT_REASON_PROMPT, title: `Lower this chat's label to ${picked.label}`, validateInput: (value: string) => (value.trim() === '' ? 'A reason is needed to lower a chat\'s label.' : undefined) });
  if (given === undefined || given.trim() === '') return false;
  const reason = given.trim();
  // The chat may have read more while the person chose: lower only from what it holds now, and only if the choice is still lower and still covers the project.
  const now = mark.current();
  if (!isLowerMark(picked.mark, now, policy.scales) || !coversProject(picked.mark, project, policy.scales)) {
    void Promise.resolve(vscode.window.showWarningMessage(`Nothing was changed: this chat read more meanwhile, and its label is now ${labelsShown(now)}. Run SovAI: Lower This Chat's Label again.`, LOWER_CHAT_LABEL_ACTION))
      .then((picked) => { if (picked === LOWER_CHAT_LABEL_ACTION) void lowerChatLabel(host, chat); }).catch(() => undefined);
    return false;
  }
  // D-58: the lowering travels to this person's other copies of the chat only signed with this install's device key; with no key it is lowered here only.
  const signed = await host.signChatLowering({ chatId: chat.id, from: [...now], to: [...picked.mark], reason, at: new Date(host.now()).toISOString() });
  chat.prepareLowering(signed ?? true);
  const before = mark.lowerByPerson(picked.mark, reason);
  if (signed === undefined) void Promise.resolve(vscode.window.showWarningMessage(LOWERING_NOT_SIGNED_TEXT)).catch(() => undefined);
  // The record's label is the strictest label of the new mark, as every label event's is (recordLabelEvent works it out from the mark).
  host.recordLabelEvent(chat.root, { event: 'label.declassify', path: `chat ${chat.id}`, mark: picked.mark, from: before, reason: `Lowered from ${before.map((each) => labelRecorded(each)).join(', ')} to ${picked.mark.map((each) => labelRecorded(each)).join(', ')}: ${reason}` });
  void Promise.resolve(vscode.window.showInformationMessage(`${`This chat's label is now ${labelsShown(picked.mark)}.`} ${LOWERED_HERE_ONLY_TEXT}`)).catch(() => undefined);
  return true;
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

/** Set Label while the policy cannot be trusted: it holds no clearances, so nothing can be labelled (D-27, D-64). */
export const ACCEPT_BRANCH_QUESTION = "Use this branch's labels?";
export const ACCEPT_BRANCH_DETAIL = 'The label file in this project is signed, but it is not the one this computer last checked (for example after switching branches). Using it makes its labels the current ones, signed again with this computer\'s key.';

export const NO_LABELS_WHILE_FAILED_TEXT =
  'Nothing can be labelled while your Standing Orders cannot be trusted, because a policy in that state holds no clearances. Open SovAI: Standing Orders to see why and what fixes it, then set the label.';

/** Said after the person accepts another branch's signed labels (D-61). */
export const BRANCH_LABELS_ACCEPTED_TEXT = "This branch's labels are now the ones SovAI checks in this project.";

/** The words of the refusal when the person's own clearance does not cover the label they chose (D-27). */
export function notYourClearanceText(label: Label): string {
  return `You cannot set ${labelKeyShown(label)}: your Standing Orders give you no clearance that covers it, so you could not read what you label. To add a clearance, open SovAI: Standing Orders and choose Edit my Standing Orders. ${CLEARANCE_SELF_ASSERTED_TEXT}`;
}

/** What Set Label acts on: a project, and a project-relative path in it (a folder ends with `/`, the project itself is the empty path). */
export interface LabelTarget {
  readonly root: string;
  readonly path: string;
}

/**
 * A label as Set Label and Lower This Chat's Label show it: the scale's name with the level (coherence review S8), each reserved export compartment as its
 * words after the level from the label module (D-62), then the other compartments and the handling.
 */
export function labelShown(label: Label): string {
  const reserved: readonly string[] = RESERVED_EXPORT_COMPARTMENTS;
  return labelParts(exportMarkingsShown(labelKeyShown(label), label.compartments), label.compartments.filter((token) => !reserved.includes(token)), label.handling);
}

/** A label as records and administrator panes keep it (D-62): every compartment as its token. */
export function labelRecorded(label: Label): string {
  return labelParts(labelKeyShown(label), label.compartments, label.handling);
}

function labelParts(shown: string, compartments: readonly string[], handling: readonly string[]): string {
  return [shown, ...(compartments.length > 0 ? [`compartments ${compartments.join(', ')}`] : []), ...(handling.length > 0 ? [handling.join(', ')] : [])].join(', ');
}

/** Said when the label file changed under Set Label so that the change became a lowering no reason was given for: nothing is written. */
export const LOWER_NEEDS_REASON_TEXT = 'Nothing was written: this change lowers a label, and no reason was given for it. Run SovAI: Set Label again to give one.';

/** True when `next` is lower than `current` on some scale: raising `next` by every label of `current` changes it. */
function lowers(current: readonly Label[], next: Label | undefined, scales: Parameters<typeof raiseMark>[2]): boolean {
  if (next === undefined) return current.length > 0;
  let raised: readonly Label[] = [next];
  for (const label of current) raised = raiseMark(raised, label, scales);
  return JSON.stringify(raised) !== JSON.stringify([next]);
}

/**
 * SovAI: Set Label. Before the first pick the person sees LABELS_NOT_ACCREDITATION_TEXT (CLAS-07), and beside the government and NATO scales the scales
 * caveat (CLAS-02). The person picks a scale, a level, optional compartments and handling flags. A label their own clearance does not cover is refused with
 * the Edit Policy hint (D-27); lowering a label asks for a reason. The change is signed into the project's label file and recorded as label.set.
 * Returns true when a label was set or removed.
 */
export async function setLabel(host: GateHost, target: LabelTarget): Promise<boolean> {
  await host.state();
  const policy = host.labelPolicy();
  const key = target.path === '' ? '' : labelMapKey(target.path.replace(/\/$/, ''), target.path.endsWith('/'));
  if (typeof key !== 'string' && !key.ok) {
    void Promise.resolve(vscode.window.showWarningMessage('SovAI cannot label that path. Pick a file or folder inside the project.')).catch(() => undefined);
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
    const levelPick = await vscode.window.showQuickPick(levels.map((level) => ({ label: levelShown(scale, level), ...(levelShown(scale, level) === level ? {} : { description: `stored as ${scale}/${level}` }), level })), { title: `Level on ${scaleShown(scale, policy.scales)}`, placeHolder: CAVEAT_SCALES.has(scale) ? SCALE_PRESETS_CAVEAT_TEXT : 'Pick a level, lowest first.' });
    if (levelPick === undefined) return false;
    const typed = await vscode.window.showInputBox({ prompt: COMPARTMENTS_PROMPT, title: 'Compartments', validateInput: (value: string) => (value.trim() === '' || value.trim().split(/\s+/).every((token) => LABEL_TOKEN_PATTERN.test(token)) ? undefined : 'Use capital letters and digits, with - or _ after the first one, up to 32 characters each.') });
    if (typed === undefined) return false;
    const compartments = [...new Set(typed.trim() === '' ? [] : typed.trim().split(/\s+/))].sort();
    const handlingPick = await vscode.window.showQuickPick(HANDLING_FLAGS.map((flag) => ({ label: flag })), { title: 'Handling', placeHolder: HANDLING_PLACEHOLDER, canPickMany: true });
    if (handlingPick === undefined) return false;
    const handling = (handlingPick as readonly vscode.QuickPickItem[]).map((item) => item.label).sort();
    const parsed = parseLabel({ scale, level: levelPick.level, compartments, releasability: [], handling }, policy.scales);
    if (!parsed.ok) {
      void Promise.resolve(vscode.window.showWarningMessage('Nothing was changed: that label is not one your policy knows.')).catch(() => undefined);
      return false;
    }
    label = parsed.value;
    // D-27: a person labels only what their own clearance covers, so they never lock themselves out of their own files by mistake.
    const context = { scales: policy.scales, mappings: policy.mappings, now: host.now() };
    if (!policy.valid) {
      void Promise.resolve(vscode.window.showWarningMessage(NO_LABELS_WHILE_FAILED_TEXT)).catch(() => undefined);
      return false;
    }
    if (!policy.clearances.some((clearance) => dominates(clearance, label!, context))) {
      void Promise.resolve(vscode.window.showWarningMessage(notYourClearanceText(label))).catch(() => undefined);
      return false;
    }
  }
  let reason: string | undefined;
  const askReason = async (): Promise<string | undefined> => {
    const given = await vscode.window.showInputBox({ prompt: LOWER_REASON_PROMPT, title: `Lower the label of ${shownTarget}`, validateInput: (value: string) => (value.trim() === '' ? 'A reason is needed to lower a label.' : undefined) });
    return given === undefined || given.trim() === '' ? undefined : given.trim();
  };
  // The label the write will replace (PR #85 review): while the file holds reads, the view reads every path at the default label, but the write restores
  // (or accepts) a signed map, so the label is judged against the labels this computer last verified too. The change re-checks against the map it is given.
  const ownLabel = (map: LabelMapPayload): readonly Label[] => {
    const resolved = resolveLabel(keyText, { verified: map, bundleDefault: policy.defaultLabel, scales: policy.scales });
    return resolved.origin === 'default' ? [] : resolved.mark;
  };
  const restored = holdsReads(view.state) ? await host.lastVerifiedLabels(target.root) : undefined;
  if (lowers([...(current.origin === 'default' ? [] : current.mark), ...(restored === undefined ? [] : ownLabel(restored))], label, policy.scales)) {
    reason = await askReason();
    if (reason === undefined) return false;
  }
  const confirm = async (question: LabelMapQuestion): Promise<boolean> => {
    if (question === 'accept') {
      const asked = await vscode.window.showWarningMessage(ACCEPT_BRANCH_QUESTION, { modal: true, detail: ACCEPT_BRANCH_DETAIL }, USE_BRANCH_LABELS_ACTION);
      return asked === USE_BRANCH_LABELS_ACTION;
    }
    const text = question === 'resign' ? LABEL_MAP_RESIGN_QUESTION : LABEL_MAP_RESTORE_QUESTION;
    const detail = question === 'resign'
      ? 'The label file is not signed by this computer. Signing it again keeps the labels this computer checked, plus only the labels in the file that are stricter.'
      : 'The label file is missing or cannot be read. Signing again writes the labels this computer last checked.';
    return (await vscode.window.showWarningMessage(text, { modal: true, detail }, SIGN_AGAIN_ACTION)) === SIGN_AGAIN_ACTION;
  };
  try {
    await host.changeLabels(target.root, (map) => {
      // Re-checked against the map the write is really made over, so no lowering is ever signed without a reason (fail closed: nothing is written).
      if (reason === undefined && lowers(ownLabel(map), label, policy.scales)) throw new LabelMapError(LOWER_NEEDS_REASON_TEXT);
      return keyText === '' ? setProjectLabel(map, label) : setLabelEntry(map, keyText, label);
      // A person's recorded change (label.set below, with the reason when it lowers): the one path that may lower or remove a label.
    }, confirm, { lowering: { kind: 'person', reason: reason ?? '' } });
  } catch (error) {
    void Promise.resolve(vscode.window.showWarningMessage(error instanceof LabelMapError ? error.message : 'Nothing was changed: SovAI could not save the label.')).catch(() => undefined);
    return false;
  }
  host.recordLabelEvent(target.root, { event: 'label.set', path: keyText, ...(label === undefined ? {} : { label }), ...(current.origin === 'default' ? {} : { from: current.mark }), ...(reason === undefined ? {} : { reason }) });
  void Promise.resolve(vscode.window.showInformationMessage(label === undefined ? `The label of ${shownTarget} was removed.` : `${shownTarget} is labelled ${labelShown(label)}.`)).catch(() => undefined);
  // A lowered file does not lower a chat that read it (D-29: a chat's label only rises on its own). When the chat in view, in this project, holds the file's
  // old label, the person is told so and offered the one way down for the chat.
  if (reason !== undefined && current.origin !== 'default') {
    const chat = chatInView();
    const held = chat !== undefined && chat.root === target.root ? chat.mark()?.current() : undefined;
    if (held !== undefined && chatKeepsLabel(held, current.mark, label, policy.scales)) {
      void Promise.resolve(vscode.window.showInformationMessage(CHAT_KEEPS_LABEL_TEXT, LOWER_CHAT_LABEL_ACTION))
        .then((picked) => { if (picked === LOWER_CHAT_LABEL_ACTION) void lowerChatLabel(host, chat); }).catch(() => undefined);
    }
  }
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

/**
 * SovAI: Edit Policy. Writes the personal layer as stored (never your organization's narrowed view, D-44), pretty-printed and unsigned, to this extension's
 * storage (never the project) with that layer's hash beside it, opens it, and says what Apply does, with the self-declared clearance words. Returns its path.
 */
export async function editPolicy(host: GateHost, globalStorageDir: string, port?: PolicyEditorPort): Promise<string | undefined> {
  await host.state();
  const state = host.bundleState();
  const personal = host.policyLayers().personal;
  if (state.state !== 'valid' || personal === undefined) {
    void Promise.resolve(vscode.window.showWarningMessage(standingOrdersInstructions(`Your Standing Orders cannot be edited until SovAI can verify them.${state.state === 'valid' ? '' : ` ${state.sentence}`}`))).catch(() => undefined);
    return undefined;
  }
  const files = draftFiles(globalStorageDir);
  await writeFileAtomic(files.draft, `${JSON.stringify(personal.stored, null, 2)}\n`);
  await writeFileAtomic(files.base, `${personal.hash}\n`);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(files.draft)), { preview: false });
  void Promise.resolve(vscode.window.showInformationMessage(editPolicyNotice(state.bundle.defaultLabel), APPLY_DRAFT_ACTION, DISCARD_DRAFT_ACTION)).then(async (answer) => {
    if (answer === APPLY_DRAFT_ACTION) await applyPolicyDraftCommand(host, globalStorageDir, port);
    else if (answer === DISCARD_DRAFT_ACTION) await discardDraft(globalStorageDir);
  }).catch(() => undefined);
  return files.draft;
}

/** SovAI: Apply Policy Draft: the draft is shown on the policy page as a proposal and applied only from there (D-44). Returns true when applied. */
export function applyPolicyDraftCommand(host: GateHost, globalStorageDir: string, port?: PolicyEditorPort): Promise<boolean> {
  return proposeDraft(host, globalStorageDir, port);
}

/**
 * A label file state that needs the person (D-61): another branch's signed labels get one button, Use this branch's labels, which accepts them; a deleted
 * or unreadable file gets the plain sentence, with no accept. Dismissing changes nothing and agent reads stay held.
 */
export async function labelNotice(host: GateHost, root: string, state: LabelMapState, message: string, tell: (message: string) => void): Promise<boolean> {
  if (state !== 'other-revision') {
    tell(message);
    return false;
  }
  const answer = await vscode.window.showWarningMessage(message, USE_BRANCH_LABELS_ACTION);
  if (answer !== USE_BRANCH_LABELS_ACTION) return false;
  try {
    const accepted = await host.acceptBranchLabels(root);
    if (accepted) void Promise.resolve(vscode.window.showInformationMessage(BRANCH_LABELS_ACCEPTED_TEXT)).catch(() => undefined);
    return accepted;
  } catch (error) {
    void Promise.resolve(vscode.window.showWarningMessage(error instanceof LabelMapError ? error.message : "Nothing was changed: SovAI could not use this branch's labels.")).catch(() => undefined);
    return false;
  }
}

/**
 * A labelled chat's write could not raise the written file's label automatically (the label file does not verify, or is held): the person is told once with
 * Sign Again, which signs the label file again with this computer's key (keeping only what raises) and then writes the kept raises (D-53). Returns whether
 * they were written.
 */
export async function labelRaiseRefused(host: GateHost, root: string, message: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(message, SIGN_AGAIN_ACTION);
  if (answer !== SIGN_AGAIN_ACTION) return false;
  try {
    return await host.signAgainForRaises(root);
  } catch (error) {
    void Promise.resolve(vscode.window.showWarningMessage(error instanceof LabelMapError ? error.message : 'Nothing was changed: SovAI could not sign the label file.')).catch(() => undefined);
    return false;
  }
}

/** The only path that re-signs a bundle that failed verification: a modal the person confirms, then host.reset(), which records policy.reset. */
export async function resetPolicy(host: GateHost): Promise<boolean> {
  const detail = host.policyLayers().organization.state === 'none' ? RESET_DETAIL : RESET_DETAIL_ORGANIZATION;
  const answer = await vscode.window.showWarningMessage(RESET_TITLE, { modal: true, detail }, RESET_CONFIRM_ACTION);
  if (answer !== RESET_CONFIRM_ACTION) return false;
  try {
    const result = await host.reset();
    if (result.state.state === 'valid') {
      void Promise.resolve(vscode.window.showInformationMessage(RESET_DONE_TEXT)).catch(() => undefined);
      return true;
    }
    void Promise.resolve(vscode.window.showWarningMessage(standingOrdersInstructions(result.state.sentence))).catch(() => undefined);
    return false;
  } catch (error) {
    const message = error instanceof BundleStoreError ? error.message : RESET_FAILED_TEXT;
    void Promise.resolve(vscode.window.showErrorMessage(message)).catch(() => undefined);
    return false;
  }
}
