import assert from 'node:assert/strict';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { openObject } from '../domain/state/objects';
import { entryId, type ThreadEntry } from '../domain/state/threadEntries';
import type { AgentMessage } from '../services/nearAiClient';
import { stateHomeFor } from '../services/stateHome';
import { stateKeysFor } from '../services/stateKeys';
import { applyRetention, reconcileArchives } from '../services/threadArchive';
import { ThreadStore } from '../services/threadStore';
import type { Transcript } from '../services/transcripts';
import { MemorySecrets, tempProject } from './helpers/stateFixtures';

// Phase 27, plan 07 (SYNC-01, D-08): the threads beyond the most recently used few are archived inside the state home, never deleted, and come back
// whole and live when opened. Each test works on a temporary project folder with a clock the test sets, so the order of use is exact.

interface Clock { now: Date }
const minute = (n: number): Date => new Date(Date.UTC(2026, 10, 1, 0, n));
const idOf = (n: number): string => `conv-arc-${String(n).padStart(4, '0')}`;

function storeFor(root: string, clock: Clock, secrets = new MemorySecrets(), writer = 'edA.1'): ThreadStore {
  return new ThreadStore(stateHomeFor(root), stateKeysFor(root, secrets), { writer, now: () => clock.now });
}

/** A thread of two typed messages with a tool step between, last used at minute n. */
async function addThread(store: ThreadStore, clock: Clock, n: number, turns = 2): Promise<string> {
  clock.now = minute(n);
  const id = idOf(n);
  const messages: AgentMessage[] = [{ role: 'system', content: 'You are an agent.' }];
  for (let turn = 1; turn <= turns; turn += 1) {
    messages.push(
      { role: 'user', content: `Thread ${n} question ${turn}` },
      { role: 'assistant', content: null, tool_calls: [{ id: `c${n}-${turn}`, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: `f${turn}.md` }) } }] },
      { role: 'tool', tool_call_id: `c${n}-${turn}`, content: `contents ${n} ${turn} ${'x'.repeat(2_000)}` },
      { role: 'assistant', content: `Answer ${n} ${turn}` }
    );
  }
  const transcript: Transcript = { id, title: `Thread ${n} title`, model: 'm', updatedAt: clock.now.toISOString(), turns, messages, display: [] };
  await store.captureTranscript(transcript, new Map(), new WeakSet<AgentMessage>());
  await store.save(transcript);
  return id;
}

const exists = async (file: string): Promise<boolean> => Boolean(await stat(file).catch(() => undefined));
const archiveDir = (root: string, id: string): string => path.join(stateHomeFor(root).paths.archive, id);
const liveDir = (root: string, id: string): string => path.join(stateHomeFor(root).paths.threads, id);

test('the sixth thread archives the oldest: its live folder goes, the archive holds sealed parts, and it is listed archived with its title', async () => {
  const root = await tempProject();
  try {
    const clock: Clock = { now: minute(0) };
    const store = storeFor(root, clock);
    for (let n = 1; n <= 6; n += 1) await addThread(store, clock, n);
    const oldest = idOf(1);
    const before = (await store.entries(oldest)).map((entry) => entry.id);
    assert.ok(before.length >= 8, 'the oldest thread has its messages and tool steps');

    const result = await applyRetention(store, 5, []);
    assert.deepEqual(result.archived, [oldest]);
    assert.equal(await exists(liveDir(root, oldest)), false, 'the live folder is gone');
    const files = await readdir(archiveDir(root, oldest));
    assert.ok(files.includes('parts.json'));
    assert.ok(files.some((name) => name.endsWith('.bin')), 'at least one sealed part');

    const index = await store.index();
    assert.equal(index.length, 6, 'every thread is still listed');
    const archived = index.filter((item) => item.state === 'archived');
    assert.deepEqual(archived.map((item) => [item.id, item.title]), [[oldest, 'Thread 1 title']]);
    for (let n = 2; n <= 6; n += 1) assert.equal(await exists(liveDir(root, idOf(n))), true, `thread ${n} stays live`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('opening the archived thread returns every entry it had, makes it live, and the now-oldest live thread is archived in its place', async () => {
  const root = await tempProject();
  try {
    const clock: Clock = { now: minute(0) };
    const store = storeFor(root, clock);
    for (let n = 1; n <= 6; n += 1) await addThread(store, clock, n);
    const oldest = idOf(1);
    const before = await store.lines(oldest);
    await applyRetention(store, 5, []);
    assert.equal(await exists(liveDir(root, oldest)), false);

    clock.now = minute(100);
    const reopened = await store.lines(oldest);
    assert.deepEqual(reopened.main.map((entry) => entry.id), before.main.map((entry) => entry.id), 'the same entries in the same order');
    assert.deepEqual(reopened.main.map((entry) => entry.body), before.main.map((entry) => entry.body));
    assert.equal(await exists(liveDir(root, oldest)), true, 'it is live again');
    assert.equal(await exists(archiveDir(root, oldest)), false, 'its archive is removed once it is live');
    assert.equal((await store.load(oldest))?.title, 'Thread 1 title', 'its saved context came back too');

    const result = await applyRetention(store, 5, []);
    assert.deepEqual(result.archived, [idOf(2)], 'the lowest-ranked live thread is archived in its place');
    const state = new Map((await store.index()).map((item) => [item.id, item.state]));
    assert.equal(state.get(oldest), 'live');
    assert.equal(state.get(idOf(2)), 'archived');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the archive's parts open as bundle objects of class cold under the project's data key, and not as any other class", async () => {
  const root = await tempProject();
  try {
    const clock: Clock = { now: minute(0) };
    const secrets = new MemorySecrets();
    const store = storeFor(root, clock, secrets);
    for (let n = 1; n <= 6; n += 1) await addThread(store, clock, n);
    const count = (await store.entries(idOf(1))).length;
    await applyRetention(store, 5, []);
    const dir = archiveDir(root, idOf(1));
    const listed = JSON.parse(await readFile(path.join(dir, 'parts.json'), 'utf8')) as { parts: Array<{ file: string; bytes: number; sha256: string; part: number; of: number }> };
    const parts = await Promise.all(listed.parts.map(async (part) => ({ entry: { ...part, class: 'cold' as const }, data: await readFile(path.join(dir, part.file)) })));
    const dataKey = await stateKeysFor(root, secrets).dataKey();
    const meta = await stateHomeFor(root).readMeta();
    assert.ok(dataKey && meta);
    const bundle = openObject(dataKey, meta.stateId, 'cold', parts) as { entries: Array<{ id: string }>; meta: { id: string; title: string }; context: { id: string } | null };
    assert.equal(bundle.meta.id, idOf(1));
    assert.equal(bundle.meta.title, 'Thread 1 title');
    assert.equal(bundle.context?.id, idOf(1));
    assert.equal(bundle.entries.length, count, 'the archive holds every entry');
    const hotParts = parts.map((part) => ({ ...part, entry: { ...part.entry, class: 'hot' as const } }));
    assert.throws(() => openObject(dataKey, meta.stateId, 'hot', hotParts), 'a part sealed as cold does not open as another class');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- crash safety, never pruned, reopen by delta, refused archives ---------------------------------------------------------------------------

async function bigStore(count: number): Promise<{ root: string; clock: Clock; store: ThreadStore; secrets: MemorySecrets }> {
  const root = await tempProject();
  const clock: Clock = { now: minute(0) };
  const secrets = new MemorySecrets();
  const store = storeFor(root, clock, secrets);
  for (let n = 1; n <= count; n += 1) await addThread(store, clock, n);
  return { root, clock, store, secrets };
}

function lateEntry(thread: string, parent: string, text: string): ThreadEntry {
  const body = { text };
  return { id: entryId(parent, 'user', body), thread, parent, at: '2026-11-02T00:00:00.000Z', writer: 'edB.2', role: 'user', body };
}

const idsOf = (entries: ReadonlyArray<{ id: string }>): string[] => entries.map((entry) => entry.id).sort();

/** The thread's live folder as it is now, copied aside: putting it back after archiving is a crash between "archive written" and "live removed". */
async function keepLiveCopy(root: string, id: string): Promise<() => Promise<void>> {
  const aside = path.join(root, `.aside-${id}`);
  await cp(liveDir(root, id), aside, { recursive: true });
  return async () => { await cp(aside, liveDir(root, id), { recursive: true }); };
}

test('a crash after the archive is written but before the live files are removed: a live copy that adds nothing is finished, one that adds entries is made whole', async () => {
  const { root, clock, store, secrets } = await bigStore(6);
  try {
    const finished = idOf(1);
    const grown = idOf(2);
    const restoreFinished = await keepLiveCopy(root, finished);
    const restoreGrown = await keepLiveCopy(root, grown);
    const originalIds = { [finished]: idsOf(await store.entries(finished)), [grown]: idsOf(await store.entries(grown)) };
    assert.deepEqual((await applyRetention(store, 4, [])).archived.sort(), [finished, grown]);
    await restoreFinished();
    await restoreGrown();
    // thread 2 was also used on the live side after the archive was taken
    const next = storeFor(root, clock, secrets, 'edB.2');
    const tip = (await next.lines(grown)).main.at(-1)?.id ?? '';
    await next.appendEntries(grown, [lateEntry(grown, tip, 'a message written after the archive')]);

    const restart = storeFor(root, clock, secrets, 'edB.2');
    const settled = await reconcileArchives(restart);
    assert.deepEqual(settled.sort(), [finished, grown]);
    assert.equal(await exists(liveDir(root, finished)), false, 'nothing was added live: the archive is finished');
    assert.equal(await exists(archiveDir(root, finished)), true);
    assert.equal(await exists(liveDir(root, grown)), true, 'entries only the live copy had: the thread is live, with the union');
    assert.equal(await exists(archiveDir(root, grown)), false);
    assert.deepEqual(idsOf(await restart.entries(finished)), originalIds[finished], 'no entry lost (reading brings it live)');
    const grownIds = idsOf(await restart.entries(grown));
    assert.ok(originalIds[grown].every((entryIdValue) => grownIds.includes(entryIdValue)) && grownIds.length === originalIds[grown].length + 1, 'every old entry and the new one');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a crash in the middle of removing the live files (log removed, meta kept) leaves a complete live thread and loses no entry', async () => {
  const { root, clock, store, secrets } = await bigStore(6);
  try {
    const id = idOf(1);
    const restore = await keepLiveCopy(root, id);
    const original = idsOf(await store.entries(id));
    await applyRetention(store, 5, []);
    await restore();
    await rm(path.join(liveDir(root, id), 'log.jsonl'));
    assert.equal(await exists(path.join(liveDir(root, id), 'meta.enc')), true);

    const restart = storeFor(root, clock, secrets, 'edB.2');
    assert.deepEqual(await reconcileArchives(restart), [id]);
    assert.equal(await exists(path.join(liveDir(root, id), 'log.jsonl')), true, 'the log is back');
    assert.deepEqual(idsOf(await restart.liveEntries(id)), original);
    assert.equal((await restart.load(id))?.title, 'Thread 1 title');
    assert.equal(await exists(archiveDir(root, id)), false);
    // a log, context and meta all removed but the empty folder kept is the same crash a step later
    assert.equal((await restart.index()).find((item) => item.id === id)?.state, 'live');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a thread that must stay live (open in a tab) is made live again by reconcile instead of being finished', async () => {
  const { root, clock, store, secrets } = await bigStore(6);
  try {
    const id = idOf(1);
    const restore = await keepLiveCopy(root, id);
    await applyRetention(store, 5, []);
    await restore();
    const restart = storeFor(root, clock, secrets, 'edB.2');
    assert.deepEqual(await reconcileArchives(restart, [id]), [id]);
    assert.equal(await exists(liveDir(root, id)), true);
    assert.equal(await exists(archiveDir(root, id)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sixty threads with five live leave sixty listed threads, fifty-five archived, and every archived thread has a complete archive', { timeout: 120_000 }, async () => {
  const { root, store } = await bigStore(60);
  try {
    const result = await applyRetention(store, 5, []);
    assert.equal(result.archived.length, 55);
    const index = await store.index();
    assert.equal(index.length, 60, 'nothing is dropped from the list');
    assert.equal(index.filter((item) => item.state === 'archived').length, 55);
    assert.deepEqual(index.slice(0, 5).map((item) => item.id), [60, 59, 58, 57, 56].map(idOf), 'the live ones are the five most recently used');
    for (const item of index) {
      if (item.state === 'archived') {
        assert.equal(await exists(liveDir(root, item.id)), false);
        assert.equal(await exists(path.join(archiveDir(root, item.id), 'parts.json')), true, `${item.id} has its archive`);
      } else assert.equal(await exists(path.join(liveDir(root, item.id), 'log.jsonl')), true);
    }
    assert.equal((await applyRetention(store, 5, [])).archived.length, 0, 'a second pass changes nothing');
    assert.equal((await store.index()).length, 60);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a delta file next to an archive is folded in when the thread is opened, and the archive's own entries are all there too", async () => {
  const { root, store } = await bigStore(6);
  try {
    const id = idOf(1);
    const original = idsOf(await store.entries(id));
    const tip = (await store.lines(id)).main.at(-1)?.id ?? '';
    await applyRetention(store, 5, []);
    const late = lateEntry(id, tip, 'continued on another computer while archived');
    await store.appendArchiveDelta(id, [late]);
    assert.ok(await exists(path.join(archiveDir(root, id), 'delta.jsonl')));
    const opened = await store.lines(id);
    assert.deepEqual(idsOf(opened.main), [...original, late.id].sort());
    assert.equal(opened.main.at(-1)?.id, late.id);
    assert.equal(await exists(archiveDir(root, id)), false, 'the archive and its delta go once the thread is live');
    assert.equal((await store.index()).find((item) => item.id === id)?.state, 'live');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a modified archive is refused: nothing is read from it, nothing is removed, and the thread stays archived', async () => {
  const { root, store } = await bigStore(6);
  try {
    const id = idOf(1);
    await applyRetention(store, 5, []);
    const dir = archiveDir(root, id);
    const bin = (await readdir(dir)).find((name) => name.endsWith('.bin')) as string;
    const bytes = await readFile(path.join(dir, bin));
    bytes[bytes.length - 1] ^= 0xff;
    await writeFile(path.join(dir, bin), bytes);
    assert.deepEqual(await store.entries(id), []);
    assert.equal(await store.load(id), undefined);
    assert.equal(await exists(dir), true, 'the archive is kept');
    assert.equal(await exists(liveDir(root, id)), false);
    assert.equal((await store.index()).find((item) => item.id === id)?.state, 'archived');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an archive of another thread put in this thread's folder is refused", async () => {
  const { root, store } = await bigStore(3);
  try {
    await applyRetention(store, 1, []);
    await rm(archiveDir(root, idOf(2)), { recursive: true });
    await cp(archiveDir(root, idOf(1)), archiveDir(root, idOf(2)), { recursive: true });
    assert.deepEqual(await store.entries(idOf(2)), [], 'its entries name another thread');
    assert.equal(await exists(archiveDir(root, idOf(2))), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a thread used while its archive was being made is not removed: the live files are kept when they changed since the snapshot', async () => {
  const { root, store } = await bigStore(2);
  try {
    const id = idOf(1);
    const snapshot = await store.liveSnapshot(id);
    assert.ok(snapshot);
    const tip = (await store.lines(id)).main.at(-1)?.id ?? '';
    await store.appendEntries(id, [lateEntry(id, tip, 'typed while archiving')]);
    assert.equal(await store.removeLive(id, snapshot), false);
    assert.equal(await exists(path.join(liveDir(root, id), 'log.jsonl')), true);
    assert.equal((await store.liveEntries(id)).length, snapshot.entries.length + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lowering the setting archives more and raising it brings them back without making them the most recently used', async () => {
  const { root, store } = await bigStore(8);
  try {
    const before = new Map((await store.index()).map((item) => [item.id, item.lastUsedAt]));
    assert.equal((await applyRetention(store, 2, [])).archived.length, 6);
    assert.equal((await store.index()).filter((item) => item.state === 'archived').length, 6);
    const back = await applyRetention(store, 5, []);
    assert.deepEqual(back.restored.sort(), [idOf(6), idOf(5), idOf(4)].sort(), 'the three most recent of the archived ones');
    const index = await store.index();
    assert.equal(index.filter((item) => item.state === 'live').length, 5);
    for (const item of index) assert.equal(item.lastUsedAt, before.get(item.id), `${item.id} keeps its last use`);
    assert.equal(await exists(liveDir(root, idOf(1))), false, 'older ones stay archived');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a thread that is open or running stays live whatever its rank, in addition to the live count', async () => {
  const { root, store } = await bigStore(8);
  try {
    const result = await applyRetention(store, 5, [idOf(1)]);
    assert.deepEqual(result.archived.sort(), [idOf(2), idOf(3)].sort());
    assert.equal(await exists(liveDir(root, idOf(1))), true);
    assert.equal((await store.index()).filter((item) => item.state === 'live').length, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('no thread is archived or opened by a store that cannot open the project (no key): nothing is created or removed', async () => {
  const { root, clock, store } = await bigStore(3);
  try {
    const stranger = storeFor(root, clock, new MemorySecrets(), 'edC.3');
    // The key file in the project would open it; remove the file so only a recovery code could.
    await rm(stateHomeFor(root).paths.localKey, { force: true });
    const result = await applyRetention(stranger, 1, []);
    assert.deepEqual(result, { archived: [], restored: [] });
    for (let n = 1; n <= 3; n += 1) assert.equal(await exists(path.join(liveDir(root, idOf(n)), 'log.jsonl')), true);
    assert.equal(await exists(stateHomeFor(root).paths.archive), false);
    void store;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('when the archive cannot be written the live thread is untouched: nothing is removed before an archive exists and has been checked', async () => {
  const { root, store } = await bigStore(6);
  try {
    const id = idOf(1);
    const before = idsOf(await store.liveEntries(id));
    await mkdir(stateHomeFor(root).paths.archive, { recursive: true });
    await writeFile(archiveDir(root, id), 'in the way');
    const result = await applyRetention(store, 5, []);
    assert.deepEqual(result.archived, []);
    assert.deepEqual(idsOf(await store.liveEntries(id)), before);
    assert.equal(await exists(path.join(liveDir(root, id), 'meta.enc')), true);
    assert.equal(await exists(path.join(liveDir(root, id), 'context.enc')), true);
    assert.equal((await store.index()).find((item) => item.id === id)?.state, 'live');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
