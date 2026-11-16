// Tracer for Team Mode: a signed genesis batch travels from client A to client B through a real bare remote.
// Covers the Ed25519 signing scheme (D-06), the genesis anchor (D-10), the git compare-and-swap ref (D-03) and neutral commits (D-04).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { eventPath } from '../domain/team/canonical';
import { serialiseState, teamMaterializer } from '../domain/team/materialize';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { GenesisAnchor, LogHead, TeamEvent, TeamState } from '../domain/team/types';
import { CAS_LOST_MARKERS, DEFAULT_COORDINATION_REF, GitTransport, LOCAL_REF, QUARANTINE_REF_PREFIX, RETRYABLE_FETCH_MARKERS, classifyGitFailure, classifyPush, isContactableRemoteAddress } from '../team/gitTransport';
import type { GitTransportOptions } from '../team/gitTransport';
import { newTeamId } from '../team/identity';
import { redactGitMessage, runGit } from '../team/runGit';
import type { GitRunner } from '../team/runGit';
import { BRANCH_MISSING_REASON } from '../team/transport';
import type { AppendBuilder } from '../team/transport';
import { createOwner, createTeamFixture, faultRunner, fakeGitResult, gitIn, recordingMaterializer, testEvent, testGenesis, withGlobalGitConfig } from './helpers/teamHarness';
import type { RecordedState, TeamFixture, TestGenesis, TestOwner } from './helpers/teamHarness';

function clientFor(fixture: TeamFixture, name: string, anchor: GenesisAnchor): GitTransport<TeamState> {
  return new GitTransport<TeamState>({
    mirrorDir: path.join(fixture.storageDir(name), 'coordination.git'),
    projectRoot: fixture.clones[name] as string,
    remote: 'origin',
    ref: DEFAULT_COORDINATION_REF,
    materializer: teamMaterializer(anchor)
  });
}

async function withFixture(names: string[], run: (fixture: TeamFixture) => Promise<void>): Promise<void> {
  const fixture = await createTeamFixture({ clones: names });
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}

test('a signed genesis batch from client A is fetched, verified and materialised identically by client B', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const teamId = newTeamId();
    const owner = await createOwner(teamId);
    const genesis = testGenesis({ teamId, owner, name: 'Tracer team' });
    const cloneA = fixture.clones['a'] as string;
    const refsBefore = gitIn(cloneA, ['for-each-ref']);
    const a = clientFor(fixture, 'a', genesis.anchor);
    const appended = await a.append(async () => genesis.events, { genesis: { teamFileText: genesis.teamFileText } });
    assert.equal(appended.ok, true);
    if (appended.ok) assert.equal(appended.attempts, 1);

    const parents = gitIn(fixture.remote, ['rev-list', '--parents', DEFAULT_COORDINATION_REF]).split('\n');
    assert.equal(parents.length, 1, 'one commit on the coordination branch');
    assert.equal((parents[0] as string).split(' ').length, 1, 'the commit has no parent');
    const tree = gitIn(fixture.remote, ['ls-tree', '-r', '--name-only', DEFAULT_COORDINATION_REF]).split('\n');
    assert.deepEqual(tree, [eventPath(genesis.events[0]), eventPath(genesis.events[1]), 'team.json']);
    assert.equal(gitIn(fixture.remote, ['log', '-1', '--format=%an <%ae>|%cn <%ce>', DEFAULT_COORDINATION_REF]), 'NEAR AI Team <coordination@near-ai.invalid>|NEAR AI Team <coordination@near-ai.invalid>');
    assert.equal(gitIn(fixture.remote, ['log', '-1', '--format=%s', DEFAULT_COORDINATION_REF]), `team: team.created ${genesis.events[0].id}`);
    assert.ok(gitIn(path.join(fixture.storageDir('a'), 'coordination.git'), ['config', 'core.hooksPath']).endsWith('coordination-hooks'), 'the mirror ignores the global hooks path');

    const b = clientFor(fixture, 'b', genesis.anchor);
    const entries = await b.fetch();
    assert.deepEqual(entries.map((entry) => entry.path), [eventPath(genesis.events[0]), eventPath(genesis.events[1]), 'team.json']);
    assert.deepEqual(entries.map((entry) => entry.kind), ['event', 'event', 'genesis-copy']);
    assert.ok(entries.every((entry) => entry.verdict?.accepted === true), 'every entry is accepted');
    assert.equal(serialiseState(b.state()), serialiseState(a.state()));
    assert.equal(b.status().state, 'ok');
    const member = b.state().members.get(owner.memberId);
    assert.equal(member?.role, 'owner');
    assert.equal(member?.devices.length, 1);
    assert.equal(b.state().head.eventId, genesis.events[1].id);
    assert.equal(b.state().highLamport, 2);
    assert.deepEqual(b.state().rejected, []);

    assert.equal(gitIn(cloneA, ['status', '--porcelain']), '');
    assert.equal(gitIn(cloneA, ['for-each-ref']), refsBefore, 'the clone keeps the same branches and refs');
  });
});

test('a client whose genesis anchor names a different owner key refuses the whole log', async () => {
  await withFixture(['a', 'c'], async (fixture) => {
    const teamId = newTeamId();
    const owner = await createOwner(teamId);
    const genesis = testGenesis({ teamId, owner, name: 'Anchored team' });
    const a = clientFor(fixture, 'a', genesis.anchor);
    assert.equal((await a.append(async () => genesis.events, { genesis: { teamFileText: genesis.teamFileText } })).ok, true);

    const stranger = await createOwner(teamId);
    const wrongAnchor: GenesisAnchor = { teamId, eventId: genesis.events[0].id, ownerDevice: { fingerprint: stranger.identity.fingerprint, publicKey: stranger.identity.publicKey } };
    const c = clientFor(fixture, 'c', wrongAnchor);
    await c.fetch();
    assert.equal(c.state().refused, "This coordination log does not belong to this project's team");
    assert.equal(c.state().refused, TEAM_REJECTION_REASONS.logRefused);
    assert.equal(c.state().members.size, 0);
    assert.equal(c.state().accepted, 0);
  });
});

test('a second genesis append to a remote that already has a coordination log is refused', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const teamId = newTeamId();
    const first = testGenesis({ teamId, owner: await createOwner(teamId), name: 'First team' });
    assert.equal((await clientFor(fixture, 'a', first.anchor).append(async () => first.events, { genesis: { teamFileText: first.teamFileText } })).ok, true);

    const otherTeam = newTeamId();
    const second = testGenesis({ teamId: otherTeam, owner: await createOwner(otherTeam), name: 'Second team' });
    const result = await clientFor(fixture, 'b', second.anchor).append(async () => second.events, { genesis: { teamFileText: second.teamFileText } });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'exists');
      assert.equal(result.reason, 'This remote already has a coordination log');
    }
  });
});

test('appending without a coordination log is refused with a plain explanation and nothing is created', async () => {
  await withFixture(['a'], async (fixture) => {
    const teamId = newTeamId();
    const genesis = testGenesis({ teamId, owner: await createOwner(teamId), name: 'Not enabled' });
    const a = clientFor(fixture, 'a', genesis.anchor);
    const result = await a.append(async () => genesis.events);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'refused');
      assert.equal(result.reason, 'The coordination log does not exist yet. Enable Team Mode first.');
    }
    assert.equal(gitIn(fixture.remote, ['for-each-ref', 'refs/heads/near-ai']), '');
    assert.equal(a.status().state, 'ok');
  });
});

test('a rewritten coordination branch pauses the client and keeps its last good state', async () => {
  await withFixture(['a', 'b', 'c'], async (fixture) => {
    const teamId = newTeamId();
    const genesis = testGenesis({ teamId, owner: await createOwner(teamId), name: 'Rewritten team' });
    assert.equal((await clientFor(fixture, 'a', genesis.anchor).append(async () => genesis.events, { genesis: { teamFileText: genesis.teamFileText } })).ok, true);
    const b = clientFor(fixture, 'b', genesis.anchor);
    await b.fetch();
    const before = serialiseState(b.state());

    gitIn(fixture.remote, ['config', 'receive.denyNonFastForwards', 'false']);
    const cloneC = fixture.clones['c'] as string;
    gitIn(cloneC, ['checkout', '-q', '--orphan', 'rewrite']);
    gitIn(cloneC, ['commit', '-q', '--allow-empty', '-m', 'rewrite']);
    gitIn(cloneC, ['push', '-q', '--force', 'origin', `rewrite:${DEFAULT_COORDINATION_REF}`]);

    assert.deepEqual(await b.fetch(), []);
    assert.equal(b.status().state, 'paused');
    assert.equal(b.status().reason, TEAM_REJECTION_REASONS.logRewritten);
    assert.equal(serialiseState(b.state()), before);
    const append = await b.append(async () => genesis.events);
    assert.equal(append.ok, false);
    if (!append.ok) assert.equal(append.kind, 'paused');
    assert.notEqual(gitIn(path.join(fixture.storageDir('b'), 'coordination.git'), ['for-each-ref', 'refs/team/quarantine']), '');
    assert.ok(gitIn(path.join(fixture.storageDir('b'), 'coordination.git'), ['rev-parse', LOCAL_REF]).length > 0);
  });
});

test('git messages lose URL credentials before they can be shown or stored', () => {
  const message = redactGitMessage('fatal: unable to access https://person:hunter2-secret@example.invalid/team.git/: Could not resolve host');
  assert.equal(message.includes('hunter2-secret'), false);
  assert.equal(message.includes('person'), false);
  assert.ok(message.includes('example.invalid/team.git'));
});

// ---- Compare-and-swap appends (plan 60-03, D-17, D-29, D-34). These tests use an accept-all materializer so only the transport is under test.

const noSleep = async (): Promise<void> => undefined;

function recClient(fixture: TeamFixture, name: string, extra: Partial<GitTransportOptions<RecordedState>> = {}): GitTransport<RecordedState> {
  return new GitTransport<RecordedState>({
    mirrorDir: path.join(fixture.storageDir(name), 'coordination.git'),
    projectRoot: fixture.clones[name] as string,
    remote: 'origin',
    ref: DEFAULT_COORDINATION_REF,
    materializer: recordingMaterializer(),
    sleep: noSleep,
    ...extra
  });
}

interface Seeded { teamId: string; owner: TestOwner; genesis: TestGenesis; client: GitTransport<RecordedState> }

async function seedLog(fixture: TeamFixture, name: string, extra: Partial<GitTransportOptions<RecordedState>> = {}): Promise<Seeded> {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const genesis = testGenesis({ teamId, owner, name: 'Transport team' });
  const client = recClient(fixture, name, extra);
  const result = await client.append(async () => genesis.events, { genesis: { teamFileText: genesis.teamFileText } });
  assert.equal(result.ok, true);
  return { teamId, owner, genesis, client };
}

function nextEvent(owner: TestOwner, teamId: string, head: LogHead): TeamEvent {
  return testEvent(owner.identity, { lamport: head.lamport + 1, prev: head.eventId, author: owner.memberId, teamId });
}

function availability(owner: TestOwner, teamId: string, seen?: number[]): AppendBuilder<RecordedState> {
  return (_state, head) => {
    seen?.push(head.lamport);
    return [nextEvent(owner, teamId, head)];
  };
}

function remoteEventFiles(fixture: TeamFixture): string[] {
  return gitIn(fixture.remote, ['ls-tree', '-r', '--name-only', DEFAULT_COORDINATION_REF]).split('\n').filter((line) => line.startsWith('events/'));
}

function lamports(files: string[]): number[] {
  return files.map((file) => Number(file.slice('events/'.length, 'events/'.length + 12)));
}

function assertLinear(fixture: TeamFixture): number {
  const commits = gitIn(fixture.remote, ['rev-list', '--parents', DEFAULT_COORDINATION_REF]).split('\n');
  for (const line of commits) assert.ok(line.split(' ').length <= 2, 'no commit has two parents');
  return commits.length;
}

const NOT_FAST_FORWARD = fakeGitResult(1, 'To somewhere\n!\tabc:refs/heads/near-ai/coordination\t[rejected] (non-fast-forward)\nDone\n', 'error: failed to push some refs');

test('a writer that loses the race rebuilds from the fresh head and both events land in a linear history', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const { teamId, owner, client: a } = await seedLog(fixture, 'a');
    let armed = false;
    const staleFetch = faultRunner(runGit, [{ when: (args) => armed && args.includes('fetch'), times: 1, replace: () => fakeGitResult(0) }]);
    const b = recClient(fixture, 'b', { git: staleFetch });
    await b.fetch();
    assert.equal(b.head().lamport, 2);

    assert.equal((await a.append(availability(owner, teamId))).ok, true);
    armed = true;
    const seen: number[] = [];
    const result = await b.append(availability(owner, teamId, seen));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.attempts, 2);
    assert.deepEqual(seen, [2, 3], 'the builder is called again with a head one higher');
    assert.equal(remoteEventFiles(fixture).length, 4, 'genesis plus both appended events');
    assert.equal(assertLinear(fixture), 3, 'one genesis commit plus two appended commits');
    assert.deepEqual(lamports(remoteEventFiles(fixture)), [1, 2, 3, 4]);
    assert.equal(b.head().lamport, 4);
  });
});

test('a builder conflict is refused at the first attempt and reported as a conflict after a lost race, never retried', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const { teamId, owner, client: a } = await seedLog(fixture, 'a');
    const first = await a.append(() => ({ conflict: 'Taken by Sam' }));
    assert.equal(first.ok, false);
    if (!first.ok) {
      assert.equal(first.kind, 'refused');
      assert.equal(first.reason, 'Taken by Sam');
      assert.equal(first.attempts, 1);
    }

    let armed = false;
    const b = recClient(fixture, 'b', { git: faultRunner(runGit, [{ when: (args) => armed && args.includes('fetch'), times: 1, replace: () => fakeGitResult(0) }]) });
    await b.fetch();
    assert.equal((await a.append(availability(owner, teamId))).ok, true);
    armed = true;
    let calls = 0;
    const later = await b.append((_state, head) => {
      calls += 1;
      return calls === 1 ? [nextEvent(owner, teamId, head)] : { conflict: 'Already claimed' };
    });
    assert.equal(later.ok, false);
    if (!later.ok) {
      assert.equal(later.kind, 'conflict');
      assert.equal(later.reason, 'Already claimed');
      assert.equal(later.attempts, 2);
    }
    assert.equal(calls, 2);
  });
});

test('events the materializer refuses are not written', async () => {
  await withFixture(['a'], async (fixture) => {
    const { teamId, owner } = await seedLog(fixture, 'a');
    const base = recordingMaterializer();
    const strict = recClient(fixture, 'a', { materializer: { ...base, check: () => ({ eventId: 'evt-x', reason: 'not permitted' }) } });
    const before = remoteEventFiles(fixture);
    const result = await strict.append(availability(owner, teamId));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'refused');
      assert.equal(result.reason, 'not permitted');
    }
    assert.deepEqual(remoteEventFiles(fixture), before);
  });
});

test('every push losing the race returns busy after maxRetries + 1 attempts with jittered exponential delays', async () => {
  await withFixture(['a'], async (fixture) => {
    const { teamId, owner } = await seedLog(fixture, 'a');
    const delays: number[] = [];
    let builds = 0;
    const loser = recClient(fixture, 'a', {
      git: faultRunner(runGit, [{ when: (args) => args.includes('push'), replace: () => NOT_FAST_FORWARD }]),
      maxRetries: 3, baseDelayMs: 100, random: () => 0.25, sleep: async (ms) => { delays.push(ms); }
    });
    const before = remoteEventFiles(fixture);
    const result = await loser.append((state, head) => { builds += 1; return availability(owner, teamId)(state, head); });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'busy');
      assert.equal(result.attempts, 4);
      assert.equal(result.reason, 'The team record changed too often while saving. Try again in a moment.');
    }
    assert.equal(builds, 4);
    assert.deepEqual(delays, [75, 150, 300]);
    assert.deepEqual(remoteEventFiles(fixture), before);
  });
});

test('a remote hook that declines the push is a permanent rejection with a plain reason and no URL userinfo', { skip: process.platform === 'win32' }, async () => {
  await withFixture(['a'], async (fixture) => {
    const { teamId, owner, client } = await seedLog(fixture, 'a');
    const hook = path.join(fixture.remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "declined by the test hook" >&2\nexit 1\n', 'utf8');
    chmodSync(hook, 0o755);
    const result = await client.append(availability(owner, teamId));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'remote-rejected');
      assert.ok(result.reason.includes('pre-receive hook declined'), result.reason);
      assert.equal(/\/\/[^/\s]*@/.test(result.reason), false);
      assert.equal(result.attempts, 1);
    }
  });
});

test('a push whose response was lost is recognised on the next fetch and the event is written once', async () => {
  await withFixture(['a'], async (fixture) => {
    const { teamId, owner } = await seedLog(fixture, 'a');
    const timeout = fakeGitResult(124, '', 'git timed out after 60000 ms');
    const flaky = recClient(fixture, 'a', { git: faultRunner(runGit, [{ when: (args) => args.includes('push'), times: 1, runReal: true, replace: () => timeout }]) });
    let builds = 0;
    const result = await flaky.append((state, head) => { builds += 1; return availability(owner, teamId)(state, head); });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.attempts, 2);
      assert.equal(result.events.length, 1);
      assert.equal(result.commit, gitIn(fixture.remote, ['rev-parse', DEFAULT_COORDINATION_REF]));
    }
    assert.equal(builds, 1, 'the landed event is not rebuilt');
    assert.equal(remoteEventFiles(fixture).length, 3);
    assert.equal(assertLinear(fixture), 2);
  });
});

test('a push that never reached the remote and then loses the network reports offline and writes nothing', async () => {
  await withFixture(['a'], async (fixture) => {
    const { teamId, owner } = await seedLog(fixture, 'a');
    const down = fakeGitResult(128, '', 'fatal: unable to access the remote: Could not resolve host');
    const flaky = recClient(fixture, 'a', {
      maxRetries: 1,
      git: faultRunner(runGit, [{ when: (args) => args.includes('push'), replace: () => down }])
    });
    const result = await flaky.append(availability(owner, teamId));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'offline');
      assert.equal(result.attempts, 2);
    }
    assert.equal(flaky.status().state, 'offline');
    assert.equal(remoteEventFiles(fixture).length, 2);
  });
});

test('a fetch that loses a ref lock race is retried and the append succeeds', async () => {
  await withFixture(['a'], async (fixture) => {
    const { teamId, owner } = await seedLog(fixture, 'a');
    const delays: number[] = [];
    const race = fakeGitResult(1, '', 'error: fetching ref refs/team/incoming failed: incorrect old value provided');
    const racing = recClient(fixture, 'a', {
      git: faultRunner(runGit, [{ when: (args) => args.includes('fetch'), times: 1, replace: () => race }]),
      sleep: async (ms) => { delays.push(ms); }
    });
    const result = await racing.append(availability(owner, teamId));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.attempts, 1);
    assert.equal(delays.length, 1);
    assert.equal(racing.status().state, 'ok');
  });
});

test('opening a mirror that another process is configuring retries the config lock, and an already configured mirror is not written again', async () => {
  await withFixture(['a'], async (fixture) => {
    const { teamId, owner } = await seedLog(fixture, 'a');
    // A second process (a new transport on the same mirror) meets git's config.lock twice before it gets through.
    const locked = fakeGitResult(255, '', 'error: could not lock config file /somewhere/coordination.git/config: File exists');
    const delays: number[] = [];
    const contended = recClient(fixture, 'a', {
      git: faultRunner(runGit, [{ when: (args) => args.includes('config') && !args.includes('--get'), times: 2, replace: () => locked }]),
      sleep: async (ms) => { delays.push(ms); }
    });
    const result = await contended.append(availability(owner, teamId));
    assert.equal(result.ok, true);
    assert.equal(delays.length, 0, 'an already configured mirror needs no config write, so there is no lock to lose');
    assert.equal(gitIn(mirrorOf(fixture, 'a'), ['config', '--get', 'gc.autoDetach']), 'false');

    // A mirror whose settings are missing is written, and a lock race on that write is retried.
    const fresh = recClient(fixture, 'a', {
      mirrorDir: path.join(fixture.storageDir('fresh'), 'coordination.git'),
      git: faultRunner(runGit, [{ when: (args) => args.includes('config') && !args.includes('--get'), times: 2, replace: () => locked }]),
      sleep: async (ms) => { delays.push(ms); }
    });
    await fresh.fetch();
    assert.equal(fresh.status().state, 'ok');
    assert.equal(delays.length, 2);
    assert.equal(gitIn(path.join(fixture.storageDir('fresh'), 'coordination.git'), ['config', '--get', 'transfer.fsckObjects']), 'true');

    const writes: string[][] = [];
    const counting: GitRunner = async (args, options) => {
      if (args.includes('config') && !args.includes('--get')) writes.push(args);
      return runGit(args, options);
    };
    await recClient(fixture, 'a', { git: counting }).fetch();
    assert.deepEqual(writes, [], 'reopening a configured mirror writes no config');
  });
});

test('push outcomes are classified from the porcelain lines and the stderr', () => {
  const ref = 'abc:refs/heads/near-ai/coordination';
  assert.deepEqual(classifyPush(fakeGitResult(0, `To x\n*\t${ref}\t[new branch]\nDone\n`)), { kind: 'ok' });
  assert.deepEqual(classifyPush(fakeGitResult(0, `To x\n \t${ref}\tabc..def\nDone\n`)), { kind: 'ok' });
  assert.deepEqual(classifyPush(fakeGitResult(0, `To x\n=\t${ref}\t[up to date]\nDone\n`)), { kind: 'up-to-date' });
  for (const marker of CAS_LOST_MARKERS) {
    const flag = marker === 'incorrect old value provided' ? '[remote rejected]' : '[rejected]';
    const outcome = classifyPush(fakeGitResult(1, `To x\n!\t${ref}\t${flag} (${marker})\nDone\n`));
    assert.equal(outcome.kind, 'cas-lost', marker);
  }
  const permanent = classifyPush(fakeGitResult(1, `To x\n!\t${ref}\t[remote rejected] (protected branch hook declined)\nDone\n`, 'remote: GH006 protected\nremote: details\n'));
  assert.equal(permanent.kind, 'permanent');
  if (permanent.kind === 'permanent') {
    assert.ok(permanent.detail.includes('protected branch hook declined'));
    assert.ok(permanent.detail.includes('GH006 protected'));
  }
  const canary = `canary${randomBytes(6).toString('hex')}`;
  const unreachable = classifyPush(fakeGitResult(128, `To https://user:${canary}@example.invalid/team.git\n`, `fatal: unable to access 'https://user:${canary}@example.invalid/team.git/': Could not resolve host`));
  assert.equal(unreachable.kind, 'offline');
  if (unreachable.kind === 'offline') assert.equal(unreachable.detail.includes(canary), false);
  assert.equal(classifyPush(fakeGitResult(124, '', 'git timed out after 60000 ms')).kind, 'offline');
});

test('git failures are classified as absent, race, auth or unreachable with redacted details', () => {
  assert.deepEqual(classifyGitFailure(fakeGitResult(128, '', "fatal: couldn't find remote ref refs/heads/near-ai/coordination")), { kind: 'absent' });
  for (const marker of RETRYABLE_FETCH_MARKERS) assert.deepEqual(classifyGitFailure(fakeGitResult(1, '', `error: ${marker}`)), { kind: 'race' });
  const auth = classifyGitFailure(fakeGitResult(128, '', "fatal: could not read Username for 'https://example.invalid': terminal prompts disabled"));
  assert.equal(auth.kind, 'auth');
  const canary = `canary${randomBytes(6).toString('hex')}`;
  const down = classifyGitFailure(fakeGitResult(128, '', `fatal: unable to access 'https://user:${canary}@example.invalid/x.git/': Failed to connect`));
  assert.equal(down.kind, 'unreachable');
  if (down.kind === 'unreachable') {
    assert.equal(down.detail.includes(canary), false);
    assert.ok(down.detail.includes('Failed to connect'));
  }
  assert.equal(QUARANTINE_REF_PREFIX, 'refs/team/quarantine/');
});

test('two appends on one mirror in one process never interleave their git calls and both succeed', async () => {
  await withFixture(['a'], async (fixture) => {
    const { teamId, owner } = await seedLog(fixture, 'a');
    const calls: string[] = [];
    const tagged = (tag: string) => faultRunner(async (args, options) => {
      calls.push(tag);
      return runGit(args, options);
    }, []);
    const first = recClient(fixture, 'a', { git: tagged('A') });
    const second = recClient(fixture, 'a', { git: tagged('B') });
    const results = await Promise.all([first.append(availability(owner, teamId)), second.append(availability(owner, teamId))]);
    assert.ok(results.every((result) => result.ok));
    const runs = calls.filter((tag, index) => index === 0 || calls[index - 1] !== tag);
    assert.equal(runs.length, 2, `calls ran as ${runs.join('')}`);
    assert.equal(remoteEventFiles(fixture).length, 4);
    assert.equal(assertLinear(fixture), 3, 'one genesis commit plus two appended commits');
  });
});

test('three clients appending concurrently from separate mirrors lose no event and keep history linear', async () => {
  await withFixture(['a', 'b', 'c'], async (fixture) => {
    const { teamId, owner } = await seedLog(fixture, 'a', { maxRetries: 20, baseDelayMs: 25, sleep: undefined });
    const writers = ['a', 'b', 'c'].map((name) => recClient(fixture, name, { maxRetries: 20, baseDelayMs: 25, sleep: undefined }));
    const results = await Promise.all(writers.map(async (writer) => {
      const outcomes = [];
      for (let index = 0; index < 2; index += 1) outcomes.push(await writer.append(availability(owner, teamId)));
      return outcomes;
    }));
    for (const outcomes of results) for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
    const files = remoteEventFiles(fixture);
    assert.equal(files.length, 8);
    assert.deepEqual(lamports(files), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(assertLinear(fixture), 7, 'one genesis commit plus six appended commits');
  });
});

test('extra snapshot files travel with the event; other paths and repeated snapshots are refused', async () => {
  await withFixture(['a'], async (fixture) => {
    const { teamId, owner, client } = await seedLog(fixture, 'a');
    const builder = (file: string): AppendBuilder<RecordedState> => (_state, head) => ({
      events: [nextEvent(owner, teamId, head)],
      files: [{ path: file, text: '{"snapshot":true}' }]
    });
    const ok = await client.append(builder('snapshots/000000000003.json'));
    assert.equal(ok.ok, true);
    assert.ok(gitIn(fixture.remote, ['ls-tree', '-r', '--name-only', DEFAULT_COORDINATION_REF]).split('\n').includes('snapshots/000000000003.json'));
    const bad = await client.append(builder('events/000000000009-evt-forged.json'));
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.kind, 'refused');
    const repeat = await client.append(builder('snapshots/000000000003.json'));
    assert.equal(repeat.ok, false);
    if (!repeat.ok) assert.ok(repeat.kind === 'refused' || repeat.kind === 'conflict');
    assert.equal(remoteEventFiles(fixture).length, 3);
  });
});

test('head() reports the applied commit and the last accepted position', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const { teamId, owner, client } = await seedLog(fixture, 'a');
    assert.equal((await client.append(availability(owner, teamId))).ok, true);
    const b = recClient(fixture, 'b');
    assert.deepEqual(b.head(), { lamport: 0, eventId: '' });
    await b.fetch();
    const head = b.head();
    assert.equal(head.commit, gitIn(fixture.remote, ['rev-parse', DEFAULT_COORDINATION_REF]));
    assert.equal(head.lamport, 3);
    assert.ok(head.eventId.startsWith('evt-'));
  });
});

// ---- Offline and paused status, rewrite refusal, anomalies and isolation (plan 60-03 task 2, D-03, D-16, D-25, D-33, D-34).

for (const reported of [undefined, '2.30.2']) {
  test(`a remote address that starts with a dash is refused before any network call (git ${reported ?? 'current'})`, async () => {
    await withFixture(['a'], async (fixture) => {
      const teamId = newTeamId();
      const owner = await createOwner(teamId);
      const genesis = testGenesis({ teamId, owner, name: 'Dash address team' });
      const calls: RecordedCall[] = [];
      const transport = new GitTransport<TeamState>({
        mirrorDir: path.join(fixture.storageDir('a'), 'coordination.git'), projectRoot: fixture.clones['a'] as string, remote: 'origin',
        ref: DEFAULT_COORDINATION_REF, materializer: teamMaterializer(genesis.anchor), git: recordingRunner(calls, reported), baseDelayMs: 1
      });
      gitIn(fixture.clones['a'] as string, ['config', 'remote.origin.url', '--upload-pack=touch refused-marker']);
      const appended = await transport.append(async () => genesis.events, { genesis: { teamFileText: genesis.teamFileText } });
      assert.equal(appended.ok, false);
      assert.equal(appended.ok === false && appended.kind, 'refused');
      await transport.fetch();
      assert.equal(transport.status().state, 'offline');
      const network = calls.filter((call) => call.args.includes('--git-dir') && ['fetch', 'push', 'ls-remote'].some((verb) => call.args.includes(verb)));
      assert.deepEqual(network, [], 'no fetch, push or ls-remote ran');
      assert.equal(calls.some((call) => call.args.some((arg) => arg.startsWith('--upload-pack'))), false, 'the address never reached a git argument');
    });
  });
}

test('only file, ssh, git, http and https addresses, scp-like addresses and plain local paths are contacted', () => {
  for (const good of [
    'https://example.com/team.git', 'HTTP://example.com/team.git', 'http://user:token@example.com:8080/team.git', 'ssh://git@example.com/team.git', 'git://example.com/team.git',
    'file:///srv/teams/team.git', 'git@example.com:org/team.git', 'example.com:org/team.git', '[::1]:org/team.git', '/srv/teams/team.git', './team.git', '../team.git', 'team.git',
    'C:\\teams\\team.git', 'ssh://[::1]/team.git'
  ]) assert.equal(isContactableRemoteAddress(good), true, `${good} is contacted`);
  for (const bad of [
    '', ' ', '-oProxyCommand=x', '--upload-pack=x', 'ext::sh -c true', 'EXT::sh -c true', 'fd::3', 'fd::3,4', 'foo::bar', 'https::example.com/x', 'ext::https://example.com/x',
    'ext://sh', 'ftp://example.com/team.git', 'ftps://example.com/team.git', 'rsync://example.com/team.git', 'javascript://example.com/%0aalert(1)', 'data://x', 'gopher://example.com/',
    'https://example.com/x\nhttps://other.example.com/', 'git@example.com:org/team.git\n--upload-pack=x', 'ssh://example.com/\u0000x'
  ]) assert.equal(isContactableRemoteAddress(bad), false, `${JSON.stringify(bad)} is refused`);
});

for (const address of ['ext::echo near-ai-refused-marker', 'fd::3', 'ftp://example.com/team.git', 'rsync://example.com/team.git']) {
  test(`a remote address that is not file, ssh, git, http or https is refused before any network call: ${address}`, async () => {
    await withFixture(['a'], async (fixture) => {
      const teamId = newTeamId();
      const owner = await createOwner(teamId);
      const genesis = testGenesis({ teamId, owner, name: 'Transport address team' });
      const calls: RecordedCall[] = [];
      const transport = new GitTransport<TeamState>({
        mirrorDir: path.join(fixture.storageDir('a'), 'coordination.git'), projectRoot: fixture.clones['a'] as string, remote: 'origin',
        ref: DEFAULT_COORDINATION_REF, materializer: teamMaterializer(genesis.anchor), git: recordingRunner(calls), baseDelayMs: 1
      });
      gitIn(fixture.clones['a'] as string, ['config', 'remote.origin.url', address]);
      const appended = await transport.append(async () => genesis.events, { genesis: { teamFileText: genesis.teamFileText } });
      assert.equal(appended.ok, false);
      assert.equal(appended.ok === false && appended.kind, 'refused');
      await transport.fetch();
      assert.equal(transport.status().state, 'offline');
      const network = calls.filter((call) => call.args.includes('--git-dir') && ['fetch', 'push', 'ls-remote'].some((verb) => call.args.includes(verb)));
      assert.deepEqual(network, [], 'no fetch, push or ls-remote ran');
      assert.equal(JSON.stringify(calls).includes(address), false, 'the address never reached a git argument or environment value');
      assert.equal(JSON.stringify(appended).includes('echo'), false, 'the refusal does not repeat the address');
    });
  });
}

const REWRITTEN_TEXT = "The team's coordination log was rewritten on the remote; Team Mode is paused";

function mirrorOf(fixture: TeamFixture, name: string): string {
  return path.join(fixture.storageDir(name), 'coordination.git');
}

// Replaces the coordination branch on the remote with an unrelated history, as a hostile or careless force push would.
function rewriteRemote(fixture: TeamFixture, via: string): void {
  gitIn(fixture.remote, ['config', 'receive.denyNonFastForwards', 'false']);
  const dir = fixture.clones[via] as string;
  gitIn(dir, ['checkout', '-q', '--orphan', 'rewrite']);
  gitIn(dir, ['commit', '-q', '--allow-empty', '-m', 'rewrite']);
  gitIn(dir, ['push', '-q', '--force', 'origin', `rewrite:${DEFAULT_COORDINATION_REF}`]);
  gitIn(fixture.remote, ['config', 'receive.denyNonFastForwards', 'true']);
}

// A fast-forward checkout of the coordination branch in a clone, for tests that need to commit unusual history.
function checkoutCoordination(fixture: TeamFixture, name: string): string {
  const dir = fixture.clones[name] as string;
  gitIn(dir, ['fetch', '-q', 'origin', `+${DEFAULT_COORDINATION_REF}:refs/work/coordination`]);
  gitIn(dir, ['checkout', '-q', '--detach', 'refs/work/coordination']);
  return dir;
}

function pushCoordination(dir: string): void {
  gitIn(dir, ['push', '-q', 'origin', `HEAD:${DEFAULT_COORDINATION_REF}`]);
}

test('an unreachable remote makes the transport offline with a redacted reason, then recovers when the remote is back', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const { teamId, owner } = await seedLog(fixture, 'a');
    const b = recClient(fixture, 'b');
    const clone = fixture.clones['b'] as string;
    const user = `user${randomBytes(5).toString('hex')}`;
    const password = `pw${randomBytes(8).toString('hex')}`;
    gitIn(clone, ['remote', 'set-url', 'origin', `http://${user}:${password}@127.0.0.1:1/team.git`]);

    assert.deepEqual(await b.fetch(), []);
    assert.equal(b.status().state, 'offline');
    const reason = b.status().reason ?? '';
    assert.ok(reason.length > 0);
    assert.equal(reason.includes(password), false);
    assert.equal(reason.includes(user), false);
    const append = await b.append(availability(owner, teamId));
    assert.equal(append.ok, false);
    if (!append.ok) {
      assert.equal(append.kind, 'offline');
      assert.equal(append.reason.includes(password), false);
      assert.equal(append.reason.includes(user), false);
    }
    const config = gitIn(mirrorOf(fixture, 'b'), ['config', '--local', '--list']);
    assert.equal(config.includes(password), false, 'the URL is never written into the mirror config');

    gitIn(clone, ['remote', 'set-url', 'origin', fixture.remote]);
    const entries = await b.fetch();
    assert.ok(entries.length > 0);
    assert.equal(b.status().state, 'ok');
    assert.equal(b.status().reason, undefined);
  });
});

test('a credential prompt failure is offline with the hint to run git fetch once in a terminal', async () => {
  await withFixture(['a'], async (fixture) => {
    await seedLog(fixture, 'a');
    const denied = fakeGitResult(128, '', "fatal: could not read Username for 'https://example.invalid': terminal prompts disabled");
    const client = recClient(fixture, 'a', { git: faultRunner(runGit, [{ when: (args) => args.includes('fetch'), replace: () => denied }]) });
    await client.fetch();
    assert.equal(client.status().state, 'offline');
    assert.ok((client.status().reason ?? '').includes('Run git fetch once in a terminal so your credential helper can store the credentials.'));
  });
});

test('a rewritten remote branch pauses the transport, quarantines the old head and keeps the last trusted history', async () => {
  await withFixture(['a', 'b', 'c'], async (fixture) => {
    const { teamId, owner, client: a } = await seedLog(fixture, 'a');
    assert.equal((await a.append(availability(owner, teamId))).ok, true);
    const b = recClient(fixture, 'b');
    await b.fetch();
    const oldHead = gitIn(fixture.remote, ['rev-parse', DEFAULT_COORDINATION_REF]);
    const before = JSON.stringify(b.state());
    const entriesBefore = b.state().entries.length;

    rewriteRemote(fixture, 'c');
    assert.deepEqual(await b.fetch(), []);
    assert.equal(b.status().state, 'paused');
    assert.equal(b.status().reason, REWRITTEN_TEXT);
    assert.equal(gitIn(mirrorOf(fixture, 'b'), ['rev-parse', `${QUARANTINE_REF_PREFIX}${oldHead.slice(0, 12)}`]), oldHead);
    assert.equal(JSON.stringify(b.state()), before, 'the serialised state does not change');
    assert.equal(gitIn(mirrorOf(fixture, 'b'), ['rev-parse', LOCAL_REF]), oldHead, 'the trusted head is not moved');
    const append = await b.append(availability(owner, teamId));
    assert.equal(append.ok, false);
    if (!append.ok) assert.equal(append.kind, 'paused');
    const trusted = await b.readAll();
    assert.equal(trusted.length, entriesBefore);
    assert.ok(trusted.every((entry) => entry.commit !== gitIn(fixture.remote, ['rev-parse', DEFAULT_COORDINATION_REF])));
  });
});

test('a saved position catches a rewrite even after the mirror directory was deleted', async () => {
  await withFixture(['a', 'b', 'c'], async (fixture) => {
    const { teamId, owner, client: a } = await seedLog(fixture, 'a');
    assert.equal((await a.append(availability(owner, teamId))).ok, true);
    const first = recClient(fixture, 'b');
    await first.fetch();
    const pin = JSON.parse(await readFile(path.join(fixture.storageDir('b'), 'pin.json'), 'utf8')) as { head: string; lamport: number; entries: number };
    assert.equal(pin.head, gitIn(fixture.remote, ['rev-parse', DEFAULT_COORDINATION_REF]));
    assert.equal(pin.lamport, 3);
    assert.equal(pin.entries, 4);

    rewriteRemote(fixture, 'c');
    await rm(mirrorOf(fixture, 'b'), { recursive: true, force: true });
    const second = recClient(fixture, 'b');
    assert.deepEqual(await second.fetch(), []);
    assert.equal(second.status().state, 'paused');
    assert.equal(second.status().reason, REWRITTEN_TEXT);
    const append = await second.append(availability(owner, teamId));
    assert.equal(append.ok, false);
    if (!append.ok) assert.equal(append.kind, 'paused');
  });
});

test('a saved position does not block a fresh mirror when the remote was only extended', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const { teamId, owner, client: a } = await seedLog(fixture, 'a');
    await recClient(fixture, 'b').fetch();
    assert.equal((await a.append(availability(owner, teamId))).ok, true);
    await rm(mirrorOf(fixture, 'b'), { recursive: true, force: true });
    const again = recClient(fixture, 'b');
    const entries = await again.fetch();
    assert.equal(again.status().state, 'ok');
    assert.equal(entries.length, 4);
  });
});

test('failing to compare heads is offline with a redacted reason and not a rewrite', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const { teamId, owner, client } = await seedLog(fixture, 'a');
    assert.equal((await client.append(availability(owner, teamId))).ok, true);
    assert.equal((await recClient(fixture, 'b').append(availability(owner, teamId))).ok, true, 'the remote moves ahead of the first mirror');
    const canary = `canary${randomBytes(6).toString('hex')}`;
    const broken = fakeGitResult(128, '', `fatal: bad object from https://user:${canary}@example.invalid/x.git`);
    const probing = recClient(fixture, 'a', { git: faultRunner(runGit, [{ when: (args) => args.includes('merge-base'), replace: () => broken }]) });
    await probing.fetch();
    assert.equal(probing.status().state, 'offline');
    const reason = probing.status().reason ?? '';
    assert.ok(reason.startsWith('Team sync could not compare coordination heads'), reason);
    assert.equal(reason.includes(canary), false);
  });
});

test('a commit that modifies an existing event file becomes an anomaly and the adding commit stays the source of truth', async () => {
  await withFixture(['a', 'b', 'c'], async (fixture) => {
    const { genesis } = await seedLog(fixture, 'a');
    const b = recClient(fixture, 'b');
    await b.fetch();
    const file = eventPath(genesis.events[0]);
    const original = gitIn(fixture.remote, ['show', `${DEFAULT_COORDINATION_REF}:${file}`]);
    const dir = checkoutCoordination(fixture, 'c');
    writeFileSync(path.join(dir, file), '{"tampered":true}', 'utf8');
    gitIn(dir, ['commit', '-q', '-am', 'edit an event']);
    pushCoordination(dir);

    const entries = await b.fetch();
    assert.deepEqual(entries.map((entry) => [entry.kind, entry.anomaly, entry.path]), [['anomaly', TEAM_REJECTION_REASONS.historyChanged, file]]);
    const seen = b.state().entries.filter((entry) => entry.path === file && entry.kind === 'event');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.kind, 'event');
    assert.equal(seen[0]?.text, original);
    const fresh = recClient(fixture, 'a');
    await rm(mirrorOf(fixture, 'a'), { recursive: true, force: true });
    await fresh.fetch();
    assert.equal(fresh.state().entries.filter((entry) => entry.path === file && entry.kind === 'event')[0]?.text, original, 'a full read also uses the adding commit');
  });
});

test('a commit that deletes a coordination file becomes an anomaly', async () => {
  await withFixture(['a', 'b', 'c'], async (fixture) => {
    const { genesis } = await seedLog(fixture, 'a');
    const b = recClient(fixture, 'b');
    await b.fetch();
    const file = eventPath(genesis.events[1]);
    const dir = checkoutCoordination(fixture, 'c');
    gitIn(dir, ['rm', '-q', file]);
    gitIn(dir, ['commit', '-q', '-m', 'remove an event']);
    pushCoordination(dir);
    const entries = await b.fetch();
    assert.deepEqual(entries.map((entry) => [entry.kind, entry.anomaly, entry.path]), [['anomaly', TEAM_REJECTION_REASONS.historyChanged, file]]);
  });
});

test('a merge commit becomes an anomaly and the merged-in history is ignored', async () => {
  await withFixture(['a', 'b', 'c'], async (fixture) => {
    await seedLog(fixture, 'a');
    const b = recClient(fixture, 'b');
    await b.fetch();
    const dir = checkoutCoordination(fixture, 'c');
    const tip = gitIn(dir, ['rev-parse', 'HEAD']);
    gitIn(dir, ['checkout', '-q', '-b', 'side']);
    writeFileSync(path.join(dir, 'side.txt'), 'merged in from the second parent', 'utf8');
    gitIn(dir, ['add', 'side.txt']);
    gitIn(dir, ['commit', '-q', '-m', 'side work']);
    gitIn(dir, ['checkout', '-q', '--detach', tip]);
    gitIn(dir, ['merge', '-q', '--no-ff', '-s', 'ours', 'side', '-m', 'merge side']);
    pushCoordination(dir);
    const entries = await b.fetch();
    assert.deepEqual(entries.map((entry) => [entry.kind, entry.anomaly]), [['anomaly', TEAM_REJECTION_REASONS.mergeCommit]]);
    assert.equal(b.state().entries.some((entry) => entry.path === 'side.txt'), false);
  });
});

test('files outside events, snapshots and the root team file are anomalies', async () => {
  await withFixture(['a', 'b', 'c'], async (fixture) => {
    await seedLog(fixture, 'a');
    const b = recClient(fixture, 'b');
    await b.fetch();
    const dir = checkoutCoordination(fixture, 'c');
    mkdirSync(path.join(dir, 'events', 'nested'), { recursive: true });
    writeFileSync(path.join(dir, 'events', 'nested', 'x.json'), '{}', 'utf8');
    writeFileSync(path.join(dir, 'notes.txt'), 'hello', 'utf8');
    gitIn(dir, ['add', 'events/nested/x.json', 'notes.txt']);
    gitIn(dir, ['commit', '-q', '-m', 'extra files']);
    pushCoordination(dir);
    const entries = await b.fetch();
    assert.deepEqual(entries.map((entry) => [entry.kind, entry.anomaly, entry.path]), [
      ['anomaly', TEAM_REJECTION_REASONS.unexpectedPath, 'events/nested/x.json'],
      ['anomaly', TEAM_REJECTION_REASONS.unexpectedPath, 'notes.txt']
    ]);
  });
});

test('a failing global pre-push hook does not stop a coordination push', { skip: process.platform === 'win32' }, async () => {
  await withFixture(['a'], async (fixture) => {
    const hooks = await mkdtemp(path.join(tmpdir(), 'near-ai-team-hooks-'));
    writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\nexit 1\n', 'utf8');
    chmodSync(path.join(hooks, 'pre-push'), 0o755);
    const config = withGlobalGitConfig(['[core]', `\thooksPath = ${hooks}`]);
    try {
      const control = (): void => {
        execFileSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/hook-control'], { cwd: fixture.clones['a'], env: { ...process.env, ...config.env }, stdio: 'ignore' });
      };
      assert.throws(control, 'the global hook really does block an ordinary push');
      const withHooks: GitRunner = (args, options) => runGit(args, { ...options, env: { ...options?.env, ...config.env } });
      const { teamId, owner, client } = await seedLog(fixture, 'a', { git: withHooks });
      const result = await client.append(availability(owner, teamId));
      assert.equal(result.ok, true);
      assert.equal(remoteEventFiles(fixture).length, 3);
    } finally {
      await config.cleanup();
      await rm(hooks, { recursive: true, force: true });
    }
  });
});

test('the mirror never stores the remote and checks incoming objects', async () => {
  await withFixture(['a'], async (fixture) => {
    const { teamId, owner, client } = await seedLog(fixture, 'a');
    assert.equal((await client.append(availability(owner, teamId))).ok, true);
    const lines = gitIn(mirrorOf(fixture, 'a'), ['config', '--local', '--list']).split('\n');
    assert.equal(lines.some((line) => line.toLowerCase().startsWith('remote.')), false);
    assert.equal(lines.some((line) => line.includes(fixture.remote)), false);
    assert.ok(lines.map((line) => line.toLowerCase()).includes('transfer.fsckobjects=true'));
  });
});

test('update listeners receive new entries until disposed; diagnostics are redacted', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const { teamId, owner, client: a } = await seedLog(fixture, 'a');
    const canary = `canary${randomBytes(6).toString('hex')}`;
    const gcFailure = fakeGitResult(1, '', `fatal: gc failed near https://user:${canary}@example.invalid/x.git`);
    const b = recClient(fixture, 'b', { gcEveryOperations: 1, git: faultRunner(runGit, [{ when: (args) => args.includes('gc'), replace: () => gcFailure }]) });
    const batches: number[] = [];
    const diagnostics: string[] = [];
    const subscription = b.onUpdate((entries) => { batches.push(entries.length); });
    const diagnosticSubscription = b.onDiagnostic((message) => { diagnostics.push(message); });

    await b.fetch();
    assert.deepEqual(batches, [3]);
    assert.equal(diagnostics.length, 1);
    assert.ok(diagnostics[0]?.includes('Maintenance'));
    assert.equal(diagnostics[0]?.includes(canary), false);
    assert.equal(b.status().state, 'ok', 'a failed gc does not change the status');

    subscription.dispose();
    diagnosticSubscription.dispose();
    assert.equal((await a.append(availability(owner, teamId))).ok, true);
    await b.fetch();
    assert.deepEqual(batches, [3]);
    assert.equal(diagnostics.length, 1);
    assert.equal(b.head().lamport, 3);
  });
});

test('a coordination branch deleted on the remote after it was read shows a visible state and recovers when it returns (WR-10)', async () => {
  await withFixture(['a', 'b', 'c'], async (fixture) => {
    const teamId = newTeamId();
    const owner = await createOwner(teamId);
    const genesis = testGenesis({ teamId, owner, name: 'Deleted branch team' });
    const a = clientFor(fixture, 'a', genesis.anchor);
    assert.equal((await a.append(async () => genesis.events, { genesis: { teamFileText: genesis.teamFileText } })).ok, true);
    const b = clientFor(fixture, 'b', genesis.anchor);
    await b.fetch();
    assert.deepEqual(b.status(), { state: 'ok' });

    const head = gitIn(fixture.remote, ['rev-parse', DEFAULT_COORDINATION_REF]);
    gitIn(fixture.remote, ['update-ref', '-d', DEFAULT_COORDINATION_REF]);
    assert.deepEqual(await b.fetch(), []);
    assert.deepEqual(b.status(), { state: 'offline', reason: BRANCH_MISSING_REASON }, 'a branch this client has read is not reported as healthy when it is gone');
    assert.equal(b.state().accepted, 2, 'the last good state is kept');

    // A client that never read the branch still treats an absent branch as normal (a team being created).
    const c = clientFor(fixture, 'c', genesis.anchor);
    await c.fetch();
    assert.deepEqual(c.status(), { state: 'ok' });

    gitIn(fixture.remote, ['update-ref', DEFAULT_COORDINATION_REF, head]);
    await b.fetch();
    assert.deepEqual(b.status(), { state: 'ok' }, 'sync resumes when the branch is back');
  });
});

interface RecordedCall { args: string[]; env: Record<string, string> | undefined }

function recordingRunner(calls: RecordedCall[], reportedVersion?: string): GitRunner {
  return async (args, options) => {
    calls.push({ args: [...args], env: options?.env === undefined ? undefined : { ...options.env } });
    if (reportedVersion !== undefined && args.length === 1 && args[0] === '--version') return fakeGitResult(0, `git version ${reportedVersion}\n`);
    return runGit(args, options);
  };
}

test('the remote URL travels in the git process environment, never in its arguments (WR-12)', async () => {
  await withFixture(['a'], async (fixture) => {
    const teamId = newTeamId();
    const owner = await createOwner(teamId);
    const genesis = testGenesis({ teamId, owner, name: 'Environment URL team' });
    const calls: RecordedCall[] = [];
    const transport = new GitTransport<TeamState>({
      mirrorDir: path.join(fixture.storageDir('a'), 'coordination.git'), projectRoot: fixture.clones['a'] as string, remote: 'origin',
      ref: DEFAULT_COORDINATION_REF, materializer: teamMaterializer(genesis.anchor), git: recordingRunner(calls), baseDelayMs: 1
    });
    assert.equal((await transport.append(async () => genesis.events, { genesis: { teamFileText: genesis.teamFileText } })).ok, true);
    await transport.fetch();
    const url = fixture.remote;
    const network = calls.filter((call) => ['fetch', 'push', 'ls-remote'].some((verb) => call.args.includes(verb)) && call.args.includes('--git-dir'));
    assert.ok(network.length >= 3, 'ls-remote, push and fetch all ran');
    for (const call of network) {
      assert.equal(call.args.some((arg) => arg.includes(url)), false, `no argument carries the URL: ${call.args.join(' ')}`);
      assert.equal(call.env?.['GIT_CONFIG_COUNT'], '1');
      assert.equal(call.env?.['GIT_CONFIG_KEY_0'], 'remote.near-ai-team.url');
      assert.equal(call.env?.['GIT_CONFIG_VALUE_0'], url);
    }
    assert.equal(gitIn(path.join(fixture.storageDir('a'), 'coordination.git'), ['config', '--local', '--list']).includes(url), false, 'the mirror config does not keep it');
  });
});

test('a git older than 2.31 falls back to passing the URL as an argument and still works (WR-12)', async () => {
  await withFixture(['a'], async (fixture) => {
    const teamId = newTeamId();
    const owner = await createOwner(teamId);
    const genesis = testGenesis({ teamId, owner, name: 'Old git team' });
    const calls: RecordedCall[] = [];
    const transport = new GitTransport<TeamState>({
      mirrorDir: path.join(fixture.storageDir('a'), 'coordination.git'), projectRoot: fixture.clones['a'] as string, remote: 'origin',
      ref: DEFAULT_COORDINATION_REF, materializer: teamMaterializer(genesis.anchor), git: recordingRunner(calls, '2.30.2'), baseDelayMs: 1
    });
    assert.equal((await transport.append(async () => genesis.events, { genesis: { teamFileText: genesis.teamFileText } })).ok, true);
    assert.ok(calls.some((call) => call.args.includes('push') && call.args.includes(fixture.remote)), 'the push used the URL argument');
    assert.equal(calls.some((call) => call.env?.['GIT_CONFIG_COUNT'] !== undefined), false);
  });
});
