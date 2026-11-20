// Client id slots (D-41, refining D-03) and the roster questions Phase 31 adds to the static test roster: who owns a client id, and who may run an
// agent seat (WR-01, D-12, default deny).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CLIENT_COUNTER_BITS, CLIENT_COUNTER_SPAN, ClientIdAllocator, MAX_SLOT, clientIdOf, isSlot, nextClientId, slotOfClientId } from '../domain/replica/clientIds';
import { MAX_CLIENT_ID } from '../domain/replica/kindSchemas/doc';
import { ROSTER_ROLE_PATTERNS, staticRosterView } from '../domain/replica/rosterView';
import type { StaticRosterSpec } from '../domain/replica/rosterView';
import { applyRemote, docText, encodeFullState, inspectUpdate } from '../domain/replica/doc';
import { foldEntries } from '../domain/replica/fold';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { createWorld, permutations, rng, updateData } from './helpers/replicaWorld';
import type { Editor, World, Written } from './helpers/replicaWorld';

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

// ---- Client ids bound to the writer's slot in the text reducer (D-03, D-41, plan 31-04) ----------------------------------------------------------

const PRODUCT = 'intel-estimate';
const sealed = (items: readonly Written[]) => items.map((item) => item.entry);
const reasons = (result: ReturnType<typeof foldEntries>): Array<[string, string]> => result.refused.map((item): [string, string] => [item.hash, item.reason]).sort();

function productOf(result: ReturnType<typeof foldEntries>): ProductTextOutput {
  const products = result.families.doc as ProductTextOutput[];
  assert.equal(products.length, 1);
  return products[0];
}

// A holds slot 1 and B slot 2; N is admitted but has no slot.
function slottedWorld(): World {
  return createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'], slots: [1] }, { member: 'mbr-bbbb', devices: ['B'], slots: [2] }, { member: 'mbr-nnnn', devices: ['N'] }] });
}

test('with slots in the roster a writer registers ids of its own slot only: an id of another writer\'s slot is refused foreign-client-id', () => {
  const world = slottedWorld();
  const regA = world.editor('A', PRODUCT, clientIdOf(1, 0)).register();
  const intoA = world.editor('B', PRODUCT, clientIdOf(1, 5)).register();
  const b = world.editor('B', PRODUCT, clientIdOf(2, 0));
  const regB = b.register();
  const typed = b.insert(0, 'own range');
  const result = foldEntries(sealed([regA, intoA, regB, typed]), world.ctx());
  assert.deepEqual(reasons(result), [[intoA.hash, 'foreign-client-id']]);
  assert.deepEqual(result.applied.slice().sort(), [regA.hash, regB.hash, typed.hash].sort());
  const product = productOf(result);
  assert.deepEqual(product.registrations.map((registration) => [registration.clientId, registration.writer]), [[clientIdOf(1, 0), world.writerOf('A')], [clientIdOf(2, 0), world.writerOf('B')]]);
  assert.equal(product.text, 'own range');
});

test('two writers registering one id at once is not a race: in every delivery order the slot owner keeps it and the other is refused foreign-client-id', () => {
  const world = slottedWorld();
  const a = world.editor('A', PRODUCT, clientIdOf(1, 0));
  const b = world.editor('B', PRODUCT, clientIdOf(1, 0));
  const regB = b.register();
  const regA = a.register();
  const typedA = a.insert(0, 'from A');
  const typedB = b.insert(0, 'from B');
  const all = [regA, regB, typedA, typedB];
  const reference = foldEntries(sealed(all), world.ctx());
  assert.equal(reasons(reference).some(([hash, reason]) => hash === regB.hash && reason === 'foreign-client-id'), true);
  for (const order of permutations(sealed(all))) {
    const result = foldEntries(order, world.ctx());
    assert.equal(result.applied.includes(regA.hash) && result.applied.includes(typedA.hash), true);
    assert.deepEqual(result.refused.find((item) => item.hash === regB.hash)?.reason, 'foreign-client-id');
    assert.equal(result.applied.includes(typedB.hash), false);
    assert.deepEqual(result.digests, reference.digests);
    assert.equal(productOf(result).text, 'from A');
    assert.deepEqual(productOf(result).registrations.map((registration) => registration.writer), [world.writerOf('A')]);
  }
});

test('when the roster names owners, an id below 2^20, an id of a slot nobody holds and any id of a device without a slot are refused foreign-client-id', () => {
  const world = slottedWorld();
  const low = world.editor('A', PRODUCT, 11).register();
  const top = world.editor('A', PRODUCT, clientIdOf(1, 0) - 1).register();
  const empty = world.editor('A', PRODUCT, clientIdOf(9, 0)).register();
  const unslotted = world.editor('N', PRODUCT, clientIdOf(3, 0)).register();
  const result = foldEntries(sealed([low, top, empty, unslotted]), world.ctx());
  assert.deepEqual(reasons(result), [low, top, empty, unslotted].map((item): [string, string] => [item.hash, 'foreign-client-id']).sort());
  assert.deepEqual(result.applied, []);
});

test('inside its own range a device that registers an id again under another actor is still refused client-collision', () => {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'], slots: [1], agentSeats: ['j2-analyst'] }] });
  const first = world.editor('A', PRODUCT, clientIdOf(1, 3)).register();
  const again = world.editor('A', PRODUCT, clientIdOf(1, 3)).register();
  const asAgent = world.editor('A', PRODUCT, clientIdOf(1, 3)).register({ actor: { kind: 'agent', member: 'j2-analyst', run: 'r-1' } });
  const result = foldEntries(sealed([first, again, asAgent]), world.ctx());
  assert.deepEqual(reasons(result), [[asAgent.hash, 'client-collision']]);
  assert.deepEqual(result.applied.slice().sort(), [first.hash, again.hash].sort());
  assert.equal(productOf(result).registrations.length, 1);
});

test('a world without slots (the Phase 30 static roster) registers as before: small ids are fine and the earlier claim wins with client-collision', () => {
  const world = createWorld({ members: [{ member: 'mbr-wwww', devices: ['W'] }, { member: 'mbr-xxxx', devices: ['X'] }] });
  const regX = world.editor('X', PRODUCT, 7).register();
  const regW = world.editor('W', PRODUCT, 7).register();
  const result = foldEntries(sealed([regX, regW]), world.ctx());
  const loser = result.order.indexOf(regX.hash) < result.order.indexOf(regW.hash) ? regW : regX;
  assert.deepEqual(reasons(result), [[loser.hash, 'client-collision']]);
  assert.equal(productOf(result).registrations.length, 1);
  assert.equal(productOf(result).registrations[0].clientId, 7);
});

test('invariant: in every fold whose roster names client id owners, every accepted update inserts only under ids of its writer\'s slot (60 seeded worlds)', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const random = rng(seed);
    const count = 2 + random.int(4);
    const names = Array.from({ length: count }, (_, index) => `D${index}`);
    // Distinct slots spread over the whole range, so ids of high slots (above 2^31) are exercised too.
    const slots: number[] = [];
    while (slots.length < count) {
      const slot = 1 + random.int(4095);
      if (!slots.includes(slot)) slots.push(slot);
    }
    const world = createWorld({ members: names.map((name, index) => ({ member: `mbr-${index}`, devices: [name], slots: [slots[index]] })) });
    const slotOf = new Map(names.map((name, index) => [world.writerOf(name), slots[index]]));
    const editors: Array<{ name: string; editor: Editor }> = [];
    const written: Written[] = [];
    const updates = new Map<string, Uint8Array>();
    for (let step = 0; step < 18; step += 1) {
      const name = random.pick(names);
      const own = slots[names.indexOf(name)];
      if (editors.length === 0 || random.chance(0.3)) {
        // Mostly an id of the writer's own slot; sometimes another writer's id, an unheld slot or an id below 2^20.
        const roll = random.next();
        const clientId = roll < 0.6 ? clientIdOf(own, random.int(4)) : roll < 0.8 ? clientIdOf(random.pick(slots), random.int(4)) : roll < 0.9 ? 1 + random.int(1048575) : clientIdOf(1 + random.int(4095), 0);
        const editor = world.editor(name, PRODUCT, clientId);
        editors.push({ name, editor });
        written.push(editor.register());
        continue;
      }
      const chosen = random.pick(editors);
      // A writer types on its own editors, and sometimes writes an update under an editor of another writer (a forgery attempt).
      const writer = random.chance(0.25) ? random.pick(names) : chosen.name;
      const other = random.pick(editors);
      if (other !== chosen) applyRemote(chosen.editor.doc, encodeFullState(other.editor.doc));
      const bytes = chosen.editor.insertUpdate(random.int(1 + docText(chosen.editor.doc).length), `w${random.int(100)} `);
      const entry = world.write(writer, { kind: 'doc.update', data: updateData(PRODUCT, bytes) });
      updates.set(entry.hash, bytes);
      written.push(entry);
    }
    const result = foldEntries(sealed(written), world.ctx());
    const byHash = new Map(written.map((item) => [item.hash, item]));
    for (const hash of result.applied) {
      const bytes = updates.get(hash);
      if (bytes === undefined) continue;
      const writerSlot = slotOf.get((byHash.get(hash) as Written).writer);
      const inspection = inspectUpdate(bytes);
      assert.equal('error' in inspection, false, `seed ${seed}`);
      if ('error' in inspection) continue;
      for (const span of inspection.clients) assert.equal(slotOfClientId(span.client), writerSlot, `seed ${seed}: client ${span.client}`);
    }
    for (const product of result.families.doc as ProductTextOutput[]) {
      for (const registration of product.registrations) assert.equal(slotOfClientId(registration.clientId), slotOf.get(registration.writer), `seed ${seed}: registration`);
    }
  }
});

// The walk nextClientId made before: every counter of the slot from 0.
function naiveNext(slot: number, used: ReadonlySet<number>): number | undefined {
  const base = clientIdOf(slot, 0);
  for (let counter = 0; counter < CLIENT_COUNTER_SPAN; counter += 1) if (!used.has(base + counter)) return base + counter;
  return undefined;
}

test('nextClientId and ClientIdAllocator give exactly the ids the full walk gave, for random used sets that mix slots, gaps and other ids', () => {
  let seed = 7;
  const random = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 200; round += 1) {
    const used = new Set<number>();
    const size = Math.floor(random() * 60);
    for (let index = 0; index < size; index += 1) {
      const slot = 1 + Math.floor(random() * 3);
      used.add(random() < 0.7 ? clientIdOf(slot, Math.floor(random() * 40)) : Math.floor(random() * 5000));
    }
    for (const slot of [1, 2, 3]) {
      const expected = naiveNext(slot, used);
      assert.equal(nextClientId(slot, used), expected, `round ${round} slot ${slot}`);
      assert.equal(new ClientIdAllocator(used).next(slot), expected, `allocator round ${round} slot ${slot}`);
    }
  }
  // A full slot gives undefined both ways; a slot out of range throws both ways.
  const full = new Set(Array.from({ length: CLIENT_COUNTER_SPAN }, (_, counter) => clientIdOf(9, counter)));
  assert.equal(nextClientId(9, full), undefined);
  assert.equal(new ClientIdAllocator(full).next(9), undefined);
  assert.throws(() => new ClientIdAllocator().next(0), /slot/);
});

test('many registrations stay fast: 200 000 ids taken one after another in one slot, each the lowest free one, with ids marked used out of order', () => {
  const allocator = new ClientIdAllocator();
  // Ids used by the log ahead of time, out of order: the allocator skips them.
  for (const counter of [5, 3, 4]) allocator.markUsed(clientIdOf(2, counter));
  const started = Date.now();
  const taken: number[] = [];
  for (let index = 0; index < 200_000; index += 1) taken.push(allocator.take(2) as number);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `200 000 registrations took ${elapsed} ms`);
  assert.deepEqual(taken.slice(0, 6), [0, 1, 2, 6, 7, 8].map((counter) => clientIdOf(2, counter)));
  assert.equal(new Set(taken).size, taken.length, 'no id is given twice');
  assert.equal(taken[taken.length - 1], clientIdOf(2, 200_002));
  // The same answer the bounded walk gives for the same used set.
  const used = new Set([...taken, clientIdOf(2, 3), clientIdOf(2, 4), clientIdOf(2, 5)]);
  assert.equal(allocator.next(2), nextClientId(2, used));
  // Another slot starts at its own counter 0.
  assert.equal(allocator.take(3), clientIdOf(3, 0));
});
