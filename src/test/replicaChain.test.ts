// Chain rules (plan 30-05, D-08, D-12, D-13): a changed old entry breaks only its writer's chain, withholding is reported, the lamport and roster
// citation rules hold, and entries dated too far ahead wait for the injected clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyChains, withholdingReport } from '../domain/replica/chain';
import type { RefusedPlace } from '../domain/replica/chain';
import { GENESIS_PREV } from '../domain/replica/entry';
import type { SealedEntry } from '../domain/replica/entry';
import { foldEntries } from '../domain/replica/fold';
import { staticRosterView } from '../domain/replica/rosterView';
import type { ReplicaContext } from '../domain/replica/rosterView';
import { verifyEntry } from '../domain/replica/verify';
import type { VerifiedEntry } from '../domain/replica/verify';
import { forkAt, futureEntry, tamperHeader } from './helpers/replicaForks';
import { WORLD_NOW, createWorld, rng, shuffled } from './helpers/replicaWorld';
import type { Written } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';
const MEMBERS = [
  { member: 'mbr-wwww', name: 'Wren', devices: ['W'] },
  { member: 'mbr-xxxx', name: 'Xia', devices: ['X'] },
  { member: 'mbr-yyyy', name: 'Yan', devices: ['Y'] }
];

let nextClient = 100;
// Plain registrations stand in for any entry: every one has its own client id so no two collide.
const reg = (): { kind: string; data: unknown } => {
  nextClient += 1;
  return { kind: 'doc.client', data: { product: PRODUCT, clientId: nextClient, actor: { kind: 'person' } } };
};
const sealed = (...items: Written[]): SealedEntry[] => items.map((item) => item.entry);

// What the fold's own first stage gives the chain stage: the verified entries, and the places of the entries refused before it.
function verifyAll(ctx: ReplicaContext, entries: readonly SealedEntry[]): { verified: VerifiedEntry[]; refused: RefusedPlace[] } {
  const verified: VerifiedEntry[] = [];
  const refused: RefusedPlace[] = [];
  for (const entry of entries) {
    const outcome = verifyEntry(entry, ctx);
    if (outcome.status === 'verified') verified.push(outcome.entry);
    else if (outcome.status === 'rejected' && outcome.header !== undefined) refused.push({ stream: outcome.header.stream, writer: outcome.header.writer, seq: outcome.header.seq });
  }
  return { verified, refused };
}

const reasonOf = (list: Array<{ hash?: string; reason: string }>, item: Written): string | undefined => list.find((record) => record.hash === item.hash)?.reason;

test('a changed old entry is rejected bad-signature, its writer\'s later entries are held chain-broken, and every other writer is applied as before', () => {
  const world = createWorld({ members: MEMBERS });
  const w = [0, 1, 2, 3].map(() => world.write('W', reg()));
  const x = [0, 1].map(() => world.write('X', reg()));
  const ctx = world.ctx();
  const tampered = tamperHeader(w[1].entry, { epoch: 1 });

  const result = foldEntries([w[0].entry, tampered, w[2].entry, w[3].entry, ...sealed(...x)], ctx);
  assert.deepEqual(result.rejected.map((record) => record.reason), ['bad-signature']);
  assert.deepEqual([...result.applied].sort(), [w[0].hash, x[0].hash, x[1].hash].sort());
  assert.deepEqual(result.held.filter((record) => record.stage === 'chain').map((record) => record.hash).sort(), [w[2].hash, w[3].hash].sort());
  // The fold itself passes the refused places on (plan 30-12), so its own output labels them chain-broken, not missing-predecessor.
  assert.deepEqual(result.held.filter((record) => record.stage === 'chain').map((record) => record.reason), ['chain-broken', 'chain-broken']);
  const without = foldEntries([w[0].entry, ...sealed(...x)], ctx);
  assert.deepEqual(result.digests, without.digests, 'the others\' stream digest equals a fold without the broken writer\'s later entries');

  // Given the place of the refused entry, the chain labels the rest of that writer's log chain-broken, and only that writer's.
  const { verified, refused } = verifyAll(ctx, [w[0].entry, tampered, w[2].entry, w[3].entry, ...sealed(...x)]);
  assert.deepEqual(refused, [{ stream: world.stream, writer: w[1].writer, seq: 1 }]);
  const chain = classifyChains(verified, ctx, refused);
  assert.equal(reasonOf(chain.held, w[2]), 'chain-broken');
  assert.equal(reasonOf(chain.held, w[3]), 'chain-broken');
  assert.deepEqual(chain.admitted.map((entry) => entry.hash).sort(), [w[0].hash, x[0].hash, x[1].hash].sort());
  // Without that information the same entries are only missing a predecessor, and a good copy arriving heals both cases.
  assert.equal(reasonOf(classifyChains(verified, ctx).held, w[2]), 'missing-predecessor');
  const healed = foldEntries(world.entries, ctx);
  assert.equal(healed.applied.length, 6);
});

test('withholding: a cited entry that never arrived is reported with the highest seq held, the cited seq and the count missing', () => {
  const world = createWorld({ members: MEMBERS });
  const w = [0, 1, 2, 3, 4].map(() => world.write('W', reg()));
  const y = world.write('Y', { ...reg(), deps: [w[4]] });
  const ctx = world.ctx();
  const { verified } = verifyAll(ctx, [w[0].entry, w[1].entry, y.entry]);
  const chain = classifyChains(verified, ctx);
  assert.equal(reasonOf(chain.held, y), 'missing-predecessor');
  const citations = [{ stream: y.stream, writer: w[4].writer, seq: 4, hash: w[4].hash }];
  assert.deepEqual(withholdingReport(chain, citations), [{ writer: w[4].writer, stream: world.stream, haveThrough: 1, citedSeq: 4, count: 3 }]);

  // Holding the cited entry itself (but not 2 and 3) leaves two missing; holding everything leaves nothing to report.
  const partial = classifyChains(verifyAll(ctx, [w[0].entry, w[1].entry, w[4].entry, y.entry]).verified, ctx);
  assert.deepEqual(withholdingReport(partial, citations), [{ writer: w[4].writer, stream: world.stream, haveThrough: 1, citedSeq: 4, count: 2 }]);
  const whole = classifyChains(verifyAll(ctx, world.entries).verified, ctx);
  assert.deepEqual(withholdingReport(whole, citations), []);
  // A writer with nothing delivered at all: haveThrough is -1.
  const none = classifyChains(verifyAll(ctx, [y.entry]).verified, ctx);
  assert.deepEqual(withholdingReport(none, citations), [{ writer: w[4].writer, stream: world.stream, haveThrough: -1, citedSeq: 4, count: 5 }]);
});

test('lamport must be exactly one more than the highest predecessor: too high, equal to the predecessor and 2 with no predecessor are rejected bad-lamport', () => {
  const world = createWorld({ members: MEMBERS });
  const body = (lamport: number): { deps: []; roster: string; lamport: number; at: string; actor: { kind: 'person' }; kind: string; data: unknown } => ({ deps: [], roster: world.rosterHash, lamport, at: '2026-11-19T11:00:00.000Z', actor: { kind: 'person' }, ...reg() });
  const w0 = world.write('W', reg());
  const wEqual = world.writeRaw('W', { stream: world.stream, seq: 1, prev: w0.hash, body: body(1) });
  const wAfter = world.writeRaw('W', { stream: world.stream, seq: 2, prev: wEqual.hash, body: body(2) });
  const xFirst = world.writeRaw('X', { stream: world.stream, seq: 0, prev: GENESIS_PREV, body: body(2) });
  const y0 = world.write('Y', reg());
  const yHigh = world.writeRaw('Y', { stream: world.stream, seq: 1, prev: y0.hash, body: body(3) });
  const ctx = world.ctx();
  const { verified, refused } = verifyAll(ctx, world.entries);
  const chain = classifyChains(verified, ctx, refused);
  assert.equal(reasonOf(chain.rejected, wEqual), 'bad-lamport');
  assert.equal(reasonOf(chain.rejected, xFirst), 'bad-lamport');
  assert.equal(reasonOf(chain.rejected, yHigh), 'bad-lamport');
  assert.equal(reasonOf(chain.held, wAfter), 'chain-broken', 'what follows a refused entry of the same log is chain-broken');
  assert.deepEqual(chain.admitted.map((entry) => entry.hash).sort(), [w0.hash, y0.hash].sort());
});

test('static refusals: a first entry that points back, an entry that follows nothing of its own log, and a dep that is not the writer and seq it names', () => {
  const world = createWorld({ members: MEMBERS });
  const w0 = world.write('W', reg());
  const raw = (lamport: number): { deps: []; roster: string; lamport: number; at: string; actor: { kind: 'person' }; kind: string; data: unknown } => ({ deps: [], roster: world.rosterHash, lamport, at: '2026-11-19T11:00:00.000Z', actor: { kind: 'person' }, ...reg() });
  const backward = world.writeRaw('X', { stream: world.stream, seq: 0, prev: 'a'.repeat(64), body: raw(1) });
  const strangerPrev = world.writeRaw('Y', { stream: world.stream, seq: 1, prev: w0.hash, body: raw(2) });
  const genesisPrev = world.writeRaw('Y', { stream: world.stream, seq: 2, prev: GENESIS_PREV, body: raw(1) });
  const wrongSeq = world.write('W', { ...reg(), deps: [{ ...w0, seq: 5 }] });
  const ctx = world.ctx();
  const chain = classifyChains(verifyAll(ctx, world.entries).verified, ctx);
  assert.equal(reasonOf(chain.rejected, backward), 'bad-genesis');
  assert.equal(reasonOf(chain.rejected, strangerPrev), 'bad-prev');
  assert.equal(reasonOf(chain.rejected, genesisPrev), 'bad-prev');
  assert.equal(reasonOf(chain.rejected, wrongSeq), 'bad-dep');
  assert.deepEqual(chain.admitted.map((entry) => entry.hash), [w0.hash]);
});

test('an entry citing a roster older than one in its own past is rejected stale-roster-citation; an entry citing the newer roster is applied', () => {
  const world = createWorld({ members: MEMBERS });
  const marker = world.write('X', reg());
  // R1 is a roster the marker entry stands for: position 1, after the world's own roster.
  const second = staticRosterView({ rosters: [world.rosterSpec.rosters[0], { hash: marker.hash, members: world.rosterSpec.rosters[0].members }] });
  const ctx = world.ctx({ roster: second });
  const stale = world.write('W', { ...reg(), deps: [marker] });
  const fresh = world.write('Y', { ...reg(), deps: [marker], roster: marker.hash });
  const back = world.write('Y', reg());
  const afterStale = world.write('W', { ...reg(), roster: marker.hash });
  const result = foldEntries(world.entries, ctx);
  const chain = classifyChains(verifyAll(ctx, world.entries).verified, ctx);
  assert.equal(reasonOf(chain.rejected, stale), 'stale-roster-citation');
  assert.equal(reasonOf(chain.rejected, back), 'stale-roster-citation', 'cited rosters only move forward along one log too');
  assert.equal(reasonOf(chain.held, afterStale), 'chain-broken');
  assert.deepEqual([...result.applied].sort(), [marker.hash, fresh.hash].sort());
  assert.deepEqual(result.rejected.map((record) => record.reason), ['stale-roster-citation', 'stale-roster-citation']);
});

test('an entry dated more than 10 minutes after the injected now is held future-dated, its followers are held, and both fold once now catches up', () => {
  const world = createWorld({ members: MEMBERS });
  const ahead = futureEntry(world, 'W', 11, reg());
  const next = world.write('W', reg());
  const citing = world.write('X', { ...reg(), deps: [ahead] });
  const early = foldEntries(world.entries, world.ctx());
  assert.equal(reasonOf(early.held, ahead), 'future-dated');
  assert.equal(reasonOf(early.held, next), 'missing-predecessor');
  assert.equal(reasonOf(early.held, citing), 'missing-predecessor');
  assert.deepEqual(early.applied, []);
  const later = foldEntries(world.entries, world.ctx({ now: new Date(Date.parse(WORLD_NOW) + 2 * 60_000) }));
  assert.deepEqual(later.held, []);
  assert.equal(later.applied.length, 3);
  // The same set folded under the same now gives the same answer in any order, and the clock only decides what waits.
  assert.deepEqual(foldEntries([...world.entries].reverse(), world.ctx()).held, early.held);
});

test('the limit is exact: dated 9 or 10 minutes ahead is applied, 10 minutes and a second is held', () => {
  const world = createWorld({ members: MEMBERS });
  const nine = futureEntry(world, 'W', 9, reg());
  const ten = futureEntry(world, 'X', 10, reg());
  const over = futureEntry(world, 'Y', 10 + 1 / 60, reg());
  const result = foldEntries(world.entries, world.ctx());
  assert.deepEqual([...result.applied].sort(), [nine.hash, ten.hash].sort());
  assert.equal(reasonOf(result.held, over), 'future-dated');
});

test('the chain stage is a function of the set: the same entries in any order give the same admitted, held, rejected, excluded and proof lists', () => {
  const world = createWorld({ members: MEMBERS });
  const w = [0, 1, 2].map(() => world.write('W', reg()));
  const fork = forkAt(world, 'W', world.stream, 1, reg());
  const x = [0, 1, 2].map(() => world.write('X', reg()));
  const ahead = futureEntry(world, 'Y', 30, reg());
  const missing = world.write('Y', { ...reg(), deps: [w[2]] });
  const ctx = world.ctx();
  const everything = [...sealed(...w, fork, ...x, ahead, missing)];
  const reference = classifyChains(verifyAll(ctx, everything).verified, ctx);
  assert.equal(reference.proofs.length, 1);
  assert.equal(reasonOf(reference.held, ahead), 'future-dated');
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const shuffledInput = shuffled(everything, rng(seed));
    const result = classifyChains(verifyAll(ctx, shuffledInput).verified, ctx);
    assert.deepEqual(result.admitted.map((entry) => entry.hash), reference.admitted.map((entry) => entry.hash));
    assert.deepEqual([...result.excluded].sort(), [...reference.excluded].sort());
    assert.deepEqual([result.held, result.rejected, result.quarantined, result.proofs], [reference.held, reference.rejected, reference.quarantined, reference.proofs]);
  }
});
