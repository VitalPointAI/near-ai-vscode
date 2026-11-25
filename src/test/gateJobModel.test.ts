// Phase 74.1-05 Task 1 (D-18, D-18a): the defaults by job are Western passports in AGENT_DEFAULTS only, and resolveJobModel turns them into the model a
// run uses: a person's own value, else your organization's default, else the shipped preference, the first catalogue model the gate allows; today's ids
// only as the report-mode fallback. Fake catalogues and allows callbacks; no network, no model.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_DEFAULTS } from '../domain/agentDefaults';
import { JOB_RESOLUTION_TEXT, resolveJobModel } from '../domain/gate/jobModel';
import { JOB_MINIMUM_TIER, MODEL_JOBS, USE_TIERS, effectiveMaxTier, parseModelsSection } from '../domain/gate/models';
import type { ModelJob, ModelsSection } from '../domain/gate/models';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { SHIPPED_PASSPORTS } from '../domain/gate/shippedPassports';
import { FIXED_NOW } from './helpers/policyFixtures';

const SUPER = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8';
const NANO = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8';
const GPT_OSS = 'openai/gpt-oss-120b';
const GUARDIAN = 'ibm-granite/granite-guardian-4.1-8b';
const GRANITE = 'ibm-granite/granite-4.2-8b';
const ENFORCE: ModelsSection = { v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [] };
const REPORT: ModelsSection = { ...ENFORCE, mode: 'report' };

const catalog = (...ids: string[]) => ids.map((id) => ({ id }));
const allowing = (...allowed: string[]) => (modelId: string): boolean => allowed.includes(modelId);
const resolve = (job: ModelJob, extra: Partial<Parameters<typeof resolveJobModel>[1]> = {}) => resolveJobModel(job, { catalog: catalog(SUPER, GPT_OSS), allows: () => true, models: ENFORCE, now: FIXED_NOW, ...extra });

test('standard resolves to Nemotron 3 Super, then gpt-oss when the gate refuses Nemotron, then nothing with the reason', () => {
  assert.deepEqual(resolve('standard'), { model: SUPER, source: 'shipped' });
  assert.deepEqual(resolve('standard', { allows: allowing(GPT_OSS) }), { model: GPT_OSS, source: 'shipped' });
  assert.deepEqual(resolve('standard', { allows: allowing() }), { model: undefined, reason: JOB_RESOLUTION_TEXT.none });
});

test('your organization\'s default for the job wins over the shipped order', () => {
  // Your organization's own gpt-oss passport (it replaces the shipped one by id) is the default it names.
  const own = { ...SHIPPED_PASSPORTS.find((candidate) => candidate.id === 'openai/gpt-oss'), issuedAt: '2026-11-20T00:00:00.000Z', expiresAt: '2027-06-01T00:00:00.000Z' };
  const parsed = parseModelsSection({ v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [JSON.parse(JSON.stringify(own))], defaults: { standard: 'openai/gpt-oss' } }, SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : `${parsed.reason} ${parsed.path}`);
  if (!parsed.ok) return;
  assert.deepEqual(resolve('standard', { models: parsed.value }), { model: GPT_OSS, source: 'organization' });
});

test('safety follows the owner\'s classifier order: gpt-oss, Nemotron 3 Nano, Granite Guardian, each only when the gate allows it', () => {
  const all = catalog(GUARDIAN, NANO, GPT_OSS);
  assert.equal(resolve('safety', { catalog: all }).model, GPT_OSS);
  assert.equal(resolve('safety', { catalog: all, allows: allowing(NANO, GUARDIAN) }).model, NANO);
  assert.equal(resolve('safety', { catalog: all, allows: allowing(GUARDIAN) }).model, GUARDIAN);
});

test('fast resolves Nemotron 3 Nano, then gpt-oss, then Granite', () => {
  const all = catalog(GRANITE, GPT_OSS, NANO);
  assert.equal(resolve('fast', { catalog: all }).model, NANO);
  assert.equal(resolve('fast', { catalog: all, allows: allowing(GPT_OSS, GRANITE) }).model, GPT_OSS);
  assert.equal(resolve('fast', { catalog: all, allows: allowing(GRANITE) }).model, GRANITE);
});

test('D-18a: in report mode with only today\'s model in the catalogue, standard falls back to it; under enforce, to nothing', () => {
  const glm = catalog('z-ai/glm-5.3');
  assert.deepEqual(resolve('standard', { catalog: glm, models: REPORT }), { model: 'z-ai/glm-5.3', source: 'report-fallback' });
  assert.deepEqual(resolve('standard', { catalog: glm, models: undefined }), { model: 'z-ai/glm-5.3', source: 'report-fallback' }, 'no models section is report mode');
  assert.deepEqual(resolve('standard', { catalog: glm }), { model: undefined, reason: JOB_RESOLUTION_TEXT.none });
});

test('a person\'s own value is returned as set, even one the gate would refuse (the gate then refuses at send, with its sentence)', () => {
  assert.deepEqual(resolve('standard', { setByPerson: 'z-ai/glm-5.3', allows: allowing() }), { model: 'z-ai/glm-5.3', source: 'set-by-you' });
  assert.deepEqual(resolve('standard', { setByPerson: '  ' }), { model: SUPER, source: 'shipped' }, 'an empty value is not a choice');
});

test('no preference list names a passport whose origin is not Western or whose approval is below the job\'s minimum use', () => {
  const western = new Set(['US', 'CA', 'DE']);
  for (const job of MODEL_JOBS) {
    for (const id of AGENT_DEFAULTS.models[job]) {
      const passport = SHIPPED_PASSPORTS.find((candidate) => candidate.id === id);
      assert.ok(passport, `${job}: ${id} is a shipped passport`);
      assert.ok(western.has(passport.origin), `${job}: ${id}`);
      assert.ok(USE_TIERS.indexOf(effectiveMaxTier(passport, FIXED_NOW)) >= USE_TIERS.indexOf(JOB_MINIMUM_TIER[job]), `${job}: ${id}`);
    }
  }
});

test('D-18: the shipped preference per job, and the report fallback holds today\'s ids only', () => {
  assert.deepEqual(AGENT_DEFAULTS.models.standard, ['nvidia/nemotron-3-super', 'cohere/command-a-plus', 'openai/gpt-oss']);
  assert.deepEqual(AGENT_DEFAULTS.models.deep, ['nvidia/nemotron-3-ultra', 'cohere/command-a-plus', 'openai/gpt-oss']);
  assert.deepEqual(AGENT_DEFAULTS.models.fast, ['nvidia/nemotron-3-nano', 'openai/gpt-oss', 'ibm-granite/granite']);
  assert.deepEqual(AGENT_DEFAULTS.models.safety, ['openai/gpt-oss', 'nvidia/nemotron-3-nano', 'ibm-granite/granite-guardian']);
  assert.deepEqual(AGENT_DEFAULTS.models.vision, ['cohere/command-a-plus']);
  assert.deepEqual([...AGENT_DEFAULTS.models.t0, ...AGENT_DEFAULTS.models.rerank], []);
  assert.equal(AGENT_DEFAULTS.reportFallback.standard, 'z-ai/glm-5.3');
  assert.equal(Object.prototype.hasOwnProperty.call(AGENT_DEFAULTS, 'tiers'), false, 'tiers is replaced by models');
});
