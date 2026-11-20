// Helpers for forks, tampering, re-sealing and future-dated entries, built on world.writeRaw. Owned by plan 30-05. The shared world helper
// (replicaWorld.ts) is not edited by this plan.
import { entryHash, openBody } from '../../domain/replica/entry';
import type { Actor, Dep, EntryHeader, NewBody, SealedEntry } from '../../domain/replica/entry';
import { WORLD_AT, WORLD_NOW } from './replicaWorld';
import type { Written, World } from './replicaWorld';

export interface ForkBody { kind: string; data: unknown; deps?: Dep[]; lamport?: number; at?: string; roster?: string; actor?: Actor }

function findEntry(world: World, writerName: string, stream: string, seq: number): SealedEntry {
  const writer = world.writerOf(writerName);
  const found = world.entries.find((entry) => entry.header.writer === writer && entry.header.stream === stream && entry.header.seq === seq);
  if (found === undefined) throw new Error(`The world has no entry by ${writerName} at seq ${seq}`);
  return found;
}

// The body of an entry this world wrote, opened with the world's own key.
export function openWorldBody(world: World, entry: SealedEntry): NewBody {
  const key = world.keyFor(entry.header.stream, entry.header.epoch);
  const plain = openBody(key, entry.header, Buffer.from(entry.body, 'base64url'));
  if (plain === undefined) throw new Error('The world could not open its own entry');
  const body = JSON.parse(plain.toString('utf8')) as NewBody & { blob?: string };
  if (body.blob !== undefined) throw new Error('The fork helpers handle inline bodies only');
  return body;
}

function lamportOfHash(world: World, hash: string): number {
  const found = world.entries.find((entry) => entryHash(entry.header) === hash);
  return found === undefined ? 0 : openWorldBody(world, found).lamport;
}

// Signs and seals a second entry at an existing seq of the writer, with the same prev: the writer shows two histories. The lamport defaults to
// the rule's value (1 plus the highest of the predecessors), which makes the branches look the same to the ordering.
export function forkAt(world: World, writerName: string, stream: string, seq: number, body: ForkBody): Written {
  const existing = findEntry(world, writerName, stream, seq);
  const deps = body.deps ?? [];
  const preds = [...(existing.header.seq > 0 ? [existing.header.prev] : []), ...deps.map((dep) => dep.hash)];
  const lamport = body.lamport ?? 1 + Math.max(0, ...preds.map((hash) => lamportOfHash(world, hash)));
  return world.writeRaw(writerName, {
    stream,
    seq,
    prev: existing.header.prev,
    epoch: existing.header.epoch,
    body: { deps, roster: body.roster ?? world.rosterHash, lamport, at: body.at ?? WORLD_AT, actor: body.actor ?? { kind: 'person' }, kind: body.kind, data: body.data }
  });
}

// A copy of the entry with one header field changed after signing, and the original signature kept.
export function tamperHeader(entry: SealedEntry, change: Partial<Omit<EntryHeader, 'sig' | 'v'>>): SealedEntry {
  return { header: { ...entry.header, ...change }, body: entry.body };
}

// Seals the same body again at the same seq (a new IV, so a new body.hash and a freshly signed second header): equivocation, not a retry.
export function resealAt(world: World, writerName: string, entry: SealedEntry): Written {
  const body = openWorldBody(world, entry);
  return world.writeRaw(writerName, { stream: entry.header.stream, seq: entry.header.seq, prev: entry.header.prev, epoch: entry.header.epoch, body });
}

// Writes the writer's next entry dated that many minutes after the world's now.
export function futureEntry(world: World, writerName: string, minutesAhead: number, options: { kind: string; data: unknown; deps?: readonly Written[]; stream?: string }): Written {
  const at = new Date(Date.parse(WORLD_NOW) + minutesAhead * 60_000).toISOString();
  return world.write(writerName, { ...options, at });
}
