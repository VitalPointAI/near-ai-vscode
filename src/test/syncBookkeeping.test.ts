import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { generateRecoveryCode } from '../domain/state/recoveryCode';
import { StateSync, syncOwnerFor } from '../services/stateSync';
import { StateTransport } from '../services/stateTransport';
import { bareRemote, fixtureGit, hermeticRunner, mirrorPaths } from './helpers/gitFixtures';
import { SIX_TURNS, chain, machine, treeHash, type Machine } from './helpers/syncFixtures';

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
