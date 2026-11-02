// Card history (D-18, A9): a bounded, in-memory view of the accepted item events a board adapter has been shown. It is not part of TeamState,
// a snapshot or the state hash, and it is never persisted; a reload rebuilds it from the log. Pure: no I/O, no clock, no vscode. The `at` it
// keeps is the event's own display-only time and orders nothing.
import type { CommittedEvent, ImplementedTeamEvent } from './types';

export const MAX_HISTORY_PER_ITEM = 50;

export interface HistoryEntry { eventId: string; type: string; author: string; at: string; reason?: string; changed?: string[] }

export class ItemHistory {
  public record(_entries: readonly CommittedEvent[]): void {
    // not built yet
  }

  public forItem(_itemId: string): HistoryEntry[] {
    return [];
  }
}

export type ItemEvent = Extract<ImplementedTeamEvent, { type: `item.${string}` }>;
