// Routing tiers through the client (CLAS-05, CLAS-06, D-30, D-31, D-37, D-50, D-57): local-only means a model running on this computer, Protected B never
// falls back to a cloud, a hybrid profile is judged per client, and attested-cloud levels stay on this computer until the connection binding exists. Each
// test sets the session's mark by hand, which plan 19's route check already supports; no label is needed. Every fetch is a counting stub; nothing reaches
// the network and no key is read.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Mark } from '../domain/gate/dominance';
import type { Label } from '../domain/gate/labels';
import { BINDING_REFUSALS, DEFAULT_ROUTING, isLocalRouteHost } from '../domain/gate/routing';
import type { ActorRef } from '../domain/gate/decide';
import type { BundleState } from '../domain/gate/bundle';
import { withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { NearAiClient, RouteRefusedError } from '../services/nearAiClient';
import type { NearAiClientOptions } from '../services/nearAiClient';
import { testBundleState } from './helpers/gatedRuns';

const NEAR = 'https://cloud-api.near.ai/v1';
const ACTOR: ActorRef = { kind: 'agent', deviceFingerprint: 'device-test', sessionId: 'tiers', agentId: 'main', agentLabel: 'agent' };

function label(scale: string, level: string): Label {
  return { scale, level, compartments: [], releasability: [], handling: [] };
}
const PROTECTED_B = label('ca-protected', 'Protected B');

/** A fake fetch serving a catalog, counting content requests; `hold` keeps a content request open until released. */
function fakeFetch(catalog: { tee?: string[]; local?: string[] }, hold?: Promise<void>): { fetchFn: typeof fetch; content: string[] } {
  const content: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/models')) return new Response(JSON.stringify({ data: [...(catalog.tee ?? []), ...(catalog.local ?? [])].map((id) => ({ id })) }), { status: 200 });
    if (method === 'GET' && url.endsWith('/model/list')) {
      return new Response(JSON.stringify({ models: (catalog.tee ?? []).map((modelId) => ({ modelId, metadata: { attestationSupported: true, providerType: 'vllm' } })) }), { status: 200 });
    }
    content.push(`${method} ${new URL(url).host}${new URL(url).pathname}`);
    if (hold !== undefined) await hold;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, content };
}

function stateWith(localHosts: string[] = []): BundleState {
  const state = testBundleState();
  if (state.state !== 'valid') throw new Error('unreachable');
  return { ...state, bundle: { ...state.bundle, routing: { ...state.bundle.routing, localHosts: localHosts as never } } };
}

function routeAt(markOf: () => Mark, state: BundleState = stateWith()): SessionRoute {
  return { markOf, bundleState: () => state, actor: ACTOR, attestation: { failed: false } };
}

async function nearClient(options: Partial<NearAiClientOptions> = {}, hold?: Promise<void>): Promise<{ client: NearAiClient; content: string[] }> {
  const fake = fakeFetch({ tee: ['tee-model'] }, hold);
  const client = new NearAiClient({ baseUrl: NEAR, apiKey: 'test-key', fetchFn: fake.fetchFn, route: 'near', ...options });
  await client.listModels();
  return { client, content: fake.content };
}

async function localClient(baseUrl: string, models: string[] = ['local-model'], hold?: Promise<void>): Promise<{ client: NearAiClient; content: string[] }> {
  const fake = fakeFetch({ local: models }, hold);
  const client = new NearAiClient({ baseUrl, apiKey: '', fetchFn: fake.fetchFn, route: 'local' });
  await client.listLocalModels();
  return { client, content: fake.content };
}

const ask = (client: NearAiClient, model: string) => client.completeOnce(model, [{ role: 'user', content: 'hello' }], { maxTokens: 32 });
const refusedWith = (rule: string, starts?: string) => (error: unknown): boolean => error instanceof RouteRefusedError && error.rule === rule && /^Nothing was sent\./.test(error.message) && (starts === undefined || error.message.startsWith(starts));

test('Protected B with only a NEAR AI Cloud profile is refused before fetch, saying no local model is set up', async () => {
  const near = await nearClient();
  await assert.rejects(() => withSessionRoute(routeAt(() => [PROTECTED_B]), () => ask(near.client, 'tee-model')), refusedWith('route.no-local-model'));
  assert.equal(near.content.length, 0, 'the fake fetch was called 0 times');
});

test('Protected B goes to a local runtime on 127.0.0.1, and not to one on a remote host until the policy names that host as local', async () => {
  const loopback = await localClient('http://127.0.0.1:11434/v1');
  assert.equal((await withSessionRoute(routeAt(() => [PROTECTED_B]), () => ask(loopback.client, 'local-model'))).text, 'ok');
  assert.equal(loopback.content.length, 1);
  const remote = await localClient('https://models.example.org/v1');
  await assert.rejects(() => withSessionRoute(routeAt(() => [PROTECTED_B]), () => ask(remote.client, 'local-model')), refusedWith('route.local-host-not-local'));
  assert.equal(remote.content.length, 0);
  assert.equal((await withSessionRoute(routeAt(() => [PROTECTED_B], stateWith(['models.example.org'])), () => ask(remote.client, 'local-model'))).text, 'ok');
  assert.equal(remote.content.length, 1);
});

test('CLAS-06 adjacency and encoding: localhost, 127.0.0.1 and [::1] are this computer; 127.0.0.2, a LAN host, a trailing dot and a userinfo trick are not; case does not matter', async () => {
  for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1', 'http://LOCALHOST:11434/v1']) {
    const local = await localClient(url);
    assert.equal((await withSessionRoute(routeAt(() => [PROTECTED_B]), () => ask(local.client, 'local-model'))).text, 'ok', url);
  }
  for (const url of ['https://127.0.0.2/v1', 'https://192.168.1.20/v1', 'https://localhost./v1', 'https://127.0.0.1@models.example.org/v1', 'https://127.0.0.1.example.org/v1']) {
    const other = await localClient(url);
    await assert.rejects(() => withSessionRoute(routeAt(() => [PROTECTED_B]), () => ask(other.client, 'local-model')), refusedWith('route.local-host-not-local'), url);
    assert.equal(other.content.length, 0, url);
  }
  // The policy's own names compare by the URL parser's lowercase hostname, so a name written in capitals still matches, and nothing else does.
  const lan = await localClient('https://Models.Example.org/v1');
  assert.equal((await withSessionRoute(routeAt(() => [PROTECTED_B], stateWith(['MODELS.example.ORG'])), () => ask(lan.client, 'local-model'))).text, 'ok');
  assert.equal(isLocalRouteHost('https://models.example.org.evil.example/v1', ['models.example.org'] as never), false);
  assert.equal(isLocalRouteHost('https://a.models.example.org/v1', ['*.MODELS.example.org'] as never), true);
});

test('CLAS-06 empty: local-only with no local client, or with a local client whose catalog has no local model, is refused before fetch', async () => {
  const near = await nearClient();
  await assert.rejects(() => withSessionRoute(routeAt(() => [PROTECTED_B]), () => ask(near.client, 'tee-model')), refusedWith('route.no-local-model'));
  const empty = await localClient('http://127.0.0.1:11434/v1', []);
  await assert.rejects(() => withSessionRoute(routeAt(() => [PROTECTED_B]), () => ask(empty.client, 'local-model')), refusedWith('route.no-local-model'));
  assert.equal(near.content.length + empty.content.length, 0);
});

test('a hybrid profile is judged per client: at local-only the local request is sent and the NEAR one refused; at Confidential the NEAR one is not bound (D-50)', async () => {
  const near = await nearClient({ localModelAvailable: true });
  const local = await localClient('http://127.0.0.1:11434/v1');
  const session = routeAt(() => [PROTECTED_B]);
  await withSessionRoute(session, async () => {
    assert.equal((await ask(local.client, 'local-model')).text, 'ok');
    await assert.rejects(() => ask(near.client, 'tee-model'), refusedWith('route.no-local-model'));
  });
  const confidential = routeAt(() => [label('org', 'Confidential')]);
  await withSessionRoute(confidential, async () => {
    await assert.rejects(() => ask(near.client, 'tee-model'), refusedWith('route.connection-not-bound', BINDING_REFUSALS.unknown));
    assert.equal((await ask(local.client, 'local-model')).text, 'ok');
  });
  assert.equal(near.content.length, 0);
  assert.equal(local.content.length, 2);
  // A NEAR-only profile at Confidential has no local model: refused, the binding cause first.
  const only = await nearClient();
  await assert.rejects(() => withSessionRoute(confidential, () => ask(only.client, 'tee-model')), refusedWith('route.no-local-model', BINDING_REFUSALS.unknown));
  assert.equal(only.content.length, 0, 'the fake fetch was called 0 times');
});

test('CLAS-05 concurrency: a mark that rises while a request is in flight takes effect at the next request', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const near = await nearClient({}, hold);
  let mark: Mark = [label('org', 'Public')];
  const session = routeAt(() => mark);
  const first = withSessionRoute(session, () => ask(near.client, 'tee-model'));
  while (near.content.length === 0) await new Promise((resolve) => setImmediate(resolve));
  mark = [label('org', 'Restricted')];
  release();
  assert.equal((await first).text, 'ok', 'the request already sent completes');
  await assert.rejects(() => withSessionRoute(session, () => ask(near.client, 'tee-model')), refusedWith('route.no-local-model'));
  assert.equal(near.content.length, 1);
});

test('a model id not in the cached catalog is refused at attested-cloud and at local-only', async () => {
  const near = await nearClient({ localModelAvailable: true });
  await assert.rejects(() => withSessionRoute(routeAt(() => [label('org', 'Internal')]), () => ask(near.client, 'not-in-catalog')), refusedWith('route.not-tee'));
  const local = await localClient('http://127.0.0.1:11434/v1');
  await assert.rejects(() => withSessionRoute(routeAt(() => [PROTECTED_B]), () => ask(local.client, 'not-in-catalog')), refusedWith('route.no-local-model'));
  assert.equal(near.content.length + local.content.length, 0);
  assert.equal(DEFAULT_ROUTING.levels['ca-protected/Protected B'], 'local-only');
});

test('the local runtime prompt says that only a runtime on this computer counts as local, unless your organization names its host (D-37)', () => {
  const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');
  assert.ok(source.includes('Only a runtime on this computer (localhost or 127.0.0.1) counts as local for content that must stay on this computer, unless your organization names its host in the policy.'));
  assert.ok(source.includes("validateInput: (value) => isSecureEndpoint(value.trim())"), 'the prompt still accepts the same URLs');
});
