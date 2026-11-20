// The authority rules of the single-writer roster (31-17; DESIGN 7.1 and 15.1; D-08 to D-12, D-48; owner decision 5): the deputy lead, lead handover,
// naming the deputy, roster splits and the person's choice, and entries that cite a branch nobody chose. Every roster here is folded by the real
// roster fold from signed, sealed entries, and every main-fold check reads the real roster view.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, localInsert } from '../domain/replica/doc';
import { addEntries, createFoldState, foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { ROSTER_REFUSALS, ROSTER_SPLIT_TEXT, rosterView } from '../domain/replica/roster';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { KEEP_REASONS, VERIFY_HOLDS } from '../domain/replica/verify';
import type { RosterState } from '../domain/replica/roster';
import type { SealedEntry } from '../domain/replica/entry';
import { DEMO_CLEARANCE, INVITE_EXPIRES, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import { permutations, updateData } from './helpers/replicaWorld';
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

// ---- Task 2: lead handover -------------------------------------------------------------------------------------------------------------------

test('a planned handover by the lead: staff_lead is the new lead\'s from that roster on and the old lead\'s before; the old lead\'s later entry is refused', () => {
  const s = staff();
  const handover = s.world.rosterEntry(s.lead, 'lead.handover', { to: s.em.member, reason: 'planned' }, s.head);
  const byOld = inviteBy(s.world, s.lead, handover.hash, 'inv-old-lead');
  const byNew = inviteBy(s.world, s.em, handover.hash, 'inv-new-lead');
  const base = s.world.entries.filter((entry) => entry !== byNew.entry);
  const state = foldWith(s, base);
  assert.deepEqual(refusalsOf(state), [[byOld.hash, 'member.invite', 'not-a-roster-writer']]);
  assert.equal(headOf(state), handover.hash);
  const view = rosterView(state);
  assert.equal(view.hasRole(s.em.member, 'staff_lead', handover.hash), true);
  assert.equal(view.hasRole(s.em.member, 'staff_lead', s.head), false);
  assert.equal(view.hasRole(s.lead.member, 'staff_lead', s.head), true);
  assert.equal(view.hasRole(s.lead.member, 'staff_lead', handover.hash), false);
  assert.equal(view.roleWithdrawnBy(s.lead.member, 'staff_lead', s.genesis.hash), handover.hash);
  // The old lead stays a member with an admitted device; only the lead role moved.
  assert.equal(view.isAdmitted(s.lead.writer, handover.hash), true);
  assert.equal(view.hasRole(s.lead.member, 'member', handover.hash), true);
  // The new lead writes at the new head.
  const withNew = foldWith(s, [...base.filter((entry) => entry !== byOld.entry), byNew.entry]);
  assert.deepEqual(withNew.refused, []);
  assert.equal(headOf(withNew), byNew.hash);
});

test('an old lead who is named deputy after the handover writes the roster again from that roster on', () => {
  const s = staff();
  const handover = s.world.rosterEntry(s.lead, 'lead.handover', { to: s.em.member, reason: 'planned' }, s.head);
  const named = s.world.rosterEntry(s.em, 'deputy.name', { member: s.lead.member }, handover.hash);
  const byOld = inviteBy(s.world, s.lead, named.hash, 'inv-old-lead-as-deputy');
  const state = s.world.foldRoster();
  assert.deepEqual(state.refused, []);
  assert.equal(headOf(state), byOld.hash);
  const view = rosterView(state);
  assert.equal(view.hasRole(s.lead.member, 'deputy_lead', named.hash), true);
  assert.equal(view.hasRole(s.lead.member, 'staff_lead', named.hash), false);
  assert.equal(view.hasRole(s.em.member, 'staff_lead', byOld.hash), true);
});

test('the deputy hands over with reason lead-lost and it applies; a planned handover from the deputy is refused handover-not-allowed', () => {
  const s = staff();
  const named = s.world.rosterEntry(s.lead, 'deputy.name', { member: s.dee.member }, s.head);
  const base = [...s.world.entries];
  const planned = s.world.rosterEntry(s.dee, 'lead.handover', { to: s.dee.member, reason: 'planned' }, named.hash);
  const refused = foldWith(s, [...base, planned.entry]);
  assert.deepEqual(refusalsOf(refused), [[planned.hash, 'lead.handover', 'handover-not-allowed']]);
  assert.equal(rosterView(refused).hasRole(s.lead.member, 'staff_lead', named.hash), true);

  const lost = s.world.rosterEntry(s.dee, 'lead.handover', { to: s.dee.member, reason: 'lead-lost' }, named.hash);
  const byOld = inviteBy(s.world, s.lead, lost.hash, 'inv-lost-lead');
  const state = foldWith(s, [...base, lost.entry, byOld.entry]);
  assert.deepEqual(refusalsOf(state), [[byOld.hash, 'member.invite', 'not-a-roster-writer']]);
  assert.equal(headOf(state), lost.hash);
  const view = rosterView(state);
  assert.equal(view.hasRole(s.dee.member, 'staff_lead', lost.hash), true);
  // The deputy who became the lead holds one lead role, not two.
  assert.equal(view.hasRole(s.dee.member, 'deputy_lead', lost.hash), false);
  assert.equal(view.hasRole(s.dee.member, 'deputy_lead', named.hash), true);
  assert.equal(view.hasRole(s.lead.member, 'staff_lead', lost.hash), false);
  // The new lead names a new deputy, which the old deputy could not do.
  const next = s.world.rosterEntry(s.dee, 'deputy.name', { member: s.eve.member }, lost.hash);
  const after = foldWith(s, [...base, lost.entry, next.entry]);
  assert.deepEqual(after.refused, []);
  assert.equal(rosterView(after).hasRole(s.eve.member, 'deputy_lead', next.hash), true);
});

test('a plain member writing lead.handover is refused not-a-roster-writer; a handover to the lead or to an unknown member is refused', () => {
  const s = staff();
  const base = [...s.world.entries];
  const byMember = s.world.rosterEntry(s.em, 'lead.handover', { to: s.em.member, reason: 'lead-lost' }, s.head);
  assert.deepEqual(refusalsOf(foldWith(s, [...base, byMember.entry])), [[byMember.hash, 'lead.handover', 'not-a-roster-writer']]);
  for (const [to, reason] of [[s.lead.member, 'names-the-lead'], ['mbr-nobody', 'not-an-active-member']] as const) {
    const bad = s.world.rosterEntry(s.lead, 'lead.handover', { to, reason: 'planned' }, s.head);
    const state = foldWith(s, [...base, bad.entry]);
    assert.deepEqual(refusalsOf(state), [[bad.hash, 'lead.handover', reason]], to);
    assert.equal(headOf(state), s.head, to);
    assert.equal(rosterView(state).hasRole(s.lead.member, 'staff_lead', s.head), true, to);
  }
});

const PRODUCT_ROLES = { owner: 'j2-chief', sectionLead: 'j2-lead', releaseGuard: 'release-guard' };

test('after a handover the main fold still accepts the genesis and a product created by the old lead at the earlier roster, and judges later acts at their own roster', () => {
  const s = staff();
  const create = s.world.write(s.lead, { kind: 'product.create', data: { product: 'intel-estimate', section: 'j2', roles: PRODUCT_ROLES, title: 'Intel estimate' }, roster: s.head });
  const handover = s.world.rosterEntry(s.lead, 'lead.handover', { to: s.em.member, reason: 'planned' }, s.head);
  const byOld = s.world.write(s.lead, { kind: 'product.owner', data: { product: 'intel-estimate', owner: 'j2-chief-2' }, roster: handover.hash, deps: [create] });
  const byNew = s.world.write(s.em, { kind: 'product.owner', data: { product: 'intel-estimate', owner: 'j2-chief-3' }, roster: handover.hash, deps: [create, byOld] });
  const state = s.world.foldRoster();
  assert.equal(headOf(state), handover.hash);
  const result = foldEntries(s.world.entries, s.world.ctxFor(state, s.world.ringFor(s.lead)));
  // Authority at the cited roster (D-11): the genesis cites the origin and the product.create cites the roster before the handover, where the old lead
  // held staff_lead, so the later handover rejects neither.
  assert.ok(result.applied.includes(s.genesis.hash));
  assert.ok(result.applied.includes(create.hash));
  assert.deepEqual(result.refused.filter((item) => item.family === 'versions').map((item) => [item.hash, item.reason]), [[byOld.hash, 'not-authorised']]);
  assert.ok(result.applied.includes(byNew.hash));
  const products = result.families.versions as Array<{ product: string; roles: { owner: string } }>;
  assert.equal(products.find((product) => product.product === 'intel-estimate')?.roles.owner, 'j2-chief-3');
});

// ---- Task 3: split, choose, and entries that cite a branch nobody chose ------------------------------------------------------------------------

interface Split {
  s: Staff;
  // The split point: the roster after the lead named Dee deputy.
  point: string;
  // Everything written up to the split point, in writing order.
  prefix: SealedEntry[];
  // Two roster changes on the split point, by the lead (a) and by the deputy (b), and one later change on each branch.
  a: Written;
  b: Written;
  a2: Written;
  b2: Written;
}

function split(): Split {
  const s = staff();
  const named = s.world.rosterEntry(s.lead, 'deputy.name', { member: s.dee.member }, s.head);
  const prefix = [...s.world.entries];
  const a = inviteBy(s.world, s.lead, named.hash, 'inv-branch-a');
  const b = inviteBy(s.world, s.dee, named.hash, 'inv-branch-b');
  const a2 = inviteBy(s.world, s.lead, a.hash, 'inv-branch-a2');
  const b2 = inviteBy(s.world, s.dee, b.hash, 'inv-branch-b2');
  return { s, point: named.hash, prefix, a, b, a2, b2 };
}

const heldOf = (state: RosterState): Map<string, string> => new Map(state.held.map((item) => [item.hash, item.reason]));
const sorted = (...hashes: string[]): string[] => [...hashes].sort();

test('15.1 roster head -> split: two roster writers change the roster on one head; in every delivery order the prefix applies, neither branch applies, and one split is reported', () => {
  const t = split();
  const reference = foldWith(t.s, t.prefix);
  assert.equal(headOf(reference), t.point);
  for (const order of permutations([t.a, t.b, t.a2, t.b2])) {
    const state = foldWith(t.s, [...t.prefix, ...order.map((item) => item.entry)]);
    const label = order.map((item) => item.hash.slice(0, 6)).join(',');
    assert.deepEqual(state.positions, reference.positions, label);
    assert.deepEqual(state.pending, [{ at: t.point, branches: sorted(t.a.hash, t.b.hash), text: ROSTER_SPLIT_TEXT }], label);
    assert.deepEqual(state.choices, [], label);
    assert.deepEqual(state.refused, [], label);
    const view = rosterView(state);
    for (const item of [t.a, t.b, t.a2, t.b2]) {
      assert.equal(view.rosterBranchPending?.(item.hash), true, label);
      assert.equal(view.hasRoster(item.hash), false, label);
      assert.equal(heldOf(state).get(item.hash), 'roster-branch-not-chosen', label);
    }
    assert.equal(view.rosterBranchPending?.(t.point), false, label);
    // Neither branch changed the members state.
    for (const id of ['inv-branch-a', 'inv-branch-b', 'inv-branch-a2', 'inv-branch-b2']) assert.ok(!state.members.invites.has(id), `${label} ${id}`);
  }
  assert.equal(ROSTER_SPLIT_TEXT, 'The roster was changed in two places at once. The lead or the deputy must choose.');
});

test('15.1 split -> chosen branch: the lead\'s roster.choose naming the deputy\'s branch applies, that branch continues in order, and the other branch stays unapplied and is listed, in every delivery order', () => {
  const t = split();
  const choose = t.s.world.rosterEntry(t.s.lead, 'roster.choose', { chosen: t.b.hash }, t.point);
  const prefix = foldWith(t.s, t.prefix).positions;
  for (const order of permutations([t.a, t.b, t.a2, t.b2, choose])) {
    const state = foldWith(t.s, [...t.prefix, ...order.map((item) => item.entry)]);
    const label = order.map((item) => item.hash.slice(0, 6)).join(',');
    assert.deepEqual(state.positions, [...prefix, choose.hash, t.b.hash, t.b2.hash], label);
    assert.deepEqual(state.pending, [], label);
    assert.deepEqual(state.choices, [{ at: t.point, branches: sorted(t.a.hash, t.b.hash), chosen: t.b.hash, choose: choose.hash }], label);
    assert.deepEqual(state.refused, [], label);
    assert.deepEqual([...heldOf(state)].filter(([, reason]) => reason !== 'unknown-writer').sort(), sorted(t.a.hash, t.a2.hash).map((hash) => [hash, 'roster-branch-not-chosen']), label);
    const view = rosterView(state);
    assert.equal(view.rosterBranchPending?.(t.a.hash), true, label);
    assert.equal(view.rosterBranchPending?.(t.a2.hash), true, label);
    assert.equal(view.rosterBranchPending?.(t.b.hash), false, label);
    assert.equal(view.hasRoster(t.b2.hash), true, label);
    assert.ok(state.members.invites.has('inv-branch-b') && state.members.invites.has('inv-branch-b2'), label);
    assert.ok(!state.members.invites.has('inv-branch-a') && !state.members.invites.has('inv-branch-a2'), label);
  }
});

test('the deputy\'s roster.choose is refused choose-not-allowed while the lead has an active device and has not handed over, and applies once the deputy holds the lead', () => {
  const t = split();
  const base = [...t.prefix, t.a.entry, t.b.entry];
  const byDeputy = t.s.world.rosterEntry(t.s.dee, 'roster.choose', { chosen: t.b.hash }, t.point);
  const refused = foldWith(t.s, [...base, byDeputy.entry]);
  assert.deepEqual(refusalsOf(refused), [[byDeputy.hash, 'roster.choose', 'choose-not-allowed']]);
  assert.deepEqual(refused.pending.map((item) => item.at), [t.point]);
  assert.equal(headOf(refused), t.point);
  // A plain member's choice never reaches the choice rule: the member may not write the roster.
  const byMember = t.s.world.rosterEntry(t.s.em, 'roster.choose', { chosen: t.b.hash }, t.point);
  assert.deepEqual(refusalsOf(foldWith(t.s, [...base, byMember.entry])), [[byMember.hash, 'roster.choose', 'not-a-roster-writer']]);

  // The lead is lost: the deputy hands over to itself with reason lead-lost (on a fresh line, before any split), names a deputy, and a split between
  // the two is then the new lead's to choose.
  const s = staff();
  const named = s.world.rosterEntry(s.lead, 'deputy.name', { member: s.dee.member }, s.head);
  const handover = s.world.rosterEntry(s.dee, 'lead.handover', { to: s.dee.member, reason: 'lead-lost' }, named.hash);
  const next = s.world.rosterEntry(s.dee, 'deputy.name', { member: s.eve.member }, handover.hash);
  const one = inviteBy(s.world, s.dee, next.hash, 'inv-one');
  const two = inviteBy(s.world, s.eve, next.hash, 'inv-two');
  const pendingState = s.world.foldRoster();
  assert.deepEqual(pendingState.pending, [{ at: next.hash, branches: sorted(one.hash, two.hash), text: ROSTER_SPLIT_TEXT }]);
  const chosen = s.world.rosterEntry(s.dee, 'roster.choose', { chosen: two.hash }, next.hash);
  const state = s.world.foldRoster();
  assert.deepEqual(state.refused, []);
  assert.deepEqual(state.positions.slice(-3), [next.hash, chosen.hash, two.hash]);
  assert.deepEqual(state.pending, []);
  assert.ok(state.members.invites.has('inv-two') && !state.members.invites.has('inv-one'));
  // The new deputy may not choose while the new lead has an active device.
  const byNewDeputy = s.world.rosterEntry(s.eve, 'roster.choose', { chosen: one.hash }, next.hash);
  const contested = s.world.foldRoster({ entries: s.world.entries.filter((entry) => entry !== chosen.entry) });
  assert.deepEqual(refusalsOf(contested), [[byNewDeputy.hash, 'roster.choose', 'choose-not-allowed']]);
  assert.equal(contested.pending.length, 1);
});

test('a roster.choose naming a hash that is not a child of the split point is refused choose-not-a-branch and the split stays pending', () => {
  const t = split();
  const base = [...t.prefix, t.a.entry, t.b.entry, t.a2.entry];
  for (const chosen of [t.a2.hash, t.point, 'f'.repeat(64)]) {
    const choose = t.s.world.rosterEntry(t.s.lead, 'roster.choose', { chosen }, t.point);
    const state = foldWith(t.s, [...base, choose.entry]);
    assert.deepEqual(refusalsOf(state), [[choose.hash, 'roster.choose', 'choose-not-a-branch']], chosen);
    assert.deepEqual(state.pending, [{ at: t.point, branches: sorted(t.a.hash, t.b.hash), text: ROSTER_SPLIT_TEXT }], chosen);
    assert.equal(headOf(state), t.point, chosen);
  }
});

test('two choices at one split: the one signed later applies and the other is refused choose-superseded, so a person can always change the choice', () => {
  const t = split();
  const base = [...t.prefix, t.a.entry, t.b.entry];
  const first = t.s.world.rosterEntry(t.s.lead, 'roster.choose', { chosen: t.a.hash }, t.point, { at: '2026-11-19T11:05:00.000Z' });
  const second = t.s.world.rosterEntry(t.s.lead, 'roster.choose', { chosen: t.b.hash }, t.point, { at: '2026-11-19T11:06:00.000Z' });
  for (const order of permutations([first, second])) {
    const state = foldWith(t.s, [...base, ...order.map((item) => item.entry)]);
    assert.deepEqual(refusalsOf(state), [[first.hash, 'roster.choose', 'choose-superseded']]);
    assert.deepEqual(state.positions.slice(-2), [second.hash, t.b.hash]);
    assert.equal(rosterView(state).rosterBranchPending?.(t.a.hash), true);
  }
});

const PRODUCT = 'intel-estimate';

function productText(result: FoldResult): string | undefined {
  const products = result.families.doc as ProductTextOutput[];
  return products.find((product) => product.product === PRODUCT)?.text;
}

test('a doc.update from an observer is kept observer-only and changes no text, while a member admitted in the same roster writes normally', () => {
  const s = staff();
  const observer = s.world.device('OBS', 'mbr-obs');
  const watched = admit(s.world, s.lead, s.head, observer, 5, ['observer']);
  const roster = watched.admit.hash;
  const memberDoc = createLocalDoc(clientIdOf(3, 0));
  const memberClient = s.world.write(s.em, { kind: 'doc.client', data: { product: PRODUCT, clientId: clientIdOf(3, 0), actor: { kind: 'person' } }, roster });
  const memberUpdate = s.world.write(s.em, { kind: 'doc.update', data: updateData(PRODUCT, localInsert(memberDoc, 0, 'Enemy holds the ridge.')), roster, deps: [memberClient] });
  const observerDoc = createLocalDoc(clientIdOf(5, 0));
  const observerClient = s.world.write(observer, { kind: 'doc.client', data: { product: PRODUCT, clientId: clientIdOf(5, 0), actor: { kind: 'person' } }, roster });
  const observerUpdate = s.world.write(observer, { kind: 'doc.update', data: updateData(PRODUCT, localInsert(observerDoc, 0, 'Observer text. ')), roster, deps: [observerClient] });
  const state = s.world.foldRoster();
  assert.equal(headOf(state), roster);
  const view = rosterView(state);
  assert.equal(view.hasRole(observer.member, 'observer', roster), true);
  assert.equal(view.hasRole(observer.member, 'member', roster), false);
  const result = foldEntries(s.world.entries, s.world.ctxFor(state, s.world.ringFor(s.lead)));
  assert.deepEqual(result.kept.filter((item) => item.reason === 'observer-only').map((item) => item.hash).sort(), sorted(observerClient.hash, observerUpdate.hash));
  assert.ok(result.applied.includes(memberClient.hash) && result.applied.includes(memberUpdate.hash));
  assert.ok(!result.applied.includes(observerUpdate.hash));
  assert.equal(productText(result), 'Enemy holds the ridge.');
});

test('the main fold holds a doc.update citing a branch nobody chose roster-branch-not-chosen, and applies the one citing the chosen branch once the context is replaced after the choice', () => {
  const t = split();
  const { s } = t;
  const doc = createLocalDoc(clientIdOf(3, 0));
  const client = s.world.write(s.em, { kind: 'doc.client', data: { product: PRODUCT, clientId: clientIdOf(3, 0), actor: { kind: 'person' } }, roster: t.point });
  const onB = s.world.write(s.em, { kind: 'doc.update', data: updateData(PRODUCT, localInsert(doc, 0, 'Ridge held.')), roster: t.b.hash, deps: [client] });
  const onA = s.world.write(s.em, { kind: 'doc.update', data: updateData(PRODUCT, localInsert(doc, 11, ' Bridge down.')), roster: t.a.hash, deps: [onB] });
  const keys = s.world.ringFor(s.lead);

  // Before the choice: both updates wait, kept and never applied; nothing is rejected.
  const splitRoster = s.world.foldRoster();
  assert.equal(splitRoster.pending.length, 1);
  const before = addEntries(createFoldState(s.world.ctxFor(splitRoster, keys)), s.world.entries);
  const heldBefore = new Map(before.result.held.map((item) => [item.hash, item.reason]));
  assert.equal(heldBefore.get(onB.hash), 'roster-branch-not-chosen');
  assert.equal(heldBefore.get(onA.hash), 'roster-branch-not-chosen');
  assert.ok(before.result.applied.includes(client.hash));
  assert.equal(before.result.rejected.length, 0);
  assert.equal(productText(before.result) ?? '', '');

  // The lead chooses branch b; the store replaces the context with the new roster view and the held update citing b applies.
  const choose = s.world.rosterEntry(s.lead, 'roster.choose', { chosen: t.b.hash }, t.point);
  const chosenRoster = s.world.foldRoster();
  assert.deepEqual(chosenRoster.pending, []);
  const after = addEntries(before, [choose.entry], s.world.ctxFor(chosenRoster, keys));
  assert.ok(after.result.applied.includes(onB.hash));
  assert.equal(new Map(after.result.held.map((item) => [item.hash, item.reason])).get(onA.hash), 'roster-branch-not-chosen');
  assert.equal(productText(after.result), 'Ridge held.');
  // A from-scratch fold under the new roster agrees.
  const scratch = foldEntries(s.world.entries, s.world.ctxFor(chosenRoster, keys));
  assert.deepEqual(scratch.applied, after.result.applied);
  assert.equal(productText(scratch), 'Ridge held.');
});

test('every new refusal, hold and keep reason is a plain sentence without an em-dash', () => {
  const texts: Array<[string, string]> = [
    ...['deputy-cannot-name-deputy', 'not-an-active-member', 'names-the-lead', 'handover-not-allowed', 'choose-not-allowed', 'choose-not-a-branch', 'choose-superseded']
      .map((reason): [string, string] => [reason, (ROSTER_REFUSALS as Record<string, string>)[reason]]),
    ['roster-branch-not-chosen', VERIFY_HOLDS['roster-branch-not-chosen']],
    ['observer-only', KEEP_REASONS['observer-only']],
    ['split', ROSTER_SPLIT_TEXT]
  ];
  for (const [reason, text] of texts) {
    assert.ok(typeof text === 'string' && text.length > 20 && text.endsWith('.'), reason);
    assert.ok(!text.includes('\u2014'), reason);
  }
});
