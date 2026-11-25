// Checkpoint format version 2 and late joiners (plan 31-08, D-04, D-42): each head records its lamport and the newest roster in its past, a version 1
// checkpoint still verifies, and a writer's log may start right after a verified version 2 head.
import assert from 'node:assert/strict';
import test from 'node:test';
import { UNATTRIBUTED_WRITER } from '../domain/replica/attribution';
import { classifyChains } from '../domain/replica/chain';
import { CHECKPOINT_VERSION, checkpointBases, checkpointHash, checkpointHeads, orderTipOf, readCheckpoint, signCheckpoint, verifyCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint, CheckpointHead, SignedCheckpoint } from '../domain/replica/checkpoint';
import { applyRemote, applyUpdate, createFoldDoc, docText, encodeFullState, stateVectorOf, textHashOf } from '../domain/replica/doc';
import { sealBlob } from '../domain/replica/entry';
import type { Dep, NewBody, SealedEntry } from '../domain/replica/entry';
import { addEntries, createFoldState, foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { totalOrder } from '../domain/replica/order';
import { staticRosterView } from '../domain/replica/rosterView';
import type { ReplicaContext, StaticRosterSpec } from '../domain/replica/rosterView';
import { verifyEntry } from '../domain/replica/verify';
import type { VerifiedEntry } from '../domain/replica/verify';
import { createWitness } from '../domain/replica/hubWitness';
import type { WitnessState } from '../domain/replica/hubWitness';
import { foldCheckpoints, trustedCheckpointsOf } from '../staff/replica/foldCheckpoints';
import { WORLD_AT, createWorld, fixedSigner, rng, shuffled } from './helpers/replicaWorld';
import type { World, Written } from './helpers/replicaWorld';

const PROJECT = 'project-main';
const WRITERS = ['A', 'B', 'C'] as const;

interface Setup {
  world: World;
  ctx: ReplicaContext;
  spec: StaticRosterSpec;
  hub: ReturnType<typeof fixedSigner>;
  // Every entry in the order it was written.
  all: Written[];
}

// Three writers write `count` entries in turn; each entry after the first cites the one written just before it as a dependency when the seeded coin
// says so, so some entries are concurrent. H is the hub device, the only checkpoint signer.
function setup(count = 30, seed = 31): Setup {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }, { member: 'mbr-bbbb', devices: ['B'] }, { member: 'mbr-cccc', devices: ['C'] }, { member: 'mbr-hhhh', devices: ['H'] }] });
  const hub = fixedSigner('H');
  const spec: StaticRosterSpec = { ...world.rosterSpec, rosters: world.rosterSpec.rosters.map((roster) => ({ ...roster, checkpointSigners: [hub.writer] })) };
  const editors = WRITERS.map((name, index) => world.editor(name, 'intel-estimate', 101 * (index + 1)));
  const registered = new Set<number>();
  const all: Written[] = [];
  let state = seed;
  const coin = (): boolean => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % 3 !== 0;
  };
  for (let index = 0; index < count; index += 1) {
    const which = index % WRITERS.length;
    const editor = editors[which];
    const deps = index > 0 && coin() ? [all[index - 1]] : [];
    if (!registered.has(which)) {
      registered.add(which);
      all.push(editor.register({ deps }));
    } else {
      all.push(editor.insert(0, `w${index} `, { deps }));
    }
  }
  return { world, ctx: world.ctx({ roster: staticRosterView(spec) }), spec, hub, all };
}

function verified(ctx: ReplicaContext, items: readonly Written[]): VerifiedEntry[] {
  return items.map((item) => {
    const outcome = verifyEntry(item.entry, ctx);
    assert.equal(outcome.status, 'verified', JSON.stringify(outcome));
    return (outcome as { entry: VerifiedEntry }).entry;
  });
}

// The version 2 checkpoint a correct hub signs for a causally closed covered set: per stream, the heads with lamport and roster, the count, and the
// order tip of the covered entries in total order.
function v2Checkpoint(s: Setup, covered: readonly Written[], signer = s.hub.writer): Checkpoint {
  const entries = verified(s.ctx, covered);
  const heads = checkpointHeads(entries, s.ctx.roster);
  const streams = [...heads.keys()].sort().map((stream) => {
    const hashes = totalOrder(entries.filter((entry) => entry.header.stream === stream)).map((entry) => entry.hash);
    return { stream, heads: heads.get(stream) as CheckpointHead[], count: hashes.length, orderTip: orderTipOf(hashes) };
  });
  return { type: 'checkpoint', v: 2, project: PROJECT, signer, rosterHead: s.world.rosterHash, streams };
}

// The same checkpoint in the version 1 shape: heads carry writer, seq and hash only.
function v1Of(checkpoint: Checkpoint): Checkpoint {
  return { ...checkpoint, v: 1, streams: checkpoint.streams.map((stream) => ({ ...stream, heads: stream.heads.map((head): Dep => ({ writer: head.writer, seq: head.seq, hash: head.hash })) })) };
}

const signHub = (s: Setup, checkpoint: Checkpoint): SignedCheckpoint => signCheckpoint(s.hub.signer, checkpoint);
const sealed = (items: readonly Written[]): SealedEntry[] => items.map((item) => item.entry);
const hashes = (items: readonly Written[]): string[] => items.map((item) => item.hash);
const chainHeld = (result: FoldResult): string[] => result.held.filter((item) => item.stage === 'chain').map((item) => item.reason);
const rejectedReasons = (result: FoldResult): Array<[string | undefined, string]> => result.rejected.map((item): [string | undefined, string] => [item.hash, item.reason]);

// ---- Task 1: the format --------------------------------------------------------------------------------------------------------------------

test('a version 2 checkpoint built from a world signs, reads back equal, and verifies under a roster that names its signer', () => {
  const s = setup();
  assert.equal(CHECKPOINT_VERSION, 2);
  const checkpoint = v2Checkpoint(s, s.all.slice(0, 20));
  const signed = signHub(s, checkpoint);
  assert.equal(signed.payload.v, 2);
  assert.deepEqual(readCheckpoint(signed.payload), checkpoint);
  const verdict = verifyCheckpoint(signed, s.ctx.roster);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  if (verdict.ok) assert.deepEqual(verdict.checkpoint, checkpoint);
  // Every head names its writer's last covered entry, with that entry's lamport and the roster it cites (one roster here).
  const heads = checkpoint.streams[0].heads as CheckpointHead[];
  assert.equal(heads.length, 3);
  for (const head of heads) {
    const own = s.all.slice(0, 20).filter((item) => item.writer === head.writer);
    const last = own[own.length - 1];
    assert.deepEqual(head, { writer: last.writer, seq: last.seq, hash: last.hash, lamport: last.lamport, roster: s.world.rosterHash });
  }
  // Signing again gives the same bytes.
  assert.equal(signHub(s, checkpoint).sig, signed.sig);
});

test('a version 2 checkpoint signed by a writer the roster does not name as checkpoint signer is refused not-a-checkpoint-signer', () => {
  const s = setup();
  const writer = fixedSigner('A');
  const signed = signCheckpoint(writer.signer, v2Checkpoint(s, s.all.slice(0, 20), writer.writer));
  const verdict = verifyCheckpoint(signed, s.ctx.roster);
  assert.deepEqual(verdict.ok ? 'ok' : verdict.reason, 'not-a-checkpoint-signer');
  // A version 2 checkpoint that is not verified gives no join base in the fold either; checkpointBases itself reads only the shape.
  assert.equal(checkpointBases([signed]).size, 3);
});

test('a version 1 checkpoint (heads with exactly writer, seq and hash) still reads and verifies, and checkpointBases ignores it', () => {
  const s = setup();
  const v1 = v1Of(v2Checkpoint(s, s.all.slice(0, 20)));
  const signed = signHub(s, v1);
  assert.equal(signed.payload.v, 1);
  assert.deepEqual(readCheckpoint(signed.payload), v1);
  const verdict = verifyCheckpoint(signed, s.ctx.roster);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  if (verdict.ok) assert.deepEqual(verdict.checkpoint, v1);
  assert.equal(checkpointBases([signed]).size, 0);
  // The two versions sign different bytes for the same covered set.
  assert.notEqual(signHub(s, v2Checkpoint(s, s.all.slice(0, 20))).sig, signed.sig);
});

test('a version 2 head with an extra key, a missing or non-integer lamport, or a roster that is not a 64-hex hash is refused, and so is a mixed checkpoint', () => {
  const s = setup();
  const good = v2Checkpoint(s, s.all.slice(0, 20));
  const withHead = (change: (head: Record<string, unknown>) => Record<string, unknown>): unknown => ({
    ...good,
    streams: good.streams.map((stream) => ({ ...stream, heads: stream.heads.map((head, index) => (index === 0 ? change({ ...head }) : head)) }))
  });
  const bad: Array<[string, unknown]> = [
    ['extra key', withHead((head) => ({ ...head, extra: 1 }))],
    ['missing lamport', withHead(({ lamport: _lamport, ...head }) => head)],
    ['missing roster', withHead(({ roster: _roster, ...head }) => head)],
    ['fractional lamport', withHead((head) => ({ ...head, lamport: 1.5 }))],
    ['lamport as text', withHead((head) => ({ ...head, lamport: '3' }))],
    ['lamport zero', withHead((head) => ({ ...head, lamport: 0 }))],
    ['negative lamport', withHead((head) => ({ ...head, lamport: -1 }))],
    ['short roster', withHead((head) => ({ ...head, roster: 'ab' }))],
    ['upper-case roster', withHead((head) => ({ ...head, roster: (head.roster as string).toUpperCase() }))],
    ['roster not text', withHead((head) => ({ ...head, roster: 7 }))],
    ['version 1 head in a version 2 checkpoint', withHead((head) => ({ writer: head.writer, seq: head.seq, hash: head.hash }))],
    ['version 2 heads in a version 1 checkpoint', { ...good, v: 1 }],
    ['unknown version', { ...good, v: 3 }]
  ];
  for (const [name, value] of bad) {
    assert.equal(readCheckpoint(value), undefined, name);
    assert.throws(() => signCheckpoint(s.hub.signer, value as Checkpoint), /Nothing was signed/, name);
    assert.equal(checkpointBases([{ ...signHub(s, good), payload: value as Checkpoint }]).size, 0, name);
  }
  // A signed version 2 checkpoint whose head was changed after signing is refused: the bytes no longer match the signature.
  const signed = signHub(s, good);
  const changed = { ...signed, payload: withHead((head) => ({ ...head, lamport: (head.lamport as number) + 1 })) };
  assert.deepEqual((verifyCheckpoint(changed, s.ctx.roster) as { reason: string }).reason, 'bad-signature');
});

test('checkpointBases of one version 2 checkpoint gives one base per head, keyed by head hash, and drops a head two checkpoints disagree about', () => {
  const s = setup();
  const checkpoint = v2Checkpoint(s, s.all.slice(0, 20));
  const signed = signHub(s, checkpoint);
  const bases = checkpointBases([signed]);
  const stream = checkpoint.streams[0];
  assert.equal(bases.size, stream.heads.length);
  for (const head of stream.heads as CheckpointHead[]) {
    assert.deepEqual(bases.get(head.hash), { stream: stream.stream, writer: head.writer, seq: head.seq, hash: head.hash, lamport: head.lamport, roster: head.roster });
  }
  // A second checkpoint naming the same head hash with the same values adds nothing; one naming it with another lamport removes that base, since
  // the two cannot both be right and the joiner cannot tell which is.
  assert.deepEqual(checkpointBases([signed, signed]), bases);
  const first = (stream.heads as CheckpointHead[])[0];
  const lying = { ...checkpoint, streams: [{ ...stream, heads: (stream.heads as CheckpointHead[]).map((head) => (head.hash === first.hash ? { ...head, lamport: head.lamport + 7 } : head)) }] };
  const both = checkpointBases([signed, signHub(s, lying)]);
  assert.equal(both.has(first.hash), false);
  assert.equal(both.size, bases.size - 1);
  assert.deepEqual(checkpointBases([signHub(s, lying), signed]), both);
});

test('checkpointHeads names, per stream and writer, the highest-seq entry, its lamport and the newest roster cited in its causal past', () => {
  const s = setup(6);
  const second = 'f'.repeat(64);
  const spec: StaticRosterSpec = { ...s.spec, rosters: [...s.spec.rosters, { ...s.spec.rosters[0], hash: second }] };
  const ctx = s.world.ctx({ roster: staticRosterView(spec) });
  // B writes citing the newer roster; A then cites the older roster but depends on B's entry, so A's head carries the newer roster from its past.
  const b = s.world.write('B', { kind: 'doc.client', data: { product: 'other', clientId: 909, actor: { kind: 'person' } }, roster: second });
  const a = s.world.write('A', { kind: 'doc.client', data: { product: 'other', clientId: 808, actor: { kind: 'person' } }, deps: [b] });
  const entries = [...s.all, b, a].map((item) => {
    const outcome = verifyEntry(item.entry, ctx);
    assert.equal(outcome.status, 'verified', JSON.stringify(outcome));
    return (outcome as { entry: VerifiedEntry }).entry;
  });
  const heads = checkpointHeads(entries, ctx.roster).get(s.world.stream) as CheckpointHead[];
  assert.deepEqual(heads.map((head) => head.writer), [...heads.map((head) => head.writer)].sort());
  const byWriter = new Map(heads.map((head) => [head.writer, head]));
  assert.deepEqual(byWriter.get(a.writer), { writer: a.writer, seq: a.seq, hash: a.hash, lamport: a.lamport, roster: second });
  assert.deepEqual(byWriter.get(b.writer), { writer: b.writer, seq: b.seq, hash: b.hash, lamport: b.lamport, roster: second });
  const c = s.all.filter((item) => item.writer === s.world.writerOf('C')).pop() as Written;
  assert.deepEqual(byWriter.get(c.writer), { writer: c.writer, seq: c.seq, hash: c.hash, lamport: c.lamport, roster: s.world.rosterHash });
});

// ---- Task 2: a joiner's chain starts after a checkpoint head --------------------------------------------------------------------------------

test('a late joiner with only the version 2 checkpoint and the 10 later entries admits all 10, and their order is the suffix of the full fold\'s order', () => {
  const s = setup();
  const prefix = s.all.slice(0, 20);
  const post = s.all.slice(20);
  const signed = signHub(s, v2Checkpoint(s, prefix));
  const options = { checkpoints: [signed] };
  const full = foldEntries(sealed(s.all), s.ctx, options);
  assert.deepEqual([full.held, full.rejected], [[], []]);
  assert.equal(full.checkpoint, checkpointHash(signed));
  assert.deepEqual([...full.order.slice(0, 20)].sort(), [...hashes(prefix)].sort());

  const joiner = foldEntries(sealed(post), s.ctx, options);
  assert.deepEqual(rejectedReasons(joiner), []);
  assert.deepEqual(chainHeld(joiner), []);
  assert.equal(joiner.order.length, 10);
  assert.deepEqual(joiner.order, full.order.slice(20));
  assert.deepEqual(joiner.order, totalOrder(verified(s.ctx, post)).map((entry) => entry.hash));
  // The registrations are in the prefix, so the joiner's text updates wait for them at the reducer stage (D-42: state written before the checkpoint
  // is rebuilt only when the prefix is served). The heads are not in the graph, so the checkpoint fixes no order here.
  assert.ok(joiner.held.length > 0);
  for (const held of joiner.held) assert.deepEqual([held.stage, held.reason], ['fold', 'unregistered-client']);
  assert.equal(joiner.checkpoint, null);

  // In any delivery order and in any number of pieces, the incremental fold gives the same.
  const random = rng(8);
  for (let round = 0; round < 4; round += 1) {
    const order = shuffled(post, random);
    let state = createFoldState(s.ctx, options);
    for (const piece of [order.slice(0, 3), order.slice(3, 7), order.slice(7)]) state = addEntries(state, sealed(piece));
    assert.deepEqual(state.result.order, joiner.order);
    assert.deepEqual(state.result.digests, joiner.digests);
  }

  // When the prefix is served later (Phase 32 serves it on demand), the joiner equals the full fold that uses the same checkpoint.
  const served = addEntries(addEntries(createFoldState(s.ctx, options), sealed(post)), sealed(prefix));
  assert.deepEqual(served.result.order, full.order);
  assert.deepEqual(served.result.digests, full.digests);
  assert.deepEqual(served.result.applied, full.applied);
  assert.deepEqual([served.result.held, served.result.rejected, served.result.checkpoint], [[], [], full.checkpoint]);
});

test('without a usable version 2 checkpoint the later entries wait: none, a version 1 one, and one from a non-signer all leave them missing-predecessor', () => {
  const s = setup();
  const prefix = s.all.slice(0, 20);
  const post = s.all.slice(20);
  const v2 = v2Checkpoint(s, prefix);
  const stranger = fixedSigner('A');
  const cases: Array<[string, SignedCheckpoint[] | undefined]> = [
    ['none', undefined],
    ['version 1', [signHub(s, v1Of(v2))]],
    ['not a checkpoint signer', [signCheckpoint(stranger.signer, { ...v2, signer: stranger.writer })]]
  ];
  for (const [name, checkpoints] of cases) {
    const result = foldEntries(sealed(post), s.ctx, checkpoints === undefined ? {} : { checkpoints });
    assert.deepEqual(result.order, [], name);
    assert.deepEqual(rejectedReasons(result), [], name);
    assert.deepEqual(chainHeld(result), post.map(() => 'missing-predecessor'), name);
  }
});

test('a full holder folds the same with a version 2 checkpoint as with the version 1 checkpoint of the same covered set', () => {
  const s = setup();
  const prefix = s.all.slice(0, 20);
  const v2 = v2Checkpoint(s, prefix);
  const withV2 = foldEntries(sealed(s.all), s.ctx, { checkpoints: [signHub(s, v2)] });
  const withV1 = foldEntries(sealed(s.all), s.ctx, { checkpoints: [signHub(s, v1Of(v2))] });
  for (const key of ['order', 'applied', 'held', 'rejected', 'refused', 'kept', 'excluded', 'families', 'digests'] as const) assert.deepEqual(withV2[key], withV1[key], key);
  // classifyChains with no bases is the Phase 30 behaviour, entry for entry.
  const entries = verified(s.ctx, s.all);
  assert.deepEqual(classifyChains(entries, s.ctx, [], new Map()), classifyChains(entries, s.ctx));
});

// A raw entry by `name` right after the checkpoint, with the given changes. By default it is the correct next entry: prev is the writer's head, seq is
// one more, lamport is one more than the largest of the head and its deps, and the roster is the head's.
interface AfterOptions { seq?: number; prev?: string; lamport?: number; deps?: Dep[]; roster?: string }
function after(s: Setup, heads: readonly CheckpointHead[], name: string, options: AfterOptions = {}): Written {
  const writer = s.world.writerOf(name);
  const head = heads.find((candidate) => candidate.writer === writer) as CheckpointHead;
  const deps = options.deps ?? [];
  const lamports = [head.lamport, ...deps.map((dep) => heads.find((candidate) => candidate.hash === dep.hash)?.lamport ?? 0)];
  const body: NewBody = {
    deps,
    roster: options.roster ?? head.roster,
    lamport: options.lamport ?? 1 + Math.max(...lamports),
    at: WORLD_AT,
    actor: { kind: 'person' },
    kind: 'doc.client',
    data: { product: 'after-checkpoint', clientId: 4242, actor: { kind: 'person' } }
  };
  return s.world.writeRaw(name, { stream: s.world.stream, seq: options.seq ?? head.seq + 1, prev: options.prev ?? head.hash, body });
}

const asDep = (head: CheckpointHead): Dep => ({ writer: head.writer, seq: head.seq, hash: head.hash });

test('after a checkpoint, a prev that names another head or a seq that skips is rejected bad-prev, and the correct next entry is admitted', () => {
  const s = setup();
  const checkpoint = v2Checkpoint(s, s.all);
  const options = { checkpoints: [signHub(s, checkpoint)] };
  const heads = checkpoint.streams[0].heads as CheckpointHead[];
  const [headA, headB] = ['A', 'B'].map((name) => heads.find((head) => head.writer === s.world.writerOf(name)) as CheckpointHead);
  const good = after(s, heads, 'A');
  const admitted = foldEntries(sealed([good]), s.ctx, options);
  assert.deepEqual([admitted.order, admitted.rejected, chainHeld(admitted)], [[good.hash], [], []]);
  const cases: Array<[string, Written]> = [
    ['prev is another writer\'s head', after(s, heads, 'A', { prev: headB.hash, seq: headB.seq + 1, lamport: headB.lamport + 1 })],
    ['seq skips one', after(s, heads, 'A', { seq: headA.seq + 2 })],
    ['seq repeats the head\'s', after(s, heads, 'A', { seq: headA.seq })]
  ];
  for (const [name, entry] of cases) {
    const result = foldEntries(sealed([entry]), s.ctx, options);
    assert.deepEqual(rejectedReasons(result), [[entry.hash, 'bad-prev']], name);
    assert.deepEqual(result.order, [], name);
  }
});

test('after a checkpoint, a lamport that is not one more than the largest of the head and its other deps is rejected bad-lamport', () => {
  const s = setup();
  const checkpoint = v2Checkpoint(s, s.all);
  const options = { checkpoints: [signHub(s, checkpoint)] };
  const heads = checkpoint.streams[0].heads as CheckpointHead[];
  // The writer with the earliest head cites the head with the latest lamport, so the dep, not its own head, sets the lamport.
  const byLamport = [...heads].sort((x, y) => x.lamport - y.lamport);
  const [low, other] = [byLamport[0], byLamport[byLamport.length - 1]];
  assert.ok(other.lamport > low.lamport);
  const name = WRITERS.find((candidate) => s.world.writerOf(candidate) === low.writer) as string;
  const withDep = after(s, heads, name, { deps: [asDep(other)] });
  assert.deepEqual(foldEntries(sealed([withDep]), s.ctx, options).order, [withDep.hash]);
  const cases: Array<[string, Written]> = [
    ['too high', after(s, heads, name, { lamport: low.lamport + 5 })],
    ['equal to the head\'s', after(s, heads, name, { lamport: low.lamport })],
    ['ignores a later dep', after(s, heads, name, { deps: [asDep(other)], lamport: low.lamport + 1 })]
  ];
  for (const [name, entry] of cases) {
    const result = foldEntries(sealed([entry]), s.ctx, options);
    assert.deepEqual(rejectedReasons(result), [[entry.hash, 'bad-lamport']], name);
  }
});

test('after a checkpoint, an entry citing a roster older than the head\'s roster is rejected stale-roster-citation, through its prev or a dep', () => {
  const s = setup();
  const second = 'e'.repeat(64);
  const spec: StaticRosterSpec = { ...s.spec, rosters: [...s.spec.rosters, { ...s.spec.rosters[0], hash: second }] };
  const ctx = s.world.ctx({ roster: staticRosterView(spec) });
  // B moves to the newer roster before the checkpoint.
  const newer = s.world.write('B', { kind: 'doc.client', data: { product: 'other', clientId: 919, actor: { kind: 'person' } }, roster: second });
  const twoRosters: Setup = { ...s, ctx, spec };
  const checkpoint = v2Checkpoint(twoRosters, [...s.all, newer]);
  const options = { checkpoints: [signCheckpoint(s.hub.signer, checkpoint)] };
  const heads = checkpoint.streams[0].heads as CheckpointHead[];
  const headB = heads.find((head) => head.writer === s.world.writerOf('B')) as CheckpointHead;
  assert.equal(headB.roster, second);
  const fine = after(twoRosters, heads, 'B');
  assert.deepEqual(foldEntries(sealed([fine]), ctx, options).order, [fine.hash]);
  const cases: Array<[string, Written]> = [
    ['the writer\'s own head', after(twoRosters, heads, 'B', { roster: s.world.rosterHash })],
    ['a dep on that head', after(twoRosters, heads, 'A', { deps: [asDep(headB)], roster: s.world.rosterHash })]
  ];
  for (const [name, entry] of cases) {
    const result = foldEntries(sealed([entry]), ctx, options);
    assert.deepEqual(rejectedReasons(result), [[entry.hash, 'stale-roster-citation']], name);
  }
  // A dep on a head of the older roster with the older roster cited is fine.
  const headC = heads.find((head) => head.writer === s.world.writerOf('C')) as CheckpointHead;
  const older = after(twoRosters, heads, 'A', { deps: [asDep(headC)], roster: s.world.rosterHash });
  assert.deepEqual(foldEntries(sealed([older]), ctx, options).order, [older.hash]);
});

test('after a checkpoint, a dep naming a covered entry that is not a head is held missing-predecessor, and a dep naming a head with the wrong seq is bad-dep', () => {
  const s = setup();
  const checkpoint = v2Checkpoint(s, s.all);
  const options = { checkpoints: [signHub(s, checkpoint)] };
  const heads = checkpoint.streams[0].heads as CheckpointHead[];
  const headB = heads.find((head) => head.writer === s.world.writerOf('B')) as CheckpointHead;
  const covered = s.all.find((item) => item.writer === headB.writer && item.seq === headB.seq - 2) as Written;
  const coveredDep: Dep = { writer: covered.writer, seq: covered.seq, hash: covered.hash };
  const waiting = after(s, heads, 'A', { deps: [coveredDep], lamport: 1 + Math.max(covered.lamport, (heads.find((head) => head.writer === s.world.writerOf('A')) as CheckpointHead).lamport) });
  const held = foldEntries(sealed([waiting]), s.ctx, options);
  assert.deepEqual([held.order, rejectedReasons(held), chainHeld(held)], [[], [], ['missing-predecessor']]);
  // A full holder admits it: the conservative hold is the joiner's only, and goes once the covered entry is served.
  assert.ok(foldEntries(sealed([...s.all, waiting]), s.ctx, options).order.includes(waiting.hash));
  const wrongSeq = after(s, heads, 'A', { deps: [{ ...asDep(headB), seq: headB.seq + 1 }] });
  assert.deepEqual(rejectedReasons(foldEntries(sealed([wrongSeq]), s.ctx, options)), [[wrongSeq.hash, 'bad-dep']]);
  const wrongWriter = after(s, heads, 'A', { deps: [{ ...asDep(headB), writer: s.world.writerOf('C') }] });
  assert.deepEqual(rejectedReasons(foldEntries(sealed([wrongWriter]), s.ctx, options)), [[wrongWriter.hash, 'bad-dep']]);
});

test('text a joiner has only from a compaction, its covered updates absent behind the checkpoint, keeps unverified: true in the doc output', () => {
  const world = createWorld({ members: [{ member: 'mbr-aaaa', devices: ['A'] }, { member: 'mbr-bbbb', devices: ['B'] }, { member: 'mbr-cccc', devices: ['C'] }, { member: 'mbr-hhhh', devices: ['H'] }] });
  const hub = fixedSigner('H');
  const spec: StaticRosterSpec = { ...world.rosterSpec, rosters: world.rosterSpec.rosters.map((roster) => ({ ...roster, checkpointSigners: [hub.writer] })) };
  const ctx = world.ctx({ roster: staticRosterView(spec) });
  const product = 'intel-estimate';
  const a = world.editor('A', product, 11);
  const b = world.editor('B', product, 22);
  const c = world.editor('C', product, 33);
  const regs = [a.register(), b.register(), c.register()];
  const updA = a.insert(0, 'alpha ');
  applyRemote(b.doc, encodeFullState(a.doc));
  const updB = b.insert(6, 'beta');
  const merged = createFoldDoc();
  applyUpdate(merged, encodeFullState(a.doc));
  applyUpdate(merged, encodeFullState(b.doc));
  const prefix = [...regs, updA, updB];
  const s: Setup = { world, ctx, spec, hub, all: prefix };
  const signed = signHub(s, v2Checkpoint(s, prefix));
  const blob = sealBlob(world.keyFor(world.stream, 0), world.stream, 0, Buffer.from(encodeFullState(merged)));
  world.blobs.set(blob.hash, blob);
  const dep = (item: Written): Dep => ({ writer: item.writer, seq: item.seq, hash: item.hash });
  const compaction = world.write('C', { kind: 'doc.compact', deps: [updA, updB], data: { product, covers: [dep(updA), dep(updB)], stateVector: stateVectorOf(merged), textHash: textHashOf(docText(merged)), stateBlob: blob.hash } });
  const productOf = (result: FoldResult): ProductTextOutput => (result.families.doc as ProductTextOutput[])[0];

  // The joiner holds the registrations (served with the welcome) and the compaction, but not the updates the compaction covers.
  const joiner = foldEntries(sealed([...regs, compaction]), ctx, { checkpoints: [signed] });
  assert.deepEqual([joiner.rejected, joiner.held, joiner.refused], [[], [], []]);
  assert.ok(joiner.order.includes(compaction.hash));
  const text = productOf(joiner);
  assert.equal(text.text, docText(merged));
  assert.deepEqual(text.compactions, [{ entry: compaction.hash, verified: false }]);
  assert.ok(text.attribution.length > 0);
  for (const span of text.attribution) assert.deepEqual([span.writer, span.unverified], [UNATTRIBUTED_WRITER, true]);
  // With the covered updates the same compaction is checked against them, and nothing is unverified.
  const full = productOf(foldEntries(sealed([...prefix, compaction]), ctx, { checkpoints: [signed] }));
  assert.equal(full.text, text.text);
  assert.deepEqual(full.compactions, [{ entry: compaction.hash, verified: true }]);
  for (const span of full.attribution) assert.notEqual(span.unverified, true);
});

// ---- Phase 33 plan 14: the checkpoints a computer's fold uses (foldCheckpoints.ts) -----------------------------------------------------------

test('parity: a computer starting from the trusted checkpoint and one replaying the full history fold the same entries, in any order, to the same result', () => {
  const s = setup();
  const prefix = s.all.slice(0, 20);
  const post = s.all.slice(20);
  const earlier = signHub(s, v2Checkpoint(s, s.all.slice(0, 11)));
  const newest = signHub(s, v2Checkpoint(s, prefix));
  const chosen = foldCheckpoints([earlier, newest], new Map([[s.hub.writer, newest]]), s.ctx.roster, PROJECT, s.world.rosterHash);
  assert.deepEqual(chosen.map(checkpointHash).sort(), [checkpointHash(earlier), checkpointHash(newest)].sort(), 'the newest and the earlier one it nests');
  const full = foldEntries(sealed(s.all), s.ctx, { checkpoints: chosen });
  assert.deepEqual([full.held, full.rejected], [[], []]);
  const random = rng(14);
  for (let round = 0; round < 6; round += 1) {
    // The joiner takes the later entries first (from the checkpoint base), then the prefix in pieces, each delivery in a shuffled order.
    let state = addEntries(createFoldState(s.ctx, { checkpoints: chosen }), sealed(shuffled(post, random)));
    assert.deepEqual(chainHeld(state.result), [], 'the later entries join at the base');
    const served = shuffled(prefix, random);
    for (const piece of [served.slice(0, 7), served.slice(7, 13), served.slice(13)]) state = addEntries(state, sealed(piece));
    for (const key of ['order', 'applied', 'held', 'rejected', 'refused', 'kept', 'digests', 'families', 'checkpoint'] as const) assert.deepEqual(state.result[key], full[key], `${key}, round ${round}`);
  }
});

test('a checkpoint from a hub that is not admitted, of another project, newer than the witness trusts, or from a hub the witness distrusts after a fork or rollback is not used, and the later entries wait for the full history', async () => {
  const s = setup();
  const prefix = s.all.slice(0, 20);
  const post = s.all.slice(20);
  const signed = signHub(s, v2Checkpoint(s, prefix));
  const head = s.world.rosterHash;
  assert.equal(foldCheckpoints([signed], new Map([[s.hub.writer, signed]]), s.ctx.roster, PROJECT, head).length, 1, 'the control: trusted and admitted');
  const stranger = fixedSigner('A');
  const strangers = signCheckpoint(stranger.signer, { ...v2Checkpoint(s, prefix), signer: stranger.writer });
  const notAdmitted = staticRosterView({ ...s.spec, rosters: s.spec.rosters.map((roster) => ({ ...roster, checkpointSigners: [] })) });
  const otherProject = signHub(s, { ...v2Checkpoint(s, prefix), project: 'project-other' });
  const larger = signHub(s, v2Checkpoint(s, s.all.slice(0, 25)));
  const smaller = signHub(s, v2Checkpoint(s, s.all.slice(0, 11)));
  const cases: Array<[string, ReturnType<typeof foldCheckpoints>]> = [
    ['the witness distrusts the hub', foldCheckpoints([signed], new Map([[s.hub.writer, undefined]]), s.ctx.roster, PROJECT, head)],
    ['signed by a device that is no checkpoint signer', foldCheckpoints([strangers], new Map([[stranger.writer, strangers]]), s.ctx.roster, PROJECT, head)],
    ['the hub is not admitted at the roster head', foldCheckpoints([signed], new Map([[s.hub.writer, signed]]), notAdmitted, PROJECT, head)],
    ['another project', foldCheckpoints([otherProject], new Map([[s.hub.writer, otherProject]]), s.ctx.roster, PROJECT, head)],
    ['no witness at all', foldCheckpoints([signed], new Map(), s.ctx.roster, PROJECT, head)]
  ];
  for (const [name, chosen] of cases) {
    assert.deepEqual(chosen, [], name);
    assert.deepEqual(chainHeld(foldEntries(sealed(post), s.ctx, { checkpoints: chosen })), post.map(() => 'missing-predecessor'), `${name}: full replay`);
  }
  // A stored checkpoint larger than the one the witness trusts (one the hub showed and then took back) is evidence only.
  assert.deepEqual(foldCheckpoints([smaller, larger], new Map([[s.hub.writer, smaller]]), s.ctx.roster, PROJECT, head), [smaller]);

  // The witness memory: its newest checkpoint while trusted; none once it holds a proof or distrusts the hub; none when it cannot be read.
  const memoryOf = (state: Partial<WitnessState> | 'broken') => ({
    load: async (hub: string, project: string): Promise<WitnessState> => {
      if (state === 'broken') throw new Error('unreadable');
      return { ...createWitness(hub, project), ...state };
    }
  });
  assert.deepEqual(await trustedCheckpointsOf(memoryOf({ newest: signed }), PROJECT, [signed]), new Map([[s.hub.writer, signed]]));
  assert.deepEqual(await trustedCheckpointsOf(memoryOf({ newest: signed, distrusted: true }), PROJECT, [signed]), new Map([[s.hub.writer, undefined]]));
  assert.deepEqual(await trustedCheckpointsOf(memoryOf({ newest: signed, proof: { a: signed, b: larger } as never }), PROJECT, [signed]), new Map([[s.hub.writer, undefined]]));
  assert.deepEqual(await trustedCheckpointsOf(memoryOf('broken'), PROJECT, [signed]), new Map([[s.hub.writer, undefined]]));
});
