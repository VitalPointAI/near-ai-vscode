// Removing a member and cancelling an invitation (Phase 61 plan 11, TEAM-03): the order of the NEAR steps and the log removal, what a NEAR
// failure leaves on the cleanup list, retries, a lead leaving the organization, cancel, idempotency and racing removals, all over real git
// and the fake NEAR server. Keys are made by the fake at run time; nothing here is a literal secret.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';
import { expectedJoinRole, joinProofBytes } from '../domain/team/invite';
import { teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { GenesisAnchor, MemberInvitedBody, MemberJoinedBody, MemberKeySealedBody, Role, TeamFile, TeamState } from '../domain/team/types';
import type { FetchLike } from '../services/reportingSignIn';
import { CleanupChecklist, repoAccessText } from '../team/cleanupChecklist';
import type { CleanupItem } from '../team/cleanupChecklist';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { createDeviceIdentity, createSealIdentity, emailHash, newMemberId, newTeamId } from '../team/identity';
import type { DeviceIdentity, SealIdentity } from '../team/identity';
import { deriveInviteKey, generateInviteCode } from '../team/inviteCode';
import { SEAL_SCHEME, sealTo } from '../team/keySeal';
import { NearOrgClient } from '../team/nearOrg';
import type { NearAuth } from '../team/nearOrg';
import { KEY_STILL_SPENDS_WARNING, removeMember, retryCleanupItem } from '../team/remove';
import { canonicalTeamFile } from '../team/teamFile';
import { startFakeNear } from './helpers/fakeNear';
import type { FakeNear, FakeRequest } from './helpers/fakeNear';
import { MemorySecrets, createOwner, createTeamFixture } from './helpers/teamHarness';
import type { TeamFixture } from './helpers/teamHarness';

const GIGA = 1_000_000_000;
const NEAR_LINK = { organizationId: 'org-1', workspaceId: 'ws-1' };
const fixedNow = (): Date => new Date('2026-02-03T04:05:06.000Z');
const noSleep = async (): Promise<void> => undefined;

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

function staticAuth(token: string): NearAuth {
  return { accessToken: async () => token, refreshAfterUnauthorized: async () => undefined };
}

// A person who joined from their own clone: device key, X25519 seal key, and a client that signs as them.
interface Person { memberId: string; name: string; email: string; clone: string; identity: DeviceIdentity; seal: SealIdentity; secrets: MemorySecrets; client: Client }

interface World {
  fixture: TeamFixture;
  fake: FakeNear;
  teamId: string;
  teamFile: TeamFile;
  anchor: GenesisAnchor;
  a: Client;
  ownerMemberId: string;
  org: NearOrgClient;
  checklist: CleanupChecklist;
  /** Every request the lead's NEAR client sent, with whether the member had already been removed in the lead's log at that moment. */
  seen: Array<{ method: string; path: string; removedInLog: boolean }>;
  watch: { memberId?: string };
}

interface WorldOptions { membersIncludeEmail?: boolean }

async function startWorld(fixture: TeamFixture, options: WorldOptions = {}): Promise<World> {
  const fake = await startFakeNear(options.membersIncludeEmail === undefined ? {} : { membersIncludeEmail: options.membersIncludeEmail });
  const lead = fake.addUser({ id: 'user-owner', username: 'owner', email: 'owner@example.invalid' });
  fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-owner', role: 'owner' }] });
  fake.addWorkspace({ id: 'ws-1', organizationId: 'org-1', name: 'Team workspace' });
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const genesis = buildGenesisEvents({
    teamId, teamName: 'Removal team', owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [emailHash(teamId, 'owner@example.invalid')] },
    identity: owner.identity, policy: defaultTeamPolicy(), near: NEAR_LINK, now: fixedNow
  });
  const teamFile: TeamFile = {
    version: 1, teamId, name: 'Removal team', coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: genesis.anchor.eventId, ownerDevice: genesis.anchor.ownerDevice }, near: NEAR_LINK, createdAt: '2026-02-03T04:05:06.000Z'
  };
  const a = clientFor(fixture, 'a', genesis.anchor, { identity: owner.identity, memberId: owner.memberId });
  const written = await a.transport.append(async () => genesis.events, { genesis: { teamFileText: canonicalTeamFile(teamFile) } });
  assert.equal(written.ok, true);

  const seen: World['seen'] = [];
  const watch: World['watch'] = {};
  // Wraps the real fetch so each NEAR call is stamped with whether the lead's own log already shows the removal.
  const spy: FetchLike = (url, init) => {
    const removedInLog = watch.memberId !== undefined && a.log.state().members.get(watch.memberId)?.removedEvent !== undefined;
    seen.push({ method: init.method, path: new URL(url).pathname, removedInLog });
    return (fetch as unknown as FetchLike)(url, init);
  };
  const org = new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(lead.accessToken), sleep: noSleep, fetch: spy });
  return { fixture, fake, teamId, teamFile, anchor: genesis.anchor, a, ownerMemberId: owner.memberId, org, checklist: new CleanupChecklist(path.join(fixture.root, 'cleanup-a')), seen, watch };
}

async function inWorld(names: string[], options: WorldOptions, run: (world: World) => Promise<void>): Promise<void> {
  const fixture = await createTeamFixture({ clones: names });
  let world: World | undefined;
  try {
    world = await startWorld(fixture, options);
    await run(world);
  } finally {
    await world?.fake.close();
    await fixture.cleanup();
  }
}

function inviteBody(w: World, memberId: string, name: string, email: string, role: MemberInvitedBody['role'], codeBytes: Buffer): MemberInvitedBody {
  return {
    memberId, name, emailHashes: [emailHash(w.teamId, email)], role, allocationNanoUsd: 5 * GIGA,
    ttlSeconds: 604_800, invite: { publicKey: deriveInviteKey(codeBytes, w.teamId, memberId).publicKey }
  };
}

function joinBody(state: TeamState, teamId: string, memberId: string, codeBytes: Buffer, identity: DeviceIdentity, sealKey: string): MemberJoinedBody | { conflict: string } {
  const member = state.members.get(memberId);
  if (member === undefined || member.invite === undefined) return { conflict: TEAM_REJECTION_REASONS.notInvited };
  const device = { fingerprint: identity.fingerprint, publicKey: identity.publicKey };
  const role: Role = expectedJoinRole(member.pendingRole ?? 'observer', state.team.policy);
  const sig = deriveInviteKey(codeBytes, teamId, memberId).sign(joinProofBytes(teamId, memberId, member.invite.eventId, device, sealKey));
  return { memberId, name: member.name, emailHashes: [...member.emailHashes], role, device, invite: { sig }, sealKey: { publicKey: sealKey } };
}

// The owner invites. Returns the member id and the code so the person can join (or not, for a cancelled invitation).
async function invite(w: World, name: string, email: string, role: MemberInvitedBody['role']): Promise<{ memberId: string; codeBytes: Buffer }> {
  const memberId = newMemberId();
  const code = generateInviteCode();
  const result = await w.a.log.append(() => [{ type: 'member.invited', body: inviteBody(w, memberId, name, email, role, code.bytes) }]);
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  return { memberId, codeBytes: code.bytes };
}

// Invited, joined from `clone`, and confirmed by the owner (member.role-changed to the invited role).
async function addMember(w: World, clone: string, name: string, email: string, role: MemberInvitedBody['role'] = 'developer'): Promise<Person> {
  const { memberId, codeBytes } = await invite(w, name, email, role);
  const secrets = new MemorySecrets();
  const identity = await createDeviceIdentity(secrets, w.teamId);
  const seal = await createSealIdentity(secrets, w.teamId);
  const client = clientFor(w.fixture, clone, w.anchor, { identity, memberId });
  await client.log.sync();
  const joined = await client.log.appendJoin(identity, (state) => joinBody(state, w.teamId, memberId, codeBytes, identity, seal.publicKey));
  assert.equal(joined.ok, true, joined.ok ? '' : joined.reason);
  await w.a.log.sync();
  const confirmed = await w.a.log.append(() => [{ type: 'member.role-changed', body: { memberId, role } }]);
  assert.equal(confirmed.ok, true, confirmed.ok ? '' : confirmed.reason);
  await client.log.sync();
  return { memberId, name, email, clone, identity, seal, secrets, client };
}

// A key made in the team workspace for this person and sealed to their one device, recorded with member.key-sealed (as a confirmation does).
async function giveKey(w: World, person: Person): Promise<string> {
  const created = await w.org.createKey('ws-1', `key-${randomBytes(4).toString('hex')}`, 5 * GIGA);
  const keyId = created.key.id;
  const entry = sealTo(created.secret, person.seal.publicKey, { teamId: w.teamId, memberId: person.memberId, device: person.identity.fingerprint, keyId });
  created.secret.fill(0);
  const body: MemberKeySealedBody = { memberId: person.memberId, keyId, scheme: SEAL_SCHEME, sealed: [entry] };
  const sealed = await w.a.log.append(() => [{ type: 'member.key-sealed', body }]);
  assert.equal(sealed.ok, true, sealed.ok ? '' : sealed.reason);
  return keyId;
}

function removeArgs(w: World, memberId: string, extra: { org?: NearOrgClient | null } = {}): Parameters<typeof removeMember>[0] {
  const org = extra.org === undefined ? w.org : extra.org ?? undefined;
  return { log: w.a.log, teamFile: w.teamFile, memberId, checklist: w.checklist, ...(org === undefined ? {} : { org }) };
}

const indexOf = (requests: FakeRequest[], method: string, includes: string): number => requests.findIndex((request) => request.method === method && request.path.includes(includes));

test('tracer: the owner removes a confirmed developer; NEAR sees limit 0, then the log removal, then the revoke', async () => {
  await inWorld(['a', 'b'], {}, async (w) => {
    const dana = await addMember(w, 'b', 'Dana Developer', 'dana@example.invalid');
    const keyId = await giveKey(w, dana);
    w.watch.memberId = dana.memberId;
    w.seen.length = 0;
    const before = w.fake.requests.length;

    const result = await removeMember(removeArgs(w, dana.memberId));
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(result.kind, 'removed');
    assert.equal(result.keyStillSpends, false);

    // The key was capped first, the log removal came next, and only then was the key revoked.
    const spendLimitCall = w.seen.find((call) => call.method === 'PATCH' && call.path.endsWith('/spend-limit'));
    const revokeCall = w.seen.find((call) => call.method === 'DELETE' && call.path.endsWith(`/api-keys/${keyId}`));
    assert.ok(spendLimitCall !== undefined && revokeCall !== undefined, 'both NEAR calls were made');
    assert.equal(spendLimitCall.removedInLog, false, 'the key was capped before the removal was written');
    assert.equal(revokeCall.removedInLog, true, 'the key was revoked after the removal was written');
    const sent = w.fake.requests.slice(before);
    const zeroAt = indexOf(sent, 'PATCH', `/api-keys/${keyId}/spend-limit`);
    const revokeAt = indexOf(sent, 'DELETE', `/api-keys/${keyId}`);
    assert.ok(zeroAt >= 0 && revokeAt >= 0 && zeroAt < revokeAt, 'the spend-limit PATCH precedes the key DELETE');
    assert.deepEqual(w.fake.key(keyId)?.spendLimitNanoUsd, 0);
    assert.equal(w.fake.key(keyId)?.revoked, true);

    // Dana's own clone syncs the removal and can no longer write.
    await dana.client.log.sync();
    assert.notEqual(dana.client.log.state().members.get(dana.memberId)?.removedEvent, undefined);
    const attempt = await dana.client.log.append(() => [{ type: 'member.availability', body: { availability: 'focus' } }]);
    assert.equal(attempt.ok, false);
    if (!attempt.ok) assert.match(attempt.reason, /removed/, attempt.reason);

    // The only thing left for the lead is the reminder about repository access, last.
    const items = await w.checklist.forMember(dana.memberId);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.step, 'repo-access');
    assert.equal(items[0]?.status, 'manual');
    assert.deepEqual(result.checklist.map((item) => item.step), ['repo-access']);
    assert.equal(repoAccessText('Dana Developer').startsWith('Remove Dana Developer'), true);
    assert.ok(result.message.includes('Dana Developer'));
  });
});
