// The deterministic total order (D-08): lamport, then writer, then seq. Wall time (at) never orders. Pure, hub-side.
// The key is extended with stream and entry hash only to break ties D-08 leaves open: one writer can have the same lamport and seq in two streams.
import type { CausalGraph } from './causal';
import type { EntryHeader, EntryBody } from './entry';

export interface Orderable { hash: string; header: EntryHeader; body: Pick<EntryBody, 'lamport'> }

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareEntries(a: Orderable, b: Orderable): number {
  return (a.body.lamport - b.body.lamport)
    || compareText(a.header.writer, b.header.writer)
    || (a.header.seq - b.header.seq)
    || compareText(a.header.stream, b.header.stream)
    || compareText(a.hash, b.hash);
}

export function totalOrder<T extends Orderable>(entries: readonly T[]): T[] {
  return [...entries].sort(compareEntries);
}

// The reference order for the tests (D-08): a priority-queue Kahn sort over the entries' predecessor edges, keyed by compareEntries. When every edge
// goes from a smaller to a larger lamport, this equals totalOrder; the property tests assert that on seeded histories. The fold must never call it.
export function kahnOrder<T extends Orderable>(entries: readonly T[], graph: CausalGraph): T[] {
  const byHash = new Map<string, T>();
  for (const entry of entries) byHash.set(entry.hash, entry);
  const waiting = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const entry of byHash.values()) {
    const preds = graph.preds(entry.hash).filter((pred) => byHash.has(pred));
    waiting.set(entry.hash, preds.length);
    for (const pred of preds) {
      const list = successors.get(pred);
      if (list === undefined) successors.set(pred, [entry.hash]);
      else list.push(entry.hash);
    }
  }
  const heap: T[] = [];
  const push = (entry: T): void => {
    heap.push(entry);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (compareEntries(heap[parent], heap[child]) <= 0) break;
      [heap[parent], heap[child]] = [heap[child], heap[parent]];
      child = parent;
    }
  };
  const pop = (): T => {
    const top = heap[0];
    const last = heap.pop() as T;
    if (heap.length > 0) {
      heap[0] = last;
      let parent = 0;
      for (;;) {
        const left = 2 * parent + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < heap.length && compareEntries(heap[left], heap[smallest]) < 0) smallest = left;
        if (right < heap.length && compareEntries(heap[right], heap[smallest]) < 0) smallest = right;
        if (smallest === parent) break;
        [heap[parent], heap[smallest]] = [heap[smallest], heap[parent]];
        parent = smallest;
      }
    }
    return top;
  };
  for (const entry of byHash.values()) if (waiting.get(entry.hash) === 0) push(entry);
  const result: T[] = [];
  while (heap.length > 0) {
    const next = pop();
    result.push(next);
    for (const hash of successors.get(next.hash) ?? []) {
      const left = (waiting.get(hash) as number) - 1;
      waiting.set(hash, left);
      if (left === 0) push(byHash.get(hash) as T);
    }
  }
  if (result.length !== byHash.size) throw new Error('The entries contain a cycle, which a hash-linked history cannot have.');
  return result;
}

// The final order under checkpoints (D-14): sort(C1), then sort(C2 minus C1), and so on, then sort(everything else). coveredSets must be nested,
// smallest first; an entry belongs to the first set that holds it. Without checkpoints this is totalOrder.
export function checkpointOrder<T extends Orderable>(entries: readonly T[], coveredSets: ReadonlyArray<ReadonlySet<string>>): T[] {
  const buckets: T[][] = coveredSets.map(() => []);
  const rest: T[] = [];
  for (const entry of entries) {
    const index = coveredSets.findIndex((set) => set.has(entry.hash));
    (index < 0 ? rest : buckets[index]).push(entry);
  }
  return [...buckets.flatMap((bucket) => totalOrder(bucket)), ...totalOrder(rest)];
}
