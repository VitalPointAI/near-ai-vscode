// Removal releases everything the member held (Phase 61 plan 06, D-19), in the one place every client agrees on: the materialiser.
// Claims, leases and allocations have no events until Phases 63 and 66, so the fixtures place them straight into a live TeamState.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEntry, createState, reduce } from '../domain/team/materialize';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { Allocation, Claim, GenesisAnchor, Lease, TeamEvent, TeamState, WorkItem } from '../domain/team/types';
import { emailHash, newMemberId, newTeamId } from '../team/identity';
import { deriveInviteKey, generateInviteCode } from '../team/inviteCode';
import { addFixtureMember, entryOf, genesisEntries, makeActor, signed } from './helpers/teamEvents';
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

test('createState alone has nothing to release and removal of a joined member without work is a plain removal', async () => {
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
