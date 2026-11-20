// The body of the decode worker (D-05 as refined by D-43). Bytes that arrive from outside the machine are inspected here, in a worker thread whose
// heap and stack are capped by decodeHost.ts, so a decoder bug or a large accepted update costs this thread and never the extension host's.
//
// The worker only inspects (P-31-12): it answers one job with a small plain summary, never writes, stores or keeps anything between jobs, and never
// decides on its own what the fold sees. It uses the same pure checks the fold runs in process (doc.ts and the skim in updateGuard.ts), so an honest
// update gets the same answer here as there. It imports no editor API: a worker thread has none.
//
// Protocol: the host posts { id, kind: 'update' | 'snapshot' | 'state', bytes } and the worker answers { id, ok: true, structs, deletes, clients }
// or { id, ok: false, error }. structs, deletes and clients are counts. For a snapshot, structs is 0, deletes is its delete ranges and clients is
// the clients of its state vector.
import { parentPort } from 'node:worker_threads';
import { decodeSnapshot, inspectState, inspectUpdate, snapshotStateVector } from '../../domain/replica/doc';
import type { InspectError, UpdateInspection } from '../../domain/replica/doc';
import { MAX_STATE_BYTES } from '../../domain/replica/kindSchemas/doc';
import { skimSnapshot } from '../../domain/replica/updateGuard';

export type DecodeKind = 'update' | 'snapshot' | 'state';
export interface DecodeJob { id: number; kind: DecodeKind; bytes: Uint8Array }
export type DecodeReply =
  | { id: number; ok: true; structs: number; deletes: number; clients: number }
  | { id: number; ok: false; error: InspectError };

type Answer = { ok: true; structs: number; deletes: number; clients: number } | { ok: false; error: InspectError };

function summary(found: UpdateInspection | { error: InspectError }): Answer {
  if ('error' in found) return { ok: false, error: found.error };
  return { ok: true, structs: found.structs.length, deletes: found.deletes.length, clients: found.clients.length };
}

// decodeSnapshot answers only "a snapshot or not", so the size and the skim are asked first to tell too-large and forbidden content from damage.
function inspectSnapshotBytes(bytes: Uint8Array): Answer {
  if (bytes.length > MAX_STATE_BYTES) return { ok: false, error: 'too-large' };
  const skim = skimSnapshot(bytes);
  if (!skim.ok) return { ok: false, error: skim.error };
  const snapshot = decodeSnapshot(bytes);
  if (snapshot === undefined) return { ok: false, error: 'malformed' };
  return { ok: true, structs: 0, deletes: skim.ranges, clients: snapshotStateVector(snapshot).length };
}

export function answerJob(kind: unknown, bytes: unknown): Answer {
  if (!(bytes instanceof Uint8Array)) return { ok: false, error: 'malformed' };
  try {
    if (kind === 'update') return summary(inspectUpdate(bytes));
    if (kind === 'state') return summary(inspectState(bytes));
    if (kind === 'snapshot') return inspectSnapshotBytes(bytes);
    return { ok: false, error: 'malformed' };
  } catch {
    // The pure checks never throw on hostile bytes; anything that still escapes is damage, not a crash of the worker.
    return { ok: false, error: 'malformed' };
  }
}

function isJob(value: unknown): value is DecodeJob {
  return typeof value === 'object' && value !== null && Number.isSafeInteger((value as { id?: unknown }).id);
}

if (parentPort !== null) {
  const port = parentPort;
  port.on('message', (message: unknown) => {
    // A message without a job id cannot be answered; the host only ever sends jobs, so it is ignored.
    if (!isJob(message)) return;
    const reply: DecodeReply = { id: message.id, ...answerJob(message.kind, message.bytes) };
    port.postMessage(reply);
  });
}
