// Slices (research note 11, section 5; WP-OBS0): a saved scope over observations by area, time, grade, discipline, unit and echelon, always clamped to
// the asker's clearance, for people and agents alike. Pure: no I/O, no clock, no vscode.
//
// A slice has no label or clearance field: it can only narrow what the reader sees, never widen it. Rows the reader's clearance does not cover are
// removed before any other test, so a slice over a store holding them gives exactly what a store that never held them gives (the two-compartment test).
// The dimensions are the ones the v0.6.0 host will index, so swapping the local store for the host query service changes the backend only.
import { parseIsoMillis } from '../../gate/shape';
import { ECHELON_ALIASES, ECHELONS, INFORMATION_CREDIBILITY_GRADES, INTELLIGENCE_DISCIPLINES, SOURCE_RELIABILITY_GRADES, STANDARD_IDENTITIES } from '../doctrine';
import type { Echelon, InformationCredibility, IntelligenceDiscipline, SourceReliability, StandardIdentity } from '../doctrine';
import { insidePolygon } from '../guardScan';
import { originKey } from '../intel';
import { EARTH_RADIUS_M, gridCentre, gridToWgs84, parseGridReference } from './frame';
import type { ExerciseFrame } from './frame';
import type { Observation, Position } from './observation';
import { bool, childPath, choice, fail, field, fields, int, isoTime, list, num, optionalField, reading, slug, text, uniqueList } from './read';
import type { ObsParsed } from './read';

export const SLICE_MAX_LIMIT = 500;
export const SLICE_DEFAULT_LIMIT = 100;
export const SLICE_MAX_RADIUS_M = 500_000;

/** Where: a box, a polygon ([longitude, latitude]), a control measure by id (an NAI, a route), or a grid reference and radius. */
export type SliceArea =
  | { readonly kind: 'box'; readonly west: number; readonly south: number; readonly east: number; readonly north: number }
  | { readonly kind: 'polygon'; readonly ring: ReadonlyArray<readonly [number, number]> }
  | { readonly kind: 'control-measure'; readonly id: string; readonly withinMetres?: number }
  | { readonly kind: 'grid-radius'; readonly reference: string; readonly radiusMetres: number };

/** When: a valid-time window ("as happened"), and an optional known-time cut-off ("as known at T": what the staff knew at that moment). */
export interface SliceTime { readonly validFrom?: string; readonly validTo?: string; readonly knownBy?: string }

/** How good: reliability at least (A best), credibility at most (1 best), and only rows another independent origin corroborates. */
export interface SliceGrade { readonly minReliability?: SourceReliability; readonly maxCredibility?: InformationCredibility; readonly corroboratedOnly?: boolean }

/** Which units: these ids, and with `subordinates` everything under them in the order of battle. */
export interface SliceUnits { readonly ids: readonly string[]; readonly subordinates: boolean }

/** Which echelons: the units a row is about, from `atLeast` up to `atMost` ("battalion and above"). */
export interface SliceEchelons { readonly atLeast?: Echelon; readonly atMost?: Echelon }

export interface SliceQuery {
  readonly area?: SliceArea;
  readonly time?: SliceTime;
  readonly grade?: SliceGrade;
  readonly disciplines?: readonly IntelligenceDiscipline[];
  readonly feeds?: readonly string[];
  readonly units?: SliceUnits;
  readonly echelons?: SliceEchelons;
  /** Standard identities as the J2 assessed them, never as the feed claimed (note 11, 5 and 6.2). A row nobody assessed is `pending`. */
  readonly identities?: readonly StandardIdentity[];
  readonly order?: 'valid' | 'known';
  readonly limit?: number;
}

/** Keys a slice refuses outright: a slice never names a label or a clearance. */
const WIDENING_KEYS = ['label', 'labels', 'clearance', 'clearances', 'mark'];

function readArea(value: unknown, path: string): SliceArea {
  const raw = fields(value, path, ['kind'], ['west', 'south', 'east', 'north', 'ring', 'id', 'withinMetres', 'reference', 'radiusMetres']);
  const kind = choice(['box', 'polygon', 'control-measure', 'grid-radius'] as const, field(raw, 'kind'), childPath(path, 'kind'));
  const only = (keys: readonly string[]): void => {
    const extra = Object.keys(raw).find((key) => key !== 'kind' && !keys.includes(key));
    if (extra) fail('unknown-field', childPath(path, extra));
  };
  if (kind === 'box') {
    only(['west', 'south', 'east', 'north']);
    const box = {
      west: num(field(raw, 'west'), childPath(path, 'west'), -180, 180), south: num(field(raw, 'south'), childPath(path, 'south'), -90, 90),
      east: num(field(raw, 'east'), childPath(path, 'east'), -180, 180), north: num(field(raw, 'north'), childPath(path, 'north'), -90, 90)
    };
    if (box.south >= box.north || box.west >= box.east) fail('out-of-range', path);
    return { kind, ...box };
  }
  if (kind === 'polygon') {
    only(['ring']);
    const ring = list(field(raw, 'ring'), childPath(path, 'ring'), 1000, (item, at): readonly [number, number] => {
      if (!Array.isArray(item) || item.length !== 2) fail('bad-geometry', at);
      return [num(item[0], at, -180, 180), num(item[1], at, -90, 90)];
    });
    if (ring.length < 3) fail('bad-geometry', childPath(path, 'ring'));
    return { kind, ring };
  }
  if (kind === 'control-measure') {
    only(['id', 'withinMetres']);
    const id = field(raw, 'id');
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id)) fail('wrong-type', childPath(path, 'id'));
    const withinMetres = optionalField(raw, 'withinMetres', path, (v, at) => num(v, at, 0, SLICE_MAX_RADIUS_M));
    return { kind, id, ...(withinMetres !== undefined ? { withinMetres } : {}) };
  }
  only(['reference', 'radiusMetres']);
  return { kind, reference: text(field(raw, 'reference'), childPath(path, 'reference'), 60), radiusMetres: num(field(raw, 'radiusMetres'), childPath(path, 'radiusMetres'), 0, SLICE_MAX_RADIUS_M) };
}

/** Reads a slice strictly. A label or clearance field is `label-widening`; a combined grade is `grades-separate`; a window that ends first is `time-order`. */
export function parseSliceQuery(value: unknown, path = ''): ObsParsed<SliceQuery> {
  return reading(() => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const widening = WIDENING_KEYS.find((key) => Object.prototype.hasOwnProperty.call(value, key));
      if (widening) fail('label-widening', childPath(path, widening));
    }
    const raw = fields(value, path, [], ['area', 'time', 'grade', 'disciplines', 'feeds', 'units', 'echelons', 'identities', 'order', 'limit']);
    const area = optionalField(raw, 'area', path, readArea);
    const time = optionalField(raw, 'time', path, (v, at): SliceTime => {
      const t = fields(v, at, [], ['validFrom', 'validTo', 'knownBy']);
      const validFrom = optionalField(t, 'validFrom', at, isoTime);
      const validTo = optionalField(t, 'validTo', at, isoTime);
      const knownBy = optionalField(t, 'knownBy', at, isoTime);
      if (validFrom !== undefined && validTo !== undefined && parseIsoMillis(validTo) < parseIsoMillis(validFrom)) fail('time-order', childPath(at, 'validTo'));
      return { ...(validFrom !== undefined ? { validFrom } : {}), ...(validTo !== undefined ? { validTo } : {}), ...(knownBy !== undefined ? { knownBy } : {}) };
    });
    const grade = optionalField(raw, 'grade', path, (v, at): SliceGrade => {
      if (v !== null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'grade')) fail('grades-separate', childPath(at, 'grade'));
      const g = fields(v, at, [], ['minReliability', 'maxCredibility', 'corroboratedOnly']);
      const minReliability = optionalField(g, 'minReliability', at, (r, where) => {
        if (typeof r === 'string' && /^[A-Fa-f]\s*[1-6]$/.test(r)) fail('grades-separate', where);
        return choice(SOURCE_RELIABILITY_GRADES, r, where);
      });
      const maxCredibility = optionalField(g, 'maxCredibility', at, (c, where) => {
        if (typeof c !== 'number' || !INFORMATION_CREDIBILITY_GRADES.includes(c as InformationCredibility)) fail('unknown-value', where);
        return c as InformationCredibility;
      });
      const corroboratedOnly = optionalField(g, 'corroboratedOnly', at, bool);
      return { ...(minReliability ? { minReliability } : {}), ...(maxCredibility ? { maxCredibility } : {}), ...(corroboratedOnly !== undefined ? { corroboratedOnly } : {}) };
    });
    const disciplines = optionalField(raw, 'disciplines', path, (v, at) => uniqueList(v, at, INTELLIGENCE_DISCIPLINES.length, (item, where) => choice(INTELLIGENCE_DISCIPLINES, item, where)));
    const feeds = optionalField(raw, 'feeds', path, (v, at) => uniqueList(v, at, 50, slug));
    const units = optionalField(raw, 'units', path, (v, at): SliceUnits => {
      const u = fields(v, at, ['ids'], ['subordinates']);
      const ids = uniqueList(field(u, 'ids'), childPath(at, 'ids'), 50, (item, where) => {
        if (typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(item)) fail('wrong-type', where);
        return item;
      });
      if (ids.length === 0) fail('missing-field', childPath(at, 'ids'));
      return { ids, subordinates: optionalField(u, 'subordinates', at, bool) ?? false };
    });
    const echelons = optionalField(raw, 'echelons', path, (v, at): SliceEchelons => {
      const e = fields(v, at, [], ['atLeast', 'atMost']);
      const atLeast = optionalField(e, 'atLeast', at, (item, where) => choice(ECHELONS, item, where));
      const atMost = optionalField(e, 'atMost', at, (item, where) => choice(ECHELONS, item, where));
      if (atLeast && atMost && ECHELONS.indexOf(atMost) < ECHELONS.indexOf(atLeast)) fail('out-of-range', childPath(at, 'atMost'));
      return { ...(atLeast ? { atLeast } : {}), ...(atMost ? { atMost } : {}) };
    });
    const identities = optionalField(raw, 'identities', path, (v, at) => uniqueList(v, at, STANDARD_IDENTITIES.length, (item, where) => choice(STANDARD_IDENTITIES, item, where)));
    const order = optionalField(raw, 'order', path, (v, at) => choice(['valid', 'known'] as const, v, at));
    const limit = optionalField(raw, 'limit', path, (v, at) => int(v, at, 1, SLICE_MAX_LIMIT));
    return {
      ...(area ? { area } : {}), ...(time ? { time } : {}), ...(grade ? { grade } : {}), ...(disciplines ? { disciplines } : {}), ...(feeds ? { feeds } : {}),
      ...(units ? { units } : {}), ...(echelons ? { echelons } : {}), ...(identities ? { identities } : {}), ...(order ? { order } : {}),
      ...(limit !== undefined ? { limit } : {})
    };
  });
}

/** A scenario's echelon text as an echelon (`battery` reads as `company`), or undefined for text that names none. */
export function echelonOf(textValue: string | undefined): Echelon | undefined {
  if (textValue === undefined) return undefined;
  const key = textValue.trim().toLowerCase().replace(/\s+/g, '-');
  if ((ECHELONS as readonly string[]).includes(key)) return key as Echelon;
  return Object.prototype.hasOwnProperty.call(ECHELON_ALIASES, key) ? ECHELON_ALIASES[key] : undefined;
}

// ---- Evaluating a slice ---------------------------------------------------------------------------------------------------------------------

/** What a store passes in: the reader's clearance as a test, and how to resolve control measures, units and assessed identities. */
export interface SliceContext {
  /** Whether the reader's clearance covers a label. Applied first, always. */
  readonly visible: (label: string) => boolean;
  /** The scenario's frame, for grid references. */
  readonly frame?: ExerciseFrame;
  /** A control measure's geometry ([longitude, latitude]): a polygon ring for an NAI or area, a line for a route or phase line. */
  readonly controlMeasure?: (id: string) => { readonly kind: 'polygon' | 'line'; readonly points: ReadonlyArray<readonly [number, number]> } | undefined;
  /** A unit's parent in the order of battle. */
  readonly parentOf?: (id: string) => string | undefined;
  readonly echelonOf?: (id: string) => Echelon | undefined;
  /** The J2's assessed identity of what a row reports, if any. */
  readonly assessedIdentity?: (row: Observation) => StandardIdentity | undefined;
}

export interface SliceResult {
  readonly rows: readonly Observation[];
  /** How many rows matched before the cap. */
  readonly total: number;
  readonly cut: boolean;
  /** Said whenever the result was cut, so neither a person nor an agent mistakes a capped answer for the whole picture. */
  readonly note?: string;
}

/** The sentence a capped answer carries. */
export function cutNote(shown: number, total: number): string {
  return `Showing ${shown} of ${total} matching observations; the answer was cut at the limit. Narrow the slice (area, time, grade) to see the rest.`;
}

function positionsOf(row: Observation): Position[] {
  const geometry = row.geometry;
  if (geometry.type === 'Point') return [geometry.coordinates];
  if (geometry.type === 'LineString') return [...geometry.coordinates];
  return geometry.coordinates.flat();
}

/** Metres between two [longitude, latitude] points (equirectangular at their mean latitude; enough for slices of a few hundred kilometres). */
function metresBetween(a: readonly [number, number], b: readonly [number, number]): number {
  const rad = Math.PI / 180;
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = (b[1] - a[1]) * rad;
  return Math.hypot(x, y) * EARTH_RADIUS_M;
}

function metresToSegment(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  const rad = Math.PI / 180;
  const k = Math.cos(p[1] * rad);
  const ax = (a[0] - p[0]) * k; const ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * k; const by = b[1] - p[1];
  const dx = bx - ax; const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length));
  return Math.hypot(ax + t * dx, ay + t * dy) * rad * EARTH_RADIUS_M;
}

function areaTest(area: SliceArea, context: SliceContext): (point: readonly [number, number]) => boolean {
  if (area.kind === 'box') return ([lon, lat]) => lon >= area.west && lon <= area.east && lat >= area.south && lat <= area.north;
  if (area.kind === 'polygon') return (point) => insidePolygon(point, area.ring);
  if (area.kind === 'grid-radius') {
    const frame = context.frame;
    const reference = frame && parseGridReference(area.reference, frame.grid, frame.squareMetres);
    if (!frame || !reference) fail('unknown-value', 'area.reference');
    const centre = gridToWgs84(frame, gridCentre(reference));
    return (point) => metresBetween(point, [centre.longitude, centre.latitude]) <= area.radiusMetres;
  }
  const measure = context.controlMeasure?.(area.id);
  if (!measure || measure.points.length < 2) fail('unknown-value', 'area.id');
  const within = area.withinMetres ?? 0;
  const near = (point: readonly [number, number]): boolean => {
    const points = measure.points;
    const edges = measure.kind === 'polygon' ? points.length : points.length - 1;
    for (let i = 0; i < edges; i += 1) if (metresToSegment(point, points[i], points[(i + 1) % points.length]) <= within) return true;
    return false;
  };
  return measure.kind === 'polygon' ? (point) => insidePolygon(point, measure.points) || (within > 0 && near(point)) : near;
}

/** Every unit id the slice names, with their subordinates when asked. */
function unitSet(units: SliceUnits, context: SliceContext, candidates: readonly string[]): Set<string> {
  const named = new Set(units.ids);
  if (!units.subordinates || !context.parentOf) return named;
  const out = new Set(named);
  for (const id of candidates) {
    const chain = new Set<string>();
    for (let parent = context.parentOf(id); parent !== undefined && !chain.has(parent); parent = context.parentOf(parent)) {
      chain.add(parent);
      if (named.has(parent)) { out.add(id); break; }
    }
  }
  return out;
}

/**
 * The rows a slice returns for one reader, capped at its limit, in valid-time (or known-time) order, newest last. Rows the reader cannot see go first; in
 * "as known at T" mode rows learned after T are gone and a row is hidden only by a correction known by T. Corroboration counts independent origins among
 * the rows the reader can see.
 */
export function sliceObservations(rows: readonly Observation[], query: SliceQuery, context: SliceContext): ObsParsed<SliceResult> {
  return reading(() => {
    const knownBy = query.time?.knownBy !== undefined ? parseIsoMillis(query.time.knownBy) : undefined;
    let pool = rows.filter((row) => context.visible(row.label));
    if (knownBy !== undefined) pool = pool.filter((row) => parseIsoMillis(row.knownAt) <= knownBy);
    const superseded = new Set(pool.flatMap((row) => (row.supersedes ? [row.supersedes] : [])));
    pool = pool.filter((row) => !superseded.has(row.obsId));
    const inArea = query.area ? areaTest(query.area, context) : undefined;
    const from = query.time?.validFrom !== undefined ? parseIsoMillis(query.time.validFrom) : undefined;
    const to = query.time?.validTo !== undefined ? parseIsoMillis(query.time.validTo) : undefined;
    const grade = query.grade;
    const units = query.units ? unitSet(query.units, context, [...new Set(pool.flatMap((row) => row.about ?? []))]) : undefined;
    const subjectsOf = (row: Observation): string[] => [...(row.trackId ? [row.trackId] : []), ...(row.about ?? [])];
    const corroborated = (row: Observation): boolean => {
      const subjects = subjectsOf(row);
      return pool.some((other) => other.obsId !== row.obsId && originKey(other.origin) !== originKey(row.origin) && subjectsOf(other).some((subject) => subjects.includes(subject)));
    };
    const matched = pool.filter((row) => {
      if (inArea && !positionsOf(row).some((point) => inArea([point[0], point[1]]))) return false;
      const valid = parseIsoMillis(row.validAt);
      if (from !== undefined && valid < from) return false;
      if (to !== undefined && valid > to) return false;
      if (grade?.minReliability && SOURCE_RELIABILITY_GRADES.indexOf(row.reliability) > SOURCE_RELIABILITY_GRADES.indexOf(grade.minReliability)) return false;
      if (grade?.maxCredibility && row.credibility > grade.maxCredibility) return false;
      if (grade?.corroboratedOnly && !corroborated(row)) return false;
      if (query.disciplines && (row.discipline === null || !query.disciplines.includes(row.discipline))) return false;
      if (query.feeds && !query.feeds.includes(row.feed)) return false;
      if (units && !(row.about ?? []).some((id) => units.has(id))) return false;
      if (query.echelons) {
        const low = query.echelons.atLeast ? ECHELONS.indexOf(query.echelons.atLeast) : 0;
        const high = query.echelons.atMost ? ECHELONS.indexOf(query.echelons.atMost) : ECHELONS.length - 1;
        const fits = (row.about ?? []).some((id) => {
          const echelon = context.echelonOf?.(id);
          return echelon !== undefined && ECHELONS.indexOf(echelon) >= low && ECHELONS.indexOf(echelon) <= high;
        });
        if (!fits) return false;
      }
      if (query.identities && !query.identities.includes(context.assessedIdentity?.(row) ?? 'pending')) return false;
      return true;
    });
    const key = query.order === 'known' ? 'knownAt' : 'validAt';
    matched.sort((a, b) => parseIsoMillis(a[key]) - parseIsoMillis(b[key]) || a.obsId.localeCompare(b.obsId));
    const limit = query.limit ?? SLICE_DEFAULT_LIMIT;
    const cut = matched.length > limit;
    const shown = cut ? matched.slice(matched.length - limit) : matched;
    return { rows: shown, total: matched.length, cut, ...(cut ? { note: cutNote(shown.length, matched.length) } : {}) };
  });
}
