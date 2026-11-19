// The GeoJSON codec (RFC 7946; WP-IMP): a FeatureCollection, a Feature or a bare geometry. Points, lines and polygons become one record each; multi-part
// geometries and geometry collections are split into their parts. Coordinates are held to the observation contract's own geometry rules (readGeometry):
// finite, in range, a line of two positions or more, a closed ring of four or more, at most 2,000 vertices. A feature that breaks them is skipped and
// counted, never repaired. Pure: no I/O, no clock.
import { readGeometry } from '../observation';
import type { ObservationGeometry } from '../observation';
import { reading } from '../read';
import { cleanText, contentHash, countProblem, isoOf, plainText } from './record';
import type { CodecResult, ImportRecord } from './record';

const own = (value: unknown, key: string): unknown =>
  (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined);

const SIMPLE = ['Point', 'LineString', 'Polygon'] as const;
const MULTI: Readonly<Record<string, (typeof SIMPLE)[number]>> = { MultiPoint: 'Point', MultiLineString: 'LineString', MultiPolygon: 'Polygon' };

/** The simple geometries inside one GeoJSON geometry, or the reason it cannot be read. A collection is read one level deep. */
function parts(geometry: unknown, depth = 0): Array<ObservationGeometry> | 'bad-geometry' | 'no-geometry' {
  if (geometry === null || geometry === undefined) return 'no-geometry';
  const type = own(geometry, 'type');
  if (type === 'GeometryCollection') {
    const members = own(geometry, 'geometries');
    if (depth > 0 || !Array.isArray(members) || members.length > 500) return 'bad-geometry';
    const out: ObservationGeometry[] = [];
    for (const member of members) {
      const read = parts(member, depth + 1);
      if (typeof read === 'string') return 'bad-geometry';
      out.push(...read);
    }
    return out;
  }
  const coordinates = own(geometry, 'coordinates');
  const single = typeof type === 'string' && Object.prototype.hasOwnProperty.call(MULTI, type) ? MULTI[type] : (SIMPLE as readonly unknown[]).includes(type) ? type as (typeof SIMPLE)[number] : undefined;
  if (!single) return 'bad-geometry';
  const list = single === type ? [coordinates] : coordinates;
  if (!Array.isArray(list) || list.length === 0 || list.length > 500) return 'bad-geometry';
  const out: ObservationGeometry[] = [];
  for (const entry of list) {
    const read = reading(() => readGeometry({ type: single, coordinates: entry }, 'geometry'));
    if (!read.ok) return 'bad-geometry';
    out.push(read.value);
  }
  return out;
}

const TIME_KEYS = ['time', 'timestamp', 'datetime', 'validAt', 'when', 'date'] as const;

/** Reads GeoJSON text. A file that is not JSON, or not GeoJSON at all, is one problem: `not-geojson`. */
export function readGeoJson(text: string, maxRecords: number): CodecResult {
  const records: ImportRecord[] = [];
  const problems: Record<string, number> = {};
  let root: unknown;
  try { root = JSON.parse(text); } catch { countProblem(problems, 'not-geojson'); return { records, problems }; }
  const type = own(root, 'type');
  const features: unknown[] = type === 'FeatureCollection'
    ? (Array.isArray(own(root, 'features')) ? own(root, 'features') as unknown[] : [])
    : type === 'Feature' ? [root] : typeof type === 'string' ? [{ type: 'Feature', geometry: root, properties: {} }] : [];
  if (features.length === 0) { countProblem(problems, type === 'FeatureCollection' ? 'empty' : 'not-geojson'); return { records, problems }; }
  features.forEach((feature, index) => {
    if (records.length >= maxRecords) { countProblem(problems, 'too-many'); return; }
    if (own(feature, 'type') !== 'Feature') { countProblem(problems, 'bad-geometry'); return; }
    const geometries = parts(own(feature, 'geometry'));
    if (typeof geometries === 'string') { countProblem(problems, geometries); return; }
    const props = own(feature, 'properties');
    const name = cleanText(str(own(props, 'name')) ?? str(own(props, 'title')), 120);
    const excerpt = plainText(str(own(props, 'description')) ?? str(own(props, 'remarks')));
    let validAt: string | undefined;
    for (const key of TIME_KEYS) { validAt ??= isoOf(str(own(props, key))); }
    const featureId = str(own(feature, 'id'));
    geometries.forEach((geometry, part) => {
      if (records.length >= maxRecords) { countProblem(problems, 'too-many'); return; }
      records.push({
        messageId: `geojson:${contentHash({ featureId, name, validAt, geometry, index: featureId ? 0 : index, part })}`,
        ...(validAt ? { validAt } : {}), geometry, error: { circularMetres: null, verticalMetres: null }, how: 'reported',
        ...(name || excerpt ? { attributes: { ...(name ? { name } : {}), ...(excerpt ? { excerpt } : {}) } } : {})
      });
    });
  });
  return { records, problems };
}
