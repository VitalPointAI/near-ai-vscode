// The shape of one piece of project state that moves between computers, and the two things every merge needs from it: a canonical text form (so the
// same content hashes to the same revision on every machine) and a revision. Pure: no VS Code, no files.
//
// Every record is { kind, id, rev, basedOn?, at, writer, body }. `rev` is a hash of the body, `basedOn` is the revision the writer started from, and
// `at` / `writer` say when and from which install the record was written. How two copies of one record combine is in merge.ts.
import { createHash } from 'node:crypto';

export type RecordKind = 'marker' | 'checkpoint' | 'comparison' | 'choice' | 'profile' | 'secret' | 'spend' | 'pickup' | 'thread-meta' | 'thread-context' | 'tombstone';

export const RECORD_KINDS: readonly RecordKind[] = ['marker', 'checkpoint', 'comparison', 'choice', 'profile', 'secret', 'spend', 'pickup', 'thread-meta', 'thread-context', 'tombstone'];

/**
 * What happens when two machines edited one record of a kind without seeing each other's edit:
 * - fork: keep the newer under the original id and the older under a new id (a person's saved work is never dropped);
 * - lww: keep only the newer (a setting, where the older value is simply superseded);
 * - union: the kind is an append-only log whose lines have their own ids, so one id with two revisions is a newer line replacing an older one.
 * A tombstone is not in this table: it follows the tombstone rule in merge.ts.
 */
export type MergePolicy = 'fork' | 'lww' | 'union';

export const MERGE_POLICY: Readonly<Record<Exclude<RecordKind, 'tombstone'>, MergePolicy>> = {
  comparison: 'fork',
  checkpoint: 'fork',
  spend: 'union',
  marker: 'lww',
  choice: 'lww',
  profile: 'lww',
  secret: 'lww',
  pickup: 'lww',
  'thread-meta': 'lww',
  'thread-context': 'lww'
};

/** A tombstone says "the record of this kind and id was deleted at `at`". Its own id is the id of the record it removes. */
export interface TombstoneBody { target: Exclude<RecordKind, 'tombstone'> }

export interface StateRecord<T = unknown> {
  kind: RecordKind;
  id: string;
  rev: string;
  basedOn?: string;
  at: string;
  writer: string;
  body: T;
}

const WRITER_PATTERN = /^[a-z0-9-]{4,80}$/;
const REV_PATTERN = /^[0-9a-f]{16}$/;
const FORK_SUFFIX = /~[0-9a-f]{12}$/;
const MAX_ID_LENGTH = 200;

/**
 * The text form every machine agrees on: object keys sorted at every depth, arrays in order, no whitespace. Throws on anything that has no single
 * agreed text (undefined, functions, symbols, NaN, Infinity, bigints, class instances, cycles), because a silent difference between two machines would
 * give the same content two revisions.
 */
export function canonicalJson(value: unknown): string {
  return write(value, []);
}

function write(value: unknown, path: object[]): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: NaN and Infinity have no canonical form');
      return JSON.stringify(value);
    case 'object': break;
    default: throw new TypeError(`canonicalJson: ${typeof value} has no canonical form`);
  }
  const object = value as object;
  if (path.includes(object)) throw new TypeError('canonicalJson: circular value');
  const next = [...path, object];
  if (Array.isArray(object)) return `[${object.map((item) => write(item, next)).join(',')}]`;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonicalJson: only plain objects have a canonical form');
  const record = object as Record<string, unknown>;
  // Keys by UTF-16 code unit order, the same on every machine.
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${write(record[key], next)}`).join(',')}}`;
}

/** The revision of a body: the first 16 hex characters of the sha256 of its canonical text. */
export function revOf(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex').slice(0, 16);
}

export interface RecordMeta {
  /** When the record was written, in the exact form `new Date().toISOString()` gives. */
  at: string;
  writer: string;
  /** The revision this edit started from. */
  basedOn?: string;
  /**
   * The record this edit replaces. Sets `basedOn` and makes sure `at` is later than the base's, so an edit is never ordered before what it edits even when
   * two computers' clocks disagree. Merging relies on this: a descendant is always the newer of the two.
   */
  base?: StateRecord;
}

/** Builds a valid record, or throws when the id, writer or time are not acceptable (a programming error, not a data error). */
export function makeRecord<T>(kind: RecordKind, id: string, body: T, meta: RecordMeta): StateRecord<T> {
  let at = meta.at;
  let basedOn = meta.basedOn;
  if (meta.base) {
    basedOn = meta.base.rev;
    if (at <= meta.base.at) at = new Date(Date.parse(meta.base.at) + 1).toISOString();
  }
  const record: StateRecord<T> = { kind, id, rev: revOf(body), ...(basedOn === undefined ? {} : { basedOn }), at, writer: meta.writer, body };
  if (!parseRecord(record)) throw new Error(`makeRecord: not a valid ${kind} record`);
  return record;
}

/** Whether `id` is a valid record id: at most 200 characters (213 for a fork id), no path separator, no NUL, no control character. */
function validId(id: unknown): id is string {
  if (typeof id !== 'string' || id === '' || id === '.' || id === '..') return false;
  if (id.length > (FORK_SUFFIX.test(id) ? MAX_ID_LENGTH + 13 : MAX_ID_LENGTH)) return false;
  return !/[\\/\u0000-\u001f\u007f]/.test(id);
}

/** Validates a value read from disk or from another machine. Returns a clean copy, or undefined for anything that is not a well-formed record. */
export function parseRecord(value: unknown): StateRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== 'string' || !(RECORD_KINDS as readonly string[]).includes(raw.kind)) return undefined;
  const kind = raw.kind as RecordKind;
  if (!validId(raw.id)) return undefined;
  if (typeof raw.rev !== 'string' || !REV_PATTERN.test(raw.rev)) return undefined;
  if (raw.basedOn !== undefined && (typeof raw.basedOn !== 'string' || !REV_PATTERN.test(raw.basedOn))) return undefined;
  if (typeof raw.at !== 'string' || !isIsoTime(raw.at)) return undefined;
  if (typeof raw.writer !== 'string' || !WRITER_PATTERN.test(raw.writer)) return undefined;
  if (!('body' in raw)) return undefined;
  try { canonicalJson(raw.body); } catch { return undefined; }
  if (kind === 'tombstone') {
    const body = raw.body as Record<string, unknown> | null;
    if (typeof body !== 'object' || body === null || typeof body.target !== 'string' || body.target === 'tombstone' || !(RECORD_KINDS as readonly string[]).includes(body.target)) return undefined;
  }
  return { kind, id: raw.id, rev: raw.rev, ...(raw.basedOn === undefined ? {} : { basedOn: raw.basedOn as string }), at: raw.at, writer: raw.writer, body: raw.body };
}

/** The exact `toISOString()` form, so two times compare correctly as plain text. */
function isIsoTime(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** The id of a record with every fork suffix removed. A fork keeps the saved work of the older edit under `<id>~<12 hex>`. */
export function baseId(id: string): string {
  let current = id;
  while (FORK_SUFFIX.test(current)) current = current.replace(FORK_SUFFIX, '');
  return current;
}
