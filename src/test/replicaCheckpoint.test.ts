// Checkpoints (plan 30-09, D-14, D-36): signing and verification, order that a checkpoint makes final, recomputation from the entries, and the proof
// that a signer disagreed with itself about one prefix.
import assert from 'node:assert/strict';
import test from 'node:test';
import { signPayload } from '../domain/team/signedPayload';
import { checkpointCoverage, checkpointConflict, checkpointHash, orderTipOf, recomputeCheckpoint, signCheckpoint, verifyCheckpoint, CHECKPOINT_REFUSALS } from '../domain/replica/checkpoint';
import type { Checkpoint, SignedCheckpoint } from '../domain/replica/checkpoint';
import { buildCausalGraph } from '../domain/replica/causal';
import { REPLICA_SIGNED_AT } from '../domain/replica/entry';
import type { Dep, SealedEntry } from '../domain/replica/entry';
import { foldEntries } from '../domain/replica/fold';
import { totalOrder } from '../domain/replica/order';
import { staticRosterView } from '../domain/replica/rosterView';
import type { ReplicaContext } from '../domain/replica/rosterView';
import type { FoldView } from '../domain/replica/reducers';
import { textReducer } from '../domain/replica/textFold';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { verifyEntry } from '../domain/replica/verify';
import type { VerifiedEntry } from '../domain/replica/verify';
import { createWorld, fixedSigner } from './helpers/replicaWorld';
import type { World, Written } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';
const PROJECT = 'project-main';
const sealed = (...items: Written[]): SealedEntry[] => items.map((item) => item.entry);

interface Setup {
  world: World;
  ctx: ReplicaContext;
  hub: ReturnType<typeof fixedSigner>;
  // A's log: a0 and a1 are covered by the first checkpoint, a2 by the second, a3 by none.
  a: Written[];
  c: Written[];
}

// A writes four entries; C writes two concurrent ones (low lamport, so they sort inside A's early entries). H is the hub device, allowed to sign
// checkpoints at the roster head.
function setup(): Setup {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }, { member: 'mbr-cccc', devices: ['C'] }, { member: 'mbr-hhhh', devices: ['H'] }] });
  const hub = fixedSigner('H');
  const ea = world.editor('A', PRODUCT, 101);
  const ec = world.editor('C', PRODUCT, 303);
  const a = [ea.register(), ea.insert(0, 'one '), ea.insert(4, 'two '), ea.insert(8, 'three')];
  const c = [ec.register(), ec.insert(0, 'late ')];
  const spec = { ...world.rosterSpec, rosters: world.rosterSpec.rosters.map((roster) => ({ ...roster, checkpointSigners: [hub.writer] })) };
  return { world, ctx: world.ctx({ roster: staticRosterView(spec) }), hub, a, c };
}

function verified(ctx: ReplicaContext, items: readonly Written[]): VerifiedEntry[] {
  return items.map((item) => {
    const outcome = verifyEntry(item.entry, ctx);
    assert.equal(outcome.status, 'verified');
    return (outcome as { entry: VerifiedEntry }).entry;
  });
}

interface MakeOptions { earlier?: readonly Written[][]; project?: string; digest?: boolean; signer?: string; tipFrom?: 'plain' | 'nested' }

// Builds the checkpoint a correct hub would sign for the covered entries: heads per writer per stream, count, and the order tip of the final order
// (sort the first covered set, then the part of each later one that is new). The order is built here with plain sorts, not with checkpointOrder.
function makeCheckpoint(setupValue: Setup, covered: readonly Written[], options: MakeOptions = {}): Checkpoint {
  const { world, ctx, hub } = setupValue;
  const entries = verified(ctx, covered);
  const done = new Set<string>();
  const ordered: VerifiedEntry[] = [];
  for (const group of [...(options.earlier ?? []), covered]) {
    const members = verified(ctx, group).filter((entry) => !done.has(entry.hash));
    for (const entry of totalOrder(options.tipFrom === 'plain' ? entries : members)) {
      if (done.has(entry.hash)) continue;
      done.add(entry.hash);
      ordered.push(entry);
    }
    if (options.tipFrom === 'plain') break;
  }
  const digests = foldEntries(sealed(...covered), ctx).digests;
  const streams = [...new Set(entries.map((entry) => entry.header.stream))].sort().map((stream) => {
    const heads = new Map<string, Dep>();
    for (const entry of entries.filter((candidate) => candidate.header.stream === stream)) {
      const known = heads.get(entry.header.writer);
      if (known === undefined || known.seq < entry.header.seq) heads.set(entry.header.writer, { writer: entry.header.writer, seq: entry.header.seq, hash: entry.hash });
    }
    const hashes = ordered.filter((entry) => entry.header.stream === stream).map((entry) => entry.hash);
    return {
      stream,
      heads: [...heads.values()].sort((x, y) => (x.writer < y.writer ? -1 : 1)),
      count: hashes.length,
      orderTip: orderTipOf(hashes),
      ...(options.digest === false ? {} : { digest: digests[stream] })
    };
  });
  return { type: 'checkpoint', v: 1, project: options.project ?? PROJECT, signer: options.signer ?? hub.writer, rosterHead: world.rosterHash, streams };
}

const sign = (setupValue: Setup, checkpoint: Checkpoint): SignedCheckpoint => signCheckpoint(setupValue.hub.signer, checkpoint);

test('a checkpoint signed by the hub device verifies, signing again gives the same bytes, and the hash is stable', () => {
  const s = setup();
  const checkpoint = makeCheckpoint(s, s.a.slice(0, 2));
  const signed = sign(s, checkpoint);
  assert.equal(signed.purpose, 'staff-replica');
  assert.equal(signed.signedAt, REPLICA_SIGNED_AT);
  const verdict = verifyCheckpoint(signed, s.ctx.roster);
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.deepEqual(verdict.checkpoint, checkpoint);
    assert.equal(verdict.hash, checkpointHash(signed));
  }
  assert.equal(sign(s, checkpoint).sig, signed.sig);
  assert.match(checkpointHash(signed), /^[0-9a-f]{64}$/);
});

test('one changed count fails with bad-signature, and a changed signer name fails as an unknown signer', () => {
  const s = setup();
  const signed = sign(s, makeCheckpoint(s, s.a.slice(0, 2)));
  const changed = { ...signed, payload: { ...signed.payload, streams: signed.payload.streams.map((stream) => ({ ...stream, count: stream.count + 1 })) } };
  const verdict = verifyCheckpoint(changed, s.ctx.roster);
  assert.deepEqual(verdict.ok ? 'ok' : verdict.reason, 'bad-signature');
  const renamed = { ...signed, payload: { ...signed.payload, signer: s.world.writerOf('A') } };
  assert.deepEqual((verifyCheckpoint(renamed, s.ctx.roster) as { reason: string }).reason, 'bad-signature');
  const stranger = { ...signed, payload: { ...signed.payload, signer: 'f'.repeat(64) } };
  assert.deepEqual((verifyCheckpoint(stranger, s.ctx.roster) as { reason: string }).reason, 'unknown-signer');
  for (const reason of Object.keys(CHECKPOINT_REFUSALS)) assert.ok(!CHECKPOINT_REFUSALS[reason as keyof typeof CHECKPOINT_REFUSALS].includes('—'));
});

test('a signer the roster does not allow to sign checkpoints fails with not-a-checkpoint-signer, even with a good signature', () => {
  const s = setup();
  const writer = fixedSigner('A');
  const checkpoint = makeCheckpoint(s, s.a.slice(0, 2), { signer: writer.writer });
  const signed = signCheckpoint(writer.signer, checkpoint);
  const verdict = verifyCheckpoint(signed, s.ctx.roster);
  assert.equal(verdict.ok, false);
  assert.equal((verdict as { reason: string }).reason, 'not-a-checkpoint-signer');
  // A signer that signs for someone else is refused when signing, not later.
  assert.throws(() => signCheckpoint(writer.signer, makeCheckpoint(s, s.a.slice(0, 2))), /different signer/);
});

test('a header signed as an envelope is not a checkpoint, and a checkpoint is not an entry header', () => {
  const s = setup();
  const signed = sign(s, makeCheckpoint(s, s.a.slice(0, 2)));
  const { sig: _sig, ...unsignedHeader } = s.a[0].entry.header;
  const headerEnvelope = signPayload(s.hub.signer, 'staff-replica', unsignedHeader, { now: () => new Date(REPLICA_SIGNED_AT) });
  assert.equal((verifyCheckpoint(headerEnvelope, s.ctx.roster) as { reason: string }).reason, 'not-a-checkpoint');
  assert.equal((verifyCheckpoint(s.a[0].entry.header, s.ctx.roster) as { reason: string }).reason, 'malformed');
  assert.equal((verifyCheckpoint({ ...signed, payload: { ...signed.payload, extra: 1 } }, s.ctx.roster) as { reason: string }).reason, 'malformed');
  for (const asHeader of [signed, signed.payload, { ...signed.payload, sig: signed.sig }]) {
    // A checkpoint carries v 1 and no header keys, so it is refused at the header shape (as an unreadable or an unknown version, never as an entry).
    const outcome = verifyEntry({ header: asHeader, body: '' }, s.ctx);
    assert.equal(outcome.status, 'rejected');
    assert.match((outcome as { reason: string }).reason, /header/);
  }
  const folded = foldEntries([{ header: { ...signed.payload, sig: signed.sig }, body: '' }], s.ctx);
  assert.equal(folded.rejected.length, 1);
  assert.deepEqual([folded.applied, folded.order], [[], []]);
});

test('hostile input to verifyCheckpoint is refused without throwing', () => {
  const s = setup();
  for (const hostile of [undefined, null, 7, 'text', [], {}, { payload: null }, { v: 1, purpose: 'staff-replica', signer: {}, signedAt: '', payload: { type: 'checkpoint' }, sig: 1 }]) {
    assert.equal(verifyCheckpoint(hostile, s.ctx.roster).ok, false);
  }
});

test('order covered by a checkpoint is final: a late entry that sorts inside the prefix is placed after it, and isFinal says so', () => {
  const s = setup();
  const covered = s.a.slice(0, 3);
  const signed = sign(s, makeCheckpoint(s, covered));
  const finals = new Map<string, boolean>();
  const observer = { ...textReducer, apply: (state: Parameters<typeof textReducer.apply>[0], entry: VerifiedEntry, view: FoldView) => { finals.set(entry.hash, view.isFinal(entry.hash)); return textReducer.apply(state, entry, view); } };
  const everything = [...s.a, ...s.c];
  const without = foldEntries(sealed(...everything), s.ctx);
  const withCheckpoint = foldEntries(sealed(...everything), s.ctx, { checkpoints: [signed], reducers: [observer] });
  // Without the checkpoint the late C entries sort among A's.
  assert.ok(without.order.indexOf(s.c[1].hash) < without.order.indexOf(s.a[2].hash));
  assert.equal(without.checkpoint, null);
  assert.deepEqual(withCheckpoint.order.slice(0, 3), covered.map((item) => item.hash));
  for (const late of [s.c[0], s.c[1], s.a[3]]) assert.ok(withCheckpoint.order.indexOf(late.hash) >= 3);
  assert.deepEqual(withCheckpoint.order.slice(3), totalOrder(verified(s.ctx, [s.c[0], s.c[1], s.a[3]])).map((entry) => entry.hash));
  assert.equal(withCheckpoint.checkpoint, checkpointHash(signed));
  for (const item of covered) assert.equal(finals.get(item.hash), true);
  for (const item of [s.c[0], s.c[1], s.a[3]]) assert.equal(finals.get(item.hash), false);
  assert.deepEqual(withCheckpoint.checkpointConflicts, []);
  // The same entries still give the same set of texts; only the numbering of what sorts first changes.
  assert.equal((withCheckpoint.families.doc as ProductTextOutput[])[0].text, (without.families.doc as ProductTextOutput[])[0].text);
});

test('nested checkpoints order the fold as sort(first), sort(second minus first), sort(rest), whatever order the caller lists them in', () => {
  const s = setup();
  const first = makeCheckpoint(s, s.a.slice(0, 2));
  const second = makeCheckpoint(s, s.a.slice(0, 3), { earlier: [s.a.slice(0, 2)] });
  const signedFirst = sign(s, first);
  const signedSecond = sign(s, second);
  const everything = [...s.a, ...s.c];
  const forward = foldEntries(sealed(...everything), s.ctx, { checkpoints: [signedFirst, signedSecond] });
  const backward = foldEntries(sealed(...everything), s.ctx, { checkpoints: [signedSecond, signedFirst] });
  assert.deepEqual(forward.order, backward.order);
  assert.equal(forward.checkpoint, checkpointHash(signedSecond));
  assert.deepEqual(forward.order.slice(0, 3), s.a.slice(0, 3).map((item) => item.hash));
  assert.deepEqual(forward.checkpointConflicts, []);
  // Covered sets are the closure of the heads.
  const graph = buildCausalGraph(verified(s.ctx, everything));
  assert.equal(checkpointCoverage(second, graph).size, 3);
});

test('a checkpoint that does not nest with the chain used is reported and not used, whatever order the caller lists them in', () => {
  const s = setup();
  const signedA = sign(s, makeCheckpoint(s, s.a.slice(0, 2)));
  const signedC = sign(s, makeCheckpoint(s, s.c));
  const everything = [...s.a, ...s.c];
  const forward = foldEntries(sealed(...everything), s.ctx, { checkpoints: [signedA, signedC] });
  const backward = foldEntries(sealed(...everything), s.ctx, { checkpoints: [signedC, signedA] });
  assert.equal(forward.checkpoint, backward.checkpoint);
  assert.deepEqual(forward.checkpointConflicts, backward.checkpointConflicts);
  assert.equal(forward.checkpointConflicts.length, 1);
  assert.equal(forward.checkpointConflicts[0].reason, 'does-not-nest');
  assert.notEqual(forward.checkpointConflicts[0].checkpoint, forward.checkpoint);
  assert.deepEqual(forward.order, backward.order);
});

test('recomputing from the entries reproduces count, order tip and digest, and names a wrong order tip or a wrong digest', () => {
  const s = setup();
  const covered = s.a.slice(0, 3);
  const checkpoint = makeCheckpoint(s, covered);
  const entries = verified(s.ctx, [...s.a, ...s.c]);
  const digests = foldEntries(sealed(...covered), s.ctx).digests;
  assert.deepEqual(recomputeCheckpoint(checkpoint, entries, digests), { ok: true, mismatches: [] });
  // Order tip computed over a different order (a late entry slotted into the prefix).
  const wrongOrder = makeCheckpoint(s, covered, { tipFrom: 'plain' });
  assert.equal(recomputeCheckpoint(wrongOrder, entries, digests).ok, true, 'plain and nested orders agree when nothing is late');
  const reversed = { ...checkpoint, streams: checkpoint.streams.map((stream) => ({ ...stream, orderTip: orderTipOf(covered.map((item) => item.hash).reverse()) })) };
  const tipResult = recomputeCheckpoint(reversed, entries, digests);
  assert.deepEqual(tipResult.mismatches.map((mismatch) => mismatch.reason), ['order-tip-mismatch']);
  const wrongDigest = { ...checkpoint, streams: checkpoint.streams.map((stream) => ({ ...stream, digest: '0'.repeat(64) })) };
  assert.deepEqual(recomputeCheckpoint(wrongDigest, entries, digests).mismatches.map((mismatch) => mismatch.reason), ['digest-mismatch']);
  const wrongCount = { ...checkpoint, streams: checkpoint.streams.map((stream) => ({ ...stream, count: stream.count + 2 })) };
  assert.deepEqual(recomputeCheckpoint(wrongCount, entries, digests).mismatches.map((mismatch) => mismatch.reason), ['count-mismatch']);
  // Entries that are not here yet: nothing can be checked.
  const missing = recomputeCheckpoint(checkpoint, entries.slice(0, 1), digests);
  assert.deepEqual([missing.ok, missing.mismatches.map((mismatch) => mismatch.reason)], [false, ['missing-entries']]);
});

test('two checkpoints from one signer with equal counts and different order tips are a proof without entries', () => {
  const s = setup();
  const good = makeCheckpoint(s, s.a.slice(0, 2));
  const forked = { ...good, streams: good.streams.map((stream) => ({ ...stream, orderTip: orderTipOf(s.a.slice(0, 2).map((item) => item.hash).reverse()) })) };
  const signedGood = sign(s, good);
  const signedForked = sign(s, forked);
  const proof = checkpointConflict(signedGood, signedForked);
  assert.ok(proof !== undefined);
  assert.equal(proof?.reason, 'equal-count-tip-mismatch');
  assert.equal(proof?.stream, good.streams[0].stream);
  // Both signatures verify, so the pair convinces a third party.
  assert.equal(verifyCheckpoint(proof?.a, s.ctx.roster).ok, true);
  assert.equal(verifyCheckpoint(proof?.b, s.ctx.roster).ok, true);
  // Another signer's checkpoint is no proof against this one.
  assert.equal(checkpointConflict(signedGood, signCheckpoint(fixedSigner('A').signer, { ...forked, signer: s.world.writerOf('A') })), undefined);
});

test('a later checkpoint whose ordered prefix does not reproduce the earlier tip is a proof with entries; nested, consistent checkpoints give none', () => {
  const s = setup();
  const everything = verified(s.ctx, [...s.a, ...s.c]);
  const early = sign(s, makeCheckpoint(s, s.a.slice(0, 2)));
  // The honest later checkpoint nests after the earlier one.
  const honest = sign(s, makeCheckpoint(s, [...s.a.slice(0, 3), ...s.c], { earlier: [s.a.slice(0, 2)] }));
  assert.equal(checkpointConflict(early, honest, everything), undefined);
  assert.equal(checkpointConflict(honest, early, everything), undefined);
  // A dishonest one sorts the whole covered set again, so the late C entries slot inside the earlier prefix.
  const dishonest = sign(s, makeCheckpoint(s, [...s.a.slice(0, 3), ...s.c], { tipFrom: 'plain' }));
  const proof = checkpointConflict(early, dishonest, everything);
  assert.equal(proof?.reason, 'prefix-mismatch');
  assert.equal(checkpointConflict(dishonest, early, everything)?.reason, 'prefix-mismatch');
  // A later checkpoint that does not cover everything the earlier one covered.
  const broken = sign(s, makeCheckpoint(s, [s.a[0], ...s.c, s.a[1]]));
  const wider = sign(s, makeCheckpoint(s, s.a.slice(0, 3)));
  assert.equal(checkpointConflict(broken, wider, everything)?.reason, 'not-nested');
  // Without enough entries nothing can be judged.
  assert.equal(checkpointConflict(early, dishonest, everything.slice(0, 1)), undefined);
});
