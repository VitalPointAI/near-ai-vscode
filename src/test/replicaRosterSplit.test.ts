// The authority rules of the single-writer roster (31-17; DESIGN 7.1 and 15.1; D-08 to D-12, D-48; owner decision 5): the deputy lead, lead handover,
// naming the deputy, roster splits and the person's choice, and entries that cite a branch nobody chose. Every roster here is folded by the real
// roster fold from signed, sealed entries, and every main-fold check reads the real roster view.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { rosterView } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
import type { SealedEntry } from '../domain/replica/entry';
import { DEMO_CLEARANCE, INVITE_EXPIRES, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import type { Written } from './helpers/replicaWorld';

const secretHash = (label: string): string => createHash('sha256').update(`join-secret/${label}`, 'utf8').digest('hex');

interface Admitted { invite: Written; admit: Written }

// An invitation and its admission, both written by one roster writer: the device joins at the slot with the roles given.
function admit(world: RosterWorld, by: RosterDevice, prev: string, device: RosterDevice, slot: number, roles: string[] = ['member']): Admitted {
  const id = `inv-${device.label.toLowerCase()}`;
  const name = `Person ${device.label}`;
  const invite = world.rosterEntry(by, 'member.invite', { invite: id, name, seat: 'j2-chief', roles, clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: secretHash(id) }, prev);
  const admitted = world.rosterEntry(by, 'member.admit', { member: device.member, invite: id, name, seat: 'j2-chief', roles, clearance: DEMO_CLEARANCE, device: device.descriptor(slot), agentSeats: [] }, invite.hash);
  return { invite, admit: admitted };
}

// A roster change that touches nothing but the invitations, so a test can write as many as it needs on any head.
function inviteBy(world: RosterWorld, by: RosterDevice, prev: string, id: string): Written {
  return world.rosterEntry(by, 'member.invite', { invite: id, name: `Invitee ${id}`, seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: secretHash(id) }, prev);
}

interface Staff {
  world: RosterWorld;
  lead: RosterDevice;
  // Admitted as plain members; the tests name deputies and leads among them.
  dee: RosterDevice;
  em: RosterDevice;
  eve: RosterDevice;
  genesis: Written;
  // The roster after the three admissions.
  head: string;
}

// Genesis by the lead, then Dee (slot 2), Em (slot 3) and Eve (slot 4) admitted as members.
function staff(): Staff {
  const world = createRosterWorld();
  const dee = world.device('DEE', 'mbr-dee');
  const em = world.device('EM', 'mbr-em');
  const eve = world.device('EVE', 'mbr-eve');
  const { entry: genesis } = world.genesis();
  const first = admit(world, world.lead, genesis.hash, dee, 2);
  const second = admit(world, world.lead, first.admit.hash, em, 3);
  const third = admit(world, world.lead, second.admit.hash, eve, 4);
  return { world, lead: world.lead, dee, em, eve, genesis, head: third.admit.hash };
}

const headOf = (state: RosterState): string => state.positions[state.positions.length - 1];
const refusalsOf = (state: RosterState): Array<[string, string, string]> => state.refused.map((item): [string, string, string] => [item.hash, item.kind, item.reason]);
// The roster folded from a fixed set of entries (each test keeps the entries it wrote so far and adds the one it judges).
const foldWith = (s: Staff, entries: readonly SealedEntry[]): RosterState => s.world.foldRoster({ entries });

// ---- Task 1: the deputy ----------------------------------------------------------------------------------------------------------------------

test('the lead names a deputy: deputy_lead is held from that roster on and not before; naming the lead or an unknown member is refused', () => {
  const s = staff();
  const named = s.world.rosterEntry(s.lead, 'deputy.name', { member: s.dee.member }, s.head);
  const base = [...s.world.entries];
  const state = foldWith(s, base);
  assert.deepEqual(state.refused, []);
  assert.equal(headOf(state), named.hash);
  const view = rosterView(state);
  assert.equal(view.hasRole(s.dee.member, 'deputy_lead', named.hash), true);
  assert.equal(view.hasRole(s.dee.member, 'deputy_lead', s.head), false);
  assert.equal(view.hasRole(s.dee.member, 'staff_lead', named.hash), false);
  assert.equal(view.hasRole(s.lead.member, 'staff_lead', named.hash), true);
  assert.equal(view.hasRole(s.lead.member, 'deputy_lead', named.hash), false);
  assert.equal(view.roleWithdrawnBy(s.dee.member, 'deputy_lead', named.hash), undefined);
  assert.equal(view.roleWithdrawnBy(s.em.member, 'deputy_lead', named.hash), undefined);

  for (const [member, reason] of [[s.lead.member, 'names-the-lead'], ['mbr-nobody', 'not-an-active-member']] as const) {
    const bad = s.world.rosterEntry(s.lead, 'deputy.name', { member }, named.hash);
    const refused = foldWith(s, [...base, bad.entry]);
    assert.deepEqual(refusalsOf(refused), [[bad.hash, 'deputy.name', reason]], member);
    assert.equal(headOf(refused), named.hash, member);
  }
});

test('the deputy\'s device writes a roster entry and it applies; the deputy naming a deputy is refused deputy-cannot-name-deputy; a plain member is refused not-a-roster-writer', () => {
  const s = staff();
  const named = s.world.rosterEntry(s.lead, 'deputy.name', { member: s.dee.member }, s.head);
  const byDeputy = inviteBy(s.world, s.dee, named.hash, 'inv-by-deputy');
  const deputyNames = s.world.rosterEntry(s.dee, 'deputy.name', { member: s.eve.member }, byDeputy.hash);
  const byMember = inviteBy(s.world, s.em, byDeputy.hash, 'inv-by-member');
  const state = s.world.foldRoster();
  assert.equal(headOf(state), byDeputy.hash);
  assert.ok(state.members.invites.has('inv-by-deputy'));
  assert.ok(!state.members.invites.has('inv-by-member'));
  assert.deepEqual(refusalsOf(state).sort(), [
    [deputyNames.hash, 'deputy.name', 'deputy-cannot-name-deputy'],
    [byMember.hash, 'member.invite', 'not-a-roster-writer']
  ].sort());
  const view = rosterView(state);
  // The deputy stays the deputy: the refused naming changed nothing.
  assert.equal(view.hasRole(s.dee.member, 'deputy_lead', byDeputy.hash), true);
  assert.equal(view.hasRole(s.eve.member, 'deputy_lead', byDeputy.hash), false);
  // The deputy also admits: an invitation and its admission written by the deputy's device both apply.
  const late = s.world.device('LATE', 'mbr-late');
  const admitted = admit(s.world, s.dee, byDeputy.hash, late, 5);
  // Folded without the two refused entries, which cite the same head and would otherwise be judged with the invitation there.
  const after = foldWith(s, s.world.entries.filter((entry) => entry !== deputyNames.entry && entry !== byMember.entry));
  assert.deepEqual(after.refused, []);
  assert.equal(headOf(after), admitted.admit.hash);
  assert.equal(rosterView(after).isAdmitted(late.writer, admitted.admit.hash), true);
});

test('the lead replaces the deputy: the old deputy\'s next roster entry is refused not-a-roster-writer, and its entry at the earlier roster stays applied', () => {
  const s = staff();
  const first = s.world.rosterEntry(s.lead, 'deputy.name', { member: s.dee.member }, s.head);
  const before = inviteBy(s.world, s.dee, first.hash, 'inv-before');
  const second = s.world.rosterEntry(s.lead, 'deputy.name', { member: s.eve.member }, before.hash);
  const after = inviteBy(s.world, s.dee, second.hash, 'inv-after');
  const byNewDeputy = inviteBy(s.world, s.eve, second.hash, 'inv-new-deputy');
  const base = s.world.entries.filter((entry) => entry !== byNewDeputy.entry);
  const state = foldWith(s, base);
  assert.deepEqual(refusalsOf(state), [[after.hash, 'member.invite', 'not-a-roster-writer']]);
  assert.equal(headOf(state), second.hash);
  // Authority at the cited roster: the old deputy's entry before the change is still applied, at its own position.
  assert.equal(state.positionOf.get(before.hash), state.positionOf.get(first.hash)! + 1);
  assert.ok(state.members.invites.has('inv-before'));
  assert.ok(!state.members.invites.has('inv-after'));
  const view = rosterView(state);
  assert.equal(view.hasRole(s.dee.member, 'deputy_lead', before.hash), true);
  assert.equal(view.hasRole(s.dee.member, 'deputy_lead', second.hash), false);
  assert.equal(view.hasRole(s.eve.member, 'deputy_lead', second.hash), true);
  assert.equal(view.roleWithdrawnBy(s.dee.member, 'deputy_lead', first.hash), second.hash);
  // The new deputy writes at the new head.
  const withNew = foldWith(s, [...base.filter((entry) => entry !== after.entry), byNewDeputy.entry]);
  assert.deepEqual(withNew.refused, []);
  assert.equal(headOf(withNew), byNewDeputy.hash);
});
