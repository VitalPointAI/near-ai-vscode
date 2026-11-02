// Team Board model (D-07, D-08, D-12, D-13, D-15, D-16, D-18): the whole board as a pure function of the log, and the one place that decides a move.
// The menu, the drop targets and the write path all ask planMove, so the board offers only what the log would accept, and the host re-runs the same
// function on fresh state inside the append. Pure: no vscode, no I/O, no clock reads (nowMs is a parameter used for display text only).
import {
  ALL_CARDS_LABEL, BOARD_LANE_LABEL, COLUMN_CAPTIONS, COLUMN_LABELS, HISTORY_LIMIT_TEXT, KIND_WORDS, MOVE_LABELS, NO_PLANS_TEXT, READ_ONLY_BANNERS, REFUSALS, SOMEONE, SOURCE_BOARD_TEXT,
  SOURCE_IMPORT_TEXT, UNASSIGNED_LABEL, ageText, cardLabel, estimateText, flattenName, historySentence, notReadyRefusal, notReadySentences, stripFormatControls
} from './boardText';
import { MAX_HISTORY_PER_ITEM } from './itemHistory';
import type { HistoryEntry } from './itemHistory';
import { decideTeamAction } from './permissions';
import { findSecrets } from './secrets';
import type {
  ImplementedTeamEvent, ItemBlockedBody, ItemCancelledBody, ItemKind, ItemReopenedBody, ItemUnblockedBody, ItemUpdatedBody, Role, TeamState, WorkItem
} from './types';
import { TEAM_REJECTION_REASONS } from './types';
import { REASON_MAX } from './validate';
import { BOARD_COLUMNS, effectiveColumn, isCard, isOwnDraft, progressOf, readiness, transitionProblem } from './work';
import type { BoardColumn } from './work';

export const MOVE_KEYS = ['done', 'cancel', 'hold', 'release', 'reopen', 'block', 'unblock'] as const;
export type MoveKey = typeof MOVE_KEYS[number];
export interface CardMove { key: MoveKey; label: string; column?: BoardColumn; prompt: 'none' | 'reason' | 'confirm'; dependents?: number }
// A structural subset of the EventIntent union in src/team/eventLog.ts, so the host can append it without a cast.
export type MoveIntent =
  | { type: 'item.updated'; body: ItemUpdatedBody } | { type: 'item.blocked'; body: ItemBlockedBody } | { type: 'item.unblocked'; body: ItemUnblockedBody }
  | { type: 'item.cancelled'; body: ItemCancelledBody } | { type: 'item.reopened'; body: ItemReopenedBody };
export type MoveResult = { ok: true; intent: MoveIntent } | { ok: false; reason: string };

export type BoardStatus = { kind: 'live' | 'syncing' | 'offline' | 'paused' | 'removed'; text: string; lastUpdated?: string };
export interface BoardModelOptions { nowMs: number; status: BoardStatus; viewerId?: string; canWrite: boolean; readOnlyReason?: string }
export interface BoardProgress { percent: number; done: number; total: number; text: string }
export interface BoardColumnInfo { key: BoardColumn; label: string; caption?: string; count: number }
export interface BoardMilestone { id: string; title: string; active: boolean; progress: BoardProgress }
export interface BoardPhase { id: string; title: string; milestoneId?: string }
export interface BoardLane { key: string; label: string; count: number; collapsedByDefault: boolean; milestoneId?: string; progress?: BoardProgress }
export interface BoardViewer { name: string; role?: Role; canWrite: boolean; canImport: boolean; canCreate: boolean; readOnlyReason?: string }
export interface BoardCard {
  id: string; displayId: string; kind: ItemKind; title: string; column: BoardColumn; stateLabel: string;
  lane: { member: string; phase: string; milestone: string }; phaseId?: string; milestoneId?: string; requirements: string[]; mine: boolean;
  blocked?: { reason: string; byName: string; since: string }; held: boolean; doneInGsd: boolean; dependencyCount: number; estimateText: string; ageText: string;
  createdByName?: string; moves: CardMove[]; refusals: Partial<Record<BoardColumn, string>>; a11yLabel: string;
}
export interface BoardModel {
  status: BoardStatus; viewer: BoardViewer; columns: BoardColumnInfo[]; milestones: BoardMilestone[]; selectedMilestone: string; phases: BoardPhase[]; requirements: string[];
  lanes: { member: BoardLane[]; phase: BoardLane[]; milestone: BoardLane[]; none: BoardLane[] }; cards: BoardCard[]; counts: { cards: number; ready: number; blocked: number };
}
export interface CardDetail {
  itemId: string; displayId: string; title: string; kind: ItemKind; kindLabel: string; column: BoardColumn; stateLabel: string; held: boolean; doneInGsd: boolean;
  blocked?: { reason: string; byName: string; since: string };
  facts: { phase?: string; milestone?: string; wave?: number; createdBy?: string; estimate: string; age: string; source: string };
  estimateTokens?: number; description?: string; mustHaves: string[]; requirements: string[];
  dependencies: Array<{ id: string; label: string; stateLabel?: string; done: boolean; onBoard: boolean }>;
  files: string[]; tasks: { done: number; total: number; summary: string; items: Array<{ id: string; title: string; done: boolean }> };
  notReady: string[]; editable: boolean; history: Array<{ at: string; text: string }>; historyNote?: string;
}

const R = TEAM_REJECTION_REASONS;
// A stand-in reason used only to ask "would this move be accepted": availableMoves never writes it.
const PLACEHOLDER_REASON = 'placeholder';
const MOVE_COLUMN: Readonly<Partial<Record<MoveKey, BoardColumn>>> = { done: 'done', cancel: 'cancelled', hold: 'backlog', release: 'ready', reopen: 'backlog' };
const MOVE_PROMPT: Readonly<Record<MoveKey, CardMove['prompt']>> = { done: 'confirm', cancel: 'reason', hold: 'none', release: 'none', reopen: 'none', block: 'reason', unblock: 'none' };

// ---- who may move ----------------------------------------------------------------------------------------------------------------------------

// The reason this viewer may not move cards at all, or undefined when the role allows it. Decision first (D-12, A12): no viewer is a computer
// without a device key, a removed member can look but not touch, and the matrix decides the rest.
function moveDenial(state: TeamState, viewerId: string | undefined): string | undefined {
  if (viewerId === undefined) return REFUSALS.noDeviceKey;
  const member = state.members.get(viewerId);
  if (member?.removedEvent !== undefined) return REFUSALS.removed;
  return decideTeamAction(state, viewerId, { kind: 'item.move' }).allowed ? undefined : REFUSALS.notManager;
}

// ---- planMove --------------------------------------------------------------------------------------------------------------------------------

function intentFor(itemId: string, move: MoveKey, reason: string): MoveIntent {
  switch (move) {
    case 'done': return { type: 'item.updated', body: { id: itemId, changes: { state: 'done' } } };
    case 'hold': return { type: 'item.updated', body: { id: itemId, changes: { hold: true } } };
    case 'release': return { type: 'item.updated', body: { id: itemId, changes: { hold: false } } };
    case 'cancel': return { type: 'item.cancelled', body: { id: itemId, reason } };
    case 'reopen': return { type: 'item.reopened', body: { id: itemId } };
    case 'block': return { type: 'item.blocked', body: { id: itemId, reason } };
    case 'unblock': return { type: 'item.unblocked', body: { id: itemId } };
  }
}

// The state machine of 62-01 answers on a synthetic envelope: transitionProblem reads only the type and the body.
function transitionFor(state: TeamState, viewerId: string, intent: MoveIntent): string | undefined {
  const event = { v: 1, id: 'evt-probe', teamId: state.team.id, type: intent.type, lamport: 0, at: '', author: viewerId, device: '', prev: '', body: intent.body, sig: '' };
  return transitionProblem(state, event as unknown as ImplementedTeamEvent);
}

// A transition reason in the board's own words, by the move that ran into it.
function refusalFor(move: MoveKey, problem: string, item: WorkItem): string {
  if (problem === R.itemMissing) return REFUSALS.missing;
  if (problem === R.itemTerminal) return REFUSALS.alreadySettled;
  switch (move) {
    case 'done': return problem === R.itemBlocked ? REFUSALS.doneBlocked : REFUSALS.doneNotNow;
    case 'hold': return item.hold === true ? REFUSALS.alreadyHeld : REFUSALS.holdNotNow;
    case 'release': return REFUSALS.notHeld;
    case 'reopen': return REFUSALS.notTerminal;
    case 'block': return problem === R.itemBlocked ? REFUSALS.alreadyBlocked : REFUSALS.blockNotNow;
    case 'unblock': return REFUSALS.notBlocked;
    case 'cancel': return REFUSALS.alreadySettled;
  }
}

// A reason for block or cancel: one line, 1 to 200 characters, and nothing that looks like a password or key. The check runs before any intent exists,
// so a secret-like reason never reaches the log; assertNoSecrets still runs on write as the second line of defence.
function cleanReason(raw: string | undefined): { ok: true; reason: string } | { ok: false; reason: string } {
  const reason = flattenName(raw ?? '', Number.MAX_SAFE_INTEGER);
  if (reason === '' || reason.length > REASON_MAX) return { ok: false, reason: REFUSALS.reasonInvalid };
  return findSecrets(reason).length > 0 ? { ok: false, reason: REFUSALS.secret } : { ok: true, reason };
}

const REASON_REQUIRED: readonly MoveKey[] = ['cancel', 'block'];

// The one function that decides a move: the exact intent to append, or a plain refusal that ends "Nothing was moved." (D-12, D-16, BOARD-03).
export function planMove(state: TeamState, viewerId: string | undefined, itemId: string, move: MoveKey, input: { reason?: string } = {}): MoveResult {
  const denied = moveDenial(state, viewerId);
  if (denied !== undefined || viewerId === undefined) return { ok: false, reason: denied ?? REFUSALS.noDeviceKey };
  const item = state.items.get(itemId);
  if (item === undefined || !isCard(item)) return { ok: false, reason: REFUSALS.missing };
  let reason = '';
  if (REASON_REQUIRED.includes(move)) {
    const cleaned = cleanReason(input.reason);
    if (!cleaned.ok) return cleaned;
    reason = cleaned.reason;
  }
  const intent = intentFor(itemId, move, reason);
  const problem = transitionFor(state, viewerId, intent);
  if (problem !== undefined) return { ok: false, reason: refusalFor(move, problem, item) };
  if (move === 'hold' && effectiveColumn(state.items, item) !== 'ready') return { ok: false, reason: REFUSALS.holdNotReady };
  return { ok: true, intent };
}

// How many unfinished plans wait for this card, so the host can ask for a second confirmation before a cancel leaves them waiting.
function dependentsOf(state: TeamState, itemId: string): number {
  let waiting = 0;
  for (const item of state.items.values()) if (item.kind === 'plan' && item.state !== 'done' && item.state !== 'cancelled' && item.dependsOn.includes(itemId)) waiting += 1;
  return waiting;
}

// The menu: each move whose plan succeeds, in menu order. The two moves that need a reason are asked with a placeholder.
export function availableMoves(state: TeamState, viewerId: string | undefined, itemId: string): CardMove[] {
  const moves: CardMove[] = [];
  for (const key of MOVE_KEYS) {
    if (!planMove(state, viewerId, itemId, key, { reason: PLACEHOLDER_REASON }).ok) continue;
    const column = MOVE_COLUMN[key];
    moves.push({
      key, label: MOVE_LABELS[key], ...(column === undefined ? {} : { column }), prompt: MOVE_PROMPT[key],
      ...(key === 'cancel' ? { dependents: dependentsOf(state, itemId) } : {})
    });
  }
  return moves;
}

const CLAIM_COLUMNS: readonly BoardColumn[] = ['claimed', 'in-progress', 'in-review', 'integrating'];

// How many of the card's dependencies are on the board and not finished yet (a phase counts as finished when its live plans are).
function waitingOn(state: TeamState, item: WorkItem): number {
  let waiting = 0;
  for (const id of item.dependsOn) {
    const dependency = state.items.get(id);
    if (dependency === undefined) continue;
    const progress = dependency.kind === 'phase' ? progressOf(state.items, id) : undefined;
    const complete = progress === undefined ? dependency.state === 'done' : progress.total > 0 ? progress.done === progress.total : dependency.state === 'done';
    if (!complete) waiting += 1;
  }
  return waiting;
}

function asDrop(planned: MoveResult, move: MoveKey): { ok: true; move: MoveKey } | { ok: false; reason: string } {
  return planned.ok ? { ok: true, move } : { ok: false, reason: planned.reason };
}

// A drop target as a move: the key to plan, nothing to do when the card is already there, or the one refusal to show on the card (D-13, D-16).
// The viewer's own permission comes first, so a viewer who may not move anything hears that, not a sentence about claims.
export function columnMove(state: TeamState, viewerId: string | undefined, itemId: string, column: BoardColumn): { ok: true; move?: MoveKey } | { ok: false; reason: string } {
  const item = state.items.get(itemId);
  if (item === undefined || !isCard(item)) return { ok: false, reason: REFUSALS.missing };
  const current = effectiveColumn(state.items, item);
  if (current === column) return { ok: true };
  const denied = moveDenial(state, viewerId);
  if (denied !== undefined) return { ok: false, reason: denied };
  const ask = (move: MoveKey): { ok: true; move: MoveKey } | { ok: false; reason: string } => asDrop(planMove(state, viewerId, itemId, move, { reason: PLACEHOLDER_REASON }), move);
  if (current === 'done' || current === 'cancelled') return column === 'backlog' ? ask('reopen') : { ok: false, reason: REFUSALS.terminal };
  if (CLAIM_COLUMNS.includes(column)) return { ok: false, reason: REFUSALS[column as 'claimed' | 'in-progress' | 'in-review' | 'integrating'] };
  switch (column) {
    case 'done': return ask('done');
    case 'cancelled': return ask('cancel');
    case 'backlog': return current === 'ready' ? ask('hold') : { ok: false, reason: REFUSALS.notNow };
    case 'ready': {
      if (current !== 'backlog') return { ok: false, reason: REFUSALS.notNow };
      const { reasons } = readiness(state.items, itemId);
      // A hold that is the only thing in the way is released; anything else is named, so the person knows what to fix.
      if (reasons.length === 1 && reasons[0] === 'held') return ask('release');
      return { ok: false, reason: notReadyRefusal(reasons, waitingOn(state, item), item.kind === 'plan') };
    }
    default: return { ok: false, reason: REFUSALS.notNow };
  }
}

// ---- the model -------------------------------------------------------------------------------------------------------------------------------

function memberName(state: TeamState, id: string | undefined): string {
  const name = id === undefined ? undefined : state.members.get(id)?.name;
  return name === undefined ? SOMEONE : flattenName(name);
}

function displayIdOf(item: WorkItem): string {
  if (item.kind === 'plan') return item.id.slice('plan:'.length);
  if (item.origin === 'board') return `${KIND_WORDS[item.kind] ?? item.kind} ${item.id.slice(-4)}`;
  return item.id;
}

function milestoneOf(state: TeamState, item: WorkItem): string | undefined {
  const phase = item.parentId === undefined ? undefined : state.items.get(item.parentId);
  return phase?.kind === 'phase' ? phase.parentId : undefined;
}

function selectedMilestoneOf(state: TeamState): string {
  const active = [...state.items.values()].filter((item) => item.kind === 'milestone' && item.active === true).map((item) => item.id).sort();
  return active[0] ?? 'all';
}

function visibleUnder(card: BoardCard, selected: string): boolean {
  return selected === 'all' || card.milestoneId === selected || card.milestoneId === undefined;
}

function readOnlyReasonOf(state: TeamState, options: BoardModelOptions): string | undefined {
  const member = options.viewerId === undefined ? undefined : state.members.get(options.viewerId);
  if (member === undefined) return options.readOnlyReason ?? REFUSALS.noDeviceKey;
  if (member.removedEvent !== undefined) return REFUSALS.removed;
  if (!options.canWrite) return options.readOnlyReason ?? REFUSALS.offline;
  if (member.role === 'developer') return READ_ONLY_BANNERS.developer;
  return member.role === 'reviewer' || member.role === 'observer' ? READ_ONLY_BANNERS.lookOnly : undefined;
}

function viewerOf(state: TeamState, options: BoardModelOptions): BoardViewer {
  const member = options.viewerId === undefined ? undefined : state.members.get(options.viewerId);
  const active = member !== undefined && member.removedEvent === undefined;
  const canWrite = options.canWrite && active;
  const allowed = (ownDraft: boolean): boolean => canWrite && options.viewerId !== undefined && decideTeamAction(state, options.viewerId, { kind: 'item.create', ownDraft }).allowed;
  const viewer: BoardViewer = { name: member === undefined ? '' : flattenName(member.name), canWrite, canImport: allowed(false), canCreate: allowed(true) };
  if (member !== undefined) viewer.role = member.role;
  const reason = readOnlyReasonOf(state, options);
  if (reason !== undefined) viewer.readOnlyReason = reason;
  return viewer;
}

function moveGateReason(state: TeamState, options: BoardModelOptions): string | undefined {
  if (!options.canWrite) return options.readOnlyReason ?? (options.viewerId === undefined ? REFUSALS.noDeviceKey : REFUSALS.offline);
  return moveDenial(state, options.viewerId);
}

function cardOf(state: TeamState, options: BoardModelOptions, gate: string | undefined, item: WorkItem): BoardCard {
  const column = effectiveColumn(state.items, item);
  const milestoneId = milestoneOf(state, item);
  const phase = item.parentId !== undefined && state.items.get(item.parentId)?.kind === 'phase' ? item.parentId : undefined;
  const refusals: Partial<Record<BoardColumn, string>> = {};
  for (const target of BOARD_COLUMNS) {
    if (target === column) continue;
    const verdict = gate === undefined ? columnMove(state, options.viewerId, item.id, target) : { ok: false as const, reason: gate };
    if (!verdict.ok) refusals[target] = verdict.reason;
  }
  const blocked = item.blocked === undefined ? undefined : { reason: flattenName(item.blocked.reason, 200), byName: memberName(state, item.blocked.by), since: item.blocked.since };
  const doneInGsd = item.summary === true && item.state !== 'done' && item.state !== 'cancelled';
  const age = ageText(options.nowMs, item.stateSince);
  const card: BoardCard = {
    id: item.id, displayId: displayIdOf(item), kind: item.kind, title: flattenName(item.title, 200), column, stateLabel: COLUMN_LABELS[column],
    lane: { member: 'unassigned', phase: phase ?? 'board', milestone: milestoneId ?? 'board' }, requirements: [...item.requirements],
    mine: item.origin === 'board' && options.viewerId !== undefined && item.createdBy === options.viewerId,
    held: item.hold === true, doneInGsd, dependencyCount: item.dependsOn.length, estimateText: estimateText(item.estimate?.tokens), ageText: age,
    moves: gate === undefined ? availableMoves(state, options.viewerId, item.id) : [], refusals,
    a11yLabel: cardLabel({
      isPlan: item.kind === 'plan', displayId: displayIdOf(item), title: flattenName(item.title, 200), stateLabel: COLUMN_LABELS[column], ...(blocked === undefined ? {} : { blockedReason: blocked.reason }),
      held: item.hold === true, doneInGsd, cancelled: column === 'cancelled', dependencyCount: item.dependsOn.length, ...(item.estimate === undefined ? {} : { estimateTokens: item.estimate.tokens }), age
    })
  };
  if (phase !== undefined) card.phaseId = phase;
  if (milestoneId !== undefined) card.milestoneId = milestoneId;
  if (blocked !== undefined) card.blocked = blocked;
  if (item.origin === 'board' && item.createdBy !== undefined) card.createdByName = memberName(state, item.createdBy);
  return card;
}

// ---- ordering and numbers --------------------------------------------------------------------------------------------------------------------

// "9" before "10" before "10.1": each dot-separated part is compared as an integer when both are digits, and a shorter number comes first.
function compareParts(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const order = numeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (order !== 0) return order;
  }
  return 0;
}

function planParts(item: WorkItem): { phase: string; plan: string } {
  const key = item.id.slice('plan:'.length);
  const cut = key.lastIndexOf('-');
  return cut < 0 ? { phase: key, plan: '' } : { phase: key.slice(0, cut), plan: key.slice(cut + 1) };
}

function comparePlans(a: WorkItem, b: WorkItem): number {
  const left = planParts(a);
  const right = planParts(b);
  return compareParts(left.phase, right.phase) || compareParts(left.plan, right.plan) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function progressView(items: ReadonlyMap<string, WorkItem>, id: string): BoardProgress {
  const { percent, done, total } = progressOf(items, id);
  return { percent, done, total, text: total === 0 ? NO_PLANS_TEXT : `${percent}%, ${done} of ${total} plans done` };
}

function phaseNumber(item: WorkItem): string {
  return item.id.slice('phase:'.length);
}

function phaseLabel(item: WorkItem): string {
  return `Phase ${phaseNumber(item)}: ${flattenName(item.title, 200)}`;
}

function milestonesOf(state: TeamState): WorkItem[] {
  const bare = (item: WorkItem): string => item.id.slice('milestone:'.length).replace(/^v/i, '');
  return [...state.items.values()].filter((item) => item.kind === 'milestone')
    .sort((a, b) => Number(b.active === true) - Number(a.active === true) || compareParts(bare(a), bare(b)) || (a.id < b.id ? -1 : 1));
}

function phasesOf(state: TeamState): WorkItem[] {
  return [...state.items.values()].filter((item) => item.kind === 'phase').sort((a, b) => compareParts(phaseNumber(a), phaseNumber(b)) || (a.id < b.id ? -1 : 1));
}

function lanesOf(state: TeamState, cards: readonly BoardCard[], shown: readonly BoardCard[]): BoardModel['lanes'] {
  const countBy = (pick: (card: BoardCard) => string, key: string): number => shown.filter((card) => pick(card) === key).length;
  const hasBoardItems = cards.some((card) => state.items.get(card.id)?.origin === 'board');
  const boardLane = (pick: (card: BoardCard) => string): BoardLane[] => (hasBoardItems ? [{ key: 'board', label: BOARD_LANE_LABEL, count: countBy(pick, 'board'), collapsedByDefault: false }] : []);
  const phase: BoardLane[] = phasesOf(state).map((item) => {
    const progress = progressView(state.items, item.id);
    return {
      key: item.id, label: phaseLabel(item), count: countBy((card) => card.lane.phase, item.id), collapsedByDefault: progress.total === 0,
      ...(item.parentId === undefined ? {} : { milestoneId: item.parentId }), progress
    };
  });
  const milestone: BoardLane[] = milestonesOf(state).map((item) => {
    const progress = progressView(state.items, item.id);
    return { key: item.id, label: flattenName(item.title, 200), count: countBy((card) => card.lane.milestone, item.id), collapsedByDefault: progress.total === 0, milestoneId: item.id, progress };
  });
  return {
    member: [{ key: 'unassigned', label: UNASSIGNED_LABEL, count: shown.length, collapsedByDefault: false }],
    phase: [...phase, ...boardLane((card) => card.lane.phase)],
    milestone: [...milestone, ...boardLane((card) => card.lane.milestone)],
    none: [{ key: 'all', label: ALL_CARDS_LABEL, count: shown.length, collapsedByDefault: false }]
  };
}

export function buildBoardModel(state: TeamState, options: BoardModelOptions): BoardModel {
  const gate = moveGateReason(state, options);
  const entries = [...state.items.values()].filter(isCard).map((item, seq) => ({ item, seq, card: cardOf(state, options, gate, item) }));
  // Column by column in board order; inside a column plans go by phase then plan number and board items follow in log order. Done and Cancelled run
  // the other way, newest number first. Nothing here reads a clock, so every client that replays the same log lists the same cards in the same order.
  entries.sort((a, b) => {
    const byColumn = BOARD_COLUMNS.indexOf(a.card.column) - BOARD_COLUMNS.indexOf(b.card.column);
    if (byColumn !== 0) return byColumn;
    const aPlan = a.item.kind === 'plan';
    if (aPlan !== (b.item.kind === 'plan')) return aPlan ? -1 : 1;
    const order = aPlan ? comparePlans(a.item, b.item) : a.seq - b.seq;
    return a.card.column === 'done' || a.card.column === 'cancelled' ? -order : order;
  });
  const cards = entries.map((entry) => entry.card);
  const selected = selectedMilestoneOf(state);
  const shown = cards.filter((card) => visibleUnder(card, selected));
  const columns: BoardColumnInfo[] = BOARD_COLUMNS.map((key) => {
    const caption = COLUMN_CAPTIONS[key];
    return { key, label: COLUMN_LABELS[key], ...(caption === undefined ? {} : { caption }), count: shown.filter((card) => card.column === key).length };
  });
  const milestones: BoardMilestone[] = milestonesOf(state).map((item) => ({ id: item.id, title: flattenName(item.title, 200), active: item.active === true, progress: progressView(state.items, item.id) }));
  const phases: BoardPhase[] = phasesOf(state).map((item) => ({ id: item.id, title: phaseLabel(item), ...(item.parentId === undefined ? {} : { milestoneId: item.parentId }) }));
  const requirements = [...new Set(cards.flatMap((card) => card.requirements))].sort();
  return {
    status: options.status, viewer: viewerOf(state, options), columns, milestones, selectedMilestone: selected, phases, requirements, lanes: lanesOf(state, cards, shown), cards,
    counts: { cards: shown.length, ready: shown.filter((card) => card.column === 'ready').length, blocked: shown.filter((card) => card.blocked !== undefined).length }
  };
}

// ---- card detail -----------------------------------------------------------------------------------------------------------------------------

// "62-01" for a plan, "Phase 62" for a phase: what a dependency row calls an id, whether or not the item is still on the board.
function idLabel(id: string): string {
  const cut = id.indexOf(':');
  const rest = cut < 0 ? id : id.slice(cut + 1);
  return id.startsWith('phase:') ? `Phase ${rest}` : rest;
}

function dependencyRows(state: TeamState, item: WorkItem): CardDetail['dependencies'] {
  return item.dependsOn.map((id) => {
    const dependency = state.items.get(id);
    if (dependency === undefined) return { id, label: `${idLabel(id)} (not on the board)`, done: false, onBoard: false };
    let done: boolean;
    let stateLabel: string;
    if (dependency.kind === 'phase') {
      const progress = progressOf(state.items, id);
      done = progress.total > 0 ? progress.done === progress.total : dependency.state === 'done';
      stateLabel = done ? COLUMN_LABELS.done : 'Not done';
    } else {
      const column = isCard(dependency) ? effectiveColumn(state.items, dependency) : dependency.state;
      done = column === 'done';
      stateLabel = COLUMN_LABELS[column];
    }
    return { id, label: `${idLabel(id)} ${flattenName(dependency.title, 200)}`, stateLabel, done, onBoard: true };
  });
}

function taskRows(state: TeamState, item: WorkItem): CardDetail['tasks'] {
  const index = (task: WorkItem): number => Number(task.id.slice(task.id.lastIndexOf('-') + 1)) || 0;
  const tasks = [...state.items.values()].filter((task) => task.kind === 'task' && task.parentId === item.id).sort((a, b) => index(a) - index(b) || (a.id < b.id ? -1 : 1));
  const rows = tasks.map((task) => ({ id: task.id, title: flattenName(task.title, 200), done: task.state === 'done' || item.state === 'done' }));
  const done = rows.filter((row) => row.done).length;
  return { done, total: rows.length, summary: rows.length === 0 ? '' : `${done} of ${rows.length} ${rows.length === 1 ? 'task' : 'tasks'} done`, items: rows };
}

// The history entry does not store which way a hold went. It is worked out from what the log guarantees: holds and releases alternate, an item
// starts without a hold, and cancel, reopen and mark done each end one. Forward from the item's creation and from each ending first, then backward
// from the item's current hold for whatever is left; a hold that neither pass can place is reported as "changed".
function holdDirections(entries: readonly HistoryEntry[], currentlyHeld: boolean): Map<string, 'on' | 'off'> {
  const isHoldChange = (entry: HistoryEntry): boolean => entry.type === 'item.updated' && entry.changed?.includes('hold') === true;
  const endsHold = (entry: HistoryEntry): boolean => entry.type === 'item.cancelled' || entry.type === 'item.reopened' || (entry.type === 'item.updated' && entry.changed?.includes('state') === true);
  const found = new Map<string, 'on' | 'off'>();
  const oldest = entries[entries.length - 1];
  let held: boolean | null = oldest !== undefined && (oldest.type === 'item.imported' || oldest.type === 'item.created') ? false : null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as HistoryEntry;
    if (endsHold(entry)) held = false;
    else if (isHoldChange(entry) && held !== null) {
      found.set(entry.eventId, held ? 'off' : 'on');
      held = !held;
    }
  }
  let after: boolean | null = currentlyHeld;
  for (const entry of entries) {
    if (endsHold(entry)) after = null;
    else if (isHoldChange(entry)) {
      const known = found.get(entry.eventId);
      if (known === undefined && after !== null) found.set(entry.eventId, after ? 'on' : 'off');
      const direction = found.get(entry.eventId);
      after = direction === undefined ? null : direction === 'on' ? false : true;
    }
  }
  return found;
}

export function buildCardDetail(state: TeamState, itemId: string, options: { viewerId?: string; nowMs: number; history: readonly HistoryEntry[] }): CardDetail | undefined {
  const item = state.items.get(itemId);
  if (item === undefined || !isCard(item)) return undefined;
  const column = effectiveColumn(state.items, item);
  const phase = item.parentId === undefined ? undefined : state.items.get(item.parentId);
  const milestone = phase?.parentId === undefined ? undefined : state.items.get(phase.parentId);
  const blocked = item.blocked === undefined ? undefined : { reason: flattenName(item.blocked.reason, 200), byName: memberName(state, item.blocked.by), since: item.blocked.since };
  const doneInGsd = item.summary === true && item.state !== 'done' && item.state !== 'cancelled';
  const facts: CardDetail['facts'] = { estimate: estimateText(item.estimate?.tokens), age: ageText(options.nowMs, item.stateSince), source: item.origin === 'board' ? SOURCE_BOARD_TEXT : SOURCE_IMPORT_TEXT };
  if (phase?.kind === 'phase') facts.phase = phaseLabel(phase);
  if (milestone?.kind === 'milestone') facts.milestone = flattenName(milestone.title, 200);
  if (item.gsd?.wave !== undefined) facts.wave = item.gsd.wave;
  if (item.origin === 'board' && item.createdBy !== undefined) facts.createdBy = memberName(state, item.createdBy);
  const waiting = waitingOn(state, item);
  const { reasons } = readiness(state.items, itemId);
  const viewerId = options.viewerId;
  const editable = item.origin === 'board' && viewerId !== undefined && decideTeamAction(state, viewerId, { kind: 'item.edit', ownDraft: isOwnDraft(state, itemId, viewerId) }).allowed;
  const entries = options.history.slice(0, MAX_HISTORY_PER_ITEM);
  const directions = holdDirections(entries, item.hold === true);
  const detail: CardDetail = {
    itemId, displayId: displayIdOf(item), title: flattenName(item.title, 200), kind: item.kind, kindLabel: KIND_WORDS[item.kind] ?? item.kind, column, stateLabel: COLUMN_LABELS[column],
    held: item.hold === true, doneInGsd, facts, mustHaves: item.mustHaves.map((text) => flattenName(text, 600)), requirements: [...item.requirements],
    dependencies: dependencyRows(state, item), files: item.scope.map((entry) => flattenName(entry, 200)), tasks: taskRows(state, item),
    notReady: column === 'backlog' ? notReadySentences(reasons, waiting) : [], editable,
    history: entries.map((entry) => {
      const direction = directions.get(entry.eventId);
      return { at: entry.at, text: historySentence(entry, state.members.get(entry.author)?.name ?? '', { origin: item.origin, ...(direction === undefined ? {} : { hold: direction }) }) };
    })
  };
  if (item.estimate !== undefined) detail.estimateTokens = item.estimate.tokens;
  if (item.description !== undefined) detail.description = stripFormatControls(item.description);
  if (blocked !== undefined) detail.blocked = blocked;
  if (entries.length === MAX_HISTORY_PER_ITEM) detail.historyNote = HISTORY_LIMIT_TEXT;
  return detail;
}
