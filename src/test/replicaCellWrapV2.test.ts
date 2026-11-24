// cell-wrap/v2 (33.2-01; 33.2-CONTEXT D-02, D-05, D-08): the hybrid P-256 + ML-KEM-768 wrap of one cell epoch key to one device, its binding to the
// cell, the epoch, the device and both recipient keys, the frozen vectors, the one entry point every wrap path calls, and the start-up probe.
// The runtime primitives are checked first against the published vectors (FIPS 203 through NIST ACVP, RFC 5903, RFC 5869), so a runtime that
// computes them differently fails here and not in a project.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { unwrapEpochKey, wrapEpochKey, x25519PrivateFromSeed, x25519PublicRaw, WRAP_BYTES } from '../domain/replica/cellKeys';
import {
  deriveWrapV2Key,
  kemPrivateFromSeeds,
  kemPublicFromSeeds,
  newKemSeeds,
  probeWrapV2,
  unwrapEpochKeyV2,
  wrapEpochKeyV2,
  wrapForDevice,
  wrapFormatOf,
  wrapV2Info,
  WRAP_V2_BYTES,
  WRAP_V2_REFUSALS
} from '../domain/replica/cellWrapV2';
import type { KemSeeds } from '../domain/replica/cellWrapV2';
import { streamId } from './helpers/replicaWorld';

const FIXTURE = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'replica', 'cell-wrap-v2', 'vectors.json');
const vectors = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  fips203: { keyGen: { d: string; z: string; ek: string }; decapsulation: Array<{ tcId: number; reason: string; dk: string; c: string; k: string }> };
  rfc5903: { i: string; gi: string; gr: string; girx: string };
  rfc5869: { ikm: string; salt: string; info: string; okm: string };
  kdf: { zEc: string; zPq: string; ephemeral: string; ciphertext: string; infoHex: string; key: string };
  wrap: { recipient: { p256Scalar: string; mlkemSeed: string; p256: string; mlkem768: string }; cell: string; epoch: number; writer: string; epochKey: string; infoHex: string; zEc: string; zPq: string; key: string; wrap: string };
};

const nodeCrypto = require('node:crypto') as Record<string, unknown>;
const hex = (value: string): Buffer => Buffer.from(value, 'hex');
const b64 = (value: string): Buffer => Buffer.from(value, 'base64url');
const writerOf = (label: string): string => createHash('sha256').update(`writer/${label}`).digest('hex');
// decapsulate is not in the @types/node this repo pins; the module has it on every runtime 33.2-RESEARCH.md section 1 lists.
const decapsulate = nodeCrypto.decapsulate as (key: KeyObject, ciphertext: Buffer) => Buffer;

// Fictional cell, epoch, device and epoch key.
const CELL_C = streamId('cell-c');
const CELL_D = streamId('cell-d');
const DEVICE_W = writerOf('device-w');
const DEVICE_V = writerOf('device-v');
const EPOCH_KEY = createHash('sha256').update('fictional epoch key 3').digest();

interface Device { seeds: KemSeeds; keys: ReturnType<typeof kemPublicFromSeeds>; privateKeys: ReturnType<typeof kemPrivateFromSeeds> }
function device(seeds: KemSeeds = newKemSeeds()): Device {
  return { seeds, keys: kemPublicFromSeeds(seeds), privateKeys: kemPrivateFromSeeds(seeds) };
}
const W = device();
const wrapToW = (overrides: Partial<{ cell: string; epoch: number; writer: string }> = {}): string =>
  wrapEpochKeyV2({ cell: overrides.cell ?? CELL_C, epoch: overrides.epoch ?? 3, writer: overrides.writer ?? DEVICE_W, recipient: W.keys, epochKey: EPOCH_KEY });
const openAsW = (wrap: string, overrides: Partial<{ cell: string; epoch: number; writer: string }> = {}): Buffer | undefined =>
  unwrapEpochKeyV2({ cell: overrides.cell ?? CELL_C, epoch: overrides.epoch ?? 3, writer: overrides.writer ?? DEVICE_W, privateKeys: W.privateKeys, wrap });

// ---- the runtime, against the published vectors ----

test('FIPS 203 keyGen (NIST ACVP ML-KEM-768): the 64-byte seed d||z, imported in the PKCS#8 seed form, gives the recorded encapsulation key', () => {
  const { d, z, ek } = vectors.fips203.keyGen;
  const keys = kemPublicFromSeeds({ p256: hex(vectors.rfc5903.i), mlkem768: Buffer.concat([hex(d), hex(z)]) });
  assert.equal(b64(keys.mlkem768).toString('hex'), ek);
});

test('FIPS 203 decapsulation (NIST ACVP ML-KEM-768): a valid ciphertext and a modified one (implicit rejection) both give the recorded secret', () => {
  // ACVP publishes the expanded 2,400-byte key, not the seed, so this test imports the PKCS#8 expandedKey form. Product code never does: BoringSSL
  // in VS Code's Electron accepts only the seed form (33.2-RESEARCH.md section 2).
  const expandedPrefix = hex('30820978020100300b06096086480165030404020482096404820960');
  assert.deepEqual(vectors.fips203.decapsulation.map((item) => item.reason), ['valid decapsulation', 'modified ciphertext']);
  for (const item of vectors.fips203.decapsulation) {
    const key = createPrivateKey({ key: Buffer.concat([expandedPrefix, hex(item.dk)]), format: 'der', type: 'pkcs8' });
    assert.equal(Buffer.from(decapsulate(key, hex(item.c))).toString('hex'), item.k, `tcId ${item.tcId}`);
  }
});

test('RFC 5903 section 8.1: P-256 from the 32-byte scalar i gives g^i, and ECDH with g^r gives the recorded x-coordinate', () => {
  const { i, gi, gr, girx } = vectors.rfc5903;
  const keys = kemPublicFromSeeds({ p256: hex(i), mlkem768: Buffer.alloc(64, 7) });
  assert.equal(b64(keys.p256).toString('hex'), gi);
  const peer = createPublicKey({ key: Buffer.concat([hex('3059301306072a8648ce3d020106082a8648ce3d030107034200'), hex(gr)]), format: 'der', type: 'spki' });
  const privateKeys = kemPrivateFromSeeds({ p256: hex(i), mlkem768: Buffer.alloc(64, 7) });
  assert.equal(diffieHellman({ privateKey: privateKeys.p256, publicKey: peer }).toString('hex'), girx);
});

test('RFC 5869 appendix A.1: HKDF-SHA256 gives the recorded output', () => {
  const { ikm, salt, info, okm } = vectors.rfc5869;
  assert.equal(Buffer.from(hkdfSync('sha256', hex(ikm), hex(salt), hex(info), okm.length / 2)).toString('hex'), okm);
});

// ---- the wrap ----

test('a v2 wrap to device W for cell c, epoch 3 is exactly 1,214 bytes starting with version byte 2, and W opens it', () => {
  const wrap = wrapToW();
  assert.equal(WRAP_V2_BYTES, 1214);
  const wire = b64(wrap);
  assert.equal(wire.length, WRAP_V2_BYTES);
  assert.equal(wire[0], 2);
  assert.equal(wire.toString('base64url'), wrap);
  assert.deepEqual(openAsW(wrap), EPOCH_KEY);
  assert.notEqual(wrapToW(), wrap, 'each wrap uses a fresh ephemeral key, ciphertext and iv');
});

test('the wrap is bound: another cell, epoch or device writer does not open it', () => {
  const wrap = wrapToW();
  assert.equal(openAsW(wrap, { cell: CELL_D }), undefined);
  assert.equal(openAsW(wrap, { epoch: 4 }), undefined);
  assert.equal(openAsW(wrap, { writer: DEVICE_V }), undefined);
});

test('another recipient does not open it, and neither half of W\'s keys alone does (T-33.2-01)', () => {
  const wrap = wrapToW();
  const other = device();
  assert.equal(unwrapEpochKeyV2({ cell: CELL_C, epoch: 3, writer: DEVICE_W, privateKeys: other.privateKeys, wrap }), undefined);
  const sameKemOtherCurve = kemPrivateFromSeeds({ p256: other.seeds.p256, mlkem768: W.seeds.mlkem768 });
  const sameCurveOtherKem = kemPrivateFromSeeds({ p256: W.seeds.p256, mlkem768: other.seeds.mlkem768 });
  assert.equal(unwrapEpochKeyV2({ cell: CELL_C, epoch: 3, writer: DEVICE_W, privateKeys: sameKemOtherCurve, wrap }), undefined);
  assert.equal(unwrapEpochKeyV2({ cell: CELL_C, epoch: 3, writer: DEVICE_W, privateKeys: sameCurveOtherKem, wrap }), undefined);
});

test('one changed byte in any field (version, ephemeral key, ML-KEM ciphertext, iv, tag, sealed key) fails, and nothing throws', () => {
  const wire = b64(wrapToW());
  // Field starts, middles and ends of the layout: 0 | 1..65 | 66..1153 | 1154..1165 | 1166..1181 | 1182..1213.
  const positions = [0, 1, 33, 65, 66, 600, 1153, 1154, 1160, 1165, 1166, 1173, 1181, 1182, 1197, 1213];
  for (const position of positions) {
    const changed = Buffer.from(wire);
    changed[position] ^= 0x01;
    assert.equal(openAsW(changed.toString('base64url')), undefined, `byte ${position}`);
  }
  assert.equal(openAsW(wire.subarray(0, WRAP_V2_BYTES - 1).toString('base64url')), undefined, 'one byte short');
  assert.equal(openAsW(`${wire.toString('base64url')}A`), undefined, 'not strict base64url');
});

test('wrapFormatOf tells v1 from v2, refuses version 3 and later as not supported yet, and anything else as malformed (D-08)', () => {
  const v1Recipient = x25519PublicRaw(x25519PrivateFromSeed(Buffer.alloc(32, 9)));
  const v1 = wrapEpochKey({ cell: CELL_C, epoch: 3, writer: DEVICE_W, recipient: v1Recipient, epochKey: EPOCH_KEY });
  assert.deepEqual(wrapFormatOf(v1), { ok: true, format: 1 });
  const v2 = wrapToW();
  assert.deepEqual(wrapFormatOf(v2), { ok: true, format: 2 });
  const v3 = Buffer.from(b64(v2));
  v3[0] = 3;
  assert.deepEqual(wrapFormatOf(v3.toString('base64url')), { ok: false, reason: 'not-supported-yet' });
  assert.equal(openAsW(v3.toString('base64url')), undefined);
  assert.equal(WRAP_V2_REFUSALS['not-supported-yet'].length > 0, true);
  const versionOne = Buffer.from(b64(v2));
  versionOne[0] = 1;
  assert.deepEqual(wrapFormatOf(versionOne.toString('base64url')), { ok: false, reason: 'malformed' });
  assert.deepEqual(wrapFormatOf(''), { ok: false, reason: 'malformed' });
  assert.deepEqual(wrapFormatOf('not base64url!'), { ok: false, reason: 'malformed' });
});

test('recipient keys are checked before any wrap: a wrong length, a compressed or off-curve point, or a P-256 scalar of 0 or n is refused', () => {
  const p256 = b64(W.keys.p256);
  const compressed = Buffer.from(p256);
  compressed[0] = 2;
  const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]);
  const wrapTo = (recipient: { p256: Buffer | string; mlkem768: Buffer | string }) => () =>
    wrapEpochKeyV2({ cell: CELL_C, epoch: 3, writer: DEVICE_W, recipient, epochKey: EPOCH_KEY });
  assert.throws(wrapTo({ p256: compressed, mlkem768: W.keys.mlkem768 }));
  assert.throws(wrapTo({ p256: offCurve, mlkem768: W.keys.mlkem768 }));
  assert.throws(wrapTo({ p256: p256.subarray(1), mlkem768: W.keys.mlkem768 }));
  assert.throws(wrapTo({ p256: W.keys.p256, mlkem768: b64(W.keys.mlkem768).subarray(1) }));
  assert.throws(() => wrapEpochKeyV2({ cell: CELL_C, epoch: 3, writer: DEVICE_W, recipient: W.keys, epochKey: EPOCH_KEY.subarray(1) }));
  // OpenSSL imports both of these scalars without complaint (33.2-RESEARCH.md section 3), so the range check is ours.
  const order = hex('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  assert.throws(() => kemPrivateFromSeeds({ p256: Buffer.alloc(32), mlkem768: W.seeds.mlkem768 }));
  assert.throws(() => kemPrivateFromSeeds({ p256: order, mlkem768: W.seeds.mlkem768 }));
  assert.throws(() => kemPrivateFromSeeds({ p256: W.seeds.p256, mlkem768: W.seeds.mlkem768.subarray(1) }));
});

// ---- the frozen vectors ----

test('frozen wrap vector: the recorded recipient seeds open the recorded wrap to the recorded epoch key, step by step', () => {
  const v = vectors.wrap;
  const seeds = { p256: b64(v.recipient.p256Scalar), mlkem768: b64(v.recipient.mlkemSeed) };
  assert.deepEqual(kemPublicFromSeeds(seeds), { p256: v.recipient.p256, mlkem768: v.recipient.mlkem768 });
  const privateKeys = kemPrivateFromSeeds(seeds);
  const info = wrapV2Info(v.cell, v.epoch, v.writer, { p256: v.recipient.p256, mlkem768: v.recipient.mlkem768 });
  assert.equal(info.toString('hex'), v.infoHex);
  const wire = b64(v.wrap);
  const ephemeral = wire.subarray(1, 66);
  const ciphertext = wire.subarray(66, 1154);
  const ephemeralKey = createPublicKey({ key: Buffer.concat([hex('3059301306072a8648ce3d020106082a8648ce3d030107034200'), ephemeral]), format: 'der', type: 'spki' });
  assert.equal(diffieHellman({ privateKey: privateKeys.p256, publicKey: ephemeralKey }).toString('base64url'), v.zEc);
  assert.equal(Buffer.from(decapsulate(privateKeys.mlkem768, ciphertext)).toString('base64url'), v.zPq);
  assert.equal(deriveWrapV2Key({ zEc: b64(v.zEc), zPq: b64(v.zPq), ephemeral, ciphertext, info }).toString('base64url'), v.key);
  assert.equal(unwrapEpochKeyV2({ cell: v.cell, epoch: v.epoch, writer: v.writer, privateKeys, wrap: v.wrap })?.toString('base64url'), v.epochKey);
});

test('frozen KDF vector: fixed Z_ec and Z_pq (classical first), ephemeral key, ciphertext and info give the recorded 32 bytes', () => {
  const k = vectors.kdf;
  const input = { zEc: b64(k.zEc), zPq: b64(k.zPq), ephemeral: b64(k.ephemeral), ciphertext: b64(k.ciphertext), info: hex(k.infoHex) };
  assert.equal(deriveWrapV2Key(input).toString('base64url'), k.key);
  // The order is part of the format: swapping the two secrets gives another key.
  assert.notEqual(deriveWrapV2Key({ ...input, zEc: input.zPq, zPq: input.zEc }).toString('base64url'), k.key);
});

// ---- the one entry point ----

test('wrapForDevice: format 1 writes a v1 wrap that unwrapEpochKey opens, even when the device also has v2 keys', () => {
  const x25519 = x25519PrivateFromSeed(Buffer.alloc(32, 5));
  const result = wrapForDevice({ format: 1, cell: CELL_C, epoch: 3, writer: DEVICE_W, epochKey: EPOCH_KEY, recipient: { x25519: x25519PublicRaw(x25519), kem: W.keys } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.format, 1);
  assert.equal(b64(result.wrap).length, WRAP_BYTES);
  assert.deepEqual(unwrapEpochKey({ cell: CELL_C, epoch: 3, writer: DEVICE_W, privateKey: x25519, wrap: result.wrap }), EPOCH_KEY);
});

test('wrapForDevice: format 2 writes a v2 wrap; without v2 keys it refuses with no-v2-keys and never falls back to v1 (T-33.2-03)', () => {
  const x25519 = x25519PublicRaw(x25519PrivateFromSeed(Buffer.alloc(32, 5)));
  const v2 = wrapForDevice({ format: 2, cell: CELL_C, epoch: 3, writer: DEVICE_W, epochKey: EPOCH_KEY, recipient: { x25519, kem: W.keys } });
  assert.equal(v2.ok && v2.format, 2);
  if (v2.ok) assert.deepEqual(openAsW(v2.wrap), EPOCH_KEY);
  assert.deepEqual(wrapForDevice({ format: 2, cell: CELL_C, epoch: 3, writer: DEVICE_W, epochKey: EPOCH_KEY, recipient: { x25519 } }), { ok: false, reason: 'no-v2-keys' });
  assert.deepEqual(wrapForDevice({ format: 1, cell: CELL_C, epoch: 3, writer: DEVICE_W, epochKey: EPOCH_KEY, recipient: { kem: W.keys } }), { ok: false, reason: 'no-v1-key' });
  for (const reason of ['no-v2-keys', 'no-v1-key', 'v2-unavailable'] as const) assert.ok(WRAP_V2_REFUSALS[reason].length > 0);
});

// ---- the probe ----

test('probeWrapV2 is true on this Node, and false (no throw) when crypto.encapsulate is missing; wrapForDevice then refuses format 2', () => {
  assert.equal(probeWrapV2(), true);
  const saved = nodeCrypto.encapsulate;
  try {
    nodeCrypto.encapsulate = undefined;
    assert.equal(probeWrapV2(), false);
    assert.deepEqual(wrapForDevice({ format: 2, cell: CELL_C, epoch: 3, writer: DEVICE_W, epochKey: EPOCH_KEY, recipient: { kem: W.keys } }), { ok: false, reason: 'v2-unavailable' });
  } finally {
    nodeCrypto.encapsulate = saved;
  }
  assert.equal(probeWrapV2(), true);
});
