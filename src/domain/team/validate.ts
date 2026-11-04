// Schema layer of the validation pipeline (D-09 step 1): turns one committed file into an event or a fixed rejection reason.
// Pure: no I/O, no clock, no vscode. Parsed input is validated in place with Object.keys and own-property checks and is never
// copied with spread syntax, so a hostile prototype key cannot survive into a trusted object (T-60-19).
import { MAX_EVENT_BYTES, canonicalize, eventPath, fingerprintOf, isStrictBase64url, snapshotPath } from './canonical';
import { validatePolicy, validatePolicyChanges } from './policy';
import { AVAILABILITIES, IMPLEMENTED_EVENT_TYPES, INVITABLE_ROLES, ROLES, TEAM_REJECTION_REASONS } from './types';
import type { CommittedEvent, ImplementedEventType, ImplementedTeamEvent, ItemKind, Rejection } from './types';
import { BOARD_ITEM_ID_PATTERN, GSD_ITEM_ID_PATTERN, isScopePattern, itemKindOf } from './work';

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
const MAX_EMAIL_HASHES = 8;
const MAX_SKILLS = 32;
const SKILL_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,39}$/;
const TIME_ZONE_PATTERN = /^[A-Za-z0-9_+/-]{1,64}$/;
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const NEAR_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const STATE_HASH_PATTERN = /^[0-9a-f]{64}$/;
const PUBLIC_KEY_BYTES = 32;
const LAST_WEEKDAY = 6;
const MIN_INVITE_TTL_SECONDS = 3600;
const MAX_INVITE_TTL_SECONDS = 2_592_000;
const SIGNATURE_BYTES = 64;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MIN_CIPHERTEXT_BYTES = 16;
const MAX_CIPHERTEXT_BYTES = 525;
const MAX_SEALED_ENTRIES = 8;
// The only sealing scheme this version reads. A new scheme is a new string and a new reader, never a silent change.
const SEAL_SCHEME_NAME = 'x25519-hkdf-sha256-aes-256-gcm-v1';

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

// Members carry salted hashes only; a plain address can never match the 64 hex shape.
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

function has(body: Fields, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

// A one-key object holding strict base64url of the given length, such as { publicKey } or { sig }.
function validateKeyHolder(value: unknown, path: string, key: string, byteLength: number): string | undefined {
  if (!isRecord(value)) return invalid(path);
  const keyError = checkKeys(value, path, [key]);
  if (keyError !== undefined) return keyError;
  const text = value[key];
  return typeof text === 'string' && isStrictBase64url(text, byteLength) ? undefined : invalid(child(path, key));
}

// Exactly one salted hash: an invitation is for one person's address.
function validateSingleEmailHash(value: unknown, path: string): string | undefined {
  return validateEmailHashes(value, path) ?? ((value as unknown[]).length === 1 ? undefined : invalid(path));
}

// A ciphertext is strict base64url of 16 to 525 bytes with no padding. The byte length follows from the text length, then the strict check
// confirms the alphabet and that re-encoding gives the same text.
function validateCiphertext(value: unknown, path: string): string | undefined {
  if (typeof value !== 'string') return invalid(path);
  const bytes = Math.floor((value.length * 3) / 4);
  return bytes >= MIN_CIPHERTEXT_BYTES && bytes <= MAX_CIPHERTEXT_BYTES && isStrictBase64url(value, bytes) ? undefined : invalid(path);
}

function validateSealedEntry(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalid(path);
  return checkKeys(value, path, ['device', 'ephemeral', 'nonce', 'tag', 'ciphertext'])
    ?? validateId(value.device, FINGERPRINT_PATTERN, child(path, 'device'))
    ?? validateKeyHolder(value.ephemeral, child(path, 'ephemeral'), 'publicKey', PUBLIC_KEY_BYTES)
    ?? (typeof value.nonce === 'string' && isStrictBase64url(value.nonce, NONCE_BYTES) ? undefined : invalid(child(path, 'nonce')))
    ?? (typeof value.tag === 'string' && isStrictBase64url(value.tag, TAG_BYTES) ? undefined : invalid(child(path, 'tag')))
    ?? validateCiphertext(value.ciphertext, child(path, 'ciphertext'));
}

// One to eight entries, each for a different device.
function validateSealedList(value: unknown, path: string): string | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SEALED_ENTRIES) return invalid(path);
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    const problem = validateSealedEntry(entry, `${path}[${index}]`);
    if (problem !== undefined) return problem;
    const device = (entry as Fields).device as string;
    if (seen.has(device)) return invalid(path);
    seen.add(device);
  }
  return undefined;
}

function validateLamportField(value: unknown, path: string): string | undefined {
  return isSafeIntegerInRange(value, 1, MAX_LAMPORT) ? undefined : invalid(path);
}

// ---- Work item fields (D-04, D-10 to D-14) -------------------------------------------------------------------------------------------
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 2000;
export const REASON_MAX = 200;
export const MUST_HAVE_MAX = 600;
export const MAX_SCOPE_ENTRIES = 64;
export const MAX_REQUIREMENTS = 32;
export const MAX_MUST_HAVES = 16;
export const MAX_DEPENDENCIES = 32;
export const MAX_TAGS = 8;
export const MAX_ESTIMATE_TOKENS = 1_000_000_000_000;
export const MAX_WAVE = 99;
export const REQUIREMENT_PATTERN = /^[A-Z][A-Z0-9]{0,15}-\d{1,3}$/;
export const ITEM_TAG_PATTERN = /^[a-z][a-z0-9:-]{0,39}$/;
export const GSD_PHASE_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;
export const GSD_PLAN_PATTERN = /^\d{2,3}$/;
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
// A description may hold line feeds; nothing else below the space character is allowed.
const DESCRIPTION_CONTROL_CHARACTERS = /[\u0000-\u0009\u000B-\u001F\u007F\u2028\u2029]/;
const CONFIDENCES: readonly string[] = ['low', 'medium', 'high'];
const IMPORTED_KINDS: readonly string[] = ['milestone', 'phase', 'plan', 'task'];
const BOARD_KINDS: readonly string[] = ['bug', 'chore', 'spike'];
// Kinds that carry a parent. A milestone has none; the parent kind each of these needs is checked by transitionProblem.
const PARENT_KINDS: Readonly<Record<string, ItemKind>> = { phase: 'milestone', plan: 'phase', task: 'plan' };

export function validateText(value: unknown, path: string, max: number): string | undefined {
  return typeof value === 'string' && value.trim().length >= 1 && value.length <= max && !CONTROL_CHARACTERS.test(value) ? undefined : invalid(path);
}

export function validateDescription(value: unknown, path: string): string | undefined {
  return typeof value === 'string' && value.length <= DESCRIPTION_MAX && !DESCRIPTION_CONTROL_CHARACTERS.test(value) ? undefined : invalid(path);
}

function validateItemList(value: unknown, path: string, max: number, entry: (item: string) => boolean): string | undefined {
  if (!Array.isArray(value) || value.length > max) return invalid(path);
  return value.every((item: unknown) => typeof item === 'string' && entry(item)) ? undefined : invalid(path);
}

export function validateScope(value: unknown, path: string): string | undefined {
  return validateItemList(value, path, MAX_SCOPE_ENTRIES, isScopePattern);
}

export function validateRequirements(value: unknown, path: string): string | undefined {
  return validateItemList(value, path, MAX_REQUIREMENTS, (item) => REQUIREMENT_PATTERN.test(item));
}

export function validateMustHaves(value: unknown, path: string): string | undefined {
  return validateItemList(value, path, MAX_MUST_HAVES, (item) => item.trim().length >= 1 && item.length <= MUST_HAVE_MAX && !CONTROL_CHARACTERS.test(item));
}

// Dependencies name plans or phases, never tasks, milestones or board items.
export function validateDependencies(value: unknown, path: string): string | undefined {
  return validateItemList(value, path, MAX_DEPENDENCIES, (item) => {
    const kind = itemKindOf(item);
    return kind === 'plan' || kind === 'phase';
  });
}

export function validateItemTags(value: unknown, path: string): string | undefined {
  return validateItemList(value, path, MAX_TAGS, (item) => ITEM_TAG_PATTERN.test(item));
}

export function validateEstimate(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalid(path);
  return checkKeys(value, path, ['tokens'], ['confidence'])
    ?? (isSafeIntegerInRange(value.tokens, 1, MAX_ESTIMATE_TOKENS) ? undefined : invalid(child(path, 'tokens')))
    ?? (has(value, 'confidence') ? validateChoice(value.confidence, CONFIDENCES, child(path, 'confidence')) : undefined);
}

export function validateGsdRef(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalid(path);
  return checkKeys(value, path, ['phase'], ['plan', 'wave', 'file'])
    ?? validateId(value.phase, GSD_PHASE_PATTERN, child(path, 'phase'))
    ?? (has(value, 'plan') ? validateId(value.plan, GSD_PLAN_PATTERN, child(path, 'plan')) : undefined)
    ?? (has(value, 'wave') ? (isSafeIntegerInRange(value.wave, 1, MAX_WAVE) ? undefined : invalid(child(path, 'wave'))) : undefined)
    ?? (has(value, 'file') ? (typeof value.file === 'string' && isScopePattern(value.file) ? undefined : invalid(child(path, 'file'))) : undefined);
}

// The id of an imported item names its kind (D-04), and the kind in the body must agree with the prefix.
function validateImportedId(body: Fields): string | undefined {
  return matches(body.id, GSD_ITEM_ID_PATTERN) && itemKindOf(body.id) === body.kind ? undefined : invalid('body.id');
}

// A milestone has no parent; a phase, plan or task names one by an imported id. Whether that parent exists and has the kind above it is
// a question about the log's state, answered at the reference step (itemParent), not by the schema.
function validateParent(body: Fields): string | undefined {
  if (PARENT_KINDS[body.kind as string] === undefined) return has(body, 'parentId') ? invalid('body.parentId') : undefined;
  return matches(body.parentId, GSD_ITEM_ID_PATTERN) ? undefined : invalid('body.parentId');
}

function validateLiteralTrue(value: unknown, path: string): string | undefined {
  return value === true ? undefined : invalid(path);
}

function validateBoolean(value: unknown, path: string): string | undefined {
  return typeof value === 'boolean' ? undefined : invalid(path);
}

export function validateSource(value: unknown, path: string): string | undefined {
  return matches(value, COMMIT_PATTERN) ? undefined : invalid(path);
}

function validateItemRef(body: Fields): string | undefined {
  return matches(body.id, GSD_ITEM_ID_PATTERN) || matches(body.id, BOARD_ITEM_ID_PATTERN) ? undefined : invalid('body.id');
}

const CHANGE_KEYS = ['title', 'description', 'scope', 'requirements', 'mustHaves', 'dependsOn', 'estimate', 'gsd', 'tags', 'summary', 'active', 'source', 'hold', 'state'];

const CHANGE_VALIDATORS: Readonly<Record<string, (value: unknown, path: string) => string | undefined>> = {
  title: (value, path) => validateText(value, path, TITLE_MAX),
  description: validateDescription,
  scope: validateScope,
  requirements: validateRequirements,
  mustHaves: validateMustHaves,
  dependsOn: validateDependencies,
  estimate: validateEstimate,
  gsd: validateGsdRef,
  tags: validateItemTags,
  summary: validateBoolean,
  active: validateBoolean,
  source: validateSource,
  hold: validateBoolean,
  state: (value, path) => (value === 'done' ? undefined : invalid(path))
};

// At least one change, only known keys, and a hold or a mark-done never travels with anything else, so one event is one move.
function validateChanges(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalid(path);
  const keyError = checkKeys(value, path, [], CHANGE_KEYS);
  if (keyError !== undefined) return keyError;
  const keys = Object.keys(value);
  if (keys.length === 0) return invalid(path);
  if (keys.length > 1 && (keys.includes('hold') || keys.includes('state'))) return invalid(path);
  for (const key of keys) {
    const problem = (CHANGE_VALIDATORS[key] as (value: unknown, path: string) => string | undefined)(value[key], child(path, key));
    if (problem !== undefined) return problem;
  }
  return undefined;
}

// Exact-key bodies for the implemented types (D-31). The signed shapes are permanent, so a test pins each one.
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
  'member.invited': (body) => checkKeys(body, 'body', ['memberId', 'name', 'emailHashes', 'role', 'allocationNanoUsd', 'ttlSeconds', 'invite'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
    ?? validateName(body.name, 'body.name')
    ?? validateSingleEmailHash(body.emailHashes, 'body.emailHashes')
    ?? validateChoice(body.role, INVITABLE_ROLES, 'body.role')
    ?? (isSafeIntegerInRange(body.allocationNanoUsd, 0, Number.MAX_SAFE_INTEGER) ? undefined : invalid('body.allocationNanoUsd'))
    ?? (isSafeIntegerInRange(body.ttlSeconds, MIN_INVITE_TTL_SECONDS, MAX_INVITE_TTL_SECONDS) ? undefined : invalid('body.ttlSeconds'))
    ?? validateKeyHolder(body.invite, 'body.invite', 'publicKey', PUBLIC_KEY_BYTES),
  'member.joined': (body) => checkKeys(body, 'body', ['memberId', 'name', 'emailHashes', 'role', 'device'], ['invite', 'sealKey'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
    ?? validateName(body.name, 'body.name')
    ?? validateEmailHashes(body.emailHashes, 'body.emailHashes')
    ?? validateChoice(body.role, ROLES, 'body.role')
    ?? validateDeviceRef(body.device, 'body.device')
    ?? (has(body, 'invite') ? validateKeyHolder(body.invite, 'body.invite', 'sig', SIGNATURE_BYTES) : undefined)
    ?? (has(body, 'sealKey') ? validateKeyHolder(body.sealKey, 'body.sealKey', 'publicKey', PUBLIC_KEY_BYTES) : undefined),
  'member.role-changed': (body) => checkKeys(body, 'body', ['memberId', 'role'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
    ?? validateChoice(body.role, ROLES, 'body.role'),
  'member.removed': (body) => checkKeys(body, 'body', ['memberId'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId'),
  'device.added': (body) => checkKeys(body, 'body', ['memberId', 'device'], ['sealKey'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
    ?? validateDeviceRef(body.device, 'body.device')
    ?? (has(body, 'sealKey') ? validateKeyHolder(body.sealKey, 'body.sealKey', 'publicKey', PUBLIC_KEY_BYTES) : undefined),
  'device.revoked': (body) => checkKeys(body, 'body', ['memberId', 'fingerprint'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
    ?? validateId(body.fingerprint, FINGERPRINT_PATTERN, 'body.fingerprint'),
  'member.availability': (body) => checkKeys(body, 'body', ['availability'], ['workingHours'])
    ?? validateChoice(body.availability, AVAILABILITIES, 'body.availability')
    ?? (Object.prototype.hasOwnProperty.call(body, 'workingHours') ? validateWorkingHours(body.workingHours, 'body.workingHours') : undefined),
  'member.skills': (body) => checkKeys(body, 'body', ['memberId', 'skills'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
    ?? validateSkills(body.skills, 'body.skills'),
  'member.key-sealed': (body) => checkKeys(body, 'body', ['memberId', 'keyId', 'scheme', 'sealed'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
    ?? validateId(body.keyId, NEAR_ID_PATTERN, 'body.keyId')
    ?? (body.scheme === SEAL_SCHEME_NAME ? undefined : invalid('body.scheme'))
    ?? validateSealedList(body.sealed, 'body.sealed'),
  'item.imported': (body) => checkKeys(body, 'body', ['id', 'kind', 'title', 'state', 'dependsOn', 'scope', 'requirements', 'mustHaves', 'tags'], ['parentId', 'gsd', 'estimate', 'summary', 'active', 'source'])
    ?? validateChoice(body.kind, IMPORTED_KINDS, 'body.kind')
    ?? validateImportedId(body)
    ?? validateText(body.title, 'body.title', TITLE_MAX)
    ?? validateChoice(body.state, ['backlog', 'done'], 'body.state')
    ?? validateDependencies(body.dependsOn, 'body.dependsOn')
    ?? validateScope(body.scope, 'body.scope')
    ?? validateRequirements(body.requirements, 'body.requirements')
    ?? validateMustHaves(body.mustHaves, 'body.mustHaves')
    ?? validateItemTags(body.tags, 'body.tags')
    ?? validateParent(body)
    ?? (has(body, 'gsd') ? validateGsdRef(body.gsd, 'body.gsd') : undefined)
    ?? (has(body, 'estimate') ? validateEstimate(body.estimate, 'body.estimate') : undefined)
    ?? (has(body, 'summary') ? (body.kind === 'plan' ? validateLiteralTrue(body.summary, 'body.summary') : invalid('body.summary')) : undefined)
    ?? (has(body, 'active') ? (body.kind === 'milestone' ? validateLiteralTrue(body.active, 'body.active') : invalid('body.active')) : undefined)
    ?? (has(body, 'source') ? (body.kind === 'milestone' ? validateSource(body.source, 'body.source') : invalid('body.source')) : undefined),
  'item.created': (body) => checkKeys(body, 'body', ['id', 'kind', 'title', 'scope', 'requirements', 'mustHaves'], ['description', 'estimate', 'tags'])
    ?? validateChoice(body.kind, BOARD_KINDS, 'body.kind')
    ?? validateId(body.id, BOARD_ITEM_ID_PATTERN, 'body.id')
    ?? validateText(body.title, 'body.title', TITLE_MAX)
    ?? validateScope(body.scope, 'body.scope')
    ?? validateRequirements(body.requirements, 'body.requirements')
    ?? validateMustHaves(body.mustHaves, 'body.mustHaves')
    ?? (has(body, 'description') ? validateDescription(body.description, 'body.description') : undefined)
    ?? (has(body, 'estimate') ? validateEstimate(body.estimate, 'body.estimate') : undefined)
    ?? (has(body, 'tags') ? validateItemTags(body.tags, 'body.tags') : undefined),
  'item.updated': (body) => checkKeys(body, 'body', ['id', 'changes'])
    ?? validateItemRef(body)
    ?? validateChanges(body.changes, 'body.changes'),
  'item.estimated': (body) => checkKeys(body, 'body', ['id', 'estimate'])
    ?? validateItemRef(body)
    ?? validateEstimate(body.estimate, 'body.estimate'),
  'item.blocked': (body) => checkKeys(body, 'body', ['id', 'reason'])
    ?? validateItemRef(body)
    ?? validateText(body.reason, 'body.reason', REASON_MAX),
  'item.unblocked': (body) => checkKeys(body, 'body', ['id'])
    ?? validateItemRef(body),
  // G-62-5: an assignment names the item and the member, nothing else; the unassign names only the item.
  'item.assigned': (body) => checkKeys(body, 'body', ['id', 'memberId'])
    ?? validateItemRef(body)
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId'),
  'item.unassigned': (body) => checkKeys(body, 'body', ['id'])
    ?? validateItemRef(body),
  'item.cancelled': (body) => checkKeys(body, 'body', ['id', 'reason'])
    ?? validateItemRef(body)
    ?? validateText(body.reason, 'body.reason', REASON_MAX),
  'item.reopened': (body) => checkKeys(body, 'body', ['id'])
    ?? validateItemRef(body),
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
