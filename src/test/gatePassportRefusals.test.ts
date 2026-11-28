// Phase 74.1-04 Task 1 (D-06, D-11, D-20): under `models.mode: enforce` every gap refuses with its own sentence in the refusal form; a t1-risk exception
// counts only under your organization's layer (never self-signed); a non-commercial licence is research only off a vendor's own service. Fictional
// organizations, people and models only; no network, no key.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { AuthorizationBody } from '../domain/gate/authorizations';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { NON_COMMERCIAL_LICENCES, parseModelsSection, passportCovers, resolvePassport } from '../domain/gate/models';
import type { ModelsSection } from '../domain/gate/models';
import { PASSPORT_GAPS, PASSPORT_GAP_TEXT } from '../domain/gate/passportStep';
import type { PassportGapDetails } from '../domain/gate/passportStep';
import { DEFAULT_ROUTING, decideRoute } from '../domain/gate/routing';
import type { RouteDecision, RouteFacts, RoutePolicy, VerifiedAuthorization } from '../domain/gate/routing';
import { DAY_MS, FIXED_NOW, FIXTURE_EVALUATION, authorizationFor } from './helpers/policyFixtures';

const NEAR = 'https://cloud-api.near.ai/v1';
const PUBLIC: Label = { scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] };
const PROJECT = 'project-northern-example';
const GLM: RouteFacts = { clientRoute: 'near', host: NEAR, nearEndpoint: true, model: { id: 'z-ai/glm-5.3', privacyBoundary: 'tee' }, attestationFailed: false, now: FIXED_NOW };
const ENFORCE: ModelsSection = { v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [] };

function policy(extra: Partial<RoutePolicy> = {}): RoutePolicy {
  return { endpoints: [], authorizations: [], scales: SCALE_PRESETS, mappings: [], clearances: [], organization: true, requireAccreditedDevice: false, now: FIXED_NOW, project: PROJECT, models: ENFORCE, ...extra };
}

const decide = (facts: RouteFacts, extra: Partial<RoutePolicy> = {}): RouteDecision => decideRoute([PUBLIC], DEFAULT_ROUTING, facts, undefined, undefined, policy(extra));

function riskFor(body: Partial<Parameters<typeof authorizationFor>[0]> = {}, selfSigned = false): VerifiedAuthorization {
  const authorization: AuthorizationBody = authorizationFor({ kind: 't1-risk', subject: { model: 'z-ai/glm' }, scope: { projects: [PROJECT], labels: ['org/Public'], uses: ['t1'] }, ...body });
  return { body: authorization, selfSigned };
}

function digest(label: string): string {
  return createHash('sha256').update(`gate-passport-refusals/${label}`, 'utf8').digest('hex');
}

/** A fictional policy passport, valid at FIXED_NOW. */
function passport(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'example/western-chat', match: ['example/Western-Chat-*'], developer: 'Example Labs', origin: 'CA',
    lineage: { family: 'example', base: 'Western Chat (Example Labs)', teachers: [], method: 'pretrain+sft' },
    licence: { id: 'Apache-2.0', obligations: [], inherited: [] }, legal: { coveredByUsLaw: false, entityList: false, removalOrders: [] },
    hosting: ['nearai-tee'], maxTier: 'T2', issuedAt: '2026-11-20T00:00:00.000Z', expiresAt: '2027-06-01T00:00:00.000Z', reevaluateOn: ['artifact-change'], ...overrides
  };
}

function enforceWith(...passports: Array<Record<string, unknown>>): ModelsSection {
  const parsed = parseModelsSection({ v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports }, SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : `${parsed.reason} ${parsed.path}`);
  return parsed.ok ? parsed.value : (undefined as never);
}

const SAMPLE: PassportGapDetails = {
  model: 'example/Western-Chat-8B', use: 'T2', approvedUse: 'T1', expiresAt: '2027-06-01T00:00:00.000Z', licence: 'CC-BY-NC-4.0',
  acceptance: { name: 'Alex Example', expiresAt: '2027-01-01T00:00:00.000Z' }, approvedPlaces: ['NEAR AI private hardware'], place: 'this computer',
  whoToAsk: 'Who to ask: Security Desk (security@example.org).'
};

test('every gap sentence is in the refusal form and never says tier, passport, route. or a tier name', () => {
  for (const gap of PASSPORT_GAPS) {
    const text = PASSPORT_GAP_TEXT[gap](SAMPLE);
    assert.match(text, /^Nothing was sent\. /, gap);
    assert.match(text, /Who to ask: Security Desk \(security@example\.org\)\.$/, gap);
    assert.doesNotMatch(text, /tier|passport|route\.|\bT[0-3]\b|—/i, gap);
  }
});

test('unknown: the model is named and pointed to the research workspace', () => {
  const refused = decide({ ...GLM, model: { id: 'example/unlisted-7b', privacyBoundary: 'tee' }, use: 'T1' });
  assert.deepEqual({ rule: refused.rule, gap: refused.passportGap }, { rule: 'route.passport', gap: 'unknown' });
  assert.match(refused.reason ?? '', /^Nothing was sent\. example\/unlisted-7b has no approval from your organization\./);
  assert.match(refused.reason ?? '', /research workspace/);
});

test('expired: the sentence gives the date the approval ended', () => {
  const later = Date.parse('2027-07-01T00:00:00.000Z');
  const refused = decide({ ...GLM, model: { id: 'example/Western-Chat-8B', privacyBoundary: 'tee' }, use: 'T2', now: later }, { now: later, models: enforceWith(passport({})) });
  assert.equal(refused.passportGap, 'expired');
  assert.match(refused.reason ?? '', /ended on 1 Jun 2027/);
});

test('tier-exceeded: the approved use and this request\'s use, in the glossary\'s words', () => {
  const refused = decide({ ...GLM, model: { id: 'openai/gpt-oss-120b', privacyBoundary: 'tee' }, use: 'T3' });
  assert.equal(refused.passportGap, 'tier-exceeded');
  assert.match(refused.reason ?? '', /is approved for agent work, and this request is operational work\./);
});

test('D-20: a t1-risk authorization under your organization\'s layer covering the model, project and label allows chat you review and is recorded', () => {
  const risk = riskFor();
  const allowed = decide({ ...GLM, use: 'T1' }, { authorizations: [risk] });
  assert.equal(allowed.allowed, true);
  assert.ok(allowed.allowedBy?.some((record) => record.kind === 'authorization' && record.authorizationKind === 't1-risk'));
});

test('D-20: the same authorization verified only against this device\'s key (self-signed, no organization layer) covers nothing', () => {
  const refused = decide({ ...GLM, use: 'T1' }, { organization: false, authorizations: [riskFor({}, true)] });
  assert.deepEqual({ allowed: refused.allowed, gap: refused.passportGap }, { allowed: false, gap: 'acceptance-missing' });
  assert.match(refused.reason ?? '', /approved for research only\. Chat you review needs an exception that a named person in your organization signed/);
});

test('acceptance-expired: an ended risk acceptance names the person and the date', () => {
  const issuedAt = new Date(FIXED_NOW - 40 * DAY_MS).toISOString();
  const ended = riskFor({ issuedAt, expiresAt: new Date(FIXED_NOW - DAY_MS).toISOString() });
  const refused = decide({ ...GLM, use: 'T1' }, { authorizations: [ended] });
  assert.equal(refused.passportGap, 'acceptance-expired');
  assert.match(refused.reason ?? '', /The exception by Alex Example that let z-ai\/glm-5\.3 serve chat you review ended on /);
  // One for another project is not this request's acceptance: missing, not expired.
  const elsewhere = riskFor({ issuedAt, expiresAt: new Date(FIXED_NOW - DAY_MS).toISOString(), scope: { projects: ['project-other'], uses: ['t1'] } });
  assert.equal(decide({ ...GLM, use: 'T1' }, { authorizations: [elsewhere] }).passportGap, 'acceptance-missing');
});

test('T-74.1-11: with a risk acceptance, agent work for a PRC-origin model is still refused (tier-exceeded)', () => {
  assert.equal(decide({ ...GLM, use: 'T2' }, { authorizations: [riskFor({ scope: { projects: [PROJECT], uses: ['t1', 't2'] } })] }).passportGap, 'tier-exceeded');
});

test('hosting-mismatch: the approved places and this one, in the Runs on words', () => {
  const refused = decide({ ...GLM, host: 'http://127.0.0.1:11434', nearEndpoint: false, clientRoute: 'local', model: { id: 'openai/gpt-oss-120b', privacyBoundary: 'local' }, use: 'T2' });
  assert.equal(refused.passportGap, 'hosting-mismatch');
  assert.match(refused.reason ?? '', /is approved to run on NEAR AI private hardware, and this request would run on this computer\./);
});

test('artifact-mismatch: an observed hash that differs from the approved files refuses; the same hash goes', () => {
  const approved = digest('approved-weights');
  // 74.1-06 (D-16): your organization evaluated these exact files, so only the observed hash decides here.
  const models = enforceWith(passport({ hosting: ['local'], artifact: { format: 'gguf', sha256: approved, quantization: 'q4_k_m', remoteCode: false }, evaluation: { ...FIXTURE_EVALUATION } }));
  const local: RouteFacts = { ...GLM, host: 'http://127.0.0.1:11434', nearEndpoint: false, clientRoute: 'local', model: { id: 'example/Western-Chat-8B', privacyBoundary: 'local' }, use: 'T2' };
  assert.equal(decide({ ...local, observedArtifact: digest('other-weights') }, { models }).passportGap, 'artifact-mismatch');
  assert.equal(decide({ ...local, observedArtifact: approved }, { models }).allowed, true);
  assert.equal(decide(local, { models }).allowed, true, 'nothing observed: the approval binds to the id until an attested hash arrives');
});

test('D-06: a passport under a non-commercial licence is research only off a vendor class; on a vendor class the vendor\'s terms apply', () => {
  assert.deepEqual([...NON_COMMERCIAL_LICENCES], ['CC-BY-NC-4.0', 'CC-BY-NC-ND-4.0', 'CC-BY-NC-SA-4.0', 'FLUX-Non-Commercial', 'LicenseRef-Non-Commercial']);
  const commandA = passport({
    id: 'cohere/command-a', match: ['CohereLabs/c4ai-command-a-03-2025'], developer: 'Cohere', licence: { id: 'CC-BY-NC-4.0', obligations: [], inherited: [] },
    hosting: ['org-tee', 'vendor-region'], artifact: { format: 'safetensors', sha256: digest('command-a'), quantization: 'bf16', remoteCode: false }
  });
  const resolved = resolvePassport(enforceWith(commandA), 'CohereLabs/c4ai-command-a-03-2025', FIXED_NOW);
  const covers = (use: 'T0' | 'T1' | 'T2', endpointClass: 'org-tee' | 'vendor-region'): unknown => passportCovers({ resolved, use, endpointClass, t1RiskCovers: false, now: FIXED_NOW });
  assert.deepEqual(covers('T1', 'org-tee'), { covers: false, why: 'licence' });
  assert.deepEqual(covers('T2', 'org-tee'), { covers: false, why: 'licence' });
  assert.deepEqual(covers('T0', 'org-tee'), { covers: true });
  assert.deepEqual(covers('T2', 'vendor-region'), { covers: true });
});

test('licence: the refusal names the licence and points to the vendor\'s own service', () => {
  const commandA = passport({ id: 'cohere/command-a', match: ['example/Command-A'], developer: 'Cohere', licence: { id: 'CC-BY-NC-4.0', obligations: [], inherited: [] } });
  const refused = decide({ ...GLM, model: { id: 'example/Command-A', privacyBoundary: 'tee' }, use: 'T1' }, { models: enforceWith(commandA) });
  assert.equal(refused.passportGap, 'licence');
  assert.match(refused.reason ?? '', /\(CC-BY-NC-4\.0\) allows research only outside the vendor's own service\./);
});

test('who to ask: your organization\'s security contact by name, the generic words without one, and this computer\'s words with no organization layer', () => {
  const unlisted = { ...GLM, model: { id: 'example/unlisted-7b', privacyBoundary: 'tee' as const }, use: 'T1' as const };
  assert.match(decide(unlisted, { contact: { name: 'Security Desk', how: 'security@example.org' } }).reason ?? '', /Who to ask: Security Desk \(security@example\.org\)\.$/);
  assert.match(decide(unlisted).reason ?? '', /Who to ask: your organization's security contact\.$/);
  assert.match(decide(unlisted, { organization: false }).reason ?? '', /Who to ask: whoever set up the rules on this computer\.$/);
});
