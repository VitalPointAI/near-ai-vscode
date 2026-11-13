import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { buildManifest, MAX_MANIFEST_BYTES, MAX_PART_BYTES, OBJECT_HEADER_BYTES, type ObjectEntry } from '../domain/state/objects';
import { generateRecoveryCode } from '../domain/state/recoveryCode';
import type { StateRecord } from '../domain/state/records';
import type { ThreadEntry } from '../domain/state/threadEntries';
import { HOT_CONSOLIDATE_COUNT, MAX_LISTED_OBJECTS, SYNC_COLD_STOP_BYTES, SYNC_WARN_BYTES, type StateSyncOptions, type SyncOutcome } from '../services/stateSync';
import type { HotPayload } from '../services/stateRecords';
import { applyRetention } from '../services/threadArchive';
import { bareRemote, fixtureGit, sealingKeys } from './helpers/gitFixtures';
import { chain, entryIds, machine, remoteManifest, remotePayloads, type Machine } from './helpers/syncFixtures';

// Phase 27, plan 13 (SYNC-05, D-07, D-08): a thread archived on one computer and continued on another ends on both with every entry of both; two
// computers that keep different numbers of threads live agree on what every thread holds. Real git against a local bare remote.

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3));
const idOf = (prefix: string, n: number): string => `conv-${prefix}-${String(n).padStart(3, '0')}`;

function filteringRemote(): string {
  const remote = bareRemote({ withMain: false });
  fixtureGit(remote, ['config', 'uploadpack.allowFilter', 'true']);
  return remote;
}

/** A thread of its own words, last used after every thread made before it. Returns its entry ids. */
async function addThread(m: Machine, id: string, title: string): Promise<string[]> {
  await m.threads.create({ id, title, model: 'near/model-a', origin: 'panel' });
  const entries = chain(id, m.writer, [['user', `${title}: what changed`], ['assistant', `${title}: the answer`], ['user', `${title}: and then`], ['assistant', `${title}: done`]]);
  await m.threads.appendEntries(id, entries);
  await tick();
  return entries.map((entry) => entry.id);
}

async function liveCount(m: Machine): Promise<number> {
  return (await m.threads.index()).filter((item) => item.state === 'live').length;
}

async function archiveHash(m: Machine, id: string): Promise<string> {
  const dir = m.threads.archiveDirOf(id);
  const names = (await readdir(dir)).filter((name) => name !== 'delta.jsonl').sort();
  const hash = createHash('sha256');
  for (const name of names) hash.update(name).update(await readFile(path.join(dir, name)));
  return hash.digest('hex');
}

/** A with six threads, the oldest archived and pushed; B opened with the code and pulled. */
async function archivedOnA(prefix: string): Promise<{ remote: string; a: Machine; b: Machine; bytes: Buffer; thread: string; original: string[] }> {
  const remote = filteringRemote();
  const a = await machine(remote, 'alpha');
  const b = await machine(remote, 'bravo');
  const { bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  const thread = idOf(prefix, 1);
  const original = await addThread(a, thread, 'Archived on one, continued on the other');
  for (let n = 2; n <= 6; n += 1) await addThread(a, idOf(prefix, n), `Merge thread ${n}`);
  assert.deepEqual((await applyRetention(a.threads, 5, [])).archived, [thread]);
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal((await b.sync.unlockFromRemote(bytes)).kind, 'synced');
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
  return { remote, a, b, bytes, thread, original };
}

test('archived on A and continued on B: A keeps B\'s new entries next to the archive, ranks the thread live, and folds both by union', async () => {
  const { a, b, thread, original } = await archivedOnA('merge');
  const archiveBefore = await archiveHash(a, thread);

  // B opens it (the archive is fetched), adds three entries and syncs.
  assert.equal(await b.threads.prepareOpen(thread), undefined);
  const more = chain(thread, b.writer, [['user', 'one more question'], ['assistant', 'one more answer'], ['user', 'thanks']], original[original.length - 1] ?? null);
  await b.threads.appendEntries(thread, more);
  assert.equal((await b.sync.sync()).kind, 'synced');

  // A pulls. The archive is not opened or rewritten; the new entries wait beside it.
  const pulled = await a.sync.sync();
  assert.equal(pulled.kind, 'synced', pulled.message);
  assert.equal(await archiveHash(a, thread), archiveBefore, 'the archive itself is untouched');
  assert.deepEqual((await a.threads.archiveDeltaEntries(thread)).map((entry) => entry.id).sort(), more.map((entry) => entry.id).sort(), 'the delta file holds B\'s three entries');
  const archivedItem = (await a.threads.index()).find((item) => item.id === thread);
  assert.equal(archivedItem?.state, 'archived');
  const latest = (await b.threads.index()).find((item) => item.id === thread)?.lastUsedAt ?? '';
  assert.ok(latest > '', 'B used the thread');
  assert.ok((archivedItem?.lastUsedAt ?? '') >= latest, 'the thread\'s last use on A is at least B\'s: the merged one');

  // Nothing keeps ping-ponging between the two: a second sync on each side pushes nothing.
  assert.equal((await a.sync.sync()).pushed, false, 'A has nothing more to say');
  assert.equal((await b.sync.sync()).pushed, false, 'and neither has B');

  // Ranked by that, the thread is live again on A and the lowest-ranked live thread is archived in its place.
  const retained = await applyRetention(a.threads, 5, []);
  assert.deepEqual(retained.restored, [thread]);
  assert.deepEqual(retained.archived, [idOf('merge', 2)]);
  assert.deepEqual(await entryIds(a, thread), [...original, ...more.map((entry) => entry.id)].sort(), 'every entry of both computers');
  assert.deepEqual(await readdir(a.threads.archiveDirOf(thread)).catch(() => []), [], 'the archive folder is gone once it is folded in');
});

test('a third computer that never had the thread lists it archived and opens it with the archive and the entries added since', async () => {
  const { remote, a, b, bytes, thread, original } = await archivedOnA('third');
  await b.threads.prepareOpen(thread);
  const more = chain(thread, b.writer, [['user', 'a follow-up'], ['assistant', 'a reply']], original[original.length - 1] ?? null);
  await b.threads.appendEntries(thread, more);
  assert.equal((await b.sync.sync()).kind, 'synced');
  assert.equal((await a.sync.sync()).kind, 'synced');

  const c = await machine(remote, 'charlie');
  assert.equal((await c.sync.unlockFromRemote(bytes)).kind, 'synced');
  assert.equal((await c.sync.pullOnly()).kind, 'synced');
  const listed = (await c.threads.index()).find((item) => item.id === thread);
  assert.equal(listed?.state, 'archived');
  assert.equal(listed?.location, 'remote');
  assert.deepEqual((await c.threads.archiveDeltaEntries(thread)).map((entry) => entry.id).sort(), more.map((entry) => entry.id).sort(), 'the entries added since wait beside it');
  assert.equal((await readdir(c.threads.archiveDirOf(thread))).filter((name) => name.endsWith('.bin')).length, 0, 'the archive itself was not downloaded');
  assert.deepEqual(await entryIds(c, thread), [...original, ...more.map((entry) => entry.id)].sort(), 'opening it brings the archive and unites it with them');
  assert.deepEqual(await entryIds(a, thread), await entryIds(c, thread));
});

test('two computers that keep different numbers of threads live agree on what every thread holds; only which are live differs', async () => {
  const remote = filteringRemote();
  const a = await machine(remote, 'alpha');
  const b = await machine(remote, 'bravo');
  const { bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  const expected = new Map<string, string[]>();
  for (let n = 1; n <= 6; n += 1) expected.set(idOf('aaa', n), await addThread(a, idOf('aaa', n), `Thread from A ${n}`));
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal((await b.sync.unlockFromRemote(bytes)).kind, 'synced');
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
  for (let n = 1; n <= 6; n += 1) expected.set(idOf('bbb', n), await addThread(b, idOf('bbb', n), `Thread from B ${n}`));

  // A keeps two live and B keeps five, and each syncs in turn until nothing moves.
  for (let round = 0; round < 2; round += 1) {
    await applyRetention(a.threads, 2, []);
    assert.equal((await a.sync.sync()).kind, 'synced');
    await applyRetention(b.threads, 5, []);
    assert.equal((await b.sync.sync()).kind, 'synced');
  }
  assert.equal((await a.sync.sync()).kind, 'synced');
  await applyRetention(a.threads, 2, []);
  await applyRetention(b.threads, 5, []);
  assert.equal(await liveCount(a), 2, 'A keeps two live');
  assert.equal(await liveCount(b), 5, 'B keeps five live');

  // Both list all twelve, and opening each (from the archive, or from the online copy) shows the same entries on both.
  assert.equal((await a.threads.index()).length, 12);
  assert.equal((await b.threads.index()).length, 12);
  for (const [id, ids] of expected) {
    assert.deepEqual(await entryIds(a, id), [...ids].sort(), `A holds every entry of ${id}`);
    assert.deepEqual(await entryIds(b, id), [...ids].sort(), `B holds every entry of ${id}`);
  }
  assert.ok(await stat(a.home.dir).then(() => true), 'the state home is intact');
});

// ---- growth and limits (Task 3) ----------------------------------------------------------------------------------------------------------

const MIB = 1024 * 1024;

function isHot(payload: unknown): payload is HotPayload {
  return typeof payload === 'object' && payload !== null && 'entries' in payload && 'records' in payload;
}

/** How many hot objects (whole objects, not parts) the remote's manifest lists. */
async function hotObjects(remote: string, m: Machine): Promise<number> {
  return (await remoteManifest(remote, m)).objects.filter((entry) => entry.class === 'hot' && entry.part === 0).length;
}

/** A project with sync on and a thread whose chain grows one entry at a time. */
async function growingThread(extra: Partial<StateSyncOptions> = {}): Promise<{ remote: string; a: Machine; thread: string; add: () => Promise<ThreadEntry[]>; bytes: Buffer }> {
  const remote = filteringRemote();
  const a = await machine(remote, 'alpha', { extra });
  const { bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  const thread = idOf('grow', 1);
  await a.threads.create({ id: thread, title: 'A long conversation', model: 'near/model-a', origin: 'panel' });
  let tip: string | null = null;
  let n = 0;
  const add = async (): Promise<ThreadEntry[]> => {
    n += 1;
    const entries = chain(thread, a.writer, [['user', `question ${n}`]], tip);
    tip = entries[entries.length - 1]?.id ?? tip;
    await a.threads.appendEntries(thread, entries);
    return entries;
  };
  return { remote, a, thread, add, bytes };
}

test('more than twenty hot objects are replaced by one: nothing is lost and another computer syncs the same', async () => {
  const { remote, a, thread, add, bytes } = await growingThread();
  const written: string[] = [];
  const series: number[] = [];
  for (let n = 1; n <= 25; n += 1) {
    written.push(...(await add()).map((entry) => entry.id));
    const outcome = await a.sync.sync();
    assert.equal(outcome.kind, 'synced', outcome.message);
    series.push(await hotObjects(remote, a));
  }
  assert.equal(series[HOT_CONSOLIDATE_COUNT - 1], HOT_CONSOLIDATE_COUNT, 'twenty pushes leave twenty hot objects');
  assert.ok((series[HOT_CONSOLIDATE_COUNT] ?? 99) <= 3, 'the next push consolidates: at most three hot objects remain');
  assert.ok(Math.max(...series) <= HOT_CONSOLIDATE_COUNT, 'the remote never holds more than twenty');
  // Everything is still on the remote: every entry id of every push is in the hot objects now listed.
  const onRemote = new Set<string>();
  for (const payload of await remotePayloads(remote, a)) if (isHot(payload)) for (const entry of payload.entries[thread] ?? []) onRemote.add(entry.id);
  for (const id of written) assert.ok(onRemote.has(id), `entry ${id} survived the consolidation`);

  const b = await machine(remote, 'bravo');
  assert.equal((await b.sync.unlockFromRemote(bytes)).kind, 'synced');
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
  assert.deepEqual(await entryIds(b, thread), [...written].sort(), 'a second computer gets every entry');
  const more = await add();
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal((await b.sync.sync()).kind, 'synced');
  assert.ok((await entryIds(b, thread)).includes(more[0]?.id ?? ''), 'and what is added after');
});

test('a consolidation that would lose one entry is refused: the old objects stay and the push goes ahead as usual', async () => {
  const lose = (payload: HotPayload): HotPayload => {
    const [id, list] = Object.entries(payload.entries)[0] ?? ['', []];
    return { ...payload, entries: { ...payload.entries, [id]: list.slice(0, -1) } };
  };
  const { remote, a, thread, add, bytes } = await growingThread({ shapeConsolidated: lose });
  const written: string[] = [];
  for (let n = 1; n <= HOT_CONSOLIDATE_COUNT + 1; n += 1) {
    written.push(...(await add()).map((entry) => entry.id));
    const outcome = await a.sync.sync();
    assert.equal(outcome.kind, 'synced', outcome.message);
  }
  assert.equal(await hotObjects(remote, a), HOT_CONSOLIDATE_COUNT + 1, 'the twenty-first push was not consolidated: every old object is still listed');
  const onRemote = new Set<string>();
  for (const payload of await remotePayloads(remote, a)) if (isHot(payload)) for (const entry of payload.entries[thread] ?? []) onRemote.add(entry.id);
  for (const id of written) assert.ok(onRemote.has(id), `entry ${id} is still on the remote`);
  const b = await machine(remote, 'bravo');
  assert.equal((await b.sync.unlockFromRemote(bytes)).kind, 'synced');
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
  assert.deepEqual(await entryIds(b, thread), [...written].sort());
});

test('hot objects are also replaced when together they are more than twice the size of what they hold now', async () => {
  let version = 0;
  const profileSource = { records: () => { version += 1; return Promise.resolve([{ id: 'profile-one', body: { notes: randomBytes(520 * 1024).toString('base64'), version } }]); } };
  const { remote, a } = await growingThread({ profileSource });
  const series: number[] = [];
  for (let n = 1; n <= 7; n += 1) {
    const outcome = await a.sync.sync();
    assert.equal(outcome.kind, 'synced', outcome.message);
    series.push(await hotObjects(remote, a));
  }
  assert.ok(Math.max(...series) < HOT_CONSOLIDATE_COUNT, 'the count rule is nowhere near');
  assert.ok(series.some((count, at) => at > 0 && count < (series[at - 1] ?? 0)), `the size rule replaced them: ${series.join(' ')}`);
});

test('no object part is over 8 MiB: a larger payload is split and a second computer still reads it', async () => {
  const profileSource = { records: () => Promise.resolve([{ id: 'profile-big', body: { notes: randomBytes(9 * MIB).toString('base64') } }]) };
  const { remote, a, bytes } = await growingThread({ profileSource });
  assert.equal((await a.sync.sync()).kind, 'synced');
  const objects = (await remoteManifest(remote, a)).objects;
  assert.ok(objects.some((entry) => entry.of > 1), 'it took more than one part');
  for (const entry of objects) assert.ok(entry.bytes <= MAX_PART_BYTES + OBJECT_HEADER_BYTES, `${entry.file} is ${entry.bytes} bytes`);
  const b = await machine(remote, 'bravo');
  assert.equal((await b.sync.unlockFromRemote(bytes)).kind, 'synced');
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
});

test('the manifest lists at most as many objects as its own size limit allows, with wide margin', async () => {
  const keys = await sealingKeys();
  const entry = (n: number): ObjectEntry => ({ file: `${n.toString(16).padStart(32, '0')}.bin`, bytes: 8 * MIB, sha256: '0123456789abcdef'.repeat(4), class: n % 2 ? 'cold' : 'hot', part: 0, of: 1 });
  const objects = Array.from({ length: MAX_LISTED_OBJECTS }, (_, n) => entry(n));
  const text = buildManifest({ stateId: keys.stateId, kdf: keys.kdf, wrappedKey: keys.wrappedKey, dataKey: keys.dataKey, seq: 1, objects, indexFile: objects[0]?.file ?? null });
  assert.ok(Buffer.byteLength(text, 'utf8') < MAX_MANIFEST_BYTES * 0.8, `a manifest of ${MAX_LISTED_OBJECTS} objects is ${Buffer.byteLength(text, 'utf8')} bytes of the ${MAX_MANIFEST_BYTES} allowed`);
});

/** A with six threads and the three oldest archived, ready to sync. */
async function threeArchived(extra: Partial<StateSyncOptions>): Promise<{ remote: string; a: Machine; bytes: Buffer; archived: string[] }> {
  const remote = filteringRemote();
  const a = await machine(remote, 'alpha', { extra });
  const { bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  for (let n = 1; n <= 6; n += 1) await addThread(a, idOf('size', n), `Sized thread ${n}`);
  const archived = (await applyRetention(a.threads, 3, [])).archived.sort();
  assert.equal(archived.length, 3);
  return { remote, a, bytes, archived };
}

const coldCount = async (remote: string, m: Machine): Promise<number> => (await remoteManifest(remote, m)).objects.filter((entry) => entry.class === 'cold').length;

test('at 600 MB of synced ciphertext sync says so in plain words, and everything still syncs', async () => {
  const { remote, a } = await threeArchived({ measure: (listed: number) => listed + 600 * MIB });
  const outcome: SyncOutcome = await a.sync.sync();
  assert.equal(outcome.kind, 'synced');
  assert.match(outcome.message, /Synced project state is over 500 MB\./);
  assert.equal(await coldCount(remote, a), 3, 'the archives still went up');
  const quiet = await a.sync.sync();
  assert.match(quiet.message, /Synced project state is over 500 MB\./, 'and it is said again while it stays true');
  assert.equal(quiet.pushed, false);
  assert.ok(SYNC_WARN_BYTES === 500 * MIB && SYNC_COLD_STOP_BYTES === 1024 * MIB);
});

test('at 1.1 GB no new cold object is added: the message says which stay on this computer, nothing is deleted, and they go up once there is room', async () => {
  let reported = 1.1 * 1024 * MIB;
  const { remote, a, bytes, archived } = await threeArchived({ measure: (listed: number) => listed + reported });
  const outcome = await a.sync.sync();
  assert.equal(outcome.kind, 'synced', outcome.message);
  assert.match(outcome.message, /3 older conversations stay on this computer only/);
  assert.match(outcome.message, /Nothing was deleted/);
  assert.equal(await coldCount(remote, a), 0, 'no cold object was added');
  const onRemote = new Set<string>();
  for (const payload of await remotePayloads(remote, a)) if (isHot(payload)) for (const id of Object.keys(payload.entries)) onRemote.add(id);
  for (const id of archived) assert.equal(onRemote.has(id), false, `${id} is not on the remote in any form`);
  for (const id of archived) {
    assert.ok((await a.threads.index()).some((item) => item.id === id && item.state === 'archived'), `${id} is still listed archived here`);
    assert.ok((await readdir(a.threads.archiveDirOf(id))).some((name) => name.endsWith('.bin')), `${id} still has its archive here`);
  }
  assert.equal((await a.threads.index()).length, 6);

  reported = 0;
  const later = await a.sync.sync();
  assert.equal(later.kind, 'synced', later.message);
  assert.equal(await coldCount(remote, a), 3, 'with room again the archives go up');
  const b = await machine(remote, 'bravo');
  assert.equal((await b.sync.unlockFromRemote(bytes)).kind, 'synced');
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
  assert.equal((await b.threads.index()).length, 6, 'and B lists every one');
});

test('when the manifest would list more objects than allowed no new cold object is added either, and it says so', async () => {
  const { remote, a } = await threeArchived({ maxListedObjects: 4 });
  const outcome = await a.sync.sync();
  assert.equal(outcome.kind, 'synced', outcome.message);
  assert.equal(await coldCount(remote, a), 1, 'two objects are reserved for the hot object and the index, so one archive fits');
  assert.match(outcome.message, /2 older conversations stay on this computer only/);
  assert.equal((await remoteManifest(remote, a)).objects.length, 4);
});
