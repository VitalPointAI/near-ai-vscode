// roster.require (POST-01; Phase 33 D-04, D-05, D-08): who may write it, which ids it takes, and that the required set is a union that only grows.
// Every roster here is folded by the real roster fold from signed, sealed entries (createRosterWorld). Fictional people and data only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { KNOWN_REPLICA_FEATURES } from '../domain/replica/features';
import { KIND_FAMILIES, validateData } from '../domain/replica/kinds';
import { ROSTER_SPLIT_TEXT } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
import type { SealedEntry } from '../domain/replica/entry';
import type { ProjectState, ReplicaProject } from '../staff/replica/replicaProject';
import { REQUIRE_ARMED_FEATURE, ensureRequireArmed, requireProblem } from '../staff/replica/requireGate';
import { DEMO_CLEARANCE, INVITE_EXPIRES, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import type { Written } from './helpers/replicaWorld';

const secretHash = (label: string): string => createHash('sha256').update(`join-secret/${label}`, 'utf8').digest('hex');
const headOf = (state: RosterState): string => state.positions[state.positions.length - 1];
const refusalOf = (state: RosterState, written: Written): string | undefined => state.refused.find((item) => item.hash === written.hash)?.reason;
const heldOf = (state: RosterState, written: Written): string | undefined => state.held.find((item) => item.hash === written.hash)?.reason;

interface Staff { world: RosterWorld; lead: RosterDevice; dee: RosterDevice; em: RosterDevice; head: string }

/** The lead's genesis, Dee (slot 2) and Em (slot 3) admitted as members, then Dee named deputy lead. */
function staff(): Staff {
  const world = createRosterWorld();
  const dee = world.device('DEE', 'mbr-dee');
  const em = world.device('EM', 'mbr-em');
  let head = world.genesis().entry.hash;
  for (const [device, slot] of [[dee, 2], [em, 3]] as const) {
    const id = `inv-${device.label.toLowerCase()}`;
    const name = `Person ${device.label}`;
    const invite = world.rosterEntry(world.lead, 'member.invite', { invite: id, name, seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: secretHash(id) }, head);
    head = world.rosterEntry(world.lead, 'member.admit', { member: device.member, invite: id, name, seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: device.descriptor(slot), agentSeats: [] }, invite.hash).hash;
  }
  head = world.rosterEntry(world.lead, 'deputy.name', { member: dee.member }, head).hash;
  return { world, lead: world.lead, dee, em, head };
}

const requireBy = (s: Staff, by: RosterDevice, features: string[], prev: string, extra = {}): Written => s.world.rosterEntry(by, 'roster.require', { features }, prev, extra);
const fold = (s: Staff, entries: readonly SealedEntry[] = s.world.entries): RosterState => s.world.foldRoster({ entries });

test('the lead\'s device writes roster.require: it applies at the head and the required set is its features', () => {
  const s = staff();
  const written = requireBy(s, s.lead, ['require@1'], s.head);
  const state = fold(s);
  assert.equal(headOf(state), written.hash);
  assert.deepEqual(state.required, ['require@1']);
  assert.deepEqual(state.refused, []);
  assert.ok(Object.isFrozen(state.required));
});

test('the deputy lead\'s device may write roster.require too', () => {
  const s = staff();
  const written = requireBy(s, s.dee, ['positions@1'], s.head);
  const state = fold(s);
  assert.equal(headOf(state), written.hash);
  assert.deepEqual(state.required, ['positions@1']);
});

test('a member device is refused not-a-roster-writer, and the required set stays empty', () => {
  const s = staff();
  const written = requireBy(s, s.em, ['require@1'], s.head);
  const state = fold(s);
  assert.equal(refusalOf(state, written), 'not-a-roster-writer');
  assert.equal(headOf(state), s.head);
  assert.deepEqual(state.required, []);
});

test('an agent on the lead\'s device is refused person-only', () => {
  const s = staff();
  const written = requireBy(s, s.lead, ['require@1'], s.head, { actor: { kind: 'agent', member: s.lead.member, run: 'run-1' } });
  const state = fold(s);
  assert.equal(refusalOf(state, written), 'person-only');
  assert.deepEqual(state.required, []);
});

test('the schema takes 1 to 16 distinct sorted name@N ids and nothing else', () => {
  const prev = 'a'.repeat(64);
  const seventeen = Array.from({ length: 17 }, (_, index) => `f${String(index).padStart(2, '0')}@1`);
  assert.deepEqual(validateData('roster.require', { features: ['positions@1', 'require@1'], rosterPrev: prev }), { ok: true });
  assert.deepEqual(validateData('roster.require', { features: seventeen.slice(0, 16), rosterPrev: prev }), { ok: true });
  const refused: Array<[unknown, string]> = [
    [[], 'data.features'],
    [seventeen, 'data.features'],
    [['require@1', 'require@1'], 'data.features[1]'],
    [['require@1', 'positions@1'], 'data.features[1]'],
    [['Positions@1'], 'data.features[0]'],
    [['positions'], 'data.features[0]'],
    [['positions@0'], 'data.features[0]'],
    [['positions@1000'], 'data.features[0]'],
    [['positions@01'], 'data.features[0]'],
    ['require@1', 'data.features'],
    [[7], 'data.features[0]']
  ];
  for (const [features, path] of refused) {
    const check = validateData('roster.require', { features, rosterPrev: prev });
    assert.equal(check.ok, false, JSON.stringify(features));
    assert.ok(!check.ok && check.reason.includes(path), `${JSON.stringify(features)}: ${check.ok ? '' : check.reason}`);
  }
  const extra = validateData('roster.require', { features: ['require@1'], rosterPrev: prev, note: 'x' });
  assert.ok(!extra.ok && extra.reason.includes('data.note'));
  const missing = validateData('roster.require', { rosterPrev: prev });
  assert.ok(!missing.ok && missing.reason.includes('data.features'));
});

test('the required set is a union that never shrinks; an entry adding nothing keeps its place and a later roster entry cites it as usual', () => {
  const s = staff();
  const first = requireBy(s, s.lead, ['require@1'], s.head);
  const second = requireBy(s, s.lead, ['positions@1'], first.hash);
  const again = requireBy(s, s.dee, ['require@1'], second.hash);
  const after = s.world.rosterEntry(s.lead, 'member.invite', { invite: 'inv-later', name: 'Later Person', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: secretHash('later') }, again.hash);
  const state = fold(s);
  assert.deepEqual(state.refused, []);
  assert.deepEqual(state.positions.slice(-4), [first.hash, second.hash, again.hash, after.hash]);
  assert.deepEqual(state.required, ['positions@1', 'require@1']);
  assert.ok(state.members.invites.has('inv-later'));
});

test('two leads arming at once split the roster; the chooser settles it, and the required set is the same on either branch', () => {
  for (const pick of ['lead', 'deputy'] as const) {
    const s = staff();
    const byLead = requireBy(s, s.lead, ['require@1'], s.head);
    const byDeputy = requireBy(s, s.dee, ['require@1'], s.head);
    const split = fold(s);
    assert.deepEqual(split.pending, [{ at: s.head, branches: [byLead.hash, byDeputy.hash].sort(), text: ROSTER_SPLIT_TEXT }], pick);
    assert.deepEqual(split.required, [], 'neither branch applies before the choice');
    const chosen = pick === 'lead' ? byLead : byDeputy;
    s.world.rosterEntry(s.lead, 'roster.choose', { chosen: chosen.hash }, s.head);
    const settled = fold(s);
    assert.deepEqual(settled.pending, [], pick);
    assert.equal(headOf(settled), chosen.hash, pick);
    assert.deepEqual(settled.required, ['require@1'], pick);
  }
});

test('an older client (0.4.35, which has no roster.require) keeps the entry as made by a newer version and stalls the roster line after it', () => {
  // 0.4.35 neither lists roster.require nor routes it to a roster module. This build treats a roster-stream kind it does not know the same way, so a
  // kind no build knows stands in for roster.require as 0.4.35 sees it (the kind list itself is not edited).
  const s = staff();
  assert.equal(KIND_FAMILIES.has('roster.later'), false);
  const unknown = s.world.rosterEntry(s.lead, 'roster.later', { features: ['positions@1'] }, s.head);
  const later = s.world.rosterEntry(s.lead, 'member.invite', { invite: 'inv-later', name: 'Later Person', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: secretHash('later') }, unknown.hash);
  const older = fold(s);
  assert.equal(headOf(older), s.head, 'the client never moves past the entry it cannot read');
  assert.equal(refusalOf(older, unknown), undefined, 'kept, not refused');
  assert.equal(heldOf(older, later), 'roster-prev-not-applied', 'every later roster entry waits, so the older client cannot follow the line');
  assert.equal(older.members.invites.has('inv-later'), false);
  // The same line with roster.require, which this build knows, folds through.
  const t = staff();
  const required = requireBy(t, t.lead, ['positions@1'], t.head);
  const next = t.world.rosterEntry(t.lead, 'member.invite', { invite: 'inv-later', name: 'Later Person', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: secretHash('later') }, required.hash);
  const current = fold(t);
  assert.equal(headOf(current), next.hash);
  assert.deepEqual(current.required, ['positions@1']);
});

test('requireProblem on a folded roster names what this build lacks, and a newer build lacks nothing', () => {
  const s = staff();
  requireBy(s, s.lead, ['later@1', 'require@1'], s.head);
  const state = fold(s);
  assert.deepEqual(requireProblem(state), { missing: ['later@1'] });
  assert.equal(requireProblem(state, [...KNOWN_REPLICA_FEATURES, 'later@1']), undefined);
});

/** A project stand-in for ensureRequireArmed: its checked append plans against the given roster and records what it would write. */
function armingProject(roster: RosterState, writer: string): Pick<ReplicaProject, 'appendChecked' | 'deviceWriter'> & { written: unknown[] } {
  const written: unknown[] = [];
  const appendChecked = (prepare: (state: ProjectState) => { ok: false } | { kind: string; data: unknown }): Promise<unknown> => {
    const plan = prepare({ roster, fold: undefined as unknown as ProjectState['fold'] });
    if ('ok' in plan) return Promise.resolve(plan);
    written.push({ kind: plan.kind, data: plan.data });
    return Promise.resolve({ ok: true, hash: 'f'.repeat(64) });
  };
  return { deviceWriter: writer, written, appendChecked: appendChecked as unknown as ReplicaProject['appendChecked'] };
}

test('ensureRequireArmed plans roster.require require@1 on a lead device of an unarmed project, and nothing on a member device or an armed project', () => {
  const s = staff();
  const unarmed = fold(s);
  const lead = armingProject(unarmed, s.lead.writer);
  return (async () => {
    assert.ok('ok' in (await ensureRequireArmed(lead)) && lead.written.length === 1);
    assert.deepEqual(lead.written, [{ kind: 'roster.require', data: { features: [REQUIRE_ARMED_FEATURE] } }]);
    const deputy = armingProject(unarmed, s.dee.writer);
    await ensureRequireArmed(deputy);
    assert.equal(deputy.written.length, 1, 'the deputy lead may arm it too');
    const member = armingProject(unarmed, s.em.writer);
    assert.deepEqual(await ensureRequireArmed(member), { ok: false, skipped: 'not-a-lead-device' });
    assert.deepEqual(member.written, []);
    requireBy(s, s.lead, [REQUIRE_ARMED_FEATURE], s.head);
    const armed = armingProject(fold(s), s.lead.writer);
    assert.deepEqual(await ensureRequireArmed(armed), { ok: false, skipped: 'already-armed' });
    assert.deepEqual(armed.written, []);
  })();
});
