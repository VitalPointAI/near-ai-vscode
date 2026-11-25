// Data schemas for the roster family (DESIGN 7.1, 7.3, 7.4, 10.2, 15.1, 15.2; D-07, D-12, D-27). Hub-side: pure, no Yjs; it must not import kinds.ts.
// Owner: 30-04. Phase 31 folds these kinds and may extend them before any store exists. Until then every roster entry is kept and relayed and changes
// no state, but its shape is still closed so a hostile one is refused at verification.
//
// Every roster entry carries rosterPrev, the hash of the roster entry it follows (the first roster entry carries 64 zeros), so authority is a line and
// never needs general state resolution (DESIGN 7.1).
import { isRecord, isSafeIntegerInRange } from '../../team/validate';
import { MAX_FEATURES, isReplicaFeature } from '../features';
import { ROSTER_ROLE_PATTERNS } from '../rosterView';
import { invalidAt, isIsoTime, isSlug } from './shared';
import { countCheck, deviceProblem, hashCheck, hasOwn, keyProblem, lineCheck, oneOf, slugCheck, streamCheck, timeCheck, validateShape } from './project';
import type { Check, Shape } from './project';

const MAX_ROLES = 16;
// The agent seats a member's devices may run (D-12, D-49): seat slugs such as release-guard, each named once.
const MAX_AGENT_SEATS = 16;
const MAX_TOKENS = 32;
// The label words of the Phase 70 gate (src/domain/gate/labels.ts), kept here as plain values so this hub-side file imports nothing from the gate.
const LABEL_TOKEN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
const LABEL_LEVEL = /^[A-Za-z0-9][A-Za-z0-9 ,_-]{0,63}$/;
const HANDLING_FLAGS: readonly string[] = ['local-only', 'no-agent-tools'];
export const CELL_REKEY_REASONS = ['member-removed', 'device-revoked', 'clearance-lowered', 'hub-revoked', 'scheduled'] as const;
export const HANDOVER_REASONS = ['planned', 'lead-lost'] as const;

// A roster.require feature list (POST-01, D-04): 1 to MAX_FEATURES ids of the form name@N, distinct and sorted, so one set has one wire form. Whether
// this build knows an id is not the wire's business: an unknown id is exactly what the feature check stops on.
function featuresProblem(value: unknown, path: string): string | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FEATURES) return invalidAt(path);
  for (let index = 0; index < value.length; index += 1) {
    const id: unknown = value[index];
    if (!isReplicaFeature(id) || (index > 0 && !((value[index - 1] as string) < id))) return invalidAt(`${path}[${index}]`);
  }
  return undefined;
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

function agentSeatsProblem(value: unknown, path: string): string | undefined {
  if (!Array.isArray(value) || value.length > MAX_AGENT_SEATS) return invalidAt(path);
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const seat: unknown = value[index];
    if (!isSlug(seat) || seen.has(seat)) return invalidAt(`${path}[${index}]`);
    seen.add(seat);
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

// The device descriptor check (writer, keys, binding signature and the optional D-41 slot) lives in project.ts as deviceProblem, because the genesis
// lead.device uses it too; every roster kind that names a device (member.admit, device.add, device.rotate, hub.admit) carries the slot the same way.

const nameCheck = lineCheck(120);
const reasonCheck = lineCheck(200);
const epochCheck: Check = (value, path) => (isSafeIntegerInRange(value, 1, Number.MAX_SAFE_INTEGER) ? undefined : invalidAt(path));

// The 20 roster kinds. The key order of a record is the order the checks run in, so the first wrong field is the one named.
// Phase 31 additions (D-49) are optional on the wire so every Phase 30 sample and vector stays valid; the roster fold requires them where D-41, D-44
// and D-49 need them:
// - member.invite forMember: the invite admits another device of an existing member (D-18, Add My Other Machine).
// - member.admit and member.update agentSeats: the agent seats the member's devices may run (D-12).
// - device.add invite: the invite the second machine joined with, so the fold can mark it used (D-17 single use).
// - cell.create epoch and grant, cell.rekey grant: the sha256 of the signed grant object outside the streams (D-44).
// - invite.void: closes an open invite (D-17).
// - roster.require (Phase 33 POST-01, D-04): the features the project requires; written by a lead device, the required set only grows.
// - hub.readmit (Phase 33 D-42): a lead device trusts an admitted hub again with the pin the lead compared; fromCheckpoint names a restored checkpoint.
const SHAPES: Readonly<Record<string, Shape>> = {
  'member.invite': { required: { invite: slugCheck, name: nameCheck, seat: slugCheck, roles: rolesProblem, clearance: clearanceProblem, expiresAt: timeCheck, secretHash: hashCheck, rosterPrev: hashCheck }, optional: { forMember: slugCheck } },
  'member.admit': { required: { member: slugCheck, invite: slugCheck, name: nameCheck, seat: slugCheck, roles: rolesProblem, clearance: clearanceProblem, device: deviceProblem, rosterPrev: hashCheck }, optional: { agentSeats: agentSeatsProblem } },
  'member.update': { required: { member: slugCheck, rosterPrev: hashCheck }, optional: { name: nameCheck, seat: slugCheck, roles: rolesProblem, clearance: clearanceProblem, agentSeats: agentSeatsProblem }, atLeastOneOf: ['name', 'seat', 'roles', 'clearance', 'agentSeats'] },
  'member.remove': { required: { member: slugCheck, rosterPrev: hashCheck }, optional: { reason: reasonCheck } },
  'device.add': { required: { member: slugCheck, device: deviceProblem, rosterPrev: hashCheck }, optional: { invite: slugCheck } },
  'device.rotate': { required: { member: slugCheck, from: hashCheck, device: deviceProblem, rosterPrev: hashCheck } },
  'device.revoke': { required: { member: slugCheck, writer: hashCheck, rosterPrev: hashCheck }, optional: { reason: reasonCheck } },
  'device.quarantine': { required: { writer: hashCheck, stream: streamCheck, seq: countCheck, rosterPrev: hashCheck } },
  'device.release': { required: { writer: hashCheck, stream: streamCheck, seq: countCheck, branch: hashCheck, rosterPrev: hashCheck } },
  'hub.admit': { required: { hub: slugCheck, device: deviceProblem, certPin: hashCheck, ceiling: clearanceProblem, rosterPrev: hashCheck } },
  'hub.grant': { required: { hub: slugCheck, cell: streamCheck, rosterPrev: hashCheck } },
  'hub.revoke': { required: { hub: slugCheck, rosterPrev: hashCheck }, optional: { reason: reasonCheck } },
  'cell.create': { required: { cell: streamCheck, rosterPrev: hashCheck }, optional: { epoch: epochCheck, grant: hashCheck } },
  'cell.rekey': { required: { cell: streamCheck, epoch: epochCheck, reason: oneOf(CELL_REKEY_REASONS), rosterPrev: hashCheck }, optional: { grant: hashCheck } },
  'lead.handover': { required: { to: slugCheck, reason: oneOf(HANDOVER_REASONS), rosterPrev: hashCheck } },
  'roster.choose': { required: { chosen: hashCheck, rosterPrev: hashCheck } },
  'deputy.name': { required: { member: slugCheck, rosterPrev: hashCheck } },
  'invite.void': { required: { invite: slugCheck, rosterPrev: hashCheck } },
  'roster.require': { required: { features: featuresProblem, rosterPrev: hashCheck } },
  'hub.readmit': { required: { hub: slugCheck, certPin: hashCheck, rosterPrev: hashCheck }, optional: { fromCheckpoint: hashCheck } }
};

// Returns a reason, or undefined when the data is valid.
export function validateRosterData(kind: string, data: unknown, path: string): string | undefined {
  return validateShape(SHAPES, kind, data, path);
}
