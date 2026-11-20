// High-water marks of a replica store (D-27): how far this device has seen the shared history of one project, kept outside the project in the
// editor's secret storage so a store folder that was rolled back (restored from a backup, cut short, an older copy put in its place) is noticed.
//
// Modelled on the staff host's signed ledger head (LEDGER_HEAD_SECRET_PREFIX and headKey in staffHost.ts): one secret per store, under a key made
// from the hashed absolute path (no path is in the key). A mark that does not verify is never trusted and never silently replaced: the store refuses
// to open (mark-unverified) until the person starts this computer's shared history again.
//
// The signed part is compact (31-REVIEW MJ-06): this device signs, with purpose staff-replica-mark, the roster head, the sizes of three lists and
// one sha256 over them. The lists themselves are kept beside the signature in the same secret value, so one write records both, and they are trusted
// only when they hash to the signed value. However many files a project has, the signed payload stays a few hundred bytes.
//
// The three lists:
// - heads: for one (stream, writer) file, the highest seq seen, one hash held at that seq, how many distinct entries the file held, and a digest of
//   those entries' hashes in file order. The count catches a file cut short; the digest catches a line swapped, moved or put in between.
// - held: entries from outside that the decode check refused, with its reason (D-05). Kept in the signed record, so deleting or editing a file in
//   the project folder cannot let them into the fold (MJ-07).
// - waiting: entries the decode check has not passed yet: never checked (found on disk), or waiting for their key or their blob. They stay out of the
//   fold until a check passes them.
// An entry the mark covers (one of the first `count` entries of a file it names) and that is on neither list passed the check, or is this device's
// own. Node crypto and pure domain code only.
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

/** The version of the mark this code writes and reads. */
export const MARK_VERSION = 2;

/** The most heads one mark may name; far above any real project, so a hostile value cannot make a huge mark. */
export const MAX_MARK_HEADS = 100_000;

/** The most entries the held and the waiting lists may each name. */
export const MAX_MARK_LISTED = 1_000_000;

/** The longest reason kept for one held entry. */
export const MAX_HELD_REASON = 200;

export interface MarkHead {
  stream: string;
  writer: string;
  /** The highest seq this device has seen in the file. */
  seq: number;
  /** One entry hash this device has seen at that seq. */
  hash: string;
  /** How many distinct entries the file held. */
  count: number;
  /** sha256 over the hashes of the file's first `count` distinct entries, in file order (digestOf). */
  digest: string;
}

/** Why an entry waits for the decode check: never checked yet, or its epoch key or its blob is not on this machine yet. */
export type WaitReason = 'unchecked' | 'awaiting-key' | 'awaiting-blob';
export const WAIT_REASONS: readonly WaitReason[] = ['unchecked', 'awaiting-key', 'awaiting-blob'];

export interface ReplicaMark {
  /** The roster head entry this device has seen, or null before one is recorded. */
  rosterHead: string | null;
  heads: MarkHead[];
  held: Array<{ hash: string; reason: string }>;
  waiting: Array<{ hash: string; reason: WaitReason }>;
}

/** What the store knows of one (stream, writer) file now. */
export interface MarkFileState {
  stream: string;
  writer: string;
  /** Distinct entries read from the file. */
  count: number;
  /** Whole lines of the file that are not an entry of it. */
  damaged: number;
  /** digestOf the first `count` distinct entries of the file, or undefined when it holds fewer. */
  digestAt(count: number): string | undefined;
  hashesAt(seq: number): readonly string[];
}

export type MarkComparison = { ok: true } | { ok: false; reason: 'rolled-back' | 'damaged'; stream: string; writer: string };

export type MarkRead = { kind: 'none' } | { kind: 'mark'; mark: ReplicaMark; text: string } | { kind: 'unverified' };

/** The secret storage key of a store's mark: the prefix plus the first 32 hex of sha256 of the store's absolute path, with forward slashes. */
export function markKey(storeDir: string): string {
  const absolute = path.resolve(storeDir).split(path.sep).join('/');
  return `${REPLICA_MARK_SECRET_PREFIX}${createHash('sha256').update(absolute).digest('hex').slice(0, 32)}`;
}

/** The digest of a file's entries: sha256 over each entry hash and a newline, in file order. */
export function digestOf(hashes: Iterable<string>): string {
  const hash = createHash('sha256');
  for (const item of hashes) hash.update(`${item}\n`);
  return hash.digest('hex');
}

/** A held reason as one plain line of at most MAX_HELD_REASON characters. */
export function heldReason(reason: unknown): string {
  const text = typeof reason === 'string' ? reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
  return (text || 'The decode check refused this update.').slice(0, MAX_HELD_REASON);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function headOf(value: unknown): MarkHead | undefined {
  if (!isRecord(value) || !exactKeys(value, ['stream', 'writer', 'seq', 'hash', 'count', 'digest'])) return undefined;
  const { stream, writer, seq, hash, count, digest } = value;
  if (typeof stream !== 'string' || !STREAM_ID_PATTERN.test(stream)) return undefined;
  if (typeof writer !== 'string' || !HASH_PATTERN.test(writer)) return undefined;
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash) || typeof digest !== 'string' || !HASH_PATTERN.test(digest)) return undefined;
  if (!isSafeIntegerInRange(seq, 0, Number.MAX_SAFE_INTEGER) || !isSafeIntegerInRange(count, 1, Number.MAX_SAFE_INTEGER)) return undefined;
  return { stream, writer, seq, hash, count, digest };
}

function byStreamWriter(a: MarkHead, b: MarkHead): number {
  if (a.stream !== b.stream) return a.stream < b.stream ? -1 : 1;
  return a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0;
}

function byHash(a: { hash: string }, b: { hash: string }): number {
  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
}

/** A mark's lists in the exact shape this version writes, as fresh objects in a stable order, or undefined. Never throws. */
export function parseReplicaMark(value: unknown): ReplicaMark | undefined {
  try {
    if (!isRecord(value) || !exactKeys(value, ['rosterHead', 'heads', 'held', 'waiting'])) return undefined;
    const rosterHead = value.rosterHead;
    if (rosterHead !== null && (typeof rosterHead !== 'string' || !HASH_PATTERN.test(rosterHead))) return undefined;
    if (!Array.isArray(value.heads) || value.heads.length > MAX_MARK_HEADS) return undefined;
    if (!Array.isArray(value.held) || value.held.length > MAX_MARK_LISTED) return undefined;
    if (!Array.isArray(value.waiting) || value.waiting.length > MAX_MARK_LISTED) return undefined;
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
    const listed = new Set<string>();
    const held: ReplicaMark['held'] = [];
    for (const item of value.held) {
      if (!isRecord(item) || !exactKeys(item, ['hash', 'reason']) || typeof item.hash !== 'string' || !HASH_PATTERN.test(item.hash)) return undefined;
      if (typeof item.reason !== 'string' || item.reason !== heldReason(item.reason) || listed.has(item.hash)) return undefined;
      listed.add(item.hash);
      held.push({ hash: item.hash, reason: item.reason });
    }
    const waiting: ReplicaMark['waiting'] = [];
    for (const item of value.waiting) {
      if (!isRecord(item) || !exactKeys(item, ['hash', 'reason']) || typeof item.hash !== 'string' || !HASH_PATTERN.test(item.hash)) return undefined;
      if (!WAIT_REASONS.includes(item.reason as WaitReason) || listed.has(item.hash)) return undefined;
      listed.add(item.hash);
      waiting.push({ hash: item.hash, reason: item.reason as WaitReason });
    }
    return { rosterHead, heads: heads.sort(byStreamWriter), held: held.sort(byHash), waiting: waiting.sort(byHash) };
  } catch {
    return undefined;
  }
}

/** sha256 over a parsed mark's lists, in the stable order parseReplicaMark gives them. What the signed payload commits to. */
export function markContentHash(mark: ReplicaMark): string {
  const hash = createHash('sha256');
  hash.update(`replica-mark/${MARK_VERSION}\n`);
  for (const head of mark.heads) hash.update(`${JSON.stringify(['h', head.stream, head.writer, head.seq, head.hash, head.count, head.digest])}\n`);
  for (const item of mark.held) hash.update(`${JSON.stringify(['x', item.hash, item.reason])}\n`);
  for (const item of mark.waiting) hash.update(`${JSON.stringify(['w', item.hash, item.reason])}\n`);
  return hash.digest('hex');
}

interface SignedMarkPayload { v: number; rosterHead: string | null; heads: number; held: number; waiting: number; content: string }

function signedPayloadOf(value: unknown): SignedMarkPayload | undefined {
  if (!isRecord(value) || !exactKeys(value, ['v', 'rosterHead', 'heads', 'held', 'waiting', 'content']) || value.v !== MARK_VERSION) return undefined;
  const { rosterHead, heads, held, waiting, content } = value;
  if (rosterHead !== null && (typeof rosterHead !== 'string' || !HASH_PATTERN.test(rosterHead))) return undefined;
  if (!isSafeIntegerInRange(heads, 0, MAX_MARK_HEADS) || !isSafeIntegerInRange(held, 0, MAX_MARK_LISTED) || !isSafeIntegerInRange(waiting, 0, MAX_MARK_LISTED)) return undefined;
  if (typeof content !== 'string' || !HASH_PATTERN.test(content)) return undefined;
  return { v: MARK_VERSION, rosterHead, heads, held, waiting, content };
}

/**
 * The mark this device last recorded for a store: none, the verified mark, or unverified when a value is there but does not verify (the signature,
 * the shape, or the lists beside it, which must hash to the signed content and match its sizes). Never throws on a bad value.
 */
export async function readMark(secrets: SecretStorageLike, key: string, status: KeyStatusLookup): Promise<MarkRead> {
  const text = await Promise.resolve(secrets.get(key));
  if (text === undefined) return { kind: 'none' };
  try {
    const stored = JSON.parse(text) as unknown;
    if (!isRecord(stored) || !exactKeys(stored, ['v', 'signed', 'heads', 'held', 'waiting']) || stored.v !== MARK_VERSION) return { kind: 'unverified' };
    const verdict = verifyPayload(stored.signed, { purpose: 'staff-replica-mark', status });
    const signed = verdict.ok ? signedPayloadOf(verdict.payload) : undefined;
    if (!signed) return { kind: 'unverified' };
    const mark = parseReplicaMark({ rosterHead: signed.rosterHead, heads: stored.heads, held: stored.held, waiting: stored.waiting });
    if (!mark || mark.heads.length !== signed.heads || mark.held.length !== signed.held || mark.waiting.length !== signed.waiting) return { kind: 'unverified' };
    if (markContentHash(mark) !== signed.content) return { kind: 'unverified' };
    return { kind: 'mark', mark, text };
  } catch {
    return { kind: 'unverified' };
  }
}

/**
 * Records a mark in secret storage in one write: the compact payload signed by this device with purpose staff-replica-mark, and the lists beside it.
 * The lists are written in a stable order. Returns the text written.
 */
export async function writeMark(secrets: SecretStorageLike, key: string, signer: PayloadSigner, mark: ReplicaMark, now: () => Date = () => new Date()): Promise<string> {
  const ordered = parseReplicaMark({ rosterHead: mark.rosterHead, heads: mark.heads, held: mark.held, waiting: mark.waiting });
  if (!ordered) throw new Error('Nothing was recorded: the mark is not in the shape this version writes.');
  const payload: SignedMarkPayload = { v: MARK_VERSION, rosterHead: ordered.rosterHead, heads: ordered.heads.length, held: ordered.held.length, waiting: ordered.waiting.length, content: markContentHash(ordered) };
  const signed = signPayload(signer, 'staff-replica-mark', payload, { now });
  const text = JSON.stringify({ v: MARK_VERSION, signed, heads: ordered.heads, held: ordered.held, waiting: ordered.waiting });
  await Promise.resolve(secrets.store(key, text));
  return text;
}

/**
 * Compares the store's files with the mark. A file fails when it is missing, holds fewer entries than the mark counted, its first `count` entries do
 * not hash to the marked digest, or it does not hold the marked hash at the marked seq. A failing file that has damaged lines enough to make up the
 * difference is damaged (lines that can no longer be read); otherwise it was rolled back. Files the mark does not name are new and fine. Pure.
 */
export function compareWithMark(mark: ReplicaMark, files: readonly MarkFileState[]): MarkComparison {
  const byId = new Map(files.map((file) => [`${file.stream}/${file.writer}`, file]));
  for (const head of mark.heads) {
    const file = byId.get(`${head.stream}/${head.writer}`);
    if (file && file.count >= head.count && file.digestAt(head.count) === head.digest && file.hashesAt(head.seq).includes(head.hash)) continue;
    const damaged = file !== undefined && file.damaged > 0 && file.count + file.damaged >= head.count;
    return { ok: false, reason: damaged ? 'damaged' : 'rolled-back', stream: head.stream, writer: head.writer };
  }
  return { ok: true };
}
