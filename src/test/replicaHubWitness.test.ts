// The hub witness (plan 32-16; D-46, D-50, D-63, D-70; DESIGN 10.8 and 19): what a misbehaving hub can still do short of forging a signature, each
// caught from what this computer already holds and named in one plain sentence. Pure: every test passes time in and builds checkpoints by hand.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { signCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint, SignedCheckpoint } from '../domain/replica/checkpoint';
import { staticRosterView } from '../domain/replica/rosterView';
import type { RosterView } from '../domain/replica/rosterView';
import { HUB_FINDINGS, createWitness, findingSentence, witnessCheckpoint } from '../domain/replica/hubWitness';
import type { HubFinding, WitnessState } from '../domain/replica/hubWitness';
import { fixedSigner } from './helpers/replicaWorld';

const PROJECT = 'project-main';
const OTHER_PROJECT = 'project-other';
const HUB_ID = 'hub-exercise-north';
const hex = (label: string): string => createHash('sha256').update(label).digest('hex');
const ROSTER = hex('roster/0');
const STREAM = hex('stream/base').slice(0, 32);
const STREAM_B = hex('stream/ops').slice(0, 32);
const A = fixedSigner('A');
const B = fixedSigner('B');
const HUB = fixedSigner('H');

function roster(): RosterView {
  return staticRosterView({
    rosters: [{
      hash: ROSTER,
      checkpointSigners: [HUB.writer],
      members: [
        { member: 'mbr-aaaa000000000000', name: 'Analyst A', roles: ['member'], devices: [{ writer: A.writer, publicKey: A.publicKey }] },
        { member: 'mbr-bbbb000000000000', name: 'Analyst B', roles: ['member'], devices: [{ writer: B.writer, publicKey: B.publicKey }] },
        { member: 'mbr-hhhh000000000000', name: 'Sync hub', roles: ['member'], devices: [{ writer: HUB.writer, publicKey: HUB.publicKey }] }
      ]
    }]
  });
}

interface HeadSpec { writer: string; seq: number; label?: string }
interface StreamSpec { stream?: string; heads: HeadSpec[]; count?: number; tip?: string }
interface CheckpointSpec { streams: StreamSpec[]; project?: string; by?: ReturnType<typeof fixedSigner> }

// The hash of a writer's entry at a seq. A label other than the default stands for a second entry at the same place (a fork).
const headHash = (writer: string, seq: number, label = 'main'): string => hex(`entry/${writer}/${seq}/${label}`);

function checkpoint(spec: CheckpointSpec): SignedCheckpoint {
  const by = spec.by ?? HUB;
  const value: Checkpoint = {
    type: 'checkpoint',
    v: 2,
    project: spec.project ?? PROJECT,
    signer: by.writer,
    rosterHead: ROSTER,
    streams: spec.streams.map((stream) => {
      const heads = stream.heads.map((head) => ({ writer: head.writer, seq: head.seq, hash: headHash(head.writer, head.seq, head.label), lamport: head.seq + 1, roster: ROSTER }));
      const count = stream.count ?? heads.reduce((sum, head) => sum + head.seq + 1, 0);
      return { stream: stream.stream ?? STREAM, heads, count, orderTip: hex(`tip/${stream.tip ?? heads.map((head) => head.hash).join('/')}`) };
    })
  };
  return signCheckpoint(by.signer, value);
}

const one = (writer: string, seq: number, label?: string): CheckpointSpec => ({ streams: [{ heads: [{ writer, seq, label }] }] });

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const kinds = (findings: readonly HubFinding[]): string[] => findings.map((finding) => finding.kind);

function feed(state: WitnessState, ...signed: SignedCheckpoint[]): WitnessState {
  let current = state;
  for (const item of signed) {
    const result = witnessCheckpoint(current, item, roster());
    assert.deepEqual(result.findings, [], 'an honest checkpoint gives no finding');
    current = result.state;
  }
  return current;
}

// Task 1: checkpoints (D-46).

test('honest checkpoints in order give no finding and the newest is kept', () => {
  const c1 = checkpoint(one(A.writer, 3));
  const c2 = checkpoint(one(A.writer, 5));
  const start = createWitness(HUB_ID, PROJECT);
  assert.equal(start.newest, undefined);
  const state = feed(start, c1, c2);
  assert.deepEqual(state.newest, c2);
  assert.equal(state.distrusted, false);
});

test('rolled-back: a checkpoint below the newest one this computer holds is named and the newest stays', () => {
  const c2 = checkpoint(one(A.writer, 5));
  const state = feed(createWitness(HUB_ID, PROJECT), checkpoint(one(A.writer, 3)), c2);
  const result = witnessCheckpoint(deepFreeze(state), checkpoint(one(A.writer, 2)), roster());
  assert.deepEqual(kinds(result.findings), ['rolled-back']);
  assert.equal(result.findings[0].sentence, 'The hub showed an older copy of this project than this computer has already seen.');
  assert.deepEqual(result.state.newest, c2);
  assert.equal(result.state.distrusted, false);
  assert.equal(result.trusted, false);
});

test('rolled-back: a checkpoint that drops a writer or a stream the newest one covered is below it', () => {
  const both = checkpoint({ streams: [{ heads: [{ writer: A.writer, seq: 4 }, { writer: B.writer, seq: 2 }] }, { stream: STREAM_B, heads: [{ writer: A.writer, seq: 1 }] }] });
  const state = feed(createWitness(HUB_ID, PROJECT), both);
  const noWriter = witnessCheckpoint(state, checkpoint({ streams: [{ heads: [{ writer: A.writer, seq: 4 }] }, { stream: STREAM_B, heads: [{ writer: A.writer, seq: 1 }] }] }), roster());
  assert.deepEqual(kinds(noWriter.findings), ['rolled-back']);
  const noStream = witnessCheckpoint(state, checkpoint({ streams: [{ heads: [{ writer: A.writer, seq: 4 }, { writer: B.writer, seq: 2 }] }] }), roster());
  assert.deepEqual(kinds(noStream.findings), ['rolled-back']);
  assert.deepEqual(noStream.state.newest, both);
});

test('forked-view: another hash at a seq both checkpoints cover keeps both as proof and the hub is no longer trusted', () => {
  const c2 = checkpoint(one(A.writer, 5));
  const fork = checkpoint(one(A.writer, 5, 'other'));
  const state = feed(createWitness(HUB_ID, PROJECT), checkpoint(one(A.writer, 3)), c2);
  const result = witnessCheckpoint(deepFreeze(state), fork, roster());
  assert.deepEqual(kinds(result.findings), ['forked-view']);
  assert.equal(result.findings[0].sentence, 'The hub showed two different versions of this project, so this computer no longer trusts its checkpoints.');
  assert.equal(result.state.distrusted, true);
  assert.deepEqual(result.state.proof?.a, c2);
  assert.deepEqual(result.state.proof?.b, fork);
  assert.equal(result.state.proof?.stream, STREAM);
  assert.equal(result.trusted, false);
  // No trust until the lead admits the hub again (Phase 33): even an honest later checkpoint is forked-view, and the proof does not change.
  const later = witnessCheckpoint(result.state, checkpoint(one(A.writer, 7)), roster());
  assert.deepEqual(kinds(later.findings), ['forked-view']);
  assert.deepEqual(later.state.proof, result.state.proof);
  assert.equal(later.state.distrusted, true);
});

test('forked-view: checkpointConflict finds the same count under two final orders, and its proof is kept', () => {
  const c2 = checkpoint({ streams: [{ heads: [{ writer: A.writer, seq: 5 }], tip: 'first' }] });
  const reordered = checkpoint({ streams: [{ heads: [{ writer: A.writer, seq: 5 }], tip: 'second' }] });
  const state = feed(createWitness(HUB_ID, PROJECT), c2);
  const result = witnessCheckpoint(state, reordered, roster());
  assert.deepEqual(kinds(result.findings), ['forked-view']);
  assert.equal(result.state.proof?.reason, 'equal-count-tip-mismatch');
  assert.deepEqual(result.state.proof?.a, c2);
  assert.deepEqual(result.state.proof?.b, reordered);
});

test('forked-view: the same heads with another count cannot both be right', () => {
  const c2 = checkpoint({ streams: [{ heads: [{ writer: A.writer, seq: 5 }], count: 6 }] });
  const state = feed(createWitness(HUB_ID, PROJECT), c2);
  const result = witnessCheckpoint(state, checkpoint({ streams: [{ heads: [{ writer: A.writer, seq: 5 }], count: 9 }] }), roster());
  assert.deepEqual(kinds(result.findings), ['forked-view']);
  assert.equal(result.state.distrusted, true);
});

test('injected: a checkpoint that does not verify for this roster changes nothing', () => {
  const state = feed(createWitness(HUB_ID, PROJECT), checkpoint(one(A.writer, 5)));
  const before = structuredClone(state);
  // A is a member but not a checkpoint signer.
  const forged = checkpoint({ ...one(A.writer, 9), by: A });
  const result = witnessCheckpoint(deepFreeze(state), forged, roster());
  assert.deepEqual(kinds(result.findings), ['injected']);
  assert.equal(result.findings[0].detail.reason, 'not-a-checkpoint-signer');
  assert.deepEqual(result.state, before);
  const tampered = { ...checkpoint(one(A.writer, 9)), sig: checkpoint(one(A.writer, 8)).sig };
  const second = witnessCheckpoint(state, tampered, roster());
  assert.deepEqual(kinds(second.findings), ['injected']);
  assert.equal(second.findings[0].detail.reason, 'bad-signature');
  assert.deepEqual(second.state, before);
});

test('wrong-project: a signed checkpoint for another project is refused and changes nothing', () => {
  const state = feed(createWitness(HUB_ID, PROJECT), checkpoint(one(A.writer, 5)));
  const result = witnessCheckpoint(state, checkpoint({ ...one(A.writer, 9), project: OTHER_PROJECT }), roster());
  assert.deepEqual(kinds(result.findings), ['wrong-project']);
  assert.deepEqual(result.state, state);
});

test('the sentence table names every finding the design lists', () => {
  assert.equal(findingSentence('rolled-back'), HUB_FINDINGS['rolled-back']);
  assert.equal(findingSentence('forked-view'), HUB_FINDINGS['forked-view']);
});
