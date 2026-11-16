// Schema layer of the validation pipeline (D-09 step 1): turns one committed file into an event or a fixed rejection reason.
// Pure: no I/O, no clock, no vscode. Parsed input is validated in place with Object.keys and own-property checks and is never
// copied with spread syntax, so a hostile prototype key cannot survive into a trusted object (T-60-19).
import { MAX_EVENT_BYTES, canonicalize, eventPath, fingerprintOf, isStrictBase64url, snapshotPath } from './canonical';
import { validatePolicy, validatePolicyChanges } from './policy';
import { AVAILABILITIES, IMPLEMENTED_EVENT_TYPES, ROLES, TEAM_REJECTION_REASONS } from './types';
import type { CommittedEvent, ImplementedEventType, ImplementedTeamEvent, Rejection } from './types';

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

// Shared field validators. Every one returns a full reason string or undefined, and none of them copies its input.
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u2028\u2029]/;
const NAME_MAX = 80;
// No email-derived value is accepted: a hash of an address salted with the public team id can be reversed by guessing addresses, so the
// roster's hash lists must stay empty in this version. A later format that needs to match addresses must use a value outsiders cannot test.
const MAX_EMAIL_HASHES = 0;
const MAX_SKILLS = 32;
const SKILL_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,39}$/;
const TIME_ZONE_PATTERN = /^[A-Za-z0-9_+/-]{1,64}$/;
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const NEAR_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const STATE_HASH_PATTERN = /^[0-9a-f]{64}$/;
const PUBLIC_KEY_BYTES = 32;
const LAST_WEEKDAY = 6;

// Display names: 1..80 characters after trimming, no control characters or line separators.
export function validateName(value: unknown, path: string): string | undefined {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) return invalid(path);
  const length = value.trim().length;
  return length >= 1 && length <= NAME_MAX ? undefined : invalid(path);
}

// A device reference is bound to its key: the fingerprint must be the hash of the decoded public key (D-31).
export function validateDeviceRef(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalid(path);
  const keyError = checkKeys(value, path, ['fingerprint', 'publicKey']);
  if (keyError !== undefined) return keyError;
  const publicKey = value.publicKey;
  if (!matches(publicKey, PUBLIC_KEY_PATTERN) || !isStrictBase64url(publicKey, PUBLIC_KEY_BYTES)) return invalid(child(path, 'publicKey'));
  const fingerprint = value.fingerprint;
  if (!matches(fingerprint, FINGERPRINT_PATTERN) || fingerprint !== fingerprintOf(Buffer.from(publicKey, 'base64url'))) return invalid(child(path, 'fingerprint'));
  return undefined;
}

function validateId(value: unknown, pattern: RegExp, path: string): string | undefined {
  return matches(value, pattern) ? undefined : invalid(path);
}

function validateChoice(value: unknown, allowed: readonly string[], path: string): string | undefined {
  return typeof value === 'string' && allowed.includes(value) ? undefined : invalid(path);
}

function validateUniqueList(value: unknown, path: string, max: number, pattern: RegExp): string | undefined {
  if (!Array.isArray(value) || value.length > max) return invalid(path);
  const seen = new Set<string>();
  for (const item of value) {
    if (!matches(item, pattern) || seen.has(item)) return invalid(path);
    seen.add(item);
  }
  return undefined;
}

// Members carry no email and no value derived from one: the list must be present and empty (MAX_EMAIL_HASHES).
function validateEmailHashes(value: unknown, path: string): string | undefined {
  return validateUniqueList(value, path, MAX_EMAIL_HASHES, EMAIL_HASH_PATTERN);
}

function validateSkills(value: unknown, path: string): string | undefined {
  return validateUniqueList(value, path, MAX_SKILLS, SKILL_PATTERN);
}

function validateWorkingHours(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalid(path);
  const keyError = checkKeys(value, path, ['tz', 'days', 'start', 'end']);
  if (keyError !== undefined) return keyError;
  if (!matches(value.tz, TIME_ZONE_PATTERN)) return invalid(child(path, 'tz'));
  const days = value.days;
  if (!Array.isArray(days) || days.length < 1 || days.length > LAST_WEEKDAY + 1) return invalid(child(path, 'days'));
  let previous = -1;
  for (const day of days) {
    if (!isSafeIntegerInRange(day, 0, LAST_WEEKDAY) || day <= previous) return invalid(child(path, 'days'));
    previous = day;
  }
  if (!matches(value.start, CLOCK_PATTERN)) return invalid(child(path, 'start'));
  if (!matches(value.end, CLOCK_PATTERN)) return invalid(child(path, 'end'));
  return undefined;
}

function validateNear(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalid(path);
  const keyError = checkKeys(value, path, ['organizationId', 'workspaceId']);
  if (keyError !== undefined) return keyError;
  return validateId(value.organizationId, NEAR_ID_PATTERN, child(path, 'organizationId'))
    ?? validateId(value.workspaceId, NEAR_ID_PATTERN, child(path, 'workspaceId'));
}

function validateLamportField(value: unknown, path: string): string | undefined {
  return isSafeIntegerInRange(value, 1, MAX_LAMPORT) ? undefined : invalid(path);
}

// Exact-key bodies for the ten Phase 60 types (D-31). The signed shapes are permanent, so a test pins each one.
type BodyValidator = (body: Fields) => string | undefined;

const BODY_VALIDATORS: Record<ImplementedEventType, BodyValidator> = {
  'team.created': (body) => checkKeys(body, 'body', ['name', 'ownerId', 'ownerName', 'ownerEmailHashes', 'ownerDevice', 'policy'], ['near'])
    ?? validateName(body.name, 'body.name')
    ?? validateId(body.ownerId, MEMBER_ID_PATTERN, 'body.ownerId')
    ?? validateName(body.ownerName, 'body.ownerName')
    ?? validateEmailHashes(body.ownerEmailHashes, 'body.ownerEmailHashes')
    ?? validateDeviceRef(body.ownerDevice, 'body.ownerDevice')
    ?? validatePolicy(body.policy, 'body.policy')
    ?? (Object.prototype.hasOwnProperty.call(body, 'near') ? validateNear(body.near, 'body.near') : undefined),
  'member.joined': (body) => checkKeys(body, 'body', ['memberId', 'name', 'emailHashes', 'role', 'device'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
    ?? validateName(body.name, 'body.name')
    ?? validateEmailHashes(body.emailHashes, 'body.emailHashes')
    ?? validateChoice(body.role, ROLES, 'body.role')
    ?? validateDeviceRef(body.device, 'body.device'),
  'member.role-changed': (body) => checkKeys(body, 'body', ['memberId', 'role'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
    ?? validateChoice(body.role, ROLES, 'body.role'),
  'member.removed': (body) => checkKeys(body, 'body', ['memberId'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId'),
  'device.added': (body) => checkKeys(body, 'body', ['memberId', 'device'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
    ?? validateDeviceRef(body.device, 'body.device'),
  'device.revoked': (body) => checkKeys(body, 'body', ['memberId', 'fingerprint'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
    ?? validateId(body.fingerprint, FINGERPRINT_PATTERN, 'body.fingerprint'),
  'member.availability': (body) => checkKeys(body, 'body', ['availability'], ['workingHours'])
    ?? validateChoice(body.availability, AVAILABILITIES, 'body.availability')
    ?? (Object.prototype.hasOwnProperty.call(body, 'workingHours') ? validateWorkingHours(body.workingHours, 'body.workingHours') : undefined),
  'member.skills': (body) => checkKeys(body, 'body', ['memberId', 'skills'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
    ?? validateSkills(body.skills, 'body.skills'),
  'policy.changed': (body) => checkKeys(body, 'body', ['changes'])
    ?? validatePolicyChanges(body.changes, 'body.changes'),
  'snapshot.written': (body) => checkKeys(body, 'body', ['coversThrough', 'lamport', 'stateHash', 'path'])
    ?? validateId(body.coversThrough, EVENT_ID_PATTERN, 'body.coversThrough')
    ?? validateLamportField(body.lamport, 'body.lamport')
    ?? validateId(body.stateHash, STATE_HASH_PATTERN, 'body.stateHash')
    ?? (body.path === snapshotPath(body.lamport as number) ? undefined : invalid('body.path'))
};

function isImplementedType(type: string): type is ImplementedEventType {
  return (IMPLEMENTED_EVENT_TYPES as readonly string[]).includes(type);
}

export function validateBody(type: string, body: unknown): string | undefined {
  if (!isImplementedType(type)) return TEAM_REJECTION_REASONS.unsupported;
  if (!isRecord(body)) return invalid('body');
  return BODY_VALIDATORS[type](body);
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
