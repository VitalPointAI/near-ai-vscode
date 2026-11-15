// What happens when an agent run ends, for code that needs to know without being part of the run (retention of old threads today; sync after it).
// A listener never breaks a run: its failure, thrown or rejected, is swallowed. No vscode here.
import * as path from 'node:path';

export interface RunEndedEvent {
  /** The project folder the run belongs to. */
  root: string;
  conversationId: string;
  runId: string;
  /** How the conversation stands after the run ('done', 'stopped', 'failed' and so on). */
  outcome: string;
}

type RunEndedListener = (event: RunEndedEvent) => void | Promise<void>;

const listeners = new Set<RunEndedListener>();
/** How many runs are in flight in this editor, by project folder: sync never starts while one is (D-17). */
const inFlight = new Map<string, number>();
/** The conversations whose run is in flight in this editor, by project folder (a count each: a conversation runs once at a time, but never trust that). */
const liveIds = new Map<string, Map<string, number>>();
/** When each live conversation's run started in this editor (the first of its runs still counted), by project folder: see reconcileLiveConversations. */
const liveSince = new Map<string, Map<string, number>>();
/**
 * How long a live conversation is trusted without a run marker that backs it. A run writes its marker within moments of starting (agentSession.send);
 * the grace keeps a run that has just started, whose marker is not written yet, live.
 */
export const LIVE_UNBACKED_GRACE_MS = 2 * 60_000;
/** Runs reconcileLiveConversations dropped, by project folder and conversation: their end, if it comes after all, is not counted a second time. */
const dropped = new Map<string, Map<string, number>>();
/** The conversations whose run waits on the person right now (an approval or a question is open), by project folder. */
const waitingIds = new Map<string, Set<string>>();
/** Who hears of a quiet point: a moment a run in flight has its state saved and waits (on the person or between model turns). */
const quietListeners = new Set<(root: string) => void>();

/**
 * Tells the hooks that a run started in this project, for `conversationId` when it is known (a project sync never rewrites that conversation while it runs).
 * Call it with `runEnded` for the same project when the run ends.
 */
export function runStarted(root: string, conversationId?: string, now: number = Date.now()): void {
  const key = path.resolve(root);
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  if (conversationId === undefined) return;
  const ids = liveIds.get(key) ?? new Map<string, number>();
  ids.set(conversationId, (ids.get(conversationId) ?? 0) + 1);
  liveIds.set(key, ids);
  const since = liveSince.get(key) ?? new Map<string, number>();
  if (!since.has(conversationId)) since.set(conversationId, now);
  liveSince.set(key, since);
}

/**
 * The live conversations, after dropping each one no run marker backs (#48 review). A conversation leaves the live set on a `runEnded` with its id; if
 * that end never came (a run path that did not call it, a throw before it), the conversation stayed live all session and its context never synced. Here
 * a conversation live for longer than `graceMs` whose run marker does not say its run is running in this editor (`backed`) is forgotten, with the runs it
 * counted in flight, so sync and the scheduler see the project as it is. A failing `backed` keeps the conversation live (the safe side).
 */
export async function reconcileLiveConversations(root: string, backed: (conversationId: string) => Promise<boolean>, graceMs: number = LIVE_UNBACKED_GRACE_MS, now: number = Date.now()): Promise<string[]> {
  const key = path.resolve(root);
  for (const id of liveConversations(key)) {
    const since = liveSince.get(key)?.get(id) ?? now;
    if (now - since <= graceMs) continue;
    if (await backed(id).catch(() => true)) continue;
    const ids = liveIds.get(key);
    const count = ids?.get(id);
    if (!ids || count === undefined) continue;
    ids.delete(id);
    if (!ids.size) liveIds.delete(key);
    forgetSince(key, id);
    const gone = dropped.get(key) ?? new Map<string, number>();
    gone.set(id, (gone.get(id) ?? 0) + count);
    dropped.set(key, gone);
    const left = (inFlight.get(key) ?? 0) - count;
    if (left > 0) inFlight.set(key, left); else inFlight.delete(key);
    waitingIds.get(key)?.delete(id);
    if (waitingIds.get(key)?.size === 0) waitingIds.delete(key);
  }
  return liveConversations(key);
}

function forgetSince(key: string, conversationId: string): void {
  const since = liveSince.get(key);
  since?.delete(conversationId);
  if (since && !since.size) liveSince.delete(key);
}

/** The conversations whose run is in flight in this editor for the project. */
export function liveConversations(root: string): string[] {
  return [...(liveIds.get(path.resolve(root))?.keys() ?? [])];
}

/**
 * A run in flight in this project reached a quiet point: it is waiting on the person (an approval or a question is open), or its state was just saved
 * between model turns. Project sync may run then (owner, 2026-11-14). A listener never breaks a run.
 */
export function runQuiet(root: string): void {
  const key = path.resolve(root);
  for (const listener of [...quietListeners]) { try { listener(key); } catch { /* a hook never breaks a run */ } }
}

/** Says whether a conversation's run is waiting on the person; becoming so is a quiet point (runQuiet). */
export function runWaiting(root: string, conversationId: string, waiting: boolean): void {
  const key = path.resolve(root);
  const ids = waitingIds.get(key) ?? new Set<string>();
  const was = ids.has(conversationId);
  if (waiting) ids.add(conversationId); else ids.delete(conversationId);
  if (ids.size) waitingIds.set(key, ids); else waitingIds.delete(key);
  if (waiting && !was) runQuiet(key);
}

/** How many runs in flight in this editor wait on the person for the project. */
export function runsWaiting(root: string): number {
  const key = path.resolve(root);
  const live = liveIds.get(key);
  return [...(waitingIds.get(key) ?? [])].filter((id) => live?.has(id)).length;
}

/** Calls `listener` at every quiet point of a run (see runQuiet). Dispose the result to stop. */
export function onRunQuiet(listener: (root: string) => void): { dispose(): void } {
  const entry = (root: string): void => listener(root);
  quietListeners.add(entry);
  return { dispose: () => { quietListeners.delete(entry); } };
}

/** How many runs are in flight in this editor for the project (0 when none). */
export function runsInFlight(root: string): number {
  return inFlight.get(path.resolve(root)) ?? 0;
}

/** Calls `listener` after every run that ends. Dispose the result to stop. */
export function onRunEnded(listener: RunEndedListener): { dispose(): void } {
  // Wrapped so that adding one function twice gives two independent registrations.
  const entry: RunEndedListener = (event) => listener(event);
  listeners.add(entry);
  return { dispose: () => { listeners.delete(entry); } };
}

/** Tells every listener that a run ended. Resolves when they have all finished; never rejects. */
export async function runEnded(event: RunEndedEvent): Promise<void> {
  // The count drops before any listener hears of it, so a listener that syncs sees the project as idle.
  const key = path.resolve(event.root);
  // The end of a run reconcileLiveConversations already dropped was counted then; it must not take the count of another run in flight.
  const gone = dropped.get(key);
  const goneCount = gone?.get(event.conversationId);
  if (gone && goneCount !== undefined && !liveIds.get(key)?.has(event.conversationId)) {
    if (goneCount > 1) gone.set(event.conversationId, goneCount - 1); else gone.delete(event.conversationId);
    if (!gone.size) dropped.delete(key);
  } else {
    const left = (inFlight.get(key) ?? 0) - 1;
    if (left > 0) inFlight.set(key, left); else inFlight.delete(key);
  }
  waitingIds.get(key)?.delete(event.conversationId);
  if (waitingIds.get(key)?.size === 0) waitingIds.delete(key);
  const ids = liveIds.get(key);
  const count = ids?.get(event.conversationId);
  if (ids && count !== undefined) {
    if (count > 1) ids.set(event.conversationId, count - 1); else { ids.delete(event.conversationId); forgetSince(key, event.conversationId); }
    if (!ids.size) liveIds.delete(key);
  }
  await Promise.all([...listeners].map(async (listener) => {
    try { await listener(event); } catch { /* a hook never breaks a run */ }
  }));
}
