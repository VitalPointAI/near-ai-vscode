// Clearance dominance and the session mark's join (CLAS-03, CLAS-04, D-28, D-29). A small hand-written evaluator: pure, no I/O, no clock (the caller passes
// `now`), no vscode, no package. `dominates` is true only when all five hold: (1) the clearance is on the label's scale, or a bundle mapping covers it;
// (2) its level is at least the label's; (3) it holds every label compartment; (4) it meets the label's releasability (an empty clearance releasability
// cannot read a label that restricts releasability); (5) it has not expired. Anything unknown, malformed or missing is no access, never a guess.
import { RELEASABILITY_NONE, expiryMs, labelKey, levelIndex } from './labels';
import type { Clearance, Label, ScaleMapping, ScaleTable } from './labels';

export interface DominanceContext {
  readonly scales: ScaleTable;
  /** The mappings from the signed bundle. Never inferred, and none ships by default. */
  readonly mappings: readonly ScaleMapping[];
  /** Epoch milliseconds, supplied by the caller so this module stays pure. */
  readonly now: number;
}

/** Why a clearance does not dominate a label, in the order they are checked. Later UI words each refusal plainly from this closed list. */
export const DOMINANCE_REASONS = Object.freeze(['no-clearance', 'scale', 'level', 'compartment', 'releasability', 'expired'] as const);
export type DominanceReason = (typeof DOMINANCE_REASONS)[number];

function hasAll(held: readonly string[], needed: readonly string[]): boolean {
  return needed.every((token) => held.includes(token));
}

function sharesOne(held: readonly string[], needed: readonly string[]): boolean {
  return needed.some((token) => token !== RELEASABILITY_NONE && held.includes(token));
}

/** The first failing reason for conditions (1) and (2), or undefined when the scale and the level are covered. */
function scaleAndLevel(clearance: Clearance, label: Label, context: DominanceContext): 'scale' | 'level' | undefined {
  if (!knownScale(context, clearance.scale) || !knownScale(context, label.scale)) return 'scale';
  const have = levelIndex(context.scales, clearance.scale, clearance.level);
  const need = levelIndex(context.scales, label.scale, label.level);
  if (clearance.scale === label.scale) {
    if (have < 0 || need < 0) return 'level';
    return have >= need ? undefined : 'level';
  }
  const bridging = context.mappings.filter((mapping) => mapping.from.scale === clearance.scale && mapping.covers.scale === label.scale);
  if (bridging.length === 0) return 'scale';
  const covered = bridging.some((mapping) => {
    const from = levelIndex(context.scales, mapping.from.scale, mapping.from.level);
    const covers = levelIndex(context.scales, mapping.covers.scale, mapping.covers.level);
    return have >= 0 && need >= 0 && from >= 0 && covers >= 0 && have >= from && need <= covers;
  });
  return covered ? undefined : 'level';
}

function knownScale(context: DominanceContext, scale: string): boolean {
  return Object.prototype.hasOwnProperty.call(context.scales, scale);
}

/** The first reason the clearance does not dominate the label, or undefined when it does. No clearance at all is `no-clearance`. */
export function whyNotDominated(clearance: Clearance | undefined, label: Label, context: DominanceContext): DominanceReason | undefined {
  if (clearance === undefined) return 'no-clearance';
  const placed = scaleAndLevel(clearance, label, context);
  if (placed !== undefined) return placed;
  if (!hasAll(clearance.compartments, label.compartments)) return 'compartment';
  if (label.releasability.length > 0 && !sharesOne(clearance.releasability, label.releasability)) return 'releasability';
  if (clearance.expiresAt !== undefined && !(expiryMs(clearance.expiresAt) > context.now)) return 'expired';
  return undefined;
}

/** True only when all five conditions hold (D-28). */
export function dominates(clearance: Clearance | undefined, label: Label, context: DominanceContext): boolean {
  return whyNotDominated(clearance, label, context) === undefined;
}

/** The labels a session has read, at most one per scale that the scales can order. Never mutated: raising returns a new mark. */
export type Mark = readonly Label[];

function sortedUnion(a: readonly string[], b: readonly string[]): readonly string[] {
  return Object.freeze([...new Set([...a, ...b])].sort());
}

/** Releasability join: an empty set means unrestricted, so the other side wins; two sets that share nothing become releasable to no one, never unrestricted. */
function joinReleasability(a: readonly string[], b: readonly string[]): readonly string[] {
  if (a.length === 0) return Object.freeze([...b].sort());
  if (b.length === 0) return Object.freeze([...a].sort());
  const shared = a.filter((token) => b.includes(token) && token !== RELEASABILITY_NONE).sort();
  return Object.freeze(shared.length > 0 ? shared : [RELEASABILITY_NONE]);
}

/**
 * The join of two labels on one scale (D-29): the higher level, the union of compartments and handling, and the intersection of non-empty releasability
 * sets. Undefined when the scales differ or a level is unknown, because there is then no honest higher level to pick.
 */
export function joinLabels(a: Label, b: Label, scales: ScaleTable): Label | undefined {
  if (a.scale !== b.scale) return undefined;
  const indexA = levelIndex(scales, a.scale, a.level);
  const indexB = levelIndex(scales, b.scale, b.level);
  if (indexA < 0 || indexB < 0) return undefined;
  return Object.freeze({
    scale: a.scale,
    level: indexA >= indexB ? a.level : b.level,
    compartments: sortedUnion(a.compartments, b.compartments),
    releasability: joinReleasability(a.releasability, b.releasability),
    handling: sortedUnion(a.handling, b.handling)
  });
}

function byKey(a: Label, b: Label): number {
  const left = labelKey(a);
  const right = labelKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * A new mark with the label folded in; the mark never goes down and the input is never changed. A label on a scale already in the mark is joined with it.
 * A label on another scale is kept beside it (with no mapping there is no honest single level), so routing can take the strictest tier later. A label
 * whose level the scales cannot order is also kept beside, which `markDominated` then refuses, so an unknown level can only make access narrower.
 */
export function raiseMark(mark: Mark, label: Label, scales: ScaleTable): Mark {
  const out: Label[] = [];
  let merged = false;
  for (const held of mark) {
    const joined = merged ? undefined : joinLabels(held, label, scales);
    if (joined === undefined) {
      out.push(held);
    } else {
      out.push(joined);
      merged = true;
    }
  }
  if (!merged) out.push(label);
  return Object.freeze(out.sort(byKey));
}

/** True only when every label of the mark is dominated by some clearance. No clearance dominates a mark that holds any label; an empty mark holds nothing. */
export function markDominated(clearances: readonly Clearance[], mark: Mark, context: DominanceContext): boolean {
  return mark.every((label) => clearances.some((clearance) => dominates(clearance, label, context)));
}

/** The mark's `scale/level` keys, sorted: the keys routing looks up. */
export function markLabelKeys(mark: Mark): readonly string[] {
  return Object.freeze(mark.map(labelKey).sort());
}

function sameLabel(a: Label, b: Label): boolean {
  return labelKey(a) === labelKey(b) && JSON.stringify([...a.compartments].sort()) === JSON.stringify([...b.compartments].sort())
    && JSON.stringify([...a.releasability].sort()) === JSON.stringify([...b.releasability].sort()) && JSON.stringify([...a.handling].sort()) === JSON.stringify([...b.handling].sort());
}

/** True when two marks hold the same labels, in any order. */
export function sameMark(a: Mark, b: Mark): boolean {
  return a.length === b.length && a.every((label) => b.some((other) => sameLabel(label, other)));
}

/**
 * One chat's high-water mark (CLAS-04, D-29, D-54): what its agents have read, as a mark that only rises. Every run of the chat carries it in its RunGrants,
 * which reach every sub-agent, so what a helper reads raises the lead's mark too, and every session route of the chat reads it before each model request.
 * Pure: no I/O, no clock. `raise` never lowers; `lowerByPerson` is the one way down, called only by the person's Lower This Chat's Label command (plan 23).
 */
export class SessionMark {
  private mark: Mark;
  private readonly listeners = new Set<(mark: Mark) => void>();

  /** A mark that starts at `start`: the project's resolved label for a new chat, the stored mark for a reopened one. */
  public constructor(start: Mark) {
    this.mark = Object.freeze([...start]);
  }

  public current(): Mark {
    return this.mark;
  }

  /**
   * Folds `labels` into the mark with the join of D-29 (raiseMark). Returns true only when the mark rose; a label the mark already covers changes nothing,
   * and a label whose level the scales cannot order is kept beside once, never again.
   */
  public raise(labels: readonly Label[], scales: ScaleTable): boolean {
    let next = this.mark;
    for (const label of labels) {
      if (next.some((held) => sameLabel(held, label))) continue;
      next = raiseMark(next, label, scales);
    }
    if (sameMark(next, this.mark)) return false;
    this.set(next);
    return true;
  }

  /**
   * The person's declassification (D-29): sets the mark to `to`, which the caller has checked is lower, and returns the mark it replaced. A reason is
   * required and is the caller's to record (label.declassify); an empty one changes nothing and throws.
   */
  public lowerByPerson(to: Mark, reason: string): Mark {
    if (reason.trim() === '') throw new RangeError('A reason is required to lower a chat\'s label.');
    if (to.length === 0) throw new RangeError('A chat\'s label cannot be lowered to no label.');
    const before = this.mark;
    this.set(Object.freeze([...to]));
    return before;
  }

  /** Told the new mark each time it changes; returns a function that stops telling. */
  public onDidChange(listener: (mark: Mark) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private set(next: Mark): void {
    this.mark = next;
    for (const listener of [...this.listeners]) {
      try { listener(next); } catch { /* a listener never changes the mark */ }
    }
  }
}
