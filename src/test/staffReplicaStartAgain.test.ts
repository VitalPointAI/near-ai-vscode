// Start Again is resumable and never starts empty (32-01, 32-CONTEXT D-03 and the Start Again part of D-06). A child process is killed with SIGKILL
// after each step of Start Again; the next open finishes the job. A store folder that is gone is carried from what was set aside beside it, and the
// project never reads as unshared in between.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { GENESIS_PREV, buildEntry, sha256Hex } from '../domain/replica/entry';
import type { BuiltEntry } from '../domain/replica/entry';
import { ORIGIN_ROSTER } from '../domain/replica/roster';
import { REPLICA_DIR, REPLICA_PROJECT_FILE, SHARED_PROJECT_REFUSAL } from '../domain/staff/multiUser';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { signPayload } from '../domain/team/signedPayload';
import { joinSecretHash, newJoinSecret } from '../domain/replica/invite';
import { sharedProjectRefusal } from '../staff/logisticsHost';
import { markKey } from '../staff/replica/marks';
import { ReplicaProject, isProjectRefused } from '../staff/replica/replicaProject';
import type { ProjectRefused, ReplicaProjectDeps } from '../staff/replica/replicaProject';
import {
  ReplicaStore, START_AGAIN_COMMAND_TITLE, START_AGAIN_INTENT_FILE, START_AGAIN_REFUSALS, START_AGAIN_STEPS, STORE_REFUSALS, setStartAgainProbe
} from '../staff/replica/store';
import type { ForeignCheck, ReplicaStoreDeps, StartAgainStep, StoreRefused } from '../staff/replica/store';
import { setFolderSyncProbe, syncFolder } from '../staff/staffFiles';
import { CRASH_CHILD_NOW } from './helpers/startAgainCrashChild';
import type { CrashChildMessage } from './helpers/startAgainCrashChild';
import { FileSecrets } from './helpers/replicaStoreChild';
import { DEMO_CLEARANCE, INVITE_EXPIRES } from './helpers/replicaRosterWorld';
import { epochKey, fixedSigner, streamId } from './helpers/replicaWorld';
import type { FixedSigner } from './helpers/replicaWorld';

const ACTIVE: KeyStatusLookup = () => ({ state: 'active' });
const STREAM = streamId('start-again/products');
const ROSTER = 'a'.repeat(64);
const AT = '2026-11-19T11:00:00.000Z';
const STAMP = '20261120-100000';
const SET_ASIDE = `replica.set-aside-${STAMP}`;
const PROJECT_TEXT = '{"v":1,"anchor":"as written by the project host"}\n';
const PASS: ForeignCheck = () => Promise.resolve({ ok: true });

function tempDir(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `near-ai-start-again-${label}-`));
}

function depsFor(device: FixedSigner, secretsFile: string): ReplicaStoreDeps {
  return { secrets: new FileSecrets(secretsFile), signer: () => Promise.resolve(device.signer), keyStatus: () => Promise.resolve(ACTIVE), now: () => new Date(CRASH_CHILD_NOW) };
}

/** `count` chained entries for one writer, starting after `from` or at genesis. */
function chain(device: FixedSigner, count: number, options: { from?: { seq: number; hash: string }; big?: boolean } = {}): BuiltEntry[] {
  const out: BuiltEntry[] = [];
  let seq = options.from ? options.from.seq + 1 : 0;
  let prev = options.from?.hash ?? GENESIS_PREV;
  for (let index = 0; index < count; index += 1) {
    const data = options.big ? { text: 'x'.repeat(20_000) } : { n: seq };
    const built = buildEntry({ signer: device.signer, key: epochKey('store'), stream: STREAM, seq, prev, epoch: 0, body: { deps: [], roster: ROSTER, lamport: seq, at: AT, actor: { kind: 'person' }, kind: 'doc.update', data } });
    out.push(built);
    prev = built.hash;
    seq += 1;
  }
  return out;
}

async function opened(root: string, deps: ReplicaStoreDeps): Promise<ReplicaStore> {
  const store = await ReplicaStore.open(root, deps);
  assert.ok(store instanceof ReplicaStore, `the store opens (${(store as StoreRefused).refused})`);
  return store;
}

function refusalOf(reason: StoreRefused['refused']): StoreRefused {
  return { refused: reason, message: STORE_REFUSALS[reason] };
}

function listTree(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(`${relative}/`, ...listTree(full, relative)); else out.push(relative);
  }
  return out;
}

/** Every file under a folder by relative path with the hash of its bytes, leaving out the lock file. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of listTree(dir)) {
    if (item.endsWith('/') || item === 'replica.lock') continue;
    out[item] = sha256Hex(readFileSync(path.join(dir, item)));
  }
  return out;
}

/** The names in .planning/staff, leaving out lock files (a lock a killed process left is taken over at once). */
function staffNames(root: string): string[] {
  return readdirSync(path.join(root, '.planning', 'staff')).filter((name) => !name.includes('.lock')).sort();
}

interface Seed {
  root: string;
  staff: string;
  dir: string;
  intent: string;
  secretsFile: string;
  lead: FixedSigner;
  deps: ReplicaStoreDeps;
  own: BuiltEntry[];
  grantHash: string;
  /** The store's files, as it was when Start Again began. */
  before: Record<string, string>;
}

/**
 * A store with three own entries (the first with a blob), two of a colleague, one grant and project.json; then an older copy of the colleague's file
 * comes back, so the store is refused rolled-back. Secret storage is a file, so a child process sees the same mark.
 */
async function seeded(): Promise<Seed> {
  const root = tempDir('project');
  const secretsFile = path.join(tempDir('secrets'), 'secrets.json');
  const lead = fixedSigner('lead');
  const deps = depsFor(lead, secretsFile);
  const store = await opened(root, deps);
  const [first] = chain(lead, 1, { big: true });
  assert.equal(first.blobs.length, 1);
  const own = [first, ...chain(lead, 2, { from: { seq: 0, hash: first.hash } })];
  assert.deepEqual(await store.appendOwn(own), { ok: true, written: 3 });
  const colleague = fixedSigner('colleague');
  assert.ok('ok' in await store.ingestForeign(chain(colleague, 2).map((item) => item.entry), [], PASS));
  const cell = streamId('start-again/cell');
  const grant = signPayload(lead.signer, 'staff-cell-grant', { cell, epoch: 1, device: 'd1', wrapped: 'w' }, { now: () => new Date(AT) });
  const put = await store.putGrant(cell, 1, grant);
  assert.ok('ok' in put);
  const dir = path.join(root, REPLICA_DIR);
  writeFileSync(path.join(dir, 'project.json'), PROJECT_TEXT);
  const colleagueFile = path.join(dir, 'streams', STREAM, `${colleague.writer}.jsonl`);
  writeFileSync(colleagueFile, `${readFileSync(colleagueFile, 'utf8').split('\n')[0]}\n`);
  assert.deepEqual(await ReplicaStore.open(root, deps), refusalOf('rolled-back'));
  const staff = path.join(root, '.planning', 'staff');
  return { root, staff, dir, intent: path.join(root, ...START_AGAIN_INTENT_FILE.split('/')), secretsFile, lead, deps, own, grantHash: put.hash, before: filesOf(dir) };
}

/** What the next open finds after Start Again finished: this device's entries, the blob, the grant and project.json, and no fork. */
async function assertFinished(seed: Seed, setAside: string = SET_ASIDE): Promise<void> {
  const after = await opened(seed.root, depsFor(seed.lead, seed.secretsFile));
  assert.deepEqual(after.head(STREAM, seed.lead.writer), { seq: 2, hash: seed.own[2].hash });
  assert.deepEqual(after.entries(), seed.own.map((item) => item.entry), 'only this device\'s own entries are carried');
  assert.deepEqual(await after.blob(seed.own[0].blobs[0].hash), seed.own[0].blobs[0]);
  assert.deepEqual((await after.grants()).grants.map((item) => item.hash), [seed.grantHash]);
  assert.equal(readFileSync(path.join(seed.dir, 'project.json'), 'utf8'), PROJECT_TEXT);
  assert.deepEqual(staffNames(seed.root).filter((name) => name.startsWith('replica.set-aside-')), [setAside], 'one folder set aside');
  assert.deepEqual(filesOf(path.join(seed.staff, setAside)), seed.before, 'the old store is set aside byte for byte, nothing deleted');
  assert.equal(existsSync(seed.intent), false, 'the intent is gone');
  const [next] = chain(seed.lead, 1, { from: { seq: 2, hash: seed.own[2].hash } });
  assert.equal(next.entry.header.seq, 3);
  assert.deepEqual(await after.appendOwn([next]), { ok: true, written: 1 }, 'the next own entry follows the last one: no fork');
}

interface ChildEnd { code: number | null; signal: NodeJS.Signals | null; messages: CrashChildMessage[]; stderr: string }

/** Runs the crash child to its end: killed at `step`, or done. */
function runChild(args: string[]): Promise<ChildEnd> {
  return new Promise((resolve) => {
    const messages: CrashChildMessage[] = [];
    let stderr = '';
    const child = fork(path.join(__dirname, 'helpers', 'startAgainCrashChild.js'), args, { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('message', (message: CrashChildMessage) => { messages.push(message); });
    child.on('exit', (code, signal) => { resolve({ code, signal, messages, stderr }); });
  });
}

async function crashAt(seed: Seed, step: StartAgainStep): Promise<void> {
  const end = await runChild(['store', seed.root, seed.secretsFile, 'lead', step]);
  assert.equal(end.signal, 'SIGKILL', `the child is killed at ${step} (${end.stderr}${JSON.stringify(end.messages)})`);
}

// ---- Task 1: the tracer -------------------------------------------------------------------------------------------------------------------------

test('syncFolder syncs a folder and then runs the probe with it; a folder that is not there is an error, never ignored', async () => {
  const dir = tempDir('sync');
  const seen: string[] = [];
  setFolderSyncProbe((synced) => { seen.push(synced); });
  try {
    await syncFolder(dir);
    assert.deepEqual(seen, [dir]);
    await assert.rejects(() => syncFolder(path.join(dir, 'missing')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    assert.deepEqual(seen, [dir], 'no probe for a sync that failed');
  } finally {
    setFolderSyncProbe(undefined);
  }
});

/** A shared project made on file-backed secret storage with one roster entry after the genesis, closed again. */
async function sharedWorld(label: string): Promise<{ root: string; deps: ReplicaProjectDeps; secretsFile: string; global: string; project: ReplicaProject }> {
  const base = tempDir(label);
  const secretsFile = path.join(base, 'secrets.json');
  const global = path.join(base, 'global');
  const root = path.join(base, 'project');
  const deps: ReplicaProjectDeps = { secrets: new FileSecrets(secretsFile), globalStorageDir: global, now: () => new Date(CRASH_CHILD_NOW) };
  const created = await ReplicaProject.createSharedProject(root, deps, { name: 'Exercise Northwind', profile: 'j2', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: 'mbr-lead' } });
  assert.ok(created instanceof ReplicaProject, `the project is made (${isProjectRefused(created) ? created.refused : ''})`);
  const invited = await created.appendOwn('member.invite', { invite: 'inv-jo', name: 'Jo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret()) });
  assert.ok('ok' in invited, 'the roster entry is written');
  return { root, deps, secretsFile, global, project: created };
}

function project(value: ReplicaProject | ProjectRefused | undefined): ReplicaProject {
  assert.ok(value instanceof ReplicaProject, `the project opens (${isProjectRefused(value) ? `${value.refused} ${value.store ?? ''}` : String(value)})`);
  return value;
}

test('tracer: Start Again killed between the two renames leaves the project shared, and the next open finishes it with the roster it had', async () => {
  const world = await sharedWorld('tracer');
  const { roster: before } = await world.project.state();
  assert.equal(before.positions.length, 3, 'origin, genesis and the roster entry');
  await world.project.close();
  // This device's mark no longer verifies: the store is refused mark-unverified, which Start Again resolves.
  await new FileSecrets(world.secretsFile).store(markKey(path.join(world.root, REPLICA_DIR)), 'not json');
  const refused = await ReplicaProject.open(world.root, world.deps);
  assert.equal(isProjectRefused(refused) ? refused.store : 'opened', 'mark-unverified');
  const end = await runChild(['project', world.root, world.secretsFile, world.global, 'set-aside']);
  assert.equal(end.signal, 'SIGKILL', end.stderr);
  const staff = path.join(world.root, '.planning', 'staff');
  assert.equal(existsSync(path.join(world.root, REPLICA_DIR)), false, 'killed after the store folder was set aside and before the new one moved in');
  assert.ok(existsSync(path.join(world.root, ...START_AGAIN_INTENT_FILE.split('/'))), 'the intent is there');
  assert.equal(await sharedProjectRefusal(world.root), SHARED_PROJECT_REFUSAL, 'the project still reads as shared: no single-machine write');
  const reopened = project(await ReplicaProject.open(world.root, world.deps));
  try {
    const { roster } = await reopened.state();
    assert.deepEqual(roster.positions, before.positions, 'the roster positions it had');
    assert.equal(roster.positions[0], ORIGIN_ROSTER);
    assert.equal(existsSync(path.join(world.root, ...START_AGAIN_INTENT_FILE.split('/'))), false, 'the intent is gone');
    assert.ok(existsSync(path.join(staff, SET_ASIDE, 'project.json')), 'the old store is set aside whole');
    const next = await reopened.appendOwn('member.invite', { invite: 'inv-sam', name: 'Sam Analyst', seat: 'j2-ops', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret()) });
    assert.ok('ok' in next, 'the next own entry is written');
    assert.equal(next.built.entry.header.seq, 2, 'it follows the roster entry at seq 1: no fork');
  } finally {
    await reopened.close();
  }
});

test('an uninterrupted Start Again runs its steps in order, each followed by a sync of the folder it changed', async () => {
  const seed = await seeded();
  const log: string[] = [];
  setStartAgainProbe((step) => { log.push(step); });
  setFolderSyncProbe((dir) => {
    if (dir === seed.staff) log.push('staff synced');
    else if (/^replica\.new-[0-9a-f]{12}$/.test(path.basename(dir))) log.push('temporary synced');
  });
  try {
    const started = await ReplicaStore.startAgain(seed.root, seed.deps);
    assert.deepEqual(started, { ok: true, setAside: `.planning/staff/${SET_ASIDE}`, carried: 3 });
  } finally {
    setStartAgainProbe(undefined);
    setFolderSyncProbe(undefined);
  }
  assert.deepEqual(log, ['built', 'temporary synced', 'intent-written', 'staff synced', 'set-aside', 'staff synced', 'moved-in', 'staff synced', 'marked', 'staff synced']);
  assert.deepEqual([...START_AGAIN_STEPS], ['built', 'intent-written', 'set-aside', 'moved-in', 'marked']);
  await assertFinished(seed);
});

// ---- Task 2: every crash point and every state an intent can find ------------------------------------------------------------------------------

test('killed at built: no intent, the store is still refused rolled-back, the temporary folder is kept, and Start Again run again succeeds', async () => {
  const seed = await seeded();
  await crashAt(seed, 'built');
  assert.equal(existsSync(seed.intent), false, 'no intent was written yet');
  const orphans = staffNames(seed.root).filter((name) => name.startsWith('replica.new-'));
  assert.equal(orphans.length, 1, 'the temporary folder is left, not deleted');
  assert.deepEqual(await ReplicaStore.open(seed.root, seed.deps), refusalOf('rolled-back'));
  assert.deepEqual(filesOf(seed.dir), seed.before, 'the store was not touched');
  assert.deepEqual(await ReplicaStore.startAgain(seed.root, seed.deps), { ok: true, setAside: `.planning/staff/${SET_ASIDE}`, carried: 3 });
  assert.deepEqual(staffNames(seed.root).filter((name) => name.startsWith('replica.new-')), orphans, 'the orphan is still kept');
  await assertFinished(seed);
});

for (const step of ['intent-written', 'set-aside', 'moved-in', 'marked'] as const) {
  test(`killed at ${step}: the next open finishes Start Again with this device's entries, the blob, the grant and project.json, and no fork`, async () => {
    const seed = await seeded();
    await crashAt(seed, step);
    assert.ok(existsSync(seed.intent), 'the intent is there');
    assert.equal(await sharedProjectRefusal(seed.root), SHARED_PROJECT_REFUSAL, 'the folder reads as shared while Start Again is unfinished');
    await assertFinished(seed);
  });
}

test('an intent found with the store and the temporary folder both gone builds the store again from the folder set aside, never empty', async () => {
  const seed = await seeded();
  await crashAt(seed, 'set-aside');
  const intent = JSON.parse(readFileSync(seed.intent, 'utf8')) as { temporary: string; carried: number };
  assert.equal(intent.carried, 3);
  // The temporary folder goes missing as well (moved away by hand).
  renameSync(path.join(seed.staff, intent.temporary), path.join(tempDir('moved'), intent.temporary));
  await assertFinished(seed);
});

test('two opens at once after a crash at set-aside both open, on one store and one folder set aside', async () => {
  const seed = await seeded();
  await crashAt(seed, 'set-aside');
  const [a, b] = await Promise.all([ReplicaStore.open(seed.root, seed.deps), ReplicaStore.open(seed.root, depsFor(seed.lead, seed.secretsFile))]);
  assert.ok(a instanceof ReplicaStore && b instanceof ReplicaStore, 'both open');
  assert.deepEqual(staffNames(seed.root), ['replica', SET_ASIDE]);
  await assertFinished(seed);
});

/** A store of three own entries that opens, with no project.json. */
async function working(): Promise<{ root: string; staff: string; dir: string; intent: string; secretsFile: string; lead: FixedSigner; deps: ReplicaStoreDeps; built: BuiltEntry[] }> {
  const root = tempDir('working');
  const secretsFile = path.join(tempDir('secrets'), 'secrets.json');
  const lead = fixedSigner('lead');
  const deps = depsFor(lead, secretsFile);
  const store = await opened(root, deps);
  const built = chain(lead, 3);
  assert.deepEqual(await store.appendOwn(built), { ok: true, written: 3 });
  return { root, staff: path.join(root, '.planning', 'staff'), dir: path.join(root, REPLICA_DIR), intent: path.join(root, ...START_AGAIN_INTENT_FILE.split('/')), secretsFile, lead, deps, built };
}

test('an intent naming a folder outside .planning/staff, or of another version, is refused start-again-unfinished with nothing renamed or made', async () => {
  const world = await working();
  const temporary = 'replica.new-0123456789ab';
  mkdirSync(path.join(world.staff, temporary));
  const valid = { v: 1, writer: world.lead.writer, setAside: SET_ASIDE, temporary, source: 'replica', carried: 3, grants: 0, blobs: 0 };
  const before = filesOf(world.dir);
  const outside = path.join(world.root, '.planning', 'outside');
  for (const intent of [{ ...valid, temporary: '../outside' }, { ...valid, setAside: '../outside' }, { ...valid, source: '../../outside' }, { ...valid, v: 2 }, { ...valid, extra: true }, 'not json']) {
    writeFileSync(world.intent, typeof intent === 'string' ? intent : JSON.stringify(intent));
    assert.deepEqual(await ReplicaStore.open(world.root, world.deps), refusalOf('start-again-unfinished'), JSON.stringify(intent));
    assert.deepEqual(staffNames(world.root), ['replica', temporary, 'replica.start-again.json'].sort(), 'nothing renamed or made');
    assert.deepEqual(filesOf(world.dir), before);
    assert.equal(existsSync(outside), false);
    assert.equal(await sharedProjectRefusal(world.root), SHARED_PROJECT_REFUSAL, 'the folder reads as shared while the intent is there');
  }
  // A folder planted at the intent's name is not followed either.
  rmSync(world.intent);
  mkdirSync(world.intent);
  assert.deepEqual(await ReplicaStore.open(world.root, world.deps), refusalOf('start-again-unfinished'));
  assert.deepEqual(filesOf(world.dir), before);
});

test('an intent of another device has its folders finished and leaves this device\'s mark untouched', async () => {
  const world = await working();
  const other = fixedSigner('other-device');
  const temporary = 'replica.new-0123456789ab';
  cpSync(world.dir, path.join(world.staff, temporary), { recursive: true });
  writeFileSync(world.intent, JSON.stringify({ v: 1, writer: other.writer, setAside: SET_ASIDE, temporary, source: 'replica', carried: 0, grants: 0, blobs: 0 }));
  renameSync(world.dir, path.join(world.staff, SET_ASIDE));
  const key = markKey(world.dir);
  const markBefore = await new FileSecrets(world.secretsFile).get(key);
  assert.ok(markBefore !== undefined);
  const store = await opened(world.root, world.deps);
  assert.deepEqual(store.head(STREAM, world.lead.writer), { seq: 2, hash: world.built[2].hash });
  assert.equal(await new FileSecrets(world.secretsFile).get(key), markBefore, 'this device\'s mark is untouched');
  assert.equal(existsSync(world.intent), false);
  assert.deepEqual(staffNames(world.root), ['replica', SET_ASIDE]);
});

test('a file planted at the set-aside name mid-way: refused start-again-unfinished, never thrown, and the next open finishes under the next free name', async () => {
  const seed = await seeded();
  setStartAgainProbe((step) => {
    if (step !== 'intent-written') return;
    const intent = JSON.parse(readFileSync(seed.intent, 'utf8')) as { setAside: string };
    writeFileSync(path.join(seed.staff, intent.setAside), 'planted');
  });
  let result: unknown;
  try {
    result = await ReplicaStore.startAgain(seed.root, seed.deps);
  } finally {
    setStartAgainProbe(undefined);
  }
  assert.deepEqual(result, refusalOf('start-again-unfinished'));
  assert.deepEqual(filesOf(seed.dir), seed.before, 'the store was not moved');
  const after = await opened(seed.root, seed.deps);
  assert.ok(after instanceof ReplicaStore);
  assert.equal(readFileSync(path.join(seed.staff, SET_ASIDE), 'utf8'), 'planted', 'the planted file is left as it is');
  assert.deepEqual(filesOf(path.join(seed.staff, `${SET_ASIDE}-2`)), seed.before, 'the store was set aside under the next free name');
  assert.equal(existsSync(seed.intent), false);
  assert.deepEqual(after.head(STREAM, seed.lead.writer), { seq: 2, hash: seed.own[2].hash });
});

test('a file planted at the store name after it was set aside: refused, the folder stays shared, and once it is moved away the next open finishes', async () => {
  const seed = await seeded();
  setStartAgainProbe((step) => { if (step === 'set-aside') writeFileSync(seed.dir, 'planted'); });
  let result: unknown;
  try {
    result = await ReplicaStore.startAgain(seed.root, seed.deps);
  } finally {
    setStartAgainProbe(undefined);
  }
  assert.deepEqual(result, refusalOf('start-again-unfinished'));
  const again = await ReplicaStore.open(seed.root, seed.deps);
  assert.ok(!(again instanceof ReplicaStore), 'a file where the store folder belongs is refused, never written through');
  assert.equal(await sharedProjectRefusal(seed.root), SHARED_PROJECT_REFUSAL);
  renameSync(seed.dir, path.join(tempDir('moved'), 'planted'));
  await assertFinished(seed);
});

test('a .planning/staff that cannot be written: the store still opens or refuses as before, and Start Again is refused start-again-unfinished with nothing changed', async () => {
  const seed = await seeded();
  const namesBefore = staffNames(seed.root);
  chmodSync(seed.staff, 0o555);
  try {
    assert.deepEqual(await ReplicaStore.open(seed.root, seed.deps), refusalOf('rolled-back'), 'a refusal, never a thrown error');
    assert.deepEqual(await ReplicaStore.startAgain(seed.root, seed.deps), refusalOf('start-again-unfinished'));
    assert.deepEqual(staffNames(seed.root), namesBefore, 'nothing renamed or made');
    assert.deepEqual(filesOf(seed.dir), seed.before);
  } finally {
    chmodSync(seed.staff, 0o755);
  }
  assert.deepEqual(await ReplicaStore.startAgain(seed.root, seed.deps), { ok: true, setAside: `.planning/staff/${SET_ASIDE}`, carried: 3 });
  await assertFinished(seed);
});

// ---- Task 3: a store folder that is gone is not "start empty" ---------------------------------------------------------------------------------

test('a store folder deleted while the mark remains: open is refused rolled-back and makes nothing; Start Again carries from the folder set aside and names it', async () => {
  const seed = await seeded();
  assert.deepEqual(await ReplicaStore.startAgain(seed.root, seed.deps), { ok: true, setAside: `.planning/staff/${SET_ASIDE}`, carried: 3 });
  rmSync(seed.dir, { recursive: true });
  assert.deepEqual(await ReplicaStore.open(seed.root, seed.deps), refusalOf('rolled-back'));
  assert.equal(existsSync(seed.dir), false, 'no empty store is made');
  assert.equal(await sharedProjectRefusal(seed.root), SHARED_PROJECT_REFUSAL, 'project.json set aside beside it keeps the folder shared');
  assert.deepEqual(await ReplicaStore.startAgain(seed.root, seed.deps), { ok: true, setAside: null, carried: 3, carriedFrom: `.planning/staff/${SET_ASIDE}` });
  await assertFinished(seed);
});

test('an older version\'s leftover (store gone, a folder set aside and a temporary folder beside it, no intent) reads as shared and starts again from the folder set aside', async () => {
  const world = await sharedWorld('leftover');
  const { roster: before } = await world.project.state();
  await world.project.close();
  const staff = path.join(world.root, '.planning', 'staff');
  const dir = path.join(world.root, REPLICA_DIR);
  // What an older version left when it stopped between its two renames.
  cpSync(dir, path.join(staff, 'replica.new-0123456789ab'), { recursive: true });
  renameSync(dir, path.join(staff, 'replica.set-aside-20261119-090000'));
  assert.equal(await sharedProjectRefusal(world.root), SHARED_PROJECT_REFUSAL);
  const refused = await ReplicaProject.open(world.root, world.deps);
  assert.deepEqual(isProjectRefused(refused) ? [refused.refused, refused.store] : refused, ['store-refused', 'rolled-back']);
  assert.equal(existsSync(dir), false, 'nothing is made');
  const started = await ReplicaProject.startHistoryAgain(world.root, world.deps);
  assert.deepEqual(started, { ok: true, setAside: null, carried: 2, carriedFrom: '.planning/staff/replica.set-aside-20261119-090000' });
  assert.ok(existsSync(path.join(world.root, ...REPLICA_PROJECT_FILE.split('/'))), 'project.json is carried');
  const reopened = project(await ReplicaProject.open(world.root, world.deps));
  try {
    assert.deepEqual((await reopened.state()).roster.positions, before.positions, 'the project opens with its pin and its roster');
  } finally {
    await reopened.close();
  }
  assert.ok(existsSync(path.join(staff, 'replica.new-0123456789ab')), 'the leftover is kept');
});

test('an empty store folder beside a folder set aside whose own entries verify: carried from that folder, and the empty folder is set aside too', async () => {
  const seed = await seeded();
  assert.ok('ok' in await ReplicaStore.startAgain(seed.root, seed.deps));
  renameSync(seed.dir, path.join(tempDir('moved'), 'replica'));
  mkdirSync(seed.dir);
  assert.deepEqual(await ReplicaStore.open(seed.root, seed.deps), refusalOf('rolled-back'));
  const emptied = filesOf(seed.dir);
  assert.deepEqual(await ReplicaStore.startAgain(seed.root, seed.deps), { ok: true, setAside: `.planning/staff/${SET_ASIDE}-2`, carried: 3, carriedFrom: `.planning/staff/${SET_ASIDE}` });
  assert.deepEqual(filesOf(path.join(seed.staff, `${SET_ASIDE}-2`)), emptied, 'the empty folder is set aside, never deleted');
  const after = await opened(seed.root, seed.deps);
  assert.deepEqual(after.head(STREAM, seed.lead.writer), { seq: 2, hash: seed.own[2].hash });
  assert.deepEqual(await after.blob(seed.own[0].blobs[0].hash), seed.own[0].blobs[0]);
  assert.equal(readFileSync(path.join(seed.dir, 'project.json'), 'utf8'), PROJECT_TEXT);
});

test('two folders set aside: the newer is used when its own entries verify; a line this device did not sign or a gap sends it to the older', async () => {
  for (const damage of ['none', 'unsigned', 'gap'] as const) {
    const world = await working();
    const older = 'replica.set-aside-20261101-000000';
    const newer = 'replica.set-aside-20261110-000000';
    cpSync(world.dir, path.join(world.staff, older), { recursive: true });
    const store = await opened(world.root, world.deps);
    const [fourth] = chain(world.lead, 1, { from: { seq: 2, hash: world.built[2].hash } });
    assert.deepEqual(await store.appendOwn([fourth]), { ok: true, written: 1 });
    cpSync(world.dir, path.join(world.staff, newer), { recursive: true });
    const file = path.join(world.staff, newer, 'streams', STREAM, `${world.lead.writer}.jsonl`);
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (damage === 'unsigned') {
      // A line that names this device as its writer but was signed by another key.
      const forged = chain(fixedSigner('impostor'), 1, { from: { seq: 3, hash: fourth.hash } })[0].entry;
      lines.push(JSON.stringify({ header: { ...forged.header, writer: world.lead.writer }, body: forged.body }));
    }
    if (damage === 'gap') lines.splice(2, 1);
    writeFileSync(file, `${lines.join('\n')}\n`);
    rmSync(world.dir, { recursive: true });
    const started = await ReplicaStore.startAgain(world.root, world.deps);
    const expected = damage === 'none' ? { carried: 4, carriedFrom: `.planning/staff/${newer}` } : { carried: 3, carriedFrom: `.planning/staff/${older}` };
    assert.deepEqual(started, { ok: true, setAside: null, ...expected }, damage);
    const after = await opened(world.root, world.deps);
    assert.equal(after.head(STREAM, world.lead.writer)?.seq, expected.carried - 1, damage);
  }
});

test('a reader device (no own entries anywhere) carries the grants, the blob and project.json from the store folder as before', async () => {
  const root = tempDir('reader');
  const secretsFile = path.join(tempDir('secrets'), 'secrets.json');
  const reader = fixedSigner('reader');
  const deps = depsFor(reader, secretsFile);
  const store = await opened(root, deps);
  const colleague = fixedSigner('colleague');
  const [first] = chain(colleague, 1, { big: true });
  const entries = [first, ...chain(colleague, 1, { from: { seq: 0, hash: first.hash } })];
  const ingested = await store.ingestForeign(entries.map((item) => item.entry), first.blobs, PASS);
  assert.ok('ok' in ingested && ingested.blobsAdded === 1);
  const cell = streamId('start-again/cell');
  const put = await store.putGrant(cell, 1, signPayload(colleague.signer, 'staff-cell-grant', { cell, epoch: 1, device: 'd1', wrapped: 'w' }, { now: () => new Date(AT) }));
  assert.ok('ok' in put);
  const dir = path.join(root, REPLICA_DIR);
  writeFileSync(path.join(dir, 'project.json'), PROJECT_TEXT);
  const colleagueFile = path.join(dir, 'streams', STREAM, `${colleague.writer}.jsonl`);
  writeFileSync(colleagueFile, `${readFileSync(colleagueFile, 'utf8').split('\n')[0]}\n`);
  assert.deepEqual(await ReplicaStore.open(root, deps), refusalOf('rolled-back'));
  assert.deepEqual(await ReplicaStore.startAgain(root, deps), { ok: true, setAside: `.planning/staff/${SET_ASIDE}`, carried: 0 });
  const after = await opened(root, deps);
  assert.deepEqual(after.entries(), []);
  assert.deepEqual((await after.grants()).grants.map((item) => item.hash), [put.hash]);
  assert.deepEqual(await after.blob(first.blobs[0].hash), first.blobs[0]);
  assert.equal(readFileSync(path.join(dir, 'project.json'), 'utf8'), PROJECT_TEXT);
});

test('no store folder and nothing beside it holding project.json: Start Again is refused nothing-to-carry and makes nothing', async () => {
  const world = await working();
  rmSync(world.dir, { recursive: true });
  assert.deepEqual(await ReplicaStore.open(world.root, world.deps), refusalOf('rolled-back'), 'the mark remains, so the store is not made again empty');
  assert.deepEqual(await ReplicaStore.startAgain(world.root, world.deps), refusalOf('nothing-to-carry'));
  assert.deepEqual(staffNames(world.root), [], 'nothing made');
});

test('a folder with no shared project and nothing beside it opens and makes its store as before, and stays open to single-machine writes', async () => {
  const root = tempDir('plain');
  assert.equal(await sharedProjectRefusal(root), undefined);
  assert.equal(await ReplicaProject.open(root, { secrets: new FileSecrets(path.join(tempDir('secrets'), 'secrets.json')), globalStorageDir: tempDir('global') }), undefined);
  const store = await opened(root, depsFor(fixedSigner('lead'), path.join(tempDir('secrets'), 'secrets.json')));
  assert.ok(store instanceof ReplicaStore);
  assert.deepEqual(listTree(path.join(root, REPLICA_DIR)), ['.gitignore']);
  assert.deepEqual(staffNames(root), ['replica']);
  assert.equal(await sharedProjectRefusal(root), undefined);
});

test('the two new refusals are plain, name no command of their own, and Start Again does not resolve them', () => {
  assert.equal(STORE_REFUSALS['start-again-unfinished'], 'Starting this computer\'s shared history again did not finish, so the shared history was not opened. Nothing was deleted. Open the project again to finish it. If this message comes back, check that the folders in .planning/staff can be read and written by your user account.');
  assert.equal(STORE_REFUSALS['nothing-to-carry'], 'There is no copy of this project\'s shared history on this computer to start again from, so nothing was changed. Ask your staff lead for a new welcome file and open it with Staff: Join Staff Project.');
  for (const reason of ['start-again-unfinished', 'nothing-to-carry'] as const) {
    assert.equal(STORE_REFUSALS[reason].includes(START_AGAIN_COMMAND_TITLE), false, reason);
    assert.equal(START_AGAIN_REFUSALS.includes(reason), false, reason);
    assert.doesNotMatch(STORE_REFUSALS[reason], /\u2014/);
  }
  assert.equal(START_AGAIN_INTENT_FILE, '.planning/staff/replica.start-again.json');
});
