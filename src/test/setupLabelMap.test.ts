import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labelKey, SCALE_PRESETS, type Label } from '../domain/gate/labels';
import { DEFAULT_ROUTING } from '../domain/gate/routing';
import type { GuideAnswers } from '../domain/setup/answers';
import { proposeLabel, raiseOnly } from '../domain/setup/map';
import type { StopReason } from '../domain/setup/records';

const caInput = { scales: SCALE_PRESETS, routing: DEFAULT_ROUTING };
const orgInput = { ...caInput, scales: { org: SCALE_PRESETS.org } };

const rows: readonly [
  name: string, answers: GuideAnswers, ca: string, org?: string, stop?: StopReason,
][] = [
  ['public', { data: ['public'] }, 'org/Public', 'org/Public'],
  ['internal', { data: ['internal'] }, 'org/Internal', 'org/Internal'],
  ['personal, not sensitive', { data: ['personal'], personalSensitive: 'no' }, 'ca-protected/Protected A', 'org/Confidential'],
  ['personal, sensitive', { data: ['personal'], personalSensitive: 'yes' }, 'ca-protected/Protected B', 'org/Restricted'],
  ['personal, sensitivity unknown', { data: ['personal'], personalSensitive: 'not-sure' }, 'ca-protected/Protected B', 'org/Restricted'],
  ['Protected A', { data: ['protected-a'] }, 'ca-protected/Protected A'],
  ['Protected B', { data: ['protected-b'] }, 'ca-protected/Protected B'],
  ['Protected C', { data: ['protected-c'] }, 'ca-protected/Protected C', undefined, 'protected-c'],
  ['classified', { data: ['classified'] }, 'ca-classified/Top Secret', undefined, 'classified'],
  ['approved contract at Protected A', { data: ['contract'], contractApproval: 'yes', contractLevel: 'protected-a' }, 'ca-protected/Protected A', 'org/Confidential'],
  ['approved contract at Protected B', { data: ['contract'], contractApproval: 'yes', contractLevel: 'protected-b' }, 'ca-protected/Protected B', 'org/Restricted'],
  ['approved contract at an unknown level', { data: ['contract'], contractApproval: 'yes', contractLevel: 'not-sure' }, 'ca-protected/Protected B', 'org/Restricted'],
  ['contract without approval', { data: ['contract'], contractApproval: 'no', contractLevel: 'protected-b' }, 'ca-protected/Protected B', 'org/Restricted', 'contract-unapproved'],
  ['contract with uncertain approval', { data: ['contract'], contractApproval: 'not-sure', contractLevel: 'protected-a' }, 'ca-protected/Protected A', 'org/Confidential', 'contract-unapproved'],
  ['classified contract', { data: ['contract'], contractApproval: 'yes', contractLevel: 'classified' }, 'ca-classified/Top Secret', undefined, 'classified'],
  ['data not sure', { data: ['not-sure'] }, 'ca-protected/Protected B', 'org/Restricted'],
];

for (const [name, answers, ca, org, stop] of rows) {
  test(`GUIDE 4.3: ${name}`, () => {
    const columns = [
      { input: caInput, expected: ca, column: 'ca' },
      { input: orgInput, expected: org, column: 'org' },
    ];
    for (const { input, expected, column } of columns) {
      if (expected === undefined) continue;
      const outcome = proposeLabel(answers, input);
      assert.equal(labelKey(outcome.proposed), expected);
      assert.equal(outcome.column, column);
      assert.equal(outcome.stop, stop);
      assert.equal(outcome.notSure, answers.data.includes('not-sure'));
      assert.deepEqual(outcome.allowedWhileStopped.map(labelKey), stop === 'contract-unapproved' ? ['org/Public', 'org/Internal'] : []);
    }
  });
}

test('D-05: defaultScale picks the column for personal information', () => {
  const outcome = proposeLabel({ data: ['personal'], personalSensitive: 'no' }, { ...caInput, defaultScale: 'org' });
  assert.equal(labelKey(outcome.proposed), 'org/Confidential');
  assert.equal(outcome.column, 'org');
});

test('the strictest selected answer wins regardless of answer order', () => {
  for (const answers of [
    { data: ['internal', 'protected-b'] },
    { data: ['protected-b', 'internal'] },
    { data: ['personal', 'protected-a'], personalSensitive: 'yes' },
  ] satisfies GuideAnswers[]) {
    assert.equal(labelKey(proposeLabel(answers, caInput).proposed), 'ca-protected/Protected B');
  }
});

test('personal information keeps its Protected A label when internal work has the same routing tier', () => {
  const outcome = proposeLabel({ data: ['internal', 'personal'], personalSensitive: 'no' }, caInput);
  assert.equal(labelKey(outcome.proposed), 'ca-protected/Protected A');
});

test('a classified stop takes precedence over a contract without approval', () => {
  const outcome = proposeLabel({ data: ['contract', 'classified'], contractLevel: 'protected-b', contractApproval: 'no' }, caInput);
  assert.equal(outcome.stop, 'classified');
  assert.deepEqual(outcome.allowedWhileStopped, []);
});

test('the grouped classified answer uses the highest recognized NATO level when only that scale is available', () => {
  const outcome = proposeLabel({ data: ['classified'] }, { ...caInput, scales: { ...orgInput.scales, nato: SCALE_PRESETS.nato } });
  assert.equal(labelKey(outcome.proposed), 'nato/Cosmic Top Secret');
  assert.equal(outcome.stop, 'classified');
});

test('D-06: raise only, retaining the existing label on a rerun with lower answers', () => {
  const internal = proposeLabel({ data: ['internal'] }, caInput);
  const protectedB = proposeLabel({ data: ['protected-b'] }, caInput);
  assert.equal(raiseOnly(internal.proposed, protectedB, caInput.scales).outcome, 'raise');
  const kept = raiseOnly(protectedB.proposed, internal, caInput.scales);
  assert.equal(kept.outcome, 'keep-higher');
  assert.equal(kept.proposed, protectedB.proposed);
  assert.equal(raiseOnly(internal.proposed, internal, caInput.scales).outcome, 'same');
});

test('a same-scale raise preserves compartments, releasability and handling', () => {
  const internal = proposeLabel({ data: ['internal'] }, caInput);
  const existing: Label = {
    ...internal.proposed, level: 'Public', compartments: ['CGP'], releasability: ['CA'], handling: ['local-only'],
  };
  const raised = raiseOnly(existing, internal, caInput.scales);
  assert.equal(raised.outcome, 'raise');
  assert.deepEqual(raised.proposed, { ...existing, level: 'Internal' });
});
