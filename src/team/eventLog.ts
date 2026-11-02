// TeamLog: the facade every Team Mode caller uses to write and read the coordination log.
// Writing turns intents into stamped, secret-checked, permission-checked and signed events inside the transport builder, so a lost
// push race rebuilds lamport, prev, id and signature instead of re-sending a stale event (D-05, D-29). Reading syncs the transport and
// reports a verdict per entry; verifyAll replays the whole log from genesis (D-25). This module never imports vscode.
import { CanonicalJsonError, MAX_EVENT_BYTES, canonicalBytes, canonicalize, snapshotPath } from '../domain/team/canonical';
import { applyEntry, createState, snapshotBody } from '../domain/team/materialize';
import type { SnapshotFile } from '../domain/team/materialize';
import { actionForEvent, decideTeamAction } from '../domain/team/permissions';
import { assertNoSecrets, findSecrets } from '../domain/team/secrets';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import { parseEventFile } from '../domain/team/validate';
import type {
  CommittedEvent, DeviceRef, GenesisAnchor, ImplementedEventBodies, ImplementedEventType, ImplementedTeamEvent, LogHead, MemberJoinedBody,
  NearLink, Rejection, Role, TeamCreatedBody, TeamEvent, TeamPolicy, TeamState, UnsignedTeamEvent
} from '../domain/team/types';
import { newEventId, signEvent } from './identity';
import type { DeviceIdentity } from './identity';
import type { AppendBuild, AppendResult, CoordinationTransport, TransportStatus } from './transport';

const R = TEAM_REJECTION_REASONS;

export const DEFAULT_SNAPSHOT_EVERY = 500;
const DEFAULT_YIELD_EVERY = 200;
// An Ed25519 signature is 86 base64url characters; the placeholder gives the exact size the signed file will have.
const SIGNATURE_PLACEHOLDER = 'A'.repeat(86);
export const NO_DEVICE_KEY_MESSAGE = 'This computer has no device key for this team.';
// What a client that lost the snapshot race is told when its builder runs again against a log that already has the snapshot (D-33).
export const SNAPSHOT_ALREADY_WRITTEN = 'snapshot already written';

export class NoDeviceKeyError extends Error {
  public constructor() {
    super(NO_DEVICE_KEY_MESSAGE);
    this.name = 'NoDeviceKeyError';
  }
}

export interface TeamSigner { identity: DeviceIdentity; memberId: string }
export type EventIntent = { [T in ImplementedEventType]: { type: T; body: ImplementedEventBodies[T] } }[ImplementedEventType];

export interface GenesisInput {
  teamId: string;
  teamName: string;
  owner: { memberId: string; name: string; emailHashes: string[] };
  identity: DeviceIdentity;
  policy: TeamPolicy;
  near?: NearLink;
  now?: () => Date;
}

// The two-event batch Enable Team Mode writes (D-20): team.created at lamport 1, then member.joined for the owner at lamport 2.
export function buildGenesisEvents(input: GenesisInput): { events: [TeamEvent<'team.created'>, TeamEvent<'member.joined'>]; anchor: GenesisAnchor } {
  const now = input.now ?? ((): Date => new Date());
  const { teamId, owner, identity } = input;
  const device: DeviceRef = { fingerprint: identity.fingerprint, publicKey: identity.publicKey };
  const createdBody: TeamCreatedBody = {
    name: input.teamName, ownerId: owner.memberId, ownerName: owner.name, ownerEmailHashes: [...owner.emailHashes],
    ownerDevice: { ...device }, policy: structuredClone(input.policy)
  };
  if (input.near !== undefined) createdBody.near = { organizationId: input.near.organizationId, workspaceId: input.near.workspaceId };
  const joinedBody: MemberJoinedBody = { memberId: owner.memberId, name: owner.name, emailHashes: [...owner.emailHashes], role: 'owner', device: { ...device } };
  assertNoSecrets(createdBody, 'team.created event');
  assertNoSecrets(joinedBody, 'member.joined event');
  const created = signEvent(identity, {
    v: 1, id: newEventId(), teamId, type: 'team.created', lamport: 1, at: now().toISOString(),
    author: owner.memberId, device: device.fingerprint, prev: '', body: createdBody
  });
  const joined = signEvent(identity, {
    v: 1, id: newEventId(), teamId, type: 'member.joined', lamport: 2, at: now().toISOString(),
    author: owner.memberId, device: device.fingerprint, prev: created.id, body: joinedBody
  });
  return { events: [created, joined], anchor: { teamId, eventId: created.id, ownerDevice: { ...device } } };
}

function stamp(state: TeamState, head: LogHead, signer: TeamSigner, intent: EventIntent, index: number, prev: string, now: () => Date): UnsignedTeamEvent<ImplementedEventType> {
  return {
    v: 1, id: newEventId(), teamId: state.genesis.teamId, type: intent.type, lamport: head.lamport + 1 + index, at: now().toISOString(),
    author: signer.memberId, device: signer.identity.fingerprint, prev, body: intent.body
  };
}

// The write side of D-12 and D-23. Each intent is secret-checked (a SecretLeakError propagates and nothing is written), asked of the same
// decideTeamAction the read side asks, size-checked with a full-length signature in place, and only then signed. A denial or an oversize
// event comes back as { conflict } carrying the exact text a reader would record for it. Reference problems (a member that does not
// exist, a revoked device) and batch interplay are caught by the transport, which replays the whole batch through the materialiser.
export function prepareEvents(state: TeamState, head: LogHead, signer: TeamSigner, intents: EventIntent[], now: () => Date): TeamEvent[] | { conflict: string } {
  const events: TeamEvent[] = [];
  let prev = head.eventId;
  for (const [index, intent] of intents.entries()) {
    assertNoSecrets(intent.body, `${intent.type} event`);
    // Genesis is built only by buildGenesisEvents, so neither type is ever valid from an intent.
    if (intent.type === 'team.created') return { conflict: R.genesisOnly };
    if (intent.type === 'member.joined') return { conflict: `${R.notPermitted}: ${R.ownerJoinOnly}` };
    const unsigned = stamp(state, head, signer, intent, index, prev, now);
    const candidate = { ...unsigned, sig: SIGNATURE_PLACEHOLDER } as ImplementedTeamEvent;
    const action = actionForEvent(candidate);
    if (action === undefined) return { conflict: R.notPermitted };
    const decision = decideTeamAction(state, signer.memberId, action);
    if (!decision.allowed) return { conflict: `${R.notPermitted}: ${decision.reason ?? ''}` };
    let size: number;
    try {
      size = canonicalBytes(candidate).length;
    } catch (error) {
      if (error instanceof CanonicalJsonError) return { conflict: R.malformed };
      throw error;
    }
    if (size > MAX_EVENT_BYTES) return { conflict: R.tooLarge };
    const event = signEvent(signer.identity, unsigned);
    events.push(event);
    prev = event.id;
  }
  return events;
}

// The join of an invited person (D-09). The joiner has no roster entry and no signer, so this is the one event built without a TeamSigner: the
// author is the invited member, the signing device is the new device, and the transport's candidate check applies the same invitation rules a reader
// applies. Refused here, before signing, when the invitation is already used, cancelled or never existed in the state the builder was given.
export function prepareJoinEvent(state: TeamState, head: LogHead, identity: DeviceIdentity, body: MemberJoinedBody, now: () => Date): TeamEvent[] | { conflict: string } {
  assertNoSecrets(body, 'member.joined event');
  const member = state.members.get(body.memberId);
  if (member === undefined || member.status !== 'invited' || member.removedEvent !== undefined) return { conflict: R.notInvited };
  if (body.device.fingerprint !== identity.fingerprint || body.device.publicKey !== identity.publicKey) return { conflict: R.unboundDevice };
  const unsigned: UnsignedTeamEvent<'member.joined'> = {
    v: 1, id: newEventId(), teamId: state.genesis.teamId, type: 'member.joined', lamport: head.lamport + 1, at: now().toISOString(),
    author: body.memberId, device: identity.fingerprint, prev: head.eventId, body
  };
  let size: number;
  try {
    size = canonicalBytes({ ...unsigned, sig: SIGNATURE_PLACEHOLDER }).length;
  } catch (error) {
    if (error instanceof CanonicalJsonError) return { conflict: R.malformed };
    throw error;
  }
  if (size > MAX_EVENT_BYTES) return { conflict: R.tooLarge };
  return [signEvent(identity, unsigned)];
}

export interface TeamLogOptions {
  anchor: GenesisAnchor;
  transport: CoordinationTransport<TeamState>;
  // Without a signer the log can sync and verify but not write (this computer has no device key).
  signer?: TeamSigner;
  now?: () => Date;
  snapshotEvery?: number;
  yieldEvery?: number;
}

export interface SyncResult {
  entries: CommittedEvent[];
  accepted: TeamEvent[];
  // The author's role at each accepted event's position, keyed by event id.
  authorRoles: Map<string, Role>;
  rejected: Rejection[];
  status: TransportStatus;
  snapshot?: AppendResult;
}

export interface VerifyReport {
  events: number;
  accepted: number;
  members: Array<{ id: string; name: string; role: Role; removed: boolean; devices: Array<{ fingerprint: string; revoked: boolean }> }>;
  head: LogHead;
  rejected: Rejection[];
  refused?: string;
  unsupported: number;
  secretWarnings: string[];
  snapshots: number;
  status: TransportStatus;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a whole number of one or more.`);
  return value;
}

function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

export class TeamLog {
  private readonly anchor: GenesisAnchor;
  private readonly transport: CoordinationTransport<TeamState>;
  private readonly signer: TeamSigner | undefined;
  private readonly now: () => Date;
  private readonly snapshotEvery: number;
  private readonly yieldEvery: number;
  private lastSnapshotResult: AppendResult | undefined;

  public constructor(options: TeamLogOptions) {
    this.anchor = options.anchor;
    this.transport = options.transport;
    this.signer = options.signer;
    this.now = options.now ?? ((): Date => new Date());
    this.snapshotEvery = positiveInteger(options.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY, 'snapshotEvery');
    this.yieldEvery = positiveInteger(options.yieldEvery ?? DEFAULT_YIELD_EVERY, 'yieldEvery');
  }

  public state(): TeamState {
    return this.transport.state();
  }

  public status(): TransportStatus {
    return this.transport.status();
  }

  public async sync(): Promise<SyncResult> {
    const entries = await this.transport.fetch();
    const accepted: TeamEvent[] = [];
    const authorRoles = new Map<string, Role>();
    const rejected: Rejection[] = [];
    for (const entry of entries) {
      const verdict = entry.verdict;
      if (verdict === undefined) continue;
      if (!verdict.accepted) {
        rejected.push(verdict.rejection);
      } else if (verdict.event !== undefined) {
        accepted.push(verdict.event);
        if (verdict.authorRole !== undefined) authorRoles.set(verdict.event.id, verdict.authorRole);
      }
    }
    const snapshot = await this.trySnapshot();
    const result: SyncResult = { entries, accepted, authorRoles, rejected, status: this.transport.status() };
    if (snapshot !== undefined) result.snapshot = snapshot;
    return result;
  }

  // One event by id, read from the log itself and parsed with the same rules as every reader. Used for bodies the state does not keep, such as the
  // sealed entries of a key delivery. The first entry with the id in log order is the one that was accepted; a later copy is a rejected duplicate.
  public async findEvent(eventId: string): Promise<ImplementedTeamEvent | undefined> {
    for (const entry of await this.transport.readAll()) {
      if (entry.kind !== 'event') continue;
      const parsed = parseEventFile(entry);
      if (parsed.ok && parsed.event.id === eventId) return parsed.event;
    }
    return undefined;
  }

  // The outcome of the most recent snapshot attempt after a sync or an append, so a caller that only appended can still see it.
  public lastSnapshot(): AppendResult | undefined {
    return this.lastSnapshotResult;
  }

  // The intents function is called with the freshest state on every attempt, so a caller that derives its intents from state (a conflict
  // check, for example) sees what the winner of a lost race wrote. A { conflict } return stops the append with that text.
  public async append(intents: (state: TeamState) => EventIntent[] | { conflict: string }): Promise<AppendResult> {
    const signer = this.signer;
    if (signer === undefined) throw new NoDeviceKeyError();
    const result = await this.transport.append((state, head) => {
      const wanted = intents(state);
      return Array.isArray(wanted) ? prepareEvents(state, head, signer, wanted, this.now) : wanted;
    });
    if (result.ok) await this.trySnapshot();
    return result;
  }

  // A joiner has no signer yet (the device key is made for this join), so the identity is passed in. The body function is called with the freshest
  // state on every attempt: it re-reads the invitation, so a join that lost a race to a second device gets the notInvited conflict, not a duplicate.
  public async appendJoin(identity: DeviceIdentity, body: (state: TeamState) => MemberJoinedBody | { conflict: string }): Promise<AppendResult> {
    const result = await this.transport.append((state, head) => {
      const wanted = body(state);
      return 'conflict' in wanted ? wanted : prepareJoinEvent(state, head, identity, wanted, this.now);
    });
    if (result.ok) await this.trySnapshot();
    return result;
  }

  // The fetch and the append have already happened when a snapshot is attempted, so a throw here (a git error, a full disk) must not
  // discard what they returned: the transport does not hand the same entries out again. The failure is reported as a refused snapshot.
  private async trySnapshot(): Promise<AppendResult | undefined> {
    try {
      return await this.maybeWriteSnapshot();
    } catch (error) {
      const failed: AppendResult = { ok: false, kind: 'refused', reason: error instanceof Error ? error.message : String(error), attempts: 0 };
      this.lastSnapshotResult = failed;
      return failed;
    }
  }

  private snapshotDue(state: TeamState): boolean {
    const last = state.snapshots.reduce((highest, ref) => Math.max(highest, ref.lamport), 0);
    return state.head.lamport >= last + this.snapshotEvery;
  }

  // D-27: only an owner or lead client writes snapshots, one per snapshotEvery accepted events. A client that loses the race is not
  // in error: the result is reported (refused or conflict) and the next sync sees the winner's snapshot.
  private async maybeWriteSnapshot(): Promise<AppendResult | undefined> {
    const signer = this.signer;
    if (signer === undefined || this.transport.status().state !== 'ok') return undefined;
    const state = this.transport.state();
    if (!this.snapshotDue(state) || !decideTeamAction(state, signer.memberId, { kind: 'snapshot.write' }).allowed) return undefined;
    const result = await this.transport.append((fresh, head) => this.buildSnapshot(fresh, head, signer));
    this.lastSnapshotResult = result;
    return result;
  }

  // Runs again after every lost race, so the threshold, the state hash, the file and the event are all derived from the fresh state (D-29).
  private buildSnapshot(state: TeamState, head: LogHead, signer: TeamSigner): AppendBuild {
    const decision = decideTeamAction(state, signer.memberId, { kind: 'snapshot.write' });
    if (!decision.allowed) return { conflict: `${R.notPermitted}: ${decision.reason ?? ''}` };
    if (!this.snapshotDue(state)) return { conflict: SNAPSHOT_ALREADY_WRITTEN };
    const body = snapshotBody(state);
    // The state is copied into the file, so a secret-like value an older client let through must not be copied into a second place.
    if (findSecrets(body.state).length > 0) return { conflict: 'snapshot skipped because the state holds a secret-like value' };
    const unsigned = { ...body, author: signer.memberId, device: signer.identity.fingerprint };
    const file: SnapshotFile = { ...unsigned, sig: signer.identity.sign(canonicalBytes(unsigned)) };
    const prepared = prepareEvents(state, head, signer, [{
      type: 'snapshot.written', body: { coversThrough: body.coversThrough, lamport: body.lamport, stateHash: body.stateHash, path: snapshotPath(body.lamport) }
    }], this.now);
    if (!Array.isArray(prepared)) return prepared;
    return { events: prepared, files: [{ path: snapshotPath(body.lamport), text: canonicalize(file) }] };
  }

  // D-25: re-fetch, then replay the whole log from genesis with a fresh state, so nothing a previous sync decided is trusted.
  // Read-side secret matches are warnings only: acceptance must never depend on the detector (D-23).
  public async verifyAll(): Promise<VerifyReport> {
    await this.transport.fetch();
    const entries = await this.transport.readAll();
    const state = createState(this.anchor);
    const secretWarnings: string[] = [];
    let events = 0;
    let replayed = 0;
    for (const entry of entries) {
      if (entry.kind === 'event') events += 1;
      const verdict = applyEntry(state, entry);
      if (verdict.accepted && verdict.event !== undefined) {
        for (const found of findSecrets(verdict.event.body)) secretWarnings.push(`${verdict.event.id}: ${found}`);
      }
      replayed += 1;
      if (replayed % this.yieldEvery === 0) await nextTurn();
    }
    const report: VerifyReport = {
      events,
      accepted: state.accepted,
      members: [...state.members.values()].map((member) => ({
        id: member.id, name: member.name, role: member.role, removed: member.removedEvent !== undefined,
        devices: member.devices.map((device) => ({ fingerprint: device.fingerprint, revoked: device.revokedEvent !== undefined }))
      })),
      head: { ...state.head },
      rejected: state.rejected.map((rejection) => ({ ...rejection })),
      unsupported: state.rejected.filter((rejection) => rejection.reason === R.unsupported).length,
      secretWarnings,
      snapshots: state.snapshots.length,
      status: this.transport.status()
    };
    if (state.refused !== undefined) report.refused = state.refused;
    return report;
  }
}
