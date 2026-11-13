// What of the state home moves between computers, and how it goes in and out (SYNC-05, D-09). collectLocal reads the state home into thread entries and
// records; applyMerged writes what a merge brought in, through each kind's own store, validating every id before it becomes a path (T-27-51).
// Only the kinds in SYNCED_KINDS ever leave the machine: nothing else in the state home or beside it (security-scan consent, the emergency stop, the
// spend reporting token id, the saved-profile index, Team Mode, cyber engagement data) is read here. No vscode.
import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { RUN_ID as COMPARISON_ID, parseSavedRun, serializeRun } from '../benchmark/results';
import { mergeRecordSets } from '../domain/state/merge';
import { makeRecord, revOf, type RecordKind, type StateRecord } from '../domain/state/records';
import type { ObjectEntry } from '../domain/state/objects';
import { unionEntries, type ThreadEntry } from '../domain/state/threadEntries';
import { mergeProjectChoices, readChoicesFileSync, type ChoiceEntry } from './modelChoices';
import { parseRunMarker, type RunMarker, type RunState } from './runMarkers';
import { mergeSpendLines, parseSpendLines, spendFileText } from './spendMirror';
import { writeFileAtomic, type ProjectStateHome } from './stateHome';
import { archiveParts, readArchive } from './threadArchive';
import { mergeMeta, validEntry, type ThreadMeta, type ThreadStore } from './threadStore';
import type { Transcript } from './transcripts';

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

/** An archived thread's own sealed parts, as the sync's manifest lists a cold object, and the ids of the entries they hold. */
export interface ColdParts { parts: ObjectEntry[]; ids: Set<string> }

/** `archived` is set for a thread whose content is in this state home's archive folder: it is sent as its own cold object, not entry by entry, and has no context record. */
export interface LocalThread { entries: ThreadEntry[]; meta: PortableMeta; context?: Transcript; archived?: true; cold?: ColdParts }

export interface LocalSnapshot {
  threads: Record<string, LocalThread>;
  /** The run ids of runs that are running right now (here or elsewhere): their checkpoints and markers are not sent, and a remote copy never replaces them. */
  liveRuns: Set<string>;
  /** Every record of every synced kind, including each thread's meta and context. */
  records: StateRecord[];
}

/** What a hot object holds: entries by thread and records. */
export interface HotPayload { v: 1; entries: Record<string, ThreadEntry[]>; records: StateRecord[] }

/** What an index object holds: for each thread, its meta, how many entries the remote holds and which object files carry them. */
export interface IndexPayload {
  v: 1;
  threads: Record<string, IndexThread>;
  /** Which recovery wrap the computer that pushed used (a short hash of it). The sealed index vouches for it, so a computer can tell a newer code from a damaged header. */
  wrapId?: string;
}
/**
 * One thread in the index: `files` are the hot objects that carry its entries, `cold` the sealed parts of the archive(s) that hold it whole (a computer
 * that does not have them lists the thread from here and fetches them only when it is opened), `coldEntries` how many entries those hold, and `turns`
 * the messages the person typed (for the history list).
 */
export interface IndexThread { meta: PortableMeta; entries: number; tip: string; files: string[]; cold?: string[]; coldEntries?: number; turns?: number }

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
  /** What the remote is known to hold, so a changed record is written as an edit of it. */
  heads?: HeadMap;
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

/** What the remote is known to hold for each (kind, id), without bodies: a changed local record is written as an edit of it (`base`), so it supersedes it cleanly. */
export type HeadMap = ReadonlyMap<string, StateRecord>;
export function headKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}
export function headMapOf(heads: readonly StateRecord[]): HeadMap {
  const map = new Map<string, StateRecord>();
  for (const head of heads) if (head.kind !== 'tombstone') map.set(headKey(head.kind, head.id), head);
  return map;
}

interface Builder { (kind: RecordKind, id: string, body: unknown, at: string, writer: string): StateRecord | undefined }

/** Makes records, or nothing when the content cannot make a valid one (a damaged file is skipped, never sent). A changed record names the head it edits. */
function builderFor(heads: HeadMap): Builder {
  return (kind, id, body, at, writer) => {
    try {
      const head = heads.get(headKey(kind, id));
      return makeRecord(kind, id, body, { at, writer, ...(head && head.rev !== revOf(body) ? { base: head } : {}) });
    } catch {
      return undefined;
    }
  };
}

const EPOCH = new Date(0).toISOString();
const RUN_ID = /^run-\d+-[a-f0-9]{6}$/;
const CHECKPOINT_ID = /^run-\d+-[a-f0-9]{6}(?:~[0-9a-f]{12})?$/;
const SPEND_MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const MAX_PICKUP_BYTES = 64 * 1024;
const MAX_SPEND_FILE_BYTES = 64 * 1024 * 1024;

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function collectThreads(threads: ThreadStore, build: Builder, writer: string): Promise<{ threads: Record<string, LocalThread>; records: StateRecord[] }> {
  const found: Record<string, LocalThread> = {};
  const records: StateRecord[] = [];
  for (const item of await threads.index()) {
    if (item.locked || !THREAD_ID.test(item.id)) continue;
    let entries: ThreadEntry[];
    let meta: ThreadMeta;
    let context: Transcript | null;
    let cold: ColdParts | undefined;
    try {
      if (item.state === 'archived') {
        const bundle = await readArchive(threads, item.id);
        const delta = await threads.archiveDeltaEntries(item.id);
        entries = unionEntries(bundle.entries, delta);
        // The archive's own meta is as old as the archive: a use on another computer, applied to the index, is what makes this thread newer.
        const merged = mergeMeta(bundle.meta, item);
        meta = { ...merged, lastUsedAt: [merged.lastUsedAt, delta.at(-1)?.at ?? ''].reduce((a, b) => (a >= b ? a : b)) };
        context = bundle.context;
        cold = { parts: await archiveParts(threads, item.id), ids: new Set(bundle.entries.map((entry) => entry.id)) };
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
    found[item.id] = { entries, meta: portable, ...(context ? { context } : {}), ...(cold ? { archived: true as const, cold } : {}) };
    const metaRecord = build('thread-meta', item.id, portable, isoOf(portable.lastUsedAt, EPOCH), writer);
    if (metaRecord) records.push(metaRecord);
    // An archived thread's working context lives in its archive; only a live thread's context travels as a record.
    if (context && !cold) {
      const contextRecord = build('thread-context', item.id, JSON.parse(JSON.stringify(context)), isoOf(context.updatedAt, isoOf(portable.lastUsedAt, EPOCH)), writer);
      if (contextRecord) records.push(contextRecord);
    }
  }
  return { threads: found, records };
}

/** Finished and cut-off markers become records; a run that is running here or elsewhere is never sent, and its run id is reported as live. */
async function collectMarkers(home: ProjectStateHome, build: Builder, writer: string, runState: CollectOptions['runState']): Promise<{ records: StateRecord[]; live: Set<string> }> {
  const records: StateRecord[] = [];
  const live = new Set<string>();
  for (const name of await readdir(home.paths.runs).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!THREAD_ID.test(id)) continue;
    let marker: RunMarker | undefined;
    try { marker = parseRunMarker(JSON.parse(await readFile(path.join(home.paths.runs, name), 'utf8')), id); } catch { continue; }
    if (!marker) continue;
    const state = runState ? runState(marker) : marker.endedAt ? 'finished' : 'running-here';
    if (state === 'running-here' || state === 'running-elsewhere') { live.add(marker.runId); continue; }
    const record = build('marker', id, JSON.parse(JSON.stringify(marker)), isoOf(marker.endedAt ?? marker.activeAt, EPOCH), recordWriter(marker.writer, writer));
    if (record) records.push(record);
  }
  return { records, live };
}

/** A snapshot's relative path, or undefined when it is empty, absolute, drive-lettered, contains a NUL, or climbs out with '..'. */
function safeRel(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes('..')) return undefined;
  return value;
}

/** Keeps only the root-relative snapshots of a checkpoint file (format 2): an outside (absolute) snapshot is dropped and never leaves the computer. */
export function relativeSnapshots(saved: unknown): Array<{ rel: string; original: string | null }> | undefined {
  if (!isObject(saved) || saved.format !== 2 || !Array.isArray(saved.snapshots)) return undefined;
  const kept: Array<{ rel: string; original: string | null }> = [];
  for (const item of saved.snapshots) {
    if (!isObject(item) || item.outside === true || 'abs' in item) continue;
    const rel = safeRel(item.rel);
    if (rel === undefined || !(item.original === null || typeof item.original === 'string')) continue;
    kept.push({ rel, original: item.original as string | null });
  }
  return kept;
}

async function collectCheckpoints(home: ProjectStateHome, build: Builder, writer: string, live: ReadonlySet<string>): Promise<StateRecord[]> {
  const listed: Array<{ id: string; file: string; mtimeMs: number; size: number }> = [];
  for (const name of await readdir(home.paths.checkpoints).catch(() => [] as string[])) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!RUN_ID.test(id) || live.has(id)) continue;
    const file = path.join(home.paths.checkpoints, name);
    const info = await stat(file).catch(() => undefined);
    if (info?.isFile()) listed.push({ id, file, mtimeMs: info.mtimeMs, size: info.size });
  }
  listed.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
  const records: StateRecord[] = [];
  let total = 0;
  for (const item of listed) {
    if (records.length >= CHECKPOINT_SYNC_RUNS) break;
    if (item.size > CHECKPOINT_SYNC_BYTES * 2) continue;
    let snapshots: ReturnType<typeof relativeSnapshots>;
    try { snapshots = relativeSnapshots(JSON.parse(await readFile(item.file, 'utf8'))); } catch { continue; }
    if (!snapshots?.length) continue;
    const body = { format: 2, snapshots };
    const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (total + size > CHECKPOINT_SYNC_BYTES) break;
    const record = build('checkpoint', item.id, body, new Date(item.mtimeMs).toISOString(), writer);
    if (!record) continue;
    total += size;
    records.push(record);
  }
  return records;
}

async function collectComparisons(home: ProjectStateHome, build: Builder, writer: string): Promise<StateRecord[]> {
  const records: StateRecord[] = [];
  for (const name of await readdir(home.paths.comparisons).catch(() => [] as string[])) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!COMPARISON_ID.test(id)) continue;
    let text: string;
    try { text = await readFile(path.join(home.paths.comparisons, name), 'utf8'); } catch { continue; }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { continue; }
    // A comparison still marked running is live work: it is sent when it ends.
    if (isObject(raw) && raw.status === 'running') continue;
    const saved = parseSavedRun(text);
    if (!saved || saved.id !== id) continue;
    const record = build('comparison', id, JSON.parse(JSON.stringify(saved)), isoOf(saved.finishedAt ?? saved.startedAt, EPOCH), writer);
    if (record) records.push(record);
  }
  return records;
}

function collectChoices(home: ProjectStateHome, build: Builder, writer: string): StateRecord[] {
  const records: StateRecord[] = [];
  for (const [setting, entry] of Object.entries(readChoicesFileSync(home.root).values)) {
    if (!entry) continue;
    const record = build('choice', setting, { value: entry.value, at: entry.at, writer: entry.writer }, isoOf(entry.at, EPOCH), recordWriter(entry.writer, writer));
    if (record) records.push(record);
  }
  return records;
}

type SpendLine = Record<string, unknown>;

/** The ledger lines of a received body: only well-formed entry or settled-cost lines. */
function cleanSpendLines(value: unknown): SpendLine[] {
  return Array.isArray(value) ? parseSpendLines(value.map((line) => JSON.stringify(line)).join('\n')) : [];
}

async function collectSpend(home: ProjectStateHome, build: Builder, writer: string): Promise<StateRecord[]> {
  const records: StateRecord[] = [];
  for (const name of await readdir(home.paths.spend).catch(() => [] as string[])) {
    const month = /^(\d{4}-\d{2})\.jsonl$/.exec(name)?.[1];
    if (!month || !SPEND_MONTH.test(month)) continue;
    const file = path.join(home.paths.spend, name);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_SPEND_FILE_BYTES) continue;
    const lines = mergeSpendLines(parseSpendLines(await readFile(file, 'utf8').catch(() => '')), []);
    if (!lines.length) continue;
    const record = build('spend', month, { lines }, new Date(info.mtimeMs).toISOString(), writer);
    if (record) records.push(record);
  }
  return records;
}

async function collectPickup(home: ProjectStateHome, build: Builder, writer: string): Promise<StateRecord[]> {
  const info = await stat(home.paths.pickup).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_PICKUP_BYTES) return [];
  let body: unknown;
  try { body = JSON.parse(await readFile(home.paths.pickup, 'utf8')); } catch { return []; }
  if (!isObject(body)) return [];
  const record = build('pickup', 'pickup', body, isoOf(body.at, new Date(info.mtimeMs).toISOString()), recordWriter(typeof body.writer === 'string' ? body.writer : undefined, writer));
  return record ? [record] : [];
}

async function collectSource(kind: 'profile' | 'secret', source: ProfileSource | SecretSource | undefined, build: Builder, writer: string): Promise<StateRecord[]> {
  if (!source) return [];
  let items: SourceRecord[];
  try { items = await source.records(); } catch { return []; }
  const now = new Date().toISOString();
  const records: StateRecord[] = [];
  for (const item of items) {
    const record = build(kind, item.id, item.body, isoOf(item.at, now), recordWriter(item.writer, writer));
    if (record) records.push(record);
  }
  return records;
}

/** Reads the state home into what a sync sends. Creates and changes nothing. Only the kinds in SYNCED_KINDS are read at all. */
export async function collectLocal(home: ProjectStateHome, threads: ThreadStore, options: CollectOptions): Promise<LocalSnapshot> {
  const writer = recordWriter(options.writer, 'this-editor');
  const build = builderFor(options.heads ?? new Map());
  const collected = await collectThreads(threads, build, writer);
  const markers = await collectMarkers(home, build, writer, options.runState);
  const records = [
    ...collected.records, ...markers.records,
    ...await collectCheckpoints(home, build, writer, markers.live), ...await collectComparisons(home, build, writer), ...collectChoices(home, build, writer),
    ...await collectSpend(home, build, writer), ...await collectPickup(home, build, writer),
    ...await collectSource('profile', options.profileSource, build, writer), ...await collectSource('secret', options.secretSource, build, writer)
  ];
  return { threads: collected.threads, liveRuns: markers.live, records: records.filter((record) => isSyncedRecord(record)) };
}

/** One record's identity including its revision: what "the remote already holds this" is decided by. */
export function recordKey(record: StateRecord): string {
  return `${record.kind}\u0000${record.id}\u0000${record.rev}`;
}

/** A record without its body: all a later sync needs to know what the remote holds. A tombstone keeps the body that names its target. */
export function withoutBody(record: StateRecord): StateRecord {
  return record.kind === 'tombstone' ? record : { ...record, body: null };
}

/**
 * Two sets of records merged with the plan-02 rules, as a function of what the sets hold. The spend kind is an append-only log, so its months are not
 * decided by "the newer wins": the lines of every copy of a month are united (every version of an entry is kept), and the result is the month's one record.
 */
export function mergeAll(local: readonly StateRecord[], incoming: readonly StateRecord[]): StateRecord[] {
  const others = (records: readonly StateRecord[]): StateRecord[] => records.filter((record) => record.kind !== 'spend');
  const merged = mergeRecordSets(others(local), others(incoming));
  const months = new Map<string, StateRecord[]>();
  for (const record of [...local, ...incoming]) {
    if (record.kind !== 'spend') continue;
    const group = months.get(record.id);
    if (group) group.push(record); else months.set(record.id, [record]);
  }
  for (const [id, group] of months) {
    let lines: SpendLine[] = [];
    for (const record of group) lines = mergeSpendLines(lines, cleanSpendLines((record.body as { lines?: unknown } | null)?.lines));
    const body = { lines };
    const rev = revOf(body);
    const newest = group.reduce((a, b) => (a.at > b.at || (a.at === b.at && a.writer >= b.writer) ? a : b));
    const same = group.filter((record) => record.rev === rev).reduce<StateRecord | undefined>((a, b) => (!a || b.at > a.at ? b : a), undefined);
    merged.push(same ?? makeRecord('spend', id, body, { at: newest.at, writer: newest.writer }));
  }
  return merged;
}

/** What the remote is known to hold after more records arrived or were sent: the plan-02 merge for most kinds, every revision seen (the last few) for spend. */
export function foldHeads(heads: readonly StateRecord[], records: readonly StateRecord[]): StateRecord[] {
  const others = (list: readonly StateRecord[]): StateRecord[] => list.filter((record) => record.kind !== 'spend');
  const folded = mergeRecordSets(others(heads), others(records).map(withoutBody));
  const spend = new Map<string, StateRecord[]>();
  for (const record of [...heads, ...records.map(withoutBody)]) {
    if (record.kind !== 'spend') continue;
    const group = spend.get(record.id) ?? [];
    if (!group.some((item) => item.rev === record.rev)) group.push(record);
    spend.set(record.id, group);
  }
  for (const group of spend.values()) folded.push(...group.slice(-6));
  return folded;
}

export interface MergedInput {
  /** Entries that arrived from the remote, by thread (only what was not read before). */
  entries: Record<string, ThreadEntry[]>;
  /** Records whose winner is not what this computer holds: these are written. */
  records: StateRecord[];
  /** The threads the remote's index says are held whole as cold objects, with what the index says of each: a computer without one lists it from here and does not download it. */
  cold?: Record<string, IndexThread>;
}

export interface ApplyOptions {
  runState?: (marker: RunMarker) => RunState;
}

export interface ApplyResult { threads: number; others: number }

function groupById(records: readonly StateRecord[], kind: RecordKind): Map<string, StateRecord> {
  const found = new Map<string, StateRecord>();
  for (const record of records) if (record.kind === kind) found.set(record.id, record);
  return found;
}

async function sameText(file: string, text: string): Promise<boolean> {
  return (await readFile(file, 'utf8').catch(() => undefined)) === text;
}

async function applyMarkers(home: ProjectStateHome, records: readonly StateRecord[], runState: ApplyOptions['runState']): Promise<number> {
  let applied = 0;
  for (const record of records) {
    if (record.kind !== 'marker' || !THREAD_ID.test(record.id)) continue;
    const marker = parseRunMarker(record.body, record.id);
    if (!marker) continue;
    const file = path.join(home.paths.runs, `${record.id}.json`);
    let existing: RunMarker | undefined;
    try { existing = parseRunMarker(JSON.parse(await readFile(file, 'utf8')), record.id); } catch { existing = undefined; }
    // A run that is live on this computer keeps its own marker whatever another computer says.
    if (existing) {
      const state = runState ? runState(existing) : existing.endedAt ? 'finished' : 'running-here';
      if (state === 'running-here' || state === 'running-elsewhere') continue;
    }
    const text = `${JSON.stringify(marker)}\n`;
    if (await sameText(file, text)) continue;
    await home.ensureFolder(home.paths.runs);
    await writeFileAtomic(file, text);
    applied += 1;
  }
  return applied;
}

async function applyCheckpoints(home: ProjectStateHome, records: readonly StateRecord[], live: ReadonlySet<string>): Promise<number> {
  let applied = 0;
  for (const record of records) {
    if (record.kind !== 'checkpoint' || !CHECKPOINT_ID.test(record.id) || live.has(record.id)) continue;
    const snapshots = relativeSnapshots(record.body);
    if (!snapshots?.length) continue;
    const text = JSON.stringify({ format: 2, snapshots });
    const file = path.join(home.paths.checkpoints, `${record.id}.json`);
    if (await sameText(file, text)) continue;
    await home.ensureFolder(home.paths.checkpoints);
    await writeFileAtomic(file, text);
    applied += 1;
  }
  return applied;
}

async function applyComparisons(home: ProjectStateHome, records: readonly StateRecord[]): Promise<number> {
  let applied = 0;
  for (const record of records) {
    // A forked copy has no comparison id of its own to be saved under, so only the original id is written.
    if (record.kind !== 'comparison' || !COMPARISON_ID.test(record.id)) continue;
    const saved = parseSavedRun(JSON.stringify(record.body));
    if (!saved || saved.id !== record.id) continue;
    const text = serializeRun(saved);
    const file = path.join(home.paths.comparisons, `${record.id}.json`);
    if (await sameText(file, text)) continue;
    await home.ensureFolder(home.paths.comparisons);
    await writeFileAtomic(file, text, { mode: 0o644 });
    applied += 1;
  }
  return applied;
}

async function applyChoices(home: ProjectStateHome, records: readonly StateRecord[]): Promise<number> {
  const incoming: Record<string, ChoiceEntry> = {};
  for (const record of records) {
    if (record.kind !== 'choice' || !isObject(record.body)) continue;
    const { value, at, writer } = record.body;
    if (typeof at !== 'string') continue;
    incoming[record.id] = { value: value as ChoiceEntry['value'], at, writer: typeof writer === 'string' ? writer : '' };
  }
  return Object.keys(incoming).length && await mergeProjectChoices(home.root, incoming) ? 1 : 0;
}

async function applySpend(home: ProjectStateHome, records: readonly StateRecord[]): Promise<number> {
  let applied = 0;
  for (const record of records) {
    if (record.kind !== 'spend' || !SPEND_MONTH.test(record.id)) continue;
    const incoming = cleanSpendLines((record.body as { lines?: unknown } | null)?.lines);
    if (!incoming.length) continue;
    const file = path.join(home.paths.spend, `${record.id}.jsonl`);
    const current = await readFile(file, 'utf8').catch(() => '');
    const text = spendFileText(mergeSpendLines(parseSpendLines(current), incoming));
    if (text === current) continue;
    await home.ensureFolder(home.paths.spend);
    await writeFileAtomic(file, text);
    applied += 1;
  }
  return applied;
}

async function applyPickup(home: ProjectStateHome, records: readonly StateRecord[]): Promise<number> {
  const record = records.filter((item) => item.kind === 'pickup').pop();
  if (!record || !isObject(record.body)) return 0;
  const text = `${JSON.stringify(record.body)}\n`;
  if (text.length > MAX_PICKUP_BYTES || await sameText(home.paths.pickup, text)) return 0;
  await writeFileAtomic(home.paths.pickup, text);
  return 1;
}

/**
 * Writes what a merge brought in. Thread entries are added by id (union, never removed) and each thread's meta and context are merged by the thread
 * store's own rules; every other kind goes through its own store or an atomic file write, after its id passed the pattern for its kind. Idempotent:
 * running it again on the same input changes nothing. Profile and secret records are not handled here (the caller keeps them for plan 15).
 */
export async function applyMerged(home: ProjectStateHome, threads: ThreadStore, merged: MergedInput, local: LocalSnapshot, options: ApplyOptions = {}): Promise<ApplyResult> {
  const metas = groupById(merged.records, 'thread-meta');
  const contexts = groupById(merged.records, 'thread-context');
  const ids = new Set<string>([...Object.keys(merged.entries), ...metas.keys(), ...contexts.keys(), ...Object.keys(merged.cold ?? {})]);
  let applied = 0;
  const archivedIds = new Set(await threads.archivedIds());
  for (const id of [...ids].sort()) {
    if (!THREAD_ID.test(id)) continue;
    const entries = (merged.entries[id] ?? []).map((entry) => validEntry(entry, id)).filter((entry): entry is ThreadEntry => entry !== undefined);
    const incomingMeta = metas.has(id) ? parsePortableMeta(metas.get(id)?.body, id) : undefined;
    const incomingContext = contexts.has(id) ? parseContext(contexts.get(id)?.body, id) : undefined;
    const known = local.threads[id]?.meta;
    const listed = merged.cold?.[id];
    // A thread whose content is in an archive folder, or kept whole only online and not held here at all, is not opened: what arrived for it waits in the
    // archive's delta file (the next open unites it with the archive), and its last use in the index is raised, which ranks it live. Nothing is decompressed
    // and nothing in the archive is rewritten.
    const heldHere = local.threads[id];
    if (heldHere?.archived || (!heldHere && (listed || archivedIds.has(id)))) {
      const have = new Set([...(heldHere?.entries ?? []), ...(heldHere ? [] : await threads.archiveDeltaEntries(id))].map((entry) => entry.id));
      const missing = entries.filter((entry) => !have.has(entry.id));
      if (missing.length) await threads.appendArchiveDelta(id, missing);
      const newest = [known, incomingMeta, listed?.meta].reduce<PortableMeta | undefined>((best, meta) => (meta && (!best || meta.lastUsedAt > best.lastUsedAt) ? meta : best), undefined);
      if (newest) {
        const last = missing.at(-1)?.at;
        await threads.noteArchivedMeta(id, last && last > newest.lastUsedAt ? { ...newest, lastUsedAt: last } : newest, listed ? { entries: listed.entries, tip: listed.tip, ...(listed.turns !== undefined ? { turns: listed.turns } : {}) } : {});
      }
      if (missing.length || newest) applied += 1;
      continue;
    }
    const first = entries[0]?.at ?? EPOCH;
    const last = entries[entries.length - 1]?.at ?? first;
    const meta = incomingMeta ?? known ?? { id, title: 'Conversation', model: '', origin: 'panel' as const, createdAt: first, lastUsedAt: last };
    if (!entries.length && !incomingMeta && !incomingContext) continue;
    const { id: _id, ...rest } = meta;
    const outcome = await threads.importThread(id, { entries, meta: rest, ...(incomingContext ? { context: incomingContext, keepContextTip: true } : {}) });
    if (outcome !== 'unchanged') applied += 1;
  }
  const others = await applyMarkers(home, merged.records, options.runState)
    + await applyCheckpoints(home, merged.records, local.liveRuns)
    + await applyComparisons(home, merged.records)
    + await applyChoices(home, merged.records)
    + await applySpend(home, merged.records)
    + await applyPickup(home, merged.records);
  return { threads: applied, others };
}
