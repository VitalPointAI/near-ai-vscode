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
    assert.ok(!text.includes('\u2014'), reason);
  }
  for (const reason of ['invite-unknown', 'invite-expired', 'invite-voided', 'invite-used', 'member-exists', 'member-unknown', 'lead-role-by-handover-only', 'lead-not-removable',
    'last-lead-device', 'slot-in-use', 'slot-out-of-range', 'device-limit', 'device-exists', 'bad-binding', 'device-unknown', 'hub-unknown']) {
    assert.ok(Object.prototype.hasOwnProperty.call(MEMBER_REFUSALS, reason), reason);
  }
});

// ---- invitations (D-17, D-18) ----

const AFTER_EXPIRY = '2026-11-27T00:00:00.000Z';

// A line with Jo admitted at slot 2 through inv-jo.
function lineWithJo(): { line: Line; jo: RosterDevice; admit: Written } {
  const line = createLine();
  const jo = line.world.device('JO', JO);
  line.next('member.invite', inviteData('inv-jo'));
  const admit = line.next('member.admit', admitData(JO, 'inv-jo', jo, 2));
  return { line, jo, admit };
}

test('15.1 invited -> expired: an admit signed after the expiry is refused invite-expired, decided by signed times only, never a clock', () => {
  const line = createLine();
  const jo = line.world.device('JO', JO);
  line.next('member.invite', inviteData('inv-jo'));
  assert.equal(refusalOf(line, line.tryEntry('member.admit', admitData(JO, 'inv-jo', jo, 2), { at: AFTER_EXPIRY })), 'invite-expired');
  // The invitation answers expired for a time past its expiry and open for one before it; with no time it is open (nothing used or voided it).
  const state = line.fold();
  assert.equal(inviteAt(state.members, 'inv-jo', 2, AFTER_EXPIRY)?.state, 'expired');
  assert.equal(inviteAt(state.members, 'inv-jo', 2, INVITE_EXPIRES)?.state, 'open');
  assert.equal(inviteAt(state.members, 'inv-jo', 2)?.state, 'open');
  // An admit signed exactly at the expiry is still in time.
  line.next('member.admit', admitData(JO, 'inv-jo', jo, 2), { at: INVITE_EXPIRES });
  assert.deepEqual(line.fold().refused, []);
});

test('15.1 invited -> cancelled: invite.void applies and a later admit is refused invite-voided; a void of an unknown invite is refused invite-unknown', () => {
  const line = createLine();
  const jo = line.world.device('JO', JO);
  const invite = line.next('member.invite', inviteData('inv-jo'));
  assert.equal(refusalOf(line, line.tryEntry('invite.void', { invite: 'inv-nobody' })), 'invite-unknown');
  const voided = line.next('invite.void', { invite: 'inv-jo' });
  const state = line.fold();
  assert.deepEqual(state.refused, []);
  assert.equal(state.positions[state.positions.length - 1], voided.hash);
  assert.equal(inviteAt(state.members, 'inv-jo', state.positionOf.get(voided.hash) as number)?.state, 'voided');
  assert.equal(inviteAt(state.members, 'inv-jo', state.positionOf.get(invite.hash) as number)?.state, 'open');
  assert.equal(refusalOf(line, line.tryEntry('member.admit', admitData(JO, 'inv-jo', jo, 2))), 'invite-voided');
  assert.equal(refusalOf(line, line.tryEntry('invite.void', { invite: 'inv-jo' })), 'invite-voided');
  // A used invitation cannot be voided: the admission it made stands.
  const used = lineWithJo();
  assert.equal(refusalOf(used.line, used.line.tryEntry('invite.void', { invite: 'inv-jo' })), 'invite-used');
});

test('invite-used: a second member.admit for an invitation already used is refused, even when it names another member and device (D-17)', () => {
  const { line } = lineWithJo();
  const other = line.world.device('KIM', 'mbr-kim');
  assert.equal(refusalOf(line, line.tryEntry('member.admit', admitData('mbr-kim', 'inv-jo', other, 3))), 'invite-used');
  // An admission of a member id the roster already has is refused member-exists, whatever invitation it names.
  line.next('member.invite', inviteData('inv-kim'));
  assert.equal(refusalOf(line, line.tryEntry('member.admit', admitData(JO, 'inv-kim', other, 3))), 'member-exists');
  // An admission naming an invitation the roster does not have is refused invite-unknown.
  assert.equal(refusalOf(line, line.tryEntry('member.admit', admitData('mbr-kim', 'inv-nobody', other, 3))), 'invite-unknown');
});

test('Add My Other Machine (D-18): a forMember invite is used by a device.add for that member, then refused invite-used to a member.admit', () => {
  const { line, jo, admit } = lineWithJo();
  const laptop = line.world.device('JO-LAPTOP', JO);
  line.next('member.invite', inviteData('inv-jo-laptop', { forMember: JO }));
  // A forMember invite cannot admit a new member.
  const stranger = line.world.device('KIM', 'mbr-kim');
  assert.equal(refusalOf(line, line.tryEntry('member.admit', admitData('mbr-kim', 'inv-jo-laptop', stranger, 3))), 'invite-for-device');
  // Signed after the expiry, the device.add is refused like an admission.
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: JO, device: laptop.descriptor(5), invite: 'inv-jo-laptop' }, { at: AFTER_EXPIRY })), 'invite-expired');
  const added = line.next('device.add', { member: JO, device: laptop.descriptor(5), invite: 'inv-jo-laptop' });
  const state = line.fold();
  assert.deepEqual(state.refused, []);
  const view = rosterView(state);
  assert.equal(view.isAdmitted(laptop.writer, added.hash), true);
  assert.equal(view.isAdmitted(laptop.writer, admit.hash), false);
  assert.equal(view.isAdmitted(jo.writer, added.hash), true);
  assert.equal(inviteAt(state.members, 'inv-jo-laptop', state.positionOf.get(added.hash) as number)?.state, 'used');
  assert.equal(refusalOf(line, line.tryEntry('member.admit', admitData('mbr-kim', 'inv-jo-laptop', stranger, 3))), 'invite-used');
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: JO, device: line.world.device('JO-TABLET', JO).descriptor(6), invite: 'inv-jo-laptop' })), 'invite-used');
});

test('Add My Other Machine (D-18): a device.add naming an invite made for another member, or a new-member invite, is refused invite-wrong-member', () => {
  const { line } = lineWithJo();
  const kim = line.world.device('KIM', 'mbr-kim');
  line.next('member.invite', inviteData('inv-kim'));
  line.next('member.admit', admitData('mbr-kim', 'inv-kim', kim, 3));
  line.next('member.invite', inviteData('inv-kim-laptop', { forMember: 'mbr-kim' }));
  line.next('member.invite', inviteData('inv-new'));
  const laptop = line.world.device('JO-LAPTOP', JO);
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: JO, device: laptop.descriptor(5), invite: 'inv-kim-laptop' })), 'invite-wrong-member');
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: JO, device: laptop.descriptor(5), invite: 'inv-new' })), 'invite-wrong-member');
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: JO, device: laptop.descriptor(5), invite: 'inv-nobody' })), 'invite-unknown');
  // A forMember invite for a member the roster does not have is refused when it is written.
  assert.equal(refusalOf(line, line.tryEntry('member.invite', inviteData('inv-ghost', { forMember: 'mbr-ghost' }))), 'member-unknown');
});
