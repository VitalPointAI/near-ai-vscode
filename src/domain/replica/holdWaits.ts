// What a reducer-stage hold waits for (D-01 (d), research Pattern 3). Pure: it reads only its inputs and the injected ReplicaContext.
//
// A reducer holds an entry when a piece it needs is not there yet. When the store fills in that piece behind the same context object (a blob put
// into the blob store, a key put into the key ring), nothing new is delivered, so the fold must ask each hold whether it can now be answered. This
// file names the piece for each hold reason the reducers emit (TEXT_HOLDS in textFold.ts, VERSION_HOLDS in versions.ts) and answers the question
// cheaply. It imports no reducer, so the reducers stay free to change how they hold.
import { blobBytesHash } from './entry';
import type { HeldEntry } from './chain';
import type { ReplicaContext } from './rosterView';
import type { VerifiedEntry } from './verify';

// blob: a sealed blob, opened with the key of the entry's own cell and epoch, so the key is part of the wait. key: the key of a cell and epoch.
// entry: another admitted entry (a registration, a product.create, text updates); only an entry that sorts before the held one can answer it.
export type HoldWait =
  | { kind: 'blob'; hash: string; stream: string; epoch: number }
  | { kind: 'key'; stream: string; epoch: number }
  | { kind: 'entry' };

// The data field naming the blob a kind waits for when it is held missing-blob.
const BLOB_FIELDS: Readonly<Record<string, string>> = { 'doc.compact': 'stateBlob', 'version.propose': 'textBlob' };

// Hold reasons that wait for another entry: unregistered-client (textFold), product-unknown and updates-missing (versions).
const ENTRY_WAITS: ReadonlySet<string> = new Set(['unregistered-client', 'product-unknown', 'updates-missing']);

// What the held entry waits for, or undefined when the hold is not a reducer-stage hold this file knows (it is then never looked at again before
// something new is admitted, as before).
export function waitOf(held: HeldEntry, entry: VerifiedEntry | undefined): HoldWait | undefined {
  if (held.stage !== 'fold' || entry === undefined) return undefined;
  const { stream, epoch } = entry.header;
  if (held.reason === 'missing-key') return { kind: 'key', stream, epoch };
  if (held.reason === 'missing-blob') {
    const field = BLOB_FIELDS[entry.body.kind];
    const data = entry.data as Record<string, unknown> | undefined;
    const hash = field === undefined || typeof data !== 'object' || data === null ? undefined : data[field];
    return typeof hash === 'string' ? { kind: 'blob', hash, stream, epoch } : undefined;
  }
  return ENTRY_WAITS.has(held.reason) ? { kind: 'entry' } : undefined;
}

// Can the context answer the wait now? A blob counts only when its bytes match its name, as the reducers check, so a damaged blob does not make
// the fold start again on every delivery. newlyAdmitted: this delivery admitted an entry that sorts before the held one.
export function waitAnswered(wait: HoldWait, ctx: ReplicaContext, newlyAdmitted: boolean): boolean {
  if (wait.kind === 'entry') return newlyAdmitted;
  if (ctx.keys(wait.stream, wait.epoch) === undefined) return false;
  if (wait.kind === 'key') return true;
  const blob = ctx.blobs(wait.hash);
  return blob !== undefined && blobBytesHash(blob) === wait.hash;
}
