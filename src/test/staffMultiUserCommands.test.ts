// The multi-user staff commands (plan 31-23; D-09, D-10, D-13 to D-18, D-23, D-28 to D-37): each command driven through the vscode stub on real
// installs (a project folder, extension storage and secret storage each), with the preview setting off and on. Off: one message and nothing written.
// On: Make This Staff Project Multi-User verifies, confirms and converts; invite, join, admit with the six words, welcome, remove, add a machine,
// choose a branch, deputy, handover, change a member and the single-machine copy each run their flow and show its sentence with the D-13 notices;
// admission happens only on "The six words match"; and every refusal says what happened and what to do next.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { appendFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test, { after, beforeEach, mock } from 'node:test';
import { CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT } from '../domain/gate/labels';
import { REKEY_KEEP_TEXT } from '../domain/replica/cellKeys';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, localInsert } from '../domain/replica/doc';
import { INVITE_FILE_EXTENSION, INVITE_REFUSALS, JOIN_REQUEST_FILE_EXTENSION, WELCOME_FILE_EXTENSION } from '../domain/replica/invite';
import { PREVIEW_WAY_FORWARD_TEXT, baseCellHeldProducts } from '../domain/replica/productCells';
import type { ProjectOutput } from '../domain/replica/projectFold';
import { ROSTER_REFUSALS, ROSTER_SPLIT_TEXT } from '../domain/replica/roster';
import { CELL_REFUSALS } from '../domain/replica/rosterCells';
import { MEMBER_REFUSALS, deviceAt, inviteAt, memberAt } from '../domain/replica/rosterMembers';
import { PERSON_DECISION_COMMANDS, STAFF_COMMANDS, STAFF_MULTI_USER_COMMANDS } from '../domain/staff/commands';
import { LEGACY_DIR, MULTI_USER_DECLARED_TEXT, REPLICA_PROJECT_FILE, SHARED_PROJECT_REFUSAL, multiUserNoticeLines } from '../domain/staff/multiUser';
import { canonicalBytes } from '../domain/team/canonical';
import { LABEL_CELL_REFUSALS, NOT_CLEARED_TEXT } from '../staff/replica/labelCells';
import { MEMBERSHIP_REFUSALS } from '../staff/replica/membership';
import { MIGRATION_REFUSALS } from '../staff/replica/migrate';
import { PROJECT_REFUSALS_HOST, ReplicaProject, isProjectRefused } from '../staff/replica/replicaProject';
import type { ReplicaProjectDeps } from '../staff/replica/replicaProject';
import { COPY_REFUSALS } from '../staff/replica/singleCopy';
import { START_AGAIN_COMMAND_TITLE, STORE_REFUSALS } from '../staff/replica/store';
import { LEDGER_DIR, LEDGER_FILE } from '../staff/staffHost';
import { setFolderSyncProbe } from '../staff/staffFiles';
import { MemorySecrets } from './helpers/teamHarness';
import { CLEAN_BODY, J5_TEAM, callTool, writeBody } from './helpers/staffFixtures';
import type { StaffWorld } from './helpers/staffFixtures';
import { createFakeContext, createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
const staffCommands = require('../services/staffCommands') as typeof import('../services/staffCommands');
const multi = require('../services/staffMultiUserCommands') as typeof import('../services/staffMultiUserCommands');
const hosts = require('../staff/staffHost') as typeof import('../staff/staffHost');
// The module object the commands load the flows from, so a test can replace one flow with node:test's mock.method.
const membershipModule = require('../staff/replica/membership') as typeof import('../staff/replica/membership');

const opened: ReplicaProject[] = [];
after(async () => {
  for (const project of opened) await project.close();
  for (const subscription of current?.context.subscriptions ?? []) subscription.dispose();
  hosts.configureStaffHosts(undefined);
  uninstall();
});

// Every test starts with no answer queued, so answers a failed test left unused are never taken by the next test's dialogs.
beforeEach(() => {
  for (const queue of [stub.quickPickAnswers, stub.openDialogAnswers, stub.saveDialogAnswers, stub.inputAnswers, stub.messageAnswers]) queue.length = 0;
});

const C = STAFF_MULTI_USER_COMMANDS;
const NOTICES = multiUserNoticeLines();
const EM_DASH = '\u2014';

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
      const parsed = JSON.parse(value) as { purpose?: unknown; payload?: unknown; signed?: { purpose?: unknown; payload?: unknown } };
      if (parsed.purpose === 'staff-replica-mark') return `mark ${JSON.stringify(parsed.payload)}`;
      // The mark since 31-REVIEW MJ-06 and the PR #130 review: { v, signed }, a compact signed payload committing by one hash to the lists file in the
      // store folder. That file is named by the hash of its bytes and is rewritten only when the lists change, so the file tree compares it as it is.
      return parsed.signed?.purpose === 'staff-replica-mark' ? `mark ${JSON.stringify(parsed.signed.payload)}` : value;
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

/**
 * A lead and two admitted people the lead declared with one name and one seat ('B. Example', j2-analyst), brought in through the commands. The two
 * member ids come back in the order the roster lists them, which is the order the pickers list them.
 */
async function twins(label: string): Promise<{ lead: Install; members: [string, string] }> {
  const first = await lead(`${label}-lead`);
  for (const which of ['one', 'two']) {
    const joiner = install(`${label}-${which}`);
    const invitation = await inviteBy(first, 'B. Example');
    const { request } = await joinBy(joiner, invitation, 'B. Example');
    const welcome = path.join(first.out, `welcome-${which}${WELCOME_FILE_EXTENSION}`);
    await admitBy(first, request, multi.SIX_WORDS_MATCH, welcome);
    use(joiner);
    stub.openDialogAnswers.push([welcome]);
    await run(C.join);
    assert.match(lastNotification().message, /You joined the shared staff project/);
  }
  const roster = await rosterOf(first);
  const named = [...roster.members.members.keys()].filter((id) => memberAt(roster.members, id, headOf(roster))?.name === 'B. Example');
  assert.equal(named.length, 2, 'two members share the declared name');
  use(first);
  return { lead: first, members: [named[0], named[1]] };
}

/**
 * D-12: a sentence a command shows is checked by its level and by the two or three phrases that carry its meaning, not word for word, so wording
 * can be polished without breaking a test that pins behaviour. A refusal is still compared with its constant exactly, where the test has one.
 */
function says(text: string, phrases: ReadonlyArray<string | RegExp>, what: string): void {
  for (const phrase of phrases) {
    if (typeof phrase === 'string') assert.ok(text.includes(phrase), `${what} says "${phrase}": ${text}`);
    else assert.match(text, phrase, what);
  }
}

// ---- a single-machine staff project ----------------------------------------------------------------------------------------------------------------

/**
 * A single-machine staff project made by today's host in this window (signed by this install's device), with one proposed product. Labelled
 * org/Public by default: Make Multi-User then asks no clearance, since with none declared only org/Public is covered (D-68). Another label makes
 * the command ask the lead to declare their own clearance first (D-19).
 */
async function staffProject(label: string, productLabel = 'org/Public'): Promise<Install> {
  const at = install(label);
  use(at);
  const host = hosts.staffHostFor(at.root);
  assert.ok(host);
  await writeBody(at.root, 'j5', 'concept-of-operations', CLEAN_BODY);
  const proposed = await callTool({ root: at.root, host } as StaffWorld, J5_TEAM, 'mcp__staff-products__propose', { product: 'concept-of-operations', kind: 'plan', label: productLabel }, 'lead-planner');
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
  const picks = stub.quickPickRequests.length;
  stub.messageAnswers.push(undefined);
  await run(C.makeMultiUser);
  // An all org/Public project is asked no clearance (D-19, D-68): its quick pick requests are unchanged.
  assert.equal(stub.quickPickRequests.length, picks, 'no clearance is asked for an all org/Public project');
  const dialog = lastModal();
  assert.equal(dialog.message, multi.MAKE_MULTI_USER_QUESTION);
  assert.equal((dialog.detail ?? '').includes('Each product goes into a part of the project for its label'), false, 'no labels line for an all org/Public project');
  assert.match(dialog.detail ?? '', /the product ledger: 1 entry, verified; the decision log: none yet; the calculator ledger: none yet; the wargame ledger: none yet/);
  assert.match(dialog.detail ?? '', /\.planning\/staff\/legacy\/ and never deleted/);
  assert.match(dialog.detail ?? '', /becomes shared/);
  hasNotices(dialog.detail ?? '', 'the confirmation');
  assert.deepEqual(state(at), before, 'dismissed: nothing written');

  stub.messageAnswers.push(multi.MAKE_MULTI_USER_ACTION);
  await run(C.makeMultiUser);
  assert.equal(stub.quickPickRequests.length, picks, 'confirming asks no clearance either');
  const result = lastNotification();
  assert.equal(result.level, 'info', result.message);
  says(result.message, ['now multi-user', 'you are its staff lead', 'One ledger was brought into the shared record'], 'the result');
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
  // Made shared in Phase 32, its products are in label cells: no way forward for a preview project is added (D-22 revised).
  assert.equal(lastNotification().message.includes(PREVIEW_WAY_FORWARD_TEXT), false, lastNotification().message);
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
  says(invited.message, ['Send the file to them', 'It works once', /expires on \d{4}-\d{2}-\d{2}/], 'the invitation result');
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
  assert.equal(admitted.level, 'info', admitted.message);
  says(admitted.message, ['B. Example was admitted', 'Send them the welcome file'], 'the admit result');
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

test('remove a member: the confirmation explains pending exposure and the result describes verified keys', async () => {
  const { lead: first, member } = await pair('remove');
  stub.quickPickAnswers.push('B. Example');
  stub.messageAnswers.push(undefined);
  const before = state(first);
  await run(C.remove);
  const dialog = lastModal();
  says(dialog.message, ['Remove B. Example', 'from the project?'], 'the remove question');
  assert.ok((dialog.detail ?? '').includes(REKEY_KEEP_TEXT));
  assert.ok((dialog.detail ?? '').includes('Until the affected parts have verified new keys, devices that held the old keys may still read new work encrypted with them.'));
  assert.doesNotMatch(dialog.detail ?? '', /nothing new|anything new|Every part .*moves/);
  hasNotices(dialog.detail ?? '', 'the remove confirmation');
  assert.deepEqual(state(first), before, 'dismissed: nothing written');
  const listed = stub.quickPickRequests[stub.quickPickRequests.length - 1].items.map((item) => item.label);
  assert.ok(listed.includes('B. Example') && listed.some((label) => label.startsWith('B. Example, device in slot')), `members and devices are offered: ${listed.join(' | ')}`);

  stub.quickPickAnswers.push('B. Example');
  stub.messageAnswers.push('Remove');
  await run(C.remove);
  const result = lastNotification();
  assert.equal(result.level, 'info', result.message);
  says(result.message, ['B. Example', 'removed from the project'], 'the remove result');
  assert.ok(result.message.includes(REKEY_KEEP_TEXT));
  assert.ok(result.message.includes('Devices excluded from the new keys cannot read work encrypted with those keys.'));
  assert.doesNotMatch(result.message, /anything new/);
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
  assert.equal(lastNotification().level, 'info', lastNotification().message);
  says(lastNotification().message, ['invitation was cancelled', 'Nobody can join with it'], 'the cancel result');
  let roster = await rosterOf(first);
  assert.equal(inviteAt(roster.members, invite, headOf(roster))?.state, 'voided');

  stub.quickPickAnswers.push('B. Example, device in slot 2');
  stub.messageAnswers.push('Remove Device');
  await run(C.remove);
  says(lastModal().message, ['Remove this device', 'B. Example'], 'the device question');
  assert.ok((lastModal().detail ?? '').includes(REKEY_KEEP_TEXT));
  assert.ok((lastModal().detail ?? '').includes('Until the affected parts have verified new keys, devices that held the old keys may still read new work encrypted with them.'));
  assert.doesNotMatch(lastModal().detail ?? '', /nothing new|anything new|every part .*moves/i);
  assert.equal(lastNotification().level, 'info', lastNotification().message);
  says(lastNotification().message, ['device of B. Example', 'removed from the project'], 'the device result');
  roster = await rosterOf(first);
  assert.ok(memberAt(roster.members, member, headOf(roster)), 'the member stays');
});

test('D-04: two members with the same declared name are listed by Remove with their member ids, and picking the second removes the second', async () => {
  const { lead: first, members: [one, two] } = await twins('remove-twins');
  stub.quickPickAnswers.push(undefined);
  await run(C.remove);
  const listed = stub.quickPickRequests[stub.quickPickRequests.length - 1].items.map((item) => item.label);
  assert.ok(listed.includes(`B. Example (${one})`) && listed.includes(`B. Example (${two})`), `each is listed with their member id: ${listed.join(' | ')}`);
  assert.equal(listed.includes('B. Example'), false, 'a repeated name is never listed bare');
  for (const id of [one, two]) assert.ok(listed.some((label) => label.startsWith(`B. Example (${id}), device in slot`)), `the device of ${id} names the member id: ${listed.join(' | ')}`);
  assert.equal(new Set(listed).size, listed.length, 'every item is distinct');

  stub.quickPickAnswers.push(`B. Example (${two})`);
  stub.messageAnswers.push('Remove');
  await run(C.remove);
  says(lastModal().message, [`B. Example (${two})`], 'the remove confirmation names the member id of a repeated name');
  const result = lastNotification();
  assert.equal(result.level, 'info', result.message);
  says(result.message, ['B. Example', 'removed from the project'], 'the remove result');
  const roster = await rosterOf(first);
  assert.equal(memberAt(roster.members, two, headOf(roster)), undefined, 'the member picked is removed');
  assert.ok(memberAt(roster.members, one, headOf(roster)), 'the other member of the same name stays');
});

test('D-04: Add My Other Machine with two members of the same declared name and seat offers two distinct items, and the invitation is for the member picked', async () => {
  const { lead: first, members: [one, two] } = await twins('machine-twins');
  stub.quickPickAnswers.push(`Another computer of B. Example (${two})`);
  stub.saveDialogAnswers.push(path.join(first.out, 'twin-second'));
  await run(C.addMachine);
  const listed = stub.quickPickRequests[stub.quickPickRequests.length - 1].items.map((item) => `${item.label} / ${item.description ?? ''}`);
  assert.equal(new Set(listed).size, listed.length, `every item is distinct: ${listed.join(' | ')}`);
  assert.ok(listed.some((item) => item.startsWith(`Another computer of B. Example (${one})`)), listed.join(' | '));
  assert.equal(lastNotification().level, 'info', lastNotification().message);
  assert.ok(existsSync(path.join(first.out, `twin-second${INVITE_FILE_EXTENSION}`)));
  const roster = await rosterOf(first);
  const forMembers = [...roster.members.invites.values()].map((record) => record.forMember).filter((value) => value !== undefined);
  assert.deepEqual(forMembers, [two], 'the invitation is for the member picked');
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
  says(asked.message, ['welcome file for B. Example', 'again?'], 'the make-again question');
  hasNotices(asked.detail ?? '', 'the make-again question');
  assert.equal(lastNotification().level, 'info', lastNotification().message);
  says(lastNotification().message, ['welcome file for B. Example', 'made again'], 'the make-again result');
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
  says(lastModal().message, ['Finish', 'left unfinished?'], 'the finish question');
  assert.ok((lastModal().detail ?? '').includes(REKEY_KEEP_TEXT));
  assert.ok((lastModal().detail ?? '').includes('Until the affected parts have verified new keys, devices that held the old keys may still read new work encrypted with them.'));
  assert.doesNotMatch(lastModal().detail ?? '', /nothing new|anything new|every part .*moves/i);
  const result = lastNotification();
  assert.equal(result.level, 'info', result.message);
  says(result.message, ['left unfinished is now finished', 'One part of the project', 'moved to a new key'], 'the finish result');
  assert.ok(result.message.includes('Devices excluded from the new keys cannot read work encrypted with those keys.'));
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
  assert.equal(lastNotification().level, 'info', lastNotification().message);
  says(lastNotification().message, [/invitation for .*'s other computer/, 'is ready'], 'the add-machine result');
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
  says(lastNotification().message, ['Nell Two', 'was changed'], 'the change result');
  const branchTwo = (await rosterOf(second)).positions.at(-1) as string;
  use(first);
  stub.quickPickAnswers.push('B. Example', 'Name');
  stub.inputAnswers.push('Nell One');
  stub.messageAnswers.push('Change');
  await run(C.updateMember);
  says(lastNotification().message, ['Nell One', 'was changed'], 'the change result');
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
  says(lastModal().message, [/Use change [12] of 2/], 'the choose question');
  hasNotices(lastModal().detail ?? '', 'the choose confirmation');
  assert.equal(lastNotification().level, 'info', lastNotification().message);
  says(lastNotification().message, ['roster branch was chosen'], 'the choose result');
  const roster = await rosterOf(first);
  assert.deepEqual(roster.pending, []);
  assert.equal([...roster.members.members.keys()].map((id) => memberAt(roster.members, id, headOf(roster))?.name).includes('Nell Two'), true);
});

test('name deputy lead: confirmed, the result names the deputy; a refusal from another computer is shown as a warning with the flow\'s sentence', async () => {
  const { lead: first, joiner } = await pair('deputy');
  stub.quickPickAnswers.push('B. Example');
  stub.messageAnswers.push('Name Deputy Lead');
  await run(C.nameDeputy);
  says(lastModal().message, ['Name B. Example', 'deputy lead?'], 'the deputy question');
  assert.equal(lastNotification().level, 'info', lastNotification().message);
  says(lastNotification().message, ['B. Example', 'is now the deputy lead'], 'the deputy result');
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
  says(lastModal().message, ['Hand the staff lead over', 'B. Example'], 'the handover question');
  assert.match(lastModal().detail ?? '', /Reason recorded: Planned handover/);
  assert.equal(lastNotification().level, 'info', lastNotification().message);
  says(lastNotification().message, ['B. Example', 'is now the staff lead'], 'the handover result');
  const { leadAt } = await import('../domain/replica/roster');
  const roster = await rosterOf(first);
  assert.equal(leadAt(roster, headOf(roster)), member);
});

test('change a member\'s clearance: the confirmation carries the rekey sentence and the result is the flow\'s', async () => {
  const { lead: first, member } = await pair('change');
  stub.quickPickAnswers.push('B. Example', 'Clearance', 'Public');
  stub.messageAnswers.push('Change');
  await run(C.updateMember);
  says(lastModal().message, ['Change B. Example'], 'the change question');
  assert.ok((lastModal().detail ?? '').includes(REKEY_KEEP_TEXT));
  assert.ok((lastModal().detail ?? '').includes('Until the affected parts have verified new keys, devices that held the old keys may still read new work encrypted with them.'));
  assert.doesNotMatch(lastModal().detail ?? '', /nothing new|anything new|every part .*moves/i);
  hasNotices(lastModal().detail ?? '', 'the change confirmation');
  assert.equal(lastNotification().level, 'info', lastNotification().message);
  says(lastNotification().message, ['B. Example', 'was changed'], 'the change result');
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
  // D-09: the staff host of the shared project forgets the project it opened, so it never keeps one whose store was replaced.
  const host = hosts.staffHostFor(at.root);
  assert.ok(host);
  const invalidated = mock.method(host, 'invalidateShared');
  try {
    await run(C.singleCopy);
  } finally {
    invalidated.mock.restore();
  }
  assert.equal(invalidated.mock.callCount(), 1, 'the copy invalidates the staff host\'s shared project once');
  assert.match(lastModal().detail ?? '', /A\. Person \(approved in the shared project, carried by A\. Demo\)/);
  hasNotices(lastModal().detail ?? '', 'the copy confirmation');
  const result = lastNotification();
  assert.equal(result.level, 'info', result.message);
  assert.ok(result.message.startsWith(`The single-machine copy is in ${destination}.`), result.message);
  assert.ok(result.message.includes(multi.NOT_COPIED_TEXT));
  // Made shared in Phase 32: the copy says nothing about sharing it again (D-22 revised).
  assert.equal(result.message.includes(multi.COPY_SHARE_AGAIN_TEXT), false, result.message);
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
    multi.MAKE_WELCOME_AGAIN, multi.WELCOME_NOT_SAVED_TEXT, multi.FINISH_UNFINISHED_LABEL, multi.JOIN_NO_FILE_TEXT,
    multi.LEAD_CLEARANCE_TITLE, multi.COPY_SHARE_AGAIN_TEXT, PREVIEW_WAY_FORWARD_TEXT
  ];
  const refusals: Array<[string, string]> = [
    ...Object.entries(MEMBERSHIP_REFUSALS), ...Object.entries(MIGRATION_REFUSALS), ...Object.entries(COPY_REFUSALS), ...Object.entries(PROJECT_REFUSALS_HOST),
    ...Object.entries(INVITE_REFUSALS), ...Object.entries(ROSTER_REFUSALS), ...Object.entries(MEMBER_REFUSALS), ...Object.entries(CELL_REFUSALS),
    ...Object.entries(LABEL_CELL_REFUSALS), ['already-shared', `${MIGRATION_REFUSALS['already-shared']} ${PREVIEW_WAY_FORWARD_TEXT}`]
  ];
  const shown = refusals.map(([reason, message]) => multi.shownRefusal(reason, message));
  for (const text of [...own, ...shown, ...NOTICES]) {
    assert.equal(text.includes(EM_DASH), false, text);
    assert.equal(/organi[sz]ation/i.test(text.replace(/your organization/gi, '').replace(/organizational control/gi, '')), false, text);
  }
  const NEXT = /\b(ask|use|choose|open|try|run|check|make|send|compare|put|look|admit|turn on|cancel|move|fix|copy|pick|hand|add|invite|close|set it aside|remove)\b/i;
  for (const text of shown) assert.match(text, NEXT, 'a refusal says what to do next');
  // The way forward for a preview project and the copy's last sentence carry their own next step (D-22 revised).
  for (const text of [PREVIEW_WAY_FORWARD_TEXT, multi.COPY_SHARE_AGAIN_TEXT]) assert.match(text, NEXT, text);
  for (const text of [multi.JOIN_NO_FILE_TEXT, multi.NO_FOLDER_TEXT, multi.NOT_SHARED_TEXT, multi.WORDS_DIFFER_TEXT, multi.WORDS_NOT_CONFIRMED_TEXT, multi.INVITE_INSIDE_PROJECT_TEXT, multi.SEAT_TEXT, multi.AGENT_SEATS_TEXT, multi.MULTI_USER_PREVIEW_OFF_TEXT]) assert.match(text, NEXT, text);
  assert.deepEqual(NOTICES, [CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT, 'People and clearances in this project are declared by the staff lead, not verified.']);
  // None of the commands is a person decision the Staff Room may run (D-37).
  for (const id of Object.values(C)) assert.equal(PERSON_DECISION_COMMANDS.includes(id), false, id);
});

// ---- Start This Computer's Shared History Again (31-REVIEW MJ-08) ------------------------------------------------------------------------------

test('start this computer\'s shared history again: a project that opens is left alone; a rolled-back one names the command; dismissing changes nothing; confirming sets it aside and says how to get the history back', async () => {
  const first = await lead('start-again');
  await inviteBy(first, 'F. Example');
  use(first);
  const untouched = state(first);
  await run(C.startHistoryAgain);
  assert.deepEqual(lastNotification(), { level: 'info', message: `${STORE_REFUSALS['not-needed']} ${NOTICES.join(' ')}` });
  assert.deepEqual(state(first), untouched, 'a project that opens is not set aside');
  // The lead's base cell file loses its last line (the invitation): the store is refused rolled back, and every command says how to start again.
  const project = (JSON.parse(readFileSync(path.join(first.root, ...REPLICA_PROJECT_FILE.split('/')), 'utf8')) as { anchor: { project: string } }).anchor.project;
  const streamDir = path.join(first.root, '.planning', 'staff', 'replica', 'streams', project);
  const [ownFile] = readdirSync(streamDir);
  const lines = readFileSync(path.join(streamDir, ownFile), 'utf8').split('\n');
  assert.equal(lines.length, 4, 'the genesis, its roster.require (Phase 33 D-08) and the invitation');
  await writeFile(path.join(streamDir, ownFile), `${lines[0]}\n`);
  await run(C.invite);
  assert.equal(lastNotification().level, 'warn');
  assert.ok(lastNotification().message.includes(START_AGAIN_COMMAND_TITLE), lastNotification().message);
  const before = state(first);
  stub.messageAnswers.push(undefined);
  await run(C.startHistoryAgain);
  const dialog = lastModal();
  assert.equal(dialog.message, multi.START_AGAIN_QUESTION);
  assert.match(dialog.detail ?? '', /older than what this device has already seen/);
  assert.match(dialog.detail ?? '', /nothing is deleted/);
  assert.ok((dialog.detail ?? '').includes(multi.START_AGAIN_HOW_BACK_TEXT));
  hasNotices(dialog.detail ?? '', 'the Start Again dialog');
  assert.deepEqual(state(first), before, 'dismissing the dialog changes nothing');
  stub.messageAnswers.push(multi.START_AGAIN_ACTION);
  await run(C.startHistoryAgain);
  const result = lastNotification();
  assert.equal(result.level, 'info');
  const aside = /set aside in (\.planning\/staff\/replica\.set-aside-\d{8}-\d{6})\//.exec(result.message)?.[1];
  assert.ok(aside, result.message);
  says(result.message, ['nothing was deleted', 'One change this computer made was carried'], 'the Start Again result');
  assert.ok(result.message.includes(multi.START_AGAIN_HOW_BACK_TEXT));
  hasNotices(result.message, 'the Start Again result');
  assert.equal(readFileSync(path.join(first.root, aside, 'streams', project, ownFile), 'utf8'), `${lines[0]}\n`, 'the old folder is kept as it was');
  // The project opens again on this computer, and the command now leaves it alone.
  assert.deepEqual((await rosterOf(first)).positions.length, 2);
  await run(C.startHistoryAgain);
  assert.deepEqual(lastNotification(), { level: 'info', message: `${STORE_REFUSALS['not-needed']} ${NOTICES.join(' ')}` });
});

test('start this computer\'s shared history again in a folder with no shared project says so and makes nothing; its texts are plain', async () => {
  const at = install('start-again-none');
  use(at);
  const before = state(at);
  await run(C.startHistoryAgain);
  assert.deepEqual(lastNotification(), { level: 'warn', message: `${multi.NOT_SHARED_TEXT} ${NOTICES.join(' ')}` });
  assert.deepEqual(state(at), before);
  for (const text of [multi.START_AGAIN_QUESTION, multi.START_AGAIN_ACTION, multi.START_AGAIN_HOW_BACK_TEXT, STORE_REFUSALS['not-needed'], STORE_REFUSALS['rolled-back'], STORE_REFUSALS.damaged, STORE_REFUSALS['mark-unverified']]) {
    assert.equal(text.includes(EM_DASH), false, text);
    assert.equal(/organi[sz]ation/i.test(text), false, text);
  }
});

test('an invitation whose file could not be saved is saved again from Remove on the computer that made it, writing nothing, and the joiner joins with it', async () => {
  const first = await lead('reinvite-lead');
  // The save place does not exist: the roster records the invitation, but its file is not saved, and the lead is told how to save it again.
  use(first);
  stub.inputAnswers.push('B. Example', 'j2-analyst');
  stub.quickPickAnswers.push(['member', 'answers_for:j2'], 'Internal');
  stub.saveDialogAnswers.push(path.join(first.out, 'missing', 'invitation'));
  await run(C.invite);
  const unsaved = lastNotification();
  assert.equal(unsaved.level, 'warn');
  assert.ok(unsaved.message.includes(multi.INVITE_NOT_SAVED_TEXT), unsaved.message);
  const before = state(first);
  // Remove lists the invitation to save again; picking it saves the file and changes nothing in the project.
  const again = path.join(first.out, 'invitation-again');
  stub.quickPickAnswers.push(`${multi.INVITE_SAVE_AGAIN_PREFIX}B. Example again`);
  stub.saveDialogAnswers.push(again);
  await run(C.remove);
  assert.equal(lastNotification().level, 'info', lastNotification().message);
  says(lastNotification().message, ['invitation for B. Example is ready again', 'Nothing was changed in the project'], 'the save-again result');
  const file = `${again}${INVITE_FILE_EXTENSION}`;
  assert.ok(existsSync(file));
  const after = state(first);
  const projectFiles = (files: Record<string, string>): Array<[string, string]> => Object.entries(files).filter(([name]) => name.startsWith(`project${path.sep}`)).sort();
  assert.deepEqual(projectFiles(after.files), projectFiles(before.files), 'nothing in the project changed');
  assert.deepEqual(after.secrets, before.secrets, 'no secret changed');
  // The saved invitation works: the joiner answers it and both screens show the same six words.
  const joiner = install('reinvite-joiner');
  const { request, words } = await joinBy(joiner, file, 'B. Example');
  assert.equal(words.length, 6);
  await admitBy(first, request, multi.SIX_WORDS_MATCH, path.join(first.out, 'welcome'));
  assert.match(lastNotification().message, /B\. Example/);
  // Once used, the invitation is no longer offered to save again.
  use(first);
  stub.quickPickAnswers.push(undefined);
  await run(C.remove);
  const listed = stub.quickPickRequests[stub.quickPickRequests.length - 1].items;
  assert.equal(listed.some((item) => item.label.startsWith(multi.INVITE_SAVE_AGAIN_PREFIX)), false, listed.map((item) => item.label).join(' | '));
});

test('remakeInvite refuses a used, cancelled, expired or unknown invitation, and one whose secret this computer does not hold, writing nothing', async () => {
  const first = await lead('reinvite-refusals');
  const { inviteToProject, remakeInvite, voidInvite, reissuableInvites } = await import('../staff/replica/membership');
  const opened1 = await ReplicaProject.open(first.root, first.deps);
  assert.ok(opened1 instanceof ReplicaProject);
  opened.push(opened1);
  const shared = { project: opened1, deps: first.deps };
  const clearance = { scale: 'org', level: 'Internal', compartments: [], releasability: [] };
  const a = await inviteToProject(shared, { name: 'A. Example', seat: 'j2-analyst', clearance });
  const b = await inviteToProject(shared, { name: 'C. Example', seat: 'j2-analyst', clearance });
  assert.ok(a.ok && b.ok);
  assert.deepEqual((await reissuableInvites(shared)).map((item) => item.name).sort(), ['A. Example', 'C. Example']);
  const remade = await remakeInvite(shared, a.invite as string);
  assert.ok(remade.ok, remade.message);
  assert.equal(remade.file?.name, a.file?.name, 'the same invitation id');
  assert.equal((await remakeInvite(shared, 'inv-000000000000')).reason, 'unknown-invite');
  assert.ok((await voidInvite(shared, b.invite as string)).ok);
  assert.equal((await remakeInvite(shared, b.invite as string)).reason, 'invite-voided');
  // Without the stored secret (another computer, or the secret was forgotten), it cannot be remade.
  for (const key of [...first.secrets.values.keys()].filter((name) => name.endsWith(a.invite as string))) first.secrets.values.delete(key);
  const lost = await remakeInvite(shared, a.invite as string);
  assert.equal(lost.reason, 'invite-not-remade');
  assert.equal(lost.message.includes(EM_DASH), false);
  assert.deepEqual(await reissuableInvites(shared), []);
  // Expired: a clock past the expiry.
  const c = await inviteToProject(shared, { name: 'D. Example', seat: 'j2-analyst', clearance, days: 1 });
  assert.ok(c.ok);
  const later = { project: opened1, deps: { ...first.deps, now: () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) } };
  assert.equal((await remakeInvite(later, c.invite as string)).reason, 'invite-expired');
});

test('a secret file is created 0600 from the start, replaces a file chosen in the dialog, and on any failure leaves no copy of the secret behind', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-secret-save-'));
  const secret = `secret-${'x'.repeat(40)}`;
  // A new file: owner read and write only.
  const fresh = path.join(dir, 'invitation.near-staff-invite');
  await multi.saveSecretFile(fresh, secret);
  assert.equal(readFileSync(fresh, 'utf8'), secret);
  assert.equal(statSync(fresh).mode & 0o777, 0o600);
  // An existing world-readable file chosen in the dialog is replaced by a 0600 file, never rewritten in place with its old mode.
  const existing = path.join(dir, 'existing.near-staff-invite');
  await writeFile(existing, 'old', { mode: 0o644 });
  await multi.saveSecretFile(existing, secret);
  assert.equal(readFileSync(existing, 'utf8'), secret);
  assert.equal(statSync(existing).mode & 0o777, 0o600);
  // A failure after the new file exists (the target is a folder, so the rename fails): the error is reported and no file holds the secret.
  const folder = path.join(dir, 'a-folder');
  mkdirSync(folder);
  const before = readdirSync(dir).sort();
  await assert.rejects(() => multi.saveSecretFile(folder, secret));
  assert.deepEqual(readdirSync(dir).sort(), before, 'the unfinished copy was removed');
  assert.deepEqual(readdirSync(folder), []);
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isFile()) assert.equal(readFileSync(file, 'utf8').includes(secret) && name !== 'invitation.near-staff-invite' && name !== 'existing.near-staff-invite', false, name);
  }
  // A failure before anything is created (the folder does not exist) leaves nothing either.
  await assert.rejects(() => multi.saveSecretFile(path.join(dir, 'missing', 'invitation'), secret));
  assert.deepEqual(readdirSync(dir).sort(), before);
});

test('a join request that could not be saved says running Join again is safe, and it is: the rerun keeps one invitation record, makes a new request with new words, and that request is admitted', async () => {
  const first = await lead('join-unsaved-lead');
  const invitation = await inviteBy(first, 'J. Example');
  const joiner = install('join-unsaved');
  use(joiner);
  // The first save fails: the place chosen does not exist.
  stub.openDialogAnswers.push([invitation]);
  stub.inputAnswers.push('J. Example');
  stub.saveDialogAnswers.push(path.join(joiner.out, 'missing', 'join'));
  await run(C.join);
  const unsaved = lastNotification();
  assert.equal(unsaved.level, 'warn');
  assert.ok(unsaved.message.includes(multi.JOIN_NOT_SAVED_TEXT), unsaved.message);
  assert.deepEqual(readdirSync(joiner.out), [], 'no join request was saved anywhere');
  const project = (JSON.parse(readFileSync(invitation, 'utf8')) as { payload: { project: string } }).payload.project;
  const { pendingInvitationsDir } = await import('../staff/replica/membership');
  const pendingDir = (): string[] => readdirSync(pendingInvitationsDir(joiner.storage, project)).sort();
  const keptBefore = pendingDir();
  assert.equal(keptBefore.length, 1, 'the invitation is kept once');
  assert.equal(existsSync(path.join(joiner.root, REPLICA_PROJECT_FILE)), false, 'the project folder was not changed');
  // The rerun is safe: the same invitation record, a new request, and the lead admits it.
  const { request, words } = await joinBy(joiner, invitation, 'J. Example');
  assert.deepEqual(pendingDir(), keptBefore, 'still one invitation record');
  assert.equal(words.length, 6);
  await admitBy(first, request, multi.SIX_WORDS_MATCH, path.join(first.out, 'welcome-j'));
  assert.match(lastNotification().message, /J\. Example/);
  assert.equal(multi.JOIN_NOT_SAVED_TEXT.includes(EM_DASH), false);
});

test('D-05: Join refuses a flow result that is ok but carries no file: it says so, saves nothing at the chosen place and shows no six words', async () => {
  const first = await lead('join-no-file-lead');
  const invitation = await inviteBy(first, 'K. Example');
  const joiner = install('join-no-file');
  use(joiner);
  const target = path.join(joiner.out, 'join-empty');
  stub.openDialogAnswers.push([invitation]);
  stub.inputAnswers.push('K. Example');
  stub.saveDialogAnswers.push(target);
  const dialogs = stub.messageOptions.length;
  const joined = mock.method(membershipModule, 'joinFromInvite', async () => ({ ok: true, message: 'Your join request is ready.', notices: [] }));
  try {
    await run(C.join);
  } finally {
    joined.mock.restore();
  }
  assert.equal(joined.mock.callCount(), 1, 'the flow ran');
  const shown = lastNotification();
  assert.equal(shown.level, 'warn', shown.message);
  assert.ok(shown.message.startsWith(multi.JOIN_NO_FILE_TEXT), shown.message);
  assert.equal(multi.JOIN_NO_FILE_TEXT, 'The join request was not made. Nothing was saved. Run Join Staff Project again.');
  hasNotices(shown.message, 'the refusal');
  assert.equal(existsSync(`${target}${JOIN_REQUEST_FILE_EXTENSION}`), false, 'nothing is written at the chosen place');
  assert.deepEqual(readdirSync(joiner.out), [], 'nothing is written in the folder chosen either');
  assert.equal(stub.messageOptions.slice(dialogs).some((entry) => entry.message.startsWith('Read these six words')), false, 'no six-word dialog');
});

test('D-06: saveSecretFile syncs the target\'s folder after the rename, when the target holds the text and no temporary copy is left beside it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-secret-sync-'));
  const target = path.join(dir, `invitation${INVITE_FILE_EXTENSION}`);
  const secret = `secret-${'y'.repeat(40)}`;
  const seen: Array<{ dir: string; text: string | undefined; others: string[] }> = [];
  setFolderSyncProbe((synced) => {
    seen.push({ dir: synced, text: existsSync(target) ? readFileSync(target, 'utf8') : undefined, others: readdirSync(dir).filter((name) => name !== path.basename(target)) });
  });
  try {
    await multi.saveSecretFile(target, secret);
  } finally {
    setFolderSyncProbe(undefined);
  }
  const synced = seen.filter((item) => item.dir === dir);
  assert.equal(synced.length, 1, `the target's folder is synced once: ${JSON.stringify(seen.map((item) => item.dir))}`);
  assert.equal(synced[0].text, secret, 'the folder is synced after the rename, with the secret in place');
  assert.deepEqual(synced[0].others, [], 'no temporary copy is left beside it when the folder is synced');
  assert.equal(readFileSync(target, 'utf8'), secret);
});

test('D-03: Start Again reaches a project whose shared history folder is gone but was set aside before, says nothing was set aside and which folder it carried from, and the host forgets its project', async () => {
  const first = await lead('start-again-gone');
  await inviteBy(first, 'F. Example');
  use(first);
  // A first Start Again, as in the test above: the lead's base cell file loses its last line, so the store is refused rolled back.
  const project = (JSON.parse(readFileSync(path.join(first.root, ...REPLICA_PROJECT_FILE.split('/')), 'utf8')) as { anchor: { project: string } }).anchor.project;
  const streamDir = path.join(first.root, '.planning', 'staff', 'replica', 'streams', project);
  const [ownFile] = readdirSync(streamDir);
  const lines = readFileSync(path.join(streamDir, ownFile), 'utf8').split('\n');
  await writeFile(path.join(streamDir, ownFile), `${lines[0]}\n`);
  stub.messageAnswers.push(multi.START_AGAIN_ACTION);
  await run(C.startHistoryAgain);
  const aside = /set aside in (\.planning\/staff\/replica\.set-aside-\d{8}-\d{6}(?:-\d+)?)\//.exec(lastNotification().message)?.[1];
  assert.ok(aside, lastNotification().message);
  // Then the shared history folder on this computer is lost, project.json with it (moved out of the project, as a lost folder would be).
  await rename(path.join(first.root, '.planning', 'staff', 'replica'), path.join(first.base, 'lost-replica'));
  const dialogs = stub.messageOptions.length;
  stub.messageAnswers.push(undefined);
  await run(C.startHistoryAgain);
  assert.equal(stub.messageOptions.length, dialogs + 1, `the command reaches the dialog instead of saying the folder holds no shared project: ${lastNotification().message}`);
  const dialog = lastModal();
  assert.equal(dialog.message, multi.START_AGAIN_QUESTION);
  says(dialog.detail ?? '', ['is moved aside', 'when it is there', 'nothing is deleted'], 'the Start Again dialog');
  const host = hosts.staffHostFor(first.root);
  assert.ok(host);
  const invalidated = mock.method(host, 'invalidateShared');
  stub.messageAnswers.push(multi.START_AGAIN_ACTION);
  try {
    await run(C.startHistoryAgain);
  } finally {
    invalidated.mock.restore();
  }
  const result = lastNotification();
  assert.equal(result.level, 'info', result.message);
  says(result.message, ['Nothing was set aside', 'shared history folder was not there', 'Nothing was deleted', `The new one was made from ${aside}/.`, multi.START_AGAIN_HOW_BACK_TEXT], 'the Start Again result');
  assert.equal(/set aside in /.test(result.message), false, result.message);
  hasNotices(result.message, 'the Start Again result');
  assert.equal(invalidated.mock.callCount(), 1, 'Start Again invalidates the staff host\'s shared project once (D-09)');
  assert.ok(existsSync(path.join(first.root, ...REPLICA_PROJECT_FILE.split('/'))), 'the project record is back');
  assert.ok((await rosterOf(first)).positions.length > 0, 'the project opens again');
});

// ---- 32-12: the lead's own clearance (D-19), the copy's notices (D-23) and the way forward for preview projects (D-22 revised) ---------------------

const INTERNAL = { scale: 'org', level: 'Internal', compartments: [], releasability: [] };

/** The clearance the roster at its head holds for the project's lead. */
async function leadClearanceOf(at: Install): Promise<unknown> {
  const roster = await rosterOf(at);
  return memberAt(roster.members, roster.anchor.lead.member, headOf(roster))?.clearance;
}

test('declare for yourself: Make Multi-User on a project with an org/Internal product asks the clearance you declare for yourself before any dialog; cancelling writes nothing and asks nothing more', async () => {
  const at = await staffProject('clear-cancel', 'org/Internal');
  const before = state(at);
  const picks = stub.quickPickRequests.length;
  const dialogs = stub.messageOptions.length;
  const shown = stub.notifications.length;
  stub.quickPickAnswers.push(undefined);
  await run(C.makeMultiUser);
  assert.equal(stub.quickPickRequests.length, picks + 1, 'one quick pick');
  const asked = stub.quickPickRequests[stub.quickPickRequests.length - 1];
  assert.equal(asked.title, multi.LEAD_CLEARANCE_TITLE);
  assert.equal(multi.LEAD_CLEARANCE_TITLE, 'The clearance you declare for yourself');
  assert.match(asked.placeHolder ?? '', /self-declared, not verified/);
  assert.ok(asked.items.some((item) => item.label === 'Internal'), 'the org levels are offered');
  assert.equal(stub.messageOptions.length, dialogs, 'no confirmation was shown');
  assert.equal(stub.notifications.length, shown, 'nothing more was said');
  assert.deepEqual(state(at), before, 'cancelled: nothing written');
});

test('declare for yourself org/Public on a project with an org/Internal product: refused with the D-19 sentence naming the label and the product, before any confirmation; nothing written', async () => {
  const at = await staffProject('clear-low', 'org/Internal');
  const before = state(at);
  const dialogs = stub.messageOptions.length;
  const picks = stub.quickPickRequests.length;
  stub.quickPickAnswers.push('Public');
  await run(C.makeMultiUser);
  assert.equal(stub.quickPickRequests.length, picks + 1, 'the clearance was asked');
  assert.equal(stub.quickPickRequests[stub.quickPickRequests.length - 1].title, multi.LEAD_CLEARANCE_TITLE);
  const shown = lastNotification();
  assert.equal(shown.level, 'warn', shown.message);
  assert.ok(shown.message.startsWith(MIGRATION_REFUSALS['not-cleared-for-label']), shown.message);
  says(shown.message, [NOT_CLEARED_TEXT('org/Internal'), 'Products with that label: concept-of-operations.'], 'the refusal');
  hasNotices(shown.message, 'the refusal');
  assert.equal(stub.messageOptions.length, dialogs, 'no confirmation was asked for');
  assert.deepEqual(state(at), before, 'refused: nothing written');
});

test('declare for yourself org/Internal: the confirmation names the labels the parts get and the declared level; confirming converts, names the lead, and the roster holds that clearance for the lead', async () => {
  const at = await staffProject('clear-ok', 'org/Internal');
  const before = state(at);
  stub.quickPickAnswers.push('Internal');
  stub.messageAnswers.push(undefined);
  await run(C.makeMultiUser);
  const dialog = lastModal();
  assert.equal(dialog.message, multi.MAKE_MULTI_USER_QUESTION);
  assert.ok((dialog.detail ?? '').includes('Each product goes into a part of the project for its label: org/Internal. Only people whose declared clearance covers a label receive that part. You declare yourself cleared for Internal.'), dialog.detail);
  hasNotices(dialog.detail ?? '', 'the confirmation');
  assert.deepEqual(state(at), before, 'dismissed: nothing written');

  stub.quickPickAnswers.push('Internal');
  stub.messageAnswers.push(multi.MAKE_MULTI_USER_ACTION);
  await run(C.makeMultiUser);
  const result = lastNotification();
  assert.equal(result.level, 'info', result.message);
  says(result.message, ['now multi-user', 'you are its staff lead'], 'the result');
  hasNotices(result.message, 'the result');
  assert.deepEqual(await leadClearanceOf(at), INTERNAL, 'the roster at its head holds the declared clearance for the lead');
});

test('conversion shows the names of products whose ledger lines and versions were left behind', async () => {
  const at = await staffProject('withheld-notices', 'org/Internal');
  const host = hosts.staffHostFor(at.root);
  assert.ok(host);
  await writeBody(at.root, 'j5', 'public-annex', CLEAN_BODY);
  const proposed = await callTool({ root: at.root, host } as StaffWorld, J5_TEAM, 'mcp__staff-products__propose', {
    product: 'public-annex', kind: 'annex', label: 'org/Public', dependsOn: ['concept-of-operations@1']
  }, 'lead-planner');
  assert.ok(proposed.ok, proposed.text);
  stub.quickPickAnswers.push('Internal');
  stub.messageAnswers.push(multi.MAKE_MULTI_USER_ACTION);
  await run(C.makeMultiUser);
  const result = lastNotification();
  assert.equal(result.level, 'info', result.message);
  says(result.message, [
    'now multi-user',
    'Some history for public-annex was left out',
    'Ask someone cleared for org/Public to make a single-machine copy and share it again.',
    'public-annex was brought in without its versions'
  ], 'the conversion notice');
});

test('copy notices: Make a Single-Machine Copy shows every notice the copy returns beyond the three every screen shows, each once', async () => {
  const at = await staffProject('copy-notices', 'org/Internal');
  stub.quickPickAnswers.push('Internal');
  stub.messageAnswers.push(multi.MAKE_MULTI_USER_ACTION);
  await run(C.makeMultiUser);
  assert.match(lastNotification().message, /now multi-user/);
  const copyModule = require('../staff/replica/singleCopy') as typeof import('../staff/replica/singleCopy');
  // The notices a direct copy of the same project returns, made into another folder.
  const elsewhere = path.join(at.base, 'direct');
  mkdirSync(elsewhere);
  const direct = await copyModule.makeSingleMachineCopy(at.root, elsewhere, { ...at.deps, copier: { name: 'A. Demo', role: 'J-5 director' } });
  assert.ok(direct.ok, direct.ok ? '' : direct.message);
  const extra = direct.notices.filter((line) => !NOTICES.includes(line));

  const copyThrough = async (folder: string): Promise<string> => {
    mkdirSync(folder);
    stub.openDialogAnswers.push([folder]);
    stub.inputAnswers.push('A. Demo', 'J-5 director');
    stub.messageAnswers.push('Make Copy');
    await run(C.singleCopy);
    const shown = lastNotification();
    assert.equal(shown.level, 'info', shown.message);
    return shown.message;
  };
  const count = (text: string, line: string): number => text.split(line).length - 1;
  const shown = await copyThrough(path.join(at.base, 'alone'));
  for (const line of extra) assert.equal(count(shown, line), 1, `the copy result shows once: ${line}`);
  hasNotices(shown, 'the copy result');
  assert.equal(shown.includes(multi.COPY_SHARE_AGAIN_TEXT), false, 'made shared in Phase 32: no way to share it again is added');

  // A notice beyond the three, as the copy gives for parts this computer is not cleared for (32-11): shown once, after what the copy did not carry.
  const NOTE = 'Parts of this exercise were left out for this test.';
  const real = copyModule.makeSingleMachineCopy;
  const spied = mock.method(copyModule, 'makeSingleMachineCopy', async (...args: Parameters<typeof real>) => {
    const made = await real(...args);
    return made.ok ? { ...made, notices: [...made.notices, NOTE] } : made;
  });
  let noted: string;
  try {
    noted = await copyThrough(path.join(at.base, 'alone-noted'));
  } finally {
    spied.mock.restore();
  }
  assert.equal(spied.mock.callCount(), 1);
  assert.equal(count(noted, NOTE), 1, noted);
  assert.ok(noted.indexOf(NOTE) > noted.indexOf(multi.NOT_COPIED_TEXT), 'the extra notice follows what the copy did not carry');
  for (const line of NOTICES) assert.equal(count(noted, line), 1, `the three notices are shown once each: ${line}`);
});

/**
 * A lead's shared project as a 0.4.35 conversion left it: the concept of operations written into the base stream (product.create, doc.client and
 * doc.update through appendOwn with no stream), and project.json carrying a complete migration marker.
 */
async function previewProject(label: string): Promise<Install> {
  const at = await lead(label);
  const project = await ReplicaProject.open(at.root, at.deps);
  assert.ok(project instanceof ReplicaProject, 'the shared project opens');
  opened.push(project);
  try {
    const { roster } = await project.state();
    const slot = deviceAt(roster.members, project.deviceWriter, headOf(roster))?.slot ?? 1;
    const clientId = clientIdOf(slot, 0);
    const write = async (kind: string, data: Record<string, unknown>): Promise<void> => {
      const written = await project.appendOwn(kind, data, { actor: { kind: 'person' } });
      assert.ok(!isProjectRefused(written), `${kind}: ${isProjectRefused(written) ? written.message : ''}`);
    };
    await write('product.create', { product: 'concept-of-operations', section: 'j5', roles: { owner: 'lead-planner', sectionLead: 'j5-chief', releaseGuard: 'release-guard' }, title: 'concept-of-operations' });
    await write('doc.client', { product: 'concept-of-operations', clientId, actor: { kind: 'person' } });
    await write('doc.update', { product: 'concept-of-operations', update: Buffer.from(localInsert(createLocalDoc(clientId), 0, CLEAN_BODY)).toString('base64url') });
    assert.equal(baseCellHeldProducts((await project.state()).fold, project.projectId), true, 'the fixture holds a product in the base cell');
  } finally {
    await project.close();
  }
  const file = path.join(at.root, ...REPLICA_PROJECT_FILE.split('/'));
  const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, `${JSON.stringify({ ...record, migration: { complete: true, at: '2026-11-01T00:00:00.000Z', imports: 1 } }, null, 2)}\n`);
  use(at);
  return at;
}

test('preview: Make Multi-User in a project shared under 0.4.35 adds the way forward to its already-shared refusal; its single-machine copy ends with how to share the copy again', async () => {
  const at = await previewProject('preview');
  const before = state(at);
  const dialogs = stub.messageOptions.length;
  await run(C.makeMultiUser);
  const refused = lastNotification();
  assert.equal(refused.level, 'warn', refused.message);
  assert.ok(refused.message.startsWith(`${MIGRATION_REFUSALS['already-shared']} ${PREVIEW_WAY_FORWARD_TEXT}`), refused.message);
  assert.equal(refused.message.split(PREVIEW_WAY_FORWARD_TEXT).length - 1, 1, 'the way forward is said once');
  hasNotices(refused.message, 'the refusal');
  assert.equal(stub.messageOptions.length, dialogs, 'no dialog');
  assert.deepEqual(state(at), before, 'nothing written');

  const destination = path.join(at.base, 'alone');
  mkdirSync(destination);
  stub.openDialogAnswers.push([destination]);
  stub.inputAnswers.push('A. Demo', 'J-5 director');
  stub.messageAnswers.push('Make Copy');
  await run(C.singleCopy);
  const copied = lastNotification();
  assert.equal(copied.level, 'info', copied.message);
  assert.ok(copied.message.startsWith(`The single-machine copy is in ${destination}.`), copied.message);
  assert.ok(copied.message.endsWith(`${multi.COPY_SHARE_AGAIN_TEXT} ${NOTICES.join(' ')}`), `the copy ends with how to share it again, then the notices: ${copied.message}`);
  assert.equal(multi.COPY_SHARE_AGAIN_TEXT, 'To share it again with each product in its own part, open the copy\'s folder and run Staff: Make This Staff Project Multi-User.');
});

test('preview: a project made shared in Phase 32 gets neither the way forward nor the copy\'s share-again sentence, even with a labelled product', async () => {
  const at = await staffProject('preview-not', 'org/Internal');
  stub.quickPickAnswers.push('Internal');
  stub.messageAnswers.push(multi.MAKE_MULTI_USER_ACTION);
  await run(C.makeMultiUser);
  assert.match(lastNotification().message, /now multi-user/);
  await run(C.makeMultiUser);
  const refused = lastNotification();
  assert.ok(refused.message.startsWith(MIGRATION_REFUSALS['already-shared']), refused.message);
  assert.equal(refused.message.includes(PREVIEW_WAY_FORWARD_TEXT), false, refused.message);
  const destination = path.join(at.base, 'alone');
  mkdirSync(destination);
  stub.openDialogAnswers.push([destination]);
  stub.inputAnswers.push('A. Demo', 'J-5 director');
  stub.messageAnswers.push('Make Copy');
  await run(C.singleCopy);
  const copied = lastNotification();
  assert.equal(copied.level, 'info', copied.message);
  assert.equal(copied.message.includes(multi.COPY_SHARE_AGAIN_TEXT), false, copied.message);
});

// ---- 33-27 Task 3: one live engine in the Sterling image (D-64) ----------------------------------------------------------------------------------

test('D-64: in the Sterling image (STERLING_WORKBENCH=1) no preview command is registered, and calling one finds nothing to run', async () => {
  const at = await staffProject('sterling-image');
  const before = state(at);
  const previous = process.env.STERLING_WORKBENCH;
  process.env.STERLING_WORKBENCH = '1';
  try {
    use(at);
    for (const id of Object.values(C)) assert.equal(stub.commands.get(id), undefined, `${id} is not registered in the image`);
    // The other staff commands are still the extension's own; only the multi-user preview stands back.
    assert.ok(stub.commands.size > 0, 'the extension still registers its other staff commands');
    assert.equal(multi.inSterlingWorkbench(), true);
  } finally {
    if (previous === undefined) delete process.env.STERLING_WORKBENCH;
    else process.env.STERLING_WORKBENCH = previous;
    use(at);
  }
  assert.deepEqual(state(at), before, 'nothing was written');
});

test('D-64: outside the image every preview command is registered as before, and only the exact value 1 means the image', () => {
  assert.equal(multi.inSterlingWorkbench({}), false);
  assert.equal(multi.inSterlingWorkbench({ STERLING_WORKBENCH: '0' }), false);
  assert.equal(multi.inSterlingWorkbench({ STERLING_WORKBENCH: 'true' }), false);
  assert.equal(multi.inSterlingWorkbench({ STERLING_WORKBENCH: '1' }), true);
  const at = install('outside-image');
  use(at);
  for (const id of Object.values(C)) assert.ok(stub.commands.get(id), `${id} is registered outside the image`);
});
