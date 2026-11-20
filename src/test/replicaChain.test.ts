// Chain rules (plan 30-05, D-08, D-12, D-13): a changed old entry breaks only its writer's chain, withholding is reported, the lamport and roster
// citation rules hold, and entries dated too far ahead wait for the injected clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyChains, withholdingReport } from '../domain/replica/chain';
import type { RefusedPlace } from '../domain/replica/chain';
import { GENESIS_PREV } from '../domain/replica/entry';
import type { SealedEntry } from '../domain/replica/entry';
import { canonicalProof, findEquivocations, quarantineRecords } from '../domain/replica/equivocation';
import { addEntries, createFoldState, foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { integrityReducer } from '../domain/replica/integrityFold';
import { staticRosterView } from '../domain/replica/rosterView';
import type { ReplicaContext } from '../domain/replica/rosterView';
import { verifyEntry } from '../domain/replica/verify';
import type { VerifiedEntry } from '../domain/replica/verify';
import { forkAt, futureEntry, tamperHeader } from './helpers/replicaForks';
import { textReducer } from '../domain/replica/textFold';
import { WORLD_AT, WORLD_NOW, createWorld, permutations, rng, shuffled } from './helpers/replicaWorld';
import type { World, Written } from './helpers/replicaWorld';

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

// Forks with three or more branches (31-06, D-01 (b), WR-03, D-20). W writes seq 0, then `count` different headers at seq 1 that all follow seq 0,
// and two later entries chained on every branch. X writes one entry. A line is a branch header and its two later entries.
interface Branched { world: World; w0: Written; x0: Written; lines: Written[][] }

// The next entry of W's log after the given one, on that entry's branch.
const after = (world: World, parent: Written): Written => world.writeRaw('W', {
  stream: parent.stream, seq: parent.seq + 1, prev: parent.hash,
  body: { deps: [], roster: world.rosterHash, lamport: parent.lamport + 1, at: WORLD_AT, actor: { kind: 'person' }, ...reg() }
});

function branchedWorld(count: number): Branched {
  const world = createWorld({ members: MEMBERS });
  const w0 = world.write('W', reg());
  const x0 = world.write('X', reg());
  const heads = [world.write('W', reg()), ...Array.from({ length: count - 1 }, () => forkAt(world, 'W', world.stream, 1, reg()))];
  const lines = heads.map((head) => {
    const one = after(world, head);
    return [head, one, after(world, one)];
  });
  return { world, w0, x0, lines };
}

const hashesOf = (items: readonly Written[]): string[] => items.map((item) => item.hash).sort();
const choose = (world: World, seq: number, hash: string): ReplicaContext => world.ctx({ roster: staticRosterView({ ...world.rosterSpec, chosenBranches: [{ writer: world.writerOf('W'), stream: world.stream, seq, hash }] }) });
const REDUCERS = { reducers: [textReducer, integrityReducer] };

// The same set in chunks of three through the incremental fold, starting with the later entries (held until their branch header arrives).
function chunked(ctx: ReplicaContext, entries: readonly SealedEntry[]): FoldResult {
  let state = createFoldState(ctx, REDUCERS);
  for (let from = 0; from < entries.length; from += 3) state = addEntries(state, entries.slice(from, from + 3));
  return state.result;
}

function sameOutcome(result: FoldResult, reference: FoldResult, label: string): void {
  assert.deepEqual(result.excluded, reference.excluded, label);
  assert.deepEqual([...result.applied].sort(), [...reference.applied].sort(), label);
  assert.deepEqual(result.quarantined, reference.quarantined, label);
  assert.deepEqual(result.proofs, reference.proofs, label);
  assert.deepEqual(result.held, reference.held, label);
  assert.deepEqual(result.digests, reference.digests, label);
}

// Every choice of branch, in every delivery order of the fork headers, from scratch and in chunks: the chosen line is applied, every other line
// is excluded, and the quarantine is lifted.
function checkEveryChoice(count: number): number {
  const { world, w0, x0, lines } = branchedWorld(count);
  const heads = lines.map((line) => line[0]);
  const later = lines.flatMap((line) => line.slice(1));
  let folds = 0;
  for (const [index, line] of lines.entries()) {
    const ctx = choose(world, 1, line[0].hash);
    const others = lines.filter((_, other) => other !== index).flat();
    const reference = foldEntries(world.entries, ctx, REDUCERS);
    assert.deepEqual(reference.quarantined, [], `branch ${index} chosen`);
    assert.deepEqual(reference.excluded, hashesOf(others), `branch ${index} chosen`);
    assert.deepEqual([...reference.applied].sort(), hashesOf([w0, x0, ...line]), `branch ${index} chosen`);
    assert.deepEqual(reference.held, []);
    // Every seq where the lines differ is a slot with two or more signed headers, so seq 2 and 3 have proofs too; the release resolves them all.
    assert.deepEqual(reference.proofs.map((proof) => proof.a.seq).sort(), [1, 2, 3]);
    const atFork = reference.proofs.filter((proof) => proof.a.seq === 1);
    assert.deepEqual(atFork[0].branches, hashesOf(heads), 'the proof lists every branch at the slot');
    assert.deepEqual(reference.proofs.find((proof) => proof.a.seq === 3)?.branches, hashesOf(lines.map((each) => each[2])));
    for (const order of permutations(heads)) {
      sameOutcome(foldEntries(sealed(w0, x0, ...order, ...later), ctx, REDUCERS), reference, `branch ${index}, from scratch`);
      sameOutcome(chunked(ctx, sealed(...[...later].reverse(), ...order, x0, w0)), reference, `branch ${index}, in chunks`);
      folds += 2;
    }
  }
  return folds;
}

test('a three-branch fork: a release naming any branch admits it and its later entries and excludes the others, in all 6 orders, from scratch and in chunks', () => {
  assert.equal(checkEveryChoice(3), 3 * 6 * 2);
});

test('a four-branch fork: a release naming any of the four branches resolves it the same way in all 24 orders, from scratch and in chunks', () => {
  assert.equal(checkEveryChoice(4), 4 * 24 * 2);
});

test('with no choice, or a choice that is not a branch at the fork seq, every branch from the fork seq on stays excluded and the writer quarantined', () => {
  const { world, w0, x0, lines } = branchedWorld(4);
  const writer = world.writerOf('W');
  const quarantined = [{ writer, stream: world.stream, fromSeq: 1 }];
  for (const ctx of [world.ctx(), choose(world, 1, 'e'.repeat(64)), choose(world, 1, w0.hash), choose(world, 2, lines[3][1].hash)]) {
    const result = foldEntries(world.entries, ctx, REDUCERS);
    assert.deepEqual(result.quarantined, quarantined);
    assert.deepEqual(result.excluded, hashesOf(lines.flat()));
    assert.deepEqual([...result.applied].sort(), hashesOf([w0, x0]));
    for (const order of permutations(lines.map((line) => line[0]))) {
      const again = foldEntries(sealed(x0, ...order, ...lines.flatMap((line) => line.slice(1)), w0), ctx, REDUCERS);
      assert.deepEqual([again.quarantined, again.excluded], [quarantined, result.excluded]);
    }
  }
});

test('a carried proof of two branches, then the third branch arriving: a release naming the third resolves the fork, in every arrival order', () => {
  const { world, w0, x0, lines } = branchedWorld(3);
  const [line0, line1, line2] = lines;
  const writer = world.writerOf('W');
  // X saw branches 0 and 1 and sent the proof as an entry. This machine never receives branch 1.
  const carried = canonicalProof(line0[0].entry.header, line1[0].entry.header, world.signerOf('W').publicKey);
  const proofEntry = world.write('X', { kind: 'equivocation.proof', data: carried });
  const ctx = choose(world, 1, line2[0].hash);

  // Before the third branch arrives this machine knows of branches 0 and 1 only: the choice names no branch it knows, so the writer stays quarantined.
  const before = foldEntries(sealed(w0, x0, ...line0, proofEntry), ctx, REDUCERS);
  assert.deepEqual(before.quarantined, [{ writer, stream: world.stream, fromSeq: 1 }]);
  assert.deepEqual(before.excluded, hashesOf(line0));

  const machine = sealed(w0, x0, ...line0, proofEntry, ...line2);
  const reference = foldEntries(machine, ctx, REDUCERS);
  assert.deepEqual(reference.quarantined, [], 'the release of the third branch resolves the fork');
  assert.deepEqual(reference.excluded, hashesOf(line0));
  assert.deepEqual([...reference.applied].sort(), hashesOf([w0, x0, proofEntry, ...line2]));
  const atFork = reference.proofs.filter((proof) => proof.a.seq === 1);
  assert.equal(atFork.length, 2, 'the fork this machine found (0 and 2) and the carried proof (0 and 1)');
  for (const proof of atFork) assert.deepEqual(proof.branches, hashesOf([line0[0], line1[0], line2[0]]), 'each proof lists every branch known at the slot');
  assert.deepEqual(reference.proofs.map((proof) => proof.a.seq).sort(), [1, 1, 2, 3], 'lines 0 and 2 differ at seq 2 and 3 as well');

  // The incremental fold that held the proof first and then gets the third branch gives the same result.
  const late = addEntries(createFoldState(ctx, REDUCERS), sealed(w0, x0, ...line0, proofEntry));
  assert.deepEqual(late.result.quarantined, before.quarantined);
  sameOutcome(addEntries(late, sealed(...line2)).result, reference, 'the third branch arriving after the proof');

  // Every order of the proof and the two branch headers, one entry at a time, then the later entries.
  let count = 0;
  for (const order of permutations(sealed(proofEntry, line0[0], line2[0]))) {
    let state = createFoldState(ctx, REDUCERS);
    for (const entry of [...sealed(w0, x0), ...order, ...sealed(line0[1], line0[2], line2[1], line2[2])]) state = addEntries(state, [entry]);
    sameOutcome(state.result, reference, 'one at a time');
    sameOutcome(foldEntries([...order, ...sealed(x0, line2[2], line0[2], line2[1], line0[1], w0)], ctx, REDUCERS), reference, 'from scratch');
    count += 1;
  }
  assert.equal(count, 6);
  for (const seed of [11, 12, 13, 14]) sameOutcome(foldEntries(shuffled(machine, rng(seed)), ctx, REDUCERS), reference, `seed ${seed}`);

  // A machine that holds every branch and the proof entry excludes branch 1 as well and applies the same entries.
  const everything = foldEntries(world.entries, ctx, REDUCERS);
  assert.deepEqual(everything.quarantined, []);
  assert.deepEqual(everything.excluded, hashesOf([...line0, ...line1]));
  assert.deepEqual([...everything.applied].sort(), [...reference.applied].sort());
});

const chooseMany = (world: World, choices: ReadonlyArray<[number, string]>): ReplicaContext => world.ctx({
  roster: staticRosterView({ ...world.rosterSpec, chosenBranches: choices.map(([seq, hash]) => ({ writer: world.writerOf('W'), stream: world.stream, seq, hash })) })
});

test('after a release, a new fork on the kept branch needs its own choice, and a later choice of a set-aside branch lifts nothing', () => {
  const { world, w0, x0, lines } = branchedWorld(3);
  const [line0, line1, line2] = lines;
  // A second header at seq 2 that also follows the kept branch: a new fork on the kept history, not a leftover of the first one.
  const sibling = forkAt(world, 'W', world.stream, 2, reg());
  assert.equal(sibling.entry.header.prev, line0[0].hash);
  const setAside = hashesOf([...line1, ...line2]);
  const quarantinedAt2 = [{ writer: world.writerOf('W'), stream: world.stream, fromSeq: 2 }];

  const once = foldEntries(world.entries, choose(world, 1, line0[0].hash), REDUCERS);
  assert.deepEqual(once.quarantined, quarantinedAt2, 'two branches follow the kept one at seq 2');
  assert.deepEqual(once.excluded, [...setAside, ...hashesOf([line0[1], line0[2], sibling])].sort());
  assert.deepEqual([...once.applied].sort(), hashesOf([w0, x0, line0[0]]));

  const keepSibling = foldEntries(world.entries, chooseMany(world, [[1, line0[0].hash], [2, sibling.hash]]), REDUCERS);
  assert.deepEqual(keepSibling.quarantined, []);
  assert.deepEqual(keepSibling.excluded, [...setAside, ...hashesOf([line0[1], line0[2]])].sort());
  assert.deepEqual([...keepSibling.applied].sort(), hashesOf([w0, x0, line0[0], sibling]));

  const keepLine = foldEntries(world.entries, chooseMany(world, [[1, line0[0].hash], [2, line0[1].hash]]), REDUCERS);
  assert.deepEqual(keepLine.quarantined, []);
  assert.deepEqual(keepLine.excluded, [...setAside, sibling.hash].sort());
  assert.deepEqual([...keepLine.applied].sort(), hashesOf([w0, x0, ...line0]));

  // Forbidden: a choice at seq 2 of a branch that follows a set-aside line is not a way out of the new fork.
  const contradicting = foldEntries(world.entries, chooseMany(world, [[1, line0[0].hash], [2, line1[1].hash]]), REDUCERS);
  assert.deepEqual(contradicting.quarantined, quarantinedAt2);
  assert.deepEqual(contradicting.excluded, once.excluded);
});

test('a release of a branch with no later entries resolves the fork while the set-aside branches go on and fork among themselves, in all 24 orders', () => {
  const world = createWorld({ members: MEMBERS });
  const w0 = world.write('W', reg());
  const x0 = world.write('X', reg());
  const [h0, h1, h2] = [world.write('W', reg()), forkAt(world, 'W', world.stream, 1, reg()), forkAt(world, 'W', world.stream, 1, reg())];
  const l1a = after(world, h1);
  const l1b = after(world, h1);
  const l2a = after(world, h2);
  const ctx = choose(world, 1, h0.hash);
  const setAside = hashesOf([h1, h2, l1a, l1b, l2a]);

  const before = foldEntries(world.entries, ctx, REDUCERS);
  assert.deepEqual(before.quarantined, [], 'no branch at seq 2 follows the kept one, so nothing there needs a choice');
  assert.deepEqual(before.excluded, setAside);
  assert.deepEqual([...before.applied].sort(), hashesOf([w0, x0, h0]));

  // The kept branch goes on: its seq 2 is the only branch there that follows it, and it is applied.
  const next = after(world, h0);
  const reference = foldEntries(world.entries, ctx, REDUCERS);
  assert.deepEqual(reference.quarantined, []);
  assert.deepEqual(reference.excluded, setAside);
  assert.deepEqual([...reference.applied].sort(), hashesOf([w0, x0, h0, next]));
  let count = 0;
  for (const order of permutations(sealed(next, l1a, l1b, l2a))) {
    sameOutcome(foldEntries([...sealed(w0, x0, h1, h0, h2), ...order], ctx, REDUCERS), reference, 'from scratch');
    count += 1;
  }
  assert.equal(count, 24);
  // Without the release the writer is quarantined from the first fork, as before.
  assert.deepEqual(foldEntries(world.entries, world.ctx(), REDUCERS).quarantined, [{ writer: world.writerOf('W'), stream: world.stream, fromSeq: 1 }]);
});

test('a later fork whose branches cannot be traced back to the release keeps the quarantine; given the headers between, the release covers it', () => {
  const { world, lines } = branchedWorld(3);
  const [line0, line1, line2] = lines;
  const roster = choose(world, 1, line0[0].hash).roster;
  const verifiedLike = (items: readonly Written[]): Array<{ hash: string; header: SealedEntry['header'] }> => items.map((item) => ({ hash: item.hash, header: item.entry.header }));
  // Proofs of the fork at seq 1 and of the set-aside lines at seq 3 only: nothing says where the seq 3 headers come from.
  const proofs = [...findEquivocations(verifiedLike([line0[0], line1[0], line2[0]]), roster), ...findEquivocations(verifiedLike([line1[2], line2[2]]), roster)];
  assert.deepEqual(proofs.map((proof) => proof.a.seq).sort(), [1, 3]);
  const writer = world.writerOf('W');
  assert.deepEqual(quarantineRecords(proofs, roster), [{ writer, stream: world.stream, fromSeq: 3 }], 'doubt keeps the quarantine');
  const between = new Map([line1[1], line2[1]].map((item) => [item.hash, item.entry.header]));
  assert.deepEqual(quarantineRecords(proofs, roster, between), [], 'both seq 3 branches follow set-aside lines');
  // With a third seq 3 header on the kept line the slot has one live branch, still resolved. Every header of the slot is held here, as in the chain
  // stage; a branch known by its hash alone would count as possibly kept.
  const kept = findEquivocations(verifiedLike([line0[2], line1[2], line2[2]]), roster);
  const withKept = new Map([line0[1], line1[1], line2[1], line0[2], line1[2], line2[2]].map((item) => [item.hash, item.entry.header]));
  assert.deepEqual(quarantineRecords([...proofs.filter((proof) => proof.a.seq === 1), ...kept], roster, withKept), []);
  assert.deepEqual(quarantineRecords([...proofs.filter((proof) => proof.a.seq === 1), ...kept], world.ctx().roster, withKept), [{ writer, stream: world.stream, fromSeq: 1 }], 'no release: quarantined from the first fork');
});
