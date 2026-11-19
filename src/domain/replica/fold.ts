// The fold (DESIGN 4.4, D-09, D-10, D-11). Pure: a function of the entries and an injected ReplicaContext. It reads no clock and does no I/O.
//
// The result keeps six different things apart, because they mean different things (Pitfall 11) and none of them but "applied" changes state:
// - applied: used by a reducer.
// - held: waiting for a piece that is missing; it becomes applied when the piece arrives.
// - rejected: permanently refused at verification or chain stage.
// - refused: a reducer refused it (for example forged attribution, or a client id collision).
// - kept: genuine but not applied (unauthorised, made by a newer version, hub actor, or a family folded in a later phase).
// - excluded: skipped because its writer is quarantined (filled by plan 30-05).
import { buildCausalGraph } from './causal';
import { classifyChains } from './chain';
import type { EquivocationProof, HeldEntry, QuarantineRecord, RejectedEntry } from './chain';
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

export function foldEntries(input: readonly unknown[], ctx: ReplicaContext, options: FoldOptions = {}): FoldResult {
  const reducers = options.reducers ?? DEFAULT_REDUCERS;

  // 1. Verify each distinct input once. A duplicate delivery changes nothing. When copies of one entry differ (a damaged body next to a good one),
  // the verified copy wins; otherwise the choice is by a fixed rule, never by arrival order.
  const chosen = new Map<string, VerifyOutcome>();
  const unreadable = new Map<string, VerifyOutcome>();
  const seen = new Set<unknown>();
  for (const item of input) {
    if (seen.has(item)) continue;
    seen.add(item);
    const outcome = verifyEntry(item, ctx);
    const hash = outcome.status === 'verified' ? outcome.entry.hash : outcome.hash ?? hashOf(item);
    if (hash === undefined) {
      if (outcome.status !== 'verified') unreadable.set(outcome.reason, outcome);
      continue;
    }
    const current = chosen.get(hash);
    if (current === undefined || rank(outcome) < rank(current)) chosen.set(hash, outcome);
  }

  const verified: VerifiedEntry[] = [];
  const held: HeldEntry[] = [];
  const rejected: RejectedEntry[] = [];
  for (const outcome of [...chosen.values(), ...unreadable.values()]) {
    if (outcome.status === 'verified') {
      verified.push(outcome.entry);
      continue;
    }
    const place = outcome.header === undefined ? {} : { stream: outcome.header.stream, writer: outcome.header.writer, seq: outcome.header.seq };
    const record = { ...(outcome.hash === undefined ? {} : { hash: outcome.hash }), ...place, stage: 'verify' as const, reason: outcome.reason };
    (outcome.status === 'held' ? held : rejected).push(record);
  }

  // 2. Chains, then the total order of what is admitted.
  const chains = classifyChains(verified, ctx);
  held.push(...chains.held);
  rejected.push(...chains.rejected);
  const ordered = totalOrder(chains.admitted);
  const positions = new Map<string, number>();
  const entries = new Map<string, VerifiedEntry>();
  ordered.forEach((entry, index) => { positions.set(entry.hash, index); entries.set(entry.hash, entry); });

  // 3. Fold in order. Each entry lands in exactly one list.
  const states = new Map<KindFamily, { reducer: AnyReducer; state: unknown }>();
  for (const reducer of reducers) states.set(reducer.family, { reducer, state: reducer.init() });
  const view: FoldView = {
    ctx,
    graph: buildCausalGraph(ordered),
    position: (hash) => positions.get(hash),
    entry: (hash) => entries.get(hash),
    state: (family) => states.get(family)?.state,
    isFinal: () => false
  };
  const applied: string[] = [];
  const kept: KeptEntry[] = [];
  const refused: RefusedEntry[] = [];
  for (const entry of ordered) {
    if (chains.excluded.has(entry.hash)) continue;
    const family = kindFamily(entry.body.kind);
    const label = family === undefined ? {} : { family };
    if (entry.keep !== undefined) {
      kept.push({ hash: entry.hash, reason: entry.keep, ...label });
      continue;
    }
    if (entry.body.actor.kind === 'hub') {
      kept.push({ hash: entry.hash, reason: 'hub-actor', ...label });
      continue;
    }
    const slot = family === undefined ? undefined : states.get(family);
    if (family === undefined || slot === undefined) {
      kept.push({ hash: entry.hash, reason: 'folded-in-later-phase', ...label });
      continue;
    }
    const outcome = slot.reducer.apply(slot.state, entry, view);
    if (outcome.status === 'applied') applied.push(entry.hash);
    else if (outcome.status === 'refused') refused.push({ hash: entry.hash, reason: outcome.reason, family });
    else held.push({ hash: entry.hash, stream: entry.header.stream, writer: entry.header.writer, seq: entry.header.seq, stage: 'fold', reason: outcome.reason, family });
  }

  // 4. Outputs and digests.
  const families: Record<string, unknown> = {};
  const outputs: Array<{ family: string; reducer: AnyReducer; output: unknown }> = [];
  for (const [family, slot] of states) {
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
    applied: applied.sort(),
    kept: kept.sort(byHash),
    held: held.sort(byHash),
    rejected: rejected.sort((a, b) => byHash(a, b) || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0)),
    refused: refused.sort(byHash),
    excluded: [...chains.excluded].sort(),
    quarantined: chains.quarantined,
    proofs: chains.proofs,
    families,
    digests
  };
}
