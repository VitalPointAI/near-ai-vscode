// Card history (D-18, A9): a bounded, in-memory view of the accepted item events a board adapter has been shown. It is not part of TeamState,
// a snapshot or the state hash, and it is never persisted; a reload rebuilds it from the log. Pure: no I/O, no clock, no vscode. The `at` it
// keeps is the event's own display-only time and orders nothing.
import type { CommittedEvent, ImplementedTeamEvent } from './types';

export const MAX_HISTORY_PER_ITEM = 50;

// memberId is the person an item.assigned put on the card, or the one an item.unassigned took off (G-62-5).
export interface HistoryEntry { eventId: string; type: string; author: string; at: string; reason?: string; changed?: string[]; memberId?: string }

// assignees is the history's own view of who is on each card, followed from the same accepted events, so an unassign can name who it removed.
function entryFor(event: ImplementedTeamEvent, assignees: ReadonlyMap<string, string>): { itemId: string; entry: HistoryEntry } | undefined {
  const entry: HistoryEntry = { eventId: event.id, type: event.type, author: event.author, at: event.at };
  switch (event.type) {
    case 'item.assigned':
      entry.memberId = event.body.memberId;
      return { itemId: event.body.id, entry };
    case 'item.unassigned': {
      const removed = assignees.get(event.body.id);
      if (removed !== undefined) entry.memberId = removed;
      return { itemId: event.body.id, entry };
    }
    case 'item.imported':
    case 'item.created':
    case 'item.unblocked':
    case 'item.reopened':
      return { itemId: event.body.id, entry };
    case 'item.blocked':
    case 'item.cancelled':
      entry.reason = event.body.reason;
      return { itemId: event.body.id, entry };
    case 'item.updated':
      entry.changed = Object.keys(event.body.changes).sort();
      return { itemId: event.body.id, entry };
    case 'item.estimated':
      entry.changed = ['estimate'];
      return { itemId: event.body.id, entry };
    default:
      return undefined;
  }
}

export class ItemHistory {
  // Newest first. Only plain entries are kept: nothing here points into the state, so the state can be replaced or discarded freely.
  private readonly byItem = new Map<string, HistoryEntry[]>();
  // Item id to the member on it, as the accepted events left it. Plain ids only, like the entries.
  private readonly assignees = new Map<string, string>();

  // Feed committed entries in log order. Only entries a reader accepted count, and only item events: a rejected or foreign entry says nothing
  // about a card. An event that is already in an item's list is skipped, so showing the same entries twice adds nothing.
  public record(entries: readonly CommittedEvent[]): void {
    for (const committed of entries) {
      const verdict = committed.verdict;
      if (verdict === undefined || !verdict.accepted || verdict.event === undefined) continue;
      // An accepted event is always one of the implemented types (the reader refuses the rest), so the narrowing only tells the compiler so.
      const event = verdict.event as ImplementedTeamEvent;
      if (event.type === 'member.removed') {
        // Removal clears the member's cards in the materialiser; the history follows so a later unassign names only who was really on the card.
        for (const [itemId, memberId] of this.assignees) if (memberId === event.body.memberId) this.assignees.delete(itemId);
        continue;
      }
      if (!event.type.startsWith('item.')) continue;
      const found = entryFor(event, this.assignees);
      if (found === undefined) continue;
      const list = this.byItem.get(found.itemId) ?? [];
      if (list.some((existing) => existing.eventId === found.entry.eventId)) continue;
      if (event.type === 'item.assigned') this.assignees.set(event.body.id, event.body.memberId);
      if (event.type === 'item.unassigned') this.assignees.delete(event.body.id);
      list.unshift(found.entry);
      if (list.length > MAX_HISTORY_PER_ITEM) list.length = MAX_HISTORY_PER_ITEM;
      this.byItem.set(found.itemId, list);
    }
  }

  // A copy, newest first, so a caller cannot change what is kept.
  public forItem(itemId: string): HistoryEntry[] {
    return (this.byItem.get(itemId) ?? []).map((entry) => ({ ...entry, ...(entry.changed === undefined ? {} : { changed: [...entry.changed] }) }));
  }
}
