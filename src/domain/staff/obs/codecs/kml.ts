// The KML codec (OGC KML 2.2; WP-IMP): every Placemark in the document, at any depth of Document and Folder, with its name, description and time
// (TimeStamp `when`, or TimeSpan `begin` and `end`). A Point, LineString or Polygon (outer ring and holes) becomes one record; a MultiGeometry gives one
// record per part. Coordinates are `longitude,latitude[,altitude]` tuples and are held to the observation contract's geometry rules. Styles, overlays,
// network links and gx extensions are ignored: nothing is fetched. Pure: no I/O, no clock.
import { readGeometry } from '../observation';
import type { ObservationGeometry, Position } from '../observation';
import { reading } from '../read';
import { cleanText, contentHash, countProblem, isoOf, plainText } from './record';
import type { CodecResult, ImportRecord } from './record';
import { attr, child, childText, descendants, localName } from './xml';
import type { XmlElement } from './xml';

/** A `coordinates` element's tuples, or undefined when one does not read as numbers. */
function tuples(text: string | undefined): Position[] | undefined {
  if (!text) return undefined;
  const out: Position[] = [];
  for (const tuple of text.trim().split(/\s+/)) {
    const values = tuple.split(',').map((value) => Number(value));
    if ((values.length !== 2 && values.length !== 3) || values.some((value) => !Number.isFinite(value))) return undefined;
    out.push(values.length === 3 && values[2] !== 0 ? [values[0], values[1], values[2]] : [values[0], values[1]]);
    if (out.length > 5000) return undefined;
  }
  return out;
}

function geometryOf(element: XmlElement): ObservationGeometry | 'bad-geometry' | 'unsupported-geometry' {
  const name = localName(element.name);
  let candidate: unknown;
  if (name === 'Point') {
    const points = tuples(childText(element, 'coordinates'));
    if (!points || points.length !== 1) return 'bad-geometry';
    candidate = { type: 'Point', coordinates: points[0] };
  } else if (name === 'LineString') {
    candidate = { type: 'LineString', coordinates: tuples(childText(element, 'coordinates')) };
  } else if (name === 'Polygon') {
    const ring = (boundary: XmlElement | undefined): Position[] | undefined => {
      const linear = boundary ? child(boundary, 'LinearRing') : undefined;
      return linear ? tuples(childText(linear, 'coordinates')) : undefined;
    };
    const outer = ring(child(element, 'outerBoundaryIs'));
    const inner = element.children.filter((entry) => localName(entry.name) === 'innerBoundaryIs').map(ring);
    if (!outer || inner.some((entry) => entry === undefined)) return 'bad-geometry';
    candidate = { type: 'Polygon', coordinates: [outer, ...(inner as Position[][])] };
  } else {
    return 'unsupported-geometry';
  }
  const read = reading(() => readGeometry(candidate, 'geometry'));
  return read.ok ? read.value : 'bad-geometry';
}

const GEOMETRY_NAMES = new Set(['Point', 'LineString', 'Polygon', 'LinearRing', 'Model', 'Track', 'MultiTrack']);

/** The geometries of one Placemark: its own, or the parts of its MultiGeometry (nested ones flattened). */
function placemarkGeometries(placemark: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (element: XmlElement): void => {
    for (const entry of element.children) {
      const name = localName(entry.name);
      if (name === 'MultiGeometry') walk(entry);
      else if (GEOMETRY_NAMES.has(name)) out.push(entry);
    }
  };
  walk(placemark);
  return out;
}

/** Reads a parsed KML document. */
export function readKml(root: XmlElement, maxRecords: number): CodecResult {
  const records: ImportRecord[] = [];
  const problems: Record<string, number> = {};
  if (localName(root.name) !== 'kml') { countProblem(problems, 'not-kml'); return { records, problems }; }
  const placemarks = descendants(root, 'Placemark');
  if (!placemarks.length) countProblem(problems, 'empty');
  placemarks.forEach((placemark, index) => {
    const name = cleanText(childText(placemark, 'name'), 120);
    const excerpt = plainText(childText(placemark, 'description'));
    const stamp = child(placemark, 'TimeStamp');
    const span = child(placemark, 'TimeSpan');
    const validAt = isoOf(stamp ? childText(stamp, 'when') : span ? childText(span, 'begin') : undefined);
    const end = span ? isoOf(childText(span, 'end')) : undefined;
    const validUntil = validAt && end && end >= validAt ? end : undefined;
    const id = attr(placemark, 'id');
    const geometries = placemarkGeometries(placemark);
    if (!geometries.length) { countProblem(problems, 'no-geometry'); return; }
    geometries.forEach((element, part) => {
      if (records.length >= maxRecords) { countProblem(problems, 'too-many'); return; }
      const geometry = geometryOf(element);
      if (typeof geometry === 'string') { countProblem(problems, geometry); return; }
      records.push({
        messageId: `kml:${contentHash({ id, name, validAt, validUntil, geometry, index: id ? 0 : index, part })}`,
        ...(validAt ? { validAt } : {}), ...(validUntil ? { validUntil } : {}), geometry, error: { circularMetres: null, verticalMetres: null }, how: 'reported',
        ...(name || excerpt ? { attributes: { ...(name ? { name } : {}), ...(excerpt ? { excerpt } : {}) } } : {})
      });
    });
  });
  return { records, problems };
}
