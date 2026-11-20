// Clearance dominance and the session mark's join (CLAS-03, CLAS-04, D-28, D-29). A small hand-written evaluator: pure, no I/O, no clock (the caller passes
// `now`), no vscode, no package. `dominates` is true only when all five hold: (1) the clearance is on the label's scale, or a bundle mapping covers it;
// (2) its level is at least the label's; (3) it holds every label compartment; (4) it meets the label's releasability (an empty clearance releasability
// cannot read a label that restricts releasability); (5) it has not expired. Anything unknown, malformed or missing is no access, never a guess.
import { RELEASABILITY_NONE, expiryMs, labelKey, levelIndex, parseLabelKey, scaleOf } from './labels';
import type { Clearance, Label, ScaleMapping, ScaleTable } from './labels';

export interface DominanceContext {
  readonly scales: ScaleTable;
  /** The mappings from the signed bundle. Never inferred, and none ships by default. */
  readonly mappings: readonly ScaleMapping[];
  /** Epoch milliseconds, supplied by the caller so this module stays pure. */
  readonly now: number;
}

/** The two fields a ranking reads: a label's (or clearance's) scale and level. */
export type LabelLevel = Pick<Label, 'scale' | 'level'>;

/**
 * Whether `label` is on the same scale as `floor` and at least as high, both levels known on `scales` (D-35): the one level ranking every label check
 * uses. Across scales, or with an unknown level on either side, it is false. Pure: the caller passes the scales (the active policy's, see labelAlgebra.ts).
 */
export function atLeast(label: LabelLevel, floor: LabelLevel, scales: ScaleTable): boolean {
  if (label.scale !== floor.scale) return false;
  const rank = levelIndex(scales, label.scale, label.level);
  const floorRank = levelIndex(scales, floor.scale, floor.level);
  return rank >= 0 && floorRank >= 0 && rank >= floorRank;
}

/** The scale part of a `scale/level` text: the text before the first slash, or the whole text when it has none. */
function scalePart(text: string): string {
  const at = text.indexOf('/');
  return at < 0 ? text : text.slice(0, at);
}

/**
 * Whether the `scale/level` text `label` is below the text `floor` on the floor's scale (D-35): the two texts name the same scale and `label` is not at
 * least `floor` on `scales`. A text that does not parse is not at least anything, so an unknown level on the floor's scale counts as below; a label on
 * another scale is never below (the caller's other checks govern it). The one check the staff importers, the store and the feeds use.
 */
export function belowOnScale(label: string, floor: string, scales: ScaleTable): boolean {
  if (scalePart(label) !== scalePart(floor)) return false;
  const read = parseLabelKey(label, scales);
  const least = parseLabelKey(floor, scales);
  return !(read !== undefined && least !== undefined && atLeast(read, least, scales));
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

/** Whether `mark` already holds `floor` (D-35): raising it by every label of `floor` changes nothing. The chat label's covers and not-lower checks. */
export function markAtLeast(mark: Mark, floor: Mark, scales: ScaleTable): boolean {
  let raised: Mark = mark;
  for (const label of floor) raised = raiseMark(raised, label, scales);
  return sameMark(raised, mark);
}

function sortedIntersection(a: readonly string[], b: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(a.filter((token) => b.includes(token)))].sort());
}

/** The earlier of two expiries (absent means never); null when either cannot be read, so the caller fails closed. */
function earlierExpiry(a: string | undefined, b: string | undefined): string | undefined | null {
  if (a !== undefined && Number.isNaN(expiryMs(a))) return null;
  if (b !== undefined && Number.isNaN(expiryMs(b))) return null;
  if (a === undefined) return b;
  if (b === undefined) return a;
  return expiryMs(b) < expiryMs(a) ? b : a;
}

function levelLabel(place: { readonly scale: string; readonly level: string }): Label {
  return { scale: place.scale, level: place.level, compartments: [], releasability: [], handling: [] };
}

/**
 * The highest level of `under`'s scale, at or below `under`'s own, from which every mapping it would satisfy reaches only what `over` reaches too. A meet
 * placed on `under`'s scale must not reach a third scale through a mapping `over` cannot follow. Undefined when even the lowest level satisfies one.
 */
function narrowedUnder(under: Clearance, over: Clearance, context: DominanceContext): string | undefined {
  const levels = scaleOf(context.scales, under.scale)?.levels ?? [];
  const top = levelIndex(context.scales, under.scale, under.level);
  for (let rank = top; rank >= 0; rank -= 1) {
    const reaches = context.mappings.filter((mapping) => mapping.from.scale === under.scale && levelIndex(context.scales, mapping.from.scale, mapping.from.level) <= rank);
    if (reaches.every((mapping) => scaleAndLevel(over, levelLabel(mapping.covers), context) === undefined)) return levels[rank];
  }
  return undefined;
}

/**
 * The meet of two clearances (D-35): the widest clearance that dominates nothing either input does not, which 41-10 uses as the effective clearance (the
 * personal layer met with the roster's). On one scale it is the lower level; across scales it is the side the other covers through a signed mapping
 * (never a new ranking), held below any mapping of that side the other cannot follow. Compartments and releasability are the shared tokens and the expiry
 * the earlier one (absent means never). Neither side covering the other, an unknown scale or level, or an unreadable expiry gives undefined: no clearance.
 */
export function meetClearance(a: Clearance, b: Clearance, scales: ScaleTable, mappings: readonly ScaleMapping[]): Clearance | undefined {
  if (levelIndex(scales, a.scale, a.level) < 0 || levelIndex(scales, b.scale, b.level) < 0) return undefined;
  const expiresAt = earlierExpiry(a.expiresAt, b.expiresAt);
  if (expiresAt === null) return undefined;
  const context: DominanceContext = { scales, mappings, now: 0 };
  let place: { readonly scale: string; readonly level: string } | undefined;
  if (a.scale === b.scale) {
    place = atLeast(a, b, scales) ? b : a;
  } else {
    for (const [over, under] of [[a, b], [b, a]] as const) {
      if (scaleAndLevel(over, levelLabel(under), context) !== undefined) continue;
      const level = narrowedUnder(under, over, context);
      if (level !== undefined) { place = { scale: under.scale, level }; break; }
    }
  }
  if (place === undefined) return undefined;
  const base = {
    scale: place.scale,
    level: place.level,
    compartments: sortedIntersection(a.compartments, b.compartments),
    releasability: sortedIntersection(a.releasability, b.releasability)
  };
  return Object.freeze(expiresAt === undefined ? base : { ...base, expiresAt });
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
