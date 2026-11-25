// Phase 74.1-08 Task 1 (D-19, MPRV-09, T-74.1-26, T-74.1-27): a checker never comes from the family of the model it checks; the family comes only from
// the passport; with no allowed model of another family a person decides. gateAllows is decideRoute itself. Fictional routes; no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { ModelsSection } from '../domain/gate/models';
import { CHECKING_ROLES, CHECK_OUTCOMES, checkerFor, familyOf, preferredModels, sameFamilyText } from '../domain/gate/lineage';
import type { RoutePolicy } from '../domain/gate/routing';
import type { PolicyRecordVersion } from '../domain/gate/record';
import type { SessionRoute } from '../gate/sessionMark';
import { gateAllows } from '../services/privateRoute';
import { testBundleState } from './helpers/gatedRuns';
import { FIXED_NOW, evaluatedModels } from './helpers/policyFixtures';

const GPT_OSS = 'openai/gpt-oss-120b';
const NANO = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8';
const SUPER = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8';
const GUARDIAN = 'ibm-granite/granite-guardian-4.1-8b';
const LLAMA_NEMOTRON = 'nvidia/Llama-3_3-Nemotron-Super-49B-v1_5';
const CATALOGUE = [GPT_OSS, 'openai/gpt-oss-20b', NANO, SUPER, GUARDIAN, LLAMA_NEMOTRON, 'z-ai/glm-5.3'].map((id) => ({ id, privacyBoundary: 'tee' }));
const SAFETY = ['openai/gpt-oss', 'nvidia/nemotron-3-nano', 'ibm-granite/granite-guardian'];
const context = { models: undefined, now: FIXED_NOW };
const all = (): boolean => true;
const safetyPreference = (): string[] => preferredModels(SAFETY, CATALOGUE, undefined, FIXED_NOW);

test('familyOf reads the passport\'s lineage only: gpt, nemotron, and llama for a Nemotron post-trained on Llama; no passport, no family', () => {
  assert.equal(familyOf('openai/gpt-oss-20b', undefined, FIXED_NOW), 'gpt');
  assert.equal(familyOf(NANO, undefined, FIXED_NOW), 'nemotron');
  assert.equal(familyOf(LLAMA_NEMOTRON, undefined, FIXED_NOW), 'llama', 'a brand name is not lineage');
  assert.equal(familyOf('somevendor/unknown', undefined, FIXED_NOW), undefined);
});

test('the safety check of a gpt-oss run goes to Nemotron 3 Nano, the owner\'s second family', () => {
  assert.deepEqual(safetyPreference(), [GPT_OSS, 'openai/gpt-oss-20b', NANO, GUARDIAN]);
  assert.deepEqual(checkerFor('safety', GPT_OSS, safetyPreference(), all, context), { model: NANO, families: { author: 'gpt', checker: 'nemotron' } });
});

test('with Nemotron refused it goes to Granite Guardian; with both refused a person decides (check.same-family)', () => {
  assert.equal((checkerFor('safety', GPT_OSS, safetyPreference(), (id) => id !== NANO, context) as { model: string }).model, GUARDIAN);
  const person = checkerFor('safety', GPT_OSS, safetyPreference(), (id) => id !== NANO && id !== GUARDIAN, context);
  assert.ok('person' in person);
  assert.equal(person.outcome, 'check.same-family');
  assert.equal(person.reason, sameFamilyText(GPT_OSS, 'gpt'));
  assert.deepEqual(person.families, { author: 'gpt' });
});

test('a run on Nemotron is checked by gpt-oss', () => {
  assert.deepEqual(checkerFor('safety', SUPER, safetyPreference(), all, context), { model: GPT_OSS, families: { author: 'nemotron', checker: 'gpt' } });
});

test('a configured checker of the author\'s family is skipped for the next preference, never used', () => {
  const choice = checkerFor('reviewer', GPT_OSS, ['openai/gpt-oss-20b', ...safetyPreference()], all, context);
  assert.deepEqual(choice, { model: NANO, families: { author: 'gpt', checker: 'nemotron' } });
});

test('an author with no passport still gets a checker of a known family; a checker with no passport is never chosen', () => {
  assert.deepEqual(checkerFor('safety', 'somevendor/unknown', ['somevendor/other', GPT_OSS], all, context), { model: GPT_OSS, families: { checker: 'gpt' } });
  const none = checkerFor('safety', GPT_OSS, ['somevendor/other'], all, context);
  assert.ok('person' in none);
});

test('no role ever gets a model of the author\'s family, whatever the preference', () => {
  for (const role of CHECKING_ROLES) {
    for (const author of CATALOGUE.map((entry) => entry.id)) {
      const choice = checkerFor(role, author, CATALOGUE.map((entry) => entry.id), all, context);
      if ('model' in choice) assert.notEqual(familyOf(choice.model, undefined, FIXED_NOW), familyOf(author, undefined, FIXED_NOW), `${role} ${author}`);
    }
  }
  assert.deepEqual([...CHECK_OUTCOMES], ['check.same-family']);
});

function routeUnder(models: ModelsSection | undefined): SessionRoute {
  const state = testBundleState();
  const policy = (): RoutePolicy & { readonly policyVersion: PolicyRecordVersion } => ({
    endpoints: [], authorizations: [], scales: SCALE_PRESETS, mappings: [], clearances: [], organization: true, requireAccreditedDevice: false, now: FIXED_NOW, policyVersion: 'bundle-2', ...(models === undefined ? {} : { models })
  });
  return { markOf: () => [], bundleState: () => state, actor: { kind: 'agent', deviceFingerprint: 'device-test', sessionId: 's' }, attestation: { failed: false }, routePolicy: policy };
}

test('gateAllows is decideRoute at the job\'s use: under enforce only an evaluated model may check, and the checker choice follows it', () => {
  const host = 'https://cloud-api.near.ai/v1';
  const enforce: ModelsSection = { v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [] };
  const shipped = gateAllows({ route: routeUnder(enforce), catalog: CATALOGUE, clientRoute: 'near', host, now: FIXED_NOW });
  assert.equal(shipped(NANO, 'safety'), false, 'not evaluated (C-4)');
  assert.equal(shipped('z-ai/glm-5.3', 'safety'), false);
  const evaluated = evaluatedModels('enforce', ['nvidia/nemotron-3-nano']);
  const allows = gateAllows({ route: routeUnder(evaluated), catalog: CATALOGUE, clientRoute: 'near', host, now: FIXED_NOW });
  assert.equal(allows(NANO, 'safety'), true);
  assert.equal(allows('somevendor/not-in-catalogue', 'safety'), false);
  assert.deepEqual(checkerFor('safety', GPT_OSS, preferredModels(SAFETY, CATALOGUE, evaluated, FIXED_NOW), (id) => allows(id, 'safety'), { models: evaluated, now: FIXED_NOW }),
    { model: NANO, families: { author: 'gpt', checker: 'nemotron' } });
  // With no models section the shipped approvals report only, so the preview allows as before.
  assert.equal(gateAllows({ route: routeUnder(undefined), catalog: CATALOGUE, clientRoute: 'near', host, now: FIXED_NOW })(GUARDIAN, 'safety'), true);
});
