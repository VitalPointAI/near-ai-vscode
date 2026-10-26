import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectCredentialScope, deriveProfileId, isProfileId } from '../domain/auth';
import { API_KEY_SECRET, REFRESH_TOKEN_SECRET, AuthService, SecretStorageLike, scopedSecret } from '../services/auth';

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

test('scoped auth stores API and refresh credentials only under versioned project/profile keys', async () => {
  const secrets = new MemorySecrets();
  const auth = new AuthService(secrets);
  const scope = createProjectCredentialScope('/workspace/project-a', 'profile-company');
  await auth.saveScopedApiKey(scope, 'api-secret');
  await auth.saveScopedRefreshToken(scope, 'refresh-secret');
  assert.equal(await auth.getScopedApiKey(scope), 'api-secret');
  assert.equal(await auth.getScopedRefreshToken(scope), 'refresh-secret');
  assert.deepEqual([...secrets.values.keys()], [scopedSecret(scope, 'api-key'), scopedSecret(scope, 'refresh-token')]);
  assert.equal([...secrets.values.keys()].some((key) => key.includes('/workspace/project-a')), false);
});

test('legacy credentials require an explicit current-project import and are never a scoped fallback', async () => {
  const secrets = new MemorySecrets();
  secrets.values.set(API_KEY_SECRET, 'legacy-api');
  secrets.values.set(REFRESH_TOKEN_SECRET, 'legacy-refresh');
  const auth = new AuthService(secrets);
  const scope = createProjectCredentialScope('/workspace/project-a', 'profile-company');
  await assert.rejects(() => auth.importLegacyCredentials(scope, false), /confirmation/);
  const imported = await auth.importLegacyCredentials(scope, true);
  assert.deepEqual(imported, { apiKeyImported: true, refreshTokenImported: true });
  assert.equal(await auth.getScopedApiKey(scope), 'legacy-api');
  const otherProject = createProjectCredentialScope('/workspace/project-b', 'profile-company');
  assert.equal(await auth.getScopedApiKey(otherProject), undefined);
  assert.equal(await auth.getScopedRefreshToken(otherProject), undefined);
});

test('invalid scopes cannot be used to probe arbitrary SecretStorage keys', async () => {
  const auth = new AuthService(new MemorySecrets());
  await assert.rejects(() => auth.getScopedApiKey({ version: 1, projectId: '/workspace/project-a', profileId: 'profile-company' }), /valid project/);
});

test('project names are user-friendly while internal profile scopes remain valid and opaque', () => {
  const profileId = deriveProfileId('/workspace/project-a', 'Research & Development / 2026');
  assert.equal(isProfileId(profileId), true);
  assert.match(profileId, /^profile-research-development-2026-[a-f0-9]{10}$/);
  assert.equal(deriveProfileId('/workspace/project-a', 'Research & Development / 2026'), profileId);
  assert.notEqual(deriveProfileId('/workspace/project-b', 'Research & Development / 2026'), profileId);
});
