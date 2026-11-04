// Role-by-action decisions (D-12, D-30, D-32, SEC-04). The expected table below is written from spec 6.3, not read from the module.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTION_LABELS, PERMISSION_MATRIX, PERMISSION_REASONS, actionForEvent, decideTeamAction
} from '../domain/team/permissions';
import type { PermissionView, TeamAction, TeamActionKind } from '../domain/team/permissions';
import { defaultTeamPolicy } from '../domain/team/policy';
import { ROLES } from '../domain/team/types';
import type { ImplementedTeamEvent, Member, Role, TeamPolicy, WorkItem } from '../domain/team/types';

const IDS: Record<Role, string> = { owner: 'mbr-owner', lead: 'mbr-lead', developer: 'mbr-dev', reviewer: 'mbr-rev', observer: 'mbr-obs' };
const EXTRA = 'mbr-extra';
const GONE = 'mbr-gone';
const TEAM = 'team-0123456789abcdef0123456789abcdef';

function member(id: string, role: Role, removed = false): Member {
  const base: Member = {
    id, name: id, emailHashes: [], role, devices: [], skills: [], availability: 'available', wipLimit: 2,
    joinedAt: '2026-01-01T00:00:00.000Z', joinedEvent: `evt-${id}`
  };
  return removed ? { ...base, removedAt: '2026-02-01T00:00:00.000Z', removedEvent: `evt-gone-${id}` } : base;
}

function view(policy: TeamPolicy = defaultTeamPolicy()): PermissionView {
  const members = new Map<string, Member>();
  for (const role of ROLES) { members.set(IDS[role], member(IDS[role], role)); }
  members.set(EXTRA, member(EXTRA, 'reviewer'));
  members.set(GONE, member(GONE, 'developer', true));
  return { team: { id: TEAM, name: 'Team', ownerId: IDS.owner, policy }, members };
}

function openPolicy(): TeamPolicy {
  return { ...defaultTeamPolicy(), peerMetricsVisible: true, developerMayIntegrate: true };
}

type Expect = readonly [boolean, boolean, boolean, boolean, boolean]; // owner, lead, developer, reviewer, observer
interface Row { name: string; kind: TeamActionKind; build: (self: string) => TeamAction; policy?: () => TeamPolicy; expect: Expect }

const T = true;
const F = false;
const rows: Row[] = [
  { name: 'board.view', kind: 'board.view', build: () => ({ kind: 'board.view' }), expect: [T, T, T, T, T] },
  { name: 'metrics.view-own', kind: 'metrics.view-own', build: () => ({ kind: 'metrics.view-own' }), expect: [T, T, T, T, T] },
  { name: 'metrics.view-all with peer metrics hidden', kind: 'metrics.view-all', build: () => ({ kind: 'metrics.view-all' }), expect: [T, T, F, F, F] },
  { name: 'metrics.view-all with peer metrics visible', kind: 'metrics.view-all', build: () => ({ kind: 'metrics.view-all' }), policy: openPolicy, expect: [T, T, T, T, F] },
  { name: 'member.invite', kind: 'member.invite', build: () => ({ kind: 'member.invite' }), expect: [T, T, F, F, F] },
  { name: 'member.remove', kind: 'member.remove', build: () => ({ kind: 'member.remove', targetId: EXTRA }), expect: [T, T, F, F, F] },
  { name: 'member.change-role', kind: 'member.change-role', build: () => ({ kind: 'member.change-role', targetId: EXTRA, role: 'developer' }), expect: [T, T, F, F, F] },
  { name: 'item.create own draft', kind: 'item.create', build: () => ({ kind: 'item.create', ownDraft: true }), expect: [T, T, T, F, F] },
  { name: 'item.create not own draft', kind: 'item.create', build: () => ({ kind: 'item.create', ownDraft: false }), expect: [T, T, F, F, F] },
  { name: 'item.edit own draft', kind: 'item.edit', build: () => ({ kind: 'item.edit', ownDraft: true }), expect: [T, T, T, F, F] },
  { name: 'item.edit not own draft', kind: 'item.edit', build: () => ({ kind: 'item.edit', ownDraft: false }), expect: [T, T, F, F, F] },
  { name: 'item.estimate own draft', kind: 'item.estimate', build: () => ({ kind: 'item.estimate', ownDraft: true }), expect: [T, T, T, F, F] },
  { name: 'item.estimate not own draft', kind: 'item.estimate', build: () => ({ kind: 'item.estimate', ownDraft: false }), expect: [T, T, F, F, F] },
  { name: 'item.move', kind: 'item.move', build: () => ({ kind: 'item.move' }), expect: [T, T, F, F, F] },
  // Owner decision 2026-11-04 (G-62-5, 62-27): the card's assignee moves it; actionForEvent sends only the assignee's own moves here.
  { name: 'item.move-own', kind: 'item.move-own', build: () => ({ kind: 'item.move-own' }), expect: [T, T, T, T, F] },
  { name: 'item.claim task', kind: 'item.claim', build: () => ({ kind: 'item.claim', itemKind: 'task' }), expect: [T, T, T, F, F] },
  { name: 'item.claim review item', kind: 'item.claim', build: () => ({ kind: 'item.claim', itemKind: 'review' }), expect: [T, T, T, T, F] },
  { name: 'item.assign', kind: 'item.assign', build: () => ({ kind: 'item.assign' }), expect: [T, T, F, F, F] },
  // Owner decision 2026-11-03 (G-62-5, 62-25): any confirmed member who is not an observer assigns and unassigns themselves.
  { name: 'item.assign-self', kind: 'item.assign-self', build: () => ({ kind: 'item.assign-self' }), expect: [T, T, T, T, F] },
  { name: 'lease.manual', kind: 'lease.manual', build: () => ({ kind: 'lease.manual' }), expect: [T, T, F, F, F] },
  { name: 'review.submit on others work', kind: 'review.submit', build: () => ({ kind: 'review.submit', ownWork: false }), expect: [T, T, T, T, F] },
  { name: 'review.submit on own work', kind: 'review.submit', build: () => ({ kind: 'review.submit', ownWork: true }), expect: [T, T, F, F, F] },
  { name: 'merge.approve-out-of-scope', kind: 'merge.approve-out-of-scope', build: () => ({ kind: 'merge.approve-out-of-scope' }), expect: [T, T, F, F, F] },
  { name: 'lease.integrator with default policy', kind: 'lease.integrator', build: () => ({ kind: 'lease.integrator' }), expect: [T, T, F, F, F] },
  { name: 'lease.integrator with developerMayIntegrate', kind: 'lease.integrator', build: () => ({ kind: 'lease.integrator' }), policy: openPolicy, expect: [T, T, T, F, F] },
  { name: 'budget.set within team budget', kind: 'budget.set', build: () => ({ kind: 'budget.set', withinTeamBudget: true }), expect: [T, T, F, F, F] },
  { name: 'budget.set beyond team budget', kind: 'budget.set', build: () => ({ kind: 'budget.set', withinTeamBudget: false }), expect: [T, F, F, F, F] },
  { name: 'allocation.grant within team budget', kind: 'allocation.grant', build: () => ({ kind: 'allocation.grant', withinTeamBudget: true }), expect: [T, T, F, F, F] },
  { name: 'allocation.grant beyond team budget', kind: 'allocation.grant', build: () => ({ kind: 'allocation.grant', withinTeamBudget: false }), expect: [T, F, F, F, F] },
  { name: 'allocation.revoke within team budget', kind: 'allocation.revoke', build: () => ({ kind: 'allocation.revoke', withinTeamBudget: true }), expect: [T, T, F, F, F] },
  { name: 'allocation.revoke beyond team budget', kind: 'allocation.revoke', build: () => ({ kind: 'allocation.revoke', withinTeamBudget: false }), expect: [T, F, F, F, F] },
  { name: 'allocation.request', kind: 'allocation.request', build: () => ({ kind: 'allocation.request' }), expect: [T, T, T, T, F] },
  { name: 'team.stop', kind: 'team.stop', build: () => ({ kind: 'team.stop' }), expect: [T, T, T, T, F] },
  { name: 'team.resume', kind: 'team.resume', build: () => ({ kind: 'team.resume' }), expect: [T, T, F, F, F] },
  { name: 'policy.change', kind: 'policy.change', build: () => ({ kind: 'policy.change' }), expect: [T, F, F, F, F] },
  { name: 'device.add for self', kind: 'device.add', build: (self) => ({ kind: 'device.add', memberId: self }), expect: [T, T, T, T, T] },
  { name: 'device.add for another member', kind: 'device.add', build: () => ({ kind: 'device.add', memberId: EXTRA }), expect: [T, T, F, F, F] },
  { name: 'device.add for the owner', kind: 'device.add', build: () => ({ kind: 'device.add', memberId: IDS.owner }), expect: [T, F, F, F, F] },
  { name: 'device.revoke for self', kind: 'device.revoke', build: (self) => ({ kind: 'device.revoke', memberId: self }), expect: [T, T, T, T, T] },
  { name: 'device.revoke for another member', kind: 'device.revoke', build: () => ({ kind: 'device.revoke', memberId: EXTRA }), expect: [T, T, F, F, F] },
  { name: 'device.revoke for the owner', kind: 'device.revoke', build: () => ({ kind: 'device.revoke', memberId: IDS.owner }), expect: [T, F, F, F, F] },
  { name: 'member.availability', kind: 'member.availability', build: () => ({ kind: 'member.availability' }), expect: [T, T, T, T, T] },
  { name: 'member.skills for self', kind: 'member.skills', build: (self) => ({ kind: 'member.skills', memberId: self }), expect: [T, T, T, T, T] },
  { name: 'member.skills for another member', kind: 'member.skills', build: () => ({ kind: 'member.skills', memberId: EXTRA }), expect: [T, T, F, F, F] },
  { name: 'snapshot.write', kind: 'snapshot.write', build: () => ({ kind: 'snapshot.write' }), expect: [T, T, F, F, F] },
  { name: 'member.key-deliver for another member', kind: 'member.key-deliver', build: () => ({ kind: 'member.key-deliver', targetId: EXTRA }), expect: [T, T, F, F, F] },
  { name: 'member.key-deliver for the owner', kind: 'member.key-deliver', build: () => ({ kind: 'member.key-deliver', targetId: IDS.owner }), expect: [F, F, F, F, F] }
];

for (const row of rows) {
  test(`matrix: ${row.name}`, () => {
    const state = view(row.policy ? row.policy() : undefined);
    ROLES.forEach((role, index) => {
      const decision = decideTeamAction(state, IDS[role], row.build(IDS[role]));
      assert.equal(decision.allowed, row.expect[index], `${role} on ${row.name}`);
      if (decision.allowed) { assert.equal(decision.reason, undefined, `${role} allowed has no reason`); }
      else { assert.ok(decision.reason && decision.reason.length > 0, `${role} denial carries a reason`); }
    });
  });
}

test('the table covers every kind in the matrix and the matrix has five roles per kind', () => {
  const kinds = Object.keys(PERMISSION_MATRIX);
  // 30 since 62-25 (was 29): item.assign-self joined for the owner decision of 2026-11-03. 31 since 62-27: item.move-own joined for the owner
  // decision of 2026-11-04 (assignees move their own cards).
  assert.equal(kinds.length, 31);
  for (const kind of kinds) {
    assert.deepEqual(Object.keys(PERMISSION_MATRIX[kind as TeamActionKind]).sort(), [...ROLES].sort(), kind);
    assert.ok(rows.some((row) => row.kind === kind), `no table row for ${kind}`);
    assert.ok(ACTION_LABELS[kind as TeamActionKind].length > 0, `label for ${kind}`);
  }
});

test('an unknown actor is denied with the not-a-member reason', () => {
  const decision = decideTeamAction(view(), 'mbr-nobody', { kind: 'board.view' });
  assert.deepEqual(decision, { allowed: false, reason: PERMISSION_REASONS.notMember });
});

test('a removed member is denied every action', () => {
  const state = view(openPolicy());
  for (const row of rows) {
    const decision = decideTeamAction(state, GONE, row.build(GONE));
    assert.deepEqual(decision, { allowed: false, reason: PERMISSION_REASONS.removed }, row.name);
  }
});

test('nobody can make a second owner, including the owner and a lead', () => {
  for (const actor of [IDS.owner, IDS.lead]) {
    const decision = decideTeamAction(view(), actor, { kind: 'member.change-role', targetId: EXTRA, role: 'owner' });
    assert.deepEqual(decision, { allowed: false, reason: PERMISSION_REASONS.singleOwner });
  }
});

test('nobody can change their own role', () => {
  for (const actor of [IDS.owner, IDS.lead]) {
    const decision = decideTeamAction(view(), actor, { kind: 'member.change-role', targetId: actor, role: 'developer' });
    assert.deepEqual(decision, { allowed: false, reason: PERMISSION_REASONS.ownRole });
  }
});

test('a lead cannot change the role of the owner or remove the owner', () => {
  assert.deepEqual(
    decideTeamAction(view(), IDS.lead, { kind: 'member.change-role', targetId: IDS.owner, role: 'developer' }),
    { allowed: false, reason: PERMISSION_REASONS.leadOnOwner }
  );
  assert.deepEqual(
    decideTeamAction(view(), IDS.lead, { kind: 'member.remove', targetId: IDS.owner }),
    { allowed: false, reason: PERMISSION_REASONS.leadOnOwner }
  );
});

test('the owner cannot be removed, not even by the owner', () => {
  assert.deepEqual(
    decideTeamAction(view(), IDS.owner, { kind: 'member.remove', targetId: IDS.owner }),
    { allowed: false, reason: PERMISSION_REASONS.ownerCannotBeRemoved }
  );
});

test('an owner may remove a lead and a lead may remove a developer', () => {
  assert.equal(decideTeamAction(view(), IDS.owner, { kind: 'member.remove', targetId: IDS.lead }).allowed, true);
  assert.equal(decideTeamAction(view(), IDS.lead, { kind: 'member.remove', targetId: IDS.developer }).allowed, true);
});

test('a lead cannot add or revoke a device of the owner (D-32) but the owner can', () => {
  for (const kind of ['device.add', 'device.revoke'] as const) {
    assert.deepEqual(
      decideTeamAction(view(), IDS.lead, { kind, memberId: IDS.owner }),
      { allowed: false, reason: PERMISSION_REASONS.leadOnOwnerDevice },
      kind
    );
    assert.equal(decideTeamAction(view(), IDS.owner, { kind, memberId: IDS.owner }).allowed, true, kind);
  }
});

test('a developer cannot manage the devices of another member', () => {
  for (const kind of ['device.add', 'device.revoke'] as const) {
    const decision = decideTeamAction(view(), IDS.developer, { kind, memberId: EXTRA });
    assert.equal(decision.allowed, false, kind);
  }
});

test('policy change by anyone but the owner is denied with the exact fixed text', () => {
  for (const role of ['lead', 'developer', 'reviewer', 'observer'] as const) {
    assert.deepEqual(
      decideTeamAction(view(), IDS[role], { kind: 'policy.change' }),
      { allowed: false, reason: 'only the owner can change team policy' },
      role
    );
  }
});

test('generic denials use the role and the action label without dashes', () => {
  const decision = decideTeamAction(view(), IDS.developer, { kind: 'item.assign' });
  assert.equal(decision.reason, `the developer role does not allow ${ACTION_LABELS['item.assign']}`);
  const reasons = [...Object.values(PERMISSION_REASONS), ...Object.values(ACTION_LABELS)];
  for (const text of reasons) {
    assert.ok(!/[\u2013\u2014]/.test(text), `no dash in: ${text}`);
  }
});

test('the decision reads the policy of the state it is given, not a default', () => {
  const closed = view();
  const open = view(openPolicy());
  assert.equal(decideTeamAction(closed, IDS.developer, { kind: 'lease.integrator' }).allowed, false);
  assert.equal(decideTeamAction(open, IDS.developer, { kind: 'lease.integrator' }).allowed, true);
  assert.equal(decideTeamAction(closed, IDS.reviewer, { kind: 'metrics.view-all' }).allowed, false);
  assert.equal(decideTeamAction(open, IDS.reviewer, { kind: 'metrics.view-all' }).allowed, true);
});

const ENVELOPE = {
  v: 1 as const, id: 'evt-01', teamId: TEAM, lamport: 2, at: '2026-01-01T00:00:00.000Z', author: IDS.owner,
  device: 'dev-0123456789abcdef0123456789abcdef', prev: 'evt-00', sig: ''
};
const DEVICE = { fingerprint: 'dev-0123456789abcdef0123456789abcdef', publicKey: 'A'.repeat(43) };

test('actionForEvent maps every non-genesis event type and skips the genesis pair', () => {
  const cases: Array<[ImplementedTeamEvent, TeamAction | undefined]> = [
    [{ ...ENVELOPE, type: 'team.created', body: { name: 'T', ownerId: IDS.owner, ownerName: 'O', ownerEmailHashes: [], ownerDevice: DEVICE, policy: defaultTeamPolicy() } }, undefined],
    [{ ...ENVELOPE, type: 'member.joined', body: { memberId: IDS.owner, name: 'O', emailHashes: [], role: 'owner', device: DEVICE } }, undefined],
    [{ ...ENVELOPE, type: 'member.role-changed', body: { memberId: EXTRA, role: 'lead' } }, { kind: 'member.change-role', targetId: EXTRA, role: 'lead' }],
    [{ ...ENVELOPE, type: 'member.removed', body: { memberId: EXTRA } }, { kind: 'member.remove', targetId: EXTRA }],
    [{ ...ENVELOPE, type: 'device.added', body: { memberId: IDS.developer, device: DEVICE } }, { kind: 'device.add', memberId: IDS.developer }],
    [{ ...ENVELOPE, type: 'device.revoked', body: { memberId: IDS.developer, fingerprint: DEVICE.fingerprint } }, { kind: 'device.revoke', memberId: IDS.developer }],
    [{ ...ENVELOPE, type: 'member.availability', body: { availability: 'focus' } }, { kind: 'member.availability' }],
    [{ ...ENVELOPE, type: 'member.skills', body: { memberId: EXTRA, skills: ['ts'] } }, { kind: 'member.skills', memberId: EXTRA }],
    [{ ...ENVELOPE, type: 'policy.changed', body: { changes: { teeOnly: true } } }, { kind: 'policy.change' }],
    [{ ...ENVELOPE, type: 'snapshot.written', body: { coversThrough: 'evt-01', lamport: 2, stateHash: 'a'.repeat(64), path: 'snapshots/x.json' } }, { kind: 'snapshot.write' }],
    [{ ...ENVELOPE, type: 'member.key-sealed', body: { memberId: EXTRA, keyId: 'key_0123', scheme: 'x25519-hkdf-sha256-aes-256-gcm-v1', sealed: [] } }, { kind: 'member.key-deliver', targetId: EXTRA }]
  ];
  for (const [event, expected] of cases) {
    assert.deepEqual(actionForEvent(event), expected, event.type);
  }
});

function boardItem(id: string, createdBy: string, state: WorkItem['state'] = 'backlog'): WorkItem {
  return {
    id, kind: 'chore', title: 'Item', dependsOn: [], scope: [], requirements: [], mustHaves: [], state, tags: [],
    origin: 'board', stateSince: '2026-01-01T00:00:00.000Z', createdBy
  };
}

test('actionForEvent maps the item events, and decides own-draft from the stored item the same way for every caller', () => {
  const ITEM = 'item:01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const mine = { items: new Map([[ITEM, boardItem(ITEM, IDS.developer)]]) };
  const claimed = { items: new Map([[ITEM, boardItem(ITEM, IDS.developer, 'claimed')]]) };
  const imported = { items: new Map([['plan:62-01', { ...boardItem('plan:62-01', IDS.developer), kind: 'plan' as const, origin: 'import' as const }]]) };
  const at = (event: Record<string, unknown>, author: string = IDS.developer): ImplementedTeamEvent => ({ ...ENVELOPE, author, ...event } as ImplementedTeamEvent);
  const imports = at({ type: 'item.imported', body: { id: 'plan:62-01', kind: 'plan', title: 'P', state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [], parentId: 'phase:62' } });
  const creates = at({ type: 'item.created', body: { id: ITEM, kind: 'chore', title: 'C', scope: [], requirements: [], mustHaves: [] } });
  const edits = at({ type: 'item.updated', body: { id: ITEM, changes: { title: 'T' } } });
  const holds = at({ type: 'item.updated', body: { id: ITEM, changes: { hold: true } } });
  const done = at({ type: 'item.updated', body: { id: ITEM, changes: { state: 'done' } } });
  const estimates = at({ type: 'item.estimated', body: { id: ITEM, estimate: { tokens: 10 } } });
  assert.deepEqual(actionForEvent(imports, mine), { kind: 'item.create', ownDraft: false });
  assert.deepEqual(actionForEvent(creates, mine), { kind: 'item.create', ownDraft: true });
  assert.deepEqual(actionForEvent(edits, mine), { kind: 'item.edit', ownDraft: true });
  assert.deepEqual(actionForEvent(edits), { kind: 'item.edit', ownDraft: false }, 'without a state nothing is an own draft');
  assert.deepEqual(actionForEvent(edits, claimed), { kind: 'item.edit', ownDraft: false }, 'a claimed item is no longer a draft');
  assert.deepEqual(actionForEvent(edits, imported), { kind: 'item.edit', ownDraft: false }, 'an unknown item is not an own draft');
  assert.deepEqual(actionForEvent(at({ type: 'item.updated', body: { id: ITEM, changes: { title: 'T' } } }, IDS.lead), mine), { kind: 'item.edit', ownDraft: false }, 'another author is not the draft owner');
  assert.deepEqual(actionForEvent(holds, mine), { kind: 'item.move' });
  assert.deepEqual(actionForEvent(done, mine), { kind: 'item.move' });
  assert.deepEqual(actionForEvent(estimates, mine), { kind: 'item.estimate', ownDraft: true });
  assert.deepEqual(actionForEvent(estimates, claimed), { kind: 'item.estimate', ownDraft: false });
  for (const type of ['item.blocked', 'item.unblocked', 'item.cancelled', 'item.reopened']) {
    const body = type === 'item.blocked' || type === 'item.cancelled' ? { id: ITEM, reason: 'r' } : { id: ITEM };
    assert.deepEqual(actionForEvent(at({ type, body }), mine), { kind: 'item.move' }, type);
  }
});

test('the self-assignment row is labelled for the person, and an observer is refused with it', () => {
  assert.equal(ACTION_LABELS['item.assign-self'], 'assigning items to themselves');
  assert.equal(decideTeamAction(view(), IDS.observer, { kind: 'item.assign-self' }).reason, 'the observer role does not allow assigning items to themselves');
  assert.equal(decideTeamAction(view(), IDS.developer, { kind: 'item.assign' }).reason, 'the developer role does not allow assigning items to others');
});

test('the own-move row is labelled for the person, and an observer is refused with it', () => {
  assert.equal(ACTION_LABELS['item.move-own'], 'moving cards assigned to them');
  assert.equal(decideTeamAction(view(), IDS.observer, { kind: 'item.move-own' }).reason, 'the observer role does not allow moving cards assigned to them');
  assert.equal(decideTeamAction(view(), IDS.developer, { kind: 'item.move' }).reason, 'the developer role does not allow moving items');
});

// Owner decision 2026-11-04 (62-27): the assignee's own moves map to item.move-own; a cancel, a reopen of a card that is not done, a move by
// anyone else and any move without a state stay item.move.
test('actionForEvent sends the assignee\'s own moves to item.move-own, keeps cancel and a cancelled reopen on item.move, and needs a state to do so', () => {
  const MINE = 'plan:62-01';
  const DONE = 'plan:62-02';
  const GONE = 'plan:62-03';
  const LEADS = 'plan:62-04';
  const FREE = 'plan:62-05';
  const card = (id: string, assignee: string | undefined, state: WorkItem['state'] = 'ready'): WorkItem => ({
    ...boardItem(id, IDS.lead, state), kind: 'plan', origin: 'import', ...(assignee === undefined ? {} : { assignee, assignedBy: IDS.lead })
  });
  const state = { items: new Map([
    [MINE, card(MINE, IDS.developer)], [DONE, card(DONE, IDS.developer, 'done')], [GONE, card(GONE, IDS.developer, 'cancelled')],
    [LEADS, card(LEADS, IDS.lead)], [FREE, card(FREE, undefined)]
  ]) };
  const at = (type: string, body: Record<string, unknown>, author: string = IDS.developer): ImplementedTeamEvent => ({ ...ENVELOPE, author, type, body } as unknown as ImplementedTeamEvent);
  const OWN: TeamAction = { kind: 'item.move-own' };
  const MOVE: TeamAction = { kind: 'item.move' };
  const moves = (id: string): Array<[string, ImplementedTeamEvent]> => [
    ['hold', at('item.updated', { id, changes: { hold: true } })],
    ['release', at('item.updated', { id, changes: { hold: false } })],
    ['done', at('item.updated', { id, changes: { state: 'done' } })],
    ['block', at('item.blocked', { id, reason: 'r' })],
    ['unblock', at('item.unblocked', { id })]
  ];
  for (const [name, event] of moves(MINE)) assert.deepEqual(actionForEvent(event, state), OWN, `the developer's ${name} of their card`);
  for (const [name, event] of moves(LEADS)) assert.deepEqual(actionForEvent(event, state), MOVE, `the developer's ${name} of the lead's card`);
  for (const [name, event] of moves(FREE)) assert.deepEqual(actionForEvent(event, state), MOVE, `the developer's ${name} of a free card`);
  for (const [name, event] of moves(MINE)) assert.deepEqual(actionForEvent(event), MOVE, `${name} without a state`);
  assert.deepEqual(actionForEvent(at('item.reopened', { id: DONE }), state), OWN, 'the developer reopens their finished card');
  assert.deepEqual(actionForEvent(at('item.reopened', { id: GONE }), state), MOVE, 'the developer brings back their cancelled card');
  assert.deepEqual(actionForEvent(at('item.reopened', { id: DONE })), MOVE, 'reopen without a state');
  assert.deepEqual(actionForEvent(at('item.cancelled', { id: MINE, reason: 'r' }), state), MOVE, 'the developer cancels their card');
  assert.deepEqual(actionForEvent(at('item.blocked', { id: LEADS, reason: 'r' }, IDS.lead), state), OWN, 'a lead\'s own card is their own move too');
  assert.deepEqual(actionForEvent(at('item.blocked', { id: MINE, reason: 'r' }, IDS.lead), state), MOVE, 'a lead moving the developer\'s card asks item.move');
  assert.deepEqual(actionForEvent(at('item.updated', { id: MINE, changes: { title: 'T' } }), state), { kind: 'item.edit', ownDraft: false }, 'an edit is not a move');
});

test('actionForEvent sends a member\'s own assignment to item.assign-self and everything else to item.assign, and needs a state to do so', () => {
  const FREE = 'plan:62-01';
  const DEVS = 'plan:62-02';
  const LEADS = 'plan:62-03';
  const GIVEN = 'plan:62-04';
  // assignedBy is who made the assignment (owner decision 2026-11-04, 62-26): DEVS and LEADS were taken by their holders, GIVEN the lead gave the developer.
  const card = (id: string, assignee?: string, assignedBy: string | undefined = assignee): WorkItem => ({
    ...boardItem(id, IDS.lead), kind: 'plan', origin: 'import', ...(assignee === undefined ? {} : { assignee }), ...(assignedBy === undefined ? {} : { assignedBy })
  });
  const state = { items: new Map([[FREE, card(FREE)], [DEVS, card(DEVS, IDS.developer)], [LEADS, card(LEADS, IDS.lead)], [GIVEN, card(GIVEN, IDS.developer, IDS.lead)]]) };
  const at = (event: Record<string, unknown>, author: string = IDS.developer): ImplementedTeamEvent => ({ ...ENVELOPE, author, ...event } as ImplementedTeamEvent);
  const assign = (id: string, memberId: string, author?: string): ImplementedTeamEvent => at({ type: 'item.assigned', body: { id, memberId } }, author);
  const unassign = (id: string, author?: string): ImplementedTeamEvent => at({ type: 'item.unassigned', body: { id } }, author);
  const SELF: TeamAction = { kind: 'item.assign-self' };
  const OTHERS: TeamAction = { kind: 'item.assign' };
  const cases: Array<[string, ImplementedTeamEvent, TeamAction]> = [
    ['the developer takes a free card', assign(FREE, IDS.developer), SELF],
    ['the developer takes a card already theirs (the rules refuse the repeat)', assign(DEVS, IDS.developer), SELF],
    ['the developer takes a card that is not on the board (the rules say it is missing)', assign('plan:62-99', IDS.developer), SELF],
    ['the developer takes the lead\'s card', assign(LEADS, IDS.developer), OTHERS],
    ['the developer puts the lead on a free card', assign(FREE, IDS.lead), OTHERS],
    ['the developer puts the lead on the developer\'s own card', assign(DEVS, IDS.lead), OTHERS],
    ['the developer takes themselves off a card they took', unassign(DEVS), SELF],
    // Owner decision 2026-11-04 (62-26): a card the lead gave the developer stays on the owner and lead row.
    ['the developer takes themselves off a card the lead gave them', unassign(GIVEN), OTHERS],
    ['the developer takes the lead off', unassign(LEADS), OTHERS],
    ['the developer clears a free card', unassign(FREE), OTHERS],
    ['the lead takes themselves off', unassign(LEADS, IDS.lead), SELF],
    ['the lead takes the developer off', unassign(DEVS, IDS.lead), OTHERS],
    ['the observer takes a free card', assign(FREE, IDS.observer, IDS.observer), SELF]
  ];
  for (const [name, event, expected] of cases) assert.deepEqual(actionForEvent(event, state), expected, name);
  // Without a state there is no assignee to compare, so both events take the stricter answer.
  assert.deepEqual(actionForEvent(assign(FREE, IDS.developer)), OTHERS, 'assign without a state');
  assert.deepEqual(actionForEvent(unassign(DEVS)), OTHERS, 'unassign without a state');
  // The decision on the mapped action: the self row lets the developer and reviewer in and keeps the observer out.
  for (const [role, allowed] of [['owner', true], ['lead', true], ['developer', true], ['reviewer', true], ['observer', false]] as const) {
    const event = assign(FREE, IDS[role], IDS[role]);
    const action = actionForEvent(event, state);
    assert.ok(action !== undefined);
    assert.equal(decideTeamAction(view(), IDS[role], action).allowed, allowed, role);
  }
});

test('the same decision runs on the mapped action for a lead revoking the owner device', () => {
  const event: ImplementedTeamEvent = { ...ENVELOPE, type: 'device.revoked', author: IDS.lead, body: { memberId: IDS.owner, fingerprint: DEVICE.fingerprint } };
  const action = actionForEvent(event);
  assert.ok(action);
  assert.equal(decideTeamAction(view(), event.author, action).allowed, false);
});

test('only the owner and a lead deliver a key, never to the owner, and the owner denial has its own reason', () => {
  for (const actor of [IDS.owner, IDS.lead]) {
    assert.equal(decideTeamAction(view(), actor, { kind: 'member.key-deliver', targetId: IDS.developer }).allowed, true, actor);
    assert.deepEqual(
      decideTeamAction(view(), actor, { kind: 'member.key-deliver', targetId: IDS.owner }),
      { allowed: false, reason: PERMISSION_REASONS.ownerKey },
      actor
    );
  }
  for (const role of ['developer', 'reviewer', 'observer'] as const) {
    assert.equal(decideTeamAction(view(), IDS[role], { kind: 'member.key-deliver', targetId: EXTRA }).allowed, false, role);
  }
  assert.equal(PERMISSION_REASONS.ownerKey, "the owner's NEAR key is not delivered through the team log");
});
