// hub.readmit (Phase 33 D-42): the staff lead's signed way to trust your organization's server again after a fork or rollback finding. The roster
// part is folded by the real roster fold from signed, sealed entries; the witness part drives readmitWitness over signed checkpoints.
// Fictional people and data only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { signCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint, SignedCheckpoint } from '../domain/replica/checkpoint';
import { MAX_READMITTED, createWitness, readWitness, readmitWitness, serializeWitness, witnessCheckpoint } from '../domain/replica/hubWitness';
import type { WitnessState } from '../domain/replica/hubWitness';
import { validateData } from '../domain/replica/kinds';
import { rosterView } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
import { MEMBER_REFUSALS, hubAt, hubCellsAt } from '../domain/replica/rosterMembers';
import { staticRosterView } from '../domain/replica/rosterView';
import type { RosterView } from '../domain/replica/rosterView';
import { DEMO_CLEARANCE, INVITE_EXPIRES, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import { fixedSigner } from './helpers/replicaWorld';
import type { Written } from './helpers/replicaWorld';

const hex = (label: string): string => createHash('sha256').update(label).digest('hex');
const OLD_PIN = hex('pin/old');
const NEW_PIN = hex('pin/restored');
const HUB_ID = 'hub-main';

// ---- the roster kind -------------------------------------------------------------------------------------------------------------------------

interface Line { world: RosterWorld; jo: RosterDevice; hub: RosterDevice; head: string; admit: Written; entries: unknown[]; next(by: RosterDevice, kind: string, data: Record<string, unknown>, extra?: object): Written; fold(): RosterState }

/** Genesis, Jo admitted as a member at slot 2, and the hub admitted at slot 3 and granted the base cell, each by the lead. */
function line(): Line {
  const world = createRosterWorld();
  const jo = world.device('JO', 'mbr-jo');
  const hub = world.device('HUB', HUB_ID);
  const genesis = world.genesis().entry;
  const state: Line = {
    world, jo, hub,
    head: genesis.hash,
    admit: undefined as unknown as Written,
    entries: [genesis.entry],
    next(by, kind, data, extra = {}) {
      const written = world.rosterEntry(by, kind, data, state.head, extra);
      state.entries.push(written.entry);
      state.head = written.hash;
      return written;
    },
    fold: () => world.foldRoster({ entries: state.entries })
  };
  const secret = hex('join-secret/jo');
  state.next(world.lead, 'member.invite', { invite: 'inv-jo', name: 'Jo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: secret });
  state.next(world.lead, 'member.admit', { member: jo.member, invite: 'inv-jo', name: 'Jo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: jo.descriptor(2), agentSeats: [] });
  state.admit = state.next(world.lead, 'hub.admit', { hub: HUB_ID, device: hub.descriptor(3), certPin: OLD_PIN, ceiling: DEMO_CLEARANCE });
  state.next(world.lead, 'hub.grant', { hub: HUB_ID, cell: world.project });
  return state;
}

/** Writes one entry citing the head and folds the line with it alone, without moving the head, so a refused entry never splits the line. */
function attempt(l: Line, by: RosterDevice, kind: string, data: Record<string, unknown>, extra = {}): { written: Written; state: RosterState } {
  const written = l.world.rosterEntry(by, kind, data, l.head, extra);
  const state = l.world.foldRoster({ entries: [...l.entries, written.entry] });
  assert.equal(state.positions[state.positions.length - 1], l.head, 'a refused entry must not move the head');
  return { written, state };
}
const refusalOf = (result: { written: Written; state: RosterState }): string | undefined => result.state.refused.find((item) => item.hash === result.written.hash)?.reason;

test('hub.readmit by the lead opens a new version of the hub with the compared pin: the old pin before it, the new one from it, and hubReadmits names the entry', () => {
  const l = line();
  const before = l.head;
  const readmit = l.next(l.world.lead, 'hub.readmit', { hub: HUB_ID, certPin: NEW_PIN, fromCheckpoint: hex('checkpoint/restored') });
  const state = l.fold();
  assert.deepEqual(state.refused, []);
  const view = rosterView(state);
  assert.equal(view.hubPin?.(HUB_ID, before), OLD_PIN);
  assert.equal(view.hubPin?.(HUB_ID, readmit.hash), NEW_PIN);
  assert.equal(view.hubPin?.(HUB_ID, l.admit.hash), OLD_PIN);
  assert.deepEqual(view.hubReadmits?.(HUB_ID), [readmit.hash]);
  assert.deepEqual(view.hubReadmits?.('hub-other'), []);
  // The hub's device, ceiling and cells carry over: it still signs checkpoints and holds the base cell.
  const position = state.positionOf.get(readmit.hash) as number;
  assert.equal(view.checkpointSigner(l.hub.writer, readmit.hash), true);
  assert.deepEqual(hubCellsAt(state.members, HUB_ID, position), [l.world.project]);
  assert.equal(hubAt(state.members, HUB_ID, position)?.readmit, true);
  assert.equal(hubAt(state.members, HUB_ID, position - 1)?.readmit, undefined);
});

test('two re-admissions are listed oldest first, and a hub.grant after one keeps the re-admitted pin', () => {
  const l = line();
  const first = l.next(l.world.lead, 'hub.readmit', { hub: HUB_ID, certPin: NEW_PIN });
  const later = hex('pin/later');
  const second = l.next(l.world.lead, 'hub.readmit', { hub: HUB_ID, certPin: later });
  const grant = l.next(l.world.lead, 'hub.grant', { hub: HUB_ID, cell: hex('cell/ops').slice(0, 32) });
  const state = l.fold();
  assert.deepEqual(state.refused, []);
  const view = rosterView(state);
  assert.deepEqual(view.hubReadmits?.(HUB_ID), [first.hash, second.hash]);
  assert.equal(view.hubPin?.(HUB_ID, first.hash), NEW_PIN);
  assert.equal(view.hubPin?.(HUB_ID, grant.hash), later);
  assert.equal(hubAt(state.members, HUB_ID, state.positionOf.get(grant.hash) as number)?.readmit, undefined, 'only the version a hub.readmit opened is marked');
});

test('the deputy lead may re-admit the hub; a member device is refused not-a-roster-writer', () => {
  const l = line();
  l.next(l.world.lead, 'deputy.name', { member: l.jo.member });
  const byDeputy = l.next(l.jo, 'hub.readmit', { hub: HUB_ID, certPin: NEW_PIN });
  const state = l.fold();
  assert.equal(state.positions[state.positions.length - 1], byDeputy.hash);
  assert.equal(rosterView(state).hubPin?.(HUB_ID, byDeputy.hash), NEW_PIN);
  const m = line();
  assert.equal(refusalOf(attempt(m, m.jo, 'hub.readmit', { hub: HUB_ID, certPin: NEW_PIN })), 'not-a-roster-writer');
});

test('an agent on the lead\'s device is refused person-only', () => {
  const l = line();
  assert.equal(refusalOf(attempt(l, l.world.lead, 'hub.readmit', { hub: HUB_ID, certPin: NEW_PIN }, { actor: { kind: 'agent', member: l.world.lead.member, run: 'run-1' } })), 'person-only');
});

test('an unknown hub is refused hub-unknown and a revoked hub hub-revoked, each with a plain sentence', () => {
  const l = line();
  assert.equal(refusalOf(attempt(l, l.world.lead, 'hub.readmit', { hub: 'hub-other', certPin: NEW_PIN })), 'hub-unknown');
  l.next(l.world.lead, 'hub.revoke', { hub: HUB_ID });
  assert.equal(refusalOf(attempt(l, l.world.lead, 'hub.readmit', { hub: HUB_ID, certPin: NEW_PIN })), 'hub-revoked');
  assert.match(MEMBER_REFUSALS['hub-revoked'], /your organization's server/i);
  assert.doesNotMatch(MEMBER_REFUSALS['hub-revoked'], /—/);
});

test('the schema: hub, certPin and rosterPrev required, fromCheckpoint an optional 64-hex hash, nothing else', () => {
  const prev = 'a'.repeat(64);
  assert.deepEqual(validateData('hub.readmit', { hub: HUB_ID, certPin: NEW_PIN, rosterPrev: prev }), { ok: true });
  assert.deepEqual(validateData('hub.readmit', { hub: HUB_ID, certPin: NEW_PIN, fromCheckpoint: hex('c'), rosterPrev: prev }), { ok: true });
  const refused: Array<[Record<string, unknown>, string]> = [
    [{ hub: HUB_ID, certPin: 'x'.repeat(64), rosterPrev: prev }, 'data.certPin'],
    [{ hub: HUB_ID, certPin: NEW_PIN.slice(1), rosterPrev: prev }, 'data.certPin'],
    [{ hub: HUB_ID, certPin: NEW_PIN, fromCheckpoint: 'nope', rosterPrev: prev }, 'data.fromCheckpoint'],
    [{ hub: 'Hub Main', certPin: NEW_PIN, rosterPrev: prev }, 'data.hub'],
    [{ hub: HUB_ID, certPin: NEW_PIN, rosterPrev: prev, ceiling: DEMO_CLEARANCE }, 'data.ceiling'],
    [{ hub: HUB_ID, rosterPrev: prev }, 'data.certPin']
  ];
  for (const [data, path] of refused) {
    const check = validateData('hub.readmit', data);
    assert.ok(!check.ok && check.reason.includes(path), `${JSON.stringify(data)}: ${check.ok ? 'ok' : check.reason}`);
  }
});

// ---- the witness -----------------------------------------------------------------------------------------------------------------------------

const PROJECT = 'project-main';
const ROSTER = hex('roster/0');
const STREAM = hex('stream/base').slice(0, 32);
const A = fixedSigner('A');
const HUB = fixedSigner('H');

function witnessRoster(): RosterView {
  return staticRosterView({
    rosters: [{
      hash: ROSTER,
      checkpointSigners: [HUB.writer],
      members: [
        { member: 'mbr-aaaa000000000000', name: 'Analyst A', roles: ['member'], devices: [{ writer: A.writer, publicKey: A.publicKey }] },
        { member: 'mbr-hhhh000000000000', name: 'Sync hub', roles: ['member'], devices: [{ writer: HUB.writer, publicKey: HUB.publicKey }] }
      ]
    }]
  });
}

function checkpointAt(seq: number, label = 'main'): SignedCheckpoint {
  const head = { writer: A.writer, seq, hash: hex(`entry/${seq}/${label}`), lamport: seq + 1, roster: ROSTER };
  const value: Checkpoint = { type: 'checkpoint', v: 2, project: PROJECT, signer: HUB.writer, rosterHead: ROSTER, streams: [{ stream: STREAM, heads: [head], count: seq + 1, orderTip: hex(`tip/${seq}/${label}`) }] };
  return signCheckpoint(HUB.signer, value);
}

/** A witness that saw the hub show two versions of the project: distrusted, with its proof. */
function forked(): WitnessState {
  let state = createWitness(HUB.writer, PROJECT);
  for (const signed of [checkpointAt(3), checkpointAt(5)]) state = witnessCheckpoint(state, signed, witnessRoster()).state;
  const result = witnessCheckpoint(state, checkpointAt(5, 'other'), witnessRoster());
  assert.equal(result.state.distrusted, true);
  assert.ok(result.state.proof !== undefined);
  return result.state;
}

const READMIT_1 = hex('entry/hub.readmit/1');
const READMIT_2 = hex('entry/hub.readmit/2');

test('readmitWitness: a distrusted hub with a forked-view proof becomes trusted with no proof, the hash is remembered, and its checkpoints count again', () => {
  const state = forked();
  const result = readmitWitness(state, READMIT_1);
  assert.deepEqual(result.findings, []);
  assert.equal(result.state.distrusted, false);
  assert.equal(result.state.proof, undefined);
  assert.deepEqual(result.state.readmitted, [READMIT_1]);
  assert.equal(state.distrusted, true, 'the input state is never changed');
  // A restored hub may show an older copy than before: once re-admitted, it is judged from the start again.
  const restored = witnessCheckpoint(result.state, checkpointAt(4), witnessRoster());
  assert.equal(restored.trusted, true);
  assert.deepEqual(restored.findings, []);
});

test('readmitWitness: the same hash again changes nothing; after a later finding only a new hub.readmit clears it', () => {
  const cleared = readmitWitness(forked(), READMIT_1).state;
  assert.deepEqual(readmitWitness(cleared, READMIT_1).state, cleared);
  // The hub shows two versions again.
  let state = witnessCheckpoint(cleared, checkpointAt(6), witnessRoster()).state;
  state = witnessCheckpoint(state, checkpointAt(6, 'again'), witnessRoster()).state;
  assert.equal(state.distrusted, true);
  const replayed = readmitWitness(state, READMIT_1);
  assert.equal(replayed.state.distrusted, true, 'an old re-admission never clears a new finding');
  assert.deepEqual(replayed.state.proof, state.proof);
  const fresh = readmitWitness(state, READMIT_2).state;
  assert.equal(fresh.distrusted, false);
  assert.deepEqual(fresh.readmitted, [READMIT_1, READMIT_2].sort());
  assert.deepEqual(readmitWitness(state, 'not-a-hash').state, state, 'a value that is not an entry hash changes nothing');
});

test('readmitWitness stops clearing once MAX_READMITTED re-admissions are remembered (fails closed)', () => {
  let state = forked();
  const hashes = Array.from({ length: MAX_READMITTED }, (_, index) => hex(`entry/hub.readmit/many/${index}`));
  for (const hash of hashes) state = { ...readmitWitness(state, hash).state, distrusted: true, proof: forked().proof };
  assert.equal(state.readmitted?.length, MAX_READMITTED);
  const past = readmitWitness(state, hex('entry/hub.readmit/one-more'));
  assert.equal(past.state.distrusted, true);
});

test('a saved state round-trips with its re-admissions, a state saved before them still reads back, and a damaged list is refused', () => {
  const cleared = readmitWitness(forked(), READMIT_1).state;
  const text = serializeWitness(cleared);
  assert.deepEqual(readWitness(text, { hub: HUB.writer, project: PROJECT }), { ok: true, state: cleared });
  const older = forked();
  const olderText = serializeWitness(older);
  assert.equal(olderText.includes('readmitted'), false, 'a state with no re-admission saves no such key');
  assert.deepEqual(readWitness(olderText, { hub: HUB.writer, project: PROJECT }), { ok: true, state: older });
  const value = JSON.parse(text) as Record<string, unknown>;
  for (const readmitted of [[], ['nope'], [READMIT_2, READMIT_1].sort().reverse(), [READMIT_1, READMIT_1], 'x']) {
    const read = readWitness(JSON.stringify({ ...value, readmitted }), { hub: HUB.writer, project: PROJECT });
    assert.equal(read.ok ? 'ok' : read.reason, 'malformed', JSON.stringify(readmitted));
  }
});
