// Success criterion 3 on real git: events a malicious member pushes raw (bypassing TeamLog) are rejected identically by every client, never change
// state and are listed by verifyAll. Write and read share one decideTeamAction, so the text TeamLog refuses with equals the text a reader records.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalize, eventPath } from '../domain/team/canonical';
import { applyEntry, cloneState, reduce, serialiseState, teamMaterializer } from '../domain/team/materialize';
import { PERMISSION_REASONS } from '../domain/team/permissions';
import { defaultTeamPolicy } from '../domain/team/policy';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { GenesisAnchor, Rejection, TeamEvent, TeamFile, TeamState } from '../domain/team/types';
import { TeamLog, buildGenesisEvents, prepareEvents } from '../team/eventLog';
import type { EventIntent, TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { newEventId, newTeamId, signEvent } from '../team/identity';
import { NEUTRAL_IDENTITY_ENV } from '../team/runGit';
import { canonicalTeamFile } from '../team/teamFile';
import { createOwner, createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture, TestOwner } from './helpers/teamHarness';
import { addFixtureMember, entryOf, genesisEntries, makeActor, makeDevice, signed } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';

const fixedNow = (): Date => new Date('2026-02-03T04:05:06.000Z');

interface Client { transport: GitTransport<TeamState>; log: TeamLog }

function clientFor(fixture: TeamFixture, name: string, anchor: GenesisAnchor, signer?: TeamSigner): Client {
  const transport = new GitTransport<TeamState>({
    mirrorDir: path.join(fixture.storageDir(name), 'coordination.git'),
    projectRoot: fixture.clones[name] as string,
    remote: 'origin',
    ref: DEFAULT_COORDINATION_REF,
    materializer: teamMaterializer(anchor),
    baseDelayMs: 1
  });
  return { transport, log: new TeamLog({ anchor, transport, now: fixedNow, ...(signer === undefined ? {} : { signer }) }) };
}

async function withFixture(names: string[], run: (fixture: TeamFixture) => Promise<void>): Promise<void> {
  const fixture = await createTeamFixture({ clones: names });
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}

interface Seed { teamId: string; owner: TestOwner; signer: TeamSigner; anchor: GenesisAnchor; a: Client; valid: TeamEvent }

// Client A writes the genesis and one valid event, so there is accepted history for the forgeries to be measured against.
async function seedTeam(fixture: TeamFixture): Promise<Seed> {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const genesis = buildGenesisEvents({
    teamId, teamName: 'Forgery team', owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [] },
    identity: owner.identity, policy: defaultTeamPolicy(), now: fixedNow
  });
  const teamFile: TeamFile = {
    version: 1, teamId, name: 'Forgery team', coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: genesis.anchor.eventId, ownerDevice: genesis.anchor.ownerDevice }, createdAt: '2026-02-03T04:05:06.000Z'
  };
  const signer: TeamSigner = { identity: owner.identity, memberId: owner.memberId };
  const a = clientFor(fixture, 'a', genesis.anchor, signer);
  assert.equal((await a.transport.append(async () => genesis.events, { genesis: { teamFileText: canonicalTeamFile(teamFile) } })).ok, true);
  const first = await a.log.append(() => [{ type: 'member.availability', body: { availability: 'focus' } }]);
  assert.equal(first.ok, true);
  const valid = first.ok ? (first.events[0] as TeamEvent) : undefined;
  assert.ok(valid !== undefined);
  return { teamId, owner, signer, anchor: genesis.anchor, a, valid: valid as TeamEvent };
}

function rawGit(cwd: string, args: string[], options: { env?: Record<string, string>; input?: string } = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...options.env }, input: options.input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// What a malicious member's git access allows: add any file to the coordination branch and push it as an ordinary fast-forward.
// The sequence mirrors the transport's plumbing (throw-away index, blobs, tree, commit) but skips every TeamLog check.
function rawPush(dir: string, events: TeamEvent[], message: string): void {
  rawGit(dir, ['fetch', '-q', 'origin', `+${DEFAULT_COORDINATION_REF}:refs/raw/coordination`]);
  const parent = rawGit(dir, ['rev-parse', 'refs/raw/coordination']);
  const indexFile = path.join(dir, '.git', `raw-index-${randomBytes(4).toString('hex')}`);
  const env = { GIT_INDEX_FILE: indexFile, ...NEUTRAL_IDENTITY_ENV };
  try {
    rawGit(dir, ['read-tree', parent], { env });
    for (const event of events) {
      const blob = rawGit(dir, ['hash-object', '-w', '--stdin'], { env, input: canonicalize(event) });
      rawGit(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${eventPath(event)}`], { env });
    }
    const tree = rawGit(dir, ['write-tree'], { env });
    const commit = rawGit(dir, ['commit-tree', tree, '-p', parent, '-m', message], { env });
    rawGit(dir, ['push', '-q', 'origin', `${commit}:${DEFAULT_COORDINATION_REF}`]);
  } finally {
    rmSync(indexFile, { force: true });
  }
}

function withoutRejections(state: TeamState): string {
  const copy = cloneState(state);
  copy.rejected = [];
  return serialiseState(copy);
}

interface Forgery { label: string; event: TeamEvent; reason: string }

async function forgeriesFor(seed: Seed): Promise<Forgery[]> {
  const { teamId, owner, valid } = seed;
  const stranger = await makeActor(teamId);
  const position = { teamId, lamport: valid.lamport + 1, prev: valid.id };
  const base = signed(owner, { ...position, type: 'member.availability', body: { availability: 'away' } });
  const tampered: TeamEvent = { ...base, body: { availability: 'focus' } };
  const outsider = signEvent(stranger.identity, {
    v: 1, id: newEventId(), teamId, type: 'member.availability', lamport: position.lamport, at: '2026-02-03T04:05:07.000Z',
    author: owner.memberId, device: stranger.identity.fingerprint, prev: valid.id, body: { availability: 'away' }
  });
  const selfRole = signed(owner, { ...position, type: 'member.role-changed', body: { memberId: owner.memberId, role: 'lead' } });
  // The same id again under a new file name: the lamport differs, so the file name still matches its own event.
  const replay = signed(owner, { ...position, id: valid.id, type: 'member.availability', body: { availability: 'away' } });
  const otherTeam = signed(owner, { ...position, teamId: newTeamId(), type: 'member.availability', body: { availability: 'away' } });
  return [
    { label: 'tampered body', event: tampered, reason: TEAM_REJECTION_REASONS.badSignature },
    { label: 'outsider key claiming the owner', event: outsider, reason: TEAM_REJECTION_REASONS.unboundDevice },
    { label: 'owner changing its own role', event: selfRole, reason: `${TEAM_REJECTION_REASONS.notPermitted}: ${PERMISSION_REASONS.ownRole}` },
    { label: 'replayed event id', event: replay, reason: TEAM_REJECTION_REASONS.duplicate },
    { label: 'another team', event: otherTeam, reason: TEAM_REJECTION_REASONS.wrongTeam }
  ];
}

test('raw forged events are rejected with the same reasons by both clients, never change state and are listed by verifyAll', async () => {
  await withFixture(['a', 'b', 'raw'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const b = clientFor(fixture, 'b', seed.anchor);
    await b.log.sync();
    const beforeA = withoutRejections(seed.a.log.state());
    const beforeB = withoutRejections(b.log.state());
    assert.equal(beforeA, beforeB);
    assert.deepEqual(seed.a.log.state().rejected, []);

    const forgeries = await forgeriesFor(seed);
    for (const forgery of forgeries) rawPush(fixture.clones['raw'] as string, [forgery.event], `raw: ${forgery.label}`);
    const expected: Rejection[] = forgeries.map((forgery) => ({ eventId: forgery.event.id, reason: forgery.reason }));
    // The replayed id is the original event's id: the rejection names it, which is what a reader sees in its list.
    assert.equal(expected[3]?.eventId, seed.valid.id);

    const syncedA = await seed.a.log.sync();
    const syncedB = await b.log.sync();
    assert.deepEqual(syncedA.rejected, expected);
    assert.deepEqual(syncedB.rejected, expected);
    assert.deepEqual(syncedA.accepted, []);
    assert.deepEqual(syncedB.accepted, []);
    assert.equal(syncedA.entries.length, 5);

    assert.equal(withoutRejections(seed.a.log.state()), beforeA, 'A state is unchanged by the forgeries');
    assert.equal(withoutRejections(b.log.state()), beforeB, 'B state is unchanged by the forgeries');
    assert.equal(serialiseState(seed.a.log.state()), serialiseState(b.log.state()));

    for (const client of [seed.a, b]) {
      const report = await client.log.verifyAll();
      assert.deepEqual(report.rejected, expected);
      assert.equal(report.accepted, 3);
      assert.equal(report.events, 8);
      assert.deepEqual(report.head, { eventId: seed.valid.id, lamport: seed.valid.lamport });
    }
  });
});

test('a rejected event never poisons the high-water mark: the next honest event takes the very next lamport and both clients accept it', async () => {
  await withFixture(['a', 'b', 'raw'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const b = clientFor(fixture, 'b', seed.anchor);
    for (const forgery of await forgeriesFor(seed)) rawPush(fixture.clones['raw'] as string, [forgery.event], `raw: ${forgery.label}`);
    await b.log.sync();
    assert.equal(b.log.state().rejected.length, 5);
    assert.equal(b.log.state().highLamport, seed.valid.lamport);

    const next = await seed.a.log.append(() => [{ type: 'member.availability', body: { availability: 'available' } }]);
    assert.equal(next.ok, true);
    if (next.ok) assert.equal((next.events[0] as TeamEvent).lamport, seed.valid.lamport + 1);
    const afterB = await b.log.sync();
    assert.equal(afterB.accepted.length, 1);
    assert.deepEqual(afterB.rejected, []);
    assert.equal(serialiseState(seed.a.log.state()), serialiseState(b.log.state()));
  });
});

test('write and read share one decision: the refusal text equals the reason recorded for the raw-pushed copy', async () => {
  await withFixture(['a', 'raw'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const intent: EventIntent = { type: 'member.role-changed', body: { memberId: seed.owner.memberId, role: 'lead' } };
    const prepared = prepareEvents(seed.a.log.state(), seed.a.log.state().head, seed.signer, [intent], fixedNow);
    assert.ok('conflict' in prepared, 'the write side refuses');

    const copy = signed(seed.owner, { teamId: seed.teamId, type: 'member.role-changed', body: intent.body, lamport: seed.valid.lamport + 1, prev: seed.valid.id });
    rawPush(fixture.clones['raw'] as string, [copy], 'raw: self role change');
    const synced = await seed.a.log.sync();
    assert.equal(synced.rejected.length, 1);
    assert.equal(synced.rejected[0]?.eventId, copy.id);
    if ('conflict' in prepared) assert.equal(prepared.conflict, synced.rejected[0]?.reason);

    const refused = await seed.a.log.append(() => [intent]);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, synced.rejected[0]?.reason);
  });
});

interface RoleCase { label: string; actor: TestActor; intent: EventIntent }

interface RoleWorld {
  teamId: string; owner: TestActor; lead: TestActor; developer: TestActor; reviewer: TestActor; spareDevice: { fingerprint: string; publicKey: string };
  decide(candidate: RoleCase): { prepared: TeamEvent[] | { conflict: string }; read: Rejection | undefined };
}

// Phase 60 logs can only hold the owner as a member, so the multi-role cases place members straight into a replayed state (see teamEvents.ts).
async function roleWorld(): Promise<RoleWorld> {
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const { entries, anchor } = genesisEntries(owner, teamId);
  const state = reduce(entries, anchor);
  const lead = await makeActor(teamId);
  const developer = await makeActor(teamId);
  const reviewer = await makeActor(teamId);
  const spare = await makeActor(teamId);
  addFixtureMember(state, lead, 'lead', 'Lead member');
  addFixtureMember(state, developer, 'developer', 'Developer member');
  addFixtureMember(state, reviewer, 'reviewer', 'Reviewer member');
  const spareDevice = { fingerprint: spare.identity.fingerprint, publicKey: spare.identity.publicKey };
  const signerOf = (actor: TestActor): TeamSigner => ({ identity: actor.identity, memberId: actor.memberId });
  const decide = (candidate: RoleCase): ReturnType<RoleWorld['decide']> => {
    const prepared = prepareEvents(state, state.head, signerOf(candidate.actor), [candidate.intent], fixedNow);
    const event = Array.isArray(prepared)
      ? (prepared[0] as TeamEvent)
      : signed(candidate.actor, { teamId, type: candidate.intent.type, body: candidate.intent.body, lamport: state.head.lamport + 1, prev: state.head.eventId });
    const verdict = applyEntry(cloneState(state), entryOf(event));
    return { prepared, read: verdict.accepted ? undefined : verdict.rejection };
  };
  return { teamId, owner, lead, developer, reviewer, spareDevice, decide };
}

test('a denied role case gets the same text from prepareEvents as applyEntry records for the signed event', async () => {
  const { owner, lead, developer, reviewer, spareDevice, decide } = await roleWorld();
  const denied: RoleCase[] = [
    { label: 'developer changes policy', actor: developer, intent: { type: 'policy.changed', body: { changes: { dispatchMode: 'auto' } } } },
    { label: 'lead removes the owner', actor: lead, intent: { type: 'member.removed', body: { memberId: owner.memberId } } },
    { label: 'lead adds a device for the owner', actor: lead, intent: { type: 'device.added', body: { memberId: owner.memberId, device: spareDevice } } },
    { label: 'lead changes the owner role', actor: lead, intent: { type: 'member.role-changed', body: { memberId: owner.memberId, role: 'developer' } } },
    { label: 'developer removes the reviewer', actor: developer, intent: { type: 'member.removed', body: { memberId: reviewer.memberId } } },
    { label: 'reviewer edits the owner skills', actor: reviewer, intent: { type: 'member.skills', body: { memberId: owner.memberId, skills: ['rust'] } } },
    { label: 'developer adds a device for the lead', actor: developer, intent: { type: 'device.added', body: { memberId: lead.memberId, device: spareDevice } } },
    { label: 'lead promotes a developer to owner', actor: lead, intent: { type: 'member.role-changed', body: { memberId: developer.memberId, role: 'owner' } } },
    { label: 'lead rotates a device of the owner', actor: lead, intent: { type: 'device.rotated', body: { memberId: owner.memberId, from: owner.identity.fingerprint, device: spareDevice } } },
    { label: 'developer rotates a device of the lead', actor: developer, intent: { type: 'device.rotated', body: { memberId: lead.memberId, from: lead.identity.fingerprint, device: spareDevice } } }
  ];
  for (const candidate of denied) {
    const { prepared, read } = decide(candidate);
    assert.ok(!Array.isArray(prepared), `${candidate.label}: the write side refuses`);
    assert.ok(read !== undefined, `${candidate.label}: the read side rejects`);
    if (!Array.isArray(prepared)) assert.equal(prepared.conflict, read?.reason, candidate.label);
    assert.ok(read?.reason.startsWith(`${TEAM_REJECTION_REASONS.notPermitted}: `), candidate.label);
  }
});

test('an allowed role case is allowed by prepareEvents and accepted by applyEntry', async () => {
  const { owner, lead, developer, reviewer, spareDevice, decide } = await roleWorld();
  const allowed: RoleCase[] = [
    { label: 'owner changes policy', actor: owner, intent: { type: 'policy.changed', body: { changes: { dispatchMode: 'auto' } } } },
    { label: 'lead sets availability', actor: lead, intent: { type: 'member.availability', body: { availability: 'away' } } },
    { label: 'developer edits own skills', actor: developer, intent: { type: 'member.skills', body: { memberId: developer.memberId, skills: ['rust'] } } },
    { label: 'lead edits another member skills', actor: lead, intent: { type: 'member.skills', body: { memberId: reviewer.memberId, skills: ['docs'] } } },
    { label: 'lead promotes a developer to reviewer', actor: lead, intent: { type: 'member.role-changed', body: { memberId: developer.memberId, role: 'reviewer' } } },
    { label: 'developer rotates their own key', actor: developer, intent: { type: 'device.rotated', body: { memberId: developer.memberId, from: developer.identity.fingerprint, device: spareDevice } } },
    { label: 'lead rotates the key of a reviewer', actor: lead, intent: { type: 'device.rotated', body: { memberId: reviewer.memberId, from: reviewer.identity.fingerprint, device: spareDevice } } },
    { label: 'owner rotates their own key', actor: owner, intent: { type: 'device.rotated', body: { memberId: owner.memberId, from: owner.identity.fingerprint, device: spareDevice } } }
  ];
  for (const candidate of allowed) {
    const { prepared, read } = decide(candidate);
    assert.ok(Array.isArray(prepared), `${candidate.label}: the write side allows`);
    assert.equal(read, undefined, `${candidate.label}: the read side accepts`);
  }
});

test('rotation forgeries pushed raw are rejected by both clients with the matching reasons and never change state', async () => {
  await withFixture(['a', 'b', 'raw'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const owner = seed.owner;
    const second = await makeDevice(owner);
    const third = await makeDevice(owner);
    const fourth = await makeDevice(owner);
    const stranger = await makeActor(seed.teamId);
    const b = clientFor(fixture, 'b', seed.anchor);
    const added = await seed.a.log.append(() => [{ type: 'device.added', body: { memberId: owner.memberId, device: { fingerprint: second.identity.fingerprint, publicKey: second.identity.publicKey } } }]);
    assert.equal(added.ok, true);
    const rawDir = fixture.clones['raw'] as string;
    const position = (): { teamId: string; lamport: number; prev: string } => {
      const head = seed.a.log.state().head;
      return { teamId: seed.teamId, lamport: head.lamport + 1, prev: head.eventId };
    };
    const refOf = (actor: TestActor): { fingerprint: string; publicKey: string } => ({ fingerprint: actor.identity.fingerprint, publicKey: actor.identity.publicKey });
    // A valid self-rotation of the second key, pushed raw: both clients accept it.
    const rotation = signed(second, { ...position(), type: 'device.rotated', body: { memberId: owner.memberId, from: second.identity.fingerprint, device: refOf(third) } });
    rawPush(rawDir, [rotation], 'raw: valid rotation');
    const syncedA = await seed.a.log.sync();
    assert.deepEqual(syncedA.rejected, []);
    assert.deepEqual(syncedA.accepted.map((event) => event.id), [rotation.id]);
    assert.deepEqual((await b.log.sync()).rejected, []);
    const beforeA = withoutRejections(seed.a.log.state());
    assert.equal(beforeA, withoutRejections(b.log.state()));

    const forgeries: Forgery[] = [
      { label: 'from is not bound to the member', event: signed(owner, { ...position(), type: 'device.rotated', body: { memberId: owner.memberId, from: stranger.identity.fingerprint, device: refOf(fourth) } }), reason: TEAM_REJECTION_REASONS.deviceNotBound },
      { label: 'from is already rotated', event: signed(owner, { ...position(), type: 'device.rotated', body: { memberId: owner.memberId, from: second.identity.fingerprint, device: refOf(fourth) } }), reason: TEAM_REJECTION_REASONS.deviceRotated },
      { label: 'self-rotation signed by another of the member keys', event: signed(owner, { ...position(), type: 'device.rotated', body: { memberId: owner.memberId, from: third.identity.fingerprint, device: refOf(fourth) } }), reason: TEAM_REJECTION_REASONS.rotationNotByOldKey },
      { label: 'the retired key signs after its rotation', event: signed(second, { ...position(), type: 'member.availability', body: { availability: 'away' } }), reason: TEAM_REJECTION_REASONS.rotatedDevice }
    ];
    for (const forgery of forgeries) rawPush(rawDir, [forgery.event], `raw: ${forgery.label}`);
    const expected: Rejection[] = forgeries.map((forgery) => ({ eventId: forgery.event.id, reason: forgery.reason }));
    const afterA = await seed.a.log.sync();
    const afterB = await b.log.sync();
    assert.deepEqual(afterA.rejected, expected);
    assert.deepEqual(afterB.rejected, expected);
    assert.deepEqual(afterA.accepted, []);
    assert.equal(withoutRejections(seed.a.log.state()), beforeA, 'the forgeries change nothing but the rejection list');
    assert.equal(serialiseState(seed.a.log.state()), serialiseState(b.log.state()));
    for (const client of [seed.a, b]) {
      const report = await client.log.verifyAll();
      assert.deepEqual(report.rejected, expected);
      assert.equal(report.head.eventId, rotation.id);
    }
  });
});
