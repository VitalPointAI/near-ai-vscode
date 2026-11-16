// Shape helpers for the capability gate's grammar (D-01, D-03). Pure: no I/O, no clock, no vscode, no package.
// Parsed input is validated in place with Object.keys and own-property checks and is never copied with spread syntax, so a hostile prototype
// key cannot survive into a trusted object (the rule of src/domain/team/validate.ts, T-70-01). The three small predicates below are copied from
// that file on purpose: its invalid() hard-codes a team message, and this folder may import only from src/domain.

/** The closed list of reasons a capability is refused, each one plain sentence. A reason is never invented at a call site. */
export const GATE_SHAPE_FAILURES = {
  'unknown-verb': 'That capability names an action the vocabulary does not have.',
  'unknown-field': 'That capability has a field the vocabulary does not have.',
  'missing-field': 'That capability is missing a field it needs.',
  'wrong-type': 'A value has the wrong kind or form.',
  'empty-list': 'A list that needs at least one entry is empty.',
  'unknown-version': 'This version of the capability vocabulary is not known to this release.',
  'not-available-yet': 'This capability is not available yet.',
  'not-sorted': 'A list is not in the required order.',
  'duplicate': 'A list names the same entry twice.',
  'not-allowed-here': 'A value is not allowed in this place.'
} as const;

export type GateShapeFailure = keyof typeof GATE_SHAPE_FAILURES;

export interface Refusal { readonly ok: false; readonly reason: GateShapeFailure; readonly path: string; readonly message: string }
export type Parsed<T> = { readonly ok: true; readonly value: T } | Refusal;

export type Fields = Record<string, unknown>;

const MAX_REASON_PATH = 120;
const MAX_REASON_KEY = 40;

/** Field paths come from untrusted files, so they are cut down to a safe alphabet and a short length before they reach a sentence. */
function safePath(path: string): string {
  return path.replace(/[^A-Za-z0-9_.[\]-]/g, '?').slice(0, MAX_REASON_PATH);
}

export function childPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

export function refused(reason: GateShapeFailure, path: string): Refusal {
  const where = safePath(path);
  return { ok: false, reason, path: where, message: where === '' ? GATE_SHAPE_FAILURES[reason] : `${GATE_SHAPE_FAILURES[reason]} (at ${where})` };
}

export function isRecord(value: unknown): value is Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isSafeIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** An own property's value, or undefined: never a value inherited from a prototype. */
export function ownValue(value: Fields, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

/** Exact-key check: every required key present, nothing outside required plus optional. Returns the refusal, or undefined when the keys are right. */
export function checkKeys(value: Fields, path: string, required: readonly string[], optional: readonly string[] = []): Refusal | undefined {
  const present = Object.keys(value);
  for (const key of present) {
    if (!required.includes(key) && !optional.includes(key)) return refused('unknown-field', childPath(path, key.slice(0, MAX_REASON_KEY)));
  }
  for (const key of required) {
    if (!present.includes(key)) return refused('missing-field', childPath(path, key));
  }
  return undefined;
}
