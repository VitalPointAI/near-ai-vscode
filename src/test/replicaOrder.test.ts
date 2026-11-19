// Order and incremental folding (plan 30-09, D-08, D-10): folding as entries arrive equals folding them all at once, and a refold happens only for a
// late concurrent entry.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCausalGraph } from '../domain/replica/causal';
import type { GraphEntry } from '../domain/replica/causal';
import { addEntries, createFoldState, foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import type { Dep, SealedEntry } from '../domain/replica/entry';
import { checkpointOrder, kahnOrder, totalOrder } from '../domain/replica/order';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { WORLD_AT, createWorld, rng } from './helpers/replicaWorld';
import type { Written } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';
const sealed = (...items: Written[]): SealedEntry[] => items.map((item) => item.entry);

// A and B co-edit in sequence (B cites A's head); C writes concurrently with both, at low lamport values.
function coEdit(): { world: ReturnType<typeof createWorld>; a: Written[]; b: Written[]; c: Written[] } {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }, { member: 'mbr-bbbb', devices: ['B'] }, { member: 'mbr-cccc', devices: ['C'] }] });
  const ea = world.editor('A', PRODUCT, 101);
  const eb = world.editor('B', PRODUCT, 202);
  const ec = world.editor('C', PRODUCT, 303);
  const a0 = ea.register();
  const a1 = ea.insert(0, 'Hello ');
  const b0 = eb.register({ deps: [a1] });
  const b1 = eb.insert(0, 'world');
  const c0 = ec.register();
  const c1 = ec.insert(0, 'big ');
  return { world, a: [a0, a1], b: [b0, b1], c: [c0, c1] };
}

function sameResult(left: FoldResult, right: FoldResult, label: string): void {
  assert.deepEqual(left.order, right.order, `${label}: order`);
  assert.deepEqual(left.applied, right.applied, `${label}: applied`);
  assert.deepEqual(left.families, right.families, `${label}: families`);
  assert.deepEqual(left.digests, right.digests, `${label}: digests`);
  assert.deepEqual(left.held, right.held, `${label}: held`);
  assert.deepEqual(left.rejected, right.rejected, `${label}: rejected`);
  assert.deepEqual(left.kept, right.kept, `${label}: kept`);
  assert.deepEqual(left.refused, right.refused, `${label}: refused`);
  assert.deepEqual(left.excluded, right.excluded, `${label}: excluded`);
}

test('entries causally after everything folded are appended without a refold', () => {
  const { world, a, b } = coEdit();
  const ctx = world.ctx();
  const first = addEntries(createFoldState(ctx), sealed(...a));
  const second = addEntries(first, sealed(...b));
  assert.equal(first.refolds, 0);
  assert.equal(second.refolds, first.refolds);
  assert.equal((second.result.families.doc as ProductTextOutput[])[0].text, 'Hello world');
  sameResult(second.result, foldEntries(sealed(...a, ...b), ctx), 'append');
});

test('a late concurrent entry that sorts before the last folded entry triggers one refold, and the result equals the from-scratch fold', () => {
  const { world, a, b, c } = coEdit();
  const ctx = world.ctx();
  const second = addEntries(addEntries(createFoldState(ctx), sealed(...a)), sealed(...b));
  const third = addEntries(second, sealed(...c));
  assert.equal(third.refolds, second.refolds + 1);
  sameResult(third.result, foldEntries(sealed(...a, ...b, ...c), ctx), 'late');
  assert.equal(third.result.applied.length, 6);
});

test('an earlier state is never changed by adding entries to it', () => {
  const { world, a, b, c } = coEdit();
  const ctx = world.ctx();
  const first = addEntries(createFoldState(ctx), sealed(...a));
  const digestsBefore = JSON.stringify(first.result.digests);
  const orderBefore = [...first.result.order];
  const second = addEntries(first, sealed(...b));
  const other = addEntries(first, sealed(...c));
  assert.equal(JSON.stringify(first.result.digests), digestsBefore);
  assert.deepEqual(first.result.order, orderBefore);
  assert.equal(first.refolds, 0);
  sameResult(second.result, foldEntries(sealed(...a, ...b), ctx), 'branch b');
  sameResult(other.result, foldEntries(sealed(...a, ...c), ctx), 'branch c');
});

test('adding an entry that is already present changes nothing and does not refold', () => {
  const { world, a, b, c } = coEdit();
  const ctx = world.ctx();
  const state = addEntries(addEntries(createFoldState(ctx), sealed(...a, ...b)), sealed(...c));
  const again = addEntries(state, sealed(a[0], c[1], b[1]));
  assert.equal(again, state);
  assert.equal(again.refolds, state.refolds);
  const copy = addEntries(state, [{ header: { ...a[0].entry.header }, body: a[0].entry.body }]);
  assert.equal(copy.refolds, state.refolds);
  sameResult(copy.result, state.result, 'copy');
});

test('an entry that waits for a missing predecessor changes the held list and never refolds, and folds when the predecessor arrives', () => {
  const { world, a } = coEdit();
  const ctx = world.ctx();
  const early = addEntries(createFoldState(ctx), sealed(a[1]));
  assert.deepEqual(early.result.held.map((held) => held.reason), ['missing-predecessor']);
  assert.equal(early.result.applied.length, 0);
  const full = addEntries(early, sealed(a[0]));
  assert.equal(full.result.applied.length, 2);
  sameResult(full.result, foldEntries(sealed(...a), ctx), 'late predecessor');
});

// A random history of 2 to 5 writers and at most 60 entries with random deps, as graph entries (no sealing needed for ordering).
function randomHistory(seed: number): GraphEntry[] {
  const random = rng(seed);
  const names = ['A', 'B', 'C', 'D', 'E'].slice(0, 2 + random.int(4));
  const world = createWorld({ members: names.map((name) => ({ member: `mbr-${name.toLowerCase()}${name.toLowerCase()}`, devices: [name] })) });
  const written: Written[] = [];
  const result: GraphEntry[] = [];
  const total = 1 + random.int(60);
  for (let index = 0; index < total; index += 1) {
    const name = random.pick(names);
    const deps: Written[] = [];
    if (written.length > 0) {
      const wanted = random.int(4);
      for (let count = 0; count < wanted; count += 1) {
        const pick = random.pick(written);
        if (!deps.includes(pick)) deps.push(pick);
      }
    }
    const entry = world.write(name, { kind: 'doc.update', data: { index }, deps });
    written.push(entry);
    const depList: Dep[] = deps.map((dep) => ({ writer: dep.writer, seq: dep.seq, hash: dep.hash }));
    result.push({ hash: entry.hash, header: entry.entry.header, body: { deps: depList, roster: world.rosterHash, lamport: entry.lamport, at: WORLD_AT, actor: { kind: 'person' }, kind: 'doc.update', data: { index } } });
  }
  return result;
}

test('totalOrder equals a Kahn topological sort with the same tie-break on 200 seeded random histories', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const entries = randomHistory(seed);
    const graph = buildCausalGraph(entries);
    const reference = kahnOrder(entries, graph).map((entry) => entry.hash);
    const sorted = totalOrder(entries).map((entry) => entry.hash);
    assert.deepEqual(sorted, reference, `seed ${seed}`);
    // Whatever order the entries are listed in, the order is the same.
    const reversed = totalOrder([...entries].reverse()).map((entry) => entry.hash);
    assert.deepEqual(reversed, reference, `seed ${seed} reversed`);
  }
});

test('the total order is a topological order: every entry comes after everything it follows', () => {
  for (let seed = 201; seed <= 230; seed += 1) {
    const entries = randomHistory(seed);
    const graph = buildCausalGraph(entries);
    const position = new Map(totalOrder(entries).map((entry, index) => [entry.hash, index]));
    for (const entry of entries) {
      for (const pred of graph.preds(entry.hash)) assert.ok((position.get(pred) as number) < (position.get(entry.hash) as number), `seed ${seed}`);
    }
  }
});

test('checkpointOrder puts each covered set in order first and the rest after, and equals totalOrder without checkpoints', () => {
  const entries = randomHistory(7);
  const sorted = totalOrder(entries);
  assert.deepEqual(checkpointOrder(entries, []).map((entry) => entry.hash), sorted.map((entry) => entry.hash));
  const first = new Set(sorted.slice(5, 9).map((entry) => entry.hash));
  const second = new Set([...first, ...sorted.slice(0, 3).map((entry) => entry.hash)]);
  const ordered = checkpointOrder(entries, [first, second]).map((entry) => entry.hash);
  const expected = [
    ...totalOrder(entries.filter((entry) => first.has(entry.hash))),
    ...totalOrder(entries.filter((entry) => second.has(entry.hash) && !first.has(entry.hash))),
    ...totalOrder(entries.filter((entry) => !second.has(entry.hash)))
  ].map((entry) => entry.hash);
  assert.deepEqual(ordered, expected);
});
