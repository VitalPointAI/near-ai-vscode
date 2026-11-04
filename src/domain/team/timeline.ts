// Board timeline (62.1-CONTEXT D-02, D-03): the whole project on one axis. Milestones are bands in version order, phases are segments inside
// them, and every card of the board model is one dot at its dependency depth inside its milestone. Parallel cards share a step and stack in phase
// then plan order. Pure: no vscode, no I/O and no clock; the same state gives the same timeline on every client.
import { BOARD_LANE_LABEL } from './boardText';
import {
  milestoneHeading, noPercentText, NOW_ALL_DONE, nowAllDoneSentence, nowDetail, nowSentence, nowTitle, percentDoneText, percentLabel, percentShort,
  cardsFinishedText, phaseHeading, phaseLabels, tileName, tileText
} from './timelineText';
import { compareParts, comparePlans } from './board';
import type { BoardCard, BoardModel } from './board';
import type { TeamState, WorkItem } from './types';

export interface TimelinePercent { finished: number; counted: number; percent?: number; text: string; label: string }
export interface TimelineNow {
  milestoneId: string; step: number; stepCount: number; phaseId?: string; allDone: boolean; inProgress: number; ready: number; percent?: number;
  title: string; detail: string; sentence: string;
}
export interface TimelinePhase {
  id: string; label: string; number: string; firstStep: number; lastStep: number; percent?: TimelinePercent;
  /** The segment label, longest first: 'Phase 62: {title} · 62%', 'Phase 62 · 62%', '62 · 62%'. */
  labels: string[];
  /** The h3 and the label's title: 'Phase 62: {title}, 62% done, 17 of 27 cards finished'. */
  heading: string;
}
export interface TimelineMilestone {
  id: string; title: string; active: boolean; finished: boolean; foldedByDefault: boolean; steps: number; cycle: boolean; cardCount: number; cancelled: number;
  phases: TimelinePhase[]; percent?: TimelinePercent;
  /** The h2: '{title}, current milestone, 62% done'. */
  heading: string;
  /** '62%', or '' when nothing is counted. */
  percentText: string;
  /** '26 of 42 cards finished', or the no-percent text. */
  progressText: string;
  /** The folded tile's line: 'Finished: 30 done' or 'Finished: 30 done, 2 cancelled'. */
  tileText: string;
  /** The folded tile's accessible name: 'Show {title}, finished, 32 cards'. */
  tileName: string;
  /** The UI-SPEC cycle sentence, only when cycle is true. */
  cycleNote?: string;
  /** 'No plans yet' and the viewer's next-step line, only for a milestone with no cards. */
  emptyText?: string;
  emptyNext?: string;
}
/** A card or phase named in the expanded card's Waits for and Needed by rows; onBoard is false for a dependency that is not on the board. */
export interface TimelineLink { id: string; label: string; onBoard: boolean }
export interface TimelineDot {
  cardId: string; milestoneId: string; phaseId?: string; step: number; slot: number; inCycle: boolean; waitsFor: string[]; missing: string[]; neededBy: number;
  /** The accessible name (UI-SPEC "Accessible name of a dot"): the card's own name, who it is assigned to once, its step, what it waits for, how many need it. */
  label: string;
  /** 'Step 3 of 7' (preview). */
  stepText: string;
  /** '3 of 7 in v0.6.0 Team Mode' (the expanded card's Step fact). */
  stepFact: string;
  /** 'Assigned to Dana', 'Assigned to you' or 'Nobody yet'. */
  whoText: string;
  /** 'Waits for 2 cards', 'Waits for 1 card' or 'Waits for nothing'. */
  waitsText: string;
  waitsForLinks: TimelineLink[];
  neededByLinks: TimelineLink[];
  /** The missing dependency sentences and the cycle note, when they apply. */
  notes: string[];
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

// Strongly connected components (Tarjan), walked with an explicit stack so a long chain or a hostile log cannot overflow the call stack
// (T-62.1-01). Components come out in reverse topological order: each one after every component it reaches.
function components(count: number, successors: readonly (readonly number[])[]): number[][] {
  const index = new Int32Array(count).fill(-1);
  const low = new Int32Array(count);
  const onStack = new Uint8Array(count);
  const stack: number[] = [];
  const result: number[][] = [];
  let next = 0;
  for (let root = 0; root < count; root += 1) {
    if (index[root] !== -1) continue;
    index[root] = next;
    low[root] = next;
    next += 1;
    stack.push(root);
    onStack[root] = 1;
    const work: Array<{ vertex: number; edge: number }> = [{ vertex: root, edge: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1] as { vertex: number; edge: number };
      const v = frame.vertex;
      const edges = successors[v] ?? [];
      if (frame.edge < edges.length) {
        const w = edges[frame.edge] as number;
        frame.edge += 1;
        if (index[w] === -1) {
          index[w] = next;
          low[w] = next;
          next += 1;
          stack.push(w);
          onStack[w] = 1;
          work.push({ vertex: w, edge: 0 });
        } else if (onStack[w] === 1) {
          low[v] = Math.min(low[v] as number, index[w] as number);
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) low[parent.vertex] = Math.min(low[parent.vertex] as number, low[v] as number);
      if (low[v] !== index[v]) continue;
      const component: number[] = [];
      let w: number;
      do {
        w = stack.pop() as number;
        onStack[w] = 0;
        component.push(w);
      } while (w !== v);
      result.push(component);
    }
  }
  return result;
}

interface Layout { step: number[]; inCycle: boolean[]; waitsFor: string[][]; missing: string[][] }

// Steps (D-03 as read in the UI-SPEC amendment): the longest path over every dependency between two cards of the same band, finished or not.
// A dependency on a whole phase becomes a gate vertex that waits for every card of that phase and weighs nothing, so a phase that waits for
// another costs one vertex and its edges, never one constraint per pair of cards. Cross-milestone and missing dependencies never move a step.
// A loop (which the log should never hold) is laid out as a chain in number order from the earliest step its outside dependencies allow.
function layout(state: TeamState, nodes: readonly Node[]): Layout {
  const byId = new Map(nodes.map((node, index) => [node.card.id, index]));
  const phaseCards = new Map<string, number[]>();
  nodes.forEach((node, index) => {
    if (node.card.phaseId === undefined) return;
    const list = phaseCards.get(node.card.phaseId);
    if (list === undefined) phaseCards.set(node.card.phaseId, [index]);
    else list.push(index);
  });
  const successors: Array<Set<number>> = nodes.map(() => new Set<number>());
  const gates = new Map<string, number>();
  const gateOf = (phaseId: string, cards: readonly number[]): number => {
    const known = gates.get(phaseId);
    if (known !== undefined) return known;
    const gate = successors.length;
    successors.push(new Set<number>());
    gates.set(phaseId, gate);
    for (const card of cards) successors[card]?.add(gate);
    return gate;
  };
  const selfLoop = nodes.map(() => false);
  const waitsFor: string[][] = [];
  const missing: string[][] = [];
  nodes.forEach((node, index) => {
    const own = node.item?.dependsOn ?? [];
    const parent = node.item?.kind === 'plan' && node.item.parentId !== undefined ? state.items.get(node.item.parentId) : undefined;
    const inherited = parent?.kind === 'phase' ? parent.dependsOn : [];
    const waits: string[] = [];
    const gone: string[] = [];
    for (const id of new Set([...own, ...inherited])) {
      const phaseList = state.items.get(id)?.kind === 'phase' ? phaseCards.get(id) : undefined;
      const card = byId.get(id);
      if (phaseList !== undefined) {
        waits.push(id);
        const band = nodes[phaseList[0] as number]?.band;
        if (band === node.band) successors[gateOf(id, phaseList)]?.add(index);
      } else if (card !== undefined && state.items.get(id)?.kind !== 'phase') {
        waits.push(id);
        if (card === index) selfLoop[index] = true;
        else if (nodes[card]?.band === node.band) successors[card]?.add(index);
      } else {
        gone.push(id);
      }
    }
    waitsFor.push(waits);
    missing.push(gone);
  });

  const lists = successors.map((set) => [...set]);
  const comps = components(lists.length, lists);
  const compOf = new Int32Array(lists.length);
  comps.forEach((members, at) => { for (const v of members) compOf[v] = at; });
  const start = new Int32Array(comps.length);
  const step = nodes.map(() => 0);
  const inCycle = nodes.map(() => false);
  for (let at = comps.length - 1; at >= 0; at -= 1) {
    const members = comps[at] as number[];
    const cards = members.filter((v) => v < nodes.length).sort((a, b) => a - b);
    const cyclic = members.length > 1 || (cards.length === 1 && selfLoop[cards[0] as number] === true);
    const first = start[at] as number;
    cards.forEach((v, offset) => {
      step[v] = first + offset;
      inCycle[v] = cyclic;
    });
    const after = first + cards.length;
    for (const v of members) {
      for (const w of lists[v] ?? []) {
        const target = compOf[w] as number;
        if (target !== at && (start[target] as number) < after) start[target] = after;
      }
    }
  }
  return { step, inCycle, waitsFor, missing };
}

// Percent complete (D-14), the one rule every percent on the timeline uses: the whole number part of 100 x finished / counted, counted being every
// card that is not Cancelled and finished every card in Done. A planless phase card sits in Backlog, so it counts and is unfinished, and rounding
// down means 99.6 shows 99 until the last card is done: the number never overstates progress (T-62.1-05). Integers only.
function percentOf(cards: readonly BoardCard[]): TimelinePercent {
  const counted = cards.filter((card) => card.column !== 'cancelled').length;
  const finished = cards.filter((card) => card.column === 'done').length;
  if (counted === 0) {
    const text = noPercentText(cards.length > 0);
    return { finished, counted, text, label: text };
  }
  const percent = Math.floor((finished * 100) / counted);
  return { finished, counted, percent, text: percentDoneText(percent), label: percentLabel(finished, counted, percent) };
}

function phasesOfBand(model: BoardModel, dots: readonly TimelineDot[], cardOf: ReadonlyMap<string, BoardCard>): TimelinePhase[] {
  const spans = new Map<string, { first: number; last: number }>();
  for (const dot of dots) {
    if (dot.phaseId === undefined) continue;
    const span = spans.get(dot.phaseId);
    if (span === undefined) spans.set(dot.phaseId, { first: dot.step, last: dot.step });
    else {
      span.first = Math.min(span.first, dot.step);
      span.last = Math.max(span.last, dot.step);
    }
  }
  const titles = new Map(model.phases.map((entry) => [entry.id, entry.title]));
  return [...spans.entries()].map(([id, span]) => {
    const number = id.slice('phase:'.length);
    const label = titles.get(id) ?? `Phase ${number}`;
    const cards = dots.filter((dot) => dot.phaseId === id).map((dot) => cardOf.get(dot.cardId)).filter((card): card is BoardCard => card !== undefined);
    const percent = percentOf(cards);
    return {
      id, label, number, firstStep: span.first, lastStep: span.last, percent,
      labels: phaseLabels(label, number, percent.percent), heading: phaseHeading(label, percent.percent, percent.finished, percent.counted, percent.text)
    };
  }).sort((a, b) => a.firstStep - b.firstStep || compareParts(a.number, b.number) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const closed = (card: BoardCard): boolean => card.column === 'done' || card.column === 'cancelled';
const STARTED: ReadonlySet<string> = new Set(['claimed', 'in-progress', 'in-review', 'integrating']);

// The Now indicator (D-13 as amended in the UI-SPEC): the frontier band is the first band in timeline order (milestones in version order, then the
// cards added on the board) holding a card that is not Done or Cancelled; the Now step is the earliest step there holding one, and its phase is that
// of the first such dot in slot order. Work running ahead does not move it; the counts cover the whole band. When every card is finished it stands
// after the last step of the last band with cards. With no cards there is none.
function nowOf(milestones: readonly TimelineMilestone[], dots: readonly TimelineDot[], cardOf: ReadonlyMap<string, BoardCard>, overall: TimelinePercent): TimelineNow | undefined {
  const open = (dot: TimelineDot): boolean => {
    const card = cardOf.get(dot.cardId);
    return card !== undefined && !closed(card);
  };
  for (const band of milestones) {
    const bandDots = dots.filter((dot) => dot.milestoneId === band.id);
    const first = bandDots.find(open);
    if (first === undefined) continue;
    const columns = bandDots.map((dot) => cardOf.get(dot.cardId)?.column);
    const inProgress = columns.filter((column) => column !== undefined && STARTED.has(column)).length;
    const ready = columns.filter((column) => column === 'ready').length;
    // The band holds an unfinished card, so something is counted and the band has a percent.
    const percent = band.percent?.percent ?? 0;
    const board = band.id === BOARD_BAND_ID;
    const phaseNumber = first.phaseId === undefined ? undefined : first.phaseId.slice('phase:'.length);
    const title = nowTitle(phaseNumber, first.step + 1, band.steps);
    const now: TimelineNow = {
      milestoneId: band.id, step: first.step, stepCount: band.steps, allDone: false, inProgress, ready, percent,
      title, detail: nowDetail(inProgress, ready, percent, board), sentence: nowSentence(title, inProgress, ready, percent, board)
    };
    if (first.phaseId !== undefined) now.phaseId = first.phaseId;
    return now;
  }
  const last = [...milestones].reverse().find((band) => band.cardCount > 0);
  if (last === undefined) return undefined;
  const lastDot = [...dots].reverse().find((dot) => dot.milestoneId === last.id);
  const detail = overall.label;
  const now: TimelineNow = {
    milestoneId: last.id, step: last.steps, stepCount: last.steps, allDone: true, inProgress: 0, ready: 0,
    title: NOW_ALL_DONE, detail, sentence: nowAllDoneSentence(detail)
  };
  if (lastDot?.phaseId !== undefined) now.phaseId = lastDot.phaseId;
  if (last.percent?.percent !== undefined) now.percent = last.percent.percent;
  return now;
}

export function buildTimeline(state: TeamState, model: BoardModel, _options: { viewerId?: string }): BoardTimeline {
  const milestoneIds = new Set(model.milestones.map((milestone) => milestone.id));
  const nodes: Node[] = model.cards.map((card) => ({
    card, item: state.items.get(card.id), band: card.milestoneId !== undefined && milestoneIds.has(card.milestoneId) ? card.milestoneId : BOARD_BAND_ID, order: 0
  }));
  nodes.sort(compareCards);
  nodes.forEach((node, index) => { node.order = index; });
  const placed = layout(state, nodes);

  const bands = model.milestones.map((milestone) => milestone.id).sort(compareMilestoneKeys);
  if (nodes.some((node) => node.band === BOARD_BAND_ID)) bands.push(BOARD_BAND_ID);
  const dots: TimelineDot[] = [];
  const milestones: TimelineMilestone[] = [];
  const cardOf = new Map(model.cards.map((card) => [card.id, card]));
  for (const band of bands) {
    const inBand = nodes.filter((node) => node.band === band).sort((a, b) => (placed.step[a.order] as number) - (placed.step[b.order] as number) || a.order - b.order);
    const bandDots: TimelineDot[] = [];
    let slot = 0;
    let last = -1;
    for (const node of inBand) {
      const at = placed.step[node.order] as number;
      slot = at === last ? slot + 1 : 0;
      last = at;
      const dot: TimelineDot = {
        cardId: node.card.id, milestoneId: band, step: at, slot, inCycle: placed.inCycle[node.order] === true,
        waitsFor: placed.waitsFor[node.order] ?? [], missing: placed.missing[node.order] ?? [], neededBy: 0, label: node.card.a11yLabel,
        stepText: '', stepFact: '', whoText: '', waitsText: '', waitsForLinks: [], neededByLinks: [], notes: []
      };
      if (node.card.phaseId !== undefined) dot.phaseId = node.card.phaseId;
      bandDots.push(dot);
    }
    dots.push(...bandDots);
    const milestone = model.milestones.find((entry) => entry.id === band);
    const finished = inBand.length > 0 && inBand.every((node) => closed(node.card));
    const title = milestone?.title ?? BOARD_LANE_LABEL;
    const active = milestone?.active ?? false;
    const cancelled = inBand.filter((node) => node.card.column === 'cancelled').length;
    const percent = percentOf(inBand.map((node) => node.card));
    milestones.push({
      id: band, title, active, finished, foldedByDefault: finished,
      steps: inBand.length === 0 ? 0 : last + 1, cycle: bandDots.some((dot) => dot.inCycle), cardCount: inBand.length,
      cancelled, phases: phasesOfBand(model, bandDots, cardOf), percent,
      heading: milestoneHeading(title, active, percent.percent, percent.text), percentText: percentShort(percent.percent),
      progressText: percent.percent === undefined ? percent.text : cardsFinishedText(percent.finished, percent.counted),
      tileText: tileText(percent.finished, cancelled), tileName: tileName(title, inBand.length)
    });
  }

  // Edges join two cards on the board, across milestones too; a dependency on a whole phase or on something not on the board draws none.
  const position = new Map(dots.map((dot, index) => [dot.cardId, index]));
  const byId = new Map(nodes.map((node) => [node.card.id, node]));
  const edges: TimelineEdge[] = [];
  for (const node of nodes) {
    for (const id of new Set(node.item?.dependsOn ?? [])) {
      const from = byId.get(id);
      if (from === undefined || from === node || from.item?.kind === 'phase') continue;
      edges.push({ from: from.card.id, to: node.card.id, waiting: from.card.column !== 'done', crossMilestone: from.band !== node.band });
    }
  }
  edges.sort((a, b) => (position.get(a.from) ?? 0) - (position.get(b.from) ?? 0) || (position.get(a.to) ?? 0) - (position.get(b.to) ?? 0));
  const dotOf = new Map(dots.map((dot) => [dot.cardId, dot]));
  for (const edge of edges) {
    const dot = dotOf.get(edge.from);
    if (dot !== undefined) dot.neededBy += 1;
  }
  const percent = percentOf(model.cards);
  const timeline: BoardTimeline = { milestones, dots, edges, percent };
  const now = nowOf(milestones, dots, cardOf, percent);
  if (now !== undefined) timeline.now = now;
  return timeline;
}
