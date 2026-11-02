// Signed-event factory for the team materialiser tests: actors with real Ed25519 keys generated at runtime, a signed event builder,
// committed-entry wrappers, genesis batches and a seeded PRNG. No key material is ever written to disk.
// The file has no .test suffix on purpose so the test glob does not run it as a suite.
import { canonicalBytes, canonicalize, eventPath, snapshotPath } from '../../domain/team/canonical';
import { applyEntry, checkCandidate, createState, reduce, snapshotBody, stateHash } from '../../domain/team/materialize';
import type { SnapshotBody, SnapshotFile } from '../../domain/team/materialize';
import { DEFAULT_WIP_LIMIT } from '../../domain/team/policy';
import { TEAM_REJECTION_REASONS } from '../../domain/team/types';
import type { CommittedEvent, GenesisAnchor, ImplementedEventBodies, ImplementedEventType, Role, TeamEvent, TeamEventBodyMap, TeamPolicy, TeamState, WorkItem } from '../../domain/team/types';
import { isCard } from '../../domain/team/work';
import { createDeviceIdentity, newEventId, newTeamId, signEvent } from '../../team/identity';
import type { DeviceIdentity } from '../../team/identity';
import { MemorySecrets, createOwner, testGenesis } from './teamHarness';

export interface TestActor { memberId: string; identity: DeviceIdentity; secrets: MemorySecrets }

export const FIXTURE_EVENT_ID = `evt-${'0'.repeat(26)}`;
export const FIXTURE_TIME = '2026-01-01T00:00:00.000Z';

export async function makeActor(teamId: string): Promise<TestActor> {
  const owner = await createOwner(teamId);
  return { memberId: owner.memberId, identity: owner.identity, secrets: owner.secrets };
}

// A second device for an existing member: same member id, a fresh key held in its own secret store.
export async function makeDevice(actor: TestActor): Promise<TestActor> {
  const secrets = new MemorySecrets();
  const identity = await createDeviceIdentity(secrets, actor.identity.teamId);
  return { memberId: actor.memberId, identity, secrets };
}

export interface SignedFields<T extends ImplementedEventType> {
  teamId: string;
  type: T;
  body: ImplementedEventBodies[T];
  lamport: number;
  prev: string;
  at?: string;
  id?: string;
}

export function signed<T extends ImplementedEventType>(actor: TestActor, fields: SignedFields<T>): TeamEvent<T> {
  return signEvent(actor.identity, {
    v: 1, id: fields.id ?? newEventId(), teamId: fields.teamId, type: fields.type, lamport: fields.lamport, at: fields.at ?? FIXTURE_TIME,
    author: actor.memberId, device: actor.identity.fingerprint, prev: fields.prev, body: fields.body as TeamEventBodyMap[T]
  });
}

export function entryOf(event: TeamEvent, options: { commit?: string; text?: string; path?: string } = {}): CommittedEvent {
  const text = options.text ?? canonicalize(event);
  return {
    commit: options.commit ?? 'c'.repeat(40), commitTime: 1, path: options.path ?? eventPath(event), blob: 'b'.repeat(40),
    size: Buffer.byteLength(text, 'utf8'), text, kind: 'event'
  };
}

// The two-event batch Enable Team Mode writes, as committed entries, plus the anchor a client pins from team.json.
export function genesisEntries(owner: TestActor, teamId: string, name = 'Materialiser test team'): { entries: CommittedEvent[]; anchor: GenesisAnchor } {
  const genesis = testGenesis({ teamId, owner, name });
  return { entries: genesis.events.map((event) => entryOf(event)), anchor: genesis.anchor };
}

// Test-only stand-in for Phase 61 joins. Phase 60 logs cannot contain a non-owner member (member.joined is owner-at-genesis only, D-07),
// so the read-side permission matrix is exercised by placing members straight into the state before their events are applied.
export function addFixtureMember(state: TeamState, actor: TestActor, role: Role, name = 'Fixture member'): void {
  state.members.set(actor.memberId, {
    id: actor.memberId, name, emailHashes: [], role,
    devices: [{ fingerprint: actor.identity.fingerprint, publicKey: actor.identity.publicKey, addedBy: actor.memberId, addedEvent: FIXTURE_EVENT_ID }],
    skills: [], availability: 'available', wipLimit: DEFAULT_WIP_LIMIT, joinedAt: FIXTURE_TIME, joinedEvent: FIXTURE_EVENT_ID
  });
  state.deviceIndex.set(actor.identity.fingerprint, actor.memberId);
}

// Small seeded PRNG (mulberry32) so a failing property run can be reproduced from its seed alone.
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A snapshot file signed by the actor. Overrides are applied before signing, so a test can build a validly signed snapshot that lies.
export function signedSnapshot(actor: TestActor, state: TeamState, overrides: Partial<SnapshotBody> = {}): SnapshotFile {
  const unsigned = { ...snapshotBody(state), ...overrides, author: actor.memberId, device: actor.identity.fingerprint };
  return { ...unsigned, sig: actor.identity.sign(canonicalBytes(unsigned)) };
}

export function snapshotWrittenBody(state: TeamState): ImplementedEventBodies['snapshot.written'] {
  return { coversThrough: state.head.eventId, lamport: state.head.lamport, stateHash: stateHash(state), path: snapshotPath(state.head.lamport) };
}

export interface Scenario {
  teamId: string;
  anchor: GenesisAnchor;
  owner: TestActor;
  // Every entry in log order, valid and forged.
  entries: CommittedEvent[];
  // The same log without the forged entries.
  valid: CommittedEvent[];
  // Each forged entry with the reason a reader must give for it, in log order.
  forged: Array<{ eventId: string; reason: string }>;
}

const SKILLS = ['rust', 'typescript', 'sql', 'docs', 'review', 'devops'];
const POLICY_CHANGES: Array<Partial<TeamPolicy>> = [
  { dispatchMode: 'auto' }, { dispatchMode: 'suggest' }, { teeOnly: true }, { teeOnly: false }, { offerTimeoutMinutes: 45 }, { peerMetricsVisible: true }, { sharedPaths: ['package.json', 'CHANGELOG.md'] }
];

export interface ScenarioOptions {
  // Mix work item events into the valid events. Off by default: a seed's roster-only log is a pinned sequence and must not move.
  items?: boolean;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ITEM_SCOPES = [['src/a/**'], ['src/b/**', 'docs/**'], ['package.json']];

// A seeded log of about `length` entries: valid events from two owner devices mixed with forged ones. The first valid snapshot.written is
// placed before any forgery. The snapshot hash no longer covers state.rejected (WR-07), so the placement is kept only to leave the seeded scenarios as they were.
// Every entry is also run through a live state, which both chooses the next valid Lamport and asserts each entry gets the planned verdict.
export async function buildScenario(seed: number, length: number, options: ScenarioOptions = {}): Promise<Scenario> {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const second = await makeDevice(owner);
  const stranger = await makeActor(teamId);
  const otherTeam = newTeamId();
  const { entries: genesis, anchor } = genesisEntries(owner, teamId);
  const live = reduce(genesis, anchor);
  const entries: CommittedEvent[] = [...genesis];
  const valid: CommittedEvent[] = [...genesis];
  const forged: Array<{ eventId: string; reason: string }> = [];
  let secondAdded = false;
  let secondRevoked = false;
  let snapshotted = false;
  const at = (offset = 1): { teamId: string; lamport: number; prev: string } => ({ teamId, lamport: live.highLamport + offset, prev: live.head.eventId });
  const accepted = (event: TeamEvent): void => {
    const entry = entryOf(event);
    const verdict = applyEntry(live, entry);
    if (!verdict.accepted) throw new Error(`seed ${seed}: planned valid ${event.type} was rejected: ${verdict.rejection.reason}`);
    entries.push(entry);
    valid.push(entry);
  };
  const rejected = (entry: CommittedEvent, eventId: string, reason: string): void => {
    const verdict = applyEntry(live, entry);
    if (verdict.accepted || verdict.rejection.reason !== reason) throw new Error(`seed ${seed}: planned forgery ${eventId} expected "${reason}"`);
    entries.push(entry);
    forged.push({ eventId, reason });
  };
  const signer = (): TestActor => (secondAdded && !secondRevoked && random() < 0.5 ? { ...second } : owner);
  // Work item events are drawn only when the option is on, so a roster-only seed draws exactly the numbers it always did. The candidate is
  // checked on a copy of the live state first: an event the rules would refuse at this position is simply not written (nothing is forged).
  const boardId = (): string => `item:${Array.from({ length: 26 }, () => CROCKFORD[Math.floor(random() * 32)]).join('')}`;
  const itemIntent = (): { type: ImplementedEventType; body: unknown } => {
    const all = [...live.items.values()];
    const of = (kind: string): WorkItem[] => all.filter((entry) => entry.kind === kind);
    const cards = all.filter(isCard);
    const milestone = of('milestone')[0];
    const common = { dependsOn: [] as string[], scope: [] as string[], requirements: [] as string[], mustHaves: [] as string[], tags: [] as string[], state: 'backlog' as const };
    if (milestone === undefined) return { type: 'item.imported', body: { ...common, id: 'milestone:v1.0.0', kind: 'milestone', title: 'Version 1.0.0' } };
    const roll = random();
    const phases = of('phase');
    const plans = of('plan');
    const target = (entries: WorkItem[]): string => (entries.length === 0 ? 'plan:99-99' : (pick(entries) as WorkItem).id);
    if (roll < 0.12 || phases.length === 0) {
      const number = phases.length + 1;
      const previous = phases.length > 0 && random() < 0.4 ? [(pick(phases) as WorkItem).id] : [];
      return { type: 'item.imported', body: { ...common, id: `phase:${number}`, kind: 'phase', title: `Phase ${number}`, parentId: milestone.id, dependsOn: previous } };
    }
    if (roll < 0.35) {
      const phase = pick(phases);
      const number = plans.filter((entry) => entry.parentId === phase.id).length + 1;
      const label = `${phase.id.slice(6)}-${String(number).padStart(2, '0')}`;
      const dependsOn = plans.length > 0 && random() < 0.35 ? [(pick(plans) as WorkItem).id] : [];
      const body: Record<string, unknown> = { ...common, id: `plan:${label}`, kind: 'plan', title: `Plan ${label}`, parentId: phase.id, dependsOn, state: random() < 0.15 ? 'done' : 'backlog' };
      if (random() < 0.85) body.scope = pick(ITEM_SCOPES);
      if (random() < 0.85) body.estimate = { tokens: 1000 * (1 + Math.floor(random() * 90)) };
      return { type: 'item.imported', body };
    }
    if (roll < 0.43) {
      const plan = pick(plans.length === 0 ? [{ id: 'plan:99-99' } as WorkItem] : plans);
      return { type: 'item.imported', body: { ...common, id: `task:${plan.id.slice(5)}-${1 + Math.floor(random() * 9)}`, kind: 'task', title: 'A task', parentId: plan.id } };
    }
    if (roll < 0.56) {
      const body: Record<string, unknown> = { id: boardId(), kind: pick(['bug', 'chore', 'spike'] as const), title: `Board item ${Math.floor(random() * 1000)}`, scope: pick(ITEM_SCOPES), requirements: [], mustHaves: [] };
      if (random() < 0.7) body.estimate = { tokens: 500 * (1 + Math.floor(random() * 40)) };
      return { type: 'item.created', body };
    }
    if (roll < 0.64) return { type: 'item.blocked', body: { id: target(cards), reason: 'waiting on an answer' } };
    if (roll < 0.70) return { type: 'item.unblocked', body: { id: target(cards.filter((entry) => entry.blocked !== undefined)) } };
    if (roll < 0.78) return { type: 'item.updated', body: { id: target([...cards, ...phases]), changes: { hold: random() < 0.6 } } };
    if (roll < 0.86) return { type: 'item.updated', body: { id: target(cards), changes: { state: 'done' } } };
    if (roll < 0.90) return { type: 'item.estimated', body: { id: target(cards.filter((entry) => entry.origin === 'board')), estimate: { tokens: 700 * (1 + Math.floor(random() * 30)) } } };
    if (roll < 0.95) return { type: 'item.cancelled', body: { id: target(cards), reason: 'not needed any more' } };
    return { type: 'item.reopened', body: { id: target(cards.filter((entry) => entry.state === 'done' || entry.state === 'cancelled')) } };
  };
  const addItem = (): boolean => {
    const intent = itemIntent();
    const event = signed(signer(), { ...at(), type: intent.type, body: intent.body as never });
    if (checkCandidate(live, [event]) !== undefined) return false;
    accepted(event);
    return true;
  };
  const addValid = (): void => {
    if (options.items === true && random() < 0.6 && addItem()) return;
    const roll = random();
    if (!secondAdded) {
      secondAdded = true;
      accepted(signed(owner, { ...at(), type: 'device.added', body: { memberId: owner.memberId, device: { fingerprint: second.identity.fingerprint, publicKey: second.identity.publicKey } } }));
    } else if (roll < 0.1 && !secondRevoked) {
      secondRevoked = true;
      accepted(signed(owner, { ...at(), type: 'device.revoked', body: { memberId: owner.memberId, fingerprint: second.identity.fingerprint } }));
    } else if (roll < 0.45) {
      accepted(signed(signer(), { ...at(1 + Math.floor(random() * 5)), type: 'member.availability', body: { availability: pick(['available', 'focus', 'away', 'offline'] as const) } }));
    } else if (roll < 0.7) {
      const skills = SKILLS.filter(() => random() < 0.4);
      accepted(signed(signer(), { ...at(), type: 'member.skills', body: { memberId: owner.memberId, skills } }));
    } else {
      accepted(signed(owner, { ...at(), type: 'policy.changed', body: { changes: pick(POLICY_CHANGES) } }));
    }
  };
  const addForgery = (): void => {
    const kind = Math.floor(random() * 10);
    const reasons = TEAM_REJECTION_REASONS;
    if (kind === 0) {
      const event = signed(owner, { ...at(), type: 'member.availability', body: { availability: 'away' } });
      const tampered = { ...event, body: { availability: 'focus' as const } };
      rejected(entryOf(tampered), event.id, reasons.badSignature);
    } else if (kind === 1) {
      const event = signEvent(stranger.identity, {
        v: 1, id: newEventId(), teamId, type: 'member.availability', lamport: live.highLamport + 1, at: '2026-01-01T00:00:00.000Z', author: owner.memberId,
        device: stranger.identity.fingerprint, prev: live.head.eventId, body: { availability: 'away' }
      });
      rejected(entryOf(event), event.id, reasons.unboundDevice);
    } else if (kind === 2) {
      const event = signed(owner, { ...at(0), type: 'member.availability', body: { availability: 'away' } });
      rejected(entryOf(event), event.id, reasons.lamportNotGreater);
    } else if (kind === 3) {
      const event = signed(owner, { ...at(1001 + Math.floor(random() * 500)), type: 'member.availability', body: { availability: 'away' } });
      rejected(entryOf(event), event.id, reasons.lamportJump);
    } else if (kind === 4) {
      const events = valid.filter((entry) => entry.kind === 'event');
      const replay = pick(events);
      rejected(replay, (JSON.parse(replay.text) as { id: string }).id, reasons.duplicate);
    } else if (kind === 5) {
      const event = signed(owner, { ...at(), teamId: otherTeam, type: 'member.availability', body: { availability: 'away' } });
      rejected(entryOf(event), event.id, reasons.wrongTeam);
    } else if (kind === 6) {
      const event = signed(owner, { ...at(), type: 'member.role-changed', body: { memberId: owner.memberId, role: 'lead' } });
      rejected(entryOf(event), event.id, `${reasons.notPermitted}: nobody can change their own role`);
    } else if (kind === 7) {
      const body = snapshotWrittenBody(live);
      const event = signed(owner, { ...at(), type: 'snapshot.written', body: { ...body, stateHash: stateHash(createState(anchor)) } });
      rejected(entryOf(event), event.id, reasons.snapshotMismatch);
    } else if (kind === 8) {
      const orphan: CommittedEvent = { commit: 'c'.repeat(40), commitTime: 1, path: snapshotPath(live.highLamport + 7), blob: 'b'.repeat(40), size: 2, text: '{}', kind: 'snapshot' };
      rejected(orphan, orphan.path, reasons.snapshotOrphan);
    } else {
      const event = signed(owner, { ...at(), type: 'member.removed', body: { memberId: owner.memberId } });
      rejected(entryOf(event), event.id, `${reasons.notPermitted}: the owner cannot be removed`);
    }
  };
  const forgeryStart = 8 + Math.floor(random() * 4);
  const snapshotAt = 3 + Math.floor(random() * (forgeryStart - 3));
  while (entries.length < length) {
    if (!snapshotted && entries.length >= snapshotAt && entries.length < forgeryStart && secondAdded) {
      snapshotted = true;
      const body = snapshotWrittenBody(live);
      accepted(signed(owner, { ...at(), type: 'snapshot.written', body }));
      const file: CommittedEvent = { commit: 'c'.repeat(40), commitTime: 1, path: body.path, blob: 'b'.repeat(40), size: 2, text: '{}', kind: 'snapshot' };
      const verdict = applyEntry(live, file);
      if (!verdict.accepted) throw new Error(`seed ${seed}: the snapshot file was not accepted`);
      entries.push(file);
      valid.push(file);
    } else if (entries.length >= forgeryStart && random() < 0.3) {
      addForgery();
    } else {
      addValid();
    }
  }
  return { teamId, anchor, owner, entries, valid, forged };
}
