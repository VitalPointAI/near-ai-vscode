// What a classification proposal may do to a label (Phase 70.1, D-04, D-05, D-06, D-09, D-14, D-15; research 3.1, 3.3). Pure: no I/O, no clock, no
// vscode, no package. Automatic steps may raise or keep; nothing is ever lowered here, whatever the confidence.
// `applied` is built only by folding labels into `start` with raiseMark (the join of dominance.ts), never by assigning a label, so no field can go down by
// construction. The caller passes `start` as the inherited join (the session's mark, the sources' labels, the project, folder or cell label); an empty
// start is refused, never read as the lowest level, so text such as "this document is unclassified" can only ever fail to raise.
// This plan (70.1-01) holds the floor path; the model judgement, thresholds, shadow mode, review and the possible spill are 70.1-02's.
import type { ClassificationSection } from '../gate/classificationSection';
import { joinLabels, raiseMark, sameMark } from '../gate/dominance';
import type { Mark } from '../gate/dominance';
import { levelIndex } from '../gate/labels';
import type { Label, ScaleTable } from '../gate/labels';
import type { Floor } from './markings';
import { PROPOSAL_OUTCOMES } from './record';
import type { Basis, ItemRef, LevelDirection, ProposalOutcome, ProposalPart, ReleaseDirection, SetDirection } from './record';

/** The outcomes decide() gives: the record's outcomes (D-21). */
export const DECIDE_OUTCOMES = PROPOSAL_OUTCOMES;

/** Why decide() would not decide, each one plain sentence. */
export const DECIDE_REFUSALS = Object.freeze({
  'no-start': 'There is no starting label to raise from. A proposal only ever adds to the labels the content already inherits.',
  'unknown-label': 'A label names a level its scale does not have.'
} as const);
export type DecideRefusal = keyof typeof DECIDE_REFUSALS;

/** A label event the caller records with buildDecisionRecord (D-15): `from` is the mark before, `to` the mark after. */
export interface LabelEventDescriptor {
  readonly event: 'label.auto-raised';
  readonly from: Mark;
  readonly to: Mark;
  readonly bases: readonly Basis[];
}

export interface DecideInput {
  /** The inherited join (D-05). Never empty. */
  readonly start: Mark;
  /** The item as it is now (D-14). */
  readonly current: ItemRef;
  /** Floors found by the deterministic checks: markings now; sources, guide, detector and compilation rules later (D-09). */
  readonly floors: readonly Floor[];
  /** The model judgement arrives in 70.1-02. */
  readonly judgement?: undefined;
  readonly section: ClassificationSection;
  /** The policy's scales (labels.scales). */
  readonly scales: ScaleTable;
  /** Shadow or enforce per `scale/level` (D-10), read in 70.1-02. */
  readonly modes?: Readonly<Record<string, 'shadow' | 'enforce'>>;
}

export type DecideResult =
  | { readonly ok: false; readonly refusal: DecideRefusal; readonly message: string }
  | {
    readonly ok: true;
    readonly current: ItemRef;
    readonly outcome: ProposalOutcome;
    readonly start: Mark;
    readonly applied: Mark;
    readonly proposal: readonly ProposalPart[];
    readonly bases: readonly Basis[];
    /** True when a raise applied: the caller tells the originator or steward at once (D-11). */
    readonly notify: boolean;
    readonly events: readonly LabelEventDescriptor[];
  };

function refuse(refusal: DecideRefusal): DecideResult {
  return { ok: false, refusal, message: DECIDE_REFUSALS[refusal] };
}

function known(label: Label, scales: ScaleTable): boolean {
  return levelIndex(scales, label.scale, label.level) >= 0;
}

function setDirection(start: readonly string[], proposed: readonly string[]): SetDirection {
  const added = proposed.some((token) => !start.includes(token));
  const removed = start.some((token) => !proposed.includes(token));
  return added && removed ? 'both' : added ? 'added' : removed ? 'removed' : 'same';
}

/** Releasability: empty means unrestricted, so going from empty to a list narrows, from a list to empty widens, and a dropped token narrows. */
function releaseDirection(start: readonly string[], proposed: readonly string[]): ReleaseDirection {
  if (start.length === 0) return proposed.length === 0 ? 'same' : 'narrowed';
  if (proposed.length === 0) return 'widened';
  const narrowed = start.some((token) => !proposed.includes(token));
  const widened = proposed.some((token) => !start.includes(token));
  return narrowed && widened ? 'both' : narrowed ? 'narrowed' : widened ? 'widened' : 'same';
}

/** The direction of each field of `proposed` against the start's label on the same scale (none there: everything is a raise). */
export function partOf(start: Mark, proposed: Label, scales: ScaleTable): ProposalPart {
  const held = start.find((label) => label.scale === proposed.scale);
  if (held === undefined) {
    return Object.freeze({ label: proposed, level: 'up', compartments: setDirection([], proposed.compartments), releasability: releaseDirection([], proposed.releasability), handling: setDirection([], proposed.handling) });
  }
  const rank = levelIndex(scales, proposed.scale, proposed.level) - levelIndex(scales, held.scale, held.level);
  const level: LevelDirection = rank > 0 ? 'up' : rank < 0 ? 'down' : 'same';
  return Object.freeze({
    label: proposed,
    level,
    compartments: setDirection(held.compartments, proposed.compartments),
    releasability: releaseDirection(held.releasability, proposed.releasability),
    handling: setDirection(held.handling, proposed.handling)
  });
}

/** The proposed label per scale: the join of every floor on that scale, sorted by scale. */
function proposedLabels(floors: readonly Floor[], scales: ScaleTable): readonly Label[] {
  const byScale = new Map<string, Label>();
  for (const floor of floors) {
    const held = byScale.get(floor.label.scale);
    byScale.set(floor.label.scale, held === undefined ? floor.label : (joinLabels(held, floor.label, scales) ?? held));
  }
  return [...byScale.values()].sort((a, b) => (a.scale < b.scale ? -1 : a.scale > b.scale ? 1 : 0));
}

function uniqueBases(floors: readonly Floor[]): readonly Basis[] {
  const seen = new Set<string>();
  const out: Basis[] = [];
  for (const { basis } of floors) {
    const key = `${basis.kind} ${basis.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(basis);
  }
  return Object.freeze(out);
}

/**
 * Decides one proposal. Refuses an empty start (`no-start`) and a label whose level is unknown (`unknown-label`). Floors apply with certainty: the result
 * is `auto-raised` when the join rose, `kept` when a floor found nothing above the start, and `none` when there was nothing to propose.
 */
export function decide(input: DecideInput): DecideResult {
  if (input.start.length === 0) return refuse('no-start');
  if (!input.start.every((label) => known(label, input.scales)) || !input.floors.every((floor) => known(floor.label, input.scales))) return refuse('unknown-label');
  let applied: Mark = input.start;
  for (const floor of input.floors) applied = raiseMark(applied, floor.label, input.scales);
  const raised = !sameMark(applied, input.start);
  const outcome: ProposalOutcome = raised ? 'auto-raised' : input.floors.length > 0 ? 'kept' : 'none';
  const bases = uniqueBases(input.floors);
  const proposal = Object.freeze(proposedLabels(input.floors, input.scales).map((label) => partOf(input.start, label, input.scales)));
  const events: LabelEventDescriptor[] = raised ? [Object.freeze({ event: 'label.auto-raised' as const, from: input.start, to: applied, bases })] : [];
  return { ok: true, current: input.current, outcome, start: input.start, applied, proposal, bases, notify: raised, events: Object.freeze(events) };
}
