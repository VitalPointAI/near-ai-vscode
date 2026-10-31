// Tracer for Team Mode: a signed genesis batch travels from client A to client B through a real bare remote.
// Covers the Ed25519 signing scheme (D-06), the genesis anchor (D-10), the git compare-and-swap ref (D-03) and neutral commits (D-04).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { eventPath } from '../domain/team/canonical';
import { serialiseState, teamMaterializer } from '../domain/team/materialize';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { GenesisAnchor, LogHead, TeamEvent, TeamState } from '../domain/team/types';
import { CAS_LOST_MARKERS, DEFAULT_COORDINATION_REF, GitTransport, LOCAL_REF, QUARANTINE_REF_PREFIX, RETRYABLE_FETCH_MARKERS, classifyGitFailure, classifyPush } from '../team/gitTransport';
import type { GitTransportOptions } from '../team/gitTransport';
import { newTeamId } from '../team/identity';
import { redactGitMessage, runGit } from '../team/runGit';
import type { AppendBuilder } from '../team/transport';
import { createOwner, createTeamFixture, faultRunner, fakeGitResult, gitIn, recordingMaterializer, testEvent, testGenesis } from './helpers/teamHarness';
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
