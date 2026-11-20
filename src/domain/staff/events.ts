// The staff events and read models the UI consumes (design 10, 4.5; UX concept 4.1 and 12.5; WP-0). Types and small pure mappers only: no I/O, no clock,
// no vscode. The host builds the read models from these events and the `staff-products` registers; the Staff Room page draws them and never decides
// state. Every event carries the run and the time it happened, so a page rebuilt after a reload replays to the same picture.
import type { CrosswalkStep, StaffLevel, StaffNation, StaffProfileId, StaffSectionId } from './doctrine';
import type { StaffWriter } from './ownership';
import type { ProductKind } from './products';
import type { PersonActor, ReleaseState, StaffActor, StaffGate, TransitionRecord } from './release';

export const STAFF_EVENT_TYPES = [
  'staff.step.entered',
  'staff.lane.started', 'staff.lane.finished', 'staff.lane.switched',
  'staff.merge.started', 'staff.merge.conflict', 'staff.merge.resolved',
  'staff.product.state',
  'staff.gate.verdict',
  'staff.decision.requested', 'staff.decision.recorded',
  'staff.rfi.opened', 'staff.rfi.answered', 'staff.rfi.overdue',
  'staff.ccir.triggered',
  'staff.cop.updated',
  'staff.team.nested',
  'staff.waiting',
  'staff.wargame.turn'
] as const;
export type StaffEventType = (typeof STAFF_EVENT_TYPES)[number];

/** The states of one team reference in a team-of-teams run (design 10, 5.4); the machine itself is WP-TOT's. */
export const NESTED_TEAM_STATES = [
  'requested', 'resolving', 'refused', 'awaiting-consent', 'ready', 'queued', 'running', 'waiting', 'reporting', 'merging', 'conflict', 'done', 'cancelled', 'failed'
] as const;
export type NestedTeamState = (typeof NESTED_TEAM_STATES)[number];

export type LaneStatus = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';
export type LaneOutcome = 'done' | 'failed' | 'cancelled';
export type StepRole = 'primary' | 'supporting';
export type WargamePhase = 'action' | 'reaction' | 'counteraction';
export type WargameSide = 'friendly' | 'adversary';

interface EventBase<T extends StaffEventType> {
  readonly type: T;
  readonly run: string;
  /** `YYYY-MM-DDTHH:MM:SS.sssZ`, the gate's one time form. */
  readonly at: string;
}

export interface StepEnteredEvent extends EventBase<'staff.step.entered'> { readonly section: StaffSectionId; readonly step: CrosswalkStep; readonly stepName: string | null }
export interface LaneStartedEvent extends EventBase<'staff.lane.started'> { readonly section: StaffSectionId; readonly member: string; readonly product?: string }
/** `reason`: why a lane failed, in words ("GLM 5.3 is overloaded at NEAR AI"), when it failed and the reason is known. */
export interface LaneFinishedEvent extends EventBase<'staff.lane.finished'> { readonly section: StaffSectionId; readonly member: string; readonly product?: string; readonly outcome: LaneOutcome; readonly reason?: string }
/** A member moved to its next model, overloaded or silent at NEAR AI (owner's D-48 run); `from` and `to` are the models' names in words. */
export interface LaneSwitchedEvent extends EventBase<'staff.lane.switched'> { readonly section: StaffSectionId; readonly member: string; readonly from: string; readonly to: string; readonly reason: string }
interface MergeFields { readonly section: StaffSectionId; readonly branches: readonly string[]; readonly files: readonly string[] }
export interface MergeStartedEvent extends EventBase<'staff.merge.started'>, MergeFields {}
export interface MergeConflictEvent extends EventBase<'staff.merge.conflict'>, MergeFields {}
export interface MergeResolvedEvent extends EventBase<'staff.merge.resolved'>, MergeFields { readonly resolvedBy: StaffActor }
export interface ProductStateEvent extends EventBase<'staff.product.state'>, TransitionRecord {}
export interface GateVerdictEvent extends EventBase<'staff.gate.verdict'> {
  readonly product: string; readonly version: number; readonly gate: StaffGate; readonly verdict: string; readonly reasons: readonly string[]
}
export interface DecisionRequestedEvent extends EventBase<'staff.decision.requested'> { readonly product: string; readonly version: number; readonly role: string }
export interface DecisionRecordedEvent extends EventBase<'staff.decision.recorded'> {
  readonly product: string; readonly version: number; readonly role: string; readonly person: PersonActor; readonly decision: 'approved' | 'rejected' | 'released' | 'superseded'
}
interface RfiFields { readonly rfi: string; readonly from: StaffSectionId; readonly to: StaffSectionId | 'higher'; readonly suspense: string }
export interface RfiOpenedEvent extends EventBase<'staff.rfi.opened'>, RfiFields {}
export interface RfiAnsweredEvent extends EventBase<'staff.rfi.answered'>, RfiFields {}
export interface RfiOverdueEvent extends EventBase<'staff.rfi.overdue'>, RfiFields {}
export interface CcirTriggeredEvent extends EventBase<'staff.ccir.triggered'> { readonly ccir: string; readonly report: string; readonly member: string; readonly time: string }
export interface CopUpdatedEvent extends EventBase<'staff.cop.updated'> { readonly layer: string; readonly owner: StaffWriter; readonly featureCount: number; readonly summary: string }
export interface TeamNestedEvent extends EventBase<'staff.team.nested'> { readonly parentRun: string; readonly childRun: string; readonly team: string; readonly state: NestedTeamState }
export interface WaitingEvent extends EventBase<'staff.waiting'> {
  readonly section: StaffSectionId; readonly member: string; readonly waitingOn: StaffSectionId | 'human'; readonly what: string
}

/** One unit move in a wargame turn: the unit, its side, its path (layer coordinates), and its symbol identification code when it has one. */
export interface WargameMove { readonly unit: string; readonly side: WargameSide; readonly path: ReadonlyArray<readonly [number, number]>; readonly sidc?: string }

/** One phase of one wargame turn (UX concept 12.5), so the wargame view and replay need no parsing of the ledger file. */
export interface WargameTurnEvent extends EventBase<'staff.wargame.turn'> {
  readonly coa: string;
  readonly enemyCoa: string;
  readonly turn: number;
  readonly phase: WargamePhase;
  /** The wargame clock for this phase, as an offset from H-hour in minutes (negative before H-hour). */
  readonly hHourOffsetMinutes: number;
  readonly moves: readonly WargameMove[];
  readonly results: readonly string[];
  readonly decisionPoints: readonly string[];
}

export type StaffEvent =
  | StepEnteredEvent | LaneStartedEvent | LaneFinishedEvent | LaneSwitchedEvent
  | MergeStartedEvent | MergeConflictEvent | MergeResolvedEvent
  | ProductStateEvent | GateVerdictEvent
  | DecisionRequestedEvent | DecisionRecordedEvent
  | RfiOpenedEvent | RfiAnsweredEvent | RfiOverdueEvent
  | CcirTriggeredEvent | CopUpdatedEvent | TeamNestedEvent | WaitingEvent | WargameTurnEvent;

/**
 * The events one state machine step produces, in order: always `staff.product.state`; a gate verdict also gives `staff.gate.verdict`; a submit gives
 * `staff.decision.requested`; a person's approve, reject, release or supersede gives `staff.decision.recorded`. One event per transition, never two of a kind.
 */
export function eventsForTransition(run: string, at: string, transition: TransitionRecord, detail: { readonly gate?: StaffGate; readonly verdict?: string; readonly decisionFor?: string } = {}): StaffEvent[] {
  const events: StaffEvent[] = [{ type: 'staff.product.state', run, at, ...transition }];
  const base = { run, at, product: transition.product, version: transition.version };
  if (transition.event === 'verdict' && detail.gate && detail.verdict) {
    events.push({ type: 'staff.gate.verdict', ...base, gate: detail.gate, verdict: detail.verdict, reasons: transition.reasons ?? [] });
  }
  if (transition.event === 'submit' && detail.decisionFor) events.push({ type: 'staff.decision.requested', ...base, role: detail.decisionFor });
  const decided: Partial<Record<TransitionRecord['event'], DecisionRecordedEvent['decision']>> = { approve: 'approved', reject: 'rejected', release: 'released', supersede: 'superseded' };
  const decision = decided[transition.event];
  if (decision && transition.actor.kind === 'person') {
    events.push({ type: 'staff.decision.recorded', ...base, role: detail.decisionFor ?? transition.actor.role, person: transition.actor, decision });
  }
  return events;
}

// ---- Read models (design 10, 4.5) -----------------------------------------------------------------------------------------------------------

export interface StaffRunModel {
  readonly run: string;
  /** The team, or the team-of-teams tree: each node a team slug with its nested state and children. */
  readonly tree: StaffTeamNode;
  readonly profile: StaffProfileId;
  readonly level: StaffLevel;
  readonly nation?: StaffNation;
  readonly currentStep: Readonly<Partial<Record<StaffSectionId, CrosswalkStep>>>;
  readonly startedAt: string;
  readonly costUsd: number;
}

export interface StaffTeamNode { readonly team: string; readonly section?: StaffSectionId; readonly state?: NestedTeamState; readonly children: readonly StaffTeamNode[] }

export interface StepBoardLane { readonly member: string; readonly status: LaneStatus; readonly product?: string }
export interface StepBoardSection {
  readonly section: StaffSectionId;
  readonly step: CrosswalkStep;
  readonly role?: StepRole;
  readonly lanes: readonly StepBoardLane[];
  readonly merge: 'none' | 'merging' | 'conflict' | 'merged';
  readonly gate: 'none' | 'held' | 'cleared' | 'awaiting-decision';
}
export interface StepBoardModel { readonly run: string; readonly sections: readonly StepBoardSection[] }

export interface ProductRegistryEntry {
  readonly product: string;
  readonly kind: ProductKind;
  readonly section: StaffSectionId;
  readonly owner: string;
  readonly version: number;
  readonly state: ReleaseState;
  readonly label: string;
  readonly decisionFor?: string;
  readonly dependsOn: ReadonlyArray<{ readonly product: string; readonly version: number }>;
  readonly guard?: { readonly verdict: string; readonly version: number };
  readonly tradecraft?: { readonly verdict: string; readonly version: number };
  /** A product it depends on has a newer approved version; the owner decides whether to take it. */
  readonly sourceChanged: boolean;
}

export interface DecisionOption { readonly label: string; readonly risk: string }
export interface DecisionQueueEntry {
  readonly product: string;
  readonly version: number;
  readonly decisionFor: string;
  readonly options: readonly DecisionOption[];
  /** Dissent from the red team and others, shown beside the options, never dropped. */
  readonly dissent: readonly string[];
  readonly requestedAt: string;
  readonly deadline?: string;
}

export interface SharedRegisterModel { readonly product: string; readonly writer: StaffWriter; readonly version: number; readonly state: ReleaseState; readonly rows: number }
export interface SharedRegistersModel { readonly registers: readonly SharedRegisterModel[] }

export interface CopLayerModel { readonly layer: string; readonly owner: StaffWriter; readonly updatedAt: string; readonly featureCount: number }
export interface CopModel { readonly layers: readonly CopLayerModel[]; readonly eventTail: readonly CopUpdatedEvent[] }
