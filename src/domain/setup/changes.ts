import { dominates, type DominanceContext } from '../gate/dominance';
import { labelKeyShownWithMarkings } from '../gate/labelAlgebra';
import { CLEARANCE_SELF_ASSERTED_TEXT, type Clearance, type Label, type ScaleTable } from '../gate/labels';
import type { ModeId } from '../org/modes';
import { fillSlots, type GuideAnswers, type SetupGuideEntry, type YES_NO_UNSURE } from './answers';
import { parseOptionId, type OptionKind } from './ids';
import { raiseOnly, type LabelProposal } from './map';
import { EXERCISE_REASON_TEXT } from './landing';
import { modeRowOf, type ModeSuggestion } from './modes';
import type { ApplyReport as RecordedApplyReport, ApplyStepReport as RecordedApplyStep } from './records';
import { KEPT_HIGHER_TEXT, LOWERING_SEPARATE_TEXT, OPTION_NAME_TEXT } from './words';

export type YesNoUnsure = (typeof YES_NO_UNSURE)[number];
export type { LabelProposal } from './map';

export interface ChangeItem {
  readonly id: string;
  readonly group: 'added' | 'changed' | 'removed';
  readonly area: 'label' | 'connection' | 'project-rules' | 'mode' | 'exercise' | 'your-rules' | 'answers';
  readonly text: string;
  readonly effect: 'apply' | 'kept' | 'waits' | 'proposal' | 'already';
  readonly answersCompared?: true;
  readonly waitsFor?: 'lower-label-flow' | 'rules-change' | 'shared-project';
}

export interface ApplyStepReport extends Omit<RecordedApplyStep, 'outcome'> {
  readonly outcome: RecordedApplyStep['outcome'] | 'already-done' | 'proposal-opened';
  readonly proposalOutcome?: 'applied' | 'exported' | 'discarded' | 'replaced';
}

export interface ApplyReport extends Omit<RecordedApplyReport, 'steps'> {
  readonly steps: readonly ApplyStepReport[];
}

export interface ChangeInput {
  readonly current: {
    readonly label?: Label;
    readonly answers?: GuideAnswers;
    readonly mode?: ModeId;
    readonly exercise?: boolean;
    readonly residency?: readonly string[];
    readonly locked?: readonly string[];
    readonly connection?: string;
  };
  readonly proposal: LabelProposal;
  readonly requestedLabel?: Label;
  readonly answers?: GuideAnswers;
  readonly chosenIds?: readonly string[];
  readonly chosen: readonly OptionKind[];
  readonly mode: ModeSuggestion;
  readonly exercise: { readonly exercise: boolean; readonly reason?: string };
  readonly canada?: YesNoUnsure;
  readonly residencyBySetting: 'project' | 'already';
  readonly clearances: readonly Clearance[];
  readonly dominance: DominanceContext;
  readonly shared: boolean;
  readonly proposals: readonly { readonly id: string; readonly text: string }[];
  readonly scales: ScaleTable;
  readonly earlierLocality?: string;
}

export const CHANGE_TEXT = Object.freeze({
  labelAdded: 'Project label: set to {label}.',
  labelRaised: 'Project label: raised from {from} to {label}.',
  connectionAdded: 'AI services: add {option}.',
  connectionRemoved: 'AI services: remove {option}. Requests that use this connection will stop working.',
  clearance: 'Your rules: add your clearance for {label} (declared by you)',
  clearanceExplanation: CLEARANCE_SELF_ASSERTED_TEXT,
  waitsForRules: '{change} Waits for your rules change.',
  waitsForShared: '{change} Waits for the next update: shared project settings.',
  canada: 'This project: work must stay in Canada.',
  canadaAlready: 'Work must stay in Canada. Set by your organization.',
  mode: 'Project mode: {name}. To bring in another person, choose {join}.',
  answers: 'Setup answers: save your answers for this project.',
  earlierLocality: 'Your earlier answer: {answer}. It no longer decides where requests go.',
  locality: { local: 'local AI only', cloud: 'cloud AI', hybrid: 'local and cloud AI' },
});

function projectChange(item: ChangeItem, shared: boolean): ChangeItem {
  if (!shared || item.effect !== 'apply') return item;
  return { ...item, effect: 'waits', waitsFor: 'shared-project',
    text: fillSlots(CHANGE_TEXT.waitsForShared, { change: item.text }) };
}

function labelChanges(input: ChangeInput): readonly ChangeItem[] {
  const { current, proposal, requestedLabel, scales } = input;
  const proposed = requestedLabel ?? proposal.proposed;
  // Reuse the same raise-only comparison used to make the proposal. An older or inconsistent
  // proposal cannot turn a lower label into an Apply action.
  const checked = raiseOnly(current.label, { proposed, column: 'org', notSure: false, allowedWhileStopped: [] }, scales);
  const group = current.label ? 'changed' : 'added';
  if (checked.outcome === 'keep-higher' && (requestedLabel || proposal.outcome === 'raise')) {
    return [{ id: 'label', group, area: 'label', effect: 'waits', waitsFor: 'lower-label-flow', text: LOWERING_SEPARATE_TEXT }];
  }
  if (proposal.outcome === 'keep-higher' && current.label) {
    const label = labelKeyShownWithMarkings(current.label, scales);
    return [{ id: 'label', group, area: 'label', effect: 'kept', text: fillSlots(KEPT_HIGHER_TEXT, { label }) }];
  }
  if (proposal.outcome !== 'raise' || checked.outcome !== 'raise') return [];

  const label = labelKeyShownWithMarkings(checked.proposed, scales);
  const text = current.label === undefined
    ? fillSlots(CHANGE_TEXT.labelAdded, { label })
    : fillSlots(CHANGE_TEXT.labelRaised, { from: labelKeyShownWithMarkings(current.label, scales), label });
  const item: ChangeItem = { id: 'label', group, area: 'label', effect: 'apply', text };
  if (input.shared) return [projectChange(item, true)];
  if (input.clearances.some((clearance) => dominates(clearance, checked.proposed, input.dominance))) return [item];
  return [
    { ...item, effect: 'waits', waitsFor: 'rules-change', text: fillSlots(CHANGE_TEXT.waitsForRules, { change: text }) },
    { id: 'your-rules:clearance', group: 'added', area: 'your-rules', effect: 'proposal', text: fillSlots(CHANGE_TEXT.clearance, { label }) },
  ];
}

function connectionChanges(input: ChangeInput): readonly ChangeItem[] {
  const active = parseOptionId(input.current.connection);
  const chosen = new Set(input.chosenIds ?? input.chosen);
  const items: ChangeItem[] = [];
  for (const id of chosen) {
    const option = parseOptionId(id);
    if (!option || id === input.current.connection) continue;
    if (input.chosenIds === undefined && option.kind === active?.kind) continue;
    items.push({
      id: `connection:${id}`, group: 'added', area: 'connection', effect: 'apply',
      text: fillSlots(CHANGE_TEXT.connectionAdded, { option: OPTION_NAME_TEXT[option.kind] }),
    });
  }
  if (input.current.connection && active && items.length > 0 &&
      !chosen.has(input.current.connection) && (input.chosenIds !== undefined || !chosen.has(active.kind))) {
    items.push({
      id: `connection:${input.current.connection}`, group: 'removed', area: 'connection', effect: 'apply',
      text: fillSlots(CHANGE_TEXT.connectionRemoved, { option: OPTION_NAME_TEXT[active.kind] }),
    });
  }
  return items;
}

export function sameGuideAnswers(left: GuideAnswers, right: GuideAnswers): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof GuideAnswers>;
  return left.data.length === right.data.length && left.data.every((answer) => right.data.includes(answer)) &&
    [...keys].every((key) => key === 'data' || left[key] === right[key]);
}

export function changeList(input: ChangeInput): readonly ChangeItem[] {
  const { current, canada, mode, exercise, earlierLocality } = input;
  const items: ChangeItem[] = [...labelChanges(input), ...connectionChanges(input)];
  const addProject = (item: ChangeItem) => items.push(projectChange(item, input.shared));
  if (canada === 'yes' || canada === 'not-sure') {
    const already = input.residencyBySetting === 'already';
    const currentOnlyCanada = current.residency?.length === 1 && current.residency[0] === 'CA';
    const item: ChangeItem = {
      id: 'project-rules', group: 'changed', area: 'project-rules', text: already ? CHANGE_TEXT.canadaAlready : CHANGE_TEXT.canada,
      effect: already || currentOnlyCanada ? 'kept' : 'apply',
    };
    const incompatible = !already && current.residency !== undefined && !current.residency.includes('CA');
    addProject(incompatible
      ? { ...item, effect: 'waits', waitsFor: 'rules-change', text: fillSlots(CHANGE_TEXT.waitsForRules, { change: item.text }) }
      : item);
  }
  if (current.mode !== mode.mode && mode.source !== 'set-by-project') {
    const { name, join } = modeRowOf(mode);
    addProject({ id: 'mode', group: 'changed', area: 'mode', effect: 'apply', text: fillSlots(CHANGE_TEXT.mode, { name, join }) });
  }
  if (exercise.exercise || current.exercise) {
    addProject({
      id: 'exercise', group: 'changed', area: 'exercise', effect: current.exercise ? 'kept' : 'apply',
      text: exercise.reason ?? EXERCISE_REASON_TEXT,
    });
  }
  for (const { id, text } of input.proposals) {
    const itemId = `your-rules:${id}`;
    if (items.some((item) => item.id === itemId)) continue;
    items.push({ id: itemId, group: 'added', area: 'your-rules', effect: 'proposal', text });
  }

  const answersUnchanged = input.answers !== undefined && current.answers !== undefined && sameGuideAnswers(current.answers, input.answers);
  addProject({
    id: 'answers', group: 'changed', area: 'answers', effect: answersUnchanged ? 'already' : 'apply', text: CHANGE_TEXT.answers,
    ...(input.answers === undefined ? {} : { answersCompared: true }),
  });
  if (earlierLocality === 'local' || earlierLocality === 'cloud' || earlierLocality === 'hybrid') {
    items.push({
      id: 'earlier-locality', group: 'changed', area: 'answers', effect: 'kept',
      text: fillSlots(CHANGE_TEXT.earlierLocality, { answer: CHANGE_TEXT.locality[earlierLocality] }),
    });
  }
  return items;
}

export function rerunDiff(previous: SetupGuideEntry | undefined, items: readonly ChangeItem[]): readonly ChangeItem[] {
  if (!previous || (!previous.appliedAt && !previous.recordId && previous.pending.length === 0)) return items;
  const material = items.some(({ id, effect }) => id !== 'answers' && effect !== 'kept' && effect !== 'already');
  return items.filter(({ id, effect, answersCompared }) => {
    if (id === 'earlier-locality') return false;
    if (previous.pending.includes(id)) return effect !== 'already' && effect !== 'kept';
    if (effect === 'kept' || effect === 'already') return false;
    // Current mode, connections, residency and label are already diffed against the
    // effective settings. A previous record never overrides fresher observations.
    return id !== 'answers' || answersCompared === true || material;
  });
}

export function remainingAfter(report: ApplyReport, items: readonly ChangeItem[]): readonly ChangeItem[] {
  const pending = new Set(report.steps.filter(applyStepPending).map(({ id }) => id));
  return items.filter(({ id }) => pending.has(id));
}

export function applyStepPending({ outcome, proposalOutcome }: ApplyStepReport): boolean {
  return outcome === 'failed' || outcome === 'waiting' || (outcome === 'proposal-opened' && proposalOutcome !== 'applied');
}
