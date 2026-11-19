// The fold (DESIGN 4.4, D-09, D-10, D-11). Pure: a function of the entries and an injected ReplicaContext. It reads no clock and does no I/O.
//
// The result keeps six different things apart, because they mean different things (Pitfall 11) and none of them but "applied" changes state:
// - applied: used by a reducer.
// - held: waiting for a piece that is missing; it becomes applied when the piece arrives.
// - rejected: permanently refused at verification or chain stage.
// - refused: a reducer refused it (for example forged attribution, or a client id collision).
// - kept: genuine but not applied (unauthorised, made by a newer version, hub actor, or a family folded in a later phase).
// - excluded: skipped because its writer is quarantined (filled by plan 30-05).
//
// Two ways in, one apply loop (D-10): foldEntries folds a set from scratch, and addEntries folds as entries arrive. The incremental path appends
// when everything new sorts after what was applied, and refolds otherwise. The property tests prove the two agree.
import { buildCausalGraph } from './causal';
import type { CausalGraph } from './causal';
import { classifyChains } from './chain';
import type { ChainResult, EquivocationProof, HeldEntry, QuarantineRecord, RejectedEntry } from './chain';
import { streamDigests } from './digest';
import { entryHash, parseHeaderShape } from './entry';
import { kindFamily } from './kinds';
import type { KindFamily } from './kinds';
import { totalOrder } from './order';
import { DEFAULT_REDUCERS } from './reducers';
import type { AnyReducer, FoldView } from './reducers';
import type { ReplicaContext } from './rosterView';
import { verifyEntry } from './verify';
import type { KeepReason, VerifiedEntry, VerifyOutcome } from './verify';

export interface FoldOptions { reducers?: readonly AnyReducer[] }
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
  // The digest of each stream that has admitted entries.
  digests: Record<string, string>;
}

const byHash = (a: { hash?: string }, b: { hash?: string }): number => ((a.hash ?? '') < (b.hash ?? '') ? -1 : (a.hash ?? '') > (b.hash ?? '') ? 1 : 0);

// The entry hash of one input, or undefined when its header is not readable. This is how exact duplicates are recognised before any real work.
function hashOf(input: unknown): string | undefined {
  try {
    const record = input as { header?: unknown };
    const shape = parseHeaderShape(record?.header);
    return shape.ok ? entryHash(shape.header) : undefined;
  } catch {
    // An input whose header cannot be read has no hash.
    return undefined;
  }
}

function rank(outcome: VerifyOutcome): string {
  return outcome.status === 'verified' ? '0' : `1:${outcome.status}:${outcome.reason}`;
}

// What the caller keeps from one delivery to the next. An earlier FoldState is never changed by addEntries.
interface Chosen { outcome: VerifyOutcome; retry: unknown[] }
interface Store {
  chosen: Map<string, Chosen>;
  unreadable: Map<string, VerifyOutcome>;
  seen: Set<unknown>;
}

// The reducers' working states and the lists the apply loop fills.
interface Run {
  states: Map<KindFamily, { reducer: AnyReducer; state: unknown }>;
  applied: string[];
  kept: KeptEntry[];
  refused: RefusedEntry[];
  held: HeldEntry[];
}

// Everything derived from a Store that the apply loop needs.
interface Prepared {
  verifyHeld: HeldEntry[];
  verifyRejected: RejectedEntry[];
  chains: ChainResult;
  graph: CausalGraph;
  ordered: VerifiedEntry[];
}

export interface FoldState {
  readonly result: FoldResult;
  // How many times the fold had to start again because an entry arrived out of place.
  readonly refolds: number;
  readonly ctx: ReplicaContext;
  readonly options: FoldOptions;
  readonly store: Store;
  readonly prepared: Prepared;
  readonly run: Run;
}

function emptyStore(): Store {
  return { chosen: new Map(), unreadable: new Map(), seen: new Set() };
}

function copyStore(store: Store): Store {
  const chosen = new Map<string, Chosen>();
  for (const [hash, entry] of store.chosen) chosen.set(hash, { outcome: entry.outcome, retry: [...entry.retry] });
  return { chosen, unreadable: new Map(store.unreadable), seen: new Set(store.seen) };
}

// Verifies one input and records it. Returns true when it changed what the store knows. When copies of one entry differ (a damaged body next to a
// good one), the verified copy wins; otherwise the choice is by a fixed rule, never by arrival order.
function ingest(store: Store, item: unknown, ctx: ReplicaContext): boolean {
  const outcome = verifyEntry(item, ctx);
  const hash = outcome.status === 'verified' ? outcome.entry.hash : outcome.hash ?? hashOf(item);
  if (hash === undefined) {
    if (outcome.status === 'verified') return false;
    const known = store.unreadable.get(outcome.reason);
    store.unreadable.set(outcome.reason, outcome);
    return known === undefined;
  }
  const current = store.chosen.get(hash);
  if (current === undefined || rank(outcome) < rank(current.outcome)) {
    store.chosen.set(hash, { outcome, retry: outcome.status === 'held' ? [item] : [] });
    return true;
  }
  if (outcome.status === 'held' && rank(outcome) === rank(current.outcome)) current.retry.push(item);
  return false;
}

// Held entries wait for a piece the context may have gained since (a key, a blob), so they are looked at again; verified and rejected ones never are.
function retryHeld(store: Store, ctx: ReplicaContext): boolean {
  let changed = false;
  for (const entry of [...store.chosen.values()]) {
    if (entry.outcome.status !== 'held') continue;
    const items = entry.retry;
    entry.retry = [];
    for (const item of items) if (ingest(store, item, ctx)) changed = true;
  }
  return changed;
}

function prepare(store: Store, ctx: ReplicaContext): Prepared {
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
  const chains = classifyChains(verified, ctx);
  const graph = buildCausalGraph(chains.admitted);
  return { verifyHeld, verifyRejected, chains, graph, ordered: totalOrder(chains.admitted) };
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
  const entries = new Map<string, VerifiedEntry>();
  prepared.ordered.forEach((entry, index) => { positions.set(entry.hash, index); entries.set(entry.hash, entry); });
  return {
    ctx,
    graph: prepared.graph,
    position: (hash) => positions.get(hash),
    entry: (hash) => entries.get(hash),
    state: (family) => run.states.get(family)?.state,
    isFinal: () => false
  };
}

// The one apply loop: each entry from `from` on lands in exactly one list.
function applyFrom(run: Run, prepared: Prepared, ctx: ReplicaContext, from: number): void {
  const view = viewOf(prepared, run, ctx);
  for (let index = from; index < prepared.ordered.length; index += 1) {
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
    const outcome = slot.reducer.apply(slot.state, entry, view);
    if (outcome.status === 'applied') run.applied.push(entry.hash);
    else if (outcome.status === 'refused') run.refused.push({ hash: entry.hash, reason: outcome.reason, family });
    else run.held.push({ hash: entry.hash, stream: entry.header.stream, writer: entry.header.writer, seq: entry.header.seq, stage: 'fold', reason: outcome.reason, family });
  }
}

// Outputs, digests and the sorted lists.
function buildResult(prepared: Prepared, run: Run, ctx: ReplicaContext): FoldResult {
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
    digests
  };
}

// The from-scratch fold. It shares ingest, prepare and the apply loop with the incremental path and nothing else is different.
export function foldEntries(input: readonly unknown[], ctx: ReplicaContext, options: FoldOptions = {}): FoldResult {
  const store = emptyStore();
  for (const item of input) {
    if (store.seen.has(item)) continue;
    store.seen.add(item);
    ingest(store, item, ctx);
  }
  const prepared = prepare(store, ctx);
  const run = freshRun(options.reducers ?? DEFAULT_REDUCERS);
  applyFrom(run, prepared, ctx, 0);
  return buildResult(prepared, run, ctx);
}

export function createFoldState(ctx: ReplicaContext, options: FoldOptions = {}): FoldState {
  const store = emptyStore();
  const prepared = prepare(store, ctx);
  const run = freshRun(options.reducers ?? DEFAULT_REDUCERS);
  return { result: buildResult(prepared, run, ctx), refolds: 0, ctx, options, store, prepared, run };
}

// Does the order start with the old order, with the same entries skipped as quarantined?
function extendsOrder(before: Prepared, after: Prepared): boolean {
  if (after.ordered.length < before.ordered.length) return false;
  for (let index = 0; index < before.ordered.length; index += 1) {
    const hash = before.ordered[index].hash;
    if (after.ordered[index].hash !== hash) return false;
    if (before.chains.excluded.has(hash) !== after.chains.excluded.has(hash)) return false;
  }
  return true;
}

// Folds more entries into a state and returns the next one; the state passed in is never changed. An entry already seen changes nothing. ctx
// replaces the context for entries delivered from now on, and held entries are looked at again against it.
export function addEntries(state: FoldState, inputs: readonly unknown[], ctx?: ReplicaContext): FoldState {
  const next = ctx ?? state.ctx;
  const store = copyStore(state.store);
  let changed = false;
  for (const item of inputs) {
    if (store.seen.has(item)) continue;
    store.seen.add(item);
    if (ingest(store, item, next)) changed = true;
  }
  if (retryHeld(store, next)) changed = true;
  if (!changed) return state;

  const prepared = prepare(store, next);
  let run: Run;
  let refolds = state.refolds;
  if (extendsOrder(state.prepared, prepared)) {
    // Everything new sorts after what was applied: append.
    run = cloneRun(state.run);
    applyFrom(run, prepared, next, state.prepared.ordered.length);
  } else {
    refolds += 1;
    run = freshRun(state.options.reducers ?? DEFAULT_REDUCERS);
    applyFrom(run, prepared, next, 0);
  }
  return { result: buildResult(prepared, run, next), refolds, ctx: next, options: state.options, store, prepared, run };
}
