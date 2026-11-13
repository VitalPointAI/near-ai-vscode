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

/** Tells the hooks that a run started in this project. Call it with `runEnded` for the same project when the run ends. */
export function runStarted(root: string): void {
  const key = path.resolve(root);
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
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
  const left = (inFlight.get(key) ?? 0) - 1;
  if (left > 0) inFlight.set(key, left); else inFlight.delete(key);
  await Promise.all([...listeners].map(async (listener) => {
    try { await listener(event); } catch { /* a hook never breaks a run */ }
  }));
}
