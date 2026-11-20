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
// "The six words match" in a modal dialog; "They do not match" or closing the dialog writes nothing.
import { createHash } from 'node:crypto';
import { chmod, lstat, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { STAFF_MULTI_USER_COMMANDS } from '../domain/staff/commands';
import { STAFF_SECTION_IDS } from '../domain/staff/doctrine';
import { REPLICA_PROJECT_FILE, multiUserNoticeLines } from '../domain/staff/multiUser';
import { canonicalBytes } from '../domain/team/canonical';
import { identityDir } from '../team/identity';
import { localKeyStatus } from '../team/keyHistory';
import { readWhole } from '../staff/staffFiles';
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
export const NO_FOLDER_TEXT = 'Open the folder of a staff project first. Nothing was changed.';
export const NOT_SHARED_TEXT = 'This folder holds no shared staff project, so nothing was changed. To share this staff project, run Staff: Make This Staff Project Multi-User first.';
export const WORDS_DIFFER_TEXT = 'Nobody was admitted, and nothing was changed. Do not admit a request whose words differ, because someone else may have made it. Ask the person to make a new join request from your invitation, or cancel the invitation with Staff: Remove from Staff Project.';
export const WORDS_NOT_CONFIRMED_TEXT = 'Nobody was admitted, because the six words were not confirmed. Nothing was changed. Compare the words with the person out loud or in person, then run Staff: Admit to Staff Project again. If they do not match, ask the person for a new join request, or cancel the invitation with Staff: Remove from Staff Project.';
export const INVITE_INSIDE_PROJECT_TEXT = 'The invitation holds a one-time secret, so it is not saved inside the project folder, where git could commit it. Nothing was changed. Choose a folder outside the project.';
export const SEAT_TEXT = 'A seat is lowercase letters, digits and dashes, for example j2-analyst, so nothing was changed. Run the command again with a seat like that.';
export const AGENT_SEATS_TEXT = 'Agent seats are lowercase letters, digits and dashes, separated by commas, so nothing was changed. Run the command again with seats like that.';
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

/** Saves a file readable by this user account only: an invitation holds a one-time secret. An existing file chosen in the dialog is narrowed too. */
async function saveFile(target: string, text: string): Promise<void> {
  await writeFile(target, text, { encoding: 'utf8', mode: 0o600 });
  await chmod(target, 0o600);
}

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
async function pickClearance(title: string): Promise<{ scale: string; level: string; compartments: string[]; releasability: string[] } | undefined> {
  const items = Object.entries(SCALE_PRESETS).flatMap(([scale, value]) => value.levels.map((level) => ({ label: level, description: value.name, scale })));
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder: 'The clearance you declare for them (self-declared, not verified)' });
  if (!picked) return undefined;
  return { scale: picked.scale, level: picked.label, compartments: [], releasability: [] };
}

interface MemberView { member: string; name: string; seat?: string; roles: readonly string[]; devices: Array<{ writer: string; slot?: number }> }
interface RosterRead { members: MemberView[]; invites: Array<{ invite: string; name: string; forMember?: string }>; lead?: string; self?: string; pending: Array<{ at: string; branches: string[]; text: string }> }

/** What the pickers list: the members and their devices, the open invitations and the pending splits at the roster head. Read only. */
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
    .filter((record) => inviteAt(roster.members, record.invite, position, at)?.state === 'open')
    .map((record) => ({ invite: record.invite, name: record.name, ...(record.forMember === undefined ? {} : { forMember: record.forMember }) }));
  const lead = leadAt(roster, position);
  const self = deviceAt(roster.members, shared.project.deviceWriter, position)?.member;
  return { members, invites, ...(lead === undefined ? {} : { lead }), ...(self === undefined ? {} : { self }), pending: roster.pending.map((item) => ({ at: item.at, branches: [...item.branches], text: item.text })) };
}

/** A member picked from a list; names that repeat show their member id so every choice is distinct. */
async function pickMember(members: readonly MemberView[], title: string): Promise<MemberView | undefined> {
  if (members.length === 0) { warn('Nobody in this project can be picked for that, so nothing was changed. Invite someone first with Staff: Invite to Staff Project.'); return undefined; }
  const label = (member: MemberView): string => (members.filter((other) => other.name === member.name).length > 1 ? `${member.name} (${member.member})` : member.name);
  const picked = await vscode.window.showQuickPick(members.map((member) => ({ label: label(member), description: member.seat ?? '', detail: member.roles.join(', ') })), { title, placeHolder: 'Pick the member' });
  return picked === undefined ? undefined : members.find((member) => label(member) === picked.label);
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

// ---- the commands ---------------------------------------------------------------------------------------------------------------------------------

/** Make This Staff Project Multi-User (D-28 to D-34): verify the ledgers first, confirm in a modal dialog that says what happens, then convert. */
async function makeMultiUserCommand(context: StaffCommandContext): Promise<void> {
  const root = projectRoot();
  if (!root) { warn(NO_FOLDER_TEXT); return; }
  const migrate = await import('../staff/replica/migrate');
  if (!(await exists(path.join(root, '.planning', 'staff')))) { warn(shownRefusal('no-staff-project', migrate.MIGRATION_REFUSALS['no-staff-project'])); return; }
  if (await migrate.migrationComplete(root)) { warn(shownRefusal('already-shared', migrate.MIGRATION_REFUSALS['already-shared'])); return; }
  const dir = identityDir(context.globalStorageUri.fsPath);
  const staffKeyStatus = () => localKeyStatus(dir, context.secrets);
  // The four ledgers are checked before anything is asked, so a broken one is refused with today's sentence and its way out, and nothing is written.
  const verified = await migrate.verifyLegacyLedgers(root, { secrets: context.secrets, staffKeyStatus });
  if (!('ok' in verified)) { warn(shownRefusal(verified.refused, verified.message)); return; }
  const checked = migrate.LEGACY_LEDGERS.map((ledger) => {
    const read = verified.ledgers.find((item) => item.ledger === ledger.ledger);
    const name = LEDGER_NAMES[ledger.ledger] ?? ledger.ledger;
    return read === undefined ? `${name}: none yet` : `${name}: ${read.count} ${read.count === 1 ? 'entry' : 'entries'}, verified`;
  });
  const go = await confirm(MAKE_MULTI_USER_QUESTION, [
    `The four ledgers were checked with today's checks: ${checked.join('; ')}.`,
    'The project becomes shared: its history moves into a signed shared record in .planning/staff/replica/, which git ignores. You become its staff lead, signed with this device\'s key, and people join only when you invite and admit them.',
    'The original ledger files are kept in .planning/staff/legacy/ and never deleted, and the files you know stay where they are. Steps that work on one machine only are refused in a shared project. To work alone again, use Staff: Make a Single-Machine Copy.'
  ], MAKE_MULTI_USER_ACTION);
  if (!go) return;
  const labelMapHash = await labelMapHashOf(root);
  const result = await migrate.makeMultiUser(root, { ...(await replicaDeps(context)), staffKeyStatus }, labelMapHash === undefined ? {} : { labelMapHash });
  if (migrate.isMigrationRefused(result)) { warn(shownRefusal(result.refused, result.message)); return; }
  // The staff host reopens the project as shared on its next read.
  await staffHostFor(root)?.close();
  const count = result.imported.length;
  tell(`This staff project is now multi-user, and you are its staff lead. ${count === 1 ? 'One ledger was' : `${count} ledgers were`} brought into the shared record, and the original files are kept in .planning/staff/legacy/. To bring someone in, use Staff: Invite to Staff Project.`);
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
    await deliver(result, target, 'Cancel the invitation with Staff: Remove from Staff Project, then invite them again.');
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
  try {
    await saveFile(target, result.file?.text ?? '');
  } catch (error) {
    warn(`The join request could not be saved at ${target} (${error instanceof Error ? error.message : String(error)}). Run Staff: Join Staff Project again and choose another place.`);
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
    const { WELCOME_FILE_EXTENSION } = await import('../domain/replica/invite');
    const target = await saveTarget(`welcome-${fileSlug(who)}${WELCOME_FILE_EXTENSION}`, WELCOME_FILE_EXTENSION, `Save the welcome file for ${who}`, 'Staff welcome file');
    if (!target) { warn('Nobody was admitted, because the welcome file was given no place. Nothing was changed. Run Staff: Admit to Staff Project again when you are ready.'); return; }
    const result = await membership.admitJoinRequest(shared, read.text, { codeMatched: true });
    await deliver(result, target, 'Ask for help to bring them in another way.');
  });
}

type RemoveChoice = { kind: 'member'; member: MemberView } | { kind: 'device'; member: MemberView; writer: string; slot?: number } | { kind: 'invite'; invite: string; name: string };

/** Remove from Staff Project (D-17, D-23): a member, one of a member's devices, or an open invitation; the rekey sentence before and after. */
async function removeCommand(context: StaffCommandContext): Promise<void> {
  await withShared(context, async (shared, membership) => {
    const view = await readRoster(shared);
    const choices: Array<{ label: string; description: string; choice: RemoveChoice }> = [];
    for (const member of view.members) {
      choices.push({ label: member.name, description: `Remove ${member.name} and every device of theirs`, choice: { kind: 'member', member } });
      for (const device of member.devices) choices.push({ label: `${member.name}, device in slot ${device.slot ?? '?'}`, description: 'Remove this one device', choice: { kind: 'device', member, writer: device.writer, ...(device.slot === undefined ? {} : { slot: device.slot }) } });
    }
    for (const invite of view.invites) choices.push({ label: `Invitation for ${invite.name}`, description: `Cancel the open invitation ${invite.invite}`, choice: { kind: 'invite', invite: invite.invite, name: invite.name } });
    const picked = await vscode.window.showQuickPick(choices.map(({ label, description }) => ({ label, description })), { title: 'Remove from the staff project', placeHolder: 'Pick a member, a device or an open invitation' });
    const choice = picked === undefined ? undefined : choices.find((item) => item.label === picked.label && item.description === picked.description)?.choice;
    if (!choice) return;
    const { REKEY_KEEP_TEXT } = await import('../domain/replica/cellKeys');
    if (choice.kind === 'invite') {
      if (!(await confirm(`Cancel the invitation for ${choice.name}?`, ['Nobody can join with it after this. You can invite them again with a new invitation.'], 'Cancel Invitation'))) return;
      show(await membership.voidInvite(shared, choice.invite));
      return;
    }
    const question = choice.kind === 'member' ? `Remove ${choice.member.name} from the project?` : `Remove this device of ${choice.member.name} from the project?`;
    const what = choice.kind === 'member' ? 'Their devices receive nothing new from the project.' : 'That device receives nothing new from the project.';
    if (!(await confirm(question, [`${what} Every part of the project it was on moves to a new key for the people still on it.`, REKEY_KEEP_TEXT], choice.kind === 'member' ? 'Remove' : 'Remove Device'))) return;
    show(await membership.removeFromProject(shared, choice.kind === 'member' ? { member: choice.member.member } : { member: choice.member.member, writer: choice.writer }));
  });
}

/** Add My Other Machine (D-18): a short invitation that only that member's other computer can answer. This computer's own member is listed first. */
async function addMachineCommand(context: StaffCommandContext): Promise<void> {
  await withShared(context, async (shared, membership, root) => {
    const view = await readRoster(shared);
    const own = view.members.filter((member) => member.member === view.self);
    const others = view.members.filter((member) => member.member !== view.self);
    const items = [...own.map((member) => ({ label: 'My other computer', description: member.name, member })), ...others.map((member) => ({ label: `Another computer of ${member.name}`, description: member.seat ?? '', member }))];
    if (items.length === 0) { warn('Nobody in this project can be picked for that, so nothing was changed. Ask your staff lead for help.'); return; }
    const picked = await vscode.window.showQuickPick(items.map(({ label, description }) => ({ label, description })), { title: 'Add another computer', placeHolder: 'Whose other computer?' });
    const member = picked === undefined ? undefined : items.find((item) => item.label === picked.label && item.description === picked.description)?.member;
    if (!member) return;
    const { INVITE_FILE_EXTENSION } = await import('../domain/replica/invite');
    const target = await saveTarget(`other-computer-${fileSlug(member.name)}${INVITE_FILE_EXTENSION}`, INVITE_FILE_EXTENSION, `Save the invitation for ${member.name}'s other computer`, 'Staff invitation');
    if (!target) return;
    if (await inside(root, target)) { warn(INVITE_INSIDE_PROJECT_TEXT); return; }
    const result = await membership.addMyOtherMachine(shared, { member: member.member });
    await deliver(result, target, 'Cancel the invitation with Staff: Remove from Staff Project, then make a new one.');
  });
}

/** Choose Roster Branch (D-09): the roster was changed in two places at once; the lead (or the deputy when the lead is lost) picks one change. */
async function chooseBranchCommand(context: StaffCommandContext): Promise<void> {
  await withShared(context, async (shared, membership) => {
    const view = await readRoster(shared);
    const split = view.pending[0];
    // With no split, the flow gives its own sentence.
    if (split === undefined) { show(await membership.chooseRosterBranch(shared, '')); return; }
    const items = split.branches.map((branch, index) => ({ label: `Change ${index + 1} of ${split.branches.length}`, description: `entry ${branch.slice(0, 12)}`, detail: split.text, branch }));
    const picked = await vscode.window.showQuickPick(items.map(({ label, description, detail }) => ({ label, description, detail })), { title: 'Choose a roster branch', placeHolder: split.text });
    const branch = picked === undefined ? undefined : items.find((item) => item.label === picked.label)?.branch;
    if (!branch) return;
    if (!(await confirm(`Use ${picked?.label.toLowerCase() ?? 'this change'}?`, [split.text, 'The other change at the same point stays unapplied and is kept in the record.'], 'Use This Change'))) return;
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
    const picked = await vscode.window.showQuickPick(reasons.map(({ label, description }) => ({ label, description })), { title: 'Why is the lead handed over?' });
    const reason = picked === undefined ? undefined : reasons.find((item) => item.label === picked.label)?.reason;
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
    const { REKEY_KEEP_TEXT } = await import('../domain/replica/cellKeys');
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
        detail.push(`If it is lower than before, every part of the project they are no longer cleared for moves to a new key without their devices. ${REKEY_KEEP_TEXT} If it is higher, they receive the parts they are newly cleared for.`);
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

/** Make a Single-Machine Copy (D-35, D-47): an empty folder outside the shared project, the person who copies, and a confirmation. */
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
  const result = await copy.makeSingleMachineCopy(root, destination, { ...(await replicaDeps(context)), copier: { name: person.name, role: person.role } });
  if (!result.ok) { warn(shownRefusal(result.refused, result.message)); return; }
  const parts = [`The single-machine copy is in ${destination}. Open that folder to work alone.`];
  parts.push(result.carried === 0 ? 'No step of another person needed carrying.' : `${result.carried === 1 ? 'One step' : `${result.carried} steps`} of other people ${result.carried === 1 ? 'was' : 'were'} carried under your name.`);
  if (result.contested.length > 0) parts.push(`Left open, ${copy.CONTESTED_AT_COPY_TEXT}: ${result.contested.join(', ')}.`);
  if (result.differs.length > 0) parts.push(`Carried only up to the step today's ledger can show: ${result.differs.map((item) => `${item.product} (${item.reason})`).join('; ')}.`);
  if (result.left.length > 0) parts.push(`Not carried, because their shared copy does not verify: ${result.left.map((item) => `${item.ledger} (${item.reason})`).join('; ')}.`);
  parts.push(NOT_COPIED_TEXT);
  tell(parts.join(' '));
}

/**
 * Registers every multi-user staff command (always, so the setting needs no reload). Each checks the setting first and, when it is off, shows
 * MULTI_USER_PREVIEW_OFF_TEXT and does nothing else.
 */
export function registerStaffMultiUserCommands(context: StaffCommandContext, identity: () => Promise<{ fingerprint: string }>, register: Register): void {
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
}
