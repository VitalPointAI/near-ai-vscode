import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthService, SecretStorageLike } from '../services/auth';
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
