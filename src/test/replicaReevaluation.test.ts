// What a later delivery or a new context can change (reviewer findings CR-02 and CR-03 of phase 30; D-08, D-10, D-14, D-36): the incremental fold must give
// the state a fold from scratch gives, also when a compaction names an entry that is delivered after it, and also when the context (a blob, a key, the
// clock) is replaced between deliveries.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyUpdate, createFoldDoc, createLocalDoc, docText, encodeFullState, localInsert, stateVectorOf, textHashOf } from '../domain/replica/doc';
import { sealBlob } from '../domain/replica/entry';
import type { Dep, SealedEntry } from '../domain/replica/entry';
import { checkpointHash, orderTipOf, signCheckpoint, verifyCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint } from '../domain/replica/checkpoint';
import { addEntries, createFoldState, foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { totalOrder } from '../domain/replica/order';
import { staticRosterView } from '../domain/replica/rosterView';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { verifyEntry } from '../domain/replica/verify';
import type { VerifiedEntry } from '../domain/replica/verify';
import { createWorld, fixedSigner, rng, shuffled } from './helpers/replicaWorld';
import type { World, Written } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';
const sealed = (...items: Written[]): SealedEntry[] => items.map((item) => item.entry);
const dep = (item: Written): Dep => ({ writer: item.writer, seq: item.seq, hash: item.hash });
const productOf = (result: FoldResult): ProductTextOutput => (result.families.doc as ProductTextOutput[])[0];

// A full state as a compaction blob: what the given client typed.
function stateOf(client: number, inserts: Array<[number, string]>): Uint8Array {
  const local = createLocalDoc(client);
  for (const [index, text] of inserts) localInsert(local, index, text);
  const folded = createFoldDoc();
  applyUpdate(folded, encodeFullState(local));
  return encodeFullState(folded);
}

// A doc.compact entry written by `writer`: the state is sealed into a blob the world holds, and the covers are named but not necessarily cited as deps.
function compactEntry(world: World, writer: string, state: Uint8Array, covers: readonly Dep[], deps: readonly Written[] = []): Written {
  const doc = createFoldDoc();
  applyUpdate(doc, state);
  const blob = sealBlob(world.keyFor(world.stream, 0), world.stream, 0, Buffer.from(state));
  world.blobs.set(blob.hash, blob);
  return world.write(writer, { kind: 'doc.compact', deps, data: { product: PRODUCT, covers: [...covers], stateVector: stateVectorOf(doc), textHash: textHashOf(docText(doc)), stateBlob: blob.hash } });
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
  assert.deepEqual(left, right, `${label}: the whole result`);
}

// ---- CR-02: a compaction's outcome must not depend on when its covers were delivered ----------------------------------------------------------------

interface Hostile {
  world: World;
  regs: Written[];
  updA: Written; updB: Written; late: Written;
  // C names `late`, which sorts after it and is delivered after it, under a forged state; D names an entry nobody will ever deliver; E is honest.
  forgedLate: Written; forgedGhost: Written; honest: Written;
  all: Written[];
}

function hostileScene(): Hostile {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }, { member: 'mbr-bbbb', devices: ['B'] }, { member: 'mbr-cccc', devices: ['C'] }, { member: 'mbr-dddd', devices: ['D'] }, { member: 'mbr-eeee', devices: ['E'] }] });
  const a = world.editor('A', PRODUCT, 11);
  const b = world.editor('B', PRODUCT, 22);
  const regs = [a.register(), b.register()];
  const updA = a.insert(0, 'alpha ');
  const updB = b.insert(0, 'beta');
  const merged = createFoldDoc();
  applyUpdate(merged, encodeFullState(a.doc));
  applyUpdate(merged, encodeFullState(b.doc));
  // Lamport 3: above every compaction written without dependencies below.
  const late = a.insert(6, 'gamma', { deps: [updA, updB] });
  const forged = stateOf(11, [[0, 'FORGED under A']]);
  const forgedLate = compactEntry(world, 'C', forged, [dep(late)]);
  const ghost: Dep = { writer: world.writerOf('A'), seq: 99, hash: 'e'.repeat(64) };
  const forgedGhost = compactEntry(world, 'D', forged, [ghost]);
  const honest = compactEntry(world, 'E', encodeFullState(merged), [dep(updA), dep(updB)], [updA, updB]);
  return { world, regs, updA, updB, late, forgedLate, forgedGhost, honest, all: [...regs, updA, updB, late, forgedLate, forgedGhost, honest] };
}

test('CR-02: a hostile compaction that covers an entry delivered later is refused the same way whether the cover arrives before or after it', () => {
  const s = hostileScene();
  const ctx = s.world.ctx();
  const reference = foldEntries(sealed(...s.all), ctx);
  // From scratch the cover is in the set and not yet accepted at the compaction's place, so the compaction is refused and the forged text is not shown.
  assert.deepEqual(reference.refused.map((item) => [item.hash, item.reason]), [[s.forgedLate.hash, 'compact-mismatch']]);
  assert.deepEqual(productOf(reference).compactions.map((item) => [item.entry, item.verified]).sort(), [[s.forgedGhost.hash, false], [s.honest.hash, true]].sort());

  // The compaction first, its cover last: the compaction is accepted provisionally while the cover is unknown, and must be judged again when it arrives.
  const before = addEntries(createFoldState(ctx), sealed(...s.regs, s.updA, s.updB, s.forgedLate, s.forgedGhost, s.honest));
  assert.deepEqual(productOf(before.result).compactions.map((item) => item.entry).sort(), [s.forgedGhost.hash, s.forgedLate.hash, s.honest.hash].sort());
  const after = addEntries(before, sealed(s.late));
  assert.equal(after.refolds, before.refolds + 1, 'the late cover makes the fold start again from the compaction');
  sameResult(after.result, reference, 'cover delivered last');
  assert.deepEqual(after.result.refused.map((item) => [item.hash, item.reason]), [[s.forgedLate.hash, 'compact-mismatch']]);
});

test('CR-02: one entry at a time in random order, and in random chunks, equals the fold from scratch with hostile and honest compactions (120 orders)', () => {
  const s = hostileScene();
  const ctx = s.world.ctx();
  const reference = foldEntries(sealed(...s.all), ctx);
  let refolded = 0;
  for (let seed = 1; seed <= 120; seed += 1) {
    const random = rng(seed * 7919);
    const delivery = shuffled(s.all, random).map((item) => item.entry);
    let single = createFoldState(ctx);
    for (const entry of delivery) single = addEntries(single, [entry]);
    sameResult(single.result, reference, `seed ${seed}: one at a time`);
    refolded += single.refolds;
    let chunked = createFoldState(ctx);
    for (let from = 0; from < delivery.length;) {
      const size = 1 + random.int(3);
      chunked = addEntries(chunked, delivery.slice(from, from + size));
      from += size;
    }
    sameResult(chunked.result, reference, `seed ${seed}: chunks`);
  }
  assert.ok(refolded > 0, 'the orders exercise the refold');
});

test('CR-02: a compaction inside a checkpoint prefix whose cover is delivered after it is judged again, not read from the prefix snapshot', () => {
  const hub = fixedSigner('H');
  const hubbed = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }, { member: 'mbr-bbbb', devices: ['B'] }, { member: 'mbr-cccc', devices: ['C'] }, { member: 'mbr-hhhh', devices: ['H'] }] });
  const a = hubbed.editor('A', PRODUCT, 11);
  const b = hubbed.editor('B', PRODUCT, 22);
  const regs = [a.register(), b.register()];
  const updA = a.insert(0, 'alpha ');
  const updB = b.insert(0, 'beta');
  const late = a.insert(6, 'gamma', { deps: [updA, updB] });
  const hostile = compactEntry(hubbed, 'C', stateOf(11, [[0, 'FORGED under A']]), [dep(late)]);
  const spec = { ...hubbed.rosterSpec, rosters: hubbed.rosterSpec.rosters.map((roster) => ({ ...roster, checkpointSigners: [hub.writer] })) };
  const ctx = hubbed.ctx({ roster: staticRosterView(spec) });
  // The checkpoint covers everything but `late`, hostile compaction included, so the compaction is final in the prefix.
  const covered = [...regs, updA, updB, hostile];
  const entries = covered.map((item) => (verifyEntry(item.entry, ctx) as { entry: VerifiedEntry }).entry);
  const ordered = totalOrder(entries);
  const heads = new Map<string, Dep>();
  for (const entry of entries) {
    const known = heads.get(entry.header.writer);
    if (known === undefined || known.seq < entry.header.seq) heads.set(entry.header.writer, { writer: entry.header.writer, seq: entry.header.seq, hash: entry.hash });
  }
  const checkpoint: Checkpoint = {
    type: 'checkpoint', v: 1, project: 'project-main', signer: hub.writer, rosterHead: hubbed.rosterHash,
    streams: [{ stream: hubbed.stream, heads: [...heads.values()].sort((x, y) => (x.writer < y.writer ? -1 : 1)), count: ordered.length, orderTip: orderTipOf(ordered.map((entry) => entry.hash)) }]
  };
  const signed = signCheckpoint(hub.signer, checkpoint);
  assert.equal(verifyCheckpoint(signed, ctx.roster).ok, true);
  const options = { checkpoints: [signed] };

  const prefix = addEntries(createFoldState(ctx, options), sealed(...covered));
  assert.equal(prefix.result.checkpoint, checkpointHash(signed));
  assert.deepEqual(productOf(prefix.result).compactions, [{ entry: hostile.hash, verified: false }]);
  const full = addEntries(prefix, sealed(late));
  const scratch = foldEntries(sealed(...covered, late), ctx, options);
  assert.deepEqual(scratch.refused.map((item) => item.reason), ['compact-mismatch']);
  assert.equal(full.refolds, prefix.refolds + 1);
  sameResult(full.result, scratch, 'checkpointed, cover delivered last');
});

// ---- CR-03: a new context is looked at again by everything that was decided under the old one ------------------------------------------------------

test('CR-03: a compaction held for its blob is applied when a context that holds the blob replaces the old one, with or without new entries, and equals the from-scratch fold', () => {
  const s = hostileScene();
  const noBlob = s.world.ctx({ blobs: () => undefined });
  const withBlob = s.world.ctx();
  const everything = sealed(...s.all);
  const reference = foldEntries(everything, withBlob);
  assert.deepEqual(productOf(reference).compactions.some((item) => item.entry === s.honest.hash && item.verified), true);

  const waiting = addEntries(createFoldState(noBlob), everything);
  assert.deepEqual(waiting.result.held.filter((item) => item.stage === 'fold').map((item) => [item.hash, item.reason]).sort(), [s.forgedLate, s.forgedGhost, s.honest].map((item): [string, string] => [item.hash, 'missing-blob']).sort());
  sameResult(waiting.result, foldEntries(everything, noBlob), 'folded without the blob');
  // The same context object and nothing new: nothing to look at again.
  assert.equal(addEntries(waiting, [], noBlob), waiting);
  assert.equal(addEntries(waiting, []), waiting);

  const released = addEntries(waiting, [], withBlob);
  assert.equal(released.refolds, waiting.refolds + 1, 'the new context makes the fold start again');
  sameResult(released.result, reference, 'blob arrived, no new entry');
  assert.deepEqual(released.result.held, []);

  // The new context together with a late entry: delivered one entry at a time, the last delivery brings both.
  const base = everything.filter((entry) => entry !== s.late.entry);
  const partial = addEntries(createFoldState(noBlob), base);
  const both = addEntries(partial, sealed(s.late), withBlob);
  sameResult(both.result, reference, 'blob and late entry together');
  // Partial deliveries under the old context, then the new context with nothing else, in 80 random orders.
  for (let seed = 1; seed <= 80; seed += 1) {
    const random = rng(seed * 104729);
    const delivery = shuffled(everything, random);
    const cut = random.int(delivery.length + 1);
    let state = createFoldState(noBlob);
    for (const entry of delivery.slice(0, cut)) state = addEntries(state, [entry]);
    state = addEntries(state, delivery.slice(cut, cut + 2), withBlob);
    for (const entry of delivery.slice(cut + 2)) state = addEntries(state, [entry]);
    sameResult(state.result, reference, `seed ${seed}: context replaced after ${cut} entries`);
  }
});

test('CR-03: entries held for a missing key are applied when a context with the key replaces the old one, and the result equals the from-scratch fold', () => {
  const s = hostileScene();
  const noKeys = s.world.ctx({ keys: () => undefined });
  const withKeys = s.world.ctx();
  const reference = foldEntries(sealed(...s.all), withKeys);
  const waiting = addEntries(createFoldState(noKeys), sealed(...s.all));
  assert.equal(waiting.result.order.length, 0);
  assert.ok(waiting.result.held.length > 0 && waiting.result.held.every((item) => item.reason === 'missing-key'));
  sameResult(addEntries(waiting, [], withKeys).result, reference, 'key arrived');
  // Half of the entries arrive after the key does.
  const half = addEntries(createFoldState(noKeys), sealed(...s.all.slice(0, 5)));
  sameResult(addEntries(addEntries(half, [], withKeys), sealed(...s.all.slice(5))).result, reference, 'key arrived, rest later');
});

test('CR-03: a future-dated entry is released when a context with a later clock replaces the old one, and the entries that waited on it fold with it', () => {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }, { member: 'mbr-bbbb', devices: ['B'] }] });
  const a = world.editor('A', PRODUCT, 11);
  const b = world.editor('B', PRODUCT, 22);
  const regA = a.register();
  const first = a.insert(0, 'one ');
  // 60 minutes after the clock of the first context, and the entry that follows it in A's log, which waits on it.
  const future = a.insert(4, 'two ', { at: '2026-11-19T13:00:00.000Z' });
  const next = a.insert(8, 'three');
  const regB = b.register();
  const other = b.insert(0, 'other ');
  const all = sealed(regA, first, future, next, regB, other);
  const early = world.ctx();
  const later = world.ctx({ now: new Date('2026-11-19T13:30:00.000Z') });
  const reference = foldEntries(all, later);
  assert.equal(productOf(reference).text.includes('two'), true);

  const waiting = addEntries(createFoldState(early), all);
  assert.deepEqual(waiting.result.held.map((item) => item.reason).sort(), ['future-dated', 'missing-predecessor']);
  assert.equal(productOf(waiting.result).text.includes('two'), false);
  sameResult(waiting.result, foldEntries(all, early), 'before the clock moves');
  assert.equal(addEntries(waiting, [], early), waiting, 'the same clock changes nothing');

  const released = addEntries(waiting, [], later);
  assert.deepEqual(released.result.held, []);
  sameResult(released.result, reference, 'the clock moved on');
  // Only the future-dated entry is waiting: with nothing else applied, the new context is simply taken without starting again.
  const alone = addEntries(createFoldState(early), sealed(regA, first, future));
  assert.equal(alone.result.order.length, 2);
  sameResult(addEntries(alone, [], later).result, foldEntries(sealed(regA, first, future), later), 'a lone future-dated entry');
  const nothing = addEntries(createFoldState(early), sealed(future));
  assert.equal(nothing.result.order.length, 0);
  const onlyFuture = addEntries(nothing, [], later);
  assert.equal(onlyFuture.refolds, 0, 'nothing was applied, so nothing starts again');
  assert.equal(onlyFuture.ctx, later);
  assert.deepEqual(onlyFuture.result.held.map((item) => item.reason), ['missing-predecessor']);
  // The clock may also go back: the entry that was released is held again.
  sameResult(addEntries(released, [], early).result, foldEntries(all, early), 'the clock moved back');
});
