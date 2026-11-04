// G-61-9 (61-UAT test 10): a NEAR AI profile set up in one project can be used in another without entering its key again. The list of saved
// profiles lives in VS Code's global state as metadata only; the copy uses the original project's stored key by reference.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthService, SecretStorageLike } from '../services/auth';
import { initProfileIndex, listSavedProfiles } from '../services/profileIndex';
import { ProfileStore } from '../services/profileStore';
import { createNearAiProvider } from '../services/providerFactory';

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

/** VS Code's globalState: the value changes in memory at once and is saved later. */
class MemoryMemento {
  public readonly values = new Map<string, unknown>();
  public writes = 0;
  public get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  public update(key: string, value: unknown): Promise<void> {
    this.writes += 1;
    if (value === undefined) this.values.delete(key); else this.values.set(key, JSON.parse(JSON.stringify(value)));
    return Promise.resolve();
  }
  public dump(): string { return JSON.stringify([...this.values.entries()]); }
}

const BASE_URL = 'https://example.test/v1';

interface World {
  base: string;
  rootA: string;
  rootB: string;
  secrets: MemorySecrets;
  auth: AuthService;
  memento: MemoryMemento;
  canary: string;
  checked: Array<{ projectId: string; profileId: string; key: string | undefined }>;
  store(root: string): ProfileStore;
  cleanup(): Promise<void>;
}

async function world(): Promise<World> {
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-profile-index-'));
  const rootA = path.join(base, 'alpha-site');
  const rootB = path.join(base, 'beta-app');
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });
  const secrets = new MemorySecrets();
  const auth = new AuthService(secrets);
  const memento = new MemoryMemento();
  initProfileIndex(memento);
  const canary = `sk-canary-${randomUUID()}`;
  const checked: World['checked'] = [];
  // The check reads the key through the scope it is given, as the real provider check does.
  const validator = async (_profile: unknown, scope: { projectId: string; profileId: string }): Promise<void> => {
    const key = await auth.getScopedApiKey(scope as never);
    checked.push({ projectId: scope.projectId, profileId: scope.profileId, key });
    if (key !== canary) throw new Error('HTTP 401');
  };
  return {
    base, rootA, rootB, secrets, auth, memento, canary, checked,
    store: (root) => new ProfileStore(root, auth, { validator }),
    cleanup: async () => { await rm(base, { recursive: true, force: true }); }
  };
}

async function setUpAlpha(w: World): Promise<ProfileStore> {
  const alpha = w.store(w.rootA);
  const profile = await alpha.configure({ profileId: 'profile-alpha-cloud', displayName: 'Alpha Cloud', organization: 'Alpha Co', baseUrl: BASE_URL, authMode: 'apiKey' }, w.canary);
  assert.equal(profile.validation.status, 'valid', 'the profile in the first project passes its check');
  return alpha;
}

function countCanary(w: World): number { return [...w.secrets.values.values()].filter((value) => value === w.canary).length; }

test('tracer: a profile set up in one project is listed and used in another by reference, and serves a chat request with the original key', async () => {
  const w = await world();
  try {
    const alpha = await setUpAlpha(w);
    const listed = listSavedProfiles();
    assert.equal(listed.length, 1, 'one saved profile is recorded');
    assert.equal(listed[0].projectId, alpha.projectScopeId);
    assert.equal(listed[0].projectLabel, 'alpha-site', 'the folder name only');
    assert.equal(listed[0].profileId, 'profile-alpha-cloud');
    assert.equal(listed[0].displayName, 'Alpha Cloud');
    assert.equal(listed[0].organization, 'Alpha Co');
    assert.equal(listed[0].validation, 'valid');
    assert.equal(JSON.stringify(listed).includes(w.base), false, 'no folder path is recorded');

    const beta = w.store(w.rootB);
    assert.deepEqual(listSavedProfiles(alpha.projectScopeId), [], 'a project is not offered its own profiles');
    const offered = listSavedProfiles(beta.projectScopeId);
    assert.equal(offered.length, 1);
    const copy = await beta.useSavedProfile(offered[0]);
    assert.equal(copy.validation.status, 'valid', 'the copy is checked before it becomes active');
    assert.deepEqual(copy.keySource, { projectId: alpha.projectScopeId, profileId: 'profile-alpha-cloud' });
    assert.equal((await beta.getActiveSelection())?.profileId, copy.profileId, 'the copy is the active profile of the second project');
    assert.deepEqual(w.checked.at(-1), { projectId: alpha.projectScopeId, profileId: 'profile-alpha-cloud', key: w.canary }, 'the check read the first project\'s key by reference');
    assert.deepEqual(beta.getScope(copy.profileId), alpha.getScope('profile-alpha-cloud'), 'every key read follows the reference');
    assert.equal(await w.auth.getScopedApiKey(beta.getScope(copy.profileId)), w.canary);

    // A chat request in the second project is sent with the original key.
    const sent: Array<{ url: string; authorization: string }> = [];
    const provider = await createNearAiProvider({ auth: w.auth, profile: copy, scope: beta.getScope(copy.profileId), fetchFn: async (url, init) => {
      sent.push({ url: String(url), authorization: String((init?.headers as Record<string, string>).authorization) });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    } });
    await provider.client.listModels();
    assert.equal(sent[0]?.url, `${BASE_URL}/models`);
    assert.equal(sent[0]?.authorization, `Bearer ${w.canary}`);

    // The key is stored once, under the first project's scope, and nowhere else.
    assert.equal(countCanary(w), 1, 'the key is in secure storage exactly once');
    assert.equal([...w.secrets.values.keys()].some((key) => key.includes(beta.projectScopeId)), false, 'nothing is stored under the second project\'s scope');
    assert.equal(w.memento.dump().includes(w.canary), false, 'the saved-profile list holds no key');
    assert.equal((await readFile(alpha.filePath, 'utf8')).includes(w.canary), false, 'the first project\'s profile file holds no key');
    assert.equal((await readFile(beta.filePath, 'utf8')).includes(w.canary), false, 'the second project\'s profile file holds no key');
    assert.equal(JSON.stringify(copy).includes(w.canary), false, 'the returned profile holds no key');

    // The copy is not offered again (no chains), and the first project still sees nothing of its own.
    assert.deepEqual(listSavedProfiles().map((entry) => entry.projectId), [alpha.projectScopeId], 'only the original is listed');
    assert.deepEqual(listSavedProfiles(alpha.projectScopeId), []);
  } finally { await w.cleanup(); }
});

test('a team key profile is never offered for use elsewhere', async () => {
  const w = await world();
  try {
    const alpha = await setUpAlpha(w);
    await alpha.create({ profileId: 'profile-team-0123456789', displayName: 'Team key', organization: 'Alpha Co', baseUrl: BASE_URL, authMode: 'apiKey' });
    await w.auth.saveScopedApiKey(alpha.getScope('profile-team-0123456789'), w.canary, BASE_URL);
    await alpha.validate('profile-team-0123456789');
    assert.deepEqual(listSavedProfiles().map((entry) => entry.profileId), ['profile-alpha-cloud'], 'the team profile is left out');
  } finally { await w.cleanup(); }
});

test('the saved-profile list fills when a project is opened and is written only when something changed', async () => {
  const w = await world();
  try {
    await setUpAlpha(w);
    // A fresh list, as on a computer that ran an older version: opening the project fills it.
    const fresh = new MemoryMemento();
    initProfileIndex(fresh);
    assert.deepEqual(listSavedProfiles(), []);
    const reopened = w.store(w.rootA);
    await reopened.list();
    assert.deepEqual(listSavedProfiles().map((entry) => entry.profileId), ['profile-alpha-cloud'], 'opening the project records its profiles');
    const writes = fresh.writes;
    await w.store(w.rootA).list();
    await w.store(w.rootA).list();
    assert.equal(fresh.writes, writes, 'nothing is written when nothing changed');
  } finally { await w.cleanup(); }
});

test('a saved profile is used only when it comes from the list and from another project', async () => {
  const w = await world();
  try {
    const alpha = await setUpAlpha(w);
    const [entry] = listSavedProfiles();
    await assert.rejects(() => alpha.useSavedProfile(entry), /already in this project/);
    const beta = w.store(w.rootB);
    await assert.rejects(() => beta.useSavedProfile({ ...entry, profileId: 'profile-made-up' }), /no longer available/);
    await assert.rejects(() => beta.useSavedProfile({ ...entry, projectId: `project-${'0'.repeat(32)}` }), /no longer available/);
    assert.deepEqual(await beta.list(), [], 'nothing was copied');
  } finally { await w.cleanup(); }
});
