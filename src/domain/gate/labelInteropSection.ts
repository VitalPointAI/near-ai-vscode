// The labelInterop section of a signed policy (feature label-interop@1; Phase 45.1, D-02, XCHG-01): how your organization's labels are written for allies.
// Pure: no I/O, no clock, no vscode, no package.
// The table is abstract, in the terms of a NATO confidentiality label (ADatP-4774 section 3, cited only; no text of it is in this repository): per scale an
// abstract policy identifier, per level a classification value, compartments as values of restrictive categories, and releasability as the values of one
// permissive "Releasable To" category, with a mapping version. Only the XML form waits for the texts (Phase 45.2). Your organization's security officer
// sets the values; nothing ships with any, so every export is refused until the section is in force (D-02). Every value maps one way only (no two entries
// share a value), so mapping out and back in gives the same label.
import { parseText } from './bundle';
import { LABEL_TOKEN_PATTERN, RELEASABILITY_NONE, scaleOf } from './labels';
import type { ScaleTable } from './labels';
import { openSection } from './sections';
import { checkKeys, childPath, isRecord, isSafeIntegerInRange, ownValue, refused } from './shape';
import type { Parsed } from './shape';

/** One compartment as a value of a restrictive category. */
export interface InteropCategoryValue {
  readonly category: string;
  readonly value: string;
}

/** Releasability as the values of one permissive category (the "Releasable To" category of the partner's label policy). */
export interface InteropReleasableTo {
  readonly category: string;
  /** Releasability token to the category value. */
  readonly values: Readonly<Record<string, string>>;
}

/** How one of your organization's scales is written for allies. */
export interface InteropScale {
  /** The abstract policy identifier of the partner label policy this scale maps to. */
  readonly policy: string;
  /** Level name to classification value. Only the levels listed here can leave. */
  readonly levels: Readonly<Record<string, string>>;
  /** Compartment token to its restrictive category and value. */
  readonly compartments: Readonly<Record<string, InteropCategoryValue>>;
  readonly releasableTo: InteropReleasableTo;
}

export interface LabelInteropTable {
  readonly v: 1;
  /** The mapping version: a whole number from 1, raised by your organization's security officer whenever a value changes. */
  readonly version: number;
  /** Scale id to how it is written. */
  readonly scales: Readonly<Record<string, InteropScale>>;
}

export const MAX_INTEROP_SCALES = 16;
export const MAX_INTEROP_ENTRIES = 256;
export const MAX_INTEROP_VERSION = 2_147_483_647;
const MAX_POLICY_TEXT = 256;
const MAX_VALUE_TEXT = 128;

/** A frozen record whose entries are defined, never assigned, so a hostile key such as `__proto__` stays an ordinary own entry. */
function frozenRecord<T>(entries: readonly (readonly [string, T])[]): Readonly<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const [key, value] of entries) Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  return Object.freeze(out);
}

function tokenKey(key: string, path: string): Parsed<string> {
  // "Releasable to no one" never leaves, so it has no entry.
  return LABEL_TOKEN_PATTERN.test(key) && key !== RELEASABILITY_NONE ? { ok: true, value: key } : refused('not-allowed-here', path);
}

function parseLevels(value: unknown, levels: readonly string[], path: string): Parsed<Readonly<Record<string, string>>> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = Object.keys(value);
  if (keys.length === 0) return refused('empty-list', path);
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const key of keys) {
    const where = childPath(path, key);
    if (!levels.includes(key)) return refused('not-allowed-here', where);
    const text = parseText(ownValue(value, key), where, MAX_VALUE_TEXT);
    if (!text.ok) return text;
    if (seen.has(text.value)) return refused('duplicate', where);
    seen.add(text.value);
    out.push([key, text.value]);
  }
  return { ok: true, value: frozenRecord(out) };
}

function parseCompartments(value: unknown, path: string): Parsed<Readonly<Record<string, InteropCategoryValue>>> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = Object.keys(value);
  if (keys.length > MAX_INTEROP_ENTRIES) return refused('wrong-type', path);
  const seen = new Set<string>();
  const out: [string, InteropCategoryValue][] = [];
  for (const key of keys) {
    const where = childPath(path, key);
    const token = tokenKey(key, where);
    if (!token.ok) return token;
    const entry = ownValue(value, key);
    if (!isRecord(entry)) return refused('wrong-type', where);
    const entryKeys = checkKeys(entry, where, ['category', 'value']);
    if (entryKeys !== undefined) return entryKeys;
    const category = parseText(ownValue(entry, 'category'), childPath(where, 'category'), MAX_VALUE_TEXT);
    if (!category.ok) return category;
    const text = parseText(ownValue(entry, 'value'), childPath(where, 'value'), MAX_VALUE_TEXT);
    if (!text.ok) return text;
    const pair = JSON.stringify([category.value, text.value]);
    if (seen.has(pair)) return refused('duplicate', where);
    seen.add(pair);
    out.push([key, Object.freeze({ category: category.value, value: text.value })]);
  }
  return { ok: true, value: frozenRecord(out) };
}

function parseReleasableTo(value: unknown, path: string): Parsed<InteropReleasableTo> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['category', 'values']);
  if (keys !== undefined) return keys;
  const category = parseText(ownValue(value, 'category'), childPath(path, 'category'), MAX_VALUE_TEXT);
  if (!category.ok) return category;
  const valuesPath = childPath(path, 'values');
  const values = ownValue(value, 'values');
  if (!isRecord(values)) return refused('wrong-type', valuesPath);
  const tokens = Object.keys(values);
  if (tokens.length > MAX_INTEROP_ENTRIES) return refused('wrong-type', valuesPath);
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const key of tokens) {
    const where = childPath(valuesPath, key);
    const token = tokenKey(key, where);
    if (!token.ok) return token;
    const text = parseText(ownValue(values, key), where, MAX_VALUE_TEXT);
    if (!text.ok) return text;
    if (seen.has(text.value)) return refused('duplicate', where);
    seen.add(text.value);
    out.push([key, text.value]);
  }
  return { ok: true, value: Object.freeze({ category: category.value, values: frozenRecord(out) }) };
}

function parseScaleEntry(value: unknown, levels: readonly string[], path: string): Parsed<InteropScale> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['policy', 'levels', 'compartments', 'releasableTo']);
  if (keys !== undefined) return keys;
  const policy = parseText(ownValue(value, 'policy'), childPath(path, 'policy'), MAX_POLICY_TEXT);
  if (!policy.ok) return policy;
  const parsedLevels = parseLevels(ownValue(value, 'levels'), levels, childPath(path, 'levels'));
  if (!parsedLevels.ok) return parsedLevels;
  const compartments = parseCompartments(ownValue(value, 'compartments'), childPath(path, 'compartments'));
  if (!compartments.ok) return compartments;
  const releasableTo = parseReleasableTo(ownValue(value, 'releasableTo'), childPath(path, 'releasableTo'));
  if (!releasableTo.ok) return releasableTo;
  // The permissive category is never also a restrictive one, or a value read back in could mean either.
  for (const token of Object.keys(compartments.value)) {
    if ((compartments.value[token] as InteropCategoryValue).category === releasableTo.value.category) {
      return refused('not-allowed-here', childPath(childPath(path, 'compartments'), token));
    }
  }
  return {
    ok: true,
    value: Object.freeze({ policy: policy.value, levels: parsedLevels.value, compartments: compartments.value, releasableTo: releasableTo.value })
  };
}

/**
 * Reads the labelInterop section against the document's scales: a mapping version from 1, and at least one scale the document names, each with its own
 * policy identifier (no two scales share one), levels on that scale and no value listed twice.
 */
export function parseLabelInteropSection(value: unknown, scales: ScaleTable, path = 'labelInterop'): Parsed<LabelInteropTable> {
  const section = openSection(value, path, ['version', 'scales']);
  if (!section.ok) return section;
  const version = ownValue(section.value, 'version');
  if (!isSafeIntegerInRange(version, 1, MAX_INTEROP_VERSION)) return refused('wrong-type', childPath(path, 'version'));
  const scalesPath = childPath(path, 'scales');
  const entries = ownValue(section.value, 'scales');
  if (!isRecord(entries)) return refused('wrong-type', scalesPath);
  const ids = Object.keys(entries);
  if (ids.length === 0) return refused('empty-list', scalesPath);
  if (ids.length > MAX_INTEROP_SCALES) return refused('wrong-type', scalesPath);
  const policies = new Set<string>();
  const out: [string, InteropScale][] = [];
  for (const id of ids) {
    const where = childPath(scalesPath, id);
    const scale = scaleOf(scales, id);
    if (scale === undefined) return refused('not-allowed-here', where);
    const entry = parseScaleEntry(ownValue(entries, id), scale.levels, where);
    if (!entry.ok) return entry;
    if (policies.has(entry.value.policy)) return refused('duplicate', childPath(where, 'policy'));
    policies.add(entry.value.policy);
    out.push([id, entry.value]);
  }
  return { ok: true, value: Object.freeze({ v: 1, version, scales: frozenRecord(out) }) };
}
