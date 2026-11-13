// The thread store (D-04, D-07): every conversation of the project, kept in the state home so every editor on this computer lists and reopens the same
// ones. A thread is a folder, threads/<id>/, holding:
//   log.jsonl   the append-only record of what was said and done, one sealed entry per line, written before the model's context is trimmed;
//   context.enc the model's working list (what a resumed run continues from), replaced whole;
//   meta.enc    the title, model, counts and tip, replaced whole.
// threads/index.enc is a cache of every thread's meta. Everything is sealed with the transcript subkey of the project's data key; no vscode here.
//
// Nothing here deletes a thread or an entry. A thread whose key is not available on this device is listed as locked, never dropped.
import { createHash } from 'node:crypto';
import { appendFile, open, readFile, readdir, rmdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { aadFor, open as openSealed, seal, subKey, type SealedBlob } from '../domain/state/keys';
import { canonicalJson } from '../domain/state/records';
import { isSyntheticMessage, messagesToEntries } from '../domain/state/threadCapture';
import { threadLines, threadTip, unionEntries, type ThreadEntry, type ThreadLines, type ThreadRole } from '../domain/state/threadEntries';
import { PARTIAL_HISTORY, PARTIAL_HISTORY_NOTE, entriesToMessages, pairToolResults } from '../domain/state/threadView';
import type { AgentMessage } from './nearAiClient';
import { ProjectStateHome, stateHomeFor, writeFileAtomic } from './stateHome';
import { stateKeysFor, type SecretsLike, type StateKeys } from './stateKeys';
import { archiveMeta, readArchive, unarchiveThread, type ArchiveBundle } from './threadArchive';
import type { ConversationStore, Transcript, TranscriptSummary } from './transcripts';

export type ThreadOrigin = 'panel' | 'chat-view';

/** A live thread is listed and continued as usual; an archived one is kept whole but tucked away (set by the archive, plan 07). */
export type ThreadState = 'live' | 'archived';

export interface ThreadMeta {
  id: string;
  title: string;
  model: string;
  origin: ThreadOrigin;
  createdAt: string;
  lastUsedAt: string;
  /** User messages on the main line. */
  turns: number;
  /** Entries in the log, every branch included. */
  entries: number;
  /** Size of the log file. */
  bytes: number;
  /** The id of the last entry of the main line, or '' for a thread with no log yet. */
  tip: string;
  /** Set when the thread's earliest messages are not all present, for a thread brought in from an older version. */
  history?: string;
  /** Absent means live. */
  state?: ThreadState;
}

/** One line of the history list: a thread's meta with its state settled, or a thread this device cannot open (locked, with no title or counts). */
export type ThreadIndexItem = Omit<ThreadMeta, 'state'> & { state: ThreadState; locked?: boolean };

export interface ThreadStoreOptions {
  writer: string;
  now?: () => Date;
}

const THREAD_ID = /^conv-[a-z0-9-]{6,60}$/;
const ROLES: readonly ThreadRole[] = ['user', 'assistant', 'tool-call', 'tool-result', 'notice'];

function assertThreadId(id: string): void {
  if (!THREAD_ID.test(id)) throw new Error('Invalid transcript id.');
}

/** Two copies of one thread's meta: the newer one's fields win, the last use is the later of the two, and the thread began at the earlier. */
export function mergeMeta(a: ThreadMeta, b: ThreadMeta): ThreadMeta {
  const newer = a.lastUsedAt !== b.lastUsedAt ? (a.lastUsedAt > b.lastUsedAt ? a : b) : (JSON.stringify(a) >= JSON.stringify(b) ? a : b);
  return { ...newer, createdAt: a.createdAt < b.createdAt ? a.createdAt : b.createdAt, lastUsedAt: a.lastUsedAt > b.lastUsedAt ? a.lastUsedAt : b.lastUsedAt };
}

/** A thread meta read from a file: only a complete, well-typed one for this thread id. */
export function validMeta(value: unknown, id: string): ThreadMeta | undefined {
  const meta = value as Partial<ThreadMeta> | null;
  if (!meta || typeof meta !== 'object' || meta.id !== id) return undefined;
  const strings = [meta.title, meta.model, meta.createdAt, meta.lastUsedAt, meta.tip];
  const numbers = [meta.turns, meta.entries, meta.bytes];
  if (strings.some((text) => typeof text !== 'string') || numbers.some((count) => typeof count !== 'number' || !Number.isFinite(count))) return undefined;
  return { ...(meta as ThreadMeta), origin: meta.origin === 'chat-view' ? 'chat-view' : 'panel' };
}

/** A thread entry read from a file: only a complete one that belongs to this thread. */
export function validEntry(value: unknown, thread: string): ThreadEntry | undefined {
  const entry = value as Partial<ThreadEntry> | null;
  if (!entry || typeof entry !== 'object' || entry.thread !== thread) return undefined;
  if (typeof entry.id !== 'string' || typeof entry.at !== 'string' || typeof entry.writer !== 'string') return undefined;
  if (entry.parent !== null && typeof entry.parent !== 'string') return undefined;
  if (!ROLES.includes(entry.role as ThreadRole)) return undefined;
  return entry as ThreadEntry;
}

/** A conversation read from an older version's storage, ready to merge into the state home. */
export interface ImportedThread {
  /** The conversation's entries, in chain order. */
  entries: readonly ThreadEntry[];
  /** Title, model, origin, the times, and `history` when the earlier messages are known to be missing; the counts are worked out from the log. */
  meta: Omit<ThreadMeta, 'id' | 'turns' | 'entries' | 'bytes' | 'tip' | 'state'>;
  /** The model's working list as that version saved it. */
  context: Transcript;
}

export type ImportOutcome = 'copied' | 'merged' | 'unchanged';

/** Whether `candidate` should replace `current` as a thread's saved context: the later one by `updatedAt`, equal times going to the greater text so the choice never depends on order. */
function laterContext(candidate: Transcript, current: Transcript): boolean {
  if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt;
  return canonicalJson(JSON.parse(JSON.stringify(candidate))) > canonicalJson(JSON.parse(JSON.stringify(current)));
}

interface Material { key: Buffer; stateId: string }

/** What is known of one thread's log without its bodies, so a new batch can be chained to the main-line tip without reading every message again. */
interface LogCache { offset: number; skeleton: ThreadEntry[]; ids: Set<string> }

export class ThreadStore implements ConversationStore {
  private readonly now: () => Date;
  private readonly writer: string;
  private readonly caches = new Map<string, LogCache>();
  /** The last entry of each thread that this store's conversation has: the parent of what it writes next, and what a saved context covers. */
  private readonly covered = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly home: ProjectStateHome, private readonly keys: StateKeys, options: ThreadStoreOptions) {
    this.writer = options.writer;
    this.now = options.now ?? (() => new Date());
  }

  // ---- paths and keys ---------------------------------------------------------------------------------------------------------------

  private dirOf(id: string): string { assertThreadId(id); return path.join(this.home.paths.threads, id); }
  private logPath(id: string): string { return path.join(this.dirOf(id), 'log.jsonl'); }
  private contextPath(id: string): string { return path.join(this.dirOf(id), 'context.enc'); }
  private metaPath(id: string): string { return path.join(this.dirOf(id), 'meta.enc'); }
  private get indexPath(): string { return path.join(this.home.paths.threads, 'index.enc'); }

  /** The key and state id, or undefined when this device cannot open the project's state. Creates nothing. */
  private async readMaterial(): Promise<Material | undefined> {
    const dataKey = await this.keys.dataKey();
    const meta = await this.home.readMeta();
    return dataKey && meta ? { key: subKey(dataKey, 'transcripts'), stateId: meta.stateId } : undefined;
  }

  /** The key and state id for a write, creating the state home and the key on the first one. */
  private async writeMaterial(): Promise<Material> {
    const meta = await this.home.ensure();
    return { key: await this.keys.transcriptKey(), stateId: meta.stateId };
  }

  private sealJson(material: Material, purpose: string, id: string, value: unknown): string {
    return JSON.stringify(seal(material.key, Buffer.from(JSON.stringify(value), 'utf8'), aadFor(material.stateId, purpose, id)));
  }

  private openJson(material: Material, purpose: string, id: string, text: string): unknown {
    return JSON.parse(openSealed(material.key, JSON.parse(text) as SealedBlob, aadFor(material.stateId, purpose, id)).toString('utf8'));
  }

  /** Changes to the store happen one after another, so two saves of one thread never interleave their reads and writes. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  // ---- the log ---------------------------------------------------------------------------------------------------------------------

  /**
   * Reads complete lines of the log from `offset`. A line that cannot be parsed or opened is skipped: a torn append, or a line moved here from another
   * thread (its AAD names its own thread). A last line without its newline is left for the next read, since the writer may still be appending it.
   */
  private async readFrom(id: string, material: Material, offset: number, file: string = this.logPath(id)): Promise<{ entries: ThreadEntry[]; end: number }> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(file, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], end: offset };
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (size <= offset) return { entries: [], end: offset };
      const buffer = Buffer.alloc(size - offset);
      let read = 0;
      while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, offset + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      const data = buffer.subarray(0, read);
      const last = data.lastIndexOf(0x0a);
      if (last < 0) return { entries: [], end: offset };
      const entries: ThreadEntry[] = [];
      for (const line of data.subarray(0, last).toString('utf8').split('\n')) {
        if (!line) continue;
        try {
          const entry = validEntry(this.openJson(material, 'thread-entry', id, line), id);
          if (entry) entries.push(entry);
        } catch { /* a torn or foreign line is skipped */ }
      }
      return { entries, end: offset + last + 1 };
    } finally {
      await handle.close();
    }
  }

  private async refresh(id: string, material: Material): Promise<LogCache> {
    let cache = this.caches.get(id);
    const size = (await stat(this.logPath(id)).catch(() => undefined))?.size ?? 0;
    if (!cache || size < cache.offset) { cache = { offset: 0, skeleton: [], ids: new Set() }; this.caches.set(id, cache); }
    const { entries, end } = await this.readFrom(id, material, cache.offset);
    for (const entry of entries) {
      if (cache.ids.has(entry.id)) continue;
      cache.ids.add(entry.id);
      cache.skeleton.push({ ...entry, body: null });
    }
    cache.offset = end;
    return cache;
  }

  /** Every entry of a thread, in time order, with all copies of one entry merged. Empty when the thread is not here or cannot be opened on this device. */
  public async entries(id: string): Promise<ThreadEntry[]> {
    await this.ensureLive(id);
    return this.liveEntries(id);
  }

  /** The entries of the thread's live log, whatever its state: an archived thread has none here. */
  public async liveEntries(id: string): Promise<ThreadEntry[]> {
    const material = await this.readMaterial();
    if (!material) return [];
    return unionEntries((await this.readFrom(id, material, 0)).entries, []);
  }

  /** A thread arranged for display: the main line and every other continuation. */
  public async lines(id: string): Promise<ThreadLines> {
    return threadLines(await this.entries(id));
  }

  /**
   * The stored output of one tool step of a thread, whole up to the 2 MiB cap (D-12): `entryId` is the id of the step's tool-call entry (what the card
   * carries), or of its tool-result entry. Undefined for an unknown entry, a call with no stored result, or a thread this device cannot open.
   */
  public async toolOutput(id: string, entryId: string): Promise<string | undefined> {
    assertThreadId(id);
    const lines = await this.lines(id);
    for (const segment of [lines.main, ...lines.branches.map((branch) => branch.entries)]) {
      const own = segment.find((entry) => entry.id === entryId);
      const result = own?.role === 'tool-result' ? own : pairToolResults(segment).get(entryId);
      const output = (result?.body as { output?: unknown } | undefined)?.output;
      if (typeof output === 'string') return output;
    }
    return undefined;
  }

  /** Adds entries to a thread's log. An entry already in the log (same id) is not added twice. Nothing is removed. */
  public appendEntries(id: string, entries: readonly ThreadEntry[]): Promise<void> {
    assertThreadId(id);
    return this.enqueue(async () => { await this.append(id, entries, await this.writeMaterial()); });
  }

  /** The append itself; callers hold the queue. Returns the id of the last entry of this conversation's own line afterwards (`after` when nothing was added). */
  private async append(id: string, entries: readonly ThreadEntry[], material: Material, info: Partial<Pick<ThreadMeta, 'title' | 'model' | 'origin'>> = {}, after = ''): Promise<string> {
    for (const entry of entries) if (entry.thread !== id) throw new Error('An entry belongs to another conversation.');
    let cache = await this.refresh(id, material);
    const fresh: ThreadEntry[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (cache.ids.has(entry.id) || seen.has(entry.id)) continue;
      seen.add(entry.id);
      fresh.push(entry);
    }
    if (fresh.length) {
      await this.home.ensureFolder(this.dirOf(id));
      const file = this.logPath(id);
      let prefix = '';
      const size = (await stat(file).catch(() => undefined))?.size ?? 0;
      if (size > 0) {
        // A torn earlier append has no newline: the next line starts on its own line, so neither is lost to the other.
        const handle = await open(file, 'r');
        try {
          const last = Buffer.alloc(1);
          await handle.read(last, 0, 1, size - 1);
          if (last[0] !== 0x0a) prefix = '\n';
        } finally {
          await handle.close();
        }
      }
      const text = fresh.map((entry) => this.sealJson(material, 'thread-entry', id, entry)).join('\n');
      // One appendFile for the whole batch: a reader sees all of it or a torn last line, which it skips.
      await appendFile(file, `${prefix}${text}\n`, { mode: 0o600 });
      cache = await this.refresh(id, material);
    }
    if (!fresh.length) return after;
    const lines = threadLines(cache.skeleton);
    await this.updateMeta(id, material, { ...info, tip: lines.main.at(-1)?.id ?? '', entries: cache.ids.size, bytes: cache.offset, turns: lines.main.filter((entry) => entry.role === 'user').length });
    const last = fresh[fresh.length - 1].id;
    this.covered.set(id, last);
    return last;
  }

  /** Says which entry a conversation's context covers, so what it writes next continues from there (reopening a thread sets this). */
  public cover(id: string, tip: string): void {
    assertThreadId(id);
    if (tip) this.covered.set(id, tip); else this.covered.delete(id);
  }

  // ---- meta, index, context --------------------------------------------------------------------------------------------------------

  /** One thread's meta, or undefined when it has none or this device cannot open it. */
  public async meta(id: string): Promise<ThreadMeta | undefined> {
    assertThreadId(id);
    const material = await this.readMaterial();
    return material ? this.readMeta(id, material) : undefined;
  }

  private async readMeta(id: string, material: Material): Promise<ThreadMeta | undefined> {
    try {
      return validMeta(this.openJson(material, 'thread-meta', id, await readFile(this.metaPath(id), 'utf8')), id);
    } catch {
      return undefined;
    }
  }

  private async updateMeta(id: string, material: Material, patch: Partial<ThreadMeta>): Promise<ThreadMeta> {
    const existing = await this.readMeta(id, material);
    const at = this.now().toISOString();
    const base: ThreadMeta = existing ?? { id, title: 'Conversation', model: '', origin: 'panel', createdAt: at, lastUsedAt: at, turns: 0, entries: 0, bytes: 0, tip: '' };
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<ThreadMeta>;
    const next: ThreadMeta = { ...base, ...defined, id, lastUsedAt: patch.lastUsedAt && patch.lastUsedAt > base.lastUsedAt ? patch.lastUsedAt : at > base.lastUsedAt ? at : base.lastUsedAt };
    await this.home.ensureFolder(this.dirOf(id));
    await writeFileAtomic(this.metaPath(id), this.sealJson(material, 'thread-meta', id, next));
    return next;
  }

  private async readIndex(material: Material): Promise<ThreadMeta[]> {
    try {
      const value = this.openJson(material, 'thread-index', 'all', await readFile(this.indexPath, 'utf8'));
      if (!Array.isArray(value)) return [];
      return value.map((item) => validMeta(item, (item as { id?: string })?.id ?? '')).filter((meta): meta is ThreadMeta => Boolean(meta && THREAD_ID.test(meta.id)));
    } catch {
      return [];
    }
  }

  private async writeIndex(material: Material, metas: readonly ThreadMeta[]): Promise<void> {
    await this.home.ensureFolder(this.home.paths.threads);
    await writeFileAtomic(this.indexPath, this.sealJson(material, 'thread-index', 'all', [...metas].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))));
  }

  /** Records a thread's meta in the index cache, merged with what is there. */
  private async indexThread(material: Material, meta: ThreadMeta): Promise<void> {
    const merged = new Map<string, ThreadMeta>();
    for (const item of [...await this.readIndex(material), meta]) merged.set(item.id, merged.has(item.id) ? mergeMeta(merged.get(item.id)!, item) : item);
    await this.writeIndex(material, [...merged.values()]);
  }

  /** The folders of threads on disk. */
  private async threadFolders(): Promise<string[]> {
    return (await readdir(this.home.paths.threads, { withFileTypes: true }).catch(() => [])).filter((item) => item.isDirectory() && THREAD_ID.test(item.name)).map((item) => item.name);
  }

  /**
   * Every thread's meta: the index cache and each thread's own meta merged, so a thread the index does not know (written by another editor, or an
   * index lost to a crash) is still found. Threads whose meta cannot be opened on this device are returned as `locked`.
   */
  private async scan(): Promise<{ metas: ThreadMeta[]; locked: Array<{ id: string; updatedAt: string }> }> {
    const folders = await this.threadFolders();
    const archived = new Set(await this.archivedIds());
    const material = await this.readMaterial();
    const lockedOf = async (id: string) => ({ id, updatedAt: (await stat(path.join(this.home.paths.threads, id)).catch(() => undefined))?.mtime.toISOString() ?? '' });
    const lockedArchive = async (id: string) => ({ id, updatedAt: (await stat(path.join(this.home.paths.archive, id, 'parts.json')).catch(() => undefined))?.mtime.toISOString() ?? '' });
    if (!material) return { metas: [], locked: [...await Promise.all(folders.map(lockedOf)), ...await Promise.all([...archived].filter((id) => !folders.includes(id)).map(lockedArchive))] };
    const merged = new Map<string, ThreadMeta>();
    const add = (meta: ThreadMeta): void => { const current = merged.get(meta.id); merged.set(meta.id, current ? mergeMeta(current, meta) : meta); };
    for (const meta of await this.readIndex(material)) add(meta);
    const locked: Array<{ id: string; updatedAt: string }> = [];
    // A thread with a live meta is live, whatever the index cache says; one with only an archive is archived (the files decide, so a crash between the
    // two steps of archiving never leaves the list wrong).
    const live = new Set<string>();
    for (const id of folders) {
      const meta = await this.readMeta(id, material);
      if (meta) { add(meta); live.add(id); continue; }
      if (merged.has(id)) continue;
      const rebuilt = await this.rebuildMeta(id, material);
      if (rebuilt) { add(rebuilt); live.add(id); } else if (!archived.has(id)) locked.push(await lockedOf(id));
    }
    // An archive the index does not know (the index was lost): its title and counts are read from the archive itself.
    for (const id of archived) {
      if (merged.has(id) || live.has(id)) continue;
      const meta = await archiveMeta(this, id).catch(() => undefined);
      if (meta) add(meta); else locked.push(await lockedArchive(id));
    }
    const metas = [...merged.values()].map((meta): ThreadMeta => {
      const { state: _state, ...rest } = meta;
      return live.has(meta.id) || !(archived.has(meta.id) || meta.state === 'archived') ? rest : { ...rest, state: 'archived' };
    });
    return { metas, locked };
  }

  /** A thread folder with a log but no meta (a crash between the two writes): its meta is rebuilt from the log. Undefined when the log cannot be opened. */
  private async rebuildMeta(id: string, material: Material): Promise<ThreadMeta | undefined> {
    const { entries } = await this.readFrom(id, material, 0);
    if (!entries.length) return undefined;
    const ordered = unionEntries(entries, []);
    const lines = threadLines(ordered);
    const first = lines.main.find((entry) => entry.role === 'user');
    const text = first && typeof (first.body as { text?: unknown })?.text === 'string' ? (first.body as { text: string }).text : 'Conversation';
    return {
      id, title: text.replace(/\s+/g, ' ').slice(0, 80) || 'Conversation', model: '', origin: 'panel', createdAt: ordered[0].at, lastUsedAt: ordered[ordered.length - 1].at,
      turns: lines.main.filter((entry) => entry.role === 'user').length, entries: ordered.length, bytes: (await stat(this.logPath(id)).catch(() => undefined))?.size ?? 0, tip: lines.main.at(-1)?.id ?? ''
    };
  }

  /**
   * Every thread of the project for the history list, newest use first: the meta of each thread this device can open (from the index and the threads'
   * own small meta files, never from a log), and a locked line for each it cannot.
   */
  public async index(): Promise<ThreadIndexItem[]> {
    const { metas, locked } = await this.scan();
    const items: ThreadIndexItem[] = metas.map((meta) => ({ ...meta, state: meta.state === 'archived' ? 'archived' : 'live' }));
    for (const item of locked) {
      items.push({ id: item.id, title: '', model: '', origin: 'panel', createdAt: item.updatedAt, lastUsedAt: item.updatedAt, turns: 0, entries: 0, bytes: 0, tip: '', state: 'live', locked: true });
    }
    return items.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || a.id.localeCompare(b.id));
  }

  /** Creates a thread's meta, or returns the one it has. Writes no log. */
  public create(meta: Pick<ThreadMeta, 'id' | 'title' | 'model' | 'origin'> & Partial<ThreadMeta>): Promise<ThreadMeta> {
    assertThreadId(meta.id);
    return this.enqueue(async () => {
      const material = await this.writeMaterial();
      const existing = await this.readMeta(meta.id, material);
      if (existing) return existing;
      const at = this.now().toISOString();
      const created = await this.updateMeta(meta.id, material, { createdAt: at, lastUsedAt: at, turns: 0, entries: 0, bytes: 0, tip: '', ...meta });
      await this.indexThread(material, created);
      return created;
    });
  }

  // ---- archive support (D-08, plan 07; used by threadArchive.ts) ------------------------------------------------------------------

  private archiveFolderOf(id: string): string { assertThreadId(id); return path.join(this.home.paths.archive, id); }

  /** The folder an archived thread is kept in: archive/<id>/. */
  public archiveDirOf(id: string): string { return this.archiveFolderOf(id); }

  /** The data key and state id the archive is sealed with, or undefined when this device cannot open the project's state. Creates nothing. */
  public async archiveKeys(): Promise<{ dataKey: Buffer; stateId: string } | undefined> {
    const dataKey = await this.keys.dataKey();
    const meta = await this.home.readMeta();
    return dataKey && meta ? { dataKey, stateId: meta.stateId } : undefined;
  }

  /** The ids of the threads that have an archive (a complete parts.json), in no particular order. */
  public async archivedIds(): Promise<string[]> {
    const found: string[] = [];
    for (const item of await readdir(this.home.paths.archive, { withFileTypes: true }).catch(() => [])) {
      if (!item.isDirectory() || !THREAD_ID.test(item.name)) continue;
      if ((await stat(path.join(this.home.paths.archive, item.name, 'parts.json')).catch(() => undefined))?.isFile()) found.push(item.name);
    }
    return found;
  }

  /** Makes the thread's archive folder, owner-only. */
  public async ensureArchiveDir(id: string): Promise<string> {
    const dir = this.archiveFolderOf(id);
    await this.home.ensureFolder(dir);
    return dir;
  }

  /** What is on disk of the thread's live copy. A folder may hold any of the three after a crash in the middle of archiving. */
  public async liveFiles(id: string): Promise<{ log: boolean; context: boolean; meta: boolean }> {
    const has = async (file: string) => Boolean((await stat(file).catch(() => undefined))?.isFile());
    return { log: await has(this.logPath(id)), context: await has(this.contextPath(id)), meta: await has(this.metaPath(id)) };
  }

  /** Work on one thread's files one after another: an archive, a reopen and a reconcile of the same thread never overlap. */
  private readonly busy = new Map<string, Promise<unknown>>();
  public serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const result = (this.busy.get(id) ?? Promise.resolve()).then(work, work);
    const tail = result.catch(() => undefined);
    this.busy.set(id, tail);
    void tail.then(() => { if (this.busy.get(id) === tail) this.busy.delete(id); });
    return result;
  }

  /** Whether the thread is being archived or reopened right now. */
  public isBusy(id: string): boolean { return this.busy.has(id); }

  /**
   * A thread that is archived and has no live log comes back whole before it is read, so opening one is transparent (D-08). A refused or missing archive
   * changes nothing: the caller then finds no entries, exactly like a thread this device cannot open.
   */
  private async ensureLive(id: string): Promise<void> {
    if (!THREAD_ID.test(id)) return;
    if ((await stat(this.logPath(id)).catch(() => undefined))?.isFile()) return;
    if (!(await stat(path.join(this.archiveFolderOf(id), 'parts.json')).catch(() => undefined))?.isFile()) return;
    await unarchiveThread(this, id).catch(() => undefined);
  }

  /**
   * The live copy of a thread as it is now, for archiving: raw entries (every branch), the saved context, the meta, and a stamp of the three files so
   * the removal that follows can tell whether anything changed while the archive was written and checked. Undefined when there is nothing to archive.
   */
  public async liveSnapshot(id: string): Promise<{ entries: ThreadEntry[]; context: Transcript | null; meta: ThreadMeta; stamp: string } | undefined> {
    const material = await this.readMaterial();
    if (!material) return undefined;
    const stamp = await this.liveStamp(id);
    const meta = (await this.readMeta(id, material)) ?? (await this.rebuildMeta(id, material));
    if (!meta) return undefined;
    const entries = unionEntries((await this.readFrom(id, material, 0)).entries, []);
    let context: Transcript | null = null;
    try {
      const value = this.openJson(material, 'thread-context', id, await readFile(this.contextPath(id), 'utf8')) as Transcript;
      if (value && value.id === id && Array.isArray(value.messages)) context = value;
    } catch { /* no saved context: the thread is archived with its log and meta */ }
    const { state: _state, ...plain } = meta;
    return { entries, context, meta: plain, stamp };
  }

  private async liveStamp(id: string): Promise<string> {
    const size = (await stat(this.logPath(id)).catch(() => undefined))?.size ?? 0;
    const text = async (file: string) => readFile(file, 'utf8').catch(() => '');
    return createHash('sha256').update(`${size}\n${await text(this.contextPath(id))}\n${await text(this.metaPath(id))}`).digest('hex');
  }

  /**
   * Removes the live copy of a thread whose archive has been written and checked, but only if its files are still the ones the archive was made from
   * (`stamp`): a thread that was used in the meantime is left as it is. The index is told first; then the log, the context and the meta go, in that
   * order, meta last, so a crash leaves a thread that reconcileArchives can finish or reverse. Returns whether the live copy was removed.
   */
  public removeLive(id: string, snapshot: { meta: ThreadMeta; stamp: string }): Promise<boolean> {
    assertThreadId(id);
    return this.enqueue(async () => {
      const material = await this.readMaterial();
      if (!material || await this.liveStamp(id) !== snapshot.stamp) return false;
      await this.replaceIndexEntry(material, { ...snapshot.meta, state: 'archived' });
      for (const file of [this.logPath(id), this.contextPath(id), this.metaPath(id)]) await rm(file, { force: true });
      await rmdir(this.dirOf(id)).catch(() => undefined);
      this.caches.delete(id);
      return true;
    });
  }

  /** Puts one thread's line in the index cache exactly as given (no merge), for a state change. */
  private async replaceIndexEntry(material: Material, meta: ThreadMeta): Promise<void> {
    const rest = (await this.readIndex(material)).filter((item) => item.id !== meta.id);
    await this.writeIndex(material, [...rest, meta]);
  }

  /**
   * Brings an archived thread's content into its live folder: every entry is added to the log (union; one already there is not added twice), the
   * saved context is written unless a live one exists, and the meta is merged with a live one. `touch` makes the thread the most recently used, as
   * opening it does; a restore the rank rule or a crash recovery asks for leaves its time alone. Returns the live entry ids afterwards.
   */
  public restoreLive(id: string, bundle: ArchiveBundle, touch: boolean): Promise<Set<string>> {
    assertThreadId(id);
    return this.enqueue(async () => {
      const material = await this.writeMaterial();
      // Read before the append, which makes a default meta when there is none.
      const existing = await this.readMeta(id, material);
      const earlier = this.covered.get(id);
      await this.append(id, bundle.entries, material);
      if (earlier === undefined) this.covered.delete(id); else this.covered.set(id, earlier);
      const cache = await this.refresh(id, material);
      await this.home.ensureFolder(this.dirOf(id));
      if (bundle.context && !(await stat(this.contextPath(id)).catch(() => undefined))?.isFile()) {
        await writeFileAtomic(this.contextPath(id), this.sealJson(material, 'thread-context', id, bundle.context));
      }
      const base = existing ? mergeMeta(existing, bundle.meta) : bundle.meta;
      const lines = threadLines(cache.skeleton);
      const { state: _state, ...plain } = base;
      const next: ThreadMeta = { ...plain, id, tip: lines.main.at(-1)?.id ?? '', entries: cache.ids.size, bytes: cache.offset, turns: lines.main.filter((entry) => entry.role === 'user').length, lastUsedAt: touch && this.now().toISOString() > base.lastUsedAt ? this.now().toISOString() : base.lastUsedAt };
      await writeFileAtomic(this.metaPath(id), this.sealJson(material, 'thread-meta', id, next));
      await this.replaceIndexEntry(material, next);
      return new Set(cache.ids);
    });
  }

  // ---- import of an older version's conversation (D-05, plan 10; used by stateMigration.ts) -----------------------------------------

  /**
   * Merges a conversation brought in from an editor's own storage (0.4.19 and earlier) into the thread of the same id. Entries are added by id (an entry
   * already there is not written twice), the saved context is replaced only by a later one (by its `updatedAt`), and the meta is merged the way two copies
   * of one thread's meta always are, so a thread that was continued here since is never set back. A thread that is archived gets the missing entries in
   * its archive's delta file and is not brought back. Nothing is removed. When there is nothing to add, nothing is written (and no state home is made).
   */
  public importThread(id: string, thread: ImportedThread): Promise<ImportOutcome> {
    assertThreadId(id);
    return this.serial(id, async () => {
      const archived = !(await this.liveFiles(id)).log && Boolean((await stat(path.join(this.archiveFolderOf(id), 'parts.json')).catch(() => undefined))?.isFile());
      if (archived) {
        const bundle = await readArchive(this, id);
        const held = new Set([...bundle.entries, ...await this.archiveDeltaEntries(id)].map((entry) => entry.id));
        const missing = thread.entries.filter((entry) => !held.has(entry.id));
        if (!missing.length) return 'unchanged';
        await this.appendArchiveDelta(id, missing);
        return 'merged';
      }
      return this.enqueue(() => this.importLive(id, thread));
    });
  }

  private async importLive(id: string, thread: ImportedThread): Promise<ImportOutcome> {
    for (const entry of thread.entries) if (entry.thread !== id) throw new Error('An entry belongs to another conversation.');
    const material = (await this.readMaterial()) ?? await this.writeMaterial();
    const before = await this.refresh(id, material);
    const fresh = thread.entries.filter((entry) => !before.ids.has(entry.id));
    const existing = await this.readMeta(id, material);
    const existingContext = await this.readContextOf(id, material);
    const known = before.ids.size > 0 || Boolean(existing) || Boolean(existingContext);
    const earlier = this.covered.get(id);
    if (fresh.length) await this.append(id, fresh, material);
    if (earlier === undefined) this.covered.delete(id); else this.covered.set(id, earlier);
    const cache = await this.refresh(id, material);
    const lines = threadLines(cache.skeleton);
    const counted = { turns: lines.main.filter((entry) => entry.role === 'user').length, entries: cache.ids.size, bytes: cache.offset, tip: lines.main.at(-1)?.id ?? '' };
    const brought: ThreadMeta = { ...thread.meta, id, ...counted };
    const merged = existing ? mergeMeta(existing, brought) : brought;
    const { state: _state, ...plain } = merged;
    const next: ThreadMeta = { ...plain, ...counted };
    const metaChanged = !existing || canonicalJson(JSON.parse(JSON.stringify(existing))) !== canonicalJson(JSON.parse(JSON.stringify(next)));
    const context: Transcript = JSON.parse(JSON.stringify({ ...thread.context, basedOnTip: thread.entries.at(-1)?.id ?? '' }));
    const contextChanged = !existingContext || laterContext(context, existingContext);
    if (!fresh.length && !metaChanged && !contextChanged) return 'unchanged';
    await this.home.ensureFolder(this.dirOf(id));
    if (contextChanged) await writeFileAtomic(this.contextPath(id), this.sealJson(material, 'thread-context', id, context));
    // The meta goes last, as everywhere: a crash before it leaves a thread the next pass finishes.
    if (metaChanged || fresh.length) {
      await writeFileAtomic(this.metaPath(id), this.sealJson(material, 'thread-meta', id, next));
      await this.indexThread(material, next);
    }
    return known ? 'merged' : 'copied';
  }

  private async readContextOf(id: string, material: Material): Promise<Transcript | undefined> {
    try {
      const value = this.openJson(material, 'thread-context', id, await readFile(this.contextPath(id), 'utf8')) as Transcript;
      return value && value.id === id && Array.isArray(value.messages) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** Adds entries to the archive's delta file (sealed lines, as in a log), for entries a thread gained while archived. Nothing in the archive is rewritten. */
  public appendArchiveDelta(id: string, entries: readonly ThreadEntry[]): Promise<void> {
    assertThreadId(id);
    return this.enqueue(async () => {
      const material = await this.readMaterial();
      if (!material) throw new Error('This project has no saved state yet.');
      for (const entry of entries) if (entry.thread !== id) throw new Error('An entry belongs to another conversation.');
      if (!entries.length) return;
      const dir = await this.ensureArchiveDir(id);
      await appendFile(path.join(dir, 'delta.jsonl'), `${entries.map((entry) => this.sealJson(material, 'thread-entry', id, entry)).join('\n')}\n`, { mode: 0o600 });
    });
  }

  /** The entries of an archive's delta file; none when there is no file or this device cannot open it. */
  public async archiveDeltaEntries(id: string): Promise<ThreadEntry[]> {
    const material = await this.readMaterial();
    if (!material) return [];
    return unionEntries((await this.readFrom(id, material, 0, path.join(this.archiveFolderOf(id), 'delta.jsonl'))).entries, []);
  }

  // ---- ConversationStore -----------------------------------------------------------------------------------------------------------

  public save(transcript: Transcript): Promise<void> {
    return this.write(transcript, true);
  }

  /** Saves a running conversation's state; the index cache is left for the save at the end of the run. */
  public checkpoint(transcript: Transcript): Promise<void> {
    return this.write(transcript, false);
  }

  private write(transcript: Transcript, index: boolean): Promise<void> {
    assertThreadId(transcript.id);
    return this.enqueue(async () => {
      const material = await this.writeMaterial();
      const cache = await this.refresh(transcript.id, material);
      await this.home.ensureFolder(this.dirOf(transcript.id));
      const saved: Transcript = { ...transcript, basedOnTip: transcript.basedOnTip ?? this.covered.get(transcript.id) ?? threadTip(cache.skeleton) ?? '' };
      await writeFileAtomic(this.contextPath(transcript.id), this.sealJson(material, 'thread-context', transcript.id, saved));
      // A thread that has no log (saved without capture) is described by the transcript; one with a log is described by the log.
      const existing = await this.readMeta(transcript.id, material);
      const meta = await this.updateMeta(transcript.id, material, {
        title: transcript.title, model: transcript.model, lastUsedAt: transcript.updatedAt,
        ...(cache.ids.size === 0 ? { turns: transcript.turns } : {}), ...(existing ? {} : { origin: 'panel' as const })
      });
      if (index) await this.indexThread(material, meta);
    });
  }

  public async load(id: string): Promise<Transcript | undefined> {
    if (!THREAD_ID.test(id)) return undefined;
    await this.ensureLive(id);
    const material = await this.readMaterial();
    if (!material) return undefined;
    try {
      const value = this.openJson(material, 'thread-context', id, await readFile(this.contextPath(id), 'utf8')) as Transcript;
      if (!value || value.id !== id || !Array.isArray(value.messages)) return await this.contextFromLog(id, material);
      this.cover(id, typeof value.basedOnTip === 'string' ? value.basedOnTip : '');
      return value;
    } catch {
      return this.contextFromLog(id, material);
    }
  }

  /**
   * The context of a thread that has a log and no saved context (one begun in the Chat view, where no run ever saved a working list), built from the
   * log's main line the way a thread continued elsewhere is. It has no system prompt: the run that continues it adds the panel's own.
   */
  private async contextFromLog(id: string, material: Material): Promise<Transcript | undefined> {
    const lines = threadLines(await this.liveEntries(id));
    const tip = lines.main.at(-1)?.id;
    if (!tip) return undefined;
    const meta = (await this.readMeta(id, material)) ?? (await this.rebuildMeta(id, material));
    this.cover(id, tip);
    return {
      id, title: meta?.title ?? 'Conversation', model: meta?.model ?? '', updatedAt: meta?.lastUsedAt ?? lines.main.at(-1)!.at,
      turns: lines.main.filter((entry) => entry.role === 'user').length, messages: entriesToMessages(lines.main), display: [], basedOnTip: tip
    };
  }

  public async list(): Promise<TranscriptSummary[]> {
    const { metas, locked } = await this.scan();
    const summaries: TranscriptSummary[] = metas.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)).map((meta) => ({ id: meta.id, title: meta.title, model: meta.model, updatedAt: meta.lastUsedAt, turns: meta.turns }));
    for (const item of locked) summaries.push({ id: item.id, title: '', model: '', updatedAt: item.updatedAt, turns: 0, locked: true });
    return summaries;
  }

  // ---- capture ---------------------------------------------------------------------------------------------------------------------

  /**
   * Writes the messages of `transcript` that are not in `logged` to the thread's log, chained from the main-line tip, then marks them logged. Called
   * before the model's context is trimmed or compacted, so the log holds the originals. Messages only the model sees (the system prompt, a summary)
   * are marked logged without being written.
   */
  public captureTranscript(transcript: Transcript, display: ReadonlyMap<string, string>, logged: WeakSet<AgentMessage>): Promise<void> {
    assertThreadId(transcript.id);
    return this.enqueue(async () => {
      const fresh = transcript.messages.filter((message) => !logged.has(message));
      const real = fresh.filter((message) => !isSyntheticMessage(message));
      // Nothing to write: do not create the state home for a conversation that has only its system prompt.
      if (!real.length) { for (const message of fresh) logged.add(message); return; }
      const material = await this.writeMaterial();
      const cache = await this.refresh(transcript.id, material);
      // Continues from the entry this conversation last wrote or was opened at. A conversation this store knows nothing about starts its chain from the
      // beginning, so messages the log already holds get the ids they already have and are not written twice.
      const parent = this.covered.get(transcript.id) ?? '';
      const entries = messagesToEntries(real, display, parent || null, { thread: transcript.id, writer: this.writer, at: this.now().toISOString() });
      await this.append(transcript.id, entries, material, { title: transcript.title, model: transcript.model }, parent);
      for (const message of fresh) logged.add(message);
    });
  }
}

/** What the history list says of a thread this device cannot open. */
export const LOCKED_DETAIL = 'Locked on this device: enter your recovery code to open it';

/** One entry of the history list, in the shape of a VS Code QuickPick item. */
export interface HistoryItem { id: string; label: string; description: string; detail: string; locked: boolean }

/**
 * The history list (D-08): one item per thread of the index, newest use first and then by id. The label is the title, so typing filters by title; the
 * description counts messages and says where it was asked (the Chat view) and whether it is archived; a locked thread says so and is never opened.
 * `format` words a time (the local time by default).
 */
export function historyItems(index: readonly ThreadIndexItem[], format: (iso: string) => string = (iso) => new Date(iso).toLocaleString()): HistoryItem[] {
  return [...index].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt) || a.id.localeCompare(b.id)).map((item): HistoryItem => {
    if (item.locked) return { id: item.id, label: 'Locked conversation', description: `Locked · ${item.id}`, detail: LOCKED_DETAIL, locked: true };
    const description = [`${item.turns} message${item.turns === 1 ? '' : 's'}`, ...(item.origin === 'chat-view' ? ['Chat view'] : []), ...(item.state === 'archived' ? ['Archived'] : [])].join(' · ');
    const detail = [format(item.lastUsedAt), ...(item.model ? [item.model] : []), ...(item.history === PARTIAL_HISTORY ? [PARTIAL_HISTORY_NOTE] : [])].join(' · ');
    return { id: item.id, label: item.title || 'Conversation', description, detail, locked: false };
  });
}

const stores = new WeakMap<object, Map<string, ThreadStore>>();

/** A host that gives no secret storage keeps the data key only in the project's key file: nothing is read from or kept in a device copy. */
const NO_SECRETS: SecretsLike = { get: async () => undefined, store: async () => undefined, delete: async () => undefined };

/** One ThreadStore per project folder and secret store, built from that folder's state home and keys. Making it touches nothing on disk. */
export function threadStoreFor(root: string, secrets: SecretsLike | undefined, writer: string, keepKeyInProject?: () => boolean): ThreadStore {
  const resolved = path.resolve(root);
  const owner = secrets ?? NO_SECRETS;
  let byRoot = stores.get(owner);
  if (!byRoot) { byRoot = new Map(); stores.set(owner, byRoot); }
  let store = byRoot.get(resolved);
  if (!store) {
    store = new ThreadStore(stateHomeFor(resolved), stateKeysFor(resolved, owner, keepKeyInProject), { writer });
    byRoot.set(resolved, store);
  }
  return store;
}
