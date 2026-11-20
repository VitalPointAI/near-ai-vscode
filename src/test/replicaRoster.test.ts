// The membership and device rules of the roster fold (DESIGN 15.1 and 15.2; D-10 to D-12, D-17 to D-20, D-41, D-48), one named test per transition.
// Test titles start with the transition they cover. Every roster entry here is signed by the lead's device; deputy-signed entries reach the members
// module through the driver only after 31-17, so the deputy rule is tested by calling the module with a ctx that names the signer's member as deputy.
//
// Builders beyond the shared roster world live in this file (the world helper is not edited in this wave).
import assert from 'node:assert/strict';
import test from 'node:test';
import { joinSecretHash } from '../domain/replica/invite';
import { ORIGIN_ROSTER, rosterView } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
import { MEMBER_REFUSALS, inviteAt } from '../domain/replica/rosterMembers';
import { DEMO_CLEARANCE, INVITE_EXPIRES, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import type { Written } from './helpers/replicaWorld';

const JO = 'mbr-jo';
const SECRET_HASH = joinSecretHash('a-join-secret-for-tests-only');

// The applied roster line of one world: next() writes an entry citing the head and moves the head; tryEntry() writes one citing the head and folds the
// line with it alone, without moving the head, so a refused entry never splits the line with a later one.
interface Line {
  world: RosterWorld;
  genesis: Written;
  head: string;
  entries: unknown[];
  next(kind: string, data: Record<string, unknown>, options?: { at?: string }): Written;
  tryEntry(kind: string, data: Record<string, unknown>, options?: { at?: string }): { written: Written; state: RosterState };
  fold(): RosterState;
}

function createLine(world: RosterWorld = createRosterWorld()): Line {
  const { entry: genesis } = world.genesis();
  const line: Line = {
    world,
    genesis,
    head: genesis.hash,
    entries: [genesis.entry],
    next(kind, data, options = {}) {
      const written = world.rosterEntry(world.lead, kind, data, line.head, options);
      line.entries.push(written.entry);
      line.head = written.hash;
      return written;
    },
    tryEntry(kind, data, options = {}) {
      const written = world.rosterEntry(world.lead, kind, data, line.head, options);
      return { written, state: world.foldRoster({ entries: [...line.entries, written.entry] }) };
    },
    fold: () => world.foldRoster({ entries: line.entries })
  };
  return line;
}

const inviteData = (invite: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  invite, name: 'Jo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: SECRET_HASH, ...extra
});

const admitData = (member: string, invite: string, device: RosterDevice, slot: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  member, invite, name: 'Jo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: device.descriptor(slot), agentSeats: [], ...extra
});

// The refusal the fold gave the entry, after checking the line did not move.
function refusalOf(line: Line, attempt: { written: Written; state: RosterState }): string | undefined {
  assert.equal(attempt.state.positions[attempt.state.positions.length - 1], line.head, 'a refused entry must not move the head');
  return attempt.state.refused.find((item) => item.hash === attempt.written.hash)?.reason;
}

// Every answer the view gives about one member and its devices at a roster hash.
function memberAnswers(state: RosterState, member: string, devices: readonly RosterDevice[], hash: string): unknown[] {
  const view = rosterView(state);
  return [
    view.memberName(member, hash), view.hasRole(member, 'member', hash), view.hasRole(member, 'observer', hash), view.hasRole(member, 'decision_for:commander', hash),
    view.canRunAgent?.(member, 'release-guard', hash), view.canRunAgent?.(member, 'tradecraft-reviewer', hash),
    ...devices.flatMap((device) => [view.isAdmitted(device.writer, hash), view.deviceEncryptionKey?.(device.writer, hash), view.checkpointSigner(device.writer, hash)])
  ];
}

// ---- 15.1 membership ----

test('15.1 (none) -> invited: member.invite applies and inviteAt answers open with its expiry from the invite roster on, and nothing before it', () => {
  const line = createLine();
  const invite = line.next('member.invite', inviteData('inv-jo'));
  const state = line.fold();
  assert.deepEqual(state.refused, []);
  assert.deepEqual(state.positions, [ORIGIN_ROSTER, line.genesis.hash, invite.hash]);
  assert.deepEqual(inviteAt(state.members, 'inv-jo', 2), { state: 'open', expiresAt: INVITE_EXPIRES });
  assert.equal(inviteAt(state.members, 'inv-jo', 1), undefined);
  assert.equal(inviteAt(state.members, 'inv-other', 2), undefined);
});

test('15.1 join-requested -> active: member.admit with seat, decision role, clearance, agent seats and a slot-2 device answers at the admit roster and not at the invite roster', () => {
  const line = createLine();
  const jo = line.world.device('JO', JO);
  const invite = line.next('member.invite', inviteData('inv-jo', { roles: ['member', 'decision_for:commander'] }));
  const admit = line.next('member.admit', admitData(JO, 'inv-jo', jo, 2, { roles: ['member', 'decision_for:commander'], agentSeats: ['release-guard'] }));
  const state = line.fold();
  assert.deepEqual(state.refused, []);
  const view = rosterView(state);
  assert.equal(view.hasRole(JO, 'decision_for:commander', admit.hash), true);
  assert.equal(view.hasRole(JO, 'decision_for:commander', invite.hash), false);
  assert.equal(view.canRunAgent?.(JO, 'release-guard', admit.hash), true);
  assert.equal(view.canRunAgent?.(JO, 'release-guard', invite.hash), false);
  assert.equal(view.canRunAgent?.(JO, 'tradecraft-reviewer', admit.hash), false);
  assert.equal(view.isAdmitted(jo.writer, admit.hash), true);
  assert.equal(view.isAdmitted(jo.writer, invite.hash), false);
  assert.equal(view.memberName(JO, admit.hash), 'Jo Analyst');
  const record = state.members.members.get(JO)?.[0];
  assert.equal(record?.seat, 'j2-chief');
  assert.deepEqual(record?.clearance, DEMO_CLEARANCE);
  assert.equal(state.members.devices.get(jo.writer)?.[0].slot, 2);
  assert.deepEqual(inviteAt(state.members, 'inv-jo', 3), { state: 'used', expiresAt: INVITE_EXPIRES });
  assert.deepEqual(inviteAt(state.members, 'inv-jo', 2), { state: 'open', expiresAt: INVITE_EXPIRES });
});

test('15.1 active -> active: member.update changes roles and agent seats, the old answers hold at the old roster and the new ones at the new (D-11)', () => {
  const line = createLine();
  const jo = line.world.device('JO', JO);
  line.next('member.invite', inviteData('inv-jo', { roles: ['member', 'decision_for:commander'] }));
  const admit = line.next('member.admit', admitData(JO, 'inv-jo', jo, 2, { roles: ['member', 'decision_for:commander'], agentSeats: ['release-guard'] }));
  const update = line.next('member.update', { member: JO, roles: ['member', 'observer'], agentSeats: ['tradecraft-reviewer'] });
  const state = line.fold();
  assert.deepEqual(state.refused, []);
  assert.deepEqual(memberAnswers(state, JO, [jo], admit.hash), ['Jo Analyst', true, false, true, true, false, true, jo.x25519, false]);
  assert.deepEqual(memberAnswers(state, JO, [jo], update.hash), ['Jo Analyst', true, true, false, false, true, true, jo.x25519, false]);
  const view = rosterView(state);
  assert.equal(view.roleWithdrawnBy(JO, 'decision_for:commander', admit.hash), update.hash);
  assert.equal(view.roleWithdrawnBy(JO, 'member', admit.hash), undefined);
  // Fields the update does not name are kept.
  const current = state.members.members.get(JO)?.find((record) => record.until === undefined);
  assert.equal(current?.seat, 'j2-chief');
  assert.deepEqual(current?.clearance, DEMO_CLEARANCE);
  // An update of a member the roster does not have is refused.
  assert.equal(refusalOf(line, line.tryEntry('member.update', { member: 'mbr-nobody', seat: 'j3-chief' })), 'member-unknown');
});

test('15.1 active -> removed: member.remove ends the member and its devices from that roster on; earlier rosters still answer, and roleWithdrawnBy names the removal', () => {
  const line = createLine();
  const jo = line.world.device('JO', JO);
  line.next('member.invite', inviteData('inv-jo'));
  const admit = line.next('member.admit', admitData(JO, 'inv-jo', jo, 2));
  const remove = line.next('member.remove', { member: JO, reason: 'Left the staff.' });
  const state = line.fold();
  assert.deepEqual(state.refused, []);
  const view = rosterView(state);
  assert.equal(view.isAdmitted(jo.writer, admit.hash), true);
  assert.equal(view.isAdmitted(jo.writer, remove.hash), false);
  assert.equal(view.memberName(JO, remove.hash), undefined);
  assert.equal(view.hasRole(JO, 'member', remove.hash), false);
  assert.equal(view.roleWithdrawnBy(JO, 'member', admit.hash), remove.hash);
  // The removed device's slot stays given: its client ids have no owner, and the slot is never given again.
  assert.equal(state.members.slots.get(2), jo.writer);
  // Removing a member twice, or one the roster never had, is refused.
  assert.equal(refusalOf(line, line.tryEntry('member.remove', { member: JO })), 'member-unknown');
  assert.equal(refusalOf(line, line.tryEntry('member.remove', { member: 'mbr-nobody' })), 'member-unknown');
});

test('15.1 lead roles: an admit or update naming staff_lead or deputy_lead is refused lead-role-by-handover-only, and removing the lead is refused lead-not-removable', () => {
  const line = createLine();
  const jo = line.world.device('JO', JO);
  line.next('member.invite', inviteData('inv-jo'));
  for (const role of ['staff_lead', 'deputy_lead']) {
    assert.equal(refusalOf(line, line.tryEntry('member.admit', admitData(JO, 'inv-jo', jo, 2, { roles: ['member', role] }))), 'lead-role-by-handover-only', role);
  }
  line.next('member.admit', admitData(JO, 'inv-jo', jo, 2));
  for (const role of ['staff_lead', 'deputy_lead']) {
    assert.equal(refusalOf(line, line.tryEntry('member.update', { member: JO, roles: ['member', role] })), 'lead-role-by-handover-only', role);
  }
  assert.equal(refusalOf(line, line.tryEntry('member.remove', { member: line.world.lead.member })), 'lead-not-removable');
  // The lead is still the lead and still admitted.
  const view = rosterView(line.fold());
  assert.equal(view.hasRole(line.world.lead.member, 'staff_lead', line.head), true);
  assert.equal(view.isAdmitted(line.world.lead.writer, line.head), true);
});

test('every member refusal reason is a plain sentence without an em-dash', () => {
  for (const [reason, text] of Object.entries(MEMBER_REFUSALS)) {
    assert.ok(text.length > 20 && text.endsWith('.'), reason);
    assert.ok(!text.includes('—'), reason);
  }
  for (const reason of ['invite-unknown', 'invite-expired', 'invite-voided', 'invite-used', 'member-exists', 'member-unknown', 'lead-role-by-handover-only', 'lead-not-removable',
    'last-lead-device', 'slot-in-use', 'slot-out-of-range', 'device-limit', 'device-exists', 'bad-binding', 'device-unknown', 'hub-unknown']) {
    assert.ok(Object.prototype.hasOwnProperty.call(MEMBER_REFUSALS, reason), reason);
  }
});
