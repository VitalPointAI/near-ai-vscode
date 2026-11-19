// The causal graph of entries: an edge from each entry to its prev and to every dep (DESIGN 4.4). Pure, hub-side.
// Task 3 of plan 30-02 adds the transitive queries (past, isBefore, concurrent, closure).
import { GENESIS_PREV } from './entry';
import type { EntryBody, EntryHeader } from './entry';

export interface GraphEntry { hash: string; header: EntryHeader; body: EntryBody }

export interface CausalGraph {
  has(hash: string): boolean;
  // The entry's direct predecessors: prev (unless it is the genesis marker) and every dep, without duplicates.
  preds(hash: string): readonly string[];
  // The direct predecessors that are not in the graph.
  missingPreds(hash: string): readonly string[];
}

export function buildCausalGraph(entries: readonly GraphEntry[]): CausalGraph {
  const direct = new Map<string, readonly string[]>();
  for (const entry of entries) {
    const preds = new Set<string>();
    if (entry.header.prev !== GENESIS_PREV) preds.add(entry.header.prev);
    for (const dep of entry.body.deps) preds.add(dep.hash);
    direct.set(entry.hash, [...preds].sort());
  }
  return {
    has: (hash) => direct.has(hash),
    preds: (hash) => direct.get(hash) ?? [],
    missingPreds: (hash) => (direct.get(hash) ?? []).filter((pred) => !direct.has(pred))
  };
}
