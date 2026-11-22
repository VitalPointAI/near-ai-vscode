import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateControl, computeStatus, summarizeLevel } from '../src/status.ts';
import type { ComponentRow, EvidenceRule, StatusInput } from '../src/model.ts';

const NOW = new Date('2026-11-21T12:00:00.000Z');
const HEAD = 'a'.repeat(40);
const rule: EvidenceRule = { id: 'extension.ac-01.proves', component: 'extension', control: 'ac-01', statement: 'ac-01_smt', kind: 'test', test: { file: 'src/test/status.test.ts', path: [], name: 'proof' } };
const passing = { rule: rule.id, passed: true, reason: 'met' as const, collectedAt: NOW.toISOString(), commit: HEAD, window: 'head' as const };
const input = (overrides: Partial<StatusInput> = {}): StatusInput => ({ control: 'ac-01', component: 'extension', level: 'protected-b', responsibility: 'product', statements: [{ id: 'ac-01_smt', description: 'A statement.' }], rulesByStatement: { 'ac-01_smt': [rule] }, results: { [rule.id]: passing }, head: HEAD, now: NOW, ...overrides });

const cases: readonly [string, Partial<StatusInput>, string, string][] = [
  ['a statement without rules', { rulesByStatement: {} }, 'not-met', 'no-rules'],
  ['a failed rule', { results: { [rule.id]: { ...passing, passed: false, reason: 'test-failed' } } }, 'not-met', 'test-failed'],
  ['a head mismatch', { head: 'b'.repeat(40) }, 'stale', 'stale'],
  ['an audit 25 hours old', { results: { [rule.id]: { ...passing, window: 'audit', collectedAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString() } } }, 'stale', 'stale'],
  ["your organization's responsibility", { responsibility: 'your-organization' }, 'your-organizations-responsibility', 'your-organization'],
  ['unreviewed not applicable', { responsibility: 'not-applicable' }, 'not-met', 'not-applicable-unreviewed'],
  ['reviewed not applicable', { responsibility: 'not-applicable', tailoring: { level: 'protected-b', control: 'ac-01', component: 'extension', reason: 'Outside scope.', reviewer: 'Owner', reviewedAt: '2026-11-20' } }, 'not-applicable', 'not-applicable'],
  ['unsettled evidence', { unsettled: 'tee-question' }, 'not-met', 'unsettled'],
  ['self signed official decision', { selfSigned: true, statements: [{ id: 'ac-01_smt', description: 'A statement.', requiresOfficialSignature: true }] }, 'not-met', 'self-signed'],
  ['no statement', { statements: [] }, 'not-met', 'no-statement']
];

for (const [name, overrides, state, reason] of cases) test(name, () => {
  const outcome = computeStatus(input(overrides));
  assert.equal(outcome.state, state);
  assert.equal(outcome.reason, reason);
});

test('two statements with a passed and failed result are partly met', () => {
  const second = { ...rule, id: 'extension.ac-01.second', statement: 'ac-01_smt.b' };
  assert.deepEqual(computeStatus(input({ statements: [{ id: 'ac-01_smt', description: 'one' }, { id: 'ac-01_smt.b', description: 'two' }], rulesByStatement: { 'ac-01_smt': [rule], 'ac-01_smt.b': [second] }, results: { [rule.id]: passing, [second.id]: { ...passing, rule: second.id, passed: false, reason: 'test-failed' } } })), { state: 'partly-met', reason: 'partly-statements' });
});

test('a limitation makes otherwise met evidence partly met', () => assert.deepEqual(computeStatus(input({ limitation: 'A real known limitation.' })), { state: 'partly-met', reason: 'limitation', detail: { text: 'A real known limitation.' } }));

test('aggregateControl combines component outcomes', () => {
  const component = (state: 'met' | 'not-met' | 'stale', responsibility: StatusInput['responsibility'] = 'product'): ComponentRow => ({ component: state, state, reason: state === 'met' ? 'met' : state === 'stale' ? 'stale' : 'test-failed', responsibility, evidence: [] });
  assert.equal(aggregateControl([component('met'), component('not-met')]).state, 'partly-met');
  assert.equal(aggregateControl([component('met'), component('stale')]).state, 'stale');
  assert.equal(aggregateControl([component('not-met', 'your-organization'), component('not-met', 'inherited')]).state, 'your-organizations-responsibility');
});

test('level summary counts stale as not met', () => {
  const summary = summarizeLevel([{ state: 'met' }, { state: 'met' }, { state: 'met' }, { state: 'stale' }, { state: 'stale' }, { state: 'not-met' }]);
  assert.deepEqual(summary, { met: 3, 'partly-met': 0, 'not-met': 1, stale: 2, 'not-applicable': 0, 'your-organizations-responsibility': 0, notMetTotal: 3, metTotal: 3 });
});

test('a missing result is not met', () => assert.deepEqual(computeStatus(input({ results: {} })), { state: 'not-met', reason: 'missing-result' }));
test('shared responsibility can be met from current evidence', () => assert.deepEqual(computeStatus(input({ responsibility: 'shared' })), { state: 'met', reason: 'met' }));
test('inherited responsibility remains visible as your organization responsibility', () => assert.deepEqual(computeStatus(input({ responsibility: 'inherited' })), { state: 'your-organizations-responsibility', reason: 'inherited' }));
test('an expired acceptance does not replace the evidence failure', () => assert.deepEqual(computeStatus(input({ results: { [rule.id]: { ...passing, passed: false, reason: 'test-failed' } }, riskAcceptance: { id: 'ra', gap: 'G1', controls: ['ac-01'], reason: 'Expired.', namedPerson: { name: 'Owner', role: 'Owner' }, issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-11-20T00:00:00.000Z' } })), { state: 'not-met', reason: 'test-failed' }));
