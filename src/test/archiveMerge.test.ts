import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { generateRecoveryCode } from '../domain/state/recoveryCode';
import { applyRetention } from '../services/threadArchive';
import { bareRemote, fixtureGit } from './helpers/gitFixtures';
import { chain, entryIds, machine, type Machine } from './helpers/syncFixtures';

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
