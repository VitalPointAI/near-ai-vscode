// Routing tiers through the client (CLAS-05, CLAS-06, D-30, D-31, D-37, D-50, D-57): local-only means a model running on this computer, Protected B never
// falls back to a cloud, a hybrid profile is judged per client, and attested-cloud levels stay on this computer until the connection binding exists. Each
// test sets the session's mark by hand, which plan 19's route check already supports; no label is needed. Every fetch is a counting stub; nothing reaches
// the network and no key is read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Mark } from '../domain/gate/dominance';
import type { Label } from '../domain/gate/labels';
import { BINDING_REFUSALS, DEFAULT_ROUTING, ROUTE_REFUSALS, isLocalRouteHost } from '../domain/gate/routing';
import { NETWORK_AT_MARK_TEXT } from '../agent/gateAdapter';
import { DEFAULT_RULES } from '../agent/permissions';
import { AgentConversation } from '../services/agentSession';
import { providerErrorMessage } from '../services/chatBridge';
import { TranscriptStore } from '../services/transcripts';
import { labelledProject } from './helpers/markFixtures';
import type { ActorRef } from '../domain/gate/decide';
import type { BundleState } from '../domain/gate/bundle';
import { sessionRouteFrom, withSessionRoute } from '../gate/sessionMark';
import { validateDecisionRecord } from '../domain/gate/record';
import type { DecisionRecord } from '../domain/gate/record';
import type { ConnectionBindingSource } from '../services/connectionBinding';
import { TEST_ROOT, personalSign, testQuote, testSigner } from './helpers/attestationFixtures';
import type { SessionRoute } from '../gate/sessionMark';
import { NearAiClient, RouteRefusedError } from '../services/nearAiClient';
import type { NearAiClientOptions } from '../services/nearAiClient';
import { testBundleState, testGateHost, testGateRuntime } from './helpers/gatedRuns';

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

// PR #85 review: a route whose answer-check state is missing is unproven, not failed. At an attested-cloud level that keeps the content on this computer
// (D-50, the binding's unknown cause); on every other tier it blocks nothing.
test('a missing attestation state: any-cloud and local-only are unaffected, attested-cloud stays on this computer as unproven, never as a failed check', async () => {
  for (const attestation of [{}, undefined] as const) {
    const route = (mark: Mark): SessionRoute => ({ markOf: () => mark, bundleState: () => stateWith(), actor: ACTOR, ...(attestation === undefined ? {} : { attestation }) }) as unknown as SessionRoute;
    const near = await nearClient({ localModelAvailable: true }, undefined);
    const nearCloud = new NearAiClient({ baseUrl: NEAR, apiKey: 'k', route: 'near', fetchFn: fakeFetch({ tee: ['tee-model'] }).fetchFn });
    await nearCloud.listModels();
    assert.equal((await withSessionRoute(route([label('org', 'Public')]), () => ask(nearCloud, 'tee-model'))).text, 'ok', 'any-cloud');
    const local = await localClient('http://127.0.0.1:11434/v1');
    assert.equal((await withSessionRoute(route([PROTECTED_B]), () => ask(local.client, 'local-model'))).text, 'ok', 'local-only');
    assert.equal((await withSessionRoute(route([label('org', 'Internal')]), () => ask(local.client, 'local-model'))).text, 'ok', 'attested-cloud on a local model');
    await assert.rejects(() => withSessionRoute(route([label('org', 'Internal')]), () => ask(near.client, 'tee-model')), refusedWith('route.connection-not-bound', BINDING_REFUSALS.unknown));
    assert.equal(near.content.length, 0);
  }
});

// ---- Plan 24 (PR 4c): every refusal at a strict label names the way out ----

const LOWER = "NEAR AI: Lower This Chat's Label";

test('a chat raised to Restricted by a read, with no local model, is refused with a sentence that names Lower This Chat\'s Label and still says to add a local model', async () => {
  const root = labelledProject();
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  conversation.gateHost = testGateHost();
  const content: string[] = [];
  const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'tee-model' }] }), { status: 200 });
    if (method === 'GET' && url.endsWith('/model/list')) return new Response(JSON.stringify({ models: [{ modelId: 'tee-model', metadata: { attestationSupported: true, providerType: 'vllm' } }] }), { status: 200 });
    if (method !== 'POST') return new Response('not found', { status: 404 });
    content.push(url);
    const delta = { tool_calls: [{ index: 0, id: 'r1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'docs/plan.md' }) } }] };
    return new Response(chunk({ id: 'c', choices: [{ delta, finish_reason: 'tool_calls' }] }) + chunk({ id: 'c', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'inference-id': 'inf-1' } });
  }) as typeof fetch;
  const client = new NearAiClient({ baseUrl: NEAR, apiKey: 'test-key', fetchFn, route: 'near' });
  await client.listModels();
  let refused: unknown;
  await conversation.send({ text: 'read the plan', client, model: 'tee-model', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES }).catch((error: unknown) => { refused = error; });
  assert.ok(refused instanceof RouteRefusedError && refused.rule === 'route.no-local-model');
  const shown = providerErrorMessage(refused);
  assert.ok(shown.includes(LOWER), 'the page\'s sentence names the Lower command');
  assert.match(shown, /Add a local model/);
  assert.equal(content.length, 1, 'the fake fetch was not called again after the read');
});

test('each refusal at a strict label, and label.network-at-mark, names Lower This Chat\'s Label, and none says to start a new chat', () => {
  for (const rule of ['route.deny', 'route.no-local-model', 'route.local-host-not-local', 'route.not-tee', 'route.connection-not-bound'] as const) {
    assert.ok(ROUTE_REFUSALS[rule].includes(LOWER), rule);
    assert.ok(!/start a new chat/i.test(ROUTE_REFUSALS[rule]), rule);
  }
  assert.ok(NETWORK_AT_MARK_TEXT.includes(LOWER));
  assert.ok(!/start a new chat/i.test(NETWORK_AT_MARK_TEXT));
  assert.match(ROUTE_REFUSALS['route.no-local-model'], /Add a local model/);
});

// ---- Plan 25 (PR 4d): each attested-cloud answer is checked afterwards (D-36), a failed check stops that level for the chat, Check again clears it (D-55) ----

const SIGNING = testSigner('near-ai-gateway-test-key');
const IMPOSTOR = testSigner('someone-else');
const CONFIDENTIAL = label('org', 'Confidential');
const PRIVATE = 'Private · runs in NEAR TEE';

interface FakeNear {
  readonly client: NearAiClient;
  readonly content: string[];
  readonly reportGets: () => number;
  readonly signatureGets: () => number;
  /** What the signature endpoint does now: sign with the gateway key, sign with another key, throw as when offline, or never answer. */
  mode: 'valid' | 'bad-signature' | 'offline' | 'hang';
  clock: number;
  release: () => void;
}

/** A fake NEAR AI Cloud that streams answers and signs them the way NEAR does, with a bound connection fact whose pinned fetch is the same fake. */
async function fakeNear(): Promise<FakeNear> {
  const content: string[] = [];
  const answers = new Map<string, { request: string; response: string }>();
  let reports = 0;
  let signatures = 0;
  let released!: () => void;
  const held = new Promise<void>((resolve) => { released = resolve; });
  const state: { mode: FakeNear['mode']; clock: number } = { mode: 'valid', clock: Date.UTC(2026, 10, 18) };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.pathname.endsWith('/models')) return Response.json({ data: [{ id: 'tee-model' }] });
    if (method === 'GET' && url.pathname.endsWith('/model/list')) return Response.json({ models: [{ modelId: 'tee-model', metadata: { attestationSupported: true, providerType: 'vllm' } }] });
    if (method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      const chatId = `chatcmpl-${String(content.length + 1)}`;
      content.push(chatId);
      const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      const response = chunk({ id: chatId, choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) + chunk({ id: chatId, choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + 'data: [DONE]\n\n';
      answers.set(chatId, { request: String(init?.body), response });
      return new Response(response, { headers: { 'content-type': 'text/event-stream', 'inference-id': `inf-${chatId}` } });
    }
    if (method === 'GET' && url.pathname.startsWith('/v1/signature/')) {
      signatures += 1;
      if (state.mode === 'offline') throw new TypeError('fetch failed');
      if (state.mode === 'hang') await held;
      const answer = answers.get(decodeURIComponent(url.pathname.slice('/v1/signature/'.length)));
      if (answer === undefined) return new Response('{}', { status: 404 });
      const text = `${createHash('sha256').update(answer.request).digest('hex')}:${createHash('sha256').update(answer.response).digest('hex')}`;
      return Response.json({ text, signature: personalSign(text, (state.mode === 'bad-signature' ? IMPOSTOR : SIGNING).key), signing_address: SIGNING.address, signing_algo: 'ecdsa' });
    }
    if (method === 'GET' && url.pathname.endsWith('/attestation/report')) {
      reports += 1;
      const reportData = Buffer.alloc(64);
      Buffer.from(SIGNING.address.slice(2), 'hex').copy(reportData, 0);
      Buffer.from(url.searchParams.get('nonce') ?? '', 'hex').copy(reportData, 32);
      return Response.json({ model_attestations: [{ signing_address: SIGNING.address, signing_algo: 'ecdsa', intel_quote: testQuote(reportData) }] });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const fact = { state: 'bound' as const, host: NEAR, checkedAt: Date.now(), fingerprint: 'ab'.repeat(32) };
  const binding: ConnectionBindingSource = { current: () => ({ ...fact, checkedAt: Date.now() }), refresh: async () => fact, markNotBound: () => undefined, fetchFor: () => fetchFn };
  const client = new NearAiClient({ baseUrl: NEAR, apiKey: 'test-key', fetchFn, route: 'near', binding, maxRetries: 0, attestationTrust: { trustedRoot: TEST_ROOT }, now: () => state.clock });
  await client.listModels();
  const near: FakeNear = {
    client, content, reportGets: () => reports, signatureGets: () => signatures,
    get mode() { return state.mode; }, set mode(value) { state.mode = value; },
    get clock() { return state.clock; }, set clock(value) { state.clock = value; },
    release: () => released()
  };
  return near;
}

/** A local runtime on 127.0.0.1 that streams its answers, counting them. */
async function streamingLocal(): Promise<{ client: NearAiClient; content: string[] }> {
  const content: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET') === 'GET' && url.endsWith('/models')) return Response.json({ data: [{ id: 'local-model' }] });
    content.push(url);
    const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    return new Response(chunk({ id: 'local-1', choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const client = new NearAiClient({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', fetchFn, route: 'local' });
  await client.listLocalModels();
  return { client, content };
}

interface CheckedChat {
  readonly conversation: AgentConversation;
  readonly posted: Array<{ type: string; runId?: string; result?: { outcome: string } }>;
  readonly records: DecisionRecord[];
}

/** A chat in a project labelled org/Confidential (or unlabelled), whose gate runtimes keep their records. */
function checkedChat(projectLabel: Label | null = CONFIDENTIAL): CheckedChat {
  const root = projectLabel === null ? mkdtempSync(path.join(tmpdir(), 'near-ai-tiers-')) : labelledProject({ project: projectLabel });
  const posted: CheckedChat['posted'] = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message as never), path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  const records: DecisionRecord[] = [];
  conversation.gateHost = {
    runtimeFor: async (request) => {
      const runtime = testGateRuntime({ presence: request.presence, context: request.context, actor: { ...request.actor, deviceFingerprint: 'device-test' } });
      return { ...runtime, sink: { record: (record: DecisionRecord) => { records.push(record); runtime.sink.record(record); } } };
    }
  };
  return { conversation, posted, records };
}

const sendTo = (chat: CheckedChat, client: NearAiClient, model = 'tee-model', privacy = PRIVATE, local = false) =>
  chat.conversation.send({ text: 'hello', client, model, privacy, ...(local ? { local: true } : {}), policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES });

/** Waits for the check after the answer with this chat id, then for its listeners. */
async function settled(near: FakeNear, chatId: string): Promise<string> {
  const check = near.client.answerCheck(chatId);
  assert.ok(check !== undefined, `a check was started for ${chatId}`);
  const result = await check;
  await new Promise((resolve) => setImmediate(resolve));
  return result.outcome;
}

const checkedRecords = (chat: CheckedChat, event = 'route.attestation-checked') => chat.records.filter((record) => record.authorizations[0]?.policy.name === event);
const attestationOf = (record: DecisionRecord): unknown => (record.unmapped.nearAi as { attestation?: unknown }).attestation;

test('an org/Confidential chat sends to the TEE model over the bound connection; the check afterwards is recorded as verified and shown under the answer', async () => {
  const near = await fakeNear();
  const chat = checkedChat();
  await sendTo(chat, near.client);
  assert.deepEqual(near.content, ['chatcmpl-1']);
  assert.equal(await settled(near, 'chatcmpl-1'), 'signed');
  const records = checkedRecords(chat);
  assert.equal(records.length, 1);
  assert.equal(attestationOf(records[0]!), 'verified');
  assert.ok(validateDecisionRecord(JSON.parse(JSON.stringify(records[0]))).ok);
  assert.ok(!JSON.stringify(records[0]).includes(SIGNING.address.slice(2)), 'no signing address in the record');
  const offered = chat.posted.findIndex((message) => message.type === 'response-verifiable');
  const shown = chat.posted.findIndex((message) => message.type === 'response-verification');
  assert.ok(offered >= 0 && shown > offered, 'the row is offered first, then shows the result');
  assert.equal(chat.posted[shown]!.result?.outcome, 'signed');
  assert.equal(chat.conversation.routeAttestation.failed, false);
});

test('a failed check stops attested-cloud for the chat: the next request is refused before fetch, a local model in the chat still works, and a sub-agent is refused too', async () => {
  const near = await fakeNear();
  near.mode = 'bad-signature';
  const chat = checkedChat();
  await sendTo(chat, near.client);
  assert.equal(await settled(near, 'chatcmpl-1'), 'failed');
  assert.equal(attestationOf(checkedRecords(chat)[0]!), 'failed');
  assert.equal(chat.conversation.routeAttestation.failed, true, 'the chat\'s stop is set');
  let refused: unknown;
  await sendTo(chat, near.client).catch((error: unknown) => { refused = error; });
  assert.ok(refused instanceof RouteRefusedError && refused.rule === 'route.attestation-failed', String(refused));
  assert.equal(near.content.length, 1, 'nothing more was sent');
  const local = await streamingLocal();
  await sendTo(chat, local.client, 'local-model', 'Local · runs on this machine', true);
  assert.equal(local.content.length, 1, 'a local model in the same chat is still sent');
  // A sub-agent's route shares the chat's attestation state, so it is refused the same way.
  const child = sessionRouteFrom(testGateRuntime(), { attestation: chat.conversation.routeAttestation, markOf: () => [CONFIDENTIAL] });
  await assert.rejects(() => withSessionRoute(child, () => ask(near.client, 'tee-model')), refusedWith('route.attestation-failed'));
  assert.equal(near.content.length, 1);
  const failedRow = chat.posted.find((message) => message.type === 'response-verification');
  assert.equal(failedRow?.result?.outcome, 'failed', 'the answer\'s row shows the failure, where Check again is offered');
});

test('a check that cannot reach NEAR AI is unavailable, never failed, and the next request is sent', async () => {
  const near = await fakeNear();
  near.mode = 'offline';
  const chat = checkedChat();
  await sendTo(chat, near.client);
  assert.equal(await settled(near, 'chatcmpl-1'), 'unavailable');
  assert.equal(attestationOf(checkedRecords(chat)[0]!), 'unavailable');
  assert.equal(chat.conversation.routeAttestation.failed, false);
  await sendTo(chat, near.client);
  assert.equal(near.content.length, 2);
});

test('two answers within 10 minutes from one signing key make one report GET, after 10 minutes a second, and Check again always fetches a new report', async () => {
  const near = await fakeNear();
  const chat = checkedChat();
  await sendTo(chat, near.client);
  await settled(near, 'chatcmpl-1');
  near.clock += 9 * 60_000;
  await sendTo(chat, near.client);
  assert.equal(await settled(near, 'chatcmpl-2'), 'signed');
  assert.equal(near.reportGets(), 1, 'exactly one report GET for two answers');
  near.clock += 2 * 60_000;
  await sendTo(chat, near.client);
  assert.equal(await settled(near, 'chatcmpl-3'), 'signed');
  assert.equal(near.reportGets(), 2, 'the cached report expired after 10 minutes');
  const runId = chat.posted.filter((message) => message.type === 'response-verifiable').at(-1)!.runId!;
  assert.equal((await chat.conversation.verifyRun(runId)).outcome, 'signed');
  assert.equal(near.reportGets(), 3, 'Check again never uses the cache');
});

test('Check again on the failed answer: a signed fresh result clears the stop and is recorded; one that fails again leaves it', async () => {
  const near = await fakeNear();
  near.mode = 'bad-signature';
  const chat = checkedChat();
  await sendTo(chat, near.client);
  await settled(near, 'chatcmpl-1');
  const runId = chat.posted.find((message) => message.type === 'response-verifiable')!.runId!;
  assert.equal((await chat.conversation.verifyRun(runId)).outcome, 'failed', 'still failing');
  assert.equal(chat.conversation.routeAttestation.failed, true, 'the stop stays');
  assert.equal(checkedRecords(chat, 'route.attestation-cleared').length, 0);
  near.mode = 'valid';
  assert.equal((await chat.conversation.verifyRun(runId)).outcome, 'signed');
  assert.equal(chat.conversation.routeAttestation.failed, false, 'the stop is cleared');
  const cleared = checkedRecords(chat, 'route.attestation-cleared');
  assert.equal(cleared.length, 1);
  assert.ok(validateDecisionRecord(JSON.parse(JSON.stringify(cleared[0]))).ok);
  assert.equal(checkedRecords(chat).filter((record) => attestationOf(record) === 'failed').length, 1, 'the failure stays in the log');
  await sendTo(chat, near.client);
  assert.equal(near.content.length, 2, 'the next request is sent');
});

test('a new chat starts without the stop', async () => {
  const near = await fakeNear();
  near.mode = 'bad-signature';
  const chat = checkedChat();
  await sendTo(chat, near.client);
  await settled(near, 'chatcmpl-1');
  const stopped = chat.conversation.routeAttestation;
  assert.equal(stopped.failed, true);
  chat.conversation.reset();
  assert.equal(chat.conversation.routeAttestation.failed, false);
  assert.notEqual(chat.conversation.routeAttestation, stopped);
  near.mode = 'valid';
  await sendTo(chat, near.client);
  assert.equal(near.content.length, 2);
});

test('a check that settles after its chat was closed posts nothing and sets nothing; its record is still written', async () => {
  const near = await fakeNear();
  near.mode = 'hang';
  const chat = checkedChat();
  await sendTo(chat, near.client);
  const old = chat.conversation.routeAttestation;
  chat.conversation.dispose();
  const before = chat.posted.length;
  near.mode = 'bad-signature';
  near.release();
  assert.equal(await settled(near, 'chatcmpl-1'), 'failed');
  assert.equal(chat.posted.length, before, 'nothing was posted');
  assert.equal(old.failed, false, 'nothing was set on the closed chat');
  assert.equal(chat.conversation.routeAttestation.failed, false);
  assert.equal(attestationOf(checkedRecords(chat)[0]!), 'failed', 'the record still reached the log');
});

test('the next decision never waits for a check: a check that never settles does not delay the next request', async () => {
  const near = await fakeNear();
  near.mode = 'hang';
  const chat = checkedChat();
  await sendTo(chat, near.client);
  await sendTo(chat, near.client);
  assert.equal(near.content.length, 2);
  assert.equal(checkedRecords(chat).length, 0, 'neither check has settled');
  near.release();
});

test('a request at any-cloud starts no automatic check', async () => {
  const near = await fakeNear();
  const chat = checkedChat(null);
  await sendTo(chat, near.client);
  assert.equal(near.content.length, 1);
  assert.equal(near.client.answerCheck('chatcmpl-1'), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(near.signatureGets(), 0);
  assert.equal(checkedRecords(chat).length, 0);
});
