// The last step of startup, after the server listens: read what relay.listening needs, register the stop handlers, then announce.
//
// Regression (PR #54): relay.listening was logged before the SIGTERM handler existed, so a supervisor (or a test) that stopped the relay as soon
// as it saw that line could hit the default kill instead of a clean stop. The order lives here, in one function the tests call directly.

export type StopSignal = 'SIGTERM' | 'SIGINT';

export interface StartupFinish<T> {
  /** Reads everything the announcement needs (the instance id). A failure rejects before any handler is registered. */
  read: () => Promise<T>;
  /** Where the stop handlers go: `process` in the relay. */
  signals: { on(signal: StopSignal, listener: () => void): unknown };
  stop: (signal: StopSignal) => void;
  /** Logs relay.listening. Called synchronously right after the handlers are registered, so a stop sent on that line is always a clean one. */
  announce: (read: T) => void;
}

/**
 * Reads first, so a stop can never run while the read is in flight; then registers the SIGTERM and SIGINT handlers; then announces, with nothing
 * awaited in between. Returns what was read.
 */
export async function finishStartup<T>(steps: StartupFinish<T>): Promise<T> {
  const read = await steps.read();
  steps.signals.on('SIGTERM', () => steps.stop('SIGTERM'));
  steps.signals.on('SIGINT', () => steps.stop('SIGINT'));
  steps.announce(read);
  return read;
}
