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
import { ROSTER_REFUSALS } from '../domain/replica/roster';
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
