// Raise thresholds, bands and recall tightening (Phase 70.1 plan 02 Task 1; D-07, D-08, D-12). Probabilities are whole basis points (owner, 2026-11-25).
// The cost ratios are research 3.2's examples, used here only as test values.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BAND_IDS, MAX_HALVINGS, bands, effectiveThreshold, isBasisPoints, monotoneCumulative, raiseThreshold, signedThreshold } from '../domain/classify/thresholds';
import type { AuditResult, EffectiveThreshold } from '../domain/classify/thresholds';

const LEVELS = ['Confidential', 'Secret', 'Top Secret'];
const THRESHOLDS: Record<string, EffectiveThreshold> = {
  Confidential: effectiveThreshold(9),
  Secret: effectiveThreshold(19),
  'Top Secret': effectiveThreshold(49)
};

test('raiseThreshold is 1 / (1 + r): the research examples give 0.20, 0.10, 0.05 and 0.02', () => {
  for (const [ratio, tau] of [[4, 0.2], [9, 0.1], [19, 0.05], [49, 0.02]] as const) assert.ok(Math.abs(raiseThreshold(ratio) - tau) < 1e-12, String(ratio));
});

test('a non-positive or non-finite cost ratio throws a plain refusal', () => {
  for (const ratio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => raiseThreshold(ratio), /cost ratio must be a positive number/, String(ratio));
  assert.throws(() => effectiveThreshold(0), RangeError);
});

test('bands raise to the highest level at or above its threshold, and suggest a higher one at a quarter of its threshold', () => {
  assert.deepEqual([...BAND_IDS], ['raise', 'suggest', 'none']);
  assert.deepEqual(bands(LEVELS, { Confidential: 3000, Secret: 600, 'Top Secret': 100 }, THRESHOLDS), { band: 'raise', raiseTo: 'Secret', suggest: 'Top Secret' });
  assert.deepEqual(bands(LEVELS, { Confidential: 3000, Secret: 300 }, THRESHOLDS), { band: 'raise', raiseTo: 'Confidential', suggest: 'Secret' });
});

test('bands suggest only between a quarter of tau and tau, and give nothing below', () => {
  // Confidential's tau is 0.10, so the suggest band starts at 0.025 (250 basis points).
  assert.deepEqual(bands(LEVELS, { Confidential: 300 }, THRESHOLDS), { band: 'suggest', suggest: 'Confidential' });
  assert.deepEqual(bands(LEVELS, { Confidential: 250 }, THRESHOLDS), { band: 'suggest', suggest: 'Confidential' }, 'exactly a quarter');
  assert.deepEqual(bands(LEVELS, { Confidential: 249 }, THRESHOLDS), { band: 'none' });
  assert.deepEqual(bands(LEVELS, { Confidential: 10 }, THRESHOLDS), { band: 'none' });
  assert.deepEqual(bands(LEVELS, { Confidential: 1000 }, THRESHOLDS), { band: 'raise', raiseTo: 'Confidential' }, 'exactly tau raises');
});

test('a non-monotone answer is read as the largest probability at or above each level, which can only raise', () => {
  assert.deepEqual([...monotoneCumulative(LEVELS, { Confidential: 400, Secret: 700 })], [700, 700, 0]);
  assert.equal(bands(LEVELS, { Confidential: 400, Secret: 700 }, THRESHOLDS).raiseTo, 'Secret');
  assert.deepEqual([...monotoneCumulative(LEVELS, {})], [0, 0, 0]);
});

test('a level with no threshold entry is never raised to or suggested by the bands', () => {
  const onlyConfidential = { Confidential: THRESHOLDS['Confidential'] };
  const result = bands(LEVELS, { 'Top Secret': 9000 }, onlyConfidential);
  assert.equal(result.raiseTo, 'Confidential', 'the cumulative probability still raises the level that has one');
  assert.equal(result.suggest, undefined);
  assert.deepEqual(bands(LEVELS, { 'Top Secret': 9000 }, {}), { band: 'none' });
});

test('effectiveThreshold halves tau for each failing window, down to an eighth', () => {
  assert.ok(Math.abs(effectiveThreshold(9, ['fail']).tau - 0.05) < 1e-12);
  assert.ok(Math.abs(effectiveThreshold(9, ['fail', 'fail', 'fail', 'fail']).tau - 0.0125) < 1e-12);
  assert.equal(effectiveThreshold(9, ['fail', 'fail', 'fail', 'fail', 'fail']).halvings, MAX_HALVINGS);
});

test('a passing window returns tau to the signed value', () => {
  assert.ok(Math.abs(effectiveThreshold(9, ['fail', 'pass']).tau - 0.1) < 1e-12);
  assert.equal(effectiveThreshold(9, ['fail', 'fail', 'pass', 'fail']).halvings, 1);
  assert.deepEqual(signedThreshold({ costRatio: 9, recallTarget: 9500, secondFamily: false }), effectiveThreshold(9));
});

test('effectiveThreshold is never above the signed value, for every history up to six windows', () => {
  const signed = raiseThreshold(9);
  const results: AuditResult[] = ['pass', 'fail'];
  for (let mask = 0; mask < 2 ** 6; mask += 1) {
    for (let length = 0; length <= 6; length += 1) {
      const history = Array.from({ length }, (_, index) => results[(mask >> index) & 1] as AuditResult);
      const tau = effectiveThreshold(9, history).tau;
      assert.ok(tau <= signed && tau >= signed / 8, history.join(','));
    }
  }
});

test('a tightened threshold raises where the signed one only suggested', () => {
  const tightened = { Confidential: effectiveThreshold(9, ['fail']) };
  assert.deepEqual(bands(LEVELS, { Confidential: 600 }, { Confidential: THRESHOLDS['Confidential'] }), { band: 'suggest', suggest: 'Confidential' });
  assert.deepEqual(bands(LEVELS, { Confidential: 600 }, tightened), { band: 'raise', raiseTo: 'Confidential' });
});

test('probabilities are whole basis points from 0 to 10000', () => {
  for (const value of [0, 1, 4000, 10000]) assert.equal(isBasisPoints(value), true, String(value));
  for (const value of [-1, 10001, 0.4, Number.NaN, '4000', null]) assert.equal(isBasisPoints(value), false, String(value));
});
