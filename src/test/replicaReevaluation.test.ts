// What a later delivery or a new context can change (reviewer findings CR-02 and CR-03 of phase 30; D-08, D-10, D-14, D-36): the incremental fold must give
// the state a fold from scratch gives, also when a compaction names an entry that is delivered after it, and also when the context (a blob, a key, the
// clock) is replaced between deliveries.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyUpdate, createFoldDoc, createLocalDoc, docText, encodeFullState, localInsert, snapshotOf, stateVectorOf, textHashOf } from '../domain/replica/doc';
import { canonicalBytes } from '../domain/team/canonical';
import { sealBlob } from '../domain/replica/entry';
import type { Dep, SealedBlob, SealedEntry } from '../domain/replica/entry';
import { checkpointHash, orderTipOf, signCheckpoint, verifyCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint } from '../domain/replica/checkpoint';
import { addEntries, createFoldState, foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { totalOrder } from '../domain/replica/order';
import { staticRosterView } from '../domain/replica/rosterView';
import type { KeyRing, ReplicaContext, RosterView } from '../domain/replica/rosterView';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { replicaVersionHash } from '../domain/replica/versions';
import { verifyEntry } from '../domain/replica/verify';
import type { VerifiedEntry } from '../domain/replica/verify';
import { createWorld, fixedSigner, rng, shuffled, streamId } from './helpers/replicaWorld';
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
    // D-01 (d): the same delivery under one context object, with the compactions' blobs put behind it at a random point.
    const shelf = shelfFor(s.world);
    giveKey(shelf, s.world, s.world.stream);
    const at = random.int(delivery.length + 1);
    let shelved = createFoldState(shelf.ctx);
    for (let index = 0; index <= delivery.length; index += 1) {
      if (index === at) for (const [hash, blob] of s.world.blobs) shelf.blobs.set(hash, blob);
      shelved = addEntries(shelved, delivery.slice(index, index + 1), shelf.ctx);
    }
    sameResult(shelved.result, reference, `seed ${seed}: blobs put behind the same context after ${at} entries`);
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
  // D-01 (d): the same, with the blob put behind the one context object instead of a new context (80 random orders).
  for (let seed = 1; seed <= 80; seed += 1) {
    const random = rng(seed * 130363);
    const delivery = shuffled(everything, random);
    const cut = random.int(delivery.length + 1);
    const shelf = shelfFor(s.world);
    giveKey(shelf, s.world, s.world.stream);
    let state = createFoldState(shelf.ctx);
    for (const entry of delivery.slice(0, cut)) state = addEntries(state, [entry], shelf.ctx);
    for (const [hash, blob] of s.world.blobs) shelf.blobs.set(hash, blob);
    state = addEntries(state, delivery.slice(cut, cut + 2), shelf.ctx);
    for (const entry of delivery.slice(cut + 2)) state = addEntries(state, [entry], shelf.ctx);
    sameResult(state.result, reference, `seed ${seed}: blob put behind the same context after ${cut} entries`);
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
  // D-01 (d): the key put into the key ring behind the same context object, with nothing new and with the rest of the entries.
  const shelf = shelfFor(s.world);
  for (const [hash, blob] of s.world.blobs) shelf.blobs.set(hash, blob);
  const sameWaiting = addEntries(createFoldState(shelf.ctx), sealed(...s.all.slice(0, 5)));
  assert.equal(sameWaiting.result.order.length, 0);
  giveKey(shelf, s.world, s.world.stream);
  const sameReleased = addEntries(sameWaiting, [], shelf.ctx);
  sameResult(sameReleased.result, foldEntries(sealed(...s.all.slice(0, 5)), withKeys), 'key put behind the same context');
  sameResult(addEntries(sameReleased, sealed(...s.all.slice(5)), shelf.ctx).result, reference, 'key put behind the same context, rest later');
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

// ---- (c) WR-08: a re-delivered entry costs a hash, not a signature check and a decryption ---------------------------------------------------------

// A context that counts the lookups verification makes: one deviceKey call for each copy whose signature is checked, and key ring calls for each body
// that is opened.
function countingCtx(world: World, overrides: Partial<ReplicaContext> = {}): { ctx: ReplicaContext; counts: { deviceKey: number; keys: number } } {
  const base = world.ctx(overrides);
  const counts = { deviceKey: 0, keys: 0 };
  const roster: RosterView = {
    ...base.roster,
    deviceKey: (writer) => {
      counts.deviceKey += 1;
      return base.roster.deviceKey(writer);
    }
  };
  const keys: KeyRing = (stream, epoch) => {
    counts.keys += 1;
    return base.keys(stream, epoch);
  };
  return { ctx: { ...base, roster, keys }, counts };
}

function coEditScene(): { world: World; entries: SealedEntry[]; update: Written } {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }, { member: 'mbr-bbbb', devices: ['B'] }] });
  const a = world.editor('A', PRODUCT, 11);
  const b = world.editor('B', PRODUCT, 22);
  const regs = [a.register(), b.register()];
  const update = a.insert(0, 'alpha ');
  const other = b.insert(0, 'beta');
  return { world, entries: sealed(...regs, update, other), update };
}

const cloneOf = (entry: SealedEntry): SealedEntry => JSON.parse(JSON.stringify(entry)) as SealedEntry;

test('(c) a valid entry delivered again as 2000 JSON clones is verified once, by addEntries in one call or in many', () => {
  const s = coEditScene();
  const clones = Array.from({ length: 2000 }, () => cloneOf(s.update.entry));
  const once = countingCtx(s.world);
  const reference = addEntries(createFoldState(once.ctx), s.entries);
  const many = countingCtx(s.world);
  const flooded = addEntries(createFoldState(many.ctx), [...s.entries, ...clones]);
  assert.deepEqual(many.counts, once.counts, 'the clones add no verification work');
  sameResult(flooded.result, reference.result, 'with 2000 clones');
  // Delivered later, in their own calls: nothing changes and nothing is verified again.
  const before = { ...many.counts };
  let state = flooded;
  for (let from = 0; from < clones.length; from += 500) state = addEntries(state, clones.slice(from, from + 500));
  assert.deepEqual(many.counts, before);
  assert.equal(state, flooded, 'a delivery of known copies returns the same state');
  assert.equal(state.refolds, 0);
});

test('(c) foldEntries over an entry and 2000 clones of it equals foldEntries over the entry, with the verification work of one copy', () => {
  const s = coEditScene();
  const clones = Array.from({ length: 2000 }, () => cloneOf(s.update.entry));
  const once = countingCtx(s.world);
  const reference = foldEntries(s.entries, once.ctx);
  const many = countingCtx(s.world);
  const flooded = foldEntries([...s.entries, ...clones], many.ctx);
  assert.deepEqual(many.counts, once.counts);
  sameResult(flooded, reference, 'from scratch with 2000 clones');
});

test('(c) a corrupt copy delivered after the good copy is skipped as a duplicate of a verified hash and changes no outcome', () => {
  const s = coEditScene();
  const counting = countingCtx(s.world);
  const state = addEntries(createFoldState(counting.ctx), s.entries);
  const before = { ...counting.counts };
  const body = s.update.entry.body;
  const corrupt = { header: { ...s.update.entry.header }, body: `${body.slice(0, -4)}${body.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}` };
  const after = addEntries(state, [corrupt]);
  assert.deepEqual(counting.counts, before, 'the corrupt copy is not verified');
  assert.equal(after, state);
  sameResult(foldEntries([...s.entries, corrupt], counting.ctx), state.result, 'from scratch with the corrupt copy last');
});

test('(c) inputs that are not objects or have no readable header are counted in dropped, kept to one record per reason, and change no digest', () => {
  const s = coEditScene();
  const ctx = s.world.ctx();
  const junk: unknown[] = [42, null, 'entry', [s.update.entry], {}, { header: 5 }, { header: { ...s.update.entry.header, v: 3 }, body: s.update.entry.body }];
  const clean = foldEntries(s.entries, ctx);
  assert.equal(clean.dropped, 0);
  const dirty = foldEntries([...junk, ...s.entries, ...junk], ctx);
  assert.equal(dirty.dropped, junk.length * 2);
  assert.deepEqual(dirty.digests, clean.digests);
  assert.deepEqual([dirty.order, dirty.applied, dirty.held, dirty.families], [clean.order, clean.applied, clean.held, clean.families]);
  // The rejected list says what kinds of unreadable input arrived, once per reason, however many arrived.
  assert.deepEqual(dirty.rejected.map((item) => item.reason).sort(), ['malformed-header', 'unknown-header-version']);
  const flood = foldEntries([...s.entries, ...Array.from({ length: 1000 }, (_, index) => ({ header: index }))], ctx);
  assert.equal(flood.dropped, 1000);
  assert.equal(flood.rejected.length, 1);
  // Incrementally: junk alone is counted without folding again, and the result equals the fold from scratch.
  const folded = addEntries(createFoldState(ctx), s.entries);
  const counted = addEntries(folded, junk);
  assert.notEqual(counted, folded);
  assert.equal(counted.result.dropped, junk.length);
  assert.equal(counted.refolds, folded.refolds);
  sameResult(counted.result, foldEntries([...s.entries, ...junk], ctx), 'junk delivered after the entries');
  sameResult(addEntries(addEntries(createFoldState(ctx), junk), s.entries).result, foldEntries([...junk, ...s.entries], ctx), 'junk delivered first');
});

// ---- (c) and IN-03: held copies are bounded per hash and reason, and a held copy outranks a rejected one ------------------------------------------

const corruptCopy = (entry: SealedEntry, label: string): SealedEntry => ({ header: { ...entry.header }, body: Buffer.from(`corrupt ${label}`).toString('base64url') });

test('(c) 500 distinct held copies with one header hash and one hold reason leave one copy to look at again', () => {
  const s = coEditScene();
  const counting = countingCtx(s.world);
  const copies = Array.from({ length: 500 }, (_, index) => corruptCopy(s.update.entry, String(index)));
  const others = s.entries.filter((entry) => entry !== s.update.entry);
  const state = addEntries(createFoldState(counting.ctx), [...others, ...copies]);
  assert.deepEqual(state.result.held.filter((item) => item.hash === s.update.hash).map((item) => item.reason), ['body-missing-or-corrupt']);
  // Each delivery looks at the kept copies again: one signature check for the one copy kept for this hash and reason.
  const before = counting.counts.deviceKey;
  assert.equal(addEntries(state, [], counting.ctx), state);
  assert.equal(counting.counts.deviceKey - before, 1);
  sameResult(state.result, foldEntries([...others, ...copies], counting.ctx), 'from scratch');
  // The good copy still releases the entry.
  sameResult(addEntries(state, [s.update.entry]).result, foldEntries(s.entries, counting.ctx), 'good copy delivered last');
});

test('(c) a copy held for a different reason is kept as a second copy, and verifies when its key arrives behind the same context', () => {
  const s = coEditScene();
  const ring = new Map<string, Buffer>();
  for (const entry of s.entries) if (entry !== s.update.entry) ring.set(`${entry.header.stream}/${entry.header.epoch}`, s.world.keyFor(entry.header.stream, entry.header.epoch));
  const keyId = `${s.update.entry.header.stream}/${s.update.entry.header.epoch}`;
  const keyOfUpdate = s.world.keyFor(s.update.entry.header.stream, s.update.entry.header.epoch);
  // The update shares its stream and epoch with the other entries, so the update's own key is the stream key: take it out and give it back.
  ring.delete(keyId);
  const ctx = s.world.ctx({ keys: (stream, epoch) => ring.get(`${stream}/${epoch}`) });
  const counting = countingCtx(s.world, { keys: ctx.keys });
  const corrupt = corruptCopy(s.update.entry, 'one');
  for (const order of [[corrupt, s.update.entry], [s.update.entry, corrupt]]) {
    ring.delete(keyId);
    const waiting = addEntries(createFoldState(counting.ctx), [...s.entries.filter((entry) => entry !== s.update.entry), ...order]);
    assert.equal(waiting.result.order.length, 0, 'without the stream key nothing is admitted');
    const before = counting.counts.deviceKey;
    addEntries(waiting, [], counting.ctx);
    assert.equal(counting.counts.deviceKey - before, 5, 'one copy per entry and reason is looked at again: three entries, and two copies of the update');
    ring.set(keyId, keyOfUpdate);
    const released = addEntries(waiting, [], counting.ctx);
    sameResult(released.result, foldEntries(s.entries, counting.ctx), `key arrived, ${order[0] === corrupt ? 'corrupt' : 'good'} copy first`);
    assert.ok(released.result.applied.includes(s.update.hash));
  }
});

test('(c) while the writer is unknown, an intact copy is kept in place of a corrupt one held for the same reason, so the entry verifies when the writer is known', () => {
  const s = coEditScene();
  const base = s.world.ctx();
  const writerA = s.world.writerOf('A');
  let knowsA = false;
  const roster: RosterView = { ...base.roster, deviceKey: (writer) => (writer === writerA && !knowsA ? undefined : base.roster.deviceKey(writer)) };
  const ctx: ReplicaContext = { ...base, roster };
  const corrupt = corruptCopy(s.update.entry, 'two');
  for (const order of [[corrupt, s.update.entry], [s.update.entry, corrupt]]) {
    knowsA = false;
    const waiting = addEntries(createFoldState(ctx), [...s.entries.filter((entry) => entry !== s.update.entry), ...order]);
    assert.ok(waiting.result.held.some((item) => item.hash === s.update.hash && item.reason === 'unknown-writer'));
    knowsA = true;
    const released = addEntries(waiting, [], ctx);
    sameResult(released.result, foldEntries(s.entries, ctx), `writer known, ${order[0] === corrupt ? 'corrupt' : 'good'} copy first`);
  }
});

test('IN-03: a good copy that is permanently rejected and a corrupt copy that is only held report the entry held, whichever arrives first', () => {
  const s = coEditScene();
  // A key ring holding the wrong key for the stream: the good copy opens to nothing (rejected body-unreadable), the corrupt copy never gets that far.
  const wrong = Buffer.alloc(32, 7);
  const ctx = s.world.ctx({ keys: () => wrong });
  const corrupt = corruptCopy(s.update.entry, 'three');
  assert.equal(verifyEntry(s.update.entry, ctx).status, 'rejected');
  assert.equal(verifyEntry(corrupt, ctx).status, 'held');
  const results = [
    foldEntries([s.update.entry, corrupt], ctx),
    foldEntries([corrupt, s.update.entry], ctx),
    addEntries(addEntries(createFoldState(ctx), [s.update.entry]), [corrupt]).result,
    addEntries(addEntries(createFoldState(ctx), [corrupt]), [s.update.entry]).result
  ];
  for (const result of results) {
    assert.deepEqual(result.held.map((item) => [item.hash, item.reason]), [[s.update.hash, 'body-missing-or-corrupt']]);
    assert.deepEqual(result.rejected, []);
    sameResult(result, results[0], 'every arrival order');
  }
});

// ---- (d): a reducer-stage hold is looked at again when the same context object can now answer it ---------------------------------------------------

// A blob store and a key ring behind one context object, filled in as pieces arrive (the store owns one context, Pitfall 1).
interface Shelf { blobs: Map<string, SealedBlob>; keys: Map<string, Buffer>; ctx: ReplicaContext }
function shelfFor(world: World): Shelf {
  const blobs = new Map<string, SealedBlob>();
  const keys = new Map<string, Buffer>();
  const ctx = world.ctx({ blobs: (hash) => blobs.get(hash), keys: (stream, epoch) => keys.get(`${stream}/${epoch}`) });
  return { blobs, keys, ctx };
}
function giveKey(shelf: Shelf, world: World, stream: string, epoch = 0): void {
  shelf.keys.set(`${stream}/${epoch}`, world.keyFor(stream, epoch));
}
function foldHeld(result: FoldResult): Array<[string, string]> {
  return result.held.filter((item) => item.stage === 'fold').map((item): [string, string] => [item.hash as string, item.reason]).sort();
}

test('(d) a compaction held for its blob is applied when the blob is put behind the same context, with or without a new entry, and equals the from-scratch fold', () => {
  const s = hostileScene();
  const shelf = shelfFor(s.world);
  giveKey(shelf, s.world, s.world.stream);
  const everything = sealed(...s.all);
  const waiting = addEntries(createFoldState(shelf.ctx), everything);
  assert.deepEqual(foldHeld(waiting.result), [s.forgedLate, s.forgedGhost, s.honest].map((item): [string, string] => [item.hash, 'missing-blob']).sort());
  // Nothing the context can answer yet: the very same state, and no refold.
  assert.equal(addEntries(waiting, [], shelf.ctx), waiting);
  assert.equal(addEntries(waiting, []), waiting);
  for (const [hash, blob] of s.world.blobs) shelf.blobs.set(hash, blob);
  const released = addEntries(waiting, [], shelf.ctx);
  assert.notEqual(released, waiting);
  assert.equal(released.refolds, waiting.refolds + 1);
  sameResult(released.result, foldEntries(everything, shelf.ctx), 'blob arrived behind the same context');
  assert.deepEqual(released.result.held, []);
  // Once released, the same context and nothing new change nothing again.
  assert.equal(addEntries(released, [], shelf.ctx), released);

  // The blob arrives together with an entry that sorts last: still judged again, not appended.
  const late = createWorldShelfCase();
  sameResult(late.result, late.reference, 'blob and a last-sorting entry together');
});

// The hostile scene without `late`, folded without blobs, then the blobs and `late` (which sorts after every compaction) in one call.
function createWorldShelfCase(): { result: FoldResult; reference: FoldResult } {
  const s = hostileScene();
  const shelf = shelfFor(s.world);
  giveKey(shelf, s.world, s.world.stream);
  const base = sealed(...s.all).filter((entry) => entry !== s.late.entry);
  const waiting = addEntries(createFoldState(shelf.ctx), base);
  for (const [hash, blob] of s.world.blobs) shelf.blobs.set(hash, blob);
  return { result: addEntries(waiting, sealed(s.late), shelf.ctx).result, reference: foldEntries(sealed(...s.all), shelf.ctx) };
}

interface VersionScene { world: World; entries: SealedEntry[]; proposal: Written; textBlob: string; others: Map<string, SealedBlob> }

// A product with typed text and a proposal of that text whose blob is held back.
function versionScene(): VersionScene {
  const world = createWorld({
    members: [
      { member: 'mbr-lead', roles: ['member', 'staff_lead'], devices: ['LEAD'] },
      { member: 'mbr-p', roles: ['member', 'answers_for:j2'], devices: ['P'] }
    ]
  });
  const roles = { owner: 'j2-chief', sectionLead: 'j2-lead', releaseGuard: 'release-guard' };
  const create = world.write('LEAD', { kind: 'product.create', data: { product: PRODUCT, section: 'j2', roles, title: 'Intel estimate' } });
  const editor = world.editor('P', PRODUCT, 101);
  const reg = editor.register({ deps: [create] });
  const typed = editor.insert(0, 'Hello world', { deps: [reg] });
  const others = new Map(world.blobs);
  const text = docText(editor.doc);
  const blob = sealBlob(world.keyFor(world.stream, 0), world.stream, 0, canonicalBytes({ text, header: { title: 'Intel estimate' } }));
  world.blobs.set(blob.hash, blob);
  const data = { product: PRODUCT, hash: replicaVersionHash(text, []), textBlob: blob.hash, snapshot: Buffer.from(snapshotOf(editor.doc)).toString('base64url'), pins: [] };
  const proposal = world.write('P', { kind: 'version.propose', data, actor: { kind: 'person' }, deps: [typed] });
  return { world, entries: sealed(create, reg, typed, proposal), proposal, textBlob: blob.hash, others };
}

test('(d) a version proposal held for its text blob is applied when the blob is put behind the same context, and equals the from-scratch fold', () => {
  const v = versionScene();
  const shelf = shelfFor(v.world);
  giveKey(shelf, v.world, v.world.stream);
  for (const [hash, blob] of v.others) shelf.blobs.set(hash, blob);
  const waiting = addEntries(createFoldState(shelf.ctx), v.entries);
  assert.deepEqual(foldHeld(waiting.result), [[v.proposal.hash, 'missing-blob']]);
  assert.equal(addEntries(waiting, [], shelf.ctx), waiting);
  // A blob under the right name with the wrong bytes answers nothing.
  shelf.blobs.set(v.textBlob, { ...(v.world.blobs.get(v.textBlob) as SealedBlob), bytes: Buffer.from('not the blob').toString('base64url') });
  assert.equal(addEntries(waiting, [], shelf.ctx), waiting);
  shelf.blobs.set(v.textBlob, v.world.blobs.get(v.textBlob) as SealedBlob);
  const released = addEntries(waiting, [], shelf.ctx);
  assert.equal(released.refolds, waiting.refolds + 1);
  sameResult(released.result, foldEntries(v.entries, shelf.ctx), 'text blob arrived');
  assert.ok(released.result.applied.includes(v.proposal.hash));
});

test('(d) a compaction held at the reducer for its key is applied when the key ring behind the same context gains the key, and equals the from-scratch fold', () => {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }, { member: 'mbr-bbbb', devices: ['B'] }, { member: 'mbr-cccc', devices: ['C'] }, { member: 'mbr-dddd', devices: ['D'] }] });
  const a = world.editor('A', PRODUCT, 11);
  const b = world.editor('B', PRODUCT, 22);
  const regs = [a.register(), b.register()];
  const updA = a.insert(0, 'alpha ');
  const updB = b.insert(0, 'beta');
  const merged = createFoldDoc();
  applyUpdate(merged, encodeFullState(a.doc));
  applyUpdate(merged, encodeFullState(b.doc));
  const honest = compactEntry(world, 'C', encodeFullState(merged), [dep(updA), dep(updB)], [updA, updB]);
  // An entry of another cell that sorts before the compaction: it makes the fold start again while this cell's key is gone.
  const other = streamId('other-cell');
  const early = world.write('D', { kind: 'doc.client', stream: other, data: { product: PRODUCT, clientId: 44, actor: { kind: 'person' } } });
  const shelf = shelfFor(world);
  for (const [hash, blob] of world.blobs) shelf.blobs.set(hash, blob);
  giveKey(shelf, world, world.stream);
  giveKey(shelf, world, other);
  const first = addEntries(createFoldState(shelf.ctx), sealed(...regs, updA, updB, honest));
  assert.ok(first.result.applied.includes(honest.hash));
  shelf.keys.delete(`${world.stream}/0`);
  const waiting = addEntries(first, sealed(early));
  assert.deepEqual(foldHeld(waiting.result), [[honest.hash, 'missing-key']]);
  assert.equal(addEntries(waiting, [], shelf.ctx), waiting, 'the key is still missing');
  giveKey(shelf, world, world.stream);
  const released = addEntries(waiting, [], shelf.ctx);
  assert.equal(released.refolds, waiting.refolds + 1);
  sameResult(released.result, foldEntries(sealed(...regs, updA, updB, honest, early), shelf.ctx), 'key arrived behind the same context');
});

test('(d) property: 80 seeded deliveries with blobs and keys put behind one context at random points equal the from-scratch fold after every step', () => {
  const world = createWorld({
    members: [
      { member: 'mbr-lead', roles: ['member', 'staff_lead'], devices: ['LEAD'] },
      { member: 'mbr-p', roles: ['member', 'answers_for:j2'], devices: ['P'] },
      { member: 'mbr-sl', roles: ['member', 'section_lead:j2'], devices: ['SL'] },
      { member: 'mbr-aaaa', devices: ['A'] }, { member: 'mbr-bbbb', devices: ['B'] }, { member: 'mbr-cccc', devices: ['C'] }, { member: 'mbr-dddd', devices: ['D'] }
    ]
  });
  const roles = { owner: 'j2-chief', sectionLead: 'j2-lead', releaseGuard: 'release-guard' };
  const create = world.write('LEAD', { kind: 'product.create', data: { product: PRODUCT, section: 'j2', roles, title: 'Intel estimate' } });
  const p = world.editor('P', PRODUCT, 101);
  const regP = p.register({ deps: [create] });
  const typed = p.insert(0, 'Hello world', { deps: [regP] });
  const a = world.editor('A', PRODUCT, 11);
  const b = world.editor('B', PRODUCT, 22);
  const regA = a.register();
  const regB = b.register();
  const updA = a.insert(0, 'alpha ');
  const updB = b.insert(0, 'beta');
  const merged = createFoldDoc();
  applyUpdate(merged, encodeFullState(a.doc));
  applyUpdate(merged, encodeFullState(b.doc));
  const beforeCompaction = new Set(world.blobs.keys());
  const honest = compactEntry(world, 'C', encodeFullState(merged), [dep(updA), dep(updB)], [updA, updB]);
  const compactionBlobs = [...world.blobs.keys()].filter((hash) => !beforeCompaction.has(hash));
  // unregistered-client: D types before it registers, so the registration sorts after the update in the from-scratch fold too.
  const d = world.editor('D', PRODUCT, 44);
  const updD = d.insert(0, 'delta');
  const regD = d.register();
  // updates-missing: the section lead proposes, citing only the product, a snapshot of text typed later in the order.
  const proposeData = (text: string): Record<string, unknown> => {
    const blob = sealBlob(world.keyFor(world.stream, 0), world.stream, 0, canonicalBytes({ text, header: { title: 'Intel estimate' } }));
    world.blobs.set(blob.hash, blob);
    return { product: PRODUCT, hash: replicaVersionHash(text, []), textBlob: blob.hash, snapshot: Buffer.from(snapshotOf(p.doc)).toString('base64url'), pins: [] };
  };
  const early = world.write('SL', { kind: 'version.propose', data: proposeData(docText(p.doc)), actor: { kind: 'person' }, deps: [create] });
  // missing-blob: the owner's proposal, whose text blob arrives at a random point.
  const beforeProposal = new Set(world.blobs.keys());
  const proposal = world.write('P', { kind: 'version.propose', data: proposeData(docText(p.doc)), actor: { kind: 'person' }, deps: [typed] });
  const proposalBlobs = [...world.blobs.keys()].filter((hash) => !beforeProposal.has(hash));
  // A second cell whose key arrives at a random point (held at verification until then).
  const cell = streamId('second-cell');
  const cellReg = world.write('B', { kind: 'doc.client', stream: cell, data: { product: PRODUCT, clientId: 23, actor: { kind: 'person' } } });
  const all = sealed(create, regP, typed, regA, regB, updA, updB, honest, updD, regD, early, proposal, cellReg);
  const held = new Set([...compactionBlobs, ...proposalBlobs]);

  const reasons = new Set<string>();
  let refolded = 0;
  for (let seed = 1; seed <= 80; seed += 1) {
    const random = rng(seed * 15485863);
    const shelf = shelfFor(world);
    for (const [hash, blob] of world.blobs) if (!held.has(hash)) shelf.blobs.set(hash, blob);
    giveKey(shelf, world, world.stream);
    type Step = { entry: SealedEntry } | { give: () => void };
    const steps: Step[] = shuffled([
      ...all.map((entry): Step => ({ entry })),
      { give: () => { for (const hash of compactionBlobs) shelf.blobs.set(hash, world.blobs.get(hash) as SealedBlob); } },
      { give: () => { for (const hash of proposalBlobs) shelf.blobs.set(hash, world.blobs.get(hash) as SealedBlob); } },
      { give: () => giveKey(shelf, world, cell) }
    ], random);
    let state = createFoldState(shelf.ctx);
    const delivered: SealedEntry[] = [];
    for (let from = 0; from < steps.length;) {
      const size = 1 + random.int(3);
      const batch: SealedEntry[] = [];
      for (const step of steps.slice(from, from + size)) {
        if ('give' in step) step.give();
        else batch.push(step.entry);
      }
      from += size;
      delivered.push(...batch);
      state = addEntries(state, batch, shelf.ctx);
      for (const item of state.result.held) reasons.add(item.reason);
      sameResult(state.result, foldEntries(delivered, shelf.ctx), `seed ${seed}: after ${from} steps`);
    }
    refolded += state.refolds;
    sameResult(state.result, foldEntries(all, shelf.ctx), `seed ${seed}: everything`);
  }
  assert.ok(refolded > 0);
  for (const reason of ['missing-blob', 'missing-key', 'unregistered-client', 'updates-missing']) assert.ok(reasons.has(reason), `the scenarios reach ${reason}`);
});
