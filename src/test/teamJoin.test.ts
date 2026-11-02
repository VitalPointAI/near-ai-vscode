// The invitee's side of joining a team (Phase 61 plan 09) over two real clones and the fake NEAR server. A lead invites through inviteMember,
// the invitee pastes the bundle, prepareJoin decides ready or clone-needed, and joinTeam writes member.joined. Emails use .invalid addresses.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { DEFAULT_INVITE_TTL_SECONDS, INVITE_SKEW_SECONDS, memberAttention } from '../domain/team/invite';
import { teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import type { GenesisAnchor, TeamFile, TeamState } from '../domain/team/types';
import { AuthService } from '../services/auth';
import { ProfileStore } from '../services/profileStore';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { createDeviceIdentity, deviceKeySecretName, emailHash, loadSealIdentity, newTeamId, sealKeySecretName } from '../team/identity';
import { inviteMember } from '../team/invite';
import type { InviteInput } from '../team/invite';
import { encodeInviteBundle, parseInviteBundle } from '../team/inviteBundle';
import { generateInviteCode } from '../team/inviteCode';
import { NO_ORG_NOTICE, joinTeam, prepareJoin } from '../team/join';
import type { JoinInput, JoinPreparation } from '../team/join';
import { NearOrgClient } from '../team/nearOrg';
import type { NearAuth } from '../team/nearOrg';
import { nearSessionSecretName } from '../team/nearSession';
import { teamProfileId } from '../team/teamKeyProfile';
import type { GitRunner } from '../team/runGit';
import { canonicalTeamFile, writeTeamFile } from '../team/teamFile';
import { startFakeNear } from './helpers/fakeNear';
import type { FakeNear } from './helpers/fakeNear';
import { MemorySecrets, createOwner, createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture, TestOwner } from './helpers/teamHarness';

const fixedNow = (): Date => new Date('2026-02-03T04:05:06.000Z');
const PUBLIC_URL = 'https://example.invalid/team.git';
const NEAR_LINK = { organizationId: 'org-1', workspaceId: 'ws-1' };

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

interface Seed { teamId: string; owner: TestOwner; signer: TeamSigner; anchor: GenesisAnchor; teamFile: TeamFile; a: Client; globalStorageDir: string }

// Clone a writes the genesis through the transport, exactly as Enable Team Mode does.
async function seedTeam(fixture: TeamFixture, near?: TeamFile['near'], policyOverride?: { requireLeadConfirmation: boolean }): Promise<Seed> {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const policy = { ...defaultTeamPolicy(), ...(policyOverride ?? {}) };
  const genesis = buildGenesisEvents({
    teamId, teamName: 'Join flow team', owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [emailHash(teamId, 'owner@example.invalid')] },
    identity: owner.identity, policy, ...(near === undefined ? {} : { near }), now: fixedNow
  });
  const teamFile: TeamFile = {
    version: 1, teamId, name: 'Join flow team', coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: genesis.anchor.eventId, ownerDevice: genesis.anchor.ownerDevice }, ...(near === undefined ? {} : { near }), createdAt: '2026-02-03T04:05:06.000Z'
  };
  const signer: TeamSigner = { identity: owner.identity, memberId: owner.memberId };
  const a = clientFor(fixture, 'a', genesis.anchor, signer);
  const written = await a.transport.append(async () => genesis.events, { genesis: { teamFileText: canonicalTeamFile(teamFile) } });
  assert.equal(written.ok, true);
  return { teamId, owner, signer, anchor: genesis.anchor, teamFile, a, globalStorageDir: path.join(fixture.root, 'global-a') };
}

// The project's origin is configured as a public-looking URL and git is told where it really is, so the bundle carries the public one.
function pointOriginAt(fixture: TeamFixture, url: string): void {
  const clone = fixture.clones['a'] as string;
  gitIn(clone, ['config', `url.${fixture.remote}.insteadOf`, url]);
  gitIn(clone, ['remote', 'set-url', 'origin', url]);
}

function inviteInput(fixture: TeamFixture, seed: Seed, overrides: Partial<InviteInput> = {}): InviteInput {
  return {
    projectRoot: fixture.clones['a'] as string, globalStorageDir: seed.globalStorageDir, teamFile: seed.teamFile, log: seed.a.log,
    name: 'Dana Developer', email: 'dana@example.invalid', role: 'developer', allocationNanoUsd: 5_000_000_000, ttlSeconds: DEFAULT_INVITE_TTL_SECONDS, ...overrides
  };
}

async function invite(fixture: TeamFixture, seed: Seed, overrides: Partial<InviteInput> = {}): Promise<{ bundle: string; memberId: string }> {
  const result = await inviteMember(inviteInput(fixture, seed, overrides));
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  if (!result.ok) throw new Error('invite failed');
  return { bundle: result.bundle, memberId: result.memberId };
}

// What the second computer has: a clone that already holds team.json (the lead pushed it) and its own empty SecretStorage.
interface Joiner { name: string; projectRoot: string; globalStorageDir: string; secrets: MemorySecrets }

async function joinerOn(fixture: TeamFixture, name: string, seed: Seed): Promise<Joiner> {
  const projectRoot = fixture.clones[name] as string;
  await writeTeamFile(projectRoot, seed.teamFile);
  return { name, projectRoot, globalStorageDir: path.join(fixture.root, `global-${name}`), secrets: new MemorySecrets() };
}

async function readyFor(joiner: Joiner, bundleText: string): Promise<Extract<JoinPreparation, { kind: 'ready' }>> {
  const prepared = await prepareJoin({ projectRoot: joiner.projectRoot, bundleText });
  assert.equal(prepared.kind, 'ready', prepared.kind === 'refused' ? prepared.message : prepared.kind);
  if (prepared.kind !== 'ready') throw new Error('not ready');
  return prepared;
}

function joinInput(joiner: Joiner, prepared: Extract<JoinPreparation, { kind: 'ready' }>, overrides: Partial<JoinInput> = {}): JoinInput {
  return {
    projectRoot: joiner.projectRoot, globalStorageDir: joiner.globalStorageDir, teamFile: prepared.teamFile, bundle: prepared.bundle,
    ...(prepared.near === undefined ? {} : { near: prepared.near }), secrets: joiner.secrets, displayName: 'Dana', ...overrides
  };
}

async function withNearFake(run: (fake: FakeNear) => Promise<void>): Promise<void> {
  const fake = await startFakeNear();
  try {
    fake.addUser({ id: 'user-lead', username: 'lead', email: 'lead@example.invalid' });
    fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-lead', role: 'owner' }] });
    fake.addWorkspace({ id: 'ws-1', organizationId: 'org-1', name: 'Team workspace' });
    await run(fake);
  } finally {
    await fake.close();
  }
}

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(full)));
    else found.push(full);
  }
  return found;
}

// ---- Task 1: prepareJoin and a developer joining a NEAR-linked team -----------------------------------------------------------------------

test('prepareJoin answers clone-needed without a folder or with another team, ready for the matching folder, and refused for a damaged bundle', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    pointOriginAt(fixture, PUBLIC_URL);
    const { bundle } = await invite(fixture, seed);

    const noFolder = await prepareJoin({ projectRoot: undefined, bundleText: bundle });
    assert.deepEqual(noFolder, { kind: 'clone-needed', repoUrl: PUBLIC_URL, teamId: seed.teamId });

    // A folder with no team.json is not the team's project yet.
    const bare = await prepareJoin({ projectRoot: fixture.clones['b'] as string, bundleText: bundle });
    assert.deepEqual(bare, { kind: 'clone-needed', repoUrl: PUBLIC_URL, teamId: seed.teamId });

    // A folder whose team.json names another team is not this team's project either.
    await writeTeamFile(fixture.clones['b'] as string, { ...seed.teamFile, teamId: newTeamId() });
    const other = await prepareJoin({ projectRoot: fixture.clones['b'] as string, bundleText: bundle });
    assert.equal(other.kind, 'clone-needed');

    await writeTeamFile(fixture.clones['b'] as string, seed.teamFile);
    const ready = await prepareJoin({ projectRoot: fixture.clones['b'] as string, bundleText: `  ${bundle}\n` });
    assert.equal(ready.kind, 'ready');
    if (ready.kind === 'ready') {
      assert.equal(ready.bundle.team, seed.teamId);
      assert.equal(ready.teamFile.teamId, seed.teamId);
      assert.equal(ready.near, undefined);
    }

    const damaged = await prepareJoin({ projectRoot: fixture.clones['b'] as string, bundleText: 'near-ai-invite-v1.%%%' });
    assert.equal(damaged.kind, 'refused');
    const notInvite = await prepareJoin({ projectRoot: fixture.clones['b'] as string, bundleText: 'hello there' });
    assert.equal(notInvite.kind, 'refused');
    if (notInvite.kind === 'refused') assert.equal(notInvite.message.includes('hello there'), false, 'the pasted text is never echoed');
  });
});

test('prepareJoin takes the NEAR link only from team.json, refuses a bundle link team.json does not have (WR-03), and refuses when they disagree', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const linked = await seedTeam(fixture, NEAR_LINK);
    pointOriginAt(fixture, PUBLIC_URL);
    const { bundle } = await invite(fixture, linked);
    const joiner = await joinerOn(fixture, 'b', linked);
    const ready = await prepareJoin({ projectRoot: joiner.projectRoot, bundleText: bundle });
    assert.equal(ready.kind === 'ready' && ready.near?.organizationId, 'org-1');

    // WR-03: the bundle has no MAC, so its link is never trusted on its own. A team.json without a link (the lead's link commit was not
    // pulled, or someone changed the bundle) is refused before anything is written, with what to do next.
    const { near: _dropped, ...withoutNear } = linked.teamFile;
    await writeTeamFile(joiner.projectRoot, withoutNear);
    const fallback = await prepareJoin({ projectRoot: joiner.projectRoot, bundleText: bundle });
    assert.equal(fallback.kind, 'refused');
    if (fallback.kind === 'refused') assert.match(fallback.message, /push the NEAR link/);
    const direct = await joinTeam({
      projectRoot: joiner.projectRoot, globalStorageDir: joiner.globalStorageDir, teamFile: withoutNear, bundle: parseInviteBundle(bundle), near: NEAR_LINK,
      secrets: joiner.secrets, displayName: 'Dana'
    });
    assert.equal(direct.ok, false);
    if (!direct.ok) assert.equal(direct.code, 'team-file');
    assert.equal(joiner.secrets.values.size, 0, 'no device or seal key was made');

    // Two different links are never merged: the join is refused.
    await writeTeamFile(joiner.projectRoot, { ...linked.teamFile, near: { organizationId: 'org-2', workspaceId: 'ws-9' } });
    const clash = await prepareJoin({ projectRoot: joiner.projectRoot, bundleText: bundle });
    assert.equal(clash.kind, 'refused');

    // A bundle for another coordination branch than the project's is refused as well.
    await writeTeamFile(joiner.projectRoot, linked.teamFile);
    const parsed = parseInviteBundle(bundle);
    const otherRef = encodeInviteBundle({ ...parsed, ref: 'refs/heads/near-ai/other' });
    const refClash = await prepareJoin({ projectRoot: joiner.projectRoot, bundleText: otherRef });
    assert.equal(refClash.kind, 'refused');
  });
});

test('tracer: a developer joins a NEAR-linked team from a second clone with no NEAR request, and the lead sees them waiting', async () => {
  await withNearFake(async (fake) => {
    await withFixture(['a', 'b'], async (fixture) => {
      const seed = await seedTeam(fixture, NEAR_LINK);
      pointOriginAt(fixture, PUBLIC_URL);
      const { bundle, memberId } = await invite(fixture, seed);
      const joiner = await joinerOn(fixture, 'b', seed);
      const prepared = await readyFor(joiner, bundle);

      const before = fake.requests.length;
      const result = await joinTeam(joinInput(joiner, prepared, { nearBaseUrl: fake.baseUrl }));
      assert.equal(result.ok, true, result.ok ? '' : result.message);
      if (!result.ok) return;
      assert.equal(fake.requests.length, before, 'the developer made no request to NEAR');
      assert.equal(result.memberId, memberId);
      assert.equal(result.role, 'observer');
      assert.equal(result.pendingRole, 'developer');
      assert.equal(result.key, 'awaiting-lead');
      assert.equal(result.nearInvitation, undefined);
      assert.ok(result.notices.some((notice) => /lead/i.test(notice)), 'the result says the lead sends the team key');
      assert.equal(result.notices.includes(NO_ORG_NOTICE), false);

      // Only the two device keys exist: no NEAR session, no team key.
      assert.deepEqual([...joiner.secrets.values.keys()].sort(), [deviceKeySecretName(seed.teamId), sealKeySecretName(seed.teamId)].sort());
      assert.equal(joiner.secrets.values.has(nearSessionSecretName(seed.teamId)), false);

      // The lead's clone syncs and its attention list asks for a confirmation; the member's device has a seal key.
      const synced = await seed.a.log.sync();
      assert.deepEqual(synced.rejected, []);
      const state = seed.a.log.state();
      assert.deepEqual(memberAttention(state, true), [{ memberId, kind: 'confirm' }]);
      const member = state.members.get(memberId);
      assert.equal(member?.name, 'Dana');
      assert.equal(member?.role, 'observer');
      assert.equal(member?.pendingRole, 'developer');
      assert.equal(member?.status, undefined);
      const seal = await loadSealIdentity(joiner.secrets, seed.teamId);
      assert.equal(member?.devices.length, 1);
      assert.equal(member?.devices[0]?.sealKey, seal?.publicKey);
    });
  });
});

test('nothing from the bundle is written on the joining computer: no file holds the code or the bundle', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    pointOriginAt(fixture, PUBLIC_URL);
    const { bundle } = await invite(fixture, seed);
    const code = parseInviteBundle(bundle).code;
    const joiner = await joinerOn(fixture, 'b', seed);
    const prepared = await readyFor(joiner, bundle);
    const result = await joinTeam(joinInput(joiner, prepared));
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    const files = [...(await filesUnder(joiner.globalStorageDir)), ...(await filesUnder(joiner.projectRoot)).filter((file) => !file.includes(`${path.sep}.git${path.sep}`))];
    assert.ok(files.length > 0);
    for (const file of files) {
      const text = await fs.readFile(file);
      assert.equal(text.includes(Buffer.from(code)), false, `${file} holds the code`);
      assert.equal(text.includes(Buffer.from(bundle)), false, `${file} holds the bundle`);
    }
    for (const value of joiner.secrets.values.values()) assert.equal(value.includes(code), false, 'SecretStorage holds the code');
  });
});

// ---- Task 2: a lead invitee, the no-organization paste path, and rollback --------------------------------------------------------------

const NO_SLEEP = async (): Promise<void> => undefined;

function staticAuth(token: string): NearAuth {
  return { accessToken: async () => token, refreshAfterUnauthorized: async () => undefined };
}

function everyObject(remote: string): Buffer {
  return execFileSync('git', ['-C', remote, 'cat-file', '--batch-all-objects', '--batch'], { maxBuffer: 64 * 1024 * 1024 });
}

async function inviteLead(fixture: TeamFixture, seed: Seed, org: NearOrgClient, email = 'lena@example.invalid'): Promise<{ bundle: string; memberId: string }> {
  return invite(fixture, seed, { role: 'lead', name: 'Lena Lead', email, org });
}

test('a lead joining a NEAR-linked team signs in, accepts the organization invitation as admin and keeps the per-team session', async () => {
  await withNearFake(async (fake) => {
    await withFixture(['a', 'b'], async (fixture) => {
      const seed = await seedTeam(fixture, NEAR_LINK);
      pointOriginAt(fixture, PUBLIC_URL);
      const leadTokens = fake.addUser({ id: 'user-lena', username: 'lena', email: 'lena@example.invalid' });
      const ownerSession = fake.addUser({ id: 'user-inviter', username: 'inviter', email: 'inviter@example.invalid' });
      fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-lead', role: 'owner' }, { userId: 'user-inviter', role: 'owner' }] });
      const inviter = new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(ownerSession.accessToken), sleep: NO_SLEEP });
      const { bundle, memberId } = await inviteLead(fixture, seed, inviter);
      const joiner = await joinerOn(fixture, 'b', seed);
      const prepared = await readyFor(joiner, bundle);

      let signIns = 0;
      const result = await joinTeam(joinInput(joiner, prepared, { nearBaseUrl: fake.baseUrl, signIn: async () => { signIns += 1; return leadTokens; } }));
      assert.equal(result.ok, true, result.ok ? '' : result.message);
      if (!result.ok) return;
      assert.equal(signIns, 1);
      assert.equal(result.memberId, memberId);
      assert.equal(result.nearInvitation, 'accepted');
      assert.equal(result.key, 'awaiting-lead');
      assert.equal(result.role, 'observer');
      assert.equal(result.pendingRole, 'lead');

      // The fake shows the lead as an organization admin, and the per-team session is stored with the NEAR login as its label.
      const members = await inviter.listMembers('org-1');
      assert.equal(members.find((member) => member.userId === 'user-lena')?.role, 'admin');
      const stored = joiner.secrets.values.get(nearSessionSecretName(seed.teamId));
      assert.ok(stored !== undefined);
      assert.equal((JSON.parse(stored ?? '{}') as { label?: string }).label, 'lena');
      for (const notice of result.notices) {
        assert.equal(notice.includes(leadTokens.accessToken) || notice.includes(leadTokens.refreshToken), false);
      }
    });
  });
});

test('a lead whose invitation list cannot be read accepts with the emailed link, and a lead with no matching invitation still joins with a plain notice', async () => {
  await withNearFake(async (fake) => {
    await withFixture(['a', 'b', 'c', 'd'], async (fixture) => {
      const seed = await seedTeam(fixture, NEAR_LINK);
      pointOriginAt(fixture, PUBLIC_URL);
      const ownerSession = fake.addUser({ id: 'user-inviter', username: 'inviter', email: 'inviter@example.invalid' });
      fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-lead', role: 'owner' }, { userId: 'user-inviter', role: 'owner' }] });
      const inviter = new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(ownerSession.accessToken), sleep: NO_SLEEP });
      const first = await inviteLead(fixture, seed, inviter, 'lena@example.invalid');
      const second = await invite(fixture, seed, { role: 'lead', name: 'Sam Second', email: 'sam@example.invalid' });
      const third = await inviteLead(fixture, seed, inviter, 'tess@example.invalid');
      const token = fake.emailedToken('lena@example.invalid');
      assert.ok(token !== undefined);

      // The list route answers 404 once, so the emailed link (pasted as the address NEAR sends) is used.
      const lena = fake.addUser({ id: 'user-lena', username: 'lena', email: 'lena@example.invalid' });
      fake.fail({ method: 'GET', pathPrefix: '/v1/users/me/invitations', status: 404, times: 1 });
      const joinerB = await joinerOn(fixture, 'b', seed);
      const viaToken = await joinTeam(joinInput(joinerB, await readyFor(joinerB, first.bundle), {
        nearBaseUrl: fake.baseUrl, signIn: async () => lena, askInvitationLink: async () => `https://cloud.example.invalid/invitations/${token ?? ''}/accept`
      }));
      assert.equal(viaToken.ok && viaToken.nearInvitation, 'accepted');
      assert.equal((await inviter.listMembers('org-1')).some((member) => member.userId === 'user-lena'), true);
      assert.equal(viaToken.ok && viaToken.notices.join(' ').includes(token ?? ''), false, 'the emailed token is never shown');

      // A login with another email has no invitation, and no link is handed over: the join is done, and the notice says what to do.
      const otherLogin = fake.addUser({ id: 'user-sam-work', username: 'samwork', email: 'sam.work@example.invalid' });
      const joinerC = await joinerOn(fixture, 'c', seed);
      const notFound = await joinTeam(joinInput(joinerC, await readyFor(joinerC, second.bundle), {
        nearBaseUrl: fake.baseUrl, signIn: async () => otherLogin, askInvitationLink: async () => undefined
      }));
      assert.equal(notFound.ok, true, notFound.ok ? '' : notFound.message);
      if (!notFound.ok) return;
      assert.equal(notFound.nearInvitation, 'not-found');
      assert.ok(notFound.notices.some((notice) => /sign in with the email/i.test(notice) && /invite your NEAR/i.test(notice)));
      assert.equal(notFound.pendingRole, 'lead', 'the team join stands');

      // The emailed token only works for the address it was sent to: NEAR refuses it for another login, and the join still stands.
      const tessToken = fake.emailedToken('tess@example.invalid');
      const wrongLogin = fake.addUser({ id: 'user-tess-work', username: 'tesswork', email: 'tess.work@example.invalid' });
      const joinerD = await joinerOn(fixture, 'd', seed);
      const refused = await joinTeam(joinInput(joinerD, await readyFor(joinerD, third.bundle), {
        nearBaseUrl: fake.baseUrl, signIn: async () => wrongLogin, askInvitationLink: async () => tessToken
      }));
      assert.equal(refused.ok && refused.nearInvitation, 'failed');
      assert.equal(refused.ok && refused.notices.join(' ').includes(tessToken ?? ''), false);
    });
  });
});

test('a lead who is already an organization member is told so, a skipped sign-in is skipped, and a NEAR failure never undoes the join', async () => {
  await withNearFake(async (fake) => {
    await withFixture(['a', 'b', 'c', 'd'], async (fixture) => {
      const seed = await seedTeam(fixture, NEAR_LINK);
      pointOriginAt(fixture, PUBLIC_URL);
      const member = fake.addUser({ id: 'user-already', username: 'already', email: 'already@example.invalid' });
      const ownerSession = fake.addUser({ id: 'user-inviter', username: 'inviter', email: 'inviter@example.invalid' });
      fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-lead', role: 'owner' }, { userId: 'user-already', role: 'admin' }, { userId: 'user-inviter', role: 'owner' }] });
      const inviter = new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(ownerSession.accessToken), sleep: NO_SLEEP });
      const one = await invite(fixture, seed, { role: 'lead', name: 'Al Ready', email: 'already@example.invalid' });
      const two = await invite(fixture, seed, { role: 'lead', name: 'Si Kip', email: 'skip@example.invalid' });
      const three = await inviteLead(fixture, seed, inviter, 'failure@example.invalid');

      const joinerB = await joinerOn(fixture, 'b', seed);
      const already = await joinTeam(joinInput(joinerB, await readyFor(joinerB, one.bundle), { nearBaseUrl: fake.baseUrl, signIn: async () => member }));
      assert.equal(already.ok && already.nearInvitation, 'already-member');
      assert.ok(joinerB.secrets.values.has(nearSessionSecretName(seed.teamId)), 'the session is kept for an existing member too');

      const joinerC = await joinerOn(fixture, 'c', seed);
      const skipped = await joinTeam(joinInput(joinerC, await readyFor(joinerC, two.bundle), { nearBaseUrl: fake.baseUrl, signIn: async () => undefined }));
      assert.equal(skipped.ok && skipped.nearInvitation, 'skipped');
      assert.ok(skipped.ok && skipped.notices.some((notice) => /sign in/i.test(notice)));
      assert.equal(joinerC.secrets.values.has(nearSessionSecretName(seed.teamId)), false, 'no session without a sign-in');

      // NEAR answers a server error on the accept call: the join stays done, the notice is plain, and no token is in it.
      const failing = fake.addUser({ id: 'user-failure', username: 'failure', email: 'failure@example.invalid' });
      fake.fail({ method: 'POST', pathPrefix: '/v1/users/me/invitations/', status: 500, times: 10, message: `broken ${failing.accessToken}` });
      const joinerD = await joinerOn(fixture, 'd', seed);
      const failed = await joinTeam(joinInput(joinerD, await readyFor(joinerD, three.bundle), { nearBaseUrl: fake.baseUrl, signIn: async () => failing }));
      assert.equal(failed.ok, true, failed.ok ? '' : failed.message);
      if (!failed.ok) return;
      assert.equal(failed.nearInvitation, 'failed');
      assert.ok(failed.notices.some((notice) => /NEAR/.test(notice)));
      assert.equal(failed.notices.join(' ').includes(failing.accessToken), false);
      await seed.a.log.sync();
      assert.equal(seed.a.log.state().members.get(three.memberId)?.status, undefined, 'the member joined');
    });
  });
});

test('a lead is never joined to a different organization than the team\'s, even when that organization has invited their login', async () => {
  await withNearFake(async (fake) => {
    await withFixture(['a', 'b'], async (fixture) => {
      const seed = await seedTeam(fixture, NEAR_LINK);
      pointOriginAt(fixture, PUBLIC_URL);
      // Another organization invited this login; the team's own organization did not.
      const other = fake.addUser({ id: 'user-other-owner', username: 'otherowner', email: 'otherowner@example.invalid' });
      fake.addOrganization({ id: 'org-other', name: 'Someone Else', members: [{ userId: 'user-other-owner', role: 'owner' }] });
      const otherClient = new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(other.accessToken), sleep: NO_SLEEP });
      const outcome = await otherClient.inviteByEmail('org-other', 'lena@example.invalid', 'admin');
      assert.equal(outcome.ok, true);
      const lena = fake.addUser({ id: 'user-lena', username: 'lena', email: 'lena@example.invalid' });
      const { bundle } = await invite(fixture, seed, { role: 'lead', name: 'Lena Lead', email: 'lena@example.invalid' });
      const joiner = await joinerOn(fixture, 'b', seed);
      const result = await joinTeam(joinInput(joiner, await readyFor(joiner, bundle), { nearBaseUrl: fake.baseUrl, signIn: async () => lena }));
      assert.equal(result.ok && result.nearInvitation, 'not-found');
      assert.equal((await otherClient.listMembers('org-other')).some((member) => member.userId === 'user-lena'), false, 'the other organization was not accepted');
      assert.equal(fake.requests.some((request) => request.method === 'POST' && request.path.includes('/accept')), false, 'no accept call was made');
    });
  });
});

test('a team with no NEAR organization checks a pasted key with check_api_key only and installs it with the not-capped notice', async () => {
  await withNearFake(async (fake) => {
    await withFixture(['a', 'b'], async (fixture) => {
      const seed = await seedTeam(fixture);
      pointOriginAt(fixture, PUBLIC_URL);
      const owner = fake.addUser({ id: 'user-keys', username: 'keys', email: 'keys@example.invalid' });
      fake.addOrganization({ id: 'org-keys', name: 'Own Org', members: [{ userId: 'user-keys', role: 'owner' }] });
      fake.addWorkspace({ id: 'ws-keys', organizationId: 'org-keys', name: 'Own workspace' });
      const own = await new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(owner.accessToken), sleep: NO_SLEEP }).createKey('ws-keys', 'my own key', 5_000_000_000);
      const secret = own.secret.toString('utf8');
      const { bundle } = await invite(fixture, seed);
      const joiner = await joinerOn(fixture, 'b', seed);
      const before = fake.requests.length;
      const result = await joinTeam(joinInput(joiner, await readyFor(joiner, bundle), { nearBaseUrl: fake.baseUrl, pasteOwnKey: async () => `  ${secret}\n` }));
      assert.equal(result.ok, true, result.ok ? '' : result.message);
      if (!result.ok) return;
      assert.equal(result.key, 'installed');
      assert.ok(result.notices.includes(NO_ORG_NOTICE));
      assert.equal(result.nearInvitation, undefined);
      // Only check_api_key was asked of NEAR, with the key as the bearer.
      const calls = fake.requests.slice(before);
      assert.ok(calls.length >= 1);
      assert.ok(calls.every((call) => call.path === '/v1/check_api_key' && call.auth === 'api-key'));
      const active = await new ProfileStore(joiner.projectRoot, new AuthService(joiner.secrets)).getActiveSelection();
      assert.equal(active?.profileId, teamProfileId(seed.teamId));
      // Nothing about the key reached the log, the notices or the stored join state.
      assert.equal(everyObject(fixture.remote).includes(Buffer.from(secret)), false);
      assert.equal(result.notices.join(' ').includes(secret), false);
      for (const file of await filesUnder(joiner.globalStorageDir)) assert.equal((await fs.readFile(file)).includes(Buffer.from(secret)), false, `${file} holds the key`);
    });
  });
});

test('a rejected pasted key or none at all leaves the join done and says so plainly; a NEAR-linked team never asks for a key', async () => {
  await withNearFake(async (fake) => {
    await withFixture(['a', 'b', 'c', 'd'], async (fixture) => {
      const seed = await seedTeam(fixture);
      pointOriginAt(fixture, PUBLIC_URL);
      const one = await invite(fixture, seed, { name: 'Ann One', email: 'one@example.invalid' });
      const two = await invite(fixture, seed, { name: 'Bob Two', email: 'two@example.invalid' });
      const joinerB = await joinerOn(fixture, 'b', seed);
      const rejected = await joinTeam(joinInput(joinerB, await readyFor(joinerB, one.bundle), { nearBaseUrl: fake.baseUrl, pasteOwnKey: async () => 'sk-not-a-real-key-0123456789' }));
      assert.equal(rejected.ok, true, rejected.ok ? '' : rejected.message);
      if (!rejected.ok) return;
      assert.equal(rejected.key, 'skipped');
      assert.ok(rejected.notices.includes(NO_ORG_NOTICE));
      assert.ok(rejected.notices.some((notice) => /did not accept/i.test(notice)));
      assert.equal(rejected.notices.join(' ').includes('sk-not-a-real-key'), false);
      assert.equal(await new ProfileStore(joinerB.projectRoot, new AuthService(joinerB.secrets)).getActiveSelection(), undefined);

      const joinerC = await joinerOn(fixture, 'c', seed);
      const none = await joinTeam(joinInput(joinerC, await readyFor(joinerC, two.bundle), { nearBaseUrl: fake.baseUrl, pasteOwnKey: async () => undefined }));
      assert.equal(none.ok && none.key, 'skipped');
      assert.ok(none.ok && none.notices.includes(NO_ORG_NOTICE));
    });
    await withFixture(['a', 'b'], async (fixture) => {
      const seed = await seedTeam(fixture, NEAR_LINK);
      pointOriginAt(fixture, PUBLIC_URL);
      const { bundle } = await invite(fixture, seed);
      const joiner = await joinerOn(fixture, 'b', seed);
      let asked = 0;
      let signIns = 0;
      const tokens = fake.addUser({ id: 'user-dev', username: 'dev', email: 'dana@example.invalid' });
      const before = fake.requests.length;
      const linked = await joinTeam(joinInput(joiner, await readyFor(joiner, bundle), {
        nearBaseUrl: fake.baseUrl,
        pasteOwnKey: async () => { asked += 1; return 'sk-whatever'; },
        signIn: async () => { signIns += 1; return tokens; },
        askInvitationLink: async () => { signIns += 1; return undefined; }
      }));
      assert.equal(linked.ok && linked.key, 'awaiting-lead');
      assert.equal(asked, 0, 'pasting an own key is not offered in a NEAR-linked team');
      // D-21: a developer is never signed in to NEAR, even when the caller hands over a sign-in and the login would match the invited email.
      assert.equal(signIns, 0, 'a developer is never asked to sign in to NEAR');
      assert.equal(fake.requests.length, before);
      assert.equal(joiner.secrets.values.has(nearSessionSecretName(seed.teamId)), false);
    });
  });
});

test('a cancelled, used or unknown invitation, a wrong code and a bad name are refused before any key exists', async () => {
  await withFixture(['a', 'b', 'c'], async (fixture) => {
    const seed = await seedTeam(fixture);
    pointOriginAt(fixture, PUBLIC_URL);
    const cancelled = await invite(fixture, seed, { name: 'Cal Cancelled', email: 'cal@example.invalid' });
    const ok = await invite(fixture, seed, { name: 'Una Used', email: 'una@example.invalid' });
    const removed = await seed.a.log.append(() => [{ type: 'member.removed', body: { memberId: cancelled.memberId } }]);
    assert.equal(removed.ok, true);

    const joinerB = await joinerOn(fixture, 'b', seed);
    const cancelledResult = await joinTeam(joinInput(joinerB, await readyFor(joinerB, cancelled.bundle)));
    assert.equal(cancelledResult.ok === false && cancelledResult.code, 'cancelled');
    assert.equal(joinerB.secrets.values.size, 0);

    // A tampered code is not the one the log recorded; a made-up member id is not on the list.
    const parsed = parseInviteBundle(ok.bundle);
    const wrong = encodeInviteBundle({ ...parsed, code: generateInviteCode().text });
    const wrongResult = await joinTeam(joinInput(joinerB, await readyFor(joinerB, wrong)));
    assert.equal(wrongResult.ok === false && wrongResult.code, 'wrong-code');
    const stranger = encodeInviteBundle({ ...parsed, member: 'mbr-0123456789abcdef' });
    const strangerResult = await joinTeam(joinInput(joinerB, await readyFor(joinerB, stranger)));
    assert.equal(strangerResult.ok === false && strangerResult.code, 'not-invited');

    const badName = await joinTeam(joinInput(joinerB, await readyFor(joinerB, ok.bundle), { displayName: 'two\nlines' }));
    assert.equal(badName.ok === false && badName.code, 'invalid-name');
    assert.equal(joinerB.secrets.values.size, 0, 'no key was made for any refusal');

    // The same invitation joins once and is used afterwards, from any other computer.
    const first = await joinTeam(joinInput(joinerB, await readyFor(joinerB, ok.bundle)));
    assert.equal(first.ok, true, first.ok ? '' : first.message);
    const joinerC = await joinerOn(fixture, 'c', seed);
    const used = await joinTeam(joinInput(joinerC, await readyFor(joinerC, ok.bundle)));
    assert.equal(used.ok === false && used.code, 'used');
    assert.equal(joinerC.secrets.values.size, 0);
  });
});

test('an expired invitation is refused, early by the local check and at write time by the materialiser, and the new keys are removed again', async () => {
  await withFixture(['a', 'b', 'c'], async (fixture) => {
    const seed = await seedTeam(fixture);
    pointOriginAt(fixture, PUBLIC_URL);
    const { bundle } = await invite(fixture, seed, { ttlSeconds: 3600 });
    const late = (): number => Date.now() + (3600 + INVITE_SKEW_SECONDS + 600) * 1000;

    const early = await joinerOn(fixture, 'b', seed);
    const earlyResult = await joinTeam(joinInput(early, await readyFor(early, bundle), { now: late }));
    assert.equal(earlyResult.ok === false && earlyResult.code, 'expired');
    assert.equal(early.secrets.values.size, 0);

    // The clock looks fine for the early check and late once the keys exist, so the refusal comes from the write-side check.
    const lateJoiner = await joinerOn(fixture, 'c', seed);
    const lateResult = await joinTeam(joinInput(lateJoiner, await readyFor(lateJoiner, bundle), { now: () => (lateJoiner.secrets.values.size > 0 ? late() : Date.now()) }));
    assert.equal(lateResult.ok === false && lateResult.code, 'expired');
    assert.equal(lateJoiner.secrets.values.size, 0, 'the device and seal keys were deleted again');
    await seed.a.log.sync();
    assert.equal(seed.a.log.state().members.values().next().value !== undefined, true);
    assert.equal([...seed.a.log.state().members.values()].filter((member) => member.status === 'invited').length, 1, 'the invitation is untouched');
  });
});

test('a cancel that lands while the join is being written fails the join and removes the new keys', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    pointOriginAt(fixture, PUBLIC_URL);
    const { bundle, memberId } = await invite(fixture, seed);
    const joiner = await joinerOn(fixture, 'b', seed);
    const prepared = await readyFor(joiner, bundle);
    // Just before the joiner's first push the lead cancels, so the push loses the race and the invitation is gone when the join is rebuilt.
    let cancelled = false;
    const real: GitRunner = (await import('../team/runGit')).runGit;
    const git: GitRunner = async (args, options) => {
      if (!cancelled && args.includes('push')) {
        cancelled = true;
        const removal = await seed.a.log.append(() => [{ type: 'member.removed', body: { memberId } }]);
        assert.equal(removal.ok, true);
      }
      return real(args, options);
    };
    const result = await joinTeam(joinInput(joiner, prepared, { git }));
    assert.equal(cancelled, true, 'the cancel ran between the keys and the write');
    assert.equal(result.ok === false && result.code, 'cancelled');
    assert.equal(joiner.secrets.values.size, 0, 'both keys are gone and no session or profile was made');
  });
});

test('two devices racing with one bundle: one joins, the other is told it was used and keeps no keys', async () => {
  await withFixture(['a', 'b', 'c'], async (fixture) => {
    const seed = await seedTeam(fixture);
    pointOriginAt(fixture, PUBLIC_URL);
    const { bundle } = await invite(fixture, seed);
    const joinerB = await joinerOn(fixture, 'b', seed);
    const joinerC = await joinerOn(fixture, 'c', seed);
    const [b, c] = await Promise.all([
      joinTeam(joinInput(joinerB, await readyFor(joinerB, bundle))),
      joinTeam(joinInput(joinerC, await readyFor(joinerC, bundle)))
    ]);
    const winners = [b, c].filter((result) => result.ok);
    const losers = [b, c].filter((result) => !result.ok);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    const loser = losers[0];
    assert.ok(loser !== undefined && !loser.ok && (loser.code === 'used' || loser.code === 'conflict'), loser?.ok === false ? loser.code : 'loser joined');
    const loserSecrets = b.ok ? joinerC.secrets : joinerB.secrets;
    const winnerSecrets = b.ok ? joinerB.secrets : joinerC.secrets;
    assert.equal(loserSecrets.values.size, 0, 'the loser left nothing behind');
    assert.equal(winnerSecrets.values.size, 2);
  });
});

test('a device that already holds a team key is not given a second one, and its key is left alone', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    pointOriginAt(fixture, PUBLIC_URL);
    const { bundle } = await invite(fixture, seed);
    const joiner = await joinerOn(fixture, 'b', seed);
    await createDeviceIdentity(joiner.secrets, seed.teamId);
    const stored = joiner.secrets.values.get(deviceKeySecretName(seed.teamId));
    const result = await joinTeam(joinInput(joiner, await readyFor(joiner, bundle)));
    assert.equal(result.ok === false && result.code, 'already-has-key');
    assert.ok(result.ok === false && result.message.length > 0 && !result.message.includes('\u2014'));
    assert.equal(joiner.secrets.values.get(deviceKeySecretName(seed.teamId)), stored, 'the existing key is untouched');
    assert.equal(joiner.secrets.values.size, 1);
  });
});
