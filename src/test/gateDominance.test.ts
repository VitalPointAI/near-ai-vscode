// Clearance dominance and the mark join (CLAS-03, CLAS-04, D-28, D-29). The first half pins the named cases; the second half is a seeded property test
// (a xorshift generator written in this file, no dependency) that shows dominance implies each of its five conditions, that removing any clearance
// attribute never turns a denial into an allowance, that order never matters, and that join is commutative, associative and idempotent.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RELEASABILITY_NONE, SCALE_PRESETS } from '../domain/gate/labels';
import type { Clearance, Label, ScaleMapping } from '../domain/gate/labels';
import { DOMINANCE_REASONS, dominates, joinLabels, markDominated, markLabelKeys, raiseMark, whyNotDominated } from '../domain/gate/dominance';
import type { DominanceContext } from '../domain/gate/dominance';

const NOW = Date.parse('2026-06-01T00:00:00Z');
const context: DominanceContext = { scales: SCALE_PRESETS, mappings: [], now: NOW };

function label(level: string, extra: Partial<Label> = {}): Label {
  return { scale: 'org', level, compartments: [], releasability: [], handling: [], ...extra };
}

function clearance(level: string, extra: Partial<Clearance> = {}): Clearance {
  return { scale: 'org', level, compartments: [], releasability: [], ...extra };
}

const secretOverProtectedB: ScaleMapping = { from: { scale: 'ca-classified', level: 'Secret' }, covers: { scale: 'ca-protected', level: 'Protected B' } };

test('a clearance at a higher level dominates, and one level lower does not', () => {
  assert.equal(dominates(clearance('Restricted'), label('Confidential'), context), true);
  assert.equal(dominates(clearance('Confidential'), label('Confidential'), context), true);
  assert.equal(dominates(clearance('Internal'), label('Confidential'), context), false);
});

test('raising a mark only ever goes up', () => {
  const start = [label('Public')];
  const raised = raiseMark(start, label('Confidential'), SCALE_PRESETS);
  assert.deepEqual(raised.map((entry) => entry.level), ['Confidential']);
  const again = raiseMark(raised, label('Internal'), SCALE_PRESETS);
  assert.deepEqual(again.map((entry) => entry.level), ['Confidential']);
  assert.deepEqual(start.map((entry) => entry.level), ['Public']);
  assert.notEqual(raised, start);
});

test('a clearance on one scale covers another scale only through a bundle mapping, at the edges of both levels', () => {
  const classifiedSecret = clearance('Secret', { scale: 'ca-classified' });
  const protectedB = label('Protected B', { scale: 'ca-protected' });
  assert.equal(dominates(classifiedSecret, protectedB, context), false);
  assert.equal(whyNotDominated(classifiedSecret, protectedB, context), 'scale');
  const mapped: DominanceContext = { ...context, mappings: [secretOverProtectedB] };
  assert.equal(dominates(classifiedSecret, protectedB, mapped), true);
  assert.equal(dominates(classifiedSecret, label('Protected A', { scale: 'ca-protected' }), mapped), true, 'below covers');
  assert.equal(dominates(classifiedSecret, label('Protected C', { scale: 'ca-protected' }), mapped), false, 'one level above covers');
  assert.equal(whyNotDominated(classifiedSecret, label('Protected C', { scale: 'ca-protected' }), mapped), 'level');
  assert.equal(dominates(clearance('Top Secret', { scale: 'ca-classified' }), protectedB, mapped), true, 'above from');
  assert.equal(dominates(clearance('Confidential', { scale: 'ca-classified' }), protectedB, mapped), false, 'one level below from');
  assert.equal(dominates(clearance('Restricted'), protectedB, mapped), false, 'a mapping from another scale does not help');
  assert.equal(dominates(clearance('Protected C', { scale: 'ca-protected' }), label('Confidential', { scale: 'ca-classified' }), mapped), false, 'a mapping is one way');
});

test('compartments, releasability and expiry each deny with their own reason', () => {
  assert.equal(whyNotDominated(clearance('Restricted'), label('Public', { compartments: ['X'] }), context), 'compartment');
  assert.equal(whyNotDominated(clearance('Restricted', { compartments: ['X', 'Y'] }), label('Public', { compartments: ['X'] }), context), undefined);
  assert.equal(whyNotDominated(clearance('Restricted'), label('Public', { releasability: ['CAN'] }), context), 'releasability');
  assert.equal(whyNotDominated(clearance('Restricted', { releasability: ['USA'] }), label('Public', { releasability: ['CAN'] }), context), 'releasability');
  assert.equal(whyNotDominated(clearance('Restricted', { releasability: ['CAN', 'USA'] }), label('Public', { releasability: ['CAN'] }), context), undefined);
  assert.equal(whyNotDominated(clearance('Restricted', { expiresAt: '2026-05-31T23:59:59Z' }), label('Public'), context), 'expired');
  assert.equal(whyNotDominated(clearance('Restricted', { expiresAt: '2026-06-01T00:00:00Z' }), label('Public'), context), 'expired', 'expiring exactly now is expired');
  assert.equal(whyNotDominated(clearance('Restricted', { expiresAt: '2026-06-01T00:00:01Z' }), label('Public'), context), undefined);
  assert.equal(whyNotDominated(clearance('Restricted', { expiresAt: 'not a time' }), label('Public'), context), 'expired', 'an unreadable expiry is no access');
  assert.equal(whyNotDominated(undefined, label('Public'), context), 'no-clearance');
  assert.deepEqual([...DOMINANCE_REASONS], ['no-clearance', 'scale', 'level', 'compartment', 'releasability', 'expired']);
});

test('empty cases: empty label compartments need nothing, no clearance dominates nothing, empty clearance releasability cannot read a restricted label', () => {
  assert.equal(dominates(clearance('Public'), label('Public', { compartments: [] }), context), true);
  assert.equal(dominates(undefined, label('Public'), context), false);
  assert.equal(markDominated([], [label('Public')], context), false);
  assert.equal(markDominated([], [], context), true, 'an empty mark holds nothing');
  assert.equal(dominates(clearance('Restricted', { releasability: [] }), label('Public', { releasability: ['CAN'] }), context), false);
  assert.equal(dominates(clearance('Restricted', { releasability: ['CAN'] }), label('Public', { releasability: [] }), context), true);
});

test('anything unknown is no access', () => {
  assert.equal(dominates(clearance('Secret'), label('Public'), context), false, 'unknown clearance level');
  assert.equal(dominates(clearance('Restricted'), label('Secret'), context), false, 'unknown label level');
  assert.equal(dominates(clearance('Restricted', { scale: 'galaxy' }), label('Public', { scale: 'galaxy' }), context), false, 'unknown scale on both');
  assert.equal(whyNotDominated(clearance('Restricted', { scale: '__proto__' }), label('Public', { scale: '__proto__' }), context), 'scale');
  const unknownMapping: ScaleMapping = { from: { scale: 'ca-classified', level: 'Nope' }, covers: { scale: 'ca-protected', level: 'Protected C' } };
  assert.equal(dominates(clearance('Top Secret', { scale: 'ca-classified' }), label('Protected A', { scale: 'ca-protected' }), { ...context, mappings: [unknownMapping] }), false);
  assert.equal(dominates(clearance('Restricted', { releasability: [RELEASABILITY_NONE] }), label('Public', { releasability: [RELEASABILITY_NONE] }), context), false, 'releasable to no one is never shared');
});

test('labels on different scales are different labels: a clearance on one never covers the other without a mapping', () => {
  assert.equal(dominates(clearance('Restricted'), label('Confidential', { scale: 'ca-classified' }), context), false);
  assert.equal(dominates(clearance('Top Secret', { scale: 'ca-classified' }), label('Confidential'), context), false);
});

test('joining two labels takes the higher level, the union of compartments and handling, and the intersection of non-empty releasability', () => {
  const left = label('Internal', { compartments: ['A'], releasability: ['CAN', 'USA'], handling: ['no-agent-tools'] });
  const right = label('Confidential', { compartments: ['B'], releasability: ['CAN'], handling: ['local-only'] });
  assert.deepEqual(joinLabels(left, right, SCALE_PRESETS), label('Confidential', { compartments: ['A', 'B'], releasability: ['CAN'], handling: ['local-only', 'no-agent-tools'] }));
  const open = label('Public', { releasability: [] });
  assert.deepEqual(joinLabels(left, open, SCALE_PRESETS)?.releasability, ['CAN', 'USA'], 'an empty side keeps the other side');
  assert.deepEqual(joinLabels(open, left, SCALE_PRESETS)?.releasability, ['CAN', 'USA']);
  assert.deepEqual(joinLabels(open, open, SCALE_PRESETS)?.releasability, []);
});

test('joining labels whose releasability shares nothing never makes the result unrestricted', () => {
  const canOnly = label('Internal', { releasability: ['CAN'] });
  const usaOnly = label('Internal', { releasability: ['USA'] });
  const joined = joinLabels(canOnly, usaOnly, SCALE_PRESETS);
  assert.deepEqual(joined?.releasability, [RELEASABILITY_NONE]);
  assert.equal(dominates(clearance('Restricted', { releasability: ['CAN', 'USA'] }), joined as Label, context), false);
  assert.deepEqual(joinLabels(joined as Label, label('Public', { releasability: ['CAN', 'USA'] }), SCALE_PRESETS)?.releasability, [RELEASABILITY_NONE]);
});

test('labels on different scales, or with a level the scales cannot order, are not joined', () => {
  assert.equal(joinLabels(label('Public'), label('Protected A', { scale: 'ca-protected' }), SCALE_PRESETS), undefined);
  assert.equal(joinLabels(label('Public'), label('Secret'), SCALE_PRESETS), undefined);
});

test('a mark keeps one label per scale, keeps unmapped scales side by side, and is dominated only by clearances that dominate every label', () => {
  const start = raiseMark([], label('Confidential'), SCALE_PRESETS);
  const mark = raiseMark(start, label('Protected B', { scale: 'ca-protected' }), SCALE_PRESETS);
  assert.deepEqual(markLabelKeys(mark), ['ca-protected/Protected B', 'org/Confidential']);
  assert.equal(markDominated([clearance('Restricted')], mark, context), false);
  assert.equal(markDominated([clearance('Protected C', { scale: 'ca-protected' })], mark, context), false);
  assert.equal(markDominated([clearance('Restricted'), clearance('Protected B', { scale: 'ca-protected' })], mark, context), true);
  assert.equal(markDominated([clearance('Protected B', { scale: 'ca-protected' }), clearance('Restricted')], mark, context), true, 'order does not matter');
  assert.equal(markDominated([clearance('Internal'), clearance('Protected B', { scale: 'ca-protected' })], mark, context), false);
  const lifted = raiseMark(mark, label('Restricted'), SCALE_PRESETS);
  assert.deepEqual(markLabelKeys(lifted), ['ca-protected/Protected B', 'org/Restricted']);
  assert.deepEqual(markLabelKeys(mark), ['ca-protected/Protected B', 'org/Confidential'], 'the old mark is untouched');
  const sameEither = raiseMark(raiseMark([], label('Public'), SCALE_PRESETS), label('Internal'), SCALE_PRESETS);
  assert.deepEqual(markLabelKeys(raiseMark(raiseMark([], label('Internal'), SCALE_PRESETS), label('Public'), SCALE_PRESETS)), markLabelKeys(sameEither));
});

test('a label whose level the scales cannot order is kept beside the mark and can only make access narrower', () => {
  const mark = raiseMark([label('Confidential')], label('Mystery'), SCALE_PRESETS);
  assert.equal(mark.length, 2);
  assert.equal(markDominated([clearance('Restricted')], mark, context), false);
});

test('a mapping lets one clearance dominate a whole mark across two scales', () => {
  const mark = raiseMark(raiseMark([], label('Protected B', { scale: 'ca-protected' }), SCALE_PRESETS), label('Public'), SCALE_PRESETS);
  const orgMapping: ScaleMapping = { from: { scale: 'ca-classified', level: 'Secret' }, covers: { scale: 'org', level: 'Confidential' } };
  const mapped: DominanceContext = { ...context, mappings: [secretOverProtectedB, orgMapping] };
  assert.equal(markDominated([clearance('Secret', { scale: 'ca-classified' })], mark, mapped), true);
  assert.equal(markDominated([clearance('Secret', { scale: 'ca-classified' })], mark, { ...context, mappings: [secretOverProtectedB] }), false);
});

// ---- the seeded property test -------------------------------------------------------------------------------------------------------------------

/** xorshift32: small, fixed-seed, no dependency. The same seed always gives the same cases. */
function xorshift32(seed: number) {
  let x = seed | 0 || 1;
  const next = (): number => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
  const int = (below: number): number => next() % below;
  const chance = (percent: number): boolean => int(100) < percent;
  const pick = <T,>(items: readonly T[]): T => items[int(items.length)] as T;
  const subset = (items: readonly string[], percent: number): string[] => items.filter(() => chance(percent)).sort();
  const shuffle = <T,>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let index = out.length - 1; index > 0; index -= 1) {
      const swap = int(index + 1);
      [out[index], out[swap]] = [out[swap] as T, out[index] as T];
    }
    return out;
  };
  return { next, int, chance, pick, subset, shuffle };
}

type Rng = ReturnType<typeof xorshift32>;
const SCALE_IDS = Object.keys(SCALE_PRESETS);
const COMPARTMENT_POOL = ['A', 'B', 'C', 'D'];
const RELEASABILITY_POOL = ['CAN', 'USA', 'GBR'];

function levelsOf(scale: string): readonly string[] {
  return (SCALE_PRESETS[scale] as { readonly levels: readonly string[] }).levels;
}

function rank(scale: string, level: string): number {
  return levelsOf(scale).indexOf(level);
}

function genLabel(rng: Rng, scale: string): Label {
  const releasability = rng.chance(50) ? [] : rng.chance(8) ? [RELEASABILITY_NONE] : rng.subset(RELEASABILITY_POOL, 55);
  return { scale, level: rng.pick(levelsOf(scale)), compartments: rng.subset(COMPARTMENT_POOL, 25), releasability, handling: rng.subset(['local-only', 'no-agent-tools'], 40) };
}

function genMapping(rng: Rng, clearanceScale: string, labelScale: string): ScaleMapping {
  const fromScale = rng.chance(70) ? clearanceScale : rng.pick(SCALE_IDS);
  let coversScale = rng.chance(70) ? labelScale : rng.pick(SCALE_IDS);
  if (coversScale === fromScale) coversScale = SCALE_IDS[(SCALE_IDS.indexOf(fromScale) + 1) % SCALE_IDS.length] as string;
  return { from: { scale: fromScale, level: rng.pick(levelsOf(fromScale)) }, covers: { scale: coversScale, level: rng.pick(levelsOf(coversScale)) } };
}

interface Case {
  readonly clearance: Clearance;
  readonly label: Label;
  readonly mappings: readonly ScaleMapping[];
  readonly now: number;
}

function genCase(rng: Rng): Case {
  const labelScale = rng.pick(SCALE_IDS);
  const clearanceScale = rng.chance(55) ? labelScale : rng.pick(SCALE_IDS);
  const base = {
    scale: clearanceScale,
    level: rng.pick(levelsOf(clearanceScale)),
    compartments: rng.subset(COMPARTMENT_POOL, 70),
    releasability: rng.subset(RELEASABILITY_POOL, 65)
  };
  const clearance: Clearance = rng.chance(40) ? { ...base, expiresAt: new Date(NOW + rng.int(2001) - 1000).toISOString() } : base;
  const mappings = Array.from({ length: rng.int(4) }, () => genMapping(rng, clearanceScale, labelScale));
  return { clearance, label: genLabel(rng, labelScale), mappings, now: NOW };
}

// The five conditions, written out independently of the evaluator so the test is not the code agreeing with itself (research 9.3).
function conditionScale(c: Case): boolean {
  if (c.clearance.scale === c.label.scale) return true;
  return c.mappings.some(
    (m) =>
      m.from.scale === c.clearance.scale &&
      m.covers.scale === c.label.scale &&
      rank(c.clearance.scale, c.clearance.level) >= rank(m.from.scale, m.from.level) &&
      rank(c.label.scale, c.label.level) <= rank(m.covers.scale, m.covers.level)
  );
}
function conditionLevel(c: Case): boolean {
  return c.clearance.scale !== c.label.scale || rank(c.clearance.scale, c.clearance.level) >= rank(c.label.scale, c.label.level);
}
function conditionCompartments(c: Case): boolean {
  const held = new Set(c.clearance.compartments);
  return c.label.compartments.every((token) => held.has(token));
}
function conditionReleasability(c: Case): boolean {
  if (c.label.releasability.length === 0) return true;
  const held = new Set(c.clearance.releasability);
  return c.label.releasability.some((token) => token !== RELEASABILITY_NONE && held.has(token));
}
function conditionExpiry(c: Case): boolean {
  return c.clearance.expiresAt === undefined || Date.parse(c.clearance.expiresAt) > c.now;
}

function ask(c: Case, clearance: Clearance = c.clearance, mappings: readonly ScaleMapping[] = c.mappings, now: number = c.now): boolean {
  return dominates(clearance, c.label, { scales: SCALE_PRESETS, mappings, now });
}

const DOMINANCE_CASES = 2500;
const JOIN_CASES = 2000;

test('property: dominates holds exactly when all five conditions hold (2,500 seeded cases)', (t) => {
  const rng = xorshift32(0x5eed1234);
  let allowed = 0;
  let denied = 0;
  for (let index = 0; index < DOMINANCE_CASES; index += 1) {
    const c = genCase(rng);
    const result = ask(c);
    if (result) {
      assert.ok(conditionScale(c), `case ${String(index)}: scale or mapping`);
      assert.ok(conditionLevel(c), `case ${String(index)}: level`);
      assert.ok(conditionCompartments(c), `case ${String(index)}: compartments`);
      assert.ok(conditionReleasability(c), `case ${String(index)}: releasability`);
      assert.ok(conditionExpiry(c), `case ${String(index)}: expiry`);
      allowed += 1;
    } else {
      denied += 1;
    }
    const all = conditionScale(c) && conditionLevel(c) && conditionCompartments(c) && conditionReleasability(c) && conditionExpiry(c);
    assert.equal(result, all, `case ${String(index)}: dominates must equal the five conditions`);
    assert.equal(whyNotDominated(c.clearance, c.label, { scales: SCALE_PRESETS, mappings: c.mappings, now: c.now }) === undefined, result);
  }
  assert.equal(allowed + denied, DOMINANCE_CASES);
  assert.ok(allowed >= 150, `the cases must include real allowances, saw ${String(allowed)}`);
  assert.ok(denied >= 1000, `the cases must include real denials, saw ${String(denied)}`);
  t.diagnostic(`${String(DOMINANCE_CASES)} generated cases: ${String(allowed)} allowed, ${String(denied)} denied`);
});

test('property: removing any clearance attribute never turns a denial into an allowance (2,500 seeded cases)', (t) => {
  const rng = xorshift32(0x0badc0de);
  let checked = 0;
  for (let index = 0; index < DOMINANCE_CASES; index += 1) {
    const c = genCase(rng);
    // Only a denial can be turned into an allowance by removal, so every weaker variant of a denied case must stay denied. A weaker variant of an
    // allowed case may be either, so the property is stated as: variant allowed implies original allowed.
    const original = ask(c);
    const weaker: boolean[] = [];
    c.clearance.compartments.forEach((token) => weaker.push(ask(c, { ...c.clearance, compartments: c.clearance.compartments.filter((other) => other !== token) })));
    c.clearance.releasability.forEach((token) => weaker.push(ask(c, { ...c.clearance, releasability: c.clearance.releasability.filter((other) => other !== token) })));
    const lower = rank(c.clearance.scale, c.clearance.level) - 1;
    if (lower >= 0) weaker.push(ask(c, { ...c.clearance, level: levelsOf(c.clearance.scale)[lower] as string }));
    c.mappings.forEach((_, drop) => weaker.push(ask(c, c.clearance, c.mappings.filter((__, at) => at !== drop))));
    weaker.push(ask(c, c.clearance, [] as readonly ScaleMapping[]));
    weaker.push(ask(c, c.clearance, c.mappings, c.now + 1 + rng.int(5000)));
    if (c.clearance.expiresAt !== undefined) {
      weaker.push(ask(c, { ...c.clearance, expiresAt: new Date(Date.parse(c.clearance.expiresAt) - 1 - rng.int(5000)).toISOString() }));
    }
    weaker.push(ask(c, { ...c.clearance, compartments: [], releasability: [] }));
    for (const variant of weaker) {
      if (variant) assert.equal(original, true, `case ${String(index)}: a weaker clearance was allowed where the original was denied`);
      checked += 1;
    }
  }
  assert.ok(checked >= DOMINANCE_CASES, `checked ${String(checked)} variants`);
  t.diagnostic(`${String(DOMINANCE_CASES)} generated cases, ${String(checked)} weaker variants`);
});

test('property: the order of compartments, releasability entries, mappings, clearances and mark labels never changes the answer (2,500 seeded cases)', () => {
  const rng = xorshift32(0xfeedbeef);
  for (let index = 0; index < DOMINANCE_CASES; index += 1) {
    const c = genCase(rng);
    const shuffled: Case = {
      ...c,
      clearance: { ...c.clearance, compartments: rng.shuffle(c.clearance.compartments), releasability: rng.shuffle(c.clearance.releasability) },
      label: { ...c.label, compartments: rng.shuffle(c.label.compartments), releasability: rng.shuffle(c.label.releasability), handling: rng.shuffle(c.label.handling) },
      mappings: rng.shuffle(c.mappings)
    };
    assert.equal(ask(shuffled), ask(c), `case ${String(index)}`);
    const other = genCase(rng);
    const mark: readonly Label[] = [c.label, other.label];
    const clearances: readonly Clearance[] = [c.clearance, other.clearance];
    const ctx: DominanceContext = { scales: SCALE_PRESETS, mappings: [...c.mappings, ...other.mappings], now: NOW };
    const reordered: DominanceContext = { ...ctx, mappings: rng.shuffle(ctx.mappings) };
    assert.equal(markDominated(clearances, mark, ctx), markDominated(rng.shuffle(clearances), rng.shuffle(mark), reordered), `case ${String(index)}: mark`);
  }
});

test('property: join is commutative, associative, idempotent, never lowers a level, and is an upper bound for dominance (2,000 seeded cases)', (t) => {
  const rng = xorshift32(0xc0ffee11);
  let bounded = 0;
  for (let index = 0; index < JOIN_CASES; index += 1) {
    const scale = rng.pick(SCALE_IDS);
    const a = genLabel(rng, scale);
    const b = genLabel(rng, scale);
    const c = genLabel(rng, scale);
    const ab = joinLabels(a, b, SCALE_PRESETS) as Label;
    const ba = joinLabels(b, a, SCALE_PRESETS) as Label;
    assert.ok(ab && ba, `case ${String(index)}: same-scale labels always join`);
    assert.deepEqual(ab, ba, `case ${String(index)}: commutative`);
    assert.deepEqual(joinLabels(a, a, SCALE_PRESETS), a, `case ${String(index)}: idempotent`);
    assert.deepEqual(joinLabels(ab, c, SCALE_PRESETS), joinLabels(a, joinLabels(b, c, SCALE_PRESETS) as Label, SCALE_PRESETS), `case ${String(index)}: associative`);
    assert.ok(rank(scale, ab.level) >= rank(scale, a.level) && rank(scale, ab.level) >= rank(scale, b.level), `case ${String(index)}: never lowers`);
    assert.ok(a.compartments.every((token) => ab.compartments.includes(token)) && b.compartments.every((token) => ab.compartments.includes(token)));
    assert.ok(a.handling.every((flag) => ab.handling.includes(flag)) && b.handling.every((flag) => ab.handling.includes(flag)));
    const probe = genCase(rng);
    const holder: Clearance = { ...probe.clearance, scale, level: rng.pick(levelsOf(scale)) };
    const ctx: DominanceContext = { scales: SCALE_PRESETS, mappings: [], now: NOW };
    if (dominates(holder, ab, ctx)) {
      assert.ok(dominates(holder, a, ctx) && dominates(holder, b, ctx), `case ${String(index)}: dominating the join dominates both sides`);
      bounded += 1;
    }
  }
  assert.ok(bounded >= 50, `the join cases must include real allowances, saw ${String(bounded)}`);
  t.diagnostic(`${String(JOIN_CASES)} generated join cases, ${String(bounded)} with a dominating clearance`);
});
