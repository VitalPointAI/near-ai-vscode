// The hub witness (plan 32-16; D-46, D-50, D-63, D-70; DESIGN 10.8 and 19): what a misbehaving hub can still do short of forging a signature, each
// caught from what this computer already holds and named in one plain sentence. Pure: every test passes time in and builds checkpoints by hand.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { CHECKPOINT_MAX_BYTES, signCheckpoint } from '../domain/replica/checkpoint';
import type { Checkpoint, SignedCheckpoint } from '../domain/replica/checkpoint';
import { staticRosterView } from '../domain/replica/rosterView';
import type { RosterView } from '../domain/replica/rosterView';
import type { HeadSet } from '../domain/replica/transport';
import type { Citation } from '../domain/replica/chain';
import {
  DELAYED_AFTER_MS, HUB_FINDINGS, MAX_OWN_WAITS, MAX_SEEN_HEADS, MAX_WAITING, WITHHELD_GRACE_MS, WITNESS_MAX_BYTES, WITNESS_REFUSALS, createWitness, findingSentence, readWitness,
  serializeWitness, witnessBlob, witnessCheckpoint, witnessCitations, witnessEntry, witnessHeads, witnessOwn, witnessResponse
} from '../domain/replica/hubWitness';
import type { HubFinding, WitnessState } from '../domain/replica/hubWitness';
import { fixedSigner } from './helpers/replicaWorld';

const PROJECT = 'project-main';
const OTHER_PROJECT = 'project-other';
const hex = (label: string): string => createHash('sha256').update(label).digest('hex');
const ROSTER = hex('roster/0');
const STREAM = hex('stream/base').slice(0, 32);
const STREAM_B = hex('stream/ops').slice(0, 32);
const A = fixedSigner('A');
const B = fixedSigner('B');
const HUB = fixedSigner('H');
// The witness names the hub it witnesses by the hub's writer id, as the one-shot sync does (transport.hub).
const HUB_ID = HUB.writer;
// A second hub your organization admitted for the same project (WR-08).
const HUB_TWO = fixedSigner('H2');

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

// The roster with both hubs admitted as checkpoint signers.
function twoHubRoster(): RosterView {
  return staticRosterView({
    rosters: [{
      hash: ROSTER,
      checkpointSigners: [HUB.writer, HUB_TWO.writer],
      members: [
        { member: 'mbr-aaaa000000000000', name: 'Analyst A', roles: ['member'], devices: [{ writer: A.writer, publicKey: A.publicKey }] },
        { member: 'mbr-hhhh000000000000', name: 'Sync hub', roles: ['member'], devices: [{ writer: HUB.writer, publicKey: HUB.publicKey }] },
        { member: 'mbr-hhhh000000000002', name: 'Second sync hub', roles: ['member'], devices: [{ writer: HUB_TWO.writer, publicKey: HUB_TWO.publicKey }] }
      ]
    }]
  });
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

test('a hub checkpoint at a roster this computer has not folded yet is not judged: no finding, not kept; at a known roster it is', () => {
  const state = feed(createWitness(HUB_ID, PROJECT), checkpoint(one(A.writer, 5)));
  const before = structuredClone(state);
  const LATER = hex('roster/1');
  const ahead = signCheckpoint(HUB.signer, { ...checkpoint(one(A.writer, 9)).payload, rosterHead: LATER });
  const behind = witnessCheckpoint(deepFreeze(state), ahead, roster());
  assert.deepEqual(behind, { state: before, findings: [], trusted: false });
  // Once this computer has the roster the checkpoint names (here: a roster view that knows it), the same checkpoint is trusted.
  const caughtUp = staticRosterView({ rosters: [{ hash: ROSTER, checkpointSigners: [HUB.writer], members: [] }, { hash: LATER, checkpointSigners: [HUB.writer], members: [{ member: 'mbr-hhhh000000000000', name: 'Sync hub', roles: ['member'], devices: [{ writer: HUB.writer, publicKey: HUB.publicKey }] }, { member: 'mbr-aaaa000000000000', name: 'Analyst A', roles: ['member'], devices: [{ writer: A.writer, publicKey: A.publicKey }] }] }] });
  assert.equal(witnessCheckpoint(state, ahead, caughtUp).trusted, true);
  // Another device's checkpoint at a roster this computer does not know is still injected: the rule above is only for the watched hub.
  const byA = signCheckpoint(A.signer, { ...checkpoint(one(A.writer, 9)).payload, signer: A.writer, rosterHead: LATER });
  assert.deepEqual(kinds(witnessCheckpoint(state, byA, roster()).findings), ['injected']);
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

test('WR-08: a checkpoint another admitted hub signed is refused for this hub (injected, other-signer), never kept, never compared with this hub\'s own', () => {
  const view = twoHubRoster();
  const first = witnessCheckpoint(createWitness(HUB_ID, PROJECT), checkpoint(one(A.writer, 5)), view);
  assert.equal(first.trusted, true);
  const before = structuredClone(first.state);
  deepFreeze(first.state);
  // The second hub's genuine checkpoints: an older one is no rollback of this hub, a newer one is not this hub's newest, another hash is no fork.
  for (const other of [checkpoint({ ...one(A.writer, 2), by: HUB_TWO }), checkpoint({ ...one(A.writer, 9), by: HUB_TWO }), checkpoint({ ...one(A.writer, 5, 'other'), by: HUB_TWO })]) {
    const result = witnessCheckpoint(first.state, other, view);
    assert.deepEqual(kinds(result.findings), ['injected']);
    assert.equal(result.findings[0].detail.reason, 'other-signer');
    assert.equal(result.trusted, false);
    assert.deepEqual(result.state, before);
  }
  // A fresh witness does not take another hub's checkpoint as its first newest either.
  const fresh = witnessCheckpoint(createWitness(HUB_ID, PROJECT), checkpoint({ ...one(A.writer, 9), by: HUB_TWO }), view);
  assert.equal(fresh.trusted, false);
  assert.equal(fresh.state.newest, undefined);
  assert.deepEqual(fresh.state.seen, []);
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

// Task 2: heads, responses, entries and blobs (D-50).

const headSet = (...rows: Array<[string, string, number, string?]>): HeadSet => {
  const streams = new Map<string, Array<{ writer: string; seq: number; hash: string }>>();
  for (const [stream, writer, seq, label] of rows) {
    const list = streams.get(stream) ?? [];
    list.push({ writer, seq, hash: headHash(writer, seq, label) });
    streams.set(stream, list);
  }
  return { streams: [...streams].map(([stream, heads]) => ({ stream, heads })) };
};

test('rolled-back: heads below what this hub already showed name the stream and writer, and higher heads raise the mark', () => {
  const first = witnessHeads(createWitness(HUB_ID, PROJECT), headSet([STREAM, A.writer, 4], [STREAM, B.writer, 2]), roster());
  assert.deepEqual(first.findings, []);
  assert.deepEqual(first.state.seen.map((row) => [row.writer, row.seq]).sort(), [[A.writer, 4], [B.writer, 2]].sort());
  const lower = witnessHeads(deepFreeze(first.state), headSet([STREAM, A.writer, 1], [STREAM, B.writer, 3]), roster());
  assert.deepEqual(kinds(lower.findings), ['rolled-back']);
  assert.equal(lower.findings[0].detail.stream, STREAM.slice(0, 12));
  assert.equal(lower.findings[0].detail.writer, A.writer.slice(0, 12));
  assert.equal(lower.findings[0].detail.seq, 1);
  assert.equal(lower.findings[0].detail.seen, 4);
  // B's higher head still raises its mark; A's mark stays where it was.
  assert.equal(lower.state.seen.find((row) => row.writer === B.writer)?.seq, 3);
  assert.equal(lower.state.seen.find((row) => row.writer === A.writer)?.seq, 4);
  const higher = witnessHeads(lower.state, headSet([STREAM, A.writer, 6]), roster());
  assert.deepEqual(higher.findings, []);
  assert.equal(higher.state.seen.find((row) => row.writer === A.writer)?.seq, 6);
});

test('rolled-back: heads below an accepted checkpoint are below what this hub showed', () => {
  const state = feed(createWitness(HUB_ID, PROJECT), checkpoint(one(A.writer, 5)));
  const result = witnessHeads(state, headSet([STREAM, A.writer, 3]), roster());
  assert.deepEqual(kinds(result.findings), ['rolled-back']);
});

test('heads for a device the roster does not know, or in a shape that is not a head, raise no mark', () => {
  const stranger = fixedSigner('stranger');
  const result = witnessHeads(createWitness(HUB_ID, PROJECT), {
    streams: [{ stream: STREAM, heads: [{ writer: stranger.writer, seq: 9, hash: headHash(stranger.writer, 9) }, { writer: A.writer, seq: -1, hash: 'nope' }] }, { stream: 'not-a-stream', heads: [{ writer: A.writer, seq: 1, hash: headHash(A.writer, 1) }] }]
  }, roster());
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.state.seen, []);
});

test('wrong-project: a response naming another project or a stream not asked for is refused', () => {
  const state = createWitness(HUB_ID, PROJECT);
  assert.deepEqual(witnessResponse(state, { project: PROJECT, stream: STREAM }, [STREAM, STREAM_B]).findings, []);
  assert.deepEqual(witnessResponse(state, { project: PROJECT, stream: STREAM }, STREAM).findings, []);
  assert.deepEqual(witnessResponse(state, { project: PROJECT }, STREAM).findings, []);
  const otherProject = witnessResponse(state, { project: OTHER_PROJECT, stream: STREAM }, STREAM);
  assert.deepEqual(kinds(otherProject.findings), ['wrong-project']);
  assert.equal(otherProject.findings[0].sentence, 'The hub answered with data from another project, and it was refused.');
  const otherStream = witnessResponse(state, { project: PROJECT, stream: STREAM_B }, [STREAM]);
  assert.deepEqual(kinds(otherStream.findings), ['wrong-project']);
  assert.deepEqual(otherStream.state, state);
});

test('replayed: an entry already held is harmless and counted each time', () => {
  const hash = headHash(A.writer, 2);
  const first = witnessEntry(deepFreeze(createWitness(HUB_ID, PROJECT)), { hash, held: true });
  assert.deepEqual(kinds(first.findings), ['replayed']);
  assert.equal(first.findings[0].sentence, 'The hub sent changes this computer already had, so nothing changed.');
  assert.equal(first.state.replayed, 1);
  const second = witnessEntry(first.state, { hash, held: true });
  assert.deepEqual(kinds(second.findings), ['replayed']);
  assert.equal(second.state.replayed, 2);
  assert.equal(first.state.replayed, 1);
});

test('injected: an entry that fails verification carries the reason id, and a verified new entry gives nothing', () => {
  const state = createWitness(HUB_ID, PROJECT);
  const bad = witnessEntry(state, { hash: headHash(A.writer, 3, 'forged'), verified: false, reason: 'bad-signature' });
  assert.deepEqual(kinds(bad.findings), ['injected']);
  assert.equal(bad.findings[0].detail.reason, 'bad-signature');
  assert.equal(bad.findings[0].sentence, 'The hub sent a change that is not validly signed by anyone in this project, and it was refused.');
  assert.deepEqual(bad.state, state);
  const good = witnessEntry(state, { hash: headHash(A.writer, 3), verified: true });
  assert.deepEqual(good.findings, []);
  assert.deepEqual(good.state, state);
});

test('corrupt-blob: bytes that do not hash to the blob name are refused, and matching bytes give nothing', () => {
  const state = createWitness(HUB_ID, PROJECT);
  const bytes = Buffer.from('sealed attachment bytes of a fictional overlay');
  const name = createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(witnessBlob(state, name, bytes).findings, []);
  assert.deepEqual(witnessBlob(state, name, bytes.toString('base64url')).findings, []);
  const wrong = witnessBlob(state, name, Buffer.from('other bytes'));
  assert.deepEqual(kinds(wrong.findings), ['corrupt-blob']);
  assert.equal(wrong.findings[0].sentence, 'The hub sent an attachment that does not match its fingerprint, and it was refused.');
  assert.equal(wrong.findings[0].detail.blob, name.slice(0, 12));
  assert.deepEqual(kinds(witnessBlob(state, name, 'not base64url!').findings), ['corrupt-blob']);
  assert.deepEqual(kinds(witnessBlob(state, 'not-a-hash', bytes).findings), ['corrupt-blob']);
});

test('every finding carries kind, sentence and detail, with ids cut to 12 characters and no em-dash', () => {
  const findings: HubFinding[] = [];
  const base = feed(createWitness(HUB_ID, PROJECT), checkpoint(one(A.writer, 5)));
  findings.push(...witnessCheckpoint(base, checkpoint(one(A.writer, 2)), roster()).findings);
  findings.push(...witnessCheckpoint(base, checkpoint(one(A.writer, 5, 'other')), roster()).findings);
  findings.push(...witnessCheckpoint(base, checkpoint({ ...one(A.writer, 9), by: A }), roster()).findings);
  findings.push(...witnessCheckpoint(base, checkpoint({ ...one(A.writer, 9), project: OTHER_PROJECT }), roster()).findings);
  findings.push(...witnessHeads(base, headSet([STREAM, A.writer, 1]), roster()).findings);
  findings.push(...witnessResponse(base, { project: OTHER_PROJECT, stream: STREAM }, STREAM).findings);
  findings.push(...witnessEntry(base, { hash: headHash(A.writer, 1), held: true }).findings);
  findings.push(...witnessEntry(base, { hash: headHash(A.writer, 1), verified: false, reason: 'bad-signature' }).findings);
  findings.push(...witnessBlob(base, headHash(A.writer, 1), Buffer.from('x')).findings);
  assert.equal(findings.length, 9);
  for (const item of findings) {
    assert.deepEqual(Object.keys(item).filter((key) => key !== 'count').sort(), ['detail', 'kind', 'sentence']);
    assert.equal(typeof item.sentence, 'string');
    const text = JSON.stringify(item);
    assert.doesNotMatch(text, /\u2014/);
    assert.doesNotMatch(text, /[0-9a-f]{64}/);
    assert.doesNotMatch(text, /[0-9a-f]{13,}/);
  }
});

// Task 3: withheld and delayed over injected time, the saved state, the sentence table and the import rule (D-50, D-52, D-63).

const T0 = new Date('2026-11-19T12:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const cite = (writer: string, seq: number, stream = STREAM): Citation => ({ stream, writer, seq, hash: headHash(writer, seq) });

test('withheld: cited entries not delivered within the grace period are counted, and a delivered one stops waiting', () => {
  const cited = [cite(A.writer, 1), cite(A.writer, 2), cite(B.writer, 4)];
  const held = new Set<string>();
  const first = witnessCitations(deepFreeze(createWitness(HUB_ID, PROJECT)), cited, held, T0);
  assert.deepEqual(first.findings, []);
  assert.equal(first.state.waiting.length, 3);
  const early = witnessCitations(first.state, cited, held, at(WITHHELD_GRACE_MS - 1));
  assert.deepEqual(early.findings, []);
  // The first time each hash was seen missing is kept: a later citation does not restart the clock.
  assert.deepEqual(early.state.waiting.map((row) => row.since), [T0.toISOString(), T0.toISOString(), T0.toISOString()]);
  const due = witnessCitations(early.state, cited, held, at(WITHHELD_GRACE_MS));
  assert.deepEqual(kinds(due.findings), ['withheld']);
  assert.equal(due.findings[0].count, 3);
  assert.equal(due.findings[0].sentence, 'The hub has not delivered 3 changes that other people\'s work refers to.');
  // One is delivered meanwhile; a fourth is cited later and is not due yet.
  const delivered = (hash: string): boolean => hash === headHash(A.writer, 1);
  const later = witnessCitations(due.state, [...cited, cite(B.writer, 5)], delivered, at(WITHHELD_GRACE_MS + 1000));
  assert.deepEqual(kinds(later.findings), ['withheld']);
  assert.equal(later.findings[0].count, 2);
  assert.equal(later.state.waiting.some((row) => row.hash === headHash(A.writer, 1)), false);
  assert.equal(later.state.waiting.length, 3);
  // A verified new entry stops waiting as well.
  const entry = witnessEntry(later.state, { hash: headHash(A.writer, 2), verified: true });
  assert.equal(entry.state.waiting.length, 2);
  const single = witnessCitations(entry.state, [], new Set([headHash(B.writer, 5)]), at(WITHHELD_GRACE_MS * 2));
  assert.equal(single.findings[0].sentence, 'The hub has not delivered 1 change that other people\'s work refers to.');
});

const ownHeads = (seq: number, stream = STREAM): HeadSet['streams'] => [{ stream, heads: [{ writer: A.writer, seq, hash: headHash(A.writer, seq) }] }];

test('delayed: own entries no checkpoint covers for 5 minutes while connected are named in whole minutes', () => {
  const start = witnessOwn(deepFreeze(createWitness(HUB_ID, PROJECT)), ownHeads(2), T0, true);
  assert.deepEqual(start.findings, []);
  assert.equal(start.state.own.length, 1);
  assert.deepEqual(witnessOwn(start.state, ownHeads(2), at(DELAYED_AFTER_MS - 1), true).findings, []);
  const due = witnessOwn(start.state, ownHeads(3), at(DELAYED_AFTER_MS), true);
  assert.deepEqual(kinds(due.findings), ['delayed']);
  assert.equal(due.findings[0].count, 5);
  assert.equal(due.findings[0].sentence, 'The hub has not confirmed your changes for 5 minutes.');
  const longer = witnessOwn(due.state, ownHeads(3), at(DELAYED_AFTER_MS + 150000), true);
  assert.equal(longer.findings[0].sentence, 'The hub has not confirmed your changes for 7 minutes.');
});

test('delayed: nothing while not connected, and the clock starts again on the next connection', () => {
  const start = witnessOwn(createWitness(HUB_ID, PROJECT), ownHeads(2), T0, true);
  const offline = witnessOwn(start.state, ownHeads(2), at(DELAYED_AFTER_MS * 2), false);
  assert.deepEqual(offline.findings, []);
  assert.deepEqual(offline.state.own, []);
  const back = witnessOwn(offline.state, ownHeads(2), at(DELAYED_AFTER_MS * 2 + 1000), true);
  assert.deepEqual(back.findings, []);
  assert.deepEqual(kinds(witnessOwn(back.state, ownHeads(2), at(DELAYED_AFTER_MS * 3 + 1000), true).findings), ['delayed']);
});

test('delayed: a checkpoint covering own entries clears it, and entries past the covered part start a new clock', () => {
  const start = witnessOwn(createWitness(HUB_ID, PROJECT), ownHeads(4), T0, true);
  const covered = feed(start.state, checkpoint(one(A.writer, 4)));
  const after = witnessOwn(covered, ownHeads(4), at(DELAYED_AFTER_MS * 2), true);
  assert.deepEqual(after.findings, []);
  assert.deepEqual(after.state.own, []);
  // Part covered: seq 4 is in the checkpoint, seq 6 is not, so the clock starts when that was first seen.
  const partly = witnessOwn(feed(start.state, checkpoint(one(A.writer, 4))), ownHeads(6), at(DELAYED_AFTER_MS), true);
  assert.deepEqual(partly.findings, []);
  assert.equal(partly.state.own[0].since, at(DELAYED_AFTER_MS).toISOString());
  // Covered below the first uncovered entry: seq 4 is still uncovered since T0, so the clock keeps running from then.
  const behind = witnessOwn(feed(start.state, checkpoint(one(A.writer, 3))), ownHeads(6), at(DELAYED_AFTER_MS), true);
  assert.deepEqual(kinds(behind.findings), ['delayed']);
});

test('delayed: only cells the hub can checkpoint count (D-63), and a distrusted hub gives none', () => {
  const start = witnessOwn(createWitness(HUB_ID, PROJECT), [...ownHeads(2), ...ownHeads(1, STREAM_B)], T0, true, [STREAM]);
  assert.deepEqual(start.state.own.map((row) => row.stream), [STREAM]);
  const due = witnessOwn(start.state, [...ownHeads(2), ...ownHeads(1, STREAM_B)], at(DELAYED_AFTER_MS), true, [STREAM_B]);
  assert.deepEqual(due.findings, []);
  const forked = witnessCheckpoint(feed(createWitness(HUB_ID, PROJECT), checkpoint(one(B.writer, 5))), checkpoint(one(B.writer, 5, 'other')), roster()).state;
  const first = witnessOwn(forked, ownHeads(2), T0, true);
  assert.deepEqual(witnessOwn(first.state, ownHeads(2), at(DELAYED_AFTER_MS * 2), true).findings, []);
});

// A state holding every kind of record: marks, waits, own waits, replays and the newest checkpoint.
function richState(): WitnessState {
  let state = feed(createWitness(HUB_ID, PROJECT), checkpoint({ streams: [{ heads: [{ writer: A.writer, seq: 3 }, { writer: B.writer, seq: 1 }] }] }));
  state = witnessHeads(state, headSet([STREAM, A.writer, 5], [STREAM_B, B.writer, 2]), roster()).state;
  state = witnessCitations(state, [cite(B.writer, 7)], new Set(), T0).state;
  state = witnessOwn(state, ownHeads(6), T0, true).state;
  state = witnessEntry(state, { hash: headHash(A.writer, 1), held: true }).state;
  return state;
}

test('the saved state reads back unchanged, for a trusted hub and for a distrusted one with its proof', () => {
  const state = richState();
  const back = readWitness(serializeWitness(state), { hub: HUB_ID, project: PROJECT });
  assert.equal(back.ok, true);
  assert.deepEqual((back as { state: WitnessState }).state, state);
  const forked = witnessCheckpoint(state, checkpoint({ streams: [{ heads: [{ writer: A.writer, seq: 3, label: 'other' }, { writer: B.writer, seq: 1 }] }] }), roster()).state;
  assert.equal(forked.distrusted, true);
  const forkedBack = readWitness(serializeWitness(forked), { hub: HUB_ID, project: PROJECT });
  assert.equal(forkedBack.ok, true);
  assert.deepEqual((forkedBack as { state: WitnessState }).state, forked);
  // The read-back state keeps working: the distrusted hub is still distrusted after a restart.
  assert.deepEqual(kinds(witnessCheckpoint((forkedBack as { state: WitnessState }).state, checkpoint(one(A.writer, 9)), roster()).findings), ['forked-view']);
});

test('reading refuses a state over its size cap, for another hub or project, or malformed, each with a plain sentence', () => {
  const text = serializeWitness(richState());
  const expect = { hub: HUB_ID, project: PROJECT };
  const refused = (input: string, wanted = expect): string => {
    const result = readWitness(input, wanted);
    assert.equal(result.ok, false);
    const failure = result as { reason: keyof typeof WITNESS_REFUSALS; message: string };
    assert.equal(failure.message, WITNESS_REFUSALS[failure.reason]);
    return failure.reason;
  };
  assert.equal(refused(' '.repeat(WITNESS_MAX_BYTES + 1)), 'too-large');
  assert.equal(refused(text, { hub: 'hub-exercise-south', project: PROJECT }), 'other-hub');
  assert.equal(refused(text, { hub: HUB_ID, project: OTHER_PROJECT }), 'other-project');
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const variant = (change: (value: Record<string, unknown>) => void): string => {
    const copy = structuredClone(parsed);
    change(copy);
    return JSON.stringify(copy);
  };
  for (const input of [
    'not json',
    '[]',
    variant((value) => { value.extra = 1; }),
    variant((value) => { value.v = 2; }),
    variant((value) => { (value.seen as Array<Record<string, unknown>>)[0].hash = 'short'; }),
    variant((value) => { (value.waiting as Array<Record<string, unknown>>)[0].since = 'yesterday'; }),
    variant((value) => { (value.own as Array<Record<string, unknown>>)[0].seq = -1; }),
    variant((value) => { value.replayed = 1.5; }),
    variant((value) => { value.distrusted = 'no'; }),
    variant((value) => { (value.newest as Record<string, unknown>).payload = { type: 'checkpoint' }; }),
    variant((value) => { value.proof = { a: value.newest, b: value.newest, stream: STREAM, reason: 'made-up' }; }),
    variant((value) => { value.distrusted = true; })
  ]) assert.equal(refused(input), 'malformed', input.slice(0, 60));
  for (const sentence of Object.values(WITNESS_REFUSALS)) assert.doesNotMatch(sentence, /\u2014/);
});

test('the caps keep a full saved state under its size limit with room for a proof of two full checkpoints', () => {
  let state = createWitness(HUB_ID, PROJECT);
  const members = Array.from({ length: MAX_SEEN_HEADS + 10 }, (_unused, index) => fixedSigner(`cap-${index}`));
  const capRoster = { deviceKey: (writer: string) => (members.some((member) => member.writer === writer) ? { publicKey: 'x', member: 'm' } : undefined) };
  state = witnessHeads(state, { streams: [{ stream: STREAM, heads: members.map((member) => ({ writer: member.writer, seq: Number.MAX_SAFE_INTEGER, hash: headHash(member.writer, 1) })) }] }, capRoster).state;
  assert.equal(state.seen.length, MAX_SEEN_HEADS);
  state = witnessCitations(state, members.map((member) => cite(member.writer, Number.MAX_SAFE_INTEGER)), new Set(), T0).state;
  assert.equal(state.waiting.length, MAX_WAITING);
  const own = members.map((member, index) => ({ stream: hex(`own/${index}`).slice(0, 32), heads: [{ writer: member.writer, seq: Number.MAX_SAFE_INTEGER, hash: headHash(member.writer, 1) }] }));
  state = witnessOwn(state, own, T0, true).state;
  assert.equal(state.own.length, MAX_OWN_WAITS);
  const size = Buffer.byteLength(serializeWitness(state), 'utf8');
  assert.ok(size + 2 * CHECKPOINT_MAX_BYTES + 4096 < WITNESS_MAX_BYTES, `a full state is ${size} bytes`);
});

test('the sentence table: all eight ids, one plain sentence each, counts filled in, no em-dash', () => {
  assert.deepEqual(Object.keys(HUB_FINDINGS).sort(), ['corrupt-blob', 'delayed', 'forked-view', 'injected', 'replayed', 'rolled-back', 'withheld', 'wrong-project']);
  for (const [kind, sentence] of Object.entries(HUB_FINDINGS)) {
    assert.equal(typeof sentence, 'string', kind);
    assert.match(sentence, /^The hub [^.]*\.$/, kind);
    assert.doesNotMatch(sentence, /\u2014/, kind);
    assert.doesNotMatch(findingSentence(kind as keyof typeof HUB_FINDINGS, 2), /\bN\b/, kind);
  }
  assert.equal(findingSentence('delayed', 1), 'The hub has not confirmed your changes for 1 minute.');
  assert.equal(findingSentence('withheld', 12), 'The hub has not delivered 12 changes that other people\'s work refers to.');
  assert.equal(findingSentence('withheld'), 'The hub has not delivered some changes that other people\'s work refers to.');
});

test('the module imports only hub-side replica modules and team helpers, so no Yjs or fold code reaches the hub test bundle', () => {
  const source = readFileSync(path.resolve(__dirname, '..', '..', 'src', 'domain', 'replica', 'hubWitness.ts'), 'utf8');
  const specifiers = [...source.matchAll(/^[ \t]*(?:import|export)[^;'"]*?\bfrom[ \t]*['"]([^'"\n]+)['"]/gm)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  const allowed = new Set(['./entry', './checkpoint', './chain', './rosterView', './transport']);
  for (const specifier of specifiers) {
    if (specifier.startsWith('node:')) continue;
    assert.ok(allowed.has(specifier) || /^\.\.\/team\/[A-Za-z]+$/.test(specifier), `hubWitness.ts may not import ${specifier}`);
  }
  assert.doesNotMatch(source, /\brequire\(|\bimport\(/);
  assert.doesNotMatch(source, /\u2014/);
});

test('ids and times are checked: a bad hub or project id and an invalid time are refused', () => {
  assert.throws(() => createWitness('', PROJECT));
  assert.throws(() => createWitness(HUB_ID, 'bad project'));
  assert.throws(() => witnessCitations(createWitness(HUB_ID, PROJECT), [], new Set(), new Date('nope')));
  assert.throws(() => witnessOwn(createWitness(HUB_ID, PROJECT), [], new Date(Number.NaN), true));
});
