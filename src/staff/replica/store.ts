// The replica store on disk (D-27, D-46): where a multi-user staff project's signed entries, sealed blobs, grants and checkpoints live on this
// machine, under REPLICA_DIR (.planning/staff/replica/) in the project. Node I/O only; never imports vscode. It knows no keys and no roster: it keeps
// sealed bytes, checks their shape, and hands them to the fold. Decryption, the decode worker and folding are wired by the project host.
//
// Layout:
//   .gitignore                          '*' and '!.gitignore': git ignores the folder, so the store is never committed by accident.
//   streams/<stream>/<writer>.jsonl     one sealed entry per line ({ header, body }), append-only, one file per writer per stream.
//   blobs/<hash>                        sealed blob wire bytes, named by their sha256.
//   grants/<cell>/<epoch>-<hash>.json   signed cell grants, named by the sha256 of their canonical bytes.
//   checkpoints/<hash>.json             signed checkpoints, named by checkpointHash.
//   project.json                        the convenience copy of the genesis pin (replicaProject.ts); the store copies it when it starts again.
//   replica.lock                        the cross-window lock file (withFileLock).
//
// Rules:
// - Appends write whole lines in one write, then fsync. A reader ignores bytes after the last newline (a crash mid-append) and never counts them.
// - Blobs are written to a temporary file, synced, then renamed into place.
// - Every append runs under withRegisterLock(storeDir) for order inside one process and, inside it, withFileLock(storeDir, 'replica.lock') for
//   order across windows and processes, so appends never interleave; inside the locks the store first catches up with lines another window wrote.
// - How far this device has seen is kept in a signed mark in secret storage (marks.ts). Opening a store whose files are behind the mark is refused
//   rolled-back, or damaged when lines it had read can no longer be read. The mark is a floor: lines are written and synced before it, so a mark
//   that could not be recorded leaves the files ahead of it, and the next write records it from every file (31-REVIEW MJ-06).
// - A line in this device's own file counts only when it carries this device's valid signature; any other line there is damaged and never moves
//   this device's head (31-REVIEW CR-02). Signatures of other writers are the fold's job.
// - A symbolic link anywhere from the project root to a store file is refused: nothing is read or written through it.
// - Entries from outside the machine pass an injected check (the decode worker, wired by the project host) before they reach the fold (D-05). An
//   entry the check refuses is still written, held with its reason in the signed mark, and left out of entries(); it is never silently dropped. An
//   entry the check could not run on yet (its key or its blob is not here), and an entry found on disk that no check has passed (copied in by hand,
//   or written by another install), waits out of the fold until recheck() passes it (31-REVIEW MJ-07).
// - The store never deletes an entry or a blob and never rewrites a line (P-31-17). No private key or secret is ever written here (P-31-18).
// - Starting again (startAgain, person-confirmed, 31-REVIEW MJ-08) moves the whole folder aside, never deletes it, and starts a new one with this
//   device's own signed entries, the grants, the blobs and project.json carried over, under a new mark.
import { createHash, randomBytes } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretStorageLike } from '../../services/auth';
import { withFileLock } from '../../services/stateMirrorLock';
import { withRegisterLock } from '../registerLock';
import { REPLICA_DIR, REPLICA_PROJECT_FILE } from '../../domain/staff/multiUser';
import { BLOB_MAX_BYTES, GENESIS_PREV, HASH_PATTERN, HEADER_MAX_BYTES, INLINE_BODY_MAX_BYTES, SEALED_OVERHEAD, STREAM_ID_PATTERN, entryHash, parseHeaderShape, sha256Hex, verifyHeader, writerIdOf } from '../../domain/replica/entry';
import type { BuiltEntry, SealedBlob, SealedEntry } from '../../domain/replica/entry';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import type { PayloadSigner } from '../../domain/team/signedPayload';
import { canonicalBytes } from '../../domain/team/canonical';
import { checkpointHash } from '../../domain/replica/checkpoint';
import type { SignedCheckpoint } from '../../domain/replica/checkpoint';
import { MAX_PAYLOAD_BYTES } from '../../domain/team/signedPayload';
import { GRANT_MAX_BYTES } from '../../domain/replica/cellKeys';
import { isRecord } from '../../domain/team/validate';
import { readWhole } from '../staffFiles';
import { compareWithMark, digestOf, heldReason, markKey, readMark, writeMark } from './marks';
import type { MarkFileState, MarkHead, ReplicaMark, WaitReason } from './marks';

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

/** The command that starts this computer's shared history again, as the refusals name it. */
export const START_AGAIN_COMMAND_TITLE = 'Staff: Start This Computer\'s Shared History Again';
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
  'out-of-order': 'This update does not follow the last one this device wrote to the shared history, so nothing was written. Nothing was changed.'
} as const;
export type StoreRefusal = keyof typeof STORE_REFUSALS;
export interface StoreRefused { refused: StoreRefusal; message: string }

/** The refusals that starting this computer's shared history again resolves. Every other refusal has its own fix and is never reset. */
export const START_AGAIN_REFUSALS: readonly StoreRefusal[] = ['rolled-back', 'damaged', 'mark-unverified'];

/** What the store needs from the host: secret storage for marks, this device's signer and the key status that verifies its marks. */
export interface ReplicaStoreDeps {
  secrets: SecretStorageLike;
  signer: () => Promise<PayloadSigner>;
  keyStatus: () => Promise<KeyStatusLookup>;
  now?: () => Date;
}

export type AppendResult = { ok: true; written: number } | StoreRefused;

/**
 * What the injected check says of one entry from outside: it passes; it is refused (held with the reason); or it cannot be checked yet because its
 * epoch key or its blob is not on this machine (it waits out of the fold, and recheck() runs the check again when they arrive).
 */
export type CheckVerdict = { ok: true } | { ok: false; reason: string } | { ok: false; awaiting: 'key' | 'blob' };

/** The injected check an entry from outside passes before it reaches the fold. */
export type ForeignCheck = (entry: SealedEntry) => Promise<CheckVerdict>;

export interface IngestResult {
  ok: true;
  /** New entries written (held and waiting ones included). */
  added: number;
  /** Entries the store already had, or given twice in this call: not written again and not checked again. */
  duplicates: number;
  /** New entries the check refused: written, and left out of entries(). */
  held: Array<{ hash: string; reason: string }>;
  /** New entries the check could not run on yet: written, and left out of entries() until recheck() passes them. */
  waiting: Array<{ hash: string; reason: WaitReason }>;
  /** Inputs that are not a sealed entry, whose body does not match its header, or that name this device as writer without its signature. */
  dropped: number;
  blobsAdded: number;
  /** Blobs not written: over BLOB_MAX_BYTES, or bytes that do not match their name. */
  blobsRefused: number;
}

export interface RecheckResult { ok: true; passed: number; held: number; waiting: number }

/** What starting again did: where the old folder was set aside (relative to the project, with forward slashes) and how many entries were carried. */
export interface StartedAgain { ok: true; setAside: string; carried: number }

/** A signed grant or checkpoint file read back, or the file named with why it could not be. Unreadable files are listed, never dropped silently. */
export interface StoredGrant { cell: string; epoch: number; hash: string; signed: unknown }
export interface StoredCheckpoint { hash: string; signed: unknown }
export interface UnreadableFile { file: string; reason: string }

// A grant to every device a project can hold is larger than other signed items (GRANT_MAX_BYTES, MN-04).
const SIGNED_FILE_MAX_BYTES = Math.max(2 * MAX_PAYLOAD_BYTES, GRANT_MAX_BYTES);
const PROJECT_FILE_MAX_BYTES = 64 * 1024;
const PROJECT_FILE_NAME = path.posix.basename(REPLICA_PROJECT_FILE);

/** This device as the store knows it: its writer id and the public key its own lines must verify against. */
interface OwnDevice { writer: string; publicKey: string }

function ownOf(signer: PayloadSigner): OwnDevice {
  return { writer: writerIdOf(signer.publicKey), publicKey: signer.publicKey };
}

/** A check's verdict made safe: anything but a clear pass or a clear wait is a refusal with a plain one-line reason. */
async function runCheck(check: ForeignCheck, entry: SealedEntry): Promise<{ kind: 'pass' } | { kind: 'held'; reason: string } | { kind: 'wait'; reason: WaitReason }> {
  let verdict: unknown;
  try {
    verdict = await check(entry);
  } catch {
    return { kind: 'held', reason: 'The decode check could not run on this update.' };
  }
  if (isRecord(verdict) && verdict.ok === true) return { kind: 'pass' };
  if (isRecord(verdict) && verdict.ok === false && (verdict.awaiting === 'key' || verdict.awaiting === 'blob')) return { kind: 'wait', reason: verdict.awaiting === 'key' ? 'awaiting-key' : 'awaiting-blob' };
  return { kind: 'held', reason: heldReason(isRecord(verdict) ? verdict.reason : undefined) };
}

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
  /** The distinct entries read, in file order. */
  readonly hashes: Set<string>;
  readonly bySeq: Map<number, string[]>;
  maxSeq: number;
  /** sha256 running over the entry hashes in file order (digestOf), so the mark's digest of the whole file costs one copy. */
  readonly running: Hash;
  /** Whole lines that are not an entry of this file. */
  damaged: number;
}

function newStreamFile(stream: string, writer: string, file: string): StreamFile {
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

/** A time as YYYYMMDD-HHMMSS in UTC, for the name of a folder set aside. */
function stampOf(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** Writes whole lines to a new file and syncs it. */
async function writeNewFile(file: string, bytes: Buffer | string): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ReplicaStore {
  private readonly files = new Map<string, StreamFile>();
  private readonly byHash = new Map<string, SealedEntry>();
  private readonly order: string[] = [];
  /** Entries from outside the decode check refused, with its reason. Never released once held. */
  private readonly held = new Map<string, string>();
  /** Entries from outside no check has passed yet, with why. */
  private readonly waiting = new Map<string, WaitReason>();
  private damaged = 0;
  private waitingAdded = 0;
  /** The mark last read or written, and its exact text, so a mark nobody changed is not compared again. */
  private mark: ReplicaMark | undefined;
  private markText: string | undefined;

  private constructor(public readonly root: string, public readonly dir: string, private readonly deps: ReplicaStoreDeps, private readonly own: OwnDevice) {}

  /**
   * Opens (and on first use makes) the store of the project at `root`. Refused when a symbolic link is on the way, when part of the store cannot be
   * read, when this device's mark does not verify, or when the files are behind the mark (rolled-back) or lines it counted are damaged.
   */
  public static async open(root: string, deps: ReplicaStoreDeps): Promise<ReplicaStore | StoreRefused> {
    const absolute = path.resolve(root);
    const store = new ReplicaStore(absolute, path.join(absolute, REPLICA_DIR), deps, ownOf(await deps.signer()));
    try {
      return await store.locked(async () => {
        await store.catchUp();
        await store.syncMark();
        return store;
      });
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.reason);
      throw error;
    }
  }

  /**
   * Starts this computer's shared history again (31-REVIEW MJ-08), after the person confirmed it. Only for a store refused rolled-back, damaged or
   * mark-unverified: a store that opens is refused not-needed, and any other refusal is returned as it is, with nothing changed.
   *
   * The whole store folder is moved aside to `<store>.set-aside-<time>` beside it (never deleted; it keeps its own .gitignore, so git still ignores
   * it), and a new store is made from what can be carried safely: this device's own entries that carry its valid signature (so its next entry follows
   * the last one it wrote instead of forking its chain), the grants and blobs that match their names, and project.json. The new store is built in a
   * temporary folder first and renamed into place, then this device's mark is replaced by one for the new store. Entries of other writers are not
   * carried: they come back with a new welcome file (and, in a later version, from the sharing service). An interruption at any step leaves either
   * the old store or the new one in place with a mark that refuses the other, so running this again finishes the job.
   */
  public static async startAgain(root: string, deps: ReplicaStoreDeps): Promise<StartedAgain | StoreRefused> {
    const probe = await ReplicaStore.open(root, deps);
    if (probe instanceof ReplicaStore) return refusal('not-needed');
    if (!START_AGAIN_REFUSALS.includes(probe.refused)) return probe;
    const absolute = path.resolve(root);
    const dir = path.join(absolute, REPLICA_DIR);
    const own = ownOf(await deps.signer());
    const parts = REPLICA_DIR.split('/');
    try {
      return await withRegisterLock(dir, () => withFileLock(dir, REPLICA_LOCK_FILE, async () => {
        const problem = await checkPath(absolute, parts);
        if (problem) throw new Refusal(problem);
        const old = new ReplicaStore(absolute, dir, deps, own);
        await old.catchUp();
        const temporary = `${dir}.new-${randomBytes(6).toString('hex')}`;
        await mkdir(temporary);
        await writeNewFile(path.join(temporary, '.gitignore'), STORE_GITIGNORE);
        let carried = 0;
        for (const file of old.files.values()) {
          if (file.writer !== own.writer || file.hashes.size === 0) continue;
          await mkdir(path.join(temporary, 'streams', file.stream), { recursive: true });
          const lines = [...file.hashes].map((hash) => old.byHash.get(hash) as SealedEntry).map((entry) => `${JSON.stringify({ header: entry.header, body: entry.body })}\n`);
          await writeNewFile(path.join(temporary, 'streams', file.stream, `${file.writer}.jsonl`), lines.join(''));
          carried += lines.length;
        }
        for (const grant of (await old.grants()).grants) {
          await mkdir(path.join(temporary, 'grants', grant.cell), { recursive: true });
          await writeNewFile(path.join(temporary, 'grants', grant.cell, `${grant.epoch}-${grant.hash}.json`), canonicalBytes(grant.signed));
        }
        for (const name of await old.listDir(['blobs'], [])) {
          const blob = HASH_PATTERN.test(name) ? await old.blob(name) : undefined;
          if (blob === undefined) continue;
          await mkdir(path.join(temporary, 'blobs'), { recursive: true });
          await writeNewFile(path.join(temporary, 'blobs', name), Buffer.from(blob.bytes, 'base64url'));
        }
        const projectFile = path.join(dir, PROJECT_FILE_NAME);
        const project = (await lstat(projectFile).then((info) => info.isFile(), () => false)) ? await readWhole(projectFile, PROJECT_FILE_MAX_BYTES) : undefined;
        if (project?.kind === 'text') await writeNewFile(path.join(temporary, PROJECT_FILE_NAME), project.bytes);
        // The old folder goes aside under a name of its own, then the new one takes its place.
        const stamp = stampOf((deps.now ?? (() => new Date()))());
        let aside = `${dir}.set-aside-${stamp}`;
        for (let attempt = 2; await lstat(aside).then(() => true, () => false); attempt += 1) aside = `${dir}.set-aside-${stamp}-${attempt}`;
        await rename(dir, aside);
        await rename(temporary, dir);
        const fresh = new ReplicaStore(absolute, dir, deps, own);
        await fresh.catchUp();
        await fresh.writeOwnMark(null);
        return { ok: true as const, setAside: path.relative(absolute, aside).split(path.sep).join('/'), carried };
      }));
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.reason);
      throw error;
    }
  }

  /** What the fold gets: every stored entry except those held back or still waiting for the decode check, in the order the store first saw them. */
  public entries(): SealedEntry[] {
    return this.order.filter((hash) => !this.held.has(hash) && !this.waiting.has(hash)).map((hash) => this.byHash.get(hash) as SealedEntry);
  }

  /**
   * What the roster fold reads: every stored entry the decode check has not refused, so the ones still waiting for it too, in the order the store
   * first saw them. The roster is sealed under the base cell's keys, and this device takes those keys only from the grants the roster fold places
   * (CR-01), so a roster entry waits awaiting-key until the roster fold has read it. The roster fold applies roster kinds only and never decodes a
   * document update, so nothing the decode check guards reaches it; entries() stays what the main fold gets (31-REVIEW MJ-07).
   */
  public rosterEntries(): SealedEntry[] {
    return this.order.filter((hash) => !this.held.has(hash)).map((hash) => this.byHash.get(hash) as SealedEntry);
  }

  /** Stored entries the decode check refused, with its reason. They stay in the store and out of the fold. */
  public heldForCheck(): Array<{ hash: string; reason: string }> {
    return [...this.held].filter(([hash]) => this.byHash.has(hash)).map(([hash, reason]) => ({ hash, reason }));
  }

  /** Stored entries no decode check has passed yet, with why. They stay out of the fold until recheck() passes them. */
  public waitingForCheck(): Array<{ hash: string; reason: WaitReason }> {
    return [...this.waiting].filter(([hash]) => this.byHash.has(hash)).map(([hash, reason]) => ({ hash, reason }));
  }

  /** Rises each time an entry nobody has checked is found on disk, so the host knows to run recheck() again. */
  public get waitingVersion(): number {
    return this.waitingAdded;
  }

  /** Is an entry with this hash in the store? */
  public has(hash: string): boolean {
    return this.byHash.has(hash);
  }

  /**
   * The highest seq stored for one writer in one stream and one hash at it, or undefined when the store holds none. For this device's own writer only
   * lines that carry its valid signature count (CR-02).
   */
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
        await this.syncMark();
        return { ok: true as const };
      });
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.reason);
      throw error;
    }
  }

  /** How many whole lines could not be read as an entry (damaged, edited, or a line in this device's file it did not sign). Skipped, never counted. */
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
   * must carry this device's valid signature and follow the last one in its file (seq one higher, prev naming it), or nothing is written. Blobs go
   * first, then the lines, then the mark.
   */
  public async appendOwn(built: readonly BuiltEntry[]): Promise<AppendResult> {
    const entries = built.map((item) => {
      const entry = parseSealed(item.entry);
      if (!entry || entry.header.writer !== this.own.writer || !verifyHeader(entry.header, this.own.publicKey)) throw new Error('Nothing was written: appendOwn takes only entries this device built and signed.');
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
        await this.syncMark();
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
        await this.appendLines(fresh);
        await this.writeOwnMark();
        return { ok: true, written: fresh.length };
      });
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.reason);
      throw error;
    }
  }

  /**
   * Takes entries and blobs from outside the machine. Each input is checked for shape and body hash (signatures are the fold's job), except that an
   * entry naming this device as its writer must carry this device's valid signature or it is dropped (CR-02); such an entry is this device's own and
   * needs no decode check. Each other new entry then passes `check`. Every new entry is written; one the check refuses is held, and one the check
   * cannot run on yet waits, both recorded in the signed mark with the lines, so neither reaches the fold. An entry already stored is neither written
   * nor checked again. A check that throws counts as a refusal.
   */
  public async ingestForeign(entries: readonly unknown[], blobs: readonly SealedBlob[], check: ForeignCheck): Promise<IngestResult | StoreRefused> {
    let dropped = 0;
    let duplicates = 0;
    const seen = new Set<string>();
    const fresh: Array<{ entry: SealedEntry; hash: string }> = [];
    for (const value of entries) {
      const entry = parseSealed(value);
      if (!entry || (entry.header.writer === this.own.writer && !verifyHeader(entry.header, this.own.publicKey))) { dropped += 1; continue; }
      const hash = entryHash(entry.header);
      if (seen.has(hash) || this.byHash.has(hash)) { duplicates += 1; continue; }
      seen.add(hash);
      fresh.push({ entry, hash });
    }
    const verdicts = new Map<string, Awaited<ReturnType<typeof runCheck>>>();
    for (const { entry, hash } of fresh) verdicts.set(hash, entry.header.writer === this.own.writer ? { kind: 'pass' } : await runCheck(check, entry));
    let blobsRefused = 0;
    const goodBlobs = new Map<string, Buffer>();
    for (const blob of blobs) {
      if (typeof blob?.bytes === 'string' && blob.bytes.length > MAX_BLOB_CHARS) { blobsRefused += 1; continue; }
      const wire = blobWire(blob);
      if (!wire || wire.length > BLOB_MAX_BYTES || sha256Hex(wire) !== blob.hash) { blobsRefused += 1; continue; }
      goodBlobs.set(blob.hash, wire);
    }
    try {
      return await this.locked(async () => {
        await this.catchUp();
        await this.syncMark();
        // Another window may have stored some of these since the check ran: those are duplicates now.
        const toWrite = fresh.filter(({ hash }) => !this.byHash.has(hash));
        duplicates += fresh.length - toWrite.length;
        const held: IngestResult['held'] = [];
        const waiting: IngestResult['waiting'] = [];
        for (const { hash } of toWrite) {
          const verdict = verdicts.get(hash);
          if (verdict?.kind === 'held') { this.held.set(hash, verdict.reason); held.push({ hash, reason: verdict.reason }); }
          if (verdict?.kind === 'wait') { this.waiting.set(hash, verdict.reason); waiting.push({ hash, reason: verdict.reason }); }
        }
        let blobsAdded = 0;
        for (const [hash, wire] of goodBlobs) if (await this.putBlobBytes(hash, wire)) blobsAdded += 1;
        if (toWrite.length > 0) {
          await this.appendLines(toWrite.map(({ entry }) => entry));
          await this.writeOwnMark();
        }
        return { ok: true as const, added: toWrite.length, duplicates, held, waiting, dropped, blobsAdded, blobsRefused };
      });
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.reason);
      throw error;
    }
  }

  /**
   * Runs `check` again on every entry still waiting (never checked, or waiting for its key or blob). One that passes reaches entries(); one that is
   * refused is held; one that still cannot be checked keeps waiting. The outcome is recorded in the signed mark. An entry another window decided in
   * the meantime keeps that window's verdict.
   */
  public async recheck(check: ForeignCheck): Promise<RecheckResult | StoreRefused> {
    const targets = [...this.waiting.keys()].filter((hash) => this.byHash.has(hash));
    const verdicts = new Map<string, Awaited<ReturnType<typeof runCheck>>>();
    for (const hash of targets) verdicts.set(hash, await runCheck(check, this.byHash.get(hash) as SealedEntry));
    try {
      return await this.locked(async () => {
        await this.catchUp();
        await this.syncMark();
        let passed = 0;
        let held = 0;
        let changed = false;
        for (const [hash, verdict] of verdicts) {
          const before = this.waiting.get(hash);
          if (before === undefined) continue;
          if (verdict.kind === 'pass') { this.waiting.delete(hash); passed += 1; changed = true; }
          if (verdict.kind === 'held') { this.waiting.delete(hash); this.held.set(hash, verdict.reason); held += 1; changed = true; }
          if (verdict.kind === 'wait' && verdict.reason !== before) { this.waiting.set(hash, verdict.reason); changed = true; }
        }
        if (changed) await this.writeOwnMark();
        return { ok: true as const, passed, held, waiting: this.waitingForCheck().length };
      });
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.reason);
      throw error;
    }
  }

  /** Records the roster head this device has folded to in the mark, so a store that lost that entry is refused rolled-back. */
  public async recordRosterHead(hash: string): Promise<{ ok: true } | StoreRefused> {
    if (!this.byHash.has(hash)) throw new Error('Nothing was recorded: the roster head is not an entry in this store.');
    try {
      return await this.locked(async () => {
        await this.catchUp();
        await this.syncMark();
        await this.writeOwnMark(hash);
        return { ok: true as const };
      });
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.reason);
      throw error;
    }
  }

  /** Writes a signed cell grant as grants/<cell>/<epoch>-<hash>.json, by temporary file and rename. The same grant twice is one file. */
  public async putGrant(cell: string, epoch: number, signed: unknown): Promise<{ ok: true; hash: string } | StoreRefused> {
    if (!STREAM_ID_PATTERN.test(cell) || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Nothing was written: a grant needs a cell id and an epoch of 1 or more.');
    const bytes = canonicalBytes(signed);
    if (bytes.length > GRANT_MAX_BYTES) throw new Error('Nothing was written: the grant is larger than a signed item may be.');
    const hash = sha256Hex(bytes);
    return this.putSigned(['grants', cell], `${epoch}-${hash}.json`, bytes, hash);
  }

  /** Writes a signed checkpoint as checkpoints/<checkpointHash>.json, by temporary file and rename. */
  public async putCheckpoint(signed: SignedCheckpoint): Promise<{ ok: true; hash: string } | StoreRefused> {
    if (!isRecord(signed) || !isRecord(signed.payload) || typeof signed.sig !== 'string') throw new Error('Nothing was written: the checkpoint is not a signed checkpoint.');
    const bytes = canonicalBytes(signed);
    if (bytes.length > SIGNED_FILE_MAX_BYTES) throw new Error('Nothing was written: the checkpoint is larger than a signed item may be.');
    const hash = checkpointHash(signed);
    return this.putSigned(['checkpoints'], `${hash}.json`, bytes, hash);
  }

  /** Every grant file, read back and checked against its name; files that cannot be read are listed with why. */
  public async grants(): Promise<{ grants: StoredGrant[]; unreadable: UnreadableFile[] }> {
    const grants: StoredGrant[] = [];
    const unreadable: UnreadableFile[] = [];
    const top = await this.listDir(['grants'], unreadable);
    for (const cell of top) {
      if (!STREAM_ID_PATTERN.test(cell)) { unreadable.push({ file: `grants/${cell}`, reason: 'its name is not a cell id' }); continue; }
      for (const name of await this.listDir(['grants', cell], unreadable)) {
        const file = `grants/${cell}/${name}`;
        const match = /^([1-9][0-9]{0,15})-([0-9a-f]{64})\.json$/.exec(name);
        if (!match) { unreadable.push({ file, reason: 'its name is not one the store writes' }); continue; }
        const read = await this.readSigned(file, (value) => sha256Hex(canonicalBytes(value)) === match[2]);
        if ('reason' in read) unreadable.push({ file, reason: read.reason }); else grants.push({ cell, epoch: Number(match[1]), hash: match[2], signed: read.value });
      }
    }
    return { grants, unreadable };
  }

  /** Every checkpoint file, read back and checked against its name; files that cannot be read are listed with why. */
  public async checkpoints(): Promise<{ checkpoints: StoredCheckpoint[]; unreadable: UnreadableFile[] }> {
    const checkpoints: StoredCheckpoint[] = [];
    const unreadable: UnreadableFile[] = [];
    for (const name of await this.listDir(['checkpoints'], unreadable)) {
      const file = `checkpoints/${name}`;
      const match = /^([0-9a-f]{64})\.json$/.exec(name);
      if (!match) { unreadable.push({ file, reason: 'its name is not one the store writes' }); continue; }
      const read = await this.readSigned(file, (value) => isRecord(value) && checkpointHash(value as unknown as SignedCheckpoint) === match[1]);
      if ('reason' in read) unreadable.push({ file, reason: read.reason }); else checkpoints.push({ hash: match[1], signed: read.value });
    }
    return { checkpoints, unreadable };
  }

  /** Names in a store folder, leaving out temporary files; a folder that is a link or cannot be listed is reported as unreadable. */
  private async listDir(parts: readonly string[], unreadable: UnreadableFile[]): Promise<string[]> {
    const problem = await checkPath(this.root, [...REPLICA_DIR.split('/'), ...parts]);
    if (problem) { unreadable.push({ file: parts.join('/'), reason: problem === 'symlink' ? 'it is a symbolic link' : 'it is not a folder the store made' }); return []; }
    try {
      return (await readdir(path.join(this.dir, ...parts))).filter((name) => !name.endsWith('.tmp')).sort();
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') unreadable.push({ file: parts.join('/'), reason: 'it could not be listed' });
      return [];
    }
  }

  private async readSigned(relative: string, matches: (value: unknown) => boolean): Promise<{ value: unknown } | { reason: string }> {
    const file = path.join(this.dir, relative);
    try {
      if ((await lstat(file)).isSymbolicLink()) return { reason: 'it is a symbolic link' };
    } catch {
      return { reason: 'it could not be opened' };
    }
    const read = await readWhole(file, SIGNED_FILE_MAX_BYTES);
    if (read.kind === 'missing') return { reason: 'it is gone' };
    if (read.kind === 'unreadable') return { reason: read.reason };
    let value: unknown;
    try { value = JSON.parse(read.text) as unknown; } catch { return { reason: 'it is not readable JSON' }; }
    try {
      if (!matches(value)) return { reason: 'its content does not match its name' };
    } catch {
      return { reason: 'its content does not match its name' };
    }
    return { value };
  }

  private async putSigned(parts: readonly string[], name: string, bytes: Buffer, hash: string): Promise<{ ok: true; hash: string } | StoreRefused> {
    try {
      return await this.locked(async () => {
        const dir = await ensureDir(this.dir, parts);
        const file = path.join(dir, name);
        try {
          const info = await lstat(file);
          if (info.isSymbolicLink()) throw new Refusal('symlink');
          if (info.isFile()) return { ok: true as const, hash };
        } catch (error) {
          if (error instanceof Refusal) throw error;
          if (errorCode(error) !== 'ENOENT') throw new Refusal('unreadable');
        }
        await writeAtomic(file, bytes);
        return { ok: true as const, hash };
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
          file = newStreamFile(stream, writer, path.join(dir, name));
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

  /**
   * Indexes one whole line of a file. A line that is not an entry of this file is damaged and skipped, and so is a line in this device's own file
   * that does not carry this device's valid signature (CR-02): it never becomes this device's head. An entry of another writer found here and
   * not decided yet waits for the decode check (unchecked) until the mark or recheck() says otherwise.
   */
  private take(file: StreamFile, line: string | undefined): void {
    let entry: SealedEntry | undefined;
    try {
      entry = line === undefined ? undefined : parseSealed(JSON.parse(line) as unknown);
    } catch {
      entry = undefined;
    }
    if (!entry || entry.header.stream !== file.stream || entry.header.writer !== file.writer || (file.writer === this.own.writer && !verifyHeader(entry.header, this.own.publicKey))) {
      file.damaged += 1;
      this.damaged += 1;
      return;
    }
    const hash = entryHash(entry.header);
    const known = this.byHash.has(hash);
    this.index(file, entry, hash);
    if (!known && file.writer !== this.own.writer && !this.held.has(hash) && !this.waiting.has(hash)) {
      this.waiting.set(hash, 'unchecked');
      this.waitingAdded += 1;
    }
  }

  private index(file: StreamFile, entry: SealedEntry, hash: string): void {
    if (file.hashes.has(hash)) return;
    file.hashes.add(hash);
    file.running.update(`${hash}\n`);
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
        file = newStreamFile(stream, writer, path.join(dir, `${writer}.jsonl`));
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
  private async putBlobBytes(hash: string, wire: Buffer): Promise<boolean> {
    const dir = await ensureDir(this.dir, ['blobs']);
    const file = path.join(dir, hash);
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Refusal('symlink');
      if (info.isFile()) return false;
    } catch (error) {
      if (error instanceof Refusal) throw error;
      if (errorCode(error) !== 'ENOENT') throw new Refusal('unreadable');
    }
    await writeAtomic(file, wire);
    return true;
  }

  private fileStates(): MarkFileState[] {
    return [...this.files.values()].map((file) => ({
      stream: file.stream,
      writer: file.writer,
      count: file.hashes.size,
      damaged: file.damaged,
      digestAt: (count: number) => {
        if (count > file.hashes.size) return undefined;
        if (count === file.hashes.size) return file.running.copy().digest('hex');
        return digestOf([...file.hashes].slice(0, count));
      },
      hashesAt: (seq: number) => file.bySeq.get(seq) ?? []
    }));
  }

  /**
   * Reads this device's mark and, when it changed since this store last read or wrote it, checks the files against it (refused rolled-back or damaged
   * when they are behind it) and takes its verdicts: an entry it holds stays held; an entry it covers is waiting when it lists it, and passed when it
   * does not. Refused mark-unverified when a mark is there and does not verify.
   */
  private async syncMark(): Promise<void> {
    const read = await readMark(this.deps.secrets, markKey(this.dir), await this.deps.keyStatus());
    if (read.kind === 'unverified') throw new Refusal('mark-unverified');
    if (read.kind === 'none') { this.mark = undefined; this.markText = undefined; return; }
    if (read.text === this.markText) return;
    const compared = compareWithMark(read.mark, this.fileStates());
    if (!compared.ok) throw new Refusal(compared.reason);
    if (read.mark.rosterHead && !this.byHash.has(read.mark.rosterHead)) throw new Refusal('rolled-back');
    for (const item of read.mark.held) {
      if (this.held.has(item.hash)) continue;
      this.held.set(item.hash, item.reason);
      this.waiting.delete(item.hash);
    }
    const listed = new Map(read.mark.waiting.map((item) => [item.hash, item.reason]));
    for (const head of read.mark.heads) {
      const file = this.files.get(fileId(head.stream, head.writer));
      if (!file || file.writer === this.own.writer) continue;
      let index = 0;
      for (const hash of file.hashes) {
        if (index >= head.count) break;
        index += 1;
        if (this.held.has(hash)) continue;
        const reason = listed.get(hash);
        if (reason === undefined) this.waiting.delete(hash); else this.waiting.set(hash, reason);
      }
    }
    this.mark = read.mark;
    this.markText = read.text;
  }

  /**
   * Records the mark for every file as it is now: each file's head, count and digest, the held and the waiting entries, and the roster head (the one
   * given; otherwise the one recorded before, or none when `rosterHead` is null). Runs after the files were written and synced.
   */
  private async writeOwnMark(rosterHead?: string | null): Promise<void> {
    const heads: MarkHead[] = [];
    for (const file of this.files.values()) {
      if (file.hashes.size === 0 || file.maxSeq < 0) continue;
      heads.push({ stream: file.stream, writer: file.writer, seq: file.maxSeq, hash: (file.bySeq.get(file.maxSeq) ?? [])[0], count: file.hashes.size, digest: file.running.copy().digest('hex') });
    }
    const mark: ReplicaMark = {
      rosterHead: rosterHead === undefined ? this.mark?.rosterHead ?? null : rosterHead,
      heads,
      held: this.heldForCheck(),
      waiting: this.waitingForCheck()
    };
    const text = await writeMark(this.deps.secrets, markKey(this.dir), await this.deps.signer(), mark, this.deps.now ?? (() => new Date()));
    this.mark = mark;
    this.markText = text;
  }
}

