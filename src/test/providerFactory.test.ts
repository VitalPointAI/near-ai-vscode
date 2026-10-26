import assert from 'node:assert/strict';
import test from 'node:test';
import { OrganizationProfile, createProjectCredentialScope } from '../domain/auth';
import { AuthService, SecretStorageLike, scopedSecret } from '../services/auth';
import { createNearAiProvider } from '../services/providerFactory';

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

function profile(profileId: string, validation: OrganizationProfile['validation'] = { status: 'valid', validatedAt: '2026-01-01T00:00:00Z' }): OrganizationProfile {
  return { version: 1, profileId, displayName: profileId, organization: 'Example Company', provider: 'near-ai', baseUrl: 'https://example.test/v1', authMode: 'apiKey', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', validation };
}

test('provider factory isolates project and profile SecretStorage slots and never serializes the bearer', async () => {
  const secrets = new MemorySecrets();
  const auth = new AuthService(secrets);
  const scopeA = createProjectCredentialScope('/workspace/project-a', 'profile-company');
  const scopeB = createProjectCredentialScope('/workspace/project-b', 'profile-company');
  const otherProfile = createProjectCredentialScope('/workspace/project-a', 'profile-other');
  await auth.saveScopedApiKey(scopeA, 'project-a-secret');
  assert.match(scopedSecret(scopeA, 'api-key'), /^nearAi\.v2\.project-[a-f0-9]{32}\.profile-company\.api-key$/);
  assert.doesNotMatch(scopedSecret(scopeA, 'api-key'), /workspace|Example Company|project-a-secret/);

  const requests: Array<{ url: string; authorization: string }> = [];
  const provider = await createNearAiProvider({ auth, profile: profile('profile-company'), scope: scopeA, fetchFn: async (url, init) => {
    requests.push({ url: String(url), authorization: String((init?.headers as Record<string, string>).authorization) });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  } });
  await provider.client.listModels();
  assert.deepEqual(requests, [{ url: 'https://example.test/v1/models', authorization: 'Bearer project-a-secret' }, { url: 'https://example.test/v1/model/list', authorization: 'Bearer project-a-secret' }]);
  assert.equal(await auth.getScopedApiKey(scopeB), undefined);
  assert.equal(await auth.getScopedApiKey(otherProfile), undefined);
  assert.doesNotMatch(JSON.stringify({ profileId: provider.profileId, projectId: provider.projectId, baseUrl: provider.baseUrl }), /project-a-secret/);
});

test('provider factory requires an explicitly validated matching profile', async () => {
  const auth = new AuthService(new MemorySecrets());
  const scope = createProjectCredentialScope('/workspace/project-a', 'profile-company');
  await auth.saveScopedApiKey(scope, 'secret-a');
  await assert.rejects(() => createNearAiProvider({ auth, profile: profile('profile-company', { status: 'stale' }), scope }), /validation/);
  await assert.rejects(() => createNearAiProvider({ auth, profile: profile('profile-other'), scope }), /scope/);
});

test('an explicit selected profile changes the host-side credential resolution', async () => {
  const secrets = new MemorySecrets();
  const auth = new AuthService(secrets);
  const firstScope = createProjectCredentialScope('/workspace/project-a', 'profile-first');
  const secondScope = createProjectCredentialScope('/workspace/project-a', 'profile-second');
  await auth.saveScopedApiKey(firstScope, 'first-secret');
  await auth.saveScopedApiKey(secondScope, 'second-secret');
  const seen: string[] = [];
  const first = await createNearAiProvider({ auth, profile: profile('profile-first'), scope: firstScope, fetchFn: async (_url, init) => { seen.push(String((init?.headers as Record<string, string>).authorization)); return new Response(JSON.stringify({ data: [] }), { status: 200 }); } });
  await first.client.listModels();
  const second = await createNearAiProvider({ auth, profile: profile('profile-second'), scope: secondScope, fetchFn: async (_url, init) => { seen.push(String((init?.headers as Record<string, string>).authorization)); return new Response(JSON.stringify({ data: [] }), { status: 200 }); } });
  await second.client.listModels();
  assert.deepEqual(seen, ['Bearer first-secret', 'Bearer first-secret', 'Bearer second-secret', 'Bearer second-secret']);
});
