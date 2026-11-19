// An in-memory ReplicaTransport for tests only (D-15). It keeps a set of entries by entry hash and a set of blobs by blob hash, and does what a
// bundle would: no checks beyond reading the header, no live updates, no append enforcement. The clients verify everything, as they must.
import { entryHash, parseHeaderShape } from '../../domain/replica/entry';
import type { Dep, SealedBlob, SealedEntry } from '../../domain/replica/entry';
import type { HeadSet, PullRequest, PushResult, ReplicaTransport } from '../../domain/replica/transport';

export interface FakeTransport extends ReplicaTransport {
  /** Every entry held, by hash order. */
  held(): SealedEntry[];
  heldBlobs(): SealedBlob[];
}

interface Held { entry: SealedEntry; stream: string; writer: string; seq: number }

export function createFakeTransport(): FakeTransport {
  const entries = new Map<string, Held>();
  const blobs = new Map<string, SealedBlob>();
  const headsOf = (streams: readonly string[]): HeadSet => {
    const wanted = new Set(streams);
    const best = new Map<string, Map<string, Dep>>();
    for (const [hash, item] of entries) {
      if (!wanted.has(item.stream)) continue;
      let writers = best.get(item.stream);
      if (writers === undefined) {
        writers = new Map();
        best.set(item.stream, writers);
      }
      const known = writers.get(item.writer);
      if (known === undefined || known.seq < item.seq) writers.set(item.writer, { writer: item.writer, seq: item.seq, hash });
    }
    return {
      streams: [...best.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([stream, writers]) => ({ stream, heads: [...writers.values()].sort((a, b) => (a.writer < b.writer ? -1 : 1)) }))
    };
  };
  return {
    kind: 'bundle',
    live: false,
    enforcesAppend: false,
    heads: (streams) => Promise.resolve(headsOf(streams)),
    async *pull(want: readonly PullRequest[]) {
      const sent = new Set<string>();
      for (const request of want) {
        const matching = [...entries.entries()]
          .filter(([, item]) => item.stream === request.stream && item.writer === request.writer && item.seq >= request.fromSeq)
          .sort(([, a], [, b]) => a.seq - b.seq);
        for (const [hash, item] of matching) {
          if (sent.has(hash)) continue;
          sent.add(hash);
          yield item.entry;
        }
      }
      // Blobs are content addressed and the fake cannot read which entry names which, so every blob it holds follows the entries.
      for (const blob of [...blobs.values()].sort((a, b) => (a.hash < b.hash ? -1 : 1))) yield blob;
    },
    push(newEntries: readonly SealedEntry[], newBlobs: readonly SealedBlob[]): Promise<PushResult> {
      const result: PushResult = { accepted: [], refused: [] };
      for (const entry of newEntries) {
        const shape = parseHeaderShape((entry as { header?: unknown } | undefined)?.header);
        if (!shape.ok) {
          result.refused.push({ hash: '', reason: shape.reason });
          continue;
        }
        const hash = entryHash(shape.header);
        if (!entries.has(hash)) entries.set(hash, { entry, stream: shape.header.stream, writer: shape.header.writer, seq: shape.header.seq });
        result.accepted.push(hash);
      }
      for (const blob of newBlobs) blobs.set(blob.hash, blob);
      return Promise.resolve(result);
    },
    held: () => [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, item]) => item.entry),
    heldBlobs: () => [...blobs.values()]
  };
}
