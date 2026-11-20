// Client id slots (D-41, refining D-03) and the roster questions Phase 31 adds to the static test roster: who owns a client id, and who may run an
// agent seat (WR-01, D-12, default deny).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CLIENT_COUNTER_BITS, CLIENT_COUNTER_SPAN, MAX_SLOT, clientIdOf, isSlot, nextClientId, slotOfClientId } from '../domain/replica/clientIds';
import { MAX_CLIENT_ID } from '../domain/replica/kindSchemas/doc';
import { ROSTER_ROLE_PATTERNS, staticRosterView } from '../domain/replica/rosterView';
import type { StaticRosterSpec } from '../domain/replica/rosterView';
import { createWorld } from './helpers/replicaWorld';

const ROSTER_0 = 'roster-0';
const ROSTER_1 = 'roster-1';

test('the constants describe a 20-bit counter under a slot from 1 to 4095', () => {
  assert.equal(CLIENT_COUNTER_BITS, 20);
  assert.equal(CLIENT_COUNTER_SPAN, 2 ** CLIENT_COUNTER_BITS);
  assert.equal(MAX_SLOT, 4095);
  assert.equal(isSlot(1), true);
  assert.equal(isSlot(MAX_SLOT), true);
  for (const bad of [0, 4096, 1.5, -1, Number.NaN, '3', undefined]) assert.equal(isSlot(bad), false, String(bad));
});

test('clientIdOf multiplies: the edges of the range are 2^20 and the largest unsigned 32-bit id, and slot 2048 stays positive', () => {
  assert.equal(clientIdOf(1, 0), 1048576);
  assert.equal(clientIdOf(4095, 1048575), 4294967295);
  assert.equal(clientIdOf(4095, 1048575), MAX_CLIENT_ID);
  assert.equal(clientIdOf(2048, 0), 2147483648);
  assert.ok(clientIdOf(2048, 0) > 0);
  assert.equal(clientIdOf(2047, 1048575), 2147483647);
});

test('clientIdOf refuses a slot or counter out of range, naming the bad argument', () => {
  for (const slot of [0, 4096, 1.5, -1]) assert.throws(() => clientIdOf(slot, 0), /slot/, `slot ${slot}`);
  for (const counter of [-1, 1048576, 0.5]) assert.throws(() => clientIdOf(1, counter), /counter/, `counter ${counter}`);
});

test('slotOfClientId inverts clientIdOf for every edge slot and counter, and an id below 2^20 or out of range has no slot', () => {
  for (const slot of [1, 2, 2047, 2048, 4095]) {
    for (const counter of [0, 1, 1048575]) assert.equal(slotOfClientId(clientIdOf(slot, counter)), slot, `${slot}/${counter}`);
  }
  for (const id of [0, 1, 11, 101, 202, 1048575]) assert.equal(slotOfClientId(id), 0, String(id));
  for (const id of [4294967296, -1048576, 1048576.5, Number.NaN]) assert.equal(slotOfClientId(id), 0, String(id));
});

test('nextClientId gives the lowest unused id of the slot and undefined when the slot is full', () => {
  assert.equal(nextClientId(3, new Set()), clientIdOf(3, 0));
  assert.equal(nextClientId(3, new Set([clientIdOf(3, 0), clientIdOf(3, 1)])), clientIdOf(3, 2));
  // Ids of another slot do not use up this one.
  assert.equal(nextClientId(3, new Set([clientIdOf(4, 0)])), clientIdOf(3, 0));
  const full = new Set<number>();
  for (let counter = 0; counter < CLIENT_COUNTER_SPAN; counter += 1) full.add(clientIdOf(7, counter));
  assert.equal(nextClientId(7, full), undefined);
  assert.throws(() => nextClientId(0, new Set()), /slot/);
});

const device = (writer: string, slot?: number): { writer: string; publicKey: string; slot?: number } => (slot === undefined ? { writer, publicKey: `key-${writer}` } : { writer, publicKey: `key-${writer}`, slot });

test('a static roster whose devices have slots names the writer that owns a client id at the cited roster', () => {
  const spec: StaticRosterSpec = {
    rosters: [
      { hash: ROSTER_0, members: [{ member: 'mbr-a', name: 'A', roles: ['member'], devices: [device('w-a1', 1), device('w-a2', 2)] }] },
      { hash: ROSTER_1, members: [{ member: 'mbr-a', name: 'A', roles: ['member'], devices: [device('w-a1', 1), device('w-a2', 2)] }, { member: 'mbr-b', name: 'B', roles: ['member'], devices: [device('w-b', 3)] }] }
    ]
  };
  const view = staticRosterView(spec);
  assert.equal(typeof view.clientIdOwner, 'function');
  const owner = view.clientIdOwner as (clientId: number, rosterHash: string) => string | undefined;
  assert.equal(owner(clientIdOf(2, 7), ROSTER_0), 'w-a2');
  assert.equal(owner(clientIdOf(1, 1048575), ROSTER_0), 'w-a1');
  // Slot 3 is admitted only at the later roster.
  assert.equal(owner(clientIdOf(3, 0), ROSTER_0), undefined);
  assert.equal(owner(clientIdOf(3, 0), ROSTER_1), 'w-b');
  // An unknown slot, an id in no slot and an unknown roster name no owner.
  assert.equal(owner(clientIdOf(9, 0), ROSTER_1), undefined);
  assert.equal(owner(101, ROSTER_1), undefined);
  assert.equal(owner(clientIdOf(2, 7), 'roster-unknown'), undefined);
});

test('a static roster without any slot has no clientIdOwner at all, so nothing is enforced', () => {
  const view = staticRosterView({ rosters: [{ hash: ROSTER_0, members: [{ member: 'mbr-a', name: 'A', roles: ['member'], devices: [device('w-a1')] }] }] });
  assert.equal('clientIdOwner' in view, false);
  assert.equal(view.clientIdOwner, undefined);
  // The members the static view never implements stay absent too.
  assert.equal('deviceEncryptionKey' in view, false);
  assert.equal('cellGrantees' in view, false);
  assert.equal('rosterBranchPending' in view, false);
});

const seatSpec: StaticRosterSpec = {
  rosters: [
    {
      hash: ROSTER_0,
      members: [
        { member: 'mbr-x', name: 'X', roles: ['member'], devices: [device('w-x')], agentSeats: ['release-guard', 'tradecraft'] },
        { member: 'mbr-y', name: 'Y', roles: ['member'], devices: [device('w-y')] }
      ]
    },
    // At the later roster mbr-x no longer runs the release guard.
    { hash: ROSTER_1, members: [{ member: 'mbr-x', name: 'X', roles: ['member'], devices: [device('w-x')], agentSeats: ['tradecraft'] }, { member: 'mbr-y', name: 'Y', roles: ['member'], devices: [device('w-y')] }] }
  ]
};

test('canRunAgent answers from the agent seats listed for the member at the cited roster', () => {
  const view = staticRosterView(seatSpec);
  const canRun = view.canRunAgent as (member: string, seat: string, rosterHash: string) => boolean;
  assert.equal(typeof canRun, 'function');
  assert.equal(canRun('mbr-x', 'release-guard', ROSTER_0), true);
  assert.equal(canRun('mbr-x', 'tradecraft', ROSTER_0), true);
  assert.equal(canRun('mbr-x', 'release-guard', ROSTER_1), false);
  assert.equal(canRun('mbr-x', 'tradecraft', ROSTER_1), true);
  assert.equal(canRun('mbr-x', 'j2-chief', ROSTER_0), false);
});

test('canRunAgent denies by default: an unknown member, an unknown roster, and a member with no agent seats', () => {
  const view = staticRosterView(seatSpec);
  const canRun = view.canRunAgent as (member: string, seat: string, rosterHash: string) => boolean;
  assert.equal(canRun('mbr-nobody', 'release-guard', ROSTER_0), false);
  assert.equal(canRun('mbr-x', 'release-guard', 'roster-unknown'), false);
  for (const seat of ['release-guard', 'tradecraft', 'j2-chief', '']) assert.equal(canRun('mbr-y', seat, ROSTER_0), false, seat);
});

test('observer is a roster role word; root still is not', () => {
  const matches = (role: string): boolean => ROSTER_ROLE_PATTERNS.some((entry) => entry.pattern.test(role));
  assert.equal(matches('observer'), true);
  assert.equal(ROSTER_ROLE_PATTERNS.find((entry) => entry.role === 'observer')?.meaning, 'Reads the project and writes only presence.');
  assert.equal(matches('root'), false);
  assert.equal(matches('observer:j2'), false);
});

test('createWorld passes agent seats and device slots into the static roster', () => {
  const world = createWorld({ members: [{ member: 'mbr-g', roles: ['member'], devices: ['A', 'B'], agentSeats: ['release-guard'], slots: [3, 4] }, { member: 'mbr-h', devices: ['H'] }] });
  const roster = world.ctx().roster;
  assert.equal(roster.canRunAgent?.('mbr-g', 'release-guard', world.rosterHash), true);
  assert.equal(roster.canRunAgent?.('mbr-g', 'tradecraft', world.rosterHash), false);
  assert.equal(roster.canRunAgent?.('mbr-h', 'release-guard', world.rosterHash), false);
  assert.equal(roster.clientIdOwner?.(clientIdOf(3, 0), world.rosterHash), world.writerOf('A'));
  assert.equal(roster.clientIdOwner?.(clientIdOf(4, 12), world.rosterHash), world.writerOf('B'));
  // H was given no slot, so no id maps to it.
  assert.equal(roster.clientIdOwner?.(clientIdOf(1, 0), world.rosterHash), undefined);
});

test('createWorld called as every Phase 30 test calls it gives the roster it gave before: no clientIdOwner, every seat denied', () => {
  const world = createWorld({ members: [{ member: 'mbr-lead', roles: ['member', 'staff_lead'], devices: ['LEAD'] }, { member: 'mbr-p', devices: ['P'] }] });
  const roster = world.ctx().roster;
  assert.equal('clientIdOwner' in roster, false);
  for (const member of ['mbr-lead', 'mbr-p']) {
    for (const seat of ['release-guard', 'tradecraft', 'j2-chief']) assert.equal(roster.canRunAgent?.(member, seat, world.rosterHash), false, `${member}/${seat}`);
  }
  assert.deepEqual(world.rosterSpec.rosters[0].members.map((member) => Object.keys(member).sort()), [['devices', 'member', 'name', 'roles'], ['devices', 'member', 'name', 'roles']]);
  assert.deepEqual(world.rosterSpec.rosters[0].members.flatMap((member) => member.devices.map((entry) => Object.keys(entry).sort())), [['publicKey', 'writer'], ['publicKey', 'writer']]);
});
