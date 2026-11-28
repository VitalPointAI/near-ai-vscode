// The tracer for the replication core (plan 30-02): two writers each sign and seal their entries, and the fold gives the same text and digest in
// every delivery order. Every later plan widens this path.
import assert from 'node:assert/strict';
import test from 'node:test';
import { entryHash, signHeader } from '../domain/replica/entry';
import type { SealedEntry, UnsignedHeader } from '../domain/replica/entry';
import { REPLICA_KINDS } from '../domain/replica/kinds';
import { foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { createWorld, epochKey, fixedSigner, permutations, updateData } from './helpers/replicaWorld';
import type { Written } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';

function tracerWorld(): { world: ReturnType<typeof createWorld>; a0: Written; a1: Written; b0: Written; b1: Written } {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', name: 'Ada', devices: ['A'] }, { member: 'mbr-bbbb', name: 'Bo', devices: ['B'] }] });
  const a = world.editor('A', PRODUCT, 101);
  const b = world.editor('B', PRODUCT, 202);
  const a0 = a.register();
  const a1 = a.insert(0, 'Hello ');
  const b0 = b.register();
  const b1 = b.insert(0, 'world');
  return { world, a0, a1, b0, b1 };
}

function productOf(result: FoldResult): ProductTextOutput {
  const products = result.families.doc as ProductTextOutput[];
  assert.equal(products.length, 1);
  return products[0];
}

const sealed = (...items: Written[]): SealedEntry[] => items.map((item) => item.entry);

test('two writers each sign and seal one doc.update, and the fold gives the same text, state vector and digest in either delivery order', () => {
  const { world, a0, a1, b0, b1 } = tracerWorld();
  const ctx = world.ctx();
  const forward = foldEntries(sealed(a0, a1, b0, b1), ctx);
  const backward = foldEntries(sealed(b1, b0, a1, a0), ctx);
  for (const result of [forward, backward]) {
    assert.deepEqual([...result.applied].sort(), [a0.hash, a1.hash, b0.hash, b1.hash].sort());
    assert.deepEqual([result.held, result.rejected, result.kept, result.refused], [[], [], [], []]);
    assert.equal(productOf(result).text, 'Hello world');
    assert.deepEqual(productOf(result).stateVector, [[101, 6], [202, 5]]);
  }
  assert.deepEqual(forward.digests, backward.digests);
  assert.equal(Object.keys(forward.digests).length, 1);
  assert.match(forward.digests[world.stream], /^[0-9a-f]{64}$/);
  assert.deepEqual(forward.order, backward.order);
});

test('every one of the 24 delivery orders of the four entries gives one text and one digest', () => {
  const { world, a0, a1, b0, b1 } = tracerWorld();
  const ctx = world.ctx();
  const reference = foldEntries(sealed(a0, a1, b0, b1), ctx);
  for (const order of permutations(sealed(a0, a1, b0, b1))) {
    const result = foldEntries(order, ctx);
    assert.deepEqual(result.digests, reference.digests);
    assert.equal(productOf(result).text, 'Hello world');
    assert.equal(result.applied.length, 4);
  }
});

test('delivering every entry twice gives the same digest and the same lists as delivering each once', () => {
  const { world, a0, a1, b0, b1 } = tracerWorld();
  const ctx = world.ctx();
  const once = foldEntries(sealed(a0, a1, b0, b1), ctx);
  const twice = foldEntries([...sealed(a0, a1, b0, b1), ...sealed(b1, a1, b0, a0)], ctx);
  assert.deepEqual(twice.digests, once.digests);
  assert.deepEqual(twice.applied, once.applied);
  assert.deepEqual([twice.held, twice.rejected, twice.kept, twice.refused], [[], [], [], []]);
});

test('an update that inserts text under a client id registered to the other writer is refused as foreign-client and changes no text', () => {
  const { world, a0, a1, b0, b1 } = tracerWorld();
  const b = world.editor('B', PRODUCT, 202);
  b.insertUpdate(0, 'world');
  const forged = world.write('A', { kind: 'doc.update', data: updateData(PRODUCT, b.insertUpdate(5, '!')), deps: [a1] });
  const ctx = world.ctx();
  const clean = foldEntries(sealed(a0, a1, b0, b1), ctx);
  const result = foldEntries(sealed(a0, a1, b0, b1, forged), ctx);
  assert.deepEqual(result.refused, [{ hash: forged.hash, reason: 'foreign-client', family: 'doc' }]);
  assert.equal(productOf(result).text, 'Hello world');
  assert.deepEqual(result.digests, clean.digests);
  assert.equal(result.applied.includes(forged.hash), false);
});

test('an entry whose epoch key the key ring does not have is held with missing-key, and under a different key it is rejected with body-unreadable', () => {
  const { world, a0 } = tracerWorld();
  const missing = foldEntries(sealed(a0), world.ctx({ keys: () => undefined }));
  assert.deepEqual(missing.held.map((held) => [held.hash, held.reason, held.stage]), [[a0.hash, 'missing-key', 'verify']]);
  assert.deepEqual([missing.applied, missing.rejected], [[], []]);
  const wrong = foldEntries(sealed(a0), world.ctx({ keys: () => epochKey('some other cell') }));
  assert.deepEqual(wrong.rejected.map((rejected) => [rejected.hash, rejected.reason]), [[a0.hash, 'body-unreadable']]);
  assert.deepEqual([wrong.applied, wrong.held], [[], []]);
});

test('a header re-signed by a different device key is rejected with bad-signature', () => {
  const { world, a0 } = tracerWorld();
  const { sig: _sig, ...unsigned } = a0.entry.header;
  const forged: SealedEntry = { header: signHeader(fixedSigner('B').signer, unsigned as UnsignedHeader), body: a0.entry.body };
  const result = foldEntries([forged], world.ctx());
  assert.deepEqual(result.rejected.map((rejected) => rejected.reason), ['bad-signature']);
  assert.deepEqual(result.applied, []);
  assert.equal(result.rejected[0].hash, entryHash(forged.header));
});

test('signing one header twice gives identical bytes, so a retried write is never mistaken for a second entry', () => {
  const { a0 } = tracerWorld();
  const { sig, ...unsigned } = a0.entry.header;
  const again = signHeader(fixedSigner('A').signer, unsigned as UnsignedHeader);
  assert.equal(again.sig, sig);
  assert.equal(entryHash(again), a0.hash);
});

test('entry format version 2: exact header keys, genesis prev for seq 0, a chained prev after it', () => {
  const { a0, a1 } = tracerWorld();
  assert.deepEqual(Object.keys(a0.entry.header).sort(), ['body', 'epoch', 'prev', 'seq', 'sig', 'stream', 'v', 'writer']);
  assert.deepEqual(Object.keys(a0.entry.header.body).sort(), ['hash', 'size']);
  assert.equal(a0.entry.header.v, 2);
  assert.equal(a0.entry.header.seq, 0);
  assert.equal(a0.entry.header.prev, '0'.repeat(64));
  assert.equal(a1.entry.header.seq, 1);
  assert.equal(a1.entry.header.prev, a0.hash);
  assert.equal(a0.hash, entryHash(a0.entry.header));
});

test('a doc.update over 16 KB travels as a sealed blob and still folds to the same text', () => {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }] });
  const a = world.editor('A', PRODUCT, 101);
  const text = 'abcdefghij'.repeat(2500);
  const register = a.register();
  const big = a.insert(0, text);
  assert.equal(world.blobs.size, 1);
  const result = foldEntries(sealed(register, big), world.ctx());
  assert.equal(productOf(result).text, text);
  const withoutBlob = foldEntries(sealed(register, big), world.ctx({ blobs: () => undefined }));
  assert.deepEqual(withoutBlob.held.map((held) => held.reason), ['missing-blob']);
  assert.equal(withoutBlob.applied.length, 1);
});

test('the closed kind list has 72 kinds', () => {
  assert.equal(REPLICA_KINDS.length, 72, 'roster.require (POST-01), hub.readmit (D-42) and session.certify (D-62), Phase 33; device.kem, 33.2 D-03; 14 roster and 2 personnel kinds of Phase 33.1; cell.access.commit');
  assert.equal(new Set(REPLICA_KINDS).size, 72, 'roster.require (POST-01), hub.readmit (D-42) and session.certify (D-62), Phase 33; device.kem, 33.2 D-03; 14 roster and 2 personnel kinds of Phase 33.1; cell.access.commit');
});
