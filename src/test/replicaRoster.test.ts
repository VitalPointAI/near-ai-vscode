// The membership and device rules of the roster fold (DESIGN 15.1 and 15.2; D-10 to D-12, D-17 to D-20, D-41, D-48), one named test per transition.
// Test titles start with the transition they cover. Every roster entry here is signed by the lead's device; deputy-signed entries reach the members
// module through the driver only after 31-17, so the deputy rule is tested by calling the module with a ctx that names the signer's member as deputy.
//
// Builders beyond the shared roster world live in this file (the world helper is not edited in this wave).
import assert from 'node:assert/strict';
import test from 'node:test';
import { signCheckpoint, verifyCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint } from '../domain/replica/checkpoint';
import { createLocalDoc, localInsert } from '../domain/replica/doc';
import { GENESIS_PREV, buildEntry } from '../domain/replica/entry';
import { foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { joinSecretHash } from '../domain/replica/invite';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { ORIGIN_ROSTER, rosterView } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
import { clientIdOf, MAX_SLOT } from '../domain/replica/clientIds';
import { MEMBER_REFUSALS, applyGenesisLead, applyMemberEntry, createMembersState, hubCellsAt, inviteAt } from '../domain/replica/rosterMembers';
import type { MemberApplyOutcome, MembersState } from '../domain/replica/rosterMembers';
import type { VerifiedEntry } from '../domain/replica/verify';
import { DEMO_CLEARANCE, INVITE_EXPIRES, ROSTER_AT, createRosterWorld, rosterDevice } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import { updateData } from './helpers/replicaWorld';
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

// ---- devices (D-19, D-20, D-41) ----

// An entry as the driver hands it to the members module, for calling the module directly: only the fields the module reads.
function bareEntry(kind: string, data: unknown, signer: string, at: string = ROSTER_AT): VerifiedEntry {
  return { hash: 'e'.repeat(64), header: { writer: signer }, body: { kind, at }, data, member: '' } as unknown as VerifiedEntry;
}

const reasonOf = (outcome: MemberApplyOutcome): string => (outcome.status === 'applied' ? 'applied' : outcome.reason);

test('15.2 (none) -> active: admit and device.add each make an active device with its slot; clientIdOwner and deviceEncryptionKey answer for it', () => {
  const { line, jo, admit } = lineWithJo();
  const laptop = line.world.device('JO-LAPTOP', JO);
  const added = line.next('device.add', { member: JO, device: laptop.descriptor(5) });
  const state = line.fold();
  assert.deepEqual(state.refused, []);
  const view = rosterView(state);
  assert.equal(view.clientIdOwner?.(clientIdOf(2, 7), admit.hash), jo.writer);
  assert.equal(view.deviceEncryptionKey?.(jo.writer, admit.hash), jo.x25519);
  assert.equal(view.clientIdOwner?.(clientIdOf(5, 0), added.hash), laptop.writer);
  assert.equal(view.clientIdOwner?.(clientIdOf(5, 0), admit.hash), undefined);
  assert.equal(view.deviceEncryptionKey?.(laptop.writer, added.hash), laptop.x25519);
  assert.equal(view.deviceEncryptionKey?.(laptop.writer, admit.hash), undefined);
  assert.equal(view.deviceKey(laptop.writer)?.member, JO);
  // A device for a member the roster does not have is refused.
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: 'mbr-nobody', device: line.world.device('X', 'mbr-nobody').descriptor(9) })), 'member-unknown');
});

test('device refusals: bad-binding, slot-in-use (even of a revoked device), slot-out-of-range and device-exists, through the fold', () => {
  const { line, jo } = lineWithJo();
  const laptop = line.world.device('JO-LAPTOP', JO);
  // The laptop's descriptor carrying Jo's binding signature: the X25519 key is not bound by the laptop's own signing key (T-31-41).
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: JO, device: { ...laptop.descriptor(5), x25519Sig: jo.x25519Sig } })), 'bad-binding');
  // Another device's X25519 key with this device's signature over it does not verify either.
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: JO, device: { ...laptop.descriptor(5), x25519: jo.x25519 } })), 'bad-binding');
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: JO, device: laptop.descriptor(2) })), 'slot-in-use');
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: JO, device: laptop.descriptor(1) })), 'slot-in-use');
  const { slot: _slot, ...noSlot } = laptop.descriptor(5);
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: JO, device: noSlot })), 'slot-out-of-range');
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: JO, device: jo.descriptor(5) })), 'device-exists');
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: JO, device: line.world.lead.descriptor(5) })), 'device-exists');
  // A slot outside 1 to 4095 never reaches the module: the wire schema refuses it first.
  for (const slot of [0, MAX_SLOT + 1]) {
    const attempt = line.tryEntry('device.add', { member: JO, device: laptop.descriptor(slot) });
    assert.equal(attempt.state.positions[attempt.state.positions.length - 1], line.head);
    assert.ok(attempt.state.refused.some((item) => item.hash === attempt.written.hash), String(slot));
  }
  // The slot of a revoked device is never given again (P-31-19).
  line.next('device.add', { member: JO, device: laptop.descriptor(5) });
  line.next('device.revoke', { member: JO, writer: laptop.writer });
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: JO, device: line.world.device('JO-TABLET', JO).descriptor(5) })), 'slot-in-use');
  // Nor may the revoked device come back under a new slot.
  assert.equal(refusalOf(line, line.tryEntry('device.add', { member: JO, device: laptop.descriptor(6) })), 'device-exists');
});

test('slot-out-of-range in the module for slot 0 and 4096, and device-limit for a 4096th device once every slot was given (D-41)', () => {
  const lead = rosterDevice('LEAD', 'mbr-lead');
  const state: MembersState = createMembersState({ lead: { member: 'mbr-lead', writer: lead.writer, publicKey: lead.publicKey, x25519: lead.x25519 } });
  assert.equal(applyGenesisLead(state, lead.descriptor(1), 1).status, 'applied');
  const add = (device: { writer: string; publicKey: string; x25519: string; x25519Sig: string; slot?: number }, position: number): string =>
    reasonOf(applyMemberEntry(state, bareEntry('device.add', { member: 'mbr-lead', device }, lead.writer), { position, lead: 'mbr-lead' }));
  const probe = rosterDevice('PROBE', 'mbr-lead');
  assert.equal(add(probe.descriptor(0), 2), 'slot-out-of-range');
  assert.equal(add(probe.descriptor(MAX_SLOT + 1), 2), 'slot-out-of-range');
  // Slots 2 to 4095, one device each, through the same rule (each binding checked).
  for (let slot = 2; slot <= MAX_SLOT; slot += 1) assert.equal(add(rosterDevice(`SLOT-${slot}`, 'mbr-lead').descriptor(slot), slot), 'applied', String(slot));
  assert.equal(state.slots.size, MAX_SLOT);
  assert.equal(add(probe.descriptor(MAX_SLOT), MAX_SLOT + 1), 'device-limit');
  assert.equal(add(probe.descriptor(2), MAX_SLOT + 1), 'device-limit');
  assert.equal(state.devices.has(probe.writer), false);
});

test('15.2 active -> rotated: device.rotate ends the old writer at the rotation and starts the new one there with a new slot', () => {
  const { line, jo, admit } = lineWithJo();
  const fresh = line.world.device('JO-NEW', JO);
  assert.equal(refusalOf(line, line.tryEntry('device.rotate', { member: JO, from: fresh.writer, device: fresh.descriptor(6) })), 'device-unknown');
  assert.equal(refusalOf(line, line.tryEntry('device.rotate', { member: 'mbr-lead', from: jo.writer, device: fresh.descriptor(6) })), 'device-unknown');
  assert.equal(refusalOf(line, line.tryEntry('device.rotate', { member: JO, from: jo.writer, device: line.world.lead.descriptor(6) })), 'device-exists');
  assert.equal(refusalOf(line, line.tryEntry('device.rotate', { member: JO, from: jo.writer, device: fresh.descriptor(2) })), 'slot-in-use');
  const rotate = line.next('device.rotate', { member: JO, from: jo.writer, device: fresh.descriptor(6) });
  const state = line.fold();
  assert.deepEqual(state.refused, []);
  const view = rosterView(state);
  // The old key stays valid at rosters before the rotation point (D-20).
  assert.equal(view.isAdmitted(jo.writer, admit.hash), true);
  assert.equal(view.isAdmitted(jo.writer, rotate.hash), false);
  assert.equal(view.isAdmitted(fresh.writer, admit.hash), false);
  assert.equal(view.isAdmitted(fresh.writer, rotate.hash), true);
  assert.equal(view.deviceKey(jo.writer)?.publicKey, jo.publicKey);
  assert.equal(view.clientIdOwner?.(clientIdOf(2, 0), admit.hash), jo.writer);
  assert.equal(view.clientIdOwner?.(clientIdOf(2, 0), rotate.hash), undefined);
  assert.equal(view.clientIdOwner?.(clientIdOf(6, 0), rotate.hash), fresh.writer);
  assert.equal(view.memberName(JO, rotate.hash), 'Jo Analyst');
  // The rotated-away writer cannot be rotated again.
  assert.equal(refusalOf(line, line.tryEntry('device.rotate', { member: JO, from: jo.writer, device: line.world.device('JO-THIRD', JO).descriptor(7) })), 'device-unknown');
});

test('15.2 active -> revoked: device.revoke ends the device from its position on and leaves earlier rosters as they were', () => {
  const { line, jo, admit } = lineWithJo();
  assert.equal(refusalOf(line, line.tryEntry('device.revoke', { member: 'mbr-lead', writer: jo.writer })), 'device-unknown');
  const revoke = line.next('device.revoke', { member: JO, writer: jo.writer, reason: 'Laptop lost.' });
  const state = line.fold();
  assert.deepEqual(state.refused, []);
  const view = rosterView(state);
  assert.equal(view.isAdmitted(jo.writer, admit.hash), true);
  assert.equal(view.isAdmitted(jo.writer, revoke.hash), false);
  assert.equal(view.deviceEncryptionKey?.(jo.writer, revoke.hash), undefined);
  assert.equal(view.clientIdOwner?.(clientIdOf(2, 0), revoke.hash), undefined);
  // The member stays a member with no device.
  assert.equal(view.memberName(JO, revoke.hash), 'Jo Analyst');
  assert.equal(refusalOf(line, line.tryEntry('device.revoke', { member: JO, writer: jo.writer })), 'device-unknown');
});

test('15.2 active -> revoked: the lead\'s last device revoked by the lead is refused last-lead-device; signed by the deputy it applies (D-09, D-48)', () => {
  const { line, jo } = lineWithJo();
  const lead = line.world.lead;
  assert.equal(refusalOf(line, line.tryEntry('device.revoke', { member: lead.member, writer: lead.writer })), 'last-lead-device');
  // The members module's rule, with a ctx naming the signer's member as deputy (deputy-signed entries reach it through the driver after 31-17).
  const revokeData = { member: lead.member, writer: lead.writer, rosterPrev: line.head };
  const position = line.fold().positions.length;
  const fresh = (): MembersState => line.fold().members;
  assert.equal(reasonOf(applyMemberEntry(fresh(), bareEntry('device.revoke', revokeData, lead.writer), { position, lead: lead.member, deputy: JO })), 'last-lead-device');
  assert.equal(reasonOf(applyMemberEntry(fresh(), bareEntry('device.revoke', revokeData, jo.writer), { position, lead: lead.member })), 'last-lead-device');
  const byDeputy = fresh();
  assert.equal(reasonOf(applyMemberEntry(byDeputy, bareEntry('device.revoke', revokeData, jo.writer), { position, lead: lead.member, deputy: JO })), 'applied');
  assert.equal(byDeputy.devices.get(lead.writer)?.find((record) => record.until === undefined), undefined);
  // With a second device the lead may revoke the first one.
  const spare = line.world.device('LEAD-SPARE', lead.member);
  line.next('device.add', { member: lead.member, device: spare.descriptor(7) });
  const revoke = line.next('device.revoke', { member: lead.member, writer: lead.writer });
  const state = line.fold();
  assert.deepEqual(state.refused, []);
  const view = rosterView(state);
  assert.equal(view.isAdmitted(lead.writer, revoke.hash), false);
  assert.equal(view.isAdmitted(spare.writer, revoke.hash), true);
  assert.equal(view.hasRole(lead.member, 'staff_lead', revoke.hash), true);
});

test('15.2 active -> rotated: the lead rotates its own device; the new device writes the roster from the rotation on and the old one is refused not-a-roster-writer', () => {
  const line = createLine();
  const lead = line.world.lead;
  const fresh = line.world.device('LEAD-NEW', lead.member);
  const rotate = line.next('device.rotate', { member: lead.member, from: lead.writer, device: fresh.descriptor(8) });
  // The next roster entry, signed by the new device.
  const invite = line.world.rosterEntry(fresh, 'member.invite', inviteData('inv-jo'), rotate.hash);
  const state = line.world.foldRoster({ entries: [...line.entries, invite.entry] });
  assert.deepEqual(state.refused, []);
  assert.equal(state.positions[state.positions.length - 1], invite.hash);
  assert.equal(rosterView(state).isAdmitted(lead.writer, rotate.hash), false);
  // The same entry signed by the rotated-away device is refused at the head.
  const stale = line.world.rosterEntry(lead, 'member.invite', inviteData('inv-kim'), rotate.hash);
  const refusedState = line.world.foldRoster({ entries: [...line.entries, stale.entry] });
  assert.deepEqual(refusedState.refused, [{ hash: stale.hash, kind: 'member.invite', reason: 'not-a-roster-writer' }]);
});

// ---- quarantine, release and the hub (D-04, D-12, D-20, D-48) ----

const PRODUCT = 'intel-estimate';
const BRANCH_TEXT = ['Enemy holds the ridge.', 'Enemy left the ridge.', 'Enemy reinforced the ridge.'];

interface Forked { line: Line; jo: RosterDevice; admit: Written; forks: Array<{ client: string; update: string }>; entries: unknown[] }

// Jo is admitted at slot 2 and granted the base cell; then Jo's device signs three different entries at seq 0 of the project stream, each followed by
// its own seq 1, as a device restored from an old backup might.
function forkedJo(): Forked {
  const { line, jo, admit } = lineWithJo();
  line.world.grant(line.world.lead, { roster: admit.hash, to: [jo] });
  const key = line.world.epochKeyOf(line.world.project, 1);
  const entries: unknown[] = [];
  const forks = BRANCH_TEXT.map((text, branch) => {
    const clientId = clientIdOf(2, branch);
    const body = (lamport: number, kind: string, data: unknown) => ({ deps: [], roster: admit.hash, lamport, at: ROSTER_AT, actor: { kind: 'person' as const }, kind, data });
    const client = buildEntry({ signer: jo.signer, key, stream: line.world.project, seq: 0, prev: GENESIS_PREV, epoch: 1, body: body(1, 'doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } }) });
    const update = buildEntry({ signer: jo.signer, key, stream: line.world.project, seq: 1, prev: client.hash, epoch: 1, body: body(2, 'doc.update', updateData(PRODUCT, localInsert(createLocalDoc(clientId), 0, text))) });
    for (const built of [client, update]) {
      entries.push(built.entry);
      for (const blob of built.blobs) line.world.blobs.set(blob.hash, blob);
    }
    return { client: client.hash, update: update.hash };
  });
  return { line, jo, admit, forks, entries };
}

// The main fold of the roster line and Jo's forked entries, through the real roster view folded from the same line.
function mainFold(forked: Forked): { roster: RosterState; result: FoldResult } {
  const roster = forked.line.fold();
  const result = foldEntries([...forked.line.entries, ...forked.entries], forked.line.world.ctxFor(roster, forked.line.world.ringFor(forked.jo)));
  return { roster, result };
}

test('15.2 active -> quarantined: two or more headers at one seq make the main fold quarantine the device; a device.quarantine entry changes no roster answer (D-48)', () => {
  const forked = forkedJo();
  const { line, jo } = forked;
  const before = mainFold(forked);
  assert.deepEqual(before.result.quarantined, [{ writer: jo.writer, stream: line.world.project, fromSeq: 0 }]);
  for (const fork of forked.forks) for (const hash of [fork.client, fork.update]) assert.ok(before.result.excluded.includes(hash), hash);
  // The lead records the quarantine: the entry applies and takes a position, and every member answer is what it was at the roster before it.
  const head = line.head;
  const quarantine = line.next('device.quarantine', { writer: jo.writer, stream: line.world.project, seq: 0 });
  const after = mainFold(forked);
  assert.deepEqual(after.roster.refused, []);
  assert.equal(after.roster.positions[after.roster.positions.length - 1], quarantine.hash);
  assert.deepEqual(after.roster.members, before.roster.members);
  assert.deepEqual(memberAnswers(after.roster, JO, [jo], quarantine.hash), memberAnswers(after.roster, JO, [jo], head));
  assert.equal(rosterView(after.roster).chosenBranch(jo.writer, line.world.project, 0), undefined);
  // The quarantine comes from the proof in the main fold, not from the entry: it is the same with or without it.
  assert.deepEqual(after.result.quarantined, before.result.quarantined);
  // A quarantine naming a device the roster never had is refused.
  assert.equal(refusalOf(line, line.tryEntry('device.quarantine', { writer: 'a'.repeat(64), stream: line.world.project, seq: 0 })), 'device-unknown');
});

test('15.2 quarantined -> active: device.release naming the third of three branches feeds chosenBranch, and a fresh main fold admits that branch and its later entries', () => {
  const forked = forkedJo();
  const { line, jo, forks } = forked;
  // The branch with the highest hash: never one of the two headers the proof itself carries.
  const order = forks.map((fork, index) => ({ fork, index })).sort((x, y) => (x.fork.client < y.fork.client ? -1 : 1));
  const chosen = order[2];
  const release = line.next('device.release', { writer: jo.writer, stream: line.world.project, seq: 0, branch: chosen.fork.client });
  const { roster, result } = mainFold(forked);
  assert.deepEqual(roster.refused, []);
  assert.equal(roster.positions[roster.positions.length - 1], release.hash);
  assert.equal(rosterView(roster).chosenBranch(jo.writer, line.world.project, 0), chosen.fork.client);
  assert.equal(rosterView(roster).chosenBranch(jo.writer, line.world.project, 1), undefined);
  assert.deepEqual(result.quarantined.filter((record) => record.writer === jo.writer), []);
  assert.ok(result.applied.includes(chosen.fork.client));
  assert.ok(result.applied.includes(chosen.fork.update));
  for (const other of order.slice(0, 2)) for (const hash of [other.fork.client, other.fork.update]) assert.ok(result.excluded.includes(hash), hash);
  const products = result.families.doc as ProductTextOutput[];
  assert.equal(products.length, 1);
  assert.equal(products[0].text, BRANCH_TEXT[chosen.index]);
  // The device is admitted throughout: a release lifts the quarantine, it does not re-admit.
  assert.equal(rosterView(roster).isAdmitted(jo.writer, release.hash), true);
  assert.equal(refusalOf(line, line.tryEntry('device.release', { writer: 'a'.repeat(64), stream: line.world.project, seq: 0, branch: chosen.fork.client })), 'device-unknown');
});

test('15.2 quarantined -> revoked: device.revoke of the quarantined device applies and it is not admitted from then on', () => {
  const forked = forkedJo();
  const { line, jo, admit } = forked;
  line.next('device.quarantine', { writer: jo.writer, stream: line.world.project, seq: 0 });
  const revoke = line.next('device.revoke', { member: JO, writer: jo.writer, reason: 'Signed two histories.' });
  const { roster, result } = mainFold(forked);
  assert.deepEqual(roster.refused, []);
  const view = rosterView(roster);
  assert.equal(view.isAdmitted(jo.writer, admit.hash), true);
  assert.equal(view.isAdmitted(jo.writer, revoke.hash), false);
  assert.equal(view.deviceEncryptionKey?.(jo.writer, revoke.hash), undefined);
  assert.equal(view.chosenBranch(jo.writer, line.world.project, 0), undefined);
  // No branch was released, so the main fold keeps every branch out.
  assert.deepEqual(result.quarantined, [{ writer: jo.writer, stream: line.world.project, fromSeq: 0 }]);
});

const CERT_PIN = 'c'.repeat(64);

function checkpointBy(device: RosterDevice, project: string, rosterHead: string): ReturnType<typeof signCheckpoint> {
  const checkpoint: Checkpoint = { type: 'checkpoint', v: 2, project, signer: device.writer, rosterHead, streams: [] };
  return signCheckpoint(device.signer, checkpoint);
}

test('the hub member: hub.admit gives the hub device a slot and checkpointSigner from then on; hub.grant records a cell; hub.revoke ends both (D-04, D-12)', () => {
  const { line, jo, admit } = lineWithJo();
  const hub = line.world.device('HUB', 'hub-main');
  const hubAdmit = line.next('hub.admit', { hub: 'hub-main', device: hub.descriptor(3), certPin: CERT_PIN, ceiling: DEMO_CLEARANCE });
  const grant = line.next('hub.grant', { hub: 'hub-main', cell: line.world.project });
  const revoke = line.next('hub.revoke', { hub: 'hub-main', reason: 'Hub replaced.' });
  const state = line.fold();
  assert.deepEqual(state.refused, []);
  const view = rosterView(state);
  assert.equal(view.checkpointSigner(hub.writer, admit.hash), false);
  assert.equal(view.checkpointSigner(hub.writer, hubAdmit.hash), true);
  assert.equal(view.checkpointSigner(hub.writer, grant.hash), true);
  assert.equal(view.checkpointSigner(hub.writer, revoke.hash), false);
  assert.equal(view.checkpointSigner(jo.writer, hubAdmit.hash), false);
  assert.equal(view.checkpointSigner(line.world.lead.writer, hubAdmit.hash), false);
  assert.equal(view.clientIdOwner?.(clientIdOf(3, 0), hubAdmit.hash), hub.writer);
  // A version 2 checkpoint the hub signs verifies; one a member device signs does not (T-31-44); after the revoke the hub's does not either.
  const project = line.world.project;
  const signed = verifyCheckpoint(checkpointBy(hub, project, hubAdmit.hash), view);
  assert.equal(signed.ok, true);
  const byMember = verifyCheckpoint(checkpointBy(jo, project, hubAdmit.hash), view);
  assert.equal(byMember.ok ? 'ok' : byMember.reason, 'not-a-checkpoint-signer');
  const afterRevoke = verifyCheckpoint(checkpointBy(hub, project, revoke.hash), view);
  assert.equal(afterRevoke.ok ? 'ok' : afterRevoke.reason, 'not-a-checkpoint-signer');
  // The granted cell is recorded for the hub from the grant on.
  const at = (hash: string): number => state.positionOf.get(hash) as number;
  assert.deepEqual(hubCellsAt(state.members, 'hub-main', at(hubAdmit.hash)), []);
  assert.deepEqual(hubCellsAt(state.members, 'hub-main', at(grant.hash)), [project]);
  assert.equal(hubCellsAt(state.members, 'hub-main', at(revoke.hash)), undefined);
});

test('hub refusals: an id already used is member-exists or hub-exists, an unknown hub is hub-unknown, and a hub device takes a slot like any device', () => {
  const { line } = lineWithJo();
  const hub = line.world.device('HUB', 'hub-main');
  assert.equal(refusalOf(line, line.tryEntry('hub.admit', { hub: JO, device: hub.descriptor(3), certPin: CERT_PIN, ceiling: DEMO_CLEARANCE })), 'member-exists');
  assert.equal(refusalOf(line, line.tryEntry('hub.admit', { hub: 'hub-main', device: hub.descriptor(2), certPin: CERT_PIN, ceiling: DEMO_CLEARANCE })), 'slot-in-use');
  assert.equal(refusalOf(line, line.tryEntry('hub.grant', { hub: 'hub-main', cell: line.world.project })), 'hub-unknown');
  assert.equal(refusalOf(line, line.tryEntry('hub.revoke', { hub: 'hub-main' })), 'hub-unknown');
  line.next('hub.admit', { hub: 'hub-main', device: hub.descriptor(3), certPin: CERT_PIN, ceiling: DEMO_CLEARANCE });
  assert.equal(refusalOf(line, line.tryEntry('hub.admit', { hub: 'hub-main', device: line.world.device('HUB-2', 'hub-main').descriptor(4), certPin: CERT_PIN, ceiling: DEMO_CLEARANCE })), 'hub-exists');
  // A member cannot take the hub's id, and the hub's device cannot join as a member's device.
  line.next('member.invite', inviteData('inv-hub-name'));
  const kim = line.world.device('KIM', 'mbr-kim');
  assert.equal(refusalOf(line, line.tryEntry('member.admit', admitData('hub-main', 'inv-hub-name', kim, 5))), 'member-exists');
  assert.equal(refusalOf(line, line.tryEntry('member.admit', admitData('mbr-kim', 'inv-hub-name', hub, 5))), 'device-exists');
  line.next('hub.revoke', { hub: 'hub-main' });
  assert.equal(refusalOf(line, line.tryEntry('hub.revoke', { hub: 'hub-main' })), 'hub-unknown');
  assert.equal(refusalOf(line, line.tryEntry('hub.admit', { hub: 'hub-main', device: line.world.device('HUB-3', 'hub-main').descriptor(6), certPin: CERT_PIN, ceiling: DEMO_CLEARANCE })), 'hub-exists');
});

test('every member, device, hub and invite kind has its rule: none is refused roster-kind-pending', () => {
  const forked = forkedJo();
  const { line, jo } = forked;
  const laptop = line.world.device('JO-LAPTOP', JO);
  const fresh = line.world.device('JO-NEW', JO);
  const hub = line.world.device('HUB', 'hub-main');
  line.next('member.invite', inviteData('inv-kim'));
  line.next('invite.void', { invite: 'inv-kim' });
  line.next('member.update', { member: JO, seat: 'j2-deputy' });
  line.next('device.add', { member: JO, device: laptop.descriptor(5) });
  line.next('device.rotate', { member: JO, from: laptop.writer, device: fresh.descriptor(6) });
  line.next('device.quarantine', { writer: jo.writer, stream: line.world.project, seq: 0 });
  line.next('device.release', { writer: jo.writer, stream: line.world.project, seq: 0, branch: forked.forks[0].client });
  line.next('device.revoke', { member: JO, writer: fresh.writer });
  line.next('hub.admit', { hub: 'hub-main', device: hub.descriptor(3), certPin: CERT_PIN, ceiling: DEMO_CLEARANCE });
  line.next('hub.grant', { hub: 'hub-main', cell: line.world.project });
  line.next('hub.revoke', { hub: 'hub-main' });
  line.next('member.remove', { member: JO });
  const state = line.fold();
  assert.deepEqual(state.refused, []);
  assert.equal(state.positions.length, line.entries.length + 1);
});
