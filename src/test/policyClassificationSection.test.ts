// The classification@1 section of a signed policy (Phase 70.1 plan 01 Task 2; D-07, D-10, D-11, D-13, D-16): thresholds, shadow, roles, review, the
// system-high and markings, each refused with one plain reason. Fictional Example Organization values; the threshold numbers are research 3.2's examples.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CLASSIFICATION_SECTION_KEYS, REVIEW_DEFAULTS, parseClassificationSection } from '../domain/gate/classificationSection';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';

type Loose = Record<string, any>;

const REPO = path.resolve(__dirname, '..', '..');

function label(scale: string, level: string): Label {
  return { scale, level, compartments: [], releasability: [], handling: [] };
}

function section(): Loose {
  return {
    v: 1,
    systemHigh: [label('ca-classified', 'Secret'), label('ca-protected', 'Protected C')],
    thresholds: {
      'ca-classified/Secret': { costRatio: 19, recallTarget: 9800, secondFamily: true },
      'ca-protected/Protected B': { costRatio: 9, recallTarget: 9500, secondFamily: false }
    },
    shadow: { defaultMode: 'shadow', levels: ['ca-protected/Protected B'] },
    roles: [{ passport: 'openai/gpt-oss', role: 'primary', levels: ['ca-classified/Secret', 'ca-protected/Protected B'], evaluation: 'e'.repeat(64), since: '2026-11-24T00:00:00.000Z' }],
    review: { jumpLevels: 1, topLevel: true, lowerRequestAgeDays: 7 },
    markings: [{ id: 'banner-secret', pattern: 'SECRET', label: label('ca-classified', 'Secret') }]
  };
}

function edited(edit: (value: Loose) => void): Loose {
  const value = section();
  edit(value);
  return value;
}

function reasonOf(value: unknown): string {
  const parsed = parseClassificationSection(value, SCALE_PRESETS);
  return parsed.ok ? 'ok' : `${parsed.reason} ${parsed.path}`;
}

test('a full section parses, frozen, and is its own wire form; the key list is D-16\'s', () => {
  assert.deepEqual([...CLASSIFICATION_SECTION_KEYS], ['systemHigh', 'thresholds', 'shadow', 'roles', 'review', 'markings', 'codeWords', 'factTypes', 'guideRules', 'compilationRules']);
  const parsed = parseClassificationSection(section(), SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  if (!parsed.ok) return;
  assert.ok(Object.isFrozen(parsed.value) && Object.isFrozen(parsed.value.thresholds) && Object.isFrozen(parsed.value.roles[0]));
  assert.deepEqual(parsed.value, section());
  assert.deepEqual(parseClassificationSection(JSON.parse(JSON.stringify(parsed.value)), SCALE_PRESETS), parsed);
});

test('the smallest section is { v: 1 }: defaults are filled, and there is no system-high and no threshold', () => {
  const parsed = parseClassificationSection({ v: 1 }, SCALE_PRESETS);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, { v: 1, thresholds: {}, shadow: { defaultMode: 'shadow', levels: [] }, roles: [], review: REVIEW_DEFAULTS, markings: [] });
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.value, 'systemHigh'), false, 'absent stays absent: no possible-spill outcome');
  assert.deepEqual(REVIEW_DEFAULTS, { jumpLevels: 1, topLevel: true, lowerRequestAgeDays: 7 });
  const partial = parseClassificationSection({ v: 1, review: { jumpLevels: 2 } }, SCALE_PRESETS);
  assert.ok(partial.ok);
  if (partial.ok) assert.deepEqual(partial.value.review, { jumpLevels: 2, topLevel: true, lowerRequestAgeDays: 7 });
});

test('the research 3.2 example values (4, 9, 19, 49 with recall 0.90 to 0.99, as basis points) parse', () => {
  const thresholds = {
    'ca-protected/Protected A': { costRatio: 4, recallTarget: 9000, secondFamily: false },
    'ca-protected/Protected B': { costRatio: 9, recallTarget: 9500, secondFamily: false },
    'ca-classified/Confidential': { costRatio: 9, recallTarget: 9500, secondFamily: false },
    'ca-protected/Protected C': { costRatio: 19, recallTarget: 9800, secondFamily: true },
    'ca-classified/Secret': { costRatio: 19, recallTarget: 9800, secondFamily: true },
    'ca-classified/Top Secret': { costRatio: 49, recallTarget: 9900, secondFamily: true }
  };
  assert.equal(reasonOf({ v: 1, thresholds }), 'ok');
});

test('D-07: nothing in src/domain ships a threshold as a value', () => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && /costRatio:\s*\d|recallTarget:\s*\d/.test(readFileSync(full, 'utf8'))) found.push(path.relative(REPO, full));
    }
  };
  walk(path.join(REPO, 'src', 'domain'));
  assert.deepEqual(found, []);
});

test('a threshold key that is not scale/level on the policy\'s scales is refused', () => {
  for (const key of ['ca-classified/Ultra', 'unknown/Secret', 'Secret', '__proto__/Secret']) {
    const value = edited((s) => { s.thresholds = { [key]: { costRatio: 19, recallTarget: 9800, secondFamily: true } }; });
    assert.match(reasonOf(value), /^not-allowed-here classification\.thresholds\./, key);
  }
});

test('costRatio must be a whole number from 1, recallTarget whole basis points from 1 to 10000, secondFamily a boolean', () => {
  for (const costRatio of [0, -1, 1.5, '19', null]) {
    assert.match(reasonOf(edited((s) => { s.thresholds['ca-classified/Secret'].costRatio = costRatio; })), /^wrong-type .*costRatio$/, String(costRatio));
  }
  for (const recallTarget of [0, 10001, 0.98, -5]) {
    assert.match(reasonOf(edited((s) => { s.thresholds['ca-classified/Secret'].recallTarget = recallTarget; })), /^wrong-type .*recallTarget$/, String(recallTarget));
  }
  assert.equal(reasonOf(edited((s) => { s.thresholds['ca-classified/Secret'].recallTarget = 10000; })), 'ok', 'a recall of 1');
  assert.match(reasonOf(edited((s) => { s.thresholds['ca-classified/Secret'].secondFamily = 'yes'; })), /^wrong-type .*secondFamily$/);
  assert.match(reasonOf(edited((s) => { s.thresholds['ca-classified/Secret'].tau = 5; })), /^unknown-field .*tau$/);
});

test('shadow: defaultMode is shadow or enforce, and every level named is in thresholds, sorted', () => {
  assert.equal(reasonOf(edited((s) => { s.shadow.defaultMode = 'trial'; })), 'not-allowed-here classification.shadow.defaultMode');
  assert.equal(reasonOf(edited((s) => { s.shadow.defaultMode = 'enforce'; })), 'ok');
  assert.match(reasonOf(edited((s) => { s.shadow.levels = ['ca-classified/Top Secret']; })), /^not-allowed-here classification\.shadow\.levels\[0\]$/);
  assert.match(reasonOf(edited((s) => { s.shadow.levels = ['ca-protected/Protected B', 'ca-classified/Secret']; })), /^not-sorted /);
  assert.match(reasonOf(edited((s) => { s.shadow.levels = ['ca-classified/Secret', 'ca-classified/Secret']; })), /^duplicate /);
});

test('review: jumpLevels from 1, topLevel a boolean, lowerRequestAgeDays from 1 to 90', () => {
  assert.equal(reasonOf(edited((s) => { s.review.jumpLevels = 0; })), 'wrong-type classification.review.jumpLevels');
  assert.equal(reasonOf(edited((s) => { s.review.topLevel = 1; })), 'wrong-type classification.review.topLevel');
  for (const age of [0, 91]) assert.equal(reasonOf(edited((s) => { s.review.lowerRequestAgeDays = age; })), 'wrong-type classification.review.lowerRequestAgeDays', String(age));
  for (const age of [1, 90]) assert.equal(reasonOf(edited((s) => { s.review.lowerRequestAgeDays = age; })), 'ok', String(age));
});

test('systemHigh: labels on the policy\'s scales, at most one per scale, not empty', () => {
  assert.equal(reasonOf(edited((s) => { s.systemHigh = [label('ca-classified', 'Ultra')]; })), 'not-allowed-here classification.systemHigh[0].level');
  assert.equal(reasonOf(edited((s) => { s.systemHigh = [label('ca-classified', 'Secret'), label('ca-classified', 'Top Secret')]; })), 'duplicate classification.systemHigh[1]');
  assert.equal(reasonOf(edited((s) => { s.systemHigh = []; })), 'empty-list classification.systemHigh');
});

test('markings: a known label, a pattern of plain words (never a regular expression), and one entry per id', () => {
  assert.equal(reasonOf(edited((s) => { s.markings[0].label = label('ca-classified', 'Ultra'); })), 'not-allowed-here classification.markings[0].label.level');
  assert.equal(reasonOf(edited((s) => { s.markings[0].pattern = ''; })), 'wrong-type classification.markings[0].pattern');
  for (const pattern of ['SECRET.*', '(SECRET)+', 'SECRET\\b', 'TOP  SECRET', ' SECRET', 'SECRET ', 'S'.repeat(65)]) {
    assert.equal(reasonOf(edited((s) => { s.markings[0].pattern = pattern; })), 'not-allowed-here classification.markings[0].pattern', pattern);
  }
  for (const pattern of ['PROTÉGÉ B', 'TOP SECRET', 'CAN EYES ONLY', 'TS/SCI', 'NATO-SECRET']) assert.equal(reasonOf(edited((s) => { s.markings[0].pattern = pattern; })), 'ok', pattern);
  const twice = edited((s) => { s.markings = [s.markings[0], { ...s.markings[0], pattern: 'TRÈS SECRET' }]; });
  assert.equal(reasonOf(twice), 'duplicate classification.markings[1]');
});

test('roles: a known role, at least one level that has a threshold, an evaluation hash and a start time', () => {
  assert.equal(reasonOf(edited((s) => { s.roles[0].role = 'judge'; })), 'not-allowed-here classification.roles[0].role');
  for (const role of ['primary', 'second-family', 'hidden-instruction']) assert.equal(reasonOf(edited((s) => { s.roles[0].role = role; })), 'ok', role);
  assert.equal(reasonOf(edited((s) => { s.roles[0].levels = []; })), 'empty-list classification.roles[0].levels');
  assert.match(reasonOf(edited((s) => { s.roles[0].levels = ['ca-classified/Top Secret']; })), /^not-allowed-here classification\.roles\[0\]\.levels\[0\]$/);
  for (const evaluation of ['E'.repeat(64), 'e'.repeat(63), 'g'.repeat(64)]) {
    assert.equal(reasonOf(edited((s) => { s.roles[0].evaluation = evaluation; })), 'wrong-type classification.roles[0].evaluation');
  }
  for (const since of ['2026-11-24', '2026-02-30T00:00:00.000Z', 'yesterday']) {
    assert.equal(reasonOf(edited((s) => { s.roles[0].since = since; })), 'wrong-type classification.roles[0].since', since);
  }
  assert.equal(reasonOf(edited((s) => { s.roles = [s.roles[0], { ...s.roles[0] }]; })), 'duplicate classification.roles[1]');
});

test('an unknown key and a newer section version are refused; the keys 70.1-03 parses are not available yet', () => {
  assert.equal(reasonOf(edited((s) => { s.autoLower = true; })), 'unknown-field classification.autoLower');
  assert.equal(reasonOf(edited((s) => { s.v = 2; s.newKey = 1; })), 'unknown-version classification.v');
  for (const key of ['codeWords', 'factTypes', 'guideRules', 'compilationRules']) {
    assert.equal(reasonOf(edited((s) => { s[key] = []; })), `not-available-yet classification.${key}`, key);
  }
});
