import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthService, SecretStorageLike } from '../services/auth';
import { initProfileIndex, listSavedProfiles } from '../services/profileIndex';
import { ProfileStore, ProfileStoreFileSystem } from '../services/profileStore';

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

async function tempRoot(): Promise<string> { return mkdtemp(path.join(tmpdir(), 'near-ai-profile-store-')); }

test('profile store persists allowlisted named organization metadata and active selection', async () => {
  const root = await tempRoot();
  try {
    const store = new ProfileStore(root, { clock: () => '2026-01-01T00:00:00.000Z' });
    const created = await store.create({ profileId: 'profile-company', displayName: 'Company Cloud', organization: 'Example Company', baseUrl: 'https://example.test/v1', authMode: 'apiKey' });
    assert.equal(created.validation.status, 'pending');
    await assert.rejects(() => store.select(created.profileId), /validation/);
    await store.validate(created.profileId, async () => undefined);
    await store.select(created.profileId);
    const rehydrated = new ProfileStore(root);
    assert.equal((await rehydrated.getActiveSelection())?.profileId, 'profile-company');
    const exported = await rehydrated.exportMetadata();
    assert.equal(JSON.stringify(exported).includes('secret'), false);
    assert.equal(JSON.stringify(exported).includes('api-secret'), false);
    const persisted = await readFile(path.join(root, '.planning', '.near-ai', 'auth-profiles.json'), 'utf8');
    assert.match(persisted, /Example Company/);
    assert.doesNotMatch(persisted, /private prompt|raw context|command:|api-secret|refresh-secret/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('profile update invalidates validation, selection remains explicit, and deletion removes scoped credentials', async () => {
  const root = await tempRoot();
  const secrets = new MemorySecrets();
  try {
    const auth = new AuthService(secrets);
    const store = new ProfileStore(root, auth);
    await store.create({ profileId: 'profile-company', displayName: 'Company', organization: 'Company', baseUrl: 'https://example.test/v1', authMode: 'apiKey' });
    await auth.saveScopedApiKey(store.getScope('profile-company'), 'secret');
    await store.validate('profile-company', async () => undefined);
    await store.select('profile-company');
    const updated = await store.update({ profileId: 'profile-company', baseUrl: 'https://changed.test/v1' });
    assert.equal(updated.validation.status, 'stale');
    await assert.rejects(() => store.select('profile-company'), /validation/);
    assert.equal(await store.remove('profile-company'), true);
    assert.equal(await auth.getScopedApiKey(store.getScope('profile-company')), undefined);
    assert.equal(await store.getActiveSelection(), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('profile migration rewrites older allowlisted records and rejects malformed records', async () => {
  const root = await tempRoot();
  try {
    const fileSystem: ProfileStoreFileSystem = {
      mkdir: async (directory, options) => { const { mkdir } = await import('node:fs/promises'); await mkdir(directory, options); },
      readFile: async (file, encoding) => {
        if (file.endsWith('auth-profiles.json')) return JSON.stringify({ version: 0, profiles: [
          { profileId: 'profile-old', displayName: 'Old', company: 'Old Co', baseUrl: 'https://old.test/v1', authMode: 'apiKey', apiKey: 'do-not-persist' },
          { profileId: 'not-allowed', displayName: 'Bad', organization: 'Bad', baseUrl: 'not a url', authMode: 'apiKey' }
        ] });
        const { readFile } = await import('node:fs/promises'); return readFile(file, encoding);
      },
      rename: async (oldPath, newPath) => { const { rename } = await import('node:fs/promises'); await rename(oldPath, newPath); },
      writeFile: async (file, data, encoding) => { const { writeFile } = await import('node:fs/promises'); await writeFile(file, data, encoding); }
    };
    const store = new ProfileStore(root, { fileSystem });
    assert.deepEqual((await store.list()).map((profile) => profile.profileId), ['profile-old']);
    const exported = await store.exportMetadata();
    assert.equal(JSON.stringify(exported).includes('do-not-persist'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy import leaves the profile pending until provider validation and cannot select another project', async () => {
  const root = await tempRoot();
  const secrets = new MemorySecrets();
  try {
    const auth = new AuthService(secrets);
    await auth.saveApiKey('legacy-api');
    const store = new ProfileStore(root, auth);
    await store.create({ profileId: 'profile-company', displayName: 'Company', organization: 'Company', baseUrl: 'https://example.test/v1', authMode: 'apiKey' });
    const result = await store.importLegacy('profile-company', true);
    assert.equal(result.apiKeyImported, true);
    assert.equal(result.profile.validation.status, 'pending');
    await assert.rejects(() => store.select('profile-company'), /validation/);
    const otherProjectStore = new ProfileStore(`${root}-other`, auth);
    assert.equal(await auth.getScopedApiKey(otherProjectStore.getScope('profile-company')), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('configure saves the key, validates, and activates the profile so chat can use it', async () => {
  const root = await tempRoot();
  try {
    const store = new ProfileStore(root, new AuthService(new MemorySecrets()), { validator: async () => undefined });
    const profile = await store.configure({ profileId: 'profile-acme', displayName: 'Acme', organization: 'Acme', baseUrl: 'https://example.test/v1', authMode: 'apiKey' }, 'sk-test');
    assert.equal(profile.validation.status, 'valid');
    assert.equal((await new ProfileStore(root).getActiveProfile())?.profileId, 'profile-acme');
    const again = await store.configure({ profileId: 'profile-acme', displayName: 'Acme', organization: 'Acme Corp', baseUrl: 'https://example.test/v1', authMode: 'apiKey' }, 'sk-new');
    assert.equal(again.organization, 'Acme Corp');
    assert.equal(again.validation.status, 'valid');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configure leaves the active profile unchanged when the key fails validation', async () => {
  const root = await tempRoot();
  try {
    const store = new ProfileStore(root, new AuthService(new MemorySecrets()), { validator: async () => { throw new Error('HTTP 401'); } });
    const profile = await store.configure({ profileId: 'profile-bad', displayName: 'Bad', organization: 'Bad', baseUrl: 'https://example.test/v1', authMode: 'apiKey' }, 'sk-wrong');
    assert.equal(profile.validation.status, 'invalid');
    assert.match(profile.validation.error ?? '', /401/);
    assert.equal(await store.getActiveSelection(), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// G-61-9: a profile reused from another project. Removing the copy never touches the original key, and a copy whose original is gone says so.
class MemoryMemento {
  public readonly values = new Map<string, unknown>();
  public get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  public update(key: string, value: unknown): Promise<void> { this.values.set(key, JSON.parse(JSON.stringify(value))); return Promise.resolve(); }
}

async function twoProjects(): Promise<{ base: string; secrets: MemorySecrets; auth: AuthService; canary: string; alpha: ProfileStore; beta: ProfileStore; store(root: string): ProfileStore; rootB: string; cleanup(): Promise<void> }> {
  const base = await mkdtemp(path.join(tmpdir(), 'near-ai-profile-copy-'));
  const rootA = path.join(base, 'alpha-site');
  const rootB = path.join(base, 'beta-app');
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });
  initProfileIndex(new MemoryMemento());
  const secrets = new MemorySecrets();
  const auth = new AuthService(secrets);
  const canary = `sk-canary-${randomUUID()}`;
  const validator = async (_profile: unknown, scope: unknown): Promise<void> => { if (await auth.getScopedApiKey(scope as never) !== canary) throw new Error('HTTP 401'); };
  const store = (root: string): ProfileStore => new ProfileStore(root, auth, { validator });
  const alpha = store(rootA);
  await alpha.configure({ profileId: 'profile-alpha-cloud', displayName: 'Alpha Cloud', organization: 'Alpha Co', baseUrl: 'https://example.test/v1', authMode: 'apiKey' }, canary);
  return { base, secrets, auth, canary, alpha, beta: store(rootB), store, rootB, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test('removing a reused profile removes only this project\'s copy; the original profile and its key stay', async () => {
  const w = await twoProjects();
  try {
    const copy = await w.beta.useSavedProfile(listSavedProfiles(w.beta.projectScopeId)[0]);
    assert.equal(copy.validation.status, 'valid');
    assert.equal(await w.beta.remove(copy.profileId), true);
    assert.deepEqual(await w.beta.list(), [], 'the copy is gone from this project');
    assert.equal(await w.beta.getActiveSelection(), undefined, 'and is no longer selected');
    assert.equal(await w.auth.getScopedApiKey(w.alpha.getScope('profile-alpha-cloud')), w.canary, 'the original key is untouched');
    assert.equal((await w.alpha.get('profile-alpha-cloud'))?.validation.status, 'valid', 'the original profile is untouched');
    assert.deepEqual(listSavedProfiles().map((entry) => entry.profileId), ['profile-alpha-cloud'], 'the original is still offered');
  } finally { await w.cleanup(); }
});

test('when the original profile is removed, the copy says plainly that it no longer works', async () => {
  const w = await twoProjects();
  try {
    const copy = await w.beta.useSavedProfile(listSavedProfiles(w.beta.projectScopeId)[0]);
    assert.equal(await w.alpha.remove('profile-alpha-cloud'), true);
    assert.equal(w.secrets.values.size, 0, 'removing the original removed its key');
    assert.deepEqual(listSavedProfiles(), [], 'the removed profile is no longer offered');
    const checked = await w.store(w.rootB).validate(copy.profileId);
    assert.equal(checked.validation.status, 'invalid');
    assert.equal(checked.validation.error, 'The saved profile this one uses was removed. Set up a new profile or choose another.');
  } finally { await w.cleanup(); }
});

test('setting up a reused profile again gives this project its own key and never writes the original project\'s key', async () => {
  const w = await twoProjects();
  try {
    const copy = await w.beta.useSavedProfile(listSavedProfiles(w.beta.projectScopeId)[0]);
    await assert.rejects(() => w.beta.saveProfileApiKey(copy.profileId, 'sk-other'), /key saved in another project/);
    assert.equal(await w.auth.getScopedApiKey(w.alpha.getScope('profile-alpha-cloud')), w.canary, 'the original key was not overwritten');
  } finally { await w.cleanup(); }
});

test('a reused profile whose source is malformed in the profile file is dropped on load, and a hand-written source reaches no key', async () => {
  const w = await twoProjects();
  try {
    const alphaId = w.alpha.projectScopeId;
    const base = { version: 1, displayName: 'Alpha Cloud', organization: 'Alpha Co', provider: 'near-ai', baseUrl: 'https://example.test/v1', authMode: 'apiKey', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', validation: { status: 'valid', validatedAt: '2026-01-01T00:00:00.000Z' } };
    const write = async (profiles: unknown[], active?: string): Promise<void> => {
      await mkdir(path.dirname(w.beta.filePath), { recursive: true });
      await writeFile(w.beta.filePath, JSON.stringify({ version: 1, projectId: w.beta.projectScopeId, profiles, ...(active ? { active: { profileId: active, selectedAt: '2026-01-01T00:00:00.000Z' } } : {}) }), 'utf8');
    };
    await write([
      { ...base, profileId: 'profile-alpha-cloud', keySource: { projectId: '../alpha', profileId: 'profile-alpha-cloud' } },
      { ...base, profileId: 'profile-bad-id', keySource: { projectId: alphaId, profileId: 'not a profile' } },
      { ...base, profileId: 'profile-other-id', keySource: { projectId: alphaId, profileId: 'profile-alpha-cloud' } },
      { ...base, profileId: 'profile-extra', keySource: { projectId: alphaId, profileId: 'profile-extra', path: '/tmp' } },
      { ...base, profileId: 'profile-string', keySource: 'profile-alpha-cloud' }
    ]);
    assert.deepEqual(await w.store(w.rootB).list(), [], 'every malformed copy is dropped');

    // Well formed, but never chosen through Use a saved profile on this computer (for example shipped in a cloned repository).
    await write([{ ...base, profileId: 'profile-alpha-cloud', keySource: { projectId: alphaId, profileId: 'profile-alpha-cloud' } }], 'profile-alpha-cloud');
    const tampered = w.store(w.rootB);
    const [loaded] = await tampered.list();
    assert.notEqual(loaded?.validation.status, 'valid', 'it is not trusted as checked');
    assert.notDeepEqual(tampered.getScope('profile-alpha-cloud'), w.alpha.getScope('profile-alpha-cloud'), 'it does not resolve to the other project\'s key');
    assert.equal(await w.auth.getScopedApiKey(tampered.getScope('profile-alpha-cloud')), undefined);
    const checked = await tampered.validate('profile-alpha-cloud');
    assert.equal(checked.validation.status, 'invalid');
    assert.equal(checked.validation.error, 'That saved profile is no longer available. Set up a new profile or choose another.');
  } finally { await w.cleanup(); }
});
