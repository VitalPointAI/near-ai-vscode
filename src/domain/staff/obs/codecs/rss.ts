// The RSS 2.0 and Atom codec (RSS 2.0 specification; RFC 4287; WP-IMP): one record per RSS `item` or Atom `entry`, with its title, summary, link and
// time. A GeoRSS position (`georss:point "lat lon"`, or W3C `geo:lat` and `geo:long`) is kept when the item has one; otherwise the record has no
// geometry and the importer places it across the exercise frame, as the simulator's open-source reports are (importers.ts). Descriptions are plain
// text here: HTML tags are dropped and nothing is rendered or followed. Pure: no I/O, no clock.
import { cleanText, contentHash, countProblem, isoOf, plainText } from './record';
import type { CodecResult, ImportRecord } from './record';
import { attr, child, childText, childrenNamed, localName } from './xml';
import type { XmlElement } from './xml';

function geoPoint(item: XmlElement): readonly [number, number] | undefined {
  const point = childText(item, 'point');
  let lat: number;
  let lon: number;
  if (point) {
    const parts = point.split(/[\s,]+/).map(Number);
    if (parts.length !== 2) return undefined;
    [lat, lon] = parts;
  } else {
    lat = Number(childText(item, 'lat'));
    lon = Number(childText(item, 'long') ?? childText(item, 'lon'));
  }
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : undefined;
}

function record(prefix: 'rss' | 'atom', id: string | undefined, title: string | undefined, summary: string | undefined, when: string | undefined, item: XmlElement, index: number): ImportRecord {
  const name = cleanText(title, 120);
  const excerpt = plainText(summary);
  const validAt = isoOf(when);
  const point = geoPoint(item);
  const key = cleanText(id, 160);
  return {
    messageId: key ? `${prefix}:${key}` : `${prefix}:${contentHash({ name, validAt, excerpt, index })}`,
    ...(validAt ? { validAt } : {}),
    ...(point ? { geometry: { type: 'Point', coordinates: point } } : {}),
    error: { circularMetres: null, verticalMetres: null }, how: 'reported',
    ...(name || excerpt ? { attributes: { ...(name ? { name } : {}), ...(excerpt ? { excerpt } : {}) } } : {})
  };
}

/** Reads a parsed RSS 2.0 document (`rss/channel/item`). */
export function readRss(root: XmlElement, maxRecords: number): CodecResult {
  const records: ImportRecord[] = [];
  const problems: Record<string, number> = {};
  const channel = localName(root.name) === 'rss' ? child(root, 'channel') : undefined;
  if (!channel) { countProblem(problems, 'not-rss'); return { records, problems }; }
  const items = childrenNamed(channel, 'item');
  if (!items.length) countProblem(problems, 'empty');
  items.forEach((item, index) => {
    if (records.length >= maxRecords) { countProblem(problems, 'too-many'); return; }
    const title = childText(item, 'title');
    const description = childText(item, 'description');
    if (!title && !description) { countProblem(problems, 'empty-item'); return; }
    records.push(record('rss', childText(item, 'guid') ?? childText(item, 'link'), title, description, childText(item, 'pubDate') ?? childText(item, 'date'), item, index));
  });
  return { records, problems };
}

/** Reads a parsed Atom document (`feed/entry`). */
export function readAtom(root: XmlElement, maxRecords: number): CodecResult {
  const records: ImportRecord[] = [];
  const problems: Record<string, number> = {};
  if (localName(root.name) !== 'feed') { countProblem(problems, 'not-atom'); return { records, problems }; }
  const entries = childrenNamed(root, 'entry');
  if (!entries.length) countProblem(problems, 'empty');
  entries.forEach((entry, index) => {
    if (records.length >= maxRecords) { countProblem(problems, 'too-many'); return; }
    const title = childText(entry, 'title');
    const summary = childText(entry, 'summary') ?? childText(entry, 'content');
    if (!title && !summary) { countProblem(problems, 'empty-item'); return; }
    const link = child(entry, 'link');
    records.push(record('atom', childText(entry, 'id') ?? (link ? attr(link, 'href') : undefined), title, summary, childText(entry, 'published') ?? childText(entry, 'updated'), entry, index));
  });
  return { records, problems };
}
