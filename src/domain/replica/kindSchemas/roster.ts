// Data schemas for the roster family (DESIGN 7.1, 7.3, 7.4, 10.2, 15.1, 15.2; D-07, D-12, D-27). Hub-side: pure, no Yjs; it must not import kinds.ts.
// Owner: 30-04. Phase 31 folds these kinds and may extend them before any store exists. Until then every roster entry is kept and relayed and changes
// no state, but its shape is still closed so a hostile one is refused at verification.
//
// Every roster entry carries rosterPrev, the hash of the roster entry it follows (the first roster entry carries 64 zeros), so authority is a line and
// never needs general state resolution (DESIGN 7.1).
import { isRecord, isSafeIntegerInRange } from '../../team/validate';
import { writerIdOf } from '../entry';
import { ROSTER_ROLE_PATTERNS } from '../rosterView';
import { invalidAt, isBase64urlBytes, isHash, isIsoTime, isSlug } from './shared';
import { hasOwn, isCount, isLine, isStreamHex, keyProblem, own } from './project';

const ED25519_PUBLIC_BYTES = 32;
const X25519_PUBLIC_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const MAX_ROLES = 16;
const MAX_TOKENS = 32;
// The label words of the Phase 70 gate (src/domain/gate/labels.ts), kept here as plain values so this hub-side file imports nothing from the gate.
const LABEL_TOKEN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
const LABEL_LEVEL = /^[A-Za-z0-9][A-Za-z0-9 ,_-]{0,63}$/;
const HANDLING_FLAGS: readonly string[] = ['local-only', 'no-agent-tools'];
export const CELL_REKEY_REASONS = ['member-removed', 'device-revoked', 'clearance-lowered', 'hub-revoked', 'scheduled'] as const;
export const HANDOVER_REASONS = ['planned', 'lead-lost'] as const;

function isExactBytes(value: unknown, bytes: number): value is string {
  return isBase64urlBytes(value, bytes) && Buffer.from(value, 'base64url').length === bytes;
}

// One role word of the roster (ROSTER_ROLE_PATTERNS), nothing else.
function isRole(value: unknown): value is string {
  return typeof value === 'string' && ROSTER_ROLE_PATTERNS.some((entry) => entry.pattern.test(value));
}

function rolesProblem(value: unknown, path: string): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_ROLES) return invalidAt(path);
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const role: unknown = value[index];
    if (!isRole(role) || seen.has(role)) return invalidAt(`${path}[${index}]`);
    seen.add(role);
  }
  return undefined;
}

function tokensProblem(value: unknown, path: string, allowed?: readonly string[]): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_TOKENS) return invalidAt(path);
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const token: unknown = value[index];
    if (typeof token !== 'string' || !(allowed === undefined ? LABEL_TOKEN.test(token) : allowed.includes(token)) || seen.has(token)) return invalidAt(`${path}[${index}]`);
    seen.add(token);
  }
  return undefined;
}

// A person's clearance as the lead declares it (DESIGN 7.2): the Phase 70 label object as a closed-key check. Whether the scale and level exist is the
// label map's business at fold time, not the wire's.
export function clearanceProblem(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalidAt(path);
  const keys = keyProblem(value, path, ['scale', 'level', 'compartments', 'releasability'], ['handling', 'expiresAt']);
  if (keys !== undefined) return keys;
  if (!isSlug(value.scale)) return invalidAt(`${path}.scale`);
  if (typeof value.level !== 'string' || !LABEL_LEVEL.test(value.level)) return invalidAt(`${path}.level`);
  const compartments = tokensProblem(value.compartments, `${path}.compartments`);
  if (compartments !== undefined) return compartments;
  const releasability = tokensProblem(value.releasability, `${path}.releasability`);
  if (releasability !== undefined) return releasability;
  if (hasOwn(value, 'handling')) {
    const handling = tokensProblem(value.handling, `${path}.handling`, HANDLING_FLAGS);
    if (handling !== undefined) return handling;
  }
  if (hasOwn(value, 'expiresAt') && !isIsoTime(value.expiresAt)) return invalidAt(`${path}.expiresAt`);
  return undefined;
}

// A device as the roster names it (DESIGN 7.4): the Ed25519 key it signs with, the X25519 key it opens wraps with, and the Ed25519 signature that binds them.
function deviceProblem(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalidAt(path);
  const keys = keyProblem(value, path, ['writer', 'publicKey', 'x25519', 'x25519Sig']);
  if (keys !== undefined) return keys;
  if (!isHash(value.writer)) return invalidAt(`${path}.writer`);
  if (!isExactBytes(value.publicKey, ED25519_PUBLIC_BYTES)) return invalidAt(`${path}.publicKey`);
  if (!isExactBytes(value.x25519, X25519_PUBLIC_BYTES)) return invalidAt(`${path}.x25519`);
  if (!isExactBytes(value.x25519Sig, ED25519_SIGNATURE_BYTES)) return invalidAt(`${path}.x25519Sig`);
  // The writer id of a device is the hash of its signing key, so a descriptor that names another writer is wrong on its face.
  if (value.writer !== writerIdOf(value.publicKey)) return invalidAt(`${path}.writer`, 'not the hash of the key');
  return undefined;
}

type Check = (value: unknown, path: string) => string | undefined;
const slugCheck: Check = (value, path) => (isSlug(value) ? undefined : invalidAt(path));
const hashCheck: Check = (value, path) => (isHash(value) ? undefined : invalidAt(path));
const nameCheck: Check = (value, path) => (isLine(value, 120) ? undefined : invalidAt(path));
const reasonCheck: Check = (value, path) => (isLine(value, 200) ? undefined : invalidAt(path));
const streamCheck: Check = (value, path) => (isStreamHex(value) ? undefined : invalidAt(path));
const countCheck: Check = (value, path) => (isCount(value) ? undefined : invalidAt(path));
const timeCheck: Check = (value, path) => (isIsoTime(value) ? undefined : invalidAt(path));
const epochCheck: Check = (value, path) => (isSafeIntegerInRange(value, 1, Number.MAX_SAFE_INTEGER) ? undefined : invalidAt(path));
const oneOf = (words: readonly string[]): Check => (value, path) => (typeof value === 'string' && words.includes(value) ? undefined : invalidAt(path));

interface Shape { required: Record<string, Check>; optional?: Record<string, Check>; atLeastOneOf?: readonly string[] }

// The 17 roster kinds. The key order of a record is the order the checks run in, so the first wrong field is the one named.
const SHAPES: Readonly<Record<string, Shape>> = {
  'member.invite': { required: { invite: slugCheck, name: nameCheck, seat: slugCheck, roles: rolesProblem, clearance: clearanceProblem, expiresAt: timeCheck, secretHash: hashCheck, rosterPrev: hashCheck } },
  'member.admit': { required: { member: slugCheck, invite: slugCheck, name: nameCheck, seat: slugCheck, roles: rolesProblem, clearance: clearanceProblem, device: deviceProblem, rosterPrev: hashCheck } },
  'member.update': { required: { member: slugCheck, rosterPrev: hashCheck }, optional: { name: nameCheck, seat: slugCheck, roles: rolesProblem, clearance: clearanceProblem }, atLeastOneOf: ['name', 'seat', 'roles', 'clearance'] },
  'member.remove': { required: { member: slugCheck, rosterPrev: hashCheck }, optional: { reason: reasonCheck } },
  'device.add': { required: { member: slugCheck, device: deviceProblem, rosterPrev: hashCheck } },
  'device.rotate': { required: { member: slugCheck, from: hashCheck, device: deviceProblem, rosterPrev: hashCheck } },
  'device.revoke': { required: { member: slugCheck, writer: hashCheck, rosterPrev: hashCheck }, optional: { reason: reasonCheck } },
  'device.quarantine': { required: { writer: hashCheck, stream: streamCheck, seq: countCheck, rosterPrev: hashCheck } },
  'device.release': { required: { writer: hashCheck, stream: streamCheck, seq: countCheck, branch: hashCheck, rosterPrev: hashCheck } },
  'hub.admit': { required: { hub: slugCheck, device: deviceProblem, certPin: hashCheck, ceiling: clearanceProblem, rosterPrev: hashCheck } },
  'hub.grant': { required: { hub: slugCheck, cell: streamCheck, rosterPrev: hashCheck } },
  'hub.revoke': { required: { hub: slugCheck, rosterPrev: hashCheck }, optional: { reason: reasonCheck } },
  'cell.create': { required: { cell: streamCheck, rosterPrev: hashCheck } },
  'cell.rekey': { required: { cell: streamCheck, epoch: epochCheck, reason: oneOf(CELL_REKEY_REASONS), rosterPrev: hashCheck } },
  'lead.handover': { required: { to: slugCheck, reason: oneOf(HANDOVER_REASONS), rosterPrev: hashCheck } },
  'roster.choose': { required: { chosen: hashCheck, rosterPrev: hashCheck } },
  'deputy.name': { required: { member: slugCheck, rosterPrev: hashCheck } }
};

// Returns a reason, or undefined when the data is valid.
export function validateRosterData(kind: string, data: unknown, path: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(SHAPES, kind)) return invalidAt(`${path}.kind`);
  if (!isRecord(data)) return invalidAt(path);
  const shape = SHAPES[kind];
  const required = Object.keys(shape.required);
  const optional = Object.keys(shape.optional ?? {});
  const keys = keyProblem(data, path, required, optional);
  if (keys !== undefined) return keys;
  for (const key of required) {
    const problem = shape.required[key](own(data, key), `${path}.${key}`);
    if (problem !== undefined) return problem;
  }
  for (const key of optional) {
    if (!hasOwn(data, key)) continue;
    const problem = (shape.optional as Record<string, Check>)[key](own(data, key), `${path}.${key}`);
    if (problem !== undefined) return problem;
  }
  if (shape.atLeastOneOf !== undefined && !shape.atLeastOneOf.some((key) => hasOwn(data, key))) return invalidAt(path, 'nothing to change');
  return undefined;
}
