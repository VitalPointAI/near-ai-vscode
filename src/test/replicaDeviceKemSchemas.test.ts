// The device family's kind and the descriptor's kem (33.2-02 Task 1; 33.2-CONTEXT D-03, D-12): device.kem { device, p256, mlkem768, sig } with exact
// keys and byte lengths, and the optional kem { p256, mlkem768, sig } in a device descriptor. Shapes only: whether the binding holds is deviceKem.ts's
// question at fold time. Fictional keys from fixed seeds.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { kemPublicFromSeeds } from '../domain/replica/cellWrapV2';
import { REPLICA_KINDS, kindFamily, validateData } from '../domain/replica/kinds';
import { deviceProblem } from '../domain/replica/kindSchemas/project';
import { baseCellAllows } from '../domain/replica/productCells';
import { isPersonKeyKind } from '../domain/replica/sessionKeys';
import { rosterDevice } from './helpers/replicaRosterWorld';

const KEYS = kemPublicFromSeeds({ p256: createHash('sha256').update('kem schema p256').digest(), mlkem768: createHash('sha512').update('kem schema mlkem').digest() });
const SIG = Buffer.alloc(64, 3).toString('base64url');
const DEVICE = rosterDevice('KEM-SCHEMA-LAPTOP', 'mbr-kem');
const valid = { device: DEVICE.writer, p256: KEYS.p256, mlkem768: KEYS.mlkem768, sig: SIG };
const bytes = (value: string): Buffer => Buffer.from(value, 'base64url');
const check = (data: unknown): string | undefined => {
  const result = validateData('device.kem', data);
  return result.ok ? undefined : result.reason;
};

test('device.kem is the one kind of the device family, kept in the base cell and signed only by a person key', () => {
  assert.equal(kindFamily('device.kem'), 'device');
  assert.equal(REPLICA_KINDS.filter((kind) => kindFamily(kind) === 'device').length, 1);
  assert.equal(baseCellAllows('device.kem'), true);
  assert.equal(isPersonKeyKind('device.kem'), true);
});

test('a device.kem with a 64-hex device, a 65-byte uncompressed P-256 key, a 1,184-byte ML-KEM key and a 64-byte sig is valid', () => {
  assert.equal(check(valid), undefined);
});

test('device.kem: a device that is not 64 lowercase hex is refused', () => {
  assert.match(check({ ...valid, device: DEVICE.writer.toUpperCase() }) ?? '', /data\.device/);
  assert.match(check({ ...valid, device: DEVICE.writer.slice(1) }) ?? '', /data\.device/);
});

test('device.kem: a P-256 key one byte short, one byte long or compressed is refused', () => {
  const p256 = bytes(KEYS.p256);
  assert.match(check({ ...valid, p256: p256.subarray(1).toString('base64url') }) ?? '', /data\.p256/);
  assert.match(check({ ...valid, p256: Buffer.concat([p256, Buffer.from([1])]).toString('base64url') }) ?? '', /data\.p256/);
  const compressed = Buffer.from(p256);
  compressed[0] = 2;
  assert.match(check({ ...valid, p256: compressed.toString('base64url') }) ?? '', /data\.p256/);
});

test('device.kem: an ML-KEM key of the wrong length is refused', () => {
  assert.match(check({ ...valid, mlkem768: bytes(KEYS.mlkem768).subarray(1).toString('base64url') }) ?? '', /data\.mlkem768/);
  assert.match(check({ ...valid, mlkem768: Buffer.alloc(1568, 1).toString('base64url') }) ?? '', /data\.mlkem768/);
});

test('device.kem: a sig that is not 64 bytes is refused', () => {
  assert.match(check({ ...valid, sig: Buffer.alloc(63).toString('base64url') }) ?? '', /data\.sig/);
});

test('device.kem: a missing field or an extra field is refused', () => {
  const { sig: _dropped, ...missing } = valid;
  assert.match(check(missing) ?? '', /data\.sig/);
  assert.match(check({ ...valid, slot: 2 }) ?? '', /data\.slot/);
  assert.notEqual(check('not an object'), undefined);
});

test('a device descriptor may carry kem { p256, mlkem768, sig } and is valid without it exactly as today', () => {
  const descriptor = DEVICE.descriptor(2);
  assert.equal(deviceProblem(descriptor, 'd'), undefined);
  assert.equal(deviceProblem({ ...descriptor, kem: { p256: KEYS.p256, mlkem768: KEYS.mlkem768, sig: SIG } }, 'd'), undefined);
});

test('a descriptor kem with a field missing, an extra field or a wrong length is refused', () => {
  const descriptor = DEVICE.descriptor(2);
  assert.match(deviceProblem({ ...descriptor, kem: { p256: KEYS.p256, mlkem768: KEYS.mlkem768 } }, 'd') ?? '', /d\.kem\.sig/);
  assert.match(deviceProblem({ ...descriptor, kem: { p256: KEYS.p256, mlkem768: KEYS.mlkem768, sig: SIG, device: DEVICE.writer } }, 'd') ?? '', /d\.kem\.device/);
  assert.match(deviceProblem({ ...descriptor, kem: { p256: KEYS.mlkem768, mlkem768: KEYS.mlkem768, sig: SIG } }, 'd') ?? '', /d\.kem\.p256/);
  assert.match(deviceProblem({ ...descriptor, kem: 'keys' }, 'd') ?? '', /d\.kem/);
});
