// Materialiser for the team event log: the full D-09 validation pipeline and the state transitions for the ten Phase 60 event types.
// Every client runs exactly this code on every committed entry, so it is pure and deterministic: no I/O, no clock, no secret scanning
// (acceptance must not depend on detector versions), and ordering comes only from the order entries are applied in (D-03).
import { canonicalize, eventPath, verifyEventSignature } from './canonical';
import { actionForEvent, decideTeamAction } from './permissions';
import { DEFAULT_WIP_LIMIT, applyPolicyChanges, defaultTeamPolicy } from './policy';
import { TEAM_REJECTION_REASONS } from './types';
import type { CommittedEvent, DeviceKey, DeviceRef, EntryVerdict, GenesisAnchor, ImplementedTeamEvent, Materializer, Member, Rejection, TeamEvent, TeamState } from './types';
import { isRecord, parseEventFile } from './validate';

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

function accept(state: TeamState, event: ImplementedTeamEvent): EntryVerdict {
  state.head = { eventId: event.id, lamport: event.lamport };
  state.highLamport = event.lamport;
  state.accepted += 1;
  state.seenEventIds.add(event.id);
  return { accepted: true, event };
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
  return accept(state, event);
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
    case 'snapshot.written':
      // Task 2 proves a snapshot against the replayed state; until a state hash exists nothing can match.
      return R.snapshotMismatch;
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
      return;
  }
}

export function applyEntry(state: TeamState, entry: CommittedEvent): EntryVerdict {
  if (state.refused !== undefined) return { accepted: false, rejection: { eventId: entry.path, reason: state.refused } };
  if (entry.kind === 'genesis-copy') return { accepted: true };
  if (entry.kind === 'anomaly') return reject(state, entry.path, entry.anomaly ?? R.unexpectedPath);
  if (entry.kind === 'snapshot') return reject(state, entry.path, R.snapshotOrphan);
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
  applyTransition(state, event);
  return accept(state, event);
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

// Byte-stable text for hashing and comparison: Maps and Sets become key-sorted arrays, undefined fields are omitted.
export function serialiseState(state: TeamState): string {
  return canonicalize(toPlain(state));
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
