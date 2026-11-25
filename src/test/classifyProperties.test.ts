// Seeded property tests of the asymmetric rule (Phase 70.1 plan 02 Task 3; CLSF-02, D-04, D-10, D-13, D-14). 2,000 random cases per property over the
// four shipped scales: no proposal from any source, in any mode, lowers any field of a label; a stale result changes nothing; anything above the
// system-high is a possible spill; shadow never applies a judgement; no judgement suppresses a floor. The seed is printed on failure and can be set with
// CLASSIFY_SEED. 70.1-04 adds hidden parts and session histories to this generator, in this file.
import assert from 'node:assert/strict';
import test from 'node:test';
import { markAtLeast } from '../domain/gate/dominance';
import type { Mark } from '../domain/gate/dominance';
import { SCALE_PRESETS, levelIndex } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { parseClassificationSection } from '../domain/gate/classificationSection';
import type { ClassificationSection } from '../domain/gate/classificationSection';
import { decide, withinSystemHigh } from '../domain/classify/decide';
import type { DecideInput, Decision, Judgement } from '../domain/classify/decide';
import type { Floor } from '../domain/classify/markings';
import type { BasisKind } from '../domain/classify/record';

const CASES = 2000;
const H = 'a'.repeat(64);
const OTHER = 'e'.repeat(64);
const SCALES = Object.keys(SCALE_PRESETS);
const COMPARTMENTS = ['CGP', 'EXAMPLE-CW', 'ITAR'];
const RELEASE = ['CAN', 'GBR', 'USA'];
const HANDLING = ['local-only', 'no-agent-tools'];
const FLOOR_KINDS: BasisKind[] = ['source', 'marking', 'guide', 'detector', 'compilation'];

/** mulberry32: small, seeded and the same on every machine. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Random = () => number;

const pick = <T>(random: Random, list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
const subset = (random: Random, list: readonly string[]): string[] => list.filter(() => random() < 0.3).sort();

function randomLabel(random: Random, scale = pick(random, SCALES)): Label {
  const levels = SCALE_PRESETS[scale]?.levels ?? [];
  return { scale, level: pick(random, levels), compartments: subset(random, COMPARTMENTS), releasability: subset(random, RELEASE), handling: subset(random, HANDLING) };
}

/** Labels on distinct scales, sorted as a mark. */
function randomMark(random: Random, min: number, max: number): Mark {
  const count = min + Math.floor(random() * (max - min + 1));
  const scales = [...SCALES].sort(() => random() - 0.5).slice(0, count);
  return scales.map((scale) => randomLabel(random, scale)).sort((a, b) => (`${a.scale}/${a.level}` < `${b.scale}/${b.level}` ? -1 : 1));
}

function randomSection(random: Random, withSystemHigh: boolean): ClassificationSection {
  const thresholds: Record<string, unknown> = {};
  for (const scale of SCALES) {
    for (const level of SCALE_PRESETS[scale]?.levels ?? []) {
      if (random() < 0.6) thresholds[`${scale}/${level}`] = { costRatio: 1 + Math.floor(random() * 60), recallTarget: 9000, secondFamily: random() < 0.5 };
    }
  }
  const keys = Object.keys(thresholds).sort();
  const value: Record<string, unknown> = {
    v: 1, thresholds,
    shadow: { defaultMode: random() < 0.5 ? 'shadow' : 'enforce', levels: keys.filter(() => random() < 0.3) },
    review: { jumpLevels: 1 + Math.floor(random() * 3), topLevel: random() < 0.5 }
  };
  if (withSystemHigh) value['systemHigh'] = randomMark(random, 1, 2).map((label) => ({ ...label, compartments: [], releasability: [], handling: [] }));
  const parsed = parseClassificationSection(value, SCALE_PRESETS);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

function randomFloors(random: Random): Floor[] {
  const count = Math.floor(random() * 4);
  return Array.from({ length: count }, (_, index) => ({ label: randomLabel(random), basis: { kind: pick(random, FLOOR_KINDS), ref: `rule-${String(index)}` } }));
}

function randomJudgement(random: Random, contentHash = H): Judgement {
  const proposal = [...randomMark(random, 1, 2)];
  const probabilities: Record<string, number> = {};
  for (const label of proposal) {
    for (const level of SCALE_PRESETS[label.scale]?.levels ?? []) if (random() < 0.6) probabilities[`${label.scale}/${level}`] = Math.floor(random() * 10001);
  }
  return {
    contentHash, proposal, probabilities, calibration: 'cal-property', sampleAgreement: Math.floor(random() * 10001), facts: [], rationaleHash: 'f'.repeat(64),
    model: { servedModel: 'gpt-oss-20b', endpoint: 'example-org-classifier', passport: 'openai/gpt-oss', passportHash: 'b'.repeat(64), artifactHash: 'c'.repeat(64), endpointClass: 'local', useTier: 'T3' }
  };
}

function randomInput(random: Random, options: { systemHigh?: boolean; judgement?: boolean } = {}): DecideInput {
  return {
    start: randomMark(random, 1, 2),
    current: { item: 'item-property', contentHash: H, revision: 1 },
    floors: randomFloors(random),
    ...(options.judgement ?? random() < 0.7 ? { judgement: randomJudgement(random) } : {}),
    section: randomSection(random, options.systemHigh ?? random() < 0.4),
    scales: SCALE_PRESETS
  };
}

function decided(input: DecideInput): Decision {
  const result = decide(input);
  if (!result.ok) throw new Error(result.message);
  return result;
}

/** Runs `check` over CASES seeded cases and names the seed and case on the first failure. */
function forAll(name: string, check: (random: Random) => void): void {
  const seed = process.env['CLASSIFY_SEED'] === undefined ? 70_1 : Number(process.env['CLASSIFY_SEED']);
  const random = generator(seed);
  let ran = 0;
  for (let index = 0; index < CASES; index += 1) {
    try {
      check(random);
    } catch (error) {
      throw new Error(`${name}: case ${String(index)} with seed ${String(seed)} (set CLASSIFY_SEED to repeat): ${(error as Error).message}`);
    }
    ran += 1;
  }
  assert.equal(ran, CASES, `${name} ran ${String(ran)} cases`);
}

function rose(label: Label, start: Mark): boolean {
  const held = start.find((entry) => entry.scale === label.scale);
  return held === undefined || levelIndex(SCALE_PRESETS, label.scale, label.level) > levelIndex(SCALE_PRESETS, held.scale, held.level);
}

test('property: applied is never below start on any field, whatever the floors, judgement, mode and section', () => {
  forAll('never below start', (random) => {
    const input = randomInput(random);
    const result = decided(input);
    assert.ok(markAtLeast(result.applied, input.start, SCALE_PRESETS), JSON.stringify({ start: input.start, applied: result.applied }));
  });
});

test('property: a stale result never changes applied and writes no event', () => {
  forAll('stale', (random) => {
    const input = { ...randomInput(random), judgement: randomJudgement(random, OTHER) };
    const result = decided(input);
    assert.equal(result.outcome, 'stale');
    assert.deepEqual(result.applied, input.start);
    assert.deepEqual(result.events, []);
    assert.equal(result.notify, false);
  });
});

test('property: a floor above the system-high always gives possible-spill, and without a spill every raised level is within it', () => {
  let spills = 0;
  forAll('system-high', (random) => {
    const input = randomInput(random, { systemHigh: true });
    const result = decided(input);
    const above = input.floors.some((floor) => !withinSystemHigh(floor.label, input.section, SCALE_PRESETS));
    if (above) assert.equal(result.outcome, 'possible-spill');
    if (result.outcome === 'possible-spill') {
      spills += 1;
      assert.equal(result.freeze, true);
      assert.ok(result.applied.every((label) => label.handling.includes('local-only') && label.handling.includes('no-agent-tools')));
      assert.ok(result.exceptions.some((entry) => entry.kind === 'possible-spill'));
    } else {
      for (const label of result.applied) if (rose(label, input.start)) assert.ok(withinSystemHigh(label, input.section, SCALE_PRESETS), JSON.stringify(label));
    }
  });
  assert.ok(spills > 100, `the generator reaches the spill path (${String(spills)})`);
});

test('property: shadow never applies a judgement: with every level in shadow the result applies what the floors alone apply', () => {
  forAll('shadow', (random) => {
    const base = randomInput(random, { systemHigh: false, judgement: true });
    const section = { ...base.section, shadow: { defaultMode: 'shadow' as const, levels: [] } };
    const withJudgement = decided({ ...base, section });
    const floorsOnly = decided({ ...base, section, judgement: undefined });
    assert.deepEqual(withJudgement.applied, floorsOnly.applied);
    assert.ok(!withJudgement.suggestions.some((entry) => entry.reason === 'band' && !rose(entry.label, base.start)), 'a band suggestion is always a raise');
  });
});

test('property: no judgement suppresses a floor: every floor is covered by applied, or the outcome is a possible spill', () => {
  forAll('floors', (random) => {
    const input = randomInput(random);
    const result = decided(input);
    if (result.outcome === 'possible-spill') return;
    for (const floor of input.floors) assert.ok(markAtLeast(result.applied, [floor.label], SCALE_PRESETS), JSON.stringify(floor.label));
  });
});
