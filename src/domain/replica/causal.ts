// The causal graph of entries: an edge from each entry to its prev and to every dep (DESIGN 4.4). Pure, hub-side.
// The transitive queries (past, isBefore, concurrent, closure) are the relations that stale-citation checks, decision precedence, concurrent
// proposals and checkpoint prefixes build on. All of them walk the graph with an explicit stack, so a long chain cannot overflow the call stack.
import { GENESIS_PREV } from './entry';
import type { EntryBody, EntryHeader } from './entry';

export interface GraphEntry { hash: string; header: EntryHeader; body: EntryBody }

export interface CausalGraph {
  has(hash: string): boolean;
  // The entry's direct predecessors: prev (unless it is the genesis marker) and every dep, without duplicates.
  preds(hash: string): readonly string[];
  // The direct predecessors that are not in the graph.
  missingPreds(hash: string): readonly string[];
  // The strict ancestors of an entry that are in the graph: everything reachable through prev and deps, not the entry itself. Empty when the
  // entry is not in the graph. The answer is computed once per entry and shared, so callers must not change it.
  past(hash: string): ReadonlySet<string>;
  // True when a is a strict ancestor of b.
  isBefore(a: string, b: string): boolean;
  // True when both entries are in the graph, they differ, and neither is an ancestor of the other.
  concurrent(a: string, b: string): boolean;
  // The heads that are in the graph plus all their ancestors.
  closure(heads: readonly string[]): ReadonlySet<string>;
  // How much work the graph has done, for tests: pastsBuilt counts the ancestor sets computed so far.
  stats(): { pastsBuilt: number };
}

export function buildCausalGraph(entries: readonly GraphEntry[]): CausalGraph {
  const direct = new Map<string, readonly string[]>();
  const lamports = new Map<string, unknown>();
  for (const entry of entries) {
    const preds = new Set<string>();
    if (entry.header.prev !== GENESIS_PREV) preds.add(entry.header.prev);
    for (const dep of entry.body.deps) preds.add(dep.hash);
    direct.set(entry.hash, [...preds].sort());
    lamports.set(entry.hash, entry.body.lamport);
  }
  // The lamport bound (WR-06): a strict ancestor has a smaller lamport, so a is before b only when lamport(a) < lamport(b). The chain admits an entry
  // only when its lamport is one more than the largest of its predecessors, so this holds for every graph the fold builds. It is checked here on
  // every edge anyway, and a graph where it fails (hand-built, or not yet chain-checked) answers from the ancestor sets alone.
  const lamportOf = (hash: string): number => lamports.get(hash) as number;
  let rising = true;
  for (const [hash, preds] of direct) {
    const own = lamports.get(hash);
    if (typeof own !== 'number' || !Number.isFinite(own)) { rising = false; break; }
    if (preds.some((pred) => direct.has(pred) && !((lamports.get(pred) as number) < own))) { rising = false; break; }
  }
  let pastsBuilt = 0;
  // Every entry reachable from the starts through predecessors that are in the graph, starts included when they are in the graph.
  const reach = (starts: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const stack: string[] = [];
    for (const start of starts) if (direct.has(start)) stack.push(start);
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const pred of direct.get(next) ?? []) if (direct.has(pred) && !seen.has(pred)) stack.push(pred);
    }
    return seen;
  };
  const pasts = new Map<string, ReadonlySet<string>>();
  const past = (hash: string): ReadonlySet<string> => {
    const known = pasts.get(hash);
    if (known !== undefined) return known;
    const found = reach(direct.get(hash) ?? []);
    pastsBuilt += 1;
    pasts.set(hash, found);
    return found;
  };
  // An ancestor set only ever holds entries of the graph, so a or b outside it, or a lamport not below b's, answers false without building one.
  const isBefore = (a: string, b: string): boolean => {
    if (a === b || !direct.has(a) || !direct.has(b)) return false;
    if (rising && !(lamportOf(a) < lamportOf(b))) return false;
    return past(b).has(a);
  };
  return {
    has: (hash) => direct.has(hash),
    preds: (hash) => direct.get(hash) ?? [],
    missingPreds: (hash) => (direct.get(hash) ?? []).filter((pred) => !direct.has(pred)),
    past,
    isBefore,
    concurrent: (a, b) => a !== b && direct.has(a) && direct.has(b) && !isBefore(a, b) && !isBefore(b, a),
    closure: (heads) => reach(heads),
    stats: () => ({ pastsBuilt })
  };
}
