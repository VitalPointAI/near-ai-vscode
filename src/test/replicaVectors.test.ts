// The replica contract as bytes (D-28, D-03, D-31, D-32, D-36, D-37): the committed vectors must equal what the builder makes, every vector entry must
// pass the production reader, and a changed format detail must break the comparison. Phases 31 and 32 and the hub test against the same fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalBytes } from '../domain/team/canonical';
import { openRaw } from '../domain/state/keys';
import { orderTipOf, recomputeCheckpoint, verifyCheckpoint } from '../domain/replica/checkpoint';
import { acceptableProof, proofHash, verifyProof } from '../domain/replica/equivocation';
import { blobAad, entryHash, fromWire, headerAad, openBlob, sha256Hex, verifyHeader } from '../domain/replica/entry';
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
