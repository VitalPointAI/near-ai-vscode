// Labels v1 (CLAS-01, CLAS-02, D-22, D-23, D-47). A label is a closed shape: an unknown scale, level, handling value or field is refused with a plain reason.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SCALE, LABEL_TOKEN_PATTERN, SCALE_PRESETS, labelKey, levelIndex, parseLabel } from '../domain/gate/labels';

function label(overrides: Record<string, unknown> = {}): unknown {
  return { scale: 'org', level: 'Internal', compartments: [], releasability: [], handling: [], ...overrides };
}

test('an org label parses and keeps its level as a name, not a number', () => {
  const parsed = parseLabel(label(), SCALE_PRESETS);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.level, 'Internal');
  assert.equal(labelKey(parsed.value), 'org/Internal');
  assert.equal(DEFAULT_SCALE, 'org');
  assert.equal(levelIndex(SCALE_PRESETS, 'org', 'Confidential'), 2);
  assert.equal(levelIndex(SCALE_PRESETS, 'org', 'Secret'), -1);
  assert.equal(levelIndex(SCALE_PRESETS, '__proto__', 'Public'), -1);
});

test('an unknown level, an unknown field and a malformed token are refused', () => {
  const unknownLevel = parseLabel(label({ level: 'Secret' }), SCALE_PRESETS);
  assert.ok(!unknownLevel.ok);
  assert.equal(unknownLevel.reason, 'not-allowed-here');
  const unknownField = parseLabel(label({ colour: 'red' }), SCALE_PRESETS);
  assert.ok(!unknownField.ok);
  assert.equal(unknownField.reason, 'unknown-field');
  const badToken = parseLabel(label({ compartments: ['lower'] }), SCALE_PRESETS);
  assert.ok(!badToken.ok);
  assert.equal(badToken.reason, 'wrong-type');
  assert.equal(LABEL_TOKEN_PATTERN.test('ABC_1-2'), true);
});
