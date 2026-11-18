// Strict parsing helpers for the staff contract (WP-0). Pure: no I/O, no clock, no vscode.
// Parsed input is checked in place with own-property reads and is never copied with spread syntax, so a hostile prototype key cannot survive into a
// trusted object (the rule of src/domain/gate/shape.ts, whose small predicates are reused here). Every refusal is one sentence from a closed list.
import { childPath, isRecord, ownValue } from '../gate/shape';
import type { Fields } from '../gate/shape';

export { childPath, isRecord, ownValue };
export type { Fields };

/** The closed list of reasons a staff file or setting is refused. A reason is never invented at a call site. */
export const STAFF_PARSE_FAILURES = {
  'not-an-object': 'The value must be a set of named fields.',
  'unknown-field': 'That field is not part of the staff format.',
  'missing-field': 'A required field is missing.',
  'duplicate-field': 'The same field is given twice.',
  'wrong-type': 'A value has the wrong kind or form.',
  'unknown-value': 'A value is not one of the allowed choices.',
  'not-offered': 'That profile does not offer that level.',
  'not-allowed-here': 'A value is not allowed in this place.',
  'duplicate-entry': 'A list names the same entry twice.',
  'out-of-range': 'A number is outside the allowed range.',
  'bad-syntax': 'A line is not in the expected form.'
} as const;

export type StaffParseFailure = keyof typeof STAFF_PARSE_FAILURES;

export interface StaffRefusal { readonly ok: false; readonly reason: StaffParseFailure; readonly path: string; readonly message: string }
export type StaffParsed<T> = { readonly ok: true; readonly value: T } | StaffRefusal;

const MAX_PATH = 120;

export function staffRefused(reason: StaffParseFailure, path: string): StaffRefusal {
  const where = path.replace(/[^A-Za-z0-9_.[\]-]/g, '?').slice(0, MAX_PATH);
  return { ok: false, reason, path: where, message: where === '' ? STAFF_PARSE_FAILURES[reason] : `${STAFF_PARSE_FAILURES[reason]} (at ${where})` };
}

export function ok<T>(value: T): StaffParsed<T> {
  return { ok: true, value };
}

/** Exact-key check: every required key present, nothing outside required plus optional. */
export function checkStaffKeys(value: Fields, path: string, required: readonly string[], optional: readonly string[] = []): StaffRefusal | undefined {
  const present = Object.keys(value);
  for (const key of present) {
    if (!required.includes(key) && !optional.includes(key)) return staffRefused('unknown-field', childPath(path, key.slice(0, 40)));
  }
  for (const key of required) {
    if (!present.includes(key)) return staffRefused('missing-field', childPath(path, key));
  }
  return undefined;
}

/** Whether `value` is one of `choices`, compared by exact string equality (no case folding). */
export function isOneOf<T extends string>(choices: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (choices as readonly string[]).includes(value);
}

/** A slug: lower case letters, digits and dashes, starting with a letter or digit, at most 64 characters. Product, member and layer names use it. */
export const STAFF_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One line of plain text: no line breaks or other control characters, not blank, at most `max` characters. */
export function isOneLine(value: unknown, max: number): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

// A small, strict subset of YAML for the staff headers and the team-file `staff:` block: `key: value` lines whose value is a plain scalar, a flow list
// `[a, b]` or a flow map `{ k: v, k: v }`, with an optional `# note` after whitespace. No quoting, no nesting inside flow values, no block lists:
// anything else is refused rather than guessed at, so a file means exactly one thing.

/** A value with any trailing ` # note` removed. A `#` that is not after whitespace stays part of the value. */
export function stripNote(value: string): string {
  const match = /(^|\s)#/.exec(value);
  return (match ? value.slice(0, match.index) : value).trim();
}

/** `[a, b, c]` as its items (an empty list is `[]`), or undefined when the text is not a flow list of plain items. */
export function parseFlowList(text: string): string[] | undefined {
  const match = /^\[(.*)\]$/.exec(text.trim());
  if (!match) return undefined;
  const inner = match[1].trim();
  if (inner === '') return [];
  const items = inner.split(',').map((item) => item.trim());
  return items.every((item) => item !== '' && !/[[\]{}:'"]/.test(item)) ? items : undefined;
}

/** `{ k: v, k: v }` as ordered pairs, or undefined when the text is not a flow map of plain keys and values. Duplicate keys are kept for the caller to refuse. */
export function parseFlowMap(text: string): Array<[string, string]> | undefined {
  const match = /^\{(.*)\}$/.exec(text.trim());
  if (!match) return undefined;
  const inner = match[1].trim();
  if (inner === '') return [];
  const pairs: Array<[string, string]> = [];
  for (const part of inner.split(',')) {
    const pair = /^\s*([^:\s[\]{}'"]+):\s+([^[\]{}'"]*?)\s*$/.exec(part);
    if (!pair || pair[2] === '') return undefined;
    pairs.push([pair[1], pair[2]]);
  }
  return pairs;
}

/** One `key: value` line of a block (after its indent), or undefined when the line is not in that form. The value has its note stripped. */
export function parseKeyLine(line: string): { key: string; value: string } | undefined {
  const match = /^([a-z][a-z0-9_-]*):(?:\s+(.*))?$/.exec(line);
  if (!match) return undefined;
  return { key: match[1], value: stripNote(match[2] ?? '') };
}
