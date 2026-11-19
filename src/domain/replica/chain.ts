// Per-writer chains (DESIGN 4.4 step 1, 4.5; D-13). Pure, hub-side: no Yjs, no fold.
//
// This plan's rules, for every (stream, writer):
// - seq 0 must have prev GENESIS_PREV; seq n must have prev equal to the hash of the admitted seq n-1.
// - two different entries at one (stream, writer, seq) are both held (conflicting-seq). Plan 30-05 turns that into a proof of equivocation.
// - an entry with any predecessor (prev or dep) that is not admitted is held, repeated until nothing changes.
// excluded, quarantined and proofs stay empty here; plan 30-05 fills them.
import { GENESIS_PREV } from './entry';
import type { EntryHeader } from './entry';
import type { ReplicaContext } from './rosterView';
import type { VerifiedEntry } from './verify';

export const CHAIN_HOLDS = {
  'conflicting-seq': 'Two different entries claim the same place in one device\'s log, so neither is used until this is sorted out.',
  'missing-predecessor': 'An entry this one follows has not arrived or is not usable yet.',
  'chain-break': 'This entry does not follow the entry before it in the same device\'s log.'
} as const;
export type ChainHold = keyof typeof CHAIN_HOLDS;

export const CHAIN_REJECTIONS = {
  'bad-genesis': 'The first entry of a device\'s log must start the log, and this one points at an earlier entry.',
  'bad-dep': 'This entry cites an entry as a dependency, but that entry is not the writer and place it names.'
} as const;
export type ChainRejection = keyof typeof CHAIN_REJECTIONS;

export type FoldStage = 'verify' | 'chain' | 'fold';

export interface HeldEntry { hash?: string; stream?: string; writer?: string; seq?: number; stage: FoldStage; reason: string; family?: string }
export interface RejectedEntry { hash?: string; stream?: string; writer?: string; seq?: number; stage: FoldStage; reason: string; family?: string }
export interface QuarantineRecord { writer: string; stream: string; fromSeq: number }
// Two different signed headers at one (stream, writer, seq), and the key that signed both, so anyone can check the pair alone.
export interface EquivocationProof { a: EntryHeader; b: EntryHeader; publicKey: string }

export interface ChainResult {
  admitted: VerifiedEntry[];
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

export function classifyChains(verified: readonly VerifiedEntry[], _ctx: ReplicaContext): ChainResult {
  const byHash = new Map<string, VerifiedEntry>();
  for (const entry of verified) byHash.set(entry.hash, entry);
  const slots = new Map<string, VerifiedEntry[]>();
  for (const entry of [...byHash.values()].sort((a, b) => (a.hash < b.hash ? -1 : 1))) {
    const key = slot(entry.header.stream, entry.header.writer, entry.header.seq);
    const list = slots.get(key);
    if (list === undefined) slots.set(key, [entry]);
    else list.push(entry);
  }

  const held = new Map<string, HeldEntry>();
  const rejected: RejectedEntry[] = [];
  const candidates = new Map<string, VerifiedEntry>();
  for (const list of slots.values()) {
    if (list.length > 1) {
      for (const entry of list) held.set(entry.hash, { ...where(entry), stage: 'chain', reason: 'conflicting-seq' });
    } else {
      candidates.set(list[0].hash, list[0]);
    }
  }
  const candidateAt = (stream: string, writer: string, seq: number): VerifiedEntry | undefined => {
    const list = slots.get(slot(stream, writer, seq));
    return list !== undefined && list.length === 1 ? list[0] : undefined;
  };

  // Permanent refusals first: they never become usable, so their followers are held, not rejected.
  for (const entry of [...candidates.values()]) {
    const { header, body } = entry;
    if (header.seq === 0 && header.prev !== GENESIS_PREV) {
      rejected.push({ ...where(entry), stage: 'chain', reason: 'bad-genesis' });
      candidates.delete(entry.hash);
      continue;
    }
    const badDep = body.deps.some((dep) => {
      const target = byHash.get(dep.hash);
      return target !== undefined && (target.header.writer !== dep.writer || target.header.seq !== dep.seq);
    });
    if (badDep) {
      rejected.push({ ...where(entry), stage: 'chain', reason: 'bad-dep' });
      candidates.delete(entry.hash);
    }
  }

  const admitted = new Map<string, VerifiedEntry>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of candidates.values()) {
      if (admitted.has(entry.hash)) continue;
      const { header, body } = entry;
      let ready = true;
      if (header.seq > 0) {
        const previous = candidateAt(header.stream, header.writer, header.seq - 1);
        ready = previous !== undefined && previous.hash === header.prev && admitted.has(previous.hash);
      }
      if (ready) ready = body.deps.every((dep) => admitted.has(dep.hash));
      if (ready) {
        admitted.set(entry.hash, entry);
        changed = true;
      }
    }
  }

  for (const entry of candidates.values()) {
    if (admitted.has(entry.hash)) continue;
    const previous = entry.header.seq > 0 ? candidateAt(entry.header.stream, entry.header.writer, entry.header.seq - 1) : undefined;
    const reason: ChainHold = previous !== undefined && previous.hash !== entry.header.prev ? 'chain-break' : 'missing-predecessor';
    held.set(entry.hash, { ...where(entry), stage: 'chain', reason });
  }

  const byText = (a: { hash?: string }, b: { hash?: string }): number => ((a.hash ?? '') < (b.hash ?? '') ? -1 : (a.hash ?? '') > (b.hash ?? '') ? 1 : 0);
  return {
    admitted: [...admitted.values()].sort((a, b) => (a.hash < b.hash ? -1 : 1)),
    excluded: new Set<string>(),
    held: [...held.values()].sort(byText),
    rejected: rejected.sort(byText),
    quarantined: [],
    proofs: []
  };
}
