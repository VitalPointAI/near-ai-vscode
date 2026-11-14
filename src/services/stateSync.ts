// Sync of the project's state through the project's own remote (SYNC-05, D-01, D-02, D-09). A sync is: fetch, verify everything the remote holds (manifest,
// index, every object not read before, the sequence number), merge per record with the plan-02 rules, apply to the state home, then build and push one new
// hot object, a new index and a new manifest on top of the remote tip. A push that loses a race fetches, merges and tries again (never forced). Nothing
// local is changed when verification fails. The transport owns the mirror lock; this module never holds it around a transport call. No vscode.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { StateRefusedError, aadFor, deriveKek, open as openSealed, seal, subKey, unwrapDataKey, type KdfRecord, type SealedBlob } from '../domain/state/keys';
import {
  OBJECT_NAME, openManifest, openObject, readManifestHeader, sealObject, buildManifest,
  type ManifestHeader, type ObjectEntry, type OpenPart, type SealedPart
} from '../domain/state/objects';
import { compareRecords, slotKind } from '../domain/state/merge';
import { canonicalJson, parseRecord, type StateRecord } from '../domain/state/records';
import { threadLines, threadTip, unionEntries, type ThreadEntry } from '../domain/state/threadEntries';
import type { RunMarker, RunState } from './runMarkers';
import { rm } from 'node:fs/promises';
import { ProjectStateHome, writeFileAtomic } from './stateHome';
import type { RecoveryWrap, StateKeys } from './stateKeys';
import { StateBusyError, withStateLock } from './stateLocks';
import { MirrorBusyError, type MirrorLockOptions } from './stateMirrorLock';
import {
  THREAD_ID, applyMerged, collectLocal, foldHeads, headMapOf, isSyncedRecord, mergeAll, parsePortableMeta, recordKey, withoutBody,
  type ColdParts, type HotPayload, type IndexPayload, type IndexThread, type LocalSnapshot, type PortableMeta, type ProfileSource, type SecretSource
} from './stateRecords';
import type { StateFile, StateFileRef, StateTransport, SyncFailure } from './stateTransport';
import { bundleOf, installArchive, writeArchive, type ArchiveBundle } from './threadArchive';
import { mergeMeta, validEntry, type ColdFetchResult, type ThreadStore } from './threadStore';

/** A push that loses a race fetches, merges and tries again this many times before giving up until the next sync. */
export const MAX_PUSH_ATTEMPTS = 5;
/** More hot objects than this on the remote after a push, and the push replaces them all with one (SYNC-05). */
export const HOT_CONSOLIDATE_COUNT = 20;
/** The other consolidation rule (hot objects bigger than twice what they hold now) only counts once the hot objects add up to this much, so the 64 KiB floor of tiny objects never trips it. */
export const HOT_CONSOLIDATE_FLOOR_BYTES = 2 * 1024 * 1024;
/** Plain-words warning from this much synced ciphertext (research flag 7). */
export const SYNC_WARN_BYTES = 500 * 1024 * 1024;
/** From this much, no new cold object is added (nothing is ever deleted): research flag 7. */
export const SYNC_COLD_STOP_BYTES = 1024 * 1024 * 1024;
/** The manifest lists at most this many objects when a push adds cold ones: its own size limit (1 MiB) binds near 5 000 entries, so there is wide margin. */
export const MAX_LISTED_OBJECTS = 3500;
const RETRY_MIN_MS = 200;
const RETRY_SPAN_MS = 1800;
const STATE_FILE = 'state.json';

export type SyncKind = 'synced' | 'nothing-yet' | 'refused' | 'waiting' | 'failed';
export interface SyncOutcome {
  kind: SyncKind;
  /** One plain sentence for the person. */
  message: string;
  /** Present when kind is 'failed': what went wrong with the remote, for the status line and backoff. */
  failure?: SyncFailure;
  /** Whether this sync pushed a new commit. */
  pushed?: boolean;
  /** The archived threads that were not sent because the synced state is full (the message says so); they stay on this computer, and nothing is deleted. */
  stayLocal?: string[];
  /** How much synced ciphertext the manifest lists, as measured for the limits. */
  syncedBytes?: number;
  /** How many pushes were tried. */
  attempts?: number;
}

const MESSAGES = {
  synced: 'Your project is up to date everywhere it is shared.',
  nothingYet: 'There is nothing saved online for this project yet.',
  waiting: 'A chat is running or another window is syncing, so sync will wait.',
  locked: "This project's chats are locked on this computer. Enter the recovery code to open them.",
  noRecoveryCode: 'Project sync has no recovery code on this computer yet, so nothing was sent.',
  contended: 'Other computers kept saving at the same moment. Sync will try again shortly.',
  unlocked: "This project's chats were opened with the recovery code.",
  overWarning: 'Synced project state is over 500 MB.'
} as const;

/** The plain sentence for archived conversations that cannot go up: how many, and that nothing was deleted. */
function stayLocalText(count: number, reason: 'bytes' | 'objects'): string {
  const subject = count === 1 ? '1 older conversation stays' : `${count} older conversations stay`;
  const cause = reason === 'bytes' ? 'Synced project state has reached 1 GiB' : 'Synced project state holds as many saved parts as it can';
  return `${cause}, so ${subject} on this computer only. Nothing was deleted.`;
}

export interface StateSyncOptions {
  /** The project folder. */
  root: string;
  home: ProjectStateHome;
  keys: StateKeys;
  threads: ThreadStore;
  transport: StateTransport;
  /** The remote this sync is for (the transport was built with it); kept for display. */
  remote?: string;
  /** This editor's writer id. */
  writer: string;
  /** Whether no run is in flight in this editor. Sync waits while this is false. */
  isIdle?: () => boolean;
  profileSource?: ProfileSource;
  secretSource?: SecretSource;
  /** Where a run marker stands as this editor sees it (RunMarkers.runState). Only finished and cut-off runs sync; without it only finished ones do. */
  runState?: (marker: RunMarker) => RunState;
  applyProfiles?: (records: StateRecord[]) => Promise<void>;
  /** Test seam: what the synced ciphertext counts as, given the bytes the manifest lists (to try the size limits without writing a gigabyte). */
  measure?: (listedBytes: number) => number;
  /** Test seam: a lower limit than MAX_LISTED_OBJECTS on how many objects the manifest lists. */
  maxListedObjects?: number;
  /** Test seam: shapes the consolidated hot payload before it is checked against the objects it replaces (a fault injection). */
  shapeConsolidated?: (payload: HotPayload) => HotPayload;
  /** Test seams for the retry wait. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Test seam: the wait limits and sleep of the cross-process sync lock (a short wait to see 'waiting' without waiting two minutes). */
  lockTimings?: Partial<MirrorLockOptions>;
  /** False for a sync that only opens the remote once (a throwaway mirror): it must not become the thread store's way of fetching archived threads. Default true. */
  registerColdFetcher?: boolean;
}

/** What opening the remote with a recovery code gives: the project's id and data key and the wrap that opened it. Nothing is written by getting it. */
export type RemoteOpening = { ok: true; stateId: string; dataKey: Buffer; wrap: { kdf: KdfRecord; wrappedKey: SealedBlob } } | { ok: false; outcome: SyncOutcome };

interface SyncState {
  version: 1;
  lastSeenSeq: number;
  /** The first file name of every hot or cold object whose content is already merged here. */
  readObjects: string[];
  /** The entry ids the remote is known to hold, by thread. */
  pushed: Record<string, string[]>;
  /** What the remote holds for each record, without bodies: a record whose (kind, id, rev) is here is not sent again. */
  heads: StateRecord[];
  /** The entry ids of each thread that the remote's cold objects hold (pushed from here or fetched here), so a consolidated hot object need not carry them again. */
  cold: Record<string, string[]>;
  /** A new recovery code was made here and its wrap has not been pushed yet: the next push carries it, even with nothing else to send. */
  wrapPending?: boolean;
}

function freshState(): SyncState {
  return { version: 1, lastSeenSeq: 0, readObjects: [], pushed: {}, heads: [], cold: {} };
}

/** A short, stable name for a recovery wrap, so two computers can say whether they mean the same one. */
export function wrapIdOf(wrap: RecoveryWrap): string {
  return createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify({ kdf: wrap.kdf, wrappedKey: wrap.wrappedKey }))), 'utf8').digest('hex').slice(0, 16);
}

function parseState(text: string): SyncState {
  try {
    const value = JSON.parse(text) as Partial<SyncState> | null;
    if (!value || typeof value !== 'object' || value.version !== 1 || typeof value.lastSeenSeq !== 'number' || !Number.isSafeInteger(value.lastSeenSeq) || value.lastSeenSeq < 0) return freshState();
    const pushed: Record<string, string[]> = {};
    if (value.pushed && typeof value.pushed === 'object') {
      for (const [id, ids] of Object.entries(value.pushed)) if (THREAD_ID.test(id) && Array.isArray(ids)) pushed[id] = ids.filter((item): item is string => typeof item === 'string');
    }
    const heads = Array.isArray(value.heads) ? value.heads.map((item) => parseRecord(item)).filter((record): record is StateRecord => record !== undefined) : [];
    const cold: Record<string, string[]> = {};
    if (value.cold && typeof value.cold === 'object') {
      for (const [id, ids] of Object.entries(value.cold)) if (THREAD_ID.test(id) && Array.isArray(ids)) cold[id] = ids.filter((item): item is string => typeof item === 'string');
    }
    return {
      version: 1, lastSeenSeq: value.lastSeenSeq,
      readObjects: Array.isArray(value.readObjects) ? value.readObjects.filter((item): item is string => typeof item === 'string') : [],
      pushed, heads, cold, ...(value.wrapPending === true ? { wrapPending: true } : {})
    };
  } catch {
    return freshState();
  }
}

function isBusy(error: unknown): boolean {
  return error instanceof StateBusyError || error instanceof MirrorBusyError;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The parts of a manifest's object list that make up each object, in order. */
function groupObjects(entries: readonly ObjectEntry[]): ObjectEntry[][] {
  const groups: ObjectEntry[][] = [];
  let at = 0;
  while (at < entries.length) {
    const first = entries[at] as ObjectEntry;
    if (first.part !== 0) throw new StateRefusedError('tampered');
    const group = entries.slice(at, at + first.of);
    if (group.length !== first.of) throw new StateRefusedError('tampered');
    group.forEach((entry, index) => { if (entry.part !== index || entry.of !== first.of || entry.class !== first.class) throw new StateRefusedError('tampered'); });
    groups.push(group);
    at += first.of;
  }
  return groups;
}

function parseHot(value: unknown): { entries: Record<string, ThreadEntry[]>; records: StateRecord[] } {
  if (!isObject(value) || value.v !== 1 || !isObject(value.entries) || !Array.isArray(value.records)) throw new StateRefusedError('tampered');
  const entries: Record<string, ThreadEntry[]> = {};
  for (const [id, list] of Object.entries(value.entries)) {
    if (!THREAD_ID.test(id) || !Array.isArray(list)) continue;
    entries[id] = list.map((item) => validEntry(item, id)).filter((entry): entry is ThreadEntry => entry !== undefined);
  }
  const records = value.records.map((item) => parseRecord(item)).filter((record): record is StateRecord => record !== undefined && isSyncedRecord(record));
  return { entries, records };
}

function parseIndex(value: unknown): IndexPayload {
  if (!isObject(value) || value.v !== 1 || !isObject(value.threads)) throw new StateRefusedError('tampered');
  const threads: IndexPayload['threads'] = {};
  for (const [id, item] of Object.entries(value.threads)) {
    if (!THREAD_ID.test(id) || !isObject(item)) continue;
    const meta = parsePortableMeta(item.meta, id);
    if (!meta || typeof item.entries !== 'number' || !Number.isSafeInteger(item.entries) || item.entries < 0 || typeof item.tip !== 'string' || !Array.isArray(item.files)) continue;
    const thread: IndexThread = { meta, entries: item.entries, tip: item.tip, files: item.files.filter((file): file is string => typeof file === 'string') };
    // Cold part names are only ever compared with the sealed manifest's own list, so a name that is not an object name can never match anything.
    const cold = Array.isArray(item.cold) ? item.cold.filter((file): file is string => typeof file === 'string' && OBJECT_NAME.test(file)) : [];
    if (cold.length) thread.cold = cold;
    if (typeof item.coldEntries === 'number' && Number.isSafeInteger(item.coldEntries) && item.coldEntries >= 0) thread.coldEntries = item.coldEntries;
    if (typeof item.turns === 'number' && Number.isSafeInteger(item.turns) && item.turns >= 0) thread.turns = item.turns;
    threads[id] = thread;
  }
  const wrapId = typeof value.wrapId === 'string' && /^[0-9a-f]{16}$/.test(value.wrapId) ? value.wrapId : undefined;
  return { v: 1, threads, ...(wrapId ? { wrapId } : {}) };
}

interface RemoteBundle {
  tip: string;
  seq: number;
  header: ManifestHeader;
  objects: ObjectEntry[];
  indexFile: string | null;
  tree: Map<string, string>;
  /** The first file names of the objects read this time. */
  newObjects: string[];
  entries: Record<string, ThreadEntry[]>;
  records: StateRecord[];
  index: IndexPayload;
}

/**
 * The one owner of sync bookkeeping (sync/state.json) for a project folder on this computer (REVIEW MAJOR stateSync.ts:226). Every StateSync built for
 * the folder, whoever built it (the scheduler, a command, a flow), runs through the same in-process queue and holds the cross-process lock
 * .near-ai/locks/sync.lock from reading sync/state.json to writing it back, so two windows or two editors never interleave a sync. Order rule from
 * stateLocks.ts: a holder of 'sync' may take 'meta', never the reverse; nothing run here takes 'sync' again.
 */
export class SyncOwner {
  private queued: Promise<unknown> = Promise.resolve();

  public constructor(public readonly root: string) {}

  /**
   * Runs `work` after the work queued before it, while holding the sync lock. Work started from inside a run of this owner (an archived thread opened
   * during a merge) runs at once: waiting for the run it is part of would never end. `lock: false` is for work that never reads or writes
   * sync/state.json (opening the remote with a code, asking what it holds): it keeps its place in the queue but takes no lock file, so a wrong
   * code still creates nothing in the project folder.
   */
  public run<T>(work: () => Promise<T>, timings?: Partial<MirrorLockOptions>, lock = true): Promise<T> {
    if (insideRun.getStore() === this) return work();
    const held = (): Promise<T> => insideRun.run(this, work);
    const inside = lock ? (): Promise<T> => withStateLock(this.root, 'sync', held, timings ?? {}) : held;
    const result = this.queued.then(inside, inside);
    this.queued = result.catch(() => undefined);
    return result;
  }
}

const insideRun = new AsyncLocalStorage<SyncOwner>();
const owners = new Map<string, SyncOwner>();

/** The sync owner of the project folder at `root`: one per resolved folder in this process. */
export function syncOwnerFor(root: string): SyncOwner {
  const resolved = path.resolve(root);
  let owner = owners.get(resolved);
  if (!owner) { owner = new SyncOwner(resolved); owners.set(resolved, owner); }
  return owner;
}

export class StateSync {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  public constructor(private readonly options: StateSyncOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    // A thread kept only online is fetched through this sync when someone opens it.
    if (options.registerColdFetcher !== false) options.threads.setColdFetcher((id) => this.fetchColdThread(id));
  }

  /** Pull, merge, apply, then push what the remote lacks. */
  public sync(): Promise<SyncOutcome> {
    return this.enqueue(() => this.run('sync'));
  }

  /** Pull, merge and apply only. Never pushes. */
  public pullOnly(): Promise<SyncOutcome> {
    return this.enqueue(() => this.run('pull'));
  }

  /**
   * Opens the project's chats on a computer that has none yet, with the recovery code: the remote's manifest header is read, the code unwraps the data
   * key, and only then is the state home made (with the remote's id) and the key kept. A wrong code creates nothing.
   */
  public unlockFromRemote(codeBytes: Buffer): Promise<SyncOutcome> {
    return this.enqueue(() => this.guard(async () => {
      const opened = await this.openRemoteNow(codeBytes);
      if (!opened.ok) return opened.outcome;
      try {
        await this.options.keys.adoptDataKey(opened.dataKey, opened.stateId);
      } catch (error) {
        return { kind: 'refused', message: error instanceof Error ? error.message : MESSAGES.locked };
      }
      await this.options.keys.storeRecoveryWrap(opened.wrap);
      return { kind: 'synced', message: MESSAGES.unlocked };
    }), false);
  }

  /**
   * Opens the remote with the recovery code without keeping anything: the manifest header is read, the code unwraps the data key, and the sealed manifest
   * is checked with it. The caller decides what to do with the id and key (a computer with nothing adopts them; one with chats of its own joins first).
   * A wrong code, or any damage, is a plain refusal and writes nothing.
   */
  public async openRemote(codeBytes: Buffer): Promise<RemoteOpening> {
    let opening: RemoteOpening | undefined;
    const outcome = await this.enqueue(() => this.guard(async () => {
      opening = await this.openRemoteNow(codeBytes);
      return opening.ok ? { kind: 'synced', message: MESSAGES.unlocked } : opening.outcome;
    }), false);
    return opening ?? { ok: false, outcome };
  }

  /**
   * Whether the remote already holds synced state, and for which project (the id in the manifest's header, readable without any key). Changes nothing.
   * Used before sync is turned on, so a project whose chats are already online is not given a second, separate copy.
   */
  public async remoteState(): Promise<{ ok: true; stateId?: string } | { ok: false; outcome: SyncOutcome }> {
    let found: { ok: true; stateId?: string } | { ok: false; outcome: SyncOutcome } | undefined;
    const outcome = await this.enqueue(() => this.guard(async () => {
      const fetched = await this.options.transport.fetch();
      if (!fetched.ok) { found = { ok: false, outcome: { kind: 'failed', message: fetched.failure.message, failure: fetched.failure } }; return found.outcome; }
      if (!fetched.value) { found = { ok: true }; return { kind: 'nothing-yet', message: MESSAGES.nothingYet }; }
      found = { ok: true, stateId: readManifestHeader(await this.readManifestText(fetched.value)).stateId };
      return { kind: 'synced', message: '' };
    }), false);
    return found ?? { ok: false, outcome };
  }

  private async openRemoteNow(codeBytes: Buffer): Promise<RemoteOpening> {
    const fetched = await this.options.transport.fetch();
    if (!fetched.ok) return { ok: false, outcome: { kind: 'failed', message: fetched.failure.message, failure: fetched.failure } };
    if (!fetched.value) return { ok: false, outcome: { kind: 'nothing-yet', message: MESSAGES.nothingYet } };
    const text = await this.readManifestText(fetched.value);
    const header = readManifestHeader(text);
    if (codeBytes.length !== 32) throw new StateRefusedError('wrong-code-or-damaged');
    const kek = await deriveKek(codeBytes, Buffer.from(header.kdf.salt, 'base64'), header.kdf);
    const dataKey = unwrapDataKey(kek, header.wrappedKey, header.stateId);
    openManifest(text, dataKey, 0);
    return { ok: true, stateId: header.stateId, dataKey, wrap: { kdf: header.kdf, wrappedKey: header.wrappedKey } };
  }

  // ---- plumbing ---------------------------------------------------------------------------------------------------------------------

  /** Runs the work as the project folder's sync owner: after what is queued, holding the sync lock. A lock that could not be had in time is 'waiting', and nothing was done. */
  private async enqueue(work: () => Promise<SyncOutcome>, lock = true): Promise<SyncOutcome> {
    try {
      return await syncOwnerFor(this.options.root).run(work, this.options.lockTimings, lock);
    } catch (error) {
      if (isBusy(error)) return { kind: 'waiting', message: MESSAGES.waiting };
      throw error;
    }
  }

  private async guard(work: () => Promise<SyncOutcome>): Promise<SyncOutcome> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StateRefusedError) return { kind: 'refused', message: error.message };
      if (isBusy(error)) return { kind: 'waiting', message: MESSAGES.waiting };
      throw error;
    }
  }

  private statePath(): string {
    return path.join(this.options.home.paths.sync, STATE_FILE);
  }

  private async readState(): Promise<SyncState> {
    return parseState(await readFile(this.statePath(), 'utf8').catch(() => ''));
  }

  private async writeState(state: SyncState): Promise<void> {
    await this.options.home.ensureFolder(this.options.home.paths.sync);
    await writeFileAtomic(this.statePath(), `${JSON.stringify(state)}\n`);
  }

  private async readManifestText(tip: string): Promise<string> {
    const tree = await this.options.transport.readTree(tip);
    const manifest = tree.find((entry) => entry.name === 'manifest.json');
    if (!manifest) throw new StateRefusedError('missing-object');
    return (await this.options.transport.readBlob(manifest.oid)).toString('utf8');
  }

  // ---- reading and checking the remote ----------------------------------------------------------------------------------------------

  /**
   * Reads and verifies everything the remote tip holds that this computer has not merged: the manifest (sealed, not older than one already seen), the
   * index, and each object not read before. Nothing is applied here; a refusal leaves the state home as it was.
   */
  private async loadRemote(tip: string, dataKey: Buffer, stateId: string, state: SyncState): Promise<RemoteBundle> {
    const { transport } = this.options;
    const treeEntries = await transport.readTree(tip);
    const tree = new Map(treeEntries.map((entry) => [entry.name, entry.oid]));
    const manifestOid = tree.get('manifest.json');
    if (!manifestOid) throw new StateRefusedError('missing-object');
    const text = (await transport.readBlob(manifestOid)).toString('utf8');
    const manifest = openManifest(text, dataKey, state.lastSeenSeq);
    // A bundle sealed for another project cannot be told from this one by its key alone (a holder of the key can seal under any id): the id must be ours.
    if (manifest.header.stateId !== stateId) throw new StateRefusedError('tampered');
    for (const entry of manifest.objects) if (!tree.has(entry.file)) throw new StateRefusedError('missing-object');
    const read = new Set(state.readObjects);
    const entries: Record<string, ThreadEntry[]> = {};
    const records: StateRecord[] = [];
    const newObjects: string[] = [];
    let index: IndexPayload = { v: 1, threads: {} };
    for (const group of groupObjects(manifest.objects)) {
      const first = group[0] as ObjectEntry;
      const isIndex = group.some((entry) => entry.file === manifest.indexFile);
      // A cold object is one archived thread, kept whole: it is read only when that thread is opened (fetchColdThread), never by a sync.
      if (!isIndex && (first.class === 'cold' || read.has(first.file))) continue;
      const parts: OpenPart[] = [];
      for (const entry of group) parts.push({ entry, data: await transport.readBlob(tree.get(entry.file) as string) });
      const payload = openObject(dataKey, stateId, first.class, parts);
      if (isIndex) { index = parseIndex(payload); continue; }
      const hot = parseHot(payload);
      for (const [id, list] of Object.entries(hot.entries)) entries[id] = unionEntries(entries[id] ?? [], list);
      records.push(...hot.records);
      newObjects.push(first.file);
    }
    // The authentic index says how many entries each thread has on the remote. A computer that does not hold that many after reading every listed
    // object is looking at a bundle with parts missing, so nothing is applied.
    const held = (id: string): number => new Set([...(state.pushed[id] ?? []), ...(entries[id] ?? []).map((entry) => entry.id)]).size;
    for (const [id, item] of Object.entries(index.threads)) if (item.entries - (item.coldEntries ?? 0) > held(id)) throw new StateRefusedError('missing-object');
    return { tip, seq: manifest.seq, header: manifest.header, objects: manifest.objects, indexFile: manifest.indexFile, tree, newObjects, entries, records, index };
  }

  // ---- the sync itself --------------------------------------------------------------------------------------------------------------

  private async run(mode: 'sync' | 'pull'): Promise<SyncOutcome> {
    if (this.options.isIdle && !this.options.isIdle()) return { kind: 'waiting', message: MESSAGES.waiting };
    return this.guard(() => this.attempts(mode));
  }

  private async attempts(mode: 'sync' | 'pull'): Promise<SyncOutcome> {
    const { transport, home, keys, threads } = this.options;
    const state = await this.readState();
    let tries = 0;
    for (;;) {
      const fetched = await transport.fetch();
      if (!fetched.ok) return { kind: 'failed', message: fetched.failure.message, failure: fetched.failure, attempts: tries };
      const tip = fetched.value;
      let dataKey = await keys.dataKey();
      let meta = await home.readMeta();
      if (!dataKey || !meta) {
        // A computer with no key of its own never makes one when the remote already holds this project's state: it must be unlocked with the code.
        if (tip) return { kind: 'refused', message: MESSAGES.locked, attempts: tries };
        if (mode === 'pull') return { kind: 'nothing-yet', message: MESSAGES.nothingYet };
        dataKey = await keys.ensureDataKey();
        meta = await home.readMeta();
        if (!meta) return { kind: 'refused', message: MESSAGES.locked, attempts: tries };
      }
      if (!tip && mode === 'pull') return { kind: 'nothing-yet', message: MESSAGES.nothingYet };

      // Everything is read and verified before the first local write.
      const remote = tip ? await this.loadRemote(tip, dataKey, meta.stateId, state) : undefined;
      const local = await collectLocal(home, threads, this.collectOptions(state));
      const incoming = remote?.records ?? [];
      const merged = mergeAll(local.records, incoming);
      const localKeys = new Set(local.records.map(recordKey));
      const toApply = merged.filter((record) => !localKeys.has(recordKey(record)));
      await applyMerged(home, threads, { entries: remote?.entries ?? {}, records: toApply, cold: coldListed(remote) }, local, this.options.runState ? { runState: this.options.runState } : {});
      await this.handleProfiles(toApply, dataKey, meta.stateId);

      if (remote) this.learnRemote(state, remote);
      await this.writeState(state);
      if (mode === 'pull') return { kind: 'synced', message: MESSAGES.synced, pushed: false, attempts: tries };

      const send = this.whatRemoteLacks(local, merged, remote, state);
      const chosen = await this.chooseWrap(remote, state);
      if (remote && !send.hasNew && !chosen.mustPush) {
        if (chosen.settled) { delete state.wrapPending; await this.writeState(state); }
        return { kind: 'synced', ...this.withSizeNotes(this.measured(listedBytes(remote?.objects ?? [])), send), pushed: false, attempts: tries };
      }
      const wrap = chosen.wrap;
      if (!wrap) return { kind: 'refused', message: MESSAGES.noRecoveryCode, attempts: tries };
      const built = await this.buildCommit({ dataKey, stateId: meta.stateId, wrap, remote, state, local, merged, send });
      tries += 1;
      const pushed = await transport.push(built.commit);
      if (pushed.ok) {
        this.learnPush(state, built);
        if (chosen.pushesLocal || chosen.settled) delete state.wrapPending;
        await this.writeState(state);
        return { kind: 'synced', ...this.withSizeNotes(this.measured(listedBytes(built.objects)), send), pushed: true, attempts: tries };
      }
      if (pushed.failure.kind !== 'rejected') return { kind: 'failed', message: pushed.failure.message, failure: pushed.failure, attempts: tries };
      if (tries >= MAX_PUSH_ATTEMPTS) return { kind: 'failed', message: MESSAGES.contended, failure: pushed.failure, attempts: tries };
      await this.sleep(RETRY_MIN_MS + Math.floor(this.random() * RETRY_SPAN_MS));
    }
  }

  /**
   * Which recovery wrap the next push carries (D-02). This computer's own, normally. After a new code was made here (`wrapPending`) it must reach the
   * remote even with nothing else to send. When another computer made a new code, the remote's header carries its wrap and the sealed index names that
   * wrap's id: this computer then takes the remote's wrap instead of pushing its older one back (which would undo the new code). A header that does not
   * match what the sealed index says is damaged, and this computer's wrap goes up in its place.
   */
  private async chooseWrap(remote: RemoteBundle | undefined, state: SyncState): Promise<{ wrap: RecoveryWrap | undefined; mustPush: boolean; pushesLocal: boolean; settled: boolean }> {
    const { keys } = this.options;
    const local = await keys.readRecoveryWrap();
    const header: RecoveryWrap | undefined = remote ? { kdf: remote.header.kdf, wrappedKey: remote.header.wrappedKey } : undefined;
    if (!local) return { wrap: header, mustPush: false, pushesLocal: false, settled: false };
    if (!header || wrapIdOf(local) === wrapIdOf(header)) return { wrap: local, mustPush: false, pushesLocal: false, settled: state.wrapPending === true };
    if (state.wrapPending) return { wrap: local, mustPush: true, pushesLocal: true, settled: false };
    const claimed = remote?.index.wrapId;
    if (claimed !== undefined && claimed === wrapIdOf(header)) {
      await keys.storeRecoveryWrap(header);
      return { wrap: header, mustPush: false, pushesLocal: false, settled: false };
    }
    return { wrap: local, mustPush: false, pushesLocal: false, settled: false };
  }

  /** Says that a new recovery code was made on this computer, so the next sync pushes its wrap even when there is nothing else to send. */
  public markWrapChanged(): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.readState();
      state.wrapPending = true;
      await this.writeState(state);
      return { kind: 'synced', message: '' } as SyncOutcome;
    }).then(() => undefined);
  }

  private pendingPath(): string {
    return path.join(this.options.home.paths.sync, 'records.enc');
  }

  /**
   * Profile and secret records that arrived are handed to applyProfiles (plan 15) when this sync has it. Without it they are kept, sealed under the data
   * key, in sync/records.enc, and applied by the first sync that does have it; the sync never touches profiles or keys itself.
   */
  private async handleProfiles(received: readonly StateRecord[], dataKey: Buffer, stateId: string): Promise<void> {
    const wanted = received.filter((record) => record.kind === 'profile' || record.kind === 'secret');
    const key = subKey(dataKey, 'transcripts');
    const aad = aadFor(stateId, 'sync-records');
    let stored: StateRecord[] = [];
    try {
      const value = JSON.parse(openSealed(key, JSON.parse(await readFile(this.pendingPath(), 'utf8')) as SealedBlob, aad).toString('utf8')) as unknown;
      if (Array.isArray(value)) stored = value.map((item) => parseRecord(item)).filter((record): record is StateRecord => record !== undefined);
    } catch { stored = []; }
    if (!wanted.length && !stored.length) return;
    const all = mergeAll(stored, wanted);
    if (this.options.applyProfiles) {
      await this.options.applyProfiles(all);
      await rm(this.pendingPath(), { force: true });
      return;
    }
    await this.options.home.ensureFolder(this.options.home.paths.sync);
    await writeFileAtomic(this.pendingPath(), JSON.stringify(seal(key, Buffer.from(JSON.stringify(all), 'utf8'), aad)));
  }

  private collectOptions(state: SyncState) {
    const { writer, profileSource, secretSource, runState } = this.options;
    return { writer, heads: headMapOf(state.heads), ...(profileSource ? { profileSource } : {}), ...(secretSource ? { secretSource } : {}), ...(runState ? { runState } : {}) };
  }

  /** What this computer now knows the remote holds, after reading and applying it. */
  private learnRemote(state: SyncState, remote: RemoteBundle): void {
    state.lastSeenSeq = Math.max(state.lastSeenSeq, remote.seq);
    const listed = new Set(groupObjects(remote.objects).map((group) => (group[0] as ObjectEntry).file));
    state.readObjects = [...new Set([...state.readObjects.filter((name) => listed.has(name)), ...remote.newObjects])];
    for (const [id, list] of Object.entries(remote.entries)) state.pushed[id] = [...new Set([...(state.pushed[id] ?? []), ...list.map((entry) => entry.id)])];
    state.heads = foldHeads(state.heads, remote.records);
  }

  private measured(listedBytesNow: number): number {
    return this.options.measure ? this.options.measure(listedBytesNow) : listedBytesNow;
  }

  /** The message and the facts a sync reports about size: a warning from 500 MB, and which archived threads stay on this computer because there is no more room. */
  private withSizeNotes(total: number, send: SendSet): { message: string; stayLocal?: string[]; syncedBytes: number } {
    const notes: string[] = [MESSAGES.synced];
    if (total >= SYNC_WARN_BYTES) notes.push(MESSAGES.overWarning);
    if (send.heldBack.length && send.stop) notes.push(stayLocalText(send.heldBack.length, send.stop));
    return { message: notes.join(' '), ...(send.heldBack.length ? { stayLocal: send.heldBack } : {}), syncedBytes: total };
  }

  private whatRemoteLacks(local: LocalSnapshot, merged: readonly StateRecord[], remote: RemoteBundle | undefined, state: SyncState): SendSet {
    const entries: Record<string, ThreadEntry[]> = {};
    const cold: ColdAdd[] = [];
    const heldBack: string[] = [];
    let stop: 'bytes' | 'objects' | undefined;
    // What the manifest would list after this push: what it lists now, and a new hot object and a new index.
    let running = this.measured(listedBytes(remote?.objects ?? []));
    let listed = (remote?.objects.length ?? 0) + 2;
    const limit = this.options.maxListedObjects ?? MAX_LISTED_OBJECTS;
    for (const [id, thread] of Object.entries(local.threads).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const held = new Set(state.pushed[id] ?? []);
      let add: ColdParts | undefined;
      let blocked = false;
      if (thread.cold && !remoteHoldsCold(remote, id)) {
        // An archived thread that no cold object holds yet goes up as its own archive, byte for byte; what it holds is then not also sent entry by entry.
        // Nothing is ever deleted: at the size limits it simply does not go up (and is not sent entry by entry either), and the message says so.
        const reason = running >= SYNC_COLD_STOP_BYTES ? 'bytes' : listed + thread.cold.parts.length > limit ? 'objects' : undefined;
        if (reason) { blocked = true; stop ??= reason; } else {
          add = thread.cold;
          cold.push({ id, parts: add.parts, ids: [...add.ids] });
          running += add.parts.reduce((total, part) => total + part.bytes, 0);
          listed += add.parts.length;
        }
      }
      const fresh = thread.entries.filter((entry) => !held.has(entry.id) && !add?.ids.has(entry.id));
      if (blocked) { if (fresh.length) heldBack.push(id); continue; }
      if (fresh.length) entries[id] = fresh;
    }
    // A thread kept back that the remote has never heard of is not named in any record or index either.
    const hide = new Set(heldBack.filter((id) => !remote?.index.threads[id]));
    const held = new Set(state.heads.map(recordKey));
    const records = merged.filter((record) => isSyncedRecord(record) && !held.has(recordKey(record)) && !hidden(record, hide));
    return { entries, records, cold, heldBack, hide, ...(stop ? { stop } : {}), hasNew: Object.keys(entries).length > 0 || records.length > 0 || cold.length > 0 || !remote };
  }

  /** Reads the archive parts of each cold add from the archive folder, checked against their listed size and sha256. A thread whose archive changed meanwhile (it was opened) is left for the next sync. */
  private async readColdParts(adds: readonly ColdAdd[]): Promise<ReadyCold[]> {
    const ready: ReadyCold[] = [];
    for (const add of adds) {
      const files: Array<{ entry: ObjectEntry; data: Buffer }> = [];
      try {
        for (const entry of add.parts) {
          const data = await readFile(path.join(this.options.threads.archiveDirOf(add.id), entry.file));
          if (data.length !== entry.bytes || createHash('sha256').update(data).digest('hex') !== entry.sha256) throw new Error('changed');
          files.push({ entry, data });
        }
      } catch {
        continue;
      }
      ready.push({ ...add, files });
    }
    return ready;
  }

  /**
   * What would replace every hot object on the remote: the union of what they hold, what this computer holds and the merged records, less what a cold
   * object already holds. It is built from the old objects themselves (not from this computer's state alone), then checked to hold every entry id and
   * every record the old objects held (an entry a cold object holds counts as held, a record counts when its newest revision is there). Returns
   * undefined when an old object cannot be read or the check fails: the caller then keeps the old objects and pushes as usual.
   */
  private async consolidatedHot(input: BuildInput, hot: readonly ObjectEntry[][], covered: (id: string) => Set<string>): Promise<{ payload: HotPayload; parts: SealedPart[] } | undefined> {
    const { dataKey, stateId, remote, local, merged, send } = input;
    if (!remote) return undefined;
    const oldEntries = new Map<string, ThreadEntry[]>();
    const oldRecords: StateRecord[] = [];
    try {
      for (const group of hot) {
        const parts: OpenPart[] = [];
        for (const entry of group) parts.push({ entry, data: await this.options.transport.readBlob(remote.tree.get(entry.file) as string) });
        const content = parseHot(openObject(dataKey, stateId, 'hot', parts));
        for (const [id, list] of Object.entries(content.entries)) oldEntries.set(id, unionEntries(oldEntries.get(id) ?? [], list));
        oldRecords.push(...content.records);
      }
    } catch {
      return undefined;
    }
    const entries: Record<string, ThreadEntry[]> = {};
    for (const id of new Set([...oldEntries.keys(), ...Object.keys(local.threads)])) {
      if (send.hide.has(id)) continue;
      const have = covered(id);
      const list = unionEntries(oldEntries.get(id) ?? [], local.threads[id]?.entries ?? []).filter((entry) => !have.has(entry.id));
      if (list.length) entries[id] = list;
    }
    const records = mergeAll(oldRecords, merged.filter((record) => isSyncedRecord(record) && !hidden(record, send.hide)));
    const wanted: HotPayload = { v: 1, entries, records };
    const payload = this.options.shapeConsolidated ? this.options.shapeConsolidated(wanted) : wanted;
    // The new object must hold what the old ones held and also what this push is meant to send, or it is not used.
    const owed = new Map(oldEntries);
    for (const [id, list] of Object.entries(send.entries)) owed.set(id, unionEntries(owed.get(id) ?? [], list));
    for (const [id, list] of owed) {
      const there = new Set((payload.entries[id] ?? []).map((entry) => entry.id));
      const have = covered(id);
      if (list.some((entry) => !there.has(entry.id) && !have.has(entry.id))) return undefined;
    }
    const slots = new Map<string, StateRecord>();
    for (const record of payload.records) {
      const key = `${slotKind(record)}\u0000${record.id}`;
      const current = slots.get(key);
      if (!current || compareRecords(record, current) > 0) slots.set(key, record);
    }
    for (const record of [...oldRecords, ...send.records]) {
      const now = slots.get(`${slotKind(record)}\u0000${record.id}`);
      if (!now || (now.rev !== record.rev && compareRecords(now, record) < 0)) return undefined;
    }
    if (Object.keys(payload.entries).length === 0 && payload.records.length === 0) return undefined;
    return { payload, parts: sealObject(dataKey, stateId, 'hot', payload) };
  }

  private async buildCommit(input: BuildInput): Promise<BuiltCommit> {
    const { dataKey, stateId, wrap, remote, state, local, merged, send } = input;
    const adds = await this.readColdParts(send.cold);
    const addedIds = new Map<string, string[]>(adds.map((add) => [add.id, add.ids]));
    const addedFiles = new Map<string, string[]>(adds.map((add) => [add.id, add.parts.map((part) => part.file)]));
    // What a cold object holds is not repeated in the hot object that replaces the old ones.
    const coldIds = (id: string): Set<string> => new Set([...(state.cold[id] ?? []), ...(addedIds.get(id) ?? [])]);
    const known = new Map<string, ThreadEntry[]>();
    for (const [id, thread] of Object.entries(local.threads)) if (!send.hide.has(id)) known.set(id, thread.entries);
    for (const [id, list] of Object.entries(remote?.entries ?? {})) known.set(id, unionEntries(known.get(id) ?? [], list));

    // Hot objects are replaced by one when more than HOT_CONSOLIDATE_COUNT would be listed, or when together they are more than twice what they hold now.
    const hot = remote ? groupObjects(remote.objects.filter((entry) => entry.class === 'hot')) : [];
    const incremental: HotPayload = { v: 1, entries: send.entries, records: send.records };
    const addsHot = Object.keys(incremental.entries).length > 0 || incremental.records.length > 0;
    const hotBytes = hot.reduce((total, group) => total + group.reduce((sum, entry) => sum + entry.bytes, 0), 0);
    const overCount = hot.length + (addsHot ? 1 : 0) > HOT_CONSOLIDATE_COUNT;
    let replacement: { payload: HotPayload; parts: SealedPart[] } | undefined;
    if (hot.length > 0 && (overCount || (hot.length >= 2 && hotBytes >= HOT_CONSOLIDATE_FLOOR_BYTES))) {
      const candidate = await this.consolidatedHot(input, hot, coldIds);
      const liveBytes = candidate?.parts.reduce((total, part) => total + part.entry.bytes, 0) ?? 0;
      if (candidate && (overCount || hotBytes > 2 * liveBytes)) replacement = candidate;
    }
    const consolidate = replacement !== undefined;
    const payload: HotPayload = replacement?.payload ?? incremental;
    const empty = Object.keys(payload.entries).length === 0 && payload.records.length === 0;
    const hotParts: SealedPart[] = replacement?.parts ?? (empty ? [] : sealObject(dataKey, stateId, 'hot', payload));

    const hotFiles = hotParts.map((part) => part.entry.file);
    const previous = remote?.index.threads ?? {};
    const metas = new Map<string, PortableMeta>();
    for (const [id, thread] of Object.entries(local.threads)) if (!send.hide.has(id)) metas.set(id, thread.meta);
    for (const [id, item] of Object.entries(previous)) if (!metas.has(id)) metas.set(id, item.meta);
    for (const record of merged) if (record.kind === 'thread-meta' && !send.hide.has(record.id)) { const parsed = parsePortableMeta(record.body, record.id); if (parsed) metas.set(record.id, parsed); }
    const index: IndexPayload = { v: 1, threads: {}, wrapId: wrapIdOf(wrap) };
    for (const [id, meta] of metas) {
      const list = known.get(id) ?? [];
      const before = previous[id];
      const covered = coldIds(id);
      const held = new Set([...(state.pushed[id] ?? []), ...(send.entries[id] ?? []).map((entry) => entry.id), ...covered]);
      const carriesHot = consolidate ? Object.keys(payload.entries).includes(id) : (send.entries[id]?.length ?? 0) > 0;
      const coldFiles = [...new Set([...(before?.cold ?? []), ...(addedFiles.get(id) ?? [])])];
      const turns = list.length ? threadLines(list).main.filter((entry) => entry.role === 'user').length : before?.turns;
      index.threads[id] = {
        meta, entries: Math.max(before?.entries ?? 0, held.size), tip: threadTip(list) ?? before?.tip ?? '',
        files: [...(consolidate ? [] : before?.files ?? []), ...(carriesHot ? hotFiles : [])],
        ...(coldFiles.length ? { cold: coldFiles, coldEntries: Math.max(before?.coldEntries ?? 0, covered.size) } : {}),
        ...(turns !== undefined ? { turns } : {})
      };
    }
    const indexParts = sealObject(dataKey, stateId, 'index', index);
    if (indexParts.length !== 1) throw new Error('The sync index is too large to save.');
    const indexEntry = (indexParts[0] as SealedPart).entry;
    // Cold objects are never dropped from the list: they are the only copy of an archived thread that is not on this computer.
    const kept = !remote ? [] : remote.objects.filter((entry) => entry.file !== remote.indexFile && (!consolidate || entry.class === 'cold'));
    const coldEntries = adds.flatMap((add) => add.parts);
    const objects = [...kept, ...coldEntries, ...hotParts.map((part) => part.entry), indexEntry];
    const seq = Math.max(remote?.seq ?? 0, state.lastSeenSeq) + 1;
    const manifest = buildManifest({ stateId, kdf: wrap.kdf, wrappedKey: wrap.wrappedKey, dataKey, seq, objects, indexFile: indexEntry.file });
    const files: Array<StateFile | StateFileRef> = [{ name: 'manifest.json', data: manifest }];
    for (const entry of kept) files.push({ name: entry.file, oid: remote?.tree.get(entry.file) as string });
    for (const add of adds) for (const file of add.files) files.push({ name: file.entry.file, data: file.data });
    for (const part of [...hotParts, ...indexParts]) files.push({ name: part.entry.file, data: part.data });
    const commit = await this.options.transport.writeCommit(files, remote?.tip);
    return { commit, seq, objects, hotFiles, sent: { entries: payload.entries, records: payload.records }, cold: Object.fromEntries(addedIds) };
  }

  private learnPush(state: SyncState, built: BuiltCommit): void {
    state.lastSeenSeq = Math.max(state.lastSeenSeq, built.seq);
    const send = built.sent;
    for (const [id, list] of Object.entries(send.entries)) state.pushed[id] = [...new Set([...(state.pushed[id] ?? []), ...list.map((entry) => entry.id)])];
    for (const [id, ids] of Object.entries(built.cold)) {
      state.pushed[id] = [...new Set([...(state.pushed[id] ?? []), ...ids])];
      state.cold[id] = [...new Set([...(state.cold[id] ?? []), ...ids])];
    }
    state.heads = foldHeads(state.heads, send.records);
    const listed = new Set(groupObjects(built.objects).map((group) => (group[0] as ObjectEntry).file));
    state.readObjects = [...new Set([...state.readObjects, ...(built.hotFiles.length ? [built.hotFiles[0] as string] : [])])].filter((name) => listed.has(name));
  }

  // ---- opening a thread that is kept only online ------------------------------------------------------------------------------------

  /** Records that the remote's cold objects hold these entries of a thread, so this computer never sends them again. */
  private async noteCold(id: string, ids: readonly string[]): Promise<void> {
    const state = await this.readState();
    state.pushed[id] = [...new Set([...(state.pushed[id] ?? []), ...ids])];
    state.cold[id] = [...new Set([...(state.cold[id] ?? []), ...ids])];
    await this.writeState(state);
  }

  /**
   * Fetches one archived thread from the project's synced state into this computer's archive folder, where the thread store opens it. Only that
   * thread's cold parts are read (git downloads exactly those blobs); the sealed manifest and index name them, and every part is authenticated as a
   * cold object of this project, and the bundle must be for this thread, before a single file is written. Nothing is written otherwise.
   */
  public async fetchColdThread(id: string): Promise<ColdFetchResult> {
    try {
      return await syncOwnerFor(this.options.root).run(() => this.fetchColdNow(id), this.options.lockTimings);
    } catch (error) {
      if (isBusy(error)) return { ok: false, reason: 'offline' };
      throw error;
    }
  }

  private async fetchColdNow(id: string): Promise<ColdFetchResult> {
    const { transport, keys, home, threads } = this.options;
    if (!THREAD_ID.test(id)) return { ok: false, reason: 'damaged' };
    const dataKey = await keys.dataKey();
    const meta = await home.readMeta();
    if (!dataKey || !meta) return { ok: false, reason: 'needs-recovery-code' };
    let reading = '';
    let tip: string | undefined;
    try {
      tip = await transport.currentTip();
      if (!tip) return { ok: false, reason: 'offline' };
      const tree = new Map((await transport.readTree(tip)).map((entry) => [entry.name, entry.oid]));
      const manifestOid = tree.get('manifest.json');
      if (!manifestOid) return { ok: false, reason: 'damaged' };
      // The floor is 0: this reads one thread out of a tree already merged by a sync; the rollback check belongs to the sync that merges.
      const manifest = openManifest((await transport.readBlob(manifestOid)).toString('utf8'), dataKey, 0);
      if (manifest.header.stateId !== meta.stateId || !manifest.indexFile) return { ok: false, reason: 'damaged' };
      const indexGroup = manifest.objects.filter((entry) => entry.file === manifest.indexFile);
      const indexParts: OpenPart[] = [];
      for (const entry of indexGroup) { reading = tree.get(entry.file) ?? ''; indexParts.push({ entry, data: await transport.readBlob(reading) }); }
      const item = parseIndex(openObject(dataKey, meta.stateId, 'index', indexParts)).threads[id];
      if (!item?.cold?.length) return { ok: false, reason: 'damaged' };
      const wanted = new Set(item.cold);
      const listed = manifest.objects.filter((entry) => wanted.has(entry.file));
      if (listed.length !== wanted.size || listed.some((entry) => entry.class !== 'cold')) throw new StateRefusedError('tampered');
      const bundles: ArchiveBundle[] = [];
      const sealed: Array<Array<{ entry: ObjectEntry; data: Buffer }>> = [];
      for (const group of groupObjects(listed)) {
        const parts: OpenPart[] = [];
        for (const entry of group) { reading = tree.get(entry.file) ?? ''; if (!reading) throw new StateRefusedError('missing-object'); parts.push({ entry, data: await transport.readBlob(reading) }); }
        bundles.push(bundleOf(openObject(dataKey, meta.stateId, 'cold', parts), id));
        sealed.push(parts.map((part) => ({ entry: part.entry, data: part.data as Buffer })));
      }
      if (!bundles.length) return { ok: false, reason: 'damaged' };
      const installed = bundles.length === 1
        ? await installArchive(threads, id, sealed[0] as Array<{ entry: ObjectEntry; data: Buffer }>)
        : await writeArchive(threads, id, mergeBundles(bundles));
      await this.noteCold(id, installed.entries.map((entry) => entry.id));
      return { ok: true };
    } catch (error) {
      if (error instanceof StateRefusedError) {
        // A blob git could not download looks like a missing object: if it is one the mirror still lacks, the cause is the connection, not the data.
        if (error.reason === 'missing-object' && tip && reading && (await transport.missingObjects(tip).catch(() => [] as string[])).includes(reading)) return { ok: false, reason: 'offline' };
        return { ok: false, reason: 'damaged' };
      }
      return { ok: false, reason: 'offline' };
    }
  }
}

/** Several cold objects for one thread (two computers archived it separately): their entries united, the later context and the merged meta kept. */
function mergeBundles(bundles: readonly ArchiveBundle[]): ArchiveBundle {
  let entries: ThreadEntry[] = [];
  let context: ArchiveBundle['context'] = null;
  let meta = (bundles[0] as ArchiveBundle).meta;
  for (const bundle of bundles) {
    entries = unionEntries(entries, bundle.entries);
    if (bundle.context && (!context || bundle.context.updatedAt > context.updatedAt)) context = bundle.context;
    meta = mergeMeta(meta, bundle.meta);
  }
  return { entries, context, meta };
}

/** The bytes the manifest lists: what the remote's tree holds of this project's state, apart from the manifest file itself. */
function listedBytes(objects: readonly ObjectEntry[]): number {
  return objects.reduce((total, entry) => total + entry.bytes, 0);
}

/** Whether a record is about a thread that this push keeps back: its meta and context are not sent either. */
function hidden(record: StateRecord, hide: ReadonlySet<string>): boolean {
  return (record.kind === 'thread-meta' || record.kind === 'thread-context') && hide.has(record.id);
}

function remoteHoldsCold(remote: RemoteBundle | undefined, id: string): boolean {
  return (remote?.index.threads[id]?.cold?.length ?? 0) > 0;
}

function coldListed(remote: RemoteBundle | undefined): Record<string, IndexThread> {
  const found: Record<string, IndexThread> = {};
  for (const [id, item] of Object.entries(remote?.index.threads ?? {})) if (item.cold?.length) found[id] = item;
  return found;
}

interface ColdAdd { id: string; parts: ObjectEntry[]; ids: string[] }
interface ReadyCold extends ColdAdd { files: Array<{ entry: ObjectEntry; data: Buffer }> }
interface SendSet {
  entries: Record<string, ThreadEntry[]>;
  records: StateRecord[];
  cold: ColdAdd[];
  /** Archived threads kept back at a size limit, and the first limit that kept one back. */
  heldBack: string[];
  /** The ones of those the remote has never heard of: not named in any record or the index either. */
  hide: Set<string>;
  stop?: 'bytes' | 'objects';
  hasNew: boolean;
}
interface BuildInput {
  dataKey: Buffer;
  stateId: string;
  wrap: { kdf: KdfRecord; wrappedKey: SealedBlob };
  remote: RemoteBundle | undefined;
  state: SyncState;
  local: LocalSnapshot;
  merged: readonly StateRecord[];
  send: SendSet;
}
interface BuiltCommit { commit: string; seq: number; objects: ObjectEntry[]; hotFiles: string[]; sent: { entries: Record<string, ThreadEntry[]>; records: StateRecord[] }; cold: Record<string, string[]> }
