// Which threads of a project stay live and which are archived (D-08). Pure: no vscode, no files. Nothing here decides to delete a thread: a thread that
// is not live is archived, and an archived thread is kept whole and reopens on request.

/** How many of the most recently used conversations stay live when the person has not chosen (nearAi.history.liveConversations). */
export const LIVE_CONVERSATIONS_DEFAULT = 5;
export const LIVE_CONVERSATIONS_MIN = 1;
export const LIVE_CONVERSATIONS_MAX = 50;

/** An integer from 1 to 50; anything that is not a finite number gives the default. */
export function clampLiveConversations(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return LIVE_CONVERSATIONS_DEFAULT;
  return Math.min(LIVE_CONVERSATIONS_MAX, Math.max(LIVE_CONVERSATIONS_MIN, Math.floor(value)));
}

/** What the rank rule needs of a thread. */
export interface RankedThread { id: string; lastUsedAt: string }

/**
 * Splits threads into the ones that stay live and the ones to archive. The `liveCount` most recently used threads are live (equal times rank by
 * thread id, ascending, so every editor places and lists them the same way), and so is every id in `protectedIds` (a thread open in a tab, or one
 * with a run that is running here or elsewhere), in addition. Both lists are in rank order. A protected id that is not among the threads is ignored.
 */
export function rankThreads(index: readonly RankedThread[], liveCount: number, protectedIds: Iterable<string> = []): { live: string[]; archive: string[] } {
  const keep = new Set(protectedIds);
  const count = clampLiveConversations(liveCount);
  const ranked = [...index].sort((a, b) => (a.lastUsedAt === b.lastUsedAt ? 0 : a.lastUsedAt > b.lastUsedAt ? -1 : 1) || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
  const live: string[] = [];
  const archive: string[] = [];
  ranked.forEach((thread, position) => { (position < count || keep.has(thread.id) ? live : archive).push(thread.id); });
  return { live, archive };
}
