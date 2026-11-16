// Materialiser tests: the D-09 validation pipeline in order, positional revocation and removal (D-11), the read-side permission matrix (D-12, D-32),
// reference checks, the ten state transitions, and that a rejected event changes nothing but state.rejected.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalize, snapshotPath } from '../domain/team/canonical';
import { MAX_LAMPORT_JUMP, SNAPSHOT_REASONS, STATE_HASH_VERSION, applyEntry, checkCandidate, cloneState, deserialiseState, parseSnapshotFile, reduce, serialiseState, snapshotBody, stateHash } from '../domain/team/materialize';
import { PERMISSION_REASONS } from '../domain/team/permissions';
import { applyPolicyChanges, defaultTeamPolicy } from '../domain/team/policy';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { CommittedEvent, GenesisAnchor, ImplementedEventBodies, ImplementedEventType, JsonObject, Role, TeamEvent, TeamState } from '../domain/team/types';
import { newEventId, newMemberId, newTeamId, signEvent } from '../team/identity';
import { addFixtureMember, buildScenario, entryOf, genesisEntries, makeActor, makeDevice, mulberry32, rotationBody, signed, signedSnapshot, snapshotWrittenBody } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';

const R = TEAM_REJECTION_REASONS;

interface World { teamId: string; owner: TestActor; anchor: GenesisAnchor; genesis: CommittedEvent[]; state: TeamState }

async function world(): Promise<World> {
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const { entries, anchor } = genesisEntries(owner, teamId);
  return { teamId, owner, anchor, genesis: entries, state: reduce(entries, anchor) };
}

function make<T extends ImplementedEventType>(w: World, actor: TestActor, type: T, body: ImplementedEventBodies[T], lamport?: number): TeamEvent<T> {
  return signed(actor, { teamId: w.teamId, type, body, lamport: lamport ?? w.state.head.lamport + 1, prev: w.state.head.eventId });
}

function deviceRef(actor: TestActor): { fingerprint: string; publicKey: string } {
  return { fingerprint: actor.identity.fingerprint, publicKey: actor.identity.publicKey };
}

// Everything except state.rejected: what a rejected event must leave exactly as it was.
function withoutRejected(state: TeamState): string {
  const plain = JSON.parse(serialiseState(state)) as Record<string, unknown>;
  delete plain.rejected;
  return canonicalize(plain);
}

function accept(w: World, event: TeamEvent): void {
  const verdict = applyEntry(w.state, entryOf(event));
  assert.deepEqual(verdict.accepted ? undefined : verdict.rejection, undefined, 'event should be accepted');
}

function expectRejected(w: World, entry: CommittedEvent, reason: string, eventId?: string): void {
  const before = withoutRejected(w.state);
  const rejectedBefore = w.state.rejected.length;
  const verdict = applyEntry(w.state, entry);
  assert.equal(verdict.accepted, false, `expected rejection: ${reason}`);
  if (verdict.accepted) return;
  assert.equal(verdict.rejection.reason, reason);
  if (eventId !== undefined) assert.equal(verdict.rejection.eventId, eventId);
  assert.equal(w.state.rejected.length, rejectedBefore + 1);
  assert.deepEqual(w.state.rejected[rejectedBefore], verdict.rejection);
  assert.equal(withoutRejected(w.state), before, 'a rejected event must change nothing but state.rejected');
}

function reject(w: World, event: TeamEvent, reason: string): void {
  expectRejected(w, entryOf(event), reason, event.id);
}

function notPermitted(reason: string): string {
  return `${R.notPermitted}: ${reason}`;
}

async function withMember(w: World, role: Role): Promise<TestActor> {
  const actor = await makeActor(w.teamId);
  addFixtureMember(w.state, actor, role);
  return actor;
}

test('genesis: the anchored team.created then the owner member.joined are accepted', async () => {
  const w = await world();
  assert.equal(w.state.refused, undefined);
  assert.equal(w.state.accepted, 2);
  assert.equal(w.state.head.lamport, 2);
  assert.equal(w.state.highLamport, 2);
  assert.deepEqual(w.state.rejected, []);
  const owner = w.state.members.get(w.owner.memberId);
  assert.equal(owner?.role, 'owner');
  assert.equal(w.state.deviceIndex.get(w.owner.identity.fingerprint), w.owner.memberId);
});

test('genesis: a first event with another id, another key, a tampered body or a malformed file refuses the whole log', async () => {
  const w = await world();
  const outsider = await makeActor(w.teamId);
  const foreign = genesisEntries(outsider, w.teamId).entries;
  const created = JSON.parse(w.genesis[0]?.text ?? '') as TeamEvent<'team.created'>;
  const tampered = { ...created, body: { ...created.body, name: 'Hijacked' } };
  const cases: Array<{ label: string; first: CommittedEvent; anchor: GenesisAnchor }> = [
    { label: 'another id', first: foreign[0] as CommittedEvent, anchor: w.anchor },
    { label: 'another key', first: w.genesis[0] as CommittedEvent, anchor: { ...w.anchor, ownerDevice: deviceRef(outsider) } },
    { label: 'a tampered body', first: entryOf(tampered), anchor: w.anchor },
    { label: 'a malformed file', first: { ...(w.genesis[0] as CommittedEvent), text: '{not json', size: 9 }, anchor: w.anchor }
  ];
  for (const item of cases) {
    const state = reduce([item.first, ...w.genesis], item.anchor);
    assert.equal(state.refused, R.logRefused, item.label);
    assert.equal(state.accepted, 0, item.label);
    assert.equal(state.members.size, 0, item.label);
    assert.equal(state.rejected.length, 1, `${item.label}: one rejection is recorded, later entries are ignored`);
    assert.equal(state.rejected[0]?.reason, R.logRefused, item.label);
    const later = applyEntry(state, w.genesis[1] as CommittedEvent);
    assert.equal(later.accepted, false, item.label);
    if (!later.accepted) assert.equal(later.rejection.reason, R.logRefused, item.label);
    assert.equal(state.rejected.length, 1, `${item.label}: ignored entries are not recorded`);
  }
});

test('genesis: team.created at a later position and member.joined for anyone else or at the wrong place are rejected', async () => {
  const w = await world();
  const created = JSON.parse(w.genesis[0]?.text ?? '') as TeamEvent<'team.created'>;
  reject(w, make(w, w.owner, 'team.created', created.body), R.genesisOnly);
  const joinedAgain = make(w, w.owner, 'member.joined', { memberId: w.owner.memberId, name: 'Owner', emailHashes: [], role: 'owner', device: deviceRef(w.owner) });
  reject(w, joinedAgain, notPermitted(R.ownerJoinOnly));
  const other = await makeActor(w.teamId);
  const early = reduce([w.genesis[0] as CommittedEvent], w.anchor);
  const forOther = signed(w.owner, {
    teamId: w.teamId, type: 'member.joined', lamport: 2, prev: early.head.eventId,
    body: { memberId: other.memberId, name: 'Other', emailHashes: [], role: 'developer', device: deviceRef(other) }
  });
  expectRejected({ ...w, state: early }, entryOf(forOther), notPermitted(R.ownerJoinOnly), forOther.id);
  assert.equal(early.accepted, 1);
});

test('step order: another team is reported before a bad signature', async () => {
  const w = await world();
  const event = signed(w.owner, { teamId: newTeamId(), type: 'member.availability', body: { availability: 'away' }, lamport: 3, prev: w.state.head.eventId });
  const tampered = { ...event, body: { availability: 'focus' as const } };
  expectRejected(w, entryOf(tampered), R.wrongTeam, event.id);
});

test('step order: an unbound device, a broken signature, a replay and the lamport rules each report their own reason', async () => {
  const w = await world();
  const stranger = await makeActor(w.teamId);
  const unbound = signEvent(stranger.identity, {
    v: 1, id: newEventId(), teamId: w.teamId, type: 'member.availability', lamport: 3, at: '2026-01-01T00:00:00.000Z', author: w.owner.memberId,
    device: stranger.identity.fingerprint, prev: w.state.head.eventId, body: { availability: 'away' }
  });
  reject(w, unbound, R.unboundDevice);
  const unknownAuthor = make(w, stranger, 'member.availability', { availability: 'away' });
  reject(w, unknownAuthor, R.unboundDevice);

  const good = make(w, w.owner, 'member.availability', { availability: 'away' });
  reject(w, { ...good, body: { availability: 'focus' }, id: newEventId() }, R.badSignature);

  accept(w, good);
  expectRejected(w, entryOf(good), R.duplicate, good.id);

  reject(w, make(w, w.owner, 'member.availability', { availability: 'focus' }, w.state.highLamport), R.lamportNotGreater);
  reject(w, make(w, w.owner, 'member.availability', { availability: 'focus' }, w.state.highLamport - 1), R.lamportNotGreater);
  reject(w, make(w, w.owner, 'member.availability', { availability: 'focus' }, w.state.highLamport + MAX_LAMPORT_JUMP + 1), R.lamportJump);
  accept(w, make(w, w.owner, 'member.availability', { availability: 'focus' }, w.state.highLamport + MAX_LAMPORT_JUMP));
});

test('rejected events never move the lamport high-water mark, head or counters', async () => {
  const w = await world();
  const high = w.state.highLamport;
  const head = { ...w.state.head };
  reject(w, make(w, w.owner, 'member.availability', { availability: 'away' }, high + MAX_LAMPORT_JUMP + 5), R.lamportJump);
  assert.equal(w.state.highLamport, high);
  assert.deepEqual(w.state.head, head);
  assert.equal(w.state.accepted, 2);
  accept(w, make(w, w.owner, 'member.availability', { availability: 'away' }, high + 1));
  assert.equal(w.state.highLamport, high + 1);
  assert.equal(w.state.accepted, 3);
});

test('positional revocation: a revoked device is valid before the revocation and rejected after it, and a full replay agrees', async () => {
  const w = await world();
  const second = await makeDevice(w.owner);
  const entries: CommittedEvent[] = [...w.genesis];
  const take = <T extends ImplementedEventType>(event: TeamEvent<T>): TeamEvent<T> => { entries.push(entryOf(event)); return event; };
  accept(w, take(make(w, w.owner, 'device.added', { memberId: w.owner.memberId, device: deviceRef(second) })));
  accept(w, take(make(w, second, 'member.availability', { availability: 'focus' })));
  accept(w, take(make(w, w.owner, 'device.revoked', { memberId: w.owner.memberId, fingerprint: second.identity.fingerprint })));
  const late = take(make(w, second, 'member.availability', { availability: 'away' }));
  reject(w, late, R.revokedDevice);
  const replay = reduce(entries, w.anchor);
  assert.equal(replay.accepted, 5);
  assert.deepEqual(replay.rejected, [{ eventId: late.id, reason: R.revokedDevice }]);
  assert.equal(serialiseState(replay), serialiseState(w.state));
  assert.equal(replay.members.get(w.owner.memberId)?.availability, 'focus');
});

test('tracer: an owner rotates their own key in one signed step; the new key signs, the old one is refused from that position on (D-09)', async () => {
  const w = await world();
  const fresh = await makeDevice(w.owner);
  const entries: CommittedEvent[] = [...w.genesis];
  const take = <T extends ImplementedEventType>(event: TeamEvent<T>): TeamEvent<T> => { entries.push(entryOf(event)); return event; };
  // Before the rotation the genesis key signs as usual.
  accept(w, take(make(w, w.owner, 'member.availability', { availability: 'focus' })));
  const rotation = take(make(w, w.owner, 'device.rotated', { memberId: w.owner.memberId, from: w.owner.identity.fingerprint, device: deviceRef(fresh) }));
  accept(w, rotation);
  const devices = w.state.members.get(w.owner.memberId)?.devices ?? [];
  assert.equal(devices.length, 2);
  const retired = devices.find((device) => device.fingerprint === w.owner.identity.fingerprint);
  assert.equal(retired?.rotatedEvent, rotation.id);
  assert.equal(retired?.rotatedAt, rotation.at);
  assert.equal(retired?.rotatedTo, fresh.identity.fingerprint);
  assert.equal(retired?.revokedEvent, undefined);
  const bound = devices.find((device) => device.fingerprint === fresh.identity.fingerprint);
  assert.deepEqual(bound, { fingerprint: fresh.identity.fingerprint, publicKey: fresh.identity.publicKey, addedBy: w.owner.memberId, addedEvent: rotation.id });
  assert.equal(w.state.deviceIndex.get(w.owner.identity.fingerprint), w.owner.memberId, 'the retired fingerprint stays in the index');
  assert.equal(w.state.deviceIndex.get(fresh.identity.fingerprint), w.owner.memberId);
  // The new key signs; the retired one is refused with the exact text.
  accept(w, take(make(w, fresh, 'member.availability', { availability: 'away' })));
  const late = take(make(w, w.owner, 'member.availability', { availability: 'available' }));
  reject(w, late, 'device was rotated before this event');
  assert.equal(R.rotatedDevice, 'device was rotated before this event');
  assert.equal(w.state.members.get(w.owner.memberId)?.availability, 'away');
  const replay = reduce(entries, w.anchor);
  assert.equal(replay.accepted, 5);
  assert.deepEqual(replay.rejected, [{ eventId: late.id, reason: R.rotatedDevice }]);
  assert.equal(serialiseState(replay), serialiseState(w.state));
});

test('rotation references: unknown, removed, foreign, revoked and already rotated keys and taken fingerprints are rejected with fixed reasons', async () => {
  const w = await world();
  const developer = await withMember(w, 'developer');
  const spare = await makeDevice(w.owner);
  const extra = await makeDevice(w.owner);
  const stranger = await makeActor(w.teamId);
  const rotate = (author: TestActor, memberId: string, from: TestActor, to: TestActor): TeamEvent<'device.rotated'> =>
    make(w, author, 'device.rotated', rotationBody(memberId, from, to));
  reject(w, rotate(w.owner, newMemberId(), developer, spare), R.memberMissing);
  reject(w, rotate(w.owner, w.owner.memberId, developer, spare), R.deviceNotBound);
  reject(w, rotate(w.owner, w.owner.memberId, stranger, spare), R.deviceNotBound);
  reject(w, rotate(w.owner, developer.memberId, developer, w.owner), R.deviceTaken);
  // The new fingerprint may not be the retired one either: it is already in the index.
  reject(w, rotate(w.owner, developer.memberId, developer, developer), R.deviceTaken);
  const own = rotate(developer, developer.memberId, developer, spare);
  accept(w, own);
  assert.equal(w.state.members.get(developer.memberId)?.devices.find((device) => device.fingerprint === developer.identity.fingerprint)?.rotatedTo, spare.identity.fingerprint);
  reject(w, rotate(w.owner, developer.memberId, developer, extra), R.deviceRotated);
  reject(w, rotate(w.owner, developer.memberId, spare, spare), R.deviceTaken);
  // A retired fingerprint can never be registered again, by device.added or by another rotation.
  reject(w, make(w, w.owner, 'device.added', { memberId: developer.memberId, device: deviceRef(developer) }), R.deviceTaken);
  reject(w, rotate(w.owner, developer.memberId, spare, developer), R.deviceTaken);
  accept(w, make(w, w.owner, 'device.added', { memberId: developer.memberId, device: deviceRef(extra) }));
  accept(w, make(w, w.owner, 'device.revoked', { memberId: developer.memberId, fingerprint: extra.identity.fingerprint }));
  reject(w, rotate(w.owner, developer.memberId, extra, stranger), R.deviceRevoked);
  accept(w, make(w, w.owner, 'member.removed', { memberId: developer.memberId }));
  reject(w, rotate(w.owner, developer.memberId, spare, stranger), R.memberRemoved);
});

test('self-rotation must be signed by the key it retires; an owner or lead rotating for someone else signs with their own device (D-09)', async () => {
  const w = await world();
  const second = await makeDevice(w.owner);
  const fresh = await makeDevice(w.owner);
  const later = await makeDevice(w.owner);
  accept(w, make(w, w.owner, 'device.added', { memberId: w.owner.memberId, device: deviceRef(second) }));
  // Another of the member's own keys cannot retire it.
  reject(w, make(w, w.owner, 'device.rotated', rotationBody(w.owner.memberId, second, fresh)), R.rotationNotByOldKey);
  assert.equal(R.rotationNotByOldKey, 'a member rotates a device key only by signing with that key');
  accept(w, make(w, second, 'device.rotated', rotationBody(w.owner.memberId, second, fresh)));
  const developer = await withMember(w, 'developer');
  const lead = await withMember(w, 'lead');
  const developerNew = await makeDevice(developer);
  const developerLater = await makeDevice(developer);
  // The owner and a lead are not the member, so they sign with their own devices.
  accept(w, make(w, w.owner, 'device.rotated', rotationBody(developer.memberId, developer, developerNew)));
  accept(w, make(w, lead, 'device.rotated', rotationBody(developer.memberId, developerNew, developerLater)));
  assert.equal(w.state.members.get(developer.memberId)?.devices.filter((device) => device.rotatedEvent === undefined).length, 1);
  accept(w, make(w, fresh, 'device.rotated', rotationBody(w.owner.memberId, fresh, later)));
});

test('rotation permissions on the read side: members rotate only their own key, owner and lead rotate others, a lead never the owner (D-09, D-32)', async () => {
  const w = await world();
  const developer = await withMember(w, 'developer');
  const reviewer = await withMember(w, 'reviewer');
  const observer = await withMember(w, 'observer');
  const lead = await withMember(w, 'lead');
  const spares = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => makeDevice(w.owner)));
  const spare = (index: number): TestActor => spares[index] as TestActor;
  reject(w, make(w, developer, 'device.rotated', rotationBody(reviewer.memberId, reviewer, spare(0))), notPermitted('the developer role does not allow rotating devices for another member'));
  reject(w, make(w, observer, 'device.rotated', rotationBody(w.owner.memberId, w.owner, spare(0))), notPermitted('the observer role does not allow rotating devices for another member'));
  reject(w, make(w, lead, 'device.rotated', rotationBody(w.owner.memberId, w.owner, spare(0))), notPermitted(PERMISSION_REASONS.leadOnOwnerDevice));
  assert.equal(PERMISSION_REASONS.leadOnOwnerDevice, 'a lead cannot add, revoke or rotate a device of the owner');
  for (const [actor, index] of [[developer, 1], [reviewer, 2], [observer, 3]] as Array<[TestActor, number]>) {
    accept(w, make(w, actor, 'device.rotated', rotationBody(actor.memberId, actor, spare(index))));
  }
  accept(w, make(w, lead, 'device.rotated', rotationBody(developer.memberId, spare(1), spare(4))));
  accept(w, make(w, w.owner, 'device.rotated', rotationBody(lead.memberId, lead, spare(5))));
  accept(w, make(w, w.owner, 'device.rotated', rotationBody(w.owner.memberId, w.owner, spare(6))));
});

test('revoking a rotated key is accepted and skips the last-device rule; the last active key is still protected (D-21)', async () => {
  const w = await world();
  const fresh = await makeDevice(w.owner);
  const later = await makeDevice(w.owner);
  accept(w, make(w, w.owner, 'device.rotated', rotationBody(w.owner.memberId, w.owner, fresh)));
  // A rotation leaves exactly one active key, so revoking it is still the last-device case.
  reject(w, make(w, fresh, 'device.revoked', { memberId: w.owner.memberId, fingerprint: fresh.identity.fingerprint }), R.lastDevice);
  const revocation = make(w, fresh, 'device.revoked', { memberId: w.owner.memberId, fingerprint: w.owner.identity.fingerprint });
  accept(w, revocation);
  const retired = w.state.members.get(w.owner.memberId)?.devices.find((device) => device.fingerprint === w.owner.identity.fingerprint);
  assert.equal(retired?.revokedEvent, revocation.id);
  assert.equal(retired?.rotatedTo, fresh.identity.fingerprint, 'the rotation record stays when the retired key is revoked too');
  reject(w, make(w, fresh, 'device.revoked', { memberId: w.owner.memberId, fingerprint: w.owner.identity.fingerprint }), R.deviceRevoked);
  // Revocation is reported before rotation for a key that is both.
  reject(w, make(w, w.owner, 'member.availability', { availability: 'away' }), R.revokedDevice);
  reject(w, make(w, fresh, 'device.rotated', rotationBody(w.owner.memberId, w.owner, later)), R.deviceRevoked);
  // Rotating again never trips the last-device rule, and the new key is then the protected one.
  accept(w, make(w, fresh, 'device.rotated', rotationBody(w.owner.memberId, fresh, later)));
  reject(w, make(w, later, 'device.revoked', { memberId: w.owner.memberId, fingerprint: later.identity.fingerprint }), R.lastDevice);
});

test('snapshots carry rotation: round-trip keeps the rotation fields, a rotated signer and an inconsistent rotatedTo are refused (D-09)', async () => {
  const w = await world();
  const fresh = await makeDevice(w.owner);
  const rotation = make(w, w.owner, 'device.rotated', rotationBody(w.owner.memberId, w.owner, fresh));
  accept(w, rotation);
  accept(w, make(w, fresh, 'snapshot.written', snapshotWrittenBody(w.state)));
  const good = signedSnapshot(fresh, w.state);
  const parsed = parseSnapshotFile(canonicalize(good), w.anchor);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(serialiseState(parsed.state), serialiseState(w.state));
  const retired = parsed.state.members.get(w.owner.memberId)?.devices.find((device) => device.fingerprint === w.owner.identity.fingerprint);
  assert.deepEqual(retired, {
    fingerprint: w.owner.identity.fingerprint, publicKey: w.owner.identity.publicKey, addedBy: w.owner.memberId, addedEvent: w.anchor.eventId,
    rotatedEvent: rotation.id, rotatedAt: rotation.at, rotatedTo: fresh.identity.fingerprint
  });
  // The key that replaced it carries no rotation field.
  assert.deepEqual(Object.keys(parsed.state.members.get(w.owner.memberId)?.devices.find((device) => device.fingerprint === fresh.identity.fingerprint) ?? {}).sort(), ['addedBy', 'addedEvent', 'fingerprint', 'publicKey']);
  // A snapshot signed by the retired key is refused like one signed by a revoked key.
  const byRetired = parseSnapshotFile(canonicalize(signedSnapshot(w.owner, w.state)), w.anchor);
  assert.deepEqual(byRetired, { ok: false, reason: R.rotatedDevice });

  const plain = (): JsonObject => JSON.parse(serialiseState(w.state)) as JsonObject;
  type Devices = Array<Record<string, unknown>>;
  const devicesOf = (state: JsonObject): Devices => ((state.members as Array<{ devices: Devices }>)[0] as { devices: Devices }).devices;
  assert.doesNotThrow(() => deserialiseState(plain(), w.anchor));
  const stranger = await makeActor(w.teamId);
  const elsewhere = plain();
  (devicesOf(elsewhere)[0] as Record<string, unknown>).rotatedTo = stranger.identity.fingerprint;
  assert.throws(() => deserialiseState(elsewhere, w.anchor), /devices\.rotatedTo/, 'rotatedTo names no device of that member');
  const pointsAtSelf = plain();
  (devicesOf(pointsAtSelf)[0] as Record<string, unknown>).rotatedTo = w.owner.identity.fingerprint;
  assert.throws(() => deserialiseState(pointsAtSelf, w.anchor), /devices\.rotatedTo/, 'rotatedTo names the retired key itself');
  const partial = plain();
  delete (devicesOf(partial)[0] as Record<string, unknown>).rotatedAt;
  assert.throws(() => deserialiseState(partial, w.anchor), 'the three rotation fields come together');
  const wrongEvent = plain();
  (devicesOf(wrongEvent)[0] as Record<string, unknown>).rotatedEvent = newEventId();
  assert.throws(() => deserialiseState(wrongEvent, w.anchor), 'the successor was bound by another event');
});

test('a log with no rotation serialises and hashes with no rotation field anywhere (D-09)', async () => {
  const w = await world();
  const second = await makeDevice(w.owner);
  accept(w, make(w, w.owner, 'device.added', { memberId: w.owner.memberId, device: deviceRef(second) }));
  accept(w, make(w, w.owner, 'device.revoked', { memberId: w.owner.memberId, fingerprint: second.identity.fingerprint }));
  assert.ok(!serialiseState(w.state).includes('rotat'));
  assert.ok(!JSON.stringify(snapshotBody(w.state).state).includes('rotat'));
  const fresh = await makeDevice(w.owner);
  const before = stateHash(w.state);
  accept(w, make(w, w.owner, 'device.rotated', rotationBody(w.owner.memberId, w.owner, fresh)));
  assert.ok(serialiseState(w.state).includes('rotatedEvent'));
  assert.notEqual(stateHash(w.state), before);
});

test('positional removal: events before the removal stay valid, events after are rejected', async () => {
  const w = await world();
  const developer = await withMember(w, 'developer');
  accept(w, make(w, developer, 'member.availability', { availability: 'focus' }));
  accept(w, make(w, w.owner, 'member.removed', { memberId: developer.memberId }));
  reject(w, make(w, developer, 'member.availability', { availability: 'away' }), R.removedAuthor);
  assert.equal(w.state.members.get(developer.memberId)?.availability, 'focus');
});

test('read side: the same decideTeamAction as the write side rejects each forbidden action with the permissions.ts reason', async () => {
  const w = await world();
  const developer = await withMember(w, 'developer');
  const lead = await withMember(w, 'lead');
  const newDevice = await makeDevice(w.owner);
  reject(w, make(w, developer, 'policy.changed', { changes: { enforceWip: false } }), notPermitted(PERMISSION_REASONS.policyOwnerOnly));
  reject(w, make(w, lead, 'policy.changed', { changes: { enforceWip: false } }), notPermitted(PERMISSION_REASONS.policyOwnerOnly));
  reject(w, make(w, lead, 'member.removed', { memberId: w.owner.memberId }), notPermitted(PERMISSION_REASONS.leadOnOwner));
  reject(w, make(w, lead, 'member.role-changed', { memberId: w.owner.memberId, role: 'developer' }), notPermitted(PERMISSION_REASONS.leadOnOwner));
  reject(w, make(w, lead, 'device.added', { memberId: w.owner.memberId, device: deviceRef(newDevice) }), notPermitted(PERMISSION_REASONS.leadOnOwnerDevice));
  reject(w, make(w, lead, 'device.revoked', { memberId: w.owner.memberId, fingerprint: w.owner.identity.fingerprint }), notPermitted(PERMISSION_REASONS.leadOnOwnerDevice));
  reject(w, make(w, w.owner, 'member.role-changed', { memberId: w.owner.memberId, role: 'lead' }), notPermitted(PERMISSION_REASONS.ownRole));
  reject(w, make(w, w.owner, 'member.role-changed', { memberId: developer.memberId, role: 'owner' }), notPermitted(PERMISSION_REASONS.singleOwner));
  reject(w, make(w, w.owner, 'member.removed', { memberId: w.owner.memberId }), notPermitted(PERMISSION_REASONS.ownerCannotBeRemoved));
  reject(w, make(w, developer, 'member.removed', { memberId: lead.memberId }), notPermitted('the developer role does not allow removing members'));
  reject(w, make(w, developer, 'member.skills', { memberId: lead.memberId, skills: ['typescript'] }), notPermitted('the developer role does not allow editing skills for another member'));
  reject(w, make(w, developer, 'device.added', { memberId: lead.memberId, device: deviceRef(newDevice) }), notPermitted('the developer role does not allow adding devices for another member'));
  // A lead may still act on others, and a developer on their own record.
  accept(w, make(w, lead, 'member.role-changed', { memberId: developer.memberId, role: 'reviewer' }));
  accept(w, make(w, developer, 'member.skills', { memberId: developer.memberId, skills: ['typescript'] }));
});

test('an accepted verdict carries the author role at that position, read before the event changes anything (WR-05)', async () => {
  const w = await world();
  const lead = await withMember(w, 'lead');
  const developer = await withMember(w, 'developer');
  const roleAt = (event: TeamEvent): Role | undefined => {
    const verdict = applyEntry(w.state, entryOf(event));
    assert.equal(verdict.accepted, true);
    return verdict.accepted ? verdict.authorRole : undefined;
  };
  assert.equal(roleAt(make(w, lead, 'member.skills', { memberId: lead.memberId, skills: ['rust'] })), 'lead');
  assert.equal(roleAt(make(w, w.owner, 'member.role-changed', { memberId: lead.memberId, role: 'developer' })), 'owner');
  assert.equal(roleAt(make(w, lead, 'member.skills', { memberId: lead.memberId, skills: ['sql'] })), 'developer', 'after the demotion the same author is a developer');
  assert.equal(roleAt(make(w, developer, 'member.availability', { availability: 'away' })), 'developer');
  // The genesis events were read at the owner role as well.
  const fresh = await world();
  const replay = reduce([], fresh.anchor);
  const verdicts = fresh.genesis.map((entry) => applyEntry(replay, entry));
  assert.deepEqual(verdicts.map((verdict) => (verdict.accepted ? verdict.authorRole : undefined)), ['owner', 'owner']);
});

test('prev must name the accepted log head: a signed event pointing anywhere else is rejected with a fixed reason (WR-08)', async () => {
  const w = await world();
  const first = signed(w.owner, { teamId: w.teamId, type: 'member.availability', body: { availability: 'away' }, lamport: 3, prev: w.state.head.eventId });
  accept(w, first);
  const elsewhere = [
    '', // a genesis-style empty link
    w.genesis.length > 0 ? (JSON.parse(w.genesis[0].text) as { id: string }).id : '', // an older event, not the head
    newEventId() // an event that is not in the log at all
  ];
  for (const [index, prev] of elsewhere.entries()) {
    const event = signed(w.owner, { teamId: w.teamId, type: 'member.availability', body: { availability: 'focus' }, lamport: 4 + index, prev });
    reject(w, event, R.prevMismatch);
  }
  // The head did not move, so an event that names it is still accepted afterwards.
  accept(w, signed(w.owner, { teamId: w.teamId, type: 'member.availability', body: { availability: 'focus' }, lamport: 4, prev: first.id }));
});

test('a genesis team.created whose prev is not empty refuses the whole log (WR-08)', async () => {
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const { entries, anchor } = genesisEntries(owner, teamId);
  const original = JSON.parse(entries[0].text) as TeamEvent<'team.created'>;
  const { sig: _sig, ...unsigned } = original;
  void _sig;
  const linked = signEvent(owner.identity, { ...unsigned, prev: newEventId() });
  // The id, author and device are the anchored ones and the signature is valid: only the link differs.
  assert.equal(linked.id, original.id);
  const state = reduce([], anchor);
  const verdict = applyEntry(state, entryOf(linked));
  assert.equal(verdict.accepted, false);
  assert.equal(state.refused, R.logRefused);
});

test('references: unknown members, taken fingerprints, foreign or revoked devices and the last device are rejected with fixed reasons', async () => {
  const w = await world();
  const developer = await withMember(w, 'developer');
  const lead = await withMember(w, 'lead');
  const ghost = newMemberId();
  const spare = await makeDevice(w.owner);
  reject(w, make(w, w.owner, 'member.role-changed', { memberId: ghost, role: 'reviewer' }), R.memberMissing);
  reject(w, make(w, w.owner, 'member.removed', { memberId: ghost }), R.memberMissing);
  reject(w, make(w, w.owner, 'member.skills', { memberId: ghost, skills: [] }), R.memberMissing);
  reject(w, make(w, w.owner, 'device.added', { memberId: ghost, device: deviceRef(spare) }), R.memberMissing);
  reject(w, make(w, w.owner, 'device.added', { memberId: w.owner.memberId, device: deviceRef(w.owner) }), R.deviceTaken);
  reject(w, make(w, w.owner, 'device.added', { memberId: developer.memberId, device: deviceRef(lead) }), R.deviceTaken);
  reject(w, make(w, w.owner, 'device.revoked', { memberId: w.owner.memberId, fingerprint: developer.identity.fingerprint }), R.deviceNotBound);
  reject(w, make(w, w.owner, 'device.revoked', { memberId: w.owner.memberId, fingerprint: spare.identity.fingerprint }), R.deviceNotBound);
  reject(w, make(w, w.owner, 'device.revoked', { memberId: w.owner.memberId, fingerprint: w.owner.identity.fingerprint }), R.lastDevice);
  accept(w, make(w, w.owner, 'device.added', { memberId: w.owner.memberId, device: deviceRef(spare) }));
  accept(w, make(w, w.owner, 'device.revoked', { memberId: w.owner.memberId, fingerprint: spare.identity.fingerprint }));
  reject(w, make(w, w.owner, 'device.revoked', { memberId: w.owner.memberId, fingerprint: spare.identity.fingerprint }), R.deviceRevoked);
  accept(w, make(w, w.owner, 'member.removed', { memberId: developer.memberId }));
  reject(w, make(w, w.owner, 'member.removed', { memberId: developer.memberId }), R.memberRemoved);
  reject(w, make(w, w.owner, 'member.role-changed', { memberId: developer.memberId, role: 'lead' }), R.memberRemoved);
});

test('transitions: role change, removal, device add and revoke update the roster', async () => {
  const w = await world();
  const developer = await withMember(w, 'developer');
  const extra = await makeDevice(developer);
  const roleEvent = make(w, w.owner, 'member.role-changed', { memberId: developer.memberId, role: 'lead' });
  accept(w, roleEvent);
  assert.equal(w.state.members.get(developer.memberId)?.role, 'lead');
  const addEvent = make(w, w.owner, 'device.added', { memberId: developer.memberId, device: deviceRef(extra) });
  accept(w, addEvent);
  const added = w.state.members.get(developer.memberId)?.devices.find((device) => device.fingerprint === extra.identity.fingerprint);
  assert.deepEqual(added, { fingerprint: extra.identity.fingerprint, publicKey: extra.identity.publicKey, addedBy: w.owner.memberId, addedEvent: addEvent.id });
  assert.equal(w.state.deviceIndex.get(extra.identity.fingerprint), developer.memberId);
  const revokeEvent = make(w, w.owner, 'device.revoked', { memberId: developer.memberId, fingerprint: extra.identity.fingerprint });
  accept(w, revokeEvent);
  const revoked = w.state.members.get(developer.memberId)?.devices.find((device) => device.fingerprint === extra.identity.fingerprint);
  assert.equal(revoked?.revokedEvent, revokeEvent.id);
  assert.equal(revoked?.revokedBy, w.owner.memberId);
  const removeEvent = make(w, w.owner, 'member.removed', { memberId: developer.memberId });
  accept(w, removeEvent);
  const removed = w.state.members.get(developer.memberId);
  assert.equal(removed?.removedEvent, removeEvent.id);
  assert.equal(removed?.removedAt, removeEvent.at);
  assert.equal(w.state.deviceIndex.get(developer.identity.fingerprint), developer.memberId, 'a removed member keeps their fingerprints indexed');
  assert.equal(w.state.head.eventId, removeEvent.id);
  assert.equal(w.state.head.lamport, removeEvent.lamport);
  assert.equal(w.state.highLamport, removeEvent.lamport);
  assert.equal(w.state.accepted, 6);
  assert.equal(w.state.seenEventIds.has(removeEvent.id), true);
});

test('transitions: availability is the author only, skills follow self-or-manager, policy changes merge', async () => {
  const w = await world();
  const developer = await withMember(w, 'developer');
  const hours = { tz: 'UTC', days: [1, 2, 3], start: '09:00', end: '17:00' };
  accept(w, make(w, developer, 'member.availability', { availability: 'focus', workingHours: hours }));
  assert.equal(w.state.members.get(developer.memberId)?.availability, 'focus');
  assert.deepEqual(w.state.members.get(developer.memberId)?.workingHours, hours);
  assert.equal(w.state.members.get(w.owner.memberId)?.availability, 'available');
  accept(w, make(w, developer, 'member.availability', { availability: 'away' }));
  assert.deepEqual(w.state.members.get(developer.memberId)?.workingHours, hours, 'an update without hours keeps the hours');
  accept(w, make(w, w.owner, 'member.skills', { memberId: developer.memberId, skills: ['rust', 'typescript'] }));
  assert.deepEqual(w.state.members.get(developer.memberId)?.skills, ['rust', 'typescript']);
  const changes = { dispatchMode: 'auto' as const, teeOnly: true, sharedPaths: ['package.json'] };
  const before = w.state.team.policy;
  accept(w, make(w, w.owner, 'policy.changed', { changes }));
  assert.deepEqual(w.state.team.policy, applyPolicyChanges(defaultTeamPolicy(), changes));
  assert.notEqual(w.state.team.policy, before);
  assert.equal(before.teeOnly, false, 'the previous policy object is not mutated');
});

test('anomaly entries are recorded with their reason, genesis copies change nothing', async () => {
  const w = await world();
  const anomaly: CommittedEvent = { commit: 'a'.repeat(40), commitTime: 1, path: 'events/bad.json', blob: '', size: 0, text: '', kind: 'anomaly', anomaly: R.mergeCommit };
  expectRejected(w, anomaly, R.mergeCommit, 'events/bad.json');
  const before = serialiseState(w.state);
  const copy: CommittedEvent = { ...(w.genesis[0] as CommittedEvent), kind: 'genesis-copy' };
  assert.equal(applyEntry(w.state, copy).accepted, true);
  assert.equal(serialiseState(w.state), before);
  assert.equal(w.state.accepted, 2);
});

test('an unparseable event file is rejected as malformed under its path', async () => {
  const w = await world();
  const path = 'events/000000000003-evt-00000000000000000000000001.json';
  expectRejected(w, { ...(w.genesis[1] as CommittedEvent), path, text: 'not json', size: 8 }, R.malformed, path);
});

test('checkCandidate returns the rejection a read would produce and leaves the input state untouched', async () => {
  const w = await world();
  const developer = await withMember(w, 'developer');
  const before = serialiseState(w.state);
  const good = make(w, w.owner, 'member.availability', { availability: 'away' });
  assert.equal(checkCandidate(w.state, [good]), undefined);
  const forbidden = make(w, developer, 'policy.changed', { changes: { teeOnly: true } });
  assert.deepEqual(checkCandidate(w.state, [forbidden]), { eventId: forbidden.id, reason: notPermitted(PERMISSION_REASONS.policyOwnerOnly) });
  const second = signed(w.owner, { teamId: w.teamId, type: 'member.availability', body: { availability: 'focus' }, lamport: good.lamport + 1, prev: good.id });
  assert.equal(checkCandidate(w.state, [good, second]), undefined, 'a batch is checked in order against the growing candidate state');
  assert.deepEqual(checkCandidate(w.state, [good, { ...second, lamport: good.lamport }])?.reason, R.badSignature);
  assert.equal(serialiseState(w.state), before);
});

test('cloneState copies maps, sets, arrays, members and policy so a candidate never aliases the live state', async () => {
  const w = await world();
  const copy = cloneState(w.state);
  assert.equal(serialiseState(copy), serialiseState(w.state));
  copy.members.get(w.owner.memberId)?.devices.push({ fingerprint: 'dev-x', publicKey: 'x', addedBy: 'x', addedEvent: 'x' });
  copy.deviceIndex.set('dev-x', 'x');
  copy.seenEventIds.add('evt-x');
  copy.team.policy.teeOnly = true;
  copy.rejected.push({ eventId: 'x', reason: 'x' });
  assert.equal(w.state.members.get(w.owner.memberId)?.devices.length, 1);
  assert.equal(w.state.deviceIndex.has('dev-x'), false);
  assert.equal(w.state.seenEventIds.has('evt-x'), false);
  assert.equal(w.state.team.policy.teeOnly, false);
  assert.equal(w.state.rejected.length, 0);
});

// ---- Task 2: stable serialisation, state hash, snapshots and the determinism property ----

function snapshotEntry(path: string): CommittedEvent {
  return { commit: 'c'.repeat(40), commitTime: 1, path, blob: 'b'.repeat(40), size: 2, text: '{}', kind: 'snapshot' };
}

test('serialiseState is byte-stable: the same entries and any member insertion order give identical text', async () => {
  const w = await world();
  const again = reduce(w.genesis, w.anchor);
  assert.equal(serialiseState(w.state), serialiseState(again));
  const left = reduce(w.genesis, w.anchor);
  const right = reduce(w.genesis, w.anchor);
  const first = await makeActor(w.teamId);
  const second = await makeActor(w.teamId);
  addFixtureMember(left, first, 'developer');
  addFixtureMember(left, second, 'reviewer');
  addFixtureMember(right, second, 'reviewer');
  addFixtureMember(right, first, 'developer');
  assert.equal(serialiseState(left), serialiseState(right));
  assert.equal(stateHash(left), stateHash(right));
  assert.match(stateHash(left), /^[0-9a-f]{64}$/);
  assert.notEqual(stateHash(left), stateHash(w.state));
  assert.equal(serialiseState(cloneState(left)), serialiseState(left));
});

test('serialiseState carries refused and omits undefined fields', async () => {
  const w = await world();
  const plain = JSON.parse(serialiseState(w.state)) as Record<string, unknown>;
  assert.equal('refused' in plain, false);
  const refusedState = reduce([entryOf(signed(w.owner, { teamId: w.teamId, type: 'member.availability', body: { availability: 'away' }, lamport: 1, prev: '' }))], w.anchor);
  const refused = JSON.parse(serialiseState(refusedState)) as Record<string, unknown>;
  assert.equal(refused.refused, R.logRefused);
  assert.equal(serialiseState(w.state).includes('undefined'), false);
});

test('snapshot.written matching the replayed state is accepted and recorded; any mismatch is rejected', async () => {
  const w = await world();
  const good = snapshotWrittenBody(w.state);
  reject(w, make(w, w.owner, 'snapshot.written', { ...good, stateHash: 'f'.repeat(64) }), R.snapshotMismatch);
  reject(w, make(w, w.owner, 'snapshot.written', { ...good, coversThrough: newEventId() }), R.snapshotMismatch);
  reject(w, make(w, w.owner, 'snapshot.written', { ...good, lamport: good.lamport - 1, path: snapshotPath(good.lamport - 1) }), R.snapshotMismatch);
  const developer = await withMember(w, 'developer');
  reject(w, make(w, developer, 'snapshot.written', snapshotWrittenBody(w.state)), notPermitted('the developer role does not allow writing snapshots'));
  // The hash no longer covers state.rejected (WR-07), so the rejections above do not matter; the body is taken at the current head.
  const afterFixture = snapshotWrittenBody(w.state);
  const event = make(w, w.owner, 'snapshot.written', afterFixture);
  accept(w, event);
  assert.deepEqual(w.state.snapshots, [{ path: afterFixture.path, coversThrough: afterFixture.coversThrough, lamport: afterFixture.lamport, stateHash: afterFixture.stateHash, eventId: event.id }]);
  reject(w, make(w, w.owner, 'snapshot.written', afterFixture), R.snapshotMismatch);
});

test('the snapshot hash ignores version-dependent bookkeeping, so rejected junk and unknown event types do not break it (WR-07)', async () => {
  const w = await world();
  const quiet = reduce(w.genesis, w.anchor);
  // A reader that did not understand a newer event type records a rejection; another reader that saw a forged file records one too.
  const future = { ...signed(w.owner, { teamId: w.teamId, type: 'member.availability', body: { availability: 'away' }, lamport: 3, prev: w.state.head.eventId }), type: 'item.created' };
  expectRejected(w, entryOf(future as unknown as TeamEvent), R.unsupported);
  const forged = signed(w.owner, { teamId: w.teamId, type: 'member.availability', body: { availability: 'away' }, lamport: 3, prev: w.state.head.eventId });
  reject(w, { ...forged, body: { availability: 'focus' } }, R.badSignature);
  assert.equal(w.state.rejected.length, 2);
  assert.notEqual(serialiseState(w.state), serialiseState(quiet), 'the full state text still records the rejections');
  assert.equal(stateHash(w.state), stateHash(quiet), 'the hash does not');
  // Bookkeeping that depends on how a client counted entries is outside the hash as well.
  const counted = cloneState(quiet);
  counted.accepted += 1;
  counted.seenEventIds.add(newEventId());
  counted.snapshots.push({ path: snapshotPath(9), coversThrough: quiet.head.eventId, lamport: 9, stateHash: 'a'.repeat(64), eventId: newEventId() });
  assert.equal(stateHash(counted), stateHash(quiet));
  // A snapshot computed by the quiet reader is accepted by the reader that carries the junk.
  accept(w, make(w, w.owner, 'snapshot.written', snapshotWrittenBody(quiet)));
  assert.equal(w.state.snapshots.length, 1);
});

test('the snapshot hash still covers what matters: members, devices, policy, head and the hash version (WR-07)', async () => {
  const w = await world();
  const base = stateHash(w.state);
  const role = cloneState(w.state);
  addFixtureMember(role, await makeActor(w.teamId), 'developer');
  assert.notEqual(stateHash(role), base, 'a member');
  const policy = cloneState(w.state);
  policy.team.policy.teeOnly = !policy.team.policy.teeOnly;
  assert.notEqual(stateHash(policy), base, 'the policy');
  const moved = cloneState(w.state);
  moved.head = { eventId: newEventId(), lamport: moved.head.lamport + 1 };
  assert.notEqual(stateHash(moved), base, 'the head');
  const lamport = cloneState(w.state);
  lamport.highLamport += 1;
  assert.notEqual(stateHash(lamport), base, 'the highest lamport');
  const stopped = cloneState(w.state);
  stopped.stopped = true;
  assert.notEqual(stateHash(stopped), base, 'a later-phase field');
  assert.equal(STATE_HASH_VERSION, 1);
  const unversioned = createHash('sha256').update(serialiseState(w.state)).digest('hex');
  assert.notEqual(base, unversioned, 'the hash is of the versioned stable shape, not of the raw state text');
});

test('a snapshot file is accepted only when an accepted snapshot.written names its path', async () => {
  const w = await world();
  const orphanPath = snapshotPath(w.state.head.lamport);
  expectRejected(w, snapshotEntry(orphanPath), R.snapshotOrphan, orphanPath);
  const body = snapshotWrittenBody(w.state);
  assert.equal(body.path, orphanPath);
  accept(w, make(w, w.owner, 'snapshot.written', body));
  const before = serialiseState(w.state);
  assert.equal(applyEntry(w.state, snapshotEntry(body.path)).accepted, true);
  assert.equal(serialiseState(w.state), before);
  expectRejected(w, snapshotEntry(snapshotPath(body.lamport + 1)), R.snapshotOrphan, snapshotPath(body.lamport + 1));
});

test('parseSnapshotFile accepts an owner or lead signed snapshot as provisional and round-trips the state', async () => {
  const w = await world();
  const lead = await withMember(w, 'lead');
  accept(w, make(w, w.owner, 'member.skills', { memberId: lead.memberId, skills: ['sql'] }));
  const ownerSigned = signedSnapshot(w.owner, w.state);
  const parsed = parseSnapshotFile(canonicalize(ownerSigned), w.anchor);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.provisional, true);
  assert.equal(serialiseState(parsed.state), serialiseState(w.state));
  assert.equal(stateHash(parsed.state), ownerSigned.stateHash);
  assert.equal(parsed.file.coversThrough, w.state.head.eventId);
  const leadSigned = parseSnapshotFile(canonicalize(signedSnapshot(lead, w.state)), w.anchor);
  assert.equal(leadSigned.ok, true);
  assert.equal(deserialiseState(snapshotBody(w.state).state, w.anchor).accepted, w.state.accepted);
});

test('parseSnapshotFile rejects bad signatures, non-managers, hash mismatches, another team and extra keys', async () => {
  const w = await world();
  const developer = await withMember(w, 'developer');
  const stranger = await makeActor(w.teamId);
  const good = signedSnapshot(w.owner, w.state);
  const reason = (text: string, anchor: GenesisAnchor = w.anchor): string => {
    const parsed = parseSnapshotFile(text, anchor);
    assert.equal(parsed.ok, false, 'expected a rejection');
    return parsed.ok ? '' : parsed.reason;
  };
  const flipped = `${good.sig.startsWith('A') ? 'B' : 'A'}${good.sig.slice(1)}`;
  assert.equal(reason(canonicalize({ ...good, sig: flipped })), R.badSignature);
  assert.equal(reason(canonicalize(signedSnapshot(developer, w.state))), SNAPSHOT_REASONS.notManager);
  assert.equal(reason(canonicalize(signedSnapshot(stranger, w.state))), R.unboundDevice);
  assert.equal(reason(canonicalize(signedSnapshot(w.owner, w.state, { stateHash: 'e'.repeat(64) }))), R.snapshotMismatch);
  assert.equal(reason(canonicalize(signedSnapshot(w.owner, w.state, { coversThrough: newEventId() }))), R.snapshotMismatch);
  assert.equal(reason(canonicalize({ ...good, extra: 1 })), `${SNAPSHOT_REASONS.invalid}: file`);
  assert.equal(reason(canonicalize({ ...good, state: { ...good.state, extra: 1 } })).startsWith(SNAPSHOT_REASONS.invalid), true);
  assert.equal(reason(JSON.stringify(good, null, 2)), SNAPSHOT_REASONS.notCanonical);
  assert.equal(reason('not json'), SNAPSHOT_REASONS.malformed);
  const otherTeam = newTeamId();
  const otherOwner = await makeActor(otherTeam);
  const other = genesisEntries(otherOwner, otherTeam);
  assert.equal(reason(canonicalize(good), other.anchor), SNAPSHOT_REASONS.wrongTeam);
  assert.equal(reason(canonicalize(signedSnapshot(otherOwner, reduce(other.entries, other.anchor)))), SNAPSHOT_REASONS.wrongTeam);
  const wrongAnchor: GenesisAnchor = { ...w.anchor, eventId: newEventId() };
  assert.equal(reason(canonicalize(good), wrongAnchor).startsWith(SNAPSHOT_REASONS.invalid), true);
});

test('deserialiseState refuses a state that is not tied to the anchor or is internally inconsistent', async () => {
  const w = await world();
  const plain = (): JsonObject => JSON.parse(serialiseState(w.state)) as JsonObject;
  assert.doesNotThrow(() => deserialiseState(plain(), w.anchor));
  const withRefused = { ...plain(), refused: R.logRefused };
  assert.throws(() => deserialiseState(withRefused, w.anchor));
  const strangerDevice = await makeActor(w.teamId);
  const swapped = plain();
  const members = swapped.members as Array<{ devices: Array<{ publicKey: string; fingerprint: string }> }>;
  const device = members[0]?.devices[0];
  if (device === undefined) throw new Error('fixture has no device');
  device.publicKey = strangerDevice.identity.publicKey;
  device.fingerprint = strangerDevice.identity.fingerprint;
  assert.throws(() => deserialiseState(swapped, w.anchor));
  const inflated = { ...plain(), accepted: 99 };
  assert.throws(() => deserialiseState(inflated, w.anchor));
  // No email-derived value is kept, so a snapshot member that carries one is refused, however well formed.
  const withHash = plain();
  const hashed = withHash.members as Array<{ emailHashes: string[] }>;
  assert.ok(hashed[0] !== undefined && hashed[0].emailHashes.length === 0, 'members carry an empty list');
  hashed[0].emailHashes = ['a'.repeat(64)];
  assert.throws(() => deserialiseState(withHash, w.anchor), /emailHashes/);
});

test('deterministic property: replay, incremental application and snapshot plus tail agree over seeded random logs', async () => {
  const seeds = Array.from({ length: 40 }, (_unused, index) => 1001 + index * 7919);
  let withRotation = 0;
  let withStaleKey = 0;
  let withRevokedRetiredKey = 0;
  for (const seed of seeds) {
    const scenario = await buildScenario(seed, 60);
    const label = `seed ${seed}`;
    const full = reduce(scenario.entries, scenario.anchor);
    // (a) reduce is deterministic.
    assert.equal(serialiseState(reduce(scenario.entries, scenario.anchor)), serialiseState(full), `${label}: replay`);
    // (e) exactly the forged entries are rejected, each with its planned reason.
    assert.deepEqual(full.rejected, scenario.forged, `${label}: rejected list`);
    assert.equal(full.refused, undefined, label);
    if ([...full.members.values()].some((member) => member.devices.some((device) => device.rotatedEvent !== undefined))) withRotation += 1;
    if (full.rejected.some((rejection) => rejection.reason === R.rotatedDevice)) withStaleKey += 1;
    if ([...full.members.values()].some((member) => member.devices.some((device) => device.rotatedEvent !== undefined && device.revokedEvent !== undefined))) withRevokedRetiredKey += 1;
    // (b) incremental application in random chunks, with the live state copied between chunks, equals a full replay.
    const random = mulberry32(seed ^ 0x9e3779b9);
    let live = reduce([], scenario.anchor);
    for (let index = 0; index < scenario.entries.length;) {
      const size = 1 + Math.floor(random() * 9);
      for (const entry of scenario.entries.slice(index, index + size)) applyEntry(live, entry);
      index += size;
      live = cloneState(live);
    }
    assert.equal(serialiseState(live), serialiseState(full), `${label}: incremental`);
    // (c) rejected events change nothing but state.rejected.
    const validOnly = reduce(scenario.valid, scenario.anchor);
    assert.equal(withoutRejected(full), withoutRejected(validOnly), `${label}: forged entries leave no trace`);
    assert.deepEqual(validOnly.rejected, [], label);
    // (d) a snapshot taken at a random cut plus the tail equals the full replay, also through the signed file.
    const cut = 2 + Math.floor(random() * (scenario.entries.length - 2));
    const head = reduce(scenario.entries.slice(0, cut), scenario.anchor);
    const restored = deserialiseState(snapshotBody(head).state, scenario.anchor);
    for (const entry of scenario.entries.slice(cut)) applyEntry(restored, entry);
    assert.equal(serialiseState(restored), serialiseState(full), `${label}: snapshot at ${cut} plus tail`);
    const signedFile = parseSnapshotFile(canonicalize(signedSnapshot(scenario.owner, head)), scenario.anchor);
    assert.equal(signedFile.ok, true, `${label}: signed snapshot parses`);
    if (signedFile.ok) {
      for (const entry of scenario.entries.slice(cut)) applyEntry(signedFile.state, entry);
      assert.equal(serialiseState(signedFile.state), serialiseState(full), `${label}: provisional snapshot plus tail`);
    }
  }
  // The generator must really exercise rotations and the retired key's refusal, or the property says nothing about them.
  assert.ok(withRotation >= 5, `rotations appear in ${withRotation} of ${seeds.length} seeds`);
  assert.ok(withStaleKey >= 3, `a retired key is refused in ${withStaleKey} of ${seeds.length} seeds`);
  assert.ok(withRevokedRetiredKey >= 2, `a retired key is revoked in ${withRevokedRetiredKey} of ${seeds.length} seeds`);
});
