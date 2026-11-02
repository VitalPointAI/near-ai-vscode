// Sealed key delivery in the signed log (Phase 61 plan 05): a lead seals a freshly created NEAR key to a joined member's device and appends
// member.key-sealed over real git; the member's clone opens it with the X25519 key kept in SecretStorage. Canary keys are built at run time.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';
import { expectedJoinRole, joinProofBytes } from '../domain/team/invite';
import { teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import { assertNoSecrets } from '../domain/team/secrets';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { GenesisAnchor, MemberInvitedBody, MemberJoinedBody, MemberKeySealedBody, Role, TeamEvent, TeamFile, TeamState } from '../domain/team/types';
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
