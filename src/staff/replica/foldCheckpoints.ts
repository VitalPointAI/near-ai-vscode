// The checkpoints a computer's fold uses (Phase 33 plan 14, D-42, D-43). A version 2 checkpoint fixes the order of what it covers, and each of its heads
// lets a log start right after it (a join base), so a late joiner can begin from it instead of replaying the whole history. Only checkpoints this
// computer has reason to trust are used:
// - they are signed by a hub the roster admits as a checkpoint signer at the roster head, and they verify against the roster at their own position;
// - the hub's witness on this computer (hubWitness.ts, kept by every exchange) trusts it: a hub the witness distrusts after a fork, or holds a proof
//   against, gives none, and the fold falls back to full replay;
// - only the witness's newest checkpoint of that hub and the stored ones of the same hub no larger than it (the chain the hub nests).
// Everything else stored (fork proofs, another hub's, an older format) is evidence only. The result is sorted by hash, so two computers holding the
// same checkpoints fold under the same list.
import { CHECKPOINT_VERSION, checkpointHash, verifyCheckpoint } from '../../domain/replica/checkpoint';
import type { Checkpoint, SignedCheckpoint } from '../../domain/replica/checkpoint';
import type { RosterView } from '../../domain/replica/rosterView';
import { hubMemoryOf } from './hubSync';
import type { HubMemory, WitnessSecrets } from './hubSync';

/** Per hub writer id: the newest checkpoint its witness trusts on this computer, or undefined when the witness distrusts the hub. */
export type TrustedCheckpoints = ReadonlyMap<string, SignedCheckpoint | undefined>;

const covered = (checkpoint: Checkpoint): number => checkpoint.streams.reduce((sum, stream) => sum + stream.count, 0);

/** The verified checkpoint, or undefined unless it is a version 2 checkpoint of this project by this hub that verifies against the roster. */
function usable(signed: SignedCheckpoint, roster: RosterView, project: string, hub: string): Checkpoint | undefined {
  const read = verifyCheckpoint(signed, roster);
  if (!read.ok || read.checkpoint.v !== CHECKPOINT_VERSION || read.checkpoint.project !== project || read.checkpoint.signer !== hub) return undefined;
  return read.checkpoint;
}

/** The checkpoints the fold may use, from the stored ones and what each hub's witness trusts. */
export function foldCheckpoints(stored: readonly SignedCheckpoint[], trusted: TrustedCheckpoints, roster: RosterView, project: string, head: string): SignedCheckpoint[] {
  const chosen = new Map<string, SignedCheckpoint>();
  for (const [hub, newest] of trusted) {
    if (newest === undefined || !roster.checkpointSigner(hub, head)) continue;
    const top = usable(newest, roster, project, hub);
    if (top === undefined) continue;
    chosen.set(checkpointHash(newest), newest);
    for (const signed of stored) {
      const earlier = usable(signed, roster, project, hub);
      if (earlier !== undefined && covered(earlier) <= covered(top)) chosen.set(checkpointHash(signed), signed);
    }
  }
  return [...chosen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, signed]) => signed);
}

/**
 * What the witness of each hub that signed a stored checkpoint trusts on this computer, read once from the witness memory in this computer's secret
 * store (or the memory given); a hub whose memory cannot be read gives none.
 */
export async function trustedCheckpointsOf(secrets: WitnessSecrets | Pick<HubMemory, 'load'>, project: string, stored: readonly SignedCheckpoint[]): Promise<Map<string, SignedCheckpoint | undefined>> {
  const memory = 'load' in secrets ? secrets : hubMemoryOf(secrets);
  const trusted = new Map<string, SignedCheckpoint | undefined>();
  for (const hub of new Set(stored.map((signed) => signed?.payload?.signer).filter((signer): signer is string => typeof signer === 'string'))) {
    try {
      const witness = await memory.load(hub, project);
      trusted.set(hub, witness.distrusted || witness.proof !== undefined ? undefined : witness.newest);
    } catch {
      trusted.set(hub, undefined);
    }
  }
  return trusted;
}

