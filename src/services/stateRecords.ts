// What of the state home moves between computers, and how it goes in and out (SYNC-05, D-09). collectLocal reads the state home into thread entries and
// records; applyMerged writes what a merge brought in, through each kind's own store, validating every id before it becomes a path (T-27-51).
// Only the kinds in SYNCED_KINDS ever leave the machine: nothing else in the state home or beside it (security-scan consent, the emergency stop, the
// spend reporting token id, the saved-profile index, Team Mode, cyber engagement data) is read here. No vscode.
import { mergeRecordSets } from '../domain/state/merge';
import { makeRecord, type RecordKind, type StateRecord } from '../domain/state/records';
import { unionEntries, type ThreadEntry } from '../domain/state/threadEntries';
import type { RunMarker, RunState } from './runMarkers';
import { readArchive } from './threadArchive';
import { validEntry, type ThreadMeta, type ThreadStore } from './threadStore';
import type { Transcript } from './transcripts';
import type { ProjectStateHome } from './stateHome';

/** The only record kinds that are collected, sent or applied. A tombstone is allowed when it deletes one of these. */
export const SYNCED_KINDS: readonly RecordKind[] = ['thread-meta', 'thread-context', 'marker', 'checkpoint', 'comparison', 'choice', 'spend', 'pickup', 'profile', 'secret'];
/** At most this many of the newest runs' checkpoints sync, within CHECKPOINT_SYNC_BYTES in total (Pitfall 5). */
export const CHECKPOINT_SYNC_RUNS = 10;
export const CHECKPOINT_SYNC_BYTES = 25 * 1024 * 1024;

const SYNCED = new Set<string>(SYNCED_KINDS);
export const THREAD_ID = /^conv-[a-z0-9-]{6,60}$/;

/** Whether a record may cross machines at all. */
export function isSyncedRecord(record: StateRecord): boolean {
  if (record.kind === 'tombstone') return SYNCED.has((record.body as { target: string }).target);
  return SYNCED.has(record.kind);
}

/** The part of a thread's meta that two machines agree on: no counts, tip or size (each machine works those out from its own log) and no archived state. */
export interface PortableMeta {
  id: string;
  title: string;
  model: string;
  origin: 'panel' | 'chat-view';
  createdAt: string;
  lastUsedAt: string;
  history?: string;
}

export interface LocalThread { entries: ThreadEntry[]; meta: PortableMeta; context?: Transcript }

export interface LocalSnapshot {
  threads: Record<string, LocalThread>;
  /** Every record of every synced kind, including each thread's meta and context. */
  records: StateRecord[];
}

/** What a hot object holds: entries by thread and records. */
export interface HotPayload { v: 1; entries: Record<string, ThreadEntry[]>; records: StateRecord[] }

/** What an index object holds: for each thread, its meta, how many entries the remote holds and which object files carry them. */
export interface IndexPayload { v: 1; threads: Record<string, { meta: PortableMeta; entries: number; tip: string; files: string[] }> }

/** One profile or secret record handed over by plan 15's sources. */
export interface SourceRecord { id: string; body: unknown; at?: string; writer?: string }
export interface ProfileSource { records(): Promise<SourceRecord[]> }
export interface SecretSource { records(): Promise<SourceRecord[]> }

export interface CollectOptions {
  /** This editor's writer id (`<editor>.<instance>`); sanitised into a record writer. */
  writer: string;
  profileSource?: ProfileSource;
  secretSource?: SecretSource;
  runState?: (marker: RunMarker) => RunState;
}

/** A writer that passes the record rules (lowercase letters, digits and hyphens, 4 to 80 characters). */
export function recordWriter(raw: string | undefined, fallback: string): string {
  const clean = (text: string | undefined): string => (text ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const first = clean(raw);
  if (first.length >= 4) return first;
  const second = clean(fallback);
  return second.length >= 4 ? second : 'unknown-writer';
}

/** The exact toISOString form of a time, or the fallback when the text is not a time. */
export function isoOf(text: unknown, fallback: string): string {
  if (typeof text === 'string') {
    const at = Date.parse(text);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  return fallback;
}

/** A record, or undefined when the content cannot make a valid one (a damaged file is skipped, never sent). */
export function safeRecord(kind: RecordKind, id: string, body: unknown, at: string, writer: string): StateRecord | undefined {
  try {
    return makeRecord(kind, id, body, { at, writer });
  } catch {
    return undefined;
  }
}

function portableOf(meta: ThreadMeta): PortableMeta {
  return {
    id: meta.id, title: meta.title, model: meta.model, origin: meta.origin === 'chat-view' ? 'chat-view' : 'panel', createdAt: meta.createdAt, lastUsedAt: meta.lastUsedAt,
    ...(meta.history ? { history: meta.history } : {})
  };
}

/** A thread meta body from another computer, read strictly: only a complete one for this thread id. */
export function parsePortableMeta(value: unknown, id: string): PortableMeta | undefined {
  const meta = value as Partial<PortableMeta> | null;
  if (!meta || typeof meta !== 'object' || meta.id !== id) return undefined;
  if (typeof meta.title !== 'string' || typeof meta.model !== 'string' || typeof meta.createdAt !== 'string' || typeof meta.lastUsedAt !== 'string') return undefined;
  return {
    id, title: meta.title, model: meta.model, origin: meta.origin === 'chat-view' ? 'chat-view' : 'panel', createdAt: meta.createdAt, lastUsedAt: meta.lastUsedAt,
    ...(typeof meta.history === 'string' && meta.history ? { history: meta.history } : {})
  };
}

/** A thread's context from another computer: only a transcript that names this thread and holds a message list. */
export function parseContext(value: unknown, id: string): Transcript | undefined {
  const context = value as Partial<Transcript> | null;
  if (!context || typeof context !== 'object' || context.id !== id || !Array.isArray(context.messages)) return undefined;
  return context as Transcript;
}

async function collectThreads(threads: ThreadStore, writer: string): Promise<{ threads: Record<string, LocalThread>; records: StateRecord[] }> {
  const found: Record<string, LocalThread> = {};
  const records: StateRecord[] = [];
  for (const item of await threads.index()) {
    if (item.locked || !THREAD_ID.test(item.id)) continue;
    let entries: ThreadEntry[];
    let meta: ThreadMeta;
    let context: Transcript | null;
    try {
      if (item.state === 'archived') {
        const bundle = await readArchive(threads, item.id);
        entries = unionEntries(bundle.entries, await threads.archiveDeltaEntries(item.id));
        meta = bundle.meta;
        context = bundle.context;
      } else {
        const snapshot = await threads.liveSnapshot(item.id);
        if (!snapshot) continue;
        ({ entries, meta, context } = snapshot);
      }
    } catch {
      // A thread this computer cannot open is left where it is: it is neither sent nor changed.
      continue;
    }
    const portable = portableOf(meta);
    found[item.id] = { entries, meta: portable, ...(context ? { context } : {}) };
    const metaRecord = safeRecord('thread-meta', item.id, portable, isoOf(portable.lastUsedAt, new Date(0).toISOString()), writer);
    if (metaRecord) records.push(metaRecord);
    if (context) {
      const contextRecord = safeRecord('thread-context', item.id, JSON.parse(JSON.stringify(context)), isoOf(context.updatedAt, isoOf(portable.lastUsedAt, new Date(0).toISOString())), writer);
      if (contextRecord) records.push(contextRecord);
    }
  }
  return { threads: found, records };
}

/** Reads the state home into what a sync sends. Creates and changes nothing. */
export async function collectLocal(_home: ProjectStateHome, threads: ThreadStore, options: CollectOptions): Promise<LocalSnapshot> {
  const writer = recordWriter(options.writer, 'this-editor');
  const collected = await collectThreads(threads, writer);
  return { threads: collected.threads, records: collected.records.filter((record) => isSyncedRecord(record)) };
}

/** One record's identity including its revision: what "the remote already holds this" is decided by. */
export function recordKey(record: StateRecord): string {
  return `${record.kind}\u0000${record.id}\u0000${record.rev}`;
}

/** Two sets of records merged with the plan-02 rules, as a function of what the sets hold. */
export function mergeAll(local: readonly StateRecord[], incoming: readonly StateRecord[]): StateRecord[] {
  return mergeRecordSets(local, incoming);
}

export interface MergedInput {
  /** Entries that arrived from the remote, by thread (only what was not read before). */
  entries: Record<string, ThreadEntry[]>;
  /** Records whose winner is not what this computer holds: these are written. */
  records: StateRecord[];
}

export interface ApplyResult { threads: number }

function groupById(records: readonly StateRecord[], kind: RecordKind): Map<string, StateRecord> {
  const found = new Map<string, StateRecord>();
  for (const record of records) if (record.kind === kind) found.set(record.id, record);
  return found;
}

/**
 * Writes what a merge brought in. Thread entries are added by id (union, never removed) and each thread's meta and context are merged by the thread
 * store's own rules. Idempotent: running it again on the same input changes nothing.
 */
export async function applyMerged(_home: ProjectStateHome, threads: ThreadStore, merged: MergedInput, local: LocalSnapshot): Promise<ApplyResult> {
  const metas = groupById(merged.records, 'thread-meta');
  const contexts = groupById(merged.records, 'thread-context');
  const ids = new Set<string>([...Object.keys(merged.entries), ...metas.keys(), ...contexts.keys()]);
  let applied = 0;
  for (const id of [...ids].sort()) {
    if (!THREAD_ID.test(id)) continue;
    const entries = (merged.entries[id] ?? []).map((entry) => validEntry(entry, id)).filter((entry): entry is ThreadEntry => entry !== undefined);
    const incomingMeta = metas.has(id) ? parsePortableMeta(metas.get(id)?.body, id) : undefined;
    const incomingContext = contexts.has(id) ? parseContext(contexts.get(id)?.body, id) : undefined;
    const known = local.threads[id]?.meta;
    const first = entries[0]?.at ?? new Date(0).toISOString();
    const last = entries[entries.length - 1]?.at ?? first;
    const meta = incomingMeta ?? known ?? { id, title: 'Conversation', model: '', origin: 'panel' as const, createdAt: first, lastUsedAt: last };
    if (!entries.length && !incomingMeta && !incomingContext) continue;
    const { id: _id, ...rest } = meta;
    const outcome = await threads.importThread(id, { entries, meta: rest, ...(incomingContext ? { context: incomingContext, keepContextTip: true } : {}) });
    if (outcome !== 'unchanged') applied += 1;
  }
  return { threads: applied };
}
