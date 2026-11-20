// The multi-user staff commands (plan 31-23; D-09, D-10, D-13 to D-18, D-23, D-28 to D-37): each command driven through the vscode stub on real
// installs (a project folder, extension storage and secret storage each), with the preview setting off and on. Off: one message and nothing written.
// On: Make This Staff Project Multi-User verifies, confirms and converts; invite, join, admit with the six words, welcome, remove, add a machine,
// choose a branch, deputy, handover, change a member and the single-machine copy each run their flow and show its sentence with the D-13 notices;
// admission happens only on "The six words match"; and every refusal says what happened and what to do next.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test, { after } from 'node:test';
import { CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT } from '../domain/gate/labels';
import { REKEY_KEEP_TEXT } from '../domain/replica/cellKeys';
import { INVITE_FILE_EXTENSION, INVITE_REFUSALS, JOIN_REQUEST_FILE_EXTENSION, WELCOME_FILE_EXTENSION } from '../domain/replica/invite';
import type { ProjectOutput } from '../domain/replica/projectFold';
import { ROSTER_REFUSALS, ROSTER_SPLIT_TEXT } from '../domain/replica/roster';
import { CELL_REFUSALS } from '../domain/replica/rosterCells';
import { MEMBER_REFUSALS, inviteAt, memberAt } from '../domain/replica/rosterMembers';
import { PERSON_DECISION_COMMANDS, STAFF_COMMANDS, STAFF_MULTI_USER_COMMANDS } from '../domain/staff/commands';
import { LEGACY_DIR, MULTI_USER_DECLARED_TEXT, REPLICA_PROJECT_FILE, SHARED_PROJECT_REFUSAL, multiUserNoticeLines } from '../domain/staff/multiUser';
import { canonicalBytes } from '../domain/team/canonical';
import { MEMBERSHIP_REFUSALS } from '../staff/replica/membership';
import { MIGRATION_REFUSALS } from '../staff/replica/migrate';
import { PROJECT_REFUSALS_HOST, ReplicaProject } from '../staff/replica/replicaProject';
import type { ReplicaProjectDeps } from '../staff/replica/replicaProject';
import { COPY_REFUSALS } from '../staff/replica/singleCopy';
import { LEDGER_DIR, LEDGER_FILE } from '../staff/staffHost';
import { MemorySecrets } from './helpers/teamHarness';
import { CLEAN_BODY, J5_TEAM, callTool, writeBody } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const staffCommands = require('../services/staffCommands') as typeof import('../services/staffCommands');
const multi = require('../services/staffMultiUserCommands') as typeof import('../services/staffMultiUserCommands');
const hosts = require('../staff/staffHost') as typeof import('../staff/staffHost');

const opened: ReplicaProject[] = [];
after(async () => {
  for (const project of opened) await project.close();
  for (const subscription of current?.context.subscriptions ?? []) subscription.dispose();
  hosts.configureStaffHosts(undefined);
  uninstall();
});

const C = STAFF_MULTI_USER_COMMANDS;
const NOTICES = multiUserNoticeLines();
const EM_DASH = '—';

// ---- installs --------------------------------------------------------------------------------------------------------------------------------------

/** One install: a project folder, the extension's global storage, its secret storage, and the folder the person saves files to. */
interface Install {
  readonly base: string;
  readonly root: string;
  readonly storage: string;
  readonly out: string;
  readonly secrets: MemorySecrets;
  readonly context: ReturnType<typeof createFakeContext>;
  readonly deps: ReplicaProjectDeps;
}

function install(label: string): Install {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-mu-cmd-${label}-`));
  const root = path.join(base, 'project');
  const out = path.join(base, 'out');
  mkdirSync(root, { recursive: true });
  mkdirSync(out, { recursive: true });
  const storage = path.join(base, 'storage');
  const secrets = new MemorySecrets();
  return { base, root, storage, out, secrets, context: createFakeContext(storage, secrets), deps: { secrets, globalStorageDir: storage } };
}

let current: Install | undefined;

/** This window is now the install's: its folder is open and the staff commands are registered with its storage and secrets. */
function use(at: Install, preview = true): void {
  for (const subscription of current?.context.subscriptions.splice(0) ?? []) subscription.dispose();
  stub.commands.clear();
  stub.setWorkspaceFolders([at.root]);
  stub.setConfig(multi.MULTI_USER_PREVIEW_SETTING, preview);
  staffCommands.registerStaffCommands(at.context as never);
  current = at;
}

async function run(id: string): Promise<void> {
  const handler = stub.commands.get(id);
  assert.ok(handler, `${id} is registered`);
  await handler();
}

function lastNotification(): { level: string; message: string } {
  const last = stub.notifications[stub.notifications.length - 1];
  assert.ok(last, 'a message was shown');
  return last;
}

function lastModal(): { message: string; modal?: boolean; detail?: string } {
  const last = stub.messageOptions[stub.messageOptions.length - 1];
  assert.ok(last?.modal, 'a modal dialog was shown');
  return last;
}

function hasNotices(text: string, what: string): void {
  for (const line of NOTICES) assert.ok(text.includes(line), `${what} shows: ${line}`);
}

/** Every file under a folder, by path, with the hash of its bytes; folders too. Nothing may change when a command writes nothing. */
function tree(folder: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const relative = path.relative(folder, full);
      if (statSync(full).isDirectory()) { result[`${relative}/`] = 'dir'; walk(full); } else result[relative] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(folder);
  return result;
}

/**
 * The files and the secrets of an install. Opening a shared project signs its store mark again with a new time (31-13), so a mark is compared by what
 * it records, not by when it was signed.
 */
function state(at: Install): { files: Record<string, string>; secrets: Array<[string, string]> } {
  const recorded = (value: string): string => {
    try {
      const parsed = JSON.parse(value) as { purpose?: unknown; payload?: unknown };
      return parsed.purpose === 'staff-replica-mark' ? `mark ${JSON.stringify(parsed.payload)}` : value;
    } catch {
      return value;
    }
  };
  return { files: tree(at.base), secrets: [...at.secrets.values.entries()].map(([key, value]): [string, string] => [key, recorded(value)]).sort() };
}

/** A lead install whose project is shared (founded directly through ReplicaProject, as the membership tests do), with this window open on it. */
async function lead(label = 'lead'): Promise<Install> {
  const at = install(label);
  const made = await ReplicaProject.createSharedProject(at.root, at.deps, { name: 'Exercise Northwind', profile: 'nato-ca', level: 'tactical', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead' } });
  assert.ok(made instanceof ReplicaProject);
  await made.close();
  // Opened once, as the window would, so the store's mark is recorded before a test compares anything.
  await stateOf(at);
  use(at);
  return at;
}

/** Opens an install's shared project, reads its state, and closes it. */
async function stateOf(at: Install): Promise<Awaited<ReturnType<ReplicaProject['state']>>> {
  const project = await ReplicaProject.open(at.root, at.deps);
  assert.ok(project instanceof ReplicaProject, 'the shared project opens');
  opened.push(project);
  try {
    return await project.state();
  } finally {
    await project.close();
  }
}

async function rosterOf(at: Install): Promise<Awaited<ReturnType<ReplicaProject['state']>>['roster']> {
  return (await stateOf(at)).roster;
}

const headOf = (roster: Awaited<ReturnType<typeof rosterOf>>): number => roster.positions.length - 1;

/** The lead invites a person through the command; the invitation is saved in the lead's out folder. */
async function inviteBy(at: Install, name: string): Promise<string> {
  use(at);
  const target = path.join(at.out, `invitation-${name.replace(/\W+/g, '-')}`);
  stub.inputAnswers.push(name, 'j2-analyst');
  stub.quickPickAnswers.push(['member', 'answers_for:j2'], 'Internal');
  stub.saveDialogAnswers.push(target);
  await run(C.invite);
  const file = `${target}${INVITE_FILE_EXTENSION}`;
  assert.ok(existsSync(file), `the invitation is saved with its extension (${lastNotification().message})`);
  return file;
}

/** The joining install answers the invitation through the command; the join request is saved in its out folder. */
async function joinBy(at: Install, invitation: string, name: string): Promise<{ request: string; words: string[] }> {
  use(at);
  stub.openDialogAnswers.push([invitation]);
  stub.inputAnswers.push(name);
  stub.saveDialogAnswers.push(path.join(at.out, `join${JOIN_REQUEST_FILE_EXTENSION}`));
  await run(C.join);
  const dialog = lastModal();
  const words = /Read these six words to the staff lead: (.+)$/.exec(dialog.message)?.[1].split(' ') ?? [];
  assert.equal(words.length, 6, `six words are shown: ${dialog.message}`);
  return { request: path.join(at.out, `join${JOIN_REQUEST_FILE_EXTENSION}`), words };
}

/** The lead admits through the command, answering the six-word dialog. */
async function admitBy(at: Install, request: string, answer: string | undefined, welcome?: string): Promise<void> {
  use(at);
  stub.openDialogAnswers.push([request]);
  stub.messageAnswers.push(answer);
  if (welcome !== undefined) stub.saveDialogAnswers.push(welcome);
  await run(C.admit);
}

/** A lead and one admitted person, brought in entirely through the commands. */
async function pair(label: string): Promise<{ lead: Install; joiner: Install; member: string }> {
  const first = await lead(`${label}-lead`);
  const joiner = install(`${label}-joiner`);
  const invitation = await inviteBy(first, 'B. Example');
  const { request } = await joinBy(joiner, invitation, 'B. Example');
  const welcome = path.join(first.out, `welcome${WELCOME_FILE_EXTENSION}`);
  await admitBy(first, request, multi.SIX_WORDS_MATCH, welcome);
  use(joiner);
  stub.openDialogAnswers.push([welcome]);
  await run(C.join);
  assert.match(lastNotification().message, /You joined the shared staff project/);
  const roster = await rosterOf(first);
  const member = [...roster.members.members.keys()].find((id) => memberAt(roster.members, id, headOf(roster))?.name === 'B. Example');
  assert.ok(member, 'the person is a member');
  use(first);
  return { lead: first, joiner, member };
}

// ---- a single-machine staff project ----------------------------------------------------------------------------------------------------------------

/** A single-machine staff project made by today's host in this window (signed by this install's device), with one proposed product. */
async function staffProject(label: string): Promise<Install> {
  const at = install(label);
  use(at);
  const host = hosts.staffHostFor(at.root);
  assert.ok(host);
  await writeBody(at.root, 'j5', 'concept-of-operations', CLEAN_BODY);
  const proposed = await callTool({ root: at.root, host } as StaffWorld, J5_TEAM, 'mcp__staff-products__propose', { product: 'concept-of-operations', kind: 'plan' }, 'lead-planner');
  assert.ok(proposed.ok, proposed.text);
  return at;
}

// ---- Task 1: the gate and Make This Staff Project Multi-User --------------------------------------------------------------------------------------

test('with the setting off, Make This Staff Project Multi-User says how to turn it on and writes nothing', async () => {
  const at = await staffProject('off');
  use(at, false);
  const before = state(at);
  const shown = stub.notifications.length;
  await run(C.makeMultiUser);
  assert.equal(stub.notifications.length, shown + 1, 'one message');
  assert.deepEqual(lastNotification(), { level: 'info', message: multi.MULTI_USER_PREVIEW_OFF_TEXT });
  assert.match(multi.MULTI_USER_PREVIEW_OFF_TEXT, /Settings[\s\S]*nearAi\.staff\.multiUserPreview/);
  assert.deepEqual(state(at), before, 'no file, folder or secret changed');
});

test('with the setting on, the modal says what happens; dismissing writes nothing; confirming converts and shows the notices and the real label map hash', async () => {
  const at = await staffProject('on');
  // A signed label map of the project (its content does not matter to the hash): the genesis names its hash (D-07).
  const labels = { payload: { labelMapVersion: 1, entries: {} }, signature: 'x' };
  mkdirSync(path.join(at.root, '.planning', '.near-ai'), { recursive: true });
  await writeFile(path.join(at.root, '.planning', '.near-ai', 'labels.json'), JSON.stringify(labels, null, 2));
  const before = state(at);
  stub.messageAnswers.push(undefined);
  await run(C.makeMultiUser);
  const dialog = lastModal();
  assert.equal(dialog.message, multi.MAKE_MULTI_USER_QUESTION);
  assert.match(dialog.detail ?? '', /the product ledger: 1 entry, verified; the decision log: none yet; the calculator ledger: none yet; the wargame ledger: none yet/);
  assert.match(dialog.detail ?? '', /\.planning\/staff\/legacy\/ and never deleted/);
  assert.match(dialog.detail ?? '', /becomes shared/);
  hasNotices(dialog.detail ?? '', 'the confirmation');
  assert.deepEqual(state(at), before, 'dismissed: nothing written');

  stub.messageAnswers.push(multi.MAKE_MULTI_USER_ACTION);
  await run(C.makeMultiUser);
  const result = lastNotification();
  assert.equal(result.level, 'info', result.message);
  assert.match(result.message, /now multi-user, and you are its staff lead\. One ledger was brought into the shared record/);
  hasNotices(result.message, 'the result');
  assert.ok(existsSync(path.join(at.root, ...REPLICA_PROJECT_FILE.split('/'))));
  assert.ok(existsSync(path.join(at.root, ...LEGACY_DIR.split('/'), 'ledger', LEDGER_FILE)), 'the original ledger is kept in the legacy folder');
  const { roster, fold } = await stateOf(at);
  const output = (fold.families.project as ProjectOutput | undefined)?.find((item) => item.stream === roster.anchor.project);
  assert.equal(output?.labelMapHash, createHash('sha256').update(canonicalBytes(labels)).digest('hex'), 'the genesis names the project\'s label map');
  // The staff host now reads the project as shared, and the command refuses a second conversion with a next step.
  assert.equal(await hosts.staffHostFor(at.root)?.isSharedProject(), true);
  await run(C.makeMultiUser);
  assert.match(lastNotification().message, new RegExp(`${MIGRATION_REFUSALS['already-shared'].replace(/[.]/g, '\\.')} To bring someone in, use Staff: Invite to Staff Project\\.`));
});

test('a broken product ledger is refused with today\'s wording and the Set Aside way out, before any dialog, and nothing is written', async () => {
  const at = await staffProject('broken');
  await appendFile(path.join(at.root, LEDGER_DIR, LEDGER_FILE), 'this line is not a ledger entry\n');
  const before = state(at);
  const dialogs = stub.messageOptions.length;
  await run(C.makeMultiUser);
  const shown = lastNotification();
  assert.equal(shown.level, 'warn');
  assert.ok(shown.message.startsWith(MIGRATION_REFUSALS['ledger-broken']), shown.message);
  assert.match(shown.message, /Staff: Set Aside the Product Ledger/);
  hasNotices(shown.message, 'the refusal');
  assert.equal(stub.messageOptions.length, dialogs, 'no confirmation was asked for');
  assert.deepEqual(state(at), before);
});

// ---- Task 2: the other ten commands ----------------------------------------------------------------------------------------------------------------

test('invite, join, admit with the six words matching, and the welcome: each through its command, with the notices on every screen', async () => {
  const first = await lead('flow-lead');
  const joiner = install('flow-joiner');
  const invitation = await inviteBy(first, 'B. Example');
  const invited = lastNotification();
  assert.equal(invited.level, 'info');
  assert.match(invited.message, /Send the file to them any way you like\. It works once and expires on (\d{4}-\d{2}-\d{2})/);
  const expires = /expires on (\d{4}-\d{2}-\d{2})/.exec(invited.message)?.[1];
  assert.equal(expires, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10), 'open 7 days');
  hasNotices(invited.message, 'the invitation result');
  if (process.platform !== 'win32') assert.equal(statSync(invitation).mode & 0o777, 0o600, 'the invitation is readable by its owner only');
  assert.equal(stub.saveDialogRequests[stub.saveDialogRequests.length - 1].filters?.['Staff invitation']?.[0], 'near-staff-invite');

  const { request, words } = await joinBy(joiner, invitation, 'B. Example');
  assert.ok(existsSync(request), 'the join request is saved');
  hasNotices(lastModal().detail ?? '', 'the join result');

  const welcome = path.join(first.out, 'welcome-b');
  await admitBy(first, request, multi.SIX_WORDS_MATCH, welcome);
  const asked = stub.messageOptions.find((entry) => entry.message.startsWith('Admit B. Example?'));
  assert.ok(asked?.modal, 'the admit question is modal');
  assert.ok(asked.message.endsWith(words.join(' ')), 'the lead sees the same six words the joiner reads');
  assert.match(asked.detail ?? '', /admitted as B\. Example, seat j2-analyst/);
  hasNotices(asked.detail ?? '', 'the admit dialog');
  assert.deepEqual(stub.notificationActions[stub.notifications.findIndex((entry) => entry.message === asked.message)].slice(1), [multi.SIX_WORDS_MATCH, multi.SIX_WORDS_DIFFER]);
  const admitted = lastNotification();
  assert.match(admitted.message, /B\. Example was admitted\. Send them the welcome file/);
  hasNotices(admitted.message, 'the admit result');
  assert.ok(existsSync(`${welcome}${WELCOME_FILE_EXTENSION}`));

  use(joiner);
  stub.openDialogAnswers.push([`${welcome}${WELCOME_FILE_EXTENSION}`]);
  await run(C.join);
  const joined = lastNotification();
  assert.match(joined.message, new RegExp(`You joined the shared staff project\\. ${MULTI_USER_DECLARED_TEXT.replace(/[.]/g, '\\.')}`));
  hasNotices(joined.message, 'the welcome result');
  assert.ok(existsSync(path.join(joiner.root, ...REPLICA_PROJECT_FILE.split('/'))), 'the project is on the joiner\'s computer');
});

test('admit: "They do not match" and a dismissed dialog admit nobody, write nothing and say what to do', async () => {
  const first = await lead('nomatch-lead');
  const joiner = install('nomatch-joiner');
  const { request } = await joinBy(joiner, await inviteBy(first, 'C. Example'), 'C. Example');
  use(first);
  const before = state(first);
  const saves = stub.saveDialogRequests.length;
  await admitBy(first, request, multi.SIX_WORDS_DIFFER);
  assert.deepEqual(lastNotification(), { level: 'warn', message: `${multi.WORDS_DIFFER_TEXT} ${NOTICES.join(' ')}` });
  assert.match(multi.WORDS_DIFFER_TEXT, /new join request[\s\S]*cancel the invitation/);
  await admitBy(first, request, undefined);
  assert.equal(lastNotification().message, `${multi.WORDS_NOT_CONFIRMED_TEXT} ${NOTICES.join(' ')}`);
  await admitBy(first, request, 'Admit');
  assert.equal(lastNotification().message, `${multi.WORDS_NOT_CONFIRMED_TEXT} ${NOTICES.join(' ')}`, 'any answer but the match button admits nobody');
  assert.equal(stub.saveDialogRequests.length, saves, 'no welcome file was asked for');
  assert.deepEqual(state(first), before, 'nothing written');
  const roster = await rosterOf(first);
  assert.equal([...roster.members.members.keys()].some((id) => memberAt(roster.members, id, headOf(roster))?.name === 'C. Example'), false);
});

test('invite: a seat that is not a slug and a save place inside the project are refused before anything is written', async () => {
  const first = await lead('invite-refused');
  const before = state(first);
  stub.inputAnswers.push('D. Example', 'J2 Analyst');
  await run(C.invite);
  assert.equal(lastNotification().message, `${multi.SEAT_TEXT} ${NOTICES.join(' ')}`);
  stub.inputAnswers.push('D. Example', 'j2-analyst');
  stub.quickPickAnswers.push(['member'], 'Internal');
  stub.saveDialogAnswers.push(path.join(first.root, 'invitation'));
  await run(C.invite);
  assert.equal(lastNotification().message, `${multi.INVITE_INSIDE_PROJECT_TEXT} ${NOTICES.join(' ')}`);
  stub.inputAnswers.push('D. Example', 'j2-analyst');
  stub.quickPickAnswers.push(['member'], 'Internal');
  await run(C.invite);
  assert.deepEqual(state(first), before, 'a dismissed save dialog writes nothing either');
  const roster = await rosterOf(first);
  assert.equal(roster.members.invites.size, 0);
});

test('every multi-user command with the setting off shows one message and writes nothing, in a shared project too', async () => {
  const first = await lead('all-off');
  use(first, false);
  const before = state(first);
  for (const id of Object.values(C)) {
    const shown = stub.notifications.length;
    stub.openDialogAnswers.push([first.root]);
    stub.saveDialogAnswers.push(path.join(first.out, 'x'));
    stub.inputAnswers.push('E. Example', 'j2-analyst');
    await run(id);
    assert.equal(stub.notifications.length, shown + 1, id);
    assert.deepEqual(lastNotification(), { level: 'info', message: multi.MULTI_USER_PREVIEW_OFF_TEXT }, id);
    stub.openDialogAnswers.length = 0;
    stub.saveDialogAnswers.length = 0;
    stub.inputAnswers.length = 0;
  }
  assert.deepEqual(state(first), before);
});

test('remove a member: the confirmation and the result say they keep what they received and receive nothing new', async () => {
  const { lead: first, member } = await pair('remove');
  stub.quickPickAnswers.push('B. Example');
  stub.messageAnswers.push(undefined);
  const before = state(first);
  await run(C.remove);
  const dialog = lastModal();
  assert.equal(dialog.message, 'Remove B. Example from the project?');
  assert.ok((dialog.detail ?? '').includes(REKEY_KEEP_TEXT));
  hasNotices(dialog.detail ?? '', 'the remove confirmation');
  assert.deepEqual(state(first), before, 'dismissed: nothing written');
  const listed = stub.quickPickRequests[stub.quickPickRequests.length - 1].items.map((item) => item.label);
  assert.ok(listed.includes('B. Example') && listed.some((label) => label.startsWith('B. Example, device in slot')), `members and devices are offered: ${listed.join(' | ')}`);

  stub.quickPickAnswers.push('B. Example');
  stub.messageAnswers.push('Remove');
  await run(C.remove);
  const result = lastNotification();
  assert.equal(result.level, 'info', result.message);
  assert.match(result.message, /B\. Example was removed from the project\./);
  assert.ok(result.message.includes(REKEY_KEEP_TEXT));
  hasNotices(result.message, 'the remove result');
  const roster = await rosterOf(first);
  assert.equal(memberAt(roster.members, member, headOf(roster)), undefined);
});

test('remove: cancelling an open invitation writes invite.void; removing one device keeps the member', async () => {
  const { lead: first, member } = await pair('void');
  await inviteBy(first, 'F. Example');
  const invite = [...(await rosterOf(first)).members.invites.values()].find((record) => record.name === 'F. Example')?.invite;
  assert.ok(invite);
  stub.quickPickAnswers.push('Invitation for F. Example');
  stub.messageAnswers.push('Cancel Invitation');
  await run(C.remove);
  assert.match(lastNotification().message, /The invitation was cancelled\. Nobody can join with it now\./);
  let roster = await rosterOf(first);
  assert.equal(inviteAt(roster.members, invite, headOf(roster))?.state, 'voided');

  stub.quickPickAnswers.push('B. Example, device in slot 2');
  stub.messageAnswers.push('Remove Device');
  await run(C.remove);
  assert.equal(lastModal().message, 'Remove this device of B. Example from the project?');
  assert.ok((lastModal().detail ?? '').includes(REKEY_KEEP_TEXT));
  assert.match(lastNotification().message, /That device of B\. Example was removed from the project\./);
  roster = await rosterOf(first);
  assert.ok(memberAt(roster.members, member, headOf(roster)), 'the member stays');
});

test('MJ-02: a welcome file that could not be saved is made again through Admit with the same join request, writing nothing, and it opens', async () => {
  const first = await lead('remake-lead');
  const joiner = install('remake-joiner');
  const { request } = await joinBy(joiner, await inviteBy(first, 'B. Example'), 'B. Example');
  // The save place does not exist, so the welcome file is not saved: the person is admitted all the same, and the lead is told how to make it again.
  await admitBy(first, request, multi.SIX_WORDS_MATCH, path.join(first.out, 'missing', 'welcome'));
  const unsaved = lastNotification();
  assert.equal(unsaved.level, 'warn');
  assert.ok(unsaved.message.includes(multi.WELCOME_NOT_SAVED_TEXT), unsaved.message);
  const before = state(first);
  // Admit again with the same request: the person is already in, so only Make Welcome File is offered, with no six words to compare.
  const welcome = path.join(first.out, 'welcome-again');
  await admitBy(first, request, multi.MAKE_WELCOME_AGAIN, welcome);
  const asked = lastModal();
  assert.equal(asked.message, 'Make the welcome file for B. Example again?');
  hasNotices(asked.detail ?? '', 'the make-again question');
  assert.match(lastNotification().message, /The welcome file for B\. Example was made again\./);
  assert.ok(existsSync(`${welcome}${WELCOME_FILE_EXTENSION}`));
  const after = state(first);
  assert.deepEqual(after.files[path.join('project', REPLICA_PROJECT_FILE)], before.files[path.join('project', REPLICA_PROJECT_FILE)]);
  assert.deepEqual(Object.keys(after.files).filter((name) => name.startsWith(`project${path.sep}`)).sort(), Object.keys(before.files).filter((name) => name.startsWith(`project${path.sep}`)).sort(), 'nothing new in the project');
  use(joiner);
  stub.openDialogAnswers.push([`${welcome}${WELCOME_FILE_EXTENSION}`]);
  await run(C.join);
  assert.match(lastNotification().message, /You joined the shared staff project/);
});

test('MN-02: an expired invitation is listed by Remove as expired, and cancelling it voids it and forgets its join secret', async () => {
  const first = await lead('expired');
  const opened1 = await ReplicaProject.open(first.root, { ...first.deps, now: () => new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) });
  assert.ok(opened1 instanceof ReplicaProject);
  opened.push(opened1);
  const { inviteToProject } = await import('../staff/replica/membership');
  const invited = await inviteToProject({ project: opened1, deps: { ...first.deps, now: () => new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } }, { name: 'G. Example', seat: 'j2-analyst', clearance: { scale: 'org', level: 'Internal', compartments: [], releasability: [] }, days: 1 });
  await opened1.close();
  assert.ok(invited.ok, invited.message);
  const id = invited.invite as string;
  assert.ok([...first.secrets.values.keys()].some((key) => key.endsWith(id)), 'the join secret is kept');
  use(first);
  stub.quickPickAnswers.push('Invitation for G. Example (expired)');
  stub.messageAnswers.push('Cancel Invitation');
  await run(C.remove);
  const listed = stub.quickPickRequests[stub.quickPickRequests.length - 1].items;
  assert.ok(listed.some((item) => item.label === 'Invitation for G. Example (expired)' && /to clean it up/.test(item.description ?? '')), listed.map((item) => item.label).join(' | '));
  assert.match(lastNotification().message, /The invitation was cancelled\./);
  const roster = await rosterOf(first);
  assert.equal(inviteAt(roster.members, id, headOf(roster))?.state, 'voided');
  assert.equal([...first.secrets.values.keys()].some((key) => key.endsWith(id)), false, 'its join secret is forgotten');
});

test('MJ-03: Remove offers to finish a removal left unfinished, first in its list; finishing moves the cells to new keys and the offer goes away', async () => {
  const { lead: first, member } = await pair('finish');
  const project1 = await ReplicaProject.open(first.root, first.deps);
  assert.ok(project1 instanceof ReplicaProject);
  opened.push(project1);
  assert.ok('ok' in (await project1.appendOwn('member.remove', { member })));
  await project1.close();
  stub.quickPickAnswers.push(undefined);
  await run(C.remove);
  const listed = stub.quickPickRequests[stub.quickPickRequests.length - 1].items;
  assert.equal(listed[0].label, multi.FINISH_UNFINISHED_LABEL);
  assert.match(listed[0].description ?? '', /^One part of the project is still on a key/);
  stub.quickPickAnswers.push(multi.FINISH_UNFINISHED_LABEL);
  stub.messageAnswers.push('Finish');
  await run(C.remove);
  assert.equal(lastModal().message, 'Finish the removal or clearance change left unfinished?');
  assert.ok((lastModal().detail ?? '').includes(REKEY_KEEP_TEXT));
  const result = lastNotification();
  assert.equal(result.level, 'info', result.message);
  assert.match(result.message, /The removal or clearance change left unfinished is now finished\. One part of the project was moved to a new key\./);
  hasNotices(result.message, 'the finish result');
  stub.quickPickAnswers.push(undefined);
  await run(C.remove);
  assert.equal(stub.quickPickRequests[stub.quickPickRequests.length - 1].items.some((item) => item.label === multi.FINISH_UNFINISHED_LABEL), false);
});

test('add my other machine: the lead\'s own computer is offered first and the invitation is saved with its extension', async () => {
  const first = await lead('machine');
  stub.quickPickAnswers.push('My other computer');
  stub.saveDialogAnswers.push(path.join(first.out, 'second'));
  await run(C.addMachine);
  assert.match(lastNotification().message, /The invitation for .*'s other computer is ready\./);
  hasNotices(lastNotification().message, 'the result');
  assert.ok(existsSync(path.join(first.out, `second${INVITE_FILE_EXTENSION}`)));
});

test('choose roster branch with no split shows the flow\'s sentence and a next step; nothing is written', async () => {
  const first = await lead('branch');
  const before = state(first);
  await run(C.chooseBranch);
  const shown = lastNotification();
  assert.equal(shown.level, 'warn');
  assert.ok(shown.message.startsWith(`${MEMBERSHIP_REFUSALS['no-split']} ${multi.REFUSAL_NEXT_STEPS['no-split']}`), shown.message);
  assert.deepEqual(state(first), before);
});

test('choose roster branch: two lead computers change the roster offline; the command lists both changes with the split sentence and the lead\'s choice resolves it', async () => {
  const { lead: first } = await pair('split');
  // The lead's second computer, brought in through the commands.
  const second = install('split-second');
  stub.quickPickAnswers.push('My other computer');
  stub.saveDialogAnswers.push(path.join(first.out, 'second'));
  await run(C.addMachine);
  const { request } = await joinBy(second, path.join(first.out, `second${INVITE_FILE_EXTENSION}`), 'Lee Lead');
  const welcome = path.join(first.out, `second${WELCOME_FILE_EXTENSION}`);
  await admitBy(first, request, multi.SIX_WORDS_MATCH, welcome);
  use(second);
  stub.openDialogAnswers.push([welcome]);
  await run(C.join);
  // Offline, each lead computer renames B on the same roster head.
  stub.quickPickAnswers.push('B. Example', 'Name');
  stub.inputAnswers.push('Nell Two');
  stub.messageAnswers.push('Change');
  await run(C.updateMember);
  assert.match(lastNotification().message, /^Nell Two was changed\./);
  const branchTwo = (await rosterOf(second)).positions.at(-1) as string;
  use(first);
  stub.quickPickAnswers.push('B. Example', 'Name');
  stub.inputAnswers.push('Nell One');
  stub.messageAnswers.push('Change');
  await run(C.updateMember);
  assert.match(lastNotification().message, /^Nell One was changed\./);
  // What a transport would carry: the second computer's roster entries and grants, into the lead's first computer.
  const from = await ReplicaProject.open(second.root, second.deps);
  const to = await ReplicaProject.open(first.root, first.deps);
  assert.ok(from instanceof ReplicaProject && to instanceof ReplicaProject);
  opened.push(from, to);
  const carried = await from.welcomeFor(to.deviceWriter, []);
  await to.ingestForeign([carried.genesis, ...carried.roster], carried.blobs);
  const grants = path.join(second.root, '.planning', 'staff', 'replica', 'grants');
  await to.putGrants(readdirSync(grants).flatMap((cell) => readdirSync(path.join(grants, cell)).map((name) => JSON.parse(readFileSync(path.join(grants, cell, name), 'utf8')) as unknown)));
  await from.close();
  await to.close();
  assert.equal((await rosterOf(first)).pending.length, 1, 'the roster is split');

  // Dismissed: the two changes are listed with the split sentence, and nothing is chosen. Changed for MN-03: each change used to be shown as a hash
  // prefix only; it is now opened and described (what it does, who wrote it, when), with the hash prefix kept at the end of the description.
  await run(C.chooseBranch);
  const listed = stub.quickPickRequests[stub.quickPickRequests.length - 1];
  assert.deepEqual(listed.items.map((item) => item.label), ['Change 1 of 2: Changes the details of B. Example', 'Change 2 of 2: Changes the details of B. Example']);
  for (const item of listed.items) assert.equal(item.detail, ROSTER_SPLIT_TEXT);
  for (const item of listed.items) assert.match(item.description ?? '', /^by mbr-lead, \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, entry [0-9a-f]{12}$/);
  const label = listed.items.find((item) => (item.description ?? '').endsWith(`entry ${branchTwo.slice(0, 12)}`))?.label;
  assert.ok(label, 'the second computer\'s change is listed');
  assert.equal((await rosterOf(first)).pending.length, 1);

  stub.quickPickAnswers.push(label);
  stub.messageAnswers.push('Use This Change');
  await run(C.chooseBranch);
  assert.ok((lastModal().detail ?? '').startsWith(`Changes the details of B. Example.\n\n${ROSTER_SPLIT_TEXT}`));
  assert.match(lastModal().message, /^Use change [12] of 2\?$/);
  hasNotices(lastModal().detail ?? '', 'the choose confirmation');
  assert.match(lastNotification().message, /^The roster branch was chosen\./);
  const roster = await rosterOf(first);
  assert.deepEqual(roster.pending, []);
  assert.equal([...roster.members.members.keys()].map((id) => memberAt(roster.members, id, headOf(roster))?.name).includes('Nell Two'), true);
});

test('name deputy lead: confirmed, the result names the deputy; a refusal from another computer is shown as a warning with the flow\'s sentence', async () => {
  const { lead: first, joiner } = await pair('deputy');
  stub.quickPickAnswers.push('B. Example');
  stub.messageAnswers.push('Name Deputy Lead');
  await run(C.nameDeputy);
  assert.equal(lastModal().message, 'Name B. Example deputy lead?');
  assert.match(lastNotification().message, /B\. Example is now the deputy lead\./);
  hasNotices(lastNotification().message, 'the result');
  // On the joiner's computer (not the lead's), the flow refuses and nothing is written.
  use(joiner);
  const before = state(joiner);
  stub.quickPickAnswers.push('B. Example');
  stub.messageAnswers.push('Name Deputy Lead');
  await run(C.nameDeputy);
  const refused = lastNotification();
  assert.equal(refused.level, 'warn');
  assert.ok(refused.message.startsWith(MEMBERSHIP_REFUSALS['not-a-roster-writer']), refused.message);
  hasNotices(refused.message, 'the refusal');
  assert.deepEqual(state(joiner).files, before.files);
});

test('hand over staff lead: asks planned or lead lost, confirms, and the result names the new lead', async () => {
  const { lead: first, member } = await pair('handover');
  stub.quickPickAnswers.push('B. Example', 'Planned handover');
  stub.messageAnswers.push('Hand Over');
  await run(C.handOver);
  assert.equal(lastModal().message, 'Hand the staff lead over to B. Example?');
  assert.match(lastModal().detail ?? '', /Reason recorded: Planned handover/);
  assert.match(lastNotification().message, /B\. Example is now the staff lead\./);
  const { leadAt } = await import('../domain/replica/roster');
  const roster = await rosterOf(first);
  assert.equal(leadAt(roster, headOf(roster)), member);
});

test('change a member\'s clearance: the confirmation carries the rekey sentence and the result is the flow\'s', async () => {
  const { lead: first, member } = await pair('change');
  stub.quickPickAnswers.push('B. Example', 'Clearance', 'Public');
  stub.messageAnswers.push('Change');
  await run(C.updateMember);
  assert.equal(lastModal().message, 'Change B. Example?');
  assert.ok((lastModal().detail ?? '').includes(REKEY_KEEP_TEXT));
  hasNotices(lastModal().detail ?? '', 'the change confirmation');
  assert.match(lastNotification().message, /^B\. Example was changed\./);
  const roster = await rosterOf(first);
  assert.deepEqual(memberAt(roster.members, member, headOf(roster))?.clearance, { scale: 'org', level: 'Public', compartments: [], releasability: [] });
  // Agent seats that are not slugs are refused before anything is written.
  const before = state(first);
  stub.quickPickAnswers.push('B. Example', 'Agent seats');
  stub.inputAnswers.push('Threat Analyst');
  await run(C.updateMember);
  assert.equal(lastNotification().message, `${multi.AGENT_SEATS_TEXT} ${NOTICES.join(' ')}`);
  assert.deepEqual(state(first), before);
});

test('make a single-machine copy: refuses a folder inside the shared project or with staff files before asking anyone, then copies and says what is not copied', async () => {
  const at = await staffProject('copy');
  stub.messageAnswers.push(multi.MAKE_MULTI_USER_ACTION);
  await run(C.makeMultiUser);
  assert.match(lastNotification().message, /now multi-user/);
  const inputs = stub.inputRequests.length;
  stub.openDialogAnswers.push([path.join(at.root, 'inside')]);
  await run(C.singleCopy);
  assert.ok(lastNotification().message.startsWith(COPY_REFUSALS['destination-inside-shared']), lastNotification().message);
  const occupied = path.join(at.base, 'occupied');
  mkdirSync(path.join(occupied, '.planning', 'staff'), { recursive: true });
  stub.openDialogAnswers.push([occupied]);
  await run(C.singleCopy);
  assert.ok(lastNotification().message.startsWith(COPY_REFUSALS['destination-has-staff-files']), lastNotification().message);
  assert.equal(stub.inputRequests.length, inputs, 'nobody was asked who they are');

  const destination = path.join(at.base, 'alone');
  mkdirSync(destination);
  const shared = tree(at.root);
  stub.openDialogAnswers.push([destination]);
  stub.inputAnswers.push('A. Demo', 'J-5 director');
  stub.messageAnswers.push('Make Copy');
  await run(C.singleCopy);
  assert.match(lastModal().detail ?? '', /A\. Person \(approved in the shared project, carried by A\. Demo\)/);
  hasNotices(lastModal().detail ?? '', 'the copy confirmation');
  const result = lastNotification();
  assert.equal(result.level, 'info', result.message);
  assert.ok(result.message.startsWith(`The single-machine copy is in ${destination}.`), result.message);
  assert.ok(result.message.includes(multi.NOT_COPIED_TEXT));
  hasNotices(result.message, 'the copy result');
  assert.ok(existsSync(path.join(destination, LEDGER_DIR, LEDGER_FILE)), 'the copy has a product ledger');
  assert.deepEqual(tree(at.root), shared, 'the shared project is untouched');
});

test('in a shared project, Set Aside, the decision commands and Decide a PIR refuse at once, with no dialog and no question', async () => {
  const first = await lead('setaside');
  const before = state(first);
  for (const id of [STAFF_COMMANDS.setAside, STAFF_COMMANDS.approve, STAFF_COMMANDS.withdraw, STAFF_COMMANDS.decidePir]) {
    const dialogs = stub.messageOptions.length;
    const questions = stub.inputRequests.length + stub.quickPickRequests.length;
    await run(id);
    assert.deepEqual(lastNotification(), { level: 'warn', message: SHARED_PROJECT_REFUSAL }, id);
    assert.equal(stub.messageOptions.length, dialogs, `${id}: no dialog`);
    assert.equal(stub.inputRequests.length + stub.quickPickRequests.length, questions, `${id}: no question`);
  }
  assert.deepEqual(state(first), before);
});

test('join: a file that is not an invitation is refused with the invitation reader\'s sentence; a folder with staff ledgers is refused', async () => {
  const joiner = install('join-refused');
  use(joiner);
  const junk = path.join(joiner.out, `junk${INVITE_FILE_EXTENSION}`);
  await writeFile(junk, '{"not":"an invitation"}');
  stub.openDialogAnswers.push([junk]);
  await run(C.join);
  assert.ok(lastNotification().message.startsWith(INVITE_REFUSALS.malformed), lastNotification().message);
  // A folder that already holds today's staff ledgers is not joined.
  const occupied = await staffProject('join-occupied');
  const first = await lead('join-occupied-lead');
  const invitation = await inviteBy(first, 'G. Example');
  use(occupied);
  const before = state(occupied);
  stub.openDialogAnswers.push([invitation]);
  stub.inputAnswers.push('G. Example');
  stub.saveDialogAnswers.push(path.join(occupied.out, 'join'));
  await run(C.join);
  assert.ok(lastNotification().message.startsWith(MEMBERSHIP_REFUSALS['folder-has-staff-project']), lastNotification().message);
  assert.deepEqual(state(occupied).files, before.files, 'nothing written in the folder or the out folder');
});

// ---- Task 3: every text plain, each refusal with a next step -----------------------------------------------------------------------------------------

test('every text a command can show has no em-dash, calls an organization only "your organization", and every refusal says what to do next', () => {
  const own = [
    multi.MULTI_USER_PREVIEW_OFF_TEXT, multi.MAKE_MULTI_USER_QUESTION, multi.NO_FOLDER_TEXT, multi.NOT_SHARED_TEXT, multi.WORDS_DIFFER_TEXT, multi.WORDS_NOT_CONFIRMED_TEXT,
    multi.INVITE_INSIDE_PROJECT_TEXT, multi.SEAT_TEXT, multi.AGENT_SEATS_TEXT, multi.NOT_COPIED_TEXT, multi.SIX_WORDS_MATCH, multi.SIX_WORDS_DIFFER, ...Object.values(multi.REFUSAL_NEXT_STEPS),
    multi.MAKE_WELCOME_AGAIN, multi.WELCOME_NOT_SAVED_TEXT, multi.FINISH_UNFINISHED_LABEL
  ];
  const refusals: Array<[string, string]> = [
    ...Object.entries(MEMBERSHIP_REFUSALS), ...Object.entries(MIGRATION_REFUSALS), ...Object.entries(COPY_REFUSALS), ...Object.entries(PROJECT_REFUSALS_HOST),
    ...Object.entries(INVITE_REFUSALS), ...Object.entries(ROSTER_REFUSALS), ...Object.entries(MEMBER_REFUSALS), ...Object.entries(CELL_REFUSALS)
  ];
  const shown = refusals.map(([reason, message]) => multi.shownRefusal(reason, message));
  for (const text of [...own, ...shown, ...NOTICES]) {
    assert.equal(text.includes(EM_DASH), false, text);
    assert.equal(/organi[sz]ation/i.test(text.replace(/your organization/gi, '').replace(/organizational control/gi, '')), false, text);
  }
  const NEXT = /\b(ask|use|choose|open|try|run|check|make|send|compare|put|look|admit|turn on|cancel|move|fix|copy|pick|hand|add|invite|close|set it aside|remove)\b/i;
  for (const text of shown) assert.match(text, NEXT, 'a refusal says what to do next');
  for (const text of [multi.NO_FOLDER_TEXT, multi.NOT_SHARED_TEXT, multi.WORDS_DIFFER_TEXT, multi.WORDS_NOT_CONFIRMED_TEXT, multi.INVITE_INSIDE_PROJECT_TEXT, multi.SEAT_TEXT, multi.AGENT_SEATS_TEXT, multi.MULTI_USER_PREVIEW_OFF_TEXT]) assert.match(text, NEXT, text);
  assert.deepEqual(NOTICES, [CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT, 'People and clearances in this project are declared by the staff lead, not verified.']);
  // None of the commands is a person decision the Staff Room may run (D-37).
  for (const id of Object.values(C)) assert.equal(PERSON_DECISION_COMMANDS.includes(id), false, id);
});
