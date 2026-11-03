// The lead's side of inviting (Phase 61 plan 07): one call writes member.invited over real git and hands back a single invite bundle whose
// code matches the log, with the repo URL cleaned of credentials and the code held nowhere but the returned string. Canary codes and canary
// URL passwords are built at run time, never as literals.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { DEFAULT_INVITE_TTL_SECONDS, expectedJoinRole, joinProofBytes } from '../domain/team/invite';
import { teamMaterializer } from '../domain/team/materialize';
import { defaultTeamPolicy } from '../domain/team/policy';
import type { GenesisAnchor, MemberJoinedBody, Role, TeamFile, TeamState } from '../domain/team/types';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import { TeamLog, buildGenesisEvents } from '../team/eventLog';
import type { TeamSigner } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { createDeviceIdentity, emailHash, newTeamId } from '../team/identity';
import type { DeviceIdentity } from '../team/identity';
import { INVITE_FILE, inviteMember, readInviteDirectory, recordInvite, reissueInvite } from '../team/invite';
import type { InviteInput } from '../team/invite';
import { BUNDLE_PREFIX, parseInviteBundle } from '../team/inviteBundle';
import * as inviteCodeModule from '../team/inviteCode';
import { deriveInviteKey, formatInviteCode, inviteKeyMatches, parseInviteCode } from '../team/inviteCode';
import { CLEANUP_FILE, CleanupChecklist, REPO_ACCESS_TEXT, repoAccessText } from '../team/cleanupChecklist';
import type { CleanupItem } from '../team/cleanupChecklist';
import { NearOrgClient } from '../team/nearOrg';
import type { NearAuth } from '../team/nearOrg';
import { canonicalTeamFile, teamStorageDir } from '../team/teamFile';
import { SecretLeakError } from '../domain/team/secrets';
import { makeCanaries } from './helpers/teamCanary';
import { startFakeNear } from './helpers/fakeNear';
import type { FakeNear } from './helpers/fakeNear';
import { MemorySecrets, createOwner, createTeamFixture, gitIn } from './helpers/teamHarness';
import type { TeamFixture, TestOwner } from './helpers/teamHarness';

const fixedNow = (): Date => new Date('2026-02-03T04:05:06.000Z');
const PUBLIC_URL = 'https://example.invalid/team.git';

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
async function seedTeam(fixture: TeamFixture, near?: TeamFile['near']): Promise<Seed> {
  const teamId = newTeamId();
  const owner = await createOwner(teamId);
  const genesis = buildGenesisEvents({
    teamId, teamName: 'Invite flow team', owner: { memberId: owner.memberId, name: 'Owner Test', emailHashes: [emailHash(teamId, 'owner@example.invalid')] },
    identity: owner.identity, policy: defaultTeamPolicy(), ...(near === undefined ? {} : { near }), now: fixedNow
  });
  const teamFile: TeamFile = {
    version: 1, teamId, name: 'Invite flow team', coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: genesis.anchor.eventId, ownerDevice: genesis.anchor.ownerDevice }, ...(near === undefined ? {} : { near }), createdAt: '2026-02-03T04:05:06.000Z'
  };
  const signer: TeamSigner = { identity: owner.identity, memberId: owner.memberId };
  const a = clientFor(fixture, 'a', genesis.anchor, signer);
  const written = await a.transport.append(async () => genesis.events, { genesis: { teamFileText: canonicalTeamFile(teamFile) } });
  assert.equal(written.ok, true);
  return { teamId, owner, signer, anchor: genesis.anchor, teamFile, a, globalStorageDir: path.join(fixture.root, 'global-a') };
}

// The project's origin is configured as a public-looking URL and git is told where it really is, so a fetch or push reaches the local bare
// remote while the configured value (what the bundle must carry) stays the public one.
function pointOriginAt(fixture: TeamFixture, url: string): void {
  const clone = fixture.clones['a'] as string;
  gitIn(clone, ['config', `url.${fixture.remote}.insteadOf`, url]);
  gitIn(clone, ['remote', 'set-url', 'origin', url]);
}

function inputFor(fixture: TeamFixture, seed: Seed, overrides: Partial<InviteInput> = {}): InviteInput {
  return {
    projectRoot: fixture.clones['a'] as string, globalStorageDir: seed.globalStorageDir, teamFile: seed.teamFile, log: seed.a.log,
    name: 'Dana Developer', email: 'dana@example.invalid', role: 'developer', allocationNanoUsd: 5_000_000_000, ttlSeconds: DEFAULT_INVITE_TTL_SECONDS, ...overrides
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

function everyObject(remote: string): Buffer {
  return execFileSync('git', ['-C', remote, 'cat-file', '--batch-all-objects', '--batch'], { maxBuffer: 64 * 1024 * 1024 });
}

async function readIfPresent(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

test('tracer: a lead invites a developer over real git and gets a bundle whose code matches the log', async () => {
  await withFixture(['a', 'b'], async (fixture) => {
    const seed = await seedTeam(fixture);
    pointOriginAt(fixture, PUBLIC_URL);
    const result = await inviteMember(inputFor(fixture, seed));
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.ok(result.bundle.startsWith(BUNDLE_PREFIX));
    assert.equal(result.nearInvitation, 'not-applicable');

    // The bundle carries the configured URL, not the local path git rewrites it to.
    const bundle = parseInviteBundle(result.bundle);
    assert.equal(bundle.repo, PUBLIC_URL);
    assert.equal(bundle.team, seed.teamId);
    assert.equal(bundle.ref, DEFAULT_COORDINATION_REF);
    assert.equal(bundle.member, result.memberId);
    assert.equal(bundle.near, undefined);

    // A second clone syncs, sees the invited member, and the bundle's code derives the public key the log recorded.
    const b = clientFor(fixture, 'b', seed.anchor);
    const synced = await b.log.sync();
    assert.deepEqual(synced.rejected, []);
    const pending = b.log.state().members.get(result.memberId);
    assert.equal(pending?.status, 'invited');
    assert.equal(pending?.pendingRole, 'developer');
    assert.equal(pending?.allocationNanoUsd, 5_000_000_000);
    assert.equal(pending?.invite?.ttlSeconds, DEFAULT_INVITE_TTL_SECONDS);
    assert.deepEqual(pending?.emailHashes, [emailHash(seed.teamId, 'dana@example.invalid')]);
    const codeBytes = parseInviteCode(bundle.code);
    assert.ok(codeBytes !== undefined);
    if (codeBytes === undefined || pending?.invite === undefined) return;
    assert.equal(inviteKeyMatches(codeBytes, seed.teamId, result.memberId, pending.invite.publicKey), true);
    // The state object is live and the join below ends the invitation, so the event id is read first.
    const inviteEventId = pending.invite.eventId;

    // The same code joins from the second clone.
    const identity = await createDeviceIdentity(new MemorySecrets(), seed.teamId);
    const joined = await b.log.appendJoin(identity, (state) => joinBodyFor(state, seed.teamId, result.memberId, codeBytes, identity, x25519PublicKey()));
    assert.equal(joined.ok, true, joined.ok ? '' : joined.reason);
    await seed.a.log.sync();
    assert.equal(seed.a.log.state().members.get(result.memberId)?.devices.length, 1);

    // The local display cache holds who was invited, never the code.
    const directory = await readInviteDirectory(teamStorageDir(seed.globalStorageDir, seed.teamId));
    assert.equal(directory.length, 1);
    assert.equal(directory[0]?.memberId, result.memberId);
    assert.equal(directory[0]?.name, 'Dana Developer');
    assert.equal(directory[0]?.email, 'dana@example.invalid');
    assert.equal(directory[0]?.role, 'developer');
    assert.equal(directory[0]?.invitedEvent, inviteEventId);
  });
});

test('the clear-text code is in no file the invite wrote and in no object on the coordination remote', async () => {
  await withFixture(['a'], async (fixture) => {
    const seed = await seedTeam(fixture);
    pointOriginAt(fixture, PUBLIC_URL);
    const result = await inviteMember(inputFor(fixture, seed));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const code = parseInviteBundle(result.bundle).code;
    const bytes = parseInviteCode(code);
    assert.ok(bytes !== undefined);
    const needles = [code, formatInviteCode(code), bytes?.toString('hex') ?? '', bytes?.toString('base64url') ?? '', bytes?.toString('base64') ?? '', result.bundle];
    const storageDir = teamStorageDir(seed.globalStorageDir, seed.teamId);
    const invites = await readIfPresent(path.join(storageDir, INVITE_FILE));
    assert.ok(invites.length > 0, 'the invite list was written');
    const cleanup = await readIfPresent(path.join(storageDir, 'cleanup.json'));
    const remote = everyObject(fixture.remote);
    for (const needle of needles) {
      assert.notEqual(needle, '');
      assert.equal(invites.includes(needle), false, 'invites.json holds a rendering of the code');
      assert.equal(cleanup.includes(needle), false, 'cleanup.json holds a rendering of the code');
      assert.equal(remote.includes(Buffer.from(needle, 'utf8')), false, 'a coordination object holds a rendering of the code');
    }
    // The mirror the lead keeps next to the invite list is a git store too: scan every object in it.
    const mirror = execFileSync('git', ['-C', path.join(fixture.storageDir('a'), 'coordination.git'), 'cat-file', '--batch-all-objects', '--batch'], { maxBuffer: 64 * 1024 * 1024 });
    for (const needle of needles) assert.equal(mirror.includes(Buffer.from(needle, 'utf8')), false, 'the local mirror holds a rendering of the code');
  });
});

test('the code bytes are zero-filled once the bundle is built, and also when the append fails', async () => {
  await withFixture(['a'], async (fixture) => {
    const seed = await seedTeam(fixture);
    pointOriginAt(fixture, PUBLIC_URL);
    const captured: Buffer[] = [];
    const module = inviteCodeModule as unknown as { generateInviteCode: typeof inviteCodeModule.generateInviteCode };
    const original = module.generateInviteCode;
    module.generateInviteCode = () => {
      const code = original();
      captured.push(code.bytes);
      return code;
    };
    try {
      const result = await inviteMember(inputFor(fixture, seed));
      assert.equal(result.ok, true);
      assert.equal(captured.length, 1);
      assert.ok(result.ok && parseInviteCode(parseInviteBundle(result.bundle).code) !== undefined, 'the bundle still holds a real code');
      assert.deepEqual(captured[0], Buffer.alloc(20), 'the bytes were wiped after use');

      // A refused invite (a log with no device key cannot sign) wipes them too.
      const refused = await inviteMember(inputFor(fixture, seed, { log: new TeamLog({ anchor: seed.anchor, transport: seed.a.transport, now: fixedNow }) }));
      assert.equal(refused.ok, false);
      assert.equal(captured.length, 2);
      assert.deepEqual(captured[1], Buffer.alloc(20));
    } finally {
      module.generateInviteCode = original;
    }
  });
});

test('credentials in the configured remote URL never reach the bundle, the log or the failure text', async () => {
  await withFixture(['a'], async (fixture) => {
    const seed = await seedTeam(fixture);
    const canaries = makeCanaries();
    pointOriginAt(fixture, `https://canaryuser:${canaries.urlPassword}@example.invalid/team.git`);
    const result = await inviteMember(inputFor(fixture, seed));
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(parseInviteBundle(result.bundle).repo, PUBLIC_URL);
    assert.equal(Buffer.from(result.bundle.slice(BUNDLE_PREFIX.length), 'base64url').includes(Buffer.from(canaries.urlPassword)), false);
    assert.equal(everyObject(fixture.remote).includes(Buffer.from(canaries.urlPassword)), false);
    const cleaned = await readIfPresent(path.join(teamStorageDir(seed.globalStorageDir, seed.teamId), INVITE_FILE));
    assert.equal(cleaned.includes(canaries.urlPassword), false);
  });
});

test('a remote that cannot be shared refuses the invite with a reason that never holds the URL, and writes nothing', async () => {
  await withFixture(['a'], async (fixture) => {
    const seed = await seedTeam(fixture);
    // The fixture origin is a local path, which cannot be shared with a teammate.
    const before = seed.a.log.state().head.lamport;
    const local = await inviteMember(inputFor(fixture, seed));
    assert.equal(local.ok, false);
    if (local.ok) return;
    assert.equal(local.code, 'remote-url');
    assert.equal(local.message.includes(fixture.remote), false);
    await seed.a.log.sync();
    assert.equal(seed.a.log.state().head.lamport, before, 'no event was appended');

    const canaries = makeCanaries();
    const secretUrl = `https://example.invalid/team.git?token=${canaries.apiKey}`;
    pointOriginAt(fixture, secretUrl);
    const query = await inviteMember(inputFor(fixture, seed));
    assert.equal(query.ok, false);
    if (query.ok) return;
    assert.equal(query.code, 'remote-url');
    assert.equal(query.message.includes(canaries.apiKey), false);
    assert.equal(query.message.includes('example.invalid'), false);
  });
});

test('bad input is refused before anything is generated or written', async () => {
  await withFixture(['a'], async (fixture) => {
    const seed = await seedTeam(fixture);
    pointOriginAt(fixture, PUBLIC_URL);
    const before = seed.a.log.state().head.lamport;
    const cases: Array<Partial<InviteInput>> = [
      { email: 'not-an-email' }, { name: '   ' }, { allocationNanoUsd: -1 }, { allocationNanoUsd: 1.5 }, { ttlSeconds: 10 }, { role: 'owner' as unknown as 'lead' }
    ];
    for (const override of cases) {
      const result = await inviteMember(inputFor(fixture, seed, override));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'refused');
    }
    await seed.a.log.sync();
    assert.equal(seed.a.log.state().head.lamport, before);
  });
});


// ---- Lead invitations through NEAR (D-21, D-22) ---------------------------------------------------------------------------------------

const NEAR_LINK = { organizationId: 'org-1', workspaceId: 'ws-1' };
const NO_SLEEP = async (): Promise<void> => undefined;

function staticAuth(token: string): NearAuth {
  return { accessToken: async () => token, refreshAfterUnauthorized: async () => undefined };
}

interface NearWorld { fake: FakeNear; asOwner: NearOrgClient; asMember: NearOrgClient; ownerToken: string; memberToken: string }

// A fake NEAR with one organization: the inviting lead's login is an org owner, and a second login is a plain member who cannot invite.
async function withNear(run: (world: NearWorld) => Promise<void>): Promise<void> {
  const fake = await startFakeNear();
  try {
    const owner = fake.addUser({ id: 'user-lead', username: 'lead', email: 'lead@example.invalid' });
    const member = fake.addUser({ id: 'user-plain', username: 'plain', email: 'plain@example.invalid' });
    fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-lead', role: 'owner' }, { userId: 'user-plain', role: 'member' }] });
    fake.addWorkspace({ id: 'ws-1', organizationId: 'org-1', name: 'Team workspace' });
    const make = (token: string): NearOrgClient => new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(token), sleep: NO_SLEEP });
    await run({ fake, asOwner: make(owner.accessToken), asMember: make(member.accessToken), ownerToken: owner.accessToken, memberToken: member.accessToken });
  } finally {
    await fake.close();
  }
}

function inviteCalls(fake: FakeNear): number {
  return fake.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/invite-by-email')).length;
}

test('a lead invitation in a NEAR-linked team also sends a NEAR organization invitation at admin, exactly once', async () => {
  await withNear(async ({ fake, asOwner }) => {
    await withFixture(['a'], async (fixture) => {
      const seed = await seedTeam(fixture, NEAR_LINK);
      pointOriginAt(fixture, PUBLIC_URL);
      const result = await inviteMember(inputFor(fixture, seed, { role: 'lead', email: 'Lena.Lead@example.invalid', name: 'Lena Lead', org: asOwner }));
      assert.equal(result.ok, true, result.ok ? '' : result.message);
      if (!result.ok) return;
      assert.equal(result.nearInvitation, 'sent');
      assert.equal(inviteCalls(fake), 1);
      const pending = await asOwner.listInvitations('org-1', 'pending');
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.email.toLowerCase(), 'lena.lead@example.invalid');
      assert.equal(pending[0]?.role, 'admin');
      // The bundle of a NEAR-linked team carries the link, and nothing was queued.
      assert.deepEqual(parseInviteBundle(result.bundle).near, NEAR_LINK);
      assert.deepEqual(await new CleanupChecklist(teamStorageDir(seed.globalStorageDir, seed.teamId)).list(), []);
    });
  });
});

test('developer, reviewer and observer invitations never call NEAR, even with a session at hand', async () => {
  await withNear(async ({ fake, asOwner }) => {
    await withFixture(['a'], async (fixture) => {
      const seed = await seedTeam(fixture, NEAR_LINK);
      pointOriginAt(fixture, PUBLIC_URL);
      const before = fake.requests.length;
      for (const [index, role] of (['developer', 'reviewer', 'observer'] as const).entries()) {
        const result = await inviteMember(inputFor(fixture, seed, { role, email: `person${index}@example.invalid`, org: asOwner }));
        assert.equal(result.ok, true, result.ok ? '' : result.message);
        if (result.ok) assert.equal(result.nearInvitation, 'not-applicable');
      }
      assert.equal(fake.requests.length, before, 'no request reached NEAR');
      // A lead invited into a team that is not linked to NEAR does not call NEAR either.
    });
    await withFixture(['a'], async (fixture) => {
      const seed = await seedTeam(fixture);
      pointOriginAt(fixture, PUBLIC_URL);
      const before = fake.requests.length;
      const result = await inviteMember(inputFor(fixture, seed, { role: 'lead', org: asOwner }));
      assert.equal(result.ok && result.nearInvitation, 'not-applicable');
      assert.equal(fake.requests.length, before);
    });
  });
});

test('a NEAR failure never blocks the team invite: it is queued on the cleanup checklist with a plain notice', async () => {
  await withNear(async ({ fake, asMember, memberToken, ownerToken }) => {
    await withFixture(['a'], async (fixture) => {
      const seed = await seedTeam(fixture, NEAR_LINK);
      pointOriginAt(fixture, PUBLIC_URL);
      const storageDir = teamStorageDir(seed.globalStorageDir, seed.teamId);
      // The signed-in NEAR user is only a member of the organization, so NEAR answers 403.
      const denied = await inviteMember(inputFor(fixture, seed, { role: 'lead', name: 'Lena Lead', email: 'lena@example.invalid', org: asMember }));
      assert.equal(denied.ok, true, denied.ok ? '' : denied.message);
      if (!denied.ok) return;
      assert.equal(denied.nearInvitation, 'queued');
      assert.ok(denied.notice !== undefined && denied.notice.length > 0 && denied.notice.length < 400);
      assert.ok(!/[\u0000-\u001f]/.test(denied.notice ?? ''));
      await seed.a.log.sync();
      assert.equal(seed.a.log.state().members.get(denied.memberId)?.status, 'invited', 'the team invitation is in the log');
      const items = await new CleanupChecklist(storageDir).forMember(denied.memberId);
      assert.equal(items.length, 1);
      assert.equal(items[0]?.step, 'send-invitation');
      assert.equal(items[0]?.status, 'failed');
      assert.equal(items[0]?.memberName, 'Lena Lead');
      assert.ok((items[0]?.lastError ?? '').length > 0);
      const stored = await fs.readFile(path.join(storageDir, CLEANUP_FILE), 'utf8');
      for (const token of [memberToken, ownerToken, denied.bundle, 'lena@example.invalid', PUBLIC_URL]) assert.equal(stored.includes(token), false, 'the checklist holds no token, bundle, email or URL');
      assert.equal(inviteCalls(fake), 1);

      // Without a NEAR client at all the step is pending, not failed.
      const skipped = await inviteMember(inputFor(fixture, seed, { role: 'lead', name: 'Sam Skipped', email: 'sam@example.invalid' }));
      assert.equal(skipped.ok && skipped.nearInvitation, 'queued');
      if (!skipped.ok) return;
      const pendingItems = await new CleanupChecklist(storageDir).forMember(skipped.memberId);
      assert.equal(pendingItems[0]?.step, 'send-invitation');
      assert.equal(pendingItems[0]?.status, 'pending');
      assert.equal(pendingItems[0]?.lastError, undefined);
      assert.equal(inviteCalls(fake), 1, 'no request without a client');
    });
  });
});

function coordinationCommits(remote: string): number {
  return Number(execFileSync('git', ['-C', remote, 'rev-list', '--count', DEFAULT_COORDINATION_REF], { encoding: 'utf8' }).trim());
}

test('re-issue is one commit: member.removed for the old invitation and a new member.invited with a new id and a new code', async () => {
  await withFixture(['a'], async (fixture) => {
    const seed = await seedTeam(fixture);
    pointOriginAt(fixture, PUBLIC_URL);
    const first = await inviteMember(inputFor(fixture, seed, { role: 'reviewer', allocationNanoUsd: 7_000_000_000, ttlSeconds: 259_200 }));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const commitsBefore = coordinationCommits(fixture.remote);
    const again = await reissueInvite({
      projectRoot: fixture.clones['a'] as string, globalStorageDir: seed.globalStorageDir, teamFile: seed.teamFile, log: seed.a.log,
      ttlSeconds: DEFAULT_INVITE_TTL_SECONDS, oldMemberId: first.memberId, email: 'dana@example.invalid'
    });
    assert.equal(again.ok, true, again.ok ? '' : again.message);
    if (!again.ok) return;
    assert.equal(coordinationCommits(fixture.remote), commitsBefore + 1, 'one new coordination commit');
    assert.notEqual(again.memberId, first.memberId);
    const oldBundle = parseInviteBundle(first.bundle);
    const newBundle = parseInviteBundle(again.bundle);
    assert.notEqual(newBundle.code, oldBundle.code);
    assert.equal(newBundle.member, again.memberId);
    await seed.a.log.sync();
    const state = seed.a.log.state();
    assert.notEqual(state.members.get(first.memberId)?.removedEvent, undefined, 'the old invitation is cancelled');
    const fresh = state.members.get(again.memberId);
    assert.equal(fresh?.status, 'invited');
    assert.equal(fresh?.pendingRole, 'reviewer', 'the role and allocation carry over');
    assert.equal(fresh?.allocationNanoUsd, 7_000_000_000);
    assert.equal(fresh?.name, 'Dana Developer');
    assert.equal(fresh?.invite?.ttlSeconds, DEFAULT_INVITE_TTL_SECONDS, 're-issue takes the lifetime it was given');
    const newCode = parseInviteCode(newBundle.code);
    assert.ok(newCode !== undefined && fresh?.invite !== undefined);
    if (newCode !== undefined && fresh?.invite !== undefined) assert.equal(inviteKeyMatches(newCode, seed.teamId, again.memberId, fresh.invite.publicKey), true);
    const directory = await readInviteDirectory(teamStorageDir(seed.globalStorageDir, seed.teamId));
    assert.deepEqual(directory.map((entry) => entry.memberId).sort(), [first.memberId, again.memberId].sort());
    assert.equal(directory.find((entry) => entry.memberId === again.memberId)?.role, 'reviewer');
  });
});

test('re-issue refuses an invitation that is not pending or an email that is not the one invited, and writes nothing', async () => {
  await withFixture(['a'], async (fixture) => {
    const seed = await seedTeam(fixture);
    pointOriginAt(fixture, PUBLIC_URL);
    const first = await inviteMember(inputFor(fixture, seed));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const base = { projectRoot: fixture.clones['a'] as string, globalStorageDir: seed.globalStorageDir, teamFile: seed.teamFile, log: seed.a.log, ttlSeconds: DEFAULT_INVITE_TTL_SECONDS };
    const commits = coordinationCommits(fixture.remote);
    const wrongEmail = await reissueInvite({ ...base, oldMemberId: first.memberId, email: 'someone.else@example.invalid' });
    assert.equal(wrongEmail.ok, false);
    const unknown = await reissueInvite({ ...base, oldMemberId: 'mbr-0000000000000000', email: 'dana@example.invalid' });
    assert.equal(unknown.ok, false);
    const owner = await reissueInvite({ ...base, oldMemberId: seed.owner.memberId, email: 'owner@example.invalid' });
    assert.equal(owner.ok, false, 'a member who already joined has no invitation to re-issue');
    const malformed = await reissueInvite({ ...base, oldMemberId: 'not-an-id', email: 'dana@example.invalid' });
    assert.equal(malformed.ok, false);
    assert.equal(coordinationCommits(fixture.remote), commits);
  });
});

test('re-issuing a lead keeps a NEAR invitation that is still pending instead of sending it twice, and sends again when none is pending', async () => {
  await withNear(async ({ fake, asOwner }) => {
    await withFixture(['a'], async (fixture) => {
      const seed = await seedTeam(fixture, NEAR_LINK);
      pointOriginAt(fixture, PUBLIC_URL);
      const first = await inviteMember(inputFor(fixture, seed, { role: 'lead', email: 'lena@example.invalid', name: 'Lena Lead', org: asOwner }));
      assert.equal(first.ok && first.nearInvitation, 'sent');
      if (!first.ok) return;
      const base = { projectRoot: fixture.clones['a'] as string, globalStorageDir: seed.globalStorageDir, teamFile: seed.teamFile, log: seed.a.log, ttlSeconds: DEFAULT_INVITE_TTL_SECONDS, org: asOwner };
      const second = await reissueInvite({ ...base, oldMemberId: first.memberId, email: 'LENA@example.invalid' });
      assert.equal(second.ok, true, second.ok ? '' : second.message);
      if (!second.ok) return;
      assert.equal(second.nearInvitation, 'sent');
      assert.equal(inviteCalls(fake), 1, 'the pending NEAR invitation was kept');
      assert.deepEqual(await new CleanupChecklist(teamStorageDir(seed.globalStorageDir, seed.teamId)).list(), []);

      // The NEAR invitation is cancelled in the meantime, so a re-issue has to send a new one.
      const pending = await asOwner.listInvitations('org-1', 'pending');
      assert.equal(await asOwner.cancelInvitation('org-1', pending[0]?.id ?? ''), 'cancelled');
      const third = await reissueInvite({ ...base, oldMemberId: second.memberId, email: 'lena@example.invalid' });
      assert.equal(third.ok && third.nearInvitation, 'sent');
      assert.equal(inviteCalls(fake), 2);
    });
  });
});

// ---- The cleanup checklist (D-18) -------------------------------------------------------------------------------------------------------

async function withStorage(run: (dir: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'near-ai-cleanup-'));
  try {
    await run(path.join(root, 'team', newTeamId()));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function itemFor(memberId: string, step: CleanupItem['step'], extra: Partial<CleanupItem> = {}): Omit<CleanupItem, 'id' | 'attempts' | 'createdAt'> {
  return { memberId, memberName: 'Dana Developer', step, status: 'pending', ...extra };
}

test('checklist: add assigns ids and times, update counts attempts, list keeps insertion order, forMember filters, and a reload sees it all', async () => {
  await withStorage(async (dir) => {
    const times = [new Date('2026-03-01T00:00:00.000Z'), new Date('2026-03-01T00:00:01.000Z')];
    let call = 0;
    const checklist = new CleanupChecklist(dir, () => times[Math.min(call++, times.length - 1)] as Date);
    assert.deepEqual(await checklist.list(), [], 'no file yet');
    const added = await checklist.add([itemFor('mbr-aaaaaaaaaaaaaaaa', 'zero-limit', { keyId: 'key-1' }), itemFor('mbr-aaaaaaaaaaaaaaaa', 'revoke-key', { keyId: 'key-1' })]);
    assert.equal(added.length, 2);
    assert.match(added[0]?.id ?? '', /^cln-[0-9a-f]{16}$/);
    assert.notEqual(added[0]?.id, added[1]?.id);
    assert.equal(added[0]?.attempts, 0);
    assert.equal(added[0]?.createdAt, '2026-03-01T00:00:00.000Z');
    const other = await checklist.add([itemFor('mbr-bbbbbbbbbbbbbbbb', 'repo-access', { status: 'manual' })]);

    const updated = await checklist.update(added[0]?.id ?? '', { status: 'failed', lastError: 'NEAR AI Cloud answered 503', attempted: true });
    assert.equal(updated?.attempts, 1);
    assert.equal(updated?.status, 'failed');
    const again = await checklist.update(added[0]?.id ?? '', { attempted: true });
    assert.equal(again?.attempts, 2);
    assert.equal(again?.lastError, 'NEAR AI Cloud answered 503', 'an attempt alone keeps the last error');
    const done = await checklist.update(added[0]?.id ?? '', { status: 'done' });
    assert.equal(done?.status, 'done');
    assert.equal(done?.lastError, undefined, 'a finished step shows no error');
    assert.equal(await checklist.update('cln-ffffffffffffffff', { status: 'done' }), undefined);

    const reloaded = new CleanupChecklist(dir);
    const all = await reloaded.list();
    assert.deepEqual(all.map((item) => item.id), [added[0]?.id, added[1]?.id, other[0]?.id], 'insertion order');
    assert.equal(all[0]?.status, 'done');
    assert.equal(all[0]?.attempts, 2);
    assert.deepEqual((await reloaded.forMember('mbr-aaaaaaaaaaaaaaaa')).map((item) => item.step), ['zero-limit', 'revoke-key']);
    assert.deepEqual((await reloaded.forMember('mbr-bbbbbbbbbbbbbbbb')).map((item) => item.step), ['repo-access']);
    assert.deepEqual(await reloaded.forMember('mbr-cccccccccccccccc'), []);
    const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'the atomic write leaves no temp file');
  });
});

test('checklist: an error with a secret is stored redacted, control characters become spaces, and the text is cut to 300 characters', async () => {
  await withStorage(async (dir) => {
    const canaries = makeCanaries();
    const checklist = new CleanupChecklist(dir);
    const [item] = await checklist.add([itemFor('mbr-aaaaaaaaaaaaaaaa', 'revoke-key')]);
    const text = `failed with ${canaries.apiKey} and ${canaries.refreshToken} and Bearer ${canaries.reportingToken}\u0000line\nbreak\t${'x'.repeat(600)}`;
    const updated = await checklist.update(item?.id ?? '', { status: 'failed', lastError: text });
    const shown = updated?.lastError ?? '';
    assert.ok(shown.length > 0 && shown.length <= 300);
    for (const secret of [canaries.apiKey, canaries.refreshToken, canaries.reportingToken]) assert.equal(shown.includes(secret), false);
    assert.ok(!/[\u0000-\u001f]/.test(shown));
    const file = await fs.readFile(path.join(dir, CLEANUP_FILE), 'utf8');
    for (const secret of [canaries.apiKey, canaries.refreshToken, canaries.reportingToken]) assert.equal(file.includes(secret), false);
    const added = await checklist.add([itemFor('mbr-aaaaaaaaaaaaaaaa', 'send-invitation', { status: 'failed', lastError: `denied ${canaries.apiKey}` })]);
    assert.equal(added[0]?.lastError?.includes(canaries.apiKey), false);
    assert.equal((await fs.readFile(path.join(dir, CLEANUP_FILE), 'utf8')).includes(canaries.apiKey), false);
  });
});

test('checklist: a secret in a stored field refuses the write and leaves the file as it was', async () => {
  await withStorage(async (dir) => {
    const canaries = makeCanaries();
    const checklist = new CleanupChecklist(dir);
    await checklist.add([itemFor('mbr-aaaaaaaaaaaaaaaa', 'zero-limit')]);
    const before = await fs.readFile(path.join(dir, CLEANUP_FILE), 'utf8');
    await assert.rejects(checklist.add([itemFor('mbr-bbbbbbbbbbbbbbbb', 'zero-limit', { memberName: canaries.apiKey })]), SecretLeakError);
    assert.equal(await fs.readFile(path.join(dir, CLEANUP_FILE), 'utf8'), before);
  });
});

test('checklist: concurrent adds from two instances on one folder all land, and a damaged file is reported, not replaced', async () => {
  await withStorage(async (dir) => {
    const one = new CleanupChecklist(dir);
    const two = new CleanupChecklist(dir);
    const jobs: Array<Promise<CleanupItem[]>> = [];
    for (let index = 0; index < 10; index += 1) {
      jobs.push(one.add([itemFor('mbr-aaaaaaaaaaaaaaaa', 'zero-limit', { keyId: `one-${index}` })]));
      jobs.push(two.add([itemFor('mbr-bbbbbbbbbbbbbbbb', 'revoke-key', { keyId: `two-${index}` })]));
    }
    await Promise.all(jobs);
    const all = await new CleanupChecklist(dir).list();
    assert.equal(all.length, 20);
    assert.equal(new Set(all.map((item) => item.id)).size, 20);
    assert.equal(new Set(all.map((item) => item.keyId)).size, 20);

    await fs.writeFile(path.join(dir, CLEANUP_FILE), '{"version":1,"items":[{"id":"x"}]}', 'utf8');
    await assert.rejects(one.list(), /cleanup/i);
    await assert.rejects(one.add([itemFor('mbr-aaaaaaaaaaaaaaaa', 'zero-limit')]), /cleanup/i);
    assert.equal(await fs.readFile(path.join(dir, CLEANUP_FILE), 'utf8'), '{"version":1,"items":[{"id":"x"}]}');
  });
});

test('checklist: every step kind the phase uses exists, and the project access reminder names the member and says last', async () => {
  await withStorage(async (dir) => {
    const checklist = new CleanupChecklist(dir);
    const steps: CleanupItem['step'][] = ['send-invitation', 'cancel-invitation', 'deliver-key', 'rotate-key', 'zero-limit', 'revoke-key', 'remove-org-member', 'repo-access'];
    const added = await checklist.add(steps.map((step) => itemFor('mbr-aaaaaaaaaaaaaaaa', step)));
    assert.deepEqual(added.map((item) => item.step), steps);
    assert.deepEqual((await checklist.list()).map((item) => item.step), steps);
  });
  assert.match(REPO_ACCESS_TEXT, /access to the project on GitHub \(or wherever the project is hosted\) last, after NEAR AI on their computer has seen the removal/);
  assert.equal(repoAccessText('Dana Developer'), "Remove Dana Developer's access to the project on GitHub (or wherever the project is hosted) last, after NEAR AI on their computer has seen the removal.");
  assert.equal(/repository|\bgit\b/i.test(REPO_ACCESS_TEXT), false, 'plain words for the person removing someone');
  assert.equal(REPO_ACCESS_TEXT.includes('\u2014'), false, 'no em-dash');
});

test('recordInvite keeps one entry per member and survives two writers at once', async () => {
  await withStorage(async (dir) => {
    const entry = (memberId: string, name: string): Parameters<typeof recordInvite>[1] => ({ memberId, name, email: `${name}@example.invalid`, role: 'developer', invitedEvent: 'evt-0123456789ABCDEFGHJKMNPQRS' });
    await Promise.all([recordInvite(dir, entry('mbr-aaaaaaaaaaaaaaaa', 'one')), recordInvite(dir, entry('mbr-bbbbbbbbbbbbbbbb', 'two')), recordInvite(dir, entry('mbr-aaaaaaaaaaaaaaaa', 'one-again'))]);
    const all = await readInviteDirectory(dir);
    assert.equal(all.length, 2);
    assert.equal(all.find((item) => item.memberId === 'mbr-aaaaaaaaaaaaaaaa')?.name, 'one-again');
    assert.deepEqual(await readInviteDirectory(path.join(dir, 'missing')), []);
  });
});
