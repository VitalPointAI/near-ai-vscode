// High-water marks of a replica store (D-27): how far this device has seen the shared history of one project, kept outside the project in the
// editor's secret storage so a store folder that was rolled back (restored from a backup, cut short, an older copy put in its place) is noticed.
//
// Modelled on the staff host's signed ledger head (LEDGER_HEAD_SECRET_PREFIX and headKey in staffHost.ts): one secret per store, under a key made
// from the hashed absolute path (no path is in the key), holding a payload signed by this device with purpose staff-replica-mark. A mark that does
// not verify is never trusted and never silently replaced: the store refuses to open (mark-unverified).
//
// A head names, for one (stream, writer) file: the highest seq seen, one hash held at that seq, and how many entries the file held. The count
// catches a file cut short below its highest line when entries arrived out of seq order from outside. Node crypto and pure domain code only.
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { SecretStorageLike } from '../../services/auth';
import { HASH_PATTERN, STREAM_ID_PATTERN } from '../../domain/replica/entry';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import { signPayload, verifyPayload } from '../../domain/team/signedPayload';
import type { PayloadSigner } from '../../domain/team/signedPayload';
import { isRecord, isSafeIntegerInRange } from '../../domain/team/validate';

/** The secret storage key prefix of each store's signed mark; the hashed store path follows it. */
export const REPLICA_MARK_SECRET_PREFIX = 'nearAi.staff.replicaMarks.';

/** The most heads one mark may name; far above any real project, so a hostile value cannot make a huge mark. */
export const MAX_MARK_HEADS = 100_000;

export interface MarkHead {
  stream: string;
  writer: string;
  /** The highest seq this device has seen in the file. */
  seq: number;
  /** One entry hash this device has seen at that seq. */
  hash: string;
  /** How many distinct entries the file held. */
  count: number;
}

export interface ReplicaMark {
  v: 1;
  /** The roster head entry this device has seen, or null before one is recorded. */
  rosterHead: string | null;
  heads: MarkHead[];
}

/** What the store knows of one (stream, writer) file now: its entry count and the hashes it holds at a seq. */
export interface MarkFileState {
  stream: string;
  writer: string;
  count: number;
  hashesAt(seq: number): readonly string[];
}

export type MarkComparison = { ok: true } | { ok: false; reason: 'rolled-back'; stream: string; writer: string };

export type MarkRead = { kind: 'none' } | { kind: 'mark'; mark: ReplicaMark } | { kind: 'unverified' };

/** The secret storage key of a store's mark: the prefix plus the first 32 hex of sha256 of the store's absolute path, with forward slashes. */
export function markKey(storeDir: string): string {
  const absolute = path.resolve(storeDir).split(path.sep).join('/');
  return `${REPLICA_MARK_SECRET_PREFIX}${createHash('sha256').update(absolute).digest('hex').slice(0, 32)}`;
}

function headOf(value: unknown): MarkHead | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 5 || !['stream', 'writer', 'seq', 'hash', 'count'].every((key) => keys.includes(key))) return undefined;
  const { stream, writer, seq, hash, count } = value;
  if (typeof stream !== 'string' || !STREAM_ID_PATTERN.test(stream)) return undefined;
  if (typeof writer !== 'string' || !HASH_PATTERN.test(writer)) return undefined;
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) return undefined;
  if (!isSafeIntegerInRange(seq, 0, Number.MAX_SAFE_INTEGER) || !isSafeIntegerInRange(count, 1, Number.MAX_SAFE_INTEGER)) return undefined;
  return { stream, writer, seq, hash, count };
}

/** A mark payload in the exact shape this version writes, or undefined. Never throws. */
export function parseReplicaMark(value: unknown): ReplicaMark | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const keys = Object.keys(value);
    if (keys.length !== 3 || !['v', 'rosterHead', 'heads'].every((key) => keys.includes(key))) return undefined;
    if (value.v !== 1) return undefined;
    const rosterHead = value.rosterHead;
    if (rosterHead !== null && (typeof rosterHead !== 'string' || !HASH_PATTERN.test(rosterHead))) return undefined;
    if (!Array.isArray(value.heads) || value.heads.length > MAX_MARK_HEADS) return undefined;
    const heads: MarkHead[] = [];
    const seen = new Set<string>();
    for (const item of value.heads) {
      const head = headOf(item);
      if (!head) return undefined;
      const id = `${head.stream}/${head.writer}`;
      if (seen.has(id)) return undefined;
      seen.add(id);
      heads.push(head);
    }
    return { v: 1, rosterHead, heads };
  } catch {
    return undefined;
  }
}

/** The mark this device last recorded for a store: none, the verified mark, or unverified when a value is there but does not verify. */
export async function readMark(secrets: SecretStorageLike, key: string, status: KeyStatusLookup): Promise<MarkRead> {
  const text = await Promise.resolve(secrets.get(key));
  if (text === undefined) return { kind: 'none' };
  try {
    const verdict = verifyPayload(JSON.parse(text) as unknown, { purpose: 'staff-replica-mark', status });
    const mark = verdict.ok ? parseReplicaMark(verdict.payload) : undefined;
    return mark ? { kind: 'mark', mark } : { kind: 'unverified' };
  } catch {
    return { kind: 'unverified' };
  }
}

/** Records a mark, signed by this device with purpose staff-replica-mark, in secret storage. Heads are written in a stable order. */
export async function writeMark(secrets: SecretStorageLike, key: string, signer: PayloadSigner, mark: ReplicaMark, now: () => Date = () => new Date()): Promise<void> {
  const ordered: ReplicaMark = { v: 1, rosterHead: mark.rosterHead, heads: [...mark.heads].sort((a, b) => (a.stream === b.stream ? (a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0) : a.stream < b.stream ? -1 : 1)) };
  if (!parseReplicaMark(ordered)) throw new Error('Nothing was recorded: the mark is not in the shape this version writes.');
  const envelope = signPayload(signer, 'staff-replica-mark', ordered, { now });
  await Promise.resolve(secrets.store(key, JSON.stringify(envelope)));
}

/**
 * Compares the store's files with the mark. A file is rolled back when it is missing, holds fewer entries than the mark counted, or does not hold
 * the marked hash at the marked seq. Files the mark does not name are new and fine. Pure.
 */
export function compareWithMark(mark: ReplicaMark, files: readonly MarkFileState[]): MarkComparison {
  const byId = new Map(files.map((file) => [`${file.stream}/${file.writer}`, file]));
  for (const head of mark.heads) {
    const file = byId.get(`${head.stream}/${head.writer}`);
    if (!file || file.count < head.count || !file.hashesAt(head.seq).includes(head.hash)) return { ok: false, reason: 'rolled-back', stream: head.stream, writer: head.writer };
  }
  return { ok: true };
}
