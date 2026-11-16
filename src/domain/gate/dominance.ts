// Clearance dominance and the session mark's join (CLAS-03, CLAS-04, D-28, D-29). A small hand-written evaluator: pure, no I/O, no clock (the caller passes
// `now`), no vscode, no package. Anything unknown is no access, never a guess.
import { RELEASABILITY_NONE, expiryMs, levelIndex } from './labels';
import type { Clearance, Label, ScaleTable } from './labels';

export interface DominanceContext {
  readonly scales: ScaleTable;
  /** Epoch milliseconds, supplied by the caller so this module stays pure. */
  readonly now: number;
}

function hasAll(held: readonly string[], needed: readonly string[]): boolean {
  return needed.every((token) => held.includes(token));
}

/** True only when the clearance is on the label's scale, at or above its level, holds every compartment, and has not expired. */
export function dominates(clearance: Clearance, label: Label, context: DominanceContext): boolean {
  if (clearance.scale !== label.scale) return false;
  const have = levelIndex(context.scales, clearance.scale, clearance.level);
  const need = levelIndex(context.scales, label.scale, label.level);
  if (have < 0 || need < 0 || have < need) return false;
  if (!hasAll(clearance.compartments, label.compartments)) return false;
  if (clearance.expiresAt !== undefined && !(expiryMs(clearance.expiresAt) > context.now)) return false;
  return true;
}

/** The labels a session has read, at most one per scale. Never mutated: raising returns a new mark. */
export type Mark = readonly Label[];

function sortedUnion(a: readonly string[], b: readonly string[]): readonly string[] {
  return Object.freeze([...new Set([...a, ...b])].sort());
}

/** Releasability join: an empty set means unrestricted, so the other side wins; two sets that share nothing become releasable to no one (never unrestricted). */
function joinReleasability(a: readonly string[], b: readonly string[]): readonly string[] {
  if (a.length === 0) return Object.freeze([...b].sort());
  if (b.length === 0) return Object.freeze([...a].sort());
  const shared = a.filter((token) => b.includes(token) && token !== RELEASABILITY_NONE).sort();
  return Object.freeze(shared.length > 0 ? shared : [RELEASABILITY_NONE]);
}

/** The join of two labels on one scale: the higher level, the union of compartments and handling, and the intersection of non-empty releasability sets, sorted. Undefined when the scales differ or a level is unknown. */
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

/** A new mark with the label folded in: the label on an existing scale is joined, a new scale is added. The mark never goes down. */
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
  return Object.freeze(out);
}
