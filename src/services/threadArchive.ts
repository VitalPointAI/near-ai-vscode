// The archive (D-08): the threads beyond the most recently used few are kept whole, inside the state home, in the same sealed format as the objects
// that sync pushes (brotli, Padme padding, AES-256-GCM under the data key, class 'cold'), so a later plan can push an archive unchanged. Nothing here
// deletes a thread: a thread is written to its archive, the archive is opened again and compared with the thread, and only then are the live files
// removed (meta last). A crash at any step leaves the live copy, the archive, or both, and reconcileArchives finishes or reverses it by union.
//
// Layout: archive/<thread id>/parts.json   { parts: [{ file, bytes, sha256, part, of }] }, written last, so an archive without it is not complete;
//         archive/<thread id>/<32 hex>.bin  the sealed parts of one bundle { format, entries, context, meta };
//         archive/<thread id>/delta.jsonl  optional: sealed entry lines (as in a log) a thread gained while archived (written by sync, plan 13).
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { openObject, sealObject, MAX_OBJECT_ENTRIES, MAX_PART_BYTES, OBJECT_HEADER_BYTES, OBJECT_NAME, type ObjectEntry, type OpenPart } from '../domain/state/objects';
import { rankThreads } from '../domain/state/retention';
import { threadTip, unionEntries, type ThreadEntry } from '../domain/state/threadEntries';
import type { RunState } from './runMarkers';
import { writeFileAtomic } from './stateHome';
import { mergeMeta, validEntry, validMeta, type ThreadMeta, type ThreadStore } from './threadStore';
import type { Transcript } from './transcripts';

/** What an archive holds of one thread. */
export interface ArchiveBundle {
  entries: ThreadEntry[];
  context: Transcript | null;
  meta: ThreadMeta;
}

interface PartRecord { file: string; bytes: number; sha256: string; part: number; of: number }

const BUNDLE_FORMAT = 1;
const MAX_PART_FILE_BYTES = MAX_PART_BYTES + OBJECT_HEADER_BYTES;
const UNREADABLE = 'This conversation is archived and cannot be opened on this device.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** parts.json, read strictly: anything that is not a plain list of well-formed part records is refused. */
function parseParts(text: string): PartRecord[] {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > MAX_OBJECT_ENTRIES) throw new Error(UNREADABLE);
  return value.parts.map((item): PartRecord => {
    if (!isRecord(item) || typeof item.file !== 'string' || !OBJECT_NAME.test(item.file) || typeof item.sha256 !== 'string') throw new Error(UNREADABLE);
    const { bytes, part, of } = item;
    if (typeof bytes !== 'number' || typeof part !== 'number' || typeof of !== 'number' || ![bytes, part, of].every(Number.isSafeInteger)) throw new Error(UNREADABLE);
    return { file: item.file, bytes, sha256: item.sha256, part, of };
  });
}

/**
 * What a bundle payload (an archive's decrypted content, here or fetched from the project's synced state) says of thread `id`, read strictly: it must
 * name this thread in its meta, every entry and its context, so a bundle moved from another thread is not taken for this one.
 */
export function bundleOf(value: unknown, id: string): ArchiveBundle {
  if (!isRecord(value) || value.format !== BUNDLE_FORMAT || !Array.isArray(value.entries)) throw new Error(UNREADABLE);
  const meta = validMeta(value.meta, id);
  const entries = value.entries.map((entry) => validEntry(entry, id));
  if (!meta || entries.some((entry) => !entry)) throw new Error(UNREADABLE);
  const context = value.context as Partial<Transcript> | null;
  if (context !== null && (!isRecord(context) || context.id !== id || !Array.isArray(context.messages))) throw new Error(UNREADABLE);
  return { entries: entries as ThreadEntry[], context: context as Transcript | null, meta };
}

/** The parts an archive's parts.json lists, as the entries the sync's sealed manifest lists for a cold object. Throws when parts.json is missing or malformed. */
export async function archiveParts(store: ThreadStore, id: string): Promise<ObjectEntry[]> {
  return parseParts(await readFile(path.join(store.archiveDirOf(id), 'parts.json'), 'utf8')).map((record) => ({ ...record, class: 'cold' as const }));
}

/** Opens one thread's archive: every part is checked against parts.json (size, sha256) and authenticated by openObject before anything is read from it. */
export async function readArchive(store: ThreadStore, id: string): Promise<ArchiveBundle> {
  const keys = await store.archiveKeys();
  if (!keys) throw new Error(UNREADABLE);
  const dir = store.archiveDirOf(id);
  const records = parseParts(await readFile(path.join(dir, 'parts.json'), 'utf8'));
  const parts: OpenPart[] = [];
  for (const record of records) {
    const file = path.join(dir, record.file);
    const size = (await stat(file).catch(() => undefined))?.size;
    // A file larger than the part limit is never read into memory.
    if (size !== undefined && size > MAX_PART_FILE_BYTES) throw new Error(UNREADABLE);
    parts.push({ entry: { ...record, class: 'cold' }, data: size === undefined ? undefined : await readFile(file) });
  }
  return bundleOf(openObject(keys.dataKey, keys.stateId, 'cold', parts), id);
}

/**
 * Puts already sealed parts in the thread's archive folder: the parts first, parts.json last (so an archive without it is a write that never finished),
 * then the archive is opened again, which authenticates every part under this project's key. Returns what the archive holds. When the check fails the
 * parts written are left for the caller to remove (an archive without a complete parts.json is never listed).
 */
export async function installArchive(store: ThreadStore, id: string, parts: ReadonlyArray<{ entry: ObjectEntry; data: Buffer }>): Promise<ArchiveBundle> {
  const dir = await store.ensureArchiveDir(id);
  for (const part of parts) await writeFileAtomic(path.join(dir, part.entry.file), part.data);
  await writeFileAtomic(path.join(dir, 'parts.json'), `${JSON.stringify({ parts: parts.map(({ entry }) => ({ file: entry.file, bytes: entry.bytes, sha256: entry.sha256, part: entry.part, of: entry.of })) })}\n`);
  return readArchive(store, id);
}

/** Seals a bundle (class 'cold', as every archive is) and installs it. Used for a thread fetched from the project's synced state as more than one object. */
export async function writeArchive(store: ThreadStore, id: string, bundle: ArchiveBundle): Promise<ArchiveBundle> {
  const keys = await store.archiveKeys();
  if (!keys) throw new Error(UNREADABLE);
  return installArchive(store, id, sealObject(keys.dataKey, keys.stateId, 'cold', { format: BUNDLE_FORMAT, entries: bundle.entries, context: bundle.context, meta: bundle.meta }));
}

/** An archived thread's meta (title, counts, times), marked archived: for a list whose index lost the thread. */
export async function archiveMeta(store: ThreadStore, id: string): Promise<ThreadMeta> {
  const { meta } = await readArchive(store, id);
  return { ...meta, state: 'archived' };
}

/** Writes the thread to its archive, opens the archive again and compares it with the thread, then removes the live files. Nothing is removed otherwise. */
async function archiveNow(store: ThreadStore, id: string): Promise<boolean> {
  const keys = await store.archiveKeys();
  if (!keys) return false;
  const snapshot = await store.liveSnapshot(id);
  if (!snapshot) return false;
  const bundle = { format: BUNDLE_FORMAT, entries: snapshot.entries, context: snapshot.context, meta: snapshot.meta };
  const parts = sealObject(keys.dataKey, keys.stateId, 'cold', bundle);
  const dir = await store.ensureArchiveDir(id);
  for (const part of parts) await writeFileAtomic(path.join(dir, part.entry.file), part.data);
  // parts.json goes last: an archive without it is a crash in the middle of writing, never taken for a finished one.
  await writeFileAtomic(path.join(dir, 'parts.json'), `${JSON.stringify({ parts: parts.map(({ entry }) => ({ file: entry.file, bytes: entry.bytes, sha256: entry.sha256, part: entry.part, of: entry.of })) })}\n`);
  const check = await readArchive(store, id);
  const wanted = new Set(snapshot.entries.map((entry) => entry.id));
  const same = check.meta.id === id && check.entries.length === wanted.size && check.entries.every((entry) => wanted.has(entry.id)) && threadTip(check.entries) === threadTip(snapshot.entries);
  if (!same) return false;
  if (!await store.removeLive(id, snapshot)) return false;
  // Parts of an earlier attempt that parts.json no longer lists.
  const listed = new Set(parts.map((part) => part.entry.file));
  for (const name of await readdir(dir).catch(() => [] as string[])) if (OBJECT_NAME.test(name) && !listed.has(name)) await rm(path.join(dir, name), { force: true }).catch(() => undefined);
  return true;
}

/** Archives one live thread. Returns whether its live files were removed (false: nothing was changed that the archive does not hold). */
export function archiveThread(store: ThreadStore, id: string): Promise<boolean> {
  return store.serial(id, () => archiveNow(store, id));
}

/**
 * Brings an archived thread back to its live folder: the archive and its delta file are unioned into the live log, the live files are written, and
 * only when every archived entry is in the live log is the archive removed. `touch` (the default) makes the thread the most recently used, which is
 * what opening it does. Returns false when the thread has no archive; a refused archive throws and stays where it is.
 */
async function unarchiveNow(store: ThreadStore, id: string, touch: boolean): Promise<boolean> {
  if (!(await stat(path.join(store.archiveDirOf(id), 'parts.json')).catch(() => undefined))?.isFile()) return false;
  const bundle = await readArchive(store, id);
  const delta = await store.archiveDeltaEntries(id);
  const entries = unionEntries(bundle.entries, delta);
  // The archive's meta is as old as the archive. A use of the thread on another computer is in the index (and in the entries beside the archive), and the
  // thread comes back no older than that.
  const indexed = await store.indexedMeta(id);
  const merged = indexed ? mergeMeta(bundle.meta, indexed) : bundle.meta;
  const meta = { ...merged, lastUsedAt: [merged.lastUsedAt, delta.at(-1)?.at ?? ''].reduce((a, b) => (a >= b ? a : b)) };
  const live = await store.restoreLive(id, { ...bundle, entries, meta }, touch);
  if (entries.some((entry) => !live.has(entry.id))) throw new Error('The conversation could not be restored completely, so its archive was kept.');
  await rm(store.archiveDirOf(id), { recursive: true, force: true });
  return true;
}

export function unarchiveThread(store: ThreadStore, id: string, options: { touch?: boolean } = {}): Promise<boolean> {
  return store.serial(id, () => unarchiveNow(store, id, options.touch !== false));
}

/**
 * Settles what a crash left, by union. For a thread with both a live copy and an archive: a live copy with no log is restored from the archive; a live
 * copy that has entries the archive lacks (or a thread that must stay live) is made whole with the archive's entries and the archive removed; a live copy
 * that adds nothing is finished (its files removed). An archive that cannot be opened is left alone with the live copy.
 */
export async function reconcileArchives(store: ThreadStore, protectedIds: Iterable<string> = []): Promise<string[]> {
  const keep = new Set(protectedIds);
  const settled: string[] = [];
  for (const id of await store.archivedIds()) {
    if (store.isBusy(id)) continue;
    const changed = await store.serial(id, async () => {
      const files = await store.liveFiles(id);
      if (!files.log && !files.context && !files.meta) return false;
      if (!files.log) return unarchiveNow(store, id, false);
      const bundle = await readArchive(store, id);
      const held = new Set([...bundle.entries, ...await store.archiveDeltaEntries(id)].map((entry) => entry.id));
      if (keep.has(id) || (await store.liveEntries(id)).some((entry) => !held.has(entry.id))) return unarchiveNow(store, id, false);
      const snapshot = await store.liveSnapshot(id);
      return snapshot ? store.removeLive(id, snapshot) : false;
    }).catch(() => false);
    if (changed) settled.push(id);
  }
  return settled;
}

export interface RetentionResult { archived: string[]; restored: string[] }

const queues = new WeakMap<ThreadStore, Promise<unknown>>();

async function retain(store: ThreadStore, liveCount: number, protectedIds: ReadonlySet<string>): Promise<RetentionResult> {
  const result: RetentionResult = { archived: [], restored: [] };
  if (!await store.archiveKeys()) return result;
  await reconcileArchives(store, protectedIds);
  const index = (await store.index()).filter((item) => !item.locked);
  const state = new Map(index.map((item) => [item.id, item.state]));
  const ranked = rankThreads(index, liveCount, protectedIds);
  // One thread at a time, each written, checked and only then removed from the live folder.
  for (const id of ranked.archive) {
    if (state.get(id) === 'live' && !store.isBusy(id) && await archiveThread(store, id).catch(() => false)) result.archived.push(id);
  }
  // A thread the rank rule puts among the live ones (the setting was raised, or it was continued elsewhere) comes back without being counted as used.
  for (const id of ranked.live) {
    if (state.get(id) === 'archived' && !store.isBusy(id) && await unarchiveThread(store, id, { touch: false }).catch(() => false)) result.restored.push(id);
  }
  return result;
}

/**
 * Keeps the `liveCount` most recently used threads live, and every thread in `protectedIds` besides, and archives the others. Never deletes a thread.
 * Calls on one store run one after another.
 */
export function applyRetention(store: ThreadStore, liveCount: number, protectedIds: Iterable<string> = []): Promise<RetentionResult> {
  const keep = new Set(protectedIds);
  const run = (queues.get(store) ?? Promise.resolve()).then(() => retain(store, liveCount, keep), () => retain(store, liveCount, keep));
  queues.set(store, run.catch(() => undefined));
  return run;
}

/** The threads retention must leave live whatever their rank: every conversation open in a tab of this editor, and every one whose run is running here or elsewhere. */
export function protectedThreadIds(tabIds: Iterable<string>, markers: ReadonlyArray<{ conversationId: string; state: RunState }>): Set<string> {
  const keep = new Set(tabIds);
  for (const marker of markers) if (marker.state === 'running-here' || marker.state === 'running-elsewhere') keep.add(marker.conversationId);
  return keep;
}
