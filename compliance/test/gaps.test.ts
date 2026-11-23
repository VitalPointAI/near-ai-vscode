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
  assert.equal(gaps.length, 55);
  assert.equal(poam.length, 47);
  assert.ok(gaps.every((gap) => gap.controls.length > 0 && gap.remediation !== '' && gap.ownerRole !== '' && (gap.closesInPhase === undefined) !== (gap.poam === undefined)));
});
test('release assessment gaps have named open paths', () => {
  for (const [control, id, phase] of [
    ['ac-02', 'G14', '33'], ['au-02', 'G11', '44.1'], ['si-03', 'G15', '44.1'],
    ['ac-16.05', 'G16', '41'], ['ac-06.09', 'G17', '33.1'], ['au-05.01', 'G18', '44.1'], ['ia-05', 'G19', '44.1'],
    ['ia-01', 'G20', '44.1'], ['ia-04', 'G21', '44.1'], ['ia-04.04', 'G21', '44.1'],
    ['ia-12', 'G22', '44.1'], ['ia-12.02', 'G22', '44.1'], ['ia-12.03', 'G22', '44.1'],
    ['ia-12.04', 'G22', '44.1'], ['ia-12.05', 'G22', '44.1'],
    ['ia-03', 'G23', '44.1'], ['ia-05.01', 'G24', '44.1'], ['ia-06', 'G24', '44.1'],
    ['ia-05.07', 'G25', '44.1'], ['ia-07', 'G26', '44.1'],
    ['ia-02', 'G27', '44.1'], ['ia-02.01', 'G27', '44.1'], ['ia-02.02', 'G27', '44.1'],
    ['ia-02.08', 'G27', '44.1'], ['ia-02.10', 'G27', '44.1'], ['ia-11', 'G27', '44.1'],
    ['ia-05.08', 'G28', '44.1'],
    ['ia-05.09', 'G29', '44.1'], ['ia-08', 'G29', '44.1'], ['ia-08.01', 'G29', '44.1'],
    ['ia-08.02', 'G29', '44.1'], ['ia-08.04', 'G29', '44.1'], ['ia-05.14', 'G30', '44.1'],
    ['cp-02.02', 'G31', '44.1'], ['cp-04.01', 'G32', '44.1'], ['cp-07.06', 'G33', '44.1'],
    ['cp-08.05', 'G34', '44.1'], ['cp-09', 'G35', '44.1'], ['cp-09.07', 'G35', '44.1'],
    ['cp-10', 'G36', '44.1'], ['cp-10.04', 'G36', '44.1'],
    ['ac-07', 'G37', '44.1'], ['ac-08', 'G38', '44.1'], ['ac-14', 'G38', '44.1'],
    ['ac-11', 'G39', '44.1'], ['ac-11.01', 'G39', '44.1'],
    ['ac-02.05', 'G40', '44.1'], ['ac-12', 'G40', '44.1'],
    ['ac-17', 'G41', '44.1'], ['ac-17.01', 'G41', '44.1'], ['ac-17.02', 'G41', '44.1'],
    ['ac-17.03', 'G41', '44.1'], ['ac-17.04', 'G41', '44.1'], ['ac-17.400', 'G41', '44.1'],
    ['ac-20', 'G42', '44.1'], ['ac-20.01', 'G42', '44.1'], ['ac-20.02', 'G42', '44.1'],
    ['ac-20.04', 'G42', '44.1'], ['ac-21', 'G43', '44.1'], ['ac-21.400', 'G43', '44.1'],
    ['ac-21.401', 'G43', '44.1']
  ]) {
    const gap = gaps.find((item) => item.id === id);
    const item = poam.find((candidate) => candidate.id === gap?.poam);
    assert.ok(gap?.controls.includes(control), control);
    assert.ok(item?.controls.includes(control), control);
    assert.equal(item?.milestones[0]?.phase, phase, control);
    assert.equal(stateFor(id).state, 'planned', control);
  }
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
