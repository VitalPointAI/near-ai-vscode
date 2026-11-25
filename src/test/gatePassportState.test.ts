// Phase 74.1-06 Task 1 (D-15, D-16; design 12.1): every passport is in exactly one state, decided by its dates, the triggers it lists and your
// organization's removal order. Pure: the test passes the time and the observed facts. Fictional passports only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { parseModelsSection, resolvePassport } from '../domain/gate/models';
import type { ResolvedPassport } from '../domain/gate/models';
import { REVOKE_ALL_USES, passportEvaluated, passportState } from '../domain/gate/passportState';
import { FIXED_NOW } from './helpers/policyFixtures';

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
