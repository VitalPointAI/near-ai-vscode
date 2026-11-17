// The route check at the client's one choke point (CLAS-06, CLAS-05 as the owner amplified it, D-31, D-50): every content request is decided in
// NearAiClient.request, from the session route it runs inside and local facts only, before anything is sent. Every fetch here is a counting stub; nothing
// reaches the network and no key is read.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectCredentialScope } from '../domain/auth';
import type { OrganizationProfile } from '../domain/auth';
import type { Mark } from '../domain/gate/dominance';
import type { Label } from '../domain/gate/labels';
import { BINDING_REFUSALS } from '../domain/gate/routing';
import type { ActorRef } from '../domain/gate/decide';
import { withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { NearAiClient, RouteRefusedError } from '../services/nearAiClient';
import type { NearAiClientOptions } from '../services/nearAiClient';
import { AuthService } from '../services/auth';
import { createNearAiProvider } from '../services/providerFactory';
import { testBundleState } from './helpers/gatedRuns';
import { MemorySecrets } from './helpers/teamHarness';

const NEAR = 'https://cloud-api.near.ai/v1';
const LOCAL = 'http://127.0.0.1:11434/v1';

function org(level: string): Label {
  return { scale: 'org', level, compartments: [], releasability: [], handling: [] };
}

/** A fake fetch that serves a catalog and answers every content request, counting the content requests it was given. */
function fakeFetch(catalog: { tee?: string[]; cloud?: string[]; local?: string[] }): { fetchFn: typeof fetch; content: string[] } {
  const content: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/models')) {
      const ids = [...(catalog.tee ?? []), ...(catalog.cloud ?? []), ...(catalog.local ?? [])];
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    }
    if (method === 'GET' && url.endsWith('/model/list')) {
      const models = [
        ...(catalog.tee ?? []).map((modelId) => ({ modelId, metadata: { attestationSupported: true, providerType: 'vllm' } })),
        ...(catalog.cloud ?? []).map((modelId) => ({ modelId, metadata: { providerType: 'external', providerConfig: { base_url: 'https://api.example.org/v1' } } }))
      ];
      return new Response(JSON.stringify({ models }), { status: 200 });
    }
    content.push(`${method} ${new URL(url).pathname}`);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, content };
}

const ACTOR: ActorRef = { kind: 'agent', deviceFingerprint: 'device-test', sessionId: 'session-test', agentId: 'main-1', agentLabel: 'agent' };

function routeAt(mark: Mark, extra: Partial<SessionRoute> = {}): SessionRoute {
  const state = testBundleState();
  return { markOf: () => mark, bundleState: () => state, actor: ACTOR, attestation: { failed: false }, ...extra };
}

async function nearClient(options: Partial<NearAiClientOptions> = {}, catalog: { tee?: string[]; cloud?: string[] } = { tee: ['tee-model'], cloud: ['cloud-model'] }): Promise<{ client: NearAiClient; content: string[] }> {
  const fake = fakeFetch(catalog);
  const client = new NearAiClient({ baseUrl: NEAR, apiKey: 'test-key', fetchFn: fake.fetchFn, route: 'near', ...options });
  await client.listModels();
  return { client, content: fake.content };
}

async function localClient(options: Partial<NearAiClientOptions> = {}): Promise<{ client: NearAiClient; content: string[] }> {
  const fake = fakeFetch({ local: ['local-model'] });
  const client = new NearAiClient({ baseUrl: LOCAL, apiKey: '', fetchFn: fake.fetchFn, route: 'local', ...options });
  await client.listLocalModels();
  return { client, content: fake.content };
}

const ask = (client: NearAiClient, model: string) => client.completeOnce(model, [{ role: 'user', content: 'hello' }], { maxTokens: 32 });

test('tracer: a session route reaches the client\'s one choke point, and a request its tier refuses throws before fetch', async () => {
  // local-only with no local model: refused, nothing sent.
  const restricted = await nearClient();
  await assert.rejects(
    () => withSessionRoute(routeAt([org('Restricted')]), () => ask(restricted.client, 'tee-model')),
    (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.no-local-model' && /^Nothing was sent\./.test(error.message)
  );
  assert.equal(restricted.content.length, 0, 'the fake fetch was never given the content request');

  // attested-cloud with a catalog TEE model on NEAR AI Cloud's own endpoint, but no binding source (D-50): refused, the cause first.
  const confidential = await nearClient();
  await assert.rejects(
    () => withSessionRoute(routeAt([org('Confidential')]), () => ask(confidential.client, 'tee-model')),
    (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.no-local-model' && error.message.startsWith(BINDING_REFUSALS.unknown)
  );
  assert.equal(confidential.content.length, 0);

  // A local client on a loopback host serving a catalog local model sends Restricted content.
  const local = await localClient();
  const answer = await withSessionRoute(routeAt([org('Restricted')]), () => ask(local.client, 'local-model'));
  assert.equal(answer.text, 'ok');
  assert.deepEqual(local.content, ['POST /v1/chat/completions']);

  // The default mark (empty: the policy's default label, org Public) sends through the NEAR client, as today.
  const open = await nearClient();
  assert.equal((await withSessionRoute(routeAt([]), () => ask(open.client, 'cloud-model'))).text, 'ok');
  assert.equal(open.content.length, 1);
});

test('the provider factory says each client\'s route: a local profile and a hybrid profile\'s local client are local, a hybrid NEAR client knows a local model is there', async () => {
  const secrets = new MemorySecrets();
  const auth = new AuthService(secrets);
  const scope = createProjectCredentialScope('/workspace/project-a', 'profile-hybrid');
  await auth.saveScopedApiKey(scope, 'cloud-secret', NEAR);
  const base: OrganizationProfile = {
    version: 1, profileId: 'profile-hybrid', displayName: 'hybrid', organization: 'Example Company', provider: 'hybrid', baseUrl: NEAR, localBaseUrl: LOCAL, authMode: 'apiKey',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', validation: { status: 'valid', validatedAt: '2026-01-01T00:00:00Z' }
  };
  const fake = fakeFetch({ tee: ['tee-model'], local: ['local-model'] });
  const hybrid = await createNearAiProvider({ auth, profile: base, scope, fetchFn: fake.fetchFn });
  assert.ok(hybrid.localClient);
  await hybrid.client.listModels();
  await hybrid.localClient.listLocalModels();
  // Internal is attested-cloud: with a local model there, the NEAR client's refusal names the connection, and the local client sends.
  await assert.rejects(
    () => withSessionRoute(routeAt([org('Internal')]), () => ask(hybrid.client, 'tee-model')),
    (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.connection-not-bound'
  );
  assert.equal((await withSessionRoute(routeAt([org('Internal')]), () => ask(hybrid.localClient!, 'local-model'))).text, 'ok');

  const localScope = createProjectCredentialScope('/workspace/project-a', 'profile-local');
  const local = await createNearAiProvider({ auth, profile: { ...base, profileId: 'profile-local', provider: 'local', baseUrl: LOCAL }, scope: localScope, fetchFn: fake.fetchFn });
  await local.client.listLocalModels();
  assert.equal((await withSessionRoute(routeAt([org('Restricted')]), () => ask(local.client, 'local-model'))).text, 'ok');

  const cloudScope = createProjectCredentialScope('/workspace/project-a', 'profile-cloud');
  await auth.saveScopedApiKey(cloudScope, 'cloud-secret', NEAR);
  const cloud = await createNearAiProvider({ auth, profile: { ...base, profileId: 'profile-cloud', provider: 'near-ai' }, scope: cloudScope, fetchFn: fake.fetchFn });
  await cloud.client.listModels();
  await assert.rejects(
    () => withSessionRoute(routeAt([org('Internal')]), () => ask(cloud.client, 'tee-model')),
    (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.no-local-model'
  );
  assert.deepEqual(fake.content, ['POST /v1/chat/completions', 'POST /v1/chat/completions'], 'only the two local requests were sent');
});
