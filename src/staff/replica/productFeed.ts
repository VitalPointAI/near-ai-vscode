// The product update feed (Phase 33, F6, T-33-01): the update bytes of one product that the fold accepted, in fold order, after a cursor. An editor
// applies only these, never raw store bytes, so an update the fold refused or holds (an unregistered client id, a clock overlap, a forged author)
// never reaches a document. Each entry is read from the store and opened again through verifyEntry with the project's context; an accepted hash
// that cannot be produced that way ends the feed there, so an editor never applies a later update without an earlier one.
//
// The feed reads the fold's accepted list from state() and the bytes from the store's entries: ReplicaProject keeps the Y.Doc and the update bytes
// to itself (F6), and replicaProject.ts may barely grow, so this file holds the read path.
import { entryHash } from '../../domain/replica/entry';
import type { ProductTextOutput } from '../../domain/replica/textFold';
import { verifyEntry } from '../../domain/replica/verify';
import type { ReplicaProject } from './replicaProject';

/** One accepted update: the entry's hash, the device that wrote it and its Yjs update bytes. */
export interface AcceptedUpdate { hash: string; writer: string; bytes: Uint8Array }

/** The updates after the cursor, and the hash of the newest accepted update (the cursor for the next read), when the product has any. */
export interface AcceptedFeed { updates: AcceptedUpdate[]; last?: string }

/** The part of the project the feed reads. */
export type FeedProject = Pick<ReplicaProject, 'state' | 'context' | 'heads' | 'entriesAfter'>;

/** The product's text output as the fold has it now, or undefined when no entry of it was folded. */
export function productOutput(fold: { families: Record<string, unknown> }, stream: string, product: string): ProductTextOutput | undefined {
  return ((fold.families.doc as ProductTextOutput[] | undefined) ?? []).find((item) => item.stream === stream && item.product === product);
}

/**
 * The accepted update bytes of one product, in fold order, after `after` (an accepted hash). An `after` the fold does not list as accepted gives
 * every accepted update. A live editor can instead pass the hashes it has applied. A refold can place a newly accepted update before its last hash.
 */
export async function acceptedUpdates(project: FeedProject, stream: string, product: string, after?: string | ReadonlySet<string>): Promise<AcceptedFeed> {
  const { fold } = await project.state();
  const accepted = productOutput(fold, stream, product)?.accepted ?? [];
  if (accepted.length === 0) return { updates: [] };
  const wanted = typeof after === 'object'
    ? accepted.filter((hash) => !after.has(hash))
    : accepted.slice(after === undefined ? 0 : accepted.indexOf(after) + 1);
  if (wanted.length === 0) return { updates: [], last: accepted[accepted.length - 1] };

  const want = new Set(wanted);
  const raw = new Map<string, unknown>();
  const writers = (await project.heads()).find((item) => item.stream === stream)?.heads.map((head) => head.writer) ?? [];
  for (const writer of writers) {
    for (const entry of await project.entriesAfter(stream, writer, -1)) {
      const hash = entryHash(entry.header);
      if (want.has(hash)) raw.set(hash, entry);
    }
  }
  const context = project.context();
  const updates: AcceptedUpdate[] = [];
  for (const hash of wanted) {
    const opened = raw.has(hash) ? verifyEntry(raw.get(hash), context) : undefined;
    const entry = opened?.status === 'verified' ? opened.entry : undefined;
    const data = entry?.data as { product?: unknown; update?: unknown } | undefined;
    if (entry === undefined || entry.hash !== hash || entry.body.kind !== 'doc.update' || entry.header.stream !== stream || data?.product !== product || typeof data.update !== 'string') {
      // Fail closed and in order: nothing after a hole is handed out, and the cursor stays before it.
      const previous = accepted.indexOf(hash) - 1;
      return previous >= 0 ? { updates, last: accepted[previous] } : { updates };
    }
    updates.push({ hash, writer: entry.header.writer, bytes: new Uint8Array(Buffer.from(data.update, 'base64url')) });
  }
  return { updates, last: accepted[accepted.length - 1] };
}
