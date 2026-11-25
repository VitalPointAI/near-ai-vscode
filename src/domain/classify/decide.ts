// What a classification proposal may do to a label (Phase 70.1, D-04 to D-15; research 3.1 to 3.3, 4.1). Pure: no I/O, no clock, no vscode, no package.
// Automatic steps may raise or keep; nothing is ever lowered here, whatever the confidence.
// `applied` is built only by folding labels into `start` with raiseMark (the join of dominance.ts), never by assigning a label, so no field can go down by
// construction. The caller passes `start` as the inherited join (the session's mark, the sources' labels, the project, folder or cell label); an empty
// start is refused, never read as the lowest level, so text such as "this document is unclassified" can only ever fail to raise.
// Floors (source, marking, guide, detector, compilation) apply with certainty in every mode (D-09, D-10). A model judgement raises only the level, through
// the bands of its signed threshold and only where the level is enforced (D-08, D-10); every other part of a judgement is a suggestion, and every lowering
// part is a suggestion naming who may decide it (D-04). A judgement for other content is stale and changes nothing (D-14). Anything above the system-high
// is a possible spill (D-13).
import type { ClassificationSection, ShadowMode } from '../gate/classificationSection';
import { systemHighOn, thresholdFor } from '../gate/classificationSection';
import { joinLabels, raiseMark, sameMark, whyNotDominated } from '../gate/dominance';
import type { Mark } from '../gate/dominance';
import { labelKey, levelIndex, scaleOf } from '../gate/labels';
import type { HandlingFlag, Label, ScaleMapping, ScaleTable } from '../gate/labels';
import type { Floor } from './markings';
import { PROPOSAL_OUTCOMES } from './record';
import type {
  Basis, Confidence, ExceptionKind, Fact, ItemRef, LevelDirection, LoweringDecider, ModelRef, ProposalOutcome, ProposalPart, ReleaseDirection, SetDirection,
  Suggestion, SuggestionReason
} from './record';
import { bands, effectiveThreshold, isBasisPoints } from './thresholds';
import type { AuditResult, EffectiveThreshold } from './thresholds';

/** The outcomes decide() gives: the record's outcomes (D-21). */
export const DECIDE_OUTCOMES = PROPOSAL_OUTCOMES;

/** Why decide() would not decide, each one plain sentence. */
export const DECIDE_REFUSALS = Object.freeze({
  'no-start': 'There is no starting label to raise from. A proposal only ever adds to the labels the content already inherits.',
  'unknown-label': 'A label names a level its scale does not have.',
  'bad-probability': 'A probability is not a whole number of basis points from 0 to 10000.'
} as const);
export type DecideRefusal = keyof typeof DECIDE_REFUSALS;

/** The fields of a label and the direction words of each (D-04). */
export const FIELD_DIRECTIONS = Object.freeze({
  level: Object.freeze(['up', 'same', 'down'] as const),
  compartments: Object.freeze(['added', 'removed', 'both', 'same'] as const),
  releasability: Object.freeze(['narrowed', 'widened', 'both', 'same'] as const),
  handling: Object.freeze(['added', 'removed', 'both', 'same'] as const)
});

/** The handling flags a possible spill adds (D-13). */
const SPILL_FLAGS: readonly HandlingFlag[] = Object.freeze(['local-only', 'no-agent-tools'] as const);

/** The events decide() names (D-15); the caller records each with buildDecisionRecord. */
export type DecideEventId = 'label.auto-raised' | 'label.exception-queued' | 'label.could-be-lower';

/** A label event to record: `from` is the mark before, `to` the mark after; `exception` names the queued kind; `suggestions` the lowering ones. */
export interface LabelEventDescriptor {
  readonly event: DecideEventId;
  readonly from: Mark;
  readonly to: Mark;
  readonly bases: readonly Basis[];
  readonly exception?: ExceptionKind;
  readonly suggestions?: readonly Suggestion[];
}

/**
 * A model's answer as the engine reads it (74.3 builds it from the closed JSON answer). No rationale text: the caller keeps it, at the item's label, and
 * passes its SHA-256 as the judgement basis ref. Probabilities are calibrated, cumulative ("the true level is at least this one"), in basis points, keyed by
 * `scale/level`. The model's own stated confidence is never an input.
 */
export interface Judgement {
  readonly contentHash: string;
  /** The model's proposed label per scale. */
  readonly proposal: readonly Label[];
  readonly probabilities: Readonly<Record<string, number>>;
  readonly calibration: string;
  readonly sampleAgreement: number;
  readonly secondFamilyAgreement?: number;
  readonly facts: readonly Fact[];
  readonly rationaleHash: string;
  readonly model: ModelRef;
}

export interface DecideInput {
  /** The inherited join (D-05). Never empty. */
  readonly start: Mark;
  /** The item as it is now (D-14). */
  readonly current: ItemRef;
  /** Floors found by the deterministic checks (D-09). */
  readonly floors: readonly Floor[];
  readonly judgement?: Judgement;
  readonly section: ClassificationSection;
  /** The policy's scales (labels.scales). */
  readonly scales: ScaleTable;
  /** The policy's approved scale mappings (labels.mappings), for the system-high check (D-13). */
  readonly mappings?: readonly ScaleMapping[];
  /**
   * The caller's hold per `scale/level` (74.3's shadow period). It can only keep a level in shadow: a level is enforced only when the signed section
   * enforces it (D-17) and the caller does not hold it.
   */
  readonly modes?: Readonly<Record<string, ShadowMode>>;
  /** Blind-audit history per `scale/level`, oldest first (D-12). */
  readonly history?: Readonly<Record<string, readonly AuditResult[]>>;
}

export interface Decision {
  readonly ok: true;
  readonly current: ItemRef;
  readonly outcome: ProposalOutcome;
  readonly start: Mark;
  readonly applied: Mark;
  readonly proposal: readonly ProposalPart[];
  readonly bases: readonly Basis[];
  readonly suggestions: readonly Suggestion[];
  readonly exceptions: readonly { readonly kind: ExceptionKind }[];
  /** The judgement's confidence as the record keeps it, or null with no judgement. */
  readonly confidence: Confidence | null;
  /** True when a raise applied: the caller tells the originator or steward at once (D-11). */
  readonly notify: boolean;
  /** True on a possible spill: the item is frozen for sharing until a person resolves it (D-13). */
  readonly freeze: boolean;
  readonly events: readonly LabelEventDescriptor[];
}

export type DecideResult = { readonly ok: false; readonly refusal: DecideRefusal; readonly message: string } | Decision;

function refuse(refusal: DecideRefusal): DecideResult {
  return { ok: false, refusal, message: DECIDE_REFUSALS[refusal] };
}

function known(label: Label, scales: ScaleTable): boolean {
  return levelIndex(scales, label.scale, label.level) >= 0;
}

function byKey(a: Label, b: Label): number {
  return labelKey(a) < labelKey(b) ? -1 : labelKey(a) > labelKey(b) ? 1 : 0;
}

function bare(scale: string, level: string): Label {
  return Object.freeze({ scale, level, compartments: Object.freeze([]), releasability: Object.freeze([]), handling: Object.freeze([]) });
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

/** The proposed label per scale: the join of every floor and the judgement's label on that scale, in a mark's order. */
function proposedLabels(labels: readonly Label[], scales: ScaleTable): readonly Label[] {
  const byScale = new Map<string, Label>();
  for (const label of labels) {
    const held = byScale.get(label.scale);
    byScale.set(label.scale, held === undefined ? label : (joinLabels(held, label, scales) ?? held));
  }
  return [...byScale.values()].sort(byKey);
}

function uniqueBases(bases: readonly Basis[]): readonly Basis[] {
  const seen = new Set<string>();
  const out: Basis[] = [];
  for (const basis of bases) {
    const key = `${basis.kind} ${basis.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(basis);
  }
  return Object.freeze(out);
}

/** Enforced only when the signed section enforces the level and the caller does not hold it in shadow (D-10, D-17). */
function enforced(key: string, input: DecideInput): boolean {
  const own = input.modes !== undefined && Object.prototype.hasOwnProperty.call(input.modes, key) ? input.modes[key] : undefined;
  const signed = input.section.shadow.defaultMode === 'enforce' || input.section.shadow.levels.includes(key);
  return signed && own !== 'shadow';
}

function thresholdsOf(scale: string, input: DecideInput): Record<string, EffectiveThreshold | undefined> {
  const out: Record<string, EffectiveThreshold | undefined> = {};
  for (const level of scaleOf(input.scales, scale)?.levels ?? []) {
    const entry = thresholdFor(input.section, { scale, level });
    if (entry === undefined) continue;
    const key = labelKey({ scale, level });
    const history = input.history !== undefined && Object.prototype.hasOwnProperty.call(input.history, key) ? input.history[key] : undefined;
    out[level] = effectiveThreshold(entry.costRatio, history ?? []);
  }
  return out;
}

function suggestion(label: Label, reason: SuggestionReason, decidedBy?: LoweringDecider): Suggestion {
  return Object.freeze(decidedBy === undefined ? { label, reason } : { label, reason, decidedBy });
}

function withField(base: Label, field: Partial<Pick<Label, 'level' | 'compartments' | 'releasability' | 'handling'>>): Label {
  return Object.freeze({ ...base, ...field });
}

interface JudgementParts {
  readonly raises: readonly Label[];
  readonly predicted: readonly Label[];
  readonly suggestions: readonly Suggestion[];
}

/**
 * One judgement read against the start (D-04, D-07 to D-10): the level raise it may apply, the levels it predicts at the raise band (for the system-high
 * check, whatever the mode), and every other part as a suggestion.
 */
function judgementParts(judgement: Judgement, input: DecideInput): JudgementParts {
  const raises: Label[] = [];
  const predicted: Label[] = [];
  const suggestions: Suggestion[] = [];
  for (const proposed of judgement.proposal) {
    const scale = scaleOf(input.scales, proposed.scale);
    if (scale === undefined) continue;
    const probabilities: Record<string, number> = {};
    for (const level of scale.levels) {
      const key = labelKey({ scale: proposed.scale, level });
      if (Object.prototype.hasOwnProperty.call(judgement.probabilities, key)) probabilities[level] = judgement.probabilities[key] as number;
    }
    const thresholds = thresholdsOf(proposed.scale, input);
    const band = bands(scale.levels, probabilities, thresholds);
    const held = input.start.find((label) => label.scale === proposed.scale);
    const heldRank = held === undefined ? -1 : levelIndex(input.scales, held.scale, held.level);
    const base = held ?? bare(proposed.scale, proposed.level);
    if (band.raiseTo !== undefined && levelIndex(input.scales, proposed.scale, band.raiseTo) > heldRank) {
      const target = bare(proposed.scale, band.raiseTo);
      predicted.push(target);
      if (enforced(labelKey(target), input)) raises.push(target);
      else suggestions.push(suggestion(withField(base, { level: band.raiseTo }), 'shadow'));
    }
    if (band.suggest !== undefined && levelIndex(input.scales, proposed.scale, band.suggest) > heldRank) {
      suggestions.push(suggestion(withField(base, { level: band.suggest }), 'band'));
    }
    const proposedRank = levelIndex(input.scales, proposed.scale, proposed.level);
    const bandRank = Math.max(band.raiseTo === undefined ? -1 : levelIndex(input.scales, proposed.scale, band.raiseTo),
      band.suggest === undefined ? -1 : levelIndex(input.scales, proposed.scale, band.suggest));
    if (proposedRank > heldRank && proposedRank > bandRank && thresholdFor(input.section, proposed) === undefined) {
      suggestions.push(suggestion(withField(base, { level: proposed.level }), 'no-threshold'));
    }
    if (held === undefined) {
      // A new scale: everything the judgement adds there beyond the level is a suggestion.
      if (proposed.compartments.length > 0 || proposed.releasability.length > 0 || proposed.handling.length > 0) suggestions.push(suggestion(proposed, 'judgement-only'));
      continue;
    }
    if (proposedRank < heldRank) suggestions.push(suggestion(withField(held, { level: proposed.level }), 'could-be-lower', 'classification-authority'));
    const addedCompartments = proposed.compartments.filter((token) => !held.compartments.includes(token));
    const removedCompartments = held.compartments.filter((token) => !proposed.compartments.includes(token));
    if (addedCompartments.length > 0) suggestions.push(suggestion(withField(held, { compartments: Object.freeze([...held.compartments, ...addedCompartments].sort()) }), 'judgement-only'));
    if (removedCompartments.length > 0) suggestions.push(suggestion(withField(held, { compartments: held.compartments.filter((token) => proposed.compartments.includes(token)) }), 'could-be-lower', 'compartment-owner'));
    const release = releaseDirection(held.releasability, proposed.releasability);
    if (release === 'narrowed' || release === 'both') {
      const narrowed = joinLabels(held, withField(held, { releasability: proposed.releasability }), input.scales);
      if (narrowed !== undefined) suggestions.push(suggestion(narrowed, 'judgement-only'));
    }
    if (release === 'widened' || release === 'both') suggestions.push(suggestion(withField(held, { releasability: proposed.releasability }), 'wider-release', 'release-authority'));
    const addedHandling = proposed.handling.filter((flag) => !held.handling.includes(flag));
    const removedHandling = held.handling.filter((flag) => !proposed.handling.includes(flag));
    if (addedHandling.length > 0) suggestions.push(suggestion(withField(held, { handling: Object.freeze([...held.handling, ...addedHandling].sort()) }), 'judgement-only'));
    if (removedHandling.length > 0) suggestions.push(suggestion(withField(held, { handling: held.handling.filter((flag) => proposed.handling.includes(flag)) }), 'could-be-lower', 'steward'));
  }
  return { raises, predicted, suggestions };
}

/**
 * Whether a label is within the system-high (D-13): a system-high label on its scale is at least it, or an approved mapping covers it, by the one mapping
 * rule clearance dominance uses (whyNotDominated, scale and level only). With no systemHigh in the section, everything is within.
 */
export function withinSystemHigh(label: Label, section: ClassificationSection, scales: ScaleTable, mappings: readonly ScaleMapping[] = []): boolean {
  if (section.systemHigh === undefined) return true;
  return section.systemHigh.some((high) => {
    const reason = whyNotDominated({ scale: high.scale, level: high.level, compartments: [], releasability: [] }, label, { scales, mappings, now: 0 });
    return reason !== 'scale' && reason !== 'level';
  });
}

/** Every label of the mark gains the spill flags, through the join. */
function withSpillFlags(mark: Mark, scales: ScaleTable): Mark {
  let out = mark;
  for (const label of mark) out = raiseMark(out, withField(label, { handling: Object.freeze([...SPILL_FLAGS]) }), scales);
  return out;
}

function rankOf(mark: Mark, scale: string, scales: ScaleTable): number {
  const held = mark.find((label) => label.scale === scale);
  return held === undefined ? -1 : levelIndex(scales, held.scale, held.level);
}

/** A raise by more than review.jumpLevels levels on a scale the start holds, or to a scale's top level when review.topLevel, also goes to review (D-11). */
function largeRaise(start: Mark, applied: Mark, input: DecideInput): boolean {
  return applied.some((label) => {
    const levels = scaleOf(input.scales, label.scale)?.levels ?? [];
    const to = levelIndex(input.scales, label.scale, label.level);
    const from = rankOf(start, label.scale, input.scales);
    if (to <= from) return false;
    if (from >= 0 && to - from > input.section.review.jumpLevels) return true;
    return input.section.review.topLevel && to === levels.length - 1;
  });
}

function confidenceOf(judgement: Judgement): Confidence {
  const base = { levels: Object.freeze({ ...judgement.probabilities }), calibration: judgement.calibration, sampleAgreement: judgement.sampleAgreement };
  return Object.freeze(judgement.secondFamilyAgreement === undefined ? base : { ...base, secondFamilyAgreement: judgement.secondFamilyAgreement });
}

function judgementValid(judgement: Judgement, scales: ScaleTable): DecideRefusal | undefined {
  if (!judgement.proposal.every((label) => known(label, scales))) return 'unknown-label';
  const numbers = [...Object.values(judgement.probabilities), judgement.sampleAgreement, ...(judgement.secondFamilyAgreement === undefined ? [] : [judgement.secondFamilyAgreement])];
  return numbers.every(isBasisPoints) ? undefined : 'bad-probability';
}

const LOWERING: readonly SuggestionReason[] = Object.freeze(['could-be-lower', 'wider-release']);

/**
 * Decides one proposal. Refuses an empty start (`no-start`), a label whose level is unknown (`unknown-label`) and a probability outside whole basis points
 * (`bad-probability`). A judgement for other content is `stale`. Otherwise the floors and the judgement's enforced level raise are folded into the start;
 * anything above the system-high gives `possible-spill`; a raise gives `auto-raised`; a raising suggestion gives `suggested`; a floor or judgement that
 * found nothing above the start gives `kept`; nothing at all gives `none`.
 */
export function decide(input: DecideInput): DecideResult {
  if (input.start.length === 0) return refuse('no-start');
  if (!input.start.every((label) => known(label, input.scales)) || !input.floors.every((floor) => known(floor.label, input.scales))) return refuse('unknown-label');
  const judgement = input.judgement;
  if (judgement !== undefined) {
    const invalid = judgementValid(judgement, input.scales);
    if (invalid !== undefined) return refuse(invalid);
  }
  const confidence = judgement === undefined ? null : confidenceOf(judgement);
  const empty = Object.freeze([]);
  if (judgement !== undefined && judgement.contentHash !== input.current.contentHash) {
    return {
      ok: true, current: input.current, outcome: 'stale', start: input.start, applied: input.start, proposal: empty, bases: empty, suggestions: empty,
      exceptions: empty, confidence, notify: false, freeze: false, events: empty
    };
  }
  const parts = judgement === undefined ? { raises: [], predicted: [], suggestions: [] } : judgementParts(judgement, input);
  const bases = uniqueBases([...input.floors.map((floor) => floor.basis), ...(judgement === undefined ? [] : [{ kind: 'judgement' as const, ref: judgement.rationaleHash }])]);
  const proposal = Object.freeze(proposedLabels([...input.floors.map((floor) => floor.label), ...(judgement?.proposal ?? [])], input.scales)
    .map((label) => partOf(input.start, label, input.scales)));
  const mappings = input.mappings ?? [];
  const raises = [...input.floors.map((floor) => floor.label), ...parts.raises];
  const over = [...raises, ...parts.predicted].filter((label) => !withinSystemHigh(label, input.section, input.scales, mappings));
  const exceptions: ExceptionKind[] = [];
  let applied: Mark = input.start;
  for (const label of raises) if (withinSystemHigh(label, input.section, input.scales, mappings)) applied = raiseMark(applied, label, input.scales);
  const spill = over.length > 0;
  if (spill) {
    const highs = input.section.systemHigh ?? [];
    for (const label of over) {
      const high = systemHighOn(input.section, label.scale);
      for (const cap of high === undefined ? highs : [high]) applied = raiseMark(applied, cap, input.scales);
    }
    applied = withSpillFlags(applied, input.scales);
    exceptions.push('possible-spill');
  }
  const raised = !sameMark(applied, input.start);
  if (raised && largeRaise(input.start, applied, input)) exceptions.unshift('large-raise');
  const suggestions = Object.freeze(parts.suggestions);
  const lowering = suggestions.filter((entry) => LOWERING.includes(entry.reason));
  const raising = suggestions.length > lowering.length;
  const outcome: ProposalOutcome = spill ? 'possible-spill' : raised ? 'auto-raised' : raising ? 'suggested'
    : input.floors.length > 0 || judgement !== undefined ? 'kept' : 'none';
  const events: LabelEventDescriptor[] = [];
  if (raised) events.push(Object.freeze({ event: 'label.auto-raised' as const, from: input.start, to: applied, bases }));
  for (const kind of exceptions) events.push(Object.freeze({ event: 'label.exception-queued' as const, from: input.start, to: applied, bases, exception: kind }));
  if (lowering.length > 0) events.push(Object.freeze({ event: 'label.could-be-lower' as const, from: input.start, to: applied, bases, suggestions: Object.freeze(lowering) }));
  return {
    ok: true, current: input.current, outcome, start: input.start, applied, proposal, bases, suggestions,
    exceptions: Object.freeze(exceptions.map((kind) => Object.freeze({ kind }))), confidence, notify: raised, freeze: spill, events: Object.freeze(events)
  };
}
