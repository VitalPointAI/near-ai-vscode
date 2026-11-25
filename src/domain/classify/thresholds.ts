// Raise thresholds, bands and recall tightening (Phase 70.1, D-07, D-08, D-12; research 3.2). Pure: no I/O, no clock, no vscode, no package.
// For a level with cost ratio r (under-classifying cost over over-classifying cost) the raise threshold is tau = 1 / (1 + r). Probabilities are whole basis
// points (10000 is 1; owner, 2026-11-25), so "p is at least tau" is the exact integer test p * (1 + r) * 2^h >= 10000, where h is the number of halvings a
// recall drop has applied (D-12). Nothing here ships a threshold as a value: the signed section's entries are the only source.
import type { ThresholdEntry } from '../gate/classificationSection';
import { BASIS_POINTS } from '../gate/classificationSection';

/** The three bands of a level (D-08): at or above tau, raise; from tau/4 up to tau, suggest; below tau/4, nothing. */
export const BAND_IDS = Object.freeze(['raise', 'suggest', 'none'] as const);
export type BandId = (typeof BAND_IDS)[number];

/** One blind-audit window's result for a level (74.3 supplies the history): recall met its target or not. */
export const AUDIT_RESULTS = Object.freeze(['pass', 'fail'] as const);
export type AuditResult = (typeof AUDIT_RESULTS)[number];

/** The most halvings a recall drop applies: tau never goes below tau / 8 (D-12). */
export const MAX_HALVINGS = 3;

/** A level's threshold in force: the signed cost ratio and the halvings applied after failing audit windows. `tau` is for display and tests only. */
export interface EffectiveThreshold {
  readonly costRatio: number;
  readonly halvings: number;
  readonly tau: number;
}

const SUGGEST_FACTOR = 4;

function checkRatio(costRatio: number): void {
  if (!Number.isFinite(costRatio) || costRatio <= 0) throw new RangeError('A cost ratio must be a positive number.');
}

/** tau = 1 / (1 + r). A non-positive or non-finite ratio throws, so no caller can make a threshold of 1 or more. */
export function raiseThreshold(costRatio: number): number {
  checkRatio(costRatio);
  return 1 / (1 + costRatio);
}

/**
 * The threshold in force after the audit history (oldest first): each failing window halves tau, down to tau / 8; a passing window returns it to the
 * signed value. Never above the signed value, so a recall drop only ever causes more raises.
 */
export function effectiveThreshold(costRatio: number, history: readonly AuditResult[] = []): EffectiveThreshold {
  checkRatio(costRatio);
  let halvings = 0;
  for (const result of history) halvings = result === 'fail' ? Math.min(halvings + 1, MAX_HALVINGS) : 0;
  return Object.freeze({ costRatio, halvings, tau: 1 / ((1 + costRatio) * 2 ** halvings) });
}

/** The signed entry's threshold with no history. */
export function signedThreshold(entry: ThresholdEntry): EffectiveThreshold {
  return effectiveThreshold(entry.costRatio);
}

/** Whether a probability in basis points is a whole number from 0 to 10000. Anything else is refused by the caller, never clamped. */
export function isBasisPoints(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= BASIS_POINTS;
}

/** Exact: p (basis points) is at least tau / factor. */
function meets(probability: number, threshold: EffectiveThreshold, factor: number): boolean {
  return probability * (1 + threshold.costRatio) * 2 ** threshold.halvings * factor >= BASIS_POINTS;
}

/**
 * The cumulative probabilities made non-increasing up the scale (D-08): each level reads the largest probability at or above it, so a model cannot dodge a
 * lower level's threshold by putting its weight on a higher one. This can only raise a level's probability. A missing level reads 0 before the fold.
 */
export function monotoneCumulative(levels: readonly string[], probabilities: Readonly<Record<string, number>>): readonly number[] {
  const out = new Array<number>(levels.length).fill(0);
  let highest = 0;
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    const key = levels[index] as string;
    const own = Object.prototype.hasOwnProperty.call(probabilities, key) ? (probabilities[key] as number) : 0;
    highest = Math.max(highest, own);
    out[index] = highest;
  }
  return Object.freeze(out);
}

export interface BandResult {
  readonly band: BandId;
  /** The highest level whose probability meets its threshold. */
  readonly raiseTo?: string;
  /** The highest level above raiseTo whose probability meets a quarter of its threshold. */
  readonly suggest?: string;
}

/**
 * The bands of one scale (D-08). `levels` is the scale's order, lowest first; `probabilities` and `thresholds` are keyed by level name. A level with no
 * threshold is never raised to or suggested here (D-07): the caller may at most suggest it from the model's own proposal.
 */
export function bands(levels: readonly string[], probabilities: Readonly<Record<string, number>>, thresholds: Readonly<Record<string, EffectiveThreshold | undefined>>): BandResult {
  const cumulative = monotoneCumulative(levels, probabilities);
  let raiseIndex = -1;
  let suggestIndex = -1;
  levels.forEach((level, index) => {
    const threshold = Object.prototype.hasOwnProperty.call(thresholds, level) ? thresholds[level] : undefined;
    if (threshold === undefined) return;
    const probability = cumulative[index] as number;
    if (meets(probability, threshold, 1)) raiseIndex = index;
    if (meets(probability, threshold, SUGGEST_FACTOR)) suggestIndex = index;
  });
  const raiseTo = raiseIndex >= 0 ? levels[raiseIndex] : undefined;
  const suggest = suggestIndex > raiseIndex ? levels[suggestIndex] : undefined;
  const band: BandId = raiseTo !== undefined ? 'raise' : suggest !== undefined ? 'suggest' : 'none';
  return Object.freeze({ band, ...(raiseTo === undefined ? {} : { raiseTo }), ...(suggest === undefined ? {} : { suggest }) });
}
