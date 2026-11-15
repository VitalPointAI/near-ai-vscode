// The coordination transport contract (D-18 as amended by D-29). The git transport implements it now; the relay in a later phase implements the same shape.
// Commit timestamps travel on CommittedEvent for lease and offer TTL logic only. They are never used to order events.
import type { CommittedEvent, LogHead, TeamEvent } from '../domain/team/types';

export type TransportState = 'ok' | 'paused' | 'offline';
export interface TransportStatus { state: TransportState; reason?: string }

// The remote no longer has a coordination branch this client has already read. It is not a rewrite (that pauses for good) and not a network
// problem, so it gets its own visible, self-healing state: sync resumes when the branch comes back.
export const BRANCH_MISSING_REASON = 'The coordination branch is missing on the remote. NEAR AI keeps the last good copy and checks again.';

// A builder may return events, events plus extra files for the same commit, or a conflict that stops the append.
export type AppendBuild = TeamEvent[] | { events: TeamEvent[]; files?: Array<{ path: string; text: string }> } | { conflict: string };
// The builder is called again after every lost race so lamport, prev and the signature are re-derived from the fresh state (D-29).
export type AppendBuilder<S> = (state: S, head: LogHead) => AppendBuild | Promise<AppendBuild>;
export interface AppendOptions { genesis?: { teamFileText: string } }
export type AppendFailureKind = 'refused' | 'conflict' | 'busy' | 'exists' | 'remote-rejected' | 'offline' | 'paused';
export type AppendResult =
  | { ok: true; events: TeamEvent[]; commit: string; attempts: number }
  | { ok: false; kind: AppendFailureKind; reason: string; attempts: number };
export interface TransportSubscription { dispose(): void }

export interface CoordinationTransport<S> {
  // Fetch new entries, apply them to the transport state and return them in log order.
  fetch(): Promise<CommittedEvent[]>;
  // Read the whole log from the first commit without applying it (used for full verification).
  readAll(): Promise<CommittedEvent[]>;
  append(build: AppendBuilder<S>, options?: AppendOptions): Promise<AppendResult>;
  onUpdate(listener: (entries: CommittedEvent[]) => void): TransportSubscription;
  status(): TransportStatus;
  state(): S;
}
