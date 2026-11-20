// The reducer for the integrity family (DESIGN 4.4, D-12): proofs of equivocation sent as entries, and digest reports. Fold-side file, but it only
// imports types from the fold, so it needs no Yjs.
//
// Quarantine itself is decided at the chain stage, from the set of verified entries (chain.ts), so it does not depend on this reducer or on the
// order entries are folded. This reducer records what the entries said, for the project's record: which proofs it holds and which digests peers
// reported. The proofs the fold found itself stay in FoldResult.proofs for the replicator (Phase 33) to write as an entry.
import type { Dep } from './entry';
import { acceptableProof, parseProof, proofHash } from './equivocation';
import type { EquivocationProof } from './equivocation';
import type { FamilyReducer, ReduceOutcome } from './reducers';

export const INTEGRITY_REFUSALS = {
  'invalid-proof': 'The proof does not check out on its own, or names a device this project does not know under that key, so it quarantines nothing.',
  'unsupported-kind': 'This kind of integrity entry is not applied by this version.'
} as const;

export interface DigestReport { entry: string; writer: string; stream: string; heads: Dep[]; digest: string; checkpoint?: string }
export interface IntegrityState { proofs: Map<string, EquivocationProof>; reports: Map<string, DigestReport> }
// One row per stream that has a proof or a report: the sorted hashes of its proofs, and its reports sorted by entry hash.
export interface IntegrityRow { stream: string; proofs: string[]; reports: DigestReport[] }
export type IntegrityOutput = IntegrityRow[];

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function refused(reason: keyof typeof INTEGRITY_REFUSALS): ReduceOutcome {
  return { status: 'refused', reason };
}

export const integrityReducer: FamilyReducer<IntegrityState, IntegrityOutput> = {
  family: 'integrity',
  init: () => ({ proofs: new Map(), reports: new Map() }),
  apply(state, entry, view): ReduceOutcome {
    if (entry.body.kind === 'equivocation.proof') {
      const proof = parseProof(entry.data);
      if (proof === undefined || !acceptableProof(proof, view.ctx.roster)) return refused('invalid-proof');
      state.proofs.set(proofHash(proof), proof);
      return { status: 'applied' };
    }
    if (entry.body.kind === 'digest.report') {
      const data = entry.data as { stream: string; heads: Dep[]; digest: string; checkpoint?: string };
      const report: DigestReport = {
        entry: entry.hash,
        writer: entry.header.writer,
        stream: data.stream,
        heads: data.heads.map((head) => ({ writer: head.writer, seq: head.seq, hash: head.hash })),
        digest: data.digest,
        ...(data.checkpoint === undefined ? {} : { checkpoint: data.checkpoint })
      };
      state.reports.set(entry.hash, report);
      return { status: 'applied' };
    }
    return refused('unsupported-kind');
  },
  finish(state): IntegrityOutput {
    const rows = new Map<string, IntegrityRow>();
    const row = (stream: string): IntegrityRow => {
      let found = rows.get(stream);
      if (found === undefined) {
        found = { stream, proofs: [], reports: [] };
        rows.set(stream, found);
      }
      return found;
    };
    for (const [hash, proof] of state.proofs) row(proof.a.stream).proofs.push(hash);
    for (const report of state.reports.values()) row(report.stream).reports.push(report);
    for (const found of rows.values()) {
      found.proofs.sort(compareText);
      found.reports.sort((a, b) => compareText(a.entry, b.entry));
    }
    return [...rows.values()].sort((a, b) => compareText(a.stream, b.stream));
  },
  canonical(output, stream): unknown {
    const found = output.find((row) => row.stream === stream);
    return found === undefined ? { proofs: [], reports: [] } : { proofs: found.proofs, reports: found.reports };
  },
  clone(state): IntegrityState {
    return { proofs: new Map(state.proofs), reports: new Map(state.reports) };
  }
};
