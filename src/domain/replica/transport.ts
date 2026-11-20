// The transport contract (DESIGN 9; D-15): types only. Four transports implement it in later phases (hub, LAN peer, git refs, sealed bundle file),
// and none of them is trusted: clients verify every entry whatever carried it, logs only grow, and merging is set union, so any mix converges.
// Nothing here runs. The in-memory fake the tests use lives in src/test/helpers/replicaFakeTransport.ts.
import type { SignedCheckpoint } from './checkpoint';
import type { Dep, SealedBlob, SealedEntry } from './entry';

// What one side holds: per stream, the head of each writer's log, and the newest checkpoint it knows.
export interface HeadSet {
  streams: Array<{ stream: string; heads: Dep[] }>;
  checkpoint?: SignedCheckpoint;
}

// Entries of one writer's log in one stream from a sequence number on.
export interface PullRequest { stream: string; writer: string; fromSeq: number }

// accepted lists entry hashes now held by the receiver; refused names why an entry was not taken.
export interface PushResult {
  accepted: string[];
  refused: Array<{ hash: string; reason: string }>;
}

export type Unsubscribe = () => void;

export interface ReplicaTransport {
  readonly kind: 'hub' | 'lan' | 'git' | 'bundle';
  // Can it push changes to this machine while connected?
  readonly live: boolean;
  // Does the other end refuse anything but appends to a writer's log?
  readonly enforcesAppend: boolean;
  heads(streams: readonly string[]): Promise<HeadSet>;
  pull(want: readonly PullRequest[]): AsyncIterable<SealedEntry | SealedBlob>;
  push(entries: readonly SealedEntry[], blobs: readonly SealedBlob[]): Promise<PushResult>;
  // onPresence receives opaque sealed bytes; their format belongs to Phase 33.
  subscribe?(onHeads: (heads: HeadSet) => void, onPresence: (sealed: Uint8Array) => void): Unsubscribe;
}
