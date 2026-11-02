// Materialiser for the team event log: the full D-09 validation pipeline and the state transitions for the implemented event types.
// Every client runs exactly this code on every committed entry, so it is pure and deterministic: no I/O, no clock, no secret scanning
// (acceptance must not depend on detector versions), and ordering comes only from the order entries are applied in (D-03).
import { createHash } from 'node:crypto';
import { canonicalBytes, canonicalize, eventPath, fingerprintOf, isStrictBase64url, snapshotPath, verifyEventSignature, verifySignature } from './canonical';
import { expectedJoinRole, inviteExpired, joinProofBytes } from './invite';
import { actionForEvent, decideTeamAction } from './permissions';
import { DEFAULT_WIP_LIMIT, applyPolicyChanges, defaultTeamPolicy, validatePolicy } from './policy';
import { AVAILABILITIES, ROLES, TEAM_REJECTION_REASONS } from './types';
import type { Availability, CommittedEvent, DeviceKey, DeviceRef, EntryVerdict, GenesisAnchor, ImplementedTeamEvent, JsonObject, Materializer, Member, MemberInvite, Rejection, Role, SnapshotRef, TeamEvent, TeamPolicy, TeamState, WorkingHours } from './types';
import { EMAIL_HASH_PATTERN, EVENT_ID_PATTERN, FINGERPRINT_PATTERN, MEMBER_ID_PATTERN, SNAPSHOT_PATH_PATTERN, invalid, isRecord, parseEventFile } from './validate';

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
  if (event.prev !== '') return refuse(state, event.id);
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

// A join by an author who has an invitation on record is a self-bound join (D-09): the author's device is not on the roster yet, so it is
// bound by the join itself. Any other non-genesis member.joined keeps the Phase 60 rejection.
function claimsInvitation(state: TeamState, event: TeamEvent<'member.joined'>): boolean {
  return state.accepted > 1 && state.members.get(event.author)?.invitedEvent !== undefined;
}

// D-09 steps 3 and 4 for a self-bound join: the device in the body must be the signing device, must be new, and the envelope signature is
// verified against the key inside the body (the roster knows nothing of it yet). The invitation checks come later, at step 6.
function selfBindingProblem(state: TeamState, event: TeamEvent<'member.joined'>): string | undefined {
  const body = event.body;
  if (event.author !== body.memberId) return invalid('body.memberId');
  if (event.device !== body.device.fingerprint) return R.unboundDevice;
  if (state.deviceIndex.has(body.device.fingerprint)) return R.deviceTaken;
  return verifyEventSignature(event, body.device.publicKey) ? undefined : R.badSignature;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

// D-09 step 6 for a self-bound join, in the order the plan fixes: unused and not cancelled, code proof, email, role, expiry.
function inviteProblem(state: TeamState, event: TeamEvent<'member.joined'>, commitTime: number): string | undefined {
  const body = event.body;
  const member = state.members.get(body.memberId);
  const invite = member?.invite;
  if (member === undefined || invite === undefined || member.status !== 'invited' || member.removedEvent !== undefined) return R.notInvited;
  const proof = joinProofBytes(state.team.id, member.id, invite.eventId, body.device, body.sealKey?.publicKey ?? '');
  if (body.invite === undefined || !verifySignature(proof, body.invite.sig, invite.publicKey)) return R.inviteProof;
  if (!sameList(body.emailHashes, member.emailHashes)) return R.inviteEmail;
  if (body.role !== expectedJoinRole(member.pendingRole ?? 'observer', state.team.policy)) return R.inviteRole;
  return inviteExpired(invite.commitTime, invite.ttlSeconds, commitTime) ? R.inviteExpired : undefined;
}

// D-09 step 6: the same decideTeamAction the write side calls, evaluated against the state at this log position.
function authorisationProblem(state: TeamState, event: ImplementedTeamEvent, commitTime: number): string | undefined {
  if (event.type === 'team.created') return R.genesisOnly;
  if (event.type === 'member.joined') {
    if (isOwnerJoin(state, event)) return undefined;
    return claimsInvitation(state, event) ? inviteProblem(state, event, commitTime) : `${R.notPermitted}: ${R.ownerJoinOnly}`;
  }
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

// The member's devices that can receive a sealed key: bound to them, not revoked, and published with an X25519 key (D-24).
function sealCapableDevices(member: Member): string[] {
  return member.devices.filter((device) => device.revokedEvent === undefined && device.sealKey !== undefined).map((device) => device.fingerprint).sort(compareText);
}

// D-23 and D-24 for member.key-sealed, after the member itself was found: joined, a key id never delivered before (every delivery is a new
// key, so a device change always means a new key and an existing key is never re-sealed), every sealed device one of the member's own active
// devices with a seal key, and the sealed set equal to all of them.
function keyDeliveryProblem(state: TeamState, member: Member, keyId: string, sealedDevices: string[]): string | undefined {
  if (member.status === 'invited') return R.notJoined;
  if (member.nearApiKeyId === keyId || (member.retiredNearKeyIds ?? []).includes(keyId)) return R.keyReused;
  for (const fingerprint of sealedDevices) {
    const device = state.deviceIndex.get(fingerprint) === member.id ? member.devices.find((candidate) => candidate.fingerprint === fingerprint) : undefined;
    if (device === undefined || device.revokedEvent !== undefined || device.sealKey === undefined) return R.noSealKey;
  }
  return sameList([...sealedDevices].sort(compareText), sealCapableDevices(member)) ? undefined : R.keyDevices;
}

// D-09 step 7: every entity the event names must exist at this position.
function referenceProblem(state: TeamState, event: ImplementedTeamEvent): string | undefined {
  switch (event.type) {
    case 'member.invited': {
      // The invitation id is the member id, and a removed member's id is never reused, so a re-issue always mints a new one.
      if (state.members.has(event.body.memberId)) return R.memberTaken;
      const taken = event.body.emailHashes.some((hash) => [...state.members.values()].some((member) => member.removedEvent === undefined && member.emailHashes.includes(hash)));
      return taken ? R.alreadyInvited : undefined;
    }
    // Removing an invited member is how an invitation is cancelled, so removal is the one change that is allowed before the join.
    case 'member.removed': {
      const member = lookupMember(state, event.body.memberId);
      return typeof member === 'string' ? member : undefined;
    }
    case 'member.role-changed':
    case 'member.skills': {
      const member = lookupMember(state, event.body.memberId);
      if (typeof member === 'string') return member;
      return member.status === 'invited' ? R.notJoined : undefined;
    }
    case 'device.added': {
      const member = lookupMember(state, event.body.memberId);
      if (typeof member === 'string') return member;
      if (member.status === 'invited') return R.notJoined;
      return state.deviceIndex.has(event.body.device.fingerprint) ? R.deviceTaken : undefined;
    }
    case 'device.revoked': {
      const member = lookupMember(state, event.body.memberId);
      if (typeof member === 'string') return member;
      if (member.status === 'invited') return R.notJoined;
      const key = state.deviceIndex.get(event.body.fingerprint) === member.id
        ? member.devices.find((device) => device.fingerprint === event.body.fingerprint) : undefined;
      if (key === undefined) return R.deviceNotBound;
      if (key.revokedEvent !== undefined) return R.deviceRevoked;
      return member.devices.filter((device) => device.revokedEvent === undefined).length === 1 ? R.lastDevice : undefined;
    }
    case 'member.key-sealed': {
      const member = lookupMember(state, event.body.memberId);
      if (typeof member === 'string') return member;
      return keyDeliveryProblem(state, member, event.body.keyId, event.body.sealed.map((entry) => entry.device));
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

// The invited record: observer, no device, offline. The role the lead asked for waits in pendingRole. commitTime is stored so the expiry
// rule can compare two transport commit times later without reading a clock.
function applyInvited(state: TeamState, event: TeamEvent<'member.invited'>, commitTime: number): void {
  const body = event.body;
  const invite: MemberInvite = { publicKey: body.invite.publicKey, ttlSeconds: body.ttlSeconds, eventId: event.id, commitTime };
  state.members.set(body.memberId, {
    id: body.memberId, name: body.name, emailHashes: [...body.emailHashes], role: 'observer', devices: [], skills: [], availability: 'offline',
    wipLimit: DEFAULT_WIP_LIMIT, joinedAt: event.at, joinedEvent: event.id,
    status: 'invited', invite, invitedEvent: event.id, pendingRole: body.role, allocationNanoUsd: body.allocationNanoUsd
  });
}

// The join binds the device, ends the invited status (which is what makes the code single use) and keeps pendingRole until it is confirmed.
function applyJoiner(state: TeamState, member: Member, event: TeamEvent<'member.joined'>): void {
  const body = event.body;
  delete member.status;
  delete member.invite;
  member.name = body.name;
  member.emailHashes = [...body.emailHashes];
  member.role = body.role;
  member.availability = 'available';
  member.joinedAt = event.at;
  member.joinedEvent = event.id;
  const device: DeviceKey = { fingerprint: body.device.fingerprint, publicKey: body.device.publicKey, addedBy: member.id, addedEvent: event.id };
  if (body.sealKey !== undefined) device.sealKey = body.sealKey.publicKey;
  member.devices.push(device);
  state.deviceIndex.set(device.fingerprint, member.id);
  if (member.pendingRole === body.role) delete member.pendingRole;
}

function applyTransition(state: TeamState, event: ImplementedTeamEvent, commitTime: number): void {
  switch (event.type) {
    case 'team.created':
      return;
    case 'member.invited':
      applyInvited(state, event, commitTime);
      return;
    case 'member.joined': {
      const member = memberOf(state, event.body.memberId);
      if (member.status === 'invited') {
        applyJoiner(state, member, event);
        return;
      }
      member.name = event.body.name;
      member.emailHashes = [...event.body.emailHashes];
      member.joinedEvent = event.id;
      member.joinedAt = event.at;
      return;
    }
    case 'member.role-changed': {
      const member = memberOf(state, event.body.memberId);
      member.role = event.body.role;
      // Any role change by a lead settles the confirmation the member was waiting for.
      delete member.pendingRole;
      return;
    }
    case 'member.removed': {
      const member = memberOf(state, event.body.memberId);
      member.removedEvent = event.id;
      member.removedAt = event.at;
      return;
    }
    case 'device.added': {
      const added: DeviceKey = { fingerprint: event.body.device.fingerprint, publicKey: event.body.device.publicKey, addedBy: event.author, addedEvent: event.id };
      if (event.body.sealKey !== undefined) added.sealKey = event.body.sealKey.publicKey;
      memberOf(state, event.body.memberId).devices.push(added);
      state.deviceIndex.set(event.body.device.fingerprint, event.body.memberId);
      return;
    }
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
    case 'member.key-sealed': {
      // The previous key moves to the retired list, so removal can revoke every key ever sealed to this member (D-24).
      const member = memberOf(state, event.body.memberId);
      if (member.nearApiKeyId !== undefined) member.retiredNearKeyIds = [...(member.retiredNearKeyIds ?? []), member.nearApiKeyId];
      member.nearApiKeyId = event.body.keyId;
      member.nearKeyDevices = event.body.sealed.map((entry) => entry.device).sort(compareText);
      member.nearKeyEvent = event.id;
      return;
    }
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
  // Steps 3 and 4: the bound device, then its signature. A join by an invited member is self-bound: the device is new, so the signature is
  // checked against the key in the body (D-09) and the invitation itself is checked at step 6.
  if (event.type === 'member.joined' && claimsInvitation(state, event)) {
    const problem = selfBindingProblem(state, event);
    if (problem !== undefined) return reject(state, event.id, problem);
  } else {
    const key = boundKey(state, event);
    if (typeof key === 'string') return reject(state, event.id, key);
    if (!verifyEventSignature(event, key.publicKey)) return reject(state, event.id, R.badSignature);
  }
  // The signed prev must name the accepted head this event follows, so the field is a real link and not decoration (WR-08).
  if (event.prev !== state.head.eventId) return reject(state, event.id, R.prevMismatch);
  // Step 5: Lamport counts accepted events only, so a rejected event can never poison the high-water mark.
  if (event.lamport <= state.highLamport) return reject(state, event.id, R.lamportNotGreater);
  if (event.lamport > state.highLamport + MAX_LAMPORT_JUMP) return reject(state, event.id, R.lamportJump);
  // Steps 6 and 7: permission at this position, then the entities the event names. Nothing is mutated before all checks pass.
  const denied = authorisationProblem(state, event, entry.commitTime);
  if (denied !== undefined) return reject(state, event.id, denied);
  const missing = referenceProblem(state, event);
  if (missing !== undefined) return reject(state, event.id, missing);
  // The role is read before the transition, so an event that changes its own author's role is still recorded under the role it was written with.
  const authorRole = state.members.get(event.author)?.role;
  applyTransition(state, event, entry.commitTime);
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

// The version of the hashed shape below. A later phase that adds hashed fields bumps this deliberately; a reader that hashes with another
// version simply does not match, which is the same safe outcome as any other snapshot mismatch.
export const STATE_HASH_VERSION = 1;

// What a snapshot hash covers (WR-07): only state every client that understands the same event types derives identically. The counters
// and logs that depend on how a particular client version treated entries it did not recognise (accepted, seenEventIds, rejected) and the
// list of earlier snapshots are left out, so a newer client's snapshot is not refused by an older one because of bookkeeping alone, and a
// junk file in the log cannot invalidate a snapshot that was computed just before it. Where the log stands is bound by head and
// highLamport. The snapshot file still carries the full serialiseState text, signed by the author.
function hashedState(state: TeamState): Fields {
  const plain = plainState(state);
  for (const key of ['accepted', 'seenEventIds', 'rejected', 'snapshots']) delete plain[key];
  return { hashVersion: STATE_HASH_VERSION, ...plain };
}

export function stateHash(state: TeamState): string {
  return createHash('sha256').update(canonicalize(hashedState(state))).digest('hex');
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
  const raw = plainRecord(value, path, ['fingerprint', 'publicKey', 'addedBy', 'addedEvent'], ['revokedEvent', 'revokedBy', 'sealKey']);
  const publicKey = shortText(raw.publicKey, `${path}.publicKey`);
  const fingerprint = patterned(raw.fingerprint, `${path}.fingerprint`, FINGERPRINT_PATTERN);
  if (!isStrictBase64url(publicKey, 32) || fingerprint !== fingerprintOf(Buffer.from(publicKey, 'base64url'))) bad(`${path}.publicKey`);
  const key: DeviceKey = { fingerprint, publicKey, addedBy: shortText(raw.addedBy, `${path}.addedBy`), addedEvent: shortText(raw.addedEvent, `${path}.addedEvent`) };
  if (raw.revokedEvent !== undefined) key.revokedEvent = shortText(raw.revokedEvent, `${path}.revokedEvent`);
  if (raw.revokedBy !== undefined) key.revokedBy = shortText(raw.revokedBy, `${path}.revokedBy`);
  if (raw.sealKey !== undefined) {
    const sealKey = shortText(raw.sealKey, `${path}.sealKey`);
    if (!isStrictBase64url(sealKey, 32)) bad(`${path}.sealKey`);
    key.sealKey = sealKey;
  }
  return key;
}

function parseWorkingHours(value: unknown, path: string): WorkingHours {
  const raw = plainRecord(value, path, ['tz', 'days', 'start', 'end']);
  return { tz: shortText(raw.tz, `${path}.tz`), days: items(raw.days, `${path}.days`, (day, dayPath) => integer(day, dayPath)), start: shortText(raw.start, `${path}.start`), end: shortText(raw.end, `${path}.end`) };
}

function parseInvite(value: unknown, path: string): MemberInvite {
  const raw = plainRecord(value, path, ['publicKey', 'ttlSeconds', 'eventId', 'commitTime']);
  const publicKey = shortText(raw.publicKey, `${path}.publicKey`);
  if (!isStrictBase64url(publicKey, 32)) bad(`${path}.publicKey`);
  return { publicKey, ttlSeconds: integer(raw.ttlSeconds, `${path}.ttlSeconds`, 1), eventId: patterned(raw.eventId, `${path}.eventId`, EVENT_ID_PATTERN), commitTime: integer(raw.commitTime, `${path}.commitTime`) };
}

function parseMember(value: unknown, path: string): Member {
  const raw = plainRecord(value, path, ['id', 'name', 'emailHashes', 'role', 'devices', 'skills', 'availability', 'wipLimit', 'joinedAt', 'joinedEvent'],
    ['workingHours', 'nearApiKeyId', 'removedAt', 'removedEvent', 'status', 'invite', 'invitedEvent', 'pendingRole', 'allocationNanoUsd', 'nearKeyDevices', 'nearKeyEvent', 'retiredNearKeyIds']);
  const devices = items(raw.devices, `${path}.devices`, parseDeviceKey);
  // Only an invited member may have no device; everyone else was bound by a join.
  if (raw.status !== undefined && raw.status !== 'invited') bad(`${path}.status`);
  if (devices.length === 0 && raw.status !== 'invited') bad(`${path}.devices`);
  if ((raw.status === 'invited') !== (raw.invite !== undefined)) bad(`${path}.invite`);
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
  if (raw.status !== undefined) member.status = 'invited';
  if (raw.invite !== undefined) member.invite = parseInvite(raw.invite, `${path}.invite`);
  if (raw.invitedEvent !== undefined) member.invitedEvent = patterned(raw.invitedEvent, `${path}.invitedEvent`, EVENT_ID_PATTERN);
  if (raw.pendingRole !== undefined) member.pendingRole = choice<Role>(raw.pendingRole, `${path}.pendingRole`, ROLES);
  if (raw.allocationNanoUsd !== undefined) member.allocationNanoUsd = integer(raw.allocationNanoUsd, `${path}.allocationNanoUsd`);
  if (raw.nearKeyDevices !== undefined) member.nearKeyDevices = items(raw.nearKeyDevices, `${path}.nearKeyDevices`, (device, devicePath) => patterned(device, devicePath, FINGERPRINT_PATTERN));
  if (raw.nearKeyEvent !== undefined) member.nearKeyEvent = patterned(raw.nearKeyEvent, `${path}.nearKeyEvent`, EVENT_ID_PATTERN);
  if (raw.retiredNearKeyIds !== undefined) member.retiredNearKeyIds = items(raw.retiredNearKeyIds, `${path}.retiredNearKeyIds`, (keyId, keyPath) => shortText(keyId, keyPath));
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

function asEntry(event: TeamEvent, commitTime: number): CommittedEvent {
  const text = canonicalize(event);
  return { commit: '', commitTime, path: eventPath(event), blob: '', size: Buffer.byteLength(text, 'utf8'), text, kind: 'event' };
}

// The rejection a read of these events would produce, found on a copy so the live state is never touched. commitTime is the time the
// candidate would be committed at (the transport passes its own clock, in seconds); 0 means unknown, which skips the invitation expiry rule.
export function checkCandidate(state: TeamState, events: TeamEvent[], commitTime = 0): Rejection | undefined {
  const copy = cloneState(state);
  for (const event of events) {
    let entry: CommittedEvent;
    try {
      entry = asEntry(event, commitTime);
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
    check: (state, events: TeamEvent[], commitTime = 0) => checkCandidate(state, events, commitTime)
  };
}
