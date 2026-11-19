// Equivocation (plan 30-05, D-12, D-32): a device that signs two histories gives one portable proof and is quarantined from the fork on every machine,
// whatever the arrival order, while every other writer carries on.
import assert from 'node:assert/strict';
import test from 'node:test';
import { entryHash } from '../domain/replica/entry';
import type { SealedEntry } from '../domain/replica/entry';
import { canonicalProof, findEquivocations, proofHash, quarantineRecords, verifyProof } from '../domain/replica/equivocation';
import { foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { forkAt } from './helpers/replicaForks';
import { createWorld, permutations, updateData } from './helpers/replicaWorld';
import type { Written } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';

interface ForkWorld {
  world: ReturnType<typeof createWorld>;
  w0: Written; w1a: Written; w1b: Written; w2: Written;
  x0: Written; x1: Written;
}

// W writes seq 0 (doc.client), seq 1 (doc.update "aa"), a clone of W writes a different seq 1 ("bb") with the same prev, W writes seq 2 on branch a.
// X writes seq 0 and seq 1 ("xx").
function forkWorld(): ForkWorld {
  const world = createWorld({ members: [{ member: 'mbr-wwww', name: 'Wren', devices: ['W'] }, { member: 'mbr-xxxx', name: 'Xia', devices: ['X'] }] });
  const w = world.editor('W', PRODUCT, 301);
  const x = world.editor('X', PRODUCT, 302);
  const w0 = w.register();
  const x0 = x.register();
  const w1a = w.insert(0, 'aa');
  const clone = world.editor('W', PRODUCT, 301);
  const w1b = forkAt(world, 'W', world.stream, 1, { kind: 'doc.update', data: updateData(PRODUCT, clone.insertUpdate(0, 'bb')) });
  const w2 = w.insert(2, 'cc');
  const x1 = x.insert(0, 'xx');
  return { world, w0, w1a, w1b, w2, x0, x1 };
}

const sealed = (...items: Written[]): SealedEntry[] => items.map((item) => item.entry);

function textOf(result: FoldResult): string {
  const products = result.families.doc as ProductTextOutput[];
  assert.equal(products.length, 1);
  return products[0].text;
}

test('a cloned device that signs two histories gives one proof and quarantine from the fork, identical under all 24 arrival orders', () => {
  const { world, w0, w1a, w1b, w2, x0, x1 } = forkWorld();
  const ctx = world.ctx();
  const writer = world.writerOf('W');
  const reference = foldEntries(sealed(w0, x0, w1a, w1b, w2, x1), ctx);
  assert.deepEqual(reference.quarantined, [{ writer, stream: world.stream, fromSeq: 1 }]);
  assert.equal(reference.proofs.length, 1);
  assert.equal(verifyProof(reference.proofs[0]), true);
  assert.deepEqual(reference.excluded, [w1a.hash, w1b.hash, w2.hash].sort());
  assert.deepEqual([...reference.applied].sort(), [w0.hash, x0.hash, x1.hash].sort());
  assert.deepEqual([reference.held, reference.rejected, reference.kept, reference.refused], [[], [], [], []]);
  assert.equal(textOf(reference), 'xx');

  let count = 0;
  for (const order of permutations(sealed(w1a, w1b, w2, x1))) {
    count += 1;
    const result = foldEntries([...sealed(w0, x0), ...order], ctx);
    assert.deepEqual(result.quarantined, reference.quarantined);
    assert.deepEqual(result.proofs, reference.proofs);
    assert.deepEqual(result.excluded, reference.excluded);
    assert.deepEqual([...result.applied].sort(), [...reference.applied].sort());
    assert.equal(textOf(result), 'xx');
    assert.deepEqual(result.digests, reference.digests);
    assert.deepEqual(result.order, reference.order);
  }
  assert.equal(count, 24);
});

test('the proof is the two lowest entry hashes sorted, checks with no roster, and a machine holding both branches finds the same one', () => {
  const forked = forkWorld();
  const found = foldEntries(forked.world.entries, forked.world.ctx()).proofs;
  assert.equal(found.length, 1);
  const hashes = [forked.w1a.hash, forked.w1b.hash].sort();
  assert.deepEqual([entryHash(found[0].a), entryHash(found[0].b)], hashes);
  assert.equal(found[0].publicKey, forked.world.signerOf('W').publicKey);
  assert.equal(verifyProof(JSON.parse(JSON.stringify(found[0]))), true, 'a proof survives JSON and needs nothing else');
  assert.equal(proofHash(found[0]), proofHash(canonicalProof(found[0].b, found[0].a, found[0].publicKey)), 'the order of the pair does not change its hash');
});

test('verifyProof is false for a swapped header, equal headers, a key that is not the writer, an altered header, and anything that is not a proof', () => {
  const { world, w1a, w1b, x1 } = forkWorld();
  const [headerA, headerB] = [w1a.entry.header, w1b.entry.header];
  const key = world.signerOf('W').publicKey;
  assert.equal(verifyProof(canonicalProof(headerA, headerB, key)), true);
  assert.equal(verifyProof(canonicalProof(headerA, x1.entry.header, key)), false, 'a header of another writer');
  assert.equal(verifyProof({ a: headerA, b: headerA, publicKey: key }), false, 'both headers equal');
  assert.equal(verifyProof(canonicalProof(headerA, headerB, world.signerOf('X').publicKey)), false, 'the key does not hash to the writer');
  assert.equal(verifyProof(canonicalProof(headerA, { ...headerB, epoch: 9 }, key)), false, 'a header altered after signing');
  assert.equal(verifyProof({ a: headerA, b: { ...headerB, seq: 2 }, publicKey: key }), false, 'different seq');
  assert.equal(verifyProof({ a: headerA, b: { ...headerB, stream: 'f'.repeat(32) }, publicKey: key }), false, 'different stream');
  for (const junk of [null, undefined, 'x', 5, [], {}, { a: headerA }, { a: headerA, b: headerB, publicKey: key, extra: 1 }, { a: 1, b: 2, publicKey: key }]) {
    assert.equal(verifyProof(junk), false);
  }
});

test('findEquivocations and quarantineRecords: two forks of one writer in one stream give two proofs and one record at the lowest fork seq', () => {
  const { world, w1a, w1b, w2 } = forkWorld();
  // A second fork at seq 2: branch a has w2; the clone adds a different seq 2 on branch b.
  const second = forkAt(world, 'W', world.stream, 2, { kind: 'doc.update', data: updateData(PRODUCT, world.editor('W', PRODUCT, 301).insertUpdate(0, 'dd')) });
  const verifiedLike = [w1a, w1b, w2, second].map((item) => ({ hash: item.hash, header: item.entry.header }));
  const proofs = findEquivocations(verifiedLike, world.ctx().roster);
  assert.equal(proofs.length, 2);
  assert.deepEqual(quarantineRecords(proofs, world.ctx().roster), [{ writer: world.writerOf('W'), stream: world.stream, fromSeq: 1 }]);
});
