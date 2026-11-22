// The shape every collector shares (D-23). A collector turns one source of evidence (CI results, audits, settings, documents and the rest) into
// Observations that hold only ids, counts, hashes, run addresses, times and pass or fail (D-24). The network edge is injected, so no unit test
// touches the network.
import type { Observation, WindowKind } from '../model.ts';

/** Fetches a URL and returns its parsed JSON. Injected so collectors' unit tests run on fixtures. */
export type FetchJson = (url: string, init?: { readonly method?: string; readonly headers?: Readonly<Record<string, string>> }) => Promise<unknown>;

/** What a collector may read from its surroundings. */
export interface CollectorContext {
  /** The clock; observations are stamped with it. */
  readonly now: Date;
  /** The commit the evidence is collected for. */
  readonly commit: string;
  readonly runUrl?: string;
  readonly fetchJson?: FetchJson;
  /** Reads a file as UTF-8 text, relative to the repository root unless absolute. */
  readonly readFile: (file: string) => Promise<string>;
}

/** One collector. `window` is how long its evidence stays fresh (D-09). */
export interface Collector<Input = unknown> {
  readonly id: string;
  readonly window: WindowKind;
  collect(input: Input, context: CollectorContext): Promise<Observation[]>;
}

/** A collector's run as the bundle records it: its observations and anything that stopped it, so a silent collector cannot look green. */
export interface CollectorResult {
  readonly collector: string;
  readonly observations: readonly Observation[];
  readonly errors: readonly string[];
}
