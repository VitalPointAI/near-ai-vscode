// The hub witness (D-46, D-50, D-63, D-70; DESIGN 10.8 and 19). Pure: it reads no clock, does no I/O and holds no keys. A hub cannot forge an entry,
// because every entry is signed by a member's device, but it can still withhold, delay, roll back, show two versions, pass on junk, corrupt a blob,
// mix projects or replay. This module names each of those from what this computer already sees, in one plain sentence, so the one-shot sync (32-23)
// can count them, the malicious-hub harness (32-26) can drive every fault through them and Phase 33 can show them.
//
// Every witness function takes a state and returns a new state and its findings; the input state is never changed. The state is a plain value that
// serialises and reads back, one per hub per project (Phase 33 keeps it). Findings are values for the caller to show or count: the only thing this
// module decides is to stop trusting a hub's checkpoints once it has shown two versions of the project (forked-view), until the lead admits the hub
// again: readmitWitness, given the hash of a folded hub.readmit entry (Phase 33 D-42), clears the mark once per entry.
//
// Imports stay on hub-side modules (entry, checkpoint, chain and transport types, rosterView types, team helpers), so the hub's own test suite may
// load this file without Yjs or the fold (D-27, D-52). The hub never runs it, so it is not on the HUB_SIDE list.
import { fingerprintOf } from '../team/canonical';
import { CHECKPOINT_CONFLICTS, checkpointConflict, checkpointHash, readCheckpoint, verifyCheckpoint } from './checkpoint';
import type { Checkpoint, CheckpointEntry, CheckpointStream, SignedCheckpoint } from './checkpoint';
import { isRecord, isSafeIntegerInRange } from '../team/validate';
import { HASH_PATTERN, REPLICA_SIGNED_AT, STREAM_ID_PATTERN, sha256Hex } from './entry';
import type { Citation } from './chain';
import type { RosterView } from './rosterView';
import type { HeadSet } from './transport';

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

// The highest place in a writer's log this hub has shown, from heads or from an accepted checkpoint. Rollback is judged by seq, so no hash is kept.
export interface SeenHead { stream: string; writer: string; seq: number }
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
  // The hub.readmit entry hashes this witness already applied, sorted (Phase 33 D-42). Each clears a distrusted hub once; absent when none.
  readmitted?: string[];
}

export interface WitnessResult { state: WitnessState; findings: HubFinding[] }
// trusted: the checkpoint is now the newest, so the caller may use it (as a join base, or as final order).
export interface CheckpointWitness extends WitnessResult { trusted: boolean }

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const REASON_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SHORT = 12;
// How long a cited entry may be missing before it is withheld, and how long this device's own entries may go without a checkpoint while connected
// before they are delayed (D-50). Exported so the malicious-hub harness (32-26) drives them; time is always an argument.
export const WITHHELD_GRACE_MS = 60_000;
export const DELAYED_AFTER_MS = 300_000;
export const WITNESS_MAX_BYTES = 256 * 1024;
// Caps that keep a saved state under WITNESS_MAX_BYTES even holding a proof of two full-size checkpoints (two times CHECKPOINT_MAX_BYTES). 400
// heads is about what a full checkpoint holds. Past a cap new rows are not added; rows already held keep working, and withheld counts at most
// MAX_WAITING changes.
export const MAX_SEEN_HEADS = 400;
export const MAX_WAITING = 128;
export const MAX_OWN_WAITS = 64;
// At most this many re-admissions of one hub are remembered. Past it a further hub.readmit clears nothing (it fails closed): admit a new hub instead.
export const MAX_READMITTED = 64;

const isHash = (value: unknown): value is string => typeof value === 'string' && HASH_PATTERN.test(value);
const isStream = (value: unknown): value is string => typeof value === 'string' && STREAM_ID_PATTERN.test(value);
const isSeq = (value: unknown): value is number => isSafeIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER);

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
  if (merged.readmitted !== undefined && merged.readmitted.length > 0) state.readmitted = merged.readmitted;
  return state;
}

// A fresh witness for one hub and one project. Throws on an id this version cannot keep.
export function createWitness(hub: string, project: string): WitnessState {
  if (!ID_PATTERN.test(hub) || !ID_PATTERN.test(project)) throw new Error('The hub or project id is not one this version can keep.');
  return { v: 1, hub, project, seen: [], waiting: [], own: [], replayed: 0, distrusted: false };
}

// Raises the seen high-water marks with the heads given; a head below or level with a known mark changes nothing. Past MAX_SEEN_HEADS a new writer
// log is not tracked, and the marks already held keep rising.
function raiseSeen(seen: readonly SeenHead[], heads: ReadonlyArray<SeenHead>): SeenHead[] {
  const next = new Map(seen.map((row) => [`${row.stream}/${row.writer}`, row]));
  for (const head of heads) {
    const key = `${head.stream}/${head.writer}`;
    const known = next.get(key);
    if (known === undefined && next.size >= MAX_SEEN_HEADS) continue;
    if (known === undefined || head.seq > known.seq) next.set(key, { stream: head.stream, writer: head.writer, seq: head.seq });
  }
  return [...next.values()].sort((a, b) => compareText(a.stream, b.stream) || compareText(a.writer, b.writer));
}

const headsOf = (checkpoint: Checkpoint): SeenHead[] => checkpoint.streams.flatMap((stream) => stream.heads.map((head) => ({ stream: stream.stream, writer: head.writer, seq: head.seq })));

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

// A checkpoint the hub sent (D-46). In order: it must verify for this roster (else injected), name this project (else wrong-project), be signed by
// the hub this witness watches (else injected, other-signer: another hub your organization admitted may sign checkpoints too, but its checkpoints
// say nothing about this hub's copy, so they are never kept as this hub's newest nor compared with it) and come from a hub this computer still
// trusts (else forked-view again). Then it is compared with the newest one held: a head below it is rolled-back (the newest
// stays), another version is forked-view (both kept as proof, the hub distrusted), and otherwise it becomes the newest. entries, when given, lets
// checkpointConflict judge nesting as well as equal counts; pass the entries this computer holds under both checkpoints, or none.
export function witnessCheckpoint(state: WitnessState, signed: unknown, roster: RosterView, entries?: readonly CheckpointEntry[]): CheckpointWitness {
  const verdict = verifyCheckpoint(signed, roster);
  if (!verdict.ok) return { state: make(state), findings: [finding('injected', { reason: verdict.reason })], trusted: false };
  const checkpoint = verdict.checkpoint;
  if (checkpoint.project !== state.project) return { state: make(state), findings: [finding('wrong-project', { project: short(checkpoint.project), checkpoint: short(verdict.hash) })], trusted: false };
  if (checkpoint.signer !== state.hub) return { state: make(state), findings: [finding('injected', { reason: 'other-signer', signer: short(checkpoint.signer) })], trusted: false };
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

// The lead trusted the hub again (Phase 33 D-42): readmitHash is the hash of a hub.readmit entry for this hub that the roster folded (rosterView
// hubReadmits). Applied once per entry hash: a distrusted hub becomes trusted, its proof and the checkpoint and heads it showed before are dropped
// (a hub restored from a backup legitimately shows an older copy, and the lead compared its pin before re-admitting it), and the hash is
// remembered. The same hash again changes nothing, so after a later finding only a new hub.readmit clears it. The caller passes only hashes the
// folded roster names for this hub; the witness holds no roster.
export function readmitWitness(state: WitnessState, readmitHash: string): WitnessResult {
  const readmitted = state.readmitted ?? [];
  if (!isHash(readmitHash) || readmitted.includes(readmitHash) || readmitted.length >= MAX_READMITTED) return { state: make(state), findings: [] };
  const next = make(state, { distrusted: false, proof: undefined, newest: undefined, seen: [], readmitted: [...readmitted, readmitHash].sort() });
  return { state: next, findings: [] };
}

// The heads the hub reports (D-50). Each head below the mark this hub already showed for that writer log is rolled-back (one finding, the first
// named, the count of all); higher heads raise the mark. Only writers the roster knows are tracked, and only heads in a valid shape, so a hub cannot
// fill the marks with made-up writers. A same-seq head with another hash is a writer fork, which the chain stage handles, and changes no mark.
// heads.checkpoint is not read here: pass it to witnessCheckpoint.
export function witnessHeads(state: WitnessState, heads: HeadSet, roster: Pick<RosterView, 'deviceKey' | 'sessionCertificate'>): WitnessResult {
  const rows: SeenHead[] = [];
  for (const stream of Array.isArray(heads?.streams) ? heads.streams : []) {
    if (!isStream(stream?.stream) || !Array.isArray(stream.heads)) continue;
    for (const head of stream.heads) {
      // A person's session key the roster vouches for is tracked like a device (Phase 33 D-62).
      const known = isHash(head?.writer) && (roster.deviceKey(head.writer) !== undefined || roster.sessionCertificate?.(head.writer) !== undefined);
      if (!known || !isSeq(head.seq) || !isHash(head.hash)) continue;
      rows.push({ stream: stream.stream, writer: head.writer, seq: head.seq });
    }
  }
  const marks = new Map(state.seen.map((row) => [`${row.stream}/${row.writer}`, row]));
  const below = rows
    .filter((row) => { const mark = marks.get(`${row.stream}/${row.writer}`); return mark !== undefined && row.seq < mark.seq; })
    .sort((a, b) => compareText(a.stream, b.stream) || compareText(a.writer, b.writer));
  const next = make(state, { seen: raiseSeen(state.seen, rows) });
  if (below.length === 0) return { state: next, findings: [] };
  const first = below[0];
  const had = (marks.get(`${first.stream}/${first.writer}`) as SeenHead).seq;
  return { state: next, findings: [finding('rolled-back', { stream: short(first.stream), writer: short(first.writer), seq: first.seq, seen: had }, below.length)] };
}

// What a hub response says it carries. project is required in every response; stream when the answer is about one stream.
export interface ResponseLabel { project: string; stream?: string }

// A response must name this project and, when it names a stream, one of the streams asked for (D-50). asked is the stream or streams in the request.
export function witnessResponse(state: WitnessState, response: ResponseLabel, asked: string | readonly string[]): WitnessResult {
  const streams: readonly string[] = typeof asked === 'string' ? [asked] : asked;
  const project = typeof response?.project === 'string' ? response.project : '';
  if (project !== state.project) return { state: make(state), findings: [finding('wrong-project', { project: short(project) })] };
  if (response.stream !== undefined && !streams.includes(response.stream)) {
    return { state: make(state), findings: [finding('wrong-project', { stream: short(String(response.stream)) })] };
  }
  return { state: make(state), findings: [] };
}

// One entry the hub sent, after this computer checked it: already held (replayed, counted and harmless), failed verification with the verifier's
// reason id (injected), or verified and new (nothing, and it stops waiting if it was cited).
export type EntryWitness =
  | { hash: string; held: true }
  | { hash: string; held?: false; verified: true }
  | { hash: string; held?: false; verified: false; reason: string };

export function witnessEntry(state: WitnessState, entry: EntryWitness): WitnessResult {
  const id = short(String(entry.hash));
  if (entry.held === true) {
    const replayed = state.replayed + 1;
    return { state: make(state, { replayed }), findings: [finding('replayed', { entry: id }, replayed)] };
  }
  if (entry.verified === false) {
    const reason = typeof entry.reason === 'string' && REASON_PATTERN.test(entry.reason) ? entry.reason : 'unknown';
    return { state: make(state), findings: [finding('injected', { entry: id, reason })] };
  }
  const waiting = state.waiting.filter((row) => row.hash !== entry.hash);
  return { state: make(state, { waiting }), findings: [] };
}

// The raw bytes of a blob, or its base64url text as SealedBlob carries it, must hash to its name (D-50). Bytes that cannot be read are corrupt too.
export function witnessBlob(state: WitnessState, name: string, bytes: Uint8Array | string): WitnessResult {
  let raw: Buffer | undefined;
  if (typeof bytes === 'string') {
    const decoded = Buffer.from(bytes, 'base64url');
    raw = decoded.toString('base64url') === bytes ? decoded : undefined;
  } else if (bytes instanceof Uint8Array) {
    raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (isHash(name) && raw !== undefined && sha256Hex(raw) === name) return { state: make(state), findings: [] };
  return { state: make(state), findings: [finding('corrupt-blob', { blob: short(String(name)) })] };
}

function assertTime(now: Date): number {
  const ms = now instanceof Date ? now.getTime() : Number.NaN;
  if (Number.isNaN(ms)) throw new Error('The witness was given no valid time.');
  return ms;
}

const sinceMs = (since: string): number => Date.parse(since);

// Cited entries this computer does not hold: the missing deps of held entries and the heads of verified checkpoints, as Citation rows (D-50).
// The first time each hash is seen missing is kept; a hash held now stops waiting. At WITHHELD_GRACE_MS one withheld finding counts every hash
// missing that long, naming the oldest. held is the set of hashes this computer holds, or a lookup.
export function witnessCitations(state: WitnessState, cited: readonly Citation[], held: ReadonlySet<string> | ((hash: string) => boolean), now: Date): WitnessResult {
  const ms = assertTime(now);
  const isHeld = typeof held === 'function' ? held : (hash: string): boolean => held.has(hash);
  const waiting = state.waiting.filter((row) => !isHeld(row.hash));
  const known = new Set(waiting.map((row) => row.hash));
  for (const citation of cited) {
    if (!isHash(citation?.hash) || !isStream(citation.stream) || !isHash(citation.writer) || !isSeq(citation.seq)) continue;
    if (known.has(citation.hash) || isHeld(citation.hash) || waiting.length >= MAX_WAITING) continue;
    known.add(citation.hash);
    waiting.push({ hash: citation.hash, stream: citation.stream, writer: citation.writer, seq: citation.seq, since: now.toISOString() });
  }
  waiting.sort((a, b) => compareText(a.since, b.since) || compareText(a.hash, b.hash));
  const next = make(state, { waiting });
  const due = waiting.filter((row) => ms - sinceMs(row.since) >= WITHHELD_GRACE_MS);
  if (due.length === 0) return { state: next, findings: [] };
  const first = due[0];
  return { state: next, findings: [finding('withheld', { stream: short(first.stream), writer: short(first.writer), seq: first.seq, entry: short(first.hash) }, due.length)] };
}

// This device's own writer logs against the newest checkpoint (D-50, D-63). ownHeads are this device's heads per stream; covered, when given, lists
// the streams the hub can checkpoint (the base cell and cells granted with hub.grant), since the hub cannot cover a cell it cannot open. A head the
// newest checkpoint covers needs nothing. Otherwise its clock starts when it is first seen uncovered while connected and keeps running while the
// entries it started with stay uncovered; once a checkpoint covers those, the clock starts again for the rest. At DELAYED_AFTER_MS one delayed
// finding names the whole minutes of the oldest clock. Not connected, or a hub already distrusted, gives none and stops every clock.
export function witnessOwn(state: WitnessState, ownHeads: HeadSet['streams'], now: Date, connected: boolean, covered?: readonly string[]): WitnessResult {
  const ms = assertTime(now);
  if (!connected || state.distrusted) return { state: make(state, { own: [] }), findings: [] };
  const newest = state.newest === undefined ? undefined : readCheckpoint(state.newest.payload);
  const coverage = new Map((newest === undefined ? [] : headsOf(newest)).map((head) => [`${head.stream}/${head.writer}`, head.seq]));
  const before = new Map(state.own.map((row) => [`${row.stream}/${row.writer}`, row]));
  const own: OwnWait[] = [];
  const done = new Set<string>();
  for (const stream of Array.isArray(ownHeads) ? ownHeads : []) {
    if (!isStream(stream?.stream) || !Array.isArray(stream.heads) || (covered !== undefined && !covered.includes(stream.stream))) continue;
    for (const head of stream.heads) {
      if (!isHash(head?.writer) || !isSeq(head.seq)) continue;
      const key = `${stream.stream}/${head.writer}`;
      const coveredSeq = coverage.get(key) ?? -1;
      if (head.seq <= coveredSeq || done.has(key) || own.length >= MAX_OWN_WAITS) continue;
      done.add(key);
      const known = before.get(key);
      own.push(known !== undefined && known.seq > coveredSeq ? known : { stream: stream.stream, writer: head.writer, seq: head.seq, since: now.toISOString() });
    }
  }
  own.sort((a, b) => compareText(a.stream, b.stream) || compareText(a.writer, b.writer));
  const next = make(state, { own });
  const oldest = [...own].sort((a, b) => compareText(a.since, b.since))[0];
  if (oldest === undefined || ms - sinceMs(oldest.since) < DELAYED_AFTER_MS) return { state: next, findings: [] };
  const minutes = Math.floor((ms - sinceMs(oldest.since)) / 60_000);
  return { state: next, findings: [finding('delayed', { stream: short(oldest.stream), writer: short(oldest.writer), seq: oldest.seq }, minutes)] };
}

// The saved form: plain JSON of the state, whose keys are already in a fixed order. With the caps above it stays under WITNESS_MAX_BYTES.
export function serializeWitness(state: WitnessState): string {
  return JSON.stringify(state);
}

export const WITNESS_REFUSALS = {
  'too-large': 'The saved record of this hub is larger than the allowed size, so it was not read.',
  malformed: 'The saved record of this hub is not one this version can read.',
  'other-hub': 'The saved record belongs to another hub, so it was not read.',
  'other-project': 'The saved record belongs to another project, so it was not read.'
} as const;
export type WitnessRefusal = keyof typeof WITNESS_REFUSALS;
export type WitnessRead = { ok: true; state: WitnessState } | { ok: false; reason: WitnessRefusal; message: string };

class Malformed extends Error {}

function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value)) throw new Malformed();
  const keys = Object.keys(value);
  if (!required.every((key) => keys.includes(key)) || !keys.every((key) => required.includes(key) || optional.includes(key))) throw new Malformed();
  return value;
}

function readTime(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Malformed();
  return value;
}

function readList<T>(value: unknown, cap: number, row: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > cap) throw new Malformed();
  return value.map(row);
}

function need<T>(ok: boolean, value: T): T {
  if (!ok) throw new Malformed();
  return value;
}

// A kept signed checkpoint, rebuilt from its closed keys. The signature is not checked again here: this is this computer's own record, and
// witnessCheckpoint verified it before keeping it.
function readKept(value: unknown, project: string): SignedCheckpoint {
  const signed = exactKeys(value, ['v', 'purpose', 'signer', 'signedAt', 'payload', 'sig']);
  const signer = exactKeys(signed.signer, ['fingerprint', 'publicKey']);
  const checkpoint = readCheckpoint(signed.payload);
  need(signed.v === 1 && signed.purpose === 'staff-replica' && signed.signedAt === REPLICA_SIGNED_AT && typeof signed.sig === 'string', null);
  need(typeof signer.fingerprint === 'string' && typeof signer.publicKey === 'string' && checkpoint !== undefined && checkpoint.project === project, null);
  return { v: 1, purpose: 'staff-replica', signer: { fingerprint: signer.fingerprint as string, publicKey: signer.publicKey as string }, signedAt: REPLICA_SIGNED_AT, payload: checkpoint as Checkpoint, sig: signed.sig as string };
}

const writerKey = (row: { stream: string; writer: string }): string => `${row.stream}/${row.writer}`;
const distinct = (keys: readonly string[]): boolean => new Set(keys).size === keys.length;

// Reads a saved state back for the hub and project the caller expects. Never throws: too large, another hub or project, or any shape this version
// does not write is refused with a plain sentence.
export function readWitness(text: string, expect: { hub: string; project: string }): WitnessRead {
  const refuse = (reason: WitnessRefusal): WitnessRead => ({ ok: false, reason, message: WITNESS_REFUSALS[reason] });
  if (typeof text !== 'string') return refuse('malformed');
  if (Buffer.byteLength(text, 'utf8') > WITNESS_MAX_BYTES) return refuse('too-large');
  try {
    const value = exactKeys(JSON.parse(text), ['v', 'hub', 'project', 'seen', 'waiting', 'own', 'replayed', 'distrusted'], ['newest', 'proof', 'readmitted']);
    const { hub, project } = value;
    if (value.v !== 1 || typeof hub !== 'string' || !ID_PATTERN.test(hub) || typeof project !== 'string' || !ID_PATTERN.test(project)) return refuse('malformed');
    if (hub !== expect.hub) return refuse('other-hub');
    if (project !== expect.project) return refuse('other-project');
    const seen = readList(value.seen, MAX_SEEN_HEADS, (item): SeenHead => {
      const row = exactKeys(item, ['stream', 'writer', 'seq']);
      return need(isStream(row.stream) && isHash(row.writer) && isSeq(row.seq), { stream: row.stream as string, writer: row.writer as string, seq: row.seq as number });
    });
    const waiting = readList(value.waiting, MAX_WAITING, (item): WaitingCitation => {
      const row = exactKeys(item, ['hash', 'stream', 'writer', 'seq', 'since']);
      return need(isHash(row.hash) && isStream(row.stream) && isHash(row.writer) && isSeq(row.seq), { hash: row.hash as string, stream: row.stream as string, writer: row.writer as string, seq: row.seq as number, since: readTime(row.since) });
    });
    const own = readList(value.own, MAX_OWN_WAITS, (item): OwnWait => {
      const row = exactKeys(item, ['stream', 'writer', 'seq', 'since']);
      return need(isStream(row.stream) && isHash(row.writer) && isSeq(row.seq), { stream: row.stream as string, writer: row.writer as string, seq: row.seq as number, since: readTime(row.since) });
    });
    need(distinct(seen.map(writerKey)) && distinct(waiting.map((row) => row.hash)) && distinct(own.map(writerKey)), null);
    need(isSeq(value.replayed) && typeof value.distrusted === 'boolean', null);
    const state: WitnessState = { v: 1, hub, project, seen, waiting, own, replayed: value.replayed as number, distrusted: value.distrusted as boolean };
    if (value.newest !== undefined) state.newest = readKept(value.newest, project);
    if (value.proof !== undefined) {
      const proof = exactKeys(value.proof, ['a', 'b', 'stream', 'reason']);
      const reason = proof.reason;
      need(isStream(proof.stream) && typeof reason === 'string' && Object.prototype.hasOwnProperty.call(WITNESS_PROOF_REASONS, reason), null);
      state.proof = { a: readKept(proof.a, project), b: readKept(proof.b, project), stream: proof.stream as string, reason: reason as WitnessProofReason };
    }
    if (value.readmitted !== undefined) {
      const readmitted = readList(value.readmitted, MAX_READMITTED, (item) => need(isHash(item), item as string));
      need(readmitted.length > 0 && readmitted.every((hash, index) => index === 0 || readmitted[index - 1] < hash), null);
      state.readmitted = readmitted;
    }
    // A distrusted hub always has its proof and no newest checkpoint; a trusted one has no proof.
    need(state.distrusted === (state.proof !== undefined) && !(state.distrusted && state.newest !== undefined), null);
    return { ok: true, state };
  } catch {
    return refuse('malformed');
  }
}
