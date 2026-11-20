// Client id slots (D-41, refining D-03) and the roster questions Phase 31 adds to the static test roster: who owns a client id, and who may run an
// agent seat (WR-01, D-12, default deny).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CLIENT_COUNTER_BITS, CLIENT_COUNTER_SPAN, MAX_SLOT, clientIdOf, isSlot, nextClientId, slotOfClientId } from '../domain/replica/clientIds';
import { MAX_CLIENT_ID } from '../domain/replica/kindSchemas/doc';
import { staticRosterView } from '../domain/replica/rosterView';
import type { StaticRosterSpec } from '../domain/replica/rosterView';

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
