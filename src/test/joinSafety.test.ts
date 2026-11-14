// Phase 27, plan 31 (SYNC-04, SYNC-05): joining a synced project from a computer that already has chats of its own never loses a message. A join waits for
// runs, holds the project's sync lock from the copy to the catch-up, carries a line another editor wrote in between, leaves other editors on the joined key,
// keeps every conversation it could not carry, and removes the folder from before the join only when everything in it is in the joined state.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { RunMarkers } from '../services/runMarkers';
import { stateHomeFor } from '../services/stateHome';
import { discardPreviousState, recoverInterruptedAdoption } from '../services/stateRestore';
import type { GitRunner } from '../services/stateGit';
import { archiveThread } from '../services/threadArchive';
import { buildStateSync, enterCodeFlow, turnOnFlow, type SyncEnv } from '../services/syncFlows';
import { bareRemote, computer, fakeUi, type Computer } from './helpers/flowFixtures';
import { hermeticRunner } from './helpers/gitFixtures';
import { SIX_TURNS, chain, treeHash } from './helpers/syncFixtures';
import { tempProject } from './helpers/stateFixtures';

const RUNNING = 'A chat is running in this project, in this editor or another one. Enter the recovery code again when it has finished. Nothing was changed.';
const KEPT_TWO = '2 conversations on this computer could not be added to the online project, because they could not be opened here. They are kept beside this project\'s saved state, and nothing was deleted.';

async function thread(c: Computer, id: string, title: string): Promise<string[]> {
  await c.threads.create({ id, title, model: 'near/model-a', origin: 'panel' });
  const entries = chain(id, c.parts.writer, SIX_TURNS);
  await c.threads.appendEntries(id, entries);
  return entries.map((entry) => entry.id).sort();
}

async function ids(c: Computer, id: string): Promise<string[]> {
  return (await c.threads.entries(id)).map((entry) => entry.id).sort();
}

/** An online project on one computer (alpha, with one thread) and a second computer with chats of its own, ready to enter the code. */
async function setup(extra: { git?: GitRunner } = {}): Promise<{ remote: string; a: Computer; b: Computer; code: string }> {
  const remote = bareRemote({ withMain: false });
  const a = computer(remote, 'alpha');
  await thread(a, 'conv-online-1', 'Online one');
  const turnOn = fakeUi();
  assert.equal((await turnOnFlow({ env: a.env, ui: turnOn.ui })).status, 'on');
  const b = computer(remote, 'bravo', extra.git ? { git: extra.git } : {});
  return { remote, a, b, code: turnOn.shown[0] as string };
}

function previousFolders(c: Computer): Promise<string[]> {
  return readdir(path.dirname(c.home.dir)).then((names) => names.filter((name) => name.startsWith('state.previous-')).sort());
}

/** Another editor's run marker in this project's state folder, live right now. */
async function otherEditorRuns(c: Computer): Promise<RunMarkers> {
  const markers = new RunMarkers('', c.root, { dir: c.home.paths.runs, writer: 'edaaaaaa.inst0001', pid: 4242, alive: () => true });
  await markers.start({ conversationId: 'conv-live00-0a0b0c0d', runId: 'run-1793570629237-876b3a', model: 'near/model-a' });
  await markers.idle();
  markers.dispose();
  return markers;
}

function ownRuns(c: Computer): RunMarkers {
  return new RunMarkers('', c.root, { dir: c.home.paths.runs, writer: c.parts.writer });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Task 1: runs, the lock, late writes, other editors ----------------------------------------------------------------------------------

test('tracer: a join is refused while a chat runs in another editor, and changes nothing; once it has finished the join works', async () => {
  const { a, b, code } = await setup();
  const own = await thread(b, 'conv-local-1', 'Local one');
  const runs = ownRuns(b);
  (b.env as SyncEnv).runsLive = async () => (await runs.liveRuns()).length > 0;
  const other = await otherEditorRuns(b);
  const before = treeHash(b.home.dir);
  const asked = { code: 0 };
  const ui = fakeUi({ code });
  const original = ui.ui.askCode;
  ui.ui.askCode = async () => { asked.code += 1; return original(); };
  const refused = await enterCodeFlow({ env: b.env, ui: ui.ui });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.message, RUNNING);
  assert.ok(ui.messages.includes(RUNNING));
  assert.equal(asked.code, 0, 'the person was not asked for the code');
  assert.equal(ui.confirms.length, 0);
  assert.equal(treeHash(b.home.dir), before, 'the state folder is byte-identical');

  // The same when it is this editor's own run, as the editor counts them.
  (b.env as SyncEnv).runsLive = async () => true;
  assert.equal((await enterCodeFlow({ env: b.env, ui: fakeUi({ code }).ui })).status, 'refused');
  assert.equal(treeHash(b.home.dir), before);

  // The run ends: the join goes through.
  await other.end('conv-live00-0a0b0c0d', 'run-1793570629237-876b3a', 'completed');
  (b.env as SyncEnv).runsLive = async () => false;
  assert.equal((await enterCodeFlow({ env: b.env, ui: fakeUi({ code }).ui })).status, 'restored');
  assert.deepEqual(await ids(b, 'conv-local-1'), own);
  assert.equal((await b.home.readMeta())?.stateId, (await a.home.readMeta())?.stateId);
});

test('a run that starts after the question was answered stops the join before anything is copied', async () => {
  const { b, code } = await setup();
  await thread(b, 'conv-local-1', 'Local one');
  const before = treeHash(b.home.dir);
  let looks = 0;
  (b.env as SyncEnv).runsLive = async () => { looks += 1; return looks > 1; };
  const result = await enterCodeFlow({ env: b.env, ui: fakeUi({ code }).ui });
  assert.equal(result.status, 'refused');
  assert.equal(result.message, RUNNING);
  assert.ok(looks >= 2, 'looked again under the lock');
  assert.equal(treeHash(b.home.dir), before);
  assert.deepEqual(await previousFolders(b), []);
});

test('the join holds the project\'s sync lock from the copy to the catch-up: a sync started in between waits for the swap', async () => {
  const { remote, b, code } = await setup();
  await thread(b, 'conv-local-1', 'Local one');
  const ownStateId = (await b.home.readMeta())?.stateId;
  let reached!: () => void;
  const atBuilt = new Promise<void>((resolve) => { reached = resolve; });
  let proceed!: () => void;
  const held = new Promise<void>((resolve) => { proceed = resolve; });
  const flow = enterCodeFlow({
    env: b.env, ui: fakeUi({ code }).ui,
    adopt: { hook: async (at) => { if (at === 'built') { reached(); await held; } } }
  });
  await atBuilt;
  // Another sync of the same project, started from outside the join, as another editor's scheduler would.
  const other = buildStateSync(computer(remote, 'other', { root: b.root }).parts, { remote: 'origin' });
  let settled = false;
  const late = other.sync().then((outcome) => { settled = true; return outcome; });
  await sleep(300);
  assert.equal(settled, false, 'the other sync is still waiting while the join holds the lock');
  assert.equal((await b.home.readMeta())?.stateId, ownStateId, 'the swap has not happened yet');
  proceed();
  assert.equal((await flow).status, 'restored');
  const outcome = await late;
  assert.ok(['synced', 'waiting', 'nothing-yet'].includes(outcome.kind), `the other sync ran after the join (${outcome.kind})`);
});

test('a line another editor writes between the copy and the swap is in the joined state afterwards, once', async () => {
  const { remote, a, b, code } = await setup();
  const own = await thread(b, 'conv-local-1', 'Local one');
  const b2 = computer(remote, 'bravo2', { root: b.root });
  assert.deepEqual(await ids(b2, 'conv-local-1'), own, 'the second editor reads the thread with the old key');
  const late = chain('conv-local-1', b2.parts.writer, [['user', 'a line written during the join'], ['assistant', 'and its answer']], (await b2.threads.entries('conv-local-1')).at(-1)?.id ?? null);
  const result = await enterCodeFlow({
    env: b.env, ui: fakeUi({ code }).ui,
    adopt: { hook: async (at) => { if (at === 'built') await b2.threads.appendEntries('conv-local-1', late); } }
  });
  assert.equal(result.status, 'restored');
  const expected = [...own, ...late.map((entry) => entry.id)].sort();
  assert.deepEqual(await ids(b, 'conv-local-1'), expected, 'every line, the late ones once');
  assert.equal((await b.threads.entries('conv-local-1')).length, expected.length);
  assert.equal((await b.home.readMeta())?.stateId, (await a.home.readMeta())?.stateId);
  assert.deepEqual(await previousFolders(b), [], 'nothing was left behind: everything was carried');
});

test('after a join, another editor that had the old key cached reads every thread and its next line is readable by the first editor', async () => {
  const { remote, b, code } = await setup();
  const own = await thread(b, 'conv-local-1', 'Local one');
  await thread(b, 'conv-local-2', 'Local two');
  const b2 = computer(remote, 'bravo2', { root: b.root });
  // The second editor has read and written with the old key, so its caches are warm.
  assert.deepEqual(await ids(b2, 'conv-local-1'), own);
  assert.equal((await b2.threads.index()).length, 2);
  const next = chain('conv-local-1', b2.parts.writer, [['user', 'before the join']], (await b2.threads.entries('conv-local-1')).at(-1)?.id ?? null);
  await b2.threads.appendEntries('conv-local-1', next);
  const caches = (b2.threads as unknown as { caches: Map<string, unknown> }).caches;
  const warm = caches.get('conv-local-1');
  assert.ok(warm, 'the second editor holds what it knows of the log');

  assert.equal((await enterCodeFlow({ env: b.env, ui: fakeUi({ code }).ui })).status, 'restored');

  const listed = await b2.threads.index();
  assert.deepEqual(listed.map((item) => item.id).sort(), ['conv-local-1', 'conv-local-2', 'conv-online-1']);
  assert.equal(listed.some((item) => item.locked), false, 'the second editor sees no locked thread');
  assert.notEqual(caches.get('conv-local-1'), warm, 'what it knew of the old log was dropped when the state id changed');
  const all = [...own, ...next.map((entry) => entry.id)].sort();
  assert.deepEqual(await ids(b2, 'conv-local-1'), all, 'the second editor reads every line of the thread in full');
  const after = chain('conv-local-1', b2.parts.writer, [['assistant', 'sealed under the joined key']], (await b2.threads.entries('conv-local-1')).at(-1)?.id ?? null);
  await b2.threads.appendEntries('conv-local-1', after);
  assert.deepEqual(await ids(b, 'conv-local-1'), [...all, ...after.map((entry) => entry.id)].sort(), 'the first editor reads the second one\'s next line');
  assert.equal((await b.threads.index()).some((item) => item.locked), false);
});

// ---- Task 2: keep what could not be carried; remove a folder only when everything in it is carried ------------------------------------------

test('a join keeps the conversations it could not carry, says how many, and the folder from before the join stays after the first sync', async () => {
  const { b, code } = await setup();
  const own = {
    'conv-local-1': await thread(b, 'conv-local-1', 'Local one'),
    'conv-local-2': await thread(b, 'conv-local-2', 'Local two'),
    'conv-local-3': await thread(b, 'conv-local-3', 'Local three')
  };
  // One whose log and meta are damaged, so it cannot be read.
  await thread(b, 'conv-damaged-1', 'Damaged');
  await writeFile(path.join(b.home.paths.threads, 'conv-damaged-1', 'log.jsonl'), 'not a sealed line\n');
  await writeFile(path.join(b.home.paths.threads, 'conv-damaged-1', 'meta.enc'), 'not sealed');
  // One archived thread kept only online: listed, with nothing of it on this computer.
  await thread(b, 'conv-online-kept', 'Kept online');
  assert.equal(await archiveThread(b.threads, 'conv-online-kept'), true);
  await rm(path.join(b.home.paths.archive, 'conv-online-kept'), { recursive: true, force: true });
  const index = await b.threads.index();
  const damaged = await b.threads.liveSnapshot('conv-damaged-1').catch(() => undefined);
  assert.ok(!damaged || damaged.entries.length === 0, 'the damaged thread cannot be read');
  assert.equal(index.find((item) => item.id === 'conv-online-kept')?.location, 'remote', 'the other one is kept only online');

  const ui = fakeUi({ code });
  const result = await enterCodeFlow({ env: b.env, ui: ui.ui });
  assert.equal(result.status, 'restored');
  assert.ok(result.message.includes(KEPT_TWO), result.message);
  assert.ok(ui.messages.some((message) => message.includes(KEPT_TWO)));
  const listed = (await b.threads.index()).map((item) => item.id).sort();
  assert.deepEqual(listed, ['conv-local-1', 'conv-local-2', 'conv-local-3', 'conv-online-1']);
  for (const [id, expected] of Object.entries(own)) assert.deepEqual(await ids(b, id), expected);

  const kept = await previousFolders(b);
  assert.equal(kept.length, 1, 'the folder from before the join was kept');
  const folder = path.join(path.dirname(b.home.dir), kept[0] as string);
  assert.ok((await stat(path.join(folder, 'threads', 'conv-damaged-1'))).isDirectory(), 'with the damaged thread in it');
  // Removing is a rule, not a moment: a later call keeps it too.
  await discardPreviousState(b.root, b.threads);
  assert.deepEqual(await previousFolders(b), kept);
});

test('a join whose first sync does not finish ends pending and keeps the folder; the first later sync that works removes it', async () => {
  let pushFails = false;
  const inner = hermeticRunner();
  const flaky: GitRunner = async (args, options) => (pushFails && args.includes('push') ? { code: 1, stdout: Buffer.alloc(0), stderr: 'remote unreachable' } : inner(args, options));
  const { b, code } = await setup({ git: flaky });
  const own = await thread(b, 'conv-local-1', 'Local one');
  pushFails = true;
  const result = await enterCodeFlow({ env: b.env, ui: fakeUi({ code }).ui });
  assert.equal(result.status, 'pending');
  const kept = await previousFolders(b);
  assert.equal(kept.length, 1, 'the folder is kept');
  assert.match(kept[0] as string, /^state\.previous-\d{8}T\d{9}Z-[0-9a-f]{8}$/, 'named with the time first');

  pushFails = false;
  const outcome = await buildStateSync(b.parts, { remote: 'origin' }).sync();
  assert.equal(outcome.kind, 'synced');
  await discardPreviousState(b.root, b.threads);
  assert.deepEqual(await previousFolders(b), [], 'every conversation in it is in the joined state, so it goes');
  assert.deepEqual(await ids(b, 'conv-local-1'), own);
});

test('discardPreviousState never removes a folder that names a thread the current state does not hold', async () => {
  const { b, code } = await setup();
  await thread(b, 'conv-local-1', 'Local one');
  assert.equal((await enterCodeFlow({ env: b.env, ui: fakeUi({ code }).ui })).status, 'restored');
  const parent = path.dirname(b.home.dir);
  const makeKept = async (name: string, parts: string[]): Promise<string> => {
    const dir = path.join(parent, name);
    for (const part of parts) await mkdir(path.join(dir, part), { recursive: true });
    return dir;
  };
  const complete = await makeKept('state.previous-20200101T000000000Z-aaaaaaaa', ['threads/conv-local-1', 'archive/conv-online-1']);
  const missingThread = await makeKept('state.previous-20200102T000000000Z-bbbbbbbb', ['threads/conv-local-1', 'threads/conv-ghost-000001']);
  const missingArchive = await makeKept('state.previous-20200103T000000000Z-cccccccc', ['archive/conv-ghost-000002']);
  await discardPreviousState(b.root, b.threads);
  assert.equal(await stat(complete).then(() => true, () => false), false, 'a folder whose conversations are all here is removed');
  assert.equal(await stat(missingThread).then(() => true, () => false), true, 'a thread folder the state lacks keeps it');
  assert.equal(await stat(missingArchive).then(() => true, () => false), true, 'so does an archive folder');
  // Without the thread store, the folders on disk stand for what the state holds, with the same result.
  await discardPreviousState(b.root);
  assert.equal(await stat(missingThread).then(() => true, () => false), true);
  assert.equal(await stat(missingArchive).then(() => true, () => false), true);
});

test('recovery after a cut-off join puts back the newest folder by the time in its name, and by modification time for older names', async () => {
  const root = await tempProject();
  try {
    const home = stateHomeFor(root);
    const parent = path.dirname(home.dir);
    await mkdir(parent, { recursive: true });
    // An older name format sorts after the new one by name ('c' after '2'), but is older by modification time.
    const older = path.join(parent, 'state.previous-cut');
    const newer = path.join(parent, 'state.previous-20261114T101010101Z-abcd1234');
    const earlier = path.join(parent, 'state.previous-20261113T090909090Z-ffffffff');
    for (const dir of [older, newer, earlier]) { await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'mark.txt'), path.basename(dir)); }
    const long = new Date('2020-01-01T00:00:00Z');
    await utimes(older, long, long);
    await recoverInterruptedAdoption(root);
    assert.equal((await stat(path.join(home.dir, 'mark.txt'))).isFile(), true);
    assert.equal(await readFile(path.join(home.dir, 'mark.txt'), 'utf8'), 'state.previous-20261114T101010101Z-abcd1234', 'the later one by name came back');
    assert.deepEqual((await readdir(parent)).sort(), ['state', 'state.previous-20261113T090909090Z-ffffffff', 'state.previous-cut']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
