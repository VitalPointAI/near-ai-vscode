// Sealed key delivery in the signed log (Phase 61 plan 05): a lead seals a freshly created NEAR key to a joined member's device and appends
// member.key-sealed over real git; the member's clone opens it with the X25519 key kept in SecretStorage. Canary keys are built at run time.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';
import { expectedJoinRole, joinProofBytes, keyNeedsRotation, memberAttention } from '../domain/team/invite';
import { applyEntry, deserialiseState, reduce, serialiseState, stateHash, teamMaterializer } from '../domain/team/materialize';
import { PERMISSION_REASONS } from '../domain/team/permissions';
import { defaultTeamPolicy } from '../domain/team/policy';
import { assertNoSecrets } from '../domain/team/secrets';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { EntryVerdict, GenesisAnchor, JsonObject, MemberInvitedBody, MemberJoinedBody, MemberKeySealedBody, Role, SealedEntryBody, TeamEvent, TeamFile, TeamState } from '../domain/team/types';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { createDeviceIdentity, createSealIdentity, emailHash, loadSealIdentity, newMemberId, newTeamId } from '../team/identity';
import type { DeviceIdentity, SealIdentity } from '../team/identity';
import { deriveInviteKey, generateInviteCode } from '../team/inviteCode';
import { SEAL_SCHEME, sealTo } from '../team/keySeal';
import { canonicalTeamFile } from '../team/teamFile';
import { MemorySecrets, createOwner, createTeamFixture } from './helpers/teamHarness';
import type { TeamFixture, TestOwner } from './helpers/teamHarness';
import { addFixtureMember, entryOf, genesisEntries, makeActor, makeDevice, signed } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';
import { phase60Fixture } from './helpers/teamPhase60Fixture';

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
  const log = new TeamLog({ anchor, transport, now: fixedNow, ...(signer === undefined ? {} : { signer }) });
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

interface Seed { teamId: string; owner: TestOwner; signer: TeamSigner; anchor: GenesisAnchor; a: Client }

// Clone a writes the genesis through the transport, exactly as Enable Team Mode does.
async function seedTeam(fixture: TeamFixture): Promise<Seed> {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const genesis = buildGenesisEvents({
    teamId, teamName: 'Sealed key team', owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [emailHash(teamId, 'owner@example.invalid')] },
    identity: owner.identity, policy: defaultTeamPolicy(), now: fixedNow
  });
  const teamFile: TeamFile = {
    version: 1, teamId, name: 'Sealed key team', coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: genesis.anchor.eventId, ownerDevice: genesis.anchor.ownerDevice }, createdAt: '2026-02-03T04:05:06.000Z'
  };
  const signer: TeamSigner = { identity: owner.identity, memberId: owner.memberId };
  const a = clientFor(fixture, 'a', genesis.anchor, signer);
  const written = await a.transport.append(async () => genesis.events, { genesis: { teamFileText: canonicalTeamFile(teamFile) } });
  assert.equal(written.ok, true);
  return { teamId, owner, signer, anchor: genesis.anchor, a };
}

function inviteBodyFor(teamId: string, memberId: string, codeBytes: Buffer): MemberInvitedBody {
  return {
    memberId, name: 'Dana Developer', emailHashes: [emailHash(teamId, 'dana@example.invalid')], role: 'developer', allocationNanoUsd: 5_000_000_000,
    ttlSeconds: 604_800, invite: { publicKey: deriveInviteKey(codeBytes, teamId, memberId).publicKey }
  };
}

function joinBodyFor(state: TeamState, teamId: string, memberId: string, codeBytes: Buffer, identity: DeviceIdentity, sealKey: string): MemberJoinedBody | { conflict: string } {
  const member = state.members.get(memberId);
  if (member === undefined || member.invite === undefined) return { conflict: TEAM_REJECTION_REASONS.notInvited };
  const device = { fingerprint: identity.fingerprint, publicKey: identity.publicKey };
  const role: Role = expectedJoinRole(member.pendingRole ?? 'observer', state.team.policy);
  const sig = deriveInviteKey(codeBytes, teamId, memberId).sign(joinProofBytes(teamId, memberId, member.invite.eventId, device, sealKey));
  return { memberId, name: member.name, emailHashes: [...member.emailHashes], role, device, invite: { sig }, sealKey: { publicKey: sealKey } };
}

// A key id and a clear key built at run time. The id is what the log records; the key is what must never appear anywhere.
function canaryKey(): { keyId: string; clear: string } {
  return { keyId: `key_${randomBytes(8).toString('hex')}`, clear: `sk-canary${randomBytes(24).toString('hex')}` };
}

test('tracer: a lead seals a key to a joined member over real git and the member clone opens it', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const { teamId, anchor, a } = await seedTeam(fixture);
    const memberId = newMemberId();
    const code = generateInviteCode();
    assert.equal((await a.log.append(() => [{ type: 'member.invited', body: inviteBodyFor(teamId, memberId, code.bytes) }])).ok, true);

    // The member's clone has a device key and an X25519 seal key, both in its own SecretStorage.
    const b = clientFor(fixture, 'b', anchor);
    await b.log.sync();
    const bSecrets = new MemorySecrets();
    const identity = await createDeviceIdentity(bSecrets, teamId);
    const seal: SealIdentity = await createSealIdentity(bSecrets, teamId);
    const joined = await b.log.appendJoin(identity, (state) => joinBodyFor(state, teamId, memberId, code.bytes, identity, seal.publicKey));
    assert.equal(joined.ok, true, joined.ok ? '' : joined.reason);

    // The owner confirms the member, then seals a key made for that member to the member's one device.
    await a.log.sync();
    assert.equal((await a.log.append(() => [{ type: 'member.role-changed', body: { memberId, role: 'developer' } }])).ok, true);
    const { keyId, clear } = canaryKey();
    const entry = sealTo(Buffer.from(clear, 'utf8'), seal.publicKey, { teamId, memberId, device: identity.fingerprint, keyId });
    const body: MemberKeySealedBody = { memberId, keyId, scheme: SEAL_SCHEME, sealed: [entry] };
    assertNoSecrets(body, 'member.key-sealed event');
    const sealed = await a.log.append(() => [{ type: 'member.key-sealed', body }]);
    assert.equal(sealed.ok, true, sealed.ok ? '' : sealed.reason);

    const synced = await b.log.sync();
    assert.deepEqual(synced.rejected, []);
    const event = synced.accepted.find((candidate): candidate is TeamEvent<'member.key-sealed'> => candidate.type === 'member.key-sealed');
    assert.ok(event !== undefined, 'the member clone accepted the sealed key event');
    const member = b.log.state().members.get(memberId);
    assert.equal(member?.nearApiKeyId, keyId);
    assert.deepEqual(member?.nearKeyDevices, [identity.fingerprint]);
    assert.equal(member?.nearKeyEvent, event.id);
    assert.equal(member?.role, 'developer');

    // The member opens its own entry with the key from SecretStorage and gets the clear key back.
    const mine = event.body.sealed.find((candidate) => candidate.device === identity.fingerprint);
    assert.ok(mine !== undefined, 'the event holds an entry for this device');
    const reloaded = await loadSealIdentity(bSecrets, teamId);
    assert.ok(reloaded !== undefined, 'the seal key is in SecretStorage');
    const opened = reloaded.open(mine, { teamId, memberId, device: identity.fingerprint, keyId });
    assert.equal(opened?.toString('utf8'), clear);

    // The clear key appears in no object on the coordination remote; the key id is the only trace.
    const everything = execFileSync('git', ['-C', fixture.remote, 'cat-file', '--batch-all-objects', '--batch'], { maxBuffer: 64 * 1024 * 1024 });
    for (const needle of [clear, Buffer.from(clear, 'utf8').toString('base64'), Buffer.from(clear, 'utf8').toString('base64url'), Buffer.from(clear, 'utf8').toString('hex')]) {
      assert.equal(everything.includes(Buffer.from(needle, 'utf8')), false, 'a rendering of the clear key is in the remote');
    }
    assert.equal(everything.includes(Buffer.from(keyId, 'utf8')), true, 'the key id is recorded');
    assert.equal(everything.includes(Buffer.from(code.text, 'utf8')), false, 'the invite code is not in the remote');
  });
});


// ---- Delivery rules on fixture entries --------------------------------------------------------------------------------------------------
// Members are placed straight into the state (as the Phase 60 permission tests do); every event is signed and applied through applyEntry,
// so each rule is checked at the position where a reader would meet it.

const R = TEAM_REJECTION_REASONS;

interface World { teamId: string; owner: TestActor; state: TeamState }

async function worldWith(): Promise<World> {
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const { entries, anchor } = genesisEntries(owner, teamId);
  return { teamId, owner, state: reduce(entries, anchor) };
}

function next(world: World): { teamId: string; lamport: number; prev: string } {
  return { teamId: world.teamId, lamport: world.state.highLamport + 1, prev: world.state.head.eventId };
}

function x25519PublicKey(): string {
  const jwk = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' });
  assert.equal(typeof jwk.x, 'string');
  return jwk.x as string;
}

function accepted(verdict: EntryVerdict): void {
  assert.equal(verdict.accepted, true, verdict.accepted ? '' : verdict.rejection.reason);
}

function rejectedWith(verdict: EntryVerdict, reason: string): void {
  assert.equal(verdict.accepted, false, 'expected a rejection');
  if (!verdict.accepted) assert.equal(verdict.rejection.reason, reason);
}

// A joined member whose first device publishes a seal key.
async function addJoined(world: World, role: Role, name: string, withSealKey = true): Promise<TestActor> {
  const actor = await makeActor(world.teamId);
  addFixtureMember(world.state, actor, role, name);
  const device = world.state.members.get(actor.memberId)?.devices[0];
  assert.ok(device !== undefined);
  if (withSealKey) device.sealKey = x25519PublicKey();
  return actor;
}

// Entries with the right byte lengths but no real ciphertext: the log checks shape and binding, never decrypts.
function fakeSealed(devices: string[]): SealedEntryBody[] {
  return devices.map((device) => ({
    device, ephemeral: { publicKey: randomBytes(32).toString('base64url') }, nonce: randomBytes(12).toString('base64url'),
    tag: randomBytes(16).toString('base64url'), ciphertext: randomBytes(48).toString('base64url')
  }));
}

function newKeyId(): string {
  return `key_${randomBytes(8).toString('hex')}`;
}

function deliver(world: World, author: TestActor, memberId: string, devices: string[], keyId: string = newKeyId()): EntryVerdict {
  const body: MemberKeySealedBody = { memberId, keyId, scheme: SEAL_SCHEME, sealed: fakeSealed(devices) };
  return applyEntry(world.state, entryOf(signed(author, { ...next(world), type: 'member.key-sealed', body })));
}

function fingerprintsOf(world: World, memberId: string): string[] {
  return (world.state.members.get(memberId)?.devices ?? []).map((device) => device.fingerprint);
}

// A second device for the member, added by the member's first device. The seal key is optional, as in device.added.
async function addDevice(world: World, member: TestActor, withSealKey: boolean): Promise<{ device: TestActor; verdict: EntryVerdict }> {
  const device = await makeDevice(member);
  const ref = { fingerprint: device.identity.fingerprint, publicKey: device.identity.publicKey };
  const body = withSealKey ? { memberId: member.memberId, device: ref, sealKey: { publicKey: x25519PublicKey() } } : { memberId: member.memberId, device: ref };
  return { device, verdict: applyEntry(world.state, entryOf(signed(member, { ...next(world), type: 'device.added', body }))) };
}

function revokeDevice(world: World, author: TestActor, memberId: string, fingerprint: string): EntryVerdict {
  return applyEntry(world.state, entryOf(signed(author, { ...next(world), type: 'device.revoked', body: { memberId, fingerprint } })));
}

test('only the owner or a lead delivers a key, and never to the owner', async () => {
  const world = await worldWith();
  const lead = await addJoined(world, 'lead', 'Lee Lead');
  const developer = await addJoined(world, 'developer', 'Dana Developer');
  const target = await addJoined(world, 'developer', 'Eli Target');
  const targetDevices = fingerprintsOf(world, target.memberId);

  rejectedWith(deliver(world, developer, target.memberId, targetDevices), `${R.notPermitted}: the developer role does not allow delivering team API keys`);
  const ownerDevices = fingerprintsOf(world, world.owner.memberId);
  rejectedWith(deliver(world, lead, world.owner.memberId, ownerDevices), `${R.notPermitted}: ${PERMISSION_REASONS.ownerKey}`);
  rejectedWith(deliver(world, world.owner, world.owner.memberId, ownerDevices), `${R.notPermitted}: ${PERMISSION_REASONS.ownerKey}`);
  accepted(deliver(world, lead, target.memberId, targetDevices));
  assert.equal(world.state.members.get(target.memberId)?.nearApiKeyId?.startsWith('key_'), true);
  const second = await addJoined(world, 'reviewer', 'Rae Reviewer');
  accepted(deliver(world, world.owner, second.memberId, fingerprintsOf(world, second.memberId)));
});

test('the target must be joined and not removed', async () => {
  const world = await worldWith();
  const invited = await addJoined(world, 'observer', 'Ivy Invited');
  const member = world.state.members.get(invited.memberId);
  assert.ok(member !== undefined);
  member.status = 'invited';
  member.devices = [];
  rejectedWith(deliver(world, world.owner, invited.memberId, []), `${R.invalidBody}: body.sealed`);
  rejectedWith(deliver(world, world.owner, invited.memberId, [`dev-${'a'.repeat(32)}`]), R.notJoined);

  const gone = await addJoined(world, 'developer', 'Gus Gone');
  const goneDevices = fingerprintsOf(world, gone.memberId);
  const removed = world.state.members.get(gone.memberId);
  assert.ok(removed !== undefined);
  removed.removedEvent = 'evt-01ARZ3NDEKTSV4RRFFQ69G5FAV';
  rejectedWith(deliver(world, world.owner, gone.memberId, goneDevices), R.memberRemoved);
  rejectedWith(deliver(world, world.owner, `mbr-${'0'.repeat(16)}`, goneDevices), R.memberMissing);
});

test('every delivery is a new key: the current and every retired key id is refused', async () => {
  const world = await worldWith();
  const target = await addJoined(world, 'developer', 'Dana Developer');
  const devices = fingerprintsOf(world, target.memberId);
  const first = newKeyId();
  const second = newKeyId();
  accepted(deliver(world, world.owner, target.memberId, devices, first));
  rejectedWith(deliver(world, world.owner, target.memberId, devices, first), R.keyReused);
  accepted(deliver(world, world.owner, target.memberId, devices, second));
  const member = world.state.members.get(target.memberId);
  assert.equal(member?.nearApiKeyId, second);
  assert.deepEqual(member?.retiredNearKeyIds, [first]);
  rejectedWith(deliver(world, world.owner, target.memberId, devices, first), R.keyReused);
  rejectedWith(deliver(world, world.owner, target.memberId, devices, second), R.keyReused);
  assert.equal(member?.nearApiKeyId !== undefined && (member.retiredNearKeyIds ?? []).includes(member.nearApiKeyId), false, 'the current id is never in the retired list');
});

test('sealing to a device of another member, a revoked device or a device without a seal key is refused', async () => {
  const world = await worldWith();
  const target = await addJoined(world, 'developer', 'Dana Developer');
  const other = await addJoined(world, 'developer', 'Eli Other');
  const mine = fingerprintsOf(world, target.memberId);
  rejectedWith(deliver(world, world.owner, target.memberId, [...mine, ...fingerprintsOf(world, other.memberId)]), R.noSealKey);
  rejectedWith(deliver(world, world.owner, target.memberId, [`dev-${'c'.repeat(32)}`]), R.noSealKey);

  const plain = await addDevice(world, target, false);
  accepted(plain.verdict);
  rejectedWith(deliver(world, world.owner, target.memberId, [...mine, plain.device.identity.fingerprint]), R.noSealKey);
  accepted(deliver(world, world.owner, target.memberId, mine));

  const sealed = await addDevice(world, target, true);
  accepted(sealed.verdict);
  accepted(revokeDevice(world, target, target.memberId, sealed.device.identity.fingerprint));
  rejectedWith(deliver(world, world.owner, target.memberId, [...mine, sealed.device.identity.fingerprint]), R.noSealKey);
});

test('the sealed devices must be exactly the active devices that have a seal key', async () => {
  const world = await worldWith();
  const target = await addJoined(world, 'developer', 'Dana Developer');
  const added = await addDevice(world, target, true);
  accepted(added.verdict);
  const [first] = fingerprintsOf(world, target.memberId);
  const both = fingerprintsOf(world, target.memberId);
  assert.equal(both.length, 2);
  rejectedWith(deliver(world, world.owner, target.memberId, [first]), R.keyDevices);
  accepted(deliver(world, world.owner, target.memberId, both));
  assert.deepEqual(world.state.members.get(target.memberId)?.nearKeyDevices, [...both].sort());
});

test('device.added with a seal key records it, one without is still valid, and a key stops matching once the device set changes', async () => {
  const world = await worldWith();
  const target = await addJoined(world, 'developer', 'Dana Developer');
  const devices = fingerprintsOf(world, target.memberId);
  const member = world.state.members.get(target.memberId);
  assert.ok(member !== undefined);
  assert.equal(keyNeedsRotation(member), false, 'no key yet, nothing to rotate');
  const firstKey = newKeyId();
  accepted(deliver(world, world.owner, target.memberId, devices, firstKey));
  assert.equal(keyNeedsRotation(member), false);

  const plain = await addDevice(world, target, false);
  accepted(plain.verdict);
  assert.equal(member.devices.find((device) => device.fingerprint === plain.device.identity.fingerprint)?.sealKey, undefined);
  assert.equal(keyNeedsRotation(member), false, 'a device that cannot receive a key does not change the key');

  const sealed = await addDevice(world, target, true);
  accepted(sealed.verdict);
  assert.equal(typeof member.devices.find((device) => device.fingerprint === sealed.device.identity.fingerprint)?.sealKey, 'string');
  assert.equal(keyNeedsRotation(member), true, 'a new seal-capable device means the key must be re-created');
  const secondKey = newKeyId();
  accepted(deliver(world, world.owner, target.memberId, [...devices, sealed.device.identity.fingerprint], secondKey));
  assert.equal(keyNeedsRotation(member), false);
  assert.deepEqual(member.retiredNearKeyIds, [firstKey]);
  assert.equal(member.nearApiKeyId, secondKey);

  accepted(revokeDevice(world, target, target.memberId, sealed.device.identity.fingerprint));
  assert.equal(keyNeedsRotation(member), true, 'a revoked device means the key must be re-created');
  accepted(deliver(world, world.owner, target.memberId, devices, newKeyId()));
  assert.equal(keyNeedsRotation(member), false);
  assert.equal(member.retiredNearKeyIds?.length, 2);
});

test('memberAttention lists confirmations, missing keys and rotations in member order, and only confirmations without a NEAR link', async () => {
  const world = await worldWith();
  const waiting = await addJoined(world, 'observer', 'Wes Waiting');
  const waitingMember = world.state.members.get(waiting.memberId);
  assert.ok(waitingMember !== undefined);
  waitingMember.pendingRole = 'developer';
  const needsKey = await addJoined(world, 'developer', 'Ned Needskey');
  const noSealDevice = await addJoined(world, 'developer', 'Nia Noseal', false);
  const rotating = await addJoined(world, 'reviewer', 'Rob Rotating');
  const done = await addJoined(world, 'developer', 'Dot Done');
  accepted(deliver(world, world.owner, rotating.memberId, fingerprintsOf(world, rotating.memberId)));
  accepted(deliver(world, world.owner, done.memberId, fingerprintsOf(world, done.memberId)));
  accepted((await addDevice(world, rotating, true)).verdict);

  const invited = await addJoined(world, 'observer', 'Ivy Invited');
  const invitedMember = world.state.members.get(invited.memberId);
  assert.ok(invitedMember !== undefined);
  invitedMember.status = 'invited';
  invitedMember.pendingRole = 'developer';
  invitedMember.devices = [];
  const gone = await addJoined(world, 'developer', 'Gus Gone');
  const goneMember = world.state.members.get(gone.memberId);
  assert.ok(goneMember !== undefined);
  goneMember.removedEvent = 'evt-01ARZ3NDEKTSV4RRFFQ69G5FAV';
  goneMember.pendingRole = 'developer';

  assert.deepEqual(memberAttention(world.state, true), [
    { memberId: waiting.memberId, kind: 'confirm' },
    { memberId: needsKey.memberId, kind: 'deliver-key' },
    { memberId: rotating.memberId, kind: 'rotate-key' }
  ]);
  assert.deepEqual(memberAttention(world.state, false), [{ memberId: waiting.memberId, kind: 'confirm' }]);
  assert.equal(memberAttention(world.state, true).some((item: { memberId: string }) => item.memberId === world.owner.memberId || item.memberId === noSealDevice.memberId), false);
});

// Taken from the Phase 60 code (the commit before plan 61-01) over the deterministic log in helpers/teamPhase60Fixture.ts.
const PHASE60_STATE_HASH = 'e41fe7cbcc4fc089a0f07a373835e3388a20d76e6fe235cc0121204863e14408';

test('a Phase 60 state keeps its hash and serialises none of the key delivery fields', async () => {
  const { entries, anchor } = await phase60Fixture();
  const state = reduce(entries, anchor);
  assert.equal(state.accepted, 2);
  assert.equal(stateHash(state), PHASE60_STATE_HASH);
  const text = serialiseState(state);
  for (const key of ['nearApiKeyId', 'nearKeyDevices', 'nearKeyEvent', 'retiredNearKeyIds', 'sealKey']) assert.equal(text.includes(`"${key}"`), false, `${key} is left out when absent`);
  const restored = deserialiseState(JSON.parse(text) as JsonObject, anchor);
  assert.equal(stateHash(restored), PHASE60_STATE_HASH, 'the state loads from its snapshot form with the same hash');
  assert.equal(serialiseState(restored), text);
});

test('a team with delivered keys and retired key ids round-trips through the snapshot form', async () => {
  const world = await worldWith();
  const target = await addJoined(world, 'developer', 'Dana Developer');
  accepted(deliver(world, world.owner, target.memberId, fingerprintsOf(world, target.memberId)));
  accepted(deliver(world, world.owner, target.memberId, fingerprintsOf(world, target.memberId)));
  assert.equal(world.state.members.get(target.memberId)?.retiredNearKeyIds?.length, 1);
  const text = serialiseState(world.state);
  const restored = deserialiseState(JSON.parse(text) as JsonObject, world.state.genesis);
  assert.equal(serialiseState(restored), text);
  assert.equal(stateHash(restored), stateHash(world.state));
});
