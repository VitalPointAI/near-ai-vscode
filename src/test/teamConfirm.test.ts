// Confirming a member and giving them a capped NEAR key (Phase 61 plan 10): the lead's client creates the key with the allocation as its
// spend limit, seals it to the member's devices through the signed log, and the member's clone opens it and installs it. Proven over real
// git against the fake NEAR server. Canary keys are whatever the fake generates at run time; nothing here is a literal secret.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { AuthService } from '../services/auth';
import { ProfileStore } from '../services/profileStore';
import { expectedJoinRole, joinProofBytes, keyNeedsRotation, memberAttention } from '../domain/team/invite';
import { teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import { parseEventFile } from '../domain/team/validate';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { GenesisAnchor, MemberInvitedBody, MemberJoinedBody, Role, TeamEvent, TeamFile, TeamState } from '../domain/team/types';
import { CleanupChecklist } from '../team/cleanupChecklist';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { createDeviceIdentity, createSealIdentity, emailHash, newMemberId, newTeamId } from '../team/identity';
import type { DeviceIdentity, SealIdentity } from '../team/identity';
import { deriveInviteKey, generateInviteCode } from '../team/inviteCode';
import { confirmMember, deliverMemberKey, installDeliveredKey, rotateMemberKey, teamKeyName } from '../team/keyDelivery';
import { NearOrgClient } from '../team/nearOrg';
import type { CreatedNearKey, NearAuth, NearOrgClientOptions } from '../team/nearOrg';
import { NearSessionError } from '../team/nearSession';
import { canonicalTeamFile, checkNearPin, teamStorageDir } from '../team/teamFile';
import { readInstalledKey, teamProfileId } from '../team/teamKeyProfile';
import { startFakeNear } from './helpers/fakeNear';
import type { FakeNear } from './helpers/fakeNear';
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

// A device of the invited member: its own clone, SecretStorage, device key and X25519 seal key.
interface Device { clone: string; secrets: MemorySecrets; identity: DeviceIdentity; seal: SealIdentity; client: Client; globalStorageDir: string }

interface World {
  fixture: TeamFixture;
  fake: FakeNear;
  teamId: string;
  teamFile: TeamFile;
  anchor: GenesisAnchor;
  a: Client;
  org: NearOrgClient;
  auth: NearAuth;
  checklist: CleanupChecklist;
  memberId: string;
  first: Device;
  codeBytes: Buffer;
  ownerMemberId: string;
}

function inviteBody(teamId: string, memberId: string, codeBytes: Buffer, role: MemberInvitedBody['role'], allocationNanoUsd: number): MemberInvitedBody {
  return {
    memberId, name: 'Dana Developer', emailHashes: [emailHash(teamId, 'dana@example.invalid')], role, allocationNanoUsd,
    ttlSeconds: 604_800, invite: { publicKey: deriveInviteKey(codeBytes, teamId, memberId).publicKey }
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

async function makeDevice(fixture: TeamFixture, clone: string, teamId: string, anchor: GenesisAnchor, memberId: string): Promise<Device> {
  const secrets = new MemorySecrets();
  const identity = await createDeviceIdentity(secrets, teamId);
  const seal = await createSealIdentity(secrets, teamId);
  const client = clientFor(fixture, clone, anchor, { identity, memberId });
  return { clone, secrets, identity, seal, client, globalStorageDir: path.join(fixture.root, `global-${clone}`) };
}

interface WorldOptions { allocation?: number; role?: MemberInvitedBody['role']; join?: boolean }

// The owner's clone writes a NEAR-linked team, invites Dana, and Dana joins from clone b with the invite code.
async function startWorld(fixture: TeamFixture, options: WorldOptions = {}): Promise<World> {
  const fake = await startFakeNear();
  const lead = fake.addUser({ id: 'user-lead', username: 'lead', email: 'lead@example.invalid' });
  fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-lead', role: 'owner' }] });
  fake.addWorkspace({ id: 'ws-1', organizationId: 'org-1', name: 'Team workspace' });
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const genesis = buildGenesisEvents({
    teamId, teamName: 'Confirm team', owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [emailHash(teamId, 'owner@example.invalid')] },
    identity: owner.identity, policy: defaultTeamPolicy(), near: NEAR_LINK, now: fixedNow
  });
  const teamFile: TeamFile = {
    version: 1, teamId, name: 'Confirm team', coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: genesis.anchor.eventId, ownerDevice: genesis.anchor.ownerDevice }, near: NEAR_LINK, createdAt: '2026-02-03T04:05:06.000Z'
  };
  const a = clientFor(fixture, 'a', genesis.anchor, { identity: owner.identity, memberId: owner.memberId });
  const written = await a.transport.append(async () => genesis.events, { genesis: { teamFileText: canonicalTeamFile(teamFile) } });
  assert.equal(written.ok, true);

  const memberId = newMemberId();
  const code = generateInviteCode();
  const invited = await a.log.append(() => [{ type: 'member.invited', body: inviteBody(teamId, memberId, code.bytes, options.role ?? 'developer', options.allocation ?? 5 * GIGA) }]);
  assert.equal(invited.ok, true, invited.ok ? '' : invited.reason);

  const first = await makeDevice(fixture, 'b', teamId, genesis.anchor, memberId);
  await first.client.log.sync();
  if (options.join !== false) {
    const joined = await first.client.log.appendJoin(first.identity, (state) => joinBody(state, teamId, memberId, code.bytes, first.identity, first.seal.publicKey));
    assert.equal(joined.ok, true, joined.ok ? '' : joined.reason);
    await a.log.sync();
  }
  return {
    fixture, fake, teamId, teamFile, anchor: genesis.anchor, a,
    org: new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(lead.accessToken), sleep: noSleep }), auth: staticAuth(lead.accessToken),
    checklist: new CleanupChecklist(path.join(fixture.root, 'cleanup-a')), memberId, first, codeBytes: code.bytes, ownerMemberId: owner.memberId
  };
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

async function eventTypes(client: Client): Promise<string[]> {
  const types: string[] = [];
  for (const entry of await client.transport.readAll()) {
    const parsed = parseEventFile(entry);
    if (parsed.ok) types.push(parsed.event.type);
  }
  return types;
}

function memberOf(world: World, client: Client = world.a): NonNullable<ReturnType<TeamState['members']['get']>> {
  const member = client.log.state().members.get(world.memberId);
  assert.ok(member !== undefined, 'the member is in the log');
  return member;
}

function installFor(world: World, device: Device): Parameters<typeof installDeliveredKey>[0] {
  return {
    projectRoot: world.fixture.clones[device.clone] as string, globalStorageDir: device.globalStorageDir, teamFile: world.teamFile, log: device.client.log,
    deviceFingerprint: device.identity.fingerprint, secrets: device.secrets, baseUrl: world.fake.baseUrl, sleep: noSleep
  };
}

async function activeKeyOf(world: World, device: Device): Promise<{ profileId: string | undefined; key: string | undefined }> {
  const projectRoot = world.fixture.clones[device.clone] as string;
  const auth = new AuthService(device.secrets);
  const store = new ProfileStore(projectRoot, auth);
  const profileId = (await store.getActiveSelection())?.profileId;
  const key = profileId === undefined ? undefined : await auth.getScopedApiKey(store.getScope(profileId));
  return { profileId, key };
}

function everyObject(gitDir: string): Buffer {
  return execFileSync('git', ['-C', gitDir, 'cat-file', '--batch-all-objects', '--batch'], { maxBuffer: 64 * 1024 * 1024 });
}

async function filesUnder(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(full)));
    else found.push(full);
  }
  return found;
}

// The key must be nowhere but the member's SecretStorage: not in a coordination object on the remote or in any mirror, not in a file under any
// storage folder or working clone, and not in the lead's cleanup checklist.
async function assertKeyNowhere(world: World, secret: string): Promise<void> {
  assert.ok(secret.length >= 12, 'a real secret is being searched for');
  const needle = Buffer.from(secret, 'utf8');
  const blobs: Array<{ where: string; data: Buffer }> = [{ where: 'the remote', data: everyObject(world.fixture.remote) }];
  for (const name of Object.keys(world.fixture.clones)) {
    const mirror = path.join(world.fixture.storageDir(name), 'coordination.git');
    if (await fs.stat(mirror).then(() => true, () => false)) blobs.push({ where: `mirror ${name}`, data: everyObject(mirror) });
  }
  const roots = [path.join(world.fixture.root, 'storage'), path.join(world.fixture.root, 'clones'), path.join(world.fixture.root, 'cleanup-a')];
  for (const entry of await fs.readdir(world.fixture.root)) if (entry.startsWith('global-')) roots.push(path.join(world.fixture.root, entry));
  for (const root of roots) for (const file of await filesUnder(root)) blobs.push({ where: file, data: await fs.readFile(file) });
  blobs.push({ where: 'the cleanup checklist', data: Buffer.from(JSON.stringify(await world.checklist.list()), 'utf8') });
  for (const blob of blobs) assert.equal(blob.data.includes(needle), false, `the key is not in ${blob.where}`);
}

test('tracer: the owner confirms a developer, the key is created with the allocation as its cap, sealed through the log and installed on the developer clone', async () => {
  await inWorld(['a', 'b'], {}, async (world) => {
    assert.deepEqual(memberAttention(world.a.log.state(), true), [{ memberId: world.memberId, kind: 'confirm' }]);
    assert.equal(memberOf(world).role, 'observer');
    assert.equal(memberOf(world).pendingRole, 'developer');

    const result = await confirmMember({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org: world.org, checklist: world.checklist });
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(result.roleChanged, true);
    assert.equal(result.key, 'delivered');

    // The role changed first, then the key was sealed.
    assert.deepEqual((await eventTypes(world.a)).slice(-2), ['member.role-changed', 'member.key-sealed']);
    const member = memberOf(world);
    assert.equal(member.role, 'developer');
    assert.equal(member.pendingRole, undefined);
    const keyId = member.nearApiKeyId;
    assert.ok(keyId !== undefined, 'the log records the key id');
    assert.deepEqual(member.nearKeyDevices, [world.first.identity.fingerprint]);

    // The cap was part of the create call: one create POST and no later PATCH.
    const stored = world.fake.key(keyId);
    assert.equal(stored?.spendLimitNanoUsd, 5 * GIGA);
    assert.equal(stored?.revoked, false);
    const keyRequests = world.fake.requests.filter((request) => request.path.includes('/api-keys'));
    assert.equal(keyRequests.filter((request) => request.method === 'POST').length, 1);
    assert.equal(world.fake.requests.some((request) => request.method === 'PATCH'), false, 'the limit was never changed after the create');
    assert.deepEqual(await world.checklist.list(), []);
    assert.deepEqual(memberAttention(world.a.log.state(), true), []);

    // The developer's clone syncs, opens its entry and installs the key as the project's active credential.
    await world.first.client.log.sync();
    const installed = await installDeliveredKey(installFor(world, world.first));
    assert.deepEqual(installed, { status: 'installed', keyId });
    const active = await activeKeyOf(world, world.first);
    assert.equal(active.profileId, teamProfileId(world.teamId));
    assert.equal(active.key, stored?.secret);
    assert.equal((await readInstalledKey(world.first.globalStorageDir, world.teamId))?.keyId, keyId);
    assert.deepEqual(await installDeliveredKey(installFor(world, world.first)), { status: 'already-installed' });

    await assertKeyNowhere(world, stored?.secret ?? '');
    // The scan is not vacuous: the same key written into a storage folder is found.
    await fs.mkdir(world.first.globalStorageDir, { recursive: true });
    await fs.writeFile(path.join(world.first.globalStorageDir, 'leak.txt'), stored?.secret ?? '', 'utf8');
    await assert.rejects(assertKeyNowhere(world, stored?.secret ?? ''), /the key is not in/);
  });
});

// CR-01: a team.json whose NEAR link differs from the one this computer pinned must not decide where a key is made or which organization and
// workspace a delivered key has to belong to.
test('CR-01: a key is never created in, or installed from, a NEAR link that differs from the one this computer pinned', async () => {
  await inWorld(['a', 'b'], {}, async (world) => {
    world.fake.addWorkspace({ id: 'ws-2', organizationId: 'org-1', name: 'Decoy workspace' });
    assert.deepEqual(await checkNearPin(world.checklist.storageDir, world.teamFile), NEAR_LINK);
    const forged: TeamFile = { ...world.teamFile, near: { organizationId: 'org-1', workspaceId: 'ws-2' } };
    const before = world.fake.requests.length;
    const result = await confirmMember({ log: world.a.log, teamFile: forged, memberId: world.memberId, org: world.org, checklist: world.checklist });
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(result.key, 'queued');
    assert.match(result.message, /different NEAR organization or workspace/);
    assert.equal(world.fake.requests.slice(before).some((request) => request.path.includes('/api-keys')), false, 'no key was made anywhere');

    // With the pinned link the key is delivered; the member's computer pinned the real link too, and refuses a forged one when installing.
    const sent = await deliverMemberKey({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org: world.org, checklist: world.checklist });
    assert.equal(sent.ok, true, sent.ok ? '' : sent.message);
    await world.first.client.log.sync();
    assert.deepEqual(await checkNearPin(teamStorageDir(world.first.globalStorageDir, world.teamId), world.teamFile), NEAR_LINK);
    const refused = await installDeliveredKey({ ...installFor(world, world.first), teamFile: forged });
    assert.equal(refused.status, 'failed');
    if (refused.status === 'failed') assert.match(refused.message, /different NEAR organization or workspace/);
    assert.equal((await activeKeyOf(world, world.first)).key, undefined, 'nothing was installed');
  });
});

test('a key name is plain text of at most 100 characters and differs for each delivery', () => {
  const unusual = `Team ${'long '.repeat(40)}‮<script>`;
  const name = teamKeyName(unusual, `Dana \u{1F600} "Developer"\n${'x'.repeat(200)}`, 'dev-0123456789abcdef');
  assert.match(name, /^[A-Za-z0-9 ._-]{1,100}$/);
  assert.ok(name.includes('dev-0123456789abcdef'), 'the unique part is kept whole');
  assert.notEqual(teamKeyName('Team', 'Dana', 'dev-aaaa'), teamKeyName('Team', 'Dana', 'dev-bbbb'));
  assert.match(teamKeyName('', '', 'dev-aaaa'), /^[A-Za-z0-9 ._-]{1,100}$/);
});

test('confirming a member who is not waiting and needs no key answers not-pending', async () => {
  await inWorld(['a', 'b'], {}, async (world) => {
    const input = { log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org: world.org, checklist: world.checklist };
    assert.equal((await confirmMember(input)).ok, true);
    const again = await confirmMember(input);
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.code, 'not-pending');
    const stranger = await confirmMember({ ...input, memberId: newMemberId() });
    assert.equal(stranger.ok, false);
    if (!stranger.ok) assert.equal(stranger.code, 'not-pending');
    assert.equal(world.fake.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/api-keys')).length, 1, 'no second key was made');
  });
});

test('an event the log does not have is not found', async () => {
  await inWorld(['a', 'b'], {}, async (world) => {
    assert.equal(await world.a.log.findEvent('evt-01ARZ3NDEKTSV4RRFFQ69G5FAV'), undefined);
    const first = (await world.a.transport.readAll()).map((entry) => parseEventFile(entry)).find((parsed) => parsed.ok);
    assert.ok(first !== undefined && first.ok);
    if (first !== undefined && first.ok) assert.equal((await world.a.log.findEvent(first.event.id))?.type, first.event.type);
  });
});

// ---- failure paths (Task 2) -------------------------------------------------------------------------------------------------------------

// A client that runs a step of the test right after a key was made, to stand in for another lead acting between two steps of one delivery.
class InterruptedOrg extends NearOrgClient {
  public lastKeyId: string | undefined;
  private readonly afterCreate: () => Promise<void>;

  public constructor(options: NearOrgClientOptions, afterCreate: () => Promise<void>) {
    super(options);
    this.afterCreate = afterCreate;
  }

  public override async createKey(workspaceId: string, name: string, spendLimitNanoUsd: number): Promise<CreatedNearKey> {
    const created = await super.createKey(workspaceId, name, spendLimitNanoUsd);
    this.lastKeyId = created.key.id;
    await this.afterCreate();
    return created;
  }
}

function interruptedOrg(world: World, afterCreate: () => Promise<void>): InterruptedOrg {
  return new InterruptedOrg({ baseUrl: world.fake.baseUrl, auth: world.auth, sleep: noSleep }, afterCreate);
}

const removeMember = (world: World) => async (): Promise<void> => {
  const removed = await world.a.log.append(() => [{ type: 'member.removed', body: { memberId: world.memberId } }]);
  assert.equal(removed.ok, true, removed.ok ? '' : removed.reason);
};

test('confirming without a NEAR sign-in changes the role, queues the key and leaves a pending item that says to sign in', async () => {
  await inWorld(['a', 'b'], {}, async (world) => {
    const result = await confirmMember({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, checklist: world.checklist });
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(result.roleChanged, true);
    assert.equal(result.key, 'queued');
    assert.deepEqual((await eventTypes(world.a)).slice(-1), ['member.role-changed']);
    assert.equal(world.fake.requests.some((request) => request.path.includes('/api-keys')), false, 'NEAR was not asked for anything');
    const items = await world.checklist.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.step, 'deliver-key');
    assert.equal(items[0]?.status, 'pending');
    assert.equal(items[0]?.memberName, 'Dana Developer');
    assert.equal(items[0]?.memberId, world.memberId);
    assert.match(items[0]?.lastError ?? '', /Sign in to NEAR to send Dana Developer's key/);
    assert.deepEqual(memberAttention(world.a.log.state(), true), [{ memberId: world.memberId, kind: 'deliver-key' }]);

    // Signing in later and retrying sends the key and settles the same item.
    const sent = await deliverMemberKey({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org: world.org, checklist: world.checklist });
    assert.equal(sent.ok, true, sent.ok ? '' : sent.message);
    const after = await world.checklist.list();
    assert.equal(after.length, 1, 'the open item is reused, not duplicated');
    assert.equal(after[0]?.id, items[0]?.id);
    assert.equal(after[0]?.status, 'done');
    assert.equal(after[0]?.lastError, undefined);
  });
});

test('a lead whose NEAR sign-in is gone gets signed-out and a pending item, with nothing made at NEAR', async () => {
  await inWorld(['a', 'b'], {}, async (world) => {
    const signedOut = new NearOrgClient({
      baseUrl: world.fake.baseUrl, sleep: noSleep,
      auth: { accessToken: async () => { throw new NearSessionError('signed-out', 'You are not signed in to NEAR AI for this team. Sign in first.'); }, refreshAfterUnauthorized: async () => undefined }
    });
    const result = await deliverMemberKey({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org: signedOut, checklist: world.checklist });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'signed-out');
    const items = await world.checklist.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.status, 'pending');
    assert.match(items[0]?.lastError ?? '', /Sign in to NEAR to send Dana Developer's key/);
    assert.equal(world.fake.requests.filter((request) => request.path.includes('/api-keys')).length, 0);
  });
});

test('a NEAR error while making the key leaves the confirmation done, the key queued and a failed item with the error', async () => {
  await inWorld(['a', 'b'], {}, async (world) => {
    world.fake.fail({ method: 'POST', pathPrefix: '/v1/workspaces/ws-1/api-keys', status: 500, times: 1 });
    const result = await confirmMember({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org: world.org, checklist: world.checklist });
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(result.roleChanged, true);
    assert.equal(result.key, 'queued');
    const types = await eventTypes(world.a);
    assert.equal(types.includes('member.role-changed'), true);
    assert.equal(types.includes('member.key-sealed'), false);
    assert.equal(memberOf(world).role, 'developer');
    const items = await world.checklist.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.step, 'deliver-key');
    assert.equal(items[0]?.status, 'failed');
    assert.equal(items[0]?.attempts, 1);
    assert.match(items[0]?.lastError ?? '', /500/);
    assert.equal((await world.org.listKeys('ws-1')).length, 0, 'no key was left in the workspace');

    // The retry works once the fault clears, settles the same item, and a second failure before that would have counted as another attempt.
    const retried = await deliverMemberKey({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org: world.org, checklist: world.checklist });
    assert.equal(retried.ok, true, retried.ok ? '' : retried.message);
    const after = await world.checklist.list();
    assert.equal(after.length, 1);
    assert.equal(after[0]?.id, items[0]?.id);
    assert.equal(after[0]?.status, 'done');
    assert.equal(after[0]?.lastError, undefined);
  });
});

test('a failed retry counts as another attempt on the same item', async () => {
  await inWorld(['a', 'b'], {}, async (world) => {
    world.fake.fail({ method: 'POST', pathPrefix: '/v1/workspaces/ws-1/api-keys', status: 500, times: 2 });
    const input = { log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org: world.org, checklist: world.checklist };
    assert.equal((await deliverMemberKey(input)).ok, false);
    assert.equal((await deliverMemberKey(input)).ok, false);
    const items = await world.checklist.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.attempts, 2);
    assert.equal(items[0]?.status, 'failed');
  });
});

test('a key whose log write is refused because the member was removed meanwhile is zeroed then revoked, and a Retry item is left', async () => {
  await inWorld(['a', 'b'], {}, async (world) => {
    const org = interruptedOrg(world, removeMember(world));
    const result = await confirmMember({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org, checklist: world.checklist });
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(result.roleChanged, true, 'the confirmation stands');
    assert.equal(result.key, 'queued');
    assert.match(result.message, /removed/);
    const keyId = org.lastKeyId;
    assert.ok(keyId !== undefined, 'a key was made');
    const stored = world.fake.key(keyId);
    assert.equal(stored?.revoked, true);
    assert.equal(stored?.spendLimitNanoUsd, 0);
    // The limit was set to 0 before the revoke, so a half-finished clean-up never leaves a spendable key.
    const order = world.fake.requests.filter((request) => request.path.includes(`/api-keys/${keyId}`)).map((request) => request.method);
    assert.deepEqual(order, ['PATCH', 'DELETE']);
    assert.equal(memberOf(world).nearApiKeyId, undefined, 'the log holds no key for the member');
    const items = await world.checklist.list();
    assert.deepEqual(items.map((item) => [item.step, item.status]), [['deliver-key', 'failed']]);
    assert.match(items[0]?.lastError ?? '', /removed/);
  });
});

test('a key that cannot be zeroed or revoked after a refused write is put on the list for both steps', async () => {
  await inWorld(['a', 'b'], {}, async (world) => {
    world.fake.fail({ method: 'PATCH', pathPrefix: '/v1/workspaces/ws-1/api-keys', status: 500, times: 20 });
    world.fake.fail({ method: 'DELETE', pathPrefix: '/v1/workspaces/ws-1/api-keys', status: 500, times: 20 });
    const org = interruptedOrg(world, removeMember(world));
    const result = await deliverMemberKey({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org, checklist: world.checklist });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'log');
    const keyId = org.lastKeyId;
    assert.ok(keyId !== undefined);
    const items = await world.checklist.list();
    const byStep = new Map(items.map((item) => [item.step, item]));
    assert.equal(byStep.get('deliver-key')?.status, 'failed');
    assert.equal(byStep.get('zero-limit')?.status, 'failed');
    assert.equal(byStep.get('zero-limit')?.keyId, keyId);
    assert.equal(byStep.get('revoke-key')?.status, 'failed');
    assert.equal(byStep.get('revoke-key')?.keyId, keyId);
    assert.equal(items.length, 3);
    assert.equal(world.fake.key(keyId)?.revoked, false, 'the fake still has it, which is why the items exist');
  });
});

test('a member who joined with their final role gets a key through deliverMemberKey at their allocation', async () => {
  await inWorld(['a', 'b'], { role: 'observer', allocation: 2 * GIGA }, async (world) => {
    assert.equal(memberOf(world).pendingRole, undefined);
    assert.equal(memberOf(world).role, 'observer');
    assert.deepEqual(memberAttention(world.a.log.state(), true), [{ memberId: world.memberId, kind: 'deliver-key' }]);
    const result = await deliverMemberKey({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org: world.org, checklist: world.checklist });
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(world.fake.key(result.keyId)?.spendLimitNanoUsd, 2 * GIGA);
    assert.equal(memberOf(world).nearApiKeyId, result.keyId);
    assert.deepEqual((await eventTypes(world.a)).slice(-1), ['member.key-sealed']);

    // A second delivery is refused: the key already sent is not replaced by a second one.
    const again = await deliverMemberKey({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org: world.org, checklist: world.checklist });
    assert.equal(again.ok, false);
    assert.equal(world.fake.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/api-keys')).length, 1);

    await world.first.client.log.sync();
    assert.deepEqual(await installDeliveredKey(installFor(world, world.first)), { status: 'installed', keyId: result.keyId });
  });
});

test('confirmMember sends the key alone for a member who needs no role change', async () => {
  await inWorld(['a', 'b'], { role: 'observer' }, async (world) => {
    const result = await confirmMember({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org: world.org, checklist: world.checklist });
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(result.roleChanged, false);
    assert.equal(result.key, 'delivered');
    assert.equal(memberOf(world).nearApiKeyId !== undefined, true);
    assert.equal((await eventTypes(world.a)).includes('member.role-changed'), false);
  });
});

test('the owner never gets a key through the log and a member who has not joined has no device', async () => {
  await inWorld(['a', 'b'], {}, async (world) => {
    const owner = await deliverMemberKey({ log: world.a.log, teamFile: world.teamFile, memberId: world.ownerMemberId, org: world.org, checklist: world.checklist });
    assert.equal(owner.ok, false);
    if (!owner.ok) {
      assert.equal(owner.code, 'log');
      assert.match(owner.message, /owner/i);
    }
    assert.equal(world.fake.requests.some((request) => request.path.includes('/api-keys')), false);
  });
  await inWorld(['a', 'b'], { join: false }, async (world) => {
    const invited = await deliverMemberKey({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org: world.org, checklist: world.checklist });
    assert.equal(invited.ok, false);
    if (!invited.ok) assert.equal(invited.code, 'no-device');
    assert.equal(world.fake.requests.some((request) => request.path.includes('/api-keys')), false);
  });
});

// ---- rotation (Task 3) ------------------------------------------------------------------------------------------------------------------

// A further device for the member, added by the member's first device. withSeal false publishes no X25519 key, so it cannot receive a key.
async function addDevice(world: World, clone: string, withSeal = true): Promise<Device> {
  const secrets = new MemorySecrets();
  const identity = await createDeviceIdentity(secrets, world.teamId);
  const seal = await createSealIdentity(secrets, world.teamId);
  const client = clientFor(world.fixture, clone, world.anchor, { identity, memberId: world.memberId });
  await world.first.client.log.sync();
  const added = await world.first.client.log.append(() => [{
    type: 'device.added',
    body: { memberId: world.memberId, device: { fingerprint: identity.fingerprint, publicKey: identity.publicKey }, ...(withSeal ? { sealKey: { publicKey: seal.publicKey } } : {}) }
  }]);
  assert.equal(added.ok, true, added.ok ? '' : added.reason);
  await world.a.log.sync();
  await client.log.sync();
  return { clone, secrets, identity, seal, client, globalStorageDir: path.join(world.fixture.root, `global-${clone}`) };
}

// The member joined with their final role, so the first key is one call away; the cap is the allocation.
async function withFirstKey(world: World): Promise<string> {
  const first = await deliverMemberKey({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org: world.org, checklist: world.checklist });
  assert.equal(first.ok, true, first.ok ? '' : first.message);
  return first.ok ? first.keyId : '';
}

const leadInput = (world: World) => ({ log: world.a.log, teamFile: world.teamFile, memberId: world.memberId, org: world.org, checklist: world.checklist });

function sealedDevicesOfLastKeyEvent(entries: TeamEvent[]): string[] {
  const last = [...entries].reverse().find((event): event is TeamEvent<'member.key-sealed'> => event.type === 'member.key-sealed');
  return (last?.body.sealed ?? []).map((entry) => entry.device).sort();
}

async function acceptedEvents(client: Client): Promise<TeamEvent[]> {
  const events: TeamEvent[] = [];
  for (const entry of await client.transport.readAll()) {
    const parsed = parseEventFile(entry);
    if (parsed.ok) events.push(parsed.event);
  }
  return events;
}

test('adding a device gives a new key with the remaining cap, then revoking it gives another sealed to the one device left', async () => {
  await inWorld(['a', 'b', 'c'], { role: 'observer', allocation: 5 * GIGA }, async (world) => {
    const oldKeyId = await withFirstKey(world);
    world.fake.addUsage(oldKeyId, 1_200_000_000);
    await world.first.client.log.sync();
    assert.equal((await installDeliveredKey(installFor(world, world.first))).status, 'installed');
    const oldSecret = world.fake.key(oldKeyId)?.secret ?? '';

    const second = await addDevice(world, 'c');
    assert.equal(keyNeedsRotation(memberOf(world)), true);
    assert.deepEqual(memberAttention(world.a.log.state(), true), [{ memberId: world.memberId, kind: 'rotate-key' }]);

    const rotated = await rotateMemberKey(leadInput(world));
    assert.equal(rotated.ok, true, rotated.ok ? '' : rotated.message);
    if (!rotated.ok) return;
    const newKeyId = rotated.keyId;
    assert.notEqual(newKeyId, oldKeyId);
    // 5 USD minus 1.2 USD already spent.
    assert.equal(world.fake.key(newKeyId)?.spendLimitNanoUsd, 3_800_000_000);
    assert.equal(world.fake.key(oldKeyId)?.spendLimitNanoUsd, 0);
    assert.equal(world.fake.key(oldKeyId)?.revoked, true);
    // Order: the new key is made and delivered before the old one is touched, and the old one is zeroed before it is revoked.
    const trail = world.fake.requests
      .filter((request) => request.path.includes('/api-keys') && request.method !== 'GET')
      .map((request) => `${request.method} ${request.path.endsWith('/spend-limit') ? 'limit' : request.path.endsWith('/api-keys') ? 'create' : 'key'}${request.path.includes(oldKeyId) ? ' old' : ''}`);
    assert.deepEqual(trail, ['POST create', 'POST create', 'PATCH limit old', 'DELETE key old']);

    const member = memberOf(world);
    assert.equal(member.nearApiKeyId, newKeyId);
    assert.deepEqual(member.retiredNearKeyIds, [oldKeyId]);
    assert.deepEqual(member.nearKeyDevices, [world.first.identity.fingerprint, second.identity.fingerprint].sort());
    assert.equal(keyNeedsRotation(member), false);
    assert.deepEqual(sealedDevicesOfLastKeyEvent(await acceptedEvents(world.a)), [world.first.identity.fingerprint, second.identity.fingerprint].sort());
    assert.deepEqual(await world.checklist.list(), []);

    // Both computers install the newest key.
    await world.first.client.log.sync();
    await second.client.log.sync();
    assert.deepEqual(await installDeliveredKey(installFor(world, world.first)), { status: 'installed', keyId: newKeyId });
    assert.deepEqual(await installDeliveredKey(installFor(world, second)), { status: 'installed', keyId: newKeyId });
    const newSecret = world.fake.key(newKeyId)?.secret ?? '';
    assert.equal((await activeKeyOf(world, world.first)).key, newSecret);
    assert.equal((await activeKeyOf(world, second)).key, newSecret);
    await assertKeyNowhere(world, oldSecret);
    await assertKeyNowhere(world, newSecret);

    // The second device is revoked: the next key is for the remaining device only, capped at what the second key had left.
    world.fake.addUsage(newKeyId, 500_000_000);
    await world.first.client.log.sync();
    const revoked = await world.first.client.log.append(() => [{ type: 'device.revoked', body: { memberId: world.memberId, fingerprint: second.identity.fingerprint } }]);
    assert.equal(revoked.ok, true, revoked.ok ? '' : revoked.reason);
    await world.a.log.sync();
    assert.equal(keyNeedsRotation(memberOf(world)), true);
    const third = await rotateMemberKey(leadInput(world));
    assert.equal(third.ok, true, third.ok ? '' : third.message);
    if (!third.ok) return;
    assert.equal(world.fake.key(third.keyId)?.spendLimitNanoUsd, 3_300_000_000);
    assert.equal(world.fake.key(newKeyId)?.revoked, true);
    assert.deepEqual(sealedDevicesOfLastKeyEvent(await acceptedEvents(world.a)), [world.first.identity.fingerprint]);
    assert.deepEqual(memberOf(world).retiredNearKeyIds, [oldKeyId, newKeyId]);
    await world.first.client.log.sync();
    await second.client.log.sync();
    assert.deepEqual(await installDeliveredKey(installFor(world, world.first)), { status: 'installed', keyId: third.keyId });
    assert.deepEqual(await installDeliveredKey(installFor(world, second)), { status: 'not-for-this-device' });
  });
});

test('the new cap is the old cap minus lifetime usage, never below zero, including usage that meets or passes the old cap', async () => {
  const cases: Array<{ usage: number; expected: number }> = [
    { usage: 0, expected: 5 * GIGA },
    { usage: 1_200_000_000, expected: 3_800_000_000 },
    { usage: 5 * GIGA - 1, expected: 1 },
    { usage: 5 * GIGA, expected: 0 },
    { usage: 7 * GIGA, expected: 0 }
  ];
  for (const { usage, expected } of cases) {
    await inWorld(['a', 'b', 'c'], { role: 'observer', allocation: 5 * GIGA }, async (world) => {
      const oldKeyId = await withFirstKey(world);
      if (usage > 0) world.fake.addUsage(oldKeyId, usage);
      await addDevice(world, 'c');
      const rotated = await rotateMemberKey(leadInput(world));
      assert.equal(rotated.ok, true, `usage ${usage}: ${rotated.ok ? '' : rotated.message}`);
      if (!rotated.ok) return;
      assert.equal(world.fake.key(rotated.keyId)?.spendLimitNanoUsd, expected, `usage ${usage}`);
      assert.equal(world.fake.key(oldKeyId)?.revoked, true);
      assert.equal(world.fake.key(oldKeyId)?.spendLimitNanoUsd, 0);
    });
  }
});

test('an old key NEAR no longer has gives the new key a cap of 0 and a manual note, and the rotation still completes', async () => {
  await inWorld(['a', 'b', 'c'], { role: 'observer', allocation: 5 * GIGA }, async (world) => {
    const oldKeyId = await withFirstKey(world);
    assert.equal(await world.org.revokeKey('ws-1', oldKeyId), 'revoked');
    await addDevice(world, 'c');
    const rotated = await rotateMemberKey(leadInput(world));
    assert.equal(rotated.ok, true, rotated.ok ? '' : rotated.message);
    if (!rotated.ok) return;
    assert.equal(world.fake.key(rotated.keyId)?.spendLimitNanoUsd, 0);
    const items = await world.checklist.list();
    // CR-01: the old key NEAR does not list is also a manual revoke item for the NEAR console, never counted as revoked.
    assert.deepEqual(items.map((item) => [item.step, item.status, item.keyId]), [['revoke-key', 'manual', oldKeyId], ['rotate-key', 'manual', oldKeyId]]);
    assert.match(items[0]?.lastError ?? '', /NEAR console/);
    assert.ok((items[1]?.lastError ?? '').length > 0, 'the note says what to check');
    assert.match(rotated.notice ?? '', /limit of 0/);
    assert.equal(memberOf(world).nearApiKeyId, rotated.keyId);
  });
});

test('an old key that cannot be revoked is listed by id, and one that cannot be zeroed but is revoked needs no item', async () => {
  await inWorld(['a', 'b', 'c'], { role: 'observer', allocation: 5 * GIGA }, async (world) => {
    const oldKeyId = await withFirstKey(world);
    await addDevice(world, 'c');
    world.fake.fail({ method: 'DELETE', pathPrefix: '/v1/workspaces/ws-1/api-keys', status: 500, times: 20 });
    const rotated = await rotateMemberKey(leadInput(world));
    assert.equal(rotated.ok, true, rotated.ok ? '' : rotated.message);
    if (!rotated.ok) return;
    assert.equal(memberOf(world).nearApiKeyId, rotated.keyId, 'the delivery stands');
    assert.equal(world.fake.key(oldKeyId)?.spendLimitNanoUsd, 0, 'the old key is at least zeroed');
    assert.equal(world.fake.key(oldKeyId)?.revoked, false);
    const items = await world.checklist.list();
    assert.deepEqual(items.map((item) => [item.step, item.status, item.keyId]), [['revoke-key', 'failed', oldKeyId]]);
    assert.match(rotated.notice ?? '', /revoke/i);
  });
  await inWorld(['a', 'b', 'c'], { role: 'observer', allocation: 5 * GIGA }, async (world) => {
    const oldKeyId = await withFirstKey(world);
    await addDevice(world, 'c');
    world.fake.fail({ method: 'PATCH', pathPrefix: '/v1/workspaces/ws-1/api-keys', status: 500, times: 20 });
    const rotated = await rotateMemberKey(leadInput(world));
    assert.equal(rotated.ok, true, rotated.ok ? '' : rotated.message);
    assert.equal(world.fake.key(oldKeyId)?.revoked, true);
    assert.deepEqual(await world.checklist.list(), []);
  });
});

test('a failure while making the new key leaves the old key working and puts rotate-key on the list', async () => {
  await inWorld(['a', 'b', 'c'], { role: 'observer', allocation: 5 * GIGA }, async (world) => {
    const oldKeyId = await withFirstKey(world);
    await addDevice(world, 'c');
    world.fake.fail({ method: 'POST', pathPrefix: '/v1/workspaces/ws-1/api-keys', status: 500, times: 1 });
    const failed = await rotateMemberKey(leadInput(world));
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.code, 'near');
    assert.equal(world.fake.key(oldKeyId)?.revoked, false);
    assert.equal(world.fake.key(oldKeyId)?.spendLimitNanoUsd, 5 * GIGA);
    assert.equal(memberOf(world).nearApiKeyId, oldKeyId);
    const items = await world.checklist.list();
    assert.deepEqual(items.map((item) => [item.step, item.status]), [['rotate-key', 'failed']]);
    const retried = await rotateMemberKey(leadInput(world));
    assert.equal(retried.ok, true, retried.ok ? '' : retried.message);
    assert.deepEqual((await world.checklist.list()).map((item) => [item.step, item.status]), [['rotate-key', 'done']]);
  });
});

test('a member with no device left that can receive a key is told so, nothing is made, and the old key is not touched', async () => {
  await inWorld(['a', 'b', 'c'], { role: 'observer', allocation: 5 * GIGA }, async (world) => {
    const oldKeyId = await withFirstKey(world);
    const plain = await addDevice(world, 'c', false);
    const revoked = await plain.client.log.append(() => [{ type: 'device.revoked', body: { memberId: world.memberId, fingerprint: world.first.identity.fingerprint } }]);
    assert.equal(revoked.ok, true, revoked.ok ? '' : revoked.reason);
    await world.a.log.sync();
    assert.equal(keyNeedsRotation(memberOf(world)), true);
    assert.deepEqual(memberAttention(world.a.log.state(), true), [{ memberId: world.memberId, kind: 'rotate-key' }]);
    const result = await rotateMemberKey(leadInput(world));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'no-device');
      assert.match(result.message, /no device that can receive a new key/);
      assert.match(result.message, /old key stays valid/);
    }
    assert.equal(world.fake.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/api-keys')).length, 1, 'no second key was made');
    assert.equal(world.fake.key(oldKeyId)?.revoked, false);
    assert.deepEqual((await world.checklist.list()).map((item) => [item.step, item.status]), [['rotate-key', 'failed']]);
  });
});

test('rotation is refused when the key already matches the devices, and for a member who never had a key', async () => {
  await inWorld(['a', 'b'], { role: 'observer' }, async (world) => {
    const never = await rotateMemberKey(leadInput(world));
    assert.equal(never.ok, false);
    await withFirstKey(world);
    const current = await rotateMemberKey(leadInput(world));
    assert.equal(current.ok, false);
    if (!current.ok) assert.equal(current.code, 'log');
    assert.equal(world.fake.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/api-keys')).length, 1);
    assert.deepEqual(await world.checklist.list(), []);
  });
});
