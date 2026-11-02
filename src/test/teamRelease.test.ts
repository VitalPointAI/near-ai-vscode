// Removal releases everything the member held (Phase 61 plan 06, D-19), in the one place every client agrees on: the materialiser.
// Claims, leases and allocations have no events until Phases 63 and 66, so the fixtures place them straight into a live TeamState.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { canonicalize } from '../domain/team/canonical';
import { expectedJoinRole, joinProofBytes, sealCapableFingerprints } from '../domain/team/invite';
import { STATE_HASH_VERSION, applyEntry, createState, deserialiseState, parseSnapshotFile, reduce, serialiseState, stateHash } from '../domain/team/materialize';
import { INVITABLE_ROLES, TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { Allocation, Claim, CommittedEvent, GenesisAnchor, JsonObject, Lease, TeamEvent, TeamState, WorkItem } from '../domain/team/types';
import { createSealIdentity, emailHash, newMemberId, newTeamId } from '../team/identity';
import type { SealIdentity } from '../team/identity';
import { deriveInviteKey, generateInviteCode } from '../team/inviteCode';
import { SEAL_SCHEME, sealTo } from '../team/keySeal';
import { addFixtureMember, entryOf, genesisEntries, makeActor, mulberry32, signed, signedSnapshot } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';

const NO_SPEND = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, confirmedNanoUsd: 0, pendingNanoUsd: 0, estimatedNanoUsd: 0, requests: 0 };

interface Cast { teamId: string; anchor: GenesisAnchor; owner: TestActor; lead: TestActor; devA: TestActor; devB: TestActor; genesis: ReturnType<typeof genesisEntries>['entries'] }

async function makeCast(): Promise<Cast> {
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const lead = await makeActor(teamId);
  const devA = await makeActor(teamId);
  const devB = await makeActor(teamId);
  const { entries, anchor } = genesisEntries(owner, teamId);
  return { teamId, anchor, owner, lead, devA, devB, genesis: entries };
}

function claim(id: string, itemId: string, memberId: string, status: Claim['status'], leaseIds: string[] = []): Claim {
  return { id, itemId, memberId, branch: `near-ai/${itemId}/${memberId.slice(-4)}`, base: 'main', leaseIds, startedAt: '2026-01-01T00:00:00.000Z', lastHeartbeatAt: '2026-01-01T00:00:00.000Z', status, spend: { ...NO_SPEND, confirmedNanoUsd: 7 } };
}

function item(id: string, state: WorkItem['state'], claimId?: string): WorkItem {
  const base: WorkItem = { id, kind: 'task', title: `Item ${id}`, dependsOn: [], scope: [], requirements: [], mustHaves: [], state, tags: [] };
  if (claimId !== undefined) base.claimId = claimId;
  return base;
}

function lease(id: string, holder: string, kind: Lease['kind'], claimId?: string): Lease {
  const base: Lease = { id, holder, kind, grantedAt: '2026-01-01T00:00:00.000Z', ttlMinutes: 30 };
  if (kind === 'paths') base.paths = ['src/a.ts'];
  else base.resource = 'database';
  if (claimId !== undefined) base.claimId = claimId;
  return base;
}

function allocation(id: string, memberId: string, nanoUsd: number): Allocation {
  return { id, memberId, nanoUsd, period: '2026-01', grantedBy: 'lead' };
}

// Genesis, then the lead and both developers as joined members, then the work the removal has to deal with.
function fixtureState(cast: Cast): TeamState {
  const state = reduce(cast.genesis, cast.anchor);
  addFixtureMember(state, cast.lead, 'lead', 'Lead');
  addFixtureMember(state, cast.devA, 'developer', 'Developer A');
  addFixtureMember(state, cast.devB, 'developer', 'Developer B');
  const a = cast.devA.memberId;
  const b = cast.devB.memberId;
  const claims = [
    claim('claim-a1', 'item-1', a, 'active', ['lease-a1']), claim('claim-a2', 'item-2', a, 'in-review'), claim('claim-a3', 'item-3', a, 'merged'),
    claim('claim-a4', 'item-4', a, 'expired'), claim('claim-a5', 'item-5', a, 'integrating'), claim('claim-b1', 'item-6', b, 'active', ['lease-b1'])
  ];
  for (const entry of claims) state.claims.set(entry.id, entry);
  state.items.set('item-1', item('item-1', 'in-progress', 'claim-a1'));
  state.items.set('item-2', item('item-2', 'in-review', 'claim-a2'));
  state.items.set('item-3', item('item-3', 'done', 'claim-a3'));
  state.items.set('item-4', item('item-4', 'ready'));
  state.items.set('item-5', item('item-5', 'integrating', 'claim-a5'));
  state.items.set('item-6', item('item-6', 'in-progress', 'claim-b1'));
  state.items.set('item-7', item('item-7', 'cancelled'));
  for (const entry of [
    lease('lease-a1', a, 'paths', 'claim-a1'), lease('lease-a-direct', a, 'resource'), lease('lease-lead-on-a2', cast.lead.memberId, 'paths', 'claim-a2'),
    lease('lease-b1', b, 'paths', 'claim-b1'), lease('lease-b-direct', b, 'resource')
  ]) state.leases.set(entry.id, entry);
  state.allocations = [allocation('alloc-a1', a, 100), allocation('alloc-b1', b, 200), allocation('alloc-a2', a, 50), allocation('alloc-lead', cast.lead.memberId, 300)];
  state.integrationQueue = ['claim-a1', 'claim-b1', 'claim-a5'];
  return state;
}

function nextEvent<T extends 'member.removed' | 'member.availability'>(state: TeamState, cast: Cast, actor: TestActor, type: T, body: T extends 'member.removed' ? { memberId: string } : { availability: 'away' }): TeamEvent<T> {
  return signed(actor, { teamId: cast.teamId, type, lamport: state.highLamport + 1, prev: state.head.eventId, body } as never) as TeamEvent<T>;
}

// A plain-object dump of everything release touches, in insertion order, for comparing two clients.
function dump(state: TeamState): unknown {
  return {
    claims: [...state.claims.entries()], items: [...state.items.entries()], leases: [...state.leases.entries()],
    allocations: state.allocations, queue: state.integrationQueue
  };
}

test('tracer: a lead removes a member holding claims, leases and allocations and every client releases them the same way', async () => {
  const cast = await makeCast();
  const first = fixtureState(cast);
  const second = fixtureState(cast);
  const a = cast.devA.memberId;
  const b = cast.devB.memberId;

  // A's availability before the removal is accepted (positional rule: events before the removal stay valid).
  const before = nextEvent(first, cast, cast.devA, 'member.availability', { availability: 'away' });
  const beforeEntry = entryOf(before);
  assert.equal(applyEntry(first, beforeEntry).accepted, true);
  assert.equal(applyEntry(second, beforeEntry).accepted, true);
  const snapshotOfB = JSON.stringify([first.claims.get('claim-b1'), first.items.get('item-6'), first.leases.get('lease-b1'), first.leases.get('lease-b-direct'), first.allocations.filter((entry) => entry.memberId === b)]);
  const mergedClaim = JSON.stringify(first.claims.get('claim-a3'));
  const expiredClaim = JSON.stringify(first.claims.get('claim-a4'));
  const doneItem = JSON.stringify(first.items.get('item-3'));

  const removal = nextEvent(first, cast, cast.lead, 'member.removed', { memberId: a });
  const removalEntry = entryOf(removal);
  const verdict = applyEntry(first, removalEntry);
  assert.equal(verdict.accepted, true, verdict.accepted ? '' : verdict.rejection.reason);
  assert.equal(applyEntry(second, removalEntry).accepted, true);

  // The active, in-review and integrating claims are released, the branch is kept, and the items are back in the pool.
  for (const [claimId, itemId] of [['claim-a1', 'item-1'], ['claim-a2', 'item-2'], ['claim-a5', 'item-5']] as const) {
    const released = first.claims.get(claimId);
    assert.equal(released?.status, 'released', claimId);
    assert.equal(released?.branch, claim(claimId, itemId, a, 'active').branch, `${claimId} keeps its branch name`);
    assert.equal(released?.base, 'main');
    assert.equal(released?.spend.confirmedNanoUsd, 7, `${claimId} keeps its spend`);
    const freed = first.items.get(itemId);
    assert.equal(freed?.state, 'ready', itemId);
    assert.equal('claimId' in (freed ?? {}), false, `${itemId} has no claimId`);
  }
  // Merged, expired and done work is history and stays as it was.
  assert.equal(JSON.stringify(first.claims.get('claim-a3')), mergedClaim);
  assert.equal(JSON.stringify(first.claims.get('claim-a4')), expiredClaim);
  assert.equal(JSON.stringify(first.items.get('item-3')), doneItem);
  assert.equal(first.items.get('item-7')?.state, 'cancelled');
  // Leases the member held, and leases that belonged to a released claim, are gone; the other developer keeps theirs.
  assert.deepEqual([...first.leases.keys()], ['lease-b1', 'lease-b-direct']);
  // Allocations of the member are removed, the rest stay in order.
  assert.deepEqual(first.allocations.map((entry) => entry.id), ['alloc-b1', 'alloc-lead']);
  // The queue loses every released claim and keeps the other developer's.
  assert.deepEqual(first.integrationQueue, ['claim-b1']);
  assert.equal(first.integrationQueue.includes('claim-a1'), false);
  assert.equal(first.integrationQueue.includes('claim-a5'), false);
  // Developer B is untouched.
  assert.equal(JSON.stringify([first.claims.get('claim-b1'), first.items.get('item-6'), first.leases.get('lease-b1'), first.leases.get('lease-b-direct'), first.allocations.filter((entry) => entry.memberId === b)]), snapshotOfB);

  // Removal is positional through removedEvent: no device of the member is revoked.
  const removed = first.members.get(a);
  assert.equal(removed?.removedEvent, removal.id);
  assert.ok(removed !== undefined && removed.devices.length > 0);
  for (const device of removed?.devices ?? []) assert.equal(device.revokedEvent, undefined);

  // Two clients computed the same release.
  assert.deepEqual(dump(first), dump(second));

  // An event signed by the removed member's device after the removal is rejected; the one before stays accepted.
  const after = nextEvent(first, cast, cast.devA, 'member.availability', { availability: 'away' });
  const late = applyEntry(first, entryOf(after));
  assert.equal(late.accepted, false);
  assert.equal(late.accepted ? '' : late.rejection.reason, TEAM_REJECTION_REASONS.removedAuthor);
  assert.ok(first.seenEventIds.has(before.id));
});

test('removing a joined member who holds nothing changes only the member record', async () => {
  const cast = await makeCast();
  const state = reduce(cast.genesis, cast.anchor);
  addFixtureMember(state, cast.lead, 'lead', 'Lead');
  addFixtureMember(state, cast.devA, 'developer', 'Developer A');
  const removal = nextEvent(state, cast, cast.lead, 'member.removed', { memberId: cast.devA.memberId });
  assert.equal(applyEntry(state, entryOf(removal)).accepted, true);
  assert.equal(state.claims.size + state.leases.size + state.allocations.length + state.integrationQueue.length, 0);
  assert.equal(createState(cast.anchor).claims.size, 0);
});

test('cancelling an invitation only marks the record removed and releases nothing', async () => {
  const cast = await makeCast();
  const state = fixtureState(cast);
  const memberId = newMemberId();
  const code = generateInviteCode();
  const invited = signed(cast.lead, {
    teamId: cast.teamId, type: 'member.invited', lamport: state.highLamport + 1, prev: state.head.eventId,
    body: { memberId, name: 'Invited Ines', emailHashes: [emailHash(cast.teamId, 'ines@example.invalid')], role: 'developer', allocationNanoUsd: 1, ttlSeconds: 604_800, invite: { publicKey: deriveInviteKey(code.bytes, cast.teamId, memberId).publicKey } }
  });
  assert.equal(applyEntry(state, entryOf(invited)).accepted, true);
  // An invited member cannot hold work, so any entry that names the id is left alone by a cancel.
  state.allocations.push(allocation('alloc-invited', memberId, 9));
  state.leases.set('lease-invited', lease('lease-invited', memberId, 'resource'));
  const before = JSON.stringify(dump(state));
  const cancel = signed(cast.lead, { teamId: cast.teamId, type: 'member.removed', lamport: state.highLamport + 1, prev: state.head.eventId, body: { memberId } });
  const verdict = applyEntry(state, entryOf(cancel));
  assert.equal(verdict.accepted, true, verdict.accepted ? '' : verdict.rejection.reason);
  assert.equal(state.members.get(memberId)?.removedEvent, cancel.id);
  assert.equal(JSON.stringify(dump(state)), before);
});

// ---- Snapshot compatibility and determinism for this phase's member fields (Pitfall 9) ----------------------------------------------

type Stage = 'fresh' | 'invited' | 'cancelled' | 'joined' | 'removed';
interface Candidate { actor: TestActor; seal: SealIdentity; code: ReturnType<typeof generateInviteCode>; stage: Stage; email: string }
interface Counts { invited: number; joined: number; confirmed: number; sealed: number; cancelled: number; removed: number; late: number }

// A team that grows by signed events only: every event is built by the right actor and applied to a live state, which both chooses the
// next Lamport and asserts the verdict the generator planned.
class World {
  public readonly entries: CommittedEvent[];
  public readonly live: TeamState;
  public readonly candidates: Candidate[] = [];
  public readonly sealedKeyIds = new Map<string, string[]>();
  public readonly counts: Counts = { invited: 0, joined: 0, confirmed: 0, sealed: 0, cancelled: 0, removed: 0, late: 0 };
  private keyCounter = 0;

  private constructor(public readonly teamId: string, public readonly anchor: GenesisAnchor, public readonly owner: TestActor, genesis: CommittedEvent[]) {
    this.entries = [...genesis];
    this.live = reduce(genesis, anchor);
  }

  public static async create(candidateCount: number): Promise<World> {
    const teamId = newTeamId();
    const owner = await makeActor(teamId);
    const { entries, anchor } = genesisEntries(owner, teamId);
    const world = new World(teamId, anchor, owner, entries);
    for (let index = 0; index < candidateCount; index += 1) {
      const actor = await makeActor(teamId);
      world.candidates.push({ actor, seal: await createSealIdentity(actor.secrets, teamId), code: generateInviteCode(), stage: 'fresh', email: `person${index}@example.invalid` });
    }
    return world;
  }

  public next(offset = 1): { teamId: string; lamport: number; prev: string } {
    return { teamId: this.teamId, lamport: this.live.highLamport + offset, prev: this.live.head.eventId };
  }

  // Applies one planned event; a different verdict than planned is a bug in the generator or in the materialiser, and names the event.
  public apply(event: TeamEvent, expectedReason?: string): void {
    const entry = entryOf(event);
    const verdict = applyEntry(this.live, entry);
    this.entries.push(entry);
    if (expectedReason === undefined) assert.equal(verdict.accepted, true, `${event.type} was rejected: ${verdict.accepted ? '' : verdict.rejection.reason}`);
    else assert.equal(verdict.accepted ? 'accepted' : verdict.rejection.reason, expectedReason, `${event.type} verdict`);
  }

  public invite(candidate: Candidate, signer: TestActor, role: (typeof INVITABLE_ROLES)[number]): void {
    const memberId = candidate.actor.memberId;
    this.apply(signed(signer, {
      ...this.next(), type: 'member.invited',
      body: { memberId, name: `Candidate ${memberId.slice(-4)}`, emailHashes: [emailHash(this.teamId, candidate.email)], role, allocationNanoUsd: 1_000_000_000, ttlSeconds: 604_800, invite: { publicKey: deriveInviteKey(candidate.code.bytes, this.teamId, memberId).publicKey } }
    }));
    candidate.stage = 'invited';
    this.counts.invited += 1;
  }

  public join(candidate: Candidate): void {
    const memberId = candidate.actor.memberId;
    const member = this.live.members.get(memberId);
    if (member === undefined || member.invite === undefined) throw new Error('join needs an invitation on record');
    const identity = candidate.actor.identity;
    const device = { fingerprint: identity.fingerprint, publicKey: identity.publicKey };
    const sig = deriveInviteKey(candidate.code.bytes, this.teamId, memberId).sign(joinProofBytes(this.teamId, memberId, member.invite.eventId, device, candidate.seal.publicKey));
    this.apply(signed(candidate.actor, {
      ...this.next(), type: 'member.joined',
      body: { memberId, name: member.name, emailHashes: [...member.emailHashes], role: expectedJoinRole(member.pendingRole ?? 'observer', this.live.team.policy), device, invite: { sig }, sealKey: { publicKey: candidate.seal.publicKey } }
    }));
    candidate.stage = 'joined';
    this.counts.joined += 1;
  }

  public confirm(candidate: Candidate, role: (typeof INVITABLE_ROLES)[number]): void {
    this.apply(signed(this.owner, { ...this.next(), type: 'member.role-changed', body: { memberId: candidate.actor.memberId, role } }));
    this.counts.confirmed += 1;
  }

  public seal(candidate: Candidate, signer: TestActor, jump = 1): void {
    const memberId = candidate.actor.memberId;
    const member = this.live.members.get(memberId);
    if (member === undefined) throw new Error('seal needs a member');
    this.keyCounter += 1;
    const keyId = `key_${this.keyCounter.toString(16).padStart(6, '0')}${randomBytes(4).toString('hex')}`;
    const sealed = sealCapableFingerprints(member).map((fingerprint) => {
      const device = member.devices.find((candidateDevice) => candidateDevice.fingerprint === fingerprint);
      if (device?.sealKey === undefined) throw new Error('a seal-capable device has a seal key');
      return sealTo(randomBytes(32), device.sealKey, { teamId: this.teamId, memberId, device: fingerprint, keyId });
    });
    this.apply(signed(signer, { ...this.next(jump), type: 'member.key-sealed', body: { memberId, keyId, scheme: SEAL_SCHEME, sealed } }));
    this.sealedKeyIds.set(memberId, [...(this.sealedKeyIds.get(memberId) ?? []), keyId]);
    this.counts.sealed += 1;
  }

  public cancel(candidate: Candidate): void {
    this.apply(signed(this.owner, { ...this.next(), type: 'member.removed', body: { memberId: candidate.actor.memberId } }));
    candidate.stage = 'cancelled';
    this.counts.cancelled += 1;
  }

  public remove(candidate: Candidate): void {
    this.apply(signed(this.owner, { ...this.next(), type: 'member.removed', body: { memberId: candidate.actor.memberId } }));
    candidate.stage = 'removed';
    this.counts.removed += 1;
  }

  public availability(candidate: Candidate, expectedReason?: string): void {
    this.apply(signed(candidate.actor, { ...this.next(), type: 'member.availability', body: { availability: 'focus' } }), expectedReason);
    if (expectedReason !== undefined) this.counts.late += 1;
  }

  public activeLead(): TestActor | undefined {
    const lead = this.candidates.find((candidate) => candidate.stage === 'joined' && this.live.members.get(candidate.actor.memberId)?.role === 'lead');
    return lead?.actor;
  }
}

// One seeded log of 30 to 60 events that mixes invites, joins with code proof, confirms, sealed keys, cancels and removals.
async function seededWorld(seed: number): Promise<World> {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const world = await World.create(7);
  const target = 30 + Math.floor(random() * 31);
  const inStage = (stage: Stage): Candidate[] => world.candidates.filter((candidate) => candidate.stage === stage);
  const signer = (): TestActor => {
    const lead = world.activeLead();
    return lead !== undefined && random() < 0.4 ? lead : world.owner;
  };
  while (world.entries.length - 2 < target) {
    const fresh = inStage('fresh');
    const invited = inStage('invited');
    const joined = inStage('joined');
    const removed = inStage('removed');
    const roll = random();
    if (fresh.length > 0 && (roll < 0.2 || joined.length + invited.length === 0)) world.invite(pick(fresh), signer(), pick(INVITABLE_ROLES));
    else if (invited.length > 0 && roll < 0.4) world.join(pick(invited));
    else if (invited.length > 0 && roll < 0.47) world.cancel(pick(invited));
    else if (joined.length > 0 && roll < 0.6) world.confirm(pick(joined), pick(INVITABLE_ROLES));
    else if (joined.length > 0 && roll < 0.82) world.seal(pick(joined), signer(), 1 + Math.floor(random() * 3));
    else if (joined.length > 0 && roll < 0.88) world.remove(pick(joined));
    else if (removed.length > 0 && roll < 0.93) world.availability(pick(removed), TEAM_REJECTION_REASONS.removedAuthor);
    else if (joined.length > 0) world.availability(pick(joined));
    else if (invited.length > 0) world.join(pick(invited));
    else if (fresh.length > 0) world.invite(pick(fresh), world.owner, 'developer');
  }
  return world;
}

const PHASE60_MEMBER_KEYS = ['availability', 'devices', 'emailHashes', 'id', 'joinedAt', 'joinedEvent', 'name', 'role', 'skills', 'wipLimit'];

test('invited and joined members with every new field round-trip through the snapshot form with an unchanged hash', async () => {
  const world = await World.create(2);
  const [invited, joined] = world.candidates as [Candidate, Candidate];
  world.invite(joined, world.owner, 'developer');
  world.join(joined);
  world.confirm(joined, 'developer');
  world.seal(joined, world.owner);
  world.seal(joined, world.owner);
  world.invite(invited, world.owner, 'lead');
  const pending = world.live.members.get(invited.actor.memberId);
  const member = world.live.members.get(joined.actor.memberId);
  assert.equal(pending?.status, 'invited');
  assert.ok(pending?.invite !== undefined && pending.invitedEvent !== undefined && pending.pendingRole === 'lead' && pending.allocationNanoUsd === 1_000_000_000);
  assert.equal(member?.devices[0]?.sealKey, joined.seal.publicKey);
  assert.ok(member?.nearApiKeyId !== undefined && member.nearKeyEvent !== undefined);
  assert.deepEqual(member?.nearKeyDevices, [joined.actor.identity.fingerprint]);
  assert.equal(member?.retiredNearKeyIds?.length, 1);

  const text = serialiseState(world.live);
  const restored = deserialiseState(JSON.parse(text) as JsonObject, world.anchor);
  assert.equal(stateHash(restored), stateHash(world.live));
  assert.equal(serialiseState(restored), text);
  assert.deepEqual(restored.members.get(invited.actor.memberId), pending);
  assert.deepEqual(restored.members.get(joined.actor.memberId), member);

  // The same state also loads as a signed snapshot file written by the owner.
  const file = signedSnapshot(world.owner, world.live);
  const parsed = parseSnapshotFile(canonicalize(file), world.anchor);
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.reason);
  assert.equal(parsed.ok ? stateHash(parsed.state) : '', stateHash(world.live));
});

test('a Phase 60 log keeps its hash and serialised text has none of the new member keys; the hash version is still 1', async () => {
  assert.equal(STATE_HASH_VERSION, 1);
  const teamId = newTeamId();
  const owner = await makeActor(teamId);
  const { entries, anchor } = genesisEntries(owner, teamId);
  const state = reduce(entries, anchor);
  for (const event of [
    signed(owner, { teamId, type: 'member.skills', lamport: state.highLamport + 1, prev: state.head.eventId, body: { memberId: owner.memberId, skills: ['rust', 'docs'] } })
  ]) assert.equal(applyEntry(state, entryOf(event)).accepted, true);
  assert.equal(applyEntry(state, entryOf(signed(owner, { teamId, type: 'member.availability', lamport: state.highLamport + 1, prev: state.head.eventId, body: { availability: 'focus' } }))).accepted, true);

  const text = serialiseState(state);
  for (const key of ['status', 'invite', 'invitedEvent', 'pendingRole', 'allocationNanoUsd', 'sealKey', 'nearApiKeyId', 'nearKeyDevices', 'nearKeyEvent', 'retiredNearKeyIds']) assert.equal(text.includes(`"${key}"`), false, `${key} is left out`);
  const plain = JSON.parse(text) as { members: Array<Record<string, unknown>> } & Record<string, unknown>;
  for (const member of plain.members) assert.deepEqual(Object.keys(member).sort(), PHASE60_MEMBER_KEYS);
  // The Phase 60 hash recipe, written out again from the serialised text only: version 1 plus the state without the bookkeeping lists.
  const reference: Record<string, unknown> = { hashVersion: 1, ...plain };
  for (const key of ['accepted', 'seenEventIds', 'rejected', 'snapshots']) delete reference[key];
  assert.equal(stateHash(state), createHash('sha256').update(canonicalize(reference as never)).digest('hex'));

  // A Phase 60 snapshot still loads with the hash it was written with.
  const file = signedSnapshot(owner, state);
  assert.equal(file.stateHash, stateHash(state));
  const parsed = parseSnapshotFile(canonicalize(file), anchor);
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.reason);
  assert.equal(parsed.ok ? stateHash(parsed.state) : '', file.stateHash);
});

test('for 20 seeds a log of invites, joins, confirms, sealed keys, cancels and removals replays identically and keeps the key invariant', async () => {
  const totals: Counts = { invited: 0, joined: 0, confirmed: 0, sealed: 0, cancelled: 0, removed: 0, late: 0 };
  let withRetired = 0;
  for (let seed = 1; seed <= 20; seed += 1) {
    const world = await seededWorld(seed);
    for (const key of Object.keys(totals) as Array<keyof Counts>) totals[key] += world.counts[key];
    assert.ok(world.entries.length - 2 >= 30 && world.entries.length - 2 <= 60, `seed ${seed}: ${world.entries.length - 2} events`);

    // Replaying the same log twice gives byte-identical state, and so does the live state the generator grew one entry at a time.
    const once = serialiseState(reduce(world.entries, world.anchor));
    assert.equal(serialiseState(reduce(world.entries, world.anchor)), once, `seed ${seed}: replay twice`);
    assert.equal(serialiseState(world.live), once, `seed ${seed}: incremental versus one reduce`);
    // Resuming from a state reduced to the middle of the log lands on the same bytes.
    const middle = Math.floor(world.entries.length / 2);
    const resumed = reduce(world.entries.slice(0, middle), world.anchor);
    for (const entry of world.entries.slice(middle)) applyEntry(resumed, entry);
    assert.equal(serialiseState(resumed), once, `seed ${seed}: resumed from the middle`);
    // The final state loads from its own snapshot form with the same hash.
    const restored = deserialiseState(JSON.parse(once) as JsonObject, world.anchor);
    assert.equal(stateHash(restored), stateHash(world.live), `seed ${seed}: snapshot round trip`);

    // Key invariant: the current key is never retired, and current plus retired are exactly the key ids of the accepted deliveries.
    for (const member of world.live.members.values()) {
      const delivered = world.sealedKeyIds.get(member.id) ?? [];
      const retired = member.retiredNearKeyIds ?? [];
      if (retired.length > 0) withRetired += 1;
      if (member.nearApiKeyId !== undefined) assert.equal(retired.includes(member.nearApiKeyId), false, `seed ${seed}: current key retired for ${member.id}`);
      assert.equal(new Set(retired).size, retired.length, `seed ${seed}: retired ids repeat`);
      const held = [...retired, ...(member.nearApiKeyId === undefined ? [] : [member.nearApiKeyId])];
      assert.deepEqual([...held].sort(), [...delivered].sort(), `seed ${seed}: key ids of ${member.id}`);
    }
  }
  for (const [kind, count] of Object.entries(totals)) assert.ok(count > 0, `the seeds never produced a ${kind} event`);
  assert.ok(withRetired > 0, 'some member received more than one key');
});
