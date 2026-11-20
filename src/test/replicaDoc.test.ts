// The ownership and compaction rules of co-edited text (plan 30-06, D-18, D-19, D-21, D-35, D-37): a hostile update cannot forge attribution, crash
// the fold, or make the text depend on the order updates were applied in, and a compaction is a cache that is checked against the log.
import assert from 'node:assert/strict';
import test from 'node:test';
import { UNATTRIBUTED_WRITER, summariseAuthors } from '../domain/replica/attribution';
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
  return createWorld({ members: [{ member: 'mbr-wwww', name: 'Wen', devices: ['W'], agentSeats: ['j2-analyst'] }, { member: 'mbr-qqqq', name: 'Quinn', devices: ['Q'] }, { member: 'mbr-xxxx', name: 'Xi', devices: ['X'] }] });
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

// ---- Task 3: compaction as a verified cache -------------------------------------------------------------------------------------------------

interface Scene {
  world: World;
  regA: Written; regB: Written; regC: Written;
  updA: Written; updB: Written;
  merged: Uint8Array;
  text: string;
}

// A and B each register and type, B after seeing A. C registers and later writes the compaction.
function compactScene(): Scene {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }, { member: 'mbr-bbbb', devices: ['B'] }, { member: 'mbr-cccc', devices: ['C'] }] });
  const a = world.editor('A', PRODUCT, 11);
  const b = world.editor('B', PRODUCT, 22);
  const c = world.editor('C', PRODUCT, 33);
  const regC = c.register();
  const regA = a.register();
  const regB = b.register();
  const updA = a.insert(0, 'alpha ');
  applyRemote(b.doc, encodeFullState(a.doc));
  const updB = b.insert(6, 'beta');
  const fold = createFoldDoc();
  applyUpdate(fold, encodeFullState(a.doc));
  applyUpdate(fold, encodeFullState(b.doc));
  return { world, regA, regB, regC, updA, updB, merged: encodeFullState(fold), text: docText(fold) };
}

function dep(item: Written): Dep {
  return { writer: item.writer, seq: item.seq, hash: item.hash };
}

interface CompactOptions { textHash?: string; blobState?: Uint8Array; withDeps?: boolean; stateVector?: Array<[number, number]>; blobText?: string; covers?: Dep[]; writer?: string; deps?: Written[] }

// Each compaction needs its own scene: the writer's chain would otherwise make a second one wait for the first.
function sceneWith(options: CompactOptions = {}): { scene: Scene; entry: Written } {
  const scene = compactScene();
  return { scene, entry: compaction(scene, options) };
}

// A doc.compact entry written by C. With its covered heads as dependencies it sorts after them (a verified compaction); without, it can be
// held by a joiner that does not have them (a provisional one).
function compaction(scene: Scene, options: CompactOptions = {}): Written {
  const { world } = scene;
  const doc = createFoldDoc();
  applyUpdate(doc, scene.merged);
  const blob = sealBlob(world.keyFor(world.stream, 0), world.stream, 0, Buffer.from(options.blobState ?? scene.merged));
  world.blobs.set(blob.hash, blob);
  const covers = options.covers ?? [dep(scene.updA), dep(scene.updB)];
  return world.write(options.writer ?? 'C', {
    kind: 'doc.compact',
    deps: options.withDeps === false ? [] : options.deps ?? [scene.updA, scene.updB],
    data: { product: PRODUCT, covers, stateVector: options.stateVector ?? stateVectorOf(doc), textHash: options.textHash ?? textHashOf(options.blobText ?? scene.text), stateBlob: blob.hash }
  });
}

test('the doc.compact schema checks its fields and refuses more than 64 covers, an unsorted state vector and a bad hash', () => {
  const good = { product: PRODUCT, covers: [], stateVector: [[11, 6], [22, 4]], textHash: 'a'.repeat(64), stateBlob: 'b'.repeat(64) };
  assert.equal(validateDocData('doc.compact', good, 'data'), undefined);
  const covers = Array.from({ length: 65 }, (_, index) => ({ writer: 'c'.repeat(64), seq: index, hash: 'd'.repeat(64) }));
  for (const bad of [{ ...good, covers }, { ...good, stateVector: [[22, 4], [11, 6]] }, { ...good, stateVector: [[11, -1]] }, { ...good, textHash: 'xyz' }, { ...good, extra: 1 }, { ...good, stateBlob: 5 }]) {
    assert.match(validateDocData('doc.compact', bad, 'data') ?? '', /^bad-data/);
  }
  assert.doesNotMatch(validateDocData('doc.compact', good, 'data') ?? '', /schema not yet defined/);
});

test('a compaction whose covered updates are all present and match is recorded verified, changes neither text nor digest, and removes no update', () => {
  const scene = compactScene();
  const base = [scene.regC, scene.regA, scene.regB, scene.updA, scene.updB];
  const without = foldEntries(sealed(base), scene.world.ctx());
  const entry = compaction(scene);
  const withCompaction = foldEntries(sealed([...base, entry]), scene.world.ctx());
  assert.deepEqual([withCompaction.held, withCompaction.refused, withCompaction.rejected], [[], [], []]);
  const product = productOf(withCompaction);
  assert.deepEqual(product.compactions, [{ entry: entry.hash, verified: true }]);
  assert.equal(product.text, scene.text);
  assert.deepEqual(withCompaction.digests, without.digests);
  assert.deepEqual(product.accepted.slice().sort(), [scene.updA.hash, scene.updB.hash].sort());
  assert.deepEqual(product.attribution, productOf(without).attribution);
});

test('a compaction with a wrong text hash, a wrong state vector, or a blob that holds different text is refused compact-mismatch', () => {
  const other = createLocalDoc(11);
  localInsert(other, 0, 'something else');
  const otherFold = createFoldDoc();
  applyUpdate(otherFold, encodeFullState(other));
  const cases: CompactOptions[] = [{ textHash: textHashOf('not the text') }, { stateVector: [[11, 6]] }, { blobState: encodeFullState(otherFold) }];
  for (const options of cases) {
    const { scene, entry } = sceneWith(options);
    const base = [scene.regC, scene.regA, scene.regB, scene.updA, scene.updB];
    const result = foldEntries(sealed([...base, entry]), scene.world.ctx());
    assert.deepEqual(reasons(result), [[entry.hash, 'compact-mismatch']]);
    const product = productOf(result);
    assert.deepEqual(product.compactions, []);
    assert.equal(product.text, scene.text);
  }
});

test('a set with the registrations and a compaction but none of the covered updates loads the compaction provisionally, marked unverified', () => {
  const scene = compactScene();
  const entry = compaction(scene, { withDeps: false });
  const joiner = foldEntries(sealed([scene.regC, scene.regA, scene.regB, entry]), scene.world.ctx());
  assert.deepEqual([joiner.held, joiner.refused, joiner.rejected], [[], [], []]);
  const product = productOf(joiner);
  assert.equal(product.text, scene.text);
  assert.deepEqual(product.compactions, [{ entry: entry.hash, verified: false }]);
  assert.deepEqual(product.accepted, []);
  const full = foldEntries(sealed([scene.regC, scene.regA, scene.regB, scene.updA, scene.updB]), scene.world.ctx());
  assert.deepEqual(product.stateVector, productOf(full).stateVector);
  // CR-01: the text and its places are the full log's, but no accepted update backs it, so nobody is named as its author. Every span is flagged
  // unverified and carries no writer, even though the client ids are registered to A and B.
  assert.deepEqual(product.attribution.map((span) => [span.start, span.length, span.clientId]), productOf(full).attribution.map((span) => [span.start, span.length, span.clientId]));
  assert.ok(product.attribution.length > 0);
  for (const span of product.attribution) assert.deepEqual([span.writer, span.member, span.unverified], [UNATTRIBUTED_WRITER, '', true]);
  assert.equal(product.incomplete, false);
  // Once the updates the compaction covers are in the set the text is proven and the attribution is the full log's, with nothing unverified.
  const withLog = foldEntries(sealed([scene.regC, scene.regA, scene.regB, scene.updA, scene.updB, entry]), scene.world.ctx());
  assert.deepEqual(productOf(withLog).attribution, productOf(full).attribution);
});

test('a compaction holding a struct whose client has no registration is refused compact-unregistered-client, and a lost blob is held', () => {
  const scene = compactScene();
  const entry = compaction(scene, { withDeps: false });
  const result = foldEntries(sealed([scene.regC, scene.regA, entry]), scene.world.ctx());
  assert.deepEqual(reasons(result), [[entry.hash, 'compact-unregistered-client']]);
  assert.equal(productOf(result).text, '');
  const noBlob = foldEntries(sealed([scene.regC, scene.regA, scene.regB, entry]), scene.world.ctx({ blobs: () => undefined }));
  assert.deepEqual(noBlob.held.map((item) => item.reason), ['missing-blob']);
});

test('loading the newest compaction plus later updates gives the same text, state vector and attribution as the full log, over random histories', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const random = rng(seed);
    const docs = [11, 22, 33, 44].map((client) => createLocalDoc(client));
    const updates: Uint8Array[] = [];
    for (let step = 0; step < 30; step += 1) {
      const doc = random.pick(docs);
      if (random.chance(0.3)) {
        applyRemote(doc, encodeFullState(random.pick(docs)));
        continue;
      }
      const length = docText(doc).length;
      updates.push(length > 3 && random.chance(0.3) ? localDelete(doc, random.int(length - 2), 1 + random.int(2)) : localInsert(doc, random.int(length + 1), `w${random.int(100)} `));
    }
    const midpoint = Math.floor(updates.length / 2);
    const head = createFoldDoc();
    for (const update of updates.slice(0, midpoint)) applyUpdate(head, update);
    const full = createFoldDoc();
    for (const update of updates) applyUpdate(full, update);
    const loaded = buildFromCompaction(encodeFullState(head), updates.slice(midpoint));
    assert.ok(loaded !== undefined, `seed ${seed}`);
    assert.equal(docText(loaded), docText(full), `seed ${seed}: text`);
    assert.deepEqual(stateVectorOf(loaded), stateVectorOf(full), `seed ${seed}: state vector`);
    assert.deepEqual(attributionRuns(loaded), attributionRuns(full), `seed ${seed}: attribution`);
    assert.equal(pendingState(loaded), false);
  }
});

test('a late joiner loading the compaction in a fold gets the full text, and a hostile compaction under a registered client is unverified until the log can check it', () => {
  const forged = createLocalDoc(11);
  localInsert(forged, 0, 'forged under client eleven');
  const forgedFold = createFoldDoc();
  applyUpdate(forgedFold, encodeFullState(forged));
  const { scene, entry: hostile } = sceneWith({ withDeps: false, blobState: encodeFullState(forgedFold), blobText: docText(forgedFold), stateVector: stateVectorOf(forgedFold) });
  const result = foldEntries(sealed([scene.regC, scene.regA, scene.regB, hostile]), scene.world.ctx());
  assert.deepEqual(productOf(result).compactions, [{ entry: hostile.hash, verified: false }]);
  assert.notEqual(productOf(result).text, scene.text);
  // Once the real updates are in the set, the same hostile compaction is checked against them and refused, and the text is the log's.
  const checked = foldEntries(sealed([scene.regC, scene.regA, scene.regB, scene.updA, scene.updB, hostile]), scene.world.ctx());
  assert.deepEqual(reasons(checked), [[hostile.hash, 'compact-mismatch']]);
  assert.equal(productOf(checked).text, scene.text);
  assert.deepEqual(productOf(checked).compactions, []);
});

// ---- CR-01: a provisional compaction cannot speak for another device ----------------------------------------------------------------------------

// A full state holding what the given client typed, as the blob of a compaction.
function stateOf(client: number, inserts: Array<[number, string]>): { blobState: Uint8Array; blobText: string; stateVector: Array<[number, number]> } {
  const local = createLocalDoc(client);
  for (const [index, text] of inserts) localInsert(local, index, text);
  const folded = createFoldDoc();
  applyUpdate(folded, encodeFullState(local));
  return { blobState: encodeFullState(folded), blobText: docText(folded), stateVector: stateVectorOf(folded) };
}

test('CR-01: text a provisional compaction holds under another device\'s client id is never attributed to that device, whatever cover hash the compactor names', () => {
  const scene = compactScene();
  const writerA = scene.world.writerOf('A');
  const ghost: Dep = { writer: writerA, seq: 99, hash: 'e'.repeat(64) };
  // Device C writes "FORGED under A" under A's registered client id 11, citing a cover entry this machine does not hold.
  const hostile = compaction(scene, { withDeps: false, covers: [ghost], ...stateOf(11, [[0, 'FORGED under A']]) });
  const result = foldEntries(sealed([scene.regC, scene.regA, scene.regB, hostile]), scene.world.ctx());
  assert.deepEqual([result.held, result.refused, result.rejected], [[], [], []]);
  const product = productOf(result);
  assert.deepEqual(product.compactions, [{ entry: hostile.hash, verified: false }]);
  assert.equal(product.text, 'FORGED under A');
  assert.ok(product.attribution.length > 0);
  for (const span of product.attribution) assert.deepEqual([span.writer, span.member, span.actor, span.unverified], [UNATTRIBUTED_WRITER, '', 'person', true]);
  assert.equal(summariseAuthors(product.attribution).some((row) => row.writer === writerA || row.member === 'mbr-aaaa'), false);
  assert.deepEqual(summariseAuthors(product.attribution).map((row) => [row.writer, row.unverified, row.characters]), [[UNATTRIBUTED_WRITER, true, 14]]);
});

test('CR-01: the log\'s own text keeps its author next to unverified text, the split falls exactly where the accepted updates end, and unverified text of the compactor\'s own client is shown as the compactor\'s', () => {
  const scene = compactScene();
  const writerA = scene.world.writerOf('A');
  const writerC = scene.world.writerOf('C');
  const ghost: Dep = { writer: writerA, seq: 99, hash: 'e'.repeat(64) };
  // A really typed "alpha " (clocks 0 to 5 of client 11). C's compaction repeats it and adds "FORGED" after it under client 11.
  const hostile = compaction(scene, { withDeps: false, covers: [ghost], ...stateOf(11, [[0, 'alpha '], [6, 'FORGED']]) });
  const mixed = productOf(foldEntries(sealed([scene.regC, scene.regA, scene.regB, scene.updA, hostile]), scene.world.ctx()));
  assert.equal(mixed.text, 'alpha FORGED');
  assert.deepEqual(mixed.attribution.map((span) => [span.start, span.length, span.writer, span.unverified]), [[0, 6, writerA, undefined], [6, 6, UNATTRIBUTED_WRITER, true]]);
  // The same fold in any delivery order says the same thing.
  const reversed = productOf(foldEntries(sealed([hostile, scene.updA, scene.regB, scene.regA, scene.regC]), scene.world.ctx()));
  assert.deepEqual(reversed.attribution, mixed.attribution);
  // Text under the compactor's own client id is its own word: attributed to C, but still flagged because no accepted update backs it.
  const second = compactScene();
  const own = compaction(second, { withDeps: false, covers: [ghost], ...stateOf(33, [[0, 'my own words']]) });
  const ownProduct = productOf(foldEntries(sealed([second.regC, second.regA, second.regB, own]), second.world.ctx()));
  assert.deepEqual(ownProduct.attribution.map((span) => [span.writer, span.member, span.unverified]), [[writerC, 'mbr-cccc', true]]);
});

// ---- WR-04 (D-01 (a)): one refused or held update in the covered history no longer switches compaction off ------------------------------------

// C writes an update the fold does not accept, inside the history an honest compaction by B covers.
function coveredRejectScene(kind: 'refused' | 'held'): { scene: Scene; bad: Written; base: Written[] } {
  const scene = compactScene();
  // Refused: text under A's registered client id 11 (foreign-client). Held: text under client 77, which nobody registered (unregistered-client).
  const stranger = createLocalDoc(kind === 'refused' ? 11 : 77);
  const bad = scene.world.write('C', { kind: 'doc.update', data: updateData(PRODUCT, localInsert(stranger, 0, 'not accepted')) });
  return { scene, bad, base: [scene.regC, scene.regA, scene.regB, scene.updA, scene.updB, bad] };
}

const coveringAll = (scene: Scene, bad: Written): CompactOptions => ({ writer: 'B', deps: [scene.updA, scene.updB, bad], covers: [dep(scene.updA), dep(scene.updB), dep(bad)] });

test('WR-04: an honest compaction whose covered history holds a refused foreign-client update is accepted as verified, and its text is the fold\'s', () => {
  const { scene, bad, base } = coveredRejectScene('refused');
  const entry = compaction(scene, coveringAll(scene, bad));
  const result = foldEntries(sealed([...base, entry]), scene.world.ctx());
  assert.deepEqual(reasons(result), [[bad.hash, 'foreign-client']]);
  const product = productOf(result);
  assert.deepEqual(product.compactions, [{ entry: entry.hash, verified: true }]);
  assert.equal(product.text, scene.text);
  const without = foldEntries(sealed(base), scene.world.ctx());
  assert.deepEqual(result.digests, without.digests);
});

test('WR-04: a held covered update is ignored the same way as a refused one when the vector and text hash match', () => {
  const { scene, bad, base } = coveredRejectScene('held');
  const entry = compaction(scene, coveringAll(scene, bad));
  const result = foldEntries(sealed([...base, entry]), scene.world.ctx());
  assert.deepEqual(result.held.map((item) => [item.hash, item.reason]), [[bad.hash, 'unregistered-client']]);
  assert.deepEqual(result.refused, []);
  assert.deepEqual(productOf(result).compactions, [{ entry: entry.hash, verified: true }]);
  assert.equal(productOf(result).text, scene.text);
});

test('WR-04: a compaction that leaves out an accepted covered update is still refused compact-mismatch next to a refused one', () => {
  const { scene, bad, base } = coveredRejectScene('refused');
  // The blob holds only A's text, but the covers name B's accepted update too.
  const entry = compaction(scene, { ...coveringAll(scene, bad), ...stateOf(11, [[0, 'alpha ']]) });
  const result = foldEntries(sealed([...base, entry]), scene.world.ctx());
  assert.deepEqual(reasons(result), [[bad.hash, 'foreign-client'], [entry.hash, 'compact-mismatch']].sort());
  assert.deepEqual(productOf(result).compactions, []);
  assert.equal(productOf(result).text, scene.text);
});

test('WR-04: with a refused update covered, a wrong text hash or a wrong state vector is still refused compact-mismatch', () => {
  for (const wrong of [{ textHash: textHashOf('not the text') }, { stateVector: [[11, 6]] as Array<[number, number]> }]) {
    const { scene, bad, base } = coveredRejectScene('refused');
    const entry = compaction(scene, { ...coveringAll(scene, bad), ...wrong });
    const result = foldEntries(sealed([...base, entry]), scene.world.ctx());
    assert.deepEqual(reasons(result), [[bad.hash, 'foreign-client'], [entry.hash, 'compact-mismatch']].sort());
    assert.deepEqual(productOf(result).compactions, []);
  }
});

// ---- WR-02 (client part): an agent registration needs the seat --------------------------------------------------------------------------------

const ANALYST: Actor = { kind: 'agent', member: 'j2-analyst', run: 'r-7' };

test('WR-02: an agent registration is refused agent-seat-not-allowed unless the roster lets the device\'s member run that seat, and a view that cannot answer denies', () => {
  const world = twoWriters();
  // Xi holds no seat; Wen holds j2-analyst but not j2-chief.
  const x = world.editor('X', PRODUCT, 51);
  const byX = x.register({ actor: ANALYST });
  const typedX = x.insert(0, 'agent text', { actor: ANALYST });
  const otherSeat = world.editor('W', PRODUCT, 32).register({ actor: { kind: 'agent', member: 'j2-chief', run: 'r-8' } });
  const byW = world.editor('W', PRODUCT, 31).register({ actor: ANALYST });
  const result = foldEntries(sealed([byX, typedX, otherSeat, byW]), world.ctx());
  assert.deepEqual(reasons(result), [[byX.hash, 'agent-seat-not-allowed'], [otherSeat.hash, 'agent-seat-not-allowed']].sort());
  assert.deepEqual(result.held.map((item) => [item.hash, item.reason]), [[typedX.hash, 'unregistered-client']]);
  assert.deepEqual(productOf(result).registrations.map((registration) => [registration.clientId, registration.member]), [[31, 'mbr-wwww']]);
  // Default deny: a roster view without canRunAgent allows no agent registration, and a person registration is unaffected.
  const roster = Object.assign({}, world.ctx().roster, { canRunAgent: undefined });
  const person = world.editor('W', PRODUCT, 33).register();
  const blind = foldEntries(sealed([byX, typedX, otherSeat, byW, person]), world.ctx({ roster }));
  assert.deepEqual(reasons(blind), [byX, otherSeat, byW].map((item): [string, string] => [item.hash, 'agent-seat-not-allowed']).sort());
  assert.deepEqual(blind.applied, [person.hash]);
});

test('WR-02: text typed under an allowed agent registration is attributed to the device\'s member with the agent seat and run', () => {
  const world = twoWriters();
  const w = world.editor('W', PRODUCT, 31);
  const register = w.register({ actor: ANALYST });
  const typed = w.insert(0, 'assessment', { actor: ANALYST });
  const result = foldEntries(sealed([register, typed]), world.ctx());
  assert.deepEqual([result.refused, result.held], [[], []]);
  assert.deepEqual(productOf(result).attribution, [{ start: 0, length: 10, clientId: 31, writer: world.writerOf('W'), member: 'mbr-wwww', actor: 'agent', agentMember: 'j2-analyst', run: 'r-7' }]);
});
