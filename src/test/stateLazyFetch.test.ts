import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { generateRecoveryCode } from '../domain/state/recoveryCode';
import { applyRetention } from '../services/threadArchive';
import { bareRemote, fixtureGit } from './helpers/gitFixtures';
import { chain, entryIds, machine, remotePayloads, remoteManifest, replaceRemoteTree, remoteFiles, treeHash, type Machine } from './helpers/syncFixtures';

// Phase 27, plan 13 (SYNC-05, D-08, research flag 7): an archived thread travels as a cold object, a normal sync does not download it, and opening it
// fetches exactly its own parts. Real git against a local bare remote; no network is contacted.

const REF = 'refs/heads/near-ai/state';
const INCOMING = 'refs/near-ai/incoming';
const idOf = (n: number): string => `conv-lazy-${String(n).padStart(3, '0')}`;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3));

/** A bare remote that can filter (what GitHub and most hosts do). */
function filteringRemote(): string {
  const remote = bareRemote({ withMain: false });
  fixtureGit(remote, ['config', 'uploadpack.allowFilter', 'true']);
  return remote;
}

/** A thread of its own words, last used after every thread made before it. */
async function addThread(m: Machine, n: number, title = `Lazy thread ${n}`): Promise<string[]> {
  const id = idOf(n);
  await m.threads.create({ id, title, model: 'near/model-a', origin: 'panel' });
  const entries = chain(id, m.writer, [['user', `${title}: what changed`], ['assistant', `${title}: the answer`], ['user', `${title}: and then`], ['assistant', `${title}: done`]]);
  await m.threads.appendEntries(id, entries);
  await tick();
  return entries.map((entry) => entry.id);
}

/** A on one side with six threads and the oldest archived and pushed; B opened with the recovery code and pulled. */
async function archivedPair(remote: string): Promise<{ a: Machine; b: Machine; archived: string; ids: string[]; lines: string[] }> {
  const a = await machine(remote, 'alpha');
  const b = await machine(remote, 'bravo');
  const { bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  const ids = await addThread(a, 1, 'The oldest conversation');
  for (let n = 2; n <= 6; n += 1) await addThread(a, n);
  const lines = (await a.threads.lines(idOf(1))).main.map((entry) => entry.id);
  const retained = await applyRetention(a.threads, 5, []);
  assert.deepEqual(retained.archived, [idOf(1)], 'the oldest of six is archived');
  const pushed = await a.sync.sync();
  assert.equal(pushed.kind, 'synced', pushed.message);
  assert.equal((await b.sync.unlockFromRemote(bytes)).kind, 'synced');
  const pulled = await b.sync.pullOnly();
  assert.equal(pulled.kind, 'synced', pulled.message);
  return { a, b, archived: idOf(1), ids, lines };
}

/** The blob ids the remote's tree holds for the parts of an archive. */
async function coldBlobs(remote: string, a: Machine, id: string): Promise<{ names: string[]; oids: string[] }> {
  const parts = JSON.parse(await readFile(path.join(a.threads.archiveDirOf(id), 'parts.json'), 'utf8')) as { parts: Array<{ file: string }> };
  const names = parts.parts.map((part) => part.file);
  const tree = new Map(fixtureGit(remote, ['ls-tree', REF]).split('\n').filter(Boolean).map((line) => { const [meta = '', name = ''] = line.split('\t'); return [name, meta.split(' ')[2] ?? ''] as const; }));
  return { names, oids: names.map((name) => tree.get(name) ?? '') };
}

const missingIn = (m: Machine): string[] => fixtureGit(m.mirrorDir, ['--git-dir', m.mirrorDir, 'rev-list', '--objects', `--missing=print`, INCOMING]).split('\n').filter((line) => line.startsWith('?')).map((line) => line.slice(1).trim());

test('tracer: an archived thread is pushed cold, listed on B without being downloaded, and fetched in full when B opens it', async () => {
  const remote = filteringRemote();
  const { a, b, archived, lines } = await archivedPair(remote);

  const manifest = await remoteManifest(remote, a);
  assert.ok(manifest.objects.some((entry) => entry.class === 'cold'), 'the archive went up as a cold object');
  const cold = await coldBlobs(remote, a, archived);
  assert.ok(cold.oids.every((oid) => /^[0-9a-f]{40}$/.test(oid)), 'the archive parts are in the remote tree under their own names, unchanged');

  // B lists the thread from the sealed index: its title, archived, kept online, with no archive folder here.
  const listed = (await b.threads.index()).find((item) => item.id === archived);
  assert.equal(listed?.title, 'The oldest conversation');
  assert.equal(listed?.state, 'archived');
  assert.equal(listed?.location, 'remote');
  assert.equal(listed?.turns, 2);
  assert.deepEqual(await readdir(b.home.paths.archive).catch(() => []), [], 'nothing of the archive was downloaded to the state home');
  assert.equal((await b.threads.index()).filter((item) => item.state === 'live').length, 5, 'the five live threads came with the sync');

  // The cold parts are exactly what git has not downloaded: everything else the sync read is here.
  const before = missingIn(b);
  assert.deepEqual([...before].sort(), [...cold.oids].sort(), 'rev-list --missing lists the cold blobs, and only them');
  assert.deepEqual([...(await b.transport.missingObjects())].sort(), [...cold.oids].sort(), 'the transport reports the same');

  // Opening it fetches those parts and shows the whole conversation.
  assert.equal((await b.threads.prepareOpen(archived)), undefined);
  assert.deepEqual((await b.threads.lines(archived)).main.map((entry) => entry.id), lines, 'B shows the same lines as A');
  assert.deepEqual(missingIn(b), [], 'its parts are now here');
  const opened = (await b.threads.index()).find((item) => item.id === archived);
  assert.equal(opened?.state, 'live', 'opening it makes it live on B');
  assert.deepEqual(await readdir(b.home.paths.archive).catch(() => []), [], 'the archive folder is gone once the thread is live');
  assert.equal((await b.threads.load(archived))?.title, 'The oldest conversation', 'its saved context came too');
});

test('a cold part changed on the remote is refused when the thread is opened: nothing is written and the thread is still listed', async () => {
  const remote = filteringRemote();
  const { a, b, archived } = await archivedPair(remote);
  const cold = await coldBlobs(remote, a, archived);
  const files = remoteFiles(remote);
  const target = files.get(cold.names[0] as string) as Buffer;
  const flipped = Buffer.from(target);
  flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 0xff;
  files.set(cold.names[0] as string, flipped);
  replaceRemoteTree(remote, files);
  // The sync does not read cold parts, so it takes the new tip without noticing: only opening the thread reads them.
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
  const untouched = treeHash(b.home.dir);

  const problem = await b.threads.prepareOpen(archived);
  assert.equal(problem?.reason, 'damaged');
  assert.deepEqual(await b.threads.entries(archived), [], 'nothing is shown for it');
  assert.equal(treeHash(b.home.dir), untouched, 'the state home is byte-identical: no archive file, no live thread');
  const still = (await b.threads.index()).find((item) => item.id === archived);
  assert.equal(still?.state, 'archived', 'it is still listed');
  assert.equal(still?.location, 'remote');
});

test('after B opens an archived thread, its next sync does not send the thread again', async () => {
  const remote = filteringRemote();
  const { b, archived, ids } = await archivedPair(remote);
  assert.deepEqual(await entryIds(b, archived), [...ids].sort());
  const pushed = await b.sync.sync();
  assert.equal(pushed.kind, 'synced', pushed.message);
  const hot = (await remotePayloads(remote, b)).filter((payload): payload is { entries: Record<string, unknown[]> } => typeof payload === 'object' && payload !== null && 'entries' in payload && 'records' in payload);
  assert.ok(hot.every((payload) => !(archived in payload.entries) || (payload.entries[archived] as unknown[]).length === 0), 'no hot object carries the entries the cold object already holds');
});
