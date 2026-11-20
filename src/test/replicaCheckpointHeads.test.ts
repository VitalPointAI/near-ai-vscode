// Checkpoint format version 2 and late joiners (plan 31-08, D-04, D-42): each head records its lamport and the newest roster in its past, a version 1
// checkpoint still verifies, and a writer's log may start right after a verified version 2 head.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CHECKPOINT_VERSION, checkpointBases, checkpointHeads, orderTipOf, readCheckpoint, signCheckpoint, verifyCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint, CheckpointHead, SignedCheckpoint } from '../domain/replica/checkpoint';
import type { Dep } from '../domain/replica/entry';
import { totalOrder } from '../domain/replica/order';
import { staticRosterView } from '../domain/replica/rosterView';
import type { ReplicaContext, StaticRosterSpec } from '../domain/replica/rosterView';
import { verifyEntry } from '../domain/replica/verify';
import type { VerifiedEntry } from '../domain/replica/verify';
import { createWorld, fixedSigner } from './helpers/replicaWorld';
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
