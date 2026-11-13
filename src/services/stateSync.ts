// Sync of the project's state through the project's own remote (SYNC-05, D-01, D-02, D-09). A sync is: fetch, verify everything the remote holds (manifest,
// index, every object not read before, the sequence number), merge per record with the plan-02 rules, apply to the state home, then build and push one new
// hot object, a new index and a new manifest on top of the remote tip. A push that loses a race fetches, merges and tries again (never forced). Nothing
// local is changed when verification fails. The transport owns the mirror lock; this module never holds it around a transport call. No vscode.
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { StateRefusedError, aadFor, deriveKek, open as openSealed, seal, subKey, unwrapDataKey, type KdfRecord, type SealedBlob } from '../domain/state/keys';
import {
  openManifest, openObject, readManifestHeader, sealObject, buildManifest,
  type ManifestHeader, type ObjectEntry, type OpenPart, type SealedPart
} from '../domain/state/objects';
import { parseRecord, type StateRecord } from '../domain/state/records';
import { threadTip, unionEntries, type ThreadEntry } from '../domain/state/threadEntries';
import type { RunMarker, RunState } from './runMarkers';
import { rm } from 'node:fs/promises';
import { ProjectStateHome, writeFileAtomic } from './stateHome';
import type { StateKeys } from './stateKeys';
import { MirrorBusyError } from './stateMirrorLock';
import {
  THREAD_ID, applyMerged, collectLocal, foldHeads, headMapOf, isSyncedRecord, mergeAll, parsePortableMeta, recordKey, withoutBody,
  type HotPayload, type IndexPayload, type LocalSnapshot, type PortableMeta, type ProfileSource, type SecretSource
} from './stateRecords';
import type { StateFile, StateFileRef, StateTransport, SyncFailure } from './stateTransport';
import { validEntry, type ThreadStore } from './threadStore';

/** A push that loses a race fetches, merges and tries again this many times before giving up until the next sync. */
export const MAX_PUSH_ATTEMPTS = 5;
/** When the manifest lists this many objects, the next push seals everything into one fresh object instead of adding another (the manifest is capped at 1 MiB). */
export const CONSOLIDATE_AT_OBJECTS = 200;
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
  unlocked: "This project's chats were opened with the recovery code."
} as const;

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
  /** Test seams for the retry wait. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface SyncState {
  version: 1;
  lastSeenSeq: number;
  /** The first file name of every hot or cold object whose content is already merged here. */
  readObjects: string[];
  /** The entry ids the remote is known to hold, by thread. */
  pushed: Record<string, string[]>;
  /** What the remote holds for each record, without bodies: a record whose (kind, id, rev) is here is not sent again. */
  heads: StateRecord[];
}

function freshState(): SyncState {
  return { version: 1, lastSeenSeq: 0, readObjects: [], pushed: {}, heads: [] };
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
    return {
      version: 1, lastSeenSeq: value.lastSeenSeq,
      readObjects: Array.isArray(value.readObjects) ? value.readObjects.filter((item): item is string => typeof item === 'string') : [],
      pushed, heads
    };
  } catch {
    return freshState();
  }
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
    threads[id] = { meta, entries: item.entries, tip: item.tip, files: item.files.filter((file): file is string => typeof file === 'string') };
  }
  return { v: 1, threads };
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

export class StateSync {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  public constructor(private readonly options: StateSyncOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
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
      const fetched = await this.options.transport.fetch();
      if (!fetched.ok) return { kind: 'failed', message: fetched.failure.message, failure: fetched.failure };
      if (!fetched.value) return { kind: 'nothing-yet', message: MESSAGES.nothingYet };
      const text = await this.readManifestText(fetched.value);
      const header = readManifestHeader(text);
      if (codeBytes.length !== 32) throw new StateRefusedError('wrong-code-or-damaged');
      const kek = await deriveKek(codeBytes, Buffer.from(header.kdf.salt, 'base64'), header.kdf);
      const dataKey = unwrapDataKey(kek, header.wrappedKey, header.stateId);
      openManifest(text, dataKey, 0);
      try {
        await this.options.keys.adoptDataKey(dataKey, header.stateId);
      } catch (error) {
        return { kind: 'refused', message: error instanceof Error ? error.message : MESSAGES.locked };
      }
      await this.options.keys.storeRecoveryWrap({ kdf: header.kdf, wrappedKey: header.wrappedKey });
      return { kind: 'synced', message: MESSAGES.unlocked };
    }));
  }

  // ---- plumbing ---------------------------------------------------------------------------------------------------------------------

  private enqueue(work: () => Promise<SyncOutcome>): Promise<SyncOutcome> {
    const result = this.chain.then(work, work);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async guard(work: () => Promise<SyncOutcome>): Promise<SyncOutcome> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StateRefusedError) return { kind: 'refused', message: error.message };
      if (error instanceof MirrorBusyError) return { kind: 'waiting', message: MESSAGES.waiting };
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
      if (!isIndex && read.has(first.file)) continue;
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
    for (const [id, item] of Object.entries(index.threads)) if (item.entries > held(id)) throw new StateRefusedError('missing-object');
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
      await applyMerged(home, threads, { entries: remote?.entries ?? {}, records: toApply }, local, this.options.runState ? { runState: this.options.runState } : {});
      await this.handleProfiles(toApply, dataKey, meta.stateId);

      if (remote) this.learnRemote(state, remote);
      await this.writeState(state);
      if (mode === 'pull') return { kind: 'synced', message: MESSAGES.synced, pushed: false, attempts: tries };

      const send = this.whatRemoteLacks(local, merged, remote, state);
      if (remote && !send.hasNew) return { kind: 'synced', message: MESSAGES.synced, pushed: false, attempts: tries };

      const wrap = (await keys.readRecoveryWrap()) ?? (remote ? { kdf: remote.header.kdf, wrappedKey: remote.header.wrappedKey } : undefined);
      if (!wrap) return { kind: 'refused', message: MESSAGES.noRecoveryCode, attempts: tries };
      const built = await this.buildCommit({ dataKey, stateId: meta.stateId, wrap, remote, state, local, merged, send });
      tries += 1;
      const pushed = await transport.push(built.commit);
      if (pushed.ok) {
        this.learnPush(state, built);
        await this.writeState(state);
        return { kind: 'synced', message: MESSAGES.synced, pushed: true, attempts: tries };
      }
      if (pushed.failure.kind !== 'rejected') return { kind: 'failed', message: pushed.failure.message, failure: pushed.failure, attempts: tries };
      if (tries >= MAX_PUSH_ATTEMPTS) return { kind: 'failed', message: MESSAGES.contended, failure: pushed.failure, attempts: tries };
      await this.sleep(RETRY_MIN_MS + Math.floor(this.random() * RETRY_SPAN_MS));
    }
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

  private whatRemoteLacks(local: LocalSnapshot, merged: readonly StateRecord[], remote: RemoteBundle | undefined, state: SyncState): SendSet {
    const entries: Record<string, ThreadEntry[]> = {};
    for (const [id, thread] of Object.entries(local.threads)) {
      const held = new Set(state.pushed[id] ?? []);
      const fresh = thread.entries.filter((entry) => !held.has(entry.id));
      if (fresh.length) entries[id] = fresh;
    }
    const held = new Set(state.heads.map(recordKey));
    const records = merged.filter((record) => isSyncedRecord(record) && !held.has(recordKey(record)));
    return { entries, records, hasNew: Object.keys(entries).length > 0 || records.length > 0 || !remote };
  }

  private async buildCommit(input: BuildInput): Promise<BuiltCommit> {
    const { dataKey, stateId, wrap, remote, state, local, merged, send } = input;
    const consolidate = (remote?.objects.length ?? 0) + 2 > CONSOLIDATE_AT_OBJECTS;
    const known = new Map<string, ThreadEntry[]>();
    for (const [id, thread] of Object.entries(local.threads)) known.set(id, thread.entries);
    for (const [id, list] of Object.entries(remote?.entries ?? {})) known.set(id, unionEntries(known.get(id) ?? [], list));
    const payload: HotPayload = consolidate
      ? { v: 1, entries: Object.fromEntries([...known].filter(([, list]) => list.length)), records: merged.filter(isSyncedRecord) }
      : { v: 1, entries: send.entries, records: send.records };
    const empty = Object.keys(payload.entries).length === 0 && payload.records.length === 0;
    const hotParts: SealedPart[] = empty ? [] : sealObject(dataKey, stateId, 'hot', payload);

    const hotFiles = hotParts.map((part) => part.entry.file);
    const previous = remote?.index.threads ?? {};
    const metas = new Map<string, PortableMeta>();
    for (const [id, thread] of Object.entries(local.threads)) metas.set(id, thread.meta);
    for (const [id, item] of Object.entries(previous)) if (!metas.has(id)) metas.set(id, item.meta);
    for (const record of merged) if (record.kind === 'thread-meta') { const parsed = parsePortableMeta(record.body, record.id); if (parsed) metas.set(record.id, parsed); }
    const index: IndexPayload = { v: 1, threads: {} };
    for (const [id, meta] of metas) {
      const list = known.get(id) ?? [];
      const held = new Set([...(state.pushed[id] ?? []), ...(send.entries[id] ?? []).map((entry) => entry.id)]);
      const sent = consolidate ? list.length > 0 : (send.entries[id]?.length ?? 0) > 0;
      index.threads[id] = {
        meta, entries: held.size, tip: threadTip(list) ?? '',
        files: [...(consolidate ? [] : previous[id]?.files ?? []), ...(sent ? hotFiles : [])]
      };
    }
    const indexParts = sealObject(dataKey, stateId, 'index', index);
    if (indexParts.length !== 1) throw new Error('The sync index is too large to save.');
    const indexEntry = (indexParts[0] as SealedPart).entry;
    const kept = consolidate || !remote ? [] : remote.objects.filter((entry) => entry.file !== remote.indexFile);
    const objects = [...kept, ...hotParts.map((part) => part.entry), indexEntry];
    const seq = Math.max(remote?.seq ?? 0, state.lastSeenSeq) + 1;
    const manifest = buildManifest({ stateId, kdf: wrap.kdf, wrappedKey: wrap.wrappedKey, dataKey, seq, objects, indexFile: indexEntry.file });
    const files: Array<StateFile | StateFileRef> = [{ name: 'manifest.json', data: manifest }];
    for (const entry of kept) files.push({ name: entry.file, oid: remote?.tree.get(entry.file) as string });
    for (const part of [...hotParts, ...indexParts]) files.push({ name: part.entry.file, data: part.data });
    const commit = await this.options.transport.writeCommit(files, remote?.tip);
    return { commit, seq, objects, hotFiles, sent: { entries: payload.entries, records: payload.records } };
  }

  private learnPush(state: SyncState, built: BuiltCommit): void {
    state.lastSeenSeq = Math.max(state.lastSeenSeq, built.seq);
    const send = built.sent;
    for (const [id, list] of Object.entries(send.entries)) state.pushed[id] = [...new Set([...(state.pushed[id] ?? []), ...list.map((entry) => entry.id)])];
    state.heads = foldHeads(state.heads, send.records);
    const listed = new Set(groupObjects(built.objects).map((group) => (group[0] as ObjectEntry).file));
    state.readObjects = [...new Set([...state.readObjects, ...(built.hotFiles.length ? [built.hotFiles[0] as string] : [])])].filter((name) => listed.has(name));
  }
}

interface SendSet { entries: Record<string, ThreadEntry[]>; records: StateRecord[]; hasNew: boolean }
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
interface BuiltCommit { commit: string; seq: number; objects: ObjectEntry[]; hotFiles: string[]; sent: { entries: Record<string, ThreadEntry[]>; records: StateRecord[] } }

