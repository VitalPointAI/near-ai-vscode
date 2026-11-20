// Canonical vectors for the replica contract (D-28). Phases 31 and 32 and the hub test against the bytes this builder writes to
// test/fixtures/replica/vectors.json, so every detail of the format shows up here: the header canonical bytes, the AES-GCM associated data, the
// signatures, the entry hashes, sealed bodies and blobs, a checkpoint with its order tip, an equivocation proof and the version hash.
//
// Every key comes from a public label (fixedSigner and epochKey in replicaWorld.ts): the fixture holds labels, public keys and outputs, never private
// key bytes. These are TEST keys; nothing sealed or signed with them protects real data.
// Sealing uses a fixed IV from a label so the bytes repeat. Production sealRaw always uses a random IV; the tests open the vectors with production
// openRaw, so the vectors prove the production reader.
import { createCipheriv, createHash } from 'node:crypto';
import { canonicalBytes } from '../../domain/team/canonical';
import { IV_BYTES, TAG_BYTES } from '../../domain/state/keys';
import { checkpointHash, orderTipOf, signCheckpoint } from '../../domain/replica/checkpoint';
import type { Checkpoint } from '../../domain/replica/checkpoint';
import { createLocalDoc, localInsert } from '../../domain/replica/doc';
import { canonicalProof, proofHash } from '../../domain/replica/equivocation';
import { foldEntries } from '../../domain/replica/fold';
import { GENESIS_PREV, SEALED_OVERHEAD, blobAad, entryHash, headerAad, sha256Hex, signHeader, toWire } from '../../domain/replica/entry';
import type { Actor, EntryBody, EntryHeader, SealedBlob, UnsignedHeader } from '../../domain/replica/entry';
import { totalOrder } from '../../domain/replica/order';
import { staticRosterView } from '../../domain/replica/rosterView';
import type { ReplicaContext } from '../../domain/replica/rosterView';
import { replicaVersionHash } from '../../domain/replica/versions';
import { epochKey, fixedSigner, streamId, updateData } from './replicaWorld';
import type { FixedSigner } from './replicaWorld';

export const VECTOR_LABELS = {
  writerA: 'near-ai replica vector writer A',
  writerB: 'near-ai replica vector writer B',
  epoch: 'near-ai replica vector epoch 0',
  stream: 'near-ai replica vector stream',
  roster: 'near-ai replica vector roster 0',
  project: 'vector-project',
  product: 'vector-product'
} as const;

export const VECTOR_NOTE = 'Test vectors for the near-ai replica contract (entry format 2). Every key is derived from a public label, so these keys must never protect real data. '
  + 'Binary values are base64url. Regenerating this file is a reviewed format change: Phases 31 and 32 and the hub test against these exact bytes.';

const VECTOR_AT = '2026-01-01T00:00:00.000Z';
const CLIENT_A = 101;
const CLIENT_B = 202;

export interface VectorWriter { label: string; publicKey: string; writer: string }
export interface VectorEntry {
  name: string;
  // base64url of the canonical bytes of the header without sig (what is signed).
  unsignedHeaderCanonical: string;
  // base64url of the AES-GCM associated data.
  aad: string;
  header: EntryHeader;
  entryHash: string;
  // base64url of the canonical body bytes before sealing.
  bodyPlaintext: string;
  // base64url of iv, tag, data.
  bodyWire: string;
  ivLabel: string;
}
export interface VectorBlob { name: string; hash: string; aad: string; plaintext: string; bytes: string; ivLabel: string }
export interface VectorProof { proof: { a: EntryHeader; b: EntryHeader; publicKey: string }; proofHash: string; secondIvLabel: string }
export interface VectorCheckpoint {
  unsigned: Checkpoint;
  orderTips: Array<{ stream: string; order: string[]; orderTip: string }>;
  signed: ReturnType<typeof signCheckpoint>;
  hash: string;
  signerLabel: string;
}
export interface VectorVersionHash { text: string; pins: Array<{ product: string; hash: string }>; hash: string }
export interface ReplicaVectors {
  note: string;
  labels: typeof VECTOR_LABELS;
  roster: { hash: string; checkpointSigner: string };
  writers: VectorWriter[];
  epochKeys: Array<{ label: string }>;
  entries: VectorEntry[];
  blobs: VectorBlob[];
  checkpoint: VectorCheckpoint;
  proof: VectorProof;
  versionHashes: VectorVersionHash[];
  // The digest of each stream when the vector entries are folded with the default reducers (plan 30-12): the state, not only the bytes, is pinned.
  digests: Record<string, string>;
}

const b64 = (bytes: Buffer | Uint8Array): string => Buffer.from(bytes).toString('base64url');
const labelHash = (label: string): Buffer => createHash('sha256').update(label, 'utf8').digest();

/** Test only: AES-256-GCM with an IV taken from a label, wire form iv, tag, data. Production sealRaw draws a random IV. */
export function sealFixedIv(key: Buffer, plaintext: Buffer, aad: Buffer, ivLabel: string): Buffer {
  const iv = labelHash(ivLabel).subarray(0, IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return toWire({ iv, tag: cipher.getAuthTag(), data });
}

// A long text that is the same on every machine and does not compress to nothing: hex of consecutive hashes.
function filler(length: number): string {
  let text = '';
  for (let index = 0; text.length < length; index += 1) text += createHash('sha256').update(`filler ${index}`).digest('hex');
  return text.slice(0, length);
}

interface Chain { signer: FixedSigner; seq: number; prev: string; lamport: number }

// The reader's context for a vector set, from its public values only: the roster of the two writers, the epoch key from its label, the blobs by hash and
// a fixed clock. The vectors test builds the same context from the committed fixture.
export function vectorContext(vectors: Pick<ReplicaVectors, 'roster' | 'writers' | 'epochKeys' | 'blobs' | 'labels'>): ReplicaContext {
  const key = epochKey(vectors.epochKeys[0].label);
  const stream = streamId(vectors.labels.stream);
  const blobs = new Map<string, SealedBlob>(vectors.blobs.map((blob) => [blob.hash, { hash: blob.hash, bytes: blob.bytes }]));
  return {
    roster: staticRosterView({
      rosters: [{
        hash: vectors.roster.hash,
        members: vectors.writers.map((writer, index) => ({ member: index === 0 ? 'writer-a' : 'writer-b', name: writer.label, roles: ['member'], devices: [{ writer: writer.writer, publicKey: writer.publicKey }] })),
        checkpointSigners: [vectors.roster.checkpointSigner]
      }]
    }),
    keys: (forStream, epoch) => (forStream === stream && epoch === 0 ? key : undefined),
    blobs: (hash) => blobs.get(hash),
    now: new Date('2026-11-19T12:00:00.000Z')
  };
}

export function buildVectors(): ReplicaVectors {
  const a = fixedSigner(VECTOR_LABELS.writerA);
  const b = fixedSigner(VECTOR_LABELS.writerB);
  const key = epochKey(VECTOR_LABELS.epoch);
  const stream = streamId(VECTOR_LABELS.stream);
  const rosterHash = labelHash(VECTOR_LABELS.roster).toString('hex');
  const person: Actor = { kind: 'person' };
  const entries: VectorEntry[] = [];
  const blobs: VectorBlob[] = [];
  const verified: Array<{ hash: string; header: EntryHeader; body: Pick<EntryBody, 'lamport'> }> = [];
  const chains = new Map<string, Chain>([['A', { signer: a, seq: 0, prev: GENESIS_PREV, lamport: 0 }], ['B', { signer: b, seq: 0, prev: GENESIS_PREV, lamport: 0 }]]);

  const add = (name: string, who: 'A' | 'B', kind: string, data: unknown, ivLabel: string, secondIv?: string): { header: EntryHeader; hash: string } => {
    const chain = chains.get(who) as Chain;
    let stored: Record<string, unknown> = { deps: [], roster: rosterHash, lamport: chain.lamport + 1, at: VECTOR_AT, actor: person, kind, data };
    let plaintext = canonicalBytes(stored);
    if (plaintext.length > 16 * 1024) {
      const blobPlain = canonicalBytes(data);
      const blobWire = sealFixedIv(key, blobPlain, blobAad(stream, 0), `${ivLabel}/blob`);
      const blobHash = sha256Hex(blobWire);
      blobs.push({ name: `${name} blob`, hash: blobHash, aad: b64(blobAad(stream, 0)), plaintext: b64(blobPlain), bytes: b64(blobWire), ivLabel: `${ivLabel}/blob` });
      stored = { deps: [], roster: rosterHash, lamport: chain.lamport + 1, at: VECTOR_AT, actor: person, kind, blob: blobHash };
      plaintext = canonicalBytes(stored);
    }
    const ids = { stream, writer: chain.signer.writer, seq: chain.seq, prev: chain.prev, epoch: 0 };
    const size = plaintext.length + SEALED_OVERHEAD;
    const aad = headerAad({ ...ids, body: { size } });
    const wire = sealFixedIv(key, plaintext, aad, secondIv ?? ivLabel);
    const unsigned: UnsignedHeader = { v: 2, ...ids, body: { hash: sha256Hex(wire), size: wire.length } };
    const header = signHeader(chain.signer.signer, unsigned);
    const hash = entryHash(header);
    if (secondIv === undefined) {
      entries.push({ name, unsignedHeaderCanonical: b64(canonicalBytes(unsigned)), aad: b64(aad), header, entryHash: hash, bodyPlaintext: b64(plaintext), bodyWire: b64(wire), ivLabel });
      verified.push({ hash, header, body: { lamport: chain.lamport + 1 } });
      chains.set(who, { ...chain, seq: chain.seq + 1, prev: hash, lamport: chain.lamport + 1 });
    }
    return { header, hash };
  };

  const docA = createLocalDoc(CLIENT_A);
  const docB = createLocalDoc(CLIENT_B);
  add('A seq 0 doc.client', 'A', 'doc.client', { product: VECTOR_LABELS.product, clientId: CLIENT_A, actor: person }, 'vector iv a0');
  const helloData = updateData(VECTOR_LABELS.product, localInsert(docA, 0, 'Hello '));
  const a1 = add('A seq 1 doc.update "Hello "', 'A', 'doc.update', helloData, 'vector iv a1');
  add('A seq 2 doc.update over 16 KB (blob)', 'A', 'doc.update', updateData(VECTOR_LABELS.product, localInsert(docA, 6, filler(13000))), 'vector iv a2');
  add('B seq 0 doc.client', 'B', 'doc.client', { product: VECTOR_LABELS.product, clientId: CLIENT_B, actor: person }, 'vector iv b0');
  add('B seq 1 doc.update "world"', 'B', 'doc.update', updateData(VECTOR_LABELS.product, localInsert(docB, 0, 'world')), 'vector iv b1');

  // The fork: the same A seq 1 body sealed under a different IV is a second signed header at one seq (D-32). Built from a copy of the chain as it
  // stood before A seq 1, and it does not advance the real chain or join the entries.
  const real = chains.get('A') as Chain;
  chains.set('A', { signer: a, seq: 1, prev: entries[0].entryHash, lamport: 1 });
  const fork = add('A seq 1 (second seal)', 'A', 'doc.update', helloData, 'vector iv a1', 'vector iv a1 second');
  chains.set('A', real);
  const proof = canonicalProof(a1.header, fork.header, a.publicKey);

  // The checkpoint: signed by device A, which the vector roster names as the checkpoint signer.
  const order = totalOrder(verified).map((entry) => entry.hash);
  const heads = [a, b]
    .map((who) => {
      const last = entries.filter((entry) => entry.header.writer === who.writer).reduce((best, entry) => (entry.header.seq > best.header.seq ? entry : best));
      return { writer: who.writer, seq: last.header.seq, hash: last.entryHash };
    })
    .sort((x, y) => (x.writer < y.writer ? -1 : 1));
  const orderTip = orderTipOf(order);
  const unsigned: Checkpoint = { type: 'checkpoint', v: 1, project: VECTOR_LABELS.project, signer: a.writer, rosterHead: rosterHash, streams: [{ stream, heads, count: order.length, orderTip }] };
  const signed = signCheckpoint(a.signer, unsigned);

  const hashOfText = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
  const versionRows: Array<{ text: string; pins: Array<{ product: string; hash: string }> }> = [
    { text: 'Plain text with no pins.\n', pins: [] },
    { text: 'Text with one pin.\n', pins: [{ product: 'product-one', hash: hashOfText('product-one text') }] },
    { text: 'Line one\r\nLine two\r\n', pins: [{ product: 'product-one', hash: hashOfText('product-one text') }, { product: 'product-two', hash: hashOfText('product-two text') }] }
  ];

  const base = {
    labels: VECTOR_LABELS,
    roster: { hash: rosterHash, checkpointSigner: a.writer },
    writers: [a, b].map((who, index) => ({ label: index === 0 ? VECTOR_LABELS.writerA : VECTOR_LABELS.writerB, publicKey: who.publicKey, writer: who.writer })),
    epochKeys: [{ label: VECTOR_LABELS.epoch }],
    blobs
  };
  const digests = foldEntries(entries.map((entry) => ({ header: entry.header, body: entry.bodyWire })), vectorContext(base)).digests;

  return {
    note: VECTOR_NOTE,
    labels: base.labels,
    roster: base.roster,
    writers: base.writers,
    epochKeys: base.epochKeys,
    entries,
    blobs,
    checkpoint: { unsigned, orderTips: [{ stream, order, orderTip }], signed, hash: checkpointHash(signed), signerLabel: VECTOR_LABELS.writerA },
    proof: { proof, proofHash: proofHash(proof), secondIvLabel: 'vector iv a1 second' },
    versionHashes: versionRows.map((row) => ({ ...row, hash: replicaVersionHash(row.text, row.pins) })),
    digests
  };
}

/** Dotted paths where two JSON values differ, so a failing comparison names the field. Arrays and objects are walked; leaves are compared by value. */
export function vectorDifferences(expected: unknown, actual: unknown, at = ''): string[] {
  if (typeof expected !== typeof actual || (expected === null) !== (actual === null) || Array.isArray(expected) !== Array.isArray(actual)) return [at || '(root)'];
  if (typeof expected !== 'object' || expected === null) return expected === actual ? [] : [at || '(root)'];
  const left = expected as Record<string, unknown>;
  const right = actual as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const found: string[] = [];
  for (const key of [...keys].sort()) {
    const path = at === '' ? key : `${at}.${key}`;
    if (!(key in left) || !(key in right)) found.push(path);
    else found.push(...vectorDifferences(left[key], right[key], path));
  }
  return found;
}
