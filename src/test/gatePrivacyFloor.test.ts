// One private floor (Phase 41 D-37, FND-06): nearAi.privacyMode tee-only, a private member or agent team, and Team Mode's teeOnly give one floor of at least
// attested-cloud through floorFor, and Team Mode's allowedModels one subset filter; decideRoute decides with them at the client's one choke point, and
// OutboundGuard's early refusal under tee-only is the same decision said before anything is sent, in today's words. Every fetch here is a counting stub.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActorRef } from '../domain/gate/decide';
import type { Mark } from '../domain/gate/dominance';
import type { Label } from '../domain/gate/labels';
import type { DecisionRecord } from '../domain/gate/record';
import { DEFAULT_ROUTING, PRIVATE_FLOOR_TEXT, ROUTE_REFUSALS, decideRoute } from '../domain/gate/routing';
import type { RouteFacts } from '../domain/gate/routing';
import { defaultTeamPolicy, teamRouteInputs } from '../domain/team/policy';
import { setPrivateOnlySetting, withPrivateOnly, withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import type { ConnectionBindingSource } from '../services/connectionBinding';
import { NearAiClient, RouteRefusedError } from '../services/nearAiClient';
import type { ModelInfo } from '../services/nearAiClient';
import { OutboundGuard } from '../services/outboundGuard';
import { floorAllowsModel, floorFor } from '../services/privateRoute';
import { chooseImageModel, chooseTeamModel } from '../services/teamStudioAi';
import { testBundleState } from './helpers/gatedRuns';

const NEAR = 'https://cloud-api.near.ai/v1';
const ACTOR: ActorRef = { kind: 'agent', deviceFingerprint: 'device-test', sessionId: 'floor', agentId: 'main', agentLabel: 'agent' };

function org(level: string): Label {
  return { scale: 'org', level, compartments: [], releasability: [], handling: [] };
}

/** A fake fetch that serves a catalog (TEE models and forwarded ones) and answers every content request, counting them. */
function fakeFetch(catalog: { tee?: string[]; cloud?: string[] }): { fetchFn: typeof fetch; content: string[] } {
  const content: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/models')) return new Response(JSON.stringify({ data: [...(catalog.tee ?? []), ...(catalog.cloud ?? [])].map((id) => ({ id })) }), { status: 200 });
    if (method === 'GET' && url.endsWith('/model/list')) {
      const models = [
        ...(catalog.tee ?? []).map((modelId) => ({ modelId, metadata: { attestationSupported: true, providerType: 'vllm' } })),
        ...(catalog.cloud ?? []).map((modelId) => ({ modelId, metadata: { providerType: 'external', providerConfig: { base_url: 'https://api.example.org/v1' } } }))
      ];
      return new Response(JSON.stringify({ models }), { status: 200 });
    }
    if (method === 'GET') return new Response('{}', { status: 404 });
    content.push(`${method} ${new URL(url).pathname}`);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, content };
}

/** A NEAR AI Cloud client whose binding source holds a fresh bound fact for its host. */
async function boundNearClient(): Promise<{ client: NearAiClient; content: string[] }> {
  const fake = fakeFetch({ tee: ['tee-model'], cloud: ['cloud-model'] });
  const binding: ConnectionBindingSource = {
    current: () => ({ state: 'bound', host: NEAR, checkedAt: Date.now() - 60_000, fingerprint: 'ab'.repeat(32) }),
    refresh: async () => ({ state: 'bound', host: NEAR, checkedAt: Date.now(), fingerprint: 'ab'.repeat(32) }),
    markNotBound: () => undefined,
    fetchFor: () => fake.fetchFn
  };
  const client = new NearAiClient({ baseUrl: NEAR, apiKey: 'test-key', fetchFn: fake.fetchFn, route: 'near', binding });
  await client.listModels();
  return { client, content: fake.content };
}

function recordingRoute(mark: Mark, records: DecisionRecord[]): SessionRoute {
  const state = testBundleState();
  return { markOf: () => mark, bundleState: () => state, actor: ACTOR, attestation: { failed: false }, sink: { record: (record) => { records.push(record); } } };
}

const ask = (client: NearAiClient, model: string) => client.completeOnce(model, [{ role: 'user', content: 'hello' }], { maxTokens: 32 });

const floorRefusal = (rule: string) => (error: unknown): boolean => error instanceof RouteRefusedError && error.rule === rule
  && error.message.startsWith('Nothing was sent. ') && error.message.includes(PRIVATE_FLOOR_TEXT);

// ---- floorFor and floorAllowsModel ----

test('floorFor: no input gives no floor; privacyMode tee-only (or a private member or agent team) and Team Mode teeOnly give attested-cloud; an allowedModels list is a filter', () => {
  assert.deepEqual(floorFor({}), {});
  assert.deepEqual(floorFor({ privateOnly: false }), {});
  assert.deepEqual(floorFor({ privateOnly: true }), { tier: 'attested-cloud' });
  assert.deepEqual(floorFor({ team: { teeOnly: true, allowedModels: [] } }), { tier: 'attested-cloud' }, 'an empty allowedModels list is no filter');
  assert.deepEqual(floorFor({ team: { teeOnly: false, allowedModels: ['example/chat-a'] } }), { allowedModels: ['example/chat-a'] });
  assert.deepEqual(floorFor({ privateOnly: true, team: { teeOnly: false, allowedModels: ['example/chat-a'] } }), { tier: 'attested-cloud', allowedModels: ['example/chat-a'] });
  // The list is copied, so a caller changing its own array later changes no floor.
  const list = ['example/chat-a'];
  const floor = floorFor({ team: { teeOnly: false, allowedModels: list } });
  list.push('example/chat-b');
  assert.deepEqual(floor.allowedModels, ['example/chat-a']);
});

test('floorAllowsModel: a floor of attested-cloud admits only TEE and local catalogue entries, a list only its ids, and no floor admits every model', () => {
  const tee = { id: 'tee-model', privacyBoundary: 'tee' as const };
  const local = { id: 'local-model', privacyBoundary: 'local' as const };
  const forwarded = { id: 'cloud-model', privacyBoundary: 'cloud' as const };
  const unknown = { id: 'mystery' };
  const privateFloor = floorFor({ privateOnly: true });
  assert.deepEqual([tee, local, forwarded, unknown].map((model) => floorAllowsModel(privateFloor, model)), [true, true, false, false]);
  assert.deepEqual([tee, local, forwarded, unknown].map((model) => floorAllowsModel(floorFor({}), model)), [true, true, true, true]);
  const listed = floorFor({ team: { teeOnly: false, allowedModels: ['cloud-model'] } });
  assert.deepEqual([tee, local, forwarded, unknown].map((model) => floorAllowsModel(listed, model)), [false, false, true, false]);
  assert.equal(floorAllowsModel(floorFor({ team: { teeOnly: true, allowedModels: ['cloud-model', 'tee-model'] } }), forwarded), false, 'both filters apply');
});

test('Team Mode inputs: teamRouteInputs reads teeOnly and the role\'s allowed models, and floorFor turns them into the floor and the filter decideRoute applies', () => {
  assert.deepEqual(teamRouteInputs(defaultTeamPolicy(), 'developer'), { teeOnly: false, allowedModels: [] });
  const policy = { ...defaultTeamPolicy(), teeOnly: true, allowedModels: { ...defaultTeamPolicy().allowedModels, developer: ['example/chat-a'] } };
  const inputs = teamRouteInputs(policy, 'developer');
  assert.deepEqual(inputs, { teeOnly: true, allowedModels: ['example/chat-a'] });
  assert.deepEqual(teamRouteInputs(policy, 'reviewer'), { teeOnly: true, allowedModels: [] }, 'another role has its own list');
  const floor = floorFor({ team: inputs });
  assert.deepEqual(floor, { tier: 'attested-cloud', allowedModels: ['example/chat-a'] });
  // decideRoute applies the list: a model not on it is refused even where the tier would allow it.
  const facts: RouteFacts = { clientRoute: 'local', host: 'http://127.0.0.1:11434', nearEndpoint: false, model: { id: 'local-model', privacyBoundary: 'local' }, attestationFailed: false, allowedModels: floor.allowedModels };
  const refused = decideRoute([], DEFAULT_ROUTING, facts, org('Public'), floor.tier);
  assert.deepEqual({ allowed: refused.allowed, rule: refused.rule, reason: refused.reason }, { allowed: false, rule: 'route.model-not-allowed', reason: ROUTE_REFUSALS['route.model-not-allowed'] });
  assert.equal(decideRoute([], DEFAULT_ROUTING, { ...facts, model: { id: 'example/chat-a', privacyBoundary: 'local' } }, org('Public'), floor.tier).allowed, true);
});

// ---- The floor through the client (guards: S4's behaviour, now through floorFor) ----

test('through the client: with nearAi.privacyMode tee-only a forwarded model at org Public is refused before fetch with the floor\'s words and recorded; a NEAR TEE model over a fresh bound connection is sent', async () => {
  const records: DecisionRecord[] = [];
  const near = await boundNearClient();
  const clear = setPrivateOnlySetting(() => true);
  try {
    await assert.rejects(() => withSessionRoute(recordingRoute([org('Public')], records), () => ask(near.client, 'cloud-model')), floorRefusal('route.not-tee'));
    assert.equal(near.content.length, 0, 'nothing was sent');
    assert.equal(records.length, 1);
    assert.equal(records[0]?.authorizations[0]?.policy.name, 'route.not-tee');
    assert.equal(records[0]?.status_detail?.includes(PRIVATE_FLOOR_TEXT), true);
    assert.equal((await withSessionRoute(recordingRoute([org('Public')], records), () => ask(near.client, 'tee-model'))).text, 'ok');
    assert.equal(near.content.length, 1);
  } finally { clear(); }
});

test('through the client: a private member or agent team (withPrivateOnly) gives the same floor', async () => {
  const records: DecisionRecord[] = [];
  const near = await boundNearClient();
  await assert.rejects(() => withPrivateOnly(() => withSessionRoute(recordingRoute([org('Public')], records), () => ask(near.client, 'cloud-model'))), floorRefusal('route.not-tee'));
  assert.equal(near.content.length, 0);
  assert.equal(records.length, 1);
  assert.equal((await withPrivateOnly(() => withSessionRoute(recordingRoute([org('Public')], records), () => ask(near.client, 'tee-model')))).text, 'ok');
  // Without the floor, org Public goes to any model as before.
  assert.equal((await withSessionRoute(recordingRoute([org('Public')], records), () => ask(near.client, 'cloud-model'))).text, 'ok');
  assert.equal(near.content.length, 2);
});

// ---- OutboundGuard's early refusal is decideRoute's answer ----

const STANDARD = { privacyMode: 'standard' as const, dailySpendLimitUsd: 0, actionPolicy: { mode: 'approve-risky' as const, emergencyStop: false } };
const TEE_ONLY = { ...STANDARD, privacyMode: 'tee-only' as const };
const MODELS: ReadonlyArray<{ readonly name: string; readonly model: string; readonly info?: ModelInfo }> = [
  { name: 'a TEE model', model: 'z-ai/glm-5.3', info: { id: 'z-ai/glm-5.3', privacyBoundary: 'tee' } },
  { name: 'a local model', model: 'local/qwen', info: { id: 'local/qwen', privacyBoundary: 'local' } },
  { name: 'a forwarded model', model: 'deepseek/deepseek-v4.1-flash', info: { id: 'deepseek/deepseek-v4.1-flash', privacyBoundary: 'cloud', forwardedTo: 'openrouter.ai' } },
  { name: 'an unknown model', model: 'mystery' }
];

/** decideRoute's preview of a request under the floor: org Public, the default routing, the model's own client (this computer for a local entry, NEAR AI Cloud otherwise) and a fresh bound fact. */
function previewRefuses(model: string, info: ModelInfo | undefined): boolean {
  const local = info?.privacyBoundary === 'local';
  const host = local ? 'http://127.0.0.1' : NEAR;
  const now = Date.now();
  const facts: RouteFacts = {
    clientRoute: local ? 'local' : 'near', host, nearEndpoint: !local, attestationFailed: false, now,
    model: info === undefined ? undefined : { id: model, ...(info.privacyBoundary === undefined ? {} : { privacyBoundary: info.privacyBoundary }) },
    binding: { state: 'bound', host, checkedAt: now }
  };
  return !decideRoute([], DEFAULT_ROUTING, facts, org('Public'), floorFor({ privateOnly: true }).tier).allowed;
}

test('OutboundGuard under tee-only blocks exactly when decideRoute refuses (a TEE, a local, a forwarded and an unknown model), with today\'s sentence word for word', () => {
  const guard = new OutboundGuard(TEE_ONLY);
  const outcomes = MODELS.map(({ name, model, info }) => {
    const verdict = guard.check({ model, ...(info === undefined ? {} : { modelInfo: info }), text: 'hello' }, 0);
    assert.equal(verdict.outcome === 'block', previewRefuses(model, info), name);
    return verdict;
  });
  assert.deepEqual(outcomes.map((verdict) => verdict.outcome), ['allow', 'allow', 'block', 'block']);
  const [, , forwarded, unknown] = outcomes;
  assert.equal(forwarded?.outcome === 'block' ? forwarded.reason : '', 'TEE-only mode is on, and deepseek/deepseek-v4.1-flash does not run in NEAR\'s TEE (NEAR forwards it to openrouter.ai). Pick a model marked "Private", or turn off nearAi.privacyMode.');
  assert.equal(unknown?.outcome === 'block' ? unknown.reason : '', 'TEE-only mode is on, and mystery does not run in NEAR\'s TEE. Pick a model marked "Private", or turn off nearAi.privacyMode.');
  assert.equal(forwarded?.outcome === 'block' ? forwarded.overrideToken : 'none', undefined, 'no override for the floor');
  // In standard mode the floor says nothing: every model is allowed for plain text.
  for (const { model, info } of MODELS) assert.equal(new OutboundGuard(STANDARD).check({ model, ...(info === undefined ? {} : { modelInfo: info }), text: 'hello' }, 0).outcome, 'allow');
});

test('OutboundGuard under tee-only keeps its other checks: the emergency stop and spend limit first, and the data-class checks with their one-time override on an allowed model', () => {
  const stopped = new OutboundGuard({ ...TEE_ONLY, actionPolicy: { mode: 'approve-risky', emergencyStop: true } }).check({ model: 'mystery', text: 'hello' }, 0);
  assert.deepEqual(stopped.outcome === 'block' ? stopped.reason : '', 'Emergency stop is on. Run "NEAR AI: Resume" to send again.');
  const limited = new OutboundGuard({ ...TEE_ONLY, dailySpendLimitUsd: 1 }).check({ model: 'mystery', text: 'hello' }, 1);
  assert.match(limited.outcome === 'block' ? limited.reason : '', /daily limit of \$1\.00/);
  const guard = new OutboundGuard(TEE_ONLY);
  const tee = MODELS[0]!;
  const text = 'Why does this fail? api_key=sk-live-123456';
  const first = guard.check({ model: tee.model, modelInfo: tee.info!, text }, 0);
  assert.equal(first.outcome, 'block');
  assert.match(first.outcome === 'block' ? first.reason : '', /credential/);
  const token = first.outcome === 'block' ? first.overrideToken : undefined;
  assert.ok(token, 'a data-class block still offers its one-time override');
  assert.equal(guard.check({ model: tee.model, modelInfo: tee.info!, text, overrideToken: token }, 0).outcome, 'allow');
});

test('Team Studio\'s choice under tee-only goes through the same floor: only TEE and local models, the same sentence when none is left', () => {
  const models: ModelInfo[] = [
    { id: 'cloud-model', privacyBoundary: 'cloud' },
    { id: 'tee-model', privacyBoundary: 'tee', attestationSupported: true },
    { id: 'local-model', privacyBoundary: 'local' }
  ];
  const input = { models, preferred: ['cloud-model'], routeFor: () => ({ kind: 'near' as const, attestation: true }), privacyMode: 'tee-only' as const };
  const choice = chooseTeamModel('any', input);
  assert.deepEqual(choice.ok ? choice.model : choice.reason, 'tee-model');
  assert.deepEqual(chooseTeamModel('any', { ...input, privacyMode: 'standard' }).ok ? (chooseTeamModel('any', { ...input, privacyMode: 'standard' }) as { model: string }).model : '', 'cloud-model');
  const none = chooseTeamModel('any', { ...input, models: [models[0]!] });
  assert.equal(none.ok ? '' : none.reason, 'TEE-only mode is on, and none of your key\'s models runs in NEAR\'s TEE or on this machine. Pick a model marked "Private", or turn off nearAi.privacyMode.');
  const images: ModelInfo[] = [{ id: 'image-cloud', privacyBoundary: 'cloud', outputModalities: ['image'] }, { id: 'image-local', privacyBoundary: 'local', outputModalities: ['image'] }];
  const image = chooseImageModel('any', { models: images, routeFor: () => ({ kind: 'near' as const, attestation: true }), privacyMode: 'tee-only', generateImage: async () => ({}) });
  assert.equal(image.ok ? image.model : image.reason, 'image-local');
});
