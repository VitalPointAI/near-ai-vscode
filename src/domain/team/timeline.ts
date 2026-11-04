// Board timeline (62.1-CONTEXT D-02, D-03): the whole project on one axis. Types first; the layout follows in the GREEN step.
import type { BoardModel } from './board';
import type { TeamState } from './types';

export interface TimelinePercent { finished: number; counted: number; percent?: number; text: string; label: string }
export interface TimelineNow {
  milestoneId: string; step: number; stepCount: number; phaseId?: string; allDone: boolean; inProgress: number; ready: number; percent?: number;
  title: string; detail: string; sentence: string;
}
export interface TimelinePhase { id: string; label: string; number: string; firstStep: number; lastStep: number; percent?: TimelinePercent }
export interface TimelineMilestone {
  id: string; title: string; active: boolean; finished: boolean; foldedByDefault: boolean; steps: number; cycle: boolean; cardCount: number; cancelled: number;
  phases: TimelinePhase[]; percent?: TimelinePercent;
}
export interface TimelineDot {
  cardId: string; milestoneId: string; phaseId?: string; step: number; slot: number; inCycle: boolean; waitsFor: string[]; missing: string[]; neededBy: number; label: string;
}
export interface TimelineEdge { from: string; to: string; waiting: boolean; crossMilestone: boolean }
export interface BoardTimeline { milestones: TimelineMilestone[]; dots: TimelineDot[]; edges: TimelineEdge[]; now?: TimelineNow; percent?: TimelinePercent }

export function buildTimeline(_state: TeamState, _model: BoardModel, _options: { viewerId?: string }): BoardTimeline {
  return { milestones: [], dots: [], edges: [] };
}
