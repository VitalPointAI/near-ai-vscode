// Every window of one VS Code keeps a team's coordination mirror in the same folder (<globalStorage>/team/<teamId>/coordination.git), so two
// windows open on two folders of one team are two processes on one mirror. These tests put a second writer after every git step of an append, one
// step per round, so every interleaving of that step is checked deterministically instead of hoping a race happens:
// - a writer that changes the mirror without taking turns (it moves the mirror's refs directly, as an older version or a stopped lock holder
//   would) must never make the append land an event with a stale position, apply an entry twice or pause;
// - a second transport on the same mirror folder (another process; here the same folder reached by another path, which no in-process lock can
//   see) must wait for the first operation to end before it runs any git step of its own.
// Found by teamConcurrency's shared-mirror test under load: two events with lamport 11 (debug session team-shared-mirror-duplicate-lamport).
import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { createOwner, createTeamFixture, gitIn, testGenesis } from './helpers/teamHarness';
import type { TeamFixture, TestOwner } from './helpers/teamHarness';
import { teamMaterializer } from '../domain/team/materialize';
import type { GenesisAnchor, TeamState } from '../domain/team/types';
import { TeamLog } from '../team/eventLog';
import type { EventIntent, TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport, INCOMING_REF, LOCAL_REF } from '../team/gitTransport';
import type { GitTransportOptions } from '../team/gitTransport';
import { newTeamId } from '../team/identity';
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
