// The one label module (D-35, FND-06): labels.ts and dominance.ts parse, rank, join and meet labels for the gate, the staff tools and the chat label, on
// whatever scales the active policy holds. Fictional data only; every key is made in the test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { atLeast } from '../domain/gate/dominance';
import { SCALE_PRESETS, levelIndex, parseLabelKey } from '../domain/gate/labels';
import { guardScan } from '../domain/staff/guardScan';
import type { ProductHeader } from '../domain/staff/products';

const HEADER: ProductHeader = { product: 'p', kind: 'plan', section: 'j5', owner: 'lead-planner', profile: 'us-joint', level: 'operational', version: 1, state: 'draft', label: 'org/Internal', dependsOn: [] };

function headerRules(label: string): { rules: string[]; hold: boolean } {
  const result = guardScan({ body: 'x', section: 'j5', owner: 'lead-planner', config: { realEntities: [] }, header: { ...HEADER, label } });
  return { rules: result.findings.map((finding) => finding.rule), hold: result.hold };
}

test('D-35: a staff product header labelled org/Internal/x is held by the guard scan (the level is everything after the first slash)', () => {
  const held = headerRules('org/Internal/x');
  assert.ok(held.rules.includes('label-ceiling'), 'an unreadable header label is held');
  assert.equal(held.hold, true);
});

test('D-35: parseLabelKey reads a scale/level text as a frozen label on the given scales, and refuses anything else', () => {
  const read = parseLabelKey('org/Internal', SCALE_PRESETS);
  assert.deepEqual(read, { scale: 'org', level: 'Internal', compartments: [], releasability: [], handling: [] });
  assert.ok(read !== undefined && Object.isFrozen(read) && Object.isFrozen(read.compartments) && Object.isFrozen(read.releasability) && Object.isFrozen(read.handling));
  assert.deepEqual(parseLabelKey('nato/NATO Unclassified', SCALE_PRESETS), { scale: 'nato', level: 'NATO Unclassified', compartments: [], releasability: [], handling: [] });
  for (const text of ['org', '/Internal', 'org/', 'org/Partner', 'nope/Internal', '__proto__/x', 'constructor/Internal', 'org/Internal/x', 'org/internal', '']) {
    assert.equal(parseLabelKey(text, SCALE_PRESETS), undefined, text);
  }
});

test('D-35: atLeast ranks two levels on one scale exactly as levelIndex does, and is false across scales or with an unknown level', () => {
  let pairs = 0;
  for (const [scale, { levels }] of Object.entries(SCALE_PRESETS)) {
    for (const a of levels) {
      for (const b of levels) {
        pairs += 1;
        const expected = levelIndex(SCALE_PRESETS, scale, a) >= levelIndex(SCALE_PRESETS, scale, b);
        assert.equal(atLeast({ scale, level: a }, { scale, level: b }, SCALE_PRESETS), expected, `${scale}/${a} vs ${b}`);
      }
    }
  }
  assert.equal(pairs, 16 + 9 + 9 + 25);
  assert.equal(atLeast({ scale: 'ca-classified', level: 'Confidential' }, { scale: 'org', level: 'Confidential' }, SCALE_PRESETS), false, 'never across scales');
  assert.equal(atLeast({ scale: 'org', level: 'Partner' }, { scale: 'org', level: 'Public' }, SCALE_PRESETS), false, 'an unknown level is never at least anything');
  assert.equal(atLeast({ scale: 'org', level: 'Restricted' }, { scale: 'org', level: 'Partner' }, SCALE_PRESETS), false, 'nothing is at least an unknown floor');
  assert.equal(atLeast({ scale: '__proto__', level: 'x' }, { scale: '__proto__', level: 'x' }, SCALE_PRESETS), false);
});

test('D-35: the guard scan header check allows the template ceilings and below, and holds anything above or unreadable', () => {
  for (const label of ['org/Internal', 'org/Public', 'nato/NATO Unclassified', 'ca-protected/Protected A']) assert.deepEqual(headerRules(label), { rules: [], hold: false }, label);
  for (const label of ['org/Confidential', 'org/Restricted', 'ca-protected/Protected B', 'ca-classified/Confidential', 'other/Internal', 'org', 'org/', '/Internal', 'org/Public/x']) {
    const held = headerRules(label);
    assert.ok(held.rules.includes('label-ceiling') && held.hold, label);
  }
});
