import { CHECKPOINT_VERSION, verifyCheckpoint, type SignedCheckpoint } from '../../domain/replica/checkpoint';
import type { RosterView } from '../../domain/replica/rosterView';
import type { HubMemory } from './hubSync';

interface CompactionCheckpointInput {
  readonly project: string;
  /** Writer id of the currently selected hub, from the same authenticated sync context as its witness memory. */
  readonly hub: string;
  readonly roster: RosterView;
  /** Current head from the project's roster fold, paired with the view above. */
  readonly rosterHead: string;
  readonly memory: Pick<HubMemory, 'load'>;
}

/** Select the signed checkpoint for a compaction preparation. Coverage and eligibility are checked separately before any append. */
export async function compactionCheckpoint(input: CompactionCheckpointInput): Promise<{
  readonly signed: SignedCheckpoint;
  readonly hash: string;
} | undefined> {
  const { project, hub, roster, rosterHead, memory } = input;
  if (!roster.checkpointSigner(hub, rosterHead)) return;
  const currentPosition = roster.rosterPosition(rosterHead);
  if (currentPosition === undefined || roster.rosterBranchPending?.(rosterHead)) return;

  // The retained checkpoint files can include fork proofs, and the event stream carries raw frames.
  // The persisted witness for this exact project and hub is the authority for its newest trusted checkpoint.
  const witness = await memory.load(hub, project).catch(() => undefined);
  if (witness?.project !== project || witness.hub !== hub || witness.distrusted !== false || witness.proof !== undefined) return;
  const signed = witness.newest;
  if (signed === undefined) return;
  const verified = verifyCheckpoint(signed, roster);
  if (!verified.ok || verified.checkpoint.v !== CHECKPOINT_VERSION ||
      verified.checkpoint.project !== project || verified.checkpoint.signer !== hub) return;
  const citedPosition = roster.rosterPosition(verified.checkpoint.rosterHead);
  if (citedPosition === undefined || citedPosition > currentPosition ||
      roster.rosterBranchPending?.(verified.checkpoint.rosterHead)) return;
  return { signed, hash: verified.hash };
}
