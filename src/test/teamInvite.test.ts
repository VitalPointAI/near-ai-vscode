// Invite and join on the signed log (Phase 61 plan 01): the single-use code, the invite-gated member.joined from a second clone over real git,
// and the guarantee that the clear-text code never reaches the coordination branch. Canary codes are built at run time, never as literals.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';
import { verifySignature } from '../domain/team/canonical';
import { joinProofBytes } from '../domain/team/invite';
import { serialiseState, teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import { expectedJoinRole } from '../domain/team/invite';
import type { GenesisAnchor, MemberInvitedBody, MemberJoinedBody, Role, TeamFile, TeamState } from '../domain/team/types';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { INVITE_CODE_BYTES, deriveInviteKey, formatInviteCode, generateInviteCode, inviteKeyMatches, parseInviteCode } from '../team/inviteCode';
import { createDeviceIdentity, emailHash, newMemberId, newTeamId } from '../team/identity';
import type { DeviceIdentity } from '../team/identity';
import { canonicalTeamFile } from '../team/teamFile';
import { MemorySecrets, createOwner, createTeamFixture } from './helpers/teamHarness';
import type { TeamFixture, TestOwner } from './helpers/teamHarness';

const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{32}$/;
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
  if (member === undefined || member.invite === undefined) return { conflict: 'not invited' };
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
