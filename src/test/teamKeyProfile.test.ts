// A team API key installed as the project's active credential in a project-scoped profile, with the
// member's own profile remembered and restored. Proven against the fake NEAR server.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isProfileId } from '../domain/auth';
import { AuthService } from '../services/auth';
import { ProfileStore } from '../services/profileStore';
import { NearAuth, NearOrgClient } from '../team/nearOrg';
import { installTeamKey, readInstalledKey, removeTeamKey, teamProfileId } from '../team/teamKeyProfile';
import { teamStorageDir } from '../team/teamFile';
import { FakeNear, startFakeNear } from './helpers/fakeNear';
import { MemorySecrets } from './helpers/teamHarness';

const GIGA = 1_000_000_000;
const TEAM_ID = `team-${'a1'.repeat(16)}`;
const never = async (): Promise<void> => undefined;

interface Fixture {
  fake: FakeNear;
  client: NearOrgClient;
  secrets: MemorySecrets;
  auth: AuthService;
  store: ProfileStore;
  projectRoot: string;
  storage: string;
  teamDir: string;
  makeKey(name: string, limit?: number): Promise<{ id: string; secret: Buffer }>;
}

function staticAuth(token: string): NearAuth {
  return { accessToken: async () => token, refreshAfterUnauthorized: async () => undefined };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fake = await startFakeNear();
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'near-ai-team-key-project-'));
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-team-key-storage-'));
  try {
    const lead = fake.addUser({ id: 'user-lead', username: 'lead', email: 'lead@example.invalid' });
    fake.addOrganization({ id: 'org-1', name: 'Team Org', members: [{ userId: 'user-lead', role: 'owner' }] });
    fake.addOrganization({ id: 'org-2', name: 'Other Org', members: [{ userId: 'user-lead', role: 'owner' }] });
    fake.addWorkspace({ id: 'ws-1', organizationId: 'org-1', name: 'Team workspace' });
    fake.addWorkspace({ id: 'ws-2', organizationId: 'org-1', name: 'Second workspace' });
    fake.addWorkspace({ id: 'ws-other', organizationId: 'org-2', name: 'Other workspace' });
    const client = new NearOrgClient({ baseUrl: fake.baseUrl, auth: staticAuth(lead.accessToken), sleep: never });
    const secrets = new MemorySecrets();
    const auth = new AuthService(secrets);
    const store = new ProfileStore(projectRoot, auth, { validator: async () => undefined });
    await run({
      fake, client, secrets, auth, store, projectRoot, storage,
      teamDir: teamStorageDir(storage, TEAM_ID),
      async makeKey(name, limit = 5 * GIGA) {
        const workspace = name.startsWith('other') ? 'ws-other' : name.startsWith('second') ? 'ws-2' : 'ws-1';
        const created = await client.createKey(workspace, name, limit);
        return { id: created.key.id, secret: created.secret };
      }
    });
  } finally {
    await fake.close();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}

async function personalProfile(store: ProfileStore, id = 'profile-personal'): Promise<void> {
  await store.configure({ profileId: id, displayName: 'Personal', organization: 'Me', baseUrl: 'https://example.test/v1', authMode: 'apiKey' }, `sk-${id}-key`);
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

test('the team profile id is profile-team- plus ten hex characters of the team id hash', () => {
  const id = teamProfileId(TEAM_ID);
  assert.match(id, /^profile-team-[0-9a-f]{10}$/);
  assert.ok(isProfileId(id));
  assert.equal(teamProfileId(TEAM_ID), id);
  assert.notEqual(teamProfileId(`team-${'b2'.repeat(16)}`), id);
});

test('a team key installs as the active profile after NEAR activates it, and the key reads back for that scope', async () => {
  await withFixture(async (f) => {
    await personalProfile(f.store);
    const { id, secret } = await f.makeKey('team-key-1');
    const plain = secret.toString('utf8');
    f.fake.setActivationDelayMs(3000);
    const sleeps: number[] = [];
    const result = await installTeamKey({
      projectRoot: f.projectRoot, globalStorageDir: f.storage, teamId: TEAM_ID, teamName: 'Acme Team', secrets: f.secrets, apiKey: secret,
      baseUrl: f.fake.baseUrl, expect: { organizationId: 'org-1', workspaceId: 'ws-1' }, keyId: id,
      sleep: async (ms) => { sleeps.push(ms); await new Promise((resolve) => setTimeout(resolve, 700)); }, attempts: 10
    });
    assert.deepEqual(result, { ok: true, profileId: teamProfileId(TEAM_ID), capped: false });
    assert.ok(sleeps.length > 0, 'the activation delay was waited out');

    const fresh = new ProfileStore(f.projectRoot, f.auth);
    assert.equal((await fresh.getActiveSelection())?.profileId, teamProfileId(TEAM_ID));
    const profile = await fresh.get(teamProfileId(TEAM_ID));
    assert.match(profile?.displayName ?? '', /^Acme Team \(team key\)$/);
    assert.equal(profile?.authMode, 'apiKey');
    assert.equal(profile?.validation.status, 'valid');
    assert.equal(await f.auth.getScopedApiKey(fresh.getScope(teamProfileId(TEAM_ID))), plain);

    assert.deepEqual(await readInstalledKey(f.storage, TEAM_ID), { keyId: id, previousProfileId: 'profile-personal' });
    assert.ok(secret.every((byte) => byte === 0), 'the key buffer is wiped once it is installed');
    assert.ok(!(await readFile(path.join(f.teamDir, 'join.json'), 'utf8')).includes(plain));
    assert.ok(!(await readFile(path.join(f.projectRoot, '.planning', '.near-ai', 'auth-profiles.json'), 'utf8')).includes(plain));
  });
});

test('the first remembered personal profile is not overwritten by a later install', async () => {
  await withFixture(async (f) => {
    await personalProfile(f.store);
    await personalProfile(f.store, 'profile-other');
    const first = await f.makeKey('team-key-1');
    const common = { projectRoot: f.projectRoot, globalStorageDir: f.storage, teamId: TEAM_ID, teamName: 'Acme', secrets: f.secrets, baseUrl: f.fake.baseUrl, sleep: never };
    assert.equal((await installTeamKey({ ...common, apiKey: first.secret, keyId: first.id })).ok, true);

    // The member switches to another profile, then the lead sends a new key.
    await f.store.select('profile-other');
    const second = await f.makeKey('team-key-2');
    assert.equal((await installTeamKey({ ...common, apiKey: second.secret, keyId: second.id })).ok, true);
    assert.deepEqual(await readInstalledKey(f.storage, TEAM_ID), { keyId: second.id, previousProfileId: 'profile-personal' });
    assert.equal((await new ProfileStore(f.projectRoot, f.auth).getActiveSelection())?.profileId, teamProfileId(TEAM_ID));
  });
});

test('a key from another organization or workspace is refused and nothing is selected or stored', async () => {
  await withFixture(async (f) => {
    await personalProfile(f.store);
    const common = { projectRoot: f.projectRoot, globalStorageDir: f.storage, teamId: TEAM_ID, teamName: 'Acme', secrets: f.secrets, baseUrl: f.fake.baseUrl, sleep: never };
    const foreignOrg = await f.makeKey('other-key');
    const wrongOrg = await installTeamKey({ ...common, apiKey: foreignOrg.secret, expect: { organizationId: 'org-1', workspaceId: 'ws-1' } });
    assert.equal(wrongOrg.ok === false && wrongOrg.code, 'wrong-organization');

    const foreignWorkspace = await f.makeKey('second-key');
    const wrongWorkspace = await installTeamKey({ ...common, apiKey: foreignWorkspace.secret, expect: { organizationId: 'org-1', workspaceId: 'ws-1' } });
    assert.equal(wrongWorkspace.ok === false && wrongWorkspace.code, 'wrong-workspace');

    const fresh = new ProfileStore(f.projectRoot, f.auth);
    assert.equal((await fresh.getActiveSelection())?.profileId, 'profile-personal');
    assert.equal(await fresh.get(teamProfileId(TEAM_ID)), undefined);
    assert.equal(await f.auth.getScopedApiKey(fresh.getScope(teamProfileId(TEAM_ID))), undefined);
    assert.equal(await readInstalledKey(f.storage, TEAM_ID), undefined);
  });
});

test('a revoked key is invalid after the attempts and a failed re-install keeps the working key', async () => {
  await withFixture(async (f) => {
    await personalProfile(f.store);
    const good = await f.makeKey('team-key-1');
    const goodText = good.secret.toString('utf8');
    const common = { projectRoot: f.projectRoot, globalStorageDir: f.storage, teamId: TEAM_ID, teamName: 'Acme', secrets: f.secrets, baseUrl: f.fake.baseUrl };
    assert.equal((await installTeamKey({ ...common, apiKey: good.secret, sleep: never })).ok, true);

    const bad = await f.makeKey('team-key-2');
    await f.client.revokeKey('ws-1', bad.id);
    const sleeps: number[] = [];
    const result = await installTeamKey({ ...common, apiKey: bad.secret, attempts: 4, sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(result.ok === false && result.code, 'invalid');
    assert.equal(result.ok === false && /different|expired|ask the lead/i.test(result.message), true);
    assert.equal(sleeps.length, 3, 'four attempts, three waits');

    const fresh = new ProfileStore(f.projectRoot, f.auth);
    assert.equal(await f.auth.getScopedApiKey(fresh.getScope(teamProfileId(TEAM_ID))), goodText, 'the working key is untouched');
    assert.equal((await fresh.getActiveSelection())?.profileId, teamProfileId(TEAM_ID));
  });
});

test('a key at its spend limit is accepted and reported as capped', async () => {
  await withFixture(async (f) => {
    await personalProfile(f.store);
    const { id, secret } = await f.makeKey('team-key-1', 1 * GIGA);
    f.fake.addUsage(id, 1 * GIGA);
    const result = await installTeamKey({ projectRoot: f.projectRoot, globalStorageDir: f.storage, teamId: TEAM_ID, teamName: 'Acme', secrets: f.secrets, apiKey: secret, baseUrl: f.fake.baseUrl, sleep: never });
    assert.deepEqual(result, { ok: true, profileId: teamProfileId(TEAM_ID), capped: true });
    assert.equal((await new ProfileStore(f.projectRoot, f.auth).getActiveSelection())?.profileId, teamProfileId(TEAM_ID));
  });
});

test('an unreachable NEAR answers unavailable, not invalid', async () => {
  await withFixture(async (f) => {
    const { secret } = await f.makeKey('team-key-1');
    f.fake.fail({ method: 'POST', pathPrefix: '/v1/check_api_key', status: 500, times: 10 });
    const result = await installTeamKey({ projectRoot: f.projectRoot, globalStorageDir: f.storage, teamId: TEAM_ID, teamName: 'Acme', secrets: f.secrets, apiKey: secret, baseUrl: f.fake.baseUrl, attempts: 2, sleep: never });
    assert.equal(result.ok === false && result.code, 'unavailable');
  });
});

test('the team name becomes a safe display label', async () => {
  await withFixture(async (f) => {
    const cases: Array<[string, RegExp]> = [
      ['My API key\u0007 crew', /^My crew \(team key\)$/],
      ['bearer token command: x', /^x \(team key\)$/],
      ['', /^Team \(team key\)$/],
      ['api key', /^Team \(team key\)$/],
      ['W'.repeat(60), /^W{40} \(team key\)$/]
    ];
    for (const [name, expected] of cases) {
      const { secret } = await f.makeKey(`team-key-${Math.random().toString(36).slice(2, 8)}`);
      const result = await installTeamKey({ projectRoot: f.projectRoot, globalStorageDir: f.storage, teamId: TEAM_ID, teamName: name, secrets: f.secrets, apiKey: secret, baseUrl: f.fake.baseUrl, sleep: never });
      assert.equal(result.ok, true, name);
      const profile = await new ProfileStore(f.projectRoot, f.auth).get(teamProfileId(TEAM_ID));
      assert.match(profile?.displayName ?? '', expected, name);
    }
  });
});

test('removing the team key restores the personal profile and deletes only the team profile and its files', async () => {
  await withFixture(async (f) => {
    await personalProfile(f.store);
    const { id, secret } = await f.makeKey('team-key-1');
    await installTeamKey({ projectRoot: f.projectRoot, globalStorageDir: f.storage, teamId: TEAM_ID, teamName: 'Acme', secrets: f.secrets, apiKey: secret, baseUrl: f.fake.baseUrl, keyId: id, sleep: never });
    const teamScope = f.store.getScope(teamProfileId(TEAM_ID));
    assert.ok(await f.auth.getScopedApiKey(teamScope));

    const removed = await removeTeamKey({ projectRoot: f.projectRoot, globalStorageDir: f.storage, teamId: TEAM_ID, secrets: f.secrets });
    assert.deepEqual(removed, { restoredProfileId: 'profile-personal' });

    const fresh = new ProfileStore(f.projectRoot, f.auth);
    assert.equal((await fresh.getActiveSelection())?.profileId, 'profile-personal');
    assert.equal(await fresh.get(teamProfileId(TEAM_ID)), undefined);
    assert.equal(await f.auth.getScopedApiKey(teamScope), undefined, 'the scoped team key is gone');
    assert.equal(await f.auth.getScopedApiKey(fresh.getScope('profile-personal')), 'sk-profile-personal-key', 'the personal key is untouched');
    assert.equal(await exists(path.join(f.teamDir, 'join.json')), false);
    assert.equal(await exists(path.join(f.teamDir, 'key.json')), false);
    assert.equal(await readInstalledKey(f.storage, TEAM_ID), undefined);

    assert.deepEqual(await removeTeamKey({ projectRoot: f.projectRoot, globalStorageDir: f.storage, teamId: TEAM_ID, secrets: f.secrets }), {}, 'removing twice is harmless');
  });
});

test('removing the team key does not override a profile the member chose afterwards, and never removes the personal one', async () => {
  await withFixture(async (f) => {
    await personalProfile(f.store);
    await personalProfile(f.store, 'profile-chosen');
    const { secret } = await f.makeKey('team-key-1');
    await installTeamKey({ projectRoot: f.projectRoot, globalStorageDir: f.storage, teamId: TEAM_ID, teamName: 'Acme', secrets: f.secrets, apiKey: secret, baseUrl: f.fake.baseUrl, sleep: never });
    await new ProfileStore(f.projectRoot, f.auth).select('profile-chosen');
    const removed = await removeTeamKey({ projectRoot: f.projectRoot, globalStorageDir: f.storage, teamId: TEAM_ID, secrets: f.secrets });
    assert.deepEqual(removed, {});
    const fresh = new ProfileStore(f.projectRoot, f.auth);
    assert.equal((await fresh.getActiveSelection())?.profileId, 'profile-chosen');
    assert.ok(await fresh.get('profile-personal'));
    assert.equal(await fresh.get(teamProfileId(TEAM_ID)), undefined);
  });
});

test('removing the team key when the personal profile is gone leaves nothing selected rather than failing', async () => {
  await withFixture(async (f) => {
    await personalProfile(f.store);
    const { secret } = await f.makeKey('team-key-1');
    await installTeamKey({ projectRoot: f.projectRoot, globalStorageDir: f.storage, teamId: TEAM_ID, teamName: 'Acme', secrets: f.secrets, apiKey: secret, baseUrl: f.fake.baseUrl, sleep: never });
    await new ProfileStore(f.projectRoot, f.auth).remove('profile-personal');
    assert.deepEqual(await removeTeamKey({ projectRoot: f.projectRoot, globalStorageDir: f.storage, teamId: TEAM_ID, secrets: f.secrets }), {});
    assert.equal(await new ProfileStore(f.projectRoot, f.auth).getActiveSelection(), undefined);
  });
});
