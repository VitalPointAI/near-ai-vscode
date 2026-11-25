// Phase 74.1-02, the tracer: the passport step of decideRoute refuses under `models.mode: enforce` and reports under `report` (D-11, D-12), the use of a
// request comes from the session route (D-13), and the refusal is thrown by the client's one choke point before anything is sent. Every fetch here is a
// counting stub; no real model, no network and no key. Fictional models and places only.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Mark } from '../domain/gate/dominance';
import { parseModelsSection, passportHash, resolvePassport } from '../domain/gate/models';
import type { ModelsSection } from '../domain/gate/models';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { PASSPORT_GAPS } from '../domain/gate/passportStep';
import type { PassportGapId } from '../domain/gate/passportStep';
import { DEFAULT_ROUTING, ROUTE_REFUSALS, ROUTE_RULES, ROUTE_RULES_NAMED_AHEAD, decideRoute } from '../domain/gate/routing';
import type { RoutePolicy, RouteFacts } from '../domain/gate/routing';
import type { UseInput } from '../domain/gate/useTier';
import type { ActorRef } from '../domain/gate/decide';
import type { DecisionRecord } from '../domain/gate/record';
import type { PolicyRecordVersion } from '../domain/gate/record';
import { sessionRouteFrom, withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { NearAiClient, RouteRefusedError } from '../services/nearAiClient';
import { routeFactsFor } from '../services/privateRoute';
import { testBundleState, testGateRuntime } from './helpers/gatedRuns';
import { evaluatedModels } from './helpers/policyFixtures';

const NEAR = 'https://cloud-api.near.ai/v1';
const PRC_MODEL = 'z-ai/glm-5.3';
const WESTERN_MODEL = 'openai/gpt-oss-120b';
const UNLISTED_MODEL = 'example/unlisted-chat-7b';
const PUBLIC: Mark = [{ scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] }];
const ACTOR: ActorRef = { kind: 'agent', deviceFingerprint: 'device-test', sessionId: 'session-test', agentId: 'main-1', agentLabel: 'agent' };

/** A NEAR AI Cloud client over a counting fake fetch whose catalogue runs both models in private hardware, with a fresh bound connection fact. */
async function nearClient(): Promise<{ client: NearAiClient; content: string[] }> {
  const content: string[] = [];
  const models = [PRC_MODEL, WESTERN_MODEL, UNLISTED_MODEL];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/models')) return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 });
    if (method === 'GET' && url.endsWith('/model/list')) {
      return new Response(JSON.stringify({ models: models.map((modelId) => ({ modelId, metadata: { attestationSupported: true, providerType: 'vllm' } })) }), { status: 200 });
    }
    if (method === 'GET' && new URL(url).pathname.endsWith('/attestation/report')) return new Response('{}', { status: 404 });
    content.push(`${method} ${new URL(url).pathname}`);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
  const client = new NearAiClient({
    baseUrl: NEAR, apiKey: 'test-key', fetchFn, route: 'near',
    binding: {
      current: () => ({ state: 'bound', host: NEAR, checkedAt: Date.now() - 60_000, fingerprint: 'ab'.repeat(32) }),
      refresh: async () => ({ state: 'bound', host: NEAR, checkedAt: Date.now(), fingerprint: 'ab'.repeat(32) }),
      markNotBound: () => undefined,
      fetchFor: () => fetchFn
    }
  });
  await client.listModels();
  return { client, content };
}

function modelsSection(mode: 'enforce' | 'report'): ModelsSection {
  const parsed = parseModelsSection({ v: 1, mode, unknownMaxTier: 'T0', passports: [] }, SCALE_PRESETS);
  assert.ok(parsed.ok);
  return parsed.ok ? parsed.value : (undefined as never);
}

/** 74.1-06 (D-16): under enforce a model takes a role above research only with your organization's evaluation, which its own passport carries. */
const evaluatedEnforce = (): ModelsSection => evaluatedModels('enforce', ['openai/gpt-oss']);

function routePolicy(models: ModelsSection | undefined): () => RoutePolicy & { readonly policyVersion: PolicyRecordVersion } {
  return () => ({
    endpoints: [], authorizations: [], scales: SCALE_PRESETS, mappings: [], clearances: [], organization: true, requireAccreditedDevice: false,
    now: Date.now(), policyVersion: 'bundle-2', ...(models === undefined ? {} : { models })
  });
}

/** A route at the default label (empty mark) deciding by `models`, whose use comes from `useOf`, recording into `records`. */
function routeWith(models: ModelsSection | undefined, useOf: (() => UseInput) | undefined, records: DecisionRecord[] = [], mark: Mark = []): SessionRoute {
  const state = testBundleState();
  return {
    markOf: () => mark, bundleState: () => state, actor: ACTOR, attestation: { failed: false }, clock: () => Date.now(),
    sink: { record: (record) => { records.push(record); } }, routePolicy: routePolicy(models), ...(useOf === undefined ? {} : { useOf })
  };
}

/** Each gap's own words (74.1-04 gives every gap a sentence naming the model and the uses); every refusal starts "Nothing was sent.". */
const GAP_WORDS: Partial<Record<PassportGapId, RegExp>> = {
  'tier-exceeded': /is approved for research only \(in the research workspace\), and this request is agent work\./,
  'acceptance-missing': /is approved for research only\. Chat you review needs an exception/,
  unknown: /has no approval from your organization\./
};
const saysGap = (message: string, gap: PassportGapId): boolean => message.startsWith('Nothing was sent. ') && (GAP_WORDS[gap]?.test(message) ?? false);

const ask = (client: NearAiClient, model: string) => client.completeOnce(model, [{ role: 'user', content: 'hello' }], { maxTokens: 32 });

test('tracer: under enforce, agent work for a PRC-origin model is refused before anything is sent, with route.passport and the gap\'s sentence', async () => {
  const near = await nearClient();
  const records: DecisionRecord[] = [];
  await assert.rejects(
    () => withSessionRoute(routeWith(modelsSection('enforce'), () => ({ tools: true }), records), () => ask(near.client, PRC_MODEL)),
    (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.passport' && saysGap(error.message, 'tier-exceeded')
  );
  assert.deepEqual(near.content, [], 'the fake fetch was never given the content request');
  assert.equal(records.length, 1);
});

test('tracer: under enforce, the same agent work for a model whose passport covers it is sent', async () => {
  const near = await nearClient();
  const answer = await withSessionRoute(routeWith(evaluatedEnforce(), () => ({ tools: true })), () => ask(near.client, WESTERN_MODEL));
  assert.equal(answer.text, 'ok');
  assert.deepEqual(near.content, ['POST /v1/chat/completions']);
});

test('D-12: under report, and with no models section, the PRC agent request is sent and reported as route.passport would refuse', async () => {
  for (const models of [modelsSection('report'), undefined]) {
    const near = await nearClient();
    const records: DecisionRecord[] = [];
    const answer = await withSessionRoute(routeWith(models, () => ({ tools: true }), records), () => ask(near.client, PRC_MODEL));
    assert.equal(answer.text, 'ok');
    assert.equal(near.content.length, 1);
    assert.deepEqual(records[0]?.unmapped.nearAi.wouldRefuse, ['route.passport'], models === undefined ? 'no models section' : 'report');
  }
});

test('D-13: chat you review (no tools) for a PRC-origin model needs a risk acceptance: refused with acceptance-missing under enforce', async () => {
  const near = await nearClient();
  await assert.rejects(
    () => withSessionRoute(routeWith(modelsSection('enforce'), () => ({})), () => ask(near.client, PRC_MODEL)),
    (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.passport' && saysGap(error.message, 'acceptance-missing')
  );
  assert.equal(near.content.length, 0);
});

test('D-13: the use comes from the current session route; outside every route it is chat you review', () => {
  const input = {
    clientRoute: 'near' as const, host: NEAR, info: { id: PRC_MODEL, privacyBoundary: 'tee' as const }, attestation: 'unproven' as const,
    fact: { state: 'unknown' as const, host: NEAR }, now: Date.now(), localModelAvailable: false, sessionless: true
  };
  assert.equal(routeFactsFor(input).use, 'T1');
  assert.equal(withSessionRoute(routeWith(undefined, () => ({ tools: true })), () => routeFactsFor(input)).use, 'T2');
  assert.equal(withSessionRoute(routeWith(undefined, () => ({ lane: 'research' })), () => routeFactsFor(input)).use, 'T0');
  assert.equal(withSessionRoute(routeWith(undefined, undefined), () => routeFactsFor(input)).use, 'T1', 'a route that says nothing about its use is chat you review');
  // The route's mark raises it by the shipped table: Protected B is agent work.
  const pb = [{ scale: 'ca-protected', level: 'Protected B', compartments: [], releasability: [], handling: [] }];
  assert.equal(withSessionRoute(routeWith(undefined, () => ({}), [], pb), () => routeFactsFor(input)).use, 'T2');
  // A use that cannot be read is the highest use, never a lower one (fail closed).
  assert.equal(withSessionRoute(routeWith(undefined, () => { throw new Error('unreadable'); }), () => routeFactsFor(input)).use, 'T3');
});

test('D-13: a session\'s use only rises: after agent work, a later chat request in the same route is still checked as agent work', async () => {
  const near = await nearClient();
  let use: UseInput = { tools: true };
  const route = routeWith(evaluatedEnforce(), () => use);
  assert.equal((await withSessionRoute(route, () => ask(near.client, WESTERN_MODEL))).text, 'ok');
  use = {};
  await assert.rejects(
    () => withSessionRoute(route, () => ask(near.client, PRC_MODEL)),
    (error: unknown) => error instanceof RouteRefusedError && saysGap(error.message, 'tier-exceeded'),
    'agent work (tier-exceeded), not chat you review (acceptance-missing)'
  );
  // A new route starts again from its own use.
  await assert.rejects(
    () => withSessionRoute(routeWith(modelsSection('enforce'), () => use), () => ask(near.client, PRC_MODEL)),
    (error: unknown) => error instanceof RouteRefusedError && saysGap(error.message, 'acceptance-missing')
  );
});

test('D-13: sessionRouteFrom takes the use in its options', () => {
  const route = sessionRouteFrom(testGateRuntime(), { use: () => ({ checkingJob: true }) });
  assert.deepEqual(route.useOf?.(), { context: 'interactive', checkingJob: true }, 'the runtime\'s context, then the caller\'s own facts (74.1-03)');
  assert.deepEqual(sessionRouteFrom(testGateRuntime()).useOf?.(), { context: 'interactive' });
});

test('D-11: route.passport is a route rule decideRoute reaches, no longer named ahead, with the generic sentence and one sentence per gap', () => {
  assert.ok((ROUTE_RULES as readonly string[]).includes('route.passport'));
  assert.equal((ROUTE_RULES_NAMED_AHEAD as readonly string[]).includes('route.passport'), false);
  assert.match(ROUTE_REFUSALS['route.passport'], /^Nothing was sent\. /);
  assert.deepEqual([...PASSPORT_GAPS], ['unknown', 'expired', 'tier-exceeded', 'acceptance-missing', 'acceptance-expired', 'revoked', 'hosting-mismatch', 'artifact-mismatch', 'licence', 'not-evaluated']);
  // Each gap's sentence is checked in gatePassportRefusals.test.ts (74.1-04).
  const facts: RouteFacts = { clientRoute: 'near', host: NEAR, nearEndpoint: true, model: { id: PRC_MODEL, privacyBoundary: 'tee' }, attestationFailed: false, now: Date.now(), use: 'T2' };
  const decision = decideRoute(PUBLIC, DEFAULT_ROUTING, facts, undefined, undefined, routePolicy(modelsSection('enforce'))());
  assert.deepEqual({ allowed: decision.allowed, rule: decision.rule, passportGap: decision.passportGap }, { allowed: false, rule: 'route.passport', passportGap: 'tier-exceeded' });
});

test('T-74.1-07: a passport check that throws refuses under enforce (fail closed) and is only reported under report', () => {
  const facts: RouteFacts = { clientRoute: 'near', host: NEAR, nearEndpoint: true, model: { id: WESTERN_MODEL, privacyBoundary: 'tee' }, attestationFailed: false, now: Date.now(), use: 'T2' };
  const throwing = (mode: 'enforce' | 'report'): ModelsSection => ({ v: 1, mode, get passports(): never { throw new Error('unreadable'); } }) as ModelsSection;
  const policy = routePolicy(undefined)();
  const enforced = decideRoute(PUBLIC, DEFAULT_ROUTING, facts, undefined, undefined, { ...policy, models: throwing('enforce') });
  assert.deepEqual({ allowed: enforced.allowed, rule: enforced.rule, reason: enforced.reason }, { allowed: false, rule: 'route.passport', reason: ROUTE_REFUSALS['route.passport'] });
  const reported = decideRoute(PUBLIC, DEFAULT_ROUTING, facts, undefined, undefined, { ...policy, models: throwing('report') });
  assert.deepEqual({ allowed: reported.allowed, wouldRefuse: reported.wouldRefuse }, { allowed: true, wouldRefuse: ['route.passport'] });
});

test('D-13: the policy\'s own tierByProject only raises the use in the decision', () => {
  const parsed = parseModelsSection({ v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [], tierByProject: { software: 'T2' } }, SCALE_PRESETS);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const facts: RouteFacts = { clientRoute: 'near', host: NEAR, nearEndpoint: true, model: { id: PRC_MODEL, privacyBoundary: 'tee' }, attestationFailed: false, now: Date.now(), use: 'T1', useInput: { project: { kind: 'software' } } };
  const decision = decideRoute(PUBLIC, DEFAULT_ROUTING, facts, undefined, undefined, { ...routePolicy(undefined)(), models: parsed.value });
  assert.deepEqual({ rule: decision.rule, passportGap: decision.passportGap, useTier: decision.useTier }, { rule: 'route.passport', passportGap: 'tier-exceeded', useTier: 'T2' });
  const resolved = resolvePassport(parsed.value, PRC_MODEL, Date.now());
  assert.deepEqual(decision.passport, resolved === undefined ? undefined : { id: resolved.passport.id, hash: passportHash(resolved.passport) });
});

// ---- Task 2 (D-23): the record and the trust facts name the use and the passport ----

const nearAiOf = (record: DecisionRecord | undefined): Record<string, unknown> => (record?.unmapped.nearAi ?? {}) as unknown as Record<string, unknown>;

test('D-23: the refused PRC request writes one record with route.passport, the use, the passport by id and hash, and the gap', async () => {
  const near = await nearClient();
  const records: DecisionRecord[] = [];
  await assert.rejects(() => withSessionRoute(routeWith(modelsSection('enforce'), () => ({ tools: true }), records), () => ask(near.client, PRC_MODEL)));
  assert.equal(records.length, 1);
  assert.equal(records[0]?.authorizations[0]?.policy.name, 'route.passport');
  const resolved = resolvePassport(undefined, PRC_MODEL, Date.now());
  assert.ok(resolved);
  const fields = nearAiOf(records[0]);
  assert.deepEqual({ useTier: fields['useTier'], passport: fields['passport'], passportHash: fields['passportHash'], passportGap: fields['passportGap'] },
    { useTier: 'T2', passport: 'z-ai/glm', passportHash: passportHash(resolved.passport), passportGap: 'tier-exceeded' });
  assert.match(String(fields['passportHash']), /^[0-9a-f]{64}$/);
});

test('D-23: the allowed gpt-oss request names its passport and no gap; an unlisted model refused names no passport and the gap unknown', async () => {
  const near = await nearClient();
  const records: DecisionRecord[] = [];
  const evaluated = evaluatedEnforce();
  await withSessionRoute(routeWith(evaluated, () => ({ tools: true }), records), () => ask(near.client, WESTERN_MODEL));
  const allowed = nearAiOf(records[0]);
  const resolved = resolvePassport(evaluated, WESTERN_MODEL, Date.now());
  assert.deepEqual({ useTier: allowed['useTier'], passport: allowed['passport'], passportHash: allowed['passportHash'] },
    { useTier: 'T2', passport: 'openai/gpt-oss', passportHash: resolved === undefined ? undefined : passportHash(resolved.passport) });
  assert.equal(Object.prototype.hasOwnProperty.call(allowed, 'passportGap'), false);
  await assert.rejects(() => withSessionRoute(routeWith(modelsSection('enforce'), () => ({}), records), () => ask(near.client, UNLISTED_MODEL)),
    (error: unknown) => error instanceof RouteRefusedError && saysGap(error.message, 'unknown'));
  const unknown = nearAiOf(records[1]);
  assert.equal(unknown['passportGap'], 'unknown');
  assert.equal(Object.prototype.hasOwnProperty.call(unknown, 'passport'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(unknown, 'passportHash'), false);
});
