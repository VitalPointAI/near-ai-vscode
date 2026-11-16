// Every window of one VS Code keeps a team's coordination mirror in the same folder (<globalStorage>/team/<teamId>/coordination.git), so two
// windows open on two folders of one team are two processes on one mirror. These tests put a second writer after every git step of an append, one
// step per round, so every interleaving of that step is checked deterministically instead of hoping a race happens:
// - a writer that changes the mirror without taking turns (it moves the mirror's refs directly, as an older version or a stopped lock holder
//   would) must never make the append land an event with a stale position, apply an entry twice or pause;
// - a second transport on the same mirror folder (another process; here the same folder reached by another path, which no in-process lock can
//   see) must wait for the first operation to end before it runs any git step of its own.
// The cross-process lock is then checked against a real second process that holds it, crashes holding it, or stops refreshing it.
// Found by teamConcurrency's shared-mirror test under load: two events with lamport 11 (debug session team-shared-mirror-duplicate-lamport).
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';
import test, { after } from 'node:test';
import { createOwner, createTeamFixture, gitIn, testGenesis } from './helpers/teamHarness';
import type { TeamFixture, TestOwner } from './helpers/teamHarness';
import { teamMaterializer } from '../domain/team/materialize';
import type { GenesisAnchor, TeamState } from '../domain/team/types';
import { TeamLog } from '../team/eventLog';
import type { EventIntent, TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport, INCOMING_REF, LOCAL_REF, MIRROR_BUSY_APPEND_REASON, MIRROR_BUSY_SYNC_REASON, TEAM_MIRROR_LOCK_FILE } from '../team/gitTransport';
import type { GitTransportOptions } from '../team/gitTransport';
import { newTeamId } from '../team/identity';
import type { LockChildMessage } from './helpers/mirrorLockChild';
import { runGit } from '../team/runGit';
import type { GitRunner } from '../team/runGit';
import type { AppendResult } from '../team/transport';

const INTENT: EventIntent = { type: 'member.availability', body: { availability: 'available' } };
const EVENT_FILE = /^events\/(\d{12})-evt-[0-9A-HJKMNP-TV-Z]{26}\.json$/;

interface Team { anchor: GenesisAnchor; owner: TestOwner; signer: TeamSigner }

function transportAt(fixture: TeamFixture, clone: string, mirrorDir: string, anchor: GenesisAnchor, extra: Partial<GitTransportOptions<TeamState>> = {}): GitTransport<TeamState> {
  return new GitTransport<TeamState>({
    mirrorDir, projectRoot: fixture.clones[clone] as string, remote: 'origin', ref: DEFAULT_COORDINATION_REF, materializer: teamMaterializer(anchor),
    maxRetries: 10, baseDelayMs: 5, ...extra
  });
}

async function seedTeam(fixture: TeamFixture): Promise<Team> {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const genesis = testGenesis({ teamId, owner, name: 'Shared mirror team' });
  const seeder = transportAt(fixture, 'owner', path.join(fixture.storageDir('seed'), 'coordination.git'), genesis.anchor);
  const written = await seeder.append(async () => genesis.events, { genesis: { teamFileText: genesis.teamFileText } });
  assert.equal(written.ok, true);
  return { anchor: genesis.anchor, owner, signer: { identity: owner.identity, memberId: owner.memberId } };
}

// A git step as a short readable label: no folders, no remote.
function describeStep(args: string[]): string {
  const shown: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--git-dir' || arg === '-C') { index += 1; continue; }
    shown.push(path.isAbsolute(arg) ? '<folder>' : arg);
  }
  return shown.slice(0, 5).join(' ');
}

// Runs real git and, once armed, calls the action right after the step-th git call of this runner returns (so that call's effect is visible).
interface Stepper { runner: GitRunner; arm(step: number, action: () => Promise<void>): void; disarm(): string[] | undefined }

function stepper(tag?: (args: string[]) => void): Stepper {
  let target = 0;
  let count = 0;
  let action: (() => Promise<void>) | undefined;
  let firedAt: string[] | undefined;
  const runner: GitRunner = async (args, options) => {
    tag?.(args);
    const result = await runGit(args, options);
    if (action !== undefined) {
      count += 1;
      if (count === target) {
        const run = action;
        action = undefined;
        firedAt = args;
        await run();
      }
    }
    return result;
  };
  return {
    runner,
    arm: (step, next) => { target = step; count = 0; action = next; firedAt = undefined; },
    disarm: () => { action = undefined; return firedAt; }
  };
}

function remoteLamports(fixture: TeamFixture): number[] {
  return gitIn(fixture.remote, ['log', '--first-parent', '--reverse', '--format=', '--name-only', '--diff-filter=A', DEFAULT_COORDINATION_REF])
    .split('\n').map((line) => EVENT_FILE.exec(line)).filter((match) => match !== null).map((match) => Number((match as RegExpExecArray)[1]));
}

function describeResult(result: AppendResult): string {
  return result.ok ? `ok after ${result.attempts} attempt(s)` : `${result.kind}: ${result.reason}`;
}

// The team-wide checks after a round: the remote's events run 1..N in commit order, a fresh replay rejects nothing new, and the writer's own state
// is exactly what a fresh replay of the same log gives (an entry applied twice shows up as an extra rejection there).
interface Seen { rejected: number; positionsBroken: boolean }

async function checkRound(fixture: TeamFixture, label: string, verifier: TeamLog, writer: TeamLog, before: Seen, problems: string[]): Promise<void> {
  const lamports = remoteLamports(fixture);
  const wanted = lamports.map((_, index) => index + 1);
  if (!before.positionsBroken && lamports.join(',') !== wanted.join(',')) {
    before.positionsBroken = true;
    problems.push(`${label}: the remote's event positions are ${lamports.join(',')}`);
  }
  const report = await verifier.verifyAll();
  if (report.rejected.length > before.rejected) problems.push(`${label}: an event landed that every reader rejects: ${report.rejected.slice(before.rejected).map((rejection) => rejection.reason).join('; ')}`);
  before.rejected = report.rejected.length;
  await writer.sync();
  const state = writer.state();
  if (state.rejected.length !== report.rejected.length) problems.push(`${label}: the writer's state holds ${state.rejected.length} rejection(s) where a fresh replay holds ${report.rejected.length} (an entry was applied twice)`);
  if (state.head.lamport !== report.head.lamport) problems.push(`${label}: the writer's state stands at ${state.head.lamport} where a fresh replay stands at ${report.head.lamport}`);
}

test('a writer that moves the shared mirror at any git step of an append never makes it land a stale event, apply an entry twice or pause', { timeout: 300_000 }, async () => {
  const fixture = await createTeamFixture({ clones: ['owner', 'other', 'verifier'] });
  try {
    const team = await seedTeam(fixture);
    const shared = path.join(fixture.storageDir('shared'), 'coordination.git');
    const other = new TeamLog({ anchor: team.anchor, transport: transportAt(fixture, 'other', path.join(fixture.storageDir('other'), 'coordination.git'), team.anchor), signer: team.signer });
    const verifier = new TeamLog({ anchor: team.anchor, transport: transportAt(fixture, 'verifier', path.join(fixture.storageDir('verifier'), 'coordination.git'), team.anchor) });
    // What another process on the shared mirror does: it appends (through its own path to the remote), then its fetch brings the new head into
    // the shared mirror and records it as the trusted head, without waiting for the operation that is running here.
    const anotherProcessWrites = async (): Promise<void> => {
      const written = await other.append(() => [INTENT]);
      assert.equal(written.ok, true, `the other writer's append: ${describeResult(written)}`);
      gitIn(fixture.root, ['--git-dir', shared, 'fetch', '--quiet', '--no-tags', fixture.remote, `+${DEFAULT_COORDINATION_REF}:${INCOMING_REF}`]);
      gitIn(fixture.root, ['--git-dir', shared, 'update-ref', LOCAL_REF, gitIn(fixture.remote, ['rev-parse', DEFAULT_COORDINATION_REF])]);
    };

    const problems: string[] = [];
    const before: Seen = { rejected: 0, positionsBroken: false };
    let rebuilt = 0;
    let step = 1;
    for (; ; step += 1) {
      // A window that has been running: a fresh transport on the shared mirror that has synced once, and one new event waiting on the remote.
      const steps = stepper();
      const writer = new TeamLog({ anchor: team.anchor, transport: transportAt(fixture, 'owner', shared, team.anchor, { git: steps.runner }), signer: team.signer });
      await writer.sync();
      assert.equal((await other.append(() => [INTENT])).ok, true);

      steps.arm(step, anotherProcessWrites);
      const result = await writer.append(() => [INTENT]);
      const at = steps.disarm();
      if (at === undefined) break;
      const label = `after step ${step} (${describeStep(at)})`;
      if (!result.ok) problems.push(`${label}: the append returned ${describeResult(result)}`);
      else if (result.attempts > 1) rebuilt += 1;
      if (writer.status().state !== 'ok') problems.push(`${label}: the transport is ${writer.status().state}: ${writer.status().reason ?? ''}`);
      await checkRound(fixture, label, verifier, writer, before, problems);
    }
    assert.deepEqual(problems, []);
    assert.ok(step > 20, `every git step of an append was covered (${step - 1} steps)`);
    assert.ok(rebuilt > 0, 'a write between the fetch and the push made the append lose the race and rebuild from the new head');
  } finally {
    await fixture.cleanup();
  }
});

test('two transports on one mirror folder that no in-process lock connects take turns: a second append started at any git step of the first waits for it', { timeout: 300_000, skip: process.platform === 'win32' }, async () => {
  const fixture = await createTeamFixture({ clones: ['owner', 'second', 'verifier'] });
  try {
    const team = await seedTeam(fixture);
    const shared = path.join(fixture.storageDir('shared'), 'coordination.git');
    // The second process reaches the same folder by another path, so the in-process lock (keyed by path) cannot serialise the two, exactly as
    // between two processes. The pin file beside it is the same file too.
    const alias = path.join(fixture.storageDir('shared'), 'alias.git');
    await transportAt(fixture, 'owner', shared, team.anchor).fetch();
    await symlink(shared, alias, 'dir');
    const verifier = new TeamLog({ anchor: team.anchor, transport: transportAt(fixture, 'verifier', path.join(fixture.storageDir('verifier'), 'coordination.git'), team.anchor) });

    const problems: string[] = [];
    const before: Seen = { rejected: 0, positionsBroken: false };
    let step = 1;
    for (; ; step += 1) {
      const order: string[] = [];
      let recording = false;
      const steps = stepper(() => { if (recording) order.push('first'); });
      const first = new TeamLog({ anchor: team.anchor, transport: transportAt(fixture, 'owner', shared, team.anchor, { git: steps.runner }), signer: team.signer });
      // The second transport tells the test when it has to wait (a pause), so the test never guesses with a timer.
      let waiting: () => void = () => undefined;
      const secondWaits = new Promise<void>((resolve) => { waiting = resolve; });
      const second = new TeamLog({
        anchor: team.anchor, signer: team.signer,
        transport: transportAt(fixture, 'second', alias, team.anchor, {
          git: async (args, options) => { if (recording) order.push('second'); return runGit(args, options); },
          sleep: async (ms) => { if (recording) waiting(); await new Promise<void>((resolve) => { setTimeout(resolve, Math.min(ms, 10)); }); }
        })
      });
      await first.sync();
      await second.sync();
      assert.equal((await second.append(() => [INTENT])).ok, true);

      recording = true;
      let secondResult: AppendResult | Error | undefined;
      let secondDone: Promise<void> = Promise.resolve();
      steps.arm(step, async () => {
        secondDone = second.append(() => [INTENT]).then((result) => { secondResult = result; }, (error: unknown) => { secondResult = error instanceof Error ? error : new Error(String(error)); });
        await Promise.race([secondDone, secondWaits]);
      });
      const firstResult = await first.append(() => [INTENT]);
      const at = steps.disarm();
      await secondDone;
      recording = false;
      if (at === undefined) break;
      const label = `second append started after step ${step} (${describeStep(at)})`;
      if (!firstResult.ok) problems.push(`${label}: the first append returned ${describeResult(firstResult)}`);
      if (secondResult instanceof Error) problems.push(`${label}: the second append threw ${secondResult.message}`);
      else if (secondResult === undefined || !secondResult.ok) problems.push(`${label}: the second append returned ${secondResult === undefined ? 'nothing' : describeResult(secondResult)}`);
      for (const [name, log] of [['first', first], ['second', second]] as const) {
        if (log.status().state !== 'ok') problems.push(`${label}: the ${name} transport is ${log.status().state}: ${log.status().reason ?? ''}`);
      }
      const firstSecond = order.indexOf('second');
      const lastFirst = order.lastIndexOf('first');
      if (firstSecond !== -1 && firstSecond < lastFirst) problems.push(`${label}: the second transport ran git while the first append was still running`);
      await checkRound(fixture, label, verifier, first, before, problems);
    }
    assert.deepEqual(problems, []);
    assert.ok(step > 20, `every git step of an append was covered (${step - 1} steps)`);
  } finally {
    await fixture.cleanup();
  }
});

// ---- The cross-process lock, against a real second process.

// Holders still running when the file ends (a test that failed before its own cleanup) are killed, so a failure never leaves the file waiting.
const liveHolders = new Set<LockHolder>();
after(() => { for (const holder of liveHolders) holder.kill(); });

// A second process that holds the mirror's lock until told to release it, or is killed holding it.
class LockHolder {
  private readonly child: ChildProcess;
  private readonly received: LockChildMessage[] = [];
  private readonly waiters = new Set<() => void>();
  private ended = false;
  public readonly exited: Promise<void>;

  public constructor(mirrorDir: string) {
    this.child = fork(path.join(__dirname, 'helpers', 'mirrorLockChild.js'), [mirrorDir], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    this.child.on('message', (message: LockChildMessage) => { this.received.push(message); this.wake(); });
    liveHolders.add(this);
    this.exited = new Promise<void>((resolve) => { this.child.on('exit', () => { this.ended = true; liveHolders.delete(this); this.wake(); resolve(); }); });
  }

  public get pid(): number {
    return this.child.pid as number;
  }

  private wake(): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiting) resolve();
  }

  public async expect(type: LockChildMessage['type']): Promise<void> {
    for (;;) {
      if (this.received.some((message) => message.type === type)) return;
      const error = this.received.find((message) => message.type === 'error');
      if (error !== undefined && error.type === 'error') throw new Error(`the lock holder failed: ${error.message}`);
      if (this.ended) throw new Error(`the lock holder ended before it sent ${type}`);
      await new Promise<void>((resolve) => { this.waiters.add(resolve); });
    }
  }

  public release(): void {
    this.child.send({ type: 'release' });
  }

  public kill(): void {
    if (!this.ended) this.child.kill('SIGKILL');
  }
}

async function withSharedMirror(run: (fixture: TeamFixture, team: Team, mirror: string) => Promise<void>): Promise<void> {
  const fixture = await createTeamFixture({ clones: ['owner', 'second'] });
  try {
    const team = await seedTeam(fixture);
    const mirror = path.join(fixture.storageDir('shared'), 'coordination.git');
    await transportAt(fixture, 'owner', mirror, team.anchor).fetch();
    await run(fixture, team, mirror);
  } finally {
    await fixture.cleanup();
  }
}

function lockFile(mirror: string): string {
  return path.join(mirror, TEAM_MIRROR_LOCK_FILE);
}

const shortPause = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, Math.min(ms, 10)); });

test('another process holding the mirror makes an append wait and write nothing until it lets go, and the lock of a process that crashed is taken over at once', { timeout: 120_000 }, async () => {
  await withSharedMirror(async (fixture, team, mirror) => {
    const holder = new LockHolder(mirror);
    try {
      await holder.expect('held');
      const pauses: number[] = [];
      let waiting: () => void = () => undefined;
      const waits = new Promise<void>((resolve) => { waiting = resolve; });
      const log = new TeamLog({
        anchor: team.anchor, signer: team.signer,
        transport: transportAt(fixture, 'owner', mirror, team.anchor, { sleep: async (ms) => { pauses.push(ms); waiting(); await shortPause(ms); } })
      });
      let settled = false;
      const appended = log.append(() => [INTENT]).then((result) => { settled = true; return result; });
      await Promise.race([waits, appended]);
      assert.equal(settled, false, 'the append waits while the other process holds the mirror');
      assert.deepEqual(remoteLamports(fixture), [1, 2], 'nothing is written while it waits');
      holder.release();
      await holder.expect('released');
      const result = await appended;
      assert.equal(result.ok, true, describeResult(result));
      assert.deepEqual(remoteLamports(fixture), [1, 2, 3]);
      assert.equal(existsSync(lockFile(mirror)), false, 'the lock is removed when the append ends');

      // A process that crashes holding the lock leaves its file behind; its process id is gone, so the next operation takes it over at once.
      const crashed = new LockHolder(mirror);
      await crashed.expect('held');
      crashed.kill();
      await crashed.exited;
      assert.equal(existsSync(lockFile(mirror)), true, 'the crashed process left its lock');
      pauses.length = 0;
      const after = await log.append(() => [INTENT]);
      assert.equal(after.ok, true, describeResult(after));
      assert.deepEqual(pauses, [], 'the lock of a process that ended is taken over without waiting');
      assert.deepEqual(remoteLamports(fixture), [1, 2, 3, 4]);
      assert.equal(existsSync(lockFile(mirror)), false);
    } finally {
      holder.kill();
      await holder.exited;
    }
  });
});

test('a lock its holder stopped refreshing is taken over after the stale time, while a holder that keeps working keeps its lock fresh', { timeout: 120_000, skip: process.platform === 'win32' }, async () => {
  await withSharedMirror(async (fixture, team, mirror) => {
    // A live process (the test runner that started this file) whose lock file was last refreshed ten minutes ago.
    await writeFile(lockFile(mirror), `${JSON.stringify({ pid: process.ppid, host: hostname(), token: 'ab'.repeat(12) })}\n`, 'utf8');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lockFile(mirror), old, old);
    const pauses: number[] = [];
    const taker = transportAt(fixture, 'owner', mirror, team.anchor, { sleep: async (ms) => { pauses.push(ms); await shortPause(ms); } });
    await taker.fetch();
    assert.equal(taker.status().state, 'ok');
    assert.deepEqual(pauses, [], 'a lock not refreshed for longer than the stale time is taken over without waiting');
    assert.equal(existsSync(lockFile(mirror)), false);

    // A holder that works for three times the stale time refreshes its lock, so a second process waits instead of taking it over.
    const timings = { staleMs: 400, refreshMs: 20 };
    const order: string[] = [];
    const alias = path.join(fixture.storageDir('shared'), 'alias.git');
    await symlink(mirror, alias, 'dir');
    let secondStarted: Promise<void> = Promise.resolve();
    let started = false;
    const second = transportAt(fixture, 'second', alias, team.anchor, {
      lockTimings: timings, sleep: shortPause,
      git: async (args, options) => { order.push('second'); return runGit(args, options); }
    });
    const first = transportAt(fixture, 'owner', mirror, team.anchor, {
      lockTimings: timings,
      git: async (args, options) => {
        order.push('first');
        const result = await runGit(args, options);
        if (!started) {
          started = true;
          secondStarted = second.fetch().then(() => undefined);
          await new Promise<void>((resolve) => { setTimeout(resolve, 3 * timings.staleMs); });
        }
        return result;
      }
    });
    await first.fetch();
    await secondStarted;
    assert.equal(first.status().state, 'ok');
    assert.equal(second.status().state, 'ok');
    assert.ok(order.includes('second'), 'the second process ran once the first was done');
    assert.ok(order.indexOf('second') > order.lastIndexOf('first'), `the second process waited for the first: ${order.join(' ')}`);
  });
});

test('a waiter gives up after the wait limit: its sync says another window is syncing, its append writes nothing, and the holder keeps its lock', { timeout: 120_000 }, async () => {
  await withSharedMirror(async (fixture, team, mirror) => {
    const holder = new LockHolder(mirror);
    try {
      await holder.expect('held');
      const log = new TeamLog({ anchor: team.anchor, signer: team.signer, transport: transportAt(fixture, 'owner', mirror, team.anchor, { lockTimings: { waitMs: 100 }, sleep: shortPause }) });
      const synced = await log.sync();
      assert.deepEqual(synced.entries, []);
      assert.deepEqual(log.status(), { state: 'offline', reason: MIRROR_BUSY_SYNC_REASON });
      const result = await log.append(() => [INTENT]);
      assert.deepEqual(result, { ok: false, kind: 'busy', reason: MIRROR_BUSY_APPEND_REASON, attempts: 0 });
      assert.deepEqual(remoteLamports(fixture), [1, 2], 'nothing was written');
      const text = await readFile(lockFile(mirror), 'utf8');
      assert.equal((JSON.parse(text) as { pid: number }).pid, holder.pid, 'the holder keeps its lock');

      holder.release();
      await holder.expect('released');
      const later = await log.sync();
      assert.equal(later.status.state, 'ok');
      assert.equal((await log.append(() => [INTENT])).ok, true);
      assert.deepEqual(remoteLamports(fixture), [1, 2, 3]);
    } finally {
      holder.kill();
      await holder.exited;
    }
  });
});

test('an operation whose lock another process took over meanwhile leaves the new holder\'s lock in place when it ends', { timeout: 60_000 }, async () => {
  await withSharedMirror(async (fixture, team, mirror) => {
    const other = `${JSON.stringify({ pid: process.ppid, host: hostname(), token: 'cd'.repeat(12) })}\n`;
    let replaced = false;
    const transport = transportAt(fixture, 'owner', mirror, team.anchor, {
      git: async (args, options) => {
        if (!replaced) {
          replaced = true;
          await writeFile(lockFile(mirror), other, 'utf8');
        }
        return runGit(args, options);
      }
    });
    await transport.fetch();
    assert.equal(transport.status().state, 'ok');
    assert.equal(await readFile(lockFile(mirror), 'utf8'), other, 'the other process\'s lock is not removed');
    await rm(lockFile(mirror));
    await transport.fetch();
    assert.equal(transport.status().state, 'ok');
    assert.equal(existsSync(lockFile(mirror)), false);
  });
});
