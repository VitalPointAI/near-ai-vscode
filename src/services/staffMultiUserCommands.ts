// The commands of a multi-user staff project (D-36, plan 31-23): make a staff project multi-user, invite, join, admit with the six words, remove,
// add another machine, choose a roster branch, name the deputy, hand over the lead, change a member, and make a single-machine copy. Each handler is
// thin: it asks with standard dialogs, calls one host flow (src/staff/replica/migrate.ts, membership.ts, singleCopy.ts), saves the file the flow
// returns where the person chose, and shows the flow's sentence with the notices every multi-user screen shows (D-13).
//
// The preview gate (D-36): every command is registered always, so turning the setting on needs no reload, and hidden from the Command Palette until
// nearAi.staff.multiUserPreview is on (package.json when clauses). Each handler checks the setting again at run time and, when it is off, shows one
// message and does nothing else. The replica modules are loaded inside the handlers only (Pitfall 8): with the setting off nothing under
// src/staff/replica is loaded, and no file, folder or secret is made. No line of this file imports a module under src/staff/replica.
//
// None of these commands is a person decision the Staff Room may run (PERSON_DECISION_COMMANDS), and no agent tool runs a VS Code command (D-37).
//
// Admission (D-16): the lead opens the join request, sees the person's name and the six words, and the person is admitted only when the lead picks
// "The six words match" in a modal dialog; "They do not match" or closing the dialog writes nothing. A join request whose person is already in (their
// welcome file was lost or never saved) is offered "Make Welcome File" instead, which writes nothing and makes the welcome again (MJ-02).
//
// Remove from Staff Project lists, before the members, a way to finish a removal or clearance change whose rekeys were interrupted (MJ-03), and lists
// expired invitations too, so they can be cancelled and their join secrets forgotten (MN-02).
import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { STAFF_MULTI_USER_COMMANDS } from '../domain/staff/commands';
import { conversionNoticeLines } from '../domain/staff/conversionNotice';
import { STAFF_SECTION_IDS } from '../domain/staff/doctrine';
import { REPLICA_PROJECT_FILE, multiUserNoticeLines } from '../domain/staff/multiUser';
import { canonicalBytes } from '../domain/team/canonical';
import { identityDir } from '../team/identity';
import { localKeyStatus } from '../team/keyHistory';
import { readWhole, syncFolder } from '../staff/staffFiles';
import { staffHostFor } from '../staff/staffHost';
import { askPerson } from './staffCommands';
import type { StaffCommandArgs, StaffCommandContext } from './staffCommands';

// Types only: these never load a module at run time.
type Membership = typeof import('../staff/replica/membership');
type SharedProjectHost = import('../staff/replica/membership').SharedProjectHost;
type MembershipResult = import('../staff/replica/membership').MembershipResult;
type ReplicaProjectDeps = import('../staff/replica/replicaProject').ReplicaProjectDeps;

type Register = (id: string, run: (args?: StaffCommandArgs) => Promise<void>) => void;

export { STAFF_MULTI_USER_COMMANDS };

/** The setting that switches the multi-user staff commands on (D-36). Off by default, application scope: a project cannot turn it on for you. */
export const MULTI_USER_PREVIEW_SETTING = 'nearAi.staff.multiUserPreview';

/** What every multi-user command says, and all it does, while the setting is off. */
export const MULTI_USER_PREVIEW_OFF_TEXT = 'Multi-user staff projects are switched off, so nothing was done. To try them, open Settings and turn on nearAi.staff.multiUserPreview.';

/** The two answers of the Admit dialog (D-16). Only the first admits. */
export const SIX_WORDS_MATCH = 'The six words match';
export const SIX_WORDS_DIFFER = 'They do not match';

export const MAKE_MULTI_USER_QUESTION = 'Make this staff project multi-user?';
export const MAKE_MULTI_USER_ACTION = 'Make Multi-User';
/** The title of the quick pick where the lead declares their own clearance, when Make Multi-User needs a label other than org/Public (D-19). */
export const LEAD_CLEARANCE_TITLE = 'The clearance you declare for yourself';
export const NO_FOLDER_TEXT = 'Open the folder of a staff project first. Nothing was changed.';
export const NOT_SHARED_TEXT = 'This folder holds no shared staff project, so nothing was changed. To share this staff project, run Staff: Make This Staff Project Multi-User first.';
export const WORDS_DIFFER_TEXT = 'Nobody was admitted, and nothing was changed. Do not admit a request whose words differ, because someone else may have made it. Ask the person to make a new join request from your invitation, or cancel the invitation with Staff: Remove from Staff Project.';
export const WORDS_NOT_CONFIRMED_TEXT = 'Nobody was admitted, because the six words were not confirmed. Nothing was changed. Compare the words with the person out loud or in person, then run Staff: Admit to Staff Project again. If they do not match, ask the person for a new join request, or cancel the invitation with Staff: Remove from Staff Project.';
/** What to do when an invitation file could not be saved after the roster recorded the invitation: save it again, or cancel it and invite again. */
/**
 * When a join request could not be saved. Running Join again is safe after this partial run: the request never left this computer, the invitation
 * it kept is stored once by its content (a second run finds the same record), and this computer's keys stay the same. The new run makes a new
 * request with new six words, and only the new one is sent.
 */
export const JOIN_NOT_SAVED_TEXT = 'Nothing was sent and the project was not changed, so it is safe to run Staff: Join Staff Project again with the same invitation and choose another place. It makes a new join request with new six words; send only the new one.';
/** When the join flow answers ok but gives no join request to save (D-05): nothing is saved, so no empty request is ever sent. */
export const JOIN_NO_FILE_TEXT = 'The join request was not made. Nothing was saved. Run Join Staff Project again.';
export const INVITE_NOT_SAVED_TEXT = 'To save it again, run Staff: Remove from Staff Project on this computer and pick Save the invitation again; nothing in the project changes. Or cancel it there and invite them again.';
export const INVITE_SAVE_AGAIN_PREFIX = 'Save the invitation for ';
export const INVITE_INSIDE_PROJECT_TEXT = 'The invitation holds a one-time secret, so it is not saved inside the project folder, where git could commit it. Nothing was changed. Choose a folder outside the project.';
export const SEAT_TEXT = 'A seat is lowercase letters, digits and dashes, for example j2-analyst, so nothing was changed. Run the command again with a seat like that.';
export const AGENT_SEATS_TEXT = 'Agent seats are lowercase letters, digits and dashes, separated by commas, so nothing was changed. Run the command again with seats like that.';
/** The Admit dialog's action for a join request whose person is already admitted (MJ-02). */
export const MAKE_WELCOME_AGAIN = 'Make Welcome File';
/** What the lead is told when an admitted person's welcome file could not be saved (MJ-02). */
export const WELCOME_NOT_SAVED_TEXT = 'Run Staff: Admit to Staff Project again with the same join request to make their welcome file again.';
/** The Remove list's first item when a removal or clearance change was left unfinished (MJ-03). */
export const FINISH_UNFINISHED_LABEL = 'Finish the change left unfinished';
/**
 * The last sentence of a single-machine copy of a project made shared by the 0.4.35 preview, whose products sit in the base cell (D-22 revised):
 * how to share the copy again with each product in its own part.
 */
export const COPY_SHARE_AGAIN_TEXT = 'To share it again with each product in its own part, open the copy\'s folder and run Staff: Make This Staff Project Multi-User.';
/** What a Single-Machine Copy does not carry (31-22: no replica kind covers these yet), said plainly with what to do. */
export const NOT_COPIED_TEXT = 'Not copied: the registers, the calculator record files, gate reports, proposals, settings, observations and the staff event log (events.jsonl). Copy the folders you need from the shared project by hand, and copy .planning/staff/calculator/ too, or the copy cannot check its calculator numbers.';

/** The ledgers Make Multi-User checks, in the words the dialog uses. */
const LEDGER_NAMES: Readonly<Record<string, string>> = { products: 'the product ledger', decisions: 'the decision log', calculator: 'the calculator ledger', wargame: 'the wargame ledger' };
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LEAD_ROLES: readonly string[] = ['staff_lead', 'deputy_lead'];

/**
 * A next step for the refusals whose own sentence says what happened but not what to do (D-37). Every refusal a command shows passes through
 * shownRefusal, which adds one of these, or a general one, when the sentence has no step of its own.
 */
export const REFUSAL_NEXT_STEPS: Readonly<Record<string, string>> = {
  'already-shared': 'To bring someone in, use Staff: Invite to Staff Project.',
  'nothing-to-change': 'Pick a different value to change, or close the command.',
  'no-split': 'Run Staff: Choose Roster Branch again only when the roster says it was changed in two places at once.',
  'change-not-applied': 'Check the roster with Staff: Remove from Staff Project or Staff: Change a Staff Project Member, and ask for help if this happens again.',
  'device-unknown': 'Pick one of the devices the command lists.',
  'member-unknown': 'Pick one of the members the command lists.',
  'not-a-roster-writer': 'Ask the staff lead or the deputy lead to make this change on their computer.',
  'names-the-lead': 'Pick another member.',
  'deputy-cannot-name-deputy': 'Ask the staff lead to name the deputy.',
  'handover-not-allowed': 'Ask the staff lead to hand over the lead, or pick "The staff lead is lost" if that is the case.',
  'choose-not-allowed': 'Ask the staff lead to choose.',
  'lead-role-by-handover-only': 'To make someone the lead, use Staff: Hand Over Staff Lead; to make someone the deputy, use Staff: Name Deputy Lead.',
  'member-exists': 'Run the command again to make a new member id.',
  'device-limit': 'Remove a device nobody uses any more before you add one.',
  'store-refused': 'Ask your staff lead for help.',
  'not-shared': 'Open the shared project folder, or ask your staff lead for an invitation.'
};
const GENERAL_NEXT_STEP = 'Ask your staff lead for help if you expected this to work.';
const HAS_NEXT_STEP = /\b(ask|use|choose|open|try|run|check|make|send|compare|put|look|admit|turn on|cancel|move|fix|copy|pick|hand|add|invite|close|set it aside|remove)\b/i;

/** The sentence a command shows for a refusal: the flow's own, plus a next step when it has none (D-37). */
export function shownRefusal(reason: string | undefined, message: string): string {
  const step = reason === undefined || !Object.hasOwn(REFUSAL_NEXT_STEPS, reason) ? undefined : REFUSAL_NEXT_STEPS[reason];
  if (step !== undefined) return message.includes(step) ? message : `${message} ${step}`;
  return HAS_NEXT_STEP.test(message) ? message : `${message} ${GENERAL_NEXT_STEP}`;
}

/** True inside the Sterling workbench image, which sets STERLING_WORKBENCH=1 (D-64); the one place the extension reads that variable. */
export function inSterlingWorkbench(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STERLING_WORKBENCH === '1';
}

/** Whether the multi-user commands are switched on. Read at every run, so turning the setting on or off needs no reload. */
export function multiUserPreviewOn(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(MULTI_USER_PREVIEW_SETTING, false) === true;
}

function projectRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function notices(): string {
  return multiUserNoticeLines().join(' ');
}

/** A result: the sentence, then the notices (D-13). */
function tell(text: string): void {
  void vscode.window.showInformationMessage(`${text} ${notices()}`);
}

/** A refusal or a problem: the sentence, then the notices. */
function warn(text: string): void {
  void vscode.window.showWarningMessage(`${text} ${notices()}`);
}

/** A modal confirmation whose detail ends with the notices. True only for the action button. */
async function confirm(question: string, detail: readonly string[], action: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(question, { modal: true, detail: [...detail, ...multiUserNoticeLines()].join('\n\n') }, action);
  return answer === action;
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

/** The dependencies every flow opens a shared project with: this window's secret storage, global storage, identity folder and cell order (D-25). */
async function replicaDeps(context: StaffCommandContext): Promise<ReplicaProjectDeps> {
  const { cellOrderHook } = await import('../staff/replica/membership');
  const globalStorageDir = context.globalStorageUri.fsPath;
  return { secrets: context.secrets, globalStorageDir, identityDir: identityDir(globalStorageDir), cellOrder: cellOrderHook() };
}

/** Opens the shared project of the open folder for one flow, and closes it after. Says why when it cannot be opened. */
async function withShared(context: StaffCommandContext, run: (shared: SharedProjectHost, membership: Membership, root: string) => Promise<void>): Promise<void> {
  const root = projectRoot();
  if (!root) { warn(NO_FOLDER_TEXT); return; }
  const { ReplicaProject, isProjectRefused } = await import('../staff/replica/replicaProject');
  const membership = await import('../staff/replica/membership');
  const deps = await replicaDeps(context);
  const opened = await ReplicaProject.open(root, deps);
  if (opened === undefined) { warn(NOT_SHARED_TEXT); return; }
  if (isProjectRefused(opened)) { warn(shownRefusal(opened.refused, opened.message)); return; }
  try {
    await run({ project: opened, deps }, membership, root);
  } finally {
    await opened.close();
  }
}

/** Shows a flow's refusal, or its result. */
function show(result: MembershipResult): void {
  if (result.ok) tell(result.message);
  else warn(shownRefusal(result.reason, result.message));
}

/** Where to save a file the flow will return: asked before the flow runs, so cancelling writes nothing. The extension is added when missing. */
async function saveTarget(name: string, extension: string, title: string, filter: string): Promise<string | undefined> {
  const picked = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(homedir(), name)), filters: { [filter]: [extension.slice(1)] }, title, saveLabel: 'Save' });
  if (!picked) return undefined;
  return picked.fsPath.endsWith(extension) ? picked.fsPath : `${picked.fsPath}${extension}`;
}

/** Is the file inside the folder (or the folder itself)? Compared after resolving symbolic links where the paths exist. */
async function inside(folder: string, file: string): Promise<boolean> {
  const real = async (value: string): Promise<string> => {
    let current = path.resolve(value);
    const rest: string[] = [];
    for (;;) {
      try {
        return path.join(await realpath(current), ...rest.reverse());
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return path.resolve(value);
        rest.push(path.basename(current));
        current = parent;
      }
    }
  };
  const relative = path.relative(await real(folder), await real(file));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Saves a file readable by this user account only: an invitation holds a one-time secret. The bytes go to a new file beside the target, created
 * exclusively with mode 0600 at open time (so it is never readable by others, not even for a moment), synced, then renamed over the target; an
 * existing file chosen in the dialog is replaced, not rewritten in place. The folder is then synced, so a power cut cannot lose the saved file
 * (D-06). On any failure after the new file exists it is removed before the error is reported, so no copy of the secret is left behind; if even
 * that removal fails, the error says where the file is. A failed folder sync is reported like any other save error; the file is in place by then.
 */
export async function saveSecretFile(target: string, text: string): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    await syncFolder(path.dirname(target));
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanup) {
      if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; the unfinished copy at ${temporary} could not be removed, so delete it by hand`);
      }
    }
    throw error;
  }
}

const saveFile = saveSecretFile;

/** Writes the file a flow returned to the place the person chose, and shows the flow's sentence with where it was saved. */
async function deliver(result: MembershipResult, target: string, ifNotSaved: string): Promise<void> {
  if (!result.ok) { show(result); return; }
  if (result.file === undefined) { tell(result.message); return; }
  try {
    await saveFile(target, result.file.text);
  } catch (error) {
    warn(`${result.message} But the file could not be saved at ${target} (${error instanceof Error ? error.message : String(error)}). ${ifNotSaved}`);
    return;
  }
  tell(`${result.message} It is saved as ${target}.`);
}

/** A file name part from a person's name: lowercase letters, digits and dashes. */
function fileSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'person';
}

async function input(title: string, prompt: string, value = ''): Promise<string | undefined> {
  const answer = await vscode.window.showInputBox({ title, prompt, value, ignoreFocusOut: true });
  const trimmed = answer?.trim();
  return trimmed ? trimmed : undefined;
}

/** The roles a person may be given here: member or observer, and a section's lead or answering role. The lead roles come only by handover or naming. */
async function pickRoles(title: string, current: readonly string[] = ['member']): Promise<string[] | undefined> {
  const items = [
    { label: 'member', description: 'A member of the project.' },
    { label: 'observer', description: 'Reads the project and writes only presence.' },
    ...STAFF_SECTION_IDS.flatMap((section) => [
      { label: `section_lead:${section}`, description: `Leads the ${section} section.` },
      { label: `answers_for:${section}`, description: `Answers questions for the ${section} section.` }
    ])
  ].map((item) => ({ ...item, picked: current.includes(item.label) }));
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder: 'Pick one or more roles', canPickMany: true });
  if (!picked || picked.length === 0) return undefined;
  return picked.map((item) => item.label);
}

/** A declared clearance (D-13): a scale and a level of the shipped scales. It is what the lead declares, not a verified clearance. */
async function pickClearance(title: string, placeHolder = 'The clearance you declare for them (self-declared, not verified)'): Promise<{ scale: string; level: string; compartments: string[]; releasability: string[] } | undefined> {
  const items = Object.entries(SCALE_PRESETS).flatMap(([scale, value]) => value.levels.map((level) => ({ label: level, description: value.name, scale })));
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder });
  if (!picked) return undefined;
  return { scale: picked.scale, level: picked.label, compartments: [], releasability: [] };
}

interface MemberView { member: string; name: string; seat?: string; roles: readonly string[]; devices: Array<{ writer: string; slot?: number }> }
interface RosterRead { members: MemberView[]; invites: Array<{ invite: string; name: string; forMember?: string; expired: boolean }>; lead?: string; self?: string; pending: Array<{ at: string; branches: string[]; text: string }> }

/**
 * What the pickers list: the members and their devices, the invitations still open in the roster (expired ones too, marked, so they can be cancelled
 * and their secrets forgotten, MN-02) and the pending splits at the roster head. Read only.
 */
async function readRoster(shared: SharedProjectHost): Promise<RosterRead> {
  const { roster } = await shared.project.state();
  const { deviceAt, devicesOfMemberAt, inviteAt, memberAt } = await import('../domain/replica/rosterMembers');
  const { leadAt } = await import('../domain/replica/roster');
  const position = roster.positions.length - 1;
  const at = (shared.deps.now?.() ?? new Date()).toISOString();
  const members: MemberView[] = [];
  for (const id of roster.members.members.keys()) {
    const record = memberAt(roster.members, id, position);
    if (record === undefined) continue;
    const devices = devicesOfMemberAt(roster.members, id, position).filter((device) => device.kind === 'person').map((device) => ({ writer: device.writer, ...(device.slot === undefined ? {} : { slot: device.slot }) }));
    members.push({ member: id, name: record.name, ...(record.seat === undefined ? {} : { seat: record.seat }), roles: record.roles, devices });
  }
  const invites = [...roster.members.invites.values()]
    .map((record) => ({ record, state: inviteAt(roster.members, record.invite, position, at)?.state }))
    .filter((item) => item.state === 'open' || item.state === 'expired')
    .map(({ record, state }) => ({ invite: record.invite, name: record.name, ...(record.forMember === undefined ? {} : { forMember: record.forMember }), expired: state === 'expired' }));
  const lead = leadAt(roster, position);
  const self = deviceAt(roster.members, shared.project.deviceWriter, position)?.member;
  return { members, invites, ...(lead === undefined ? {} : { lead }), ...(self === undefined ? {} : { self }), pending: roster.pending.map((item) => ({ at: item.at, branches: [...item.branches], text: item.text })) };
}

/**
 * How a member is named in a list (D-04): the declared name, with the member id after it when another member in the list was declared with the same
 * name, so every choice reads differently. Declared names are free text the lead typed; only the member id says who someone is.
 */
function memberLabel(members: readonly MemberView[], member: MemberView): string {
  return members.filter((other) => other.name === member.name).length > 1 ? `${member.name} (${member.member})` : member.name;
}

/** A member picked from a list. Each item carries its member, and the item picked is used as it is, never matched back by its label (D-04). */
async function pickMember(members: readonly MemberView[], title: string): Promise<MemberView | undefined> {
  if (members.length === 0) { warn('Nobody in this project can be picked for that, so nothing was changed. Invite someone first with Staff: Invite to Staff Project.'); return undefined; }
  const picked = await vscode.window.showQuickPick(members.map((member) => ({ label: memberLabel(members, member), description: member.seat ?? '', detail: member.roles.join(', '), member })), { title, placeHolder: 'Pick the member' });
  return picked?.member;
}

/** The sha256 of the project's signed label map (D-07), as the gate's marker records it: of its canonical JSON. Undefined when there is none. */
async function labelMapHashOf(root: string): Promise<string | undefined> {
  const { LABEL_MAP_FILE } = await import('../gate/labelMapStore');
  const read = await readWhole(path.join(root, ...LABEL_MAP_FILE.split('/')), 1024 * 1024);
  if (read.kind !== 'text') return undefined;
  try {
    return createHash('sha256').update(canonicalBytes(JSON.parse(read.text) as unknown)).digest('hex');
  } catch {
    return createHash('sha256').update(read.bytes).digest('hex');
  }
}

/**
 * Did the base cell of the open folder's shared project ever hold products (D-22 revised)? True for a project the 0.4.35 preview made shared, whose
 * products sit in the part every member and the hub can read; false for one made shared in Phase 32, and false whenever the project cannot be opened
 * or folded. Reads only: the project is opened, folded and closed.
 */
async function heldProductsInBase(context: StaffCommandContext, root: string): Promise<boolean> {
  try {
    const { ReplicaProject, isProjectRefused } = await import('../staff/replica/replicaProject');
    const { baseCellHeldProducts } = await import('../domain/replica/productCells');
    const opened = await ReplicaProject.open(root, await replicaDeps(context));
    if (opened === undefined || isProjectRefused(opened)) return false;
    try {
      const { fold } = await opened.state();
      return baseCellHeldProducts(fold, opened.projectId);
    } finally {
      await opened.close();
    }
  } catch {
    return false;
  }
}

// ---- the commands ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Make This Staff Project Multi-User (D-28 to D-34): verify the ledgers first, confirm in a modal dialog that says what happens, then convert.
 * A project that needs a label other than org/Public (a product labelled above it, or a calculator or wargame ledger kept at org/Internal) asks the
 * lead to declare their own clearance first, and checks it before the confirmation: a clearance that does not cover every label is refused with the
 * D-19 sentence and nothing more is asked or written (D-19). An all org/Public project is asked nothing new (D-68).
 */
async function makeMultiUserCommand(context: StaffCommandContext): Promise<void> {
  const root = projectRoot();
  if (!root) { warn(NO_FOLDER_TEXT); return; }
  const migrate = await import('../staff/replica/migrate');
  if (!(await exists(path.join(root, '.planning', 'staff')))) { warn(shownRefusal('no-staff-project', migrate.MIGRATION_REFUSALS['no-staff-project'])); return; }
  if (await migrate.migrationComplete(root)) {
    // A project the 0.4.35 preview made shared is told the way forward instead, which carries its own next step (D-22 revised).
    if (await heldProductsInBase(context, root)) {
      const { PREVIEW_WAY_FORWARD_TEXT } = await import('../domain/replica/productCells');
      warn(`${migrate.MIGRATION_REFUSALS['already-shared']} ${PREVIEW_WAY_FORWARD_TEXT}`);
    } else warn(shownRefusal('already-shared', migrate.MIGRATION_REFUSALS['already-shared']));
    return;
  }
  const dir = identityDir(context.globalStorageUri.fsPath);
  const staffKeyStatus = () => localKeyStatus(dir, context.secrets);
  // The four ledgers are checked before anything is asked, so a broken one is refused with today's sentence and its way out, and nothing is written.
  const verifyDeps = { secrets: context.secrets, staffKeyStatus };
  let verified = await migrate.verifyLegacyLedgers(root, verifyDeps);
  // With no clearance declared only org/Public is covered, so a project needing any other label is refused not-cleared-for-label with those labels.
  // The lead then declares their own clearance, and the ledgers are checked again with it before anything else is asked.
  let leadClearance: Awaited<ReturnType<typeof pickClearance>>;
  if (!('ok' in verified) && verified.refused === 'not-cleared-for-label' && (verified.labels?.length ?? 0) > 0) {
    leadClearance = await pickClearance(LEAD_CLEARANCE_TITLE, 'The clearance you declare for yourself (self-declared, not verified)');
    if (!leadClearance) return;
    verified = await migrate.verifyLegacyLedgers(root, verifyDeps, { leadClearance });
  }
  if (!('ok' in verified)) { warn(shownRefusal(verified.refused, verified.message)); return; }
  const checked = migrate.LEGACY_LEDGERS.map((ledger) => {
    const read = verified.ledgers.find((item) => item.ledger === ledger.ledger);
    const name = LEDGER_NAMES[ledger.ledger] ?? ledger.ledger;
    return read === undefined ? `${name}: none yet` : `${name}: ${read.count} ${read.count === 1 ? 'entry' : 'entries'}, verified`;
  });
  const go = await confirm(MAKE_MULTI_USER_QUESTION, [
    `The four ledgers were checked with today's checks: ${checked.join('; ')}.`,
    'The project becomes shared: its history moves into a signed shared record in .planning/staff/replica/, which git ignores. You become its staff lead, signed with this device\'s key, and people join only when you invite and admit them.',
    'The original ledger files are kept in .planning/staff/legacy/ and never deleted, and the files you know stay where they are. Steps that work on one machine only are refused in a shared project. To work alone again, use Staff: Make a Single-Machine Copy.',
    ...(leadClearance === undefined ? [] : [`Each product goes into a part of the project for its label: ${verified.labels.join(', ')}. Only people whose declared clearance covers a label receive that part. You declare yourself cleared for ${leadClearance.level}.`])
  ], MAKE_MULTI_USER_ACTION);
  if (!go) return;
  const labelMapHash = await labelMapHashOf(root);
  const result = await migrate.makeMultiUser(root, { ...(await replicaDeps(context)), staffKeyStatus }, {
    ...(labelMapHash === undefined ? {} : { labelMapHash }),
    ...(leadClearance === undefined ? {} : { leadClearance })
  });
  if (migrate.isMigrationRefused(result)) { warn(shownRefusal(result.refused, result.message)); return; }
  // The staff host reopens the project as shared on its next read.
  await staffHostFor(root)?.close();
  const count = result.imported.length;
  const labels = new Map(result.cells.map(({ cell, label }) => [cell, label]));
  tell([
    `This staff project is now multi-user, and you are its staff lead. ${count === 1 ? 'One ledger was' : `${count} ledgers were`} brought into the shared record, and the original files are kept in .planning/staff/legacy/. To bring someone in, use Staff: Invite to Staff Project.`,
    ...conversionNoticeLines(result.withheld, result.unversioned, (cell) => labels.get(cell))
  ].join('\n'));
}

/** Invite to Staff Project (D-14): the person's name, seat, roles and declared clearance, then where to save the invitation. */
async function inviteCommand(context: StaffCommandContext): Promise<void> {
  await withShared(context, async (shared, membership, root) => {
    const name = await input('Their name', 'The person\'s name as you declare it. Everyone in the project sees it.');
    if (!name) return;
    const seat = await input('Their seat', 'Their staff seat in lowercase letters, digits and dashes, for example j2-analyst.');
    if (!seat) return;
    if (!SLUG.test(seat)) { warn(SEAT_TEXT); return; }
    const roles = await pickRoles(`Roles for ${name}`);
    if (!roles) return;
    const clearance = await pickClearance(`Clearance for ${name}`);
    if (!clearance) return;
    const { INVITE_FILE_EXTENSION } = await import('../domain/replica/invite');
    const target = await saveTarget(`invitation-${fileSlug(name)}${INVITE_FILE_EXTENSION}`, INVITE_FILE_EXTENSION, `Save the invitation for ${name}`, 'Staff invitation');
    if (!target) return;
    if (await inside(root, target)) { warn(INVITE_INSIDE_PROJECT_TEXT); return; }
    const result = await membership.inviteToProject(shared, { name, seat, roles, clearance });
    await deliver(result, target, INVITE_NOT_SAVED_TEXT);
  });
}

/**
 * Join Staff Project (D-15, D-16): the joining person opens the lead's invitation (and gets a join request to send back, with the six words to read
 * aloud) or, later, the lead's welcome file (and the project opens here).
 */
async function joinCommand(context: StaffCommandContext): Promise<void> {
  const root = projectRoot();
  if (!root) { warn('Open the empty folder the shared project should live in first, then run Staff: Join Staff Project again. Nothing was changed.'); return; }
  const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'Invitation or welcome file': ['near-staff-invite', 'near-staff-welcome'] }, title: 'Open the invitation or the welcome file from the staff lead', openLabel: 'Open' });
  const file = picked?.[0]?.fsPath;
  if (!file) return;
  const invite = await import('../domain/replica/invite');
  const read = await readWhole(file, invite.WELCOME_MAX_BYTES + 64 * 1024);
  if (read.kind !== 'text') { warn(read.kind === 'unreadable' && /larger/.test(read.reason) ? invite.INVITE_REFUSALS['too-large'] : `That file could not be read, so nothing was changed. Choose the file again, or ask the staff lead for a new one.`); return; }
  const membership = await import('../staff/replica/membership');
  const deps = await replicaDeps(context);
  if (file.endsWith(invite.WELCOME_FILE_EXTENSION)) {
    const result = await membership.openWelcome(root, deps, read.text);
    try {
      show(result);
    } finally {
      await result.project?.close();
    }
    // The staff host opens the joined project on its next read.
    await staffHostFor(root)?.close();
    return;
  }
  // The invitation is read before anyone is asked anything, so a wrong file is refused at once (the flow reads it again).
  const checked = invite.readInvite(read.text, new Date());
  if (!checked.ok) { warn(shownRefusal(checked.reason, checked.message)); return; }
  const last = context.globalState?.get<{ name?: string }>('nearAi.staff.person');
  const name = await input('Your name', 'Your name as you want the staff lead to see it.', last?.name ?? '');
  if (!name) return;
  const target = await saveTarget(`join-request-${fileSlug(name)}${invite.JOIN_REQUEST_FILE_EXTENSION}`, invite.JOIN_REQUEST_FILE_EXTENSION, 'Save the join request to send back to the staff lead', 'Staff join request');
  if (!target) return;
  const result = await membership.joinFromInvite(root, deps, read.text, { name });
  if (!result.ok) { show(result); return; }
  // An ok answer with no request in it is refused, so an empty join request is never saved or sent (D-05).
  if (result.file === undefined) { warn(JOIN_NO_FILE_TEXT); return; }
  try {
    await saveFile(target, result.file.text);
  } catch (error) {
    warn(`The join request could not be saved at ${target} (${error instanceof Error ? error.message : String(error)}). ${JOIN_NOT_SAVED_TEXT}`);
    return;
  }
  // The six words stay on screen in a modal dialog while the person reads them to the lead.
  void vscode.window.showInformationMessage(`Read these six words to the staff lead: ${(result.safetyWords ?? []).join(' ')}`, { modal: true, detail: [result.message, `The join request is saved as ${target}.`, ...multiUserNoticeLines()].join('\n\n') });
}

/** Admit to Staff Project (D-16): the join request, the person's name and the six words, and admission only on "The six words match". */
async function admitCommand(context: StaffCommandContext): Promise<void> {
  await withShared(context, async (shared, membership) => {
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'Staff join request': ['near-staff-join'] }, title: 'Open the join request the person sent you', openLabel: 'Open' });
    const file = picked?.[0]?.fsPath;
    if (!file) return;
    const read = await readWhole(file, 64 * 1024);
    if (read.kind !== 'text') { warn('That join request could not be read, so nobody was admitted. Ask the person to send it again.'); return; }
    const review = await membership.reviewJoinRequest(shared, read.text);
    if (!review.ok) { show(review); return; }
    const { roster } = await shared.project.state();
    const declared = review.invite === undefined ? undefined : roster.members.invites.get(review.invite);
    const who = declared?.name ?? 'this person';
    const { WELCOME_FILE_EXTENSION } = await import('../domain/replica/invite');
    if (review.alreadyAdmitted === true) {
      // Already in: their welcome file was lost or never saved. Making it again writes nothing and works on their computer only (MJ-02).
      if (!(await confirm(`Make the welcome file for ${who} again?`, [review.message, 'Nothing in the project changes. The welcome file works only on their computer.'], MAKE_WELCOME_AGAIN))) return;
      const again = await saveTarget(`welcome-${fileSlug(who)}${WELCOME_FILE_EXTENSION}`, WELCOME_FILE_EXTENSION, `Save the welcome file for ${who}`, 'Staff welcome file');
      if (!again) return;
      await deliver(await membership.remakeWelcome(shared, read.text), again, WELCOME_NOT_SAVED_TEXT);
      return;
    }
    const words = (review.safetyWords ?? []).join(' ');
    const answer = await vscode.window.showWarningMessage(
      `Admit ${who}? Compare these six words with them: ${words}`,
      {
        modal: true,
        detail: [
          review.message,
          declared === undefined ? '' : `They are admitted as ${declared.name}, seat ${declared.seat}, with the roles and the clearance you declared in the invitation.`,
          'Admit them only if every word matches what they read to you. If the words differ, someone else may have made this request.',
          ...multiUserNoticeLines()
        ].filter(Boolean).join('\n\n')
      },
      SIX_WORDS_MATCH, SIX_WORDS_DIFFER
    );
    if (answer === SIX_WORDS_DIFFER) { warn(WORDS_DIFFER_TEXT); return; }
    if (answer !== SIX_WORDS_MATCH) { warn(WORDS_NOT_CONFIRMED_TEXT); return; }
    const target = await saveTarget(`welcome-${fileSlug(who)}${WELCOME_FILE_EXTENSION}`, WELCOME_FILE_EXTENSION, `Save the welcome file for ${who}`, 'Staff welcome file');
    if (!target) { warn('Nobody was admitted, because the welcome file was given no place. Nothing was changed. Run Staff: Admit to Staff Project again when you are ready.'); return; }
    const result = await membership.admitJoinRequest(shared, read.text, { codeMatched: true });
    await deliver(result, target, WELCOME_NOT_SAVED_TEXT);
  });
}

type RemoveChoice = { kind: 'member'; member: MemberView } | { kind: 'device'; member: MemberView; writer: string; slot?: number } | { kind: 'invite'; invite: string; name: string } | { kind: 'reinvite'; invite: string; name: string } | { kind: 'finish'; count: number };

/**
 * Remove from Staff Project (D-17, D-23): a member, one of a member's devices, or an open or expired invitation; the rekey sentence before and after.
 * When a removal or clearance change was left unfinished, finishing it is offered first (MJ-03).
 */
async function removeCommand(context: StaffCommandContext): Promise<void> {
  await withShared(context, async (shared, membership, root) => {
    const view = await readRoster(shared);
    const choices: Array<{ label: string; description: string; choice: RemoveChoice }> = [];
    const unfinished = await membership.unfinishedRekeys(shared);
    if (unfinished > 0) {
      const parts = unfinished === 1 ? 'One part of the project is' : `${unfinished} parts of the project are`;
      choices.push({ label: FINISH_UNFINISHED_LABEL, description: `${parts} still on a key a removed device or a member no longer cleared holds`, choice: { kind: 'finish', count: unfinished } });
    }
    for (const member of view.members) {
      // A name two members share is shown with the member id, in the member's item and in their devices' items alike (D-04).
      const name = memberLabel(view.members, member);
      choices.push({ label: name, description: `Remove ${name} and every device of theirs`, choice: { kind: 'member', member } });
      for (const device of member.devices) choices.push({ label: `${name}, device in slot ${device.slot ?? '?'}`, description: 'Remove this one device', choice: { kind: 'device', member, writer: device.writer, ...(device.slot === undefined ? {} : { slot: device.slot }) } });
    }
    for (const invite of view.invites) {
      choices.push(invite.expired
        ? { label: `Invitation for ${invite.name} (expired)`, description: `Cancel the expired invitation ${invite.invite} to clean it up`, choice: { kind: 'invite', invite: invite.invite, name: invite.name } }
        : { label: `Invitation for ${invite.name}`, description: `Cancel the open invitation ${invite.invite}`, choice: { kind: 'invite', invite: invite.invite, name: invite.name } });
    }
    // An open invitation whose file was never saved (the save failed after the roster recorded it) can be saved again on the computer that made it.
    for (const open of await membership.reissuableInvites(shared)) {
      const who = open.forMember === undefined ? open.name : `${open.name}'s other computer`;
      choices.push({ label: `${INVITE_SAVE_AGAIN_PREFIX}${who} again`, description: `Save invitation ${open.invite} again; nothing in the project changes`, choice: { kind: 'reinvite', invite: open.invite, name: who } });
    }
    // Each item carries what it removes (the member id, and the device writer for a device), and the item picked is used as it is (D-04).
    const choice = (await vscode.window.showQuickPick(choices, { title: 'Remove from the staff project', placeHolder: 'Pick a member, a device or an open invitation' }))?.choice;
    if (!choice) return;
    const { REKEY_KEEP_TEXT, REKEY_PENDING_TEXT } = await import('../domain/replica/cellKeys');
    if (choice.kind === 'finish') {
      const parts = choice.count === 1 ? 'One part of the project still uses' : `${choice.count} parts of the project still use`;
      if (!(await confirm('Finish the removal or clearance change left unfinished?', [`${parts} a key that a removed device, or a member no longer cleared for it, holds. Finishing requires new keys for the people who still have access.`, REKEY_KEEP_TEXT, REKEY_PENDING_TEXT], 'Finish'))) return;
      show(await membership.finishRekeys(shared));
      return;
    }
    if (choice.kind === 'reinvite') {
      const { INVITE_FILE_EXTENSION } = await import('../domain/replica/invite');
      const target = await saveTarget(`invitation-${fileSlug(choice.name)}${INVITE_FILE_EXTENSION}`, INVITE_FILE_EXTENSION, `Save the invitation for ${choice.name} again`, 'Staff invitation');
      if (!target) return;
      if (await inside(root, target)) { warn(INVITE_INSIDE_PROJECT_TEXT); return; }
      await deliver(await membership.remakeInvite(shared, choice.invite), target, INVITE_NOT_SAVED_TEXT);
      return;
    }
    if (choice.kind === 'invite') {
      if (!(await confirm(`Cancel the invitation for ${choice.name}?`, ['Nobody can join with it after this. You can invite them again with a new invitation.'], 'Cancel Invitation'))) return;
      show(await membership.voidInvite(shared, choice.invite));
      return;
    }
    const who = memberLabel(view.members, choice.member);
    const question = choice.kind === 'member' ? `Remove ${who} from the project?` : `Remove this device of ${who} from the project?`;
    const whoHeld = choice.kind === 'member' ? 'the member\'s devices' : 'the device';
    if (!(await confirm(question, [`Parts ${whoHeld} could read need new keys if anyone still has access.`, REKEY_KEEP_TEXT, REKEY_PENDING_TEXT], choice.kind === 'member' ? 'Remove' : 'Remove Device'))) return;
    show(await membership.removeFromProject(shared, choice.kind === 'member' ? { member: choice.member.member } : { member: choice.member.member, writer: choice.writer }));
  });
}

/** Add My Other Machine (D-18): a short invitation that only that member's other computer can answer. This computer's own member is listed first. */
async function addMachineCommand(context: StaffCommandContext): Promise<void> {
  await withShared(context, async (shared, membership, root) => {
    const view = await readRoster(shared);
    const own = view.members.filter((member) => member.member === view.self);
    const others = view.members.filter((member) => member.member !== view.self);
    const items = [...own.map((member) => ({ label: 'My other computer', description: member.name, member })), ...others.map((member) => ({ label: `Another computer of ${memberLabel(view.members, member)}`, description: member.seat ?? '', member }))];
    if (items.length === 0) { warn('Nobody in this project can be picked for that, so nothing was changed. Ask your staff lead for help.'); return; }
    const member = (await vscode.window.showQuickPick(items, { title: 'Add another computer', placeHolder: 'Whose other computer?' }))?.member;
    if (!member) return;
    const { INVITE_FILE_EXTENSION } = await import('../domain/replica/invite');
    const target = await saveTarget(`other-computer-${fileSlug(member.name)}${INVITE_FILE_EXTENSION}`, INVITE_FILE_EXTENSION, `Save the invitation for ${member.name}'s other computer`, 'Staff invitation');
    if (!target) return;
    if (await inside(root, target)) { warn(INVITE_INSIDE_PROJECT_TEXT); return; }
    const result = await membership.addMyOtherMachine(shared, { member: member.member });
    await deliver(result, target, INVITE_NOT_SAVED_TEXT);
  });
}

/** Choose Roster Branch (D-09): the roster was changed in two places at once; the lead (or the deputy when the lead is lost) picks one change. */
async function chooseBranchCommand(context: StaffCommandContext): Promise<void> {
  await withShared(context, async (shared, membership) => {
    const view = await readRoster(shared);
    const split = view.pending[0];
    // With no split, the flow gives its own sentence.
    if (split === undefined) { show(await membership.chooseRosterBranch(shared, '')); return; }
    // Each change is opened and described (MN-03): what it does, who wrote it and when, so the lead does not choose blind.
    const described = await membership.describeRosterBranches(shared);
    const items = split.branches.map((branch, index) => {
      const view = described.find((item) => item.branch === branch);
      const summary = view?.summary ?? 'A roster change this computer cannot read';
      const when = view?.at === undefined ? '' : `, ${view.at.slice(0, 16).replace('T', ' ')} UTC`;
      return { short: `change ${index + 1} of ${split.branches.length}`, label: `Change ${index + 1} of ${split.branches.length}: ${summary}`, description: `${view?.by === undefined ? '' : `by ${view.by}${when}, `}entry ${branch.slice(0, 12)}`, detail: split.text, summary, branch };
    });
    const chosen = await vscode.window.showQuickPick(items, { title: 'Choose a roster branch', placeHolder: split.text });
    const branch = chosen?.branch;
    if (!branch) return;
    if (!(await confirm(`Use ${chosen?.short ?? 'this change'}?`, [`${chosen?.summary ?? ''}.`, split.text, 'The other change at the same point stays unapplied and is kept in the record.'], 'Use This Change'))) return;
    show(await membership.chooseRosterBranch(shared, branch));
  });
}

/** Name Deputy Lead (D-10): only the staff lead may; the deputy can act for a lost lead. */
async function nameDeputyCommand(context: StaffCommandContext): Promise<void> {
  await withShared(context, async (shared, membership) => {
    const view = await readRoster(shared);
    const member = await pickMember(view.members.filter((item) => item.member !== view.lead), 'Name the deputy lead');
    if (!member) return;
    if (!(await confirm(`Name ${member.name} deputy lead?`, ['The deputy lead can change who is in the project as you can, except naming the deputy. If you lose your computer, the deputy can hand the lead over to someone.'], 'Name Deputy Lead'))) return;
    show(await membership.nameDeputy(shared, member.member));
  });
}

/** Hand Over Staff Lead (D-10): the lead for any reason, the deputy only when the lead is lost. */
async function handOverCommand(context: StaffCommandContext): Promise<void> {
  await withShared(context, async (shared, membership) => {
    const view = await readRoster(shared);
    const member = await pickMember(view.members.filter((item) => item.member !== view.lead), 'Hand over the staff lead');
    if (!member) return;
    const reasons = [
      { label: 'Planned handover', description: 'The staff lead hands over the lead.', reason: 'planned' as const },
      { label: 'The staff lead is lost', description: 'The lead\'s computers are lost or the lead cannot act. Only then may the deputy hand over.', reason: 'lead-lost' as const }
    ];
    const picked = await vscode.window.showQuickPick(reasons, { title: 'Why is the lead handed over?' });
    const reason = picked?.reason;
    if (!reason) return;
    if (!(await confirm(`Hand the staff lead over to ${member.name}?`, [`${member.name} becomes the staff lead and decides who is in the project. Reason recorded: ${picked?.label ?? reason}.`], 'Hand Over'))) return;
    show(await membership.handOverLead(shared, { to: member.member, reason }));
  });
}

/** Change a Staff Project Member (D-23): name, seat, roles, declared clearance or agent seats; a lowered clearance moves cells to new keys. */
async function updateMemberCommand(context: StaffCommandContext): Promise<void> {
  await withShared(context, async (shared, membership) => {
    const view = await readRoster(shared);
    const member = await pickMember(view.members, 'Change a staff project member');
    if (!member) return;
    const fields = [
      { label: 'Name', description: member.name },
      { label: 'Seat', description: member.seat ?? '' },
      { label: 'Roles', description: member.roles.join(', ') },
      { label: 'Clearance', description: 'The clearance you declare for them' },
      { label: 'Agent seats', description: 'The agent seats their devices may run' }
    ];
    const field = (await vscode.window.showQuickPick(fields, { title: `Change ${member.name}`, placeHolder: 'What to change' }))?.label;
    if (!field) return;
    const { REKEY_KEEP_TEXT, REKEY_PENDING_TEXT } = await import('../domain/replica/cellKeys');
    let change: { name?: string; seat?: string; roles?: string[]; clearance?: unknown; agentSeats?: string[] } | undefined;
    let what = '';
    const detail: string[] = [];
    if (field === 'Name') {
      const name = await input(`New name for ${member.name}`, 'The name as you declare it. Everyone in the project sees it.', member.name);
      if (name) { change = { name }; what = `Their name becomes ${name}.`; }
    } else if (field === 'Seat') {
      const seat = await input(`New seat for ${member.name}`, 'A staff seat in lowercase letters, digits and dashes, for example j2-analyst.', member.seat ?? '');
      if (seat && !SLUG.test(seat)) { warn(SEAT_TEXT); return; }
      if (seat) { change = { seat }; what = `Their seat becomes ${seat}.`; }
    } else if (field === 'Roles') {
      const roles = await pickRoles(`Roles for ${member.name}`, member.roles.filter((role) => !LEAD_ROLES.includes(role)));
      if (roles) { change = { roles }; what = `Their roles become ${roles.join(', ')}.`; }
    } else if (field === 'Clearance') {
      const clearance = await pickClearance(`Clearance for ${member.name}`);
      if (clearance) {
        change = { clearance };
        what = `Their declared clearance becomes ${clearance.level}.`;
        detail.push(`Parts they lose access to may need new keys. ${REKEY_KEEP_TEXT} ${REKEY_PENDING_TEXT} If the change clears them for more parts, they receive the parts they are newly cleared for.`);
      }
    } else {
      const text = await input(`Agent seats for ${member.name}`, 'The agent seats their devices may run, separated by commas, for example threat-analyst, watch-officer.');
      if (text) {
        const agentSeats = text.split(',').map((seat) => seat.trim()).filter(Boolean);
        if (agentSeats.some((seat) => !SLUG.test(seat))) { warn(AGENT_SEATS_TEXT); return; }
        change = { agentSeats };
        what = `Their devices may run these agent seats: ${agentSeats.join(', ')}.`;
      }
    }
    if (!change) return;
    if (!(await confirm(`Change ${member.name}?`, [what, ...detail], 'Change'))) return;
    show(await membership.updateMember(shared, { member: member.member, ...change }));
  });
}

/**
 * Make a Single-Machine Copy (D-35, D-47): an empty folder outside the shared project, the person who copies, and a confirmation. The result shows
 * every notice the copy returns beyond the three every screen shows (D-23), and for a project the 0.4.35 preview made shared it ends with how to share
 * the copy again (D-22 revised).
 */
async function singleCopyCommand(context: StaffCommandContext, identity: () => Promise<{ fingerprint: string }>): Promise<void> {
  const root = projectRoot();
  if (!root) { warn(NO_FOLDER_TEXT); return; }
  const copy = await import('../staff/replica/singleCopy');
  if (!(await exists(path.join(root, ...REPLICA_PROJECT_FILE.split('/'))))) { warn(shownRefusal('not-shared', copy.COPY_REFUSALS['not-shared'])); return; }
  const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: 'Choose an empty folder for the single-machine copy', openLabel: 'Copy Here' });
  const destination = picked?.[0]?.fsPath;
  if (!destination) return;
  // The flow refuses these again before it writes; asking first spares the person the dialogs below for a folder that cannot be used.
  if (await inside(root, destination)) { warn(copy.COPY_REFUSALS['destination-inside-shared']); return; }
  if (await exists(path.join(destination, '.planning', 'staff'))) { warn(copy.COPY_REFUSALS['destination-has-staff-files']); return; }
  const person = await askPerson(context, (await identity()).fingerprint);
  if (!person) return;
  if (!(await confirm('Make a single-machine copy of this shared project?', [
    `The copy goes to ${destination}. The shared project is not changed.`,
    `Steps other people took are carried under your name and signed with this device's key, written like ${copy.carriedApprovalName('A. Person', person.name)}. A decision that people made at the same time in the shared project is left open in the copy, marked ${copy.CONTESTED_AT_COPY_TEXT}.`,
    NOT_COPIED_TEXT
  ], 'Make Copy'))) return;
  // Asked before the copy, so the answer is about the shared project as it was copied.
  const preview = await heldProductsInBase(context, root);
  const result = await copy.makeSingleMachineCopy(root, destination, { ...(await replicaDeps(context)), copier: { name: person.name, role: person.role } });
  if (!result.ok) { warn(shownRefusal(result.refused, result.message)); return; }
  const parts = [`The single-machine copy is in ${destination}. Open that folder to work alone.`];
  parts.push(result.carried === 0 ? 'No step of another person needed carrying.' : `${result.carried === 1 ? 'One step' : `${result.carried} steps`} of other people ${result.carried === 1 ? 'was' : 'were'} carried under your name.`);
  if (result.contested.length > 0) parts.push(`Left open, ${copy.CONTESTED_AT_COPY_TEXT}: ${result.contested.join(', ')}.`);
  if (result.differs.length > 0) parts.push(`Carried only up to the step today's ledger can show: ${result.differs.map((item) => `${item.product} (${item.reason})`).join('; ')}.`);
  if (result.left.length > 0) parts.push(`Not carried, because their shared copy does not verify: ${result.left.map((item) => `${item.ledger} (${item.reason})`).join('; ')}.`);
  parts.push(NOT_COPIED_TEXT);
  // Every notice the copy returns beyond the ones every multi-user screen shows (tell adds those), each once: for example that parts this computer
  // is not cleared for were not copied (D-23).
  const shownEverywhere = multiUserNoticeLines();
  for (const line of new Set(result.notices)) if (!shownEverywhere.includes(line)) parts.push(line);
  if (preview) parts.push(COPY_SHARE_AGAIN_TEXT);
  // The staff host of the shared project forgets the project it opened, so it never keeps one whose store was replaced (D-09).
  await staffHostFor(root)?.invalidateShared();
  tell(parts.join(' '));
}

// ---- start this computer's shared history again (31-REVIEW MJ-08) ----------------------------------------------------------------------------------

export const START_AGAIN_QUESTION = 'Start this computer\'s shared history again?';
export const START_AGAIN_ACTION = 'Set Aside and Start Again';
/** The store refusals this command resolves; the store's own START_AGAIN_REFUSALS, kept here so no replica module loads before the handler runs. */
const START_AGAIN_STORE_REASONS: readonly string[] = ['rolled-back', 'damaged', 'mark-unverified'];
export const START_AGAIN_HOW_BACK_TEXT = 'To bring the rest of the shared history back, ask your staff lead to send this computer a new welcome file, then open it with Staff: Join Staff Project. A later version brings it back from the sharing service by itself.';

/**
 * Start This Computer's Shared History Again: for a shared project whose history on this computer is refused rolled back, damaged or unverified.
 * Says what happened and what will happen, and only on the action button moves the store folder aside (never deleting it), carries this device's
 * own signed entries, the grants, the attachments and the project record into a new one, and starts a new record of how far this device has seen.
 * A project that opens is left alone, and any other refusal is shown with its own way out. A project whose history folder on this computer is gone
 * while a folder set aside beside it holds the project is refused rolled back too, so it is reached here (D-03): the new folder is then made from
 * the newest folder set aside, and the result says nothing was set aside and which folder it was made from.
 */
async function startHistoryAgainCommand(context: StaffCommandContext): Promise<void> {
  const root = projectRoot();
  if (!root) { warn(NO_FOLDER_TEXT); return; }
  // ReplicaProject.open answers for a folder with no project.json too: undefined when nothing shared is there, refused rolled back when the history
  // folder is gone but was set aside (32-01), so that case reaches the dialog below.
  const { ReplicaProject, isProjectRefused } = await import('../staff/replica/replicaProject');
  const { STORE_REFUSALS } = await import('../staff/replica/store');
  const deps = await replicaDeps(context);
  const opened = await ReplicaProject.open(root, deps);
  if (opened === undefined) { warn(NOT_SHARED_TEXT); return; }
  if (!isProjectRefused(opened)) { await opened.close(); tell(STORE_REFUSALS['not-needed']); return; }
  if (opened.store === undefined || !START_AGAIN_STORE_REASONS.includes(opened.store)) { warn(shownRefusal(opened.refused, opened.message)); return; }
  if (!(await confirm(START_AGAIN_QUESTION, [
    `Why: ${opened.message.split('. ')[0]}.`,
    'What happens: the shared history folder on this computer, .planning/staff/replica/, is moved aside to a folder beside it, when it is there, and nothing is deleted. A new one is started with this computer\'s own signed changes, the access grants, the attachments and the project record, and this device starts a new record of how far it has seen. Changes from other people are not carried over.',
    START_AGAIN_HOW_BACK_TEXT
  ], START_AGAIN_ACTION))) return;
  const result = await ReplicaProject.startHistoryAgain(root, deps);
  if (result === undefined) { warn(NOT_SHARED_TEXT); return; }
  if (isProjectRefused(result)) { warn(shownRefusal(result.refused, result.message)); return; }
  // The staff host forgets the project it opened and opens the new store on its next read (D-09).
  await staffHostFor(root)?.invalidateShared();
  const carried = result.carried === 1 ? 'One change this computer made was' : `${result.carried} changes this computer made were`;
  const parts = [result.setAside === null
    ? 'Nothing was set aside, because this computer\'s shared history folder was not there. Nothing was deleted.'
    : `This computer's shared history was set aside in ${result.setAside}/ and nothing was deleted.`];
  if (result.carriedFrom !== undefined) parts.push(`The new one was made from ${result.carriedFrom}/.`);
  parts.push(`${carried} carried into the new one.`, START_AGAIN_HOW_BACK_TEXT);
  tell(parts.join(' '));
}

/**
 * Registers every multi-user staff command (always, so the setting needs no reload). Each checks the setting first and, when it is off, shows
 * MULTI_USER_PREVIEW_OFF_TEXT and does nothing else.
 */
export function registerStaffMultiUserCommands(context: StaffCommandContext, identity: () => Promise<{ fingerprint: string }>, register: Register): void {
  // D-64: in the Sterling image only the native engine edits shared projects, so none of these preview commands is registered there.
  if (inSterlingWorkbench()) return;
  const gated = (id: string, run: () => Promise<void>): void => {
    register(id, async () => {
      if (!multiUserPreviewOn()) { void vscode.window.showInformationMessage(MULTI_USER_PREVIEW_OFF_TEXT); return; }
      await run();
    });
  };
  gated(STAFF_MULTI_USER_COMMANDS.makeMultiUser, () => makeMultiUserCommand(context));
  gated(STAFF_MULTI_USER_COMMANDS.invite, () => inviteCommand(context));
  gated(STAFF_MULTI_USER_COMMANDS.join, () => joinCommand(context));
  gated(STAFF_MULTI_USER_COMMANDS.admit, () => admitCommand(context));
  gated(STAFF_MULTI_USER_COMMANDS.remove, () => removeCommand(context));
  gated(STAFF_MULTI_USER_COMMANDS.addMachine, () => addMachineCommand(context));
  gated(STAFF_MULTI_USER_COMMANDS.chooseBranch, () => chooseBranchCommand(context));
  gated(STAFF_MULTI_USER_COMMANDS.nameDeputy, () => nameDeputyCommand(context));
  gated(STAFF_MULTI_USER_COMMANDS.handOver, () => handOverCommand(context));
  gated(STAFF_MULTI_USER_COMMANDS.updateMember, () => updateMemberCommand(context));
  gated(STAFF_MULTI_USER_COMMANDS.singleCopy, () => singleCopyCommand(context, identity));
  gated(STAFF_MULTI_USER_COMMANDS.startHistoryAgain, () => startHistoryAgainCommand(context));
}
