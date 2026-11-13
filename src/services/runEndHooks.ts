// What happens when an agent run ends, for code that needs to know without being part of the run (retention of old threads today; sync after it).
// A listener never breaks a run: its failure, thrown or rejected, is swallowed. No vscode here.

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

/** Calls `listener` after every run that ends. Dispose the result to stop. */
export function onRunEnded(listener: RunEndedListener): { dispose(): void } {
  // Wrapped so that adding one function twice gives two independent registrations.
  const entry: RunEndedListener = (event) => listener(event);
  listeners.add(entry);
  return { dispose: () => { listeners.delete(entry); } };
}

/** Tells every listener that a run ended. Resolves when they have all finished; never rejects. */
export async function runEnded(event: RunEndedEvent): Promise<void> {
  await Promise.all([...listeners].map(async (listener) => {
    try { await listener(event); } catch { /* a hook never breaks a run */ }
  }));
}
