// Equivocation (plan 30-05, D-12, D-32): a device that signs two histories gives one portable proof and is quarantined from the fork on every machine,
// whatever the arrival order, while every other writer carries on.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GENESIS_PREV, buildEntry, entryHash, signHeader } from '../domain/replica/entry';
import type { SealedEntry } from '../domain/replica/entry';
import { canonicalBytes } from '../domain/team/canonical';
import { canonicalProof, findEquivocations, forkChosen, parseProof, proofHash, quarantineRecords, verifyProof } from '../domain/replica/equivocation';
import { foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { staticRosterView } from '../domain/replica/rosterView';
import { integrityReducer } from '../domain/replica/integrityFold';
import type { IntegrityOutput } from '../domain/replica/integrityFold';
import { textReducer } from '../domain/replica/textFold';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { forkAt, resealAt } from './helpers/replicaForks';
import { createWorld, epochKey, fixedSigner, permutations, streamId, updateData } from './helpers/replicaWorld';
import type { Editor, Written } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';

interface ForkWorld {
  world: ReturnType<typeof createWorld>;
  w0: Written; w1a: Written; w1b: Written; w2: Written;
  x0: Written; x1: Written;
  x: Editor;
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
  return { world, w0, w1a, w1b, w2, x0, x1, x };
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

test('a roster choice of one branch (device.release) admits that branch and its descendants again, keeps the other excluded and lifts the quarantine', () => {
  const { world, w0, w1a, w1b, w2, x0, x1 } = forkWorld();
  const writer = world.writerOf('W');
  const roster = staticRosterView({ ...world.rosterSpec, chosenBranches: [{ writer, stream: world.stream, seq: 1, hash: w1a.hash }] });
  const chosenA = foldEntries(world.entries, world.ctx({ roster }));
  assert.deepEqual(chosenA.quarantined, []);
  assert.equal(chosenA.proofs.length, 1, 'the proof of the fork is still there');
  assert.deepEqual(chosenA.excluded, [w1b.hash]);
  assert.deepEqual([...chosenA.applied].sort(), [w0.hash, w1a.hash, w2.hash, x0.hash, x1.hash].sort());
  assert.match(textOf(chosenA), /aa/);
  assert.doesNotMatch(textOf(chosenA), /bb/);

  const rosterB = staticRosterView({ ...world.rosterSpec, chosenBranches: [{ writer, stream: world.stream, seq: 1, hash: w1b.hash }] });
  const chosenB = foldEntries(world.entries, world.ctx({ roster: rosterB }));
  assert.deepEqual(chosenB.excluded, [w1a.hash, w2.hash].sort(), 'branch b has no descendants here, and W2 follows branch a');
  assert.match(textOf(chosenB), /bb/);

  // A choice naming something that is not one of the two branches resolves nothing.
  const bogus = staticRosterView({ ...world.rosterSpec, chosenBranches: [{ writer, stream: world.stream, seq: 1, hash: 'e'.repeat(64) }] });
  assert.deepEqual(foldEntries(world.entries, world.ctx({ roster: bogus })).quarantined, [{ writer, stream: world.stream, fromSeq: 1 }]);
});

test('signing the same header again after a crash gives the same entry and no proof; sealing the same body again at the same seq is a fork', () => {
  const { world, w0, w1a, x0 } = forkWorld();
  const { sig: _sig, ...unsigned } = w1a.entry.header;
  const resigned = signHeader(world.signerOf('W').signer, unsigned);
  assert.deepEqual(resigned, w1a.entry.header);
  assert.equal(entryHash(resigned), w1a.hash);
  const retry = foldEntries([w0.entry, x0.entry, w1a.entry, { header: resigned, body: w1a.entry.body }], world.ctx());
  assert.deepEqual([retry.proofs, retry.quarantined, retry.excluded], [[], [], []]);
  assert.equal(retry.applied.length, 3);

  const resealed = resealAt(world, 'W', w1a.entry);
  assert.notEqual(resealed.hash, w1a.hash);
  assert.notEqual(resealed.entry.header.body.hash, w1a.entry.header.body.hash, 'a new IV gives a new ciphertext');
  assert.equal(resealed.entry.header.seq, w1a.entry.header.seq);
  const forked = foldEntries([w0.entry, x0.entry, w1a.entry, resealed.entry], world.ctx());
  assert.equal(forked.proofs.length, 1);
  assert.equal(verifyProof(forked.proofs[0]), true);
  assert.deepEqual(forked.quarantined, [{ writer: world.writerOf('W'), stream: world.stream, fromSeq: 1 }]);
  assert.deepEqual(forked.excluded, [w1a.hash, resealed.hash].sort());
});

test('another writer\'s entry that cites an excluded entry is still applied, so one forked device never stalls the project', () => {
  const { world, w1b, x } = forkWorld();
  const citing = x.insert(2, 'yy', { deps: [w1b] });
  const result = foldEntries(world.entries, world.ctx());
  assert.equal(result.applied.includes(citing.hash), true);
  assert.equal(result.excluded.includes(w1b.hash), true);
  assert.deepEqual(result.held, []);
  assert.match(textOf(result), /yy/);
});

test('exclusion reaches other streams only for entries that follow a forked entry: an earlier entry of the same writer there still stands', () => {
  const { world, w0, w1b, x0 } = forkWorld();
  const other = streamId('second');
  const before = world.write('W', { stream: other, kind: 'doc.client', data: { product: PRODUCT, clientId: 701, actor: { kind: 'person' } } });
  const following = world.write('W', { stream: other, kind: 'doc.client', data: { product: PRODUCT, clientId: 702, actor: { kind: 'person' } }, deps: [w1b] });
  const later = world.write('W', { stream: other, kind: 'doc.client', data: { product: PRODUCT, clientId: 703, actor: { kind: 'person' } } });
  const unrelated = world.write('X', { stream: other, kind: 'doc.client', data: { product: PRODUCT, clientId: 704, actor: { kind: 'person' } }, deps: [following] });
  const result = foldEntries(world.entries, world.ctx());
  assert.equal(result.applied.includes(before.hash), true);
  assert.equal(result.applied.includes(w0.hash), true);
  assert.equal(result.applied.includes(x0.hash), true);
  assert.equal(result.excluded.includes(following.hash), true);
  assert.equal(result.excluded.includes(later.hash), true, 'it follows the excluded entry in its own log');
  assert.equal(result.applied.includes(unrelated.hash), true, 'another writer\'s entry citing an excluded one stands');
  assert.deepEqual(result.quarantined, [{ writer: world.writerOf('W'), stream: world.stream, fromSeq: 1 }], 'the quarantine record names the forked stream only');
  assert.equal(Object.keys(result.digests).length, 2);
});

const REDUCERS = { reducers: [textReducer, integrityReducer] };
const integrityOf = (result: FoldResult): IntegrityOutput => result.families.integrity as IntegrityOutput;

// The machine M of the tracer: it holds W0, W1a, W2 and X's entries but never saw W1b. X, who did, writes the proof as an entry.
function proofWorld(): ForkWorld & { proofEntry: Written; machine: SealedEntry[] } {
  const forked = forkWorld();
  const found = foldEntries(forked.world.entries, forked.world.ctx()).proofs[0];
  const proofEntry = forked.world.write('X', { kind: 'equivocation.proof', data: found });
  return { ...forked, proofEntry, machine: sealed(forked.w0, forked.x0, forked.x1, forked.w1a, forked.w2) };
}

test('a proof sent as an entry quarantines the forked device on a machine that holds only one branch; without it that machine applies both entries', () => {
  const { world, w0, w1a, w2, x0, x1, proofEntry, machine } = proofWorld();
  const ctx = world.ctx();
  const without = foldEntries(machine, ctx, REDUCERS);
  assert.deepEqual(without.quarantined, []);
  assert.deepEqual(without.proofs, []);
  assert.deepEqual([...without.applied].sort(), [w0.hash, w1a.hash, w2.hash, x0.hash, x1.hash].sort());

  const withProof = foldEntries([...machine, proofEntry.entry], ctx, REDUCERS);
  assert.deepEqual(withProof.quarantined, [{ writer: world.writerOf('W'), stream: world.stream, fromSeq: 1 }]);
  assert.equal(withProof.proofs.length, 1);
  assert.equal(verifyProof(withProof.proofs[0]), true);
  assert.deepEqual(withProof.excluded, [w1a.hash, w2.hash].sort());
  assert.deepEqual([...withProof.applied].sort(), [w0.hash, x0.hash, x1.hash, proofEntry.hash].sort());
  assert.equal(textOf(withProof), 'xx');
  assert.equal(integrityOf(withProof).length, 1);
  assert.equal(integrityOf(withProof)[0].proofs.length, 1);
  // The same machine, now holding both branches, reaches the same quarantine and the same digest.
  const everything = foldEntries(world.entries, ctx, REDUCERS);
  assert.deepEqual(everything.quarantined, withProof.quarantined);
  assert.deepEqual(everything.digests, withProof.digests);
});

test('a proof with a header altered, or signed by a key the roster does not know, is refused invalid-proof and quarantines nothing', () => {
  const { world, w0, w1a, w1b, w2, x0, x1 } = forkWorld();
  const machine = sealed(w0, x0, x1, w1a, w2);
  const key = world.signerOf('W').publicKey;
  const altered = world.write('X', { kind: 'equivocation.proof', data: { ...canonicalProof(w1a.entry.header, w1b.entry.header, key), a: { ...w1a.entry.header, epoch: 9 } } });

  // A stranger forks its own key. The pair checks out alone, but the project does not know that device.
  const stranger = fixedSigner('stranger');
  const forkedBy = (text: string): SealedEntry['header'] => buildEntry({
    signer: stranger.signer, key: epochKey('stranger'), stream: world.stream, seq: 0, prev: GENESIS_PREV, epoch: 0,
    body: { deps: [], roster: world.rosterHash, lamport: 1, at: '2026-11-19T11:00:00.000Z', actor: { kind: 'person' }, kind: 'doc.client', data: { product: PRODUCT, clientId: 900 + text.length, actor: { kind: 'person' } } }
  }).entry.header;
  const pair = canonicalProof(forkedBy('a'), forkedBy('bb'), stranger.publicKey);
  assert.equal(verifyProof(pair), true, 'it is a real fork of a real key');
  const unknown = world.write('X', { kind: 'equivocation.proof', data: pair });

  const result = foldEntries([...machine, altered.entry, unknown.entry], world.ctx(), REDUCERS);
  assert.deepEqual(result.refused.map((record) => record.reason), ['invalid-proof', 'invalid-proof']);
  assert.deepEqual(result.refused.map((record) => record.hash).sort(), [altered.hash, unknown.hash].sort());
  assert.deepEqual([result.quarantined, result.proofs, result.excluded], [[], [], []]);
  assert.equal(result.applied.includes(w1a.hash) && result.applied.includes(w2.hash), true);
  assert.equal(integrityOf(result).length, 0);
});

test('a digest.report entry is applied and listed in families.integrity for its stream; a malformed report is rejected by the schema', () => {
  const { world, w0, x0, x1 } = forkWorld();
  const report = world.write('X', { kind: 'digest.report', data: { stream: world.stream, heads: [{ writer: w0.writer, seq: 0, hash: w0.hash }], digest: 'a'.repeat(64) } });
  const withCheckpoint = world.write('X', { kind: 'digest.report', data: { stream: world.stream, heads: [], digest: 'b'.repeat(64), checkpoint: 'c'.repeat(64) } });
  const result = foldEntries([w0.entry, x0.entry, x1.entry, report.entry, withCheckpoint.entry], world.ctx(), REDUCERS);
  assert.deepEqual([...result.applied].sort(), [w0.hash, x0.hash, x1.hash, report.hash, withCheckpoint.hash].sort());
  const rows = integrityOf(result);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stream, world.stream);
  assert.deepEqual(rows[0].reports.map((entry) => entry.entry).sort(), [report.hash, withCheckpoint.hash].sort());
  assert.equal(rows[0].reports.find((entry) => entry.entry === withCheckpoint.hash)?.checkpoint, 'c'.repeat(64));

  const tooMany = world.write('X', { kind: 'digest.report', data: { stream: world.stream, heads: Array.from({ length: 65 }, () => ({ writer: w0.writer, seq: 0, hash: w0.hash })), digest: 'a'.repeat(64) } });
  const badDigest = world.write('X', { kind: 'digest.report', data: { stream: world.stream, heads: [], digest: 'zz' } });
  const extra = world.write('X', { kind: 'digest.report', data: { stream: world.stream, heads: [], digest: 'a'.repeat(64), note: 'x' } });
  const bad = foldEntries([w0.entry, x0.entry, tooMany.entry, badDigest.entry, extra.entry], world.ctx(), REDUCERS);
  assert.deepEqual(bad.rejected.map((record) => record.reason), ['bad-data', 'bad-data', 'bad-data']);
  assert.equal(integrityOf(bad).length, 0);
});

test('the integrity output and the digests are the same under all 24 arrival orders of the proof entry, W1a, W2 and X1', () => {
  const { world, w0, w1a, w2, x0, x1, proofEntry } = proofWorld();
  const ctx = world.ctx();
  const start = sealed(w0, x0);
  const reference = foldEntries([...start, ...sealed(w1a, w2, x1, proofEntry)], ctx, REDUCERS);
  assert.equal(reference.quarantined.length, 1);
  let count = 0;
  for (const order of permutations(sealed(proofEntry, w1a, w2, x1))) {
    count += 1;
    const result = foldEntries([...start, ...order], ctx, REDUCERS);
    assert.deepEqual(result.families.integrity, reference.families.integrity);
    assert.deepEqual(result.digests, reference.digests);
    assert.deepEqual(result.quarantined, reference.quarantined);
    assert.deepEqual(result.excluded, reference.excluded);
    assert.deepEqual([...result.applied].sort(), [...reference.applied].sort());
  }
  assert.equal(count, 24);
});

// WR-03, D-01 (b), D-20: W writes seq 0 and 1, then signs `count` different headers at seq 2, all following the same seq 1. The fork has that many
// branches, and the lead's device.release may name any one of them.
function manyBranches(count: number): { world: ReturnType<typeof createWorld>; w1: Written; branches: Written[]; hashes: string[] } {
  const world = createWorld({ members: [{ member: 'mbr-wwww', name: 'Wren', devices: ['W'] }, { member: 'mbr-xxxx', name: 'Xia', devices: ['X'] }] });
  const client = (clientId: number): { kind: string; data: unknown } => ({ kind: 'doc.client', data: { product: PRODUCT, clientId, actor: { kind: 'person' } } });
  world.write('W', client(401));
  const w1 = world.write('W', client(402));
  const first = world.write('W', client(410));
  const branches = [first, ...Array.from({ length: count - 1 }, (_, index) => forkAt(world, 'W', world.stream, 2, client(411 + index)))];
  return { world, w1, branches, hashes: branches.map((item) => item.hash).sort() };
}

const slotOf = (items: readonly Written[]): Array<{ hash: string; header: SealedEntry['header'] }> => items.map((item) => ({ hash: item.hash, header: item.entry.header }));

function choosing(world: ReturnType<typeof createWorld>, seq: number, hash: string): ReturnType<typeof staticRosterView> {
  return staticRosterView({ ...world.rosterSpec, chosenBranches: [{ writer: world.writerOf('W'), stream: world.stream, seq, hash }] });
}

test('WR-03: a fork with three branches is resolved when the release names the highest hash, which is not one of the two in the proof', () => {
  const { world, w1, branches, hashes } = manyBranches(3);
  const proofs = findEquivocations(slotOf([w1, ...branches]), world.ctx().roster);
  assert.equal(proofs.length, 1, 'one proof per slot, whatever the number of branches');
  const [proof] = proofs;
  assert.deepEqual([entryHash(proof.a), entryHash(proof.b)], hashes.slice(0, 2), 'the proof is still the two lowest hashes');
  assert.deepEqual(proof.branches, hashes, 'every branch at the slot, sorted');
  const highest = hashes[2];
  assert.equal(forkChosen(proof, choosing(world, 2, highest)), highest, 'the highest branch is a branch the lead may choose');
  assert.deepEqual(quarantineRecords(proofs, choosing(world, 2, highest)), []);
  for (const hash of hashes) assert.equal(forkChosen(proof, choosing(world, 2, hash)), hash);
  assert.deepEqual(quarantineRecords(proofs, world.ctx().roster), [{ writer: world.writerOf('W'), stream: world.stream, fromSeq: 2 }], 'no choice: quarantined');
});

test('a four-branch fork accepts each of its four branches; a hash that is not a branch at the slot, or a choice at another seq, resolves nothing', () => {
  const { world, w1, branches, hashes } = manyBranches(4);
  const [proof] = findEquivocations(slotOf([...branches].reverse()), world.ctx().roster);
  assert.deepEqual(proof.branches, hashes);
  for (const hash of hashes) {
    assert.equal(forkChosen(proof, choosing(world, 2, hash)), hash);
    assert.deepEqual(quarantineRecords([proof], choosing(world, 2, hash)), []);
  }
  for (const stranger of ['e'.repeat(64), w1.hash]) {
    assert.equal(forkChosen(proof, choosing(world, 2, stranger)), undefined);
    assert.deepEqual(quarantineRecords([proof], choosing(world, 2, stranger)), [{ writer: world.writerOf('W'), stream: world.stream, fromSeq: 2 }]);
  }
  assert.equal(forkChosen(proof, choosing(world, 1, hashes[3])), undefined, 'a choice recorded for another seq is not a choice for this fork');
});

test('the branches never reach the wire: JSON, canonical bytes and proofHash equal the proof of the two lowest headers alone (D-39)', () => {
  const { world, branches, hashes } = manyBranches(4);
  const [proof] = findEquivocations(slotOf(branches), world.ctx().roster);
  const byHash = new Map(branches.map((item) => [item.hash, item.entry.header]));
  const key = world.signerOf('W').publicKey;
  const plain = canonicalProof(byHash.get(hashes[0]) as SealedEntry['header'], byHash.get(hashes[1]) as SealedEntry['header'], key);
  assert.equal(proof.branches?.length, 4);
  assert.equal(plain.branches, undefined, 'a proof made from two headers has no list of branches');
  assert.equal(proofHash(proof), proofHash(plain));
  assert.equal(JSON.stringify(proof), JSON.stringify(plain));
  assert.deepEqual(canonicalBytes(proof), canonicalBytes(plain));
  assert.deepEqual(Object.keys(proof).sort(), ['a', 'b', 'publicKey']);
  const wire = JSON.parse(JSON.stringify(proof)) as unknown;
  assert.equal(verifyProof(wire), true, 'the proof as sent still checks out alone');
  assert.equal(parseProof(wire)?.branches, undefined, 'a proof read from the wire carries no branches');
  assert.equal(proofHash(parseProof(wire) as NonNullable<ReturnType<typeof parseProof>>), proofHash(proof));
});

test('a proof read from the wire, with no branches of its own, accepts a choice of either of its two headers and nothing else', () => {
  const { world, branches, hashes } = manyBranches(3);
  const [found] = findEquivocations(slotOf(branches), world.ctx().roster);
  const wire = parseProof(JSON.parse(JSON.stringify(found))) as NonNullable<ReturnType<typeof parseProof>>;
  assert.equal(forkChosen(wire, choosing(world, 2, hashes[0])), hashes[0]);
  assert.equal(forkChosen(wire, choosing(world, 2, hashes[1])), hashes[1]);
  assert.equal(forkChosen(wire, choosing(world, 2, hashes[2])), undefined, 'the third branch is unknown to a bare pair; the chain stage adds it (31-06 Task 2)');
});
