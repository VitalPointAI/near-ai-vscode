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
