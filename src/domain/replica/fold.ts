// The fold (DESIGN 4.4, D-09, D-10, D-11). Pure: a function of the entries and an injected ReplicaContext. It reads no clock and does no I/O.
//
// The result keeps six different things apart, because they mean different things (Pitfall 11) and none of them but "applied" changes state:
// - applied: used by a reducer.
// - held: waiting for a piece that is missing; it becomes applied when the piece arrives.
// - rejected: permanently refused at verification or chain stage.
// - refused: a reducer refused it (for example forged attribution, or a client id collision), or the fold refused it write-down before any reducer
//   saw it (an entry citing a cell its own cell does not dominate, when the context supplies the cell order).
// - kept: genuine but not applied (unauthorised, made by a newer version, hub actor, or a family folded in a later phase).
// - excluded: skipped because its writer is quarantined (filled by plan 30-05).
//
// Two ways in, one apply loop (D-10): foldEntries folds a set from scratch, and addEntries folds as entries arrive. The incremental path appends
// when everything new sorts after what was applied, and refolds otherwise. The property tests prove the two agree.
import { buildCausalGraph } from './causal';
import type { CausalGraph } from './causal';
import { classifyChains } from './chain';
import type { ChainResult, EquivocationProof, HeldEntry, QuarantineRecord, RejectedEntry } from './chain';
import { checkpointBases, checkpointCoverage, checkpointHash, readCheckpoint, verifyCheckpoint } from './checkpoint';
import type { CheckpointBase, SignedCheckpoint } from './checkpoint';
import { streamDigests } from './digest';
import { entryHash, parseHeaderShape, sha256Hex } from './entry';
import { waitAnswered, waitOf } from './holdWaits';
import type { EntryHeader } from './entry';
import { kindFamily } from './kinds';
import type { KindFamily } from './kinds';
import { checkpointOrder } from './order';
import { DEFAULT_REDUCERS } from './reducers';
import type { AnyReducer, FoldView } from './reducers';
import type { ReplicaContext } from './rosterView';
import { verifyEntry } from './verify';
import type { KeepReason, VerifiedEntry, VerifyOutcome, VerifyRejection } from './verify';

export interface FoldOptions {
  reducers?: readonly AnyReducer[];
  // Checkpoints the caller has already verified (verifyCheckpoint). The fold uses the longest nested chain of them and reports the rest. The heads of
  // the version 2 ones are also join bases (D-04, D-42): a writer's log may start right after one (classifyChains).
  checkpoints?: readonly SignedCheckpoint[];
}
// A checkpoint the fold did not use because it does not nest with the chain it used.
export interface CheckpointNote { checkpoint: string; reason: 'does-not-nest' }
export interface KeptEntry { hash: string; reason: KeepReason; family?: string }
export interface RefusedEntry { hash: string; reason: string; family: string }

export interface FoldResult {
  // Admitted entries in the total order.
  order: string[];
  applied: string[];
  kept: KeptEntry[];
  held: HeldEntry[];
  rejected: RejectedEntry[];
  refused: RefusedEntry[];
  excluded: string[];
  quarantined: QuarantineRecord[];
  proofs: EquivocationProof[];
  // Each reducer's output, by family.
  families: Record<string, unknown>;
  // The digest of each stream that has admitted entries. Compare digests only between results with the same `checkpoint`: a machine that holds a
  // checkpoint and one that does not can number versions differently when a late concurrent entry exists.
  digests: Record<string, string>;
  // The hash of the last checkpoint the order was fixed by, or null when none was used.
  checkpoint: string | null;
  // Checkpoints that did not nest with the chain used.
  checkpointConflicts: CheckpointNote[];
  // How many inputs were not objects or had no readable header. They are counted and dropped, never kept; the rejected list shows one record per
  // reason. Not part of any digest.
  dropped: number;
}

const byHash = (a: { hash?: string }, b: { hash?: string }): number => ((a.hash ?? '') < (b.hash ?? '') ? -1 : (a.hash ?? '') > (b.hash ?? '') ? 1 : 0);

// Which copy of an entry the fold uses when copies differ (IN-03). A held copy beats a rejected one on purpose: a rejection is permanent, but a held
// copy says a good copy may still come (a corrupt body next to a good copy that cannot be opened is reported held, whichever arrives first).
export const OUTCOME_RANK: Readonly<Record<VerifyOutcome['status'], number>> = { verified: 0, held: 1, rejected: 2 };

// Negative when a is the better outcome. Ties between two held or two rejected copies go to the smaller reason, never to arrival order.
function compareOutcomes(a: VerifyOutcome, b: VerifyOutcome): number {
  const byRank = OUTCOME_RANK[a.status] - OUTCOME_RANK[b.status];
  if (byRank !== 0 || a.status === 'verified' || b.status === 'verified') return byRank;
  return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
}

// What the caller keeps from one delivery to the next. An earlier FoldState is never changed by addEntries.
// outcome is the best outcome of any copy. retry holds at most one held copy per hold reason, to be judged again when the context may answer
// (WR-08: never one per delivery). rejected is the best permanent rejection, kept so the copies judged again are still compared with it.
interface Chosen { outcome: VerifyOutcome; retry: Map<string, unknown>; rejected: VerifyOutcome | undefined }
// chosen is keyed by entry hash, so it is also the record of what has been seen: a copy is recognised by its header, never by object identity.
interface Store {
  chosen: Map<string, Chosen>;
  // One record per reason for inputs without a readable header.
  unreadable: Map<string, VerifyOutcome>;
  dropped: number;
}

// The reducers' working states and the lists the apply loop fills.
interface Run {
  states: Map<KindFamily, { reducer: AnyReducer; state: unknown }>;
  applied: string[];
  kept: KeptEntry[];
  refused: RefusedEntry[];
  held: HeldEntry[];
}

// The checkpoints the order is fixed by: a chain of nested covered sets, smallest first.
interface CheckpointPlan {
  used: string | null;
  sets: Array<ReadonlySet<string>>;
  final: ReadonlySet<string>;
  conflicts: CheckpointNote[];
}

// Everything derived from a Store that the apply loop needs.
interface Prepared {
  verifyHeld: HeldEntry[];
  verifyRejected: RejectedEntry[];
  chains: ChainResult;
  graph: CausalGraph;
  ordered: VerifiedEntry[];
  plan: CheckpointPlan;
  // How many of the first entries in the order are final under the checkpoints.
  prefix: number;
  // The checkpoint heads entries may cite without the entry itself (join bases), by hash: the write-down check reads their stream.
  bases: ReadonlyMap<string, CheckpointBase>;
}

// The reducers' states as they stood at the end of the final prefix, kept so a late entry outside the prefix refolds from there.
interface Snapshot { count: number; run: Run }

export interface FoldState {
  readonly result: FoldResult;
  // How many times the fold had to start again because an entry arrived out of place.
  readonly refolds: number;
  readonly ctx: ReplicaContext;
  readonly options: FoldOptions;
  readonly store: Store;
  readonly prepared: Prepared;
  readonly run: Run;
  readonly snapshot: Snapshot | undefined;
}

function emptyStore(): Store {
  return { chosen: new Map(), unreadable: new Map(), dropped: 0 };
}

function copyStore(store: Store): Store {
  const chosen = new Map<string, Chosen>();
  for (const [hash, entry] of store.chosen) chosen.set(hash, { outcome: entry.outcome, retry: new Map(entry.retry), rejected: entry.rejected });
  return { chosen, unreadable: new Map(store.unreadable), dropped: store.dropped };
}

type Copy = { status: 'known' } | { status: 'new'; hash: string; header: EntryHeader } | { status: 'unreadable'; outcome: VerifyOutcome & { status: 'rejected' } };

// What the store already knows of one input, found with a header-shape check and a hash only: no signature check and no decryption (WR-08). A copy
// whose entry is already verified is known, whatever its body holds, because the verified copy is the one the fold uses. An input that is not an
// object or has no readable header gets the outcome verifyEntry would give it, without a hash.
function knownCopy(store: Store, input: unknown): Copy {
  const unreadable = (reason: VerifyRejection): Copy => ({ status: 'unreadable', outcome: { status: 'rejected', reason } });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return unreadable('malformed-header');
  let hash: string;
  let header: EntryHeader;
  try {
    const shape = parseHeaderShape((input as { header?: unknown }).header);
    if (!shape.ok) return unreadable(shape.reason);
    header = shape.header;
    hash = entryHash(header);
  } catch {
    // A header that cannot be read is refused as verifyEntry refuses it.
    return unreadable('malformed-header');
  }
  return store.chosen.get(hash)?.outcome.status === 'verified' ? { status: 'known' } : { status: 'new', hash, header };
}

// Does the copy carry the body its header names? Copies of one header that pass this carry the same bytes, so keeping one of them loses nothing. It
// matters only for a hold reached before the body is checked (unknown-writer), where an intact copy and a corrupt one share the reason.
function bodyIntact(input: unknown, header: EntryHeader): boolean {
  const body = (input as { body?: unknown }).body;
  if (typeof body !== 'string' || body.length > Math.ceil((header.body.size * 4) / 3) + 4) return false;
  const bytes = Buffer.from(body, 'base64url');
  return bytes.length === header.body.size && bytes.toString('base64url') === body && sha256Hex(bytes) === header.body.hash;
}

// Verifies one input and records it. Returns true when it changed what the store knows. When copies of one entry differ (a damaged body next to a
// good one), the verified copy wins; otherwise the choice is by a fixed rule, never by arrival order. A copy of an entry already verified costs a
// hash and nothing more.
function ingest(store: Store, item: unknown, ctx: ReplicaContext): boolean {
  const copy = knownCopy(store, item);
  if (copy.status === 'known') return false;
  if (copy.status === 'unreadable') {
    store.dropped += 1;
    if (store.unreadable.has(copy.outcome.reason)) return false;
    store.unreadable.set(copy.outcome.reason, copy.outcome);
    return true;
  }
  const outcome = verifyEntry(item, ctx);
  const current = store.chosen.get(copy.hash);
  if (current === undefined) {
    store.chosen.set(copy.hash, {
      outcome,
      retry: outcome.status === 'held' ? new Map([[outcome.reason, item]]) : new Map(),
      rejected: outcome.status === 'rejected' ? outcome : undefined
    });
    return true;
  }
  if (outcome.status === 'verified') {
    store.chosen.set(copy.hash, { outcome, retry: new Map(), rejected: current.rejected });
    return true;
  }
  // A copy that changes nothing the fold shows may still change what is kept: a hold reason not kept yet, an intact copy in place of a corrupt one,
  // or a better rejection. Each of those can happen only a few times per entry, so reporting it as a change stays cheap.
  let kept = false;
  if (outcome.status === 'held') {
    const known = current.retry.get(outcome.reason);
    if (known === undefined || (!bodyIntact(known, copy.header) && bodyIntact(item, copy.header))) {
      current.retry.set(outcome.reason, item);
      kept = true;
    }
  } else if (current.rejected === undefined || compareOutcomes(outcome, current.rejected) < 0) {
    current.rejected = outcome;
    kept = true;
  }
  if (compareOutcomes(outcome, current.outcome) < 0) {
    current.outcome = outcome;
    return true;
  }
  return kept;
}

// Held entries wait for a piece the context may have gained since (a key, a blob, a device), so the kept copies are judged again from the best
// rejection alone, as a fold from scratch would judge them; verified and rejected entries never are. Returns true when the choice changed.
function retryHeld(store: Store, ctx: ReplicaContext): boolean {
  let changed = false;
  for (const [hash, entry] of [...store.chosen]) {
    if (entry.outcome.status !== 'held') continue;
    if (entry.rejected === undefined) store.chosen.delete(hash);
    else store.chosen.set(hash, { outcome: entry.rejected, retry: new Map(), rejected: entry.rejected });
    for (const item of entry.retry.values()) ingest(store, item, ctx);
    const now = store.chosen.get(hash);
    if (now === undefined || !sameChoice(entry, now)) changed = true;
  }
  return changed;
}

function sameChoice(a: Chosen, b: Chosen): boolean {
  if (a.outcome.status !== b.outcome.status || compareOutcomes(a.outcome, b.outcome) !== 0 || a.retry.size !== b.retry.size) return false;
  for (const [reason, item] of a.retry) if (b.retry.get(reason) !== item) return false;
  return true;
}

const isSubset = (small: ReadonlySet<string>, large: ReadonlySet<string>): boolean => {
  for (const hash of small) if (!large.has(hash)) return false;
  return true;
};

// The longest chain of nested covered sets among the checkpoints (strict subsets, smallest first); ties go to the larger final set, then the smaller
// hashes, so the choice never depends on the order the caller listed them in. The rest are reported when they are not comparable with the chain.
function planCheckpoints(checkpoints: readonly SignedCheckpoint[], graph: CausalGraph): CheckpointPlan {
  const byHash = new Map<string, { hash: string; covered: ReadonlySet<string> }>();
  for (const signed of checkpoints) {
    const checkpoint = readCheckpoint(signed.payload);
    if (checkpoint === undefined) continue;
    const covered = checkpointCoverage(checkpoint, graph);
    const hash = checkpointHash({ payload: checkpoint, sig: signed.sig });
    if (covered.size > 0) byHash.set(hash, { hash, covered });
  }
  const items = [...byHash.values()].sort((a, b) => a.covered.size - b.covered.size || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  const best: Array<Array<{ hash: string; covered: ReadonlySet<string> }>> = [];
  items.forEach((item, index) => {
    let chain = [item];
    for (let before = 0; before < index; before += 1) {
      const other = items[before];
      if (other.covered.size >= item.covered.size || !isSubset(other.covered, item.covered)) continue;
      const candidate = [...best[before], item];
      const better = candidate.length > chain.length || (candidate.length === chain.length && candidate.map((entry) => entry.hash).join() < chain.map((entry) => entry.hash).join());
      if (better) chain = candidate;
    }
    best.push(chain);
  });
  let chosen: Array<{ hash: string; covered: ReadonlySet<string> }> = [];
  for (const chain of best) {
    const last = chain[chain.length - 1];
    const current = chosen[chosen.length - 1];
    if (current === undefined || chain.length > chosen.length || (chain.length === chosen.length && last.covered.size > current.covered.size)) chosen = chain;
  }
  const inChain = new Set(chosen.map((entry) => entry.hash));
  const conflicts: CheckpointNote[] = [];
  for (const item of items) {
    if (inChain.has(item.hash)) continue;
    const incomparable = chosen.some((member) => !isSubset(item.covered, member.covered) && !isSubset(member.covered, item.covered));
    if (incomparable) conflicts.push({ checkpoint: item.hash, reason: 'does-not-nest' });
  }
  const last = chosen[chosen.length - 1];
  return { used: last === undefined ? null : last.hash, sets: chosen.map((entry) => entry.covered), final: last === undefined ? new Set<string>() : last.covered, conflicts };
}

// The verdicts of version 2 checkpoints, per signed object and roster view, so a fold that runs again does not check a signature twice.
const signerChecks = new WeakMap<object, WeakMap<object, boolean>>();

// A base lets entries in without their predecessors, so only a checkpoint that verifies here gives bases, even though the caller is asked to pass
// verified checkpoints only (T-31-19): one from a device the roster does not name as checkpoint signer gives none.
function joinBases(checkpoints: readonly SignedCheckpoint[], ctx: ReplicaContext): Map<string, CheckpointBase> {
  const usable = checkpoints.filter((signed) => {
    if (readCheckpoint(signed?.payload)?.v !== 2) return false;
    let byRoster = signerChecks.get(signed);
    if (byRoster === undefined) {
      byRoster = new WeakMap();
      signerChecks.set(signed, byRoster);
    }
    let ok = byRoster.get(ctx.roster);
    if (ok === undefined) {
      ok = verifyCheckpoint(signed, ctx.roster).ok;
      byRoster.set(ctx.roster, ok);
    }
    return ok;
  });
  return checkpointBases(usable);
}

function prepare(store: Store, ctx: ReplicaContext, options: FoldOptions): Prepared {
  const verified: VerifiedEntry[] = [];
  const verifyHeld: HeldEntry[] = [];
  const verifyRejected: RejectedEntry[] = [];
  for (const outcome of [...[...store.chosen.values()].map((entry) => entry.outcome), ...store.unreadable.values()]) {
    if (outcome.status === 'verified') {
      verified.push(outcome.entry);
      continue;
    }
    const place = outcome.header === undefined ? {} : { stream: outcome.header.stream, writer: outcome.header.writer, seq: outcome.header.seq };
    const record = { ...(outcome.hash === undefined ? {} : { hash: outcome.hash }), ...place, stage: 'verify' as const, reason: outcome.reason };
    (outcome.status === 'held' ? verifyHeld : verifyRejected).push(record);
  }
  const bases = joinBases(options.checkpoints ?? [], ctx);
  const chains = classifyChains(verified, ctx, verifyRejected, bases);
  const graph = buildCausalGraph(chains.admitted);
  const plan = planCheckpoints(options.checkpoints ?? [], graph);
  const ordered = checkpointOrder(chains.admitted, plan.sets);
  let prefix = 0;
  while (prefix < ordered.length && plan.final.has(ordered[prefix].hash)) prefix += 1;
  return { verifyHeld, verifyRejected, chains, graph, ordered, plan, prefix, bases };
}

function freshRun(reducers: readonly AnyReducer[]): Run {
  const states = new Map<KindFamily, { reducer: AnyReducer; state: unknown }>();
  for (const reducer of reducers) states.set(reducer.family, { reducer, state: reducer.init() });
  return { states, applied: [], kept: [], refused: [], held: [] };
}

function cloneRun(run: Run): Run {
  const states = new Map<KindFamily, { reducer: AnyReducer; state: unknown }>();
  for (const [family, slot] of run.states) states.set(family, { reducer: slot.reducer, state: slot.reducer.clone(slot.state) });
  return { states, applied: [...run.applied], kept: [...run.kept], refused: [...run.refused], held: [...run.held] };
}

function viewOf(prepared: Prepared, run: Run, ctx: ReplicaContext): FoldView {
  const positions = new Map<string, number>();
  const streamPositions = new Map<string, number>();
  const streamCounts = new Map<string, number>();
  const entries = new Map<string, VerifiedEntry>();
  prepared.ordered.forEach((entry, index) => {
    positions.set(entry.hash, index);
    entries.set(entry.hash, entry);
    const before = streamCounts.get(entry.header.stream) ?? 0;
    streamPositions.set(entry.hash, before);
    streamCounts.set(entry.header.stream, before + 1);
  });
  return {
    ctx,
    graph: prepared.graph,
    position: (hash) => positions.get(hash),
    streamPosition: (hash) => streamPositions.get(hash),
    entry: (hash) => entries.get(hash),
    state: (family) => run.states.get(family)?.state,
    isFinal: (hash) => prepared.plan.final.has(hash)
  };
}

// Write up, never down (D-25, DESIGN 8.1 rule 4). A stream is a cell, so an entry may cite (deps) an entry in another stream only when its own cell
// dominates that cell; ctx.cellOrder answers that, from Phase 70 dominance the host computed. Without cellOrder every citation is allowed, as in Phase
// 30. A dep is always an admitted entry or a checkpoint base (the chain stage holds an entry whose dep is neither), so its stream is known; one that
// is not counts as a write down. prev is always in the entry's own stream.
function writesDown(entry: VerifiedEntry, view: FoldView, bases: ReadonlyMap<string, CheckpointBase>, ctx: ReplicaContext): boolean {
  if (ctx.cellOrder === undefined) return false;
  const own = entry.header.stream;
  return entry.body.deps.some((dep) => {
    const cited = view.entry(dep.hash)?.header.stream ?? bases.get(dep.hash)?.stream;
    return cited === undefined || (cited !== own && ctx.cellOrder?.(own, cited) !== true);
  });
}

// The one apply loop: each entry from `from` on lands in exactly one list. It returns the snapshot at the end of the final prefix: the one given when it
// is for this prefix, otherwise a copy taken as the loop passes the end of the prefix, or none when the loop starts beyond it.
function applyFrom(run: Run, prepared: Prepared, ctx: ReplicaContext, from: number, keep?: Snapshot): Snapshot | undefined {
  const view = viewOf(prepared, run, ctx);
  const end = prepared.prefix;
  let snapshot = keep !== undefined && keep.count === end ? keep : undefined;
  const take = (): void => {
    if (end > 0 && snapshot === undefined) snapshot = { count: end, run: cloneRun(run) };
  };
  for (let index = from; index < prepared.ordered.length; index += 1) {
    if (index === end) take();
    const entry = prepared.ordered[index];
    if (prepared.chains.excluded.has(entry.hash)) continue;
    const family = kindFamily(entry.body.kind);
    const label = family === undefined ? {} : { family };
    if (entry.keep !== undefined) {
      run.kept.push({ hash: entry.hash, reason: entry.keep, ...label });
      continue;
    }
    if (entry.body.actor.kind === 'hub') {
      run.kept.push({ hash: entry.hash, reason: 'hub-actor', ...label });
      continue;
    }
    const slot = family === undefined ? undefined : run.states.get(family);
    if (family === undefined || slot === undefined) {
      run.kept.push({ hash: entry.hash, reason: 'folded-in-later-phase', ...label });
      continue;
    }
    // Refused before the reducer sees it: nothing is applied, and the entry stays a node of its chain and of the causal graph.
    if (writesDown(entry, view, prepared.bases, ctx)) {
      run.refused.push({ hash: entry.hash, reason: 'write-down', family });
      continue;
    }
    const outcome = slot.reducer.apply(slot.state, entry, view);
    if (outcome.status === 'applied') run.applied.push(entry.hash);
    else if (outcome.status === 'refused') run.refused.push({ hash: entry.hash, reason: outcome.reason, family });
    else run.held.push({ hash: entry.hash, stream: entry.header.stream, writer: entry.header.writer, seq: entry.header.seq, stage: 'fold', reason: outcome.reason, family });
  }
  if (end === prepared.ordered.length && from <= end) take();
  return snapshot;
}

// Outputs, digests and the sorted lists.
function buildResult(prepared: Prepared, run: Run, ctx: ReplicaContext, dropped: number): FoldResult {
  const { chains, ordered } = prepared;
  const view = viewOf(prepared, run, ctx);
  const families: Record<string, unknown> = {};
  const outputs: Array<{ family: string; reducer: AnyReducer; output: unknown }> = [];
  for (const [family, slot] of run.states) {
    const output = slot.reducer.finish(slot.state, view);
    families[family] = output;
    outputs.push({ family, reducer: slot.reducer, output });
  }
  const perStream = new Map<string, Record<string, unknown>>();
  for (const stream of new Set(ordered.map((entry) => entry.header.stream))) {
    const canonical: Record<string, unknown> = {};
    for (const { family, reducer, output } of outputs) canonical[family] = reducer.canonical(output, stream);
    perStream.set(stream, canonical);
  }
  const digests: Record<string, string> = {};
  for (const [stream, digest] of streamDigests(perStream, chains.quarantined)) digests[stream] = digest;
  return {
    order: ordered.map((entry) => entry.hash),
    applied: [...run.applied].sort(),
    kept: [...run.kept].sort(byHash),
    held: [...prepared.verifyHeld, ...chains.held, ...run.held].sort(byHash),
    rejected: [...prepared.verifyRejected, ...chains.rejected].sort((a, b) => byHash(a, b) || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)),
    refused: [...run.refused].sort(byHash),
    excluded: [...chains.excluded].sort(),
    quarantined: chains.quarantined,
    proofs: chains.proofs,
    families,
    digests,
    checkpoint: prepared.plan.used,
    checkpointConflicts: prepared.plan.conflicts,
    dropped
  };
}

// The from-scratch fold. It shares ingest, prepare and the apply loop with the incremental path and nothing else is different.
export function foldEntries(input: readonly unknown[], ctx: ReplicaContext, options: FoldOptions = {}): FoldResult {
  const store = emptyStore();
  for (const item of input) ingest(store, item, ctx);
  const prepared = prepare(store, ctx, options);
  const run = freshRun(options.reducers ?? DEFAULT_REDUCERS);
  applyFrom(run, prepared, ctx, 0);
  return buildResult(prepared, run, ctx, store.dropped);
}

export function createFoldState(ctx: ReplicaContext, options: FoldOptions = {}): FoldState {
  const store = emptyStore();
  const prepared = prepare(store, ctx, options);
  const run = freshRun(options.reducers ?? DEFAULT_REDUCERS);
  return { result: buildResult(prepared, run, ctx, 0), refolds: 0, ctx, options, store, prepared, run, snapshot: undefined };
}

// Does the order start with the old order, with the same entries skipped as quarantined?
function extendsOrder(before: Prepared, after: Prepared): boolean {
  // Nothing was applied yet, so there is nothing to start again.
  if (before.ordered.length === 0) return true;
  if (after.ordered.length < before.ordered.length) return false;
  // What is final at apply time (isFinal) must not have changed under the entries already applied.
  if (before.plan.used !== after.plan.used || before.plan.final.size !== after.plan.final.size) return false;
  for (let index = 0; index < before.ordered.length; index += 1) {
    const hash = before.ordered[index].hash;
    if (after.ordered[index].hash !== hash) return false;
    if (before.chains.excluded.has(hash) !== after.chains.excluded.has(hash)) return false;
  }
  return true;
}

// The place of the first entry of the old order that a newly admitted entry can change the outcome of, or undefined when none can (CR-02). A reducer
// names such entries with lateDependencies. Without this check the incremental fold would keep an outcome the from-scratch fold, which sees every
// entry from the start, would not give.
function earliestLateEffect(before: Prepared, after: Prepared, reducers: readonly AnyReducer[]): number | undefined {
  if (before.ordered.length === 0) return undefined;
  const known = new Set(before.ordered.map((entry) => entry.hash));
  const arrived = new Set<string>();
  for (const entry of after.ordered) if (!known.has(entry.hash)) arrived.add(entry.hash);
  if (arrived.size === 0) return undefined;
  const byFamily = new Map<KindFamily, AnyReducer>();
  for (const reducer of reducers) byFamily.set(reducer.family, reducer);
  for (let index = 0; index < before.ordered.length; index += 1) {
    const entry = before.ordered[index];
    const family = kindFamily(entry.body.kind);
    const dependencies = family === undefined ? undefined : byFamily.get(family)?.lateDependencies?.(entry);
    if (dependencies !== undefined && dependencies.some((hash) => arrived.has(hash))) return index;
  }
  return undefined;
}

// The place in the old order of the first reducer-stage hold the context can now answer, or undefined when none can (D-01 (d)). A blob or a key put
// behind the same context object arrives with no new entry and no new context, so without this the incremental fold would keep a hold the
// from-scratch fold, which asks the context at apply time, would not. `admitted` is the new order when this call admitted entries: a hold waiting
// for an entry is answerable only when a newly admitted one sorts before it (one sorting after it is after it in the from-scratch fold too).
function earliestAnswerable(before: Prepared, run: Run, ctx: ReplicaContext, admitted?: Prepared): number | undefined {
  if (run.held.length === 0) return undefined;
  const waiting = new Map<string, HeldEntry>();
  for (const held of run.held) if (held.hash !== undefined) waiting.set(held.hash, held);
  let firstNew = Infinity;
  const newPlace = new Map<string, number>();
  if (admitted !== undefined) {
    const known = new Set(before.ordered.map((entry) => entry.hash));
    admitted.ordered.forEach((entry, index) => {
      if (!known.has(entry.hash)) firstNew = Math.min(firstNew, index);
      else if (waiting.has(entry.hash)) newPlace.set(entry.hash, index);
    });
  }
  for (let index = 0; index < before.ordered.length; index += 1) {
    const entry = before.ordered[index];
    const held = waiting.get(entry.hash);
    if (held === undefined) continue;
    const wait = waitOf(held, entry);
    if (wait !== undefined && waitAnswered(wait, ctx, firstNew < (newPlace.get(entry.hash) ?? -1))) return index;
  }
  return undefined;
}

// How many leading entries are the same in both orders, with the same ones skipped as quarantined.
function commonPrefix(before: Prepared, after: Prepared): number {
  const limit = Math.min(before.ordered.length, after.ordered.length);
  let index = 0;
  while (index < limit) {
    const hash = before.ordered[index].hash;
    if (after.ordered[index].hash !== hash || before.chains.excluded.has(hash) !== after.chains.excluded.has(hash)) break;
    index += 1;
  }
  return index;
}

// Folds more entries into a state and returns the next one; the state passed in is never changed. An entry already seen changes nothing.
// A ctx that is not the object the state was folded under replaces the context (CR-03): a key ring, blob store, roster or clock may now answer
// differently, so held entries are looked at again and what the reducers decided under the old context is decided again under the new one. That
// is a start from the beginning, counted in refolds, because a reducer reads the context while it applies (a compaction waiting for its blob, a
// proposal waiting for its text), and so does the snapshot at the end of the final prefix. Pass the same object, or none, when nothing changed.
// The same object may still answer more than before: a blob or a key the store put behind it. Each reducer-stage hold is asked (holdWaits.ts), and
// one that can now be answered makes the fold start again from that hold (D-01 (d)); when none can, the very same state is returned.
export function addEntries(state: FoldState, inputs: readonly unknown[], ctx?: ReplicaContext): FoldState {
  const next = ctx ?? state.ctx;
  const replaced = next !== state.ctx;
  const store = copyStore(state.store);
  let changed = false;
  for (const item of inputs) if (ingest(store, item, next)) changed = true;
  if (retryHeld(store, next)) changed = true;
  let ready = changed || replaced ? undefined : earliestAnswerable(state.prepared, state.run, next);
  if (!changed && !replaced && ready === undefined) {
    if (store.dropped === state.store.dropped) return state;
    // Only unreadable inputs arrived: the count changes and nothing is folded again.
    return { ...state, store, result: { ...state.result, dropped: store.dropped } };
  }

  const prepared = prepare(store, next, state.options);
  // A new context starts again from the beginning below, so its holds need no asking.
  if (changed && !replaced) ready = earliestAnswerable(state.prepared, state.run, next, prepared);
  let run: Run;
  let snapshot: Snapshot | undefined;
  let refolds = state.refolds;
  // An arrival that sorts last can still change an earlier outcome (a compaction whose cover has just been delivered), so it is not a plain append.
  const late = earliestLateEffect(state.prepared, prepared, state.options.reducers ?? DEFAULT_REDUCERS);
  // Nothing applied yet means nothing was decided under the old context, so a new one needs no start again.
  const restart = replaced && state.prepared.ordered.length > 0;
  if (!restart && late === undefined && ready === undefined && extendsOrder(state.prepared, prepared)) {
    // Everything new sorts after what was applied: append.
    run = cloneRun(state.run);
    snapshot = applyFrom(run, prepared, next, state.prepared.ordered.length, state.snapshot);
  } else {
    refolds += 1;
    const reusable = Math.min(commonPrefix(state.prepared, prepared), late ?? Infinity, ready ?? Infinity);
    const kept = !restart && state.snapshot !== undefined && state.snapshot.count <= reusable ? state.snapshot : undefined;
    // Start again from the end of the final prefix when nothing at or before it changed, otherwise from the start.
    run = kept === undefined ? freshRun(state.options.reducers ?? DEFAULT_REDUCERS) : cloneRun(kept.run);
    snapshot = applyFrom(run, prepared, next, kept === undefined ? 0 : kept.count, kept);
  }
  return { result: buildResult(prepared, run, next, store.dropped), refolds, ctx: next, options: state.options, store, prepared, run, snapshot };
}
