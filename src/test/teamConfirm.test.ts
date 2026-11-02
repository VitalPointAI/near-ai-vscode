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
import { expectedJoinRole, joinProofBytes, memberAttention } from '../domain/team/invite';
import { teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import { parseEventFile } from '../domain/team/validate';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { GenesisAnchor, MemberInvitedBody, MemberJoinedBody, Role, TeamFile, TeamState } from '../domain/team/types';
import { CleanupChecklist } from '../team/cleanupChecklist';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { createDeviceIdentity, createSealIdentity, emailHash, newMemberId, newTeamId } from '../team/identity';
import type { DeviceIdentity, SealIdentity } from '../team/identity';
import { deriveInviteKey, generateInviteCode } from '../team/inviteCode';
import { confirmMember, installDeliveredKey, teamKeyName } from '../team/keyDelivery';
import { NearOrgClient } from '../team/nearOrg';
import type { NearAuth } from '../team/nearOrg';
import { canonicalTeamFile, teamStorageDir } from '../team/teamFile';
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
    org: new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(lead.accessToken), sleep: noSleep }),
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
