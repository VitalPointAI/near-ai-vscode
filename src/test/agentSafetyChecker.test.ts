// Phase 74.1-08 Task 2 (D-18, D-19, MPRV-09, T-74.1-26, T-74.1-28): the model that decides whether a command is safe is never of the family that wrote
// it, is at least as private as the run's model, and is allowed by the gate for a checking job; its request runs as a checking job, so under enforce an
// unevaluated classifier is refused before anything is sent and the command goes to the person. Fake catalogues and a counting fake fetch; no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SafetyModelCheck } from '../agent/safetyModel';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { sameFamilyText } from '../domain/gate/lineage';
import type { ModelsSection } from '../domain/gate/models';
import type { UseInput } from '../domain/gate/useTier';
import type { DecisionRecord } from '../domain/gate/record';
import type { ModelInfo } from '../domain/provider/messages';
import { currentSessionRoute, withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { safetyCheckersFor } from '../services/chatBridge';
import { NearAiClient } from '../services/nearAiClient';
import { testBundleState } from './helpers/gatedRuns';
import { FIXED_NOW, evaluatedModels } from './helpers/policyFixtures';

const NEAR = 'https://cloud-api.near.ai/v1';
const GPT_OSS = 'openai/gpt-oss-120b';
const NANO = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8';
const SUPER = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8';
const GUARDIAN = 'ibm-granite/granite-guardian-4.1-8b';
const tee = (id: string): ModelInfo => ({ id, privacyBoundary: 'tee' });
const MODELS: ModelInfo[] = [GPT_OSS, NANO, SUPER, GUARDIAN].map(tee);
const all = (): boolean => true;
const checkers = (overrides: Partial<Parameters<typeof safetyCheckersFor>[0]> = {}) =>
  safetyCheckersFor({ models: MODELS, chosen: tee(GPT_OSS), author: GPT_OSS, configured: '', allows: all, now: FIXED_NOW, ...overrides });

test('a run on gpt-oss is checked by Nemotron 3 Nano, then Granite Guardian; a run on Nemotron by gpt-oss', () => {
  assert.deepEqual(checkers(), { safetyModel: NANO, safetyFallbackModel: GUARDIAN });
  assert.deepEqual(checkers({ author: SUPER, chosen: tee(SUPER) }), { safetyModel: GPT_OSS, safetyFallbackModel: GUARDIAN });
});

test('with Nemotron refused by the gate Granite Guardian checks; with both refused a person decides, and the notice says why with both families', () => {
  assert.deepEqual(checkers({ allows: (id) => id !== NANO }), { safetyModel: GUARDIAN });
  assert.deepEqual(checkers({ allows: (id) => id !== NANO && id !== GUARDIAN }), { person: { reason: sameFamilyText(GPT_OSS, 'gpt'), families: { author: 'gpt' } } });
});

test('a configured safety model of the run\'s own family is never used', () => {
  assert.equal(checkers({ configured: 'openai/gpt-oss-20b', models: [...MODELS, tee('openai/gpt-oss-20b')] }).safetyModel, NANO);
});

test('the privacy rule still holds: a checker less private than the run\'s model is never chosen', () => {
  const forwarded = MODELS.map((entry) => (entry.id === NANO ? { ...entry, privacyBoundary: 'cloud' as const, forwardedTo: 'example.com' } : entry));
  assert.equal(checkers({ models: forwarded }).safetyModel, GUARDIAN);
});

test('the classifier\'s request runs as a checking job, starting from the run\'s own use', async () => {
  const seen: UseInput[] = [];
  const client = { completeOnce: async () => { seen.push(currentSessionRoute()?.useOf?.() ?? {}); return { text: '{"allow": true, "reason": "read only"}', usage: { promptTokens: 1, completionTokens: 1 } }; } };
  const check = new SafetyModelCheck({ client: client as never, model: NANO, task: 'list files' });
  const state = testBundleState();
  const run: SessionRoute = { markOf: () => [], bundleState: () => state, actor: { kind: 'agent', deviceFingerprint: 'd', sessionId: 's' }, attestation: { failed: false }, useOf: () => ({ tools: true }) };
  const verdict = await withSessionRoute(run, () => check.check('ls', { root: '/project', cwd: '/project' }));
  assert.equal(verdict.allow, true);
  assert.deepEqual(seen, [{ tools: true, checkingJob: true }]);
  assert.equal(currentSessionRoute(), undefined, 'the checking route ends with the check');
});

test('under enforce an unevaluated classifier is refused before anything is sent, and the command goes to the person; an evaluated one is asked', async () => {
  for (const [models, sends] of [[{ v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [] } as ModelsSection, false], [evaluatedModels('enforce', ['nvidia/nemotron-3-nano']), true]] as const) {
    const sent: string[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: NANO }] }), { status: 200 });
      if (method === 'GET' && url.endsWith('/model/list')) return new Response(JSON.stringify({ models: [{ modelId: NANO, metadata: { attestationSupported: true, providerType: 'vllm' } }] }), { status: 200 });
      if (new URL(url).pathname.endsWith('/attestation/report')) return new Response('{}', { status: 404 });
      sent.push(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"allow": true, "reason": "read only"}' }, finish_reason: 'stop' }] }), { status: 200 });
    }) as typeof fetch;
    const client = new NearAiClient({ baseUrl: NEAR, apiKey: 'test-key', fetchFn, route: 'near' });
    await client.listModels();
    const records: DecisionRecord[] = [];
    const state = testBundleState();
    const run: SessionRoute = {
      markOf: () => [], bundleState: () => state, actor: { kind: 'agent', deviceFingerprint: 'd', sessionId: 's' }, attestation: { failed: false }, clock: () => Date.now(),
      sink: { record: (record) => { records.push(record); } }, useOf: () => ({}),
      routePolicy: () => ({ endpoints: [], authorizations: [], scales: SCALE_PRESETS, mappings: [], clearances: [], organization: true, requireAccreditedDevice: false, now: Date.now(), policyVersion: 'bundle-2', models })
    };
    const verdict = await withSessionRoute(run, () => new SafetyModelCheck({ client, model: NANO, task: 'list files' }).check('ls', { root: '/project', cwd: '/project' }));
    assert.equal(verdict.allow, sends);
    assert.equal(sent.length, sends ? 1 : 0);
    const fields = records[0]?.unmapped.nearAi as unknown as Record<string, unknown>;
    assert.equal(fields['useTier'], 'T2', 'checked as a checking job');
    if (!sends) assert.equal(fields['passportGap'], 'not-evaluated');
  }
});
