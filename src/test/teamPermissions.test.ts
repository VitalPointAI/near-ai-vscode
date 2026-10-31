// Role-by-action decisions (D-12, D-30, D-32, SEC-04). The expected table below is written from spec 6.3, not read from the module.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTION_LABELS, PERMISSION_MATRIX, PERMISSION_REASONS, actionForEvent, decideTeamAction
} from '../domain/team/permissions';
import type { PermissionView, TeamAction, TeamActionKind } from '../domain/team/permissions';
import { defaultTeamPolicy } from '../domain/team/policy';
import { ROLES } from '../domain/team/types';
import type { ImplementedTeamEvent, Member, Role, TeamPolicy } from '../domain/team/types';

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
  { name: 'item.claim task', kind: 'item.claim', build: () => ({ kind: 'item.claim', itemKind: 'task' }), expect: [T, T, T, F, F] },
  { name: 'item.claim review item', kind: 'item.claim', build: () => ({ kind: 'item.claim', itemKind: 'review' }), expect: [T, T, T, T, F] },
  { name: 'item.assign', kind: 'item.assign', build: () => ({ kind: 'item.assign' }), expect: [T, T, F, F, F] },
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
  { name: 'snapshot.write', kind: 'snapshot.write', build: () => ({ kind: 'snapshot.write' }), expect: [T, T, F, F, F] }
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
  assert.equal(kinds.length, 27);
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
    assert.ok(!text.includes('—') && !text.includes('–'), `no dash in: ${text}`);
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

test('actionForEvent maps the eight non-genesis Phase 60 event types and skips the genesis pair', () => {
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
    [{ ...ENVELOPE, type: 'snapshot.written', body: { coversThrough: 'evt-01', lamport: 2, stateHash: 'a'.repeat(64), path: 'snapshots/x.json' } }, { kind: 'snapshot.write' }]
  ];
  for (const [event, expected] of cases) {
    assert.deepEqual(actionForEvent(event), expected, event.type);
  }
});

test('the same decision runs on the mapped action for a lead revoking the owner device', () => {
  const event: ImplementedTeamEvent = { ...ENVELOPE, type: 'device.revoked', author: IDS.lead, body: { memberId: IDS.owner, fingerprint: DEVICE.fingerprint } };
  const action = actionForEvent(event);
  assert.ok(action);
  assert.equal(decideTeamAction(view(), event.author, action).allowed, false);
});
