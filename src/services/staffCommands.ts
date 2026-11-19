// A person's decisions on staff products (design 10, 4.1 and 7 item 2; UX concept 4 and 5.9; WP-SHARED): the VS Code commands that alone approve,
// reject, release or withdraw a staff product, signed with this device's key. Members cannot reach them: an agent has no tool that runs a VS Code
// command, the staff tools have no such verb, and the state machine refuses each of these from an agent whatever calls it. The Staff Room's buttons will
// run these same commands with the product named, and the person still confirms in a modal dialog here, so there is no path without a person's click.
//
// The person names themselves and their role. Until verified credentials arrive (Phase 71) that identity is self-declared, and every dialog says so.
import * as vscode from 'vscode';
import { CLEARANCE_SELF_ASSERTED_TEXT } from '../domain/gate/labels';
import type { PersonActor } from '../domain/staff/release';
import type { ProductView } from '../domain/staff/readModels';
import { localKeyStatus } from '../team/keyHistory';
import { identityDir, loadOrCreateDeviceIdentity } from '../team/identity';
import type { SecretStorageLike } from './auth';
import { configureStaffHosts, describeView, staffHostFor } from '../staff/staffHost';
import { configureObservationStores } from '../staff/observationStore';
import type { StaffHost } from '../staff/staffHost';

export const STAFF_COMMANDS = {
  approve: 'nearAi.staff.approveProduct',
  reject: 'nearAi.staff.rejectProduct',
  release: 'nearAi.staff.releaseProduct',
  withdraw: 'nearAi.staff.withdrawProduct',
  show: 'nearAi.staff.showProducts',
  setAside: 'nearAi.staff.setAsideLedger',
  decidePir: 'nearAi.staff.decidePir'
} as const;

/** The words every decision dialog shows about who the person is. */
export const STAFF_IDENTITY_TEXT = `You decide as the name and role you give here, signed with this device's key. ${CLEARANCE_SELF_ASSERTED_TEXT}`;

const PERSON_KEY = 'nearAi.staff.person';

/** What a decision command may be given by the Staff Room: the product and the version hash the person was shown. Anything else is asked. */
export interface StaffCommandArgs { readonly product?: string; readonly hash?: string }

export interface StaffCommandContext {
  readonly subscriptions: Array<{ dispose(): unknown }>;
  readonly globalStorageUri: { readonly fsPath: string };
  readonly secrets: SecretStorageLike;
  readonly globalState?: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> };
}

function projectRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Sets up the staff hosts with this device's identity, and registers the commands. */
export function registerStaffCommands(context: StaffCommandContext): void {
  const dir = identityDir(context.globalStorageUri.fsPath);
  const identity = async () => (await loadOrCreateDeviceIdentity(context.secrets, { identityDir: dir })).identity;
  configureStaffHosts({ signer: identity, keyStatus: () => localKeyStatus(dir, context.secrets), headStore: context.secrets });
  // The observation store of each project writes its feed events to the same project's staff event log (research note 11, 4.2).
  configureObservationStores({ emit: async (events, root) => { await staffHostFor(root)?.emit(events); } });
  context.subscriptions.push({ dispose: () => { configureStaffHosts(undefined); configureObservationStores(undefined); } });
  const register = (id: string, run: (args?: StaffCommandArgs) => Promise<void>): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (args?: unknown) => {
      try { await run(isArgs(args) ? args : undefined); } catch (error) { void vscode.window.showErrorMessage(`NEAR AI could not finish that: ${error instanceof Error ? error.message : String(error)}`); }
    }));
  };
  register(STAFF_COMMANDS.approve, (args) => decideCommand(context, identity, 'approve', args));
  register(STAFF_COMMANDS.reject, (args) => decideCommand(context, identity, 'reject', args));
  register(STAFF_COMMANDS.release, (args) => decideCommand(context, identity, 'release', args));
  register(STAFF_COMMANDS.withdraw, (args) => decideCommand(context, identity, 'withdraw', args));
  register(STAFF_COMMANDS.show, () => showProducts());
  register(STAFF_COMMANDS.setAside, () => setAsideLedger());
  register(STAFF_COMMANDS.decidePir, (args) => decidePirCommand(context, identity, args));
}

function isArgs(value: unknown): value is StaffCommandArgs {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hostOrSay(): StaffHost | undefined {
  const root = projectRoot();
  const host = root ? staffHostFor(root) : undefined;
  if (!host) void vscode.window.showInformationMessage('Open the project folder of a staff team first.');
  return host;
}

type Action = 'approve' | 'reject' | 'release' | 'withdraw';

/** Which products each action can be taken on. */
function eligible(action: Action, view: ProductView): boolean {
  if (view.tampered) return false;
  switch (action) {
    case 'approve': case 'reject': return view.state === 'awaiting-decision';
    case 'release': return view.state === 'approved';
    default: return view.state !== 'superseded' && view.state !== 'withdrawn';
  }
}

const VERB: Readonly<Record<Action, string>> = { approve: 'Approve', reject: 'Reject', release: 'Release', withdraw: 'Withdraw' };

/** Asks the person who they are (name and role), remembering the last answer as the default. Undefined when they cancel. */
async function askPerson(context: StaffCommandContext, fingerprint: string, role?: string): Promise<PersonActor | undefined> {
  const last = context.globalState?.get<{ name?: string; role?: string }>(PERSON_KEY);
  const name = await vscode.window.showInputBox({ title: 'Your name', prompt: STAFF_IDENTITY_TEXT, value: last?.name ?? '', ignoreFocusOut: true } as vscode.InputBoxOptions);
  if (!name?.trim()) return undefined;
  const chosenRole = await vscode.window.showInputBox({ title: 'Your role', prompt: 'The role you decide in, for example Commander or J2 director.', value: role ?? last?.role ?? '', ignoreFocusOut: true } as vscode.InputBoxOptions);
  if (!chosenRole?.trim()) return undefined;
  await context.globalState?.update(PERSON_KEY, { name: name.trim(), role: chosenRole.trim() });
  return { kind: 'person', name: name.trim().slice(0, 120), role: chosenRole.trim().slice(0, 80), deviceFingerprint: fingerprint };
}

async function decideCommand(context: StaffCommandContext, identity: () => Promise<{ fingerprint: string }>, action: Action, args?: StaffCommandArgs): Promise<void> {
  const host = hostOrSay();
  if (!host) return;
  const snapshot = await host.snapshot();
  const choices = snapshot.registry.filter((view) => eligible(action, view));
  let view = args?.product ? choices.find((candidate) => candidate.product === args.product) : undefined;
  if (args?.product && !view) {
    void vscode.window.showWarningMessage(`${args.product} cannot be ${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : action === 'release' ? 'released' : 'withdrawn'} now. Check its state with NEAR AI: Staff: Show Products.`);
    return;
  }
  if (!view) {
    if (!choices.length) { void vscode.window.showInformationMessage(`No staff product is waiting for that. ${action === 'approve' || action === 'reject' ? 'A product needs the release-guard\'s CLEARED and a submit before a person decides.' : ''}`.trim()); return; }
    const picked = await vscode.window.showQuickPick(choices.map((candidate) => ({ label: candidate.product, description: `${candidate.section} v${candidate.version}: ${candidate.display}`, detail: candidate.decisionFor ? `For the ${candidate.decisionFor}` : `Owner ${candidate.owner}` })), { title: `${VERB[action]} a staff product`, placeHolder: 'Pick the product' });
    if (!picked) return;
    view = choices.find((candidate) => candidate.product === picked.label);
    if (!view) return;
  }
  // The person decides on the version they were shown: a Staff Room button passes its hash, and a changed product is refused rather than decided.
  if (args?.hash && args.hash !== view.hash) { void vscode.window.showWarningMessage(`${view.product} changed since you saw it. Look at version ${view.version} first.`); return; }
  const signer = await identity();
  const person = await askPerson(context, signer.fingerprint, action === 'approve' || action === 'reject' ? view.decisionFor : undefined);
  if (!person) return;
  let reasons: string[] = [];
  if (action === 'reject' || action === 'withdraw') {
    const reason = await vscode.window.showInputBox({ title: `Why ${action === 'reject' ? 'reject' : 'withdraw'} ${view.product}?`, prompt: action === 'reject' ? 'Your reasons go back to the owner with the product. Required.' : 'Required.', ignoreFocusOut: true } as vscode.InputBoxOptions);
    if (!reason?.trim()) return;
    reasons = reason.split(/\s*;\s*/).filter(Boolean);
  }
  const dialog = await vscode.window.showWarningMessage(
    `${VERB[action]} ${view.product} version ${view.version} as ${person.name} (${person.role})?`,
    { modal: true, detail: `${describeView(view)}\n\n${STAFF_IDENTITY_TEXT}` },
    ...(action === 'approve' ? [VERB.approve, 'Approve and Release'] : [VERB[action]])
  );
  if (!dialog) return;
  const outcome = await host.decide(person, { product: view.product, action, hash: view.hash, reasons, releaseOnApproval: dialog === 'Approve and Release' });
  if (outcome.ok) void vscode.window.showInformationMessage(outcome.text);
  else void vscode.window.showWarningMessage(outcome.message);
}

/**
 * A named person approves or rejects a PIR awaiting a decision. Like a product decision it asks the person's name and role, confirms in a modal dialog
 * and is signed with this device's key; the signed entry, not the register file, is what makes the PIR decided.
 */
async function decidePirCommand(context: StaffCommandContext, identity: () => Promise<{ fingerprint: string }>, args?: StaffCommandArgs): Promise<void> {
  const host = hostOrSay();
  if (!host) return;
  const waiting = await host.pirsAwaitingDecision();
  if (!waiting.length) { void vscode.window.showInformationMessage('No PIR is awaiting a decision. A J2 member marks a PIR awaiting-decision with the intel workbench first.'); return; }
  const wanted = (args as { pir?: unknown } | undefined)?.pir;
  let pir = typeof wanted === 'string' ? waiting.find((entry) => entry.id === wanted) : undefined;
  if (!pir) {
    const picked = await vscode.window.showQuickPick(waiting.map((entry) => ({ label: entry.id, description: entry.requirement, detail: `Supports ${entry.decisionPoint}; latest time of value ${entry.ltiov}` })), { title: 'Decide a PIR', placeHolder: 'Pick the PIR' });
    if (!picked) return;
    pir = waiting.find((entry) => entry.id === picked.label);
    if (!pir) return;
  }
  const choice = await vscode.window.showQuickPick([{ label: 'Approve' }, { label: 'Reject' }], { title: `Decide ${pir.id}` });
  if (!choice) return;
  const decision = choice.label === 'Approve' ? 'approved' as const : 'rejected' as const;
  const signer = await identity();
  const person = await askPerson(context, signer.fingerprint, 'Commander');
  if (!person) return;
  let reasons: string[] = [];
  if (decision === 'rejected') {
    const reason = await vscode.window.showInputBox({ title: `Why reject ${pir.id}?`, prompt: 'Your reasons go back to the J2. Required.', ignoreFocusOut: true } as vscode.InputBoxOptions);
    if (!reason?.trim()) return;
    reasons = reason.split(/\s*;\s*/).filter(Boolean);
  }
  const dialog = await vscode.window.showWarningMessage(
    `${choice.label} ${pir.id} as ${person.name} (${person.role})?`,
    { modal: true, detail: `${pir.requirement}\nSupports ${pir.decisionPoint}.\n\n${STAFF_IDENTITY_TEXT}` },
    choice.label
  );
  if (dialog !== choice.label) return;
  const outcome = await host.decidePir(person, { pir: pir.id, decision, reasons });
  if (outcome.ok) void vscode.window.showInformationMessage(outcome.text);
  else void vscode.window.showWarningMessage(outcome.message);
}

async function showProducts(): Promise<void> {
  const host = hostOrSay();
  if (!host) return;
  const snapshot = await host.snapshot();
  const lines = ['# Staff products', ''];
  if (snapshot.ledgerProblem) lines.push(`The product ledger cannot be trusted after one point: ${snapshot.ledgerProblem}`, '');
  if (snapshot.eventLogProblem) lines.push(`The staff event log: ${snapshot.eventLogProblem}`, '');
  if (snapshot.decisions.length) {
    lines.push('## Waiting for a person', '');
    for (const entry of snapshot.decisions) {
      lines.push(`- ${entry.product} v${entry.version}, for the ${entry.decisionFor}${entry.deadline ? `, by ${entry.deadline}` : ''}`);
      for (const option of entry.options) lines.push(`  - Option: ${option.label}. Risk: ${option.risk}`);
      for (const dissent of entry.dissent) lines.push(`  - Dissent (unedited): ${dissent}`);
    }
    lines.push('');
  }
  lines.push('## Every product', '');
  for (const view of snapshot.registry) lines.push(`### ${view.product}`, '', describeView(view), '');
  if (!snapshot.registry.length) lines.push('No staff products yet.');
  lines.push('', STAFF_IDENTITY_TEXT);
  const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.join('\n') });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function setAsideLedger(): Promise<void> {
  const host = hostOrSay();
  if (!host) return;
  const answer = await vscode.window.showWarningMessage(
    'Set aside the staff product ledger?',
    { modal: true, detail: 'The ledger file is kept beside itself under a new name, never deleted, and a new ledger starts. Every product then reads as not in the ledger until its owner writes it again, and every past decision must be taken again.' },
    'Set Aside'
  );
  if (answer !== 'Set Aside') return;
  const kept = await host.setAsideLedger();
  void vscode.window.showInformationMessage(kept === undefined ? 'There is no ledger to set aside.' : kept ? `The old ledger is kept at ${kept}. A new one starts with the next product.` : 'The ledger file was already gone, so there was nothing to keep. A new ledger starts with the next product.');
}
