// The replica contract as bytes (D-28, D-03, D-31, D-32, D-36, D-37): the committed vectors must equal what the builder makes, every vector entry must
// pass the production reader, and a changed format detail must break the comparison. Phases 31 and 32 and the hub test against the same fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalBytes } from '../domain/team/canonical';
import { openRaw } from '../domain/state/keys';
import { checkpointBases, orderTipOf, readCheckpoint, recomputeCheckpoint, verifyCheckpoint } from '../domain/replica/checkpoint';
import type { CheckpointHead } from '../domain/replica/checkpoint';
import { acceptableProof, proofHash, verifyProof } from '../domain/replica/equivocation';
import { blobAad, entryHash, fromWire, headerAad, openBlob, sha256Hex, verifyHeader } from '../domain/replica/entry';
import type { EntryBody } from '../domain/replica/entry';
import { foldEntries } from '../domain/replica/fold';
import { verifyEntry } from '../domain/replica/verify';
import type { VerifiedEntry } from '../domain/replica/verify';
import { replicaVersionHash } from '../domain/replica/versions';
import { buildVectors, vectorContext, vectorDifferences } from './helpers/replicaVectors';
import type { ReplicaVectors } from './helpers/replicaVectors';
import { epochKey, shuffled, rng, streamId } from './helpers/replicaWorld';

const FIXTURE = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'replica', 'vectors.json');
const committed = (): ReplicaVectors => JSON.parse(readFileSync(FIXTURE, 'utf8')) as ReplicaVectors;
const copy = (): ReplicaVectors => JSON.parse(JSON.stringify(committed())) as ReplicaVectors;

const contextFor = vectorContext;

test('the committed vectors equal what the builder makes, and the builder is deterministic', () => {
  const built = buildVectors();
  assert.deepEqual(vectorDifferences(committed(), built), []);
  assert.deepEqual(built, committed());
  assert.deepEqual(buildVectors(), built);
});

test('every vector entry passes the production reader, and its body opens with the recorded associated data to the recorded plaintext', () => {
  const vectors = committed();
  const ctx = contextFor(vectors);
  assert.ok(vectors.entries.length >= 5);
  const key = epochKey(vectors.epochKeys[0].label);
  for (const vector of vectors.entries) {
    const outcome = verifyEntry({ header: vector.header, body: vector.bodyWire }, ctx);
    assert.equal(outcome.status, 'verified', `${vector.name}: ${JSON.stringify(outcome)}`);
    const { sig, ...unsigned } = vector.header;
    assert.ok(sig.length > 0);
    assert.equal(vector.unsignedHeaderCanonical, canonicalBytes(unsigned).toString('base64url'), `${vector.name}: the signed header bytes`);
    assert.equal(vector.aad, headerAad(vector.header).toString('base64url'), `${vector.name}: the associated data`);
    assert.equal(vector.entryHash, entryHash(vector.header), `${vector.name}: the entry hash`);
    assert.equal(vector.header.body.hash, sha256Hex(Buffer.from(vector.bodyWire, 'base64url')), `${vector.name}: the body hash`);
    const parts = fromWire(Buffer.from(vector.bodyWire, 'base64url'));
    assert.ok(parts !== undefined);
    assert.equal(openRaw(key, parts, Buffer.from(vector.aad, 'base64url')).toString('base64url'), vector.bodyPlaintext, `${vector.name}: the opened body`);
    const writer = vectors.writers.find((candidate) => candidate.writer === vector.header.writer);
    assert.ok(writer !== undefined && verifyHeader(vector.header, writer.publicKey), `${vector.name}: the signature`);
    assert.equal((outcome as { entry: VerifiedEntry }).entry.hash, vector.entryHash);
  }
});

test('the entries chain per writer, one entry is routed to a blob, and the blob opens to its recorded plaintext', () => {
  const vectors = committed();
  const ctx = contextFor(vectors);
  for (const writer of vectors.writers) {
    const own = vectors.entries.filter((entry) => entry.header.writer === writer.writer);
    own.forEach((entry, index) => {
      assert.equal(entry.header.seq, index);
      if (index > 0) assert.equal(entry.header.prev, own[index - 1].entryHash);
    });
  }
  assert.equal(vectors.blobs.length, 1);
  const blob = vectors.blobs[0];
  const stream = streamId(vectors.labels.stream);
  assert.equal(blob.hash, sha256Hex(Buffer.from(blob.bytes, 'base64url')));
  assert.equal(blob.aad, blobAad(stream, 0).toString('base64url'));
  const opened = openBlob(epochKey(vectors.epochKeys[0].label), stream, 0, { hash: blob.hash, bytes: blob.bytes });
  assert.equal(opened?.toString('base64url'), blob.plaintext);
  const routed = vectors.entries.filter((entry) => (JSON.parse(Buffer.from(entry.bodyPlaintext, 'base64url').toString('utf8')) as { blob?: string }).blob === blob.hash);
  assert.equal(routed.length, 1);
  // The reader needs the blob: without it the same entry is held, not rejected.
  const without = verifyEntry({ header: routed[0].header, body: routed[0].bodyWire }, { ...ctx, blobs: () => undefined });
  assert.equal(without.status, 'held');
});

test('the equivocation proof and the checkpoint verify, and the order tip is the chained hash of the listed order', () => {
  const vectors = committed();
  const ctx = contextFor(vectors);
  assert.equal(verifyProof(vectors.proof.proof), true);
  assert.equal(proofHash(vectors.proof.proof), vectors.proof.proofHash);
  assert.equal(acceptableProof(vectors.proof.proof, ctx.roster), true);
  const a1 = vectors.entries.find((entry) => entry.header.writer === vectors.writers[0].writer && entry.header.seq === 1);
  assert.ok(a1 !== undefined);
  assert.ok([vectors.proof.proof.a, vectors.proof.proof.b].some((header) => entryHash(header) === a1.entryHash), 'the proof pairs the recorded A seq 1 with a second header');
  assert.notEqual(entryHash(vectors.proof.proof.a), entryHash(vectors.proof.proof.b));

  const verdict = verifyCheckpoint(vectors.checkpoint.signed, ctx.roster);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.ok && verdict.hash, vectors.checkpoint.hash);
  for (const tip of vectors.checkpoint.orderTips) {
    assert.equal(orderTipOf(tip.order), tip.orderTip);
    const covered = vectors.checkpoint.unsigned.streams.find((stream) => stream.stream === tip.stream);
    assert.equal(covered?.orderTip, tip.orderTip);
    assert.equal(covered?.count, tip.order.length);
  }
  const verified = vectors.entries.map((entry) => (verifyEntry({ header: entry.header, body: entry.bodyWire }, ctx) as { entry: VerifiedEntry }).entry);
  const recomputed = recomputeCheckpoint(vectors.checkpoint.unsigned, verified);
  assert.deepEqual(recomputed, { ok: true, mismatches: [] });
});

test('the version hash rows equal replicaVersionHash, and a CRLF text hashes like its LF form', () => {
  const vectors = committed();
  assert.ok(vectors.versionHashes.length >= 3);
  for (const row of vectors.versionHashes) assert.equal(replicaVersionHash(row.text, row.pins), row.hash);
  const crlf = vectors.versionHashes.find((row) => row.text.includes('\r\n'));
  assert.ok(crlf !== undefined);
  assert.equal(replicaVersionHash(crlf.text.replace(/\r\n/g, '\n'), crlf.pins), crlf.hash);
  assert.equal(new Set(vectors.versionHashes.map((row) => row.hash)).size, vectors.versionHashes.length);
});

test('the digests vector is the digest of each stream when the committed entries are folded with the default reducers, in any delivery order', () => {
  const vectors = committed();
  const ctx = contextFor(vectors);
  const stream = streamId(vectors.labels.stream);
  assert.deepEqual(Object.keys(vectors.digests), [stream]);
  assert.match(vectors.digests[stream], /^[0-9a-f]{64}$/);
  const entries = vectors.entries.map((entry) => ({ header: entry.header, body: entry.bodyWire }));
  const result = foldEntries(entries, ctx);
  assert.deepEqual([result.held, result.rejected, result.refused, result.kept, result.excluded], [[], [], [], [], []]);
  assert.equal(result.applied.length, entries.length);
  assert.deepEqual(result.digests, vectors.digests);
  const random = rng(11);
  for (let round = 0; round < 5; round += 1) assert.deepEqual(foldEntries(shuffled(entries, random), ctx).digests, vectors.digests);
  // The state is pinned, not only the bytes: without the second writer's entries the digest is another one.
  const alone = foldEntries(entries.filter((entry) => entry.header.writer === vectors.writers[0].writer), ctx);
  assert.notEqual(alone.digests[stream], vectors.digests[stream]);
});

test('a changed AAD, signature, entry hash, checkpoint field or version hash is reported by name', () => {
  const flip = (value: string): string => `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
  const cases: Array<[string, (vectors: ReplicaVectors) => void]> = [
    ['entries.1.aad', (vectors) => { vectors.entries[1].aad = flip(vectors.entries[1].aad); }],
    ['entries.0.header.sig', (vectors) => { vectors.entries[0].header.sig = flip(vectors.entries[0].header.sig); }],
    ['entries.2.entryHash', (vectors) => { vectors.entries[2].entryHash = vectors.entries[2].entryHash.replace(/^./, (first) => (first === '0' ? '1' : '0')); }],
    ['checkpoint.unsigned.streams.0.orderTip', (vectors) => { vectors.checkpoint.unsigned.streams[0].orderTip = '1'.repeat(64); }],
    ['versionHashes.0.hash', (vectors) => { vectors.versionHashes[0].hash = '2'.repeat(64); }],
    ['proof.proofHash', (vectors) => { vectors.proof.proofHash = '3'.repeat(64); }],
    [`digests.${streamId('near-ai replica vector stream')}`, (vectors) => { vectors.digests[streamId('near-ai replica vector stream')] = '4'.repeat(64); }]
  ];
  for (const [field, mutate] of cases) {
    const changed = copy();
    mutate(changed);
    assert.deepEqual(vectorDifferences(committed(), changed), [field]);
  }
});

test('a tampered header is rejected by the production reader and named by the comparison', () => {
  const tampered = copy();
  tampered.entries[0].header.seq = 7;
  const outcome = verifyEntry({ header: tampered.entries[0].header, body: tampered.entries[0].bodyWire }, contextFor(tampered));
  assert.notEqual(outcome.status, 'verified');
  assert.deepEqual(vectorDifferences(committed(), tampered), ['entries.0.header.seq']);
});

test('the fixture holds no private key bytes: neither the seeds of the vector keys nor a private key marker', () => {
  const text = readFileSync(FIXTURE, 'utf8');
  assert.equal(/privateKey|BEGIN [A-Z ]*PRIVATE/i.test(text), false);
  const vectors = committed();
  for (const writer of vectors.writers) {
    const seed = createHash('sha256').update(`signer/${writer.label}`, 'utf8').digest();
    assert.equal(text.includes(seed.toString('hex')), false, `${writer.label}: seed as hex`);
    assert.equal(text.includes(seed.toString('base64url')), false, `${writer.label}: seed as base64url`);
    assert.equal(text.includes(seed.toString('base64')), false, `${writer.label}: seed as base64`);
  }
  const key = epochKey(vectors.epochKeys[0].label);
  assert.equal(text.includes(key.toString('hex')) || text.includes(key.toString('base64url')), false, 'the epoch key is not in the fixture, only its label');
});

// ---- Plan 31-08: the checkpointV2 section, and the Phase 30 sections byte for byte ----------------------------------------------------------------

// The SHA-256 of the canonical bytes of every section the fixture held at Phase 30 (c1dba334), taken from the committed file before checkpointV2 was
// added. A test cannot read git history, so the hashes are written here: any change to an old section, however small, fails this test (D-39, P-31-10).
const PHASE_30_SECTIONS: Readonly<Record<string, string>> = {
  note: '38cf49e8d3fcd59aa6889e68b53d3875f7adc47a4973e18bfd36cbeb8591f114',
  labels: 'dd54811d5c1a1c1657f305b0e62a5131eba7552d6def8dd55c893cf0f5fa249b',
  roster: '5858e68caad80b278e21ad4417f36caf55937a895398dfef80c12dcca30e6218',
  writers: 'ddfab3008deeffdda57ad2249a6e3e02f01090c02e0027ad9596843c34f0014e',
  epochKeys: 'e140b63cd0302fbda655da6c600026c51f7dcf65a7e48753fa6c3cc69dc96ccc',
  entries: 'ca658a0e23db4024bf52438da8b0a0ed412950145091e4e37dffb1c97e032641',
  blobs: 'dc2ff6f3f9d0bc18a727df22a2dccd55c52000df1b7aaf52fa99928e603a238d',
  checkpoint: 'fffbcb5c41b1fc1741b9e415869d253ff96a1e6946f648e1e153d953bc630e53',
  proof: '625df223238351766911f1f7ea53cfa9e6106291831fccd5074c3777f8458a9f',
  versionHashes: '6d0370b8c1e267db9c37d6126abe6f8c340900682baf7b6139b705d9b28a0eef',
  digests: '7eb414ffa87dfc50a8b6c9a16b192b186cf885930e4fd5f81d116abfb0b8835e'
};

test('every Phase 30 section of the fixture is byte-identical to Phase 30, and checkpointV2 is the only key added since', () => {
  const vectors = committed() as unknown as Record<string, unknown>;
  for (const [section, hash] of Object.entries(PHASE_30_SECTIONS)) {
    assert.equal(createHash('sha256').update(canonicalBytes(vectors[section])).digest('hex'), hash, section);
  }
  assert.deepEqual(Object.keys(vectors).filter((key) => !(key in PHASE_30_SECTIONS)), ['checkpointV2']);
  // The version 1 checkpoint still verifies, and its heads are still plain deps.
  assert.equal(committed().checkpoint.unsigned.v, 1);
  assert.equal(verifyCheckpoint(committed().checkpoint.signed, contextFor(committed()).roster).ok, true);
  for (const head of committed().checkpoint.unsigned.streams[0].heads) assert.deepEqual(Object.keys(head).sort(), ['hash', 'seq', 'writer']);
});

test('the checkpointV2 section verifies, covers the same entries as the version 1 checkpoint, and its heads name each writer\'s last entry with lamport and roster', () => {
  const vectors = committed();
  const ctx = contextFor(vectors);
  const v2 = vectors.checkpointV2;
  assert.equal(v2.unsigned.v, 2);
  assert.deepEqual(readCheckpoint(v2.signed.payload), v2.unsigned);
  const verdict = verifyCheckpoint(v2.signed, ctx.roster);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.ok && verdict.hash, v2.hash);
  assert.notEqual(v2.hash, vectors.checkpoint.hash);
  assert.notEqual(v2.signed.sig, vectors.checkpoint.signed.sig);
  for (const tip of v2.orderTips) {
    assert.equal(orderTipOf(tip.order), tip.orderTip);
    const covered = v2.unsigned.streams.find((stream) => stream.stream === tip.stream);
    assert.deepEqual([covered?.orderTip, covered?.count], [tip.orderTip, tip.order.length]);
  }
  // Same count and order tip as version 1; the heads differ only by the two added fields.
  assert.deepEqual(v2.orderTips, vectors.checkpoint.orderTips);
  const heads = v2.unsigned.streams[0].heads as CheckpointHead[];
  assert.deepEqual(heads.map(({ writer, seq, hash }) => ({ writer, seq, hash })), vectors.checkpoint.unsigned.streams[0].heads);
  for (const head of heads) {
    const own = vectors.entries.filter((entry) => entry.header.writer === head.writer);
    const last = own[own.length - 1];
    const body = JSON.parse(Buffer.from(last.bodyPlaintext, 'base64url').toString('utf8')) as EntryBody;
    assert.deepEqual(head, { writer: last.header.writer, seq: last.header.seq, hash: last.entryHash, lamport: body.lamport, roster: vectors.roster.hash });
  }
  const verified = vectors.entries.map((entry) => (verifyEntry({ header: entry.header, body: entry.bodyWire }, ctx) as { entry: VerifiedEntry }).entry);
  assert.deepEqual(recomputeCheckpoint(v2.unsigned, verified), { ok: true, mismatches: [] });
  assert.equal(checkpointBases([v2.signed]).size, heads.length);
  assert.equal(checkpointBases([vectors.checkpoint.signed]).size, 0);
  // With the version 2 checkpoint the vector entries fold to the same digests as with no checkpoint (nothing is concurrent across the prefix).
  const sealedEntries = vectors.entries.map((entry) => ({ header: entry.header, body: entry.bodyWire }));
  assert.deepEqual(foldEntries(sealedEntries, ctx, { checkpoints: [v2.signed] }).digests, vectors.digests);
});

test('a changed lamport or roster in a checkpointV2 head is reported by name and no longer verifies', () => {
  const cases: Array<[string, (vectors: ReplicaVectors) => void]> = [
    ['checkpointV2.signed.payload.streams.0.heads.0.lamport', (vectors) => { (vectors.checkpointV2.signed.payload.streams[0].heads[0] as CheckpointHead).lamport += 1; }],
    ['checkpointV2.signed.payload.streams.0.heads.1.roster', (vectors) => { (vectors.checkpointV2.signed.payload.streams[0].heads[1] as CheckpointHead).roster = '5'.repeat(64); }],
    ['checkpointV2.unsigned.streams.0.heads.0.lamport', (vectors) => { (vectors.checkpointV2.unsigned.streams[0].heads[0] as CheckpointHead).lamport += 1; }],
    ['checkpointV2.unsigned.streams.0.heads.1.roster', (vectors) => { (vectors.checkpointV2.unsigned.streams[0].heads[1] as CheckpointHead).roster = '6'.repeat(64); }]
  ];
  for (const [field, mutate] of cases) {
    const changed = copy();
    mutate(changed);
    assert.deepEqual(vectorDifferences(committed(), changed), [field]);
    if (field.includes('.signed.')) assert.equal(verifyCheckpoint(changed.checkpointV2.signed, contextFor(changed).roster).ok, false, field);
  }
});
