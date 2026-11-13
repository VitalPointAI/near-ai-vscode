import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { openObject } from '../domain/state/objects';
import type { AgentMessage } from '../services/nearAiClient';
import { stateHomeFor } from '../services/stateHome';
import { stateKeysFor } from '../services/stateKeys';
import { applyRetention } from '../services/threadArchive';
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
