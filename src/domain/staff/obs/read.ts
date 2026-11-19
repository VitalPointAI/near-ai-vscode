// Strict readers shared by the observation contract (WP-OBS0). Pure: no I/O, no clock, no vscode.
// Input is checked in place with own-property reads and never copied with spread syntax (the rule of src/domain/gate/shape.ts). Every refusal is one
// sentence from a closed list, so a test can prove which rule held and a page can show it without inventing words.
import { parseIsoMillis } from '../../gate/shape';
import { STAFF_TEMPLATE_LABELS } from '../doctrine';
import { checkStaffKeys, childPath, isOneLine, isOneOf, isRecord, ownValue, STAFF_SLUG } from '../parse';
import type { Fields } from '../parse';

export const OBS_FAILURES = {
  'not-an-object': 'The value must be a set of named fields.',
  'unknown-field': 'That field is not part of the observation format.',
  'missing-field': 'A required field is missing.',
  'wrong-type': 'A value has the wrong kind or form.',
  'unknown-value': 'A value is not one of the allowed choices.',
  'out-of-range': 'A number is outside the allowed range.',
  'too-many': 'A list has more entries than allowed.',
  'duplicate-entry': 'A list names the same entry twice.',
  'bad-time': 'A time must be written YYYY-MM-DDTHH:MM:SS.sssZ, in UTC.',
  'time-order': 'A time window ends before it starts.',
  'bad-geometry': 'The geometry is not a valid WGS 84 point, line or polygon.',
  'grades-separate': 'Reliability (A to F, of the source) and credibility (1 to 6, of the information) are graded separately, as two fields.',
  'label-ceiling': 'Staff templates hold exercise and fictional data only, at org/Internal, NATO Unclassified or Protected A at most. Higher labels belong on accredited systems.',
  'label-widening': 'A slice never widens what the reader may see: it has no label or clearance field, and the reader\'s clearance always applies.',
  integrity: 'The observation id or segment does not match the feed, channel, message and time it names.',
  'self-supersede': 'An observation cannot supersede itself.',
  'local-only': 'Partner-only reporting is always routed local-only.',
  'partner-simulation-only': 'HUMINT, SIGINT, MASINT and CI reporting enters a staff project only as a fictional partner simulation.',
  'licence-restricted': 'This source\'s terms restrict this use: it stays off until your organization records a licence that covers it, and its data is never used for training.',
  'label-too-low': 'The label is lower than this kind of source allows.',
  'not-a-person': 'Only a named person may do this.',
  'bad-transition': 'That change is not allowed from the current state.',
  'drafts-only': 'A standing watch only drafts products and alerts a named person; it never releases, approves or tasks anything.',
  'attended-only': 'Until run contracts exist (Phase 74), a standing watch runs only while a person has the staff run open.',
  'ltiov-passed': 'The watch\'s latest time of value has passed.'
} as const;
export type ObsFailure = keyof typeof OBS_FAILURES;

export interface ObsRefusal { readonly ok: false; readonly reason: ObsFailure; readonly path: string; readonly message: string }
export type ObsParsed<T> = { readonly ok: true; readonly value: T } | ObsRefusal;

export function obsRefused(reason: ObsFailure, path = ''): ObsRefusal {
  const where = path.replace(/[^A-Za-z0-9_.[\]-]/g, '?').slice(0, 120);
  return { ok: false, reason, path: where, message: where === '' ? OBS_FAILURES[reason] : `${OBS_FAILURES[reason]} (at ${where})` };
}

/** Thrown inside a read and caught by `reading`, so a nested reader stops the whole read with one refusal. */
class Refused extends Error {
  constructor(readonly refusal: ObsRefusal) { super(refusal.message); }
}

export function fail(reason: ObsFailure, path = ''): never {
  throw new Refused(obsRefused(reason, path));
}

/** Runs a reader and turns its first refusal into the result. */
export function reading<T>(read: () => T): ObsParsed<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    throw error;
  }
}

export function fields(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Fields {
  if (!isRecord(value)) fail('not-an-object', path);
  const keys = checkStaffKeys(value, path, required, optional);
  if (keys) fail(keys.reason === 'unknown-field' ? 'unknown-field' : 'missing-field', keys.path);
  return value;
}

export function field(value: Fields, key: string): unknown {
  return ownValue(value, key);
}

export function text(value: unknown, path: string, max: number): string {
  if (!isOneLine(value, max)) fail('wrong-type', path);
  return value;
}

export function slug(value: unknown, path: string): string {
  if (typeof value !== 'string' || !STAFF_SLUG.test(value)) fail('wrong-type', path);
  return value;
}

export function choice<T extends string>(choices: readonly T[], value: unknown, path: string): T {
  if (!isOneOf(choices, value)) fail('unknown-value', path);
  return value;
}

export function num(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('wrong-type', path);
  if (value < min || value > max) fail('out-of-range', path);
  return value;
}

export function int(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('wrong-type', path);
  if (value < min || value > max) fail('out-of-range', path);
  return value;
}

export function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('wrong-type', path);
  return value;
}

/** A time in the gate's one form, `YYYY-MM-DDTHH:MM:SS.sssZ`. */
export function isoTime(value: unknown, path: string): string {
  if (typeof value !== 'string' || Number.isNaN(parseIsoMillis(value))) fail('bad-time', path);
  return value;
}

export function list<T>(value: unknown, path: string, max: number, read: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) fail('wrong-type', path);
  if (value.length > max) fail('too-many', path);
  return value.map((item, index) => read(item, `${path}[${index}]`));
}

/** A list of distinct items. */
export function uniqueList<T extends string>(value: unknown, path: string, max: number, read: (item: unknown, path: string) => T): T[] {
  const items = list(value, path, max, read);
  items.forEach((item, index) => { if (items.indexOf(item) !== index) fail('duplicate-entry', `${path}[${index}]`); });
  return items;
}

export function optionalField<T>(value: Fields, key: string, path: string, read: (raw: unknown, path: string) => T): T | undefined {
  const raw = ownValue(value, key);
  return raw === undefined ? undefined : read(raw, childPath(path, key));
}

/** A label inside the staff template ceiling (design 10, 6), as its `scale/level` key. */
export function templateLabel(value: unknown, path: string): string {
  if (typeof value !== 'string' || !STAFF_TEMPLATE_LABELS.includes(value)) fail('label-ceiling', path);
  return value;
}

export { childPath };
