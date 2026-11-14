import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { generateRecoveryCode } from '../domain/state/recoveryCode';
import { generationOf } from '../services/stateKeys';
import { readProjectChoicesSync, writeProjectChoice } from '../services/modelChoices';
import { wrapIdOf, StateSync, syncOwnerFor } from '../services/stateSync';
import { StateTransport } from '../services/stateTransport';
import { applyRetention } from '../services/threadArchive';
import { bareRemote, fixtureGit, hermeticRunner, mirrorPaths } from './helpers/gitFixtures';
import { SIX_TURNS, chain, entryIds, machine, remoteManifest, treeHash, type Machine } from './helpers/syncFixtures';

// Phase 27, plan 30 (REVIEW MAJOR stateSync.ts:226, BLOCKER stateSync.ts:417): sync bookkeeping has one owner per project folder on this computer, held
// with a cross-process lock; the bookkeeping resets when the remote's history is gone or rewritten. Real git against local bare remotes; no network.

const THREAD = 'conv-bookkeep01';
const REF = 'refs/heads/near-ai/state';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A computer with a recovery code and one thread, not synced yet. */
async function lonely(remote: string, name = 'alpha', options: Parameters<typeof machine>[2] = {}): Promise<{ a: Machine; bytes: Buffer }> {
  const a = await machine(remote, name, options);
  const { bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  await a.threads.create({ id: THREAD, title: 'Bookkeeping', model: 'near/model-a', origin: 'panel' });
  await a.threads.appendEntries(THREAD, chain(THREAD, a.writer, SIX_TURNS));
  return { a, bytes };
}

/** Another StateSync over the same project folder, as the scheduler or a command builds one: its own transport and mirror, every call recorded under `label`. */
async function second(of: Machine, remote: string, label: string, log: string[], delayMs = 0): Promise<StateSync> {
  const paths = await mirrorPaths(`near-ai-mirror-${label}-`);
  const transport = new StateTransport({ root: of.root, mirrorDir: paths.mirrorDir, hooksDir: paths.hooksDir, git: hermeticRunner() });
  record(transport, label, log, delayMs);
  void remote;
  return new StateSync({
    root: of.root, home: of.home, keys: of.keys, threads: of.threads, transport, writer: of.writer, sleep: () => Promise.resolve(), random: () => 0, registerColdFetcher: false
  });
}

/** Wraps every call a sync makes on a transport so the order of calls from two syncs can be read back. The first fetch waits, so two syncs started together would overlap if nothing held them apart. */
function record(transport: StateTransport, label: string, log: string[], delayMs: number): void {
  for (const name of ['fetch', 'readTree', 'readBlob', 'writeCommit', 'push', 'currentTip', 'missingObjects'] as const) {
    const original = (transport[name] as (...args: unknown[]) => Promise<unknown>).bind(transport);
    (transport as unknown as Record<string, unknown>)[name] = async (...args: unknown[]): Promise<unknown> => {
      log.push(`${label}:${name}`);
      if (name === 'fetch' && delayMs > 0) await pause(delayMs);
      return original(...args);
    };
  }
}

const runsOf = (log: string[]): string[] => log.map((line) => line.split(':')[0] as string).filter((label, at, all) => at === 0 || all[at - 1] !== label);

test('tracer: two syncs of one project folder started together never overlap, and the second one finds nothing left to send', async () => {
  const remote = bareRemote({ withMain: false });
  const { a } = await lonely(remote);
  const log: string[] = [];
  record(a.transport, 'one', log, 60);
  const other = await second(a, remote, 'two', log, 60);
  assert.equal(syncOwnerFor(a.root), syncOwnerFor(a.root), 'one owner per folder');
  const [first, next] = await Promise.all([a.sync.sync(), other.sync()]);
  assert.equal(first.kind, 'synced', first.message);
  assert.equal(next.kind, 'synced', next.message);
  assert.equal(runsOf(log).length, 2, `one run, then the other, never interleaved: ${log.join(' ')}`);
  assert.deepEqual([first.pushed, next.pushed].sort(), [false, true], 'one pushed everything, the other had nothing left to send');
  const state = JSON.parse(await readFile(path.join(a.home.paths.sync, 'state.json'), 'utf8')) as { lastSeenSeq: number; pushed: Record<string, string[]> };
  assert.equal(state.lastSeenSeq, 1);
  assert.equal(state.pushed[THREAD]?.length, SIX_TURNS.length);
  assert.equal(fixtureGit(remote, ['rev-list', '--count', REF]).trim(), '1');
});

test('a sync that cannot get the lock held by another process in time says it is waiting, changes nothing, and the next sync after the release completes', async () => {
  const remote = bareRemote({ withMain: false });
  const { a } = await lonely(remote, 'alpha', { extra: { lockTimings: { waitMs: 120 } } });
  const release = path.join(a.root, 'release-the-lock');
  const locks = path.join(__dirname, '..', 'services', 'stateLocks.js');
  const child = spawn(process.execPath, ['-e', `
const fs = require('node:fs');
const { withStateLock } = require(${JSON.stringify(locks)});
withStateLock(${JSON.stringify(a.root)}, 'sync', async () => {
  process.stdout.write('held\\n');
  while (!fs.existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 20));
}).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
`], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('exit', (code) => reject(new Error(`the child ended early with ${String(code)}`)));
    });
    const before = treeHash(a.home.dir);
    const waiting = await a.sync.sync();
    assert.equal(waiting.kind, 'waiting', waiting.message);
    assert.equal(treeHash(a.home.dir), before, 'no file of the state home changed');
    assert.equal(fixtureGit(remote, ['for-each-ref', REF]).trim(), '', 'nothing was pushed');
    await writeFile(release, 'go');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const done = await a.sync.sync();
    assert.equal(done.kind, 'synced', done.message);
    assert.equal(done.pushed, true);
  } finally {
    child.kill();
  }
});

test('pullOnly, remoteState and fetchColdThread take the same owner: started during a sync, they wait for it', async () => {
  const remote = bareRemote({ withMain: false });
  const { a } = await lonely(remote);
  const log: string[] = [];
  record(a.transport, 'sync', log, 80);
  const other = await second(a, remote, 'other', log);
  const running = a.sync.sync();
  await pause(20);
  const results = await Promise.all([other.pullOnly(), other.remoteState(), other.fetchColdThread('conv-notcold001')]);
  assert.equal((await running).kind, 'synced');
  assert.equal(results[0].kind, 'synced');
  assert.equal(results[1].ok, true);
  assert.deepEqual(runsOf(log), ['sync', 'other'], `everything the others did came after the sync: ${log.join(' ')}`);
});

// ---- the reset rule (Task 3) -----------------------------------------------------------------------------------------------------------

const idOf = (n: number): string => `conv-bookkeep${String(n).padStart(2, '0')}`;
const NAMES = ['plan the release', 'review the diff', 'write the notes'];
const stateOf = async (m: Machine): Promise<Record<string, unknown>> => JSON.parse(await readFile(path.join(m.home.paths.sync, 'state.json'), 'utf8')) as Record<string, unknown>;

/** Three threads on the computer, a project choice, and a sync that went up. */
async function threeThreads(m: Machine, from: number): Promise<void> {
  for (let n = from; n < from + 3; n += 1) {
    await m.threads.create({ id: idOf(n), title: `Thread ${n}`, model: 'near/model-a', origin: 'panel' });
    await m.threads.appendEntries(idOf(n), chain(idOf(n), m.writer, [['user', `${NAMES[n - from]} ${n}`], ['assistant', `done ${n}`], ['user', `and then ${n}`], ['assistant', `finished ${n}`]]));
  }
}

/** A and B over one remote with sync on, both holding what the other made; C is a third computer that has not opened it yet. */
async function pairWithThreads(): Promise<{ remote: string; a: Machine; b: Machine; bytes: Buffer }> {
  const remote = bareRemote({ withMain: false });
  const a = await machine(remote, 'alpha');
  const b = await machine(remote, 'bravo');
  const { bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  await threeThreads(a, 1);
  await writeProjectChoice(a.root, 'nearAi.defaultModel', 'near/chosen-on-a', a.writer);
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal((await b.sync.unlockFromRemote(bytes)).kind, 'synced');
  assert.equal((await b.sync.sync()).kind, 'synced');
  await threeThreads(b, 4);
  assert.equal((await b.sync.sync()).kind, 'synced');
  assert.equal((await a.sync.sync()).kind, 'synced');
  return { remote, a, b, bytes };
}

async function everything(m: Machine): Promise<string[]> {
  const out: string[] = [];
  for (let n = 1; n <= 6; n += 1) out.push(`${idOf(n)}:${(await entryIds(m, idOf(n))).join(',')}`);
  return out;
}

test('the state branch is deleted and restored from a computer: it syncs, the other computer is not refused and ends with everything, a fresh computer opens every thread, and further syncs send nothing', async () => {
  const { remote, a, b, bytes } = await pairWithThreads();
  const expected = await everything(a);
  assert.deepEqual(await everything(b), expected);
  assert.ok(expected.every((line) => line.split(':')[1]?.split(',').length === 4), 'every thread holds its four entries');
  const seqBefore = (await remoteManifest(remote, a)).seq;

  fixtureGit(remote, ['update-ref', '-d', REF]);
  assert.equal(fixtureGit(remote, ['for-each-ref', REF]).trim(), '');
  const restored = await a.sync.sync();
  assert.equal(restored.kind, 'synced', restored.message);
  assert.equal(restored.pushed, true, 'everything A holds went up again');
  const after = await remoteManifest(remote, a);
  assert.ok(after.seq > seqBefore, 'the new manifest is above every sequence seen before');

  const joined = await b.sync.sync();
  assert.equal(joined.kind, 'synced', `B is not refused: ${joined.message}`);
  assert.deepEqual(await everything(b), expected, 'B holds every entry of every thread');
  assert.equal(readProjectChoicesSync(b.root)['nearAi.defaultModel']?.value, 'near/chosen-on-a');

  const c = await machine(remote, 'charlie');
  assert.equal((await c.sync.unlockFromRemote(bytes)).kind, 'synced');
  assert.equal((await c.sync.pullOnly()).kind, 'synced');
  assert.deepEqual(await everything(c), expected, 'a fresh computer opens every thread in full');

  assert.equal((await a.sync.sync()).pushed, false);
  assert.equal((await b.sync.sync()).pushed, false);
  assert.equal((await a.sync.sync()).pushed, false);
});

test('origin is re-pointed at a new empty repository: a full state goes up from one computer, the other, pointed at it too, syncs without refusal, and nothing is lost', async () => {
  const { a, b, bytes } = await pairWithThreads();
  const expected = await everything(a);
  const replacement = bareRemote({ withMain: false });
  const before = (await stateOf(a))['remoteId'];
  assert.match(String(before), /^[0-9a-f]{16}$/, 'the bookkeeping names the remote it is about');
  fixtureGit(a.root, ['remote', 'set-url', 'origin', replacement]);
  fixtureGit(b.root, ['remote', 'set-url', 'origin', replacement]);

  const up = await a.sync.sync();
  assert.equal(up.kind, 'synced', up.message);
  assert.equal(up.pushed, true);
  assert.notEqual((await stateOf(a))['remoteId'], before, 'the bookkeeping follows the new address');
  const down = await b.sync.sync();
  assert.equal(down.kind, 'synced', down.message);
  assert.deepEqual(await everything(b), expected);
  assert.equal((await a.sync.sync()).pushed, false);
  assert.equal((await b.sync.sync()).pushed, false);
  const c = await machine(replacement, 'charlie');
  assert.equal((await c.sync.unlockFromRemote(bytes)).kind, 'synced');
  assert.equal((await c.sync.pullOnly()).kind, 'synced');
  assert.deepEqual(await everything(c), expected, 'a fresh computer opens every thread from the new repository');
  assert.ok(fixtureGit(replacement, ['rev-list', '--count', REF]).trim() >= '1');
});

test('the remote branch is moved back to an older commit: the sync is not refused, nothing is lost, the new manifest is above every sequence seen, and the older header\'s wrap is not adopted', async () => {
  const { remote, a, b, bytes } = await pairWithThreads();
  const older = fixtureGit(remote, ['rev-parse', REF]).trim();
  const olderWrap = wrapIdOf((await a.keys.readRecoveryWrap()) as NonNullable<Awaited<ReturnType<typeof a.keys.readRecoveryWrap>>>);
  // A new code made on A goes up, then more is saved.
  await new Promise((resolve) => setTimeout(resolve, 8));
  const made = await a.keys.writeRecoveryWrap(bytes);
  assert.equal((await a.sync.sync()).kind, 'synced');
  await a.threads.appendEntries(idOf(1), chain(idOf(1), a.writer, [['user', 'after the new code'], ['assistant', 'noted']], (await a.threads.lines(idOf(1))).main.at(-1)?.id ?? null));
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal((await b.sync.sync()).kind, 'synced');
  const expected = await everything(a);
  const seqSeen = (await remoteManifest(remote, a)).seq;
  assert.notEqual(wrapIdOf(made), olderWrap);

  fixtureGit(remote, ['update-ref', REF, older]);
  const synced = await a.sync.sync();
  assert.equal(synced.kind, 'synced', synced.message);
  assert.deepEqual(await everything(a), expected, 'the union keeps every entry A held');
  const after = await remoteManifest(remote, a);
  assert.ok(after.seq > seqSeen, `the new manifest (${after.seq}) is above every sequence seen (${seqSeen})`);
  assert.equal(wrapIdOf((await a.keys.readRecoveryWrap()) as NonNullable<Awaited<ReturnType<typeof a.keys.readRecoveryWrap>>>), wrapIdOf(made), 'the older wrap was not adopted');
  assert.equal(generationOf(await a.keys.readRecoveryWrap()), generationOf(made));
  const header = JSON.parse(fixtureGit(remote, ['show', `${REF}:manifest.json`])) as { kdf: unknown; wrappedKey: unknown };
  assert.equal(wrapIdOf(header as never), wrapIdOf(made), 'the remote carries the newer wrap again');
  const bAfter = await b.sync.sync();
  assert.equal(bAfter.kind, 'synced', `B is not refused: ${bAfter.message}`);
  assert.deepEqual(await everything(b), expected);
});

test('a sync/state.json from an earlier build (no last tip, no remote id) syncs normally and afterwards holds both', async () => {
  const { a } = await pairWithThreads();
  const file = path.join(a.home.paths.sync, 'state.json');
  const old = await stateOf(a);
  assert.ok(typeof old['lastTip'] === 'string' && typeof old['remoteId'] === 'string', 'a current build records both');
  delete old['lastTip'];
  delete old['remoteId'];
  await writeFile(file, `${JSON.stringify(old)}\n`);
  const synced = await a.sync.sync();
  assert.equal(synced.kind, 'synced', synced.message);
  assert.equal(synced.pushed, false, 'nothing was sent again');
  const now = await stateOf(a);
  assert.match(String(now['lastTip']), /^[0-9a-f]{40}$/);
  assert.match(String(now['remoteId']), /^[0-9a-f]{16}$/);
  assert.equal(now['lastTip'], fixtureGit(a.mirrorDir, ['--git-dir', a.mirrorDir, 'rev-parse', 'refs/near-ai/incoming']).trim());
});

test('an archived conversation this computer holds only as an online entry stays listed when the branch is gone, and the outcome says how many could not be sent again', async () => {
  const remote = bareRemote({ withMain: false });
  fixtureGit(remote, ['config', 'uploadpack.allowFilter', 'true']);
  const a = await machine(remote, 'alpha');
  const b = await machine(remote, 'bravo');
  const { bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  for (let n = 1; n <= 6; n += 1) {
    await a.threads.create({ id: idOf(n), title: `Thread ${n}`, model: 'near/model-a', origin: 'panel' });
    await a.threads.appendEntries(idOf(n), chain(idOf(n), a.writer, [['user', `question ${n}`], ['assistant', `answer ${n}`]]));
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  const retained = await applyRetention(a.threads, 5, []);
  assert.deepEqual(retained.archived, [idOf(1)]);
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal((await b.sync.unlockFromRemote(bytes)).kind, 'synced');
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
  assert.ok((await b.threads.index()).some((item) => item.id === idOf(1) && item.state === 'archived'), 'B lists the archived conversation, kept online');

  fixtureGit(remote, ['update-ref', '-d', REF]);
  const gone = await b.sync.sync();
  assert.equal(gone.kind, 'synced', gone.message);
  assert.match(gone.message, /1 conversation kept only online could not be sent again from this computer/);
  assert.ok((await b.threads.index()).some((item) => item.id === idOf(1)), 'it stays listed');
  // The computer that holds the archive sends it again, and then B can open it.
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal((await b.sync.sync()).kind, 'synced');
  assert.equal((await b.threads.entries(idOf(1))).length, 2);
});
