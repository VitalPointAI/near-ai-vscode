// The invitee's side of joining a team (Phase 61 plan 09) over two real clones and the fake NEAR server. A lead invites through inviteMember,
// the invitee pastes the bundle, prepareJoin decides ready or clone-needed, and joinTeam writes member.joined. Emails use .invalid addresses.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { DEFAULT_INVITE_TTL_SECONDS, memberAttention } from '../domain/team/invite';
import { teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import type { GenesisAnchor, TeamFile, TeamState } from '../domain/team/types';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { deviceKeySecretName, emailHash, loadSealIdentity, newTeamId, sealKeySecretName } from '../team/identity';
import { inviteMember } from '../team/invite';
import type { InviteInput } from '../team/invite';
import { encodeInviteBundle, parseInviteBundle } from '../team/inviteBundle';
import { NO_ORG_NOTICE, joinTeam, prepareJoin } from '../team/join';
import type { JoinInput, JoinPreparation } from '../team/join';
import { nearSessionSecretName } from '../team/nearSession';
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

test('prepareJoin takes the NEAR link from team.json, else from the bundle, and refuses when they disagree', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const linked = await seedTeam(fixture, NEAR_LINK);
    pointOriginAt(fixture, PUBLIC_URL);
    const { bundle } = await invite(fixture, linked);
    const joiner = await joinerOn(fixture, 'b', linked);
    const ready = await prepareJoin({ projectRoot: joiner.projectRoot, bundleText: bundle });
    assert.equal(ready.kind === 'ready' && ready.near?.organizationId, 'org-1');

    // A project whose team.json has no link yet (the lead's link commit was not pulled) falls back to the bundle's.
    const { near: _dropped, ...withoutNear } = linked.teamFile;
    await writeTeamFile(joiner.projectRoot, withoutNear);
    const fallback = await prepareJoin({ projectRoot: joiner.projectRoot, bundleText: bundle });
    assert.deepEqual(fallback.kind === 'ready' ? fallback.near : undefined, NEAR_LINK);

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
