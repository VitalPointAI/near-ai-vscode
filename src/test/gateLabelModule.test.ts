// The one label module (D-35, FND-06): labels.ts and dominance.ts parse, rank, join and meet labels for the gate, the staff tools and the chat label, on
// whatever scales the active policy holds. Fictional data only; every key is made in the test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { atLeast, belowOnScale, dominates, markAtLeast, meetClearance, raiseMark, sameMark } from '../domain/gate/dominance';
import type { DominanceContext, Mark } from '../domain/gate/dominance';
import { SCALE_PRESETS, levelIndex, parseLabelKey } from '../domain/gate/labels';
import type { Clearance, Label, ScaleMapping, ScaleTable } from '../domain/gate/labels';
import { STAFF_TEMPLATE_LABELS } from '../domain/staff/doctrine';
import { LICENCE_CLASS_RULES } from '../domain/staff/obs/feeds';
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

// ---- Task 2: belowOnScale, markAtLeast and meetClearance ----

/** Today's (pre D-35) staff check, kept here as the oracle: split at the first slash, same scale, ranked on `scales`. */
function oldLabelKeyAtLeast(label: string, floor: string, scales: ScaleTable): boolean {
  const split = (text: string): { scale: string; level: string } | undefined => {
    const at = text.indexOf('/');
    return at <= 0 ? undefined : { scale: text.slice(0, at), level: text.slice(at + 1) };
  };
  const a = split(label);
  const b = split(floor);
  if (a === undefined || b === undefined || a.scale !== b.scale) return false;
  const rank = levelIndex(scales, a.scale, a.level);
  const floorRank = levelIndex(scales, b.scale, b.level);
  return floorRank >= 0 && rank >= floorRank;
}

/** Today's importer, store and channel expression: the scale parts (text before the first slash, or the whole text) are equal and the label is not at least the floor. */
function oldBelow(label: string, floor: string, scales: ScaleTable): boolean {
  return label.split('/')[0] === floor.split('/')[0] && !oldLabelKeyAtLeast(label, floor, scales);
}

const PRESET_KEYS = Object.entries(SCALE_PRESETS).flatMap(([scale, { levels }]) => levels.map((level) => `${scale}/${level}`));
const ODD_TEXTS = ['org', '/x', 'org/Partner', 'org/Internal/x', 'other/Internal'];
const EXTENDED: ScaleTable = { ...SCALE_PRESETS, org: { name: 'Organization', levels: ['Public', 'Internal', 'Partner', 'Confidential', 'Restricted'] } };

test('D-35: belowOnScale gives today\'s answer for every pair of preset and odd label texts, on the presets and on an extended scale', () => {
  const texts = [...PRESET_KEYS, ...ODD_TEXTS];
  for (const scales of [SCALE_PRESETS, EXTENDED]) {
    for (const label of texts) {
      for (const floor of texts) assert.equal(belowOnScale(label, floor, scales), oldBelow(label, floor, scales), `${label} under ${floor}`);
    }
  }
  assert.equal(belowOnScale('org/Partner', 'org/Public', SCALE_PRESETS), true, 'an unknown level on the floor\'s scale counts as below');
  assert.equal(belowOnScale('org/Partner', 'org/Public', EXTENDED), false);
  assert.equal(belowOnScale('nato/NATO Secret', 'org/Restricted', SCALE_PRESETS), false, 'another scale is never below');
});

test('D-35: the feed label check gives today\'s answer for every template label under every licence floor', () => {
  for (const rule of Object.values(LICENCE_CLASS_RULES)) {
    for (const label of STAFF_TEMPLATE_LABELS) {
      const old = !oldLabelKeyAtLeast(label, rule.floorLabel, SCALE_PRESETS) && label.startsWith('org/');
      assert.equal(belowOnScale(label, rule.floorLabel, SCALE_PRESETS), old, `${label} under ${rule.floorLabel}`);
    }
  }
});

/** A small seeded generator, so the random marks are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)] as T;
}

function subset(random: () => number, tokens: readonly string[]): string[] {
  return tokens.filter(() => random() < 0.4).sort();
}

function randomLabel(random: () => number): Label {
  const [scale, level] = pick(random, PRESET_KEYS).split('/') as [string, string];
  return { scale, level, compartments: subset(random, ['ALPHA', 'BRAVO']), releasability: subset(random, ['CAN', 'GBR', 'USA']), handling: [] };
}

function randomMark(random: () => number): Mark {
  let mark: Mark = [];
  const count = 1 + Math.floor(random() * 3);
  for (let index = 0; index < count; index += 1) mark = raiseMark(mark, randomLabel(random), SCALE_PRESETS);
  return mark;
}

/** Today's chat label `covers`, kept here as the oracle: raising `mark` by every label of `held` changes nothing. */
function oldCovers(mark: Mark, held: Mark, scales: ScaleTable): boolean {
  let raised: Mark = mark;
  for (const label of held) raised = raiseMark(raised, label, scales);
  return sameMark(raised, mark);
}

test('D-35: markAtLeast equals the chat label\'s old covers for 200 seeded random marks', () => {
  const random = seeded(4104);
  let agreedTrue = 0;
  for (let round = 0; round < 200; round += 1) {
    const mark = randomMark(random);
    const floor = random() < 0.3 ? mark.slice(0, 1) : randomMark(random);
    const expected = oldCovers(mark, floor, SCALE_PRESETS);
    assert.equal(markAtLeast(mark, floor, SCALE_PRESETS), expected, `round ${String(round)}`);
    if (expected) agreedTrue += 1;
  }
  assert.ok(agreedTrue > 10 && agreedTrue < 190, 'the sample holds both answers');
  assert.equal(markAtLeast([], [], SCALE_PRESETS), true);
});

const LATER = '2027-01-01T00:00:00.000Z';
const SOONER = '2026-12-01T00:00:00.000Z';
const NOW = Date.parse('2026-11-20T00:00:00.000Z');

function clearanceOf(key: string, compartments: string[] = [], releasability: string[] = [], expiresAt?: string): Clearance {
  const [scale, level] = key.split('/') as [string, string];
  return { scale, level, compartments, releasability, ...(expiresAt === undefined ? {} : { expiresAt }) };
}

test('D-35: meetClearance on one scale is the lower level, the shared compartments and releasability and the earlier expiry', () => {
  const met = meetClearance(clearanceOf('org/Restricted', ['ALPHA', 'BRAVO'], ['CAN', 'GBR'], LATER), clearanceOf('org/Internal', ['BRAVO'], ['GBR', 'USA'], SOONER), SCALE_PRESETS, []);
  assert.deepEqual(met, { scale: 'org', level: 'Internal', compartments: ['BRAVO'], releasability: ['GBR'], expiresAt: SOONER });
  assert.ok(met !== undefined && Object.isFrozen(met) && Object.isFrozen(met.compartments) && Object.isFrozen(met.releasability));
  assert.deepEqual(meetClearance(clearanceOf('org/Public'), clearanceOf('org/Confidential', [], [], LATER), SCALE_PRESETS, []), { scale: 'org', level: 'Public', compartments: [], releasability: [], expiresAt: LATER }, 'absent expiry is never');
  assert.equal(meetClearance(clearanceOf('org/Public'), clearanceOf('org/Confidential'), SCALE_PRESETS, [])?.expiresAt, undefined);
  assert.equal(meetClearance(clearanceOf('org/Partner'), clearanceOf('org/Public'), SCALE_PRESETS, []), undefined, 'an unknown level gives no clearance');
  assert.equal(meetClearance(clearanceOf('org/Public'), clearanceOf('org/Public', [], [], 'not a time'), SCALE_PRESETS, []), undefined, 'an unreadable expiry gives no clearance');
});

const ORG_TO_PROTECTED: ScaleMapping = { from: { scale: 'org', level: 'Confidential' }, covers: { scale: 'ca-protected', level: 'Protected B' } };
const PROTECTED_TO_NATO: ScaleMapping = { from: { scale: 'ca-protected', level: 'Protected B' }, covers: { scale: 'nato', level: 'NATO Confidential' } };

test('D-35: meetClearance across scales is the side the other covers through a mapping, never a level that would reach further than either', () => {
  assert.deepEqual(meetClearance(clearanceOf('org/Restricted', ['ALPHA']), clearanceOf('ca-protected/Protected A', ['ALPHA', 'BRAVO']), SCALE_PRESETS, [ORG_TO_PROTECTED]),
    { scale: 'ca-protected', level: 'Protected A', compartments: ['ALPHA'], releasability: [] });
  assert.deepEqual(meetClearance(clearanceOf('ca-protected/Protected A'), clearanceOf('org/Restricted'), SCALE_PRESETS, [ORG_TO_PROTECTED])?.level, 'Protected A', 'either order');
  assert.equal(meetClearance(clearanceOf('org/Internal'), clearanceOf('ca-protected/Protected A'), SCALE_PRESETS, [ORG_TO_PROTECTED]), undefined, 'below the mapping: neither covers the other');
  assert.equal(meetClearance(clearanceOf('org/Restricted'), clearanceOf('nato/NATO Unclassified'), SCALE_PRESETS, [ORG_TO_PROTECTED]), undefined, 'no mapping: no clearance');
  // org/Restricted covers Protected B, but Protected B also reaches NATO through a mapping org/Restricted has not: the meet stays below that mapping.
  assert.deepEqual(meetClearance(clearanceOf('org/Restricted'), clearanceOf('ca-protected/Protected B'), SCALE_PRESETS, [ORG_TO_PROTECTED, PROTECTED_TO_NATO])?.level, 'Protected A');
});

test('D-35: meetClearance never dominates a label either input does not, and meeting a clearance with itself changes nothing it dominates', () => {
  const context: DominanceContext = { scales: SCALE_PRESETS, mappings: [ORG_TO_PROTECTED, PROTECTED_TO_NATO], now: NOW };
  const labels: Label[] = PRESET_KEYS.flatMap((key) => {
    const [scale, level] = key.split('/') as [string, string];
    return [[], ['ALPHA']].flatMap((compartments) => [[], ['CAN']].map((releasability) => ({ scale, level, compartments, releasability, handling: [] })));
  });
  const clearances: Clearance[] = PRESET_KEYS.flatMap((key) => [[], ['ALPHA']].flatMap((compartments) => [[], ['CAN']].flatMap((releasability) =>
    [undefined, LATER, '2026-01-01T00:00:00.000Z'].map((expiresAt) => clearanceOf(key, compartments, releasability, expiresAt)))));
  let met = 0;
  for (const a of clearances) {
    const self = meetClearance(a, a, SCALE_PRESETS, context.mappings);
    assert.ok(self !== undefined);
    for (const label of labels) assert.equal(dominates(self, label, context), dominates(a, label, context), 'a met with itself');
    for (const b of clearances) {
      const meet = meetClearance(a, b, SCALE_PRESETS, context.mappings);
      if (meet === undefined) continue;
      met += 1;
      for (const label of labels) {
        if (dominates(meet, label, context)) assert.ok(dominates(a, label, context) && dominates(b, label, context), `${JSON.stringify(meet)} reaches ${JSON.stringify(label)}`);
      }
    }
  }
  assert.ok(met > clearances.length, 'cross-scale and same-scale meets were checked');
});
