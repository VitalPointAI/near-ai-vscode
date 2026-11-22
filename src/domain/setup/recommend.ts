// Pure: no I/O, no clock, no vscode, no package.
import type { Mark } from '../gate/dominance';
import { labelKeyShownWithMarkings } from '../gate/labelAlgebra';
import type { Label } from '../gate/labels';
import type { UseTier } from '../gate/models';
import { decideRoute, strictestLabelOf, type RouteDecision, type RouteFacts, type RoutePolicy, type RoutingTable, type RoutingTier } from '../gate/routing';
import { fillSlots, type KindOfWorkAnswer } from './answers';
import type { OptionKind } from './ids';
import type { StopReason } from './records';
import { isChoosable, type ViabilityResult } from './viability';
import { MODEL_APPROVAL_NOTE_TEXT, NO_FIT_TEXT, OPTION_NAME_TEXT, RECOMMEND_REASON_TEXT, SMALLER_LOCAL_MODELS_TEXT } from './words';

export const RECOMMEND_REASONS = Object.freeze([
  'stays-in-canada', 'keeps-on-controlled-machines', 'larger-models', 'only-viable', 'order', 'no-option',
  'classified', 'protected-c', 'contract-unapproved',
] as const);
export type RecommendReason = (typeof RECOMMEND_REASONS)[number];

export const DEFAULT_OPTION_ORDER: readonly OptionKind[] = Object.freeze([
  'this-computer', 'org-server', 'org-tee', 'near-private', 'vendor-tee', 'vendor-region', 'near-all',
]);

export interface OptionInput {
  readonly optionId: string;
  readonly kind: OptionKind;
  readonly viability: ViabilityResult;
  readonly facts: RouteFacts;
  readonly fitsWork?: boolean;
}

export interface RecommendInput {
  readonly mark: Mark;
  readonly routing: RoutingTable;
  readonly defaultLabel: Label;
  readonly floor?: RoutingTier;
  readonly policy: RoutePolicy;
  readonly options: readonly OptionInput[];
  readonly use: UseTier;
  readonly kind?: KindOfWorkAnswer;
  readonly now: number;
  readonly order?: readonly OptionKind[];
  readonly contact: string;
  readonly stopped?: StopReason;
}

export interface OptionOutcome {
  readonly optionId: string;
  readonly kind: OptionKind;
  readonly outcome: 'recommended' | 'available' | 'ruled-out' | 'not-available';
  readonly decision?: RouteDecision;
  readonly refusal?: string;
  readonly note?: string;
}

export interface Recommendation {
  readonly state: 'recommended' | 'none' | 'stopped';
  readonly recommendedId?: string;
  readonly reasonId: RecommendReason;
  readonly reason: string;
  readonly options: readonly OptionOutcome[];
}

function evaluate(input: RecommendInput, option: OptionInput, stopText: string | undefined): OptionOutcome {
  const { optionId, kind } = option;
  if (!isChoosable(option.viability, input.now)) return { optionId, kind, outcome: 'not-available' };
  if (stopText !== undefined) return { optionId, kind, outcome: 'ruled-out', refusal: stopText };
  const decision = decideRoute(input.mark, input.routing, { ...option.facts, use: input.use }, input.defaultLabel, input.floor, input.policy);
  if (!decision.allowed) return { optionId, kind, outcome: 'ruled-out', decision, refusal: decision.reason };
  const notes: string[] = [];
  if (option.fitsWork === false) notes.push(SMALLER_LOCAL_MODELS_TEXT);
  if (decision.wouldRefuse?.includes('route.passport')) notes.push(MODEL_APPROVAL_NOTE_TEXT);
  return { optionId, kind, outcome: 'available', decision, ...(notes.length > 0 ? { note: notes.join(' ') } : {}) };
}

function controlledMachine(kind: OptionKind): boolean {
  return kind === 'this-computer' || kind === 'org-server';
}

// Group the gate's existing refusals for the explanation shown beside the winning card.
function labelRefusal(decision: RouteDecision | undefined): boolean {
  if (decision === undefined || decision.allowed) return false;
  switch (decision.rule) {
    case 'route.endpoint-ceiling':
    case 'route.authorization-missing':
    case 'route.this-computer-only':
      return true;
    case 'route.no-local-model':
    case 'route.local-host-not-local':
    case 'route.local-host-not-exact':
      return decision.tier === 'local-only';
    default:
      return false;
  }
}

export function recommend(input: RecommendInput): Recommendation {
  if (input.stopped !== undefined) {
    const reasonId = input.stopped;
    const reason = fillSlots(RECOMMEND_REASON_TEXT[reasonId], { contact: input.contact });
    return { state: 'stopped', reasonId, reason, options: input.options.map((option) => evaluate(input, option, reason)) };
  }

  const options = input.options.map((option) => evaluate(input, option, undefined));
  const available = options.filter((option) => option.outcome === 'available');
  const eligible = options.filter((option, index) => option.outcome === 'available' && input.options[index].fitsWork !== false);
  const winner = (input.order ?? DEFAULT_OPTION_ORDER)
    .map((kind) => eligible.find((option) => option.kind === kind))
    .find((option) => option !== undefined);
  let reasonId: RecommendReason = 'no-option';
  if (winner !== undefined) {
    const localOptions = options.filter((option) => option.kind === 'this-computer');
    if (controlledMachine(winner.kind) && options.some((option) => option.decision?.rule === 'route.residency')) {
      reasonId = 'stays-in-canada';
    } else if (controlledMachine(winner.kind) && options.some((option) => !controlledMachine(option.kind) && labelRefusal(option.decision))) {
      reasonId = 'keeps-on-controlled-machines';
    } else if (winner.kind === 'near-private' && !eligible.some((option) => option.kind === 'this-computer')
      && (localOptions.length === 0 || localOptions.some((option) => option.outcome !== 'ruled-out'))) {
      reasonId = 'larger-models';
    } else {
      reasonId = available.length === 1 ? 'only-viable' : 'order';
    }
  }
  const label = strictestLabelOf(input.mark, input.routing) ?? input.defaultLabel;
  const reasonText = winner === undefined && available.length > 0 && eligible.length === 0
    ? NO_FIT_TEXT
    : RECOMMEND_REASON_TEXT[reasonId];
  const reason = fillSlots(reasonText, {
    option: winner === undefined ? '' : OPTION_NAME_TEXT[winner.kind],
    label: labelKeyShownWithMarkings(label, input.policy.scales),
    contact: input.contact,
  });
  if (winner === undefined) return { state: 'none', reasonId, reason, options };
  return {
    state: 'recommended', recommendedId: winner.optionId, reasonId, reason,
    options: options.map((option) => option === winner ? { ...option, outcome: 'recommended' } : option),
  };
}
