import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gapStates, loadGaps, loadPoam } from '../src/gaps.ts';
import { validateOurs } from '../src/validate.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gaps = loadGaps(path.join(root, 'gaps.json'));
const poam = loadPoam(path.join(root, 'poam'));
const now = new Date('2026-11-21T12:00:00.000Z');
const stateFor = (id: string, rows: readonly { level: string; control: string; state: 'met' | 'not-met' | 'not-applicable' }[] = [], acceptances: readonly any[] = [], at = now) => gapStates({ gaps, poam, rows, acceptances, now: at }).find((gap) => gap.id === id)!;

test('the real gap register and every POA&M item validate', () => {
  assert.equal(gaps.length, 25);
  assert.equal(poam.length, 17);
  assert.ok(gaps.every((gap) => gap.controls.length > 0 && gap.remediation !== '' && gap.ownerRole !== '' && (gap.closesInPhase === undefined) !== (gap.poam === undefined)));
});
test('a gap closes only when every control has met or reviewed-not-applicable evidence', () => assert.equal(stateFor('G13', [{ level: 'protected-b', control: 'sc-08', state: 'met' }, { level: 'protected-b', control: 'sr-11', state: 'not-applicable' }]).state, 'closed'));
test('some evidence for a gap is in progress', () => assert.equal(stateFor('G13', [{ level: 'protected-b', control: 'sc-08', state: 'met' }]).state, 'in-progress'));
test('a POA&M milestone makes an untouched gap planned', () => assert.equal(stateFor('G13').state, 'planned'));
test('the product incident exercise and advisory evidence are planned for Phase 44.1', () => assert.equal(stateFor('G1').phase, '44.1'));
test('a past target date is an overdue flag', () => assert.equal(stateFor('G13', [], [], new Date('2028-01-01T00:00:00.000Z')).overdue, true));
test('a current verified acceptance makes its gap risk accepted until its expiry', () => {
  const accepted = stateFor('G13', [], [{ id: 'ra', gap: 'G13', controls: ['sc-08', 'sr-11'], reason: 'Accepted.', namedPerson: { name: 'Owner', role: 'Owner' }, issuedAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-12-01T00:00:00.000Z' }]);
  assert.deepEqual({ state: accepted.state, acceptedUntil: accepted.acceptedUntil }, { state: 'risk-accepted', acceptedUntil: '2026-12-01T00:00:00.000Z' });
});
test('an expired acceptance does not change the planned state', () => assert.equal(stateFor('G13', [], [{ id: 'ra', gap: 'G13', controls: ['sc-08', 'sr-11'], reason: 'Accepted.', namedPerson: { name: 'Owner', role: 'Owner' }, issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-11-20T00:00:00.000Z' }]).state, 'planned'));
