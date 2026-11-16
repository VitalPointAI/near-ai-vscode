// Labels v1 (CLAS-01, CLAS-02, D-22, D-23): a label is exactly { scale, level, compartments, releasability, handling }, and `level` is the level's name
// from the scale's ordered list, never a number, so a label reads plainly in files and records. Pure: no I/O, no clock, no vscode, no package.
// Names and tokens compare by exact string equality: no case folding and no Unicode normalisation (a level that differs by case is a different, unknown level).
// Once a release ships a preset id, a level name or a handling value it never changes in place: a change is label v2 beside v1 (D-22).
import { checkKeys, childPath, isRecord, ownValue, parseIsoMillis, refused } from './shape';
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
  /** `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC, exactly three fraction digits); absent means the clearance does not expire. */
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

/**
 * The four shipped scale presets (D-23), each an ordered list, lowest first. A clearance on one scale covers another only through a mapping in the
 * bundle (ScaleMapping); none ships by default. Preset ids and level names end up in label maps and signed bundles, so they never change in place.
 */
export const SCALE_PRESETS: ScaleTable = Object.freeze({
  org: makeScale('Organization', ['Public', 'Internal', 'Confidential', 'Restricted']),
  'ca-protected': makeScale('Canada, Protected', ['Protected A', 'Protected B', 'Protected C']),
  'ca-classified': makeScale('Canada, Classified', ['Confidential', 'Secret', 'Top Secret']),
  nato: makeScale('NATO', ['NATO Unclassified', 'NATO Restricted', 'NATO Confidential', 'NATO Secret', 'Cosmic Top Secret'])
});

export const DEFAULT_SCALE: ScaleId = 'org';

/**
 * The v1 handling flags (D-47). Both only tighten: `local-only` keeps content on the machine and `no-agent-tools` keeps agent tools away from it.
 * There is deliberately no flag that relaxes a routing tier, so a label can never make content easier to send.
 */
export const HANDLING_FLAGS = Object.freeze(['local-only', 'no-agent-tools'] as const);
export type HandlingFlag = (typeof HANDLING_FLAGS)[number];

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

/** A list must be strictly ascending by code unit: out of order is `not-sorted`, an equal neighbour is `duplicate`, so equal labels have one canonical form. */
function checkSortedUnique(list: readonly string[], path: string): Parsed<readonly string[]> {
  for (let index = 1; index < list.length; index += 1) {
    const before = list[index - 1] as string;
    const here = list[index] as string;
    if (here === before) return refused('duplicate', `${path}[${String(index)}]`);
    if (here < before) return refused('not-sorted', `${path}[${String(index)}]`);
  }
  return { ok: true, value: Object.freeze([...list]) };
}

function parseTokenList(value: unknown, path: string): Parsed<readonly string[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (typeof entry !== 'string' || !LABEL_TOKEN_PATTERN.test(entry)) return refused('wrong-type', `${path}[${String(index)}]`);
    out.push(entry);
  }
  return checkSortedUnique(out, path);
}

function parseHandling(value: unknown, path: string): Parsed<readonly string[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (typeof entry !== 'string') return refused('wrong-type', `${path}[${String(index)}]`);
    if (!(HANDLING_FLAGS as readonly string[]).includes(entry)) return refused('not-allowed-here', `${path}[${String(index)}]`);
    out.push(entry);
  }
  return checkSortedUnique(out, path);
}

/** The reserved "releasable to no one" token may only stand alone in a label, so it can never be hidden among real entries. */
function parseLabelReleasability(value: unknown, path: string): Parsed<readonly string[]> {
  const list = parseTokenList(value, path);
  if (list.ok && list.value.includes(RELEASABILITY_NONE) && list.value.length > 1) return refused('not-allowed-here', path);
  return list;
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
  const releasability = parseLabelReleasability(ownValue(value, 'releasability'), childPath(path, 'releasability'));
  if (!releasability.ok) return releasability;
  const handling = parseHandling(ownValue(value, 'handling'), childPath(path, 'handling'));
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

const CLEARANCE_FIELDS = ['scale', 'level', 'compartments', 'releasability'] as const;

/** Parses a clearance. Its releasability may not list the reserved "releasable to no one" token, and `expiresAt`, when present, must be a real UTC time in the one form the gate uses (`YYYY-MM-DDTHH:MM:SS.sssZ`). */
export function parseClearance(value: unknown, scales: ScaleTable, path = ''): Parsed<Clearance> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, CLEARANCE_FIELDS, ['expiresAt']);
  if (keys !== undefined) return keys;
  const where = readScaleAndLevel(value, scales, path);
  if (!where.ok) return where;
  const compartments = parseTokenList(ownValue(value, 'compartments'), childPath(path, 'compartments'));
  if (!compartments.ok) return compartments;
  const releasability = parseTokenList(ownValue(value, 'releasability'), childPath(path, 'releasability'));
  if (!releasability.ok) return releasability;
  if (releasability.value.includes(RELEASABILITY_NONE)) return refused('not-allowed-here', childPath(path, 'releasability'));
  const expiresAt = ownValue(value, 'expiresAt');
  if (Object.prototype.hasOwnProperty.call(value, 'expiresAt')) {
    if (typeof expiresAt !== 'string' || Number.isNaN(expiryMs(expiresAt))) return refused('wrong-type', childPath(path, 'expiresAt'));
  }
  const base = { scale: where.value.scale, level: where.value.level, compartments: compartments.value, releasability: releasability.value };
  return { ok: true, value: Object.freeze(typeof expiresAt === 'string' ? { ...base, expiresAt } : base) };
}

/** One end of a mapping: a level on a scale. */
export interface ScaleRef {
  readonly scale: ScaleId;
  readonly level: string;
}

/**
 * A mapping from the bundle: a clearance at or above `from` on its own scale covers labels up to and including `covers` on another scale.
 * Mappings only ever come from the signed bundle, and none ships by default (CLAS-02).
 */
export interface ScaleMapping {
  readonly from: ScaleRef;
  readonly covers: ScaleRef;
}

function parseScaleRef(value: unknown, scales: ScaleTable, path: string): Parsed<ScaleRef> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['scale', 'level']);
  if (keys !== undefined) return keys;
  const where = readScaleAndLevel(value, scales, path);
  if (!where.ok) return where;
  return { ok: true, value: Object.freeze({ scale: where.value.scale, level: where.value.level }) };
}

/** Parses a mapping. Both ends must be real levels, and the two scales must differ (a mapping within one scale would mean nothing). */
export function parseMapping(value: unknown, scales: ScaleTable, path = ''): Parsed<ScaleMapping> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['from', 'covers']);
  if (keys !== undefined) return keys;
  const from = parseScaleRef(ownValue(value, 'from'), scales, childPath(path, 'from'));
  if (!from.ok) return from;
  const covers = parseScaleRef(ownValue(value, 'covers'), scales, childPath(path, 'covers'));
  if (!covers.ok) return covers;
  if (from.value.scale === covers.value.scale) return refused('not-allowed-here', childPath(path, 'covers'));
  return { ok: true, value: Object.freeze({ from: from.value, covers: covers.value }) };
}

/** Until verified credentials arrive (Phase 71), a clearance is the person's own word, so every place that shows one says so in these words (D-27). */
export const CLEARANCE_SELF_ASSERTED_TEXT =
  'Until verified credentials arrive, your clearance comes from your own policy file, which your own device key signs, so it is self-declared. It is not an enforced clearance boundary.';

/** What labels and routing do and do not promise (D-32, amended by D-40). SECURITY.md and the label settings repeat this string exactly. */
export const LABELS_NOT_ACCREDITATION_TEXT =
  'Labels and routing are an organizational control that helps prevent mistakes. They check what NEAR AI itself sends to a model and what its own file tools read, and they cannot see everything a shell command or an add-on server does. They do not make this device accredited for classified information. Until verified credentials arrive, your clearance is the one you declared yourself, so it is not an enforced boundary.';

/** Where the preset lists come from and who confirms them (D-23). */
export const SCALE_PRESETS_CAVEAT_TEXT =
  "The NATO levels come from secondary copies, and treating the Canadian Protected and Classified families as two scales is how NEAR AI reads them. Your organization's security officer should confirm both before you rely on them.";

/** A clearance's `expiresAt` as epoch milliseconds, or NaN when it is not in the one time form the gate uses (see parseIsoMillis in shape.ts). */
export function expiryMs(text: string): number {
  return parseIsoMillis(text);
}
