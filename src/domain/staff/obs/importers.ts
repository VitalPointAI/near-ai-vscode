// The feed file importers (research note 11, 9.2 item 3 and the WP-IMP row of 9.3; risks in section 10): GeoJSON, KML, CoT XML, RSS 2.0, Atom and AIS
// NMEA logs become observation rows in the WP-OBS0 contract and enter the store through its one append path. Pure: no I/O, no clock, no vscode.
//
// Two halves, run in two places:
// - parseFeedText (format detection and the codecs) runs only in the importer's own process (src/staff/feedImport/worker.ts), with its own memory, size
//   and time caps, never in the extension host: a hostile file can at worst kill that process.
// - planImport runs in the host on the neutral records the process returns: it places each record in the exercise frame, holds what falls outside it
//   (the guard-scan geofence: the frame box is allowed and everything else is held), stamps the label (clamped up to the channel's label, refused above
//   the template ceiling), and reads every row back through the contract's strict reader before the store sees it.
//
// Imported rows are never marked simulated: they say which file they came from and when it was imported (`source`, `knownAt`). Message ids come from the
// content, so importing the same file twice adds nothing.
import { STAFF_TEMPLATE_LABELS } from '../doctrine';
import type { ExerciseBox } from '../guardScan';
import { insidePolygon } from '../guardScan';
import { channelHandling, channelLabel } from './feeds';
import { frameBox, gridToWgs84 } from './frame';
import type { ExerciseFrame } from './frame';
import type { ChannelDescriptor, FeedDescriptor, FeedFormat, FeedSourceEvent, FeedSourceState } from './feeds';
import { belowOnScale } from '../../gate/dominance';
import { activeScales } from '../../gate/labelAlgebra';
import { observationId, OBSERVATION_SCHEMA, parseObservation, readGeometry, segmentId } from './observation';
import { reading } from './read';
import type { Observation, ObservationGeometry, Position } from './observation';
import { AIS_PROBLEMS, readAisLog } from './codecs/ais';
import type { AisPosition } from './codecs/ais';
import { cotEventFrom, cotIdentity, cotPositionMethod } from './codecs/cot';
import type { CotEvent } from './codecs/cot';
import { readGeoJson } from './codecs/geojson';
import { readKml } from './codecs/kml';
import { cleanText, contentHash, countProblem, isoOf, subjectRefOf, trackIdOf } from './codecs/record';
import type { CodecResult, ImportRecord } from './codecs/record';
import { readAtom, readRss } from './codecs/rss';
import { descendants, localName, readXml, XML_FAILURES } from './codecs/xml';
import type { XmlFailure } from './codecs/xml';

/** The formats a person can import, and the store format each is filed under. */
export const IMPORT_FORMATS = ['geojson', 'kml', 'cot', 'rss', 'atom', 'ais'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export const IMPORT_FORMAT_WORDS: Readonly<Record<ImportFormat, string>> = {
  geojson: 'GeoJSON', kml: 'KML', cot: 'Cursor on Target (CoT) XML', rss: 'RSS 2.0', atom: 'Atom', ais: 'AIS NMEA sentences'
};

/** The codec version the importers write into every row's `extractor`. Bumped when any codec's output changes. */
export const IMPORT_CODEC_VERSION = '1.0.0';

/** The largest file the importer reads, the most rows one import writes, and how long the parser process may run. */
export const IMPORT_MAX_BYTES = 16 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 10_000;
export const IMPORT_TIMEOUT_MS = 20_000;
/** The parser process's heap, in megabytes. */
export const IMPORT_MAX_HEAP_MB = 256;

/** A record with no position (an RSS item without GeoRSS) is placed at the centre of the frame with this error, so a slice by area finds it only across the frame. */
export const RSS_AREA_ERROR_METRES = 50_000;

// ---- Feed descriptors --------------------------------------------------------------------------------------------------------------------------

const FORMAT_OF: Readonly<Record<ImportFormat, FeedFormat>> = { geojson: 'geojson', kml: 'kml', cot: 'cot', rss: 'rss', atom: 'atom', ais: 'ais-nmea' };
const CLASS_OF = { geojson: 'static', kml: 'static', cot: 'events', rss: 'reports', atom: 'reports', ais: 'positions' } as const;

/** The channel every import of a format goes to: files a person imports. Ungraded (F and 6) until a person grades it in the source register. */
export const IMPORT_CHANNEL = 'file';

/**
 * One feed per format, filed as your organization's own data arriving by file import. Never simulated; never used for training unless your
 * organization says so (`unknown` means no).
 */
export function importFeed(format: ImportFormat): FeedDescriptor {
  const osint = format === 'rss' || format === 'atom' || format === 'ais';
  const channel: ChannelDescriptor = {
    id: IMPORT_CHANNEL, title: 'Files a person imports', discipline: osint ? 'OSINT' : null, reliability: 'F', credibility: 6,
    ...(format === 'ais' ? { origin: 'Vessel transponders (self-reported)' } : {})
  };
  return {
    id: `import-${format}`, title: `Imported ${IMPORT_FORMAT_WORDS[format]} files`, category: 'intelligence', feedClass: CLASS_OF[format], format: FORMAT_OF[format],
    transport: 'file-import', licenceClass: 'organization-own', trainingRights: 'unknown', simulated: false, channels: [channel]
  };
}

// ---- Problems ----------------------------------------------------------------------------------------------------------------------------------

/** Why an item of a file was skipped, one sentence each. */
export const IMPORT_PROBLEMS: Readonly<Record<string, string>> = {
  ...AIS_PROBLEMS,
  'not-geojson': 'The file is not GeoJSON.',
  'not-kml': 'The file is not KML.',
  'not-rss': 'The file is not an RSS 2.0 feed.',
  'not-atom': 'The file is not an Atom feed.',
  empty: 'The file holds nothing to import.',
  'empty-item': 'An item has neither a title nor a summary.',
  'too-many': `The file holds more than ${IMPORT_MAX_ROWS.toLocaleString('en-CA')} observations; the rest were not read. Split the file.`,
  'bad-geometry': 'A geometry is not a valid WGS 84 point, line or polygon (coordinates out of range, a ring that does not close, too few or too many positions).',
  'no-geometry': 'A feature has no geometry.',
  'unsupported-geometry': 'A geometry kind the importer does not read (a model, a track or an overlay).',
  'not-an-event': 'An element is not a CoT event.',
  'missing-fields': 'A CoT event lacks its uid, type, time or point.',
  'bad-point': 'A CoT point is not a valid latitude and longitude.'
};

/** Why a row was held back rather than written. */
export const IMPORT_HOLDS = {
  'outside-frame': 'Its position is outside the exercise frame, so it is held and not imported (the guard-scan geofence).',
  'no-frame': 'The project has no exercise frame (load a scenario with a frame, or set the exercise box), so nothing with a position can be placed.'
} as const;
export type ImportHold = keyof typeof IMPORT_HOLDS;

// ---- Parsing (in the importer's own process) -------------------------------------------------------------------------------------------------

export type ParsedFeed =
  | { readonly ok: true; readonly format: ImportFormat; readonly records: ImportRecord[]; readonly problems: Record<string, number> }
  | { readonly ok: false; readonly message: string };

/** The format a file's content is in, from its first bytes; undefined when it is none of them. */
export function detectFormat(text: string): ImportFormat | undefined {
  const head = text.replace(/^﻿/, '').slice(0, 64 * 1024);
  const first = head.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '' && !line.startsWith('#'));
  if (first === undefined) return undefined;
  if (first.startsWith('{') || first.startsWith('[')) return 'geojson';
  if (first.startsWith('!') || first.startsWith('\\')) return 'ais';
  if (!first.startsWith('<')) return undefined;
  const root = /<([A-Za-z_][A-Za-z0-9_.:-]*)[\s/>]/.exec(head.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, ''));
  const name = root ? localName(root[1]) : '';
  return name === 'event' || name === 'events' ? 'cot' : name === 'rss' ? 'rss' : name === 'feed' ? 'atom' : name === 'kml' ? 'kml' : undefined;
}

function xmlRefusal(reason: XmlFailure): ParsedFeed {
  return { ok: false, message: XML_FAILURES[reason] };
}

const round = (value: number, places: number): number => Math.round(value * 10 ** places) / 10 ** places;

/**
 * One CoT event as a record, shared by the importer and the simulator's ingest: the event's `uid` and `time` are its message id (note 11, 3.1); a shape
 * of four corners or more is a footprint polygon (closed if the producer left it open); a point is a track by `uid`.
 */
export function cotRecord(event: CotEvent): ImportRecord {
  const corners = event.shape.map(([lat, lon]) => [round(lon, 7), round(lat, 7)] as Position);
  if (corners.length >= 3) {
    const first = corners[0];
    const last = corners[corners.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) corners.push(first);
  }
  const footprint = corners.length >= 4;
  const geometry: ObservationGeometry = footprint
    ? { type: 'Polygon', coordinates: [corners] }
    : { type: 'Point', coordinates: event.hae !== null && event.hae !== 0 ? [round(event.lon, 7), round(event.lat, 7), round(event.hae, 1)] : [round(event.lon, 7), round(event.lat, 7)] };
  const identity = cotIdentity(event.type);
  const validAt = isoOf(event.time);
  const stale = isoOf(event.stale);
  const name = cleanText(event.callsign, 120);
  const excerpt = cleanText(event.remarks, 500);
  const subjectRef = subjectRefOf(event.uid);
  const attributes = {
    ...(name ? { name } : {}), ...(excerpt ? { excerpt } : {}),
    ...(event.course !== undefined ? { courseDegrees: event.course } : {}), ...(event.speed !== undefined ? { speedMetresPerSecond: event.speed } : {})
  };
  return {
    messageId: cleanText(`${event.uid}@${event.time}`, 200) ?? contentHash(event),
    ...(validAt ? { validAt } : {}), ...(validAt && stale && stale >= validAt ? { validUntil: stale } : {}),
    geometry, error: { circularMetres: event.ce, verticalMetres: event.le }, how: cotPositionMethod(event.how),
    ...(subjectRef ? { subjectRef } : {}), ...(cleanText(event.type, 40) ? { observedType: cleanText(event.type, 40) } : {}),
    ...(identity ? { claimedIdentity: identity } : {}), ...(Object.keys(attributes).length ? { attributes } : {}),
    ...(!footprint && trackIdOf('cot', event.uid) ? { trackId: trackIdOf('cot', event.uid) } : {})
  };
}

/** The attributes of an AIS position, in the row's units (knots to metres a second), with the vessel's name when one is known. */
export function aisAttributes(position: AisPosition, name: string | undefined): Record<string, unknown> {
  const clean = cleanText(name, 120);
  return {
    ...(clean ? { name: clean } : {}), ...(position.speedKnots !== undefined ? { speedMetresPerSecond: round(position.speedKnots * 1852 / 3600, 2) } : {}),
    ...(position.courseDegrees !== undefined ? { courseDegrees: position.courseDegrees } : {}), ...(position.headingDegrees !== undefined ? { headingDegrees: position.headingDegrees } : {})
  };
}

function readCot(text: string, maxRecords: number): CodecResult | ParsedFeed {
  const xml = readXml(text, { fragments: true });
  if (!xml.ok) return xmlRefusal(xml.reason);
  const records: ImportRecord[] = [];
  const problems: Record<string, number> = {};
  const events = xml.root.children.flatMap((element) => (localName(element.name) === 'event' ? [element] : descendants(element, 'event')));
  if (!events.length) countProblem(problems, 'empty');
  for (const element of events) {
    if (records.length >= maxRecords) { countProblem(problems, 'too-many'); break; }
    const event = cotEventFrom(element);
    if (typeof event === 'string') { countProblem(problems, event); continue; }
    records.push(cotRecord(event));
  }
  return { records, problems };
}

function readAis(text: string, maxRecords: number): CodecResult {
  const log = readAisLog(text, maxRecords * 4);
  const problems: Record<string, number> = { ...log.problems } as Record<string, number>;
  // Names come from the static messages (5, 24 part A) and the extended Class B report (19), wherever they are in the file.
  const names = new Map<number, string>();
  for (const { decoded } of log.messages) if (decoded.name) names.set(decoded.mmsi, decoded.name);
  const records: ImportRecord[] = [];
  for (const { decoded, sentences, line } of log.messages) {
    if (decoded.kind !== 'position') continue;
    if (records.length >= maxRecords) { countProblem(problems, 'too-many'); break; }
    const receivedAt = sentences.find((sentence) => sentence.receivedAt !== undefined)?.receivedAt;
    const validAt = isoOf(receivedAt);
    records.push({
      messageId: `ais:${contentHash(sentences.map((sentence) => sentence.raw))}@${line}`,
      ...(validAt ? { validAt } : {}),
      geometry: { type: 'Point', coordinates: [round(decoded.lon, 6), round(decoded.lat, 6)] },
      error: { circularMetres: decoded.highAccuracy ? 10 : 100, verticalMetres: null }, how: 'reported',
      subjectRef: String(decoded.mmsi), attributes: aisAttributes(decoded, names.get(decoded.mmsi)), trackId: `mmsi:${decoded.mmsi}`
    });
  }
  return { records, problems };
}

/** Parses a feed file's text. Runs in the importer's own process. A whole-file refusal (DOCTYPE, an unknown format) is `ok: false`. */
export function parseFeedText(text: string, options: { readonly format?: ImportFormat; readonly maxRecords?: number } = {}): ParsedFeed {
  if (text.length > IMPORT_MAX_BYTES) return { ok: false, message: `The file is larger than ${IMPORT_MAX_BYTES / (1024 * 1024)} MB, the most the importer reads.` };
  const format = options.format ?? detectFormat(text);
  if (!format) return { ok: false, message: `The file is not in a format the importer reads (${IMPORT_FORMATS.map((entry) => IMPORT_FORMAT_WORDS[entry]).join(', ')}).` };
  const max = options.maxRecords ?? IMPORT_MAX_ROWS;
  let result: CodecResult | ParsedFeed;
  if (format === 'geojson') result = readGeoJson(text, max);
  else if (format === 'ais') result = readAis(text, max);
  else if (format === 'cot') result = readCot(text, max);
  else {
    const xml = readXml(text);
    if (!xml.ok) return xmlRefusal(xml.reason);
    result = format === 'kml' ? readKml(xml.root, max) : format === 'rss' ? readRss(xml.root, max) : readAtom(xml.root, max);
  }
  if ('ok' in result) return result;
  return { ok: true, format, records: result.records, problems: result.problems };
}

// ---- Planning (in the host) ----------------------------------------------------------------------------------------------------------------

/**
 * The label an import is stamped with: the person's choice, raised to the channel's label when it is lower on the same scale (the label is never below
 * what the feed stamps), and refused when it is above the staff template ceiling.
 */
export function clampImportLabel(chosen: string, feed: FeedDescriptor): { readonly ok: true; readonly label: string; readonly raised: boolean } | { readonly ok: false; readonly message: string } {
  if (!STAFF_TEMPLATE_LABELS.includes(chosen)) {
    return { ok: false, message: `Staff projects hold exercise and fictional data only, at ${STAFF_TEMPLATE_LABELS.join(', ')} at most. Higher labels belong on accredited systems.` };
  }
  const channel = feed.channels.find((entry) => entry.id === IMPORT_CHANNEL) ?? feed.channels[0];
  const floor = channelLabel(feed, channel);
  // Ranked by the label module on the active policy's scales (D-35): raised when it is below the channel's label on the same scale.
  if (belowOnScale(chosen, floor, activeScales())) return { ok: true, label: floor, raised: true };
  return { ok: true, label: chosen, raised: false };
}

/** The area an import may place rows in (the frame's box, the guard-scan geofence) and the frame's centre, for records that name no place. */
export function frameArea(frame: ExerciseFrame): { readonly area: ExerciseBox; readonly centre: readonly [number, number] } {
  const centre = gridToWgs84(frame, { eastingMetres: (frame.extent.eastings * frame.squareMetres) / 2, northingMetres: (frame.extent.northings * frame.squareMetres) / 2 });
  return { area: frameBox(frame), centre: [centre.longitude, centre.latitude] };
}

export interface ImportContext {
  readonly fileName: string;
  readonly importedAt: number;
  /** The label after clampImportLabel. */
  readonly label: string;
  /** The allowed area: the exercise frame's box. Absent: nothing with a position can be placed. */
  readonly area?: ExerciseBox;
  /** Where a record with no position is placed: the frame's centre, [longitude, latitude]. */
  readonly centre?: readonly [number, number];
}

export interface ImportPlan {
  readonly format: ImportFormat;
  readonly feed: FeedDescriptor;
  readonly fileName: string;
  readonly importedAt: string;
  readonly label: string;
  /** Rows ready for the store, each already read back through the contract. */
  readonly rows: readonly Observation[];
  readonly held: Partial<Record<ImportHold, number>>;
  /** Items the codec skipped, and rows the contract refused (`not-a-row`), by reason. */
  readonly problems: Readonly<Record<string, number>>;
  /** The span of the rows' valid times. */
  readonly span?: { readonly from: string; readonly to: string };
}

function vertices(geometry: ObservationGeometry): Position[] {
  if (geometry.type === 'Point') return [geometry.coordinates];
  if (geometry.type === 'LineString') return [...geometry.coordinates];
  return geometry.coordinates.flat();
}

/** The file name as rows name it: its base name only, one line, at most 120 characters. */
export function importFileName(name: string): string {
  return cleanText(name.split(/[\\/]/).pop(), 120) ?? 'unnamed file';
}

/** Turns parsed records into rows for the store, holding anything outside the frame. */
export function planImport(parsed: Extract<ParsedFeed, { ok: true }>, context: ImportContext): ImportPlan {
  const feed = importFeed(parsed.format);
  const channel = feed.channels[0];
  const known = new Date(context.importedAt).toISOString();
  const fileName = importFileName(context.fileName);
  const held: Partial<Record<ImportHold, number>> = {};
  const problems: Record<string, number> = { ...parsed.problems };
  const rows: Observation[] = [];
  const seen = new Set<string>();
  const hold = (reason: ImportHold): void => { held[reason] = (held[reason] ?? 0) + 1; };
  const codec = `import-${parsed.format}`;
  for (const record of parsed.records.slice(0, IMPORT_MAX_ROWS)) {
    // The records come from another process: each is read again here, and one that does not read is a skipped item, never a failed import.
    const checked = typeof record === 'object' && record !== null && typeof record.messageId === 'string'
      ? (record.geometry === undefined ? { ok: true as const, value: undefined } : reading(() => readGeometry(record.geometry, 'geometry')))
      : { ok: false as const };
    if (!checked.ok) { countProblem(problems, 'not-a-row'); continue; }
    let geometry = checked.value;
    let error = record.error;
    if (!geometry) {
      if (!context.centre) { hold('no-frame'); continue; }
      geometry = { type: 'Point', coordinates: [round(context.centre[0], 6), round(context.centre[1], 6)] };
      error = { circularMetres: RSS_AREA_ERROR_METRES, verticalMetres: null };
    }
    if (!context.area || context.area.length < 3) { hold('no-frame'); continue; }
    if (!vertices(geometry).every((point) => insidePolygon([point[0], point[1]], context.area!))) { hold('outside-frame'); continue; }
    const obsId = observationId(feed.id, channel.id, record.messageId);
    if (seen.has(obsId)) continue;
    seen.add(obsId);
    const raw: Record<string, unknown> = {
      schema: OBSERVATION_SCHEMA, obsId, messageId: record.messageId, segment: segmentId(feed.id, channel.id, known), feed: feed.id, channel: channel.id,
      discipline: channel.discipline, validAt: record.validAt ?? known, ...(record.validUntil ? { validUntil: record.validUntil } : {}), knownAt: known,
      geometry, error, how: record.how,
      ...(record.subjectRef ? { subjectRef: record.subjectRef } : {}), ...(record.observedType ? { observedType: record.observedType } : {}),
      ...(record.claimedIdentity ? { claimedIdentity: record.claimedIdentity } : {}), ...(record.attributes ? { attributes: record.attributes } : {}),
      source: `File ${fileName}, imported ${known}`, origin: channel.origin ?? `As written in ${fileName}`, reliability: channel.reliability, credibility: channel.credibility,
      deceptionNote: 'not assessed yet: imported from a file for the J2 to weigh', label: context.label, handling: channelHandling(feed, channel),
      extractor: { codec, version: IMPORT_CODEC_VERSION }, ...(record.trackId ? { trackId: record.trackId } : {}), simulated: false
    };
    const read = parseObservation(raw);
    if (!read.ok) { countProblem(problems, 'not-a-row'); continue; }
    rows.push(read.value);
  }
  if (parsed.records.length > IMPORT_MAX_ROWS) problems['too-many'] = Math.max(problems['too-many'] ?? 0, parsed.records.length - IMPORT_MAX_ROWS);
  const times = rows.map((row) => row.validAt).sort();
  return {
    format: parsed.format, feed, fileName, importedAt: known, label: context.label, rows, held, problems,
    ...(times.length ? { span: { from: times[0], to: times[times.length - 1] } } : {})
  };
}

const plural = (count: number, word: string): string => `${count.toLocaleString('en-CA')} ${word}${count === 1 ? '' : 's'}`;

/** What the person is shown before anything is written: count, format, label, time span, what is held and what was skipped. */
export function importSummaryText(plan: ImportPlan): string {
  const lines = [
    `${plural(plan.rows.length, 'observation')} from ${plan.fileName} (${IMPORT_FORMAT_WORDS[plan.format]}), labelled ${plan.label}.`,
    plan.span ? `Seen from ${plan.span.from} to ${plan.span.to}.` : 'No times to show.',
    `They are filed under the feed "${plan.feed.title}" (${plan.feed.id}), marked as imported from this file at ${plan.importedAt}, not as simulated.`
  ];
  for (const [reason, count] of Object.entries(plan.held)) if (count) lines.push(`Held, not imported: ${plural(count, 'item')}. ${IMPORT_HOLDS[reason as ImportHold]}`);
  for (const [reason, count] of Object.entries(plan.problems)) {
    if (count) lines.push(`Skipped: ${plural(count, 'item')}. ${reason === 'not-a-row' ? 'The item does not make a valid observation.' : IMPORT_PROBLEMS[reason] ?? reason}`);
  }
  return lines.join('\n');
}

// ---- The import feed's lifecycle -------------------------------------------------------------------------------------------------------------

/**
 * The feed source events an import takes its feed through, from the state it is in (feeds.ts FEED_SOURCE_TRANSITIONS). A file import has history, so a
 * new feed backfills: the person who confirms the import approves the feed (the only person-only step), the runtime starts the backfill, the rows are
 * appended, and the feed is caught up to live. A paused or degraded feed resyncs through backfilling. A retired feed takes nothing: a person retired it,
 * and it can never come back.
 */
export function importFeedSteps(state: FeedSourceState | undefined): { readonly ok: true; readonly register: boolean; readonly before: readonly FeedSourceEvent[]; readonly after: readonly FeedSourceEvent[] } | { readonly ok: false; readonly message: string } {
  switch (state) {
    case undefined: return { ok: true, register: true, before: ['approve', 'start-backfill'], after: ['caught-up'] };
    case 'proposed': return { ok: true, register: false, before: ['approve', 'start-backfill'], after: ['caught-up'] };
    case 'approved': return { ok: true, register: false, before: ['start-backfill'], after: ['caught-up'] };
    case 'backfilling': return { ok: true, register: false, before: [], after: ['caught-up'] };
    case 'live': return { ok: true, register: false, before: [], after: [] };
    case 'degraded': case 'paused': return { ok: true, register: false, before: ['resync'], after: ['caught-up'] };
    default: return { ok: false, message: 'A person retired this import feed, so it takes no more rows. Nothing was imported.' };
  }
}
