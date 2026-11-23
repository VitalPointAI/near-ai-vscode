import { isDeepStrictEqual } from 'node:util';
import { CHECKPOINT_VERSION, checkpointHeads, recomputeCheckpoint, verifyCheckpoint, type SignedCheckpoint } from '../../domain/replica/checkpoint';
import { applyUpdate, createFoldDoc, docText, encodeFullState, pendingState, stateVectorOf, textHashOf } from '../../domain/replica/doc';
import { sealBlob, type Dep, type SealedBlob, type SealedEntry } from '../../domain/replica/entry';
import { foldEntries } from '../../domain/replica/fold';
import { MAX_COMPACT_COVERS, MAX_STATE_BYTES } from '../../domain/replica/kindSchemas/doc';
import type { ReplicaContext, RosterView } from '../../domain/replica/rosterView';
import { COMPACTION_WINDOW } from '../../domain/replica/textFold';
import { verifyEntry, type VerifiedEntry } from '../../domain/replica/verify';
import type { HubMemory } from './hubSync';
import { productOutput } from './productFeed';

const MAX_PREPARATION_ENTRIES = 4096;
const MAX_PREPARATION_BODY_CHARS = 16 * 1024 * 1024;
const MAX_PREPARATION_BLOB_CHARS = 16 * 1024 * 1024;

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

interface PrepareCompactionInput extends Omit<CompactionCheckpointInput, 'roster'> {
  readonly context: ReplicaContext;
  /** The signed entries in the complete local snapshot, including registrations and prior compactions. */
  readonly entries: readonly SealedEntry[];
  readonly stream: string;
  readonly product: string;
  readonly writer: string;
  /** The target cell epoch at rosterHead, supplied by the local roster caller. */
  readonly epoch: number;
}

export interface PreparedCompaction {
  readonly checkpoint: string;
  readonly rosterHead: string;
  readonly stream: string;
  readonly epoch: number;
  readonly blob: SealedBlob;
  readonly payload: {
    readonly product: string;
    readonly covers: readonly Dep[];
    readonly stateVector: ReadonlyArray<readonly [number, number]>;
    readonly textHash: string;
    readonly stateBlob: string;
  };
}

function openSnapshot(entries: readonly SealedEntry[], context: ReplicaContext): Map<string, VerifiedEntry> | undefined {
  if (entries.length > MAX_PREPARATION_ENTRIES) return;
  const opened = new Map<string, VerifiedEntry>();
  let bodyChars = 0;
  for (const sealed of entries) {
    if (typeof sealed?.body !== 'string') return;
    bodyChars += sealed.body.length;
    if (bodyChars > MAX_PREPARATION_BODY_CHARS) return;
    const outcome = verifyEntry(sealed, context);
    if (outcome.status !== 'verified' || opened.has(outcome.entry.hash)) return;
    opened.set(outcome.entry.hash, outcome.entry);
  }
  return opened;
}

/** Verify a complete witnessed snapshot and prepare sealed state in memory. Publication must recheck freshness under the store lock. */
export async function prepareCompaction(input: PrepareCompactionInput): Promise<PreparedCompaction | undefined> {
  const { context, entries, stream, product, writer, epoch, rosterHead } = input;
  if (!context.roster.isAdmitted(writer, rosterHead) || !Number.isSafeInteger(epoch) || epoch < 0) return;
  const key = context.keys(stream, epoch);
  if (key === undefined) return;
  const witness = await compactionCheckpoint({ ...input, roster: context.roster });
  if (!witness) return;
  const checkpoint = witness.signed.payload;
  if (checkpoint.rosterHead !== rosterHead) return;
  const covered = checkpoint.streams.find((item) => item.stream === stream);
  if (!covered || !covered.heads.length || covered.heads.length > MAX_COMPACT_COVERS ||
      checkpoint.streams.reduce((count, item) => count + item.count, 0) !== entries.length) return;

  let blobChars = 0;
  const boundedContext: ReplicaContext = {
    ...context,
    blobs(hash) {
      if (blobChars > MAX_PREPARATION_BLOB_CHARS) return;
      const blob = context.blobs(hash);
      blobChars += blob?.bytes.length ?? 0;
      return blobChars <= MAX_PREPARATION_BLOB_CHARS ? blob : undefined;
    }
  };
  const opened = openSnapshot(entries, boundedContext);
  if (!opened) return;
  const verified = [...opened.values()];
  const localHeads = checkpointHeads(verified, context.roster);
  if (localHeads.size !== checkpoint.streams.length ||
      checkpoint.streams.some((item) => !isDeepStrictEqual(item.heads, localHeads.get(item.stream)))) return;
  const folded = foldEntries(entries, boundedContext);
  if (folded.held.length || folded.order.length !== verified.length || blobChars > MAX_PREPARATION_BLOB_CHARS ||
      !recomputeCheckpoint(checkpoint, verified, folded.digests).ok) return;
  const output = productOutput(folded, stream, product);
  if (!output || output.incomplete || output.problem || output.compactions.some((item) => !item.verified)) return;

  const lastOwn = output.compactions.filter((item) => opened.get(item.entry)?.header.writer === writer).at(-1);
  const order = new Map(folded.order.map((hash, index) => [hash, index]));
  const lastPosition = lastOwn === undefined ? -1 : order.get(lastOwn.entry) ?? Number.POSITIVE_INFINITY;
  const gained = output.accepted.filter((hash) => (order.get(hash) ?? -1) > lastPosition).length;
  if (gained < COMPACTION_WINDOW) return;

  const doc = createFoldDoc();
  for (const hash of output.accepted) {
    const entry = opened.get(hash);
    const data = entry?.data as { product?: unknown; update?: unknown } | undefined;
    if (entry?.body.kind !== 'doc.update' || entry.header.stream !== stream || data?.product !== product ||
        typeof data.update !== 'string' || !applyUpdate(doc, Buffer.from(data.update, 'base64url'))) return;
  }
  if (pendingState(doc)) return;
  const stateVector = stateVectorOf(doc);
  const textHash = textHashOf(docText(doc));
  if (!isDeepStrictEqual(stateVector, output.stateVector) || textHash !== output.textHash) return;
  const bytes = Buffer.from(encodeFullState(doc));
  if (bytes.length > MAX_STATE_BYTES) return;
  const blob = sealBlob(key, stream, epoch, bytes);
  const covers = covered.heads.map(({ writer, seq, hash }) => ({ writer, seq, hash }));
  return {
    checkpoint: witness.hash, rosterHead, stream, epoch, blob,
    payload: { product, covers, stateVector, textHash, stateBlob: blob.hash }
  };
}
