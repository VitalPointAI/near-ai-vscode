// Materialiser for the team event log: the full D-09 validation pipeline and the state transitions for the ten Phase 60 event types.
// Every client runs exactly this code on every committed entry, so it is pure and deterministic: no I/O, no clock, no secret scanning
// (acceptance must not depend on detector versions), and ordering comes only from the order entries are applied in (D-03).
import { createHash } from 'node:crypto';
import { canonicalBytes, canonicalize, eventPath, fingerprintOf, isStrictBase64url, snapshotPath, verifyEventSignature, verifySignature } from './canonical';
import { actionForEvent, decideTeamAction } from './permissions';
import { DEFAULT_WIP_LIMIT, applyPolicyChanges, defaultTeamPolicy, validatePolicy } from './policy';
import { AVAILABILITIES, ROLES, TEAM_REJECTION_REASONS } from './types';
import type { Availability, CommittedEvent, DeviceKey, DeviceRef, EntryVerdict, GenesisAnchor, ImplementedTeamEvent, JsonObject, Materializer, Member, Rejection, Role, SnapshotRef, TeamEvent, TeamPolicy, TeamState, WorkingHours } from './types';
import { EMAIL_HASH_PATTERN, EVENT_ID_PATTERN, FINGERPRINT_PATTERN, MEMBER_ID_PATTERN, SNAPSHOT_PATH_PATTERN, isRecord, parseEventFile } from './validate';

export const MAX_LAMPORT_JUMP = 1000;
const R = TEAM_REJECTION_REASONS;

type Fields = Record<string, unknown>;

export function createState(anchor: GenesisAnchor): TeamState {
  return {
    team: { id: anchor.teamId, name: '', ownerId: '', policy: defaultTeamPolicy() },
    members: new Map(), deviceIndex: new Map(),
    items: new Map(), claims: new Map(), leases: new Map(), allocations: [],
    budget: { periodNanoUsd: 0, period: '' }, integrationQueue: [], stopped: false,
    head: { eventId: '', lamport: 0 }, highLamport: 0, accepted: 0, seenEventIds: new Set(),
    rejected: [], snapshots: [], genesis: { teamId: anchor.teamId, eventId: anchor.eventId, ownerDevice: { ...anchor.ownerDevice } }
  };
}

// A candidate check must never alias the live state, so the copy is deep. TeamState holds only plain data, Maps and Sets.
export function cloneState(state: TeamState): TeamState {
  return structuredClone(state);
}

function reject(state: TeamState, eventId: string, reason: string): EntryVerdict {
  const rejection: Rejection = { eventId, reason };
  state.rejected.push(rejection);
  return { accepted: false, rejection };
}

function refuse(state: TeamState, eventId: string): EntryVerdict {
  state.refused = R.logRefused;
  return reject(state, eventId, R.logRefused);
}

function accept(state: TeamState, event: ImplementedTeamEvent, authorRole?: Role): EntryVerdict {
  state.head = { eventId: event.id, lamport: event.lamport };
  state.highLamport = event.lamport;
  state.accepted += 1;
  state.seenEventIds.add(event.id);
  return authorRole === undefined ? { accepted: true, event } : { accepted: true, event, authorRole };
}

function sameDevice(left: DeviceRef, right: DeviceRef): boolean {
  return left.fingerprint === right.fingerprint && left.publicKey === right.publicKey;
}

function bindOwner(state: TeamState, event: TeamEvent<'team.created'>): void {
  const body = event.body;
  state.team = { id: state.team.id, name: body.name, ownerId: body.ownerId, policy: structuredClone(body.policy) };
  if (body.near) state.team.near = { organizationId: body.near.organizationId, workspaceId: body.near.workspaceId };
  const owner: Member = {
    id: body.ownerId, name: body.ownerName, emailHashes: [...body.ownerEmailHashes], role: 'owner',
    devices: [{ fingerprint: body.ownerDevice.fingerprint, publicKey: body.ownerDevice.publicKey, addedBy: body.ownerId, addedEvent: event.id }],
    skills: [], availability: 'available', wipLimit: DEFAULT_WIP_LIMIT, joinedAt: event.at, joinedEvent: event.id
  };
  state.members.set(owner.id, owner);
  state.deviceIndex.set(body.ownerDevice.fingerprint, owner.id);
}

// The first event must be the team.created named by the anchor and signed by the anchored owner key (D-10).
function applyGenesis(state: TeamState, entry: CommittedEvent): EntryVerdict {
  const anchor = state.genesis;
  const parsed = parseEventFile(entry);
  if (!parsed.ok) return refuse(state, parsed.rejection.eventId);
  const event = parsed.event;
  if (event.type !== 'team.created' || event.id !== anchor.eventId) return refuse(state, event.id);
  const body = event.body;
  if (event.teamId !== anchor.teamId || event.author !== body.ownerId || event.device !== anchor.ownerDevice.fingerprint) return refuse(state, event.id);
  if (!sameDevice(body.ownerDevice, anchor.ownerDevice)) return refuse(state, event.id);
  if (!verifyEventSignature(event, anchor.ownerDevice.publicKey)) return refuse(state, event.id);
  bindOwner(state, event);
  return accept(state, event, state.members.get(body.ownerId)?.role);
}

// D-09 step 3 (positional, D-11): the device must be bound to the author by an earlier accepted roster event and neither revoked nor removed yet.
function boundKey(state: TeamState, event: ImplementedTeamEvent): DeviceKey | string {
  const memberId = state.deviceIndex.get(event.device);
  if (memberId === undefined || memberId !== event.author) return R.unboundDevice;
  const member = state.members.get(memberId);
  const key = member?.devices.find((device) => device.fingerprint === event.device);
  if (member === undefined || key === undefined) return R.unboundDevice;
  if (key.revokedEvent !== undefined) return R.revokedDevice;
  if (member.removedEvent !== undefined) return R.removedAuthor;
  return key;
}

function isOwnerJoin(state: TeamState, event: TeamEvent<'member.joined'>): boolean {
  const owner = state.members.get(state.team.ownerId);
  if (state.accepted !== 1 || owner === undefined || event.author !== owner.id) return false;
  const body = event.body;
  return body.memberId === owner.id && body.role === 'owner' && sameDevice(body.device, state.genesis.ownerDevice);
}

// D-09 step 6: the same decideTeamAction the write side calls, evaluated against the state at this log position.
function authorisationProblem(state: TeamState, event: ImplementedTeamEvent): string | undefined {
  if (event.type === 'team.created') return R.genesisOnly;
  if (event.type === 'member.joined') return isOwnerJoin(state, event) ? undefined : `${R.notPermitted}: ${R.ownerJoinOnly}`;
  const action = actionForEvent(event);
  if (action === undefined) return R.notPermitted;
  const decision = decideTeamAction(state, event.author, action);
  return decision.allowed ? undefined : `${R.notPermitted}: ${decision.reason ?? ''}`;
}

function lookupMember(state: TeamState, memberId: string): Member | string {
  const member = state.members.get(memberId);
  if (member === undefined) return R.memberMissing;
  return member.removedEvent === undefined ? member : R.memberRemoved;
}

// D-09 step 7: every entity the event names must exist at this position.
function referenceProblem(state: TeamState, event: ImplementedTeamEvent): string | undefined {
  switch (event.type) {
    case 'member.role-changed':
    case 'member.removed':
    case 'member.skills': {
      const member = lookupMember(state, event.body.memberId);
      return typeof member === 'string' ? member : undefined;
    }
    case 'device.added': {
      const member = lookupMember(state, event.body.memberId);
      if (typeof member === 'string') return member;
      return state.deviceIndex.has(event.body.device.fingerprint) ? R.deviceTaken : undefined;
    }
    case 'device.revoked': {
      const member = lookupMember(state, event.body.memberId);
      if (typeof member === 'string') return member;
      const key = state.deviceIndex.get(event.body.fingerprint) === member.id
        ? member.devices.find((device) => device.fingerprint === event.body.fingerprint) : undefined;
      if (key === undefined) return R.deviceNotBound;
      if (key.revokedEvent !== undefined) return R.deviceRevoked;
      return member.devices.filter((device) => device.revokedEvent === undefined).length === 1 ? R.lastDevice : undefined;
    }
    case 'snapshot.written': {
      // The hash is computed before the transition and only when such an event arrives, about once per 500 events.
      const body = event.body;
      const matches = body.coversThrough === state.head.eventId && body.lamport === state.head.lamport
        && body.path === snapshotPath(body.lamport) && body.stateHash === stateHash(state);
      return matches ? undefined : R.snapshotMismatch;
    }
    default:
      return undefined;
  }
}

function memberOf(state: TeamState, memberId: string): Member {
  const member = state.members.get(memberId);
  if (member === undefined) throw new Error(`Member ${memberId} vanished between the reference check and the transition.`);
  return member;
}

function applyTransition(state: TeamState, event: ImplementedTeamEvent): void {
  switch (event.type) {
    case 'team.created':
      return;
    case 'member.joined': {
      const owner = memberOf(state, event.body.memberId);
      owner.name = event.body.name;
      owner.emailHashes = [...event.body.emailHashes];
      owner.joinedEvent = event.id;
      owner.joinedAt = event.at;
      return;
    }
    case 'member.role-changed':
      memberOf(state, event.body.memberId).role = event.body.role;
      return;
    case 'member.removed': {
      const member = memberOf(state, event.body.memberId);
      member.removedEvent = event.id;
      member.removedAt = event.at;
      return;
    }
    case 'device.added':
      memberOf(state, event.body.memberId).devices.push({
        fingerprint: event.body.device.fingerprint, publicKey: event.body.device.publicKey, addedBy: event.author, addedEvent: event.id
      });
      state.deviceIndex.set(event.body.device.fingerprint, event.body.memberId);
      return;
    case 'device.revoked': {
      const key = memberOf(state, event.body.memberId).devices.find((device) => device.fingerprint === event.body.fingerprint);
      if (key === undefined) throw new Error(`Device ${event.body.fingerprint} vanished between the reference check and the transition.`);
      key.revokedEvent = event.id;
      key.revokedBy = event.author;
      return;
    }
    case 'member.availability': {
      const member = memberOf(state, event.author);
      member.availability = event.body.availability;
      // An update without hours keeps the hours already on record.
      if (event.body.workingHours !== undefined) member.workingHours = structuredClone(event.body.workingHours);
      return;
    }
    case 'member.skills':
      memberOf(state, event.body.memberId).skills = [...event.body.skills];
      return;
    case 'policy.changed':
      state.team.policy = applyPolicyChanges(state.team.policy, event.body.changes);
      return;
    case 'snapshot.written':
      state.snapshots.push({ path: event.body.path, coversThrough: event.body.coversThrough, lamport: event.body.lamport, stateHash: event.body.stateHash, eventId: event.id });
      return;
  }
}

export function applyEntry(state: TeamState, entry: CommittedEvent): EntryVerdict {
  if (state.refused !== undefined) return { accepted: false, rejection: { eventId: entry.path, reason: state.refused } };
  if (entry.kind === 'genesis-copy') return { accepted: true };
  if (entry.kind === 'anomaly') return reject(state, entry.path, entry.anomaly ?? R.unexpectedPath);
  // A snapshot file only counts when an accepted snapshot.written names it; the file adds nothing to the state.
  if (entry.kind === 'snapshot') return state.snapshots.some((ref) => ref.path === entry.path) ? { accepted: true } : reject(state, entry.path, R.snapshotOrphan);
  // Step 1 (schema). The very first event decides whether this log is ours at all (D-10).
  if (state.accepted === 0) return applyGenesis(state, entry);
  const parsed = parseEventFile(entry);
  if (!parsed.ok) {
    state.rejected.push(parsed.rejection);
    return { accepted: false, rejection: parsed.rejection };
  }
  const event = parsed.event;
  // Step 2: team and replay.
  if (event.teamId !== state.team.id) return reject(state, event.id, R.wrongTeam);
  if (state.seenEventIds.has(event.id)) return reject(state, event.id, R.duplicate);
  // Steps 3 and 4: the bound device, then its signature.
  const key = boundKey(state, event);
  if (typeof key === 'string') return reject(state, event.id, key);
  if (!verifyEventSignature(event, key.publicKey)) return reject(state, event.id, R.badSignature);
  // Step 5: Lamport counts accepted events only, so a rejected event can never poison the high-water mark.
  if (event.lamport <= state.highLamport) return reject(state, event.id, R.lamportNotGreater);
  if (event.lamport > state.highLamport + MAX_LAMPORT_JUMP) return reject(state, event.id, R.lamportJump);
  // Steps 6 and 7: permission at this position, then the entities the event names. Nothing is mutated before all checks pass.
  const denied = authorisationProblem(state, event);
  if (denied !== undefined) return reject(state, event.id, denied);
  const missing = referenceProblem(state, event);
  if (missing !== undefined) return reject(state, event.id, missing);
  // The role is read before the transition, so an event that changes its own author's role is still recorded under the role it was written with.
  const authorRole = state.members.get(event.author)?.role;
  applyTransition(state, event);
  return accept(state, event, authorRole);
}

export function reduce(entries: CommittedEvent[], anchor: GenesisAnchor): TeamState {
  const state = createState(anchor);
  for (const entry of entries) applyEntry(state, entry);
  return state;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPlain(value: unknown): unknown {
  if (value instanceof Map) return [...value.entries()].sort(([left], [right]) => compareText(String(left), String(right))).map(([key, item]) => [key, toPlain(item)]);
  if (value instanceof Set) return [...value].map(toPlain).sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
  if (Array.isArray(value)) return value.map(toPlain);
  if (isRecord(value)) {
    const plain: Fields = {};
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item !== undefined) plain[key] = toPlain(item);
    }
    return plain;
  }
  return value;
}

// D-27: one fixed shape, so equal states always give equal text. Members are sorted by id with devices in addition order, the device
// index and seen ids are sorted, and Maps that Phase 60 leaves empty are written as key-sorted pair arrays for the phases that fill them.
function plainState(state: TeamState): Fields {
  const plain: Fields = {
    team: toPlain(state.team),
    members: [...state.members.values()].sort((left, right) => compareText(left.id, right.id)).map(toPlain),
    deviceIndex: [...state.deviceIndex.entries()].sort(([left], [right]) => compareText(left, right)).map(([fingerprint, memberId]) => [fingerprint, memberId]),
    items: toPlain(state.items), claims: toPlain(state.claims), leases: toPlain(state.leases), allocations: toPlain(state.allocations),
    budget: toPlain(state.budget), integrationQueue: toPlain(state.integrationQueue), stopped: state.stopped,
    head: toPlain(state.head), highLamport: state.highLamport, accepted: state.accepted,
    seenEventIds: [...state.seenEventIds].sort(compareText),
    rejected: toPlain(state.rejected), snapshots: toPlain(state.snapshots), genesis: toPlain(state.genesis)
  };
  if (state.refused !== undefined) plain.refused = state.refused;
  return plain;
}

// Byte-stable text for hashing and comparison.
export function serialiseState(state: TeamState): string {
  return canonicalize(plainState(state));
}

export function stateHash(state: TeamState): string {
  return createHash('sha256').update(serialiseState(state)).digest('hex');
}

// ---- Snapshots (D-27) -------------------------------------------------------------------------------------------------------------

export interface SnapshotBody { v: 1; kind: 'snapshot'; teamId: string; coversThrough: string; lamport: number; stateHash: string; state: JsonObject }
export interface SnapshotFile extends SnapshotBody { author: string; device: string; sig: string }
export type ParsedSnapshot = { ok: true; state: TeamState; provisional: true; file: SnapshotFile } | { ok: false; reason: string };

export const SNAPSHOT_REASONS = {
  malformed: 'malformed snapshot', notCanonical: 'snapshot file is not canonical', tooLarge: 'snapshot is larger than 8 MB',
  invalid: 'invalid snapshot', wrongTeam: 'snapshot belongs to another team', notManager: 'snapshot author is not an owner or lead'
} as const;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_KEYS = ['v', 'kind', 'teamId', 'coversThrough', 'lamport', 'stateHash', 'state', 'author', 'device', 'sig'];
const STATE_KEYS = ['team', 'members', 'deviceIndex', 'items', 'claims', 'leases', 'allocations', 'budget', 'integrationQueue', 'stopped', 'head', 'highLamport', 'accepted', 'seenEventIds', 'rejected', 'snapshots', 'genesis'];
const MAX_TEXT = 200;

// The state of the log as of its head. Signing it and writing the snapshot.written event belong to the writer (Plan 60-07).
export function snapshotBody(state: TeamState): SnapshotBody {
  return {
    v: 1, kind: 'snapshot', teamId: state.team.id, coversThrough: state.head.eventId, lamport: state.head.lamport,
    stateHash: stateHash(state), state: JSON.parse(serialiseState(state)) as JsonObject
  };
}

class SnapshotShapeError extends Error {
  public constructor(path: string) {
    super(`${SNAPSHOT_REASONS.invalid}: ${path}`);
    this.name = 'SnapshotShapeError';
  }
}

function bad(path: string): never {
  throw new SnapshotShapeError(path);
}

function plainRecord(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Fields {
  if (!isRecord(value)) return bad(path);
  const present = Object.keys(value);
  if (!required.every((key) => present.includes(key)) || !present.every((key) => required.includes(key) || optional.includes(key))) return bad(path);
  return value;
}

function shortText(value: unknown, path: string, minLength = 1): string {
  return typeof value === 'string' && value.length >= minLength && value.length <= MAX_TEXT ? value : bad(path);
}

function patterned(value: unknown, path: string, pattern: RegExp): string {
  return typeof value === 'string' && pattern.test(value) ? value : bad(path);
}

function integer(value: unknown, path: string, min = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : bad(path);
}

function items<T>(value: unknown, path: string, each: (item: unknown, itemPath: string) => T): T[] {
  if (!Array.isArray(value)) return bad(path);
  return value.map((item: unknown, index) => each(item, `${path}[${index}]`));
}

function choice<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined ? bad(path) : found;
}

function emptyList(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length !== 0) bad(path);
}

function parseDeviceKey(value: unknown, path: string): DeviceKey {
  const raw = plainRecord(value, path, ['fingerprint', 'publicKey', 'addedBy', 'addedEvent'], ['revokedEvent', 'revokedBy']);
  const publicKey = shortText(raw.publicKey, `${path}.publicKey`);
  const fingerprint = patterned(raw.fingerprint, `${path}.fingerprint`, FINGERPRINT_PATTERN);
  if (!isStrictBase64url(publicKey, 32) || fingerprint !== fingerprintOf(Buffer.from(publicKey, 'base64url'))) bad(`${path}.publicKey`);
  const key: DeviceKey = { fingerprint, publicKey, addedBy: shortText(raw.addedBy, `${path}.addedBy`), addedEvent: shortText(raw.addedEvent, `${path}.addedEvent`) };
  if (raw.revokedEvent !== undefined) key.revokedEvent = shortText(raw.revokedEvent, `${path}.revokedEvent`);
  if (raw.revokedBy !== undefined) key.revokedBy = shortText(raw.revokedBy, `${path}.revokedBy`);
  return key;
}

function parseWorkingHours(value: unknown, path: string): WorkingHours {
  const raw = plainRecord(value, path, ['tz', 'days', 'start', 'end']);
  return { tz: shortText(raw.tz, `${path}.tz`), days: items(raw.days, `${path}.days`, (day, dayPath) => integer(day, dayPath)), start: shortText(raw.start, `${path}.start`), end: shortText(raw.end, `${path}.end`) };
}

function parseMember(value: unknown, path: string): Member {
  const raw = plainRecord(value, path, ['id', 'name', 'emailHashes', 'role', 'devices', 'skills', 'availability', 'wipLimit', 'joinedAt', 'joinedEvent'],
    ['workingHours', 'nearApiKeyId', 'removedAt', 'removedEvent']);
  const devices = items(raw.devices, `${path}.devices`, parseDeviceKey);
  if (devices.length === 0) bad(`${path}.devices`);
  const member: Member = {
    id: patterned(raw.id, `${path}.id`, MEMBER_ID_PATTERN), name: shortText(raw.name, `${path}.name`),
    emailHashes: items(raw.emailHashes, `${path}.emailHashes`, (hash, hashPath) => patterned(hash, hashPath, EMAIL_HASH_PATTERN)),
    role: choice<Role>(raw.role, `${path}.role`, ROLES), devices,
    skills: items(raw.skills, `${path}.skills`, (skill, skillPath) => shortText(skill, skillPath)),
    availability: choice<Availability>(raw.availability, `${path}.availability`, AVAILABILITIES), wipLimit: integer(raw.wipLimit, `${path}.wipLimit`),
    joinedAt: shortText(raw.joinedAt, `${path}.joinedAt`), joinedEvent: shortText(raw.joinedEvent, `${path}.joinedEvent`)
  };
  if (raw.workingHours !== undefined) member.workingHours = parseWorkingHours(raw.workingHours, `${path}.workingHours`);
  if (raw.nearApiKeyId !== undefined) member.nearApiKeyId = shortText(raw.nearApiKeyId, `${path}.nearApiKeyId`);
  if (raw.removedAt !== undefined) member.removedAt = shortText(raw.removedAt, `${path}.removedAt`);
  if (raw.removedEvent !== undefined) member.removedEvent = shortText(raw.removedEvent, `${path}.removedEvent`);
  return member;
}

function parseRejection(value: unknown, path: string): Rejection {
  const raw = plainRecord(value, path, ['eventId', 'reason']);
  return { eventId: shortText(raw.eventId, `${path}.eventId`), reason: shortText(raw.reason, `${path}.reason`) };
}

function parseSnapshotRef(value: unknown, path: string): SnapshotRef {
  const raw = plainRecord(value, path, ['path', 'coversThrough', 'lamport', 'stateHash', 'eventId']);
  return {
    path: patterned(raw.path, `${path}.path`, SNAPSHOT_PATH_PATTERN), coversThrough: patterned(raw.coversThrough, `${path}.coversThrough`, EVENT_ID_PATTERN),
    lamport: integer(raw.lamport, `${path}.lamport`, 1), stateHash: patterned(raw.stateHash, `${path}.stateHash`, /^[0-9a-f]{64}$/),
    eventId: patterned(raw.eventId, `${path}.eventId`, EVENT_ID_PATTERN)
  };
}

function parsePair(value: unknown, path: string): [string, string] {
  if (!Array.isArray(value) || value.length !== 2) return bad(path);
  return [patterned(value[0], `${path}[0]`, FINGERPRINT_PATTERN), patterned(value[1], `${path}[1]`, MEMBER_ID_PATTERN)];
}

function parseTeam(value: unknown, anchor: GenesisAnchor): TeamState['team'] {
  const raw = plainRecord(value, 'team', ['id', 'name', 'ownerId', 'policy'], ['near']);
  if (raw.id !== anchor.teamId) bad('team.id');
  if (validatePolicy(raw.policy, 'team.policy') !== undefined) bad('team.policy');
  const team: TeamState['team'] = {
    id: anchor.teamId, name: shortText(raw.name, 'team.name'), ownerId: patterned(raw.ownerId, 'team.ownerId', MEMBER_ID_PATTERN),
    policy: structuredClone(raw.policy) as TeamPolicy
  };
  if (raw.near !== undefined) {
    const near = plainRecord(raw.near, 'team.near', ['organizationId', 'workspaceId']);
    team.near = { organizationId: shortText(near.organizationId, 'team.near.organizationId'), workspaceId: shortText(near.workspaceId, 'team.near.workspaceId') };
  }
  return team;
}

// A snapshot must carry the anchored genesis, and the owner's genesis device must be the anchored key, so a state signed under another
// team's keys cannot pass as this team's.
function checkAnchorBinding(state: TeamState, anchor: GenesisAnchor): void {
  const owner = state.members.get(state.team.ownerId);
  if (owner === undefined || owner.role !== 'owner') bad('team.ownerId');
  const genesisDevice = owner.devices.find((device) => device.fingerprint === anchor.ownerDevice.fingerprint);
  if (genesisDevice === undefined || genesisDevice.publicKey !== anchor.ownerDevice.publicKey || genesisDevice.addedEvent !== anchor.eventId) bad('team.ownerId');
  if ([...state.members.values()].filter((member) => member.role === 'owner').length !== 1) bad('members');
}

function checkIndex(state: TeamState): void {
  let devices = 0;
  for (const member of state.members.values()) {
    for (const device of member.devices) {
      devices += 1;
      if (state.deviceIndex.get(device.fingerprint) !== member.id) bad('deviceIndex');
    }
  }
  if (devices !== state.deviceIndex.size) bad('deviceIndex');
}

// Rebuilds a state from the shape serialiseState writes. Anything that does not match that shape exactly is refused, because a
// snapshot arrives from a remote. The final comparison guarantees the rebuilt state serialises back to the very same text.
export function deserialiseState(value: JsonObject, anchor: GenesisAnchor): TeamState {
  const root = plainRecord(value, 'state', STATE_KEYS);
  const genesis = plainRecord(root.genesis, 'genesis', ['teamId', 'eventId', 'ownerDevice']);
  const ownerDevice = plainRecord(genesis.ownerDevice, 'genesis.ownerDevice', ['fingerprint', 'publicKey']);
  if (genesis.teamId !== anchor.teamId || genesis.eventId !== anchor.eventId || ownerDevice.fingerprint !== anchor.ownerDevice.fingerprint || ownerDevice.publicKey !== anchor.ownerDevice.publicKey) bad('genesis');
  const state = createState(anchor);
  state.team = parseTeam(root.team, anchor);
  for (const member of items(root.members, 'members', parseMember)) {
    if (state.members.has(member.id)) bad('members');
    state.members.set(member.id, member);
  }
  for (const [fingerprint, memberId] of items(root.deviceIndex, 'deviceIndex', parsePair)) state.deviceIndex.set(fingerprint, memberId);
  // Later phases fill these; a Phase 60 snapshot must carry them empty and at their defaults.
  emptyList(root.items, 'items');
  emptyList(root.claims, 'claims');
  emptyList(root.leases, 'leases');
  emptyList(root.allocations, 'allocations');
  emptyList(root.integrationQueue, 'integrationQueue');
  if (root.stopped !== false) bad('stopped');
  const budget = plainRecord(root.budget, 'budget', ['periodNanoUsd', 'period']);
  if (budget.periodNanoUsd !== 0 || budget.period !== '') bad('budget');
  const head = plainRecord(root.head, 'head', ['eventId', 'lamport']);
  state.head = { eventId: patterned(head.eventId, 'head.eventId', EVENT_ID_PATTERN), lamport: integer(head.lamport, 'head.lamport', 1) };
  state.highLamport = integer(root.highLamport, 'highLamport', 1);
  state.accepted = integer(root.accepted, 'accepted', 1);
  for (const id of items(root.seenEventIds, 'seenEventIds', (item, itemPath) => patterned(item, itemPath, EVENT_ID_PATTERN))) state.seenEventIds.add(id);
  if (state.seenEventIds.size !== state.accepted || !state.seenEventIds.has(state.head.eventId) || state.highLamport !== state.head.lamport) bad('seenEventIds');
  state.rejected = items(root.rejected, 'rejected', parseRejection);
  state.snapshots = items(root.snapshots, 'snapshots', parseSnapshotRef);
  checkIndex(state);
  checkAnchorBinding(state, anchor);
  if (canonicalize(value) !== serialiseState(state)) bad('state');
  return state;
}

function snapshotFailure(reason: string): ParsedSnapshot {
  return { ok: false, reason };
}

// A loaded snapshot is provisional (D-27): it is a shortcut for display, signed by an owner or lead device bound in its own state,
// and the client still replays from genesis. verifyLog always replays fully.
export function parseSnapshotFile(fileText: string, anchor: GenesisAnchor): ParsedSnapshot {
  if (Buffer.byteLength(fileText, 'utf8') > MAX_SNAPSHOT_BYTES) return snapshotFailure(SNAPSHOT_REASONS.tooLarge);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    // Text that is not JSON is a malformed snapshot; the verdict is the reason, not a thrown error.
    return snapshotFailure(SNAPSHOT_REASONS.malformed);
  }
  let canonical: string;
  try {
    canonical = canonicalize(parsed);
  } catch {
    // Values the canonical form refuses (floats, depth, odd types) cannot be a canonical file.
    return snapshotFailure(SNAPSHOT_REASONS.notCanonical);
  }
  if (canonical !== fileText) return snapshotFailure(SNAPSHOT_REASONS.notCanonical);
  try {
    const raw = plainRecord(parsed, 'file', SNAPSHOT_KEYS);
    if (raw.v !== 1 || raw.kind !== 'snapshot') bad('file');
    const file: SnapshotFile = {
      v: 1, kind: 'snapshot', teamId: shortText(raw.teamId, 'teamId'), coversThrough: patterned(raw.coversThrough, 'coversThrough', EVENT_ID_PATTERN),
      lamport: integer(raw.lamport, 'lamport', 1), stateHash: patterned(raw.stateHash, 'stateHash', /^[0-9a-f]{64}$/), state: raw.state as JsonObject,
      author: patterned(raw.author, 'author', MEMBER_ID_PATTERN), device: patterned(raw.device, 'device', FINGERPRINT_PATTERN), sig: shortText(raw.sig, 'sig')
    };
    if (file.teamId !== anchor.teamId) return snapshotFailure(SNAPSHOT_REASONS.wrongTeam);
    const state = deserialiseState(file.state, anchor);
    if (stateHash(state) !== file.stateHash || state.head.eventId !== file.coversThrough || state.head.lamport !== file.lamport) return snapshotFailure(R.snapshotMismatch);
    const key = state.deviceIndex.get(file.device) === file.author ? state.members.get(file.author)?.devices.find((device) => device.fingerprint === file.device) : undefined;
    const member = state.members.get(file.author);
    if (key === undefined || member === undefined) return snapshotFailure(R.unboundDevice);
    if (key.revokedEvent !== undefined) return snapshotFailure(R.revokedDevice);
    if (member.removedEvent !== undefined) return snapshotFailure(R.removedAuthor);
    if (member.role !== 'owner' && member.role !== 'lead') return snapshotFailure(SNAPSHOT_REASONS.notManager);
    const { sig, ...unsigned } = file;
    if (!verifySignature(canonicalBytes(unsigned), sig, key.publicKey)) return snapshotFailure(R.badSignature);
    return { ok: true, state, provisional: true, file };
  } catch (error) {
    if (error instanceof SnapshotShapeError) return snapshotFailure(error.message);
    throw error;
  }
}

function asEntry(event: TeamEvent): CommittedEvent {
  const text = canonicalize(event);
  return { commit: '', commitTime: 0, path: eventPath(event), blob: '', size: Buffer.byteLength(text, 'utf8'), text, kind: 'event' };
}

// The rejection a read of these events would produce, found on a copy so the live state is never touched.
export function checkCandidate(state: TeamState, events: TeamEvent[]): Rejection | undefined {
  const copy = cloneState(state);
  for (const event of events) {
    let entry: CommittedEvent;
    try {
      entry = asEntry(event);
    } catch {
      // A candidate that cannot be written as a canonical file could never be committed, which a reader reports as malformed.
      return { eventId: event.id, reason: R.malformed };
    }
    const verdict = applyEntry(copy, entry);
    if (!verdict.accepted) return verdict.rejection;
  }
  return undefined;
}

export function teamMaterializer(anchor: GenesisAnchor): Materializer<TeamState> {
  return {
    initial: () => createState(anchor),
    apply: (state, entry) => applyEntry(state, entry),
    head: (state) => ({ ...state.head }),
    check: (state, events: TeamEvent[]) => checkCandidate(state, events)
  };
}
