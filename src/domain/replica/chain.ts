// Per-writer chains (DESIGN 4.4 step 1, 4.5; D-12, D-13). Pure, hub-side: no Yjs, no fold, no clock.
//
// For every (stream, writer):
// - seq 0 must have prev GENESIS_PREV; seq n must have a prev that names an entry at seq n-1 of the same writer and stream.
// - several entries at one seq are all graph nodes, each chained to its own predecessor. That is a fork: the pair becomes a portable proof of
//   equivocation, and from the fork seq on the writer's entries are excluded, in the forked stream and, when they follow a forked entry, in other
//   streams too (D-12). The result depends only on the set of entries, never on the order they arrived or on a clock.
// - an entry with any predecessor (prev or dep) that is not admitted is held, until the predecessor arrives. Excluded entries stay admitted graph
//   nodes, so other writers' entries that cite them are admitted too ("satisfied by absence"): one forked device never stalls the project.
import { buildCausalGraph } from './causal';
import { GENESIS_PREV } from './entry';
import { findEquivocations, forkChosen, proofHash, quarantineRecords } from './equivocation';
import type { EquivocationProof, QuarantineRecord } from './equivocation';
import { totalOrder } from './order';
import type { ReplicaContext } from './rosterView';
import type { VerifiedEntry } from './verify';

export type { EquivocationProof, QuarantineRecord } from './equivocation';

export const CHAIN_HOLDS = {
  'missing-predecessor': 'An entry this one follows has not arrived or is not usable yet.'
} as const;
export type ChainHold = keyof typeof CHAIN_HOLDS;

export const CHAIN_REJECTIONS = {
  'bad-genesis': 'The first entry of a device\'s log must start the log, and this one points at an earlier entry.',
  'bad-dep': 'This entry cites an entry as a dependency, but that entry is not the writer and place it names.',
  'bad-prev': 'This entry says it follows an entry that is not the one just before it in the same device\'s log.'
} as const;
export type ChainRejection = keyof typeof CHAIN_REJECTIONS;

export type FoldStage = 'verify' | 'chain' | 'fold';

export interface HeldEntry { hash?: string; stream?: string; writer?: string; seq?: number; stage: FoldStage; reason: string; family?: string }
export interface RejectedEntry { hash?: string; stream?: string; writer?: string; seq?: number; stage: FoldStage; reason: string; family?: string }

export interface ChainResult {
  admitted: VerifiedEntry[];
  // Admitted entries the fold must skip: the writer is quarantined from a fork. They stay graph nodes.
  excluded: Set<string>;
  held: HeldEntry[];
  rejected: RejectedEntry[];
  quarantined: QuarantineRecord[];
  proofs: EquivocationProof[];
}

const slot = (stream: string, writer: string, seq: number): string => `${stream}/${writer}/${seq}`;

function where(entry: VerifiedEntry): { hash: string; stream: string; writer: string; seq: number } {
  return { hash: entry.hash, stream: entry.header.stream, writer: entry.header.writer, seq: entry.header.seq };
}

// prev (unless it is the genesis marker) and every dep, without duplicates.
function predecessors(entry: VerifiedEntry): string[] {
  const preds = new Set<string>();
  if (entry.header.prev !== GENESIS_PREV) preds.add(entry.header.prev);
  for (const dep of entry.body.deps) preds.add(dep.hash);
  return [...preds];
}

// A permanent refusal that depends on the entry and the entries it names, never on what has not arrived.
function staticRefusal(entry: VerifiedEntry, nodes: ReadonlyMap<string, VerifiedEntry>): ChainRejection | undefined {
  const { header, body } = entry;
  if (header.seq === 0 && header.prev !== GENESIS_PREV) return 'bad-genesis';
  if (header.seq > 0) {
    if (header.prev === GENESIS_PREV) return 'bad-prev';
    const previous = nodes.get(header.prev);
    if (previous !== undefined && (previous.header.stream !== header.stream || previous.header.writer !== header.writer || previous.header.seq !== header.seq - 1)) return 'bad-prev';
  }
  const badDep = body.deps.some((dep) => {
    const target = nodes.get(dep.hash);
    return target !== undefined && (target.header.writer !== dep.writer || target.header.seq !== dep.seq);
  });
  return badDep ? 'bad-dep' : undefined;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

// The entries to skip: in a forked (writer, stream), every admitted entry from the fork seq on except the chosen branch and its descendants; in
// other streams, every admitted entry of that writer whose causal past holds one of those excluded forked entries.
function excludedEntries(admitted: ReadonlyMap<string, VerifiedEntry>, proofs: readonly EquivocationProof[], ctx: ReplicaContext): Set<string> {
  const forks = new Map<string, Array<{ seq: number; chosen: string | undefined }>>();
  for (const proof of proofs) {
    const key = `${proof.a.writer}/${proof.a.stream}`;
    pushTo(forks, key, { seq: proof.a.seq, chosen: forkChosen(proof, ctx.roster) });
  }
  const chains = new Map<string, VerifiedEntry[]>();
  for (const entry of admitted.values()) {
    const key = `${entry.header.writer}/${entry.header.stream}`;
    if (forks.has(key)) pushTo(chains, key, entry);
  }

  const direct = new Set<string>();
  for (const [key, list] of chains) {
    const children = new Map<string, VerifiedEntry[]>();
    for (const entry of list) pushTo(children, entry.header.prev, entry);
    for (const fork of forks.get(key) ?? []) {
      const keep = new Set<string>();
      const stack = fork.chosen !== undefined && admitted.has(fork.chosen) ? [fork.chosen] : [];
      while (stack.length > 0) {
        const next = stack.pop() as string;
        if (keep.has(next)) continue;
        keep.add(next);
        for (const child of children.get(next) ?? []) stack.push(child.hash);
      }
      for (const entry of list) if (entry.header.seq >= fork.seq && !keep.has(entry.hash)) direct.add(entry.hash);
    }
  }
  if (direct.size === 0) return direct;

  // Other streams: for each forked writer, carry along the causal order the streams of its excluded entries, and exclude the writer's own later
  // entries that follow an excluded entry of another stream.
  const graph = buildCausalGraph([...admitted.values()]);
  const ordered = totalOrder([...admitted.values()]);
  const excluded = new Set(direct);
  const forkedWriters = new Set<string>();
  for (const hash of direct) forkedWriters.add((admitted.get(hash) as VerifiedEntry).header.writer);
  for (const writer of forkedWriters) {
    const seen = new Map<string, Set<string>>();
    for (const entry of ordered) {
      let streams: Set<string> | undefined;
      for (const pred of graph.preds(entry.hash)) {
        const source = admitted.get(pred);
        if (source === undefined) continue;
        const carried = seen.get(pred);
        if (carried !== undefined) streams = new Set([...(streams ?? []), ...carried]);
        if (source.header.writer === writer && direct.has(pred)) (streams = streams ?? new Set()).add(source.header.stream);
      }
      if (streams === undefined) continue;
      seen.set(entry.hash, streams);
      if (entry.header.writer === writer && [...streams].some((stream) => stream !== entry.header.stream)) excluded.add(entry.hash);
    }
  }
  return excluded;
}

export function classifyChains(verified: readonly VerifiedEntry[], ctx: ReplicaContext): ChainResult {
  const nodes = new Map<string, VerifiedEntry>();
  for (const entry of verified) nodes.set(entry.hash, entry);
  const sorted = [...nodes.values()].sort((a, b) => compareText(a.hash, b.hash));

  const rejected: RejectedEntry[] = [];
  const live = new Map<string, VerifiedEntry>();
  for (const entry of sorted) {
    const reason = staticRefusal(entry, nodes);
    if (reason === undefined) live.set(entry.hash, entry);
    else rejected.push({ ...where(entry), stage: 'chain', reason });
  }

  // Admission: an entry is admitted once every predecessor is. Every entry of a fork is a node, chained to its own predecessor.
  const waiting = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  const queue: VerifiedEntry[] = [];
  for (const entry of live.values()) {
    const preds = predecessors(entry);
    remaining.set(entry.hash, preds.length);
    for (const pred of preds) pushTo(waiting, pred, entry.hash);
    if (preds.length === 0) queue.push(entry);
  }
  const admitted = new Map<string, VerifiedEntry>();
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index];
    admitted.set(entry.hash, entry);
    for (const next of waiting.get(entry.hash) ?? []) {
      const left = (remaining.get(next) as number) - 1;
      remaining.set(next, left);
      if (left === 0) queue.push(live.get(next) as VerifiedEntry);
    }
  }

  const held: HeldEntry[] = [];
  for (const entry of live.values()) {
    if (!admitted.has(entry.hash)) held.push({ ...where(entry), stage: 'chain', reason: 'missing-predecessor' satisfies ChainHold });
  }

  const proofs = findEquivocations(sorted, ctx.roster);
  const excluded = excludedEntries(admitted, proofs, ctx);

  const byText = (a: { hash?: string }, b: { hash?: string }): number => compareText(a.hash ?? '', b.hash ?? '');
  return {
    admitted: [...admitted.values()].sort((a, b) => compareText(a.hash, b.hash)),
    excluded,
    held: held.sort(byText),
    rejected: rejected.sort(byText),
    quarantined: quarantineRecords(proofs, ctx.roster),
    proofs: proofs.sort((a, b) => compareText(proofHash(a), proofHash(b)))
  };
}
