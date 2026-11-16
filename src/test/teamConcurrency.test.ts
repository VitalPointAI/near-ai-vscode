// Success criterion 4 with real processes: several forked clients, each with its own device key, append to one bare remote at the same
// time. The assertions are on the end state only (every event once, linear history, no forced update, a fresh client accepts everything),
// never on which client won a race (RESEARCH Pitfall 5).
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import test from 'node:test';
import { teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import type { GenesisAnchor, TeamFile, TeamState } from '../domain/team/types';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { newTeamId } from '../team/identity';
import { canonicalTeamFile } from '../team/teamFile';
import { createOwner, createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';
import type { ChildMessage, ParentMessage } from './helpers/teamAppendChild';

const MAX_RETRIES = 20;
const BASE_DELAY_MS = 25;
const EVENT_NAME = /^events\/(\d{12})-(evt-[0-9A-HJKMNP-TV-Z]{26})\.json$/;

// One forked client. Messages and failures are kept so an error that arrives before anyone is waiting is still reported.
class ChildClient {
  private readonly process: ChildProcess;
  private readonly received: ChildMessage[] = [];
  private readonly waiters = new Set<() => void>();
  private failure: string | undefined;
  private stderr = '';
  public readonly exited: Promise<number | null>;

  public constructor(private readonly name: string) {
    // execArgv [] keeps the parent's test-runner flags out of the child (verified under node --test in RESEARCH).
    this.process = fork(path.join(__dirname, 'helpers', 'teamAppendChild.js'), [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    this.process.stderr?.setEncoding('utf8');
    this.process.stderr?.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-4000); });
    this.process.on('message', (message: ChildMessage) => {
      this.received.push(message);
      if (message.type === 'error') this.fail(message.message);
      else this.wake();
    });
    this.process.on('error', (error) => { this.fail(`could not run: ${error.message}`); });
    this.exited = new Promise<number | null>((resolve) => {
      this.process.on('exit', (code, signal) => {
        const finished = code === 0 && this.received.some((message) => message.type === 'done');
        if (!finished) this.fail(`exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`} before reporting done`);
        resolve(code);
      });
    });
  }

  private fail(message: string): void {
    // The first failure is the cause; later ones (the exit that follows an error message) are consequences.
    this.failure ??= `${message}${this.stderr.trim() === '' ? '' : `\nstderr: ${this.stderr.trim()}`}`;
    this.wake();
  }

  private wake(): void {
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiting) resolve();
  }

  public send(message: ParentMessage): void {
    this.process.send(message);
  }

  public async expect<T extends ChildMessage['type']>(type: T): Promise<Extract<ChildMessage, { type: T }>> {
    for (;;) {
      const found = this.received.find((message) => message.type === type);
      if (found !== undefined) return found as Extract<ChildMessage, { type: T }>;
      if (this.failure !== undefined) throw new Error(`client ${this.name} failed: ${this.failure}`);
      await new Promise<void>((resolve) => { this.waiters.add(resolve); });
    }
  }

  public stop(): void {
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill('SIGKILL');
  }
}

interface Scenario { clients: number; each: number; shared: boolean }

interface Team { anchor: GenesisAnchor; ownerId: string; log: TeamLog }

function transportFor(fixture: TeamFixture, name: string, anchor: GenesisAnchor, mirrorDir: string, pinFile?: string): GitTransport<TeamState> {
  return new GitTransport<TeamState>({
    mirrorDir, projectRoot: fixture.clones[name] as string, remote: 'origin', ref: DEFAULT_COORDINATION_REF, materializer: teamMaterializer(anchor),
    ...(pinFile === undefined ? {} : { pinFile }), maxRetries: MAX_RETRIES, baseDelayMs: BASE_DELAY_MS
  });
}

// The owner pushes the genesis pair exactly as Enable Team Mode does and keeps a signing log for the device bindings.
async function seedOwner(fixture: TeamFixture): Promise<Team> {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const genesis = buildGenesisEvents({
    teamId, teamName: 'Concurrency team', owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [] },
    identity: owner.identity, policy: defaultTeamPolicy()
  });
  const teamFile: TeamFile = {
    version: 1, teamId, name: 'Concurrency team', coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: genesis.anchor.eventId, ownerDevice: genesis.anchor.ownerDevice }, createdAt: new Date().toISOString()
  };
  const ownerMirror = path.join(fixture.storageDir('owner'), 'coordination.git');
  const transport = transportFor(fixture, 'owner', genesis.anchor, ownerMirror);
  const log = new TeamLog({ anchor: genesis.anchor, transport, signer: { identity: owner.identity, memberId: owner.memberId } });
  const written = await transport.append(async () => genesis.events, { genesis: { teamFileText: canonicalTeamFile(teamFile) } });
  assert.equal(written.ok, true);
  return { anchor: genesis.anchor, ownerId: owner.memberId, log };
}

async function runScenario(scenario: Scenario): Promise<void> {
  const names = Array.from({ length: scenario.clients }, (_, index) => `c${index}`);
  const fixture = await createTeamFixture({ clones: ['owner', 'verifier', ...names] });
  const children: ChildClient[] = [];
  try {
    const team = await seedOwner(fixture);
    const sharedMirror = path.join(fixture.storageDir('shared'), 'coordination.git');
    const sharedPin = path.join(fixture.storageDir('shared'), 'pin.json');
    if (scenario.shared) {
      // The mirror exists before any child starts, so the race under test is fetch and append, not mirror creation.
      const warm = transportFor(fixture, 'owner', team.anchor, sharedMirror, sharedPin);
      await warm.fetch();
      assert.equal(warm.status().state, 'ok');
    }

    for (const name of names) {
      const child = new ChildClient(name);
      children.push(child);
      child.send({
        type: 'init', projectRoot: fixture.clones[name] as string,
        mirrorDir: scenario.shared ? sharedMirror : path.join(fixture.storageDir(name), 'coordination.git'),
        pinFile: scenario.shared ? sharedPin : path.join(fixture.storageDir(name), 'pin.json'),
        remote: 'origin', ref: DEFAULT_COORDINATION_REF, anchor: team.anchor, ownerId: team.ownerId,
        each: scenario.each, maxRetries: MAX_RETRIES, baseDelayMs: BASE_DELAY_MS
      });
    }
    const devices = await Promise.all(children.map((child) => child.expect('ready')));
    assert.equal(new Set(devices.map((device) => device.fingerprint)).size, scenario.clients, 'every client made its own key');

    // One batch binds every child device to the owner member, so each child signs as the owner from its own computer.
    const bound = await team.log.append(() => devices.map((device) => ({
      type: 'device.added' as const, body: { memberId: team.ownerId, device: { fingerprint: device.fingerprint, publicKey: device.publicKey } }
    })));
    assert.equal(bound.ok, true, bound.ok ? '' : `binding the devices failed: ${bound.reason}`);

    for (const child of children) child.send({ type: 'go' });
    const reports = await Promise.all(children.map((child) => child.expect('done')));
    const codes = await Promise.all(children.map((child) => child.exited));
    assert.deepEqual(codes, children.map(() => 0), 'every client exits cleanly');
    for (const report of reports) {
      assert.equal(report.results.length, scenario.each);
      assert.deepEqual(report.results.filter((result) => !result.ok), [], 'no append is left busy or refused');
    }

    const expected = 2 + scenario.clients + scenario.clients * scenario.each;
    const remote = fixture.remote;
    assert.equal(gitIn(remote, ['config', 'receive.denyNonFastForwards']), 'true', 'the remote refuses any forced update');

    const files = gitIn(remote, ['ls-tree', '-r', '--name-only', DEFAULT_COORDINATION_REF]).split('\n').filter((line) => line.startsWith('events/'));
    assert.equal(files.length, expected, 'every event is on the branch exactly once');
    const matches = files.map((file) => EVENT_NAME.exec(file));
    assert.ok(matches.every((match) => match !== null), 'every event file name is well formed');
    const ids = matches.map((match) => (match as RegExpExecArray)[2]);
    assert.equal(new Set(ids).size, expected, 'every event id is distinct');

    // Linear first-parent history: one root, every other commit has exactly one parent. Genesis, the device batch and each append are one commit each.
    const lines = gitIn(remote, ['rev-list', '--parents', DEFAULT_COORDINATION_REF]).split('\n');
    const parentCounts = lines.map((line) => line.split(' ').length - 1);
    assert.equal(parentCounts.filter((count) => count === 0).length, 1, 'exactly one root commit');
    assert.ok(parentCounts.every((count) => count <= 1), 'no merge commit');
    assert.equal(lines.length, 2 + scenario.clients * scenario.each, 'one commit per append');
    assert.deepEqual(gitIn(remote, ['rev-list', '--first-parent', DEFAULT_COORDINATION_REF]).split('\n').length, lines.length, 'the first-parent chain is the whole history');

    // Lamports run 1..N in commit order and in file-name order: a lost race was rebuilt at the new head, not re-sent stale.
    const commitOrder = gitIn(remote, ['log', '--first-parent', '--reverse', '--format=', '--name-only', '--diff-filter=A', DEFAULT_COORDINATION_REF])
      .split('\n').filter((line) => line.startsWith('events/')).map((line) => Number((EVENT_NAME.exec(line) as RegExpExecArray)[1]));
    const wanted = Array.from({ length: expected }, (_, index) => index + 1);
    assert.deepEqual(commitOrder, wanted);
    assert.deepEqual(matches.map((match) => Number((match as RegExpExecArray)[1])), wanted);

    // Each client's own events all landed: its device fingerprint authored exactly `each` of them.
    const authors = new Map<string, number>();
    for (const file of files) {
      const event = JSON.parse(gitIn(remote, ['show', `${DEFAULT_COORDINATION_REF}:${file}`])) as { type: string; device: string };
      if (event.type === 'member.availability') authors.set(event.device, (authors.get(event.device) ?? 0) + 1);
    }
    assert.deepEqual([...authors.entries()].map(([, count]) => count), devices.map(() => scenario.each));
    assert.deepEqual([...authors.keys()].sort(), devices.map((device) => device.fingerprint).sort());

    // A fresh client with its own clone and mirror replays the whole branch and accepts everything.
    const fresh = new TeamLog({ anchor: team.anchor, transport: transportFor(fixture, 'verifier', team.anchor, path.join(fixture.storageDir('verifier'), 'coordination.git')) });
    const report = await fresh.verifyAll();
    assert.equal(report.status.state, 'ok');
    assert.deepEqual(report.rejected, []);
    assert.equal(report.refused, undefined);
    assert.equal(report.events, expected);
    assert.equal(report.accepted, expected);
    assert.equal(report.head.lamport, expected);
    assert.equal(report.members.find((member) => member.id === team.ownerId)?.devices.length, 1 + scenario.clients);
  } finally {
    for (const child of children) child.stop();
    await Promise.all(children.map((child) => child.exited));
    await fixture.cleanup();
  }
}

test('4 forked clients with separate mirrors append 5 events each: every event once, linear history, no forced update, clean fresh replay', { timeout: 60_000 }, async () => {
  await runScenario({ clients: 4, each: 5, shared: false });
});

test('3 forked clients sharing one mirror directory append 3 events each and converge the same way', { timeout: 90_000 }, async () => {
  await runScenario({ clients: 3, each: 3, shared: true });
});
