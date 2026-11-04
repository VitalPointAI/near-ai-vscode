// Board timeline (62.1-CONTEXT D-02, D-03): the whole project on one axis. Milestones are bands in version order, phases are segments inside
// them, and every card of the board model is one dot at its dependency depth inside its milestone. Parallel cards share a step and stack in phase
// then plan order. Pure: no vscode, no I/O and no clock; the same state gives the same timeline on every client.
import { BOARD_LANE_LABEL } from './boardText';
import { compareParts, comparePlans } from './board';
import type { BoardCard, BoardModel } from './board';
import type { TeamState, WorkItem } from './types';

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

/** The band of the cards added on the board. */
export const BOARD_BAND_ID = 'board';

interface Node { card: BoardCard; item: WorkItem | undefined; band: string; order: number }

// Version order of the milestone keys: v0.4.0 before v0.6.0, and keys that are not versions after them by name.
function compareMilestoneKeys(a: string, b: string): number {
  const bare = (id: string): string => id.slice('milestone:'.length).replace(/^v/i, '');
  const version = (key: string): boolean => /^\d+(?:\.\d+)*$/.test(key);
  const left = bare(a);
  const right = bare(b);
  if (version(left) !== version(right)) return version(left) ? -1 : 1;
  const order = version(left) ? compareParts(left, right) : left < right ? -1 : left > right ? 1 : 0;
  return order || (a < b ? -1 : a > b ? 1 : 0);
}

// Number order: plans and phase cards by phase then plan number, cards added on the board by id (their ids sort by creation time).
function compareCards(a: Node, b: Node): number {
  const numbered = (node: Node): boolean => node.item !== undefined && (node.item.kind === 'plan' || node.item.kind === 'phase');
  if (numbered(a) && numbered(b) && a.item !== undefined && b.item !== undefined) return comparePlans(a.item, b.item);
  if (numbered(a) !== numbered(b)) return numbered(a) ? -1 : 1;
  return a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0;
}

export function buildTimeline(state: TeamState, model: BoardModel, _options: { viewerId?: string }): BoardTimeline {
  const milestoneIds = new Set(model.milestones.map((milestone) => milestone.id));
  const nodes: Node[] = model.cards.map((card) => ({
    card, item: state.items.get(card.id), band: card.milestoneId !== undefined && milestoneIds.has(card.milestoneId) ? card.milestoneId : BOARD_BAND_ID, order: 0
  }));
  nodes.sort(compareCards);
  nodes.forEach((node, index) => { node.order = index; });
  const byId = new Map(nodes.map((node) => [node.card.id, node]));

  // Longest path over the dependencies between two cards of the same band, in a queue so no walk recurses.
  const successors = new Map<Node, Node[]>();
  const waiting = new Map<Node, number>();
  for (const node of nodes) {
    waiting.set(node, 0);
    successors.set(node, []);
  }
  for (const node of nodes) {
    for (const id of new Set(node.item?.dependsOn ?? [])) {
      const from = byId.get(id);
      if (from === undefined || from === node || from.band !== node.band || from.item?.kind === 'phase') continue;
      successors.get(from)?.push(node);
      waiting.set(node, (waiting.get(node) ?? 0) + 1);
    }
  }
  const step = new Map<Node, number>(nodes.map((node) => [node, 0]));
  const queue = nodes.filter((node) => waiting.get(node) === 0);
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head] as Node;
    for (const next of successors.get(node) ?? []) {
      step.set(next, Math.max(step.get(next) ?? 0, (step.get(node) ?? 0) + 1));
      const left = (waiting.get(next) ?? 0) - 1;
      waiting.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  const bandOrder = [...model.milestones.map((milestone) => milestone.id).filter((id) => nodes.some((node) => node.band === id)).sort(compareMilestoneKeys)];
  if (nodes.some((node) => node.band === BOARD_BAND_ID)) bandOrder.push(BOARD_BAND_ID);
  const dots: TimelineDot[] = [];
  const milestones: TimelineMilestone[] = [];
  for (const band of bandOrder) {
    const inBand = nodes.filter((node) => node.band === band)
      .sort((a, b) => (step.get(a) ?? 0) - (step.get(b) ?? 0) || a.order - b.order);
    let slot = 0;
    let last = -1;
    for (const node of inBand) {
      const at = step.get(node) ?? 0;
      slot = at === last ? slot + 1 : 0;
      last = at;
      const dot: TimelineDot = { cardId: node.card.id, milestoneId: band, step: at, slot, inCycle: false, waitsFor: [], missing: [], neededBy: 0, label: node.card.a11yLabel };
      if (node.card.phaseId !== undefined) dot.phaseId = node.card.phaseId;
      dots.push(dot);
    }
    const milestone = model.milestones.find((entry) => entry.id === band);
    const finished = inBand.length > 0 && inBand.every((node) => node.card.column === 'done' || node.card.column === 'cancelled');
    milestones.push({
      id: band, title: milestone?.title ?? BOARD_LANE_LABEL, active: milestone?.active ?? false, finished, foldedByDefault: finished,
      steps: inBand.length === 0 ? 0 : last + 1, cycle: false, cardCount: inBand.length, cancelled: inBand.filter((node) => node.card.column === 'cancelled').length, phases: []
    });
  }

  const position = new Map(dots.map((dot, index) => [dot.cardId, index]));
  const edges: TimelineEdge[] = [];
  for (const node of nodes) {
    for (const id of new Set(node.item?.dependsOn ?? [])) {
      const from = byId.get(id);
      // A dependency on a whole phase orders the card after that phase and draws no line (the UI-SPEC amendment's reading of D-03).
      if (from === undefined || from === node || from.item?.kind === 'phase') continue;
      edges.push({ from: from.card.id, to: node.card.id, waiting: from.card.column !== 'done', crossMilestone: from.band !== node.band });
    }
  }
  edges.sort((a, b) => (position.get(a.from) ?? 0) - (position.get(b.from) ?? 0) || (position.get(a.to) ?? 0) - (position.get(b.to) ?? 0));
  return { milestones, dots, edges };
}
