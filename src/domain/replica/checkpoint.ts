// Finality checkpoints (DESIGN 4.6; D-14, D-36). Pure, hub-side: it imports no fold, no reducer and no Yjs, so a hub can compile it alone (the
// boundary test in plan 30-11 checks that). The caller folds the covered set to get digests and passes them in.
//
// A checkpoint says: for this project, at this roster head, these are the heads of every writer in every stream, this many entries sit under them,
// and this is the chained hash of their final order. Order covered by a checkpoint is final. The hub signs checkpoints from Phase 32; clients check
// them here and the fold places later-arriving entries after the covered prefix.
//
// Signing uses the same purpose as entry headers (staff-replica, D-05). The `type` field and the closed key list keep a checkpoint from ever
// verifying as an entry header, and a header from verifying as a checkpoint.
import { canonicalBytes, fingerprintOf, isStrictBase64url } from '../team/canonical';
import { signPayload, verifyPayload } from '../team/signedPayload';
import type { KeyStatusLookup } from '../team/keyStatus';
import type { PayloadSigner, SignedPayload } from '../team/signedPayload';
import { isRecord, isSafeIntegerInRange } from '../team/validate';
import { buildCausalGraph } from './causal';
import type { CausalGraph, GraphEntry } from './causal';
import { HASH_PATTERN, REPLICA_SIGNED_AT, sha256Hex, writerIdOf } from './entry';
import type { Dep } from './entry';
import { checkpointOrder } from './order';
import type { RosterView } from './rosterView';

export const CHECKPOINT_VERSION = 1;
export const CHECKPOINT_MAX_BYTES = 64 * 1024;
// The chained order hash starts from 64 zeros.
export const ORDER_TIP_START = '0'.repeat(64);
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PUBLIC_KEY_BYTES = 32;
const CHECKPOINT_KEYS = ['type', 'v', 'project', 'signer', 'rosterHead', 'streams'] as const;
const STREAM_KEYS = ['stream', 'heads', 'count', 'orderTip'] as const;
const STREAM_ID = /^[0-9a-f]{32}$/;

export interface CheckpointStream {
  stream: string;
  // The head of each writer's log in this stream, sorted by writer.
  heads: Dep[];
  // How many entries of this stream the checkpoint covers, and the chained hash of their final order.
  count: number;
  orderTip: string;
  // The digest of this stream when the covered set is folded, for cells the signer holds.
  digest?: string;
}

export interface Checkpoint {
  type: 'checkpoint';
  v: 1;
  project: string;
  // The writer id of the signing device (the hash of its public key).
  signer: string;
  rosterHead: string;
  streams: CheckpointStream[];
}

export type SignedCheckpoint = SignedPayload<Checkpoint>;

// Closed reason map: an id and one plain sentence each. No em-dashes.
export const CHECKPOINT_REFUSALS = {
  malformed: 'This is not a signed checkpoint this version can read.',
  'not-a-checkpoint': 'This signed item is not a checkpoint.',
  'too-large': 'The checkpoint is larger than the allowed size.',
  'unknown-signer': 'The device that signed this checkpoint is not known, so its signature cannot be checked.',
  'bad-signature': 'The signature does not match the checkpoint, so it was changed or was not made by this device.',
  'not-a-checkpoint-signer': 'This device is not allowed to sign checkpoints at the roster the checkpoint names.'
} as const;
export type CheckpointRefusal = keyof typeof CHECKPOINT_REFUSALS;

export const CHECKPOINT_MISMATCHES = {
  'missing-entries': 'Some entries under the checkpoint heads are not here yet, so the checkpoint cannot be checked.',
  'unlisted-stream': 'Entries under the checkpoint heads belong to a stream the checkpoint does not list.',
  'count-mismatch': 'The checkpoint counts a different number of entries than are under its heads.',
  'order-tip-mismatch': 'The checkpoint\'s order hash does not match the final order of the entries under its heads.',
  'digest-mismatch': 'The checkpoint\'s digest does not match the state folded from the entries under its heads.'
} as const;
export type CheckpointMismatchReason = keyof typeof CHECKPOINT_MISMATCHES;

export type CheckpointVerdict = { ok: true; checkpoint: Checkpoint; hash: string } | { ok: false; reason: CheckpointRefusal; message: string };

export interface CheckpointMismatch { stream: string; reason: CheckpointMismatchReason; expected?: unknown; actual?: unknown }
export interface Recomputation { ok: boolean; mismatches: CheckpointMismatch[] }

export const CHECKPOINT_CONFLICTS = {
  'equal-count-tip-mismatch': 'Two checkpoints from one signer cover the same number of entries of a stream and name different final orders.',
  'not-nested': 'A later checkpoint from one signer does not cover everything an earlier one covered.',
  'prefix-mismatch': 'A later checkpoint from one signer does not reproduce the final order an earlier one named.'
} as const;
export type CheckpointConflictReason = keyof typeof CHECKPOINT_CONFLICTS;
// The two signed checkpoints are the proof: anyone can check both signatures and the disagreement.
export interface CheckpointConflict { a: SignedCheckpoint; b: SignedCheckpoint; stream: string; reason: CheckpointConflictReason }

// What a checkpoint needs from an entry: the same fields the causal graph and the order read.
export type CheckpointEntry = GraphEntry;

// Authority is the roster view's job, so the key status handed to verifyPayload is always active.
const ALWAYS_ACTIVE: KeyStatusLookup = () => ({ state: 'active' });

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function readDep(value: unknown): Dep | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !['writer', 'seq', 'hash'].every((key) => keys.includes(key))) return undefined;
  const { writer, seq, hash } = value;
  if (!isHash(writer) || !isHash(hash) || !isSafeIntegerInRange(seq, 0, Number.MAX_SAFE_INTEGER)) return undefined;
  return { writer, seq: seq as number, hash };
}

function readStream(value: unknown): CheckpointStream | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (!STREAM_KEYS.every((key) => keys.includes(key)) || !keys.every((key) => (STREAM_KEYS as readonly string[]).includes(key) || key === 'digest')) return undefined;
  const { stream, heads, count, orderTip, digest } = value;
  if (typeof stream !== 'string' || !STREAM_ID.test(stream) || !Array.isArray(heads)) return undefined;
  if (!isSafeIntegerInRange(count, 0, Number.MAX_SAFE_INTEGER) || !isHash(orderTip)) return undefined;
  if (keys.includes('digest') && !isHash(digest)) return undefined;
  const read: Dep[] = [];
  for (const head of heads) {
    const dep = readDep(head);
    if (dep === undefined) return undefined;
    read.push(dep);
  }
  const result: CheckpointStream = { stream, heads: read, count: count as number, orderTip };
  if (keys.includes('digest')) result.digest = digest as string;
  return result;
}

// The checkpoint with its closed keys, or undefined. Never throws and never spreads the input. The result is NOT sorted: use normalise for that.
export function readCheckpoint(value: unknown): Checkpoint | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const keys = Object.keys(value);
    if (keys.length !== CHECKPOINT_KEYS.length || !CHECKPOINT_KEYS.every((key) => keys.includes(key))) return undefined;
    const { type, v, project, signer, rosterHead, streams } = value;
    if (type !== 'checkpoint' || v !== CHECKPOINT_VERSION) return undefined;
    if (typeof project !== 'string' || !PROJECT_PATTERN.test(project) || !isHash(signer) || !isHash(rosterHead) || !Array.isArray(streams)) return undefined;
    const read: CheckpointStream[] = [];
    for (const item of streams) {
      const stream = readStream(item);
      if (stream === undefined) return undefined;
      read.push(stream);
    }
    return { type: 'checkpoint', v: CHECKPOINT_VERSION, project, signer, rosterHead, streams: read };
  } catch {
    // Hostile input that cannot be read is not a checkpoint.
    return undefined;
  }
}

// Streams sorted by id and heads by writer, with no stream or writer twice, so one meaning has one set of bytes.
export function normaliseCheckpoint(checkpoint: Checkpoint): Checkpoint | undefined {
  const streams: CheckpointStream[] = [];
  for (const stream of [...checkpoint.streams].sort((a, b) => compareText(a.stream, b.stream))) {
    const heads = [...stream.heads].sort((a, b) => compareText(a.writer, b.writer));
    if (heads.some((head, index) => index > 0 && heads[index - 1].writer === head.writer)) return undefined;
    if (streams.length > 0 && streams[streams.length - 1].stream === stream.stream) return undefined;
    streams.push({ ...stream, heads: heads.map((head) => ({ writer: head.writer, seq: head.seq, hash: head.hash })) });
  }
  return { ...checkpoint, streams };
}

// Signs a checkpoint. The same bytes always give the same signature, because the signing time is the constant the entry headers use.
export function signCheckpoint(signer: PayloadSigner, checkpoint: Checkpoint): SignedCheckpoint {
  const read = readCheckpoint(checkpoint);
  const normal = read === undefined ? undefined : normaliseCheckpoint(read);
  if (normal === undefined) throw new Error('Nothing was signed: the checkpoint is not in the shape this version writes.');
  if (normal.signer !== writerIdOf(signer.publicKey)) throw new Error('Nothing was signed: the checkpoint names a different signer than the key that signs it.');
  return signPayload(signer, 'staff-replica', normal, { now: () => new Date(REPLICA_SIGNED_AT), maxBytes: CHECKPOINT_MAX_BYTES });
}

// The identity of a checkpoint: a hash of what was signed and its signature. FoldResult.checkpoint carries it.
export function checkpointHash(signed: { payload: Checkpoint; sig: string }): string {
  return sha256Hex(canonicalBytes({ payload: signed.payload, sig: signed.sig }));
}

function refusal(reason: CheckpointRefusal): CheckpointVerdict {
  return { ok: false, reason, message: CHECKPOINT_REFUSALS[reason] };
}

// Never throws. Order of checks: shape, the signer's device key, the signature, then the roster's say on who may sign checkpoints at the roster head.
export function verifyCheckpoint(signed: unknown, roster: RosterView): CheckpointVerdict {
  try {
    if (!isRecord(signed)) return refusal('malformed');
    const keys = Object.keys(signed);
    if (keys.length !== 6 || !['v', 'purpose', 'signer', 'signedAt', 'payload', 'sig'].every((key) => keys.includes(key))) return refusal('malformed');
    const { payload, sig } = signed;
    if (!isRecord(payload) || payload.type !== 'checkpoint') return refusal('not-a-checkpoint');
    const checkpoint = readCheckpoint(payload);
    if (checkpoint === undefined || typeof sig !== 'string') return refusal('malformed');
    // One meaning has one set of bytes: streams and heads must already be in the sorted form signCheckpoint writes.
    const normal = normaliseCheckpoint(checkpoint);
    if (normal === undefined || !canonicalBytes(normal).equals(canonicalBytes(checkpoint))) return refusal('malformed');
    const device = roster.deviceKey(checkpoint.signer);
    if (device === undefined || !isStrictBase64url(device.publicKey, PUBLIC_KEY_BYTES)) return refusal('unknown-signer');
    const raw = Buffer.from(device.publicKey, 'base64url');
    if (sha256Hex(raw) !== checkpoint.signer) return refusal('unknown-signer');
    const envelope = { v: 1, purpose: 'staff-replica', signer: { fingerprint: fingerprintOf(raw), publicKey: device.publicKey }, signedAt: REPLICA_SIGNED_AT, payload, sig };
    const verdict = verifyPayload(envelope, { purpose: 'staff-replica', status: ALWAYS_ACTIVE, maxBytes: CHECKPOINT_MAX_BYTES });
    if (!verdict.ok) return refusal(verdict.reason === 'too-large' ? 'too-large' : 'bad-signature');
    if (!roster.checkpointSigner(checkpoint.signer, checkpoint.rosterHead)) return refusal('not-a-checkpoint-signer');
    return { ok: true, checkpoint, hash: checkpointHash({ payload: checkpoint, sig }) };
  } catch {
    // Anything unforeseen on hostile input is a refusal of that input.
    return refusal('malformed');
  }
}

const headHashes = (checkpoint: Checkpoint): string[] => checkpoint.streams.flatMap((stream) => stream.heads.map((head) => head.hash));

// The entries a checkpoint covers: all its heads and everything they follow, as far as the graph holds them.
export function checkpointCoverage(checkpoint: Checkpoint, graph: CausalGraph): ReadonlySet<string> {
  return graph.closure(headHashes(checkpoint));
}

// The chained hash of an order: tip_k = sha256(tip_(k-1) || hash_k) over the raw bytes, starting from 64 zeros.
export function orderTipOf(hashes: readonly string[]): string {
  let tip = ORDER_TIP_START;
  for (const hash of hashes) tip = sha256Hex(Buffer.concat([Buffer.from(tip, 'hex'), Buffer.from(hash, 'hex')]));
  return tip;
}

// The covered entries in final order, under earlier checkpoints that nest inside this one (smallest first).
function coveredOrder(checkpoint: Checkpoint, graph: CausalGraph, entries: readonly CheckpointEntry[], earlier: readonly Checkpoint[]): CheckpointEntry[] | undefined {
  const missing = headHashes(checkpoint).some((hash) => !graph.has(hash));
  if (missing) return undefined;
  const covered = checkpointCoverage(checkpoint, graph);
  const inner = earlier
    .filter((other) => headHashes(other).every((hash) => graph.has(hash)))
    .map((other) => checkpointCoverage(other, graph))
    .sort((a, b) => a.size - b.size);
  return checkpointOrder(entries.filter((entry) => covered.has(entry.hash)), inner);
}

// Recomputes count, orderTip and (with the digests of folding the covered set) digest from the entries, and names every mismatch. earlier lists the
// checkpoints this one nests after, so the order reproduces the way the fold orders it.
export function recomputeCheckpoint(checkpoint: Checkpoint, entries: readonly CheckpointEntry[], coveredDigests?: Readonly<Record<string, string>>, earlier: readonly Checkpoint[] = []): Recomputation {
  const graph = buildCausalGraph(entries);
  const ordered = coveredOrder(checkpoint, graph, entries, earlier);
  if (ordered === undefined) {
    const mismatches = checkpoint.streams
      .filter((stream) => stream.heads.some((head) => !graph.has(head.hash)))
      .map((stream): CheckpointMismatch => ({ stream: stream.stream, reason: 'missing-entries' }));
    return { ok: false, mismatches };
  }
  const mismatches: CheckpointMismatch[] = [];
  const listed = new Set(checkpoint.streams.map((stream) => stream.stream));
  for (const stream of new Set(ordered.map((entry) => entry.header.stream))) {
    if (!listed.has(stream)) mismatches.push({ stream, reason: 'unlisted-stream' });
  }
  for (const stream of checkpoint.streams) {
    const hashes = ordered.filter((entry) => entry.header.stream === stream.stream).map((entry) => entry.hash);
    if (hashes.length !== stream.count) mismatches.push({ stream: stream.stream, reason: 'count-mismatch', expected: hashes.length, actual: stream.count });
    const tip = orderTipOf(hashes);
    if (tip !== stream.orderTip) mismatches.push({ stream: stream.stream, reason: 'order-tip-mismatch', expected: tip, actual: stream.orderTip });
    if (stream.digest !== undefined && coveredDigests !== undefined && coveredDigests[stream.stream] !== stream.digest) {
      mismatches.push({ stream: stream.stream, reason: 'digest-mismatch', expected: coveredDigests[stream.stream], actual: stream.digest });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

const totalCount = (checkpoint: Checkpoint): number => checkpoint.streams.reduce((sum, stream) => sum + stream.count, 0);

// Two checkpoints from one signer that disagree about one prefix are a hub equivocation proof (D-14, D-36).
// - Without entries: equal counts for one stream with different order tips is a proof alone, because a signer that has covered the same number of
//   entries twice must have named the same order.
// - With entries: the checkpoint that covers fewer entries is the earlier one. The later must cover everything the earlier covered, and its order tip
//   must be the one the nested order gives (the earlier prefix, then the rest). Anything else does not reproduce the earlier tip.
// Returns undefined when there is no disagreement, or when the entries given are not enough to judge.
export function checkpointConflict(a: SignedCheckpoint, b: SignedCheckpoint, entries?: readonly CheckpointEntry[]): CheckpointConflict | undefined {
  const first = readCheckpoint(a.payload);
  const second = readCheckpoint(b.payload);
  if (first === undefined || second === undefined) return undefined;
  if (first.signer !== second.signer || first.project !== second.project) return undefined;
  const shared = first.streams.filter((stream) => second.streams.some((other) => other.stream === stream.stream)).map((stream) => stream.stream).sort(compareText);
  for (const id of shared) {
    const left = first.streams.find((stream) => stream.stream === id) as CheckpointStream;
    const right = second.streams.find((stream) => stream.stream === id) as CheckpointStream;
    if (left.count === right.count && left.orderTip !== right.orderTip) return { a, b, stream: id, reason: 'equal-count-tip-mismatch' };
  }
  if (entries === undefined) return undefined;
  const firstIsEarlier = totalCount(first) <= totalCount(second);
  const [early, late] = firstIsEarlier ? [first, second] : [second, first];
  const graph = buildCausalGraph(entries);
  if (headHashes(early).some((hash) => !graph.has(hash)) || headHashes(late).some((hash) => !graph.has(hash))) return undefined;
  const earlyCovered = checkpointCoverage(early, graph);
  const lateCovered = checkpointCoverage(late, graph);
  const gone = entries.filter((entry) => earlyCovered.has(entry.hash) && !lateCovered.has(entry.hash)).sort((x, y) => compareText(x.hash, y.hash));
  if (gone.length > 0) return { a, b, stream: gone[0].header.stream, reason: 'not-nested' };
  const check = recomputeCheckpoint(late, entries, undefined, [early]);
  const wrong = check.mismatches.filter((mismatch) => mismatch.reason === 'order-tip-mismatch').map((mismatch) => mismatch.stream).sort(compareText);
  if (wrong.length > 0) return { a, b, stream: wrong[0], reason: 'prefix-mismatch' };
  return undefined;
}
