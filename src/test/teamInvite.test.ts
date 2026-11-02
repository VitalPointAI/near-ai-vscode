// Invite and join on the signed log (Phase 61 plan 01): the single-use code, the invite-gated member.joined from a second clone over real git,
// and the guarantee that the clear-text code never reaches the coordination branch. Canary codes are built at run time, never as literals.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';
import { verifySignature } from '../domain/team/canonical';
import { INVITE_SKEW_SECONDS, expectedJoinRole, inviteExpired, invitationStatus, joinProofBytes } from '../domain/team/invite';
import { applyEntry, deserialiseState, reduce, serialiseState, stateHash, teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import { assertNoSecrets } from '../domain/team/secrets';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { EntryVerdict, GenesisAnchor, JsonObject, MemberInvitedBody, MemberJoinedBody, Role, TeamEvent, TeamFile, TeamState } from '../domain/team/types';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { INVITE_CODE_BYTES, deriveInviteKey, formatInviteCode, generateInviteCode, inviteKeyMatches, parseInviteCode } from '../team/inviteCode';
import { createDeviceIdentity, emailHash, newMemberId, newTeamId } from '../team/identity';
import type { DeviceIdentity } from '../team/identity';
import { canonicalTeamFile } from '../team/teamFile';
import { MemorySecrets, createOwner, createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture, TestOwner } from './helpers/teamHarness';
import { entryOf, genesisEntries, makeActor, signed } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';

const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{32}$/;
const fixedNow = (): Date => new Date('2026-02-03T04:05:06.000Z');

interface Client { transport: GitTransport<TeamState>; log: TeamLog }

function clientFor(fixture: TeamFixture, name: string, anchor: GenesisAnchor, signer?: TeamSigner, transportNow?: () => number): Client {
  const transport = new GitTransport<TeamState>({
    mirrorDir: path.join(fixture.storageDir(name), 'coordination.git'),
    projectRoot: fixture.clones[name] as string,
    remote: 'origin',
    ref: DEFAULT_COORDINATION_REF,
    materializer: teamMaterializer(anchor),
    baseDelayMs: 1,
    ...(transportNow === undefined ? {} : { now: transportNow })
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
    teamId, teamName: 'Invite team', owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [emailHash(teamId, 'owner@example.invalid')] },
    identity: owner.identity, policy: defaultTeamPolicy(), now: fixedNow
  });
  const teamFile: TeamFile = {
    version: 1, teamId, name: 'Invite team', coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: genesis.anchor.eventId, ownerDevice: genesis.anchor.ownerDevice }, createdAt: '2026-02-03T04:05:06.000Z'
  };
  const signer: TeamSigner = { identity: owner.identity, memberId: owner.memberId };
  const a = clientFor(fixture, 'a', genesis.anchor, signer);
  const written = await a.transport.append(async () => genesis.events, { genesis: { teamFileText: canonicalTeamFile(teamFile) } });
  assert.equal(written.ok, true);
  return { teamId, owner, signer, anchor: genesis.anchor, a };
}

function inviteBodyFor(teamId: string, memberId: string, codeBytes: Buffer, overrides: Partial<MemberInvitedBody> = {}): MemberInvitedBody {
  return {
    memberId, name: 'Dana Developer', emailHashes: [emailHash(teamId, 'dana@example.invalid')], role: 'developer', allocationNanoUsd: 5_000_000_000,
    ttlSeconds: 604_800, invite: { publicKey: deriveInviteKey(codeBytes, teamId, memberId).publicKey }, ...overrides
  };
}

function x25519PublicKey(): string {
  const jwk = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' });
  assert.equal(typeof jwk.x, 'string');
  return jwk.x as string;
}

// What a joiner's client builds from the synced state and the code, exactly as the Join command will.
function joinBodyFor(state: TeamState, teamId: string, memberId: string, codeBytes: Buffer, identity: DeviceIdentity, sealKey: string): MemberJoinedBody | { conflict: string } {
  const member = state.members.get(memberId);
  if (member === undefined || member.invite === undefined) return { conflict: TEAM_REJECTION_REASONS.notInvited };
  const device = { fingerprint: identity.fingerprint, publicKey: identity.publicKey };
  const role: Role = expectedJoinRole(member.pendingRole ?? 'observer', state.team.policy);
  const sig = deriveInviteKey(codeBytes, teamId, memberId).sign(joinProofBytes(teamId, memberId, member.invite.eventId, device, sealKey));
  return { memberId, name: member.name, emailHashes: [...member.emailHashes], role, device, invite: { sig }, sealKey: { publicKey: sealKey } };
}

test('an invite code is 160 random bits shown as 32 Crockford characters and parsed back after grouping and mistyping', () => {
  const code = generateInviteCode();
  assert.equal(code.bytes.length, INVITE_CODE_BYTES);
  assert.equal(INVITE_CODE_BYTES, 20);
  assert.match(code.text, CROCKFORD);
  assert.notEqual(generateInviteCode().text, code.text);
  const grouped = formatInviteCode(code.text);
  assert.match(grouped, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  assert.deepEqual(parseInviteCode(grouped), code.bytes);
  assert.deepEqual(parseInviteCode(grouped.toLowerCase().replace(/-/g, ' ')), code.bytes);
  assert.deepEqual(parseInviteCode(code.text), code.bytes);
  const withZero = '0'.repeat(31) + '1';
  assert.deepEqual(parseInviteCode('O'.repeat(31) + 'I'), parseInviteCode(withZero), 'O reads as 0 and I as 1');
  assert.deepEqual(parseInviteCode('O'.repeat(31) + 'l'), parseInviteCode(withZero), 'l reads as 1');
  assert.equal(parseInviteCode(code.text.slice(1)), undefined, '31 characters');
  assert.equal(parseInviteCode(`${code.text}A`), undefined, '33 characters');
  assert.equal(parseInviteCode(`U${code.text.slice(1)}`), undefined, 'U is not in the alphabet');
});

test('the derived invite key is stable per code, team and member, and its signatures verify as Ed25519', () => {
  const code = generateInviteCode();
  const teamId = newTeamId();
  const memberId = newMemberId();
  const key = deriveInviteKey(code.bytes, teamId, memberId);
  assert.equal(key.publicKey.length, 43);
  assert.equal(deriveInviteKey(code.bytes, teamId, memberId).publicKey, key.publicKey);
  assert.notEqual(deriveInviteKey(code.bytes, teamId, newMemberId()).publicKey, key.publicKey);
  assert.notEqual(deriveInviteKey(code.bytes, newTeamId(), memberId).publicKey, key.publicKey);
  assert.notEqual(deriveInviteKey(generateInviteCode().bytes, teamId, memberId).publicKey, key.publicKey);
  const message = Buffer.from('proof bytes');
  assert.equal(verifySignature(message, key.sign(message), key.publicKey), true);
  assert.equal(verifySignature(Buffer.from('other bytes'), key.sign(message), key.publicKey), false);
  assert.equal(inviteKeyMatches(code.bytes, teamId, memberId, key.publicKey), true);
  assert.equal(inviteKeyMatches(generateInviteCode().bytes, teamId, memberId, key.publicKey), false);
});

test('tracer: an owner invites, a second clone joins with only the code, and both clones materialise identical state', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const { teamId, anchor, a } = await seedTeam(fixture);
    const memberId = newMemberId();
    const code = generateInviteCode();
    const invited = await a.log.append(() => [{ type: 'member.invited', body: inviteBodyFor(teamId, memberId, code.bytes) }]);
    assert.equal(invited.ok, true);

    // Clone b has no device key and no signer: it can sync and join, nothing else.
    const b = clientFor(fixture, 'b', anchor);
    const synced = await b.log.sync();
    assert.deepEqual(synced.rejected, []);
    const pending = b.log.state().members.get(memberId);
    assert.equal(pending?.status, 'invited');
    assert.equal(pending?.role, 'observer');
    assert.equal(pending?.pendingRole, 'developer');
    assert.deepEqual(pending?.devices, []);

    const identity = await createDeviceIdentity(new MemorySecrets(), teamId);
    const sealKey = x25519PublicKey();
    const joined = await b.log.appendJoin(identity, (state) => joinBodyFor(state, teamId, memberId, code.bytes, identity, sealKey));
    assert.equal(joined.ok, true, joined.ok ? '' : joined.reason);

    const resynced = await a.log.sync();
    assert.deepEqual(resynced.rejected, []);
    assert.equal(serialiseState(a.log.state()), serialiseState(b.log.state()));
    const member = a.log.state().members.get(memberId);
    assert.equal(member?.status, undefined);
    assert.equal(member?.invite, undefined);
    assert.equal(member?.role, 'observer', 'stays observer until a lead confirms');
    assert.equal(member?.pendingRole, 'developer');
    assert.equal(member?.devices.length, 1);
    assert.equal(member?.devices[0]?.fingerprint, identity.fingerprint);
    assert.equal(member?.devices[0]?.sealKey, sealKey);
    assert.equal(a.log.state().deviceIndex.get(identity.fingerprint), memberId);
  });
});

test('the clear-text code never appears in any object on the coordination remote', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const { teamId, anchor, a } = await seedTeam(fixture);
    const memberId = newMemberId();
    const code = generateInviteCode();
    assert.equal((await a.log.append(() => [{ type: 'member.invited', body: inviteBodyFor(teamId, memberId, code.bytes) }])).ok, true);
    const b = clientFor(fixture, 'b', anchor);
    await b.log.sync();
    const identity = await createDeviceIdentity(new MemorySecrets(), teamId);
    const joined = await b.log.appendJoin(identity, (state) => joinBodyFor(state, teamId, memberId, code.bytes, identity, x25519PublicKey()));
    assert.equal(joined.ok, true);

    const everything = execFileSync('git', ['-C', fixture.remote, 'cat-file', '--batch-all-objects', '--batch'], { maxBuffer: 64 * 1024 * 1024 });
    const needles = [code.text, formatInviteCode(code.text), code.bytes.toString('hex'), code.bytes.toString('base64url'), code.bytes.toString('base64')];
    for (const needle of needles) {
      assert.equal(everything.includes(Buffer.from(needle, 'utf8')), false, 'a rendering of the code is in the remote');
    }
    assert.equal(everything.includes(Buffer.from(deriveInviteKey(code.bytes, teamId, memberId).publicKey, 'utf8')), true, 'the derived public key is the only trace');
  });
});


// ---- Join rules on fixture entries ----------------------------------------------------------------------------------------------------
// Entries carry explicit commit times, so every rule and the exact expiry boundary are checked without a clock and without git.

const INVITE_TIME = 1_000_000;
const TTL = 86_400;

interface World { teamId: string; owner: TestActor; state: TeamState }
interface Invitation { memberId: string; code: ReturnType<typeof generateInviteCode>; inviteEventId: string }

async function worldWith(): Promise<World> {
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const { entries, anchor } = genesisEntries(owner, teamId);
  return { teamId, owner, state: reduce(entries, anchor) };
}

function put(world: World, actor: TestActor, event: TeamEvent, commitTime: number): EntryVerdict {
  return applyEntry(world.state, { ...entryOf(event), commitTime });
}

function next(world: World): { teamId: string; lamport: number; prev: string } {
  return { teamId: world.teamId, lamport: world.state.highLamport + 1, prev: world.state.head.eventId };
}

function accepted(verdict: EntryVerdict): void {
  assert.equal(verdict.accepted, true, verdict.accepted ? '' : verdict.rejection.reason);
}

function rejectedWith(verdict: EntryVerdict, reason: string): void {
  assert.equal(verdict.accepted, false, 'expected a rejection');
  if (!verdict.accepted) assert.equal(verdict.rejection.reason, reason);
}

function invite(world: World, overrides: Partial<MemberInvitedBody> = {}, commitTime = INVITE_TIME, author: TestActor = world.owner): Invitation {
  const memberId = overrides.memberId ?? newMemberId();
  const code = generateInviteCode();
  const event = signed(author, { ...next(world), type: 'member.invited', body: inviteBodyFor(world.teamId, memberId, code.bytes, { ttlSeconds: TTL, ...overrides }) });
  accepted(put(world, author, event, commitTime));
  return { memberId, code, inviteEventId: event.id };
}

async function joiner(world: World, invitation: Invitation): Promise<TestActor> {
  const identity = await createDeviceIdentity(new MemorySecrets(), world.teamId);
  return { memberId: invitation.memberId, identity, secrets: new MemorySecrets() };
}

function joinEvent(world: World, invitation: Invitation, actor: TestActor, overrides: Partial<MemberJoinedBody> = {}, codeBytes: Buffer = invitation.code.bytes): TeamEvent<'member.joined'> {
  const member = world.state.members.get(invitation.memberId);
  const device = { fingerprint: actor.identity.fingerprint, publicKey: actor.identity.publicKey };
  const sealKey = x25519PublicKey();
  const sig = deriveInviteKey(codeBytes, world.teamId, invitation.memberId).sign(joinProofBytes(world.teamId, invitation.memberId, invitation.inviteEventId, device, sealKey));
  const body: MemberJoinedBody = {
    memberId: invitation.memberId, name: member?.name ?? 'Dana Developer', emailHashes: [...(member?.emailHashes ?? [])],
    role: expectedJoinRole(member?.pendingRole ?? 'observer', world.state.team.policy), device, invite: { sig }, sealKey: { publicKey: sealKey }, ...overrides
  };
  return signed(actor, { ...next(world), type: 'member.joined', body });
}

test('a join with the code of another invitation fails the proof, and so does a proof copied to another device', async () => {
  const world = await worldWith();
  const one = invite(world);
  const two = invite(world, { emailHashes: [emailHash(world.teamId, 'eli@example.invalid')] });
  const device = await joiner(world, one);
  rejectedWith(put(world, device, joinEvent(world, one, device, {}, two.code.bytes), INVITE_TIME + 60), TEAM_REJECTION_REASONS.inviteProof);

  const first = await joiner(world, one);
  const second = await joiner(world, one);
  const sealKey = x25519PublicKey();
  const firstDevice = { fingerprint: first.identity.fingerprint, publicKey: first.identity.publicKey };
  const copied = deriveInviteKey(one.code.bytes, world.teamId, one.memberId).sign(joinProofBytes(world.teamId, one.memberId, one.inviteEventId, firstDevice, sealKey));
  const member = world.state.members.get(one.memberId);
  const replay = signed(second, {
    ...next(world), type: 'member.joined',
    body: { memberId: one.memberId, name: 'Dana Developer', emailHashes: [...(member?.emailHashes ?? [])], role: 'observer', device: { fingerprint: second.identity.fingerprint, publicKey: second.identity.publicKey }, invite: { sig: copied }, sealKey: { publicKey: sealKey } }
  });
  rejectedWith(put(world, second, replay, INVITE_TIME + 60), TEAM_REJECTION_REASONS.inviteProof);
  const { invite: _proof, ...bare } = replay.body;
  rejectedWith(put(world, second, signed(second, { ...next(world), type: 'member.joined', body: bare }), INVITE_TIME + 60), TEAM_REJECTION_REASONS.inviteProof);
});

test('a code is single use: a second join for the same member and a join for a cancelled invitation are refused', async () => {
  const world = await worldWith();
  const used = invite(world);
  const first = await joiner(world, used);
  accepted(put(world, first, joinEvent(world, used, first), INVITE_TIME + 60));
  const second = await joiner(world, used);
  rejectedWith(put(world, second, joinEvent(world, used, second), INVITE_TIME + 61), TEAM_REJECTION_REASONS.notInvited);

  const cancelled = invite(world, { emailHashes: [emailHash(world.teamId, 'cal@example.invalid')] });
  accepted(put(world, world.owner, signed(world.owner, { ...next(world), type: 'member.removed', body: { memberId: cancelled.memberId } }), INVITE_TIME + 10));
  const late = await joiner(world, cancelled);
  rejectedWith(put(world, late, joinEvent(world, cancelled, late), INVITE_TIME + 62), TEAM_REJECTION_REASONS.notInvited);
});

test('a join may not claim other email hashes, and the joined role follows the invited role and the confirmation policy', async () => {
  const world = await worldWith();
  const dev = invite(world);
  const who = await joiner(world, dev);
  rejectedWith(put(world, who, joinEvent(world, dev, who, { emailHashes: [emailHash(world.teamId, 'someone@example.invalid')] }), INVITE_TIME + 5), TEAM_REJECTION_REASONS.inviteEmail);
  rejectedWith(put(world, who, joinEvent(world, dev, who, { role: 'developer' }), INVITE_TIME + 5), TEAM_REJECTION_REASONS.inviteRole);
  rejectedWith(put(world, who, joinEvent(world, dev, who, { role: 'lead' }), INVITE_TIME + 5), TEAM_REJECTION_REASONS.inviteRole);
  accepted(put(world, who, joinEvent(world, dev, who), INVITE_TIME + 5));
  const joined = world.state.members.get(dev.memberId);
  assert.equal(joined?.role, 'observer', 'a developer invitation joins as observer under the default policy');
  assert.equal(joined?.pendingRole, 'developer');

  const watcher = invite(world, { role: 'observer', emailHashes: [emailHash(world.teamId, 'obs@example.invalid')] });
  const watching = await joiner(world, watcher);
  accepted(put(world, watching, joinEvent(world, watcher, watching), INVITE_TIME + 6));
  assert.equal(world.state.members.get(watcher.memberId)?.role, 'observer');
  assert.equal(world.state.members.get(watcher.memberId)?.pendingRole, undefined, 'an observer invitation needs no confirmation');

  accepted(put(world, world.owner, signed(world.owner, { ...next(world), type: 'policy.changed', body: { changes: { requireLeadConfirmation: false } } }), INVITE_TIME + 7));
  const direct = invite(world, { emailHashes: [emailHash(world.teamId, 'direct@example.invalid')] });
  const directly = await joiner(world, direct);
  rejectedWith(put(world, directly, joinEvent(world, direct, directly, { role: 'observer' }), INVITE_TIME + 8), TEAM_REJECTION_REASONS.inviteRole);
  accepted(put(world, directly, joinEvent(world, direct, directly), INVITE_TIME + 8));
  assert.equal(world.state.members.get(direct.memberId)?.role, 'developer', 'without confirmation the invited role is taken at once');
  assert.equal(world.state.members.get(direct.memberId)?.pendingRole, undefined);
});

test('the expiry rule is invite commit time plus ttl plus 300 seconds, and an unknown commit time skips it', async () => {
  assert.equal(INVITE_SKEW_SECONDS, 300);
  assert.equal(inviteExpired(INVITE_TIME, TTL, INVITE_TIME + TTL + 300), false);
  assert.equal(inviteExpired(INVITE_TIME, TTL, INVITE_TIME + TTL + 301), true);
  assert.equal(inviteExpired(0, TTL, INVITE_TIME + TTL + 999_999), false);
  assert.equal(inviteExpired(INVITE_TIME, TTL, 0), false);

  const onTime = await worldWith();
  const a = invite(onTime);
  const aJoiner = await joiner(onTime, a);
  accepted(put(onTime, aJoiner, joinEvent(onTime, a, aJoiner), INVITE_TIME + TTL + 300));

  const late = await worldWith();
  const b = invite(late);
  const bJoiner = await joiner(late, b);
  rejectedWith(put(late, bJoiner, joinEvent(late, b, bJoiner), INVITE_TIME + TTL + 301), TEAM_REJECTION_REASONS.inviteExpired);

  const unknownJoin = await worldWith();
  const c = invite(unknownJoin);
  const cJoiner = await joiner(unknownJoin, c);
  accepted(put(unknownJoin, cJoiner, joinEvent(unknownJoin, c, cJoiner), 0));

  const unknownInvite = await worldWith();
  const d = invite(unknownInvite, {}, 0);
  const dJoiner = await joiner(unknownInvite, d);
  accepted(put(unknownInvite, dJoiner, joinEvent(unknownInvite, d, dJoiner), INVITE_TIME + TTL * 50));
});

test('invitation rules: one live invitation per email, only managers invite, ids are not reused, and an invited member cannot be changed before joining', async () => {
  const world = await worldWith();
  const ownerHash = emailHash(world.teamId, 'owner@example.invalid');
  const clash = signed(world.owner, { ...next(world), type: 'member.invited', body: inviteBodyFor(world.teamId, newMemberId(), generateInviteCode().bytes, { emailHashes: [ownerHash] }) });
  rejectedWith(put(world, world.owner, clash, INVITE_TIME), TEAM_REJECTION_REASONS.alreadyInvited);

  const pending = invite(world);
  const again = signed(world.owner, { ...next(world), type: 'member.invited', body: inviteBodyFor(world.teamId, newMemberId(), generateInviteCode().bytes) });
  rejectedWith(put(world, world.owner, again, INVITE_TIME), TEAM_REJECTION_REASONS.alreadyInvited);
  const reused = signed(world.owner, { ...next(world), type: 'member.invited', body: inviteBodyFor(world.teamId, pending.memberId, generateInviteCode().bytes, { emailHashes: [emailHash(world.teamId, 'new@example.invalid')] }) });
  rejectedWith(put(world, world.owner, reused, INVITE_TIME), TEAM_REJECTION_REASONS.memberTaken);

  const device = await joiner(world, pending);
  const device2 = await makeActor(world.teamId);
  const changes: Array<TeamEvent> = [
    signed(world.owner, { ...next(world), type: 'member.role-changed', body: { memberId: pending.memberId, role: 'developer' } }),
    signed(world.owner, { ...next(world), type: 'member.skills', body: { memberId: pending.memberId, skills: ['sql'] } }),
    signed(world.owner, { ...next(world), type: 'device.added', body: { memberId: pending.memberId, device: { fingerprint: device2.identity.fingerprint, publicKey: device2.identity.publicKey } } }),
    signed(world.owner, { ...next(world), type: 'device.revoked', body: { memberId: pending.memberId, fingerprint: device.identity.fingerprint } })
  ];
  for (const change of changes) rejectedWith(put(world, world.owner, change, INVITE_TIME + 1), TEAM_REJECTION_REASONS.notJoined);

  // After the join and a confirmation, a developer exists and cannot invite.
  accepted(put(world, device, joinEvent(world, pending, device), INVITE_TIME + 2));
  accepted(put(world, world.owner, signed(world.owner, { ...next(world), type: 'member.role-changed', body: { memberId: pending.memberId, role: 'developer' } }), INVITE_TIME + 3));
  const confirmed = world.state.members.get(pending.memberId);
  assert.equal(confirmed?.role, 'developer');
  assert.equal(confirmed?.pendingRole, undefined, 'confirming clears the pending role');
  const byDeveloper = signed(device, { ...next(world), type: 'member.invited', body: inviteBodyFor(world.teamId, newMemberId(), generateInviteCode().bytes, { emailHashes: [emailHash(world.teamId, 'x@example.invalid')] }) });
  const verdict = put(world, device, byDeveloper, INVITE_TIME + 4);
  assert.equal(verdict.accepted, false);
  if (!verdict.accepted) assert.equal(verdict.rejection.reason.startsWith(`${TEAM_REJECTION_REASONS.notPermitted}: `), true);
});

test('cancelling an invitation keeps the email free for a new one and shows the invitation as cancelled, used or pending', async () => {
  const world = await worldWith();
  const old = invite(world);
  assert.equal(invitationStatus(world.state.members.get(old.memberId) as never, INVITE_TIME + 10), 'pending');
  assert.equal(invitationStatus(world.state.members.get(old.memberId) as never, INVITE_TIME + TTL + 1), 'expired');
  accepted(put(world, world.owner, signed(world.owner, { ...next(world), type: 'member.removed', body: { memberId: old.memberId } }), INVITE_TIME + 20));
  assert.equal(invitationStatus(world.state.members.get(old.memberId) as never, INVITE_TIME + 30), 'cancelled');
  const fresh = invite(world);
  const who = await joiner(world, fresh);
  accepted(put(world, who, joinEvent(world, fresh, who), INVITE_TIME + 40));
  assert.equal(invitationStatus(world.state.members.get(fresh.memberId) as never, INVITE_TIME + 50), 'used');
  assert.equal(invitationStatus(world.state.members.get(world.owner.memberId) as never, INVITE_TIME + 50), undefined, 'the owner was never invited');
});

test('a state with an invited member survives a snapshot round trip, and a team without invitations hashes as it did in Phase 60', async () => {
  const world = await worldWith();
  const before = stateHash(world.state);
  assert.equal(serialiseState(world.state).includes('invite'), false, 'no invitation keys appear when there are none');
  const anchor = world.state.genesis;
  const pending = invite(world);
  assert.notEqual(stateHash(world.state), before);
  const restored = deserialiseState(JSON.parse(serialiseState(world.state)) as JsonObject, anchor);
  assert.equal(serialiseState(restored), serialiseState(world.state));
  assert.equal(restored.members.get(pending.memberId)?.status, 'invited');
  const who = await joiner(world, pending);
  accepted(put(world, who, joinEvent(world, pending, who), INVITE_TIME + 5));
  const joinedAgain = deserialiseState(JSON.parse(serialiseState(world.state)) as JsonObject, anchor);
  assert.equal(serialiseState(joinedAgain), serialiseState(world.state));
  assert.equal(joinedAgain.members.get(pending.memberId)?.devices.length, 1);
});

test('the new body keys are never taken for secrets, whatever random key material they hold', () => {
  for (let index = 0; index < 1000; index += 1) {
    const key = x25519PublicKey();
    const sig = deriveInviteKey(generateInviteCode().bytes, newTeamId(), newMemberId()).sign(Buffer.from(key));
    assertNoSecrets({ memberId: newMemberId(), invite: { publicKey: key } }, 'member.invited event');
    assertNoSecrets({ invite: { sig }, sealKey: { publicKey: key } }, 'member.joined event');
  }
});

// ---- Join rules over real git ----------------------------------------------------------------------------------------------------------

test('expiry is also checked on write: a stale join is refused with the read-side reason and the remote does not change', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const { teamId, anchor, a } = await seedTeam(fixture);
    const memberId = newMemberId();
    const code = generateInviteCode();
    assert.equal((await a.log.append(() => [{ type: 'member.invited', body: inviteBodyFor(teamId, memberId, code.bytes, { ttlSeconds: 3600 }) }])).ok, true);
    const identity = await createDeviceIdentity(new MemorySecrets(), teamId);
    const headBefore = gitIn(fixture.remote, ['rev-parse', DEFAULT_COORDINATION_REF]);

    const tooLate = clientFor(fixture, 'b', anchor, undefined, () => (Math.floor(Date.now() / 1000) + 3600 + INVITE_SKEW_SECONDS + 60) * 1000);
    await tooLate.log.sync();
    const refused = await tooLate.log.appendJoin(identity, (state) => joinBodyFor(state, teamId, memberId, code.bytes, identity, x25519PublicKey()));
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, TEAM_REJECTION_REASONS.inviteExpired);
    assert.equal(gitIn(fixture.remote, ['rev-parse', DEFAULT_COORDINATION_REF]), headBefore);

    const inTime = clientFor(fixture, 'b', anchor, undefined, () => (Math.floor(Date.now() / 1000) + 3600) * 1000);
    await inTime.log.sync();
    const accepted = await inTime.log.appendJoin(identity, (state) => joinBodyFor(state, teamId, memberId, code.bytes, identity, x25519PublicKey()));
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.reason);
  });
});

test('re-issue is one batch: the old code stops working, the new one joins, and the same email is allowed again', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const { teamId, anchor, a } = await seedTeam(fixture);
    const oldId = newMemberId();
    const oldCode = generateInviteCode();
    assert.equal((await a.log.append(() => [{ type: 'member.invited', body: inviteBodyFor(teamId, oldId, oldCode.bytes) }])).ok, true);
    const newId = newMemberId();
    const newCode = generateInviteCode();
    const batch = await a.log.append(() => [
      { type: 'member.removed', body: { memberId: oldId } },
      { type: 'member.invited', body: inviteBodyFor(teamId, newId, newCode.bytes) }
    ]);
    assert.equal(batch.ok, true, batch.ok ? '' : batch.reason);

    const b = clientFor(fixture, 'b', anchor);
    await b.log.sync();
    const stale = await createDeviceIdentity(new MemorySecrets(), teamId);
    const refused = await b.log.appendJoin(stale, (state) => joinBodyFor(state, teamId, oldId, oldCode.bytes, stale, x25519PublicKey()));
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, TEAM_REJECTION_REASONS.notInvited);
    const fresh = await createDeviceIdentity(new MemorySecrets(), teamId);
    const joined = await b.log.appendJoin(fresh, (state) => joinBodyFor(state, teamId, newId, newCode.bytes, fresh, x25519PublicKey()));
    assert.equal(joined.ok, true, joined.ok ? '' : joined.reason);
    assert.equal(b.log.state().members.get(newId)?.devices.length, 1);
  });
});

test('two devices racing the same code produce exactly one accepted join, and the loser is told the invitation is used', async () => {
  await withFixture(['a', 'b', 'c'], async (fixture) => {
    const { teamId, anchor, a } = await seedTeam(fixture);
    const memberId = newMemberId();
    const code = generateInviteCode();
    assert.equal((await a.log.append(() => [{ type: 'member.invited', body: inviteBodyFor(teamId, memberId, code.bytes) }])).ok, true);
    const b = clientFor(fixture, 'b', anchor);
    const c = clientFor(fixture, 'c', anchor);
    await Promise.all([b.log.sync(), c.log.sync()]);
    const idB = await createDeviceIdentity(new MemorySecrets(), teamId);
    const idC = await createDeviceIdentity(new MemorySecrets(), teamId);
    const results = await Promise.all([
      b.log.appendJoin(idB, (state) => joinBodyFor(state, teamId, memberId, code.bytes, idB, x25519PublicKey())),
      c.log.appendJoin(idC, (state) => joinBodyFor(state, teamId, memberId, code.bytes, idC, x25519PublicKey()))
    ]);
    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    const loser = losers[0];
    if (loser !== undefined && !loser.ok) assert.equal(loser.reason, TEAM_REJECTION_REASONS.notInvited);
    await a.log.sync();
    const joinedEvents = [...a.log.state().seenEventIds].length;
    assert.equal(a.log.state().members.get(memberId)?.devices.length, 1);
    assert.equal(joinedEvents, 4, 'team.created, owner join, invite and exactly one join');
  });
});
