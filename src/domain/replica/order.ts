// The deterministic total order (D-08): lamport, then writer, then seq. Wall time (at) never orders. Pure, hub-side.
// The key is extended with stream and entry hash only to break ties D-08 leaves open: one writer can have the same lamport and seq in two streams.
import type { EntryHeader, EntryBody } from './entry';

export interface Orderable { hash: string; header: EntryHeader; body: Pick<EntryBody, 'lamport'> }

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareEntries(a: Orderable, b: Orderable): number {
  return (a.body.lamport - b.body.lamport)
    || compareText(a.header.writer, b.header.writer)
    || (a.header.seq - b.header.seq)
    || compareText(a.header.stream, b.header.stream)
    || compareText(a.hash, b.hash);
}

export function totalOrder<T extends Orderable>(entries: readonly T[]): T[] {
  return [...entries].sort(compareEntries);
}
