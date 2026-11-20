// High-water marks of a replica store (D-27): how far this device has seen the shared history of one project, so a store folder that was rolled
// back (restored from a backup, cut short, an older copy put in its place) is noticed.
//
// Two parts (31-REVIEW MJ-06; kept small for the OS keychain by the PR #130 review):
// - The signed record, in the editor's secret storage, one value per store under a key made from the hashed absolute path (no path is in the key),
//   modelled on the staff host's signed ledger head (LEDGER_HEAD_SECRET_PREFIX and headKey in staffHost.ts). It is { v, signed }: this device signs,
//   with purpose staff-replica-mark, the roster head, the sizes of three lists and the sha256 of the lists file. A few hundred bytes, however many
//   files a project has.
// - The lists file, inside the git-ignored store folder at marks/<this device's writer id>/<sha256 of its bytes>.json. It is trusted only when its
//   bytes hash to the signed value and it holds lists of the signed sizes in the exact form this version writes. One folder per device, so two
//   installs that share a project folder never remove each other's lists.
// A record that does not verify, or whose lists file is unreadable, too large or not what it signed, is never trusted and never silently replaced:
// the store refuses to open (mark-unverified) until the person starts this computer's shared history again. A lists file that is missing (the folder
// was restored from an older copy, or part of it was deleted) is reported as such, and the store refuses it rolled-back. Unreadable is never empty.
//
// Crash safety (writeMark): the lists file is written first, under its content hash, by temporary file and rename; then the secret; then older lists
// files of this device are removed, best effort, only after the secret was written. A crash at any point leaves the secret naming a lists file that
// is there: the old one before the secret is written, the new one after.
//
// The three lists:
// - heads: for one (stream, writer) file, the highest seq seen, one hash held at that seq, how many distinct entries the file held, and a digest of
//   those entries' hashes in file order. The count catches a file cut short; the digest catches a line swapped, moved or put in between.
// - held: entries from outside that the decode check refused, with its reason (D-05). Covered by the signed hash, so deleting or editing a file in
//   the project folder cannot let them into the fold (MJ-07).
// - waiting: entries the decode check has not passed yet: never checked (found on disk), or waiting for their key or their blob. They stay out of the
//   fold until a check passes them.
// An entry the mark covers (one of the first `count` entries of a file it names) and that is on neither list passed the check, or is this device's
// own. Node crypto and file I/O for the lists file only; the store has checked the path to its folder for symbolic links under its lock.
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretStorageLike } from '../../services/auth';
import { HASH_PATTERN, STREAM_ID_PATTERN, writerIdOf } from '../../domain/replica/entry';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import { signPayload, verifyPayload } from '../../domain/team/signedPayload';
import type { PayloadSigner } from '../../domain/team/signedPayload';
import { isRecord, isSafeIntegerInRange } from '../../domain/team/validate';

/** The secret storage key prefix of each store's signed mark; the hashed store path follows it. */
export const REPLICA_MARK_SECRET_PREFIX = 'nearAi.staff.replicaMarks.';

/**
 * The version of the mark this code writes and reads. Version 3 moved the lists out of secret storage into the lists file; a value of an older
 * version reads as unverified. The multi-user preview never shipped with an older version, so there is nothing to migrate.
 */
export const MARK_VERSION = 3;

/** The folder of the lists files inside the store folder; each device has a folder of its own in it, named by its writer id. */
export const MARK_LISTS_DIR = 'marks';

/** The largest lists file read or written. Larger is unverified on read, and refused (nothing recorded) on write. */
export const MAX_MARK_LISTS_BYTES = 64 * 1024 * 1024;

/** The most heads one mark may name; far above any real project, so a hostile value cannot make a huge mark. */
export const MAX_MARK_HEADS = 100_000;

/**
 * The most entries the held list may name (32-CONTEXT D-14). The store keeps its held list within it (MAX_REFUSED_PER_WRITER in store.ts), so the
 * mark can always be written however many refused entries arrive.
 */
export const MAX_MARK_LISTED = 10_000;

/** The most entries the waiting list may name. The store writes no new entry that would wait past it (IngestResult.deferred), so it comes again. */
export const MAX_MARK_WAITING = 100_000;

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

/**
 * What readMark found: no record; the verified mark with the exact secret text; a record that does not verify (or whose lists file is unreadable, too
 * large or not what it signed); or a record that verifies and names a lists file that is not in the store folder (lists-missing).
 */
export type MarkRead = { kind: 'none' } | { kind: 'mark'; mark: ReplicaMark; text: string } | { kind: 'unverified' } | { kind: 'lists-missing' };

/** The secret storage key of a store's mark: the prefix plus the first 32 hex of sha256 of the store's absolute path, with forward slashes. */
export function markKey(storeDir: string): string {
  const absolute = path.resolve(storeDir).split(path.sep).join('/');
  return `${REPLICA_MARK_SECRET_PREFIX}${createHash('sha256').update(absolute).digest('hex').slice(0, 32)}`;
}

/** This device's folder of lists files inside a store folder. */
export function markListsFolder(storeDir: string, writer: string): string {
  return path.join(storeDir, MARK_LISTS_DIR, writer);
}

/** The lists file whose bytes hash to `content`. */
export function markListsFile(storeDir: string, writer: string, content: string): string {
  return path.join(markListsFolder(storeDir, writer), `${content}.json`);
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
    if (!Array.isArray(value.waiting) || value.waiting.length > MAX_MARK_WAITING) return undefined;
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

/** The exact bytes of a parsed mark's lists file, in the stable order parseReplicaMark gives them. */
export function markListsBytes(mark: ReplicaMark): Buffer {
  return Buffer.from(`${JSON.stringify({ v: MARK_VERSION, heads: mark.heads, held: mark.held, waiting: mark.waiting })}\n`, 'utf8');
}

/** sha256 of a parsed mark's lists file: what the signed payload commits to, and the lists file's name. */
export function markContentHash(mark: ReplicaMark): string {
  return createHash('sha256').update(markListsBytes(mark)).digest('hex');
}

interface SignedMarkPayload { v: number; rosterHead: string | null; heads: number; held: number; waiting: number; content: string }

function signedPayloadOf(value: unknown): SignedMarkPayload | undefined {
  if (!isRecord(value) || !exactKeys(value, ['v', 'rosterHead', 'heads', 'held', 'waiting', 'content']) || value.v !== MARK_VERSION) return undefined;
  const { rosterHead, heads, held, waiting, content } = value;
  if (rosterHead !== null && (typeof rosterHead !== 'string' || !HASH_PATTERN.test(rosterHead))) return undefined;
  if (!isSafeIntegerInRange(heads, 0, MAX_MARK_HEADS) || !isSafeIntegerInRange(held, 0, MAX_MARK_LISTED) || !isSafeIntegerInRange(waiting, 0, MAX_MARK_WAITING)) return undefined;
  if (typeof content !== 'string' || !HASH_PATTERN.test(content)) return undefined;
  return { v: MARK_VERSION, rosterHead, heads, held, waiting, content };
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const LISTS_FILE_NAME = /^[0-9a-f]{64}\.json$/;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Are marks/ and marks/<writer>/ under `storeDir` real folders (not symbolic links)? missing when one is not there. */
async function listsFolderState(storeDir: string, writer: string): Promise<'ok' | 'missing' | 'unreadable'> {
  let current = storeDir;
  for (const part of [MARK_LISTS_DIR, writer]) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return 'unreadable';
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable';
    }
  }
  return 'ok';
}

/** A lists file read whole without following a symbolic link: its bytes, missing, or unreadable (not a plain file, over the limit, a read error). */
async function readListsFile(file: string): Promise<Buffer | 'missing' | 'unreadable'> {
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable';
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_MARK_LISTS_BYTES) return 'unreadable';
    // Read at most one byte past the limit, so a file that grew after the stat is still caught and never read whole.
    const buffer = Buffer.allocUnsafe(Math.min(info.size, MAX_MARK_LISTS_BYTES) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > MAX_MARK_LISTS_BYTES || length !== info.size ? 'unreadable' : buffer.subarray(0, length);
  } catch {
    return 'unreadable';
  } finally {
    await handle.close();
  }
}

/**
 * The mark this device last recorded for the store in `storeDir`: none, the verified mark, unverified when a record is there but does not verify
 * (the signature, the shape, or its lists file, which must be readable, at most MAX_MARK_LISTS_BYTES, hash to the signed content and hold lists of
 * the signed sizes in the exact form this version writes), or lists-missing when the record verifies and its lists file is not there. Never throws on
 * a bad value or file.
 */
export async function readMark(secrets: SecretStorageLike, storeDir: string, status: KeyStatusLookup): Promise<MarkRead> {
  const text = await Promise.resolve(secrets.get(markKey(storeDir)));
  if (text === undefined) return { kind: 'none' };
  try {
    const stored = JSON.parse(text) as unknown;
    if (!isRecord(stored) || !exactKeys(stored, ['v', 'signed']) || stored.v !== MARK_VERSION) return { kind: 'unverified' };
    const verdict = verifyPayload(stored.signed, { purpose: 'staff-replica-mark', status });
    const signed = verdict.ok ? signedPayloadOf(verdict.payload) : undefined;
    if (!verdict.ok || !signed) return { kind: 'unverified' };
    const writer = writerIdOf(verdict.signer.publicKey);
    const folder = await listsFolderState(storeDir, writer);
    if (folder !== 'ok') return { kind: folder === 'missing' ? 'lists-missing' : 'unverified' };
    const bytes = await readListsFile(markListsFile(storeDir, writer, signed.content));
    if (bytes === 'missing') return { kind: 'lists-missing' };
    if (bytes === 'unreadable' || createHash('sha256').update(bytes).digest('hex') !== signed.content) return { kind: 'unverified' };
    const lists = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!isRecord(lists) || !exactKeys(lists, ['v', 'heads', 'held', 'waiting']) || lists.v !== MARK_VERSION) return { kind: 'unverified' };
    const mark = parseReplicaMark({ rosterHead: signed.rosterHead, heads: lists.heads, held: lists.held, waiting: lists.waiting });
    if (!mark || mark.heads.length !== signed.heads || mark.held.length !== signed.held || mark.waiting.length !== signed.waiting) return { kind: 'unverified' };
    if (!markListsBytes(mark).equals(bytes)) return { kind: 'unverified' };
    return { kind: 'mark', mark, text };
  } catch {
    return { kind: 'unverified' };
  }
}

/** Makes this device's lists folder, refusing a symbolic link or anything that is not a folder on the way. */
async function ensureListsFolder(storeDir: string, writer: string): Promise<string> {
  let current = storeDir;
  for (const part of [MARK_LISTS_DIR, writer]) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Nothing was recorded: the folder of the mark\'s lists is a symbolic link or not a folder.');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      await mkdir(current);
    }
  }
  return current;
}

/** Is `file` a plain file holding exactly `bytes`? */
async function holds(file: string, bytes: Buffer): Promise<boolean> {
  const read = await readListsFile(file);
  return Buffer.isBuffer(read) && read.equals(bytes);
}

/** Writes the lists file by temporary file (never through a symbolic link), sync and rename, unless it already holds exactly these bytes. */
async function writeListsFile(file: string, bytes: Buffer): Promise<void> {
  if (await holds(file, bytes)) return;
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Removes this device's lists files (and temporary files left by a crash) other than `keep`. Best effort: a failure leaves a file, never a problem. */
async function removeOlderLists(folder: string, keep: string): Promise<void> {
  let names: string[];
  try { names = await readdir(folder); } catch { return; }
  for (const name of names) {
    if (name === keep || !(LISTS_FILE_NAME.test(name) || (name.endsWith('.tmp') && LISTS_FILE_NAME.test(name.split('.').slice(0, 2).join('.'))))) continue;
    try {
      const file = path.join(folder, name);
      if ((await lstat(file)).isFile()) await rm(file, { force: true });
    } catch {
      // Best effort: a file left here is removed by the next write.
    }
  }
}

/**
 * Records a mark for the store in `storeDir`: first the lists file (content-addressed, temporary file and rename), then the signed record in secret
 * storage naming it, then, only after that write, this device's older lists files are removed. Throws, recording nothing new, when the mark is not in
 * the shape this version writes or its lists would be over MAX_MARK_LISTS_BYTES. Returns the secret text written.
 */
export async function writeMark(secrets: SecretStorageLike, storeDir: string, signer: PayloadSigner, mark: ReplicaMark, now: () => Date = () => new Date()): Promise<string> {
  const ordered = parseReplicaMark({ rosterHead: mark.rosterHead, heads: mark.heads, held: mark.held, waiting: mark.waiting });
  if (!ordered) throw new Error('Nothing was recorded: the mark is not in the shape this version writes.');
  const bytes = markListsBytes(ordered);
  if (bytes.length > MAX_MARK_LISTS_BYTES) throw new Error('Nothing was recorded: the mark\'s lists are larger than the limit.');
  const content = createHash('sha256').update(bytes).digest('hex');
  const folder = await ensureListsFolder(storeDir, writerIdOf(signer.publicKey));
  await writeListsFile(path.join(folder, `${content}.json`), bytes);
  const payload: SignedMarkPayload = { v: MARK_VERSION, rosterHead: ordered.rosterHead, heads: ordered.heads.length, held: ordered.held.length, waiting: ordered.waiting.length, content };
  const signed = signPayload(signer, 'staff-replica-mark', payload, { now });
  const text = JSON.stringify({ v: MARK_VERSION, signed });
  await Promise.resolve(secrets.store(markKey(storeDir), text));
  await removeOlderLists(folder, `${content}.json`);
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
