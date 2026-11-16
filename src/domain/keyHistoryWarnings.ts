// Where a key-history warning goes when the code that raised it passed no `warn` of its own (0.4.26, PR #62 review). Team Mode installs its output
// channel here when it registers (0.4.27, PR #67 review: it used to install it only when Enable ran or a session started, so a rotation or revocation
// before either warned nowhere, and two of those at once could install two sinks). This module has no imports, so the command layer installs the sink
// at registration without loading any team module: a solo project still loads none.
//
// Sinks are kept in a list rather than "the current one and the one before": disposing a sink removes exactly that sink, so a disposed one (a channel
// that is gone) can never come back as the current sink, whatever order they are disposed in. The newest sink still in the list receives warnings.

type Sink = (message: string) => void;
const sinks: Array<{ sink: Sink }> = [];

/** Installs a sink; the disposer removes exactly this one. Never given key material. */
export function setKeyHistoryWarningSink(sink: Sink | undefined): { dispose(): void } {
  if (sink === undefined) return { dispose: (): void => undefined };
  const entry = { sink };
  sinks.push(entry);
  return { dispose: (): void => { const index = sinks.indexOf(entry); if (index >= 0) sinks.splice(index, 1); } };
}

/** The sink a warning goes to when its caller passed none: the newest one installed and not yet disposed. */
export function keyHistoryWarningSink(): Sink | undefined {
  return sinks.at(-1)?.sink;
}
