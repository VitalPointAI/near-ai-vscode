// TeamLog on real git: genesis builder, write-side checks inside the transport builder, two-clone convergence, verifyAll and the snapshot writer.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import test, { mock } from 'node:test';
import { verifyEventSignature } from '../domain/team/canonical';
import { parseSnapshotFile, reduce, serialiseState, stateHash, teamMaterializer } from '../domain/team/materialize';
import { PERMISSION_REASONS } from '../domain/team/permissions';
import { defaultTeamPolicy } from '../domain/team/policy';
import { SecretLeakError } from '../domain/team/secrets';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { GenesisAnchor, LogHead, TeamEvent, TeamFile, TeamState } from '../domain/team/types';
import { DEFAULT_SNAPSHOT_EVERY, NO_DEVICE_KEY_MESSAGE, SNAPSHOT_ALREADY_WRITTEN, TeamLog, buildGenesisEvents, prepareEvents } from '../team/eventLog';
import type { EventIntent, TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { emailHash, newTeamId } from '../team/identity';
import { runGit } from '../team/runGit';
import type { GitRunner } from '../team/runGit';
import type { CoordinationTransport } from '../team/transport';
import { canonicalTeamFile } from '../team/teamFile';
import { fakeGitResult, createOwner, createTeamFixture, faultRunner, gitIn } from './helpers/teamHarness';
import type { TeamFixture, TestOwner } from './helpers/teamHarness';
import { addFixtureMember, entryOf, makeActor, makeDevice, signed } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';

const R = TEAM_REJECTION_REASONS;
const fixedNow = (): Date => new Date('2026-02-03T04:05:06.000Z');

interface Client { transport: GitTransport<TeamState>; log: TeamLog }

function clientFor(fixture: TeamFixture, name: string, anchor: GenesisAnchor, signer?: TeamSigner, extra: { git?: GitRunner; snapshotEvery?: number; yieldEvery?: number } = {}): Client {
  const transport = new GitTransport<TeamState>({
    mirrorDir: path.join(fixture.storageDir(name), 'coordination.git'),
    projectRoot: fixture.clones[name] as string,
    remote: 'origin',
    ref: DEFAULT_COORDINATION_REF,
    materializer: teamMaterializer(anchor),
    ...(extra.git === undefined ? {} : { git: extra.git }),
    baseDelayMs: 1
  });
  const log = new TeamLog({
    anchor, transport, now: fixedNow,
    ...(signer === undefined ? {} : { signer }),
    ...(extra.snapshotEvery === undefined ? {} : { snapshotEvery: extra.snapshotEvery }),
    ...(extra.yieldEvery === undefined ? {} : { yieldEvery: extra.yieldEvery })
  });
  return { transport, log };
}

async function withFixture(names: string[], run: (fixture: TeamFixture) => Promise<void>): Promise<void> {
  const fixture = await createTeamFixture({ clones: names });
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}

interface Seed { teamId: string; owner: TestOwner; signer: TeamSigner; anchor: GenesisAnchor; a: Client; second: TestActor }

// Client A writes the genesis through the transport, exactly as Enable Team Mode will.
async function seedTeam(fixture: TeamFixture, extra: { snapshotEvery?: number } = {}): Promise<Seed> {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const genesis = buildGenesisEvents({
    teamId, teamName: 'Log team', owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [emailHash(teamId, 'owner@example.invalid')] },
    identity: owner.identity, policy: defaultTeamPolicy(), now: fixedNow
  });
  const teamFile: TeamFile = {
    version: 1, teamId, name: 'Log team', coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: genesis.anchor.eventId, ownerDevice: genesis.anchor.ownerDevice }, createdAt: '2026-02-03T04:05:06.000Z'
  };
  const signer: TeamSigner = { identity: owner.identity, memberId: owner.memberId };
  const a = clientFor(fixture, 'a', genesis.anchor, signer, extra);
  const written = await a.transport.append(async () => genesis.events, { genesis: { teamFileText: canonicalTeamFile(teamFile) } });
  assert.equal(written.ok, true);
  return { teamId, owner, signer, anchor: genesis.anchor, a, second: await makeDevice(owner) };
}

function remoteHead(fixture: TeamFixture): string {
  return gitIn(fixture.remote, ['rev-parse', DEFAULT_COORDINATION_REF]);
}

function remoteEventLamports(fixture: TeamFixture): number[] {
  return gitIn(fixture.remote, ['ls-tree', '-r', '--name-only', DEFAULT_COORDINATION_REF]).split('\n')
    .filter((line) => line.startsWith('events/')).map((line) => Number(line.slice('events/'.length, 'events/'.length + 12)));
}

function remoteSnapshotFiles(fixture: TeamFixture): string[] {
  return gitIn(fixture.remote, ['ls-tree', '-r', '--name-only', DEFAULT_COORDINATION_REF]).split('\n').filter((line) => line.startsWith('snapshots/'));
}

async function appendAvailability(client: Client, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const result = await client.log.append(() => [{ type: 'member.availability', body: { availability: index % 2 === 0 ? 'focus' : 'away' } }]);
    assert.equal(result.ok, true);
  }
}

function secondDeviceIntent(second: TestActor): EventIntent {
  return { type: 'device.added', body: { memberId: second.memberId, device: { fingerprint: second.identity.fingerprint, publicKey: second.identity.publicKey } } };
}

test('buildGenesisEvents makes a signed two-event batch that the materialiser accepts with no rejections', async () => {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const built = buildGenesisEvents({
    teamId, teamName: 'Genesis team', owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [emailHash(teamId, 'owner@example.invalid')] },
    identity: owner.identity, policy: defaultTeamPolicy(), near: { organizationId: 'org-1', workspaceId: 'ws-1' }, now: fixedNow
  });
  const [created, joined] = built.events;
  assert.equal(created.lamport, 1);
  assert.equal(created.prev, '');
  assert.equal(joined.lamport, 2);
  assert.equal(joined.prev, created.id);
  assert.equal(created.at, '2026-02-03T04:05:06.000Z');
  assert.equal(created.author, owner.memberId);
  assert.equal(created.device, owner.identity.fingerprint);
  assert.equal(created.body.ownerId, owner.memberId);
  assert.deepEqual(created.body.near, { organizationId: 'org-1', workspaceId: 'ws-1' });
  assert.equal(joined.body.role, 'owner');
  assert.deepEqual(built.anchor, { teamId, eventId: created.id, ownerDevice: { fingerprint: owner.identity.fingerprint, publicKey: owner.identity.publicKey } });
  assert.equal(verifyEventSignature(created, owner.identity.publicKey), true);
  assert.equal(verifyEventSignature(joined, owner.identity.publicKey), true);
  const state = reduce(built.events.map((event) => entryOf(event)), built.anchor);
  assert.deepEqual(state.rejected, []);
  assert.equal(state.accepted, 2);
  assert.equal(state.head.eventId, joined.id);
  assert.equal(state.members.get(owner.memberId)?.role, 'owner');
});

test('buildGenesisEvents refuses a secret in the team name before anything is signed', async () => {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const canary = `sk-${randomBytes(12).toString('hex')}`;
  assert.throws(() => buildGenesisEvents({
    teamId, teamName: canary, owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [] }, identity: owner.identity, policy: defaultTeamPolicy()
  }), (error: unknown) => error instanceof SecretLeakError && !error.message.includes(canary));
});

test('prepareEvents stamps lamport, prev, a fresh id and a signature for each intent in a batch', async () => {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const built = buildGenesisEvents({ teamId, teamName: 'Prepare team', owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [] }, identity: owner.identity, policy: defaultTeamPolicy(), now: fixedNow });
  const state = reduce(built.events.map((event) => entryOf(event)), built.anchor);
  const signer: TeamSigner = { identity: owner.identity, memberId: owner.memberId };
  const prepared = prepareEvents(state, state.head, signer, [
    { type: 'member.availability', body: { availability: 'focus' } },
    { type: 'member.skills', body: { memberId: owner.memberId, skills: ['rust'] } }
  ], fixedNow);
  assert.ok(Array.isArray(prepared));
  const events = prepared as TeamEvent[];
  assert.deepEqual(events.map((event) => event.lamport), [3, 4]);
  assert.deepEqual(events.map((event) => event.prev), [state.head.eventId, (events[0] as TeamEvent).id]);
  assert.notEqual((events[0] as TeamEvent).id, (events[1] as TeamEvent).id);
  for (const event of events) {
    assert.equal(event.teamId, teamId);
    assert.equal(event.author, owner.memberId);
    assert.equal(event.device, owner.identity.fingerprint);
    assert.equal(verifyEventSignature(event, owner.identity.publicKey), true);
  }

  const again = prepareEvents(state, state.head, signer, [{ type: 'member.availability', body: { availability: 'focus' } }], fixedNow) as TeamEvent[];
  assert.notEqual((again[0] as TeamEvent).id, (events[0] as TeamEvent).id, 'every call mints a new id');

  assert.deepEqual(prepareEvents(state, state.head, signer, [{ type: 'team.created', body: (built.events[0] as TeamEvent<'team.created'>).body }], fixedNow), { conflict: R.genesisOnly });
  assert.deepEqual(prepareEvents(state, state.head, signer, [{ type: 'member.joined', body: (built.events[1] as TeamEvent<'member.joined'>).body }], fixedNow), { conflict: `${R.notPermitted}: ${R.ownerJoinOnly}` });
});

test('two clients on two clones converge: events appended by A are materialised by B with byte-identical state', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const batch = await seed.a.log.append(() => [
      { type: 'member.availability', body: { availability: 'focus', workingHours: { tz: 'Europe/Berlin', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' } } },
      { type: 'member.skills', body: { memberId: seed.owner.memberId, skills: ['typescript', 'rust'] } }
    ]);
    assert.equal(batch.ok, true);
    if (batch.ok) assert.deepEqual(batch.events.map((event) => event.lamport), [3, 4]);
    const added = await seed.a.log.append(() => [secondDeviceIntent(seed.second)]);
    assert.equal(added.ok, true);
    const changed = await seed.a.log.append(() => [{ type: 'policy.changed', body: { changes: { dispatchMode: 'auto', offerTimeoutMinutes: 45 } } }]);
    assert.equal(changed.ok, true);
    const sent = [batch, added, changed].flatMap((result) => (result.ok ? result.events : []));
    assert.equal(sent.length, 4);

    const b = clientFor(fixture, 'b', seed.anchor);
    const synced = await b.log.sync();
    assert.deepEqual(synced.rejected, []);
    assert.equal(synced.status.state, 'ok');
    assert.deepEqual(synced.accepted.slice(2).map((event) => event.id), sent.map((event) => event.id), 'B accepts the four events in order after the genesis pair');
    assert.equal(serialiseState(b.log.state()), serialiseState(seed.a.log.state()));
    assert.deepEqual(b.log.state().rejected, []);
    const member = b.log.state().members.get(seed.owner.memberId);
    assert.equal(member?.availability, 'focus');
    assert.deepEqual(member?.skills, ['typescript', 'rust']);
    assert.equal(member?.devices.length, 2);
    assert.equal(b.log.state().team.policy.dispatchMode, 'auto');
    assert.deepEqual(remoteEventLamports(fixture), [1, 2, 3, 4, 5, 6]);
  });
});

test('an intent the permission matrix denies is refused with the read-side text and nothing is written', async () => {
  await withFixture(['a'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const before = remoteHead(fixture);
    const result = await seed.a.log.append(() => [{ type: 'member.role-changed', body: { memberId: seed.owner.memberId, role: 'lead' } }]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'refused');
      assert.equal(result.reason, `${R.notPermitted}: ${PERMISSION_REASONS.ownRole}`);
      assert.ok(result.reason.startsWith('not permitted:'));
    }
    assert.equal(remoteHead(fixture), before);
    assert.equal(seed.a.log.state().highLamport, 2);
  });
});

test('an intent that names a member who does not exist is refused by the replay of the whole batch', async () => {
  await withFixture(['a'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const before = remoteHead(fixture);
    const result = await seed.a.log.append(() => [{ type: 'member.skills', body: { memberId: 'mbr-0123456789abcdef', skills: ['rust'] } }]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, R.memberMissing);
    assert.equal(remoteHead(fixture), before);
  });
});

test('an intent carrying a secret throws SecretLeakError and the remote head is unchanged', async () => {
  await withFixture(['a'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const before = remoteHead(fixture);
    const canary = `sk-${randomBytes(12).toString('hex')}`;
    await assert.rejects(
      seed.a.log.append(() => [{ type: 'member.skills', body: { memberId: seed.owner.memberId, skills: ['rust', canary] } }]),
      (error: unknown) => error instanceof SecretLeakError && !error.message.includes(canary)
    );
    assert.equal(remoteHead(fixture), before);
    assert.ok(!gitIn(fixture.remote, ['log', '-p', '--format=', DEFAULT_COORDINATION_REF]).includes(canary), 'the canary is in no blob on the coordination branch');
  });
});

test('an event over 16 KB is refused before signing with the read-side text', async () => {
  await withFixture(['a'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const before = remoteHead(fixture);
    const skills = Array.from({ length: 500 }, (_, index) => `skill-${index}-${'a'.repeat(30)}`);
    const result = await seed.a.log.append(() => [{ type: 'member.skills', body: { memberId: seed.owner.memberId, skills } }]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'refused');
      assert.equal(result.reason, R.tooLarge);
      assert.equal(result.reason, 'event is larger than 16 KB');
    }
    assert.equal(remoteHead(fixture), before);
  });
});

test('a lost race rebuilds: the event lands at head + 1 as it was when it landed and the other client accepts it', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    assert.equal((await seed.a.log.append(() => [secondDeviceIntent(seed.second)])).ok, true);
    let armed = false;
    const stale = faultRunner(runGit, [{ when: (args) => armed && args.includes('fetch'), times: 1, replace: () => fakeGitResult(0) }]);
    const b = clientFor(fixture, 'b', seed.anchor, { identity: seed.second.identity, memberId: seed.second.memberId }, { git: stale });
    await b.log.sync();
    assert.equal(b.log.state().head.lamport, 3);

    const winner = await seed.a.log.append(() => [{ type: 'member.availability', body: { availability: 'away' } }]);
    assert.equal(winner.ok, true);
    armed = true;
    const seen: number[] = [];
    const heads: LogHead[] = [];
    const result = await b.log.append((state) => {
      seen.push(state.head.lamport);
      heads.push({ ...state.head });
      return [{ type: 'member.availability', body: { availability: 'focus' } }];
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.attempts, 2);
      assert.equal((result.events[0] as TeamEvent).lamport, 5, 'stamped from the fresh head, not the stale one');
      assert.equal((result.events[0] as TeamEvent).prev, (heads[1] as LogHead).eventId);
    }
    assert.deepEqual(seen, [3, 4]);
    assert.deepEqual(remoteEventLamports(fixture), [1, 2, 3, 4, 5]);

    const synced = await seed.a.log.sync();
    assert.deepEqual(synced.rejected, []);
    assert.equal(synced.accepted.length, 1);
    assert.equal(serialiseState(seed.a.log.state()), serialiseState(b.log.state()));
  });
});

test('verifyAll replays from genesis and reports events, members, devices, head and snapshots', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    assert.equal((await seed.a.log.append(() => [{ type: 'member.skills', body: { memberId: seed.owner.memberId, skills: ['sql'] } }, secondDeviceIntent(seed.second)])).ok, true);
    assert.equal((await seed.a.log.append(() => [{ type: 'member.availability', body: { availability: 'away' } }])).ok, true);

    const b = clientFor(fixture, 'b', seed.anchor);
    const report = await b.log.verifyAll();
    assert.equal(report.events, 5);
    assert.equal(report.accepted, 5);
    assert.deepEqual(report.rejected, []);
    assert.equal(report.unsupported, 0);
    assert.deepEqual(report.secretWarnings, []);
    assert.equal(report.snapshots, 0);
    assert.equal(report.refused, undefined);
    assert.equal(report.status.state, 'ok');
    assert.equal(report.head.lamport, 5);
    assert.deepEqual(report.head, b.log.state().head);
    assert.deepEqual(report.members, [{
      id: seed.owner.memberId, name: 'Owner Test', role: 'owner', removed: false,
      devices: [{ fingerprint: seed.owner.identity.fingerprint, revoked: false }, { fingerprint: seed.second.identity.fingerprint, revoked: false }]
    }]);
  });
});

test('verifyAll warns about a secret-like value in an accepted event but never rejects it', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const canary = `sk-${randomBytes(12).toString('hex')}`;
    // Pushed through the transport directly, which is what a client with an older or weaker detector would have done.
    const raw = await seed.a.transport.append((state, head) => [signed(seed.owner, {
      teamId: seed.teamId, type: 'member.skills', body: { memberId: seed.owner.memberId, skills: [canary] }, lamport: head.lamport + 1, prev: state.head.eventId
    })]);
    assert.equal(raw.ok, true);
    const b = clientFor(fixture, 'b', seed.anchor);
    const report = await b.log.verifyAll();
    assert.equal(report.accepted, 3, 'the event stays accepted');
    assert.deepEqual(report.rejected, []);
    assert.equal(report.secretWarnings.length, 1);
    const id = raw.ok ? (raw.events[0] as TeamEvent).id : '';
    assert.ok((report.secretWarnings[0] as string).startsWith(`${id}: `));
    assert.ok((report.secretWarnings[0] as string).includes('skills'));
    assert.ok(!report.secretWarnings[0]?.includes(canary), 'the warning names the path, never the value');
  });
});

test('verifyAll yields to the event loop every yieldEvery entries', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    for (const availability of ['focus', 'away', 'available'] as const) {
      assert.equal((await seed.a.log.append(() => [{ type: 'member.availability', body: { availability } }])).ok, true);
    }
    const b = clientFor(fixture, 'b', seed.anchor, undefined, { yieldEvery: 2 });
    const original = globalThis.setImmediate;
    let ours = 0;
    const spy = mock.method(globalThis, 'setImmediate', ((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      if ((new Error().stack ?? '').includes('eventLog')) ours += 1;
      return original(callback, ...args);
    }) as typeof setImmediate);
    try {
      const report = await b.log.verifyAll();
      assert.equal(report.accepted, 5);
    } finally {
      spy.mock.restore();
    }
    // Five events plus team.json are six entries, so yieldEvery 2 yields three times.
    assert.equal(ours, 3);
  });
});

test('a log without a signer can sync and verify but its append rejects with the no-device-key text', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const b = clientFor(fixture, 'b', seed.anchor);
    await assert.rejects(b.log.append(() => [{ type: 'member.availability', body: { availability: 'away' } }]), (error: unknown) => error instanceof Error && error.name === 'NoDeviceKeyError' && error.message === NO_DEVICE_KEY_MESSAGE);
    assert.equal(NO_DEVICE_KEY_MESSAGE, 'This computer is not a device of this team yet, so it can read the team record but not write to it.');
    assert.equal(NO_DEVICE_KEY_MESSAGE.includes('for this team'), false);
    const synced = await b.log.sync();
    assert.equal(synced.accepted.length, 2);
    assert.equal((await b.log.verifyAll()).accepted, 2);
  });
});

test('the default snapshot interval is 500 events', () => {
  assert.equal(DEFAULT_SNAPSHOT_EVERY, 500);
});

test('the owner client writes a signed snapshot with snapshot.written in one commit and another client accepts both entries', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture, { snapshotEvery: 5 });
    await appendAvailability(seed.a, 2);
    assert.deepEqual(remoteSnapshotFiles(fixture), [], 'lamport 4 is below the threshold');
    await appendAvailability(seed.a, 1);
    assert.deepEqual(remoteSnapshotFiles(fixture), ['snapshots/000000000005.json']);
    const written = seed.a.log.lastSnapshot();
    assert.equal(written?.ok, true);
    assert.deepEqual(remoteEventLamports(fixture), [1, 2, 3, 4, 5, 6]);
    const tip = gitIn(fixture.remote, ['show', '--name-only', '--format=', DEFAULT_COORDINATION_REF]).split('\n').sort();
    assert.equal(tip.length, 2, 'the tip commit holds exactly the event and the snapshot file');
    assert.ok(tip.some((name) => /^events\/000000000006-evt-/.test(name)));
    assert.ok(tip.includes('snapshots/000000000005.json'));

    const b = clientFor(fixture, 'b', seed.anchor, undefined, { snapshotEvery: 5 });
    const synced = await b.log.sync();
    assert.deepEqual(synced.rejected, []);
    assert.equal(synced.snapshot, undefined, 'a client without a signer never writes snapshots');
    const snapshotEvent = synced.accepted.find((event) => event.type === 'snapshot.written') as TeamEvent<'snapshot.written'>;
    assert.ok(snapshotEvent !== undefined);
    assert.equal(snapshotEvent.lamport, 6);
    assert.equal(snapshotEvent.body.lamport, 5);
    assert.equal(snapshotEvent.body.path, 'snapshots/000000000005.json');
    const snapshotEntry = synced.entries.find((entry) => entry.kind === 'snapshot');
    assert.equal(snapshotEntry?.verdict?.accepted, true);
    assert.equal(b.log.state().snapshots.length, 1);
    assert.equal(serialiseState(b.log.state()), serialiseState(seed.a.log.state()));

    const parsed = parseSnapshotFile(gitIn(fixture.remote, ['show', `${DEFAULT_COORDINATION_REF}:snapshots/000000000005.json`]), seed.anchor);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.provisional, true);
      assert.equal(stateHash(parsed.state), snapshotEvent.body.stateHash);
      assert.equal(parsed.file.author, seed.owner.memberId);
      assert.equal(parsed.state.head.lamport, 5);
    }
  });
});

test('a snapshot is written again only after another snapshotEvery events and verifyAll counts the snapshots written', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture, { snapshotEvery: 5 });
    await appendAvailability(seed.a, 3);
    assert.equal(seed.a.log.state().head.lamport, 6, 'events 3, 4, 5 and the snapshot event 6');
    await appendAvailability(seed.a, 3);
    assert.deepEqual(remoteSnapshotFiles(fixture), ['snapshots/000000000005.json'], 'lamport 9 is still below 5 + 5');
    await appendAvailability(seed.a, 1);
    assert.deepEqual(remoteSnapshotFiles(fixture), ['snapshots/000000000005.json', 'snapshots/000000000010.json']);

    const report = await clientFor(fixture, 'b', seed.anchor).log.verifyAll();
    assert.equal(report.snapshots, 2);
    assert.deepEqual(report.rejected, []);
    assert.equal(report.accepted, 11, 'ten events, then the second snapshot event at 11');
    assert.equal(report.head.lamport, 11);
  });
});

test('a snapshot write that throws does not discard the entries the same sync fetched (WR-04)', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture, { snapshotEvery: 1000 });
    await appendAvailability(seed.a, 3);
    const failing: GitRunner = async (args, options) => {
      if (args.includes('commit-tree')) throw new Error('disk full while writing the snapshot');
      return runGit(args, options);
    };
    const b = clientFor(fixture, 'b', seed.anchor, seed.signer, { git: failing, snapshotEvery: 5 });
    const synced = await b.log.sync();
    assert.equal(synced.accepted.length, 5, 'the genesis pair and the three new events are all returned');
    assert.equal(synced.snapshot?.ok, false);
    assert.match(synced.snapshot?.ok === false ? synced.snapshot.reason : '', /disk full while writing the snapshot/);
    assert.equal(b.log.lastSnapshot()?.ok, false);
    assert.deepEqual(remoteSnapshotFiles(fixture), []);
    const again = await b.transport.fetch();
    assert.equal(again.length, 0, 'the transport does not hand the same entries out twice, so losing them would be permanent');
  });
});

test('two clients crossing the threshold together write one snapshot and the loser skips without an error', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture, { snapshotEvery: 1000 });
    assert.equal((await seed.a.log.append(() => [secondDeviceIntent(seed.second)])).ok, true);
    await appendAvailability(seed.a, 2);
    assert.equal(seed.a.log.state().head.lamport, 5);
    assert.deepEqual(remoteSnapshotFiles(fixture), [], 'client A is configured never to snapshot here');

    const winner = new TeamLog({ anchor: seed.anchor, transport: seed.a.transport, signer: seed.signer, now: fixedNow, snapshotEvery: 5 });
    const mirror = clientFor(fixture, 'b', seed.anchor);
    let winnerResult: Awaited<ReturnType<TeamLog['sync']>> | undefined;
    // B decides a snapshot is due, then the other owner device gets its snapshot in before B's append starts.
    const racing: CoordinationTransport<TeamState> = {
      fetch: () => mirror.transport.fetch(),
      readAll: () => mirror.transport.readAll(),
      onUpdate: (listener) => mirror.transport.onUpdate(listener),
      status: () => mirror.transport.status(),
      state: () => mirror.transport.state(),
      append: async (build, options) => {
        winnerResult = await winner.sync();
        return mirror.transport.append(build, options);
      }
    };
    const loser = new TeamLog({
      anchor: seed.anchor, transport: racing, signer: { identity: seed.second.identity, memberId: seed.second.memberId }, now: fixedNow, snapshotEvery: 5
    });
    const synced = await loser.sync();
    assert.equal(winnerResult?.snapshot?.ok, true, 'the winner wrote the snapshot');
    assert.ok(synced.snapshot !== undefined);
    assert.equal(synced.snapshot?.ok, false);
    if (synced.snapshot !== undefined && !synced.snapshot.ok) {
      assert.equal(synced.snapshot.kind, 'refused');
      assert.equal(synced.snapshot.reason, SNAPSHOT_ALREADY_WRITTEN);
    }
    assert.equal(SNAPSHOT_ALREADY_WRITTEN, 'snapshot already written');
    assert.deepEqual(remoteSnapshotFiles(fixture), ['snapshots/000000000005.json'], 'exactly one snapshot landed');
    assert.deepEqual(remoteEventLamports(fixture), [1, 2, 3, 4, 5, 6]);
    assert.equal(loser.state().snapshots.length, 1);
    assert.equal(serialiseState(loser.state()), serialiseState(seed.a.log.state()));
  });
});

test('a signer whose role is not owner or lead never writes snapshots', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture, { snapshotEvery: 1000 });
    await appendAvailability(seed.a, 3);
    const developer = await makeActor(seed.teamId);
    const b = clientFor(fixture, 'b', seed.anchor, { identity: developer.identity, memberId: developer.memberId }, { snapshotEvery: 5 });
    await b.transport.fetch();
    addFixtureMember(b.transport.state(), developer, 'developer');
    const synced = await b.log.sync();
    assert.equal(b.log.state().head.lamport, 5);
    assert.equal(synced.snapshot, undefined);
    assert.equal(b.log.lastSnapshot(), undefined);
    assert.deepEqual(remoteSnapshotFiles(fixture), []);
  });
});

test('a snapshot is skipped, not thrown, when the state holds a secret-like value an older client let through', async () => {
  await withFixture(['a'], async (fixture) => {
    const seed = await seedTeam(fixture, { snapshotEvery: 3 });
    const canary = `sk-${randomBytes(12).toString('hex')}`;
    const raw = await seed.a.transport.append((state, head) => [signed(seed.owner, {
      teamId: seed.teamId, type: 'member.skills', body: { memberId: seed.owner.memberId, skills: [canary] }, lamport: head.lamport + 1, prev: state.head.eventId
    })]);
    assert.equal(raw.ok, true);
    const synced = await seed.a.log.sync();
    assert.equal(synced.snapshot?.ok, false);
    if (synced.snapshot !== undefined && !synced.snapshot.ok) assert.ok(synced.snapshot.reason.startsWith('snapshot skipped'));
    assert.deepEqual(remoteSnapshotFiles(fixture), []);
    assert.ok(!gitIn(fixture.remote, ['log', '-p', '--format=', DEFAULT_COORDINATION_REF]).includes('snapshots/'));
  });
});
