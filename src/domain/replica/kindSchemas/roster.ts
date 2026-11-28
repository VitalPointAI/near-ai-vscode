// Data schemas for the roster family (DESIGN 7.1, 7.3, 7.4, 10.2, 15.1, 15.2; D-07, D-12, D-27). Hub-side: pure, no Yjs; it must not import kinds.ts.
// Owner: 30-04. Phase 31 folds these kinds and may extend them before any store exists. Until then every roster entry is kept and relayed and changes
// no state, but its shape is still closed so a hostile one is refused at verification.
//
// Every roster entry carries rosterPrev, the hash of the roster entry it follows (the first roster entry carries 64 zeros), so authority is a line and
// never needs general state resolution (DESIGN 7.1).
import { MAX_DELEGATION_DEPTH, MAX_OVERDUE_DAYS, MIN_OVERDUE_DAYS, ORGANIZATION_SETTING_KEYS } from '../../org/modes';
import { isRecord, isSafeIntegerInRange } from '../../team/validate';
import { MAX_FEATURES, isReplicaFeature } from '../features';
import { ROSTER_ROLE_PATTERNS } from '../rosterView';
import { invalidAt, isHash, isIsoTime, isSlug } from './shared';
import { countCheck, deviceProblem, flagCheck, hashCheck, hasOwn, isLine, keyProblem, lineCheck, oneOf, own, slugCheck, streamCheck, timeCheck, validateShape } from './project';
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

// ---- Phase 33.1 shapes (D-43, the owner's answer at 33.1-01's checkpoint, 2026-11-24). Every field below is permanent in every shared log. ----
//
// The roster kinds of positions and postings (D-09 to D-15), each with rosterPrev, person key only:
// - position.create { position, title, section, decides, clearance, keyGroups, acting, dualHat, shift?, observer?, eligibleServes?, establishment? }
//   clearance is the Phase 70 label the position requires (scale, level, compartments, releasability); observer is true or absent (D-27, observers@1,
//   applied by 33.1-18); eligibleServes is 1 to 6 of SERVES_IDS, sorted (D-15, D-29).
// - position.update { position, and at least one position.create field except observer, which is fixed at create (Q9) }
// - position.disestablish { position, reason }
// - authority.delegate { grant, member, scope, kinds, expiresAt, depth, evidence?, status? }: scope is { positions } or { section } or { all: true }; kinds
//   is 1 to 3 of POSTING_KINDS, sorted; depth 0 to MAX_DELEGATION_DEPTH; evidence and status cite the delegate's ServiceCredential (Q2).
// - authority.revoke { grant }
// - posting.order { posting, position, person, evidence, status, kind, start, policy, stages, end?, instrument?, grant? }: person is { member } or a new
//   person { name, did }; end is required for a temporary posting, optional for an acting one, and later than start (Q5); grant is absent when the
//   lead orders on their own authority; stages are the staged key change ids the posting waits for. orderedBy and the authority chain are derived from
//   the signer, never stored (D-19).
// - posting.enrol { posting, device, request, member? }: request is the hash of the person's signed device request; member is the new member id, given
//   only when the order named a new person (Q3).
// - posting.report { posting, evidence?, status? }: the credentials the person presented when reporting (Q4).
// - posting.decide { posting, decision, unable, start?, position? }: unable is the hash of the person's signed unable report, which carries no reason;
//   start comes with defer and only then, position with reassign and only then.
// - posting.return { posting }; posting.end { posting, reason }; posting.cancel { posting, reason }
// - cell.rekey.staged { cell, epoch, reason, stage, posting, replaces, grant?, basis? }: replaces is the epoch it replaces, below epoch.
// - project.mode { mode, settings, policy, reason }: a roster kind despite its name (D-11); mode is an id the fold checks against the mode table (Q7);
//   settings holds any of Phase 41's ORGANIZATION_SETTING_KEYS with their types and ranges (Q8); there is no signers field.
// Shared slots (D-39, Q1): evidence is 1 to 16 credential hashes, sorted, no repeats; status is 1 to 16 { list, hash, validFrom }, sorted by list,
// unique; evidence and status come together. basis { kind, ref? } records why a label was set (D-40): ref is required for judgement and is an id or a
// hash of at most 128 characters, never the matched text.

/** How a person serves (D-21, D-29): the values of ServiceCredential { serves } and of a position's eligibleServes. */
export const SERVES_IDS = ['regular-force', 'reserve-force', 'public-servant', 'contractor', 'allied-military', 'industry'] as const;
export type Serves = typeof SERVES_IDS[number];
export const POSTING_KINDS = ['substantive', 'acting', 'temporary'] as const;
export const POSTING_DECISIONS = ['confirm', 'defer', 'reassign'] as const;
export const BASIS_KINDS = ['source', 'marking', 'guide', 'detector', 'compilation', 'judgement'] as const;
const MAX_EVIDENCE = 16;
const MAX_STATUS = 16;
const MAX_KEY_GROUPS = 64;
const MAX_STAGES = 64;
const MAX_SCOPE_POSITIONS = 64;
const MAX_DECIDES = 16;
// did:webvh:<SCID>:<host, a port written %3A>[:<path segment>]..., at most 255 characters (D-16; Phase 71 (core) verifies the log at enrolment).
const DID_WEBVH = /^did:webvh:[A-Za-z0-9]{16,128}:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?:%3A[0-9]{1,5})?(?::[A-Za-z0-9._~-]{1,64})*$/;
const DECISION_ROLE = /^decision_for:[a-z0-9][a-z0-9-]{0,39}$/;

export const isDidWebvh = (value: unknown): value is string => typeof value === 'string' && value.length <= 255 && DID_WEBVH.test(value);
const didCheck: Check = (value, path) => (isDidWebvh(value) ? undefined : invalidAt(path));

// A list of min to max values, each passing item, strictly ascending by key, so one set has one wire form.
const sortedList = (item: Check, min: number, max: number, key: (value: unknown) => string = (value) => value as string): Check => (value, path) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) return invalidAt(path);
  for (let index = 0; index < value.length; index += 1) {
    const problem = item(value[index], `${path}[${index}]`);
    if (problem !== undefined) return problem;
    if (index > 0 && !(key(value[index - 1]) < key(value[index]))) return invalidAt(`${path}[${index}]`, 'not sorted or repeated');
  }
  return undefined;
};

export const evidenceCheck: Check = sortedList(hashCheck, 1, MAX_EVIDENCE);
function statusItemProblem(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalidAt(path);
  const keys = keyProblem(value, path, ['list', 'hash', 'validFrom']);
  if (keys !== undefined) return keys;
  if (!isLine(value.list, 256)) return invalidAt(`${path}.list`);
  if (!isHash(value.hash)) return invalidAt(`${path}.hash`);
  if (!isIsoTime(value.validFrom)) return invalidAt(`${path}.validFrom`);
  return undefined;
}
export const statusCheck: Check = sortedList(statusItemProblem, 1, MAX_STATUS, (value) => (value as { list: string }).list);

// evidence and status come together, or not at all (D-39).
export function evidencePairProblem(data: Record<string, unknown>, path: string): string | undefined {
  if (hasOwn(data, 'evidence') === hasOwn(data, 'status')) return undefined;
  return invalidAt(`${path}.${hasOwn(data, 'evidence') ? 'status' : 'evidence'}`, 'evidence and status come together');
}

export function basisProblem(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalidAt(path);
  const keys = keyProblem(value, path, ['kind'], ['ref']);
  if (keys !== undefined) return keys;
  if (!(BASIS_KINDS as readonly unknown[]).includes(value.kind)) return invalidAt(`${path}.kind`);
  if (hasOwn(value, 'ref') && !isLine(value.ref, 128)) return invalidAt(`${path}.ref`);
  if (value.kind === 'judgement' && !hasOwn(value, 'ref')) return invalidAt(`${path}.ref`, 'a judgement names its reference');
  return undefined;
}

const decidesCheck: Check = sortedList((value, path) => (typeof value === 'string' && DECISION_ROLE.test(value) ? undefined : invalidAt(path)), 0, MAX_DECIDES);
const keyGroupsCheck: Check = sortedList(streamCheck, 0, MAX_KEY_GROUPS);
const servesCheck: Check = sortedList(oneOf(SERVES_IDS), 1, SERVES_IDS.length);
const postingKindsCheck: Check = sortedList(oneOf(POSTING_KINDS), 1, POSTING_KINDS.length);
const stagesCheck: Check = sortedList(slugCheck, 0, MAX_STAGES);
const observerFlagCheck: Check = (value, path) => (value === true ? undefined : invalidAt(path));
const depthCheck: Check = (value, path) => (isSafeIntegerInRange(value, 0, MAX_DELEGATION_DEPTH) ? undefined : invalidAt(path));
const replacesCheck: Check = (value, path) => (isSafeIntegerInRange(value, 1, Number.MAX_SAFE_INTEGER) ? undefined : invalidAt(path));

// The label a position requires: exactly the four label fields, no handling and no expiry.
function requiredLabelProblem(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalidAt(path);
  return keyProblem(value, path, ['scale', 'level', 'compartments', 'releasability']) ?? clearanceProblem(value, path);
}

function scopeProblem(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalidAt(path);
  const keys = Object.keys(value);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined) return invalidAt(path);
  if (key === 'positions') return sortedList(slugCheck, 1, MAX_SCOPE_POSITIONS)(own(value, key), `${path}.positions`);
  if (key === 'section') return slugCheck(own(value, key), `${path}.section`);
  if (key === 'all') return own(value, key) === true ? undefined : invalidAt(`${path}.all`);
  return invalidAt(`${path}.${key.slice(0, 40)}`, 'field not allowed');
}

function personProblem(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalidAt(path);
  if (hasOwn(value, 'member')) return keyProblem(value, path, ['member']) ?? slugCheck(value.member, `${path}.member`);
  return keyProblem(value, path, ['name', 'did']) ?? nameCheck(value.name, `${path}.name`) ?? didCheck(value.did, `${path}.did`);
}

const BOOLEAN_SETTINGS: readonly string[] = ['acting', 'dualHatting', 'enrolAtReport', 'guests', 'mayDecline', 'temporary'];
function settingsProblem(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalidAt(path);
  const keys = keyProblem(value, path, [], ORGANIZATION_SETTING_KEYS);
  if (keys !== undefined) return keys;
  for (const key of ORGANIZATION_SETTING_KEYS) {
    if (!hasOwn(value, key)) continue;
    const item = own(value, key);
    const ok = BOOLEAN_SETTINGS.includes(key) ? typeof item === 'boolean'
      : key === 'maxDelegationDepth' ? isSafeIntegerInRange(item, 0, MAX_DELEGATION_DEPTH)
        : isSafeIntegerInRange(item, MIN_OVERDUE_DAYS, MAX_OVERDUE_DAYS);
    if (!ok) return invalidAt(`${path}.${key}`);
  }
  return undefined;
}

const POSITION_FIELDS: Record<string, Check> = { title: lineCheck(120), section: slugCheck, decides: decidesCheck, clearance: requiredLabelProblem, keyGroups: keyGroupsCheck, acting: flagCheck, dualHat: flagCheck };
const POSITION_OPTIONAL: Record<string, Check> = { shift: lineCheck(40), eligibleServes: servesCheck, establishment: lineCheck(64) };

function orderRule(data: Record<string, unknown>, path: string): string | undefined {
  const pair = evidencePairProblem(data, path);
  if (pair !== undefined) return pair;
  if (data.kind === 'temporary' && !hasOwn(data, 'end')) return invalidAt(`${path}.end`, 'a temporary posting has an end');
  if (hasOwn(data, 'end') && !(Date.parse(data.end as string) > Date.parse(data.start as string))) return invalidAt(`${path}.end`, 'the end is after the start');
  return undefined;
}

function decideRule(data: Record<string, unknown>, path: string): string | undefined {
  if (hasOwn(data, 'start') !== (data.decision === 'defer')) return invalidAt(`${path}.start`, 'a new start comes with defer and only then');
  if (hasOwn(data, 'position') !== (data.decision === 'reassign')) return invalidAt(`${path}.position`, 'a position comes with reassign and only then');
  return undefined;
}

// Phase 31's declared clearance is a declaration that grants nothing (D-39); it never stands beside the member's did or credential evidence (Q6).
function memberSlotsRule(data: Record<string, unknown>, path: string): string | undefined {
  const pair = evidencePairProblem(data, path);
  if (pair !== undefined) return pair;
  if (hasOwn(data, 'clearance') && (hasOwn(data, 'did') || hasOwn(data, 'evidence'))) return invalidAt(`${path}.clearance`, 'a declaration never stands beside credentials');
  return undefined;
}

// A member.admit carries the declared clearance of Phase 31 or the member's own did, never both (Q6).
function admitRule(data: Record<string, unknown>, path: string): string | undefined {
  if (!hasOwn(data, 'clearance') && !hasOwn(data, 'did')) return invalidAt(`${path}.clearance`, 'missing field');
  return memberSlotsRule(data, path);
}

function stagedRule(data: Record<string, unknown>, path: string): string | undefined {
  return (data.replaces as number) < (data.epoch as number) ? undefined : invalidAt(`${path}.replaces`, 'the epoch it replaces is earlier');
}

// The 34 roster kinds (20 of Phases 30 to 33, 14 of Phase 33.1). The key order of a record is the order the checks run in, so the first wrong field is the one named.
// Phase 31 additions (D-49) are optional on the wire so every Phase 30 sample and vector stays valid; the roster fold requires them where D-41, D-44
// and D-49 need them:
// - member.invite forMember: the invite admits another device of an existing member (D-18, Add My Other Machine).
// - member.admit and member.update agentSeats: the agent seats the member's devices may run (D-12).
// - device.add invite: the invite the second machine joined with, so the fold can mark it used (D-17 single use).
// - cell.create epoch and grant, cell.rekey grant: the sha256 of the signed grant object outside the streams (D-44).
// - invite.void: closes an open invite (D-17).
// - roster.require (Phase 33 POST-01, D-04): the features the project requires; written by a lead device, the required set only grows.
// - hub.readmit (Phase 33 D-42): a lead device trusts an admitted hub again with the pin the lead compared; fromCheckpoint names a restored checkpoint.
const ACCESS_FIELDS = { accessRevision: hashCheck, accessRoot: hashCheck };
const SHAPES: Readonly<Record<string, Shape>> = {
  'member.invite': { required: { invite: slugCheck, name: nameCheck, seat: slugCheck, roles: rolesProblem, clearance: clearanceProblem, expiresAt: timeCheck, secretHash: hashCheck, rosterPrev: hashCheck }, optional: { forMember: slugCheck } },
  // Phase 33.1 (D-16, D-39, Q6): the member's own did and the credential evidence; a declared clearance never stands beside them, and a member.admit
  // carries one or the other.
  'member.admit': {
    required: { member: slugCheck, invite: slugCheck, name: nameCheck, seat: slugCheck, roles: rolesProblem, device: deviceProblem, rosterPrev: hashCheck },
    optional: { clearance: clearanceProblem, agentSeats: agentSeatsProblem, did: didCheck, evidence: evidenceCheck, status: statusCheck }, rule: admitRule
  },
  'member.update': {
    required: { member: slugCheck, rosterPrev: hashCheck },
    optional: { name: nameCheck, seat: slugCheck, roles: rolesProblem, clearance: clearanceProblem, agentSeats: agentSeatsProblem, did: didCheck, evidence: evidenceCheck, status: statusCheck, ...ACCESS_FIELDS },
    atLeastOneOf: ['name', 'seat', 'roles', 'clearance', 'agentSeats', 'did', 'evidence'], rule: memberSlotsRule
  },
  'member.remove': { required: { member: slugCheck, rosterPrev: hashCheck }, optional: { reason: reasonCheck, ...ACCESS_FIELDS } },
  'device.add': { required: { member: slugCheck, device: deviceProblem, rosterPrev: hashCheck }, optional: { invite: slugCheck } },
  'device.rotate': { required: { member: slugCheck, from: hashCheck, device: deviceProblem, rosterPrev: hashCheck }, optional: ACCESS_FIELDS },
  'device.revoke': { required: { member: slugCheck, writer: hashCheck, rosterPrev: hashCheck }, optional: { reason: reasonCheck, ...ACCESS_FIELDS } },
  'device.quarantine': { required: { writer: hashCheck, stream: streamCheck, seq: countCheck, rosterPrev: hashCheck } },
  'device.release': { required: { writer: hashCheck, stream: streamCheck, seq: countCheck, branch: hashCheck, rosterPrev: hashCheck } },
  'hub.admit': { required: { hub: slugCheck, device: deviceProblem, certPin: hashCheck, ceiling: clearanceProblem, rosterPrev: hashCheck } },
  'hub.grant': { required: { hub: slugCheck, cell: streamCheck, rosterPrev: hashCheck } },
  'hub.revoke': { required: { hub: slugCheck, rosterPrev: hashCheck }, optional: { reason: reasonCheck, ...ACCESS_FIELDS } },
  'cell.create': { required: { cell: streamCheck, rosterPrev: hashCheck }, optional: { epoch: epochCheck, grant: hashCheck, ...ACCESS_FIELDS } },
  // basis (D-40) on cell.rekey is accepted only once positions@1 is required (33.1-03 gates it); no access decision reads it.
  'cell.rekey': { required: { cell: streamCheck, epoch: epochCheck, reason: oneOf(CELL_REKEY_REASONS), rosterPrev: hashCheck }, optional: { grant: hashCheck, basis: basisProblem, ...ACCESS_FIELDS } },
  'cell.access.commit': { required: { rosterPrev: hashCheck, ...ACCESS_FIELDS } },
  'lead.handover': { required: { to: slugCheck, reason: oneOf(HANDOVER_REASONS), rosterPrev: hashCheck } },
  'roster.choose': { required: { chosen: hashCheck, rosterPrev: hashCheck } },
  'deputy.name': { required: { member: slugCheck, rosterPrev: hashCheck } },
  'invite.void': { required: { invite: slugCheck, rosterPrev: hashCheck } },
  'roster.require': { required: { features: featuresProblem, rosterPrev: hashCheck } },
  'hub.readmit': { required: { hub: slugCheck, certPin: hashCheck, rosterPrev: hashCheck }, optional: { fromCheckpoint: hashCheck } },
  // Phase 33.1 (D-43): positions and postings, project.mode and the staged key change.
  'position.create': { required: { position: slugCheck, ...POSITION_FIELDS, rosterPrev: hashCheck }, optional: { ...POSITION_OPTIONAL, observer: observerFlagCheck } },
  'position.update': { required: { position: slugCheck, rosterPrev: hashCheck }, optional: { ...POSITION_FIELDS, ...POSITION_OPTIONAL }, atLeastOneOf: [...Object.keys(POSITION_FIELDS), ...Object.keys(POSITION_OPTIONAL)] },
  'position.disestablish': { required: { position: slugCheck, reason: reasonCheck, rosterPrev: hashCheck } },
  'authority.delegate': {
    required: { grant: slugCheck, member: slugCheck, scope: scopeProblem, kinds: postingKindsCheck, expiresAt: timeCheck, depth: depthCheck, rosterPrev: hashCheck },
    optional: { evidence: evidenceCheck, status: statusCheck }, rule: evidencePairProblem
  },
  'authority.revoke': { required: { grant: slugCheck, rosterPrev: hashCheck } },
  'posting.order': {
    required: { posting: slugCheck, position: slugCheck, person: personProblem, evidence: evidenceCheck, status: statusCheck, kind: oneOf(POSTING_KINDS), start: timeCheck, policy: hashCheck, stages: stagesCheck, rosterPrev: hashCheck },
    optional: { end: timeCheck, instrument: lineCheck(128), grant: slugCheck }, rule: orderRule
  },
  'posting.enrol': { required: { posting: slugCheck, device: deviceProblem, request: hashCheck, rosterPrev: hashCheck }, optional: { member: slugCheck } },
  'posting.report': { required: { posting: slugCheck, rosterPrev: hashCheck }, optional: { evidence: evidenceCheck, status: statusCheck }, rule: evidencePairProblem },
  'posting.decide': { required: { posting: slugCheck, decision: oneOf(POSTING_DECISIONS), unable: hashCheck, rosterPrev: hashCheck }, optional: { start: timeCheck, position: slugCheck }, rule: decideRule },
  'posting.return': { required: { posting: slugCheck, rosterPrev: hashCheck } },
  'posting.end': { required: { posting: slugCheck, reason: reasonCheck, rosterPrev: hashCheck } },
  'posting.cancel': { required: { posting: slugCheck, reason: reasonCheck, rosterPrev: hashCheck } },
  'cell.rekey.staged': {
    required: { cell: streamCheck, epoch: epochCheck, reason: oneOf(CELL_REKEY_REASONS), stage: slugCheck, posting: slugCheck, replaces: replacesCheck, rosterPrev: hashCheck },
    optional: { grant: hashCheck, basis: basisProblem }, rule: stagedRule
  },
  'project.mode': { required: { mode: slugCheck, settings: settingsProblem, policy: hashCheck, reason: reasonCheck, rosterPrev: hashCheck } }
};


// Returns a reason, or undefined when the data is valid.
export function validateRosterData(kind: string, data: unknown, path: string): string | undefined {
  return validateShape(SHAPES, kind, data, path);
}
