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
import { openObject, sealObject, MAX_OBJECT_ENTRIES, MAX_PART_BYTES, OBJECT_HEADER_BYTES, OBJECT_NAME, type OpenPart } from '../domain/state/objects';
import { rankThreads } from '../domain/state/retention';
import { threadTip, unionEntries, type ThreadEntry } from '../domain/state/threadEntries';
import { writeFileAtomic } from './stateHome';
import { validEntry, validMeta, type ThreadMeta, type ThreadStore } from './threadStore';
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
  const value = openObject(keys.dataKey, keys.stateId, 'cold', parts);
  if (!isRecord(value) || value.format !== BUNDLE_FORMAT || !Array.isArray(value.entries)) throw new Error(UNREADABLE);
  const meta = validMeta(value.meta, id);
  // An archive moved here from another thread names its own thread in every entry and in its meta, so it is not taken for this one.
  const entries = value.entries.map((entry) => validEntry(entry, id));
  if (!meta || entries.some((entry) => !entry)) throw new Error(UNREADABLE);
  const context = value.context as Partial<Transcript> | null;
  if (context !== null && (!isRecord(context) || context.id !== id || !Array.isArray(context.messages))) throw new Error(UNREADABLE);
  return { entries: entries as ThreadEntry[], context: context as Transcript | null, meta };
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
  const entries = unionEntries(bundle.entries, await store.archiveDeltaEntries(id));
  const live = await store.restoreLive(id, { ...bundle, entries }, touch);
  if (entries.some((entry) => !live.has(entry.id))) throw new Error('The conversation could not be restored completely, so its archive was kept.');
  await rm(store.archiveDirOf(id), { recursive: true, force: true });
  return true;
}

export function unarchiveThread(store: ThreadStore, id: string, options: { touch?: boolean } = {}): Promise<boolean> {
  return store.serial(id, () => unarchiveNow(store, id, options.touch !== false));
}

export interface RetentionResult { archived: string[]; restored: string[] }

const queues = new WeakMap<ThreadStore, Promise<unknown>>();

async function retain(store: ThreadStore, liveCount: number, protectedIds: ReadonlySet<string>): Promise<RetentionResult> {
  const result: RetentionResult = { archived: [], restored: [] };
  if (!await store.archiveKeys()) return result;
  const index = (await store.index()).filter((item) => !item.locked);
  const state = new Map(index.map((item) => [item.id, item.state]));
  const ranked = rankThreads(index, liveCount, protectedIds);
  // One thread at a time, each written, checked and only then removed from the live folder.
  for (const id of ranked.archive) {
    if (state.get(id) === 'live' && !store.isBusy(id) && await archiveThread(store, id).catch(() => false)) result.archived.push(id);
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
