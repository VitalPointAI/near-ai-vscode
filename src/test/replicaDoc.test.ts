// The ownership and compaction rules of co-edited text (plan 30-06, D-18, D-19, D-21, D-35, D-37): a hostile update cannot forge attribution, crash
// the fold, or make the text depend on the order updates were applied in, and a compaction is a cache that is checked against the log.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRemote, applyUpdate, attributionRuns, buildFromCompaction, createFoldDoc, createLocalDoc, docText, encodeDiff, encodeFullState, inspectUpdate, localDelete, localInsert, pendingState, stateVectorOf, textHashOf } from '../domain/replica/doc';
import { sealBlob } from '../domain/replica/entry';
import type { Actor, Dep } from '../domain/replica/entry';
import { foldEntries } from '../domain/replica/fold';
import { MAX_UPDATE_BYTES, validateDocData } from '../domain/replica/kindSchemas/doc';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { createWorld, permutations, rng, updateData } from './helpers/replicaWorld';
import type { Written, World } from './helpers/replicaWorld';
import { embedUpdate, foreignFullState, formatUpdate, gcUpdate, mapUpdate, nestedArrayUpdate, nestedTypeUpdate, skipUpdate } from './helpers/replicaYjs';

const PRODUCT = 'intel-estimate';
const sealed = (items: readonly Written[]) => items.map((item) => item.entry);

function productOf(result: ReturnType<typeof foldEntries>): ProductTextOutput {
  const products = result.families.doc as ProductTextOutput[];
  assert.equal(products.length, 1);
  return products[0];
}

const reasons = (result: ReturnType<typeof foldEntries>): Array<[string, string]> => result.refused.map((item): [string, string] => [item.hash, item.reason]).sort();

function twoWriters(): World {
  return createWorld({ members: [{ member: 'mbr-wwww', name: 'Wen', devices: ['W'] }, { member: 'mbr-qqqq', name: 'Quinn', devices: ['Q'] }, { member: 'mbr-xxxx', name: 'Xi', devices: ['X'] }] });
}

// ---- Task 2: ownership hardening ------------------------------------------------------------------------------------------------------------

test('updates that carry an embed, a format, a map value, a nested type or a Skip struct are refused forbidden-content, and plain inserts and deletes pass', () => {
  const world = twoWriters();
  const editor = world.editor('W', PRODUCT, 31);
  const register = editor.register();
  const hostile = [embedUpdate(31), formatUpdate(31), mapUpdate(31), nestedTypeUpdate(31), skipUpdate(31, 0, 4), nestedArrayUpdate(50, 31)]
    .map((bytes) => world.write('W', { kind: 'doc.update', data: updateData(PRODUCT, bytes) }));
  const insert = editor.insert(0, 'plain text');
  const remove = editor.remove(0, 6);
  const result = foldEntries(sealed([register, ...hostile, insert, remove]), world.ctx());
  assert.deepEqual(reasons(result), hostile.map((item): [string, string] => [item.hash, 'forbidden-content']).sort());
  assert.equal(result.applied.includes(insert.hash) && result.applied.includes(remove.hash), true);
  assert.equal(productOf(result).text, 'text');
});

test('random bytes, a truncated update and a 40 KB update of 20 000 nested arrays are malformed-update and never throw out of the fold', () => {
  assert.deepEqual(inspectUpdate(Uint8Array.from(Array.from({ length: 24 }, () => 255))), { error: 'malformed' });
  const real = localInsert(createLocalDoc(31), 0, 'a longer piece of text to cut');
  assert.deepEqual(inspectUpdate(real.slice(0, real.length - 6)), { error: 'malformed' });
  const nested = nestedArrayUpdate(20_000, 31);
  assert.ok(nested.length > 39_000 && nested.length < 41_000);
  assert.deepEqual(inspectUpdate(nested), { error: 'malformed' });
  const world = twoWriters();
  const editor = world.editor('W', PRODUCT, 31);
  const register = editor.register();
  const entries = [real.slice(0, real.length - 6), nested, Uint8Array.from(Array.from({ length: 24 }, () => 255))].map((bytes) => world.write('W', { kind: 'doc.update', data: updateData(PRODUCT, bytes) }));
  const result = foldEntries(sealed([register, ...entries]), world.ctx());
  assert.deepEqual(reasons(result), entries.map((item): [string, string] => [item.hash, 'malformed-update']).sort());
  assert.equal(productOf(result).text, '');
});

test('an update over the byte cap is too-large before it is decoded, a GC struct claiming 4 294 967 295 clocks is refused too-large, and the schema stops an oversize body', () => {
  assert.deepEqual(inspectUpdate(new Uint8Array(MAX_UPDATE_BYTES + 1)), { error: 'too-large' });
  assert.deepEqual(inspectUpdate(gcUpdate(31, 0, 4_294_967_295)), { error: 'too-large' });
  assert.equal('error' in inspectUpdate(gcUpdate(31, 0, 5)), false);
  const world = twoWriters();
  const editor = world.editor('W', PRODUCT, 31);
  const register = editor.register();
  const gc = world.write('W', { kind: 'doc.update', data: updateData(PRODUCT, gcUpdate(31, 0, 4_294_967_295)) });
  const result = foldEntries(sealed([register, gc]), world.ctx());
  assert.deepEqual(reasons(result), [[gc.hash, 'too-large']]);
  assert.match(validateDocData('doc.update', { product: PRODUCT, update: Buffer.alloc(MAX_UPDATE_BYTES + 1, 7).toString('base64url') }, 'data') ?? '', /^bad-data/);
});

test('an update under another writer\'s client id, and a whole document re-encoded from a peer, are refused foreign-client and change nothing', () => {
  const world = twoWriters();
  const w = world.editor('W', PRODUCT, 31);
  const q = world.editor('Q', PRODUCT, 41);
  const regW = w.register();
  const regQ = q.register();
  const typedW = w.insert(0, 'Hello ');
  const typedQ = q.insert(0, 'world');
  const forged = world.write('W', { kind: 'doc.update', data: updateData(PRODUCT, q.insertUpdate(5, '!')) });
  const whole = world.write('W', { kind: 'doc.update', data: updateData(PRODUCT, foreignFullState([encodeFullState(w.doc), encodeFullState(q.doc)])) });
  const clean = foldEntries(sealed([regW, regQ, typedW, typedQ]), world.ctx());
  const result = foldEntries(sealed([regW, regQ, typedW, typedQ, forged, whole]), world.ctx());
  assert.deepEqual(reasons(result), [[forged.hash, 'foreign-client'], [whole.hash, 'foreign-client']].sort());
  assert.equal(productOf(result).text, productOf(clean).text);
  assert.deepEqual(result.digests, clean.digests);
});

test('an update under a client id nobody registered is held unregistered-client and changes nothing', () => {
  const world = twoWriters();
  const w = world.editor('W', PRODUCT, 31);
  const register = w.register();
  const stranger = createLocalDoc(41);
  const orphan = world.write('W', { kind: 'doc.update', data: updateData(PRODUCT, localInsert(stranger, 0, 'who typed this')) });
  const result = foldEntries(sealed([register, orphan]), world.ctx());
  assert.deepEqual(result.held.map((item) => [item.hash, item.reason, item.stage]), [[orphan.hash, 'unregistered-client', 'fold']]);
  assert.deepEqual([result.refused, result.rejected, result.applied], [[], [], [register.hash]]);
  assert.equal(productOf(result).text, '');
});

test('a set holding only the update holds it without rejecting anything, and adding the registration applies both in either delivery order', () => {
  const world = twoWriters();
  const w = world.editor('W', PRODUCT, 31);
  const w0 = w.register();
  const w1 = w.insert(0, 'late registration');
  const only = foldEntries(sealed([w1]), world.ctx());
  assert.deepEqual(only.held.map((item) => [item.hash, item.reason]), [[w1.hash, 'missing-predecessor']]);
  assert.deepEqual([only.rejected, only.refused, only.applied], [[], [], []]);
  const forward = foldEntries(sealed([w0, w1]), world.ctx());
  const backward = foldEntries(sealed([w1, w0]), world.ctx());
  assert.deepEqual([forward.applied.length, forward.held, forward.rejected], [2, [], []]);
  assert.equal(productOf(forward).text, 'late registration');
  assert.deepEqual(forward.digests, backward.digests);
  assert.equal(productOf(backward).text, productOf(forward).text);
});

test('two writers registering one client id: the earlier claim in the total order wins in every delivery order, the loser\'s text is refused, and id 0 never reaches the fold', () => {
  const world = twoWriters();
  const x = world.editor('X', PRODUCT, 7);
  const w = world.editor('W', PRODUCT, 7);
  const regX = x.register();
  const regW = w.register();
  const typedX = x.insert(0, 'from X');
  const typedW = w.insert(0, 'from W');
  const all = [regX, regW, typedX, typedW];
  const reference = foldEntries(sealed(all), world.ctx());
  const winner = reference.order.indexOf(regX.hash) < reference.order.indexOf(regW.hash) ? { reg: regX, typed: typedX, loseReg: regW, loseTyped: typedW, text: 'from X' } : { reg: regW, typed: typedW, loseReg: regX, loseTyped: typedX, text: 'from W' };
  assert.deepEqual(reasons(reference), [[winner.loseReg.hash, 'client-collision'], [winner.loseTyped.hash, 'foreign-client']].sort());
  assert.equal(productOf(reference).text, winner.text);
  for (const order of permutations(sealed(all))) {
    const result = foldEntries(order, world.ctx());
    assert.deepEqual(reasons(result), reasons(reference));
    assert.deepEqual(result.digests, reference.digests);
    assert.equal(productOf(result).text, winner.text);
  }
  const zero = world.editor('W', 'other-product', 0).register();
  const refused = foldEntries(sealed([zero]), world.ctx());
  assert.deepEqual(refused.rejected.map((item) => item.reason), ['bad-data']);
  assert.match(validateDocData('doc.client', { product: PRODUCT, clientId: 0, actor: { kind: 'person' } }, 'data') ?? '', /^bad-data/);
});

test('one client id belongs to one author: the same device registering it again as an agent run is refused', () => {
  const world = twoWriters();
  const w = world.editor('W', PRODUCT, 31);
  const person = w.register();
  const again = w.register();
  const asAgent = world.editor('W', PRODUCT, 31).register({ actor: { kind: 'agent', member: 'j2-analyst', run: 'r-1' } });
  const result = foldEntries(sealed([person, again, asAgent]), world.ctx());
  assert.deepEqual(reasons(result), [[asAgent.hash, 'client-collision']]);
  assert.equal(productOf(result).registrations.length, 1);
});

test('two updates claiming one client clock are resolved the same way in both delivery orders: the later in the writer\'s chain is clock-overlap', () => {
  const world = twoWriters();
  const first = world.editor('W', PRODUCT, 31);
  const second = world.editor('W', PRODUCT, 31);
  const register = first.register();
  const a = first.insert(0, 'abc');
  const b = second.insert(0, 'xyz');
  for (const order of [[register, a, b], [b, a, register], [a, register, b]]) {
    const result = foldEntries(sealed(order), world.ctx());
    assert.deepEqual(reasons(result), [[b.hash, 'clock-overlap']]);
    assert.equal(productOf(result).text, 'abc');
    assert.equal(productOf(result).incomplete, false);
  }
});

test('an update that starts above the next expected clock is applied and the product is marked incomplete', () => {
  const world = twoWriters();
  const w = world.editor('W', PRODUCT, 31);
  const register = w.register();
  w.insertUpdate(0, 'lost batch');
  const after = w.insert(10, ' and the rest');
  const result = foldEntries(sealed([register, after]), world.ctx());
  assert.deepEqual([result.refused, result.held], [[], []]);
  assert.equal(result.applied.includes(after.hash), true);
  assert.equal(productOf(result).incomplete, true);
  assert.equal(productOf(result).text, '');
  const alone = createFoldDoc();
  applyUpdate(alone, encodeFullState(w.doc));
  assert.equal(pendingState(alone), false);
});

test('the fold records which entry deleted which range of whose text, once however often the deletion arrives', () => {
  const world = twoWriters();
  const w = world.editor('W', PRODUCT, 31);
  const q = world.editor('Q', PRODUCT, 41);
  const x = world.editor('X', PRODUCT, 51);
  const regs = [w.register(), q.register(), x.register()];
  const typed = w.insert(0, 'the quick brown fox');
  applyRemote(q.doc, encodeFullState(w.doc));
  applyRemote(x.doc, encodeFullState(w.doc));
  const byQ = q.remove(4, 6);
  const byX = x.remove(4, 6);
  const result = foldEntries([...sealed([...regs, typed, byQ, byX]), ...sealed([byQ, byQ])], world.ctx());
  const product = productOf(result);
  assert.equal(product.text, 'the brown fox');
  assert.equal(product.deletions.length, 1);
  const first = result.order.indexOf(byQ.hash) < result.order.indexOf(byX.hash) ? byQ : byX;
  assert.deepEqual(product.deletions[0], { entry: first.hash, client: 31, clock: 4, length: 6 });
});

test('encodeDiff gives the structs a peer lacks, and buildFromCompaction rebuilds the same text from a state and later updates', () => {
  const a = createLocalDoc(31);
  const u1 = localInsert(a, 0, 'one two');
  const fold = createFoldDoc();
  applyUpdate(fold, u1);
  const state = encodeFullState(fold);
  const u2 = localInsert(a, 7, ' three');
  const behind = createFoldDoc();
  applyUpdate(behind, u1);
  const diff = encodeDiff(a, stateVectorOf(behind));
  const patched = buildFromCompaction(encodeFullState(behind), [diff]);
  assert.equal(patched === undefined ? '' : docText(patched), 'one two three');
  assert.equal(encodeDiff(behind, stateVectorOf(behind)).length < u1.length, true);
  const rebuilt = buildFromCompaction(state, [u2]);
  assert.equal(rebuilt === undefined ? '' : docText(rebuilt), 'one two three');
  assert.equal(buildFromCompaction(Uint8Array.from([255, 255]), []), undefined);
});
