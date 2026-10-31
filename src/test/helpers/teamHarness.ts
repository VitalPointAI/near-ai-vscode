// Shared fixtures for the team tests: a bare remote with clones, an in-memory SecretStorage, and a signed genesis batch.
// The file has no .test suffix on purpose so the test glob does not run it as a suite.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SecretStorageLike } from '../../services/auth';
import { canonicalize } from '../../domain/team/canonical';
import { defaultTeamPolicy } from '../../domain/team/policy';
import type { GenesisAnchor, TeamEvent, TeamFile } from '../../domain/team/types';
import { createDeviceIdentity, emailHash, newEventId, newMemberId, signEvent } from '../../team/identity';
import type { DeviceIdentity } from '../../team/identity';
import { DEFAULT_COORDINATION_REF } from '../../team/gitTransport';

// The developer's own git configuration must never change a test result.
const isolatedConfig = path.join(mkdtempSync(path.join(tmpdir(), 'near-ai-team-gitconfig-')), 'gitconfig');
writeFileSync(isolatedConfig, '', 'utf8');
process.env.GIT_CONFIG_GLOBAL = isolatedConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

export class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  public async store(key: string, value: string): Promise<void> { this.values.set(key, value); }
  public async delete(key: string): Promise<void> { this.values.delete(key); }
}

export function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface TeamFixture {
  root: string;
  remote: string;
  clones: Record<string, string>;
  storageDir(name: string): string;
  cleanup(): Promise<void>;
}

export async function createTeamFixture(options: { clones: string[]; initialised?: boolean }): Promise<TeamFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-team-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  gitIn(root, ['init', '--bare', '-q', '-b', 'main', remote]);
  gitIn(remote, ['config', 'receive.denyNonFastForwards', 'true']);
  await mkdir(seed, { recursive: true });
  gitIn(seed, ['init', '-q', '-b', 'main']);
  gitIn(seed, ['config', 'user.name', 'Team Test']);
  gitIn(seed, ['config', 'user.email', 'team-test@example.invalid']);
  writeFileSync(path.join(seed, 'README.md'), '# Team test project\n', 'utf8');
  writeFileSync(path.join(seed, '.gitignore'), '.planning/.near-ai/\n', 'utf8');
  gitIn(seed, ['add', 'README.md', '.gitignore']);
  gitIn(seed, ['commit', '-q', '-m', 'seed']);
  gitIn(seed, ['remote', 'add', 'origin', remote]);
  gitIn(seed, ['push', '-q', 'origin', 'main']);
  const clones: Record<string, string> = {};
  for (const name of options.clones) {
    const dir = path.join(root, 'clones', name);
    gitIn(root, ['clone', '-q', remote, dir]);
    gitIn(dir, ['config', 'user.name', 'Team Test']);
    gitIn(dir, ['config', 'user.email', 'team-test@example.invalid']);
    if (options.initialised) mkdirSync(path.join(dir, '.planning', '.near-ai'), { recursive: true });
    clones[name] = dir;
  }
  return {
    root,
    remote,
    clones,
    storageDir: (name: string) => path.join(root, 'storage', name),
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

export interface TestOwner { identity: DeviceIdentity; memberId: string; secrets: MemorySecrets }

export async function createOwner(teamId: string): Promise<TestOwner> {
  const secrets = new MemorySecrets();
  const identity = await createDeviceIdentity(secrets, teamId);
  return { identity, memberId: newMemberId(), secrets };
}

export interface TestGenesis { events: [TeamEvent<'team.created'>, TeamEvent<'member.joined'>]; anchor: GenesisAnchor; teamFileText: string }

// The same two-event batch Enable Team Mode writes: team.created (lamport 1) then member.joined for the owner (lamport 2).
export function testGenesis(options: { teamId: string; owner: TestOwner; name: string }): TestGenesis {
  const { teamId, owner, name } = options;
  const device = { fingerprint: owner.identity.fingerprint, publicKey: owner.identity.publicKey };
  const hashes = [emailHash(teamId, 'owner@example.invalid')];
  const created = signEvent(owner.identity, {
    v: 1, id: newEventId(), teamId, type: 'team.created', lamport: 1, at: '2026-01-01T00:00:00.000Z', author: owner.memberId, device: device.fingerprint, prev: '',
    body: { name, ownerId: owner.memberId, ownerName: 'Owner Test', ownerEmailHashes: hashes, ownerDevice: device, policy: defaultTeamPolicy() }
  });
  const joined = signEvent(owner.identity, {
    v: 1, id: newEventId(), teamId, type: 'member.joined', lamport: 2, at: '2026-01-01T00:00:01.000Z', author: owner.memberId, device: device.fingerprint, prev: created.id,
    body: { memberId: owner.memberId, name: 'Owner Test', emailHashes: hashes, role: 'owner', device }
  });
  const teamFile: TeamFile = {
    version: 1, teamId, name, coordination: { transport: 'git', ref: DEFAULT_COORDINATION_REF, remote: 'origin' },
    genesis: { eventId: created.id, ownerDevice: device }, createdAt: '2026-01-01T00:00:00.000Z'
  };
  return { events: [created, joined], anchor: { teamId, eventId: created.id, ownerDevice: device }, teamFileText: canonicalize(teamFile) };
}
