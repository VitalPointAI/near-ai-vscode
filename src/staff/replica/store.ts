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
//   marks/<writer>/<hash>.json          the lists of this device's mark, named by the sha256 of their bytes (marks.ts); derived data the store owns.
//   replica.lock                        the cross-window lock file (withFileLock).
//
// Rules:
// - Appends write whole lines in one write, then fsync. A reader ignores bytes after the last newline (a crash mid-append) and never counts them.
// - Blobs are written to a temporary file, synced, then renamed into place.
// - Every append runs under withRegisterLock(storeDir) for order inside one process and, inside it, withFileLock(storeDir, 'replica.lock') for
//   order across windows and processes, so appends never interleave; inside the locks the store first catches up with lines another window wrote.
// - How far this device has seen is kept in a signed mark (marks.ts): a small signed record in secret storage that commits by one hash to the lists
//   file under marks/. Opening a store whose files are behind the mark, or that lacks the lists file the mark names, is refused rolled-back, or
//   damaged when lines it had read can no longer be read. The mark is a floor: lines are written and synced before it, so a mark that could not be
//   recorded leaves the files ahead of it, and the next write records it from every file (31-REVIEW MJ-06).
// - A line in this device's own file counts only when it carries this device's valid signature; any other line there is damaged and never moves
//   this device's head (31-REVIEW CR-02). Signatures of other writers are the fold's job.
// - A symbolic link anywhere from the project root to a store file is refused: nothing is read or written through it.
// - Entries from outside the machine pass an injected check (the decode worker, wired by the project host) before they reach the fold (D-05). An
//   entry the check refuses is still written, held with its reason in the signed mark, and left out of entries(); it is never silently dropped. An
//   entry the check could not run on yet (its key or its blob is not here), and an entry found on disk that no check has passed (copied in by hand,
//   or written by another install), waits out of the fold until recheck() passes it (31-REVIEW MJ-07).
// - Refused entries are bounded (32-CONTEXT D-14), so one device cannot grow this device's mark until it can no longer be written: at most
//   MAX_REFUSED_PER_WRITER held per writer per stream, the last of them held with FLOODED_REASON as that writer's one flooded line. From then on none
//   of that writer's entries from outside in that stream is written or checked (counted in IngestResult.flooded); everyone else's still are. The
//   held list never names more than MAX_MARK_LISTED: the entry that fills it is its writer's flooded line, and past that a refused entry is not
//   kept. A new entry that would wait past MAX_MARK_WAITING is not written (IngestResult.deferred) and is taken when it comes again.
// - The store never deletes an entry or a blob and never rewrites a line (P-31-17). No private key or secret is ever written here (P-31-18).
// - Starting again (startAgain, person-confirmed, 31-REVIEW MJ-08) moves the whole folder aside, never deletes it, and starts a new one with this
//   device's own signed entries, the grants, the blobs and project.json carried over, under a new mark.
// - Starting again is resumable (32-CONTEXT D-03, D-06). Its steps, each followed by a sync of .planning/staff so a power cut keeps it:
//     built           the new store is built in .planning/staff/replica.new-<random> and synced, folder by folder;
//     intent-written  .planning/staff/replica.start-again.json names the folder to set aside, the temporary folder and the source;
//     set-aside       the store folder is renamed to replica.set-aside-<time> (skipped when there was no store folder);
//     moved-in        the temporary folder is renamed to replica;
//     marked          this device's mark is replaced by one for the new store; then the intent is removed.
//   Every open that finds the intent finishes the job first (finishStartAgain), whatever step it stopped at, and never starts an empty store. Every
//   locked operation runs under the .planning/staff lock (replica.start-again.lock) as well, so nothing makes or reads the store folder while a
//   Start Again holds it.
// - A store folder that is gone while this device's mark remains, or while a folder set aside beside it holds project.json, is refused rolled-back
//   and never made again empty: Start Again carries from the newest set-aside folder whose own entries verify, and says which one it used.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import type { SecretStorageLike } from '../../services/auth';
import { privateFileProblem } from '../../team/fileSafety';
import { withFileLock } from '../../services/stateMirrorLock';
import { withRegisterLock } from '../registerLock';
import { REPLICA_DIR } from '../../domain/staff/multiUser';
import { BLOB_MAX_BYTES, GENESIS_PREV, HASH_PATTERN, STREAM_ID_PATTERN, buildEntry, entryHash, sha256Hex, verifyHeader, writerIdOf } from '../../domain/replica/entry';
import type { BuiltEntry, SealedBlob, SealedEntry } from '../../domain/replica/entry';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import type { PayloadSigner } from '../../domain/team/signedPayload';
import { canonicalBytes } from '../../domain/team/canonical';
import { checkpointHash } from '../../domain/replica/checkpoint';
import type { SignedCheckpoint } from '../../domain/replica/checkpoint';
import { MAX_PAYLOAD_BYTES } from '../../domain/team/signedPayload';
import { GRANT_MAX_BYTES } from '../../domain/replica/cellKeys';
import { isRecord } from '../../domain/team/validate';
import { readWhole, syncFolder } from '../staffFiles';
import { MARK_LISTS_DIR, MAX_MARK_LISTED, MAX_MARK_WAITING, compareWithMark, digestOf, heldReason, readMark, writeMark } from './marks';
import type { MarkFileState, MarkHead, ReplicaMark, WaitReason } from './marks';
import * as startAgainCheck from './startAgainCheck';
import { checksFrontierV2Fixture, frontierV2CaptureCommitment } from '../../domain/replica/acceptedFrontier';
import type { KeyRing } from '../../domain/replica/rosterView';
import { CELL_ACCESS_FEATURE } from '../../domain/replica/features';
import { foldRoster, rosterView } from '../../domain/replica/roster';
import type { RosterAnchor } from '../../domain/replica/roster';
import { epochAt } from '../../domain/replica/rosterCells';
import { deviceAt } from '../../domain/replica/rosterMembers';
import { verifyEntry } from '../../domain/replica/verify';
import { identityDir, loadDeviceIdentity } from '../../team/identity';
import { readKeyHistory } from '../../team/keyHistory';
import { frontierCustody, reopenFrontierPolicy, withFrontierPolicySource } from '../../gate/frontierPolicy';
import { MANAGED_PACKET_STAGE_MAX_BYTES, isManagedPacketStage } from './managedGrantDelivery';
import { openManagedHandoffs } from './managedHandoffOutbox';
import { readHashedArtifacts, readStoredArtifact } from './storeArtifacts';
import {
  INTENT_MAX_BYTES, MAX_ACCEPTED_FRONTIER_BYTES, MAX_BLOB_CHARS, NOFOLLOW, PROJECT_FILE_NAME, Refusal,
  SET_ASIDE_NAME, STAFF_PARTS, STORE_NAME, STORE_PARTS, STORE_REFUSALS, blobWire, checkPath,
  ensureDir, errorCode, fileId, freeAsideName, frontierFileHandle, intentFileOf, intentPresent, isPlainFile,
  kindAt, leftoverFolders, newStreamFile, parseIntent, parseSealed, readFrontierFile, readWholeLines,
  sharedHistoryMissing, staffDirOf, staffRelative, stampOf, syncTree, writeAllAt, writeAtomic, writeIntent,
  writeNewFile
} from './storeFiles';
import type { StartAgainIntent, StoreRefusal, StoreRefused, StreamFile } from './storeFiles';

export { START_AGAIN_COMMAND_TITLE, START_AGAIN_INTENT_FILE, STORE_REFUSALS, parseSealed, sharedHistoryMissing } from './storeFiles';
export type { StoreRefusal, StoreRefused } from './storeFiles';

/** The cross-window lock file inside the store folder. */
export const REPLICA_LOCK_FILE = 'replica.lock';
/** The exact text of the store's own ignore file. */
export const STORE_GITIGNORE = '*\n!.gitignore\n';

const FRONTIER_STAGE_DIR = 'accepted-frontiers-v2-staged';
const FRONTIER_POLICY_DIR = 'frontier-policy-captures';
const FRONTIER_POLICY_SLOT = 'nearAi.staff.frontierPolicyCapture.';
type FrontierPreparationRequest = { policyStorage: string; pin: RosterAnchor; stream: string; keys: KeyRing; snapshot: string };
type FrontierV2FixtureRequest = FrontierPreparationRequest & { expectedSnapshot: string; opening: unknown };
type FrontierPreparationVerdict = 'ready' | 'refused' | 'unavailable';
/** The lock file in .planning/staff that Start Again, its recovery and every locked store operation take first. */
export const START_AGAIN_LOCK_FILE = 'replica.start-again.lock';
/** The steps of Start Again, in order; a test probe runs after each and can stop the process there. */
export const START_AGAIN_STEPS = ['built', 'intent-written', 'set-aside', 'rebuild-started', 'moved-in', 'marked'] as const;
export type StartAgainStep = typeof START_AGAIN_STEPS[number];
/** For tests only: awaited after each step of Start Again. */
export type StartAgainProbe = (step: StartAgainStep) => Promise<void> | void;
let startAgainProbe: StartAgainProbe | undefined;
export function setStartAgainProbe(next: StartAgainProbe | undefined): void { startAgainProbe = next; }

// A .planning/staff the user cannot write: no Start Again can run there, so a locked operation runs without its lock (only when no intent is there).
const UNWRITABLE = new Set(['EACCES', 'EPERM', 'EROFS']);

/** The refusals that starting this computer's shared history again resolves. Every other refusal has its own fix and is never reset. */
export const START_AGAIN_REFUSALS: readonly StoreRefusal[] = ['rolled-back', 'damaged', 'mark-unverified'];

/** What the store needs from the host: secret storage for marks, this device's signer and the key status that verifies its marks. */
export interface ReplicaStoreDeps {
  secrets: SecretStorageLike;
  signer: () => Promise<PayloadSigner>;
  keyStatus: () => Promise<KeyStatusLookup>;
  now?: () => Date;
  /**
   * For tests only: smaller bounds than MAX_REFUSED_PER_WRITER, MAX_MARK_LISTED and MAX_MARK_WAITING, so a test need not build tens of thousands of
   * entries. Production passes none. A value above its constant is ignored, so the mark this store writes always reads back.
   */
  limits?: Partial<{ refusedPerWriter: number; heldPerStore: number; waiting: number }>;
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
  /**
   * New entries not written because their writer is flooded in their stream (D-14): it sent MAX_REFUSED_PER_WRITER refused entries, the last held as
   * its flooded line. A refused entry the held list has no room for is not written and counted here too.
   */
  flooded: number;
  /** New entries not written this time, because the waiting list is full or no check ran on them: they are taken when delivered again. */
  deferred: number;
}

/**
 * The most refused entries from outside one writer that stay held in one stream (32-CONTEXT D-14). The last of them is held with FLOODED_REASON, the
 * writer's one flooded line; from then on none of that writer's entries from outside in that stream is written.
 */
export const MAX_REFUSED_PER_WRITER = 1_000;
/** The held reason of a writer's flooded line. A check's own reason that reads the same is stored with "check: " in front (T-32-20). */
export const FLOODED_REASON = 'flooded: too many refused changes from this device in this part of the project; later ones are not kept';
/** What the Staff Room says of a flooded writer (Phase 33). */
export const FLOODED_TEXT = 'Too many refused changes arrived from one device. They were not kept.';

export interface RecheckResult { ok: true; passed: number; held: number; waiting: number }

/**
 * What starting again did: where the old folder was set aside (relative to the project, with forward slashes; null when there was no store folder to
 * set aside) and how many entries were carried. carriedFrom names the folder carried from when it was not the one just set aside.
 */
export interface StartedAgain { ok: true; setAside: string | null; carried: number; carriedFrom?: string }

/** A signed grant or checkpoint file read back, or the file named with why it could not be. Unreadable files are listed, never dropped silently. */
export interface StoredGrant { cell: string; epoch: number; hash: string; signed: unknown }
export interface StoredCheckpoint { hash: string; signed: unknown }
export interface UnreadableFile { file: string; reason: string }

// A grant to every device a project can hold is larger than other signed items (GRANT_MAX_BYTES, MN-04).
const SIGNED_FILE_MAX_BYTES = Math.max(2 * MAX_PAYLOAD_BYTES, GRANT_MAX_BYTES);
const PROJECT_FILE_MAX_BYTES = 64 * 1024;
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
  const reason = heldReason(isRecord(verdict) ? verdict.reason : undefined);
  // Only the store writes a flooded line (T-32-20): a check's reason that reads the same is kept with a prefix, so it never floods a writer.
  return { kind: 'held', reason: reason === FLOODED_REASON ? heldReason(`check: ${reason}`) : reason };
}

function refusal(reason: StoreRefusal): StoreRefused {
  return { refused: reason, message: STORE_REFUSALS[reason] };
}

/**
 * Runs `work` under the .planning/staff lock, refusing a symbolic link on the way first. With `lenient`, a .planning/staff this user cannot write
 * (where no Start Again can run) lets `work` run without the lock, as long as no intent is there.
 */
/**
 * In-process queue per project root, joined before any await, so two locked operations started in
 * order in one window take the .planning/staff lock in that order (checkPath awaits before the
 * file lock's own queue is joined).
 */
const startAgainQueues = new Map<string, Promise<unknown>>();

function withStartAgainLock<T>(root: string, work: () => Promise<T>, lenient: boolean): Promise<T> {
  const previous = startAgainQueues.get(root) ?? Promise.resolve();
  const run = previous.then(() => startAgainLocked(root, work, lenient));
  const tail = run.then(() => undefined, () => undefined);
  startAgainQueues.set(root, tail);
  void tail.then(() => { if (startAgainQueues.get(root) === tail) startAgainQueues.delete(root); });
  return run;
}

async function startAgainLocked<T>(root: string, work: () => Promise<T>, lenient: boolean): Promise<T> {
  const problem = await checkPath(root, STAFF_PARTS);
  if (problem) throw new Refusal(problem);
  let entered = false;
  try {
    return await withFileLock(staffDirOf(root), START_AGAIN_LOCK_FILE, () => { entered = true; return work(); });
  } catch (error) {
    if (entered || !lenient || !UNWRITABLE.has(errorCode(error) ?? '')) throw error;
  }
  if (await intentPresent(root)) throw new Refusal('start-again-unfinished');
  return work();
}

export class ReplicaStore {
  private readonly files = new Map<string, StreamFile>();
  private readonly byHash = new Map<string, SealedEntry>();
  private readonly order: string[] = [];
  private readonly held = new Map<string, string>();
  private readonly waiting = new Map<string, WaitReason>();
  /** How many held entries each (stream, writer) file has, and how many in all, counting stored entries only (indexHeld). */
  private readonly heldBy = new Map<string, number>();
  private heldCount = 0;
  private readonly floodedFiles = new Map<string, { stream: string; writer: string }>();
  private damaged = 0;
  private waitingAdded = 0;
  private mark: ReplicaMark | undefined;
  private markText: string | undefined;

  /** The store folder's path from the project root, by part (the store itself, or a folder set aside that Start Again reads). */
  private readonly parts: readonly string[];

  private constructor(public readonly root: string, public readonly dir: string, private readonly deps: ReplicaStoreDeps, private readonly own: OwnDevice) {
    this.parts = path.relative(root, dir).split(path.sep);
  }

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
   * the last one it wrote instead of forking its chain), the grants and blobs that match their names, and project.json. Entries of other writers are
   * not carried: they come back with a new welcome file (and, in a later version, from the sharing service).
   *
   * Where it carries from (32-CONTEXT D-03): the store folder when it holds an entry of this device's own; otherwise the newest folder set aside
   * beside it (by name), then the newest folder left by an older Start Again (replica.new-*), whose own entries are one unbroken chain this device
   * signed; otherwise the first of those folders holding project.json (a reader device); otherwise nothing is changed (nothing-to-carry). A store
   * folder that is gone is never started empty. carriedFrom names the folder used when it was not the store folder.
   *
   * The new store is built in a temporary folder and synced, an intent is recorded, and then the renames and the mark follow, each synced (see the
   * file header). A stop at any step is finished by the next open (finishStartAgain). No file system error escapes: it is start-again-unfinished,
   * and nothing is deleted.
   */
  public static async startAgain(root: string, deps: ReplicaStoreDeps): Promise<StartedAgain | StoreRefused> {
    const probe = await ReplicaStore.open(root, deps);
    if (probe instanceof ReplicaStore) return refusal('not-needed');
    if (!START_AGAIN_REFUSALS.includes(probe.refused)) return probe;
    const absolute = path.resolve(root);
    const dir = path.join(absolute, REPLICA_DIR);
    try {
      const own = ownOf(await deps.signer());
      return await withStartAgainLock(absolute, async () => {
        // A Start Again another window left unfinished is finished first.
        await ReplicaStore.rollForward(absolute, deps, own);
        const problem = await checkPath(absolute, STORE_PARTS);
        if (problem) throw new Refusal(problem);
        const storeHere = (await kindAt(dir)) === 'folder';
        const run = (): Promise<StartedAgain> => ReplicaStore.startAgainLocked(absolute, deps, own, storeHere);
        return storeHere ? await withRegisterLock(dir, () => withFileLock(dir, REPLICA_LOCK_FILE, run)) : await withRegisterLock(dir, run);
      }, false);
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.reason);
      return refusal('start-again-unfinished');
    }
  }

  /** Start Again under the .planning/staff lock and, while the store folder is there, the store's own locks. */
  private static async startAgainLocked(root: string, deps: ReplicaStoreDeps, own: OwnDevice, storeHere: boolean): Promise<StartedAgain> {
    const dir = path.join(root, REPLICA_DIR);
    const staff = staffDirOf(root);
    // Checked again under the locks: another window may have started again since the first look.
    const old = new ReplicaStore(root, dir, deps, own);
    const verdict = await old.verdict(storeHere);
    if (verdict === undefined) throw new Refusal('not-needed');
    if (!START_AGAIN_REFUSALS.includes(verdict)) throw new Refusal(verdict);
    const source = await ReplicaStore.sourceFor(root, deps, own, storeHere ? old : undefined);
    if (source === undefined) throw new Refusal('nothing-to-carry');
    const stamp = stampOf((deps.now ?? (() => new Date()))());
    const setAside = storeHere ? await freeAsideName(staff, stamp) : null;
    const temporaryName = `${STORE_NAME}.new-${randomBytes(6).toString('hex')}`;
    const temporary = path.join(staff, temporaryName);
    const counts = await ReplicaStore.buildFrom(source.store, temporary);
    await startAgainProbe?.('built');
    await syncFolder(temporary);
    const intent: StartAgainIntent = { v: 1, writer: own.writer, setAside, temporary: temporaryName, source: source.name, ...counts };
    await writeIntent(root, intent);
    await startAgainProbe?.('intent-written');
    await syncFolder(staff);
    if (setAside !== null) {
      await rename(dir, path.join(staff, setAside));
      await startAgainProbe?.('set-aside');
      await syncFolder(staff);
    }
    await rename(temporary, dir);
    await startAgainProbe?.('moved-in');
    await syncFolder(staff);
    const fresh = new ReplicaStore(root, dir, deps, own);
    await fresh.catchUp();
    await fresh.writeOwnMark(null);
    await startAgainProbe?.('marked');
    await rm(intentFileOf(root));
    await syncFolder(staff);
    return {
      ok: true,
      setAside: setAside === null ? null : staffRelative(setAside),
      carried: counts.carried,
      ...(source.name === STORE_NAME ? {} : { carriedFrom: staffRelative(source.name) })
    };
  }

  /**
   * Where Start Again carries from: the store folder when it holds an entry of this device's own; else the newest folder set aside, then left, whose
   * own entries verify; else the first of the store folder and those folders that holds project.json; else undefined. Folders are only read.
   */
  private static async sourceFor(root: string, deps: ReplicaStoreDeps, own: OwnDevice, store: ReplicaStore | undefined): Promise<{ name: string; store: ReplicaStore } | undefined> {
    if (store?.hasOwnEntry()) return { name: STORE_NAME, store };
    const candidates: Array<{ name: string; store: ReplicaStore }> = [];
    for (const leftover of await leftoverFolders(root)) {
      const read = new ReplicaStore(root, leftover.dir, deps, own);
      try { await read.catchUp(); } catch { continue; }
      candidates.push({ name: leftover.name, store: read });
    }
    const verified = candidates.find((candidate) => candidate.store.ownChainVerifies());
    if (verified) return verified;
    for (const candidate of [...(store ? [{ name: STORE_NAME, store }] : []), ...candidates]) {
      if (await isPlainFile(path.join(candidate.store.dir, PROJECT_FILE_NAME))) return candidate;
    }
    return undefined;
  }

  /**
   * Builds a new store in `temporary` (which must not exist) from `source`, a store already read: this device's own entries, the grants and blobs that
   * match their names, project.json and the store's .gitignore. Every folder inside is synced; `temporary` itself is synced by the caller.
   */
  private static async buildFrom(source: ReplicaStore, temporary: string, rebuilding = false): Promise<{ carried: number; grants: number; blobs: number }> {
    await mkdir(temporary);
    const ignoreFile = path.join(temporary, '.gitignore');
    await writeNewFile(ignoreFile, STORE_GITIGNORE + '# Start Again is still copying this folder.\n');
    await syncFolder(temporary);
    if (rebuilding) await startAgainProbe?.('rebuild-started');
    let carried = 0;
    for (const file of source.files.values()) {
      if (file.writer !== source.own.writer || file.hashes.size === 0) continue;
      await mkdir(path.join(temporary, 'streams', file.stream), { recursive: true });
      const lines = [...file.hashes].map((hash) => source.byHash.get(hash) as SealedEntry).map((entry) => `${JSON.stringify({ header: entry.header, body: entry.body })}\n`);
      await writeNewFile(path.join(temporary, 'streams', file.stream, `${file.writer}.jsonl`), lines.join(''));
      carried += lines.length;
    }
    let grants = 0;
    for (const grant of (await source.grants()).grants) {
      await mkdir(path.join(temporary, 'grants', grant.cell), { recursive: true });
      await writeNewFile(path.join(temporary, 'grants', grant.cell, `${grant.epoch}-${grant.hash}.json`), canonicalBytes(grant.signed));
      grants += 1;
    }
    let blobs = 0;
    for (const name of await source.listDir(['blobs'], [])) {
      const blob = HASH_PATTERN.test(name) ? await source.blob(name) : undefined;
      if (blob === undefined) continue;
      await mkdir(path.join(temporary, 'blobs'), { recursive: true });
      await writeNewFile(path.join(temporary, 'blobs', name), Buffer.from(blob.bytes, 'base64url'));
      blobs += 1;
    }
    const projectFile = path.join(source.dir, PROJECT_FILE_NAME);
    const project = (await isPlainFile(projectFile)) ? await readWhole(projectFile, PROJECT_FILE_MAX_BYTES) : undefined;
    if (project?.kind === 'text') await writeNewFile(path.join(temporary, PROJECT_FILE_NAME), project.bytes);
    await syncTree(temporary);
    await writeAtomic(ignoreFile, STORE_GITIGNORE);
    return { carried, grants, blobs };
  }

  /**
   * Finishes a Start Again that stopped before its end (32-CONTEXT D-03), under the .planning/staff lock. ReplicaStore.open and every locked operation
   * call this first when an intent is there; the project host calls it before it decides a folder holds no shared project. Nothing to do is ok.
   */
  public static async finishStartAgain(root: string, deps: ReplicaStoreDeps): Promise<{ ok: true } | StoreRefused> {
    const absolute = path.resolve(root);
    try {
      const own = ownOf(await deps.signer());
      await withStartAgainLock(absolute, () => ReplicaStore.rollForward(absolute, deps, own), false);
      return { ok: true };
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.reason);
      return refusal('start-again-unfinished');
    }
  }

  /**
   * Rolls an intent forward, under the .planning/staff lock; each step is checked on disk first, so running it twice is harmless:
   *   store and temporary there: the store is set aside (under the next free name when the intent's is taken), then the temporary moved in;
   *   store gone: a matching temporary folder is moved in, or rebuilt from the source the intent names;
   *   store there, temporary gone: both renames are done.
   * Then this device's mark is written unless it already accepts the store (only for an intent of this device's own; another device's mark is its
   * own business), and the intent is removed. Anything else is start-again-unfinished, with nothing deleted.
   */
  private static async rollForward(root: string, deps: ReplicaStoreDeps, own: OwnDevice): Promise<void> {
    try {
      await ReplicaStore.rollForwardSteps(root, deps, own);
    } catch (error) {
      if (error instanceof Refusal) throw error;
      throw new Refusal('start-again-unfinished');
    }
  }

  private static async rollForwardSteps(root: string, deps: ReplicaStoreDeps, own: OwnDevice): Promise<void> {
    const intentFile = intentFileOf(root);
    let info;
    try { info = await lstat(intentFile); } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return;
      throw error;
    }
    const unfinished = new Refusal('start-again-unfinished');
    // A planted link or folder at the intent's name is never followed (T-32-01).
    if (!info.isFile()) throw unfinished;
    const read = await readWhole(intentFile, INTENT_MAX_BYTES);
    if (read.kind === 'missing') return;
    if (read.kind !== 'text') throw unfinished;
    let intent = parseIntent(read.text);
    if (intent === undefined) throw unfinished;
    const problem = await checkPath(root, STORE_PARTS);
    if (problem) throw new Refusal(problem);
    const staff = staffDirOf(root);
    const dir = path.join(root, REPLICA_DIR);
    const temporary = path.join(staff, intent.temporary);
    let store = await kindAt(dir);
    const temp = await kindAt(temporary);
    if (store === 'other' || temp === 'other') throw unfinished;
    if (store === 'folder' && temp === 'folder') {
      let setAside = intent.setAside;
      if (setAside === null || (await kindAt(path.join(staff, setAside))) !== 'none') {
        const stamp = setAside === null ? stampOf((deps.now ?? (() => new Date()))()) : (SET_ASIDE_NAME.exec(setAside) as RegExpExecArray)[1];
        setAside = await freeAsideName(staff, stamp);
        intent = { ...intent, setAside };
        await writeIntent(root, intent);
        await syncFolder(staff);
      }
      await rename(dir, path.join(staff, setAside));
      await syncFolder(staff);
      store = 'none';
    }
    if (store === 'none') {
      const from = intent.source === STORE_NAME ? intent.setAside : intent.source;
      const source = from === null ? undefined : path.join(staff, from);
      await startAgainCheck.moveInChecked({ temporary, dir, staff, source, intent, completedIgnore: STORE_GITIGNORE, rebuild: async () => {
        if (!source || intent.writer !== own.writer || await kindAt(source) !== 'folder') throw unfinished;
        const readFrom = new ReplicaStore(root, source, deps, own);
        await readFrom.catchUp();
        await ReplicaStore.buildFrom(readFrom, temporary, true);
      } });
    } else if (intent.setAside !== null && (await kindAt(path.join(staff, intent.setAside))) !== 'folder') {
      // The store is there and the temporary is gone, yet the folder it was set aside to is not: this may still be the old store. Left alone.
      throw unfinished;
    }
    if (intent.writer === own.writer) {
      await withRegisterLock(dir, () => withFileLock(dir, REPLICA_LOCK_FILE, async () => {
        const fresh = new ReplicaStore(root, dir, deps, own);
        await fresh.catchUp();
        if (!(await fresh.markAccepts())) await fresh.writeOwnMark(null);
      }));
    }
    await rm(intentFile);
    await syncFolder(staff);
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

  /** The (stream, writer) files whose flooded line is held (D-14), in stream then writer order. Their later entries from outside are not written. */
  public flooded(): Array<{ stream: string; writer: string }> {
    return [...this.floodedFiles.values()].sort((a, b) => (a.stream !== b.stream ? (a.stream < b.stream ? -1 : 1) : a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0)).map((item) => ({ ...item }));
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
    if (await checkPath(this.root, [...this.parts, 'blobs'])) return undefined;
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

  public async appendSnapshot(): Promise<string> {
    const unreadable: UnreadableFile[] = [];
    const cells = (await this.listDir(['grants'], unreadable)).filter((cell) => STREAM_ID_PATTERN.test(cell));
    const grants = await Promise.all(cells.map(async (cell) => [cell, await this.listDir(['grants', cell], unreadable)]));
    const evidence = await this.listDir(['access-evidence'], unreadable);
    return sha256Hex(canonicalBytes([this.mark?.rosterHead ?? null, evidence,
      [...this.byHash.keys()].sort(), [...this.held.keys()].sort(), [...this.waiting.keys()].sort(), grants, unreadable.map(({ file }) => file).sort()]));
  }
  public async appendOwn(built: readonly BuiltEntry[], expectedSnapshot?: string, mayCommit?: () => boolean, stage?: unknown): Promise<AppendResult> {
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
        if ((expectedSnapshot !== undefined && await this.appendSnapshot() !== expectedSnapshot) || mayCommit?.() === false) return refusal('snapshot-changed');
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
        if (stage !== undefined) await this.writeAccessStage(stage);
        if (stage !== undefined && mayCommit?.() === false) return refusal('snapshot-changed');
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
  /** Check foreign entries and stage valid blobs. Bound waiting and held entries and defer flooded writers (D-14). */
  public async ingestForeign(entries: readonly unknown[], blobs: readonly SealedBlob[], check: ForeignCheck, expectedSnapshot?: string, mayCommit?: () => boolean, stage?: { root: string; evidence: readonly unknown[] }): Promise<IngestResult | StoreRefused> {
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
    // Checks run outside the locks and skip flooded writers. The lock defers an unchecked entry whose writer turns out to be eligible.
    const verdicts = new Map<string, Awaited<ReturnType<typeof runCheck>>>();
    const refusedHere = new Map<string, number>();
    for (const { entry, hash } of fresh) {
      if (entry.header.writer === this.own.writer) { verdicts.set(hash, { kind: 'pass' }); continue; }
      const id = fileId(entry.header.stream, entry.header.writer);
      const refused = refusedHere.get(id) ?? 0;
      if (this.floodedFiles.has(id) || (this.heldBy.get(id) ?? 0) + refused >= this.bounds().refusedPerWriter) continue;
      const verdict = await runCheck(check, entry);
      verdicts.set(hash, verdict);
      if (verdict.kind === 'held') refusedHere.set(id, refused + 1);
    }
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
        if ((expectedSnapshot !== undefined && await this.appendSnapshot() !== expectedSnapshot) || mayCommit?.() === false) return refusal('snapshot-changed');
        if (stage !== undefined && (expectedSnapshot === undefined || !fresh.some(({ entry, hash }) => hash === stage.root && verdicts.get(hash)?.kind === 'pass' &&
          !this.byHash.has(hash) && !this.floodedFiles.has(fileId(entry.header.stream, entry.header.writer))))) return refusal('snapshot-changed');
        const toWrite: typeof fresh = [];
        const held: IngestResult['held'] = [];
        const waiting: IngestResult['waiting'] = [];
        let flooded = 0;
        let deferred = 0;
        for (const item of fresh) {
          const { entry, hash } = item;
          // Another window may have stored it since the check ran: a duplicate now.
          if (this.byHash.has(hash)) { duplicates += 1; continue; }
          const id = fileId(entry.header.stream, entry.header.writer);
          if (this.floodedFiles.has(id)) { flooded += 1; continue; }
          const verdict = verdicts.get(hash);
          if (!verdict) { deferred += 1; continue; }
          if (verdict.kind === 'held') {
            const fate = this.refusedFate(id);
            if (fate === 'drop') { flooded += 1; continue; }
            const reason = fate === 'flood' ? FLOODED_REASON : verdict.reason;
            this.hold(hash, entry, reason);
            held.push({ hash, reason });
          }
          if (verdict.kind === 'wait') {
            if (this.waiting.size >= this.bounds().waiting) { deferred += 1; continue; }
            this.waiting.set(hash, verdict.reason);
            waiting.push({ hash, reason: verdict.reason });
          }
          toWrite.push(item);
        }
        for (const artifact of stage?.evidence ?? []) await this.writeAccessStage(artifact);
        if (stage !== undefined && mayCommit?.() === false) return refusal('snapshot-changed');
        let blobsAdded = 0;
        for (const [hash, wire] of goodBlobs) if (await this.putBlobBytes(hash, wire)) blobsAdded += 1;
        if (toWrite.length > 0) {
          await this.appendLines(toWrite.map(({ entry }) => entry));
          await this.writeOwnMark();
        }
        return { ok: true as const, added: toWrite.length, duplicates, held, waiting, dropped, blobsAdded, blobsRefused, flooded, deferred };
      });
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.reason);
      throw error;
    }
  }

  /** Retry waiting entries under the ingest limits (D-14), preserving outcomes already decided in another window. */
  public async recheck(check: ForeignCheck): Promise<RecheckResult | StoreRefused> {
    const verdicts = new Map<string, Awaited<ReturnType<typeof runCheck>>>();
    const refusedHere = new Map<string, number>();
    for (const hash of [...this.waiting.keys()]) {
      const id = this.fileOf(hash);
      if (id === undefined) continue;
      const refused = refusedHere.get(id) ?? 0;
      if (this.floodedFiles.has(id) || (this.heldBy.get(id) ?? 0) + refused >= this.bounds().refusedPerWriter) continue;
      const verdict = await runCheck(check, this.byHash.get(hash) as SealedEntry);
      verdicts.set(hash, verdict);
      if (verdict.kind === 'held') refusedHere.set(id, refused + 1);
    }
    try {
      return await this.locked(async () => {
        await this.catchUp();
        await this.syncMark();
        let passed = 0;
        let held = 0;
        let changed = false;
        for (const [hash, verdict] of verdicts) {
          const before = this.waiting.get(hash);
          const id = this.fileOf(hash);
          if (before === undefined || id === undefined || this.floodedFiles.has(id)) continue;
          if (verdict.kind === 'pass') { this.waiting.delete(hash); passed += 1; changed = true; }
          if (verdict.kind === 'held') {
            const fate = this.refusedFate(id);
            if (fate === 'drop') continue;
            this.waiting.delete(hash);
            this.hold(hash, this.byHash.get(hash) as SealedEntry, fate === 'flood' ? FLOODED_REASON : verdict.reason);
            held += 1;
            changed = true;
          }
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
    const problem = await checkPath(this.root, [...this.parts, ...parts]);
    if (problem) { unreadable.push({ file: parts.join('/'), reason: problem === 'symlink' ? 'it is a symbolic link' : 'it is not a folder the store made' }); return []; }
    try {
      return (await readdir(path.join(this.dir, ...parts))).filter((name) => !name.endsWith('.tmp')).sort();
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') unreadable.push({ file: parts.join('/'), reason: 'it could not be listed' });
      return [];
    }
  }
  public async putAccessEvidence(evidence: unknown, expectedSnapshot?: string, mayCommit?: () => boolean): Promise<{ ok: true; hash: string } | StoreRefused> {
    const bytes = canonicalBytes(evidence);
    if (bytes.length > (isManagedPacketStage(evidence) ? MANAGED_PACKET_STAGE_MAX_BYTES : BLOB_MAX_BYTES)) return refusal('blob-too-large');
    const hash = sha256Hex(bytes);
    return this.putSigned(['access-evidence'], `${hash}.json`, bytes, hash, expectedSnapshot === undefined ? undefined : async () => {
      await this.verifyAppendSnapshot(expectedSnapshot);
      if (mayCommit?.() === false) throw new Refusal('snapshot-changed');
      await this.writeAccessStage(evidence);
    });
  }
  /** The synthetic check never selects or persists the private candidate. */
  private async checkFrontierPreparation(request: FrontierPreparationRequest): Promise<boolean> {
    return await this.frontierPreparation(request, 'check') === 'ready';
  }

  /** Fixture-only preparation and prospective durability. Only an inert verdict leaves the checked scope. */
  private async frontierPreparation(request: FrontierPreparationRequest, mode: 'check' | 'capture' | 'reopen'): Promise<FrontierPreparationVerdict> {
    const signer = await this.deps.signer().catch(() => undefined);
    if (signer === undefined || signer.publicKey !== this.own.publicKey || !STREAM_ID_PATTERN.test(request.stream)) return 'refused';
    const result = await withFrontierPolicySource(request.policyStorage, this.deps.secrets, this.deps.now ?? (() => new Date()),
      (capture) => this.locked(async (): Promise<FrontierPreparationVerdict> => {
        await this.verifyAppendSnapshot(request.snapshot);
        const { grants } = await this.grants();
        const { pin, keys } = request;
        const policy = await capture();
        if (policy === undefined) return 'refused';
        const { source } = policy;
        const now = new Date(source.instant);
        const roster = foldRoster({ anchor: pin, entries: this.rosterEntries(), grants: grants.map(({ signed }) => signed), keys,
          blobs: () => undefined, now });
        const predecessor = roster.positions.at(-1);
        if (predecessor === undefined || predecessor !== this.mark?.rosterHead || !this.byHash.has(pin.genesisHash) ||
          roster.pending.length !== 0 || roster.requiredFrom.has(CELL_ACCESS_FEATURE)) return 'refused';
        const epoch = epochAt(roster.cells, pin.project, roster.positions.length - 1);
        const key = epoch === undefined ? undefined : keys(pin.project, epoch);
        const head = this.head(pin.project, this.own.writer);
        if (epoch === undefined || key === undefined || head === undefined ||
          this.files.get(fileId(pin.project, this.own.writer))?.bySeq.get(head.seq)?.length !== 1) return 'refused';
        const ctx = { roster: rosterView(roster), keys, blobs: () => undefined, now };
        const previous = verifyEntry(this.byHash.get(head.hash), ctx);
        if (previous.status !== 'verified' || previous.entry.keep !== undefined) return 'refused';
        const lamport = previous.entry.body.lamport + 1;
        const matches = (entry: unknown, requirement: string, instant: number) => {
          const checked = verifyEntry(entry, { ...ctx, now: new Date(instant) });
          if (checked.status !== 'verified' || checked.entry.keep !== undefined || checked.entry.hash !== requirement) return false;
          const { writer, stream, seq, prev, epoch: signedEpoch } = checked.entry.header;
          const { body, data } = checked.entry;
          return writer === this.own.writer && stream === pin.project && seq === head.seq + 1 && prev === head.hash && signedEpoch === epoch &&
            body.kind === 'roster.require' && body.actor.kind === 'person' && body.at === new Date(instant).toISOString() &&
            body.roster === predecessor && body.lamport === lamport && body.deps.length === 0 && isRecord(data) &&
            data.rosterPrev === predecessor && Array.isArray(data.features) && data.features.length === 1 && data.features[0] === CELL_ACCESS_FEATURE;
        };
        const current = async () => {
          if (!await policy.recheck()) return false;
          await this.verifyAppendSnapshot(request.snapshot);
          return this.mark?.rosterHead === predecessor;
        };
        const scope = this.frontierCaptureScope(request, predecessor);
        const slot = FRONTIER_POLICY_SLOT + scope;
        const reference = mode === 'check' ? undefined : await this.deps.secrets.get(slot);
        if (reference !== undefined) {
          const saved = await this.readFrontierPolicyCapture(scope, reference);
          if (saved === undefined) return 'refused';
          const historical = await reopenFrontierPolicy(saved.policy, source, request.policyStorage, this.deps.secrets);
          if (historical === undefined || !matches(saved.entry, saved.requirement, historical.instant)) return 'refused';
          const custody = frontierCustody(roster, request.stream, this.own.writer, keys, historical);
          if (custody === undefined || !canonicalBytes(custody).equals(canonicalBytes(saved.custody))) return 'refused';
          return await current() ? 'ready' : 'refused';
        }
        if (mode === 'reopen') return 'refused';
        const custody = frontierCustody(roster, request.stream, this.own.writer, keys, source);
        if (custody === undefined) return 'refused';

        const at = now.toISOString();
        const built = buildEntry({ signer, key, stream: pin.project, epoch, seq: head.seq + 1, prev: head.hash,
          body: { deps: [], roster: predecessor, lamport, at, actor: { kind: 'person' },
            kind: 'roster.require', data: { rosterPrev: predecessor, features: [CELL_ACCESS_FEATURE] } } });
        if (!matches(built.entry, built.hash, source.instant) || !await current()) return 'refused';
        if (mode === 'check') return 'ready';

        const bytes = canonicalBytes({ v: 1, scope, requirement: built.hash, entry: built.entry, custody, salt: randomBytes(32).toString('hex'),
          policy: { instant: source.instant, personalEnvelope: source.personalEnvelope, personalHistoryHead: source.personalHistoryHead,
            personalSigner: source.personalSigner, personalSignerStatus: source.personalSignerStatus,
            organizationEnvelope: source.organizationEnvelope, organizationPin: source.organizationPin } });
        const artifact = frontierFileHandle(scope, bytes);
        const directory = await ensureDir(this.dir, [FRONTIER_POLICY_DIR]);
        const file = `${artifact}.json`;
        await this.writeSigned([FRONTIER_POLICY_DIR], file, bytes, 0o600);
        await syncFolder(directory);
        await syncFolder(this.dir);
        const durable = await readFrontierFile(path.join(directory, file));
        if (durable === undefined || !durable.equals(bytes) || !await current() || await this.deps.secrets.get(slot) !== undefined) return 'refused';
        const expected = canonicalBytes({ v: 1, scope, requirement: built.hash, artifact }).toString('utf8');
        try {
          await this.deps.secrets.store(slot, expected);
        } catch {
          // An error from store does not prove that the protected write failed. Confirm its result without re-signing.
        }
        const back = await this.deps.secrets.get(slot);
        if (back === undefined) return 'unavailable';
        if (back !== expected || await this.readFrontierPolicyCapture(scope, back) === undefined || !await current()) return 'refused';
        return 'ready';
      }));
    return result ?? 'unavailable';
  }

  private frontierCaptureScope(request: FrontierPreparationRequest, predecessor: string): string {
    return sha256Hex(canonicalBytes(['private-frontier-policy-capture/1', this.dir, request.pin.project, request.pin.genesisHash,
      request.stream, this.own.writer, predecessor, request.snapshot]));
  }

  /** Test fixture only. The Boolean conveys no archive or write authority. */
  private checkFrontierV2Fixture(file: unknown, request: FrontierV2FixtureRequest): Promise<boolean> {
    return this.frontierV2Fixture(file, request);
  }

  /** Test fixture only. Checks immutable private bytes without making them selectable or returning their name. */
  private async stageFrontierV2Fixture(input: Buffer, request: FrontierV2FixtureRequest): Promise<boolean> {
    if (input.length > MAX_ACCEPTED_FRONTIER_BYTES) return false;
    const bytes = Buffer.from(input);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) return false;
    try {
      return await this.frontierV2Fixture(JSON.parse(text) as unknown, request, bytes);
    } catch {
      return false;
    }
  }

  private async frontierV2Fixture(file: unknown, request: FrontierV2FixtureRequest, stagedBytes?: Buffer): Promise<boolean> {
    if (!STREAM_ID_PATTERN.test(request.stream) || !HASH_PATTERN.test(request.snapshot)) return false;
    const result = await withFrontierPolicySource(request.policyStorage, this.deps.secrets, this.deps.now ?? (() => new Date()),
      (capture) => this.locked(async () => {
        const policy = await capture();
        if (policy === undefined) return false;
        const verifyBinding = async () => {
          await this.verifyAppendSnapshot(request.expectedSnapshot);
          const { pin, keys, stream } = request;
          const { grants } = await this.grants();
          const roster = foldRoster({ anchor: pin, entries: this.rosterEntries(), grants: grants.map(({ signed }) => signed),
            keys, blobs: () => undefined, now: new Date(policy.source.instant) });
          const head = roster.positions.at(-1);
          const fence = roster.requiredFrom.get(CELL_ACCESS_FEATURE);
          if (head === undefined || head !== this.mark?.rosterHead || fence === undefined || roster.pending.length !== 0) return undefined;
          const predecessor = roster.positions[fence - 1];
          const requirement = roster.positions[fence];
          const access = roster.accessRevision;
          const reader = deviceAt(roster.members, this.own.writer, roster.positions.length - 1);
          if (predecessor === undefined || requirement === undefined || access === undefined || reader?.publicKey !== this.own.publicKey ||
            ![pin.genesisHash, predecessor, requirement, access.entry, head].every((hash) =>
              this.byHash.get(hash)?.header.stream === pin.project && !this.held.has(hash) && !this.waiting.has(hash))) return undefined;

          const scope = this.frontierCaptureScope(request, predecessor);
          const slot = FRONTIER_POLICY_SLOT + scope;
          const reference = await this.deps.secrets.get(slot);
          if (reference === undefined) return undefined;
          const saved = await this.readFrontierPolicyCapture(scope, reference);
          if (saved === undefined || saved.requirement !== requirement ||
            !canonicalBytes(saved.entry).equals(canonicalBytes(this.byHash.get(requirement)))) return undefined;
          const historical = await reopenFrontierPolicy(saved.policy, policy.source, request.policyStorage, this.deps.secrets);
          if (historical === undefined) return undefined;
          const verified = verifyEntry(saved.entry, { roster: rosterView(roster), keys, blobs: () => undefined, now: new Date(historical.instant) });
          if (verified.status !== 'verified' || verified.entry.keep !== undefined || verified.entry.hash !== requirement ||
            verified.entry.header.writer !== this.own.writer || verified.entry.body.kind !== 'roster.require' ||
            verified.entry.body.actor.kind !== 'person' || verified.entry.body.roster !== predecessor ||
            verified.entry.body.at !== new Date(historical.instant).toISOString() ||
            !isRecord(verified.entry.data) || verified.entry.data.rosterPrev !== predecessor ||
            !Array.isArray(verified.entry.data.features) || verified.entry.data.features.length !== 1 ||
            verified.entry.data.features[0] !== CELL_ACCESS_FEATURE) return undefined;
          const custody = frontierCustody(roster, stream, this.own.writer, keys, historical, fence - 1);
          if (custody === undefined || !canonicalBytes(custody).equals(canonicalBytes(saved.custody))) return undefined;
          if (!checksFrontierV2Fixture(file, { roster, accessEntry: access.entry, pin: { project: pin.project, genesis: pin.genesisHash },
            opening: request.opening, historicalKey: keys, expectedStream: stream,
            capture: { digest: frontierV2CaptureCommitment(saved.salt, saved.hash), writer: this.own.writer, before: predecessor, requirement } })) return undefined;

          if (await this.deps.secrets.get(slot) !== reference) return undefined;
          await this.verifyAppendSnapshot(request.expectedSnapshot);
          if (this.mark?.rosterHead !== head || !await policy.recheck()) return undefined;

          const expectedHead = policy.source.personalHistoryHead;
          const history = await readKeyHistory(identityDir(request.policyStorage), this.deps.secrets);
          if (!history.ok || history.head?.hash !== expectedHead.hash || history.head.seq !== expectedHead.seq) return undefined;
          // The file-only store's signer is captured at open. Read the protected device again while ordered locks are held.
          const device = await loadDeviceIdentity(this.deps.secrets);
          if (device === undefined || device.publicKey !== reader.publicKey || writerIdOf(device.publicKey) !== this.own.writer ||
            history.lookup(device).state !== 'active') return undefined;

          return sha256Hex(canonicalBytes(['private-frontier-stage/2', this.dir, pin.project, pin.genesisHash, stream,
            this.own.writer, requirement, access.entry, access.root, request.expectedSnapshot, sha256Hex(Buffer.from(reference))]));
        };
        const binding = await verifyBinding();
        if (binding === undefined) return false;
        if (stagedBytes === undefined) return true;
        if (!await this.writeFrontierV2Stage(binding, stagedBytes)) return false;
        return await verifyBinding() === binding;
      }, 'existing'));
    return result === true;
  }

  private async writeFrontierV2Stage(binding: string, bytes: Buffer): Promise<boolean> {
    if (await checkPath(this.root, [...this.parts, FRONTIER_STAGE_DIR])) return false;
    const dir = path.join(this.dir, FRONTIER_STAGE_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    const uid = process.getuid?.();
    if (!info.isDirectory() || (uid !== undefined && (info.uid !== uid || (info.mode & 0o077) !== 0))) return false;

    const file = path.join(dir, `${frontierFileHandle(binding, bytes)}.json`);
    const existing = await readFrontierFile(file);
    if (existing === undefined) await writeAtomic(file, bytes, 0o600, undefined, 'exclusive');
    else if (!existing.equals(bytes)) return false;
    await syncFolder(dir);
    await syncFolder(this.dir);
    return await privateFileProblem(file) === undefined && (await readFrontierFile(file))?.equals(bytes) === true;
  }

  private async readFrontierPolicyCapture(scope: string, reference: string) {
    let pointer: unknown;
    try { pointer = JSON.parse(reference) as unknown; } catch { return undefined; }
    if (!isRecord(pointer) || Object.keys(pointer).length !== 4 || pointer.v !== 1 || pointer.scope !== scope ||
      typeof pointer.artifact !== 'string' || !HASH_PATTERN.test(pointer.artifact) ||
      typeof pointer.requirement !== 'string' || !HASH_PATTERN.test(pointer.requirement) ||
      canonicalBytes(pointer).toString('utf8') !== reference ||
      await checkPath(this.root, [...this.parts, FRONTIER_POLICY_DIR])) return undefined;
    const bytes = await readFrontierFile(path.join(this.dir, FRONTIER_POLICY_DIR, `${pointer.artifact}.json`));
    if (bytes === undefined || frontierFileHandle(scope, bytes) !== pointer.artifact) return undefined;
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(value) || Object.keys(value).length !== 7 || value.v !== 1 || value.scope !== scope ||
      value.requirement !== pointer.requirement || typeof value.salt !== 'string' || !HASH_PATTERN.test(value.salt) ||
      !canonicalBytes(value).equals(bytes)) return undefined;
    return { entry: value.entry, requirement: pointer.requirement, policy: value.policy, custody: value.custody,
      salt: value.salt, hash: sha256Hex(bytes) };
  }

  public managedHandoffs(project: string, writer: string, now: () => Date) {
    return openManagedHandoffs(this.dir, project, writer, now, {
      locked: (work) => this.locked(work), folder: () => ensureDir(this.dir, ['managed-handoffs']), writeAtomic
    }, (expected) => this.verifyAppendSnapshot(expected));
  }
  private async verifyAppendSnapshot(expected: string): Promise<void> {
    await this.catchUp();
    await this.syncMark();
    if (await this.appendSnapshot() !== expected) throw new Refusal('snapshot-changed');
  }
  public async accessEvidence(): Promise<Array<{ hash: string; value: unknown }>> {
    return readHashedArtifacts(path.join(this.dir, 'access-evidence'), await this.listDir(['access-evidence'], []), MANAGED_PACKET_STAGE_MAX_BYTES);
  }
  private readSigned(relative: string, matches: (value: unknown) => boolean, maxBytes = SIGNED_FILE_MAX_BYTES): Promise<{ value: unknown } | { reason: string }> {
    return readStoredArtifact(path.join(this.dir, relative), maxBytes, matches);
  }
  private async writeAccessStage(stage: unknown): Promise<void> {
    const bytes = canonicalBytes(stage);
    const limit = isManagedPacketStage(stage) ? MANAGED_PACKET_STAGE_MAX_BYTES : BLOB_MAX_BYTES;
    if (bytes.length > limit) throw new Refusal('blob-too-large');
    const hash = sha256Hex(bytes);
    const file = `${hash}.json`;
    await this.writeSigned(['access-evidence'], file, bytes, 0o600);
    const stored = await this.readSigned(`access-evidence/${file}`, (value) => sha256Hex(canonicalBytes(value)) === hash, limit);
    if (!('value' in stored)) throw new Refusal('unreadable');
    await syncFolder(path.join(this.dir, 'access-evidence'));
    await syncFolder(this.dir);
  }
  private async writeSigned(parts: readonly string[], name: string, bytes: Buffer, mode?: number): Promise<void> {
    const file = path.join(await ensureDir(this.dir, parts), name);
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Refusal('symlink');
      if (info.isFile()) return;
    } catch (error) {
      if (error instanceof Refusal) throw error;
      if (errorCode(error) !== 'ENOENT') throw new Refusal('unreadable');
    }
    await writeAtomic(file, bytes, mode);
  }

  private async putSigned(parts: readonly string[], name: string, bytes: Buffer, hash: string, write = () => this.writeSigned(parts, name, bytes)): Promise<{ ok: true; hash: string } | StoreRefused> {
    try {
      await this.locked(write);
      return { ok: true, hash };
    } catch (error) {
      if (error instanceof Refusal) return refusal(error.reason);
      throw error;
    }
  }

  // ---- inside the lock ----------------------------------------------------------------------------------------------------------------------

  /** Take non-reentrant Start Again, register and cross-window locks in order and require the live store (32 D-03). */
  private locked<T>(work: () => Promise<T>, mode: 'write' | 'existing' = 'write'): Promise<T> {
    return withStartAgainLock(this.root, async () => {
      if (await intentPresent(this.root)) {
        if (mode === 'existing') throw new Refusal('start-again-unfinished');
        await ReplicaStore.rollForward(this.root, this.deps, this.own);
      }
      return withRegisterLock(this.dir, async () => {
        const problem = await checkPath(this.root, this.parts);
        if (problem) throw new Refusal(problem);
        const missing = (await kindAt(this.dir)) === 'none';
        if (missing && (mode === 'existing' || await this.historyGone())) throw new Refusal('rolled-back');
        if (mode === 'write') await mkdir(this.dir, { recursive: true });
        return withFileLock(this.dir, REPLICA_LOCK_FILE, async () => {
          const again = await checkPath(this.root, this.parts);
          if (again) throw new Refusal(again);
          if (mode === 'write') await this.ensureIgnore();
          return work();
        });
      });
    }, mode === 'write');
  }

  /** Was there a shared history here that is gone: this device's mark for this store remains, or a folder beside it holds project.json? */
  private async historyGone(): Promise<boolean> {
    if (await sharedHistoryMissing(this.root)) return true;
    return (await readMark(this.deps.secrets, this.dir, await this.deps.keyStatus())).kind !== 'none';
  }

  /** What open would say of this store now, read without its locks (the caller holds them): undefined when it opens, else the refusal. */
  private async verdict(storeHere: boolean): Promise<StoreRefusal | undefined> {
    try {
      if (!storeHere) return (await this.historyGone()) ? 'rolled-back' : undefined;
      await this.catchUp();
      await this.syncMark();
      return undefined;
    } catch (error) {
      if (error instanceof Refusal) return error.reason;
      throw error;
    }
  }

  /** Does the store hold an entry of this device's own, with its valid signature? */
  private hasOwnEntry(): boolean {
    return [...this.files.values()].some((file) => file.writer === this.own.writer && file.hashes.size > 0);
  }

  /**
   * Are this device's own entries in this folder one unbroken chain in every stream (T-32-02): at least one entry, no line it did not sign, and seq 0
   * to the highest exactly once each, the first after GENESIS_PREV and each after the one before.
   */
  private ownChainVerifies(): boolean {
    const files = [...this.files.values()].filter((file) => file.writer === this.own.writer && (file.hashes.size > 0 || file.damaged > 0));
    if (files.length === 0) return false;
    for (const file of files) {
      if (file.damaged > 0 || file.hashes.size !== file.maxSeq + 1) return false;
      let prev = GENESIS_PREV;
      for (let seq = 0; seq <= file.maxSeq; seq += 1) {
        const at = file.bySeq.get(seq) ?? [];
        if (at.length !== 1 || this.byHash.get(at[0])?.header.prev !== prev) return false;
        prev = at[0];
      }
    }
    return true;
  }

  /** Does this device's mark already accept the store as read (so a second recovery does not write it again)? */
  private async markAccepts(): Promise<boolean> {
    await this.checkMarkLists();
    const read = await readMark(this.deps.secrets, this.dir, await this.deps.keyStatus());
    if (read.kind !== 'mark' || !compareWithMark(read.mark, this.fileStates()).ok) return false;
    return !read.mark.rosterHead || this.byHash.has(read.mark.rosterHead);
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

  /** The bounds on refused and waiting entries (D-14): the constants, or the smaller test-only limits in the deps. */
  private bounds(): { refusedPerWriter: number; heldPerStore: number; waiting: number } {
    const bound = (value: number | undefined, most: number): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= most ? value : most);
    const limits = this.deps.limits ?? {};
    return {
      refusedPerWriter: bound(limits.refusedPerWriter, MAX_REFUSED_PER_WRITER),
      heldPerStore: bound(limits.heldPerStore, MAX_MARK_LISTED),
      waiting: bound(limits.waiting, MAX_MARK_WAITING)
    };
  }

  /**
   * What becomes of one more refused entry of the file `id`: held; held as the file's flooded line when it is the last the writer's bound or the held
   * list allows; or not kept when the held list is full.
   */
  private refusedFate(id: string): 'hold' | 'flood' | 'drop' {
    const { refusedPerWriter, heldPerStore } = this.bounds();
    if (this.heldCount >= heldPerStore) return 'drop';
    return (this.heldBy.get(id) ?? 0) >= refusedPerWriter - 1 || this.heldCount >= heldPerStore - 1 ? 'flood' : 'hold';
  }

  /** The (stream, writer) file of a stored entry. */
  private fileOf(hash: string): string | undefined {
    const entry = this.byHash.get(hash);
    return entry ? fileId(entry.header.stream, entry.header.writer) : undefined;
  }

  /** Holds one entry with its reason and counts it for its file; FLOODED_REASON floods the file. */
  private hold(hash: string, entry: SealedEntry, reason: string): void {
    if (this.held.has(hash)) return;
    this.held.set(hash, reason);
    const { stream, writer } = entry.header;
    const id = fileId(stream, writer);
    this.heldBy.set(id, (this.heldBy.get(id) ?? 0) + 1);
    this.heldCount += 1;
    if (reason === FLOODED_REASON) this.floodedFiles.set(id, { stream, writer });
  }

  /** Counts the held entries again from `held`, stored entries only: per file, in all, and the files whose flooded line is held. */
  private indexHeld(): void {
    this.heldBy.clear();
    this.floodedFiles.clear();
    this.heldCount = 0;
    for (const [hash, reason] of this.held) {
      const entry = this.byHash.get(hash);
      if (!entry) continue;
      const { stream, writer } = entry.header;
      const id = fileId(stream, writer);
      this.heldBy.set(id, (this.heldBy.get(id) ?? 0) + 1);
      this.heldCount += 1;
      if (reason === FLOODED_REASON) this.floodedFiles.set(id, { stream, writer });
    }
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
   * does not. An invalid mark is refused as mark-unverified; an otherwise valid mark with missing lists is refused as rolled-back.
   */
  private async syncMark(): Promise<void> {
    try {
      await this.syncMarkLists();
    } finally {
      // The held counts follow every change of the held list or of the stored entries, whatever the mark said (D-14).
      this.indexHeld();
    }
  }

  private async syncMarkLists(): Promise<void> {
    await this.checkMarkLists();
    const read = await readMark(this.deps.secrets, this.dir, await this.deps.keyStatus());
    if (read.kind === 'unverified') throw new Refusal('mark-unverified');
    if (read.kind === 'lists-missing') throw new Refusal('rolled-back');
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
    await this.checkMarkLists();
    const text = await writeMark(this.deps.secrets, this.dir, await this.deps.signer(), mark, this.deps.now ?? (() => new Date()));
    this.mark = mark;
    this.markText = text;
  }

  /** Refuses a symbolic link (or anything that is not a folder) on the way to this device's lists folder, like every other store path. */
  private async checkMarkLists(): Promise<void> {
    const problem = await checkPath(this.root, [...this.parts, MARK_LISTS_DIR, this.own.writer]);
    if (problem) throw new Refusal(problem);
  }
}


/** Finishes a Start Again left unfinished in the project at `root` (see ReplicaStore.finishStartAgain). */
export function finishStartAgain(root: string, deps: ReplicaStoreDeps): Promise<{ ok: true } | StoreRefused> {
  return ReplicaStore.finishStartAgain(root, deps);
}
