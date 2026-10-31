// Schema layer of the validation pipeline (D-09 step 1): turns one committed file into an event or a fixed rejection reason.
// Pure: no I/O, no clock, no vscode. Parsed input is validated in place with Object.keys and own-property checks and is never
// copied with spread syntax, so a hostile prototype key cannot survive into a trusted object (T-60-19).
import { MAX_EVENT_BYTES, canonicalize, eventPath, isStrictBase64url } from './canonical';
import { IMPLEMENTED_EVENT_TYPES, TEAM_REJECTION_REASONS } from './types';
import type { CommittedEvent, ImplementedTeamEvent, Rejection } from './types';

export const EVENT_ID_PATTERN = /^evt-[0-9A-HJKMNP-TV-Z]{26}$/;
export const MEMBER_ID_PATTERN = /^mbr-[0-9a-f]{16}$/;
export const TEAM_ID_PATTERN = /^team-[0-9a-f]{32}$/;
export const FINGERPRINT_PATTERN = /^dev-[0-9a-f]{32}$/;
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
export const EMAIL_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const EVENT_PATH_PATTERN = /^events\/(\d{12})-(evt-[0-9A-HJKMNP-TV-Z]{26})\.json$/;
export const SNAPSHOT_PATH_PATTERN = /^snapshots\/(\d{12})\.json$/;
export const MAX_LAMPORT = 999_999_999_999;

export type Fields = Record<string, unknown>;
export type ParsedEntry = { ok: true; event: ImplementedTeamEvent } | { ok: false; rejection: Rejection };

const ENVELOPE_KEYS = ['v', 'id', 'teamId', 'type', 'lamport', 'at', 'author', 'device', 'prev', 'body', 'sig'];
const MAX_REASON_KEY = 40;
const MAX_REASON_PATH = 120;

// A reason is a fixed prefix plus a short field path. Key names come from untrusted files, so they are cut down to a safe alphabet.
export function invalid(path: string): string {
  const safe = path.replace(/[^A-Za-z0-9_.[\]-]/g, '?');
  return `${TEAM_REJECTION_REASONS.invalidBody}: ${safe.slice(0, MAX_REASON_PATH)}`;
}

export function child(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

export function isRecord(value: unknown): value is Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Exact-key check: every required key present, nothing outside required plus optional. Returns the offending path.
export function checkKeys(value: Fields, path: string, required: readonly string[], optional: readonly string[] = []): string | undefined {
  const present = Object.keys(value);
  for (const key of required) {
    if (!present.includes(key)) return invalid(child(path, key));
  }
  for (const key of present) {
    if (!required.includes(key) && !optional.includes(key)) return invalid(child(path, key.slice(0, MAX_REASON_KEY)));
  }
  return undefined;
}

export function isSafeIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

// Envelope fields in the order a reader would look at them. Version and type come first so a newer event always gets the D-07 reason.
export function validateEnvelope(value: unknown): string | undefined {
  if (!isRecord(value)) return invalid('event');
  if (value.v !== 1) return TEAM_REJECTION_REASONS.unsupported;
  if (typeof value.type !== 'string' || !(IMPLEMENTED_EVENT_TYPES as readonly string[]).includes(value.type)) return TEAM_REJECTION_REASONS.unsupported;
  const keyError = checkKeys(value, '', ENVELOPE_KEYS);
  if (keyError !== undefined) return keyError;
  if (!matches(value.id, EVENT_ID_PATTERN)) return invalid('id');
  if (!matches(value.teamId, TEAM_ID_PATTERN)) return invalid('teamId');
  if (!matches(value.author, MEMBER_ID_PATTERN)) return invalid('author');
  if (!matches(value.device, FINGERPRINT_PATTERN)) return invalid('device');
  if (value.prev !== '' && !matches(value.prev, EVENT_ID_PATTERN)) return invalid('prev');
  if (!matches(value.at, AT_PATTERN)) return invalid('at');
  if (!isSafeIntegerInRange(value.lamport, 1, MAX_LAMPORT)) return invalid('lamport');
  if (!matches(value.sig, SIGNATURE_PATTERN) || !isStrictBase64url(value.sig, 64)) return invalid('sig');
  if (!isRecord(value.body)) return invalid('body');
  return undefined;
}

// Interim table: Task 2 of plan 60-04 replaces this with the exact-key body validators for all ten types.
export function validateBody(type: string, body: unknown): string | undefined {
  if (!(IMPLEMENTED_EVENT_TYPES as readonly string[]).includes(type)) return TEAM_REJECTION_REASONS.unsupported;
  if (!isRecord(body)) return invalid('body');
  if (type === 'member.availability') {
    const keyError = checkKeys(body, 'body', ['availability']);
    if (keyError !== undefined) return keyError;
    return body.availability === 'available' ? undefined : invalid('body.availability');
  }
  return undefined;
}

function rejectionFor(entry: CommittedEvent, reason: string, parsed?: unknown): ParsedEntry {
  let eventId = entry.path;
  if (isRecord(parsed) && matches(parsed.id, EVENT_ID_PATTERN)) eventId = parsed.id;
  return { ok: false, rejection: { eventId, reason } };
}

// D-08 and D-09 step 1: size, parse, canonical bytes, envelope, body, then the file name. The first failure decides the reason.
export function parseEventFile(entry: CommittedEvent): ParsedEntry {
  if (entry.size > MAX_EVENT_BYTES || Buffer.byteLength(entry.text, 'utf8') > MAX_EVENT_BYTES) return rejectionFor(entry, TEAM_REJECTION_REASONS.tooLarge);
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.text);
  } catch {
    // Text that is not JSON is a malformed event; the verdict is the rejection, not a thrown error.
    return rejectionFor(entry, TEAM_REJECTION_REASONS.malformed);
  }
  let canonical: string;
  try {
    canonical = canonicalize(parsed);
  } catch {
    // Floats, unsafe integers, odd values and excess depth cannot be canonical, so the file is rejected as such.
    return rejectionFor(entry, TEAM_REJECTION_REASONS.notCanonical, parsed);
  }
  if (canonical !== entry.text) return rejectionFor(entry, TEAM_REJECTION_REASONS.notCanonical, parsed);
  const envelopeError = validateEnvelope(parsed);
  if (envelopeError !== undefined) return rejectionFor(entry, envelopeError, parsed);
  const event = parsed as ImplementedTeamEvent;
  const bodyError = validateBody(event.type, event.body);
  if (bodyError !== undefined) return rejectionFor(entry, bodyError, parsed);
  if (entry.path !== eventPath(event)) return rejectionFor(entry, TEAM_REJECTION_REASONS.fileName, parsed);
  return { ok: true, event };
}
