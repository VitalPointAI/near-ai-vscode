// The observation row (research note 11, section 3.1; WP-OBS0): one row per thing seen, at one place and time, by one channel. Every feed package
// imports it: the store keeps it, importers and simulators write it, slices and watches read it, the map draws it. Pure apart from a SHA-256 hash: no
// I/O, no clock, no vscode.
//
// Rows are append-only: a correction is a new row that `supersedes` the old one. Every row carries the four things the owner asked for (source, time,
// location, label), the two separate grades and the origin the J2 tradecraft gate needs (design 10, 4.4). The label exists before the row does: no queue,
// cache or index ever holds an unlabelled observation.
//
// The row is the shape of the v0.6.0 `observation` table, column for column (OBSERVATION_V06_COLUMNS), so the one-shot "local staff store" connector
// imports drop 2 segments into the host without rework.
import { createHash } from 'node:crypto';
import { HANDLING_FLAGS, SCALE_PRESETS } from '../../gate/labels';
import type { HandlingFlag } from '../../gate/labels';
import {
  INFORMATION_CREDIBILITY_GRADES, INTELLIGENCE_DISCIPLINES, PARTNER_ONLY_DISCIPLINES, SOURCE_RELIABILITY_GRADES, STANDARD_IDENTITIES
} from '../doctrine';
import type { InformationCredibility, IntelligenceDiscipline, SourceReliability, StandardIdentity } from '../doctrine';
import { STAFF_SLUG } from '../parse';
import {
  bool, childPath, choice, fail, field, fields, isoTime, num, optionalField, reading, slug, templateLabel, text, uniqueList
} from './read';
import type { ObsParsed } from './read';
import { parseIsoMillis } from '../../gate/shape';

/** The row's own version. A later shape is version 2 beside version 1 (D-22). */
export const OBSERVATION_SCHEMA = 1;

/** How the position was produced, so fusion can weight it (CoT `how`, note 11 [F1]). */
export const POSITION_METHODS = ['gps', 'estimated', 'derived', 'reported'] as const;
export type PositionMethod = (typeof POSITION_METHODS)[number];

export const OBS_MAX_VERTICES = 2000;
export const OBS_MAX_TEXT = 300;
export const OBS_MAX_EXCERPT = 2000;
export const OBS_MAX_ABOUT = 20;
/** The largest error a row may state, in metres. CoT writes 9999999 for "not known"; importers turn that into `null`. */
export const OBS_MAX_ERROR_M = 1_000_000;

/** [longitude, latitude] or [longitude, latitude, height above the WGS 84 ellipsoid in metres], as GeoJSON orders them (RFC 7946). */
export type Position = readonly [number, number] | readonly [number, number, number];
export type ObservationGeometry =
  | { readonly type: 'Point'; readonly coordinates: Position }
  | { readonly type: 'LineString'; readonly coordinates: readonly Position[] }
  | { readonly type: 'Polygon'; readonly coordinates: ReadonlyArray<readonly Position[]> };

/** Circular (horizontal) and vertical error in metres (CoT `ce` and `le`); `null` when the feed does not say. An imagery footprint is the geometry. */
export interface LocationError { readonly circularMetres: number | null; readonly verticalMetres: number | null }

/** What the feed said about the thing, beyond where it was. Free text is untrusted: it is fenced whenever an agent or a page shows it. */
export interface ObservationAttributes {
  readonly speedMetresPerSecond?: number;
  readonly courseDegrees?: number;
  readonly headingDegrees?: number;
  readonly name?: string;
  readonly excerpt?: string;
}

export interface Observation {
  readonly schema: typeof OBSERVATION_SCHEMA;
  /** `obs-` and the SHA-256 of feed, channel and message id, so re-delivery of one message is one row (observationId). */
  readonly obsId: string;
  /** The message's own id in its feed: CoT `uid` plus `time`, an AIS sentence hash, an RSS item id. */
  readonly messageId: string;
  /** The segment the row was written to: feed, channel and the hour of `knownAt` (segmentId). */
  readonly segment: string;
  readonly feed: string;
  readonly channel: string;
  /** The intelligence discipline, or null for what is not intelligence reporting (own-force positions, weather, terrain). */
  readonly discipline: IntelligenceDiscipline | null;
  /** When the observation was true, and until when (CoT `time` and `stale`). */
  readonly validAt: string;
  readonly validUntil?: string;
  /** When we received it: drives the "as known at T" replay. */
  readonly knownAt: string;
  readonly geometry: ObservationGeometry;
  readonly error: LocationError;
  readonly how: PositionMethod;
  /** The raw identifier in the feed: CoT `uid`, MMSI, ICAO address, track number, unit designation as written. */
  readonly subjectRef?: string;
  /** CoT type or symbol identification code as reported. */
  readonly observedType?: string;
  /** The standard identity the feed claims. A claim, never the J2's assessment. */
  readonly claimedIdentity?: StandardIdentity;
  readonly attributes?: ObservationAttributes;
  /** Who provided it (reliability grades this) and where the information first came from (independence is by origin). */
  readonly source: string;
  readonly origin: string;
  readonly reliability: SourceReliability;
  readonly credibility: InformationCredibility;
  /** What deception or bias could explain it; "none seen" is an answer, a blank is not. */
  readonly deceptionNote: string;
  /** The label, as its `scale/level` key, inside the template ceiling. */
  readonly label: string;
  /** Handling flags of the gate's labels; partner-only reporting always carries `local-only`. */
  readonly handling: readonly HandlingFlag[];
  /** The codec and its version that produced the row. */
  readonly extractor: { readonly codec: string; readonly version: string };
  /** The track the row belongs to by a strong key within its feed (`mmsi:...`, `cot:...`), when it has one (tracks.ts). */
  readonly trackId?: string;
  /** Accepted links to scenario or entity ids (units, places, control measures): what a slice by unit walks. */
  readonly about?: readonly string[];
  readonly supersedes?: string;
  /** From a simulated source: always shown with the SIM badge and marked as exercise data. */
  readonly simulated: boolean;
}

export const OBSERVATION_FIELDS = [
  'schema', 'obsId', 'messageId', 'segment', 'feed', 'channel', 'discipline', 'validAt', 'validUntil', 'knownAt', 'geometry', 'error', 'how', 'subjectRef',
  'observedType', 'claimedIdentity', 'attributes', 'source', 'origin', 'reliability', 'credibility', 'deceptionNote', 'label', 'handling', 'extractor',
  'trackId', 'about', 'supersedes', 'simulated'
] as const;
const REQUIRED_FIELDS = [
  'schema', 'obsId', 'messageId', 'segment', 'feed', 'channel', 'discipline', 'validAt', 'knownAt', 'geometry', 'error', 'how', 'source', 'origin',
  'reliability', 'credibility', 'deceptionNote', 'label', 'handling', 'extractor', 'simulated'
] as const;

/**
 * Where each field lives in the v0.6.0 store (note 11, 3.1 and 3.5; data platform design 5.1): the `observation` table column, or the evidence table it
 * feeds. A row keeps its meaning when it moves: the host connector writes each field to the column named here and nothing else.
 */
export const OBSERVATION_V06_COLUMNS: Readonly<Record<(typeof OBSERVATION_FIELDS)[number], string>> = {
  schema: 'observation.schema', obsId: 'observation.obs_id', messageId: 'observation.message_id', segment: 'observation.segment_item (item)',
  feed: 'item_card.feed', channel: 'item_card.channel', discipline: 'item_card.discipline', validAt: 'observation.valid_at (relation_evidence.valid_from)',
  validUntil: 'observation.valid_until (relation_evidence.valid_to)', knownAt: 'observation.known_at (ingest.firstSeen)', geometry: 'observation.geometry',
  error: 'observation.error', how: 'observation.how', subjectRef: 'mention.text', observedType: 'mention.attributes.type',
  claimedIdentity: 'mention.attributes.identity', attributes: 'mention.attributes', source: 'item_card.provenance.source',
  origin: 'item_card.provenance.origin', reliability: 'observation.reliability', credibility: 'observation.credibility',
  deceptionNote: 'item_card.deception_note', label: 'observation.label_id', handling: 'label.handling', extractor: 'pipeline.extractorVersion',
  trackId: 'entity_link (deterministic, strong key)', about: 'mention_entity (accepted)', supersedes: 'observation.supersedes',
  simulated: 'source.kind = simulated'
};

// ---- Identity and segments ----------------------------------------------------------------------------------------------------------------

/** The observation id: `obs-` and the SHA-256 of feed, channel and message id. Re-delivery of a message gives the same id, so appends are idempotent. */
export function observationId(feed: string, channel: string, messageId: string): string {
  return `obs-${createHash('sha256').update(`${feed}\n${channel}\n${messageId}`).digest('hex')}`;
}

/** The segment a row belongs to: one per feed, channel and hour of `knownAt` (`ais/receiver-north/2026-11-18T14`). */
export function segmentId(feed: string, channel: string, knownAt: string): string {
  return `${feed}/${channel}/${knownAt.slice(0, 13)}`;
}

// ---- Labels -------------------------------------------------------------------------------------------------------------------------------

function splitLabel(label: string): { scale: string; level: string } {
  const at = label.indexOf('/');
  return { scale: label.slice(0, at), level: label.slice(at + 1) };
}

/** The rank of a `scale/level` label on its scale, or -1 when unknown. */
function rankOf(label: string): number {
  const { scale, level } = splitLabel(label);
  return Object.prototype.hasOwnProperty.call(SCALE_PRESETS, scale) ? SCALE_PRESETS[scale].levels.indexOf(level) : -1;
}

/** Whether `label` is on the same scale as `floor` and at least as high. */
export function labelAtLeast(label: string, floor: string): boolean {
  return splitLabel(label).scale === splitLabel(floor).scale && rankOf(label) >= rankOf(floor) && rankOf(floor) >= 0;
}

/**
 * The label of something derived from rows (a track, a corroboration count, a layer, a draft): the highest of its inputs (note 11, 3.5). Labels on
 * different scales do not join without a mapping in the policy bundle, so mixing them gives undefined and the caller refuses the derivation.
 */
export function joinTemplateLabels(labels: readonly string[]): string | undefined {
  if (labels.length === 0) return undefined;
  const scale = splitLabel(labels[0]).scale;
  if (labels.some((label) => splitLabel(label).scale !== scale || rankOf(label) < 0)) return undefined;
  return labels.reduce((highest, label) => (rankOf(label) > rankOf(highest) ? label : highest));
}

// ---- Reading --------------------------------------------------------------------------------------------------------------------------------

const COMBINED_GRADE = /^[A-Fa-f]\s*[1-6]$/;
const SUBJECT_REF = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,99}$/;
const TRACK_ID = /^[a-z][a-z0-9-]{0,15}:[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const ABOUT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const OBS_ID = /^obs-[0-9a-f]{64}$/;

function position(value: unknown, path: string): Position {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) fail('bad-geometry', path);
  const lon = value[0];
  const lat = value[1];
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) fail('bad-geometry', path);
  if (value.length === 2) return [lon, lat];
  const height = value[2];
  if (typeof height !== 'number' || !Number.isFinite(height) || Math.abs(height) > 100_000) fail('bad-geometry', path);
  return [lon, lat, height];
}

/** A WGS 84 point, line or polygon (RFC 7946 rules: a line has two positions or more, a ring four or more and closes on its first). */
export function readGeometry(value: unknown, path: string): ObservationGeometry {
  const geometry = fields(value, path, ['type', 'coordinates']);
  const type = choice(['Point', 'LineString', 'Polygon'] as const, field(geometry, 'type'), childPath(path, 'type'));
  const at = childPath(path, 'coordinates');
  const raw = field(geometry, 'coordinates');
  let vertices = 0;
  const positions = (input: unknown, where: string, least: number): Position[] => {
    if (!Array.isArray(input) || input.length < least) fail('bad-geometry', where);
    vertices += input.length;
    if (vertices > OBS_MAX_VERTICES) fail('too-many', where);
    return input.map((item, index) => position(item, `${where}[${index}]`));
  };
  if (type === 'Point') return { type, coordinates: position(raw, at) };
  if (type === 'LineString') return { type, coordinates: positions(raw, at, 2) };
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) fail('bad-geometry', at);
  const rings = raw.map((ring, index) => {
    const points = positions(ring, `${at}[${index}]`, 4);
    const first = points[0];
    const last = points[points.length - 1];
    if (first.length !== last.length || first.some((value, axis) => value !== last[axis])) fail('bad-geometry', `${at}[${index}]`);
    return points;
  });
  return { type, coordinates: rings };
}

function readError(value: unknown, path: string): LocationError {
  const error = fields(value, path, ['circularMetres', 'verticalMetres']);
  const metres = (raw: unknown, at: string): number | null => (raw === null ? null : num(raw, at, 0, OBS_MAX_ERROR_M));
  return { circularMetres: metres(field(error, 'circularMetres'), childPath(path, 'circularMetres')), verticalMetres: metres(field(error, 'verticalMetres'), childPath(path, 'verticalMetres')) };
}

function readAttributes(value: unknown, path: string): ObservationAttributes {
  const raw = fields(value, path, [], ['speedMetresPerSecond', 'courseDegrees', 'headingDegrees', 'name', 'excerpt']);
  const speed = optionalField(raw, 'speedMetresPerSecond', path, (v, at) => num(v, at, 0, 2000));
  const course = optionalField(raw, 'courseDegrees', path, (v, at) => num(v, at, 0, 360));
  const heading = optionalField(raw, 'headingDegrees', path, (v, at) => num(v, at, 0, 360));
  const name = optionalField(raw, 'name', path, (v, at) => text(v, at, 120));
  const excerpt = optionalField(raw, 'excerpt', path, (v, at) => {
    // eslint-disable-next-line no-control-regex
    if (typeof v !== 'string' || v.trim() === '' || v.length > OBS_MAX_EXCERPT || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) fail('wrong-type', at);
    return v;
  });
  return {
    ...(speed !== undefined ? { speedMetresPerSecond: speed } : {}), ...(course !== undefined ? { courseDegrees: course } : {}),
    ...(heading !== undefined ? { headingDegrees: heading } : {}), ...(name !== undefined ? { name } : {}), ...(excerpt !== undefined ? { excerpt } : {})
  };
}

/** The two grades, strictly: one capital letter A to F and one whole number 1 to 6. A combined grade anywhere is `grades-separate`. */
export function readObservationGrades(row: Readonly<Record<string, unknown>>, path: string): { reliability: SourceReliability; credibility: InformationCredibility } {
  if (Object.prototype.hasOwnProperty.call(row, 'grade')) fail('grades-separate', childPath(path, 'grade'));
  const reliability = Object.prototype.hasOwnProperty.call(row, 'reliability') ? row.reliability : undefined;
  const credibility = Object.prototype.hasOwnProperty.call(row, 'credibility') ? row.credibility : undefined;
  for (const [key, value] of [['reliability', reliability], ['credibility', credibility]] as const) {
    if (typeof value === 'string' && COMBINED_GRADE.test(value.trim())) fail('grades-separate', childPath(path, key));
  }
  if (typeof reliability !== 'string' || !(SOURCE_RELIABILITY_GRADES as readonly string[]).includes(reliability)) fail('unknown-value', childPath(path, 'reliability'));
  if (typeof credibility !== 'number' || !INFORMATION_CREDIBILITY_GRADES.includes(credibility as InformationCredibility)) fail('unknown-value', childPath(path, 'credibility'));
  return { reliability: reliability as SourceReliability, credibility: credibility as InformationCredibility };
}

/**
 * Reads one stored or received row strictly, and checks its integrity: the id is the hash of its feed, channel and message id, the segment is its feed,
 * channel and hour, `validUntil` is not before `validAt`, it does not supersede itself, and partner-only disciplines arrive only as simulations routed
 * `local-only`. The first problem is the refusal.
 */
export function parseObservation(value: unknown, path = ''): ObsParsed<Observation> {
  return reading(() => readObservation(value, path));
}

export function readObservation(value: unknown, path = ''): Observation {
  if (value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'grade')) fail('grades-separate', childPath(path, 'grade'));
  const row = fields(value, path, REQUIRED_FIELDS, OBSERVATION_FIELDS.filter((key) => !(REQUIRED_FIELDS as readonly string[]).includes(key)));
  const at = (key: string): string => childPath(path, key);
  if (field(row, 'schema') !== OBSERVATION_SCHEMA) fail('unknown-value', at('schema'));
  const grades = readObservationGrades(row, path);
  const feed = slug(field(row, 'feed'), at('feed'));
  const channel = slug(field(row, 'channel'), at('channel'));
  const messageId = text(field(row, 'messageId'), at('messageId'), 200);
  const obsId = field(row, 'obsId');
  if (typeof obsId !== 'string' || !OBS_ID.test(obsId)) fail('wrong-type', at('obsId'));
  if (obsId !== observationId(feed, channel, messageId)) fail('integrity', at('obsId'));
  const knownAt = isoTime(field(row, 'knownAt'), at('knownAt'));
  const segment = text(field(row, 'segment'), at('segment'), 200);
  if (segment !== segmentId(feed, channel, knownAt)) fail('integrity', at('segment'));
  const discipline = field(row, 'discipline') === null ? null : choice(INTELLIGENCE_DISCIPLINES, field(row, 'discipline'), at('discipline'));
  const validAt = isoTime(field(row, 'validAt'), at('validAt'));
  const validUntil = optionalField(row, 'validUntil', path, isoTime);
  if (validUntil !== undefined && parseIsoMillis(validUntil) < parseIsoMillis(validAt)) fail('time-order', at('validUntil'));
  const simulated = bool(field(row, 'simulated'), at('simulated'));
  const handling = uniqueList(field(row, 'handling'), at('handling'), HANDLING_FLAGS.length, (item, where) => choice(HANDLING_FLAGS, item, where));
  if (discipline !== null && PARTNER_ONLY_DISCIPLINES.includes(discipline)) {
    if (!simulated) fail('partner-simulation-only', at('discipline'));
    if (!handling.includes('local-only')) fail('local-only', at('handling'));
  }
  const extractorFields = fields(field(row, 'extractor'), at('extractor'), ['codec', 'version']);
  const extractor = { codec: slug(field(extractorFields, 'codec'), childPath(at('extractor'), 'codec')), version: field(extractorFields, 'version') };
  if (typeof extractor.version !== 'string' || !VERSION.test(extractor.version)) fail('wrong-type', childPath(at('extractor'), 'version'));
  const subjectRef = optionalField(row, 'subjectRef', path, (v, where) => {
    if (typeof v !== 'string' || !SUBJECT_REF.test(v)) fail('wrong-type', where);
    return v;
  });
  const observedType = optionalField(row, 'observedType', path, (v, where) => text(v, where, 40));
  const claimedIdentity = optionalField(row, 'claimedIdentity', path, (v, where) => choice(STANDARD_IDENTITIES, v, where));
  const attributes = optionalField(row, 'attributes', path, readAttributes);
  const trackId = optionalField(row, 'trackId', path, (v, where) => {
    if (typeof v !== 'string' || !TRACK_ID.test(v)) fail('wrong-type', where);
    return v;
  });
  const about = optionalField(row, 'about', path, (v, where) => uniqueList(v, where, OBS_MAX_ABOUT, (item, itemAt) => {
    if (typeof item !== 'string' || !ABOUT_ID.test(item)) fail('wrong-type', itemAt);
    return item;
  }));
  const supersedes = optionalField(row, 'supersedes', path, (v, where) => {
    if (typeof v !== 'string' || !OBS_ID.test(v)) fail('wrong-type', where);
    if (v === obsId) fail('self-supersede', where);
    return v;
  });
  return {
    schema: OBSERVATION_SCHEMA, obsId, messageId, segment, feed, channel, discipline, validAt,
    ...(validUntil !== undefined ? { validUntil } : {}),
    knownAt,
    geometry: readGeometry(field(row, 'geometry'), at('geometry')),
    error: readError(field(row, 'error'), at('error')),
    how: choice(POSITION_METHODS, field(row, 'how'), at('how')),
    ...(subjectRef !== undefined ? { subjectRef } : {}),
    ...(observedType !== undefined ? { observedType } : {}),
    ...(claimedIdentity !== undefined ? { claimedIdentity } : {}),
    ...(attributes !== undefined ? { attributes } : {}),
    source: text(field(row, 'source'), at('source'), OBS_MAX_TEXT),
    origin: text(field(row, 'origin'), at('origin'), OBS_MAX_TEXT),
    reliability: grades.reliability,
    credibility: grades.credibility,
    deceptionNote: text(field(row, 'deceptionNote'), at('deceptionNote'), OBS_MAX_TEXT),
    label: templateLabel(field(row, 'label'), at('label')),
    handling,
    extractor: { codec: extractor.codec, version: extractor.version },
    ...(trackId !== undefined ? { trackId } : {}),
    ...(about !== undefined ? { about } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
    simulated
  };
}

/** A segment file's lines (NDJSON): every line one row. Blank lines are skipped; the first bad line is the refusal, with its line number. */
export function parseSegmentLines(textValue: string, maxRows = 100_000): ObsParsed<Observation[]> {
  return reading(() => {
    const rows: Observation[] = [];
    const lines = textValue.split('\n');
    lines.forEach((line, index) => {
      if (line.trim() === '') return;
      if (rows.length >= maxRows) fail('too-many', `line[${index + 1}]`);
      let value: unknown;
      try { value = JSON.parse(line); } catch { fail('wrong-type', `line[${index + 1}]`); }
      rows.push(readObservation(value, `line[${index + 1}]`));
    });
    return rows;
  });
}

/** One row as its segment line. Field order follows OBSERVATION_FIELDS, so one row always writes the same bytes. */
export function observationLine(row: Observation): string {
  const ordered: Record<string, unknown> = {};
  for (const key of OBSERVATION_FIELDS) if (row[key] !== undefined) ordered[key] = row[key];
  return JSON.stringify(ordered);
}

/** The row as the v0.6.0 host writes it: keyed by column (OBSERVATION_V06_COLUMNS), with `label_id` taken from the label. */
export function toV06Row(row: Observation): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of OBSERVATION_FIELDS) if (row[key] !== undefined) out[OBSERVATION_V06_COLUMNS[key]] = row[key];
  return out;
}

/** Whether a string is a well-formed track id (`mmsi:...`, `cot:...`). */
export function isTrackId(value: unknown): value is string {
  return typeof value === 'string' && TRACK_ID.test(value);
}

/** Whether a string is a slug a feed or channel may be named by. */
export function isFeedSlug(value: unknown): value is string {
  return typeof value === 'string' && STAFF_SLUG.test(value);
}

