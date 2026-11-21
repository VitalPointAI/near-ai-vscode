// An in-memory replica for the client sync tests (32-23): a SyncLocal built from hub-side modules only, so the hub's tests can run the extension's
// transport and one-shot sync against the real hub without the fold, Yjs or the editor (D-27). It holds entries per stream and writer with a prev
// check on every add, blobs and grants, and folds the roster with foldRoster and rosterView from the device's own grants and X25519 key.
// It cannot open bodies it does not hold keys for and never decodes a document, so it names no wanted or cited blobs. All data is fictional.
import { createHash } from 'node:crypto';
import { grantHash, unwrapEpochKey } from '@ext/domain/replica/cellKeys';
import type { SignedCheckpoint } from '@ext/domain/replica/checkpoint';
import { checkpointHash } from '@ext/domain/replica/checkpoint';
import { GENESIS_PREV, entryHash } from '@ext/domain/replica/entry';
import type { SealedBlob, SealedEntry } from '@ext/domain/replica/entry';
import { foldRoster, rosterView } from '@ext/domain/replica/roster';
import type { RosterView } from '@ext/domain/replica/rosterView';
import type { HeadSet } from '@ext/domain/replica/transport';
import type { SyncLocal } from '@ext/staff/replica/hubSync';
import type { HubWorld, WorldDevice } from './hubWorld';
import { WORLD_NOW } from './hubWorld';

export interface MemoryReplica extends SyncLocal {
  /** Adds one entry if it follows the writer's head (seq one higher, prev naming it); false otherwise. */
  add(entry: SealedEntry): boolean;
  /** Every entry held, in the order added. */
  all(): SealedEntry[];
  has(hash: string): boolean;
}

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** A replica for one device of the world, holding the given entries (the world's entries by default), every world grant and blob. */
export function memoryReplica(world: HubWorld, device: WorldDevice, entries: readonly SealedEntry[] = world.entries): MemoryReplica {
  const logs = new Map<string, SealedEntry[]>();
  const order: SealedEntry[] = [];
  const hashes = new Set<string>();
  const blobs = new Map<string, SealedBlob>(world.blobs);
  const grants = new Map<string, unknown>(world.grants.map((grant) => [grantHash(grant), grant]));
  const checkpoints = new Map<string, SignedCheckpoint>();
  const logOf = (stream: string, writer: string): SealedEntry[] => {
    const key = `${stream}/${writer}`;
    let log = logs.get(key);
    if (log === undefined) {
      log = [];
      logs.set(key, log);
    }
    return log;
  };

  const add = (entry: SealedEntry): boolean => {
    const hash = entryHash(entry.header);
    if (hashes.has(hash)) return false;
    const log = logOf(entry.header.stream, entry.header.writer);
    const last = log[log.length - 1];
    const seq = last === undefined ? 0 : last.header.seq + 1;
    const prev = last === undefined ? GENESIS_PREV : entryHash(last.header);
    if (entry.header.seq !== seq || entry.header.prev !== prev) return false;
    log.push({ header: entry.header, body: entry.body });
    order.push(log[log.length - 1] as SealedEntry);
    hashes.add(hash);
    return true;
  };
  for (const entry of entries) add(entry);

  const ring = (): ((stream: string, epoch: number) => Buffer | undefined) => {
    const keys = new Map<string, Buffer>();
    for (const signed of grants.values()) {
      const payload = (signed as { payload: { cell: string; epoch: number; wraps: Array<{ writer: string; wrap: string }> } }).payload;
      const mine = payload.wraps.find((item) => item.writer === device.writer);
      if (mine === undefined) continue;
      const key = unwrapEpochKey({ cell: payload.cell, epoch: payload.epoch, writer: device.writer, privateKey: device.x25519Private, wrap: mine.wrap });
      if (key !== undefined) keys.set(`${payload.cell}/${payload.epoch}`, key);
    }
    return (stream, epoch) => keys.get(`${stream}/${epoch}`);
  };

  const replica: MemoryReplica = {
    project: world.project,
    writer: device.writer,
    add,
    all: () => [...order],
    has: (hash) => hashes.has(hash),
    async roster(): Promise<RosterView> {
      const state = foldRoster({ entries: order, anchor: world.anchor(), keys: ring(), blobs: (hash) => blobs.get(hash), grants: [...grants.values()], now: new Date(WORLD_NOW) });
      return rosterView(state);
    },
    async heads(): Promise<HeadSet['streams']> {
      const streams = new Map<string, HeadSet['streams'][number]>();
      for (const log of logs.values()) {
        const last = log[log.length - 1];
        if (last === undefined) continue;
        const row = streams.get(last.header.stream) ?? { stream: last.header.stream, heads: [] };
        row.heads.push({ writer: last.header.writer, seq: last.header.seq, hash: entryHash(last.header) });
        streams.set(last.header.stream, row);
      }
      return [...streams.values()];
    },
    async head(stream, writer) {
      const last = logs.get(`${stream}/${writer}`)?.at(-1);
      return last === undefined ? undefined : { seq: last.header.seq, hash: entryHash(last.header) };
    },
    async holds(list) {
      return new Set(list.filter((hash) => hashes.has(hash)));
    },
    async entriesAfter(stream, writer, seq) {
      return (logs.get(`${stream}/${writer}`) ?? []).filter((entry) => entry.header.seq > seq);
    },
    async blob(hash) {
      return blobs.get(hash);
    },
    async wantedBlobs() {
      return [];
    },
    async blobsCitedBy() {
      return [];
    },
    async grants() {
      return [...grants].map(([hash, signed]) => ({ hash, signed }));
    },
    async ingest(list, given) {
      let added = 0;
      for (const blob of given) if (sha256Hex(Buffer.from(blob.bytes, 'base64url')) === blob.hash) blobs.set(blob.hash, blob);
      for (const entry of list) if (add(entry)) added += 1;
      return { added, notStored: list.length - added };
    },
    async putGrants(list) {
      for (const grant of list) grants.set(grantHash(grant), grant);
    },
    async checkpoints() {
      return [...checkpoints.values()];
    },
    async putCheckpoint(signed) {
      checkpoints.set(checkpointHash(signed), signed);
    }
  };
  return replica;
}

/** A SecretStorage stand-in for the witness memory. */
export class MemorySecrets {
  readonly values = new Map<string, string>();
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }
  store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}
