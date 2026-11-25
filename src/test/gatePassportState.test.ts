// Phase 74.1-06 Task 1 (D-15, D-16; design 12.1): every passport is in exactly one state, decided by its dates, the triggers it lists and your
// organization's removal order. Pure: the test passes the time and the observed facts. Fictional passports only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { parseModelsSection, resolvePassport } from '../domain/gate/models';
import type { ModelsSection, ResolvedPassport, UseTier } from '../domain/gate/models';
import { REVOKE_ALL_USES, passportEvaluated, passportState } from '../domain/gate/passportState';
import { DEFAULT_ROUTING, decideRoute } from '../domain/gate/routing';
import type { RouteDecision, RouteFacts, RoutePolicy, VerifiedAuthorization } from '../domain/gate/routing';
import { FIXED_NOW, authorizationFor, evaluatedModels } from './helpers/policyFixtures';

const SHA = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function resolved(overrides: Record<string, unknown> = {}): ResolvedPassport {
  const passport = {
    id: 'example/western-chat', match: ['example/Western-Chat-*'], developer: 'Example Labs', origin: 'CA',
    lineage: { family: 'example', base: 'Western Chat', teachers: [], method: 'pretrain' }, licence: { id: 'Apache-2.0', obligations: [], inherited: [] },
    legal: { coveredByUsLaw: false, entityList: false, removalOrders: [] }, hosting: ['local'], maxTier: 'T2',
    artifact: { format: 'gguf', sha256: SHA, quantization: 'q4_k_m', remoteCode: false },
    issuedAt: '2026-11-20T00:00:00.000Z', expiresAt: '2027-06-01T00:00:00.000Z', reevaluateOn: ['artifact-change', 'hosting-change', 'licence-change', 'quantization'], ...overrides
  };
  const parsed = parseModelsSection({ v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [passport] }, SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : `${parsed.reason} ${parsed.path}`);
  const found = parsed.ok ? resolvePassport(parsed.value, 'example/Western-Chat-8B', FIXED_NOW) : undefined;
  assert.ok(found);
  return found;
}

test('an unknown model is unknown: research only', () => {
  assert.deepEqual(passportState(undefined, {}, FIXED_NOW), { state: 'unknown' });
});

test('a valid passport inside its dates is approved at its tier', () => {
  assert.deepEqual(passportState(resolved(), {}, FIXED_NOW), { state: 'approved', maxTier: 'T2' });
});

test('after expiresAt it is expired by date; before issuedAt too', () => {
  assert.deepEqual(passportState(resolved(), {}, Date.parse('2027-06-01T00:00:00.000Z')), { state: 'expired', reason: 'date' });
  assert.deepEqual(passportState(resolved(), {}, Date.parse('2026-11-19T00:00:00.000Z')), { state: 'expired', reason: 'date' });
});

test('hosting-change: the place a model runs differs from the first seen for this passport', () => {
  const firstSeen = { privacyBoundary: 'tee' };
  assert.deepEqual(passportState(resolved(), { firstSeen, current: { privacyBoundary: 'cloud' } }, FIXED_NOW), { state: 'expired', reason: 'hosting-change' });
  assert.deepEqual(passportState(resolved(), { firstSeen: { privacyBoundary: 'cloud', forwardedTo: 'example.org' }, current: { privacyBoundary: 'cloud', forwardedTo: 'other.example' } }, FIXED_NOW), { state: 'expired', reason: 'hosting-change' });
  assert.deepEqual(passportState(resolved(), { firstSeen, current: { privacyBoundary: 'tee' } }, FIXED_NOW).state, 'approved');
});

test('quantization: a reported quantization other than the approved files\' ', () => {
  assert.deepEqual(passportState(resolved(), { quantization: 'q8_0' }, FIXED_NOW), { state: 'expired', reason: 'quantization' });
  assert.equal(passportState(resolved(), { quantization: 'q4_k_m' }, FIXED_NOW).state, 'approved');
});

test('artifact-change: an observed hash other than the approved files\'', () => {
  assert.deepEqual(passportState(resolved(), { artifactSha256: OTHER }, FIXED_NOW), { state: 'expired', reason: 'artifact-change' });
  assert.equal(passportState(resolved(), { artifactSha256: SHA }, FIXED_NOW).state, 'approved');
});

test('licence-change: a reported licence other than the passport\'s', () => {
  assert.deepEqual(passportState(resolved(), { licenceId: 'LicenseRef-Example' }, FIXED_NOW), { state: 'expired', reason: 'licence-change' });
  assert.equal(passportState(resolved(), { licenceId: 'Apache-2.0' }, FIXED_NOW).state, 'approved');
});

test('a trigger the passport does not list never fires', () => {
  const quiet = resolved({ reevaluateOn: ['fine-tune'] });
  for (const observed of [{ quantization: 'q8_0' }, { artifactSha256: OTHER }, { licenceId: 'LicenseRef-Example' }, { firstSeen: { privacyBoundary: 'tee' }, current: { privacyBoundary: 'cloud' } }]) {
    assert.equal(passportState(quiet, observed, FIXED_NOW).state, 'approved', JSON.stringify(observed));
  }
});

test('a trigger fired earlier (kept in the trigger log) keeps the passport expired', () => {
  assert.deepEqual(passportState(resolved(), { fired: ['hosting-change'] }, FIXED_NOW), { state: 'expired', reason: 'hosting-change' });
  assert.equal(passportState(resolved({ reevaluateOn: ['fine-tune'] }), { fired: ['hosting-change'] }, FIXED_NOW).state, 'approved', 'only a listed trigger counts');
});

test(`revoked: a removal order reading exactly "${REVOKE_ALL_USES}"; "All uses" or "all uses." does not revoke`, () => {
  assert.equal(REVOKE_ALL_USES, 'all uses');
  assert.deepEqual(passportState(resolved({ legal: { coveredByUsLaw: false, entityList: false, removalOrders: ['all uses'] } }), {}, FIXED_NOW), { state: 'revoked' });
  for (const near of ['All uses', 'all uses.']) {
    assert.notEqual(passportState(resolved({ legal: { coveredByUsLaw: false, entityList: false, removalOrders: [near] } }), {}, FIXED_NOW).state, 'revoked', near);
  }
  // Revocation wins over an expired date and over a trigger.
  assert.deepEqual(passportState(resolved({ legal: { coveredByUsLaw: false, entityList: false, removalOrders: ['all uses'] } }), { fired: ['hosting-change'] }, Date.parse('2027-07-01T00:00:00.000Z')), { state: 'revoked' });
});

test('passportEvaluated: only with your organization\'s evaluation and a tier that covers the use', () => {
  const evaluation = { report: 'EVAL-2026-11-001', sha256: SHA, at: '2026-11-21T00:00:00.000Z' };
  assert.equal(passportEvaluated(resolved(), 'T2', FIXED_NOW), false, 'no evaluation');
  assert.equal(passportEvaluated(resolved({ evaluation }), 'T2', FIXED_NOW), true);
  assert.equal(passportEvaluated(resolved({ evaluation }), 'T3', FIXED_NOW), false, 'the tier does not cover operational work');
  assert.equal(passportEvaluated(undefined, 'T1', FIXED_NOW), false);
});

test('no state waits on anything but a date or a new passport: the same facts at the same time always give the same state', () => {
  const facts = { firstSeen: { privacyBoundary: 'tee' }, current: { privacyBoundary: 'cloud' } };
  const first = passportState(resolved(), facts, FIXED_NOW);
  assert.deepEqual(passportState(resolved(), facts, FIXED_NOW), first);
  // A new passport (new hash) starts clean: the trigger log keeps fired triggers per hash, and this one fired none.
  assert.equal(passportState(resolved({ expiresAt: '2027-05-01T00:00:00.000Z' }), {}, FIXED_NOW).state, 'approved');
});

// ---- Task 3 (D-15, D-16): the state and your organization's evaluation in step 7 ----

const NEAR = 'https://cloud-api.near.ai/v1';
const PUBLIC: Label = { scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] };
const PROJECT = 'project-northern-example';
const GPT_OSS = 'openai/gpt-oss-120b';
const factsFor = (model: string, use: UseTier, extra: Partial<RouteFacts> = {}): RouteFacts => ({
  clientRoute: 'near', host: NEAR, nearEndpoint: true, model: { id: model, privacyBoundary: 'tee' }, attestationFailed: false, now: FIXED_NOW, use, ...extra
});
function decideWith(models: ModelsSection, facts: RouteFacts, extra: Partial<RoutePolicy> = {}): RouteDecision {
  const policy: RoutePolicy = { endpoints: [], authorizations: [], scales: SCALE_PRESETS, mappings: [], clearances: [], organization: true, requireAccreditedDevice: false, now: FIXED_NOW, project: PROJECT, models, ...extra };
  return decideRoute([PUBLIC], DEFAULT_ROUTING, facts, undefined, undefined, policy);
}
const SHIPPED_ENFORCE: ModelsSection = { v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [] };
const gapOf = (decision: RouteDecision) => ({ allowed: decision.allowed, rule: decision.rule, gap: decision.passportGap });
const hashOf = (models: ModelsSection, model: string): string => resolvePassport(models, model, FIXED_NOW)?.hash ?? '';
function sectionWith(mode: 'enforce' | 'report', overrides: Record<string, unknown>): ModelsSection {
  const passport = {
    id: 'example/western-chat', match: ['example/Western-Chat-*'], developer: 'Example Labs', origin: 'CA',
    lineage: { family: 'example', base: 'Western Chat', teachers: [], method: 'pretrain' }, licence: { id: 'Apache-2.0', obligations: [], inherited: [] },
    legal: { coveredByUsLaw: false, entityList: false, removalOrders: [] }, hosting: ['nearai-tee'], maxTier: 'T2', evaluation: { report: 'EVAL-EXAMPLE-2026-0007', sha256: SHA, at: '2026-11-01T00:00:00.000Z' },
    issuedAt: '2026-11-20T00:00:00.000Z', expiresAt: '2027-06-01T00:00:00.000Z', reevaluateOn: ['hosting-change'], ...overrides
  };
  const parsed = parseModelsSection({ v: 1, mode, unknownMaxTier: 'T0', passports: [passport] }, SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : `${parsed.reason} ${parsed.path}`);
  return parsed.ok ? parsed.value : (undefined as never);
}

test('D-16, C-4: under enforce a shipped passport (no evaluation) refuses every use above research with not-evaluated, checking included; research needs none', () => {
  for (const use of ['T1', 'T2'] as const) assert.deepEqual(gapOf(decideWith(SHIPPED_ENFORCE, factsFor(GPT_OSS, use))), { allowed: false, rule: 'route.passport', gap: 'not-evaluated' }, use);
  const checking = decideWith(SHIPPED_ENFORCE, factsFor(GPT_OSS, 'T1', { useInput: { checkingJob: true } }));
  assert.deepEqual({ ...gapOf(checking), useTier: checking.useTier }, { allowed: false, rule: 'route.passport', gap: 'not-evaluated', useTier: 'T2' });
  assert.match(checking.reason ?? '', /^Nothing was sent\. Your organization has not evaluated openai\/gpt-oss-120b for agent work/);
  assert.equal(decideWith(SHIPPED_ENFORCE, factsFor(GPT_OSS, 'T0')).allowed, true, 'research needs no evaluation');
});

test('D-16: with your organization\'s evaluation and a tier that covers the use, the same requests go; a use above the approval is still tier-exceeded', () => {
  const models = evaluatedModels('enforce', ['openai/gpt-oss']);
  for (const use of ['T1', 'T2'] as const) assert.deepEqual(gapOf(decideWith(models, factsFor(GPT_OSS, use))).allowed, true, use);
  assert.equal(decideWith(models, factsFor(GPT_OSS, 'T1', { useInput: { checkingJob: true } })).allowed, true, 'a checking role');
  assert.equal(decideWith(models, factsFor(GPT_OSS, 'T3')).passportGap, 'tier-exceeded');
});

test('D-16: chat you review for a PRC-origin model allowed by a t1-risk exception your organization carries needs no evaluation; its assessment reference is recorded', () => {
  const risk: VerifiedAuthorization = { body: authorizationFor({ kind: 't1-risk', subject: { model: 'z-ai/glm' }, scope: { projects: [PROJECT], labels: ['org/Public'], uses: ['t1'] }, evidence: 'TRA-EXAMPLE-2026-0099' }), selfSigned: false };
  const allowed = decideWith(SHIPPED_ENFORCE, factsFor('z-ai/glm-5.3', 'T1'), { authorizations: [risk] });
  assert.equal(allowed.allowed, true);
  assert.ok(allowed.allowedBy?.some((record) => record.kind === 'authorization' && record.authorizationKind === 't1-risk' && record.evidence === 'TRA-EXAMPLE-2026-0099'));
  assert.equal(decideWith(SHIPPED_ENFORCE, factsFor('z-ai/glm-5.3', 'T2'), { authorizations: [risk] }).passportGap, 'tier-exceeded', 'never agent work');
});

test('D-15: under enforce a trigger fired for the request\'s own passport refuses every use above research with expired, naming the trigger', () => {
  const models = evaluatedModels('enforce', ['openai/gpt-oss']);
  const observed = { passportHash: hashOf(models, GPT_OSS), fired: ['hosting-change' as const] };
  for (const use of ['T1', 'T2'] as const) {
    const refused = decideWith(models, factsFor(GPT_OSS, use, { observed }));
    assert.deepEqual(gapOf(refused), { allowed: false, rule: 'route.passport', gap: 'expired' }, use);
    assert.match(refused.reason ?? '', /The approval of openai\/gpt-oss-120b ended because the place it runs changed\./);
  }
  assert.equal(decideWith(models, factsFor(GPT_OSS, 'T0', { observed })).allowed, true, 'research still goes');
  // The place seen now, against the first seen, fires it too; another passport's observations are never read.
  const moved = { passportHash: hashOf(models, GPT_OSS), firstSeen: { privacyBoundary: 'tee' }, current: { privacyBoundary: 'cloud', forwardedTo: 'example.com' } };
  assert.equal(decideWith(models, factsFor(GPT_OSS, 'T2', { observed: moved })).passportGap, 'expired');
  assert.equal(decideWith(models, factsFor(GPT_OSS, 'T2', { observed: { ...observed, passportHash: OTHER } })).allowed, true);
});

test('D-15: a revoked passport refuses every use, research included, with revoked', () => {
  const models = sectionWith('enforce', { legal: { coveredByUsLaw: false, entityList: false, removalOrders: [REVOKE_ALL_USES] } });
  for (const use of ['T0', 'T1', 'T2'] as const) {
    const refused = decideWith(models, factsFor('example/Western-Chat-8B', use));
    assert.deepEqual(gapOf(refused), { allowed: false, rule: 'route.passport', gap: 'revoked' }, use);
    assert.match(refused.reason ?? '', /has withdrawn the approval of example\/Western-Chat-8B for every use, research included/);
  }
});

test('D-15, D-16: under report each of these is recorded as would-refuse with its gap, and allowed', () => {
  const evaluated = evaluatedModels('report', ['openai/gpt-oss']);
  const cases: Array<[string, RouteDecision, string]> = [
    ['not evaluated', decideWith({ ...SHIPPED_ENFORCE, mode: 'report' }, factsFor(GPT_OSS, 'T2')), 'not-evaluated'],
    ['triggered', decideWith(evaluated, factsFor(GPT_OSS, 'T2', { observed: { passportHash: hashOf(evaluated, GPT_OSS), fired: ['hosting-change'] } })), 'expired'],
    ['revoked', decideWith(sectionWith('report', { legal: { coveredByUsLaw: false, entityList: false, removalOrders: [REVOKE_ALL_USES] } }), factsFor('example/Western-Chat-8B', 'T0')), 'revoked']
  ];
  for (const [name, decision, gap] of cases) {
    assert.deepEqual({ allowed: decision.allowed, wouldRefuse: decision.wouldRefuse, gap: decision.passportGap }, { allowed: true, wouldRefuse: ['route.passport'], gap }, name);
  }
  assert.equal(decideWith(evaluated, factsFor(GPT_OSS, 'T2')).wouldRefuse, undefined, 'an evaluated, current passport reports nothing');
});
