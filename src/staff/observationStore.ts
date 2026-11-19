// The local observation store (research note 11, sections 3, 4 and 9.2; WP-OBS): append-only NDJSON segments under .planning/staff/observations/, one per
// feed, channel and hour, with a manifest of their sizes and hashes, a feed registry (descriptors, source states, gaps, closed tracks), raw feed messages
// kept as the documented raw-copy exception, and the feed events the Staff Room draws. Node I/O only: this module never imports vscode, so the tests
// drive it directly. Every rule it applies lives in src/domain/staff/obs/.
//
// Layout under the store folder (it carries its own .gitignore: observations are not committed):
// - manifest.json                                the segment index: bytes, SHA-256, rows and known-time span of each segment, and the raw index
// - feeds.json                                   the feed registry
// - segments/<feed>/<channel>/<hour>.ndjson      rows, one per line, in the bytes observationLine writes
// - raw/<feed>/<channel>/<hour>.ndjson           raw messages of streams, `{obsId, sha256, bytes, raw?}` per line
//
// Four rules hold whatever the caller does:
// - Idempotent: a row whose observation id the store already holds is counted as a duplicate and not written again.
// - The label exists before the row does: a row below its channel's label, or without the handling its feed requires, is refused.
// - Unreadable is never empty: a segment, the manifest or the registry that is there but cannot be read whole is reported as unreadable, every answer
//   that would have used it says so, and nothing is appended on top of it.
// - Readers see only what their clearance covers: the store drops every other row before anything is computed.
import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Label } from '../domain/gate/labels';
import { feedDecay, feedSourceTransition, FEED_SOURCE_EVENTS, parseFeedDescriptor } from '../domain/staff/obs/feeds';
import type { DegradedReason, FeedSourceEvent } from '../domain/staff/obs/feeds';
import type { FeedEvent, FeedSourceStateEvent, ObservationsAppendedEvent, TrackStateEvent } from '../domain/staff/obs/events';
import { layersFor } from '../domain/staff/obs/layers';
import { observationLine, parseObservation, parseSegmentLines } from '../domain/staff/obs/observation';
import type { Observation } from '../domain/staff/obs/observation';
import { tracksAt } from '../domain/staff/obs/queries';
import type { TrackLookup } from '../domain/staff/obs/queries';
import {
  emptyManifest, emptyRegistry, keepsRawCopies, OBS_APPEND_MAX_ROWS, OBS_INDEX_MAX_BYTES, OBS_MANIFEST_FILE, OBS_MAX_GAPS, OBS_RAW_DIR, OBS_REGISTRY_FILE,
  OBS_SEGMENT_MAX_BYTES, OBS_SEGMENTS_DIR, OBS_STORE_DIR, OBS_STORE_MAX_BYTES, parseManifest, parseRegistry, parseSegmentId, RAW_MESSAGE_MAX_BYTES,
  RAW_SEGMENT_MAX_BYTES, rawExpired, rawFile, rowFits, rowLabel, segmentFile, storeUnreadableText, STORE_FAILURES, trackLayerFor, unreadableNote
} from '../domain/staff/obs/store';
import type { FeedRegistry, RegisteredFeed, SegmentEntry, StoreFailure, StoreManifest } from '../domain/staff/obs/store';
import type { TrackState } from '../domain/staff/obs/tracks';
import { isNamedPerson } from '../domain/staff/release';
import type { PersonActor } from '../domain/staff/release';
import { withFileLock } from '../services/stateMirrorLock';
import { readWhole as readStaffWhole, snapshotOf, snapshotOfBytes, writeIfUnchanged } from './staffFiles';
import type { FileSnapshot } from './staffFiles';

/** An index file changed outside the store between its read and the store's write. */
export class StoreChangedError extends Error {}

const LOCK = 'observations.lock';
const GITIGNORE = '# Observations are not committed (research note 11, 9.2): they live only in this project folder.\n*\n';

/** Whether a reader's clearance covers a row's label (with its handling flags). The tools pass the gate's own check; nothing else decides it. */
export type ObsReader = (label: Label) => boolean;

export interface ObservationStoreOptions {
  /** The project root: the store lives in its .planning/staff/observations folder. */
  readonly root: string;
  readonly now?: () => number;
  /** Where feed events go: the project's staff event log. Without one the store records nothing outside its own files. */
  readonly emit?: (events: readonly FeedEvent[], root: string) => Promise<void>;
  /** The staff run open now, if any, for the events' `run`. */
  readonly run?: () => string | null;
}

/** A segment the store could not read whole, and why. Its rows are left out of every answer, and every answer says so. */
export interface SegmentProblem { readonly segment: string; readonly reason: string }

/** The store as read now: every readable row, the registry, and what could not be read. */
export interface StoreRead {
  readonly rows: readonly Observation[];
  readonly registry: FeedRegistry;
  readonly manifest: StoreManifest;
  readonly unreadable: readonly SegmentProblem[];
}

export type StoreLoad = { readonly ok: true; readonly value: StoreRead } | { readonly ok: false; readonly message: string };

/** What a reader may see: the rows its clearance covers, the feed registry, and the sentence any answer must carry when segments could not be read. */
export interface ReaderView {
  readonly rows: readonly Observation[];
  readonly registry: FeedRegistry;
  readonly unreadable: readonly SegmentProblem[];
  readonly note?: string;
  readonly lookup: TrackLookup;
}

export interface AppendRefusal { readonly index: number; readonly reason: StoreFailure; readonly message: string; readonly obsId?: string }
export interface AppendResult {
  readonly ok: boolean;
  readonly appended: number;
  readonly duplicates: number;
  readonly refused: readonly AppendRefusal[];
  /** The store-wide refusal (an unreadable index), when nothing could be considered. */
  readonly message?: string;
}

export type StoreResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

interface CachedSegment { readonly bytes: number; readonly mtimeMs: number; readonly hash: Hash; readonly rows: Observation[] }

type WholeRead = { readonly kind: 'missing' } | { readonly kind: 'text'; readonly buffer: Buffer; readonly mtimeMs: number } | { readonly kind: 'unreadable'; readonly reason: string };

/** The shared reader (staffFiles.ts), with the store's own size limits and the file's modification time for the segment cache. */
async function readWhole(file: string, max: number): Promise<WholeRead> {
  let mtimeMs = 0;
  try { mtimeMs = (await stat(file)).mtimeMs; } catch { /* the shared reader says why */ }
  const read = await readStaffWhole(file, max);
  return read.kind === 'text' ? { kind: 'text', buffer: read.bytes, mtimeMs } : read;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

export class ObservationStore {
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedSegment>();
  /** What the store last read of each index file (manifest, registry): its next write replaces only those bytes. */
  private readonly indexRead = new Map<string, FileSnapshot>();

  public constructor(private readonly options: ObservationStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  public get root(): string { return this.options.root; }

  public get folder(): string { return path.join(this.options.root, ...OBS_STORE_DIR.split('/')); }

  private file(relative: string): string { return path.join(this.folder, ...relative.split('/')); }

  // ---- Reading ---------------------------------------------------------------------------------------------------------------------------------

  /** The segment files on disk, by segment id. */
  private async segmentsOnDisk(): Promise<string[]> {
    const out: string[] = [];
    const list = async (dir: string): Promise<string[]> => {
      try { return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; }
    };
    const root = this.file(OBS_SEGMENTS_DIR);
    for (const feed of await list(root)) {
      for (const channel of await list(path.join(root, feed))) {
        let files: string[] = [];
        try { files = (await readdir(path.join(root, feed, channel))).filter((name) => name.endsWith('.ndjson')); } catch { files = []; }
        for (const name of files) {
          const id = `${feed}/${channel}/${name.slice(0, -'.ndjson'.length)}`;
          if (parseSegmentId(id)) out.push(id);
        }
      }
    }
    return out.sort();
  }

  /** One segment, checked against what the manifest says the store wrote. A file that grew past it (a write the manifest missed) keeps its tail when it reads. */
  private async readSegment(id: string, entry: SegmentEntry | undefined): Promise<{ rows: Observation[]; entry: SegmentEntry } | { problem: string }> {
    const file = this.file(segmentFile(id));
    let info;
    try { info = await stat(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { problem: 'the manifest lists it, but the file is missing' };
      return { problem: `it could not be opened (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
    }
    const cached = this.cache.get(id);
    if (cached && cached.bytes === info.size && cached.mtimeMs === info.mtimeMs && (!entry || (entry.bytes === cached.bytes && entry.sha256 === cached.hash.copy().digest('hex')))) {
      return { rows: cached.rows, entry: entry ?? this.entryOf(cached) };
    }
    const read = await readWhole(file, OBS_SEGMENT_MAX_BYTES);
    if (read.kind === 'missing') return { problem: 'the manifest lists it, but the file is missing' };
    if (read.kind === 'unreadable') return { problem: read.reason };
    const buffer = read.buffer;
    if (entry) {
      if (buffer.length < entry.bytes) return { problem: 'it is shorter than the store wrote it: rows were removed outside the store' };
      if (sha256(buffer.subarray(0, entry.bytes)) !== entry.sha256) return { problem: 'it was changed outside the store' };
    }
    const parsed = parseSegmentLines(buffer.toString('utf8'));
    if (!parsed.ok) return { problem: `a line does not read as an observation (${parsed.message})` };
    if (parsed.value.some((row) => row.segment !== id)) return { problem: 'it holds a row of another segment' };
    if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) return { problem: 'its last line was cut short' };
    const hash = createHash('sha256').update(buffer);
    const segment: CachedSegment = { bytes: buffer.length, mtimeMs: read.mtimeMs, hash, rows: parsed.value };
    this.cache.set(id, segment);
    return { rows: segment.rows, entry: this.entryOf(segment) };
  }

  private entryOf(segment: CachedSegment): SegmentEntry {
    const known = segment.rows.map((row) => row.knownAt).sort();
    return { bytes: segment.bytes, sha256: segment.hash.copy().digest('hex'), rows: segment.rows.length, knownFrom: known[0] ?? '1970-01-01T00:00:00.000Z', knownTo: known[known.length - 1] ?? '1970-01-01T00:00:00.000Z' };
  }

  private async readIndex<T>(name: string, parse: (value: unknown) => T | undefined): Promise<{ kind: 'missing' } | { kind: 'value'; value: T } | { kind: 'problem'; message: string }> {
    const read = await readWhole(this.file(name), OBS_INDEX_MAX_BYTES);
    // The bytes read are the only bytes the next index write may replace (writeIndex).
    this.indexRead.set(name, read.kind === 'text' ? snapshotOfBytes(read.buffer) : read.kind === 'missing' ? { exists: false } : { exists: true, hash: 'unreadable' });
    if (read.kind === 'missing') return read;
    const where = `${OBS_STORE_DIR}/${name}`;
    const wayOut = 'Move it aside by hand: the store rebuilds the segment index from the segments, and a person registers the feeds again.';
    if (read.kind === 'unreadable') return { kind: 'problem', message: storeUnreadableText(where, read.reason, wayOut) };
    let value: unknown;
    try { value = JSON.parse(read.buffer.toString('utf8')); } catch { return { kind: 'problem', message: storeUnreadableText(where, 'it is not valid JSON', wayOut) }; }
    const parsed = parse(value);
    return parsed === undefined ? { kind: 'problem', message: storeUnreadableText(where, 'it is not in the store\'s format', wayOut) } : { kind: 'value', value: parsed };
  }

  /**
   * The store as it is on disk now. A missing manifest is rebuilt from the segments; an unreadable manifest or registry makes the whole store unreadable,
   * never empty. Segments that cannot be read whole are listed and their rows left out.
   */
  public async load(): Promise<StoreLoad> {
    const manifestRead = await this.readIndex(OBS_MANIFEST_FILE, parseManifest);
    if (manifestRead.kind === 'problem') return { ok: false, message: manifestRead.message };
    const registryRead = await this.readIndex(OBS_REGISTRY_FILE, parseRegistry);
    if (registryRead.kind === 'problem') return { ok: false, message: registryRead.message };
    const onDisk = await this.segmentsOnDisk();
    if (registryRead.kind === 'missing' && onDisk.length > 0) {
      return { ok: false, message: storeUnreadableText(`${OBS_STORE_DIR}/${OBS_REGISTRY_FILE}`, 'it is missing while segments are there, so their feeds, labels and decay are unknown', 'Register the feeds again; nothing in the segments was changed.') };
    }
    const manifest = manifestRead.kind === 'value' ? manifestRead.value : emptyManifest();
    const registry = registryRead.kind === 'value' ? registryRead.value : emptyRegistry();
    const ids = [...new Set([...Object.keys(manifest.segments), ...onDisk])].sort();
    const segments: Record<string, SegmentEntry> = {};
    const unreadable: SegmentProblem[] = [];
    const rows: Observation[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const read = await this.readSegment(id, manifest.segments[id]);
      if ('problem' in read) {
        unreadable.push({ segment: id, reason: read.problem });
        this.cache.delete(id);
        if (manifest.segments[id]) segments[id] = manifest.segments[id];
        continue;
      }
      segments[id] = read.entry;
      for (const row of read.rows) {
        if (seen.has(row.obsId)) continue;
        seen.add(row.obsId);
        rows.push(row);
      }
    }
    return { ok: true, value: { rows, registry, manifest: { ...manifest, segments }, unreadable } };
  }

  /**
   * What one reader may see. Rows its clearance does not cover are dropped first, so nothing computed from the view (a slice, a track, a count) differs
   * from a store that never held them. A reader that cannot be asked sees nothing.
   */
  public async view(reader: ObsReader): Promise<{ readonly ok: true; readonly value: ReaderView } | { readonly ok: false; readonly message: string }> {
    const loaded = await this.load();
    if (!loaded.ok) return loaded;
    const covers = (row: Observation): boolean => { try { return reader(rowLabel(row)); } catch { return false; } };
    const { registry, unreadable } = loaded.value;
    const rows = loaded.value.rows.filter(covers);
    return {
      ok: true,
      value: {
        rows, registry, unreadable, ...(unreadable.length ? { note: unreadableNote(unreadable.length) } : {}),
        lookup: lookupOf(registry)
      }
    };
  }

  // ---- Writing ---------------------------------------------------------------------------------------------------------------------------------

  private async ensureFolder(): Promise<void> {
    await mkdir(this.folder, { recursive: true });
    const ignore = this.file('.gitignore');
    try { await stat(ignore); } catch { await writeFile(ignore, GITIGNORE, 'utf8').catch(() => undefined); }
  }

  private async writeManifest(manifest: StoreManifest): Promise<void> {
    await this.writeIndex(OBS_MANIFEST_FILE, `${JSON.stringify(manifest, null, 1)}\n`);
  }

  private async writeRegistry(registry: FeedRegistry): Promise<void> {
    await this.writeIndex(OBS_REGISTRY_FILE, `${JSON.stringify(registry, null, 1)}\n`);
  }

  /**
   * An index write is a compare-and-swap against the bytes the store last read under its lock (staffFiles.ts, drop 1 review round 4): the store's
   * folder sits in the project, so a member's Write could land there, and the store never writes over bytes it did not read. A changed index is left as
   * it is, and the next load reports it.
   */
  private async writeIndex(name: string, text: string): Promise<void> {
    const file = this.file(name);
    const expected = this.indexRead.get(name) ?? await snapshotOf(file);
    if (!(await writeIfUnchanged(file, expected, text))) {
      this.indexRead.delete(name);
      throw new StoreChangedError(`${OBS_STORE_DIR}/${name} was changed outside the store after it was read, so the store did not write over it; the next read reports the file.`);
    }
    this.indexRead.set(name, snapshotOfBytes(Buffer.from(text, 'utf8')));
  }

  /** Every write runs under the store's lock; an index that changed outside the store ends the write with a refusal, never a write over it. */
  private async locked<T extends { readonly ok: boolean }>(work: () => Promise<T>): Promise<T | { readonly ok: false; readonly message: string }> {
    await this.ensureFolder();
    try {
      return await withFileLock(this.folder, LOCK, work);
    } catch (error) {
      if (error instanceof StoreChangedError) return { ok: false, message: error.message };
      throw error;
    }
  }

  private run(): string | null {
    try { return this.options.run?.() ?? null; } catch { return null; }
  }

  private async emit(events: readonly FeedEvent[]): Promise<void> {
    if (!events.length || !this.options.emit) return;
    try { await this.options.emit(events, this.options.root); } catch { /* the store's files are the record; an event log that cannot take events never stops an append */ }
  }

  /** Adds a feed in the `proposed` state. A feed already registered with the same descriptor is left as it is; a different one is refused. */
  public async registerFeed(raw: unknown): Promise<StoreResult> {
    const parsed = parseFeedDescriptor(raw);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const descriptor = parsed.value;
    return this.locked(async () => {
      const loaded = await this.load();
      if (!loaded.ok) return loaded;
      const registry = loaded.value.registry;
      const existing = registry.feeds[descriptor.id];
      if (existing) {
        return JSON.stringify(existing.descriptor) === JSON.stringify(descriptor)
          ? { ok: true, text: `${descriptor.id} is already registered (${existing.state}).` }
          : { ok: false, message: `${descriptor.id} is already registered with another descriptor. Retire it and register the new one under a new id.` };
      }
      const at = isoOf(this.now());
      await this.writeRegistry({ ...registry, feeds: { ...registry.feeds, [descriptor.id]: { descriptor, state: 'proposed', since: at } } });
      await this.emit([{ type: 'feed.source.state', run: this.run(), at, feed: descriptor.id, from: null, to: 'proposed', simulated: descriptor.simulated }]);
      return { ok: true, text: `${descriptor.id} is registered and proposed. A person approves it before it takes rows.` };
    });
  }

  /**
   * Moves a feed through its source lifecycle (feeds.ts): only a named person approves, rejects or retires; the runtime starts, degrades and recovers.
   * `hasHistory` says whether the feed backfills before it goes live.
   */
  public async transitionFeed(feed: string, event: FeedSourceEvent, actor: PersonActor | { readonly kind: 'agent' | 'system'; readonly member?: string }, options: { hasHistory?: boolean; reason?: string } = {}): Promise<StoreResult> {
    if (!(FEED_SOURCE_EVENTS as readonly string[]).includes(event)) return { ok: false, message: 'That is not a feed source event.' };
    if (actor.kind === 'person' && !isNamedPerson(actor)) return { ok: false, message: 'Only a named person may do this.' };
    return this.locked(async () => {
      const loaded = await this.load();
      if (!loaded.ok) return loaded;
      const registry = loaded.value.registry;
      const current = registry.feeds[feed];
      if (!current) return { ok: false, message: STORE_FAILURES['unknown-feed'] };
      const hasHistory = options.hasHistory ?? (current.descriptor.feedClass === 'static' || current.descriptor.transport === 'file-import');
      const step = feedSourceTransition(current.state, event, actor, hasHistory);
      if (!step.ok) return { ok: false, message: step.reason === 'not-a-person' ? 'Only a named person may do this.' : `A ${current.state} feed cannot ${event}.` };
      const at = isoOf(this.now());
      const reason = options.reason?.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
      const next: RegisteredFeed = { descriptor: current.descriptor, state: step.to, since: at, ...(reason ? { reason } : {}) };
      await this.writeRegistry({ ...registry, feeds: { ...registry.feeds, [feed]: next } });
      await this.emit([{ type: 'feed.source.state', run: this.run(), at, feed, from: current.state, to: step.to, ...(reason ? { reason } : {}), simulated: current.descriptor.simulated }]);
      return { ok: true, text: `${feed} is now ${step.to}.` };
    });
  }

  /** A stream was cut: the gap is recorded (and shown on the map and in replay, never filled in), and a live feed is degraded with the reason. */
  public async recordGap(input: { feed: string; channel: string; from: string; to: string; reason: DegradedReason }): Promise<StoreResult> {
    if (Number.isNaN(Date.parse(input.from)) || Number.isNaN(Date.parse(input.to)) || Date.parse(input.to) < Date.parse(input.from)) return { ok: false, message: 'A gap runs from a time to a later time.' };
    return this.locked(async () => {
      const loaded = await this.load();
      if (!loaded.ok) return loaded;
      const registry = loaded.value.registry;
      const current = registry.feeds[input.feed];
      if (!current) return { ok: false, message: STORE_FAILURES['unknown-feed'] };
      if (!current.descriptor.channels.some((channel) => channel.id === input.channel)) return { ok: false, message: STORE_FAILURES['unknown-channel'] };
      const at = isoOf(this.now());
      const gap = { feed: input.feed, channel: input.channel, from: isoOf(Date.parse(input.from)), to: isoOf(Date.parse(input.to)), reason: input.reason };
      const events: FeedEvent[] = [{ type: 'feed.gap', run: this.run(), at, ...gap }];
      let feeds = registry.feeds;
      const degrade = current.state === 'live' || current.state === 'backfilling' ? feedSourceTransition(current.state, 'degrade', { kind: 'system' }, false) : undefined;
      if (degrade?.ok) {
        feeds = { ...feeds, [input.feed]: { descriptor: current.descriptor, state: degrade.to, since: at, reason: input.reason } };
        events.push({ type: 'feed.source.state', run: this.run(), at, feed: input.feed, from: current.state, to: degrade.to, reason: input.reason, simulated: current.descriptor.simulated });
      }
      await this.writeRegistry({ ...registry, feeds, gaps: [...registry.gaps, gap].slice(-OBS_MAX_GAPS) });
      await this.emit(events);
      return { ok: true, text: `Gap recorded on ${input.feed}/${input.channel} from ${gap.from} to ${gap.to} (${input.reason}).` };
    });
  }

  /**
   * Appends rows. Each row is read strictly, held to its feed's stamp (rowFits), and written to its segment unless the store already holds its id. Rows
   * of a segment that cannot be read, or that would take a segment or the store past its size, are refused, and a flowing feed is degraded with
   * `overflow`. `raw` gives the raw message of a row by its observation id, kept for streams only (the raw-copy exception).
   */
  public async append(input: { rows: readonly unknown[]; raw?: Readonly<Record<string, string>> }): Promise<AppendResult> {
    if (input.rows.length > OBS_APPEND_MAX_ROWS) return { ok: false, appended: 0, duplicates: 0, refused: [], message: `One append takes at most ${OBS_APPEND_MAX_ROWS} rows.` };
    const result = await this.locked(async () => {
      const loaded = await this.load();
      if (!loaded.ok) return { ok: false, appended: 0, duplicates: 0, refused: [], message: `${STORE_FAILURES['store-unreadable']} ${loaded.message}` };
      const { registry, manifest } = loaded.value;
      const unreadable = new Set(loaded.value.unreadable.map((problem) => problem.segment));
      const held = new Set(loaded.value.rows.map((row) => row.obsId));
      const refused: AppendRefusal[] = [];
      const refuse = (index: number, reason: StoreFailure, obsId?: string, detail?: string): void => {
        refused.push({ index, reason, message: detail ? `${STORE_FAILURES[reason]} ${detail}` : STORE_FAILURES[reason], ...(obsId ? { obsId } : {}) });
      };
      let storeBytes = Object.values(manifest.segments).reduce((sum, entry) => sum + entry.bytes, 0);
      const pending = new Map<string, { lines: string[]; rows: Observation[]; duplicates: number; bytes: number }>();
      const overflowed = new Set<string>();
      let duplicates = 0;
      input.rows.forEach((raw, index) => {
        const parsed = parseObservation(raw);
        if (!parsed.ok) { refuse(index, 'not-a-row', undefined, parsed.message); return; }
        const row = parsed.value;
        const fit = rowFits(row, registry.feeds[row.feed]);
        if (fit) { refuse(index, fit, row.obsId); return; }
        const segment = pending.get(row.segment) ?? { lines: [], rows: [], duplicates: 0, bytes: 0 };
        pending.set(row.segment, segment);
        if (held.has(row.obsId)) { duplicates += 1; segment.duplicates += 1; return; }
        if (unreadable.has(row.segment)) { refuse(index, 'segment-unreadable', row.obsId); return; }
        const line = `${observationLine(row)}\n`;
        const size = Buffer.byteLength(line);
        const before = manifest.segments[row.segment]?.bytes ?? 0;
        if (before + segment.bytes + size > OBS_SEGMENT_MAX_BYTES) { refuse(index, 'segment-full', row.obsId); overflowed.add(row.feed); return; }
        if (storeBytes + size > OBS_STORE_MAX_BYTES) { refuse(index, 'store-full', row.obsId); overflowed.add(row.feed); return; }
        storeBytes += size;
        held.add(row.obsId);
        segment.lines.push(line);
        segment.rows.push(row);
        segment.bytes += size;
      });

      const at = isoOf(this.now());
      const segments: Record<string, SegmentEntry> = { ...manifest.segments };
      let rawIndex = { ...manifest.raw };
      const events: FeedEvent[] = [];
      let appended = 0;
      for (const [id, batch] of pending) {
        if (batch.rows.length > 0) {
          const file = this.file(segmentFile(id));
          await mkdir(path.dirname(file), { recursive: true });
          const text = batch.lines.join('');
          await appendFile(file, text, 'utf8');
          const cached = this.cache.get(id);
          const hash = cached ? cached.hash : createHash('sha256');
          hash.update(text);
          const info = await stat(file);
          const segment: CachedSegment = { bytes: (cached?.bytes ?? 0) + Buffer.byteLength(text), mtimeMs: info.mtimeMs, hash, rows: [...(cached?.rows ?? []), ...batch.rows] };
          this.cache.set(id, segment);
          segments[id] = this.entryOf(segment);
          appended += batch.rows.length;
          rawIndex = await this.keepRaw(id, batch.rows, input.raw, registry, rawIndex);
        }
        const feed = registry.feeds[batch.rows[0]?.feed ?? id.split('/')[0]];
        if (!feed) continue;
        const known = batch.rows.map((row) => row.knownAt).sort();
        const event: ObservationsAppendedEvent = {
          type: 'feed.observations.appended', run: this.run(), at, feed: feed.descriptor.id, channel: id.split('/')[1], segment: id, appended: batch.rows.length,
          duplicates: batch.duplicates, layers: layersFor(feed.descriptor.category, feed.descriptor.format), knownFrom: known[0] ?? at, knownTo: known[known.length - 1] ?? at,
          simulated: feed.descriptor.simulated
        };
        events.push(event);
      }
      if (appended > 0 || Object.keys(rawIndex).length !== Object.keys(manifest.raw).length) await this.writeManifest({ ...manifest, segments, raw: rawIndex });

      // Overflow degrades a flowing feed, with the reason, once.
      let feeds = registry.feeds;
      for (const feedId of overflowed) {
        const current = feeds[feedId];
        if (!current || (current.state !== 'live' && current.state !== 'backfilling')) continue;
        const step = feedSourceTransition(current.state, 'degrade', { kind: 'system' }, false);
        if (!step.ok) continue;
        feeds = { ...feeds, [feedId]: { descriptor: current.descriptor, state: step.to, since: at, reason: 'overflow' } };
        events.push({ type: 'feed.source.state', run: this.run(), at, feed: feedId, from: current.state, to: step.to, reason: 'overflow', simulated: current.descriptor.simulated } satisfies FeedSourceStateEvent);
      }
      const rows = [...loaded.value.rows, ...[...pending.values()].flatMap((batch) => batch.rows)];
      const ticked = this.trackChanges({ ...registry, feeds }, rows, this.now(), at);
      if (feeds !== registry.feeds || ticked.changed) await this.writeRegistry(ticked.registry);
      await this.emit([...events, ...ticked.events]);
      return { ok: refused.length === 0, appended, duplicates, refused };
    });
    return 'appended' in result ? result : { ok: false, appended: 0, duplicates: 0, refused: [], message: result.message };
  }

  /** Keeps the raw messages of a stream's rows in the segment's raw file, bounded per message and per segment; past either bound, only the hash is kept. */
  private async keepRaw(id: string, rows: readonly Observation[], raw: Readonly<Record<string, string>> | undefined, registry: FeedRegistry, index: StoreManifest['raw']): Promise<StoreManifest['raw']> {
    if (!raw) return index;
    const feed = registry.feeds[rows[0].feed];
    if (!feed || !keepsRawCopies(feed.descriptor)) return index;
    const entry = index[id] ?? { bytes: 0, messages: 0, feedClass: feed.descriptor.feedClass };
    let bytes = entry.bytes;
    const lines: string[] = [];
    for (const row of rows) {
      if (!Object.prototype.hasOwnProperty.call(raw, row.obsId) || typeof raw[row.obsId] !== 'string') continue;
      const message = raw[row.obsId];
      const size = Buffer.byteLength(message);
      const keepText = size <= RAW_MESSAGE_MAX_BYTES && bytes + size + 200 <= RAW_SEGMENT_MAX_BYTES;
      const line = `${JSON.stringify({ obsId: row.obsId, sha256: sha256(message), bytes: size, ...(keepText ? { raw: message } : {}) })}\n`;
      bytes += Buffer.byteLength(line);
      lines.push(line);
    }
    if (!lines.length) return index;
    const file = this.file(rawFile(id));
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, lines.join(''), 'utf8');
    return { ...index, [id]: { bytes, messages: entry.messages + lines.length, feedClass: entry.feedClass } };
  }

  /** Removes raw messages past their feed class's retention. Observation rows are never removed. */
  public async pruneRaw(): Promise<StoreResult> {
    return this.locked(async () => {
      const loaded = await this.load();
      if (!loaded.ok) return loaded;
      const manifest = loaded.value.manifest;
      const now = this.now();
      const raw = { ...manifest.raw };
      const expired = [...manifest.rawExpired];
      for (const [id, entry] of Object.entries(manifest.raw)) {
        const hour = parseSegmentId(id)?.hour;
        if (!hour || !rawExpired(hour, entry.feedClass, now)) continue;
        await rm(this.file(rawFile(id)), { force: true });
        delete raw[id];
        expired.push(id);
      }
      if (expired.length === manifest.rawExpired.length) return { ok: true, text: 'No raw messages are past their retention.' };
      await this.writeManifest({ ...manifest, raw, rawExpired: expired.slice(-OBS_MAX_GAPS) });
      return { ok: true, text: `Raw messages of ${expired.length - manifest.rawExpired.length} segment(s) reached the end of their retention and were removed. The observations stay.` };
    });
  }

  /** The tracks whose display state changed since it was last recorded, as events, and the registry that records the new states. */
  private trackChanges(registry: FeedRegistry, rows: readonly Observation[], now: number, at: string): { registry: FeedRegistry; events: TrackStateEvent[]; changed: boolean } {
    const states: Record<string, TrackState> = { ...registry.trackStates };
    const events: TrackStateEvent[] = [];
    for (const track of tracksAt(rows, lookupOf(registry), now)) {
      const before = states[track.trackId];
      if (before === track.state) continue;
      states[track.trackId] = track.state;
      const feed = registry.feeds[track.last.feed];
      const layer = feed ? trackLayerFor(feed.descriptor) : undefined;
      if (!layer) continue;
      const closed = track.state === 'closed' ? registry.closed.find((entry) => entry.trackId === track.trackId) : undefined;
      events.push({ type: 'feed.track.state', run: this.run(), at, trackId: track.trackId, layer, from: before ?? null, to: track.state, ...(closed ? { by: closed.by } : {}) });
    }
    return { registry: { ...registry, trackStates: states }, events, changed: events.length > 0 };
  }

  /** Records every track whose display state changed by now (decay: live to stale to lost), once each. */
  public async tick(): Promise<StoreResult> {
    return this.locked(async () => {
      const loaded = await this.load();
      if (!loaded.ok) return loaded;
      const at = isoOf(this.now());
      const ticked = this.trackChanges(loaded.value.registry, loaded.value.rows, this.now(), at);
      if (ticked.changed) await this.writeRegistry(ticked.registry);
      await this.emit(ticked.events);
      return { ok: true, text: `${ticked.events.length} track state change${ticked.events.length === 1 ? '' : 's'} recorded.` };
    });
  }

  /** A named person closes a track: it is hidden from the live picture and stays replayable. Its observations stay. */
  public async closeTrack(trackId: string, person: PersonActor): Promise<StoreResult> {
    if (!isNamedPerson(person)) return { ok: false, message: 'Only a named person may close a track.' };
    return this.locked(async () => {
      const loaded = await this.load();
      if (!loaded.ok) return loaded;
      const registry = loaded.value.registry;
      if (!loaded.value.rows.some((row) => row.trackId === trackId)) return { ok: false, message: `The store holds no track ${trackId}.` };
      if (registry.closed.some((entry) => entry.trackId === trackId)) return { ok: true, text: `${trackId} is already closed.` };
      const at = isoOf(this.now());
      const next: FeedRegistry = { ...registry, closed: [...registry.closed, { trackId, at, by: { name: person.name, role: person.role } }] };
      const ticked = this.trackChanges(next, loaded.value.rows, this.now(), at);
      await this.writeRegistry(ticked.registry);
      await this.emit(ticked.events);
      return { ok: true, text: `${trackId} is closed by ${person.name} (${person.role}). Its observations stay, and replay still shows it.` };
    });
  }
}

/** How tracks of a registry decay and close. A row from a feed the registry no longer names decays as an event feed would. */
export function lookupOf(registry: FeedRegistry): TrackLookup {
  return {
    decayOf: (feed) => {
      const entry = registry.feeds[feed];
      return entry ? feedDecay(entry.descriptor) : { staleAfterSeconds: 900, lostAfterSeconds: 3600 };
    },
    closedAt: (trackId) => registry.closed.find((entry) => entry.trackId === trackId)?.at
  };
}

/** The stores, one per project root, made on first use with the options the extension set at activation. */
const stores = new Map<string, ObservationStore>();
let configured: Omit<ObservationStoreOptions, 'root'> | undefined;

/** Called once at activation (with the staff host's event log as the sink); until then the observations tools say the store is not ready. */
export function configureObservationStores(options: Omit<ObservationStoreOptions, 'root'> | undefined): void {
  configured = options;
  stores.clear();
}

export function observationStoreFor(root: string): ObservationStore | undefined {
  if (!configured) return undefined;
  const key = path.resolve(root);
  let store = stores.get(key);
  if (!store) { store = new ObservationStore({ ...configured, root: key }); stores.set(key, store); }
  return store;
}

export { OBS_RAW_DIR };
