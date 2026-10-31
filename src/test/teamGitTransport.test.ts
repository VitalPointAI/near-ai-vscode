// Tracer for Team Mode: a signed genesis batch travels from client A to client B through a real bare remote.
// Covers the Ed25519 signing scheme (D-06), the genesis anchor (D-10), the git compare-and-swap ref (D-03) and neutral commits (D-04).
import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import { eventPath } from '../domain/team/canonical';
import { serialiseState, teamMaterializer } from '../domain/team/materialize';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { GenesisAnchor, TeamState } from '../domain/team/types';
import { DEFAULT_COORDINATION_REF, GitTransport, LOCAL_REF } from '../team/gitTransport';
import { newTeamId } from '../team/identity';
import { redactGitMessage } from '../team/runGit';
import { createOwner, createTeamFixture, gitIn, testGenesis } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';

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
