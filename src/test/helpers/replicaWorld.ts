// A small world for the replica tests: fixed keys, a static roster, per-writer chains and local text editors. Shared by every replica test; plans
// that need more helpers add their own helper file rather than editing this one.
// No key literal lives in any file: every key is derived from a label.
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { fingerprintOf } from '../../domain/team/canonical';
import type { PayloadSigner } from '../../domain/team/signedPayload';
import { createLocalDoc, localDelete, localInsert } from '../../domain/replica/doc';
import type { CrdtDoc } from '../../domain/replica/doc';
import { GENESIS_PREV, buildEntry, writerIdOf } from '../../domain/replica/entry';
import type { Actor, Dep, NewBody, SealedBlob, SealedEntry } from '../../domain/replica/entry';
import { staticRosterView } from '../../domain/replica/rosterView';
import type { ReplicaContext, StaticRosterSpec } from '../../domain/replica/rosterView';

export interface Rng { next(): number; int(n: number): number; chance(p: number): boolean; pick<T>(items: readonly T[]): T }

/** A small seeded generator (xorshift32), so a failing run can be replayed from its seed. */
export function rng(seed: number): Rng {
  let state = (seed * 2654435761) >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), chance: (p) => next() < p, pick: (items) => items[Math.floor(next() * items.length)] };
}

export function shuffled<T>(items: readonly T[], random: Rng): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = random.int(index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

/** Every ordering of the items. Exhaustive, so only for at most 7 items. */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length > 7) throw new Error('permutations is for at most 7 items');
  if (items.length <= 1) return [[...items]];
  const result: T[][] = [];
  items.forEach((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([item, ...tail]);
  });
  return result;
}

// 16-byte PKCS8 prefix for an Ed25519 private key, followed by the 32-byte seed.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

export interface FixedSigner { signer: PayloadSigner; publicKey: string; writer: string }

/** An Ed25519 key made from the label alone, so the same label gives the same device in every run. */
export function fixedSigner(label: string): FixedSigner {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, sha256(`signer/${label}`)]), format: 'der', type: 'pkcs8' });
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url');
  const publicKey = raw.toString('base64url');
  const signer: PayloadSigner = { fingerprint: fingerprintOf(raw), publicKey, sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url') };
  return { signer, publicKey, writer: writerIdOf(publicKey) };
}

export const epochKey = (label: string): Buffer => sha256(`epoch/${label}`);
export const streamId = (label: string): string => sha256(`stream/${label}`).toString('hex').slice(0, 32);

export const WORLD_NOW = '2026-11-19T12:00:00.000Z';
export const WORLD_AT = '2026-11-19T11:00:00.000Z';

// agentSeats: the agent seats the member's devices may run (D-12). slots: one roster slot per device, in the order of devices (D-41); a world
// where no member gives slots binds no client id to a writer, as in Phase 30.
export interface WorldMemberSpec { member: string; name?: string; roles?: string[]; devices: string[]; agentSeats?: string[]; slots?: number[] }
export interface WorldSpec { members: WorldMemberSpec[] }

export interface Written { entry: SealedEntry; hash: string; stream: string; writer: string; seq: number; lamport: number }
export interface WriteOptions { kind: string; data: unknown; actor?: Actor; deps?: readonly Written[]; stream?: string; at?: string; roster?: string; epoch?: number }
export interface RawWriteOptions { stream: string; seq: number; prev: string; body: NewBody; epoch?: number; key?: Buffer }

export interface Editor {
  client: number;
  doc: CrdtDoc;
  register(options?: Partial<WriteOptions>): Written;
  insert(index: number, text: string, options?: Partial<WriteOptions>): Written;
  remove(index: number, length: number, options?: Partial<WriteOptions>): Written;
  /** The update for a local insert, without writing an entry. */
  insertUpdate(index: number, text: string): Uint8Array;
}

export interface World {
  rosterHash: string;
  stream: string;
  rosterSpec: StaticRosterSpec;
  entries: SealedEntry[];
  blobs: Map<string, SealedBlob>;
  signerOf(writerName: string): FixedSigner;
  writerOf(writerName: string): string;
  keyFor(stream: string, epoch: number): Buffer;
  write(writerName: string, options: WriteOptions): Written;
  writeRaw(writerName: string, options: RawWriteOptions): Written;
  editor(writerName: string, product: string, clientId: number): Editor;
  heads(stream: string): Array<{ writer: string; seq: number; hash: string }>;
  ctx(overrides?: Partial<ReplicaContext>): ReplicaContext;
}

export function updateData(product: string, update: Uint8Array): { product: string; update: string } {
  return { product, update: Buffer.from(update).toString('base64url') };
}

export function createWorld(spec: WorldSpec): World {
  const rosterHash = sha256('roster/0').toString('hex');
  const stream = streamId('main');
  const signers = new Map<string, FixedSigner>();
  for (const member of spec.members) for (const device of member.devices) signers.set(device, fixedSigner(device));
  const rosterSpec: StaticRosterSpec = {
    rosters: [{
      hash: rosterHash,
      members: spec.members.map((member) => ({
        member: member.member,
        name: member.name ?? member.member,
        roles: member.roles ?? ['member'],
        devices: member.devices.map((device, index) => {
          const fixed = signers.get(device) as FixedSigner;
          const slot = member.slots?.[index];
          return slot === undefined ? { writer: fixed.writer, publicKey: fixed.publicKey } : { writer: fixed.writer, publicKey: fixed.publicKey, slot };
        }),
        ...(member.agentSeats === undefined ? {} : { agentSeats: [...member.agentSeats] })
      }))
    }]
  };
  const entries: SealedEntry[] = [];
  const blobs = new Map<string, SealedBlob>();
  const keys = new Map<string, Buffer>();
  const chains = new Map<string, { seq: number; prev: string; lamport: number }>();
  const lamports = new Map<string, number>();
  const signerOf = (name: string): FixedSigner => {
    const found = signers.get(name);
    if (found === undefined) throw new Error(`The world has no device called ${name}`);
    return found;
  };
  const keyFor = (streamId: string, epoch: number): Buffer => {
    const id = `${streamId}/${epoch}`;
    let key = keys.get(id);
    if (key === undefined) {
      key = epochKey(id);
      keys.set(id, key);
    }
    return key;
  };
  const record = (built: ReturnType<typeof buildEntry>, body: NewBody, stream: string, writer: string, seq: number): Written => {
    entries.push(built.entry);
    for (const blob of built.blobs) blobs.set(blob.hash, blob);
    lamports.set(built.hash, body.lamport);
    return { entry: built.entry, hash: built.hash, stream, writer, seq, lamport: body.lamport };
  };
  const write = (name: string, options: WriteOptions): Written => {
    const fixed = signerOf(name);
    const useStream = options.stream ?? stream;
    const epoch = options.epoch ?? 0;
    const chainKey = `${useStream}/${fixed.writer}`;
    const chain = chains.get(chainKey) ?? { seq: -1, prev: GENESIS_PREV, lamport: 0 };
    const deps = options.deps ?? [];
    const lamport = 1 + Math.max(chain.lamport, ...deps.map((dep) => lamports.get(dep.hash) ?? 0));
    const depList: Dep[] = deps.map((dep) => ({ writer: dep.writer, seq: dep.seq, hash: dep.hash }));
    const body: NewBody = { deps: depList, roster: options.roster ?? rosterHash, lamport, at: options.at ?? WORLD_AT, actor: options.actor ?? { kind: 'person' }, kind: options.kind, data: options.data };
    const seq = chain.seq + 1;
    const built = buildEntry({ signer: fixed.signer, key: keyFor(useStream, epoch), stream: useStream, seq, prev: chain.prev, epoch, body });
    chains.set(chainKey, { seq, prev: built.hash, lamport });
    return record(built, body, useStream, fixed.writer, seq);
  };
  const writeRaw = (name: string, options: RawWriteOptions): Written => {
    const fixed = signerOf(name);
    const epoch = options.epoch ?? 0;
    const built = buildEntry({ signer: fixed.signer, key: options.key ?? keyFor(options.stream, epoch), stream: options.stream, seq: options.seq, prev: options.prev, epoch, body: options.body });
    return record(built, options.body, options.stream, fixed.writer, options.seq);
  };
  return {
    rosterHash,
    stream,
    rosterSpec,
    entries,
    blobs,
    signerOf,
    writerOf: (name) => signerOf(name).writer,
    keyFor,
    write,
    writeRaw,
    editor(name, product, clientId) {
      const doc = createLocalDoc(clientId);
      return {
        client: clientId,
        doc,
        register: (options = {}) => write(name, { actor: { kind: 'person' }, ...options, kind: 'doc.client', data: { product, clientId, actor: options.actor ?? { kind: 'person' } } }),
        insert: (index, text, options = {}) => write(name, { ...options, kind: 'doc.update', data: updateData(product, localInsert(doc, index, text)) }),
        remove: (index, length, options = {}) => write(name, { ...options, kind: 'doc.update', data: updateData(product, localDelete(doc, index, length)) }),
        insertUpdate: (index, text) => localInsert(doc, index, text)
      };
    },
    heads(forStream) {
      const result: Array<{ writer: string; seq: number; hash: string }> = [];
      for (const [key, chain] of chains) if (key.startsWith(`${forStream}/`)) result.push({ writer: key.slice(forStream.length + 1), seq: chain.seq, hash: chain.prev });
      return result.sort((a, b) => (a.writer < b.writer ? -1 : 1));
    },
    ctx(overrides = {}) {
      return {
        roster: staticRosterView(rosterSpec),
        keys: (forStream, epoch) => keys.get(`${forStream}/${epoch}`),
        blobs: (hash) => blobs.get(hash),
        now: new Date(WORLD_NOW),
        ...overrides
      };
    }
  };
}
