// Team Board model (RED stub): types are final, behaviour arrives with the GREEN commit.
import type { HistoryEntry } from './itemHistory';
import type { ItemBlockedBody, ItemCancelledBody, ItemKind, ItemReopenedBody, ItemUnblockedBody, ItemUpdatedBody, Role, TeamState } from './types';
import type { BoardColumn } from './work';

export const MOVE_KEYS = ['done', 'cancel', 'hold', 'release', 'reopen', 'block', 'unblock'] as const;
export type MoveKey = typeof MOVE_KEYS[number];
export interface CardMove { key: MoveKey; label: string; column?: BoardColumn; prompt: 'none' | 'reason' | 'confirm'; dependents?: number }
export type MoveIntent =
  | { type: 'item.updated'; body: ItemUpdatedBody } | { type: 'item.blocked'; body: ItemBlockedBody } | { type: 'item.unblocked'; body: ItemUnblockedBody }
  | { type: 'item.cancelled'; body: ItemCancelledBody } | { type: 'item.reopened'; body: ItemReopenedBody };

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

export function planMove(_state: TeamState, _viewerId: string | undefined, _itemId: string, _move: MoveKey, _input?: { reason?: string }): { ok: true; intent: MoveIntent } | { ok: false; reason: string } {
  return { ok: false, reason: '' };
}

export function availableMoves(_state: TeamState, _viewerId: string | undefined, _itemId: string): CardMove[] {
  return [];
}

export function columnMove(_state: TeamState, _viewerId: string | undefined, _itemId: string, _column: BoardColumn): { ok: true; move?: MoveKey } | { ok: false; reason: string } {
  return { ok: false, reason: '' };
}

export function buildBoardModel(_state: TeamState, options: BoardModelOptions): BoardModel {
  const empty: BoardLane[] = [];
  return {
    status: options.status, viewer: { name: '', canWrite: false, canImport: false, canCreate: false }, columns: [], milestones: [], selectedMilestone: '', phases: [], requirements: [],
    lanes: { member: empty, phase: empty, milestone: empty, none: empty }, cards: [], counts: { cards: 0, ready: 0, blocked: 0 }
  };
}

export function buildCardDetail(_state: TeamState, _itemId: string, _options: { viewerId?: string; nowMs: number; history: readonly HistoryEntry[] }): CardDetail | undefined {
  return undefined;
}
