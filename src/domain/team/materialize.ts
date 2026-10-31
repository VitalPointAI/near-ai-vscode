// Materialiser for the team event log. This is the tracer-depth version: it proves the genesis anchor (D-10), the signature
// scheme (D-06) and deterministic serialisation. Plan 60-05 replaces the validation body with the full D-09 pipeline behind
// these same exports. Pure: no I/O, no clock, ordering comes only from the order entries are applied in (D-03).
import { MAX_EVENT_BYTES, canonicalize, eventPath, fingerprintOf, isStrictBase64url, verifyEventSignature } from './canonical';
import { DEFAULT_WIP_LIMIT, defaultTeamPolicy } from './policy';
import { TEAM_EVENT_TYPES, TEAM_REJECTION_REASONS } from './types';
import type { CommittedEvent, DeviceRef, EntryVerdict, GenesisAnchor, Materializer, Member, Rejection, TeamEvent, TeamState } from './types';

const MAX_LAMPORT_JUMP = 1000;
const EVENT_ID_PATTERN = /^evt-[0-9A-HJKMNP-TV-Z]{26}$/;
const ENVELOPE_KEYS = ['at', 'author', 'body', 'device', 'id', 'lamport', 'prev', 'sig', 'teamId', 'type', 'v'];

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Fields, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isString(value: unknown, maxLength = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isDeviceRef(value: unknown): value is DeviceRef {
  return isRecord(value) && hasExactKeys(value, ['fingerprint', 'publicKey'])
    && typeof value.publicKey === 'string' && isStrictBase64url(value.publicKey, 32)
    && typeof value.fingerprint === 'string' && value.fingerprint === fingerprintOf(Buffer.from(value.publicKey, 'base64url'));
}

function sameDevice(left: DeviceRef, right: DeviceRef): boolean {
  return left.fingerprint === right.fingerprint && left.publicKey === right.publicKey;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length <= 200);
}

function isEnvelope(value: unknown): value is TeamEvent {
  if (!isRecord(value) || !hasExactKeys(value, ENVELOPE_KEYS)) return false;
  return value.v === 1 && typeof value.id === 'string' && EVENT_ID_PATTERN.test(value.id) && isString(value.teamId)
    && typeof value.type === 'string' && (TEAM_EVENT_TYPES as readonly string[]).includes(value.type)
    && typeof value.lamport === 'number' && Number.isSafeInteger(value.lamport) && value.lamport >= 1
    && isString(value.at) && isString(value.author) && typeof value.device === 'string' && typeof value.prev === 'string'
    && isRecord(value.body) && typeof value.sig === 'string';
}

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

function reject(state: TeamState, eventId: string, reason: string): EntryVerdict {
  const rejection: Rejection = { eventId, reason };
  state.rejected.push(rejection);
  return { accepted: false, rejection };
}

function refuse(state: TeamState, eventId: string): EntryVerdict {
  state.refused = TEAM_REJECTION_REASONS.logRefused;
  return reject(state, eventId, TEAM_REJECTION_REASONS.logRefused);
}

function accept(state: TeamState, event: TeamEvent): EntryVerdict {
  state.head = { eventId: event.id, lamport: event.lamport };
  state.highLamport = event.lamport;
  state.accepted += 1;
  state.seenEventIds.add(event.id);
  return { accepted: true, event };
}

function parseEvent(entry: CommittedEvent): TeamEvent | string {
  if (entry.size > MAX_EVENT_BYTES) return TEAM_REJECTION_REASONS.tooLarge;
  let parsed: unknown;
  let canonical: string;
  try {
    parsed = JSON.parse(entry.text);
    canonical = canonicalize(parsed);
  } catch {
    // Unparseable text and values the canonical form refuses are the same fault for a reader: a malformed event.
    return TEAM_REJECTION_REASONS.malformed;
  }
  if (canonical !== entry.text) return TEAM_REJECTION_REASONS.notCanonical;
  if (!isEnvelope(parsed)) return TEAM_REJECTION_REASONS.malformed;
  return parsed;
}

function bindOwner(state: TeamState, event: TeamEvent<'team.created'>): void {
  const body = event.body;
  state.team = { id: state.team.id, name: body.name, ownerId: body.ownerId, policy: body.policy };
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
  const parsed = parseEvent(entry);
  if (typeof parsed === 'string') return refuse(state, entry.path);
  const event = parsed;
  if (event.type !== 'team.created' || event.id !== anchor.eventId || entry.path !== eventPath(event)) return refuse(state, event.id);
  const body: unknown = event.body;
  if (!isRecord(body) || !hasExactKeys(body, ['name', 'ownerId', 'ownerName', 'ownerEmailHashes', 'ownerDevice', 'policy'], ['near'])) return refuse(state, event.id);
  if (!isString(body.name) || !isString(body.ownerId) || !isString(body.ownerName) || !isStringArray(body.ownerEmailHashes) || !isRecord(body.policy)) return refuse(state, event.id);
  if (!isDeviceRef(body.ownerDevice) || !sameDevice(body.ownerDevice, anchor.ownerDevice)) return refuse(state, event.id);
  if (event.teamId !== anchor.teamId || event.author !== body.ownerId || event.device !== anchor.ownerDevice.fingerprint) return refuse(state, event.id);
  if (!verifyEventSignature(event, anchor.ownerDevice.publicKey)) return refuse(state, event.id);
  bindOwner(state, event as TeamEvent<'team.created'>);
  return accept(state, event);
}

function publicKeyFor(state: TeamState, event: TeamEvent): string | undefined {
  const memberId = state.deviceIndex.get(event.device);
  if (memberId === undefined || memberId !== event.author) return undefined;
  return state.members.get(memberId)?.devices.find((device) => device.fingerprint === event.device && device.revokedEvent === undefined)?.publicKey;
}

function applyJoined(state: TeamState, event: TeamEvent): EntryVerdict {
  const body: unknown = event.body;
  const owner = state.members.get(state.team.ownerId);
  if (state.accepted !== 1 || owner === undefined || !isRecord(body) || !hasExactKeys(body, ['memberId', 'name', 'emailHashes', 'role', 'device'])) return reject(state, event.id, TEAM_REJECTION_REASONS.ownerJoinOnly);
  if (body.memberId !== owner.id || body.role !== 'owner' || !isDeviceRef(body.device) || !sameDevice(body.device, state.genesis.ownerDevice)) return reject(state, event.id, TEAM_REJECTION_REASONS.ownerJoinOnly);
  if (!isString(body.name) || !isStringArray(body.emailHashes)) return reject(state, event.id, TEAM_REJECTION_REASONS.invalidBody);
  owner.name = body.name;
  owner.emailHashes = [...body.emailHashes];
  owner.joinedEvent = event.id;
  owner.joinedAt = event.at;
  return accept(state, event);
}

export function applyEntry(state: TeamState, entry: CommittedEvent): EntryVerdict {
  if (state.refused !== undefined) return { accepted: false, rejection: { eventId: entry.path, reason: state.refused } };
  if (entry.kind === 'genesis-copy') return { accepted: true };
  if (entry.kind === 'anomaly') return reject(state, entry.path, entry.anomaly ?? TEAM_REJECTION_REASONS.unexpectedPath);
  if (entry.kind === 'snapshot') return reject(state, entry.path, TEAM_REJECTION_REASONS.snapshotOrphan);
  if (state.accepted === 0) return applyGenesis(state, entry);
  const parsed = parseEvent(entry);
  if (typeof parsed === 'string') return reject(state, entry.path, parsed);
  const event = parsed;
  if (entry.path !== eventPath(event)) return reject(state, event.id, TEAM_REJECTION_REASONS.fileName);
  if (event.type !== 'member.joined') return reject(state, event.id, TEAM_REJECTION_REASONS.unsupported);
  if (event.teamId !== state.team.id) return reject(state, event.id, TEAM_REJECTION_REASONS.wrongTeam);
  if (state.seenEventIds.has(event.id)) return reject(state, event.id, TEAM_REJECTION_REASONS.duplicate);
  const publicKey = publicKeyFor(state, event);
  if (publicKey === undefined) return reject(state, event.id, TEAM_REJECTION_REASONS.unboundDevice);
  if (!verifyEventSignature(event, publicKey)) return reject(state, event.id, TEAM_REJECTION_REASONS.badSignature);
  if (event.lamport <= state.highLamport) return reject(state, event.id, TEAM_REJECTION_REASONS.lamportNotGreater);
  if (event.lamport > state.highLamport + MAX_LAMPORT_JUMP) return reject(state, event.id, TEAM_REJECTION_REASONS.lamportJump);
  return applyJoined(state, event);
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

export function teamMaterializer(anchor: GenesisAnchor): Materializer<TeamState> {
  return {
    initial: () => createState(anchor),
    apply: (state, entry) => applyEntry(state, entry),
    head: (state) => ({ ...state.head }),
    check: (state, events: TeamEvent[]) => {
      const copy = structuredClone(state);
      for (const event of events) {
        const verdict = applyEntry(copy, asEntry(event));
        if (!verdict.accepted) return verdict.rejection;
      }
      return undefined;
    }
  };
}
