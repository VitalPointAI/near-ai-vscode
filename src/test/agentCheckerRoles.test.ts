// Phase 74.1-09 (D-16, D-19, D-23, MPRV-09, T-74.1-29, T-74.1-30): every checking role in a team or staff run runs on a family none of the run's writers
// used, allowed by the gate for a checking job, or is not started; its route and records carry both families. Fictional runs; no network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolError } from '../agent/workspace';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { checkingRoleOf, isCheckingRole, sameFamilyText } from '../domain/gate/lineage';
import type { ModelsSection } from '../domain/gate/models';
import type { DecisionRecord, PolicyRecordVersion } from '../domain/gate/record';
import { DEFAULT_ROUTING } from '../domain/gate/routing';
import type { RoutePolicy } from '../domain/gate/routing';
import { routeRecordFor, sessionRouteFrom } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { SHIPPED_DEFAULT_LABEL } from '../domain/gate/bundle';
import { resolveSubagentModel, sameFamilyReportText, writingModelsOf } from '../services/subagentModel';
import type { SubagentModelInput } from '../services/subagentModel';
import { testBundleState, testGateRuntime } from './helpers/gatedRuns';
import { evaluatedModels } from './helpers/policyFixtures';

const GPT_OSS = 'openai/gpt-oss-120b';
const SUPER = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8';
const COMMAND = 'CohereLabs/command-a-plus-05-2026-w4a4';
const GLM = 'z-ai/glm-5.3';
const tee = (id: string) => ({ id, privacyBoundary: 'tee' as const });
const CATALOGUE = [GPT_OSS, SUPER, COMMAND, GLM].map(tee);
const NEAR_ROUTE = { kind: 'near' as const, attestation: true };

function routeUnder(models?: ModelsSection): SessionRoute {
  const state = testBundleState();
  const policy = (): RoutePolicy & { readonly policyVersion: PolicyRecordVersion } => ({
    endpoints: [], authorizations: [], scales: SCALE_PRESETS, mappings: [], clearances: [], organization: true, requireAccreditedDevice: false, now: Date.now(), policyVersion: 'bundle-2', ...(models === undefined ? {} : { models })
  });
  return { markOf: () => [], bundleState: () => state, actor: { kind: 'agent', deviceFingerprint: 'd', sessionId: 's' }, attestation: { failed: false }, routePolicy: policy };
}

function spawn(label: string, request: Partial<SubagentModelInput['request']> & { readonly model: string }, extra: Partial<SubagentModelInput> = {}) {
  const full = { tiers: { deep: request.model, standard: request.model, fast: request.model }, availableModels: CATALOGUE.map((entry) => entry.id), modelCatalog: CATALOGUE, route: NEAR_ROUTE, ...request };
  return resolveSubagentModel({ label, spawn: {}, teamMember: false, request: full, writing: writingModelsOf(full), route: routeUnder(), ...extra });
}

test('checking roles are found by name: reviewers, plan checkers, verifiers, editors, red team, release guard, tradecraft reviewer', () => {
  for (const label of ['reviewer', 'gsd-plan-checker', 'gsd-verifier', 'gsd-code-reviewer', 'editor', 'red-team', 'release-guard', 'tradecraft-reviewer']) assert.equal(isCheckingRole(label), true, label);
  for (const label of ['planner', 'gsd-executor', 'red-cell', 'j2-chief', 'jipoe-analyst']) assert.equal(isCheckingRole(label), false, label);
  assert.equal(checkingRoleOf('tradecraft-reviewer'), 'tradecraft-reviewer');
  assert.equal(checkingRoleOf('j2-release-guard'), 'release-guard');
});

test('a writing role keeps its tier model, as before the move, and joins the run\'s writers', () => {
  const request = { model: GPT_OSS, tiers: { deep: SUPER, standard: GPT_OSS, fast: GPT_OSS }, availableModels: CATALOGUE.map((entry) => entry.id), modelCatalog: CATALOGUE, route: NEAR_ROUTE };
  const writing = writingModelsOf(request);
  const planner = resolveSubagentModel({ label: 'planner', spawn: { model: 'deep' }, teamMember: false, request, writing, route: routeUnder() });
  assert.deepEqual({ model: planner.model, checkFamilies: planner.checkFamilies }, { model: SUPER, checkFamilies: undefined });
  assert.deepEqual([...writing].sort(), [SUPER, GPT_OSS].sort());
});

test('a model the call names that is not on this key still fails the call (moved unchanged)', () => {
  assert.throws(() => spawn('planner', { model: GPT_OSS }, { spawn: { model: 'example/not-on-this-key' } }), ToolError);
});

test('a gpt-oss run\'s reviewer runs on Nemotron, and its families are named', () => {
  const reviewer = spawn('reviewer', { model: GPT_OSS });
  assert.deepEqual({ model: reviewer.model, checkFamilies: reviewer.checkFamilies }, { model: SUPER, checkFamilies: { author: ['gpt'], checker: 'nemotron' } });
  assert.match(reviewer.modelNote ?? '', /checks work by the gpt family, so it runs on .*Nemotron/);
});

test('a checker whose own model is already of another family keeps it', () => {
  const reviewer = spawn('reviewer', { model: GPT_OSS, tiers: { deep: SUPER, standard: SUPER, fast: SUPER } }, { spawn: { model: 'standard' } });
  assert.equal(reviewer.model, SUPER);
  assert.equal(reviewer.modelNote, undefined);
});

test('J2: with analysts on Nemotron 3 Super, the tradecraft reviewer and release guard run on Command A+ or gpt-oss', () => {
  const request = { model: SUPER, tiers: { deep: SUPER, standard: SUPER, fast: SUPER }, availableModels: CATALOGUE.map((entry) => entry.id), modelCatalog: CATALOGUE, route: NEAR_ROUTE };
  const writing = writingModelsOf(request);
  for (const analyst of ['jipoe-analyst', 'threat-analyst']) resolveSubagentModel({ label: analyst, spawn: {}, teamMember: false, request, writing, route: routeUnder() });
  for (const label of ['tradecraft-reviewer', 'release-guard']) {
    const checker = resolveSubagentModel({ label, spawn: {}, teamMember: false, request, writing, route: routeUnder() });
    assert.ok([COMMAND, GPT_OSS].includes(checker.model), `${label}: ${checker.model}`);
    assert.deepEqual(checker.checkFamilies?.author, ['nemotron']);
  }
});

test('with no allowed model of another family the checker is not started under enforce, and the sentence says why; while the rules only report it runs and says so', () => {
  const only = [tee(SUPER), tee('nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8')];
  const enforce = routeUnder(evaluatedModels('enforce', ['nvidia/nemotron-3-nano', 'nvidia/nemotron-3-super']));
  assert.throws(() => spawn('tradecraft-reviewer', { model: SUPER, availableModels: only.map((entry) => entry.id), modelCatalog: only }, { route: enforce }),
    (error: unknown) => error instanceof ToolError && error.message === `tradecraft-reviewer was not started. ${sameFamilyText(SUPER, 'nemotron')}`);
  const reported = spawn('tradecraft-reviewer', { model: SUPER, availableModels: only.map((entry) => entry.id), modelCatalog: only });
  assert.deepEqual({ model: reported.model, note: reported.modelNote, families: reported.checkFamilies }, { model: SUPER, note: sameFamilyReportText('tradecraft-reviewer', SUPER), families: undefined });
});

test('under enforce a checker without your organization\'s evaluation is not started; an evaluated one is chosen', () => {
  const enforce: ModelsSection = { v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [] };
  assert.throws(() => spawn('reviewer', { model: GPT_OSS }, { route: routeUnder(enforce) }), (error: unknown) => error instanceof ToolError && /was not started/.test(error.message));
  assert.equal(spawn('reviewer', { model: GPT_OSS }, { route: routeUnder(evaluatedModels('enforce', ['nvidia/nemotron-3-super'])) }).model, SUPER);
});

test('a private member\'s checker is never a forwarded model', () => {
  const catalogue = [tee(GPT_OSS), { id: SUPER, privacyBoundary: 'cloud' as const }, tee(COMMAND)];
  const checker = spawn('reviewer', { model: GPT_OSS, availableModels: catalogue.map((entry) => entry.id), modelCatalog: catalogue, teeOnly: true });
  assert.equal(checker.model, COMMAND);
});

test('a checker\'s route carries checkingJob and both families, and its records name them', () => {
  const families = { author: ['nemotron'], checker: 'gpt' };
  const route = sessionRouteFrom(testGateRuntime(), { use: { tools: true, context: 'sub-agent', checkingJob: true }, checkFamilies: families });
  assert.equal(route.useOf?.().checkingJob, true);
  const record: DecisionRecord = routeRecordFor(route, { allowed: true, tier: 'any-cloud', rule: 'route.any-cloud' }, { clientRoute: 'near', host: 'https://cloud-api.near.ai/v1', nearEndpoint: true, model: tee(GPT_OSS), attestationFailed: false }, { model: GPT_OSS },
    { mark: [], defaultLabel: SHIPPED_DEFAULT_LABEL, bundleHash: '', routing: DEFAULT_ROUTING });
  assert.deepEqual(record.unmapped.nearAi.checkFamilies, families);
  const writer = routeRecordFor(sessionRouteFrom(testGateRuntime()), { allowed: true, tier: 'any-cloud', rule: 'route.any-cloud' }, { clientRoute: 'near', host: 'https://cloud-api.near.ai/v1', nearEndpoint: true, model: tee(GPT_OSS), attestationFailed: false }, { model: GPT_OSS },
    { mark: [], defaultLabel: SHIPPED_DEFAULT_LABEL, bundleHash: '', routing: DEFAULT_ROUTING });
  assert.equal(writer.unmapped.nearAi.checkFamilies, undefined);
});
