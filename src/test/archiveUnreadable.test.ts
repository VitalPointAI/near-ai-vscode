import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ArchiveUnreadableError, archiveProblemText, type ArchiveProblemReason } from '../domain/state/archiveProblem';
import { generateRecoveryCode } from '../domain/state/recoveryCode';
import { entryId, type ThreadEntry } from '../domain/state/threadEntries';
import type { AgentMessage } from '../services/nearAiClient';
import { stateHomeFor } from '../services/stateHome';
import { stateKeysFor } from '../services/stateKeys';
import { applyRetention } from '../services/threadArchive';
import { ThreadStore, historyItems } from '../services/threadStore';
import type { Transcript } from '../services/transcripts';
import { bareRemote } from './helpers/gitFixtures';
import { MemorySecrets, tempProject } from './helpers/stateFixtures';
import { chain, machine, treeHash } from './helpers/syncFixtures';

// Phase 27, plan 13 (carry-forward from plan 07, D-08, SYNC-01): an archive that is refused or damaged (a modified part, another thread's archive, a
// missing part, or no key on this computer) is explained in plain words, never shown as an empty conversation, and never saved over. Its files are not
// touched: the whole state home is byte-identical after every attempt to open it or write to it.

const minute = (n: number): Date => new Date(Date.UTC(2026, 10, 1, 0, n));
const idOf = (n: number): string => `conv-unr-${String(n).padStart(4, '0')}`;

function storeFor(root: string, now: Date, secrets = new MemorySecrets()): ThreadStore {
  return new ThreadStore(stateHomeFor(root), stateKeysFor(root, secrets), { writer: 'edA.1', now: () => now });
}

function transcriptOf(n: number, now: Date): Transcript {
  const messages: AgentMessage[] = [{ role: 'system', content: 'You are an agent.' }, { role: 'user', content: `Thread ${n} question` }, { role: 'assistant', content: `Answer ${n}` }];
  return { id: idOf(n), title: `Thread ${n} title`, model: 'm', updatedAt: now.toISOString(), turns: 1, messages, display: [] };
}

/** Three threads, the two oldest archived (threads 1 and 2 are in the archive folder). */
async function archivedStore(): Promise<{ root: string; store: ThreadStore }> {
  const root = await tempProject();
  let now = minute(0);
  const store = new ThreadStore(stateHomeFor(root), stateKeysFor(root, new MemorySecrets()), { writer: 'edA.1', now: () => now });
  for (let n = 1; n <= 3; n += 1) {
    now = minute(n);
    const transcript = transcriptOf(n, now);
    await store.captureTranscript(transcript, new Map(), new WeakSet<AgentMessage>());
    await store.save(transcript);
  }
  assert.deepEqual((await applyRetention(store, 1, [])).archived.sort(), [idOf(1), idOf(2)]);
  return { root, store };
}

const home = (root: string): string => stateHomeFor(root).dir;
const archiveOf = (root: string, id: string): string => path.join(stateHomeFor(root).paths.archive, id);

/** The archive's own files (not the delta file a sync may add beside it), by name and content. */
async function archiveHash(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const name of (await readdir(dir)).filter((file) => file !== 'delta.jsonl').sort()) hash.update(name).update(await readFile(path.join(dir, name)));
  return hash.digest('hex');
}

function lateEntry(id: string): ThreadEntry {
  const body = { text: 'typed after the archive was refused' };
  return { id: entryId(null, 'user', body), thread: id, parent: null, at: minute(30).toISOString(), writer: 'edA.1', role: 'user', body };
}

/** Everything a person or a run could do with the thread: none of it opens it, explains why, and changes a byte. */
async function assertClosed(root: string, store: ThreadStore, id: string, reason: ArchiveProblemReason): Promise<void> {
  const before = treeHash(home(root));
  assert.deepEqual(await store.prepareOpen(id), { reason }, 'the reason is named');
  assert.deepEqual(await store.entries(id), [], 'no entries are shown');
  assert.equal(await store.load(id), undefined, 'there is no conversation to continue');
  const listed = (await store.index()).find((item) => item.id === id);
  if (reason !== 'needs-recovery-code') {
    assert.equal(listed?.state, 'archived', 'it is still listed archived');
    assert.match(historyItems(await store.index()).find((item) => item.id === id)?.description ?? '', /Archived/);
  }
  const wrong = (error: unknown): boolean => error instanceof ArchiveUnreadableError && error.reason === reason && error.message === archiveProblemText(reason);
  await assert.rejects(store.appendEntries(id, [lateEntry(id)]), wrong, 'an empty view cannot be saved over it: appendEntries');
  await assert.rejects(store.save(transcriptOf(Number(id.slice(-4)), minute(31))), wrong, 'save');
  await assert.rejects(store.checkpoint(transcriptOf(Number(id.slice(-4)), minute(32))), wrong, 'checkpoint');
  await assert.rejects(store.captureTranscript(transcriptOf(Number(id.slice(-4)), minute(33)), new Map(), new WeakSet<AgentMessage>()), wrong, 'captureTranscript');
  assert.equal(treeHash(home(root)), before, 'the state home is byte-identical: the archive, the index and the live folders');
}

test('a modified archive part opens as a plain notice, not an empty thread, and is never saved over', async () => {
  const { root, store } = await archivedStore();
  try {
    const dir = archiveOf(root, idOf(1));
    const part = (await readdir(dir)).find((name) => name.endsWith('.bin')) as string;
    const bytes = await readFile(path.join(dir, part));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
    await writeFile(path.join(dir, part), bytes);
    await assertClosed(root, store, idOf(1), 'damaged');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an archive of another thread put in this thread's folder opens as a plain notice and is never saved over", async () => {
  const { root, store } = await archivedStore();
  try {
    await rm(archiveOf(root, idOf(2)), { recursive: true });
    await cp(archiveOf(root, idOf(1)), archiveOf(root, idOf(2)), { recursive: true });
    await assertClosed(root, store, idOf(2), 'damaged');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an archive with a missing part opens as a plain notice and is never saved over', async () => {
  const { root, store } = await archivedStore();
  try {
    const dir = archiveOf(root, idOf(1));
    await rm(path.join(dir, (await readdir(dir)).find((name) => name.endsWith('.bin')) as string));
    await assertClosed(root, store, idOf(1), 'damaged');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('on a computer with no key for the project, the archive is explained as needing the recovery code, and nothing is written', async () => {
  const { root } = await archivedStore();
  try {
    await rm(stateHomeFor(root).paths.localKey, { force: true });
    const stranger = storeFor(root, minute(40));
    await assertClosed(root, stranger, idOf(1), 'needs-recovery-code');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the notices are plain words: what could not be opened, why, and that nothing was changed', () => {
  for (const reason of ['damaged', 'needs-recovery-code', 'offline'] as const) {
    const text = archiveProblemText(reason);
    assert.match(text, /conversation/i);
    assert.match(text, /nothing was changed|left exactly as it is/i);
    assert.doesNotMatch(text, /undefined|\[object|Error:|aead|sha256|manifest|object/i);
  }
  assert.match(archiveProblemText('damaged'), /damaged/);
  assert.match(archiveProblemText('needs-recovery-code'), /recovery code/);
});

test('a healthy archived thread is still brought back whole before anything is written to it', async () => {
  const { root, store } = await archivedStore();
  try {
    assert.equal(await store.prepareOpen(idOf(1)), undefined);
    await store.appendEntries(idOf(1), [lateEntry(idOf(1))]);
    const entries = await store.entries(idOf(1));
    assert.ok(entries.length >= 3, 'what it had before is still there');
    assert.ok(entries.some((entry) => entry.id === lateEntry(idOf(1)).id));
    assert.equal((await store.index()).find((item) => item.id === idOf(1))?.state, 'live');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a sync that brings entries for a thread whose archive is damaged does not fail and does not touch the archive', async () => {
  const remote = bareRemote({ withMain: false });
  const a = await machine(remote, 'alpha');
  const b = await machine(remote, 'bravo');
  const { bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  const id = idOf(50);
  await a.threads.create({ id, title: 'Continued elsewhere', model: 'near/model-a', origin: 'panel' });
  const first = chain(id, a.writer, [['user', 'first'], ['assistant', 'reply']]);
  await a.threads.appendEntries(id, first);
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal((await b.sync.unlockFromRemote(bytes)).kind, 'synced');
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await b.threads.create({ id: idOf(51), title: 'Newer', model: 'near/model-a', origin: 'panel' });
  await b.threads.appendEntries(idOf(51), chain(idOf(51), b.writer, [['user', 'newer']]));
  assert.deepEqual((await applyRetention(b.threads, 1, [])).archived, [id]);
  const dir = b.threads.archiveDirOf(id);
  const part = (await readdir(dir)).find((name) => name.endsWith('.bin')) as string;
  const damaged = await readFile(path.join(dir, part));
  damaged[damaged.length - 1] = (damaged[damaged.length - 1] as number) ^ 0xff;
  await writeFile(path.join(dir, part), damaged);
  const archiveBefore = await archiveHash(dir);

  const more = chain(id, a.writer, [['user', 'second'], ['assistant', 'another reply']], first[first.length - 1]?.id ?? null);
  await a.threads.appendEntries(id, more);
  assert.equal((await a.sync.sync()).kind, 'synced');
  const outcome = await b.sync.sync();
  assert.equal(outcome.kind, 'synced', outcome.message);
  assert.equal(await archiveHash(dir), archiveBefore, 'the damaged archive itself is exactly as it was');
  assert.deepEqual((await b.threads.archiveDeltaEntries(id)).map((entry) => entry.id).sort(), more.map((entry) => entry.id).sort(), 'what arrived waits beside it');
  assert.equal((await b.threads.prepareOpen(id))?.reason, 'damaged');
});
