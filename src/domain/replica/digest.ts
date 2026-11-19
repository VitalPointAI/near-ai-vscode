// The state digest per stream (D-11). Pure, hub-side: it takes plain data only, never reducer types, so a hub can compile it without Yjs.
//
// perStream maps each stream to { [family]: canonical value }, built by the fold from each reducer's canonical output for that stream. The canonical
// values are arrays and plain objects only, because canonical JSON refuses Maps. Texts are represented by state vector and text hash.
// Same entries, same digest, whatever the order, the duplication or the partition (and, once checkpoints exist, the same checkpoint set).
import { createHash } from 'node:crypto';
import { canonicalBytes } from '../team/canonical';
import type { QuarantineRecord } from './chain';

export const DIGEST_VERSION = 1;

export function streamDigests(perStream: ReadonlyMap<string, Readonly<Record<string, unknown>>>, quarantined: readonly QuarantineRecord[]): Map<string, string> {
  const digests = new Map<string, string>();
  for (const [stream, families] of perStream) {
    const fenced = quarantined
      .filter((record) => record.stream === stream)
      .map((record) => ({ writer: record.writer, fromSeq: record.fromSeq }))
      .sort((a, b) => (a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : a.fromSeq - b.fromSeq));
    digests.set(stream, createHash('sha256').update(canonicalBytes({ v: DIGEST_VERSION, stream, families, quarantined: fenced })).digest('hex'));
  }
  return digests;
}
