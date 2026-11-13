// The thread store (D-04, D-07): every conversation of the project, kept in the state home so every editor on this computer lists and reopens the same
// ones. A thread is a folder, threads/<id>/, holding:
//   log.jsonl   the append-only record of what was said and done, one sealed entry per line, written before the model's context is trimmed;
//   context.enc the model's working list (what a resumed run continues from), replaced whole;
//   meta.enc    the title, model, counts and tip, replaced whole.
// threads/index.enc is a cache of every thread's meta. Everything is sealed with the transcript subkey of the project's data key; no vscode here.
//
// Nothing here deletes a thread or an entry. A thread whose key is not available on this device is listed as locked, never dropped.
import { appendFile, open, readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { aadFor, open as openSealed, seal, subKey, type SealedBlob } from '../domain/state/keys';
import { isSyntheticMessage, messagesToEntries } from '../domain/state/threadCapture';
import { threadLines, threadTip, unionEntries, type ThreadEntry, type ThreadLines, type ThreadRole } from '../domain/state/threadEntries';
import type { AgentMessage } from './nearAiClient';
import { ProjectStateHome, stateHomeFor, writeFileAtomic } from './stateHome';
import { stateKeysFor, type SecretsLike, type StateKeys } from './stateKeys';
import type { ConversationStore, Transcript, TranscriptSummary } from './transcripts';

export type ThreadOrigin = 'panel' | 'chat-view';

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
}

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

function validMeta(value: unknown, id: string): ThreadMeta | undefined {
  const meta = value as Partial<ThreadMeta> | null;
  if (!meta || typeof meta !== 'object' || meta.id !== id) return undefined;
  const strings = [meta.title, meta.model, meta.createdAt, meta.lastUsedAt, meta.tip];
  const numbers = [meta.turns, meta.entries, meta.bytes];
  if (strings.some((text) => typeof text !== 'string') || numbers.some((count) => typeof count !== 'number' || !Number.isFinite(count))) return undefined;
  return { ...(meta as ThreadMeta), origin: meta.origin === 'chat-view' ? 'chat-view' : 'panel' };
}

function validEntry(value: unknown, thread: string): ThreadEntry | undefined {
  const entry = value as Partial<ThreadEntry> | null;
  if (!entry || typeof entry !== 'object' || entry.thread !== thread) return undefined;
  if (typeof entry.id !== 'string' || typeof entry.at !== 'string' || typeof entry.writer !== 'string') return undefined;
  if (entry.parent !== null && typeof entry.parent !== 'string') return undefined;
  if (!ROLES.includes(entry.role as ThreadRole)) return undefined;
  return entry as ThreadEntry;
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
  private async readFrom(id: string, material: Material, offset: number): Promise<{ entries: ThreadEntry[]; end: number }> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.logPath(id), 'r');
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
    const material = await this.readMaterial();
    if (!material) return [];
    return unionEntries((await this.readFrom(id, material, 0)).entries, []);
  }

  /** A thread arranged for display: the main line and every other continuation. */
  public async lines(id: string): Promise<ThreadLines> {
    return threadLines(await this.entries(id));
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
    const material = await this.readMaterial();
    const lockedOf = async (id: string) => ({ id, updatedAt: (await stat(path.join(this.home.paths.threads, id)).catch(() => undefined))?.mtime.toISOString() ?? '' });
    if (!material) return { metas: [], locked: await Promise.all(folders.map(lockedOf)) };
    const merged = new Map<string, ThreadMeta>();
    const add = (meta: ThreadMeta): void => { const current = merged.get(meta.id); merged.set(meta.id, current ? mergeMeta(current, meta) : meta); };
    for (const meta of await this.readIndex(material)) add(meta);
    const locked: Array<{ id: string; updatedAt: string }> = [];
    for (const id of folders) {
      const meta = await this.readMeta(id, material);
      if (meta) { add(meta); continue; }
      if (merged.has(id)) continue;
      const rebuilt = await this.rebuildMeta(id, material);
      if (rebuilt) add(rebuilt); else locked.push(await lockedOf(id));
    }
    return { metas: [...merged.values()], locked };
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

  /** The meta of every thread this device can open, newest use first. */
  public async index(): Promise<ThreadMeta[]> {
    return (await this.scan()).metas.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
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
    const material = await this.readMaterial();
    if (!material) return undefined;
    try {
      const value = this.openJson(material, 'thread-context', id, await readFile(this.contextPath(id), 'utf8')) as Transcript;
      if (!value || value.id !== id || !Array.isArray(value.messages)) return undefined;
      this.cover(id, typeof value.basedOnTip === 'string' ? value.basedOnTip : '');
      return value;
    } catch {
      return undefined;
    }
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

const stores = new WeakMap<object, Map<string, ThreadStore>>();

/** One ThreadStore per project folder and secret store, built from that folder's state home and keys. Making it touches nothing on disk. */
export function threadStoreFor(root: string, secrets: SecretsLike, writer: string, keepKeyInProject?: () => boolean): ThreadStore {
  const resolved = path.resolve(root);
  let byRoot = stores.get(secrets);
  if (!byRoot) { byRoot = new Map(); stores.set(secrets, byRoot); }
  let store = byRoot.get(resolved);
  if (!store) {
    store = new ThreadStore(stateHomeFor(resolved), stateKeysFor(resolved, secrets, keepKeyInProject), { writer });
    byRoot.set(resolved, store);
  }
  return store;
}
