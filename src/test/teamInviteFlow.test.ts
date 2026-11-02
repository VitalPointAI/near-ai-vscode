// The lead's side of inviting (Phase 61 plan 07): one call writes member.invited over real git and hands back a single invite bundle whose
// code matches the log, with the repo URL cleaned of credentials and the code held nowhere but the returned string. Canary codes and canary
// URL passwords are built at run time, never as literals.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs/promises';
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
import { INVITE_FILE, inviteMember, readInviteDirectory } from '../team/invite';
import type { InviteInput } from '../team/invite';
import { BUNDLE_PREFIX, parseInviteBundle } from '../team/inviteBundle';
import { deriveInviteKey, formatInviteCode, inviteKeyMatches, parseInviteCode } from '../team/inviteCode';
import { canonicalTeamFile, teamStorageDir } from '../team/teamFile';
import { makeCanaries } from './helpers/teamCanary';
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
