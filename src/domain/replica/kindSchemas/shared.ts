// Helpers every family schema file shares (D-07). Hub-side: pure, no Yjs, and it never imports kinds.ts (no import cycle).
// Every helper reads own properties of parsed input and never spreads it, so a hostile key such as __proto__ cannot reach a result (T-30-09).
import { isStrictBase64url } from '../../team/canonical';
import { AT_PATTERN, isRecord, isSafeIntegerInRange, matches } from '../../team/validate';
import { HASH_PATTERN, isActorShape } from '../entry';
import type { Actor, Dep } from '../entry';

// The reason a known kind gets while its family's schema is not written: it fails closed, never open. Plan 30-12 asserts no kind still returns it.
export const SCHEMA_PENDING = 'schema not yet defined';

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// A reason that names the path of the first wrong field. The path is cut to safe characters so a reason can never carry markup.
export function invalidAt(path: string, why?: string): string {
  const where = path.replace(/[^A-Za-z0-9_.[\]-]/g, '?').slice(0, 120);
  return why === undefined ? `bad-data: ${where}` : `bad-data: ${where}: ${why.replace(/[^A-Za-z0-9 _.,-]/g, '?').slice(0, 80)}`;
}

// The fail-closed answer of a family whose schema its owning plan has not written yet.
export function schemaPending(family: string, kind: string): string {
  return `${SCHEMA_PENDING}: ${family} ${kind}`;
}

// True when the record has every required key, no key outside required and optional, and nothing else. Keys are compared by own names.
export function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const present = Object.keys(value);
  if (!required.every((key) => present.includes(key))) return false;
  return present.every((key) => required.includes(key) || optional.includes(key));
}

export function isSlug(value: unknown): value is string {
  return matches(value, SLUG_PATTERN);
}

export function isHash(value: unknown): value is string {
  return matches(value, HASH_PATTERN);
}

// Whole bytes a base64url text decodes to, or undefined when its length cannot be a whole number of bytes.
function decodedLength(text: string): number | undefined {
  if (text.length % 4 === 1) return undefined;
  return Math.floor((text.length * 3) / 4);
}

// Strict base64url (no padding, canonical tail) that decodes to between 1 and maxBytes bytes.
export function isBase64urlBytes(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string') return false;
  const length = decodedLength(value);
  return length !== undefined && length >= 1 && length <= maxBytes && isStrictBase64url(value, length);
}

// A canonical time text that is a real date and survives a round trip through Date.
export function isIsoTime(value: unknown): value is string {
  if (!matches(value, AT_PATTERN)) return false;
  const millis = Date.parse(value);
  return !Number.isNaN(millis) && new Date(millis).toISOString().slice(0, 19) === value.slice(0, 19);
}

export function isActor(value: unknown): value is Actor {
  return isActorShape(value);
}

export function isDep(value: unknown): value is Dep {
  if (!isRecord(value)) return false;
  return exactKeys(value, ['writer', 'seq', 'hash'])
    && isHash(value.writer) && isSafeIntegerInRange(value.seq, 0, Number.MAX_SAFE_INTEGER) && isHash(value.hash);
}
