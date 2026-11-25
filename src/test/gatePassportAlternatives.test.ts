// Phase 74.1-04 Task 2 (D-14): a passport refusal names the models that would go instead, worked out by decideRoute itself for each catalogue model, never a
// model the gate would refuse, at most five, and only when a request is refused. Fake catalogues and a counting fake fetch; no network, no model.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { parseModelsSection } from '../domain/gate/models';
import type { ModelsSection } from '../domain/gate/models';
import { DEFAULT_ROUTING, decideRoute } from '../domain/gate/routing';
import type { RouteFacts, RoutePolicy } from '../domain/gate/routing';
import type { DecisionRecord } from '../domain/gate/record';
import { withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { NearAiClient, RouteRefusedError } from '../services/nearAiClient';
import { testBundleState } from './helpers/gatedRuns';
import { FIXED_NOW, FIXTURE_EVALUATION, evaluatedModels } from './helpers/policyFixtures';

const NEAR = 'https://cloud-api.near.ai/v1';
const PUBLIC: Label = { scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] };
// 74.1-06 (D-16): under enforce a model takes a role above research only with your organization's evaluation; gpt-oss and Command A+ carry one here, so
// each is refused only for what the test names.
const ENFORCE: ModelsSection = evaluatedModels('enforce', ['cohere/command-a-plus', 'openai/gpt-oss']);
const CATALOGUE = ['z-ai/glm-5.3', 'openai/gpt-oss-120b', 'CohereLabs/command-a-plus-05-2026-w4a4', 'Qwen/Qwen3.6-35B-A3B-FP8'].map((id) => ({ id, privacyBoundary: 'tee' }));

function policy(models: ModelsSection = ENFORCE): RoutePolicy {
  return { endpoints: [], authorizations: [], scales: SCALE_PRESETS, mappings: [], clearances: [], organization: true, requireAccreditedDevice: false, now: FIXED_NOW, models };
}

/** `null`: no catalogue at all. */
const facts = (model: string, candidates: RouteFacts['candidates'] | null = CATALOGUE): RouteFacts => ({
  clientRoute: 'near', host: NEAR, nearEndpoint: true, model: { id: model, privacyBoundary: 'tee' }, attestationFailed: false, now: FIXED_NOW, use: 'T2', ...(candidates === null || candidates === undefined ? {} : { candidates })
});

test('T-74.1-13: a T2 refusal of a PRC model lists gpt-oss only: Command A+ is not on a vault class here, Qwen is research only', () => {
  const refused = decideRoute([PUBLIC], DEFAULT_ROUTING, facts('z-ai/glm-5.3'), undefined, undefined, policy());
  assert.equal(refused.rule, 'route.passport');
  assert.match(refused.reason ?? '', / Choose one of these models instead: openai\/gpt-oss-120b\. Who to ask: /);
});

test('no listed model is one decideRoute refuses, at most five are listed, sorted by your organization\'s order and then by id', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((letter) => `example/Western-${letter}`);
  const passports = ids.map((id, index) => ({
    id: `example/western-${String(index)}`, match: [id], developer: 'Example Labs', origin: 'CA',
    lineage: { family: 'example', base: 'Western', teachers: [], method: 'pretrain' }, licence: { id: 'Apache-2.0', obligations: [], inherited: [] },
    legal: { coveredByUsLaw: false, entityList: false, removalOrders: [] }, hosting: ['nearai-tee'], maxTier: 'T2', issuedAt: '2026-11-20T00:00:00.000Z', expiresAt: '2027-06-01T00:00:00.000Z', reevaluateOn: [],
    evaluation: { ...FIXTURE_EVALUATION }
  }));
  const parsed = parseModelsSection({ v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports, order: ['example/western-6', 'example/western-5'] }, SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : `${parsed.reason} ${parsed.path}`);
  if (!parsed.ok) return;
  const candidates = [...CATALOGUE, ...ids.map((id) => ({ id, privacyBoundary: 'tee' }))];
  const refused = decideRoute([PUBLIC], DEFAULT_ROUTING, facts('z-ai/glm-5.3', candidates), undefined, undefined, policy(parsed.value));
  const reason = refused.reason ?? '';
  const listed = reason.slice(reason.indexOf('instead: ') + 'instead: '.length, reason.indexOf('. Who to ask')).split(', ');
  assert.deepEqual(listed, ['example/Western-g', 'example/Western-f', 'example/Western-a', 'example/Western-b', 'example/Western-c']);
  for (const id of listed) assert.equal(decideRoute([PUBLIC], DEFAULT_ROUTING, facts(id, null), undefined, undefined, policy(parsed.value)).allowed, true, id);
});

test('with no candidate that passes, the sentence says no approved model is available here and names the ways forward', () => {
  const refused = decideRoute([PUBLIC], DEFAULT_ROUTING, facts('z-ai/glm-5.3', [{ id: 'z-ai/glm-5.3', privacyBoundary: 'tee' }, { id: 'Qwen/Qwen3.6-35B-A3B-FP8', privacyBoundary: 'tee' }]), undefined, undefined, policy());
  assert.match(refused.reason ?? '', / No model approved for this work is available here; /);
  assert.doesNotMatch(refused.reason ?? '', /Choose one of these models instead/);
  // Without a catalogue nothing is said about other models.
  const unknownCatalogue = decideRoute([PUBLIC], DEFAULT_ROUTING, facts('z-ai/glm-5.3', null), undefined, undefined, policy());
  assert.doesNotMatch(unknownCatalogue.reason ?? '', /instead|available here/);
});

test('alternatives are worked out only on a route.passport refusal', () => {
  let reads = 0;
  const counted = new Proxy([...CATALOGUE], { get(target, key, receiver) { if (key === Symbol.iterator || key === 'length') reads += 1; return Reflect.get(target, key, receiver); } });
  assert.equal(decideRoute([PUBLIC], DEFAULT_ROUTING, facts('openai/gpt-oss-120b', counted), undefined, undefined, policy()).allowed, true);
  assert.equal(reads, 0, 'an allowed request reads no candidate');
  assert.equal(decideRoute([PUBLIC], DEFAULT_ROUTING, facts('z-ai/glm-5.3', counted), undefined, undefined, { ...policy(), models: { ...ENFORCE, mode: 'report' } }).allowed, true);
  assert.equal(reads, 0, 'a report-mode request reads no candidate');
  decideRoute([PUBLIC], DEFAULT_ROUTING, facts('z-ai/glm-5.3', counted), undefined, undefined, policy());
  assert.ok(reads > 0);
});

test('the client hands its catalogue to the decision: the refusal it throws names the model that would go', async () => {
  const content: string[] = [];
  const ids = CATALOGUE.map((entry) => entry.id);
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET') === 'GET' && url.endsWith('/models')) return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    if ((init?.method ?? 'GET') === 'GET' && url.endsWith('/model/list')) return new Response(JSON.stringify({ models: ids.map((modelId) => ({ modelId, metadata: { attestationSupported: true, providerType: 'vllm' } })) }), { status: 200 });
    if (new URL(url).pathname.endsWith('/attestation/report')) return new Response('{}', { status: 404 });
    content.push(url);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 });
  }) as typeof fetch;
  const client = new NearAiClient({ baseUrl: NEAR, apiKey: 'test-key', fetchFn, route: 'near' });
  await client.listModels();
  const records: DecisionRecord[] = [];
  const state = testBundleState();
  const route: SessionRoute = {
    markOf: () => [], bundleState: () => state, actor: { kind: 'agent', deviceFingerprint: 'device-test', sessionId: 's' }, attestation: { failed: false }, clock: () => Date.now(),
    sink: { record: (record) => { records.push(record); } }, useOf: () => ({ tools: true }), routePolicy: () => ({ ...policy(), now: Date.now(), policyVersion: 'bundle-2' })
  };
  await assert.rejects(() => withSessionRoute(route, () => client.completeOnce('z-ai/glm-5.3', [{ role: 'user', content: 'hello' }], { maxTokens: 8 })),
    (error: unknown) => error instanceof RouteRefusedError && /Choose one of these models instead: openai\/gpt-oss-120b\./.test(error.message));
  assert.deepEqual(content, []);
  assert.equal(records.length, 1, 'the alternatives\' own decisions are not recorded');
});
