// Labels v1 (CLAS-01, CLAS-02, D-22, D-23): a label is exactly { scale, level, compartments, releasability, handling }, and `level` is the level's name
// from the scale's ordered list, never a number, so a label reads plainly in files and records. Pure: no I/O, no clock, no vscode, no package.
// Names and tokens compare by exact string equality: no case folding and no Unicode normalisation (a level that differs by case is a different, unknown level).
// Once a release ships a preset id, a level name or a handling value it never changes in place: a change is label v2 beside v1 (D-22).
import { checkKeys, childPath, isRecord, ownValue, refused } from './shape';
import type { Fields, Parsed } from './shape';

export type ScaleId = string;

export interface Scale {
  readonly name: string;
  /** Lowest first. The position in this list is the level's rank. */
  readonly levels: readonly string[];
}

/** The scales a check works with: the shipped presets, or the ordered lists a bundle carries. Looked up by own property only. */
export type ScaleTable = Readonly<Record<ScaleId, Scale>>;

export interface Label {
  readonly scale: ScaleId;
  readonly level: string;
  readonly compartments: readonly string[];
  readonly releasability: readonly string[];
  readonly handling: readonly string[];
}

export interface Clearance {
  readonly scale: ScaleId;
  readonly level: string;
  readonly compartments: readonly string[];
  readonly releasability: readonly string[];
  /** ISO 8601 UTC time with a trailing Z; absent means the clearance does not expire. */
  readonly expiresAt?: string;
}

/**
 * The one releasability entry that means "releasable to no one". An empty releasability means unrestricted, so joining two labels whose releasability
 * sets share nothing must not become unrestricted: it becomes this token, which no clearance can hold (a clearance that lists it is refused, and
 * dominance never counts it as shared).
 */
export const RELEASABILITY_NONE = 'RELEASABLE-TO-NONE';

/** A compartment or releasability token: upper case letters and digits, with `_` and `-` after the first character, at most 32 characters. */
export const LABEL_TOKEN_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

function makeScale(name: string, levels: readonly string[]): Scale {
  return Object.freeze({ name, levels: Object.freeze([...levels]) });
}

/** The shipped scale presets (D-23). Only `org` is in this first cut. */
export const SCALE_PRESETS: ScaleTable = Object.freeze({
  org: makeScale('Organization', ['Public', 'Internal', 'Confidential', 'Restricted'])
});

export const DEFAULT_SCALE: ScaleId = 'org';

const LABEL_FIELDS = ['scale', 'level', 'compartments', 'releasability', 'handling'] as const;

/** A scale by own property only, so a hostile name like `__proto__` is simply unknown. */
export function scaleOf(scales: ScaleTable, scale: string): Scale | undefined {
  return Object.prototype.hasOwnProperty.call(scales, scale) ? scales[scale] : undefined;
}

/** The level's rank on its scale, or -1 when the scale or the level is unknown. */
export function levelIndex(scales: ScaleTable, scale: string, level: string): number {
  const found = scaleOf(scales, scale);
  return found === undefined ? -1 : found.levels.indexOf(level);
}

/** `scale/level`: the key routing and the label map use, so `org/Confidential` and `ca-classified/Confidential` are different labels. */
export function labelKey(label: { readonly scale: string; readonly level: string }): string {
  return `${label.scale}/${label.level}`;
}

function parseTokenList(value: unknown, path: string): Parsed<readonly string[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (typeof entry !== 'string' || !LABEL_TOKEN_PATTERN.test(entry)) return refused('wrong-type', `${path}[${String(index)}]`);
    out.push(entry);
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseStringList(value: unknown, path: string): Parsed<readonly string[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (typeof entry !== 'string') return refused('wrong-type', `${path}[${String(index)}]`);
    out.push(entry);
  }
  return { ok: true, value: Object.freeze(out) };
}

function readScaleAndLevel(value: Fields, scales: ScaleTable, path: string): Parsed<{ readonly scale: string; readonly level: string }> {
  const scale = ownValue(value, 'scale');
  if (typeof scale !== 'string') return refused('wrong-type', childPath(path, 'scale'));
  if (scaleOf(scales, scale) === undefined) return refused('not-allowed-here', childPath(path, 'scale'));
  const level = ownValue(value, 'level');
  if (typeof level !== 'string') return refused('wrong-type', childPath(path, 'level'));
  if (levelIndex(scales, scale, level) < 0) return refused('not-allowed-here', childPath(path, 'level'));
  return { ok: true, value: { scale, level } };
}

/** Parses one label against the given scales. An unknown scale, level or field, a wrong type and a malformed token are each refused with one plain reason. */
export function parseLabel(value: unknown, scales: ScaleTable, path = ''): Parsed<Label> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, LABEL_FIELDS);
  if (keys !== undefined) return keys;
  const where = readScaleAndLevel(value, scales, path);
  if (!where.ok) return where;
  const compartments = parseTokenList(ownValue(value, 'compartments'), childPath(path, 'compartments'));
  if (!compartments.ok) return compartments;
  const releasability = parseTokenList(ownValue(value, 'releasability'), childPath(path, 'releasability'));
  if (!releasability.ok) return releasability;
  const handling = parseStringList(ownValue(value, 'handling'), childPath(path, 'handling'));
  if (!handling.ok) return handling;
  return {
    ok: true,
    value: Object.freeze({
      scale: where.value.scale,
      level: where.value.level,
      compartments: compartments.value,
      releasability: releasability.value,
      handling: handling.value
    })
  };
}

const EXPIRY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** An `expiresAt` as epoch milliseconds, or NaN when it is not a real ISO 8601 UTC time (a rolled-over date like February 30 is not real). */
export function expiryMs(text: string): number {
  if (!EXPIRY_PATTERN.test(text)) return Number.NaN;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return Number.NaN;
  return new Date(ms).toISOString().slice(0, 19) === text.slice(0, 19) ? ms : Number.NaN;
}
