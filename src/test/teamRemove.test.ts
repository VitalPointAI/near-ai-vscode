// Removing a member and cancelling an invitation (Phase 61 plan 11, TEAM-03): the order of the NEAR steps and the log removal, what a NEAR
// failure leaves on the cleanup list, retries, a lead leaving the organization, cancel, idempotency and racing removals, all over real git
// and the fake NEAR server. Keys are made by the fake at run time; nothing here is a literal secret.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { expectedJoinRole, joinProofBytes } from '../domain/team/invite';
import { teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { GenesisAnchor, MemberInvitedBody, MemberJoinedBody, MemberKeySealedBody, Role, TeamFile, TeamState } from '../domain/team/types';
import { AuthService } from '../services/auth';
import { ProfileStore } from '../services/profileStore';
import type { FetchLike } from '../services/reportingSignIn';
import { CleanupChecklist, repoAccessText } from '../team/cleanupChecklist';
import type { CleanupItem } from '../team/cleanupChecklist';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { createDeviceIdentity, createSealIdentity, deviceKeySecretName, emailHash, newMemberId, newTeamId, sealKeySecretName } from '../team/identity';
import type { DeviceIdentity, SealIdentity } from '../team/identity';
import { deriveInviteKey, generateInviteCode } from '../team/inviteCode';
import { SEAL_SCHEME, sealTo } from '../team/keySeal';
import { NearOrgClient } from '../team/nearOrg';
import type { NearAuth } from '../team/nearOrg';
import { nearSessionSecretName, saveNearSession } from '../team/nearSession';
import { recordInvite, retryNearInvitation } from '../team/invite';
import { KEY_STILL_SPENDS_WARNING, removeMember, retryCleanupItem } from '../team/remove';
import { REMOVED_FILE, handleOwnRemoval, readRemovedMarker, removedText } from '../team/removedClient';
import { canonicalTeamFile, checkNearPin, teamStorageDir } from '../team/teamFile';
import { installTeamKey, readInstalledKey, teamProfileId } from '../team/teamKeyProfile';
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

interface WorldOptions { membersIncludeEmail?: boolean; ownerNearEmail?: string }

async function startWorld(fixture: TeamFixture, options: WorldOptions = {}): Promise<World> {
  const fake = await startFakeNear(options.membersIncludeEmail === undefined ? {} : { membersIncludeEmail: options.membersIncludeEmail });
  const lead = fake.addUser({ id: 'user-owner', username: 'owner', email: options.ownerNearEmail ?? 'owner@example.invalid' });
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
async function addMember(w: World, clone: string, name: string, email: string, role: MemberInvitedBody['role'] = 'developer', confirm = true): Promise<Person> {
  const { memberId, codeBytes } = await invite(w, name, email, role);
  const secrets = new MemorySecrets();
  const identity = await createDeviceIdentity(secrets, w.teamId);
  const seal = await createSealIdentity(secrets, w.teamId);
  const client = clientFor(w.fixture, clone, w.anchor, { identity, memberId });
  await client.log.sync();
  const joined = await client.log.appendJoin(identity, (state) => joinBody(state, w.teamId, memberId, codeBytes, identity, seal.publicKey));
  assert.equal(joined.ok, true, joined.ok ? '' : joined.reason);
  await w.a.log.sync();
  if (confirm) {
    const confirmed = await w.a.log.append(() => [{ type: 'member.role-changed', body: { memberId, role } }]);
    assert.equal(confirmed.ok, true, confirmed.ok ? '' : confirmed.reason);
  }
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

// ---- helpers for the failure, retry, organization, cancel and race tests -------------------------------------------------------------

const stepsOf = (items: CleanupItem[]): string[] => items.map((item) => `${item.step}:${item.status}`);
const requestsSince = (w: World, before: number): FakeRequest[] => w.fake.requests.slice(before);
const deletesOf = (requests: FakeRequest[], includes: string): FakeRequest[] => requests.filter((request) => request.method === 'DELETE' && request.path.includes(includes));

// The NEAR organization as it is after the people named here accepted (the owner stays the first owner).
function setOrgMembers(w: World, others: Array<{ userId: string; role: 'owner' | 'admin' | 'member' }>): void {
  w.fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-owner', role: 'owner' }, ...others] });
}

function addNearUser(w: World, id: string, email: string): void {
  w.fake.addUser({ id, username: id, email });
}

function failSpendLimit(w: World, keyId: string, times: number): void {
  w.fake.fail({ method: 'PATCH', pathPrefix: `/v1/workspaces/ws-1/api-keys/${keyId}/spend-limit`, status: 500, times });
}

// Three more tries than a request is retried, so one rule outlasts one removal and is spent by the time a retry runs.
const ONE_CALL = 4;

async function eventsOfType(client: Client, type: string): Promise<number> {
  let count = 0;
  for (const entry of await client.transport.readAll()) if (entry.text.includes(`"type":"${type}"`)) count += 1;
  return count;
}

// ---- Task 2: failures, retries, organization removal, cancel, idempotency and races -----------------------------------------------

test('a key that cannot be capped still lets the log removal through, is never revoked, and warns that it can still spend', async () => {
  await inWorld(['a', 'b'], {}, async (w) => {
    const dana = await addMember(w, 'b', 'Dana Developer', 'dana@example.invalid');
    const keyId = await giveKey(w, dana);
    failSpendLimit(w, keyId, ONE_CALL);
    const before = w.fake.requests.length;
    const result = await removeMember(removeArgs(w, dana.memberId));
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(result.keyStillSpends, true);
    assert.ok(result.message.includes(KEY_STILL_SPENDS_WARNING.replace('<name>', 'Dana Developer')), result.message);
    assert.notEqual(w.a.log.state().members.get(dana.memberId)?.removedEvent, undefined, 'the log removal was written');
    assert.deepEqual(deletesOf(requestsSince(w, before), `/api-keys/${keyId}`), [], 'no revoke is sent for a key that was not capped');
    assert.equal(w.fake.key(keyId)?.revoked, false);
    assert.equal(w.fake.key(keyId)?.spendLimitNanoUsd, 5 * GIGA, 'the key is still capped at its allocation, not at 0');
    assert.deepEqual(stepsOf(result.checklist), ['zero-limit:failed', 'revoke-key:pending', 'repo-access:manual']);
    assert.deepEqual(result.checklist.map((item) => item.keyId), [keyId, keyId, undefined]);
  });
});

// CR-01: the workspace a removal caps and revokes in comes from team.json, which any committer can edit. The member being removed changes
// near.workspaceId to another workspace the lead can read; the removal must not report the real key as capped and revoked.
test('CR-01: a team.json whose NEAR workspace differs from the one this computer pinned caps and revokes nothing there and warns that the key can still spend', async () => {
  await inWorld(['a', 'b'], {}, async (w) => {
    w.fake.addWorkspace({ id: 'ws-2', organizationId: 'org-1', name: 'Decoy workspace' });
    const dana = await addMember(w, 'b', 'Dana Developer', 'dana@example.invalid');
    const keyId = await giveKey(w, dana);
    // The lead's computer has trusted the real link (as linking, joining or a first read does).
    assert.deepEqual(await checkNearPin(w.checklist.storageDir, w.teamFile), NEAR_LINK);
    const forged: TeamFile = { ...w.teamFile, near: { organizationId: 'org-1', workspaceId: 'ws-2' } };
    const before = w.fake.requests.length;
    const result = await removeMember({ ...removeArgs(w, dana.memberId), teamFile: forged });
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.notEqual(w.a.log.state().members.get(dana.memberId)?.removedEvent, undefined, 'the log removal is still written');
    assert.equal(result.keyStillSpends, true, 'a key that was not capped in the pinned workspace is reported as able to spend');
    assert.ok(result.message.includes(KEY_STILL_SPENDS_WARNING.replace('<name>', 'Dana Developer')), result.message);
    assert.doesNotMatch(result.message, /capped at 0 and revoked/);
    assert.deepEqual(requestsSince(w, before).filter((request) => request.path.includes('/workspaces/')), [], 'no key call went to any workspace');
    assert.equal(w.fake.key(keyId)?.spendLimitNanoUsd, 5 * GIGA);
    assert.equal(w.fake.key(keyId)?.revoked, false);
    assert.deepEqual(stepsOf(result.checklist), ['zero-limit:manual', 'revoke-key:pending', 'repo-access:manual']);
    assert.match(result.checklist[0]?.lastError ?? '', /different NEAR organization or workspace/);

    // A retry with the forged file is refused the same way; with the pinned file it caps and revokes the real key.
    const zero = result.checklist[0] as CleanupItem;
    const refused = await retryCleanupItem({ item: zero, teamFile: forged, log: w.a.log, org: w.org, checklist: w.checklist });
    assert.equal(refused.status, 'manual');
    assert.equal(w.fake.key(keyId)?.spendLimitNanoUsd, 5 * GIGA);
    const capped = await retryCleanupItem({ item: zero, teamFile: w.teamFile, log: w.a.log, org: w.org, checklist: w.checklist });
    assert.equal(capped.status, 'done');
    assert.equal(w.fake.key(keyId)?.spendLimitNanoUsd, 0);
  });
});

test('CR-01: a key the linked workspace does not list is a manual item for the NEAR console, never a finished cap or revoke', async () => {
  await inWorld(['a', 'b'], {}, async (w) => {
    w.fake.addWorkspace({ id: 'ws-2', organizationId: 'org-1', name: 'Decoy workspace' });
    const dana = await addMember(w, 'b', 'Dana Developer', 'dana@example.invalid');
    const keyId = await giveKey(w, dana);
    // This computer never saw a link before, so the forged one is the first it trusts: the pin cannot help, the key lookup must.
    const fresh = new CleanupChecklist(path.join(w.fixture.root, 'cleanup-fresh'));
    const forged: TeamFile = { ...w.teamFile, near: { organizationId: 'org-1', workspaceId: 'ws-2' } };
    const result = await removeMember({ ...removeArgs(w, dana.memberId), teamFile: forged, checklist: fresh });
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(result.keyStillSpends, true);
    assert.ok(result.message.includes(KEY_STILL_SPENDS_WARNING.replace('<name>', 'Dana Developer')), result.message);
    assert.deepEqual(stepsOf(result.checklist), ['zero-limit:manual', 'revoke-key:pending', 'repo-access:manual']);
    assert.match(result.checklist[0]?.lastError ?? '', /NEAR console/);
    assert.equal(w.fake.key(keyId)?.spendLimitNanoUsd, 5 * GIGA);
    assert.equal(w.fake.key(keyId)?.revoked, false);
  });
});

test('a NEAR-linked team with no NEAR session still removes the member and queues the cap and the revoke as pending', async () => {
  await inWorld(['a', 'b'], {}, async (w) => {
    const dana = await addMember(w, 'b', 'Dana Developer', 'dana@example.invalid');
    const keyId = await giveKey(w, dana);
    const before = w.fake.requests.length;
    const result = await removeMember(removeArgs(w, dana.memberId, { org: null }));
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(result.keyStillSpends, true);
    assert.deepEqual(stepsOf(result.checklist), ['zero-limit:pending', 'revoke-key:pending', 'repo-access:manual']);
    assert.equal(result.checklist[0]?.keyId, keyId);
    assert.equal(requestsSince(w, before).length, 0, 'no NEAR request was sent');
    assert.ok(result.message.includes(KEY_STILL_SPENDS_WARNING.replace('<name>', 'Dana Developer')));
  });
});

test('retrying the cleanup items caps first, refuses a revoke before the cap, then revokes; a key NEAR no longer has is a manual item (CR-01)', async () => {
  await inWorld(['a', 'b'], {}, async (w) => {
    const dana = await addMember(w, 'b', 'Dana Developer', 'dana@example.invalid');
    const keyId = await giveKey(w, dana);
    failSpendLimit(w, keyId, ONE_CALL);
    const removed = await removeMember(removeArgs(w, dana.memberId));
    assert.equal(removed.ok, true);
    if (!removed.ok) return;
    const [zero, revoke] = removed.checklist;
    assert.ok(zero !== undefined && revoke !== undefined);
    const retryArgs = (item: CleanupItem): Parameters<typeof retryCleanupItem>[0] => ({ item, teamFile: w.teamFile, log: w.a.log, org: w.org, checklist: w.checklist });

    // The revoke is refused while the cap is not done, and nothing is sent.
    const before = w.fake.requests.length;
    const refused = await retryCleanupItem(retryArgs(revoke));
    assert.equal(refused.status, 'pending');
    assert.match(refused.lastError ?? '', /limit to 0 first/i);
    assert.deepEqual(deletesOf(requestsSince(w, before), '/api-keys/'), []);

    // The fault is spent: the cap goes through and the item is done.
    const capped = await retryCleanupItem(retryArgs(zero));
    assert.equal(capped.status, 'done');
    assert.equal(capped.lastError, undefined);
    assert.equal(w.fake.key(keyId)?.spendLimitNanoUsd, 0);
    assert.equal(w.fake.key(keyId)?.revoked, false);

    const revoked = await retryCleanupItem(retryArgs(revoke));
    assert.equal(revoked.status, 'done');
    assert.equal(w.fake.key(keyId)?.revoked, true);

    // A key that NEAR no longer lists is not counted as revoked (CR-01): the lead is asked to check it in the NEAR console.
    const erin = await addMember(w, 'b', 'Erin Engineer', 'erin@example.invalid');
    const erinKey = await giveKey(w, erin);
    w.fake.fail({ method: 'DELETE', pathPrefix: `/v1/workspaces/ws-1/api-keys/${erinKey}`, status: 500, times: ONE_CALL });
    const second = await removeMember(removeArgs(w, erin.memberId));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.keyStillSpends, false, 'the key is capped, only the revoke failed');
    assert.deepEqual(stepsOf(second.checklist), ['zero-limit:done', 'revoke-key:failed', 'repo-access:manual']);
    assert.equal(await w.org.revokeKey('ws-1', erinKey), 'revoked');
    const gone = await retryCleanupItem(retryArgs(second.checklist[1] as CleanupItem));
    assert.equal(gone.status, 'manual');
    assert.match(gone.lastError ?? '', /NEAR console/);
  });
});

test('a member whose key was replaced by a rotation has both keys capped and revoked, and an interrupted removal keeps finished and unfinished steps', async () => {
  await inWorld(['a', 'b'], {}, async (w) => {
    const dana = await addMember(w, 'b', 'Dana Developer', 'dana@example.invalid');
    const first = await giveKey(w, dana);
    const second = await giveKey(w, dana);
    const member = w.a.log.state().members.get(dana.memberId);
    assert.equal(member?.nearApiKeyId, second);
    assert.deepEqual(member?.retiredNearKeyIds, [first]);

    const result = await removeMember(removeArgs(w, dana.memberId));
    assert.equal(result.ok && result.keyStillSpends, false);
    for (const keyId of [first, second]) {
      assert.equal(w.fake.key(keyId)?.spendLimitNanoUsd, 0, `${keyId} is capped`);
      assert.equal(w.fake.key(keyId)?.revoked, true, `${keyId} is revoked`);
    }

    // The same again, but the newer key cannot be capped: the older key's finished steps stay on the list next to the unfinished ones.
    const erin = await addMember(w, 'b', 'Erin Engineer', 'erin@example.invalid');
    const one = await giveKey(w, erin);
    const two = await giveKey(w, erin);
    failSpendLimit(w, two, ONE_CALL);
    const partial = await removeMember(removeArgs(w, erin.memberId));
    assert.equal(partial.ok, true);
    if (!partial.ok) return;
    assert.equal(partial.keyStillSpends, true);
    assert.deepEqual(stepsOf(partial.checklist), ['zero-limit:failed', 'revoke-key:pending', 'zero-limit:done', 'revoke-key:done', 'repo-access:manual']);
    assert.deepEqual(partial.checklist.map((item) => item.keyId), [two, two, one, one, undefined]);
    assert.equal(w.fake.key(one)?.revoked, true);
    assert.equal(w.fake.key(two)?.revoked, false);
    const saved = await w.checklist.forMember(erin.memberId);
    assert.deepEqual(stepsOf(saved), stepsOf(partial.checklist), 'the same list is on disk');
  });
});

test('removing a confirmed lead also removes their NEAR organization membership, found by email hash and never by an id from the log', async () => {
  await inWorld(['a', 'b'], { membersIncludeEmail: true }, async (w) => {
    const lena = await addMember(w, 'b', 'Lena Lead', 'lena@example.invalid', 'lead');
    addNearUser(w, 'user-lena', 'lena@example.invalid');
    addNearUser(w, 'user-other', 'other@example.invalid');
    setOrgMembers(w, [{ userId: 'user-lena', role: 'admin' }, { userId: 'user-other', role: 'admin' }]);
    await giveKey(w, lena);
    const before = w.fake.requests.length;
    const result = await removeMember(removeArgs(w, lena.memberId));
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.deepEqual(stepsOf(result.checklist), ['repo-access:manual']);
    const removedFromOrg = deletesOf(requestsSince(w, before), '/organizations/org-1/members/');
    assert.deepEqual(removedFromOrg.map((request) => request.path), ['/v1/organizations/org-1/members/user-lena']);
    assert.equal(await w.org.listMembers('org-1').then((members) => members.map((member) => member.userId).sort().join(',')), 'user-other,user-owner');
  });
});

test('a lead who was invited as lead and has not been confirmed yet is also taken out of the organization', async () => {
  await inWorld(['a', 'b'], { membersIncludeEmail: true }, async (w) => {
    const lena = await addMember(w, 'b', 'Lena Lead', 'lena@example.invalid', 'lead', false);
    assert.equal(w.a.log.state().members.get(lena.memberId)?.pendingRole, 'lead');
    addNearUser(w, 'user-lena', 'lena@example.invalid');
    setOrgMembers(w, [{ userId: 'user-lena', role: 'admin' }]);
    const result = await removeMember(removeArgs(w, lena.memberId));
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    assert.equal(await w.org.listMembers('org-1').then((members) => members.some((member) => member.userId === 'user-lena')), false);
  });
});

test('the organization member is never an owner or the remover; no safe match becomes a manual item naming the lead', async () => {
  // The only member NEAR can match is an organization owner: nothing is removed.
  await inWorld(['a', 'b'], { membersIncludeEmail: true }, async (w) => {
    const lena = await addMember(w, 'b', 'Lena Lead', 'lena@example.invalid', 'lead');
    addNearUser(w, 'user-co-owner', 'lena@example.invalid');
    setOrgMembers(w, [{ userId: 'user-co-owner', role: 'owner' }]);
    const before = w.fake.requests.length;
    const result = await removeMember(removeArgs(w, lena.memberId));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(stepsOf(result.checklist), ['remove-org-member:manual', 'repo-access:manual']);
    assert.match(result.checklist[0]?.lastError ?? '', /Lena Lead/);
    assert.match(result.checklist[0]?.lastError ?? '', /NEAR console/);
    assert.deepEqual(deletesOf(requestsSince(w, before), '/organizations/org-1/members/'), []);
  });
  // The matching NEAR user is the lead doing the removing: nothing is removed.
  await inWorld(['a', 'b'], { membersIncludeEmail: true, ownerNearEmail: 'self@example.invalid' }, async (w) => {
    const lena = await addMember(w, 'b', 'Lena Lead', 'self@example.invalid', 'lead');
    const before = w.fake.requests.length;
    const result = await removeMember(removeArgs(w, lena.memberId));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(stepsOf(result.checklist), ['remove-org-member:manual', 'repo-access:manual']);
    assert.deepEqual(deletesOf(requestsSince(w, before), '/organizations/org-1/members/'), []);
    assert.equal(await w.org.listMembers('org-1').then((members) => members.some((member) => member.userId === 'user-owner')), true);
  });
});

test('NEAR does not return member emails (the real server): the lead is not removed by guesswork, a manual item says to do it in the NEAR console', async () => {
  await inWorld(['a', 'b'], {}, async (w) => {
    const lena = await addMember(w, 'b', 'Lena Lead', 'lena@example.invalid', 'lead');
    addNearUser(w, 'user-lena', 'lena@example.invalid');
    setOrgMembers(w, [{ userId: 'user-lena', role: 'admin' }]);
    assert.ok((await w.org.listMembers('org-1')).every((member) => member.email === undefined), 'the fake answers like the real server: no email');
    const before = w.fake.requests.length;
    const result = await removeMember(removeArgs(w, lena.memberId));
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.deepEqual(stepsOf(result.checklist), ['remove-org-member:manual', 'repo-access:manual']);
    assert.match(result.checklist[0]?.lastError ?? '', /Lena Lead/);
    assert.match(result.checklist[0]?.lastError ?? '', /NEAR console/);
    assert.deepEqual(deletesOf(requestsSince(w, before), '/organizations/org-1/members/'), [], 'no organization member was removed');
    assert.equal(await w.org.listMembers('org-1').then((members) => members.some((member) => member.userId === 'user-lena')), true);
    assert.ok(result.message.includes('NEAR console'));
  });
});

test('a refused organization removal is a failed item, and a retry with the emails available finishes it', async () => {
  await inWorld(['a', 'b'], { membersIncludeEmail: true }, async (w) => {
    const lena = await addMember(w, 'b', 'Lena Lead', 'lena@example.invalid', 'lead');
    addNearUser(w, 'user-lena', 'lena@example.invalid');
    setOrgMembers(w, [{ userId: 'user-lena', role: 'admin' }]);
    w.fake.fail({ method: 'DELETE', pathPrefix: '/v1/organizations/org-1/members/user-lena', status: 403, times: 1 });
    const result = await removeMember(removeArgs(w, lena.memberId));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(stepsOf(result.checklist), ['remove-org-member:failed', 'repo-access:manual']);
    const item = result.checklist[0] as CleanupItem;
    const done = await retryCleanupItem({ item, teamFile: w.teamFile, log: w.a.log, org: w.org, checklist: w.checklist });
    assert.equal(done.status, 'done');
    assert.equal(await w.org.listMembers('org-1').then((members) => members.some((member) => member.userId === 'user-lena')), false);
  });
});

test('cancelling an invitation writes member.removed for the invited id; a developer needs no NEAR call, a lead has the pending NEAR invitation cancelled', async () => {
  await inWorld(['a'], {}, async (w) => {
    const dev = await invite(w, 'Dana Developer', 'dana@example.invalid', 'developer');
    const before = w.fake.requests.length;
    const cancelled = await removeMember(removeArgs(w, dev.memberId));
    assert.equal(cancelled.ok, true, cancelled.ok ? '' : cancelled.message);
    if (!cancelled.ok) return;
    assert.equal(cancelled.kind, 'cancelled');
    assert.equal(cancelled.keyStillSpends, false);
    assert.deepEqual(cancelled.checklist, []);
    assert.equal(requestsSince(w, before).length, 0, 'a developer invitation has no NEAR side');
    assert.notEqual(w.a.log.state().members.get(dev.memberId)?.removedEvent, undefined);

    const lead = await invite(w, 'Lena Lead', 'lena@example.invalid', 'lead');
    assert.deepEqual(await w.org.inviteByEmail('org-1', 'lena@example.invalid', 'admin'), { ok: true, alreadyMember: false });
    assert.notEqual(w.fake.emailedToken('lena@example.invalid'), undefined, 'the NEAR invitation is pending');
    const result = await removeMember(removeArgs(w, lead.memberId));
    assert.equal(result.ok && result.kind, 'cancelled');
    assert.equal(w.fake.emailedToken('lena@example.invalid'), undefined, 'the NEAR invitation was cancelled');
    assert.deepEqual(result.ok ? result.checklist : undefined, []);
  });
});

test('cancelling a lead invitation without a NEAR session leaves a pending cancel-invitation item; one NEAR cannot find is a manual item', async () => {
  await inWorld(['a'], {}, async (w) => {
    const lead = await invite(w, 'Lena Lead', 'lena@example.invalid', 'lead');
    assert.deepEqual(await w.org.inviteByEmail('org-1', 'lena@example.invalid', 'admin'), { ok: true, alreadyMember: false });
    const noSession = await removeMember(removeArgs(w, lead.memberId, { org: null }));
    assert.equal(noSession.ok && noSession.kind, 'cancelled');
    assert.deepEqual(noSession.ok ? stepsOf(noSession.checklist) : undefined, ['cancel-invitation:pending']);
    assert.notEqual(w.fake.emailedToken('lena@example.invalid'), undefined, 'the NEAR invitation is still pending until the item is retried');
    const item = noSession.ok ? (noSession.checklist[0] as CleanupItem) : undefined;
    assert.ok(item !== undefined);
    const done = await retryCleanupItem({ item, teamFile: w.teamFile, log: w.a.log, org: w.org, checklist: w.checklist });
    assert.equal(done.status, 'done');
    assert.equal(w.fake.emailedToken('lena@example.invalid'), undefined);

    // An invitation that went to NEAR and is no longer there (or was never sent under this address) cannot be cancelled automatically.
    const other = await invite(w, 'Mina Lead', 'mina@example.invalid', 'lead');
    const noMatch = await removeMember(removeArgs(w, other.memberId));
    assert.equal(noMatch.ok && noMatch.kind, 'cancelled');
    assert.deepEqual(noMatch.ok ? stepsOf(noMatch.checklist) : undefined, ['cancel-invitation:manual']);
    assert.match(noMatch.ok ? noMatch.checklist[0]?.lastError ?? '' : '', /Mina Lead/);
  });
});

test('removing someone who was already removed is refused locally and makes no NEAR call', async () => {
  await inWorld(['a', 'b'], {}, async (w) => {
    const dana = await addMember(w, 'b', 'Dana Developer', 'dana@example.invalid');
    await giveKey(w, dana);
    assert.equal((await removeMember(removeArgs(w, dana.memberId))).ok, true);
    const before = w.fake.requests.length;
    const again = await removeMember(removeArgs(w, dana.memberId));
    assert.deepEqual(again, { ok: false, code: 'already-removed', message: TEAM_REJECTION_REASONS.memberRemoved });
    assert.equal(w.fake.requests.length, before, 'fake.requests is unchanged');
    assert.equal((await w.checklist.forMember(dana.memberId)).length, 1, 'no second reminder was added');
    const unknown = await removeMember(removeArgs(w, newMemberId()));
    assert.equal(unknown.ok, false);
    assert.equal(unknown.ok ? undefined : unknown.code, 'not-found');
  });
});

test('nothing is capped when the caller may not remove the person: a developer, the owner, or yourself', async () => {
  await inWorld(['a', 'b', 'c'], {}, async (w) => {
    const dana = await addMember(w, 'b', 'Dana Developer', 'dana@example.invalid');
    const eli = await addMember(w, 'c', 'Eli Engineer', 'eli@example.invalid');
    await giveKey(w, eli);
    await dana.client.log.sync();
    const before = w.fake.requests.length;
    const asDeveloper = await removeMember({ log: dana.client.log, teamFile: w.teamFile, memberId: eli.memberId, org: w.org, checklist: w.checklist });
    assert.equal(asDeveloper.ok, false);
    assert.equal(asDeveloper.ok ? undefined : asDeveloper.code, 'refused');
    const owner = await removeMember(removeArgs(w, w.ownerMemberId));
    assert.equal(owner.ok ? undefined : owner.code, 'refused');
    const self = await removeMember({ log: dana.client.log, teamFile: w.teamFile, memberId: dana.memberId, org: w.org, checklist: w.checklist });
    assert.equal(self.ok ? undefined : self.code, 'refused');
    assert.equal(w.fake.requests.length, before, 'no NEAR request was sent for any refused removal');
    assert.equal(w.a.log.state().members.get(eli.memberId)?.removedEvent, undefined);
  });
});

test('two leads removing the same member at once: one member.removed is accepted, the other gets the reason, and the key ends capped and revoked', async () => {
  await inWorld(['a', 'b', 'c'], {}, async (w) => {
    const dana = await addMember(w, 'b', 'Dana Developer', 'dana@example.invalid');
    const keyId = await giveKey(w, dana);
    const lena = await addMember(w, 'c', 'Lena Lead', 'lena@example.invalid', 'lead');
    await w.a.log.sync();
    await lena.client.log.sync();
    const leadChecklist = new CleanupChecklist(path.join(w.fixture.root, 'cleanup-lena'));
    const [first, second] = await Promise.all([
      removeMember(removeArgs(w, dana.memberId)),
      removeMember({ log: lena.client.log, teamFile: w.teamFile, memberId: dana.memberId, org: w.org, checklist: leadChecklist })
    ]);
    const winners = [first, second].filter((result) => result.ok);
    const losers = [first, second].filter((result) => !result.ok);
    assert.equal(winners.length, 1, 'exactly one removal succeeded');
    assert.equal(losers.length, 1);
    const loser = losers[0];
    assert.ok(loser !== undefined && !loser.ok);
    if (loser === undefined || loser.ok) return;
    assert.ok(loser.code === 'conflict' || loser.code === 'already-removed', loser.code);
    assert.match(loser.message, /removed/);
    assert.equal(await eventsOfType(w.a, 'member.removed'), 1, 'one member.removed is in the log');
    assert.equal(w.fake.key(keyId)?.spendLimitNanoUsd, 0);
    assert.equal(w.fake.key(keyId)?.revoked, true);

    // The loser's list records what it did (it capped the key), and nothing it left undone.
    const loserList = first.ok ? await leadChecklist.forMember(dana.memberId) : await w.checklist.forMember(dana.memberId);
    assert.deepEqual(stepsOf(loserList), ['zero-limit:done']);
  });
});

// CR-02: a "send the NEAR invitation" item left open must never invite a person the log no longer shows as an invited lead.
test('CR-02: removing a lead closes their unsent NEAR invitation, and a stale one is closed on Retry with no sign-in and no NEAR call', async () => {
  await inWorld(['a', 'b'], {}, async (w) => {
    const lee = await addMember(w, 'b', 'Lee Lead', 'lee@example.invalid', 'lead', false);
    const invitedEvent = w.a.log.state().members.get(lee.memberId)?.invitedEvent as string;
    await recordInvite(w.checklist.storageDir, { memberId: lee.memberId, name: 'Lee Lead', email: 'lee@example.invalid', role: 'lead', invitedEvent });
    await w.checklist.add([{ memberId: lee.memberId, memberName: 'Lee Lead', step: 'send-invitation', status: 'pending', organizationId: 'org-1' }]);

    const removed = await removeMember(removeArgs(w, lee.memberId));
    assert.equal(removed.ok, true, removed.ok ? '' : removed.message);
    const sends = (await w.checklist.forMember(lee.memberId)).filter((item) => item.step === 'send-invitation');
    assert.deepEqual(sends.map((item) => item.status), ['done'], 'the removal closed the unsent invitation');

    // An item that is still open (from another window, or saved before the removal) is closed by Retry before any sign-in.
    const [stale] = await w.checklist.add([{ memberId: lee.memberId, memberName: 'Lee Lead', step: 'send-invitation', status: 'failed', organizationId: 'org-1' }]);
    assert.ok(stale !== undefined);
    let signIns = 0;
    const before = w.fake.requests.length;
    const outcome = await retryNearInvitation({ item: stale, teamFile: w.teamFile, log: w.a.log, checklist: w.checklist, org: async () => { signIns += 1; return w.org; } });
    assert.equal(outcome.outcome, 'closed');
    assert.equal(signIns, 0, 'no sign-in was asked for');
    assert.equal(w.fake.requests.length, before, 'no NEAR request was sent');
    assert.equal(w.fake.emailedToken('lee@example.invalid'), undefined, 'nobody was invited to the organization');
    assert.equal((await w.checklist.list()).find((item) => item.id === stale.id)?.status, 'done');
  });
});

test('CR-02: a NEAR invitation is sent on Retry only to a lead still waiting on the same invitation, and never to another organization', async () => {
  await inWorld(['a'], {}, async (w) => {
    const { memberId } = await invite(w, 'Kim Lead', 'kim@example.invalid', 'lead');
    const invitedEvent = w.a.log.state().members.get(memberId)?.invitedEvent as string;
    await recordInvite(w.checklist.storageDir, { memberId, name: 'Kim Lead', email: 'kim@example.invalid', role: 'lead', invitedEvent });

    // Queued for an organization the team is no longer linked to: closed, nothing sent.
    const [moved] = await w.checklist.add([{ memberId, memberName: 'Kim Lead', step: 'send-invitation', status: 'pending', organizationId: 'org-old' }]);
    assert.ok(moved !== undefined);
    const closed = await retryNearInvitation({ item: moved, teamFile: w.teamFile, log: w.a.log, checklist: w.checklist, org: async () => w.org });
    assert.equal(closed.outcome, 'closed');
    assert.equal(w.fake.emailedToken('kim@example.invalid'), undefined);

    // Still an invited lead on this invitation: sent once.
    const [due] = await w.checklist.add([{ memberId, memberName: 'Kim Lead', step: 'send-invitation', status: 'pending', organizationId: 'org-1' }]);
    assert.ok(due !== undefined);
    const sent = await retryNearInvitation({ item: due, teamFile: w.teamFile, log: w.a.log, checklist: w.checklist, org: async () => w.org });
    assert.equal(sent.outcome, 'sent');
    assert.notEqual(w.fake.emailedToken('kim@example.invalid'), undefined);
    assert.equal((await w.checklist.list()).find((item) => item.id === due.id)?.status, 'done');

    // An entry recorded for an earlier invitation of the same id does not match the log's invitation, so it is not sent.
    await recordInvite(w.checklist.storageDir, { memberId, name: 'Kim Lead', email: 'kim@example.invalid', role: 'lead', invitedEvent: `evt-${'0'.repeat(26)}` });
    const [superseded] = await w.checklist.add([{ memberId, memberName: 'Kim Lead', step: 'send-invitation', status: 'pending', organizationId: 'org-1' }]);
    assert.ok(superseded !== undefined);
    const old = await retryNearInvitation({ item: superseded, teamFile: w.teamFile, log: w.a.log, checklist: w.checklist, org: async () => w.org });
    assert.equal(old.outcome, 'closed');
  });
});

test('items that are not removal steps are answered unchanged with the command that retries them; repo-access stays manual', async () => {
  await inWorld(['a'], {}, async (w) => {
    const memberId = newMemberId();
    const [send, deliver, rotate, repo] = await w.checklist.add([
      { memberId, memberName: 'Dana Developer', step: 'send-invitation', status: 'failed', lastError: 'NEAR said no' },
      { memberId, memberName: 'Dana Developer', step: 'deliver-key', status: 'pending' },
      { memberId, memberName: 'Dana Developer', step: 'rotate-key', status: 'manual' },
      { memberId, memberName: 'Dana Developer', step: 'repo-access', status: 'manual' }
    ]);
    const before = w.fake.requests.length;
    for (const item of [send, deliver, rotate]) {
      assert.ok(item !== undefined);
      const answered = await retryCleanupItem({ item, teamFile: w.teamFile, log: w.a.log, org: w.org, checklist: w.checklist });
      assert.equal(answered.status, item.status, 'the status is unchanged');
      assert.match(answered.lastError ?? '', /Manage Team Members/);
    }
    assert.ok(repo !== undefined);
    const reminder = await retryCleanupItem({ item: repo, teamFile: w.teamFile, log: w.a.log, org: w.org, checklist: w.checklist });
    assert.equal(reminder.status, 'manual');
    assert.equal(w.fake.requests.length, before, 'none of these made a NEAR call');
  });
});

// ---- Task 3: the removed member's own machine ----------------------------------------------------------------------------------------

// A machine of a lead who joined: project folder under git with work in progress, a personal profile, the team key installed as the active
// profile, a device key, a seal key and a kept NEAR session, plus another team's secrets and an unrelated one that must survive.
interface Machine {
  fake: FakeNear;
  teamId: string;
  teamFile: TeamFile;
  secrets: MemorySecrets;
  projectRoot: string;
  globalStorageDir: string;
  otherTeamSecret: string;
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// What the member's work looks like to git, leaving out the extension's own .planning folder where the profile list lives.
async function workState(projectRoot: string): Promise<Record<string, string>> {
  return {
    head: gitOut(projectRoot, ['rev-parse', 'HEAD']).trim(),
    branches: gitOut(projectRoot, ['branch', '--list']),
    stash: gitOut(projectRoot, ['stash', 'list']),
    status: gitOut(projectRoot, ['status', '--porcelain', '--', '.', ':!.planning']),
    tracked: await fs.readFile(path.join(projectRoot, 'work.txt'), 'utf8'),
    untracked: await fs.readFile(path.join(projectRoot, 'notes.txt'), 'utf8')
  };
}

const REMOVED_EVENT = 'evt-0123456789ABCDEFGHJKMNPQRS';

async function withMachine(run: (machine: Machine) => Promise<void>): Promise<void> {
  const fake = await startFakeNear();
  const projectRoot = await fs.mkdtemp(path.join(tmpdir(), 'near-ai-removed-project-'));
  const globalStorageDir = await fs.mkdtemp(path.join(tmpdir(), 'near-ai-removed-storage-'));
  try {
    const lead = fake.addUser({ id: 'user-owner', username: 'owner', email: 'owner@example.invalid' });
    const member = fake.addUser({ id: 'user-lena', username: 'lena', email: 'lena@example.invalid' });
    fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-owner', role: 'owner' }, { userId: 'user-lena', role: 'admin' }] });
    fake.addWorkspace({ id: 'ws-1', organizationId: 'org-1', name: 'Team workspace' });
    const org = new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(lead.accessToken), sleep: noSleep });

    // The member's work: committed, modified, on a second branch, plus a file git does not track.
    gitOut(projectRoot, ['init', '-q', '-b', 'main']);
    gitOut(projectRoot, ['config', 'user.email', 'lena@example.invalid']);
    gitOut(projectRoot, ['config', 'user.name', 'Lena']);
    await fs.writeFile(path.join(projectRoot, 'work.txt'), 'first\n');
    gitOut(projectRoot, ['add', 'work.txt']);
    gitOut(projectRoot, ['commit', '-q', '-m', 'first']);
    gitOut(projectRoot, ['branch', 'feature/lena']);
    await fs.writeFile(path.join(projectRoot, 'work.txt'), 'first\nunsaved change\n');
    await fs.writeFile(path.join(projectRoot, 'notes.txt'), 'my own notes\n');

    const teamId = newTeamId();
    const secrets = new MemorySecrets();
    const store = new ProfileStore(projectRoot, new AuthService(secrets), { validator: async () => undefined });
    await store.configure({ profileId: 'profile-personal', displayName: 'Personal', organization: 'Me', baseUrl: 'https://example.test/v1', authMode: 'apiKey' }, 'sk-personal-key-value');
    await createDeviceIdentity(secrets, teamId);
    await createSealIdentity(secrets, teamId);
    const created = await org.createKey('ws-1', 'lena-key', 5 * GIGA);
    const installed = await installTeamKey({
      projectRoot, globalStorageDir, teamId, teamName: 'Acme Team', secrets, apiKey: created.secret, baseUrl: fake.baseUrl,
      expect: NEAR_LINK, keyId: created.key.id, sleep: noSleep
    });
    assert.equal(installed.ok, true);
    await saveNearSession(secrets, teamId, member, 'lena', { baseUrl: fake.baseUrl });

    const otherTeamSecret = deviceKeySecretName(newTeamId());
    secrets.values.set(otherTeamSecret, 'other-team-device-key-value');
    secrets.values.set('unrelated.secret', 'unrelated-value');
    const teamFile: TeamFile = {
      version: 1, teamId, name: 'Acme Team', coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
      genesis: { eventId: 'evt-00000000000000000000000000', ownerDevice: { fingerprint: 'fp', publicKey: 'pk' } }, near: NEAR_LINK, createdAt: '2026-02-03T04:05:06.000Z'
    };
    await run({ fake, teamId, teamFile, secrets, projectRoot, globalStorageDir, otherTeamSecret });
  } finally {
    await fake.close();
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(globalStorageDir, { recursive: true, force: true });
  }
}

test('a removed member machine forgets exactly this team secrets, gets the personal profile back and keeps all code and branches', async () => {
  await withMachine(async (m) => {
    const before = await workState(m.projectRoot);
    const sessionName = nearSessionSecretName(m.teamId);
    assert.ok(m.secrets.values.has(deviceKeySecretName(m.teamId)) && m.secrets.values.has(sealKeySecretName(m.teamId)) && m.secrets.values.has(sessionName));
    const store = new ProfileStore(m.projectRoot, new AuthService(m.secrets));
    assert.equal((await store.getActiveSelection())?.profileId, teamProfileId(m.teamId));
    const memberId = newMemberId();

    const result = await handleOwnRemoval({
      projectRoot: m.projectRoot, globalStorageDir: m.globalStorageDir, teamFile: m.teamFile, memberId, removedEvent: REMOVED_EVENT, secrets: m.secrets, nearBaseUrl: m.fake.baseUrl
    });
    assert.equal(result.restoredProfileId, 'profile-personal');
    for (const name of [deviceKeySecretName(m.teamId), sealKeySecretName(m.teamId), sessionName]) {
      assert.equal(m.secrets.values.has(name), false, `${name} was deleted`);
      assert.ok(result.removedSecrets.includes(name), `${name} is listed as deleted`);
    }
    const fresh = new ProfileStore(m.projectRoot, new AuthService(m.secrets));
    assert.equal((await fresh.getActiveSelection())?.profileId, 'profile-personal');
    assert.equal(await fresh.get(teamProfileId(m.teamId)), undefined, 'the team profile is gone');
    assert.equal(await new AuthService(m.secrets).getScopedApiKey(fresh.getScope(teamProfileId(m.teamId))), undefined, 'the team key is gone');
    assert.equal(await new AuthService(m.secrets).getScopedApiKey(fresh.getScope('profile-personal')), 'sk-personal-key-value', 'the personal key is untouched');
    assert.equal(await readInstalledKey(m.globalStorageDir, m.teamId), undefined);
    assert.ok(result.removedSecrets.some((name) => name.includes(teamProfileId(m.teamId))), 'the team key profile is listed');

    // Only this team's entries went: another team's device key and an unrelated secret are as they were.
    assert.equal(m.secrets.values.get(m.otherTeamSecret), 'other-team-device-key-value');
    assert.equal(m.secrets.values.get('unrelated.secret'), 'unrelated-value');

    // The marker holds the member id and the removal event, nothing else.
    const raw = JSON.parse(await fs.readFile(path.join(teamStorageDir(m.globalStorageDir, m.teamId), REMOVED_FILE), 'utf8')) as unknown;
    assert.deepEqual(raw, { memberId, removedEvent: REMOVED_EVENT });
    assert.deepEqual(await readRemovedMarker(m.globalStorageDir, m.teamId), { memberId, removedEvent: REMOVED_EVENT });

    // The member's code, branches, stash and working tree are exactly as they were.
    assert.deepEqual(await workState(m.projectRoot), before);
    assert.equal(removedText('Acme Team'), 'You were removed from Acme Team. Team sync has stopped; your code and branches are unchanged.');
  });
});

test('the NEAR session is signed out at NEAR when possible and deleted either way', async () => {
  await withMachine(async (m) => {
    const sessionName = nearSessionSecretName(m.teamId);
    m.fake.fail({ method: 'POST', pathPrefix: '/v1/auth/logout', status: 500, times: 5 });
    const result = await handleOwnRemoval({
      projectRoot: m.projectRoot, globalStorageDir: m.globalStorageDir, teamFile: m.teamFile, memberId: newMemberId(), removedEvent: REMOVED_EVENT, secrets: m.secrets, nearBaseUrl: m.fake.baseUrl
    });
    assert.ok(m.fake.requests.some((request) => request.method === 'POST' && request.path === '/v1/auth/logout'), 'the sign out was attempted');
    assert.equal(m.secrets.values.has(sessionName), false, 'the session is deleted although NEAR refused the sign out');
    assert.ok(result.removedSecrets.includes(sessionName));
  });
  await withMachine(async (m) => {
    // No NEAR address known: nothing is sent, the secret still goes.
    await handleOwnRemoval({ projectRoot: m.projectRoot, globalStorageDir: m.globalStorageDir, teamFile: m.teamFile, memberId: newMemberId(), removedEvent: REMOVED_EVENT, secrets: m.secrets });
    assert.equal(m.secrets.values.has(nearSessionSecretName(m.teamId)), false);
    assert.equal(m.fake.requests.some((request) => request.path === '/v1/auth/logout'), false);
  });
});

test('running the removal twice is harmless, a damaged marker still reads as removed, and no marker reads as not removed', async () => {
  await withMachine(async (m) => {
    assert.equal(await readRemovedMarker(m.globalStorageDir, m.teamId), undefined);
    const memberId = newMemberId();
    const input = { projectRoot: m.projectRoot, globalStorageDir: m.globalStorageDir, teamFile: m.teamFile, memberId, removedEvent: REMOVED_EVENT, secrets: m.secrets, nearBaseUrl: m.fake.baseUrl };
    await handleOwnRemoval(input);
    const second = await handleOwnRemoval(input);
    assert.deepEqual(second.removedSecrets, [], 'nothing was left to delete the second time');
    assert.equal(second.restoredProfileId, undefined);
    assert.deepEqual(await readRemovedMarker(m.globalStorageDir, m.teamId), { memberId, removedEvent: REMOVED_EVENT });
    assert.equal(m.secrets.values.get('unrelated.secret'), 'unrelated-value');

    // A marker that cannot be read as written is not a reason to let the machine sync again.
    const file = path.join(teamStorageDir(m.globalStorageDir, m.teamId), REMOVED_FILE);
    for (const damaged of ['{not json', '[]', '{"memberId":"mbr-0000000000000000"}', '{"memberId":1,"removedEvent":2}', `{"memberId":"${memberId}","removedEvent":"${REMOVED_EVENT}","extra":true}`]) {
      await fs.writeFile(file, damaged);
      assert.notEqual(await readRemovedMarker(m.globalStorageDir, m.teamId), undefined, `${damaged} reads as removed`);
    }
  });
});

test('the removal code makes no git call, never names the NEAR key folder, and deletes nothing outside the team storage folder', async () => {
  const read = (name: string): Promise<string> => fs.readFile(path.join(__dirname, '..', '..', 'src', 'team', name), 'utf8');
  const [client, removal] = [await read('removedClient.ts'), await read('remove.ts')];
  const codeLines = (text: string): string => text.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  for (const text of [codeLines(client), codeLines(removal)]) assert.equal(text.includes('near-credentials'), false);
  assert.equal(/runGit|GitRunner|'git'/.test(client), false, 'removedClient.ts makes no git call');
  assert.equal(/from 'vscode'|require\('vscode'\)/.test(client + removal), false);
  assert.equal(/fs\.(rm|unlink|rmdir)|\bunlink\(|rmSync/.test(client), false, 'no file is deleted by the removed client itself');
});
