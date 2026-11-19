// What every feed codec gives the importer (WP-IMP): one neutral record per thing seen, before it is placed in the exercise frame, labelled and stamped
// as an observation row (importers.ts). Plus the small text and time helpers every codec shares, so each rule is written once. Pure: no I/O, no clock.
import { createHash } from 'node:crypto';
import type { StandardIdentity } from '../../doctrine';
import type { LocationError, ObservationAttributes, ObservationGeometry, PositionMethod } from '../observation';
import { OBS_MAX_EXCERPT } from '../observation';

export interface ImportRecord {
  /** The message's own id in its format, stable for the same content, so importing the same file twice adds nothing. */
  readonly messageId: string;
  readonly validAt?: string;
  readonly validUntil?: string;
  /** Absent when the format names no place (an RSS item without GeoRSS): the importer places it across the exercise frame. */
  readonly geometry?: ObservationGeometry;
  readonly error: LocationError;
  readonly how: PositionMethod;
  readonly subjectRef?: string;
  readonly observedType?: string;
  readonly claimedIdentity?: StandardIdentity;
  readonly attributes?: ObservationAttributes;
  readonly trackId?: string;
}

/** A codec's result: the records, and how many items it skipped for each reason (IMPORT_PROBLEMS in importers.ts). */
export interface CodecResult { readonly records: ImportRecord[]; readonly problems: Record<string, number> }

export function countProblem(problems: Record<string, number>, reason: string): void {
  problems[reason] = (problems[reason] ?? 0) + 1;
}

export const contentHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40);

/** Free text from a feed as one clean line: control characters dropped, whitespace collapsed, cut to `max`. Undefined when nothing is left. */
export function cleanText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

/** HTML in a feed's description, as plain text (tags dropped, never rendered). */
export function plainText(value: string | undefined, max = OBS_MAX_EXCERPT): string | undefined {
  return cleanText(value?.replace(/<[^>]{0,2000}>/g, ' '), max);
}

/** A feed's identifier as the row's subject reference: only the characters the contract allows, at most 100. */
export function subjectRefOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[^A-Za-z0-9 ._:/-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100).trim();
  return cleaned || undefined;
}

/** A track id with the given prefix from a feed identifier (`cot:...`, `mmsi:...`), or undefined. */
export function trackIdOf(prefix: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[^A-Za-z0-9._:-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100);
  return cleaned ? `${prefix}:${cleaned}` : undefined;
}

const EARLIEST = Date.UTC(1970, 0, 1);
const LATEST = Date.UTC(2100, 0, 1);

/** A time as the contract writes it (`YYYY-MM-DDTHH:MM:SS.sssZ`), from ISO 8601 or RFC 822 text; undefined when it does not read or is out of range. */
export function isoOf(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = typeof value === 'number' ? value : Date.parse(value.trim());
  return Number.isFinite(ms) && ms >= EARLIEST && ms < LATEST ? new Date(ms).toISOString() : undefined;
}
