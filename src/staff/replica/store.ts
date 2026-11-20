// The replica store on disk (D-27, D-46): where a multi-user staff project's signed entries, sealed blobs, grants and checkpoints live on this
// machine, under REPLICA_DIR (.planning/staff/replica/) in the project. Node I/O only; never imports vscode. It knows no keys and no roster: it keeps
// sealed bytes, checks their shape, and hands them to the fold. Decryption, the decode worker and folding are wired by the project host.
//
// Layout:
//   .gitignore                          '*' and '!.gitignore': git ignores the folder, so the store is never committed by accident.
//   streams/<stream>/<writer>.jsonl     one sealed entry per line ({ header, body }), append-only, one file per writer per stream.
//   blobs/<hash>                        sealed blob wire bytes, named by their sha256.
//   replica.lock                        the cross-window lock file (withFileLock).
//
// Rules:
// - Appends write whole lines in one write, then fsync. A reader ignores bytes after the last newline (a crash mid-append) and never counts them.
// - Blobs are written to a temporary file, synced, then renamed into place.
// - Every append runs under withRegisterLock(storeDir) for order inside one process and, inside it, withFileLock(storeDir, 'replica.lock') for
//   order across windows and processes, so appends never interleave; inside the locks the store first catches up with lines another window wrote.
// - How far this device has seen is kept in a signed mark in secret storage (marks.ts). Opening a store whose files are behind the mark is refused.
// - A symbolic link anywhere from the project root to a store file is refused: nothing is read or written through it.
// - The store never deletes an entry or a blob and never rewrites a line (P-31-17). No private key or secret is ever written here (P-31-18).
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretStorageLike } from '../../services/auth';
import { withFileLock } from '../../services/stateMirrorLock';
import { withRegisterLock } from '../registerLock';
import { REPLICA_DIR } from '../../domain/staff/multiUser';
import { BLOB_MAX_BYTES, GENESIS_PREV, HASH_PATTERN, HEADER_MAX_BYTES, INLINE_BODY_MAX_BYTES, SEALED_OVERHEAD, STREAM_ID_PATTERN, entryHash, parseHeaderShape, sha256Hex, writerIdOf } from '../../domain/replica/entry';
import type { BuiltEntry, SealedBlob, SealedEntry } from '../../domain/replica/entry';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import type { PayloadSigner } from '../../domain/team/signedPayload';
import { isRecord } from '../../domain/team/validate';
import { compareWithMark, markKey, readMark, writeMark } from './marks';
import type { MarkFileState, MarkHead, ReplicaMark } from './marks';

/** The cross-window lock file inside the store folder. */
export const REPLICA_LOCK_FILE = 'replica.lock';
/** The exact text of the store's own ignore file. */
export const STORE_GITIGNORE = '*\n!.gitignore\n';

// The longest body a well-formed entry can carry, as base64url: an inline body is at most INLINE_BODY_MAX_BYTES plus sealing.
const MAX_BODY_CHARS = Math.ceil(((INLINE_BODY_MAX_BYTES + SEALED_OVERHEAD + 3) * 4) / 3);
// A line longer than this cannot be an entry; it is skipped as damaged without being held in memory whole.
const MAX_LINE_BYTES = HEADER_MAX_BYTES + MAX_BODY_CHARS + 1024;
const READ_CHUNK = 64 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// Closed list of refusals, in plain words. No message names a key, a secret or a full hash, and none uses an em-dash.
export const STORE_REFUSALS = {
  'rolled-back': 'The shared history in this project folder is older than what this device has already seen, so it was not opened. Nothing was changed. This happens when the folder was restored from an older backup or copy, or when part of it was deleted. Put the newer copy of the folder back if you have one, or ask your staff lead for help.',
  'mark-unverified': 'This device\'s signed record of how far it has seen the shared history does not verify, so the shared history in this project folder cannot be checked against it and was not opened. Nothing was changed. Ask your staff lead for help.',
  'blob-too-large': 'A sealed attachment is larger than the 8 MB the shared history accepts, so it was not written. Nothing was changed.',
  symlink: 'A folder or file on the way to the shared history in this project is a symbolic link, so nothing was read or written through it. Nothing was changed. Replace it with a real folder or file.',
  unreadable: 'Part of the shared history in this project folder could not be read, so it was not opened. Nothing was changed. Check that the folder and its files can be read by your user account.',
  'not-a-store': 'The shared history folder in this project is not a folder this extension made, so it was not opened. Nothing was changed.',
  'out-of-order': 'This update does not follow the last one this device wrote to the shared history, so nothing was written. Nothing was changed.'
} as const;
export type StoreRefusal = keyof typeof STORE_REFUSALS;
export interface StoreRefused { refused: StoreRefusal; message: string }

/** What the store needs from the host: secret storage for marks, this device's signer and the key status that verifies its marks. */
export interface ReplicaStoreDeps {
  secrets: SecretStorageLike;
  signer: () => Promise<PayloadSigner>;
  keyStatus: () => Promise<KeyStatusLookup>;
  now?: () => Date;
}

export type AppendResult = { ok: true; written: number } | StoreRefused;

function refusal(reason: StoreRefusal): StoreRefused {
  return { refused: reason, message: STORE_REFUSALS[reason] };
}

class Refusal extends Error {
  public constructor(public readonly reason: StoreRefusal) {
    super(STORE_REFUSALS[reason]);
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** One (stream, writer) file as read so far. */
interface StreamFile {
  readonly stream: string;
  readonly writer: string;
  readonly file: string;
  /** Bytes up to and including the last newline read. */
  offset: number;
  /** The file's size when last read; above offset means a torn tail. */
  size: number;
  readonly hashes: Set<string>;
  readonly bySeq: Map<number, string[]>;
  maxSeq: number;
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
function blobWire(blob: SealedBlob): Buffer | undefined {
  if (typeof blob?.bytes !== 'string' || typeof blob.hash !== 'string' || !HASH_PATTERN.test(blob.hash) || !BASE64URL.test(blob.bytes)) return undefined;
  return Buffer.from(blob.bytes, 'base64url');
}

/** The largest base64url text that can decode to BLOB_MAX_BYTES; longer text is refused before it is decoded. */
const MAX_BLOB_CHARS = Math.ceil((BLOB_MAX_BYTES * 4) / 3);

interface LineRead { lines: Array<string | undefined>; end: number; size: number }

/** Whole lines from `from` on, read in chunks. A line over MAX_LINE_BYTES comes back undefined (damaged). Bytes after the last newline are left. */
async function readWholeLines(handle: FileHandle, from: number): Promise<LineRead> {
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
async function checkPath(root: string, parts: readonly string[]): Promise<StoreRefusal | undefined> {
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
async function ensureDir(base: string, parts: readonly string[]): Promise<string> {
  const problem = await checkPath(base, parts);
  if (problem) throw new Refusal(problem);
  const dir = path.join(base, ...parts);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Writes bytes to a temporary file beside `file`, syncs it, then renames it into place. */
async function writeAtomic(file: string, bytes: Buffer | string): Promise<void> {
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

/** Writes every byte of `bytes` at `position`, however many writes that takes. */
async function writeAllAt(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let done = 0;
  while (done < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, done, bytes.length - done, position + done);
    if (bytesWritten <= 0) throw new Error('The disk accepted no bytes.');
    done += bytesWritten;
  }
}

function fileId(stream: string, writer: string): string {
  return `${stream}/${writer}`;
}

export class ReplicaStore {
  private readonly files = new Map<string, StreamFile>();
  private readonly byHash = new Map<string, SealedEntry>();
  private readonly order: string[] = [];
  private damaged = 0;

  private constructor(public readonly root: string, public readonly dir: string, private readonly deps: ReplicaStoreDeps) {}

  /**
   * Opens (and on first use makes) the store of the project at `root`. Refused when a symbolic link is on the way, when part of the store cannot be
   * read, when this device's mark does not verify, or when the files are behind the mark.
   */
  public static async open(root: string, deps: ReplicaStoreDeps): Promise<ReplicaStore | StoreRefused> {
    const absolute = path.resolve(root);
    const store = new ReplicaStore(absolute, path.join(absolute, REPLICA_DIR), deps);
    try {
      return await store.locked(async () => {
        await store.catchUp();
        const mark = await store.readOwnMark();
        const compared = compareWithMark(mark ?? { v: 1, rosterHead: null, heads: [] }, store.fileStates());
        if (!compared.ok) throw new Refusal('rolled-back');
        if (mark?.rosterHead && !store.byHash.has(mark.rosterHead)) throw new Refusal('rolled-back');
        return store;
      });
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.reason);
      throw error;
    }
  }

  /** Every stored entry, in the order the store first saw it. */
  public entries(): SealedEntry[] {
    return this.order.map((hash) => this.byHash.get(hash) as SealedEntry);
  }

  /** Is an entry with this hash in the store? */
  public has(hash: string): boolean {
    return this.byHash.has(hash);
  }

  /** The highest seq stored for one writer in one stream and one hash at it, or undefined when the store holds none. */
  public head(stream: string, writer: string): { seq: number; hash: string } | undefined {
    const file = this.files.get(fileId(stream, writer));
    if (!file || file.maxSeq < 0) return undefined;
    return { seq: file.maxSeq, hash: (file.bySeq.get(file.maxSeq) ?? [])[0] };
  }

  /** Reads what other windows and processes wrote since this store last looked. Refused like open when a file went backwards. */
  public async refresh(): Promise<{ ok: true } | StoreRefused> {
    try {
      return await this.locked(async () => {
        await this.catchUp();
        return { ok: true as const };
      });
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.reason);
      throw error;
    }
  }

  /** How many whole lines could not be read as an entry (damaged or edited lines). They are skipped, never counted. */
  public damagedLines(): number {
    return this.damaged;
  }

  /** A stored blob, or undefined when it is not here, is not a plain file, or its bytes do not match its name. */
  public async blob(hash: string): Promise<SealedBlob | undefined> {
    if (!HASH_PATTERN.test(hash)) return undefined;
    if (await checkPath(this.root, [...REPLICA_DIR.split('/'), 'blobs'])) return undefined;
    const file = path.join(this.dir, 'blobs', hash);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > BLOB_MAX_BYTES) return undefined;
      const bytes = await readFile(file, { flag: constants.O_RDONLY | NOFOLLOW });
      return sha256Hex(bytes) === hash ? { hash, bytes: bytes.toString('base64url') } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Appends this device's own built entries, in order, with their blobs. An entry already stored is skipped (a retry after a crash). Each new entry
   * must follow the last one in its file (seq one higher, prev naming it), or nothing is written. Blobs go first, then the lines, then the mark.
   */
  public async appendOwn(built: readonly BuiltEntry[]): Promise<AppendResult> {
    const own = writerIdOf((await this.deps.signer()).publicKey);
    const entries = built.map((item) => {
      const entry = parseSealed(item.entry);
      if (!entry || entry.header.writer !== own) throw new Error('Nothing was written: appendOwn takes only entries this device built and signed.');
      return entry;
    });
    const blobs = new Map<string, Buffer>();
    for (const blob of built.flatMap((item) => item.blobs)) {
      if (typeof blob?.bytes === 'string' && blob.bytes.length > MAX_BLOB_CHARS) return refusal('blob-too-large');
      const wire = blobWire(blob);
      if (!wire) throw new Error('Nothing was written: a blob is not in the shape this version writes.');
      if (wire.length > BLOB_MAX_BYTES) return refusal('blob-too-large');
      if (sha256Hex(wire) !== blob.hash) throw new Error('Nothing was written: a blob\'s bytes do not match its name.');
      blobs.set(blob.hash, wire);
    }
    try {
      return await this.locked(async () => {
        await this.catchUp();
        const mark = await this.readOwnMark();
        // Plan the batch against the files as they are now, before anything is written.
        const heads = new Map<string, { seq: number; hashes: readonly string[] }>();
        const fresh: SealedEntry[] = [];
        const planned = new Set<string>();
        for (const entry of entries) {
          const hash = entryHash(entry.header);
          if (this.byHash.has(hash) || planned.has(hash)) continue;
          const id = fileId(entry.header.stream, entry.header.writer);
          const known = this.files.get(id);
          const head = heads.get(id) ?? { seq: known?.maxSeq ?? -1, hashes: known && known.maxSeq >= 0 ? known.bySeq.get(known.maxSeq) ?? [] : [] };
          const follows = head.seq < 0 ? entry.header.seq === 0 && entry.header.prev === GENESIS_PREV : entry.header.seq === head.seq + 1 && head.hashes.includes(entry.header.prev);
          if (!follows) throw new Refusal('out-of-order');
          heads.set(id, { seq: entry.header.seq, hashes: [hash] });
          planned.add(hash);
          fresh.push(entry);
        }
        if (fresh.length === 0) return { ok: true, written: 0 };
        for (const [hash, wire] of blobs) await this.putBlobBytes(hash, wire);
        const touched = await this.appendLines(fresh);
        await this.writeOwnMark(mark, touched);
        return { ok: true, written: fresh.length };
      });
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.reason);
      throw error;
    }
  }

  // ---- inside the lock ----------------------------------------------------------------------------------------------------------------------

  /**
   * Runs `work` under the in-process register lock (same-process order) and, inside it, the cross-window file lock (other windows and processes),
   * after checking that no symbolic link is on the way to the store. Neither lock is re-entrant: `work` never calls another locked method.
   */
  private locked<T>(work: () => Promise<T>): Promise<T> {
    return withRegisterLock(this.dir, async () => {
      const parts = REPLICA_DIR.split('/');
      const problem = await checkPath(this.root, parts);
      if (problem) throw new Refusal(problem);
      await mkdir(this.dir, { recursive: true });
      return withFileLock(this.dir, REPLICA_LOCK_FILE, async () => {
        const again = await checkPath(this.root, parts);
        if (again) throw new Refusal(again);
        await this.ensureIgnore();
        return work();
      });
    });
  }

  /** The store's own .gitignore: written when missing or different, so the folder always ignores itself. */
  private async ensureIgnore(): Promise<void> {
    const file = path.join(this.dir, '.gitignore');
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Refusal('symlink');
      if (info.isFile() && (await readFile(file, 'utf8')) === STORE_GITIGNORE) return;
      if (!info.isFile()) throw new Refusal('not-a-store');
    } catch (error) {
      if (error instanceof Refusal) throw error;
      if (errorCode(error) !== 'ENOENT') throw new Refusal('unreadable');
    }
    await writeAtomic(file, STORE_GITIGNORE);
  }

  /** Reads every stream file, and the new lines of files read before. A file shorter than what was read before has been rolled back. */
  private async catchUp(): Promise<void> {
    const streamsDir = path.join(this.dir, 'streams');
    let streams: string[];
    try {
      const info = await lstat(streamsDir);
      if (info.isSymbolicLink()) throw new Refusal('symlink');
      if (!info.isDirectory()) throw new Refusal('not-a-store');
      streams = (await readdir(streamsDir)).sort();
    } catch (error) {
      if (error instanceof Refusal) throw error;
      if (errorCode(error) === 'ENOENT') return;
      throw new Refusal('unreadable');
    }
    for (const stream of streams) {
      if (!STREAM_ID_PATTERN.test(stream)) continue;
      const dir = path.join(streamsDir, stream);
      let names: string[];
      try {
        const info = await lstat(dir);
        if (info.isSymbolicLink()) throw new Refusal('symlink');
        if (!info.isDirectory()) continue;
        names = (await readdir(dir)).sort();
      } catch (error) {
        if (error instanceof Refusal) throw error;
        throw new Refusal('unreadable');
      }
      for (const name of names) {
        const match = /^([0-9a-f]{64})\.jsonl$/.exec(name);
        if (!match) continue;
        const writer = match[1];
        const id = fileId(stream, writer);
        let file = this.files.get(id);
        if (!file) {
          file = { stream, writer, file: path.join(dir, name), offset: 0, size: 0, hashes: new Set(), bySeq: new Map(), maxSeq: -1 };
          this.files.set(id, file);
        }
        await this.readFile(file);
      }
    }
  }

  /** Reads the new whole lines of one stream file. */
  private async readFile(file: StreamFile): Promise<void> {
    let handle: FileHandle;
    try {
      const info = await lstat(file.file);
      if (info.isSymbolicLink()) throw new Refusal('symlink');
      if (!info.isFile()) throw new Refusal('not-a-store');
      handle = await open(file.file, constants.O_RDONLY | NOFOLLOW);
    } catch (error) {
      if (error instanceof Refusal) throw error;
      if (errorCode(error) === 'ENOENT' && file.offset > 0) throw new Refusal('rolled-back');
      if (errorCode(error) === 'ENOENT') return;
      if (errorCode(error) === 'ELOOP') throw new Refusal('symlink');
      throw new Refusal('unreadable');
    }
    try {
      const size = (await handle.stat()).size;
      if (size < file.offset) throw new Refusal('rolled-back');
      if (size === file.offset) { file.size = size; return; }
      const read = await readWholeLines(handle, file.offset);
      for (const line of read.lines) this.take(file, line);
      file.offset = read.end;
      file.size = read.size;
    } catch (error) {
      if (error instanceof Refusal) throw error;
      throw new Refusal('unreadable');
    } finally {
      await handle.close();
    }
  }

  /** Indexes one whole line of a file. A line that is not an entry of this file is damaged and skipped. */
  private take(file: StreamFile, line: string | undefined): void {
    let entry: SealedEntry | undefined;
    try {
      entry = line === undefined ? undefined : parseSealed(JSON.parse(line) as unknown);
    } catch {
      entry = undefined;
    }
    if (!entry || entry.header.stream !== file.stream || entry.header.writer !== file.writer) {
      this.damaged += 1;
      return;
    }
    this.index(file, entry, entryHash(entry.header));
  }

  private index(file: StreamFile, entry: SealedEntry, hash: string): void {
    if (file.hashes.has(hash)) return;
    file.hashes.add(hash);
    const atSeq = file.bySeq.get(entry.header.seq);
    if (atSeq) atSeq.push(hash); else file.bySeq.set(entry.header.seq, [hash]);
    if (entry.header.seq > file.maxSeq) file.maxSeq = entry.header.seq;
    if (!this.byHash.has(hash)) {
      this.byHash.set(hash, entry);
      this.order.push(hash);
    }
  }

  /** Writes new entries as whole lines, one write and one fsync per file, and indexes them. Returns the ids of the files written. */
  private async appendLines(entries: readonly SealedEntry[]): Promise<Set<string>> {
    const byFile = new Map<string, SealedEntry[]>();
    for (const entry of entries) {
      const id = fileId(entry.header.stream, entry.header.writer);
      const list = byFile.get(id);
      if (list) list.push(entry); else byFile.set(id, [entry]);
    }
    for (const [id, list] of byFile) {
      const { stream, writer } = list[0].header;
      const dir = await ensureDir(this.dir, ['streams', stream]);
      let file = this.files.get(id);
      if (!file) {
        file = { stream, writer, file: path.join(dir, `${writer}.jsonl`), offset: 0, size: 0, hashes: new Set(), bySeq: new Map(), maxSeq: -1 };
        this.files.set(id, file);
      }
      const text = list.map((entry) => `${JSON.stringify({ header: entry.header, body: entry.body })}\n`).join('');
      const bytes = Buffer.from(text, 'utf8');
      const handle = await open(file.file, constants.O_RDWR | constants.O_CREAT | NOFOLLOW, 0o644);
      try {
        const size = (await handle.stat()).size;
        if (size < file.offset) throw new Refusal('rolled-back');
        if (size > file.offset) {
          // A torn tail: bytes after the last newline, from an append that crashed. It was never an entry and never counted, so it is cut off
          // here, under the lock, and the new lines start where the last whole line ended. Whole lines found here were written without the lock.
          const tail = await readWholeLines(handle, file.offset);
          if (tail.lines.length > 0) throw new Refusal('out-of-order');
          await handle.truncate(file.offset);
        }
        await writeAllAt(handle, bytes, file.offset);
        await handle.sync();
      } finally {
        await handle.close();
      }
      file.offset += bytes.length;
      file.size = file.offset;
      for (const entry of list) this.index(file, entry, entryHash(entry.header));
    }
    return new Set(byFile.keys());
  }

  /** Writes one blob's wire bytes under its hash unless a plain file with that name is already there. */
  private async putBlobBytes(hash: string, wire: Buffer): Promise<void> {
    const dir = await ensureDir(this.dir, ['blobs']);
    const file = path.join(dir, hash);
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Refusal('symlink');
      if (info.isFile()) return;
    } catch (error) {
      if (error instanceof Refusal) throw error;
      if (errorCode(error) !== 'ENOENT') throw new Refusal('unreadable');
    }
    await writeAtomic(file, wire);
  }

  private fileStates(): MarkFileState[] {
    return [...this.files.values()].map((file) => ({ stream: file.stream, writer: file.writer, count: file.hashes.size, hashesAt: (seq: number) => file.bySeq.get(seq) ?? [] }));
  }

  /** This device's mark for this store: undefined when none; refused when one is there and does not verify. */
  private async readOwnMark(): Promise<ReplicaMark | undefined> {
    const read = await readMark(this.deps.secrets, markKey(this.dir), await this.deps.keyStatus());
    if (read.kind === 'unverified') throw new Refusal('mark-unverified');
    return read.kind === 'mark' ? read.mark : undefined;
  }

  /** The mark moved forward for the files written: their heads now, every other head as it was. */
  private async writeOwnMark(before: ReplicaMark | undefined, touched: ReadonlySet<string>): Promise<void> {
    const heads = new Map<string, MarkHead>((before?.heads ?? []).map((head) => [fileId(head.stream, head.writer), head]));
    for (const id of touched) {
      const file = this.files.get(id);
      if (!file || file.maxSeq < 0) continue;
      heads.set(id, { stream: file.stream, writer: file.writer, seq: file.maxSeq, hash: (file.bySeq.get(file.maxSeq) ?? [])[0], count: file.hashes.size });
    }
    const mark: ReplicaMark = { v: 1, rosterHead: before?.rosterHead ?? null, heads: [...heads.values()] };
    await writeMark(this.deps.secrets, markKey(this.dir), await this.deps.signer(), mark, this.deps.now ?? (() => new Date()));
  }
}

