// The hub witness (D-46, D-50, D-63, D-70; DESIGN 10.8 and 19). Pure: it reads no clock, does no I/O and holds no keys. A hub cannot forge an entry,
// because every entry is signed by a member's device, but it can still withhold, delay, roll back, show two versions, pass on junk, corrupt a blob,
// mix projects or replay. This module names each of those from what this computer already sees, in one plain sentence, so the one-shot sync (32-23)
// can count them, the malicious-hub harness (32-26) can drive every fault through them and Phase 33 can show them.
//
// Every witness function takes a state and returns a new state and its findings; the input state is never changed. The state is a plain value that
// serialises and reads back, one per hub per project (Phase 33 keeps it). Findings are values for the caller to show or count: the only thing this
// module decides is to stop trusting a hub's checkpoints once it has shown two versions of the project (forked-view), until the lead admits the hub
// again (Phase 33).
//
// Imports stay on hub-side modules (entry, checkpoint, chain and transport types, rosterView types, team helpers), so the hub's own test suite may
// load this file without Yjs or the fold (D-27, D-52). The hub never runs it, so it is not on the HUB_SIDE list.
import { fingerprintOf } from '../team/canonical';
import { CHECKPOINT_CONFLICTS, checkpointConflict, checkpointHash, readCheckpoint, verifyCheckpoint } from './checkpoint';
import type { Checkpoint, CheckpointEntry, CheckpointStream, SignedCheckpoint } from './checkpoint';
import { REPLICA_SIGNED_AT } from './entry';
import type { RosterView } from './rosterView';

// Closed finding ids, each with one plain sentence (DESIGN 10.8 and 19). N stands for the count findingSentence fills in. No em-dashes.
export const HUB_FINDINGS = {
  withheld: 'The hub has not delivered N changes that other people\'s work refers to.',
  delayed: 'The hub has not confirmed your changes for N minutes.',
  'rolled-back': 'The hub showed an older copy of this project than this computer has already seen.',
  'forked-view': 'The hub showed two different versions of this project, so this computer no longer trusts its checkpoints.',
  injected: 'The hub sent a change that is not validly signed by anyone in this project, and it was refused.',
  'corrupt-blob': 'The hub sent an attachment that does not match its fingerprint, and it was refused.',
  'wrong-project': 'The hub answered with data from another project, and it was refused.',
  replayed: 'The hub sent changes this computer already had, so nothing changed.'
} as const;
export type HubFindingKind = keyof typeof HUB_FINDINGS;

// What the caller shows or counts. detail holds short ids only (12 characters), never a full hash.
export interface HubFinding {
  kind: HubFindingKind;
  sentence: string;
  detail: Readonly<Record<string, string | number>>;
  count?: number;
}

// Why two checkpoints prove the hub showed two versions: the checkpoint module's conflicts, and the two head checks this module adds.
export const WITNESS_PROOF_REASONS = {
  ...CHECKPOINT_CONFLICTS,
  'same-seq-other-hash': 'Two checkpoints from one hub name different entries at the same place in one writer\'s log.',
  'same-heads-other-count': 'Two checkpoints from one hub name the same heads of a stream and count a different number of entries under them.'
} as const;
export type WitnessProofReason = keyof typeof WITNESS_PROOF_REASONS;

// The two signed checkpoints are the proof: anyone can check both signatures and the disagreement.
export interface WitnessProof { a: SignedCheckpoint; b: SignedCheckpoint; stream: string; reason: WitnessProofReason }

// The highest place in a writer's log this hub has shown, from heads or from an accepted checkpoint.
export interface SeenHead { stream: string; writer: string; seq: number; hash: string }
// A cited entry (a dep or a checkpoint head) this computer does not hold, and when it was first seen missing.
export interface WaitingCitation { hash: string; stream: string; writer: string; seq: number; since: string }
// One of this device's writer logs whose head no checkpoint covers yet, from when it was first seen uncovered while connected.
export interface OwnWait { stream: string; writer: string; seq: number; since: string }

export const WITNESS_VERSION = 1;

export interface WitnessState {
  v: 1;
  hub: string;
  project: string;
  // The newest checkpoint this computer accepted from this hub for this project. Dropped once the hub is distrusted: the proof keeps it.
  newest?: SignedCheckpoint;
  seen: SeenHead[];
  waiting: WaitingCitation[];
  own: OwnWait[];
  // How many entries the hub sent that this computer already held.
  replayed: number;
  distrusted: boolean;
  proof?: WitnessProof;
}

export interface WitnessResult { state: WitnessState; findings: HubFinding[] }
// trusted: the checkpoint is now the newest, so the caller may use it (as a join base, or as final order).
export interface CheckpointWitness extends WitnessResult { trusted: boolean }

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SHORT = 12;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const short = (value: string): string => value.slice(0, SHORT);

// The sentence for a finding, with the count filled in where the sentence has one ("1 change", "3 changes"). Without a count, "some".
export function findingSentence(kind: HubFindingKind, count?: number): string {
  const text: string = HUB_FINDINGS[kind];
  if (!/\bN /.test(text)) return text;
  if (count === undefined) return text.replace(/\bN /, 'some ');
  return text.replace(/\bN (\w+?)s\b/, (_match, word: string) => (count === 1 ? `1 ${word}` : `${count} ${word}s`));
}

function finding(kind: HubFindingKind, detail: Record<string, string | number>, count?: number): HubFinding {
  const result: HubFinding = { kind, sentence: findingSentence(kind, count), detail };
  if (count !== undefined) result.count = count;
  return result;
}

// A new state object with the keys in a fixed order and no key holding undefined, so a state always survives a JSON round trip unchanged.
function make(base: WitnessState, changes: Partial<WitnessState> = {}): WitnessState {
  const merged = { ...base, ...changes };
  const state: WitnessState = { v: 1, hub: merged.hub, project: merged.project, seen: merged.seen, waiting: merged.waiting, own: merged.own, replayed: merged.replayed, distrusted: merged.distrusted };
  if (merged.newest !== undefined) state.newest = merged.newest;
  if (merged.proof !== undefined) state.proof = merged.proof;
  return state;
}

// A fresh witness for one hub and one project. Throws on an id this version cannot keep.
export function createWitness(hub: string, project: string): WitnessState {
  if (!ID_PATTERN.test(hub) || !ID_PATTERN.test(project)) throw new Error('The hub or project id is not one this version can keep.');
  return { v: 1, hub, project, seen: [], waiting: [], own: [], replayed: 0, distrusted: false };
}

// Raises the seen high-water marks with the heads given; a head below or level with a known mark changes nothing.
function raiseSeen(seen: readonly SeenHead[], heads: ReadonlyArray<SeenHead>): SeenHead[] {
  const next = new Map(seen.map((row) => [`${row.stream}/${row.writer}`, row]));
  for (const head of heads) {
    const key = `${head.stream}/${head.writer}`;
    const known = next.get(key);
    if (known === undefined || head.seq > known.seq) next.set(key, { stream: head.stream, writer: head.writer, seq: head.seq, hash: head.hash });
  }
  return [...next.values()].sort((a, b) => compareText(a.stream, b.stream) || compareText(a.writer, b.writer));
}

const headsOf = (checkpoint: Checkpoint): SeenHead[] => checkpoint.streams.flatMap((stream) => stream.heads.map((head) => ({ stream: stream.stream, writer: head.writer, seq: head.seq, hash: head.hash })));

interface Below { stream: string; writer: string; seq: number; had: number }
interface Comparison { below: Below[]; fork?: { stream: string; reason: WitnessProofReason } }

function sameHeads(a: CheckpointStream, b: CheckpointStream): boolean {
  return a.heads.length === b.heads.length && a.heads.every((head) => b.heads.some((other) => other.writer === head.writer && other.seq === head.seq && other.hash === head.hash));
}

// Every head of every stream in the older checkpoint against the newer one. A head the newer one lacks, or names at a lower seq, is below it: an
// honest hub's coverage only grows, because it keeps the keys of every cell it was granted (D-63, D-64). The same seq with another hash, or the same
// heads with another count, cannot both be right.
function compareCheckpoints(old: Checkpoint, next: Checkpoint): Comparison {
  const below: Below[] = [];
  let fork: Comparison['fork'];
  for (const stream of old.streams) {
    const other = next.streams.find((candidate) => candidate.stream === stream.stream);
    for (const head of stream.heads) {
      const match = other?.heads.find((candidate) => candidate.writer === head.writer);
      if (match === undefined || match.seq < head.seq) below.push({ stream: stream.stream, writer: head.writer, seq: match?.seq ?? -1, had: head.seq });
      else if (match.seq === head.seq && match.hash !== head.hash && fork === undefined) fork = { stream: stream.stream, reason: 'same-seq-other-hash' };
    }
    if (other !== undefined && fork === undefined && sameHeads(stream, other) && stream.count !== other.count) fork = { stream: stream.stream, reason: 'same-heads-other-count' };
  }
  return { below, fork };
}

// The envelope this computer keeps: rebuilt from the verified checkpoint and the signer's roster key, because verifyCheckpoint ignores the signer
// field the hub sent and checks against the roster. No field the hub added survives.
function keptCopy(checkpoint: Checkpoint, sig: string, roster: RosterView): SignedCheckpoint {
  const device = roster.deviceKey(checkpoint.signer) as { publicKey: string };
  const fingerprint = fingerprintOf(Buffer.from(device.publicKey, 'base64url'));
  return { v: 1, purpose: 'staff-replica', signer: { fingerprint, publicKey: device.publicKey }, signedAt: REPLICA_SIGNED_AT, payload: checkpoint, sig };
}

// A checkpoint the hub sent (D-46). In order: it must verify for this roster (else injected), name this project (else wrong-project) and come from
// a hub this computer still trusts (else forked-view again). Then it is compared with the newest one held: a head below it is rolled-back (the newest
// stays), another version is forked-view (both kept as proof, the hub distrusted), and otherwise it becomes the newest. entries, when given, lets
// checkpointConflict judge nesting as well as equal counts; pass the entries this computer holds under both checkpoints, or none.
export function witnessCheckpoint(state: WitnessState, signed: unknown, roster: RosterView, entries?: readonly CheckpointEntry[]): CheckpointWitness {
  const verdict = verifyCheckpoint(signed, roster);
  if (!verdict.ok) return { state: make(state), findings: [finding('injected', { reason: verdict.reason })], trusted: false };
  const checkpoint = verdict.checkpoint;
  if (checkpoint.project !== state.project) return { state: make(state), findings: [finding('wrong-project', { project: short(checkpoint.project), checkpoint: short(verdict.hash) })], trusted: false };
  if (state.distrusted) return { state: make(state), findings: [finding('forked-view', { checkpoint: short(verdict.hash) })], trusted: false };
  const kept = keptCopy(checkpoint, (signed as { sig: string }).sig, roster);
  const accept = (): CheckpointWitness => ({ state: make(state, { newest: kept, seen: raiseSeen(state.seen, headsOf(checkpoint)) }), findings: [], trusted: true });
  if (state.newest === undefined) return accept();
  if (checkpointHash(state.newest) === verdict.hash) return { state: make(state), findings: [], trusted: true };
  const old = readCheckpoint(state.newest.payload) as Checkpoint;
  const comparison = compareCheckpoints(old, checkpoint);
  const conflict = checkpointConflict(state.newest, kept, entries);
  if (conflict !== undefined || comparison.fork !== undefined) {
    const proof: WitnessProof = conflict !== undefined
      ? { a: conflict.a, b: conflict.b, stream: conflict.stream, reason: conflict.reason }
      : { a: state.newest, b: kept, stream: (comparison.fork as { stream: string }).stream, reason: (comparison.fork as { reason: WitnessProofReason }).reason };
    return { state: make(state, { newest: undefined, distrusted: true, proof }), findings: [finding('forked-view', { stream: short(proof.stream), reason: proof.reason })], trusted: false };
  }
  if (comparison.below.length > 0) {
    const first = [...comparison.below].sort((a, b) => compareText(a.stream, b.stream) || compareText(a.writer, b.writer))[0];
    const detail = { stream: short(first.stream), writer: short(first.writer), seq: first.seq, seen: first.had };
    return { state: make(state), findings: [finding('rolled-back', detail, comparison.below.length)], trusted: false };
  }
  return accept();
}

