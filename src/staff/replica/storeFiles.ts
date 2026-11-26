// Replica file formats and bounded filesystem helpers. The Store owns locks and operation ordering.
import { createHash, randomBytes } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { BLOB_MAX_BYTES, HASH_PATTERN, HEADER_MAX_BYTES, INLINE_BODY_MAX_BYTES, SEALED_OVERHEAD, parseHeaderShape, sha256Hex } from '../../domain/replica/entry';
import type { SealedBlob, SealedEntry } from '../../domain/replica/entry';
import { REPLICA_DIR, REPLICA_PROJECT_FILE } from '../../domain/staff/multiUser';
import { canonicalBytes } from '../../domain/team/canonical';
import { isRecord } from '../../domain/team/validate';
import { syncFolder } from '../../team/fileSafety';

export const MAX_ACCEPTED_FRONTIER_BYTES = 32 * 1024 * 1024;
// The longest body a well-formed entry can carry, as base64url: an inline body is at most INLINE_BODY_MAX_BYTES plus sealing.
const MAX_BODY_CHARS = Math.ceil(((INLINE_BODY_MAX_BYTES + SEALED_OVERHEAD + 3) * 4) / 3);
// A line longer than this cannot be an entry; it is skipped as damaged without being held in memory whole.
const MAX_LINE_BYTES = HEADER_MAX_BYTES + MAX_BODY_CHARS + 1024;
const READ_CHUNK = 64 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
export const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The command that starts this computer's shared history again, as the refusals name it. */
export const START_AGAIN_COMMAND_TITLE = 'Staff: Start This Computer\'s Shared History Again';
/** The record of an unfinished Start Again, beside the store folder (relative to the project, forward slashes). */
export const START_AGAIN_INTENT_FILE = `${REPLICA_DIR}.start-again.json`;

export const STAFF_PARTS = path.posix.dirname(REPLICA_DIR).split('/');
export const STORE_PARTS = REPLICA_DIR.split('/');
export const STORE_NAME = path.posix.basename(REPLICA_DIR);
// The only folder names an intent may give, and the only folders Start Again reads beside the store. Exact, so no name can leave .planning/staff.
export const SET_ASIDE_NAME = /^replica\.set-aside-(\d{8}-\d{6})(?:-(\d+))?$/;
const TEMPORARY_NAME = /^replica\.new-[0-9a-f]{12}$/;
export const INTENT_MAX_BYTES = 4 * 1024;

const START_AGAIN_STEP = `run ${START_AGAIN_COMMAND_TITLE}. It sets this copy aside without deleting anything, and your staff lead can then send you a new welcome file to bring the shared history back.`;

// Closed list of refusals, in plain words. No message names a key, a secret or a full hash, and none uses an em-dash.
export const STORE_REFUSALS = {
  'rolled-back': `The shared history in this project folder is older than what this device has already seen, so it was not opened. Nothing was changed. This happens when the folder was restored from an older backup or copy, or when part of it was deleted. Put the newer copy of the folder back if you have one. If you do not, ${START_AGAIN_STEP}`,
  damaged: `Part of the shared history in this project folder is damaged: lines this device had already read can no longer be read, so it was not opened. Nothing was changed. This happens after a disk error, or when a program or a person edited a file in the folder. Put back a good copy of the folder if you have one. If you do not, ${START_AGAIN_STEP}`,
  'mark-unverified': `This device's signed record of how far it has seen the shared history does not verify, so the shared history in this project folder cannot be checked against it and was not opened. Nothing was changed. To start a new record, ${START_AGAIN_STEP}`,
  'not-needed': 'The shared history in this project folder opens and matches what this device has already seen, so it was not set aside. Nothing was changed.',
  'blob-too-large': 'A sealed attachment is larger than the 8 MB the shared history accepts, so it was not written. Nothing was changed.',
  symlink: 'A folder or file on the way to the shared history in this project is a symbolic link, so nothing was read or written through it. Nothing was changed. Replace it with a real folder or file.',
  unreadable: 'Part of the shared history in this project folder could not be read, so it was not opened. Nothing was changed. Check that the folder and its files can be read by your user account.',
  'not-a-store': 'The shared history folder in this project is not a folder this extension made, so it was not opened. Nothing was changed.',
  'out-of-order': 'This update does not follow the last one this device wrote to the shared history, so nothing was written. Nothing was changed.',
  'snapshot-changed': 'The shared history changed before this update was saved, so nothing was written.',
  'start-again-unfinished': 'Starting this computer\'s shared history again did not finish, so the shared history was not opened. Nothing was deleted. Open the project again to finish it. If this message comes back, check that the folders in .planning/staff can be read and written by your user account.',
  'nothing-to-carry': 'There is no copy of this project\'s shared history on this computer to start again from, so nothing was changed. Ask your staff lead for a new welcome file and open it with Staff: Join Staff Project.'
} as const;
export type StoreRefusal = keyof typeof STORE_REFUSALS;
export interface StoreRefused { refused: StoreRefusal; message: string }

export const PROJECT_FILE_NAME = path.posix.basename(REPLICA_PROJECT_FILE);

export class Refusal extends Error {
  public constructor(public readonly reason: StoreRefusal) {
    super(STORE_REFUSALS[reason]);
  }
}

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** One (stream, writer) file as read so far. */
export interface StreamFile {
  readonly stream: string;
  readonly writer: string;
  readonly file: string;
  /** Bytes up to and including the last newline read. */
  offset: number;
  /** The file's size when last read; above offset means a torn tail. */
  size: number;
  /** The distinct entries read, in file order. */
  readonly hashes: Set<string>;
  readonly bySeq: Map<number, string[]>;
  maxSeq: number;
  /** sha256 running over the entry hashes in file order (digestOf), so the mark's digest of the whole file costs one copy. */
  readonly running: Hash;
  /** Whole lines that are not an entry of this file. */
  damaged: number;
}

export function newStreamFile(stream: string, writer: string, file: string): StreamFile {
  return { stream, writer, file, offset: 0, size: 0, hashes: new Set(), bySeq: new Map(), maxSeq: -1, running: createHash('sha256'), damaged: 0 };
}

/** A sealed entry read from a line or received from outside, or undefined when its shape or body is wrong. Checks shape and body hash, no signature. */
export function parseSealed(value: unknown): SealedEntry | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('header') || !keys.includes('body')) return undefined;
  const shape = parseHeaderShape(value.header);
  if (!shape.ok) return undefined;
  const body = value.body;
  if (typeof body !== 'string' || body.length > MAX_BODY_CHARS || !BASE64URL.test(body)) return undefined;
  const wire = Buffer.from(body, 'base64url');
  if (wire.length !== shape.header.body.size || sha256Hex(wire) !== shape.header.body.hash) return undefined;
  return { header: shape.header, body };
}

/** The decoded size of a blob's bytes, or undefined when they are not base64url. */
export function blobWire(blob: SealedBlob): Buffer | undefined {
  if (typeof blob?.bytes !== 'string' || typeof blob.hash !== 'string' || !HASH_PATTERN.test(blob.hash) || !BASE64URL.test(blob.bytes)) return undefined;
  return Buffer.from(blob.bytes, 'base64url');
}

/** The largest base64url text that can decode to BLOB_MAX_BYTES; longer text is refused before it is decoded. */
export const MAX_BLOB_CHARS = Math.ceil((BLOB_MAX_BYTES * 4) / 3);

interface LineRead { lines: Array<string | undefined>; end: number; size: number }

/** Whole lines from `from` on, read in chunks. A line over MAX_LINE_BYTES comes back undefined (damaged). Bytes after the last newline are left. */
export async function readWholeLines(handle: FileHandle, from: number): Promise<LineRead> {
  const size = (await handle.stat()).size;
  const lines: Array<string | undefined> = [];
  let end = from;
  let pending: Buffer[] = [];
  let pendingLength = 0;
  let overlong = false;
  let position = from;
  const chunk = Buffer.allocUnsafe(READ_CHUNK);
  while (position < size) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(READ_CHUNK, size - position), position);
    if (bytesRead === 0) break;
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      if (newline === -1 || newline >= bytesRead) break;
      const length = pendingLength + (newline - start);
      if (overlong || length > MAX_LINE_BYTES) lines.push(undefined);
      else lines.push(Buffer.concat([...pending, chunk.subarray(start, newline)]).toString('utf8'));
      pending = [];
      pendingLength = 0;
      overlong = false;
      end = position + newline + 1;
      start = newline + 1;
    }
    if (start < bytesRead && !overlong) {
      pendingLength += bytesRead - start;
      if (pendingLength > MAX_LINE_BYTES) { overlong = true; pending = []; } else pending.push(Buffer.from(chunk.subarray(start, bytesRead)));
    }
    position += bytesRead;
  }
  return { lines, end, size };
}

/** Is any part from `root` down `parts` a symbolic link? Missing parts are fine (made later). Anything else that is not a folder is not a store. */
export async function checkPath(root: string, parts: readonly string[]): Promise<StoreRefusal | undefined> {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return 'symlink';
      if (!info.isDirectory()) return 'not-a-store';
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      return 'unreadable';
    }
  }
  return undefined;
}

/** Makes `parts` under `base`, refusing a symbolic link on the way. */
export async function ensureDir(base: string, parts: readonly string[]): Promise<string> {
  const problem = await checkPath(base, parts);
  if (problem) throw new Refusal(problem);
  const dir = path.join(base, ...parts);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Syncs bytes in a temporary file before installing them atomically. Exclusive installation never replaces an existing file. */
export async function writeAtomic(
  file: string, bytes: Buffer | string, mode = 0o644, beforePublish?: () => Promise<void>, install: 'replace' | 'exclusive' = 'replace'
): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
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
    await beforePublish?.();
    if (install === 'exclusive') {
      await link(temporary, file);
      await rm(temporary);
    } else {
      await rename(temporary, file);
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function frontierFileHandle(scope: string, bytes: Buffer): string {
  return sha256Hex(canonicalBytes([scope, sha256Hex(bytes)]));
}

/** Reads bounded exact bytes without following links or an unbounded file growth. */
export async function readFrontierFile(file: string): Promise<Buffer | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_ACCEPTED_FRONTIER_BYTES) throw new Refusal('unreadable');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Refusal('unreadable');
      offset += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    if (extra.bytesRead !== 0) throw new Refusal('unreadable');
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Writes every byte of `bytes` at `position`, however many writes that takes. */
export async function writeAllAt(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let done = 0;
  while (done < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, done, bytes.length - done, position + done);
    if (bytesWritten <= 0) throw new Error('The disk accepted no bytes.');
    done += bytesWritten;
  }
}

export function fileId(stream: string, writer: string): string {
  return `${stream}/${writer}`;
}

/** A time as YYYYMMDD-HHMMSS in UTC, for the name of a folder set aside. */
export function stampOf(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** Writes whole lines to a new file and syncs it. */
export async function writeNewFile(file: string, bytes: Buffer | string): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// ---- Start Again: the intent, the folders beside the store, the .planning/staff lock -----------------------------------------------------------

/** What Start Again recorded before its first rename: folder names only (basenames in .planning/staff), the writer and counts. */
export interface StartAgainIntent {
  v: 1;
  writer: string;
  /** The name the store folder is set aside under; null when there was no store folder to set aside. */
  setAside: string | null;
  temporary: string;
  /** The folder carried from: the store folder itself, or a folder set aside or left beside it. */
  source: string;
  carried: number;
  grants: number;
  blobs: number;
}

const INTENT_KEYS = ['blobs', 'carried', 'grants', 'setAside', 'source', 'temporary', 'v', 'writer'];

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The intent read from untrusted text, or undefined when it is not exactly the shape this version writes (T-32-01). */
export function parseIntent(text: string): StartAgainIntent | undefined {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { return undefined; }
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== INTENT_KEYS.join(',') || value.v !== 1) return undefined;
  const { writer, setAside, temporary, source, carried, grants, blobs } = value;
  if (typeof writer !== 'string' || !HASH_PATTERN.test(writer)) return undefined;
  if (setAside !== null && (typeof setAside !== 'string' || !SET_ASIDE_NAME.test(setAside))) return undefined;
  if (typeof temporary !== 'string' || !TEMPORARY_NAME.test(temporary)) return undefined;
  if (typeof source !== 'string' || source === temporary || !(source === STORE_NAME || SET_ASIDE_NAME.test(source) || TEMPORARY_NAME.test(source))) return undefined;
  if (source === STORE_NAME && setAside === null) return undefined;
  if (!isCount(carried) || !isCount(grants) || !isCount(blobs)) return undefined;
  return { v: 1, writer, setAside, temporary, source, carried, grants, blobs };
}

export function staffDirOf(root: string): string {
  return path.join(root, ...STAFF_PARTS);
}

export function intentFileOf(root: string): string {
  return path.join(root, ...START_AGAIN_INTENT_FILE.split('/'));
}

/** What is at a path: nothing, a real folder, or something else (a file, a link). Errors other than absence are thrown. */
export async function kindAt(file: string): Promise<'none' | 'folder' | 'other'> {
  try {
    const info = await lstat(file);
    return info.isDirectory() ? 'folder' : 'other';
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return 'none';
    throw error;
  }
}

/** Is there an intent (or anything at its path)? A path that cannot be checked counts as there, so nothing goes on as if it were not. */
export async function intentPresent(root: string): Promise<boolean> {
  try {
    await lstat(intentFileOf(root));
    return true;
  } catch (error) {
    return !(errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR');
  }
}

/** Is `file` a plain file (no link)? */
export async function isPlainFile(file: string): Promise<boolean> {
  try { return (await lstat(file)).isFile(); } catch { return false; }
}

interface Leftover { name: string; dir: string }

/**
 * The folders set aside or left beside the store, real folders only (no link): replica.set-aside-* newest first by name (time, then number), then
 * replica.new-* newest first by change time. Read, never written.
 */
export async function leftoverFolders(root: string): Promise<Leftover[]> {
  const staff = staffDirOf(root);
  let names: string[];
  try { names = await readdir(staff); } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return [];
    throw error;
  }
  const asides: Array<{ name: string; stamp: string; n: number }> = [];
  const temporaries: Array<{ name: string; at: number }> = [];
  for (const name of names) {
    const aside = SET_ASIDE_NAME.exec(name);
    if (!aside && !TEMPORARY_NAME.test(name)) continue;
    let info;
    try { info = await lstat(path.join(staff, name)); } catch { continue; }
    if (!info.isDirectory()) continue;
    if (aside) asides.push({ name, stamp: aside[1], n: aside[2] === undefined ? 1 : Number(aside[2]) });
    else temporaries.push({ name, at: info.mtimeMs });
  }
  asides.sort((a, b) => (a.stamp === b.stamp ? b.n - a.n : a.stamp < b.stamp ? 1 : -1));
  temporaries.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  return [...asides, ...temporaries].map(({ name }) => ({ name, dir: path.join(staff, name) }));
}

/**
 * Is the shared history of the project at `root` missing: no store folder, while a folder set aside or left beside it (replica.set-aside-* or
 * replica.new-*) holds a project.json? Such a store is never made again empty. A folder that cannot be listed counts as missing (fail closed).
 */
export async function sharedHistoryMissing(root: string): Promise<boolean> {
  const absolute = path.resolve(root);
  try {
    if ((await kindAt(path.join(absolute, ...STORE_PARTS))) !== 'none') return false;
    for (const leftover of await leftoverFolders(absolute)) if (await isPlainFile(path.join(leftover.dir, PROJECT_FILE_NAME))) return true;
    return false;
  } catch {
    return true;
  }
}

/** Syncs every folder under `dir`, deepest first (not `dir` itself). */
export async function syncTree(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    await syncTree(child);
    await syncFolder(child);
  }
}

/** The first free set-aside name for `stamp` in .planning/staff: the stamp itself, then -2, -3. */
export async function freeAsideName(staff: string, stamp: string): Promise<string> {
  let name = `${STORE_NAME}.set-aside-${stamp}`;
  for (let attempt = 2; (await kindAt(path.join(staff, name))) !== 'none'; attempt += 1) name = `${STORE_NAME}.set-aside-${stamp}-${attempt}`;
  return name;
}

/** A folder in .planning/staff as the project names it: relative, with forward slashes. */
export function staffRelative(name: string): string {
  return `${STAFF_PARTS.join('/')}/${name}`;
}

export async function writeIntent(root: string, intent: StartAgainIntent): Promise<void> {
  await writeAtomic(intentFileOf(root), `${JSON.stringify(intent)}\n`);
}
