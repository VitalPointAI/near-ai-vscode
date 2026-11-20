// The local observation store's rules (research note 11, sections 3.1, 4.2, 4.3, 4.7 and 9.2; WP-OBS): where segments live, how big they may grow, which
// rows a segment accepts, what a manifest and the feed registry hold, and the raw-copy exception. Pure: no I/O, no clock, no vscode. The store that reads
// and writes the files is src/staff/observationStore.ts.
//
// Rows are appended to one NDJSON segment per feed, channel and hour (segmentId), never rewritten. A segment, the manifest or the feed registry that is
// there but cannot be read whole is `unreadable`, never empty: an empty read would hide rows from every answer and let the next append start a file again
// on top of the old one (the rule of drop 1's ledger).
import { belowOnScale } from '../../gate/dominance';
import { activeScales } from '../../gate/labelAlgebra';
import { labelKey } from '../../gate/labels';
import type { Label } from '../../gate/labels';
import { FEED_SOURCE_STATES, channelHandling, channelLabel, parseFeedDescriptor } from './feeds';
import type { FeedClass, FeedDescriptor, FeedSourceState } from './feeds';
import { layersFor } from './layers';
import { segmentId } from './observation';
import type { Observation } from './observation';
import { TRACK_STATES } from './tracks';
import type { TrackState } from './tracks';

/** The store's folder in the project. It holds a `.gitignore` of its own: observations are not committed (note 11, 9.2). */
export const OBS_STORE_DIR = '.planning/staff/observations';
export const OBS_MANIFEST_FILE = 'manifest.json';
export const OBS_REGISTRY_FILE = 'feeds.json';
export const OBS_SEGMENTS_DIR = 'segments';
export const OBS_RAW_DIR = 'raw';
export const OBS_STORE_VERSION = 1;

/** The largest segment the store writes or reads whole. A segment past it is full for appends and unreadable for reads. */
export const OBS_SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
/** The most bytes of segments one project's store holds. Past it, appends are refused and the feed is degraded with `overflow`. */
export const OBS_STORE_MAX_BYTES = 512 * 1024 * 1024;
/** The largest manifest or feed registry the store reads whole. */
export const OBS_INDEX_MAX_BYTES = 4 * 1024 * 1024;
/** The most rows one append takes. */
export const OBS_APPEND_MAX_ROWS = 5000;

// ---- The raw-copy exception (owner decision Q2, 2026-11-18) -------------------------------------------------------------------------------------

/**
 * Why raw feed messages are kept beside the rows, in the store's own words. The v0.6.0 storage rules allow raw copies only for documented reasons; the
 * owner accepted this one: a live stream cannot be read again from its source, so its raw messages are what keeps provenance (and erasure) possible.
 */
export const RAW_COPY_REASON =
  'Feed segments: a live stream cannot be read again from its source, so its raw messages are kept beside the rows they became, bounded by a retention period per feed class.';

/** How long raw messages are kept, by feed class, in hours. Static data comes from files that can be read again, so none is kept. Design values. */
export const RAW_RETENTION_HOURS: Readonly<Record<FeedClass, number>> = { positions: 72, events: 30 * 24, reports: 90 * 24, gridded: 7 * 24, static: 0 };
/** One raw message is kept up to this size; a larger one keeps its hash and length only. */
export const RAW_MESSAGE_MAX_BYTES = 64 * 1024;
/** A raw segment is kept up to this size; past it, later messages keep their hash and length only. */
export const RAW_SEGMENT_MAX_BYTES = 8 * 1024 * 1024;

/** Whether raw messages of a feed are kept at all: only streams (loopback, outside, partner) cannot be read again; a file import can. */
export function keepsRawCopies(feed: Pick<FeedDescriptor, 'transport' | 'feedClass'>): boolean {
  return feed.transport !== 'file-import' && RAW_RETENTION_HOURS[feed.feedClass] > 0;
}

/** Whether a raw segment of `hour` (`YYYY-MM-DDTHH`) is past its feed class's retention at `now`. */
export function rawExpired(hour: string, feedClass: FeedClass, now: number): boolean {
  const start = Date.parse(`${hour}:00:00.000Z`);
  if (Number.isNaN(start)) return false;
  return now >= start + (RAW_RETENTION_HOURS[feedClass] + 1) * 3600 * 1000;
}

// ---- Paths ------------------------------------------------------------------------------------------------------------------------------------

/** A segment's file under the store folder: `segments/<feed>/<channel>/<YYYY-MM-DDTHH>.ndjson`. */
export function segmentFile(segment: string): string {
  return `${OBS_SEGMENTS_DIR}/${segment}.ndjson`;
}

/** A segment's raw messages: `raw/<feed>/<channel>/<YYYY-MM-DDTHH>.ndjson`. */
export function rawFile(segment: string): string {
  return `${OBS_RAW_DIR}/${segment}.ndjson`;
}

const SEGMENT_ID = /^([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9][a-z0-9-]{0,63})\/(\d{4}-\d{2}-\d{2}T\d{2})$/;

/** A segment id read back from a path or manifest key, or undefined for anything that is not one. */
export function parseSegmentId(value: unknown): { feed: string; channel: string; hour: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = SEGMENT_ID.exec(value);
  return match ? { feed: match[1], channel: match[2], hour: match[3] } : undefined;
}

// ---- Sentences --------------------------------------------------------------------------------------------------------------------------------

/** Why the store refused a row, a write or a read, one sentence each. */
export const STORE_FAILURES = {
  'not-a-row': 'The row is not a valid observation.',
  'unknown-feed': 'The row names a feed the store does not know. Register the feed first.',
  'unknown-channel': 'The row names a channel its feed does not have.',
  'not-flowing': 'The feed is not live, backfilling or degraded, so it takes no rows. A person approves a feed and its runtime starts it.',
  'simulated-mismatch': 'A row from a simulated feed must be marked simulated, and only those rows may be.',
  'label-too-low': 'The row is labelled lower than its channel: the label is stamped by the feed, and never lowered.',
  'handling-missing': 'The row drops a handling flag its feed requires: partner-only reporting is always local-only.',
  'discipline-mismatch': 'The row\'s discipline is not its channel\'s.',
  'segment-unreadable': 'The row\'s segment cannot be read whole, so nothing is appended to it.',
  'segment-full': 'The row\'s segment is full for this hour.',
  'store-full': 'The observation store has reached its size limit for this project.',
  'store-unreadable': 'The observation store\'s index or feed registry cannot be read, so nothing is appended.'
} as const;
export type StoreFailure = keyof typeof STORE_FAILURES;

/** The sentence an answer carries when part of the store could not be read: never silence, never an empty answer that looks complete. */
export function unreadableNote(count: number): string {
  return `${count} segment${count === 1 ? '' : 's'} of the observation store cannot be read, so this answer leaves out whatever ${count === 1 ? 'it holds' : 'they hold'} and may be incomplete. obs.feeds lists ${count === 1 ? 'it' : 'them'}.`;
}

/** The plain sentence for a store file that is there but cannot be read whole, and the way out. */
export function storeUnreadableText(file: string, reason: string, wayOut: string): string {
  return `${file} cannot be read: ${reason}. Nothing was changed. ${wayOut}`;
}

// ---- The manifest: the segment index ------------------------------------------------------------------------------------------------------------

export interface SegmentEntry {
  /** Bytes and SHA-256 of the file as the store last wrote it, and its row count. */
  readonly bytes: number;
  readonly sha256: string;
  readonly rows: number;
  readonly knownFrom: string;
  readonly knownTo: string;
}

export interface RawEntry { readonly bytes: number; readonly messages: number; readonly feedClass: FeedClass }

export interface StoreManifest {
  readonly v: typeof OBS_STORE_VERSION;
  readonly segments: Readonly<Record<string, SegmentEntry>>;
  readonly raw: Readonly<Record<string, RawEntry>>;
  /** Raw segments removed at the end of their retention, so a missing raw file is never mistaken for a lost one. */
  readonly rawExpired: readonly string[];
}

export function emptyManifest(): StoreManifest {
  return { v: OBS_STORE_VERSION, segments: {}, raw: {}, rawExpired: [] };
}

const SHA256 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const own = (value: object, key: string): unknown => (Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;

/** Reads a manifest strictly, or undefined: a manifest that does not read is unreadable, never empty. */
export function parseManifest(value: unknown): StoreManifest | undefined {
  if (!isObject(value) || own(value, 'v') !== OBS_STORE_VERSION) return undefined;
  const segments = own(value, 'segments');
  const raw = own(value, 'raw');
  const expired = own(value, 'rawExpired');
  if (!isObject(segments) || !isObject(raw) || !Array.isArray(expired)) return undefined;
  const outSegments: Record<string, SegmentEntry> = {};
  for (const [key, entry] of Object.entries(segments)) {
    if (!parseSegmentId(key) || !isObject(entry)) return undefined;
    const bytes = own(entry, 'bytes'); const sha = own(entry, 'sha256'); const rows = own(entry, 'rows');
    const from = own(entry, 'knownFrom'); const to = own(entry, 'knownTo');
    if (!count(bytes, OBS_STORE_MAX_BYTES) || typeof sha !== 'string' || !SHA256.test(sha) || !count(rows, 10_000_000)) return undefined;
    if (typeof from !== 'string' || !ISO.test(from) || typeof to !== 'string' || !ISO.test(to)) return undefined;
    outSegments[key] = { bytes, sha256: sha, rows, knownFrom: from, knownTo: to };
  }
  const outRaw: Record<string, RawEntry> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!parseSegmentId(key) || !isObject(entry)) return undefined;
    const bytes = own(entry, 'bytes'); const messages = own(entry, 'messages'); const feedClass = own(entry, 'feedClass');
    if (!count(bytes, OBS_STORE_MAX_BYTES) || !count(messages, 10_000_000) || typeof feedClass !== 'string' || !Object.prototype.hasOwnProperty.call(RAW_RETENTION_HOURS, feedClass)) return undefined;
    outRaw[key] = { bytes, messages, feedClass: feedClass as FeedClass };
  }
  if (!expired.every((key) => parseSegmentId(key) !== undefined)) return undefined;
  return { v: OBS_STORE_VERSION, segments: outSegments, raw: outRaw, rawExpired: [...expired] as string[] };
}

// ---- The feed registry: descriptors, source states, gaps and closed tracks -----------------------------------------------------------------------

export interface RegisteredFeed {
  readonly descriptor: FeedDescriptor;
  readonly state: FeedSourceState;
  readonly since: string;
  readonly reason?: string;
}

export interface GapRecord { readonly feed: string; readonly channel: string; readonly from: string; readonly to: string; readonly reason: string }

export interface ClosedTrack { readonly trackId: string; readonly at: string; readonly by: { readonly name: string; readonly role: string } }

export interface FeedRegistry {
  readonly v: typeof OBS_STORE_VERSION;
  readonly feeds: Readonly<Record<string, RegisteredFeed>>;
  readonly gaps: readonly GapRecord[];
  readonly closed: readonly ClosedTrack[];
  /** The display state each track was last recorded in (feed.track.state), so a state change is recorded once. */
  readonly trackStates: Readonly<Record<string, TrackState>>;
}

export const OBS_MAX_GAPS = 5000;

export function emptyRegistry(): FeedRegistry {
  return { v: OBS_STORE_VERSION, feeds: {}, gaps: [], closed: [], trackStates: {} };
}

/** Reads a feed registry strictly (every descriptor through the contract's reader), or undefined. */
export function parseRegistry(value: unknown): FeedRegistry | undefined {
  if (!isObject(value) || own(value, 'v') !== OBS_STORE_VERSION) return undefined;
  const feeds = own(value, 'feeds'); const gaps = own(value, 'gaps'); const closed = own(value, 'closed'); const states = own(value, 'trackStates');
  if (!isObject(feeds) || !Array.isArray(gaps) || gaps.length > OBS_MAX_GAPS || !Array.isArray(closed) || !isObject(states)) return undefined;
  const outFeeds: Record<string, RegisteredFeed> = {};
  for (const [key, entry] of Object.entries(feeds)) {
    if (!isObject(entry)) return undefined;
    const parsed = parseFeedDescriptor(own(entry, 'descriptor'));
    const state = own(entry, 'state'); const since = own(entry, 'since'); const reason = own(entry, 'reason');
    if (!parsed.ok || parsed.value.id !== key) return undefined;
    if (typeof state !== 'string' || !(FEED_SOURCE_STATES as readonly string[]).includes(state) || typeof since !== 'string' || !ISO.test(since)) return undefined;
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 300)) return undefined;
    outFeeds[key] = { descriptor: parsed.value, state: state as FeedSourceState, since, ...(reason !== undefined ? { reason } : {}) };
  }
  const outGaps: GapRecord[] = [];
  for (const gap of gaps) {
    if (!isObject(gap)) return undefined;
    const feed = own(gap, 'feed'); const channel = own(gap, 'channel'); const from = own(gap, 'from'); const to = own(gap, 'to'); const reason = own(gap, 'reason');
    if (typeof feed !== 'string' || typeof channel !== 'string' || typeof from !== 'string' || !ISO.test(from) || typeof to !== 'string' || !ISO.test(to) || typeof reason !== 'string') return undefined;
    outGaps.push({ feed, channel, from, to, reason });
  }
  const outClosed: ClosedTrack[] = [];
  for (const entry of closed) {
    if (!isObject(entry)) return undefined;
    const trackId = own(entry, 'trackId'); const at = own(entry, 'at'); const by = own(entry, 'by');
    if (typeof trackId !== 'string' || typeof at !== 'string' || !ISO.test(at) || !isObject(by)) return undefined;
    const name = own(by, 'name'); const role = own(by, 'role');
    if (typeof name !== 'string' || typeof role !== 'string') return undefined;
    outClosed.push({ trackId, at, by: { name, role } });
  }
  const outStates: Record<string, TrackState> = {};
  for (const [key, state] of Object.entries(states)) {
    if (typeof state !== 'string' || !(TRACK_STATES as readonly string[]).includes(state)) return undefined;
    outStates[key] = state as TrackState;
  }
  return { v: OBS_STORE_VERSION, feeds: outFeeds, gaps: outGaps, closed: outClosed, trackStates: outStates };
}

// ---- Which rows a feed's segment accepts ------------------------------------------------------------------------------------------------------

/** The states a feed takes rows in. */
export const FLOWING_STATES: readonly FeedSourceState[] = ['live', 'backfilling', 'degraded'];

/**
 * Whether the store takes a row from its feed, or why not. The label was stamped by the feed before the row existed (note 11, 4.2); the store holds it
 * to that stamp: never below its channel's label on the same scale, with every handling flag the feed requires, from a channel the feed has, marked
 * simulated exactly when the feed is.
 */
export function rowFits(row: Observation, feed: RegisteredFeed | undefined): StoreFailure | undefined {
  if (!feed) return 'unknown-feed';
  if (!FLOWING_STATES.includes(feed.state)) return 'not-flowing';
  const descriptor = feed.descriptor;
  const channel = descriptor.channels.find((entry) => entry.id === row.channel);
  if (!channel) return 'unknown-channel';
  if (row.simulated !== descriptor.simulated) return 'simulated-mismatch';
  if (row.discipline !== channel.discipline) return 'discipline-mismatch';
  const stamped = channelLabel(descriptor, channel);
  // Ranked by the label module on the active policy's scales (D-35).
  if (belowOnScale(row.label, stamped, activeScales())) return 'label-too-low';
  if (channelHandling(descriptor, channel).some((flag) => !row.handling.includes(flag))) return 'handling-missing';
  if (row.segment !== segmentId(row.feed, row.channel, row.knownAt)) return 'not-a-row';
  return undefined;
}

/** A row's label as the gate holds it, with its handling flags, for the reader's clearance check and for raising the chat's mark. */
export function rowLabel(row: Pick<Observation, 'label' | 'handling'>): Label {
  const at = row.label.indexOf('/');
  return { scale: row.label.slice(0, at), level: row.label.slice(at + 1), compartments: [], releasability: [], handling: [...row.handling] };
}

/** The distinct labels of rows, as the gate holds them. */
export function rowLabels(rows: ReadonlyArray<Pick<Observation, 'label' | 'handling'>>): Label[] {
  const out = new Map<string, Label>();
  for (const row of rows) {
    const label = rowLabel(row);
    out.set(`${labelKey(label)}|${label.handling.join(',')}`, label);
  }
  return [...out.values()];
}

/** The one COP feed layer a track from this feed shows on (its `feed.track.state` events): positions by kind first, then intelligence. */
export function trackLayerFor(feed: Pick<FeedDescriptor, 'category' | 'format'>): string | undefined {
  const layers = layersFor(feed.category, feed.format);
  const prefer = feed.category === 'own-force' ? ['cop-feed-friendly']
    : feed.format === 'ais-nmea' ? ['cop-feed-maritime']
      : feed.format === 'adsb-json' ? ['cop-feed-air']
        : feed.category === 'intelligence' ? ['cop-feed-intelligence'] : [];
  return prefer.find((layer) => layers.includes(layer)) ?? layers[0];
}
