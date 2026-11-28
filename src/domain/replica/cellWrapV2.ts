// cell-wrap/v2: a cell epoch key wrapped to one device with a hybrid of P-256 ECDH and ML-KEM-768 (33.2-CONTEXT D-02, D-05, D-08; data-centric
// access research 10.4). Both are listed in CCCS ITSP.40.111 v5 for Unclassified, Protected A and Protected B, so a future quantum computer that
// breaks P-256 still has to break ML-KEM, and a flaw in ML-KEM still leaves P-256.
// Hub-side and pure: node:crypto and src/domain only, no clock, no I/O. Private keys come in as KeyObjects or as seeds the host keeps; nothing here
// stores, logs or returns a key, a seed, a shared secret or an opened epoch key other than to its caller (D-11).
//
// Recipient keys: a P-256 public key (65 bytes, uncompressed) and an ML-KEM-768 encapsulation key (1,184 bytes). Private parts: the 32-byte P-256
// scalar and the 64-byte ML-KEM seed (d then z). Only the seed form is used because BoringSSL in VS Code's Electron imports no other (33.2-RESEARCH 2).
//
// Wrap:
// 1. a fresh ephemeral P-256 key; Z_ec = ECDH with the recipient's P-256 key (the 32-byte x-coordinate);
// 2. (Z_pq, ct_pq) = ML-KEM-768 encapsulation to the recipient's key;
// 3. HKDF-SHA256 (the SP 800-56C two-step KDF) with IKM = Z_ec || Z_pq (the classical, listed secret first, as RFC 10024's SecP256r1MLKEM768),
//    salt = SHA-256(eph_pub || ct_pq), info = CELL_WRAP_V2_INFO NUL cell NUL epoch NUL device writer NUL hex SHA-256(recipient P-256 || ML-KEM key),
//    giving 32 bytes;
// 4. AES-256-GCM over the 32-byte epoch key with the info as associated data.
// Wire: version 2 (1) | eph_pub (65) | ct_pq (1,088) | iv (12) | tag (16) | ciphertext (32) = 1,214 bytes, as base64url. The salt binds both
// ciphertexts and the info binds both recipient keys, the cell, the epoch and the device, so a wrap copied anywhere else fails authentication.
//
// Versions: a v1 wrap (cellKeys.ts) has no version byte and is recognised by its 92-byte length; every later version starts with its version byte
// and is never 92 bytes long. Version 3 is reserved for ML-KEM-1024 + P-384 (feature wrap@3); 3 and above are "not supported yet" here.
import * as nodeCrypto from 'node:crypto';
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { isStrictBase64url } from '../team/canonical';
import { isSafeIntegerInRange } from '../team/validate';
import { EPOCH_KEY_BYTES, WRAP_BYTES, unwrapEpochKey, wrapEpochKey } from './cellKeys';
import { HASH_PATTERN, STREAM_ID_PATTERN } from './entry';

export const CELL_WRAP_V2_INFO = 'near-ai/cell-wrap/v2';
export const WRAP_VERSION_V2 = 2;
// ML-KEM-1024 + P-384 for Protected C and classified edges, pending the Cyber Centre's advice (D-08). Readers refuse it as not supported yet.
export const WRAP_VERSION_RESERVED = 3;
export const P256_PUBLIC_BYTES = 65;
export const P256_SCALAR_BYTES = 32;
export const MLKEM768_PUBLIC_BYTES = 1184;
export const MLKEM768_CIPHERTEXT_BYTES = 1088;
export const MLKEM_SEED_BYTES = 64;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const WRAP_V2_BYTES = 1 + P256_PUBLIC_BYTES + MLKEM768_CIPHERTEXT_BYTES + IV_BYTES + TAG_BYTES + EPOCH_KEY_BYTES;

// Fixed DER around the raw keys (33.2-RESEARCH 2 and 3): SubjectPublicKeyInfo for each public key, PKCS#8 for each private part. The P-256 PKCS#8
// leaves out the optional public key, so the import computes it from the scalar.
const SPKI_P256_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const PKCS8_P256_PREFIX = Buffer.from('3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex');
const SPKI_MLKEM768_PREFIX = Buffer.from('308204b2300b0609608648016503040402038204a100', 'hex');
const PKCS8_MLKEM768_SEED_PREFIX = Buffer.from('3054020100300b060960864801650304040204428040', 'hex');
// The order n of P-256. OpenSSL imports a scalar of 0 or n without complaint, so the range 1 <= scalar < n is checked here.
const P256_ORDER = Buffer.from('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551', 'hex');

// The ML-KEM calls. The @types/node this repo pins does not declare them yet, and a runtime may lack them: kemApi() is undefined then.
interface KemApi {
  encapsulate(key: KeyObject): { sharedKey: Buffer; ciphertext: Buffer };
  decapsulate(key: KeyObject, ciphertext: Buffer): Buffer;
}
function kemApi(): KemApi | undefined {
  const api = nodeCrypto as unknown as Partial<KemApi>;
  return typeof api.encapsulate === 'function' && typeof api.decapsulate === 'function' ? (api as KemApi) : undefined;
}

// A device's v2 public keys, as published in device.kem and the descriptor's kem (base64url).
export interface KemPublicKeys { p256: string; mlkem768: string }
// The private parts the host keeps (keyring, Transit envelope or hub key file): the P-256 scalar and the ML-KEM-768 seed.
export interface KemSeeds { p256: Buffer; mlkem768: Buffer }
export interface KemPrivateKeys { p256: KeyObject; mlkem768: KeyObject }
type RawKeys = { p256: Buffer | string; mlkem768: Buffer | string };

function rawOf(value: Buffer | string, bytes: number, name: string): Buffer {
  if (typeof value === 'string' && !isStrictBase64url(value, bytes)) throw new Error(`${name} must be ${bytes} bytes written as base64url.`);
  const raw = typeof value === 'string' ? Buffer.from(value, 'base64url') : value;
  if (raw.length !== bytes) throw new Error(`${name} must be ${bytes} bytes.`);
  return raw;
}

// Throws on a key that is not an uncompressed point on P-256.
function importP256Public(raw: Buffer): KeyObject {
  if (raw[0] !== 0x04) throw new Error('A P-256 public key must be an uncompressed point.');
  return createPublicKey({ key: Buffer.concat([SPKI_P256_PREFIX, raw]), format: 'der', type: 'spki' });
}

// Throws on a key that fails the FIPS 203 encapsulation key check (the import does it).
function importMlKem768Public(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_MLKEM768_PREFIX, raw]), format: 'der', type: 'spki' });
}

function checkedRecipient(recipient: RawKeys): { p256: Buffer; mlkem768: Buffer; p256Key: KeyObject; mlkemKey: KeyObject } {
  const p256 = rawOf(recipient.p256, P256_PUBLIC_BYTES, 'A P-256 public key');
  const mlkem768 = rawOf(recipient.mlkem768, MLKEM768_PUBLIC_BYTES, 'An ML-KEM-768 public key');
  return { p256, mlkem768, p256Key: importP256Public(p256), mlkemKey: importMlKem768Public(mlkem768) };
}

// True when both public keys are well formed: an uncompressed point on P-256 and an ML-KEM-768 key that passes the FIPS 203 check. Never throws.
export function kemPublicKeysValid(keys: RawKeys): boolean {
  try {
    checkedRecipient(keys);
    return true;
  } catch {
    // A key that does not import is not a key anyone can wrap to.
    return false;
  }
}

// The two private keys from the seeds the host keeps. Throws on a scalar outside 1..n-1 or a seed of the wrong size.
export function kemPrivateFromSeeds(seeds: KemSeeds): KemPrivateKeys {
  if (seeds.p256.length !== P256_SCALAR_BYTES) throw new Error('A P-256 private scalar must be 32 bytes.');
  if (seeds.p256.every((byte) => byte === 0) || Buffer.compare(seeds.p256, P256_ORDER) >= 0) throw new Error('A P-256 private scalar must be from 1 to n - 1.');
  if (seeds.mlkem768.length !== MLKEM_SEED_BYTES) throw new Error('An ML-KEM-768 seed must be 64 bytes.');
  return {
    p256: createPrivateKey({ key: Buffer.concat([PKCS8_P256_PREFIX, seeds.p256]), format: 'der', type: 'pkcs8' }),
    mlkem768: createPrivateKey({ key: Buffer.concat([PKCS8_MLKEM768_SEED_PREFIX, seeds.mlkem768]), format: 'der', type: 'pkcs8' })
  };
}

function publicRaw(key: KeyObject, prefix: Buffer): Buffer {
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' });
  if (!der.subarray(0, prefix.length).equals(prefix)) throw new Error('The key is not of the expected type.');
  return Buffer.from(der.subarray(prefix.length));
}

function publicRawOf(keys: KemPrivateKeys): { p256: Buffer; mlkem768: Buffer } {
  return { p256: publicRaw(keys.p256, SPKI_P256_PREFIX), mlkem768: publicRaw(keys.mlkem768, SPKI_MLKEM768_PREFIX) };
}

// A device's v2 public keys from its seeds, as base64url, for device.kem and the descriptor's kem.
export function kemPublicFromSeeds(seeds: KemSeeds): KemPublicKeys {
  const raw = publicRawOf(kemPrivateFromSeeds(seeds));
  return { p256: raw.p256.toString('base64url'), mlkem768: raw.mlkem768.toString('base64url') };
}

// Fresh seeds for a new device: a P-256 scalar from the runtime's own key generation and 64 random bytes for ML-KEM-768.
export function newKemSeeds(): KemSeeds {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  // JWK d is always the full 32 bytes for P-256 (RFC 7518 6.2.2.1).
  return { p256: Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url'), mlkem768: randomBytes(MLKEM_SEED_BYTES) };
}

// The KDF associated data: the domain, the cell, the epoch, the receiving device and the hash of both recipient keys. Throws on a bad id or key.
export function wrapV2Info(cell: string, epoch: number, writer: string, recipient: RawKeys): Buffer {
  if (!STREAM_ID_PATTERN.test(cell)) throw new Error('A cell id is 32 lowercase hex characters.');
  if (!isSafeIntegerInRange(epoch, 1, Number.MAX_SAFE_INTEGER)) throw new Error('A cell epoch is a whole number from 1.');
  if (!HASH_PATTERN.test(writer)) throw new Error('A writer id is 64 lowercase hex characters.');
  const p256 = rawOf(recipient.p256, P256_PUBLIC_BYTES, 'A P-256 public key');
  const mlkem768 = rawOf(recipient.mlkem768, MLKEM768_PUBLIC_BYTES, 'An ML-KEM-768 public key');
  const keys = createHash('sha256').update(p256).update(mlkem768).digest('hex');
  return Buffer.from(`${CELL_WRAP_V2_INFO}\0${cell}\0${epoch}\0${writer}\0${keys}`, 'utf8');
}

export interface WrapV2KeyInput { zEc: Buffer; zPq: Buffer; ephemeral: Buffer; ciphertext: Buffer; info: Buffer }

// The 32-byte AES key of one wrap: HKDF-SHA256 with IKM Z_ec || Z_pq, salt SHA-256(ephemeral || ciphertext) and the info. Exported for the vectors.
export function deriveWrapV2Key(input: WrapV2KeyInput): Buffer {
  const salt = createHash('sha256').update(input.ephemeral).update(input.ciphertext).digest();
  return Buffer.from(hkdfSync('sha256', Buffer.concat([input.zEc, input.zPq]), salt, input.info, 32));
}

export interface WrapV2Input { cell: string; epoch: number; writer: string; recipient: RawKeys; epochKey: Buffer }

// Wraps an epoch key to one device's v2 keys. Throws on a bad id, a recipient key that is not valid, an epoch key of the wrong size, or a runtime
// without ML-KEM (probeWrapV2 keeps such a client from asking).
export function wrapEpochKeyV2(input: WrapV2Input): string {
  const info = wrapV2Info(input.cell, input.epoch, input.writer, input.recipient);
  if (input.epochKey.length !== EPOCH_KEY_BYTES) throw new Error('An epoch key must be 32 bytes.');
  const api = kemApi();
  if (api === undefined) throw new Error('This runtime has no ML-KEM.');
  const recipient = checkedRecipient(input.recipient);
  const ephemeral = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ephemeralRaw = publicRaw(ephemeral.privateKey, SPKI_P256_PREFIX);
  const zEc = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient.p256Key });
  const { sharedKey, ciphertext } = api.encapsulate(recipient.mlkemKey);
  const key = deriveWrapV2Key({ zEc, zPq: Buffer.from(sharedKey), ephemeral: ephemeralRaw, ciphertext: Buffer.from(ciphertext), info });
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(info);
  const sealed = Buffer.concat([cipher.update(input.epochKey), cipher.final()]);
  return Buffer.concat([Buffer.from([WRAP_VERSION_V2]), ephemeralRaw, Buffer.from(ciphertext), iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

export interface UnwrapV2Input { cell: string; epoch: number; writer: string; privateKeys: KemPrivateKeys; wrap: string }

// The epoch key, or undefined for any failure: another device's keys or only one of them, another cell, epoch or writer, a changed byte, another
// version, an invalid ephemeral point or a wrong length. Never throws.
export function unwrapEpochKeyV2(input: UnwrapV2Input): Buffer | undefined {
  try {
    const api = kemApi();
    if (api === undefined || !isStrictBase64url(input.wrap, WRAP_V2_BYTES)) return undefined;
    const wire = Buffer.from(input.wrap, 'base64url');
    if (wire[0] !== WRAP_VERSION_V2) return undefined;
    let at = 1;
    const take = (bytes: number): Buffer => wire.subarray(at, (at += bytes));
    const ephemeral = take(P256_PUBLIC_BYTES);
    const ciphertext = take(MLKEM768_CIPHERTEXT_BYTES);
    const iv = take(IV_BYTES);
    const tag = take(TAG_BYTES);
    const sealed = take(EPOCH_KEY_BYTES);
    const info = wrapV2Info(input.cell, input.epoch, input.writer, publicRawOf(input.privateKeys));
    const zEc = diffieHellman({ privateKey: input.privateKeys.p256, publicKey: importP256Public(ephemeral) });
    const zPq = Buffer.from(api.decapsulate(input.privateKeys.mlkem768, ciphertext));
    const decipher = createDecipheriv('aes-256-gcm', deriveWrapV2Key({ zEc, zPq, ephemeral, ciphertext, info }), iv);
    decipher.setAAD(info);
    decipher.setAuthTag(tag);
    const opened = Buffer.concat([decipher.update(sealed), decipher.final()]);
    return opened.length === EPOCH_KEY_BYTES ? opened : undefined;
  } catch {
    // A wrap that does not open for this device, cell and epoch has one answer: no key.
    return undefined;
  }
}

export const WRAP_V2_REFUSALS = {
  'no-v2-keys': 'This computer has not published its post-quantum keys yet, so it gets its key later.',
  'no-v1-key': 'This computer has no key for the earlier wrap format.',
  'v2-unavailable': 'This version cannot make post-quantum wraps on this computer. Update to share this work.',
  'not-supported-yet': 'This key was wrapped in a newer format. Update to open it.',
  malformed: 'This wrap is not in a shape any version can read.'
} as const;
export type WrapV2Refusal = keyof typeof WRAP_V2_REFUSALS;

// Which format a wrap is in, from its bytes alone: v1 by its 92-byte length, v2 by its version byte and length, version 3 and above as not
// supported yet (D-08). Never throws.
export function wrapFormatOf(wrap: string): { ok: true; format: 1 | 2 } | { ok: false; reason: 'not-supported-yet' | 'malformed' } {
  if (typeof wrap !== 'string' || wrap.length === 0 || !/^[A-Za-z0-9_-]+$/.test(wrap)) return { ok: false, reason: 'malformed' };
  const wire = Buffer.from(wrap, 'base64url');
  if (wire.toString('base64url') !== wrap) return { ok: false, reason: 'malformed' };
  if (wire.length === WRAP_BYTES) return { ok: true, format: 1 };
  if (wire[0] >= WRAP_VERSION_RESERVED) return { ok: false, reason: 'not-supported-yet' };
  return wire[0] === WRAP_VERSION_V2 && wire.length === WRAP_V2_BYTES ? { ok: true, format: 2 } : { ok: false, reason: 'malformed' };
}

export interface DeviceWrapInput {
  // 2 once the project requires wrap@2 (and always for a cell D-07 keeps off v1); 1 before the switch. The caller decides; this never changes it.
  format: 1 | 2;
  cell: string;
  epoch: number;
  writer: string;
  epochKey: Buffer;
  // The receiving device's published keys: its X25519 key (v1) and its device.kem keys (v2), whichever it has.
  recipient: { x25519?: Buffer | string; kem?: RawKeys };
}
export type DeviceWrap = { ok: true; format: 1 | 2; wrap: string } | { ok: false; reason: 'no-v2-keys' | 'no-v1-key' | 'v2-unavailable' };

// The one entry point every wrap path calls (D-05, D-09). It writes the format asked for or refuses; it never falls back from v2 to v1, so a device
// without v2 keys at a v2 epoch gets no wrap and is given one later. Throws on a bad id, key or epoch key, like the two wrap functions.
export function wrapForDevice(input: DeviceWrapInput): DeviceWrap {
  const { cell, epoch, writer, epochKey } = input;
  if (input.format === 2) {
    if (input.recipient.kem === undefined) return { ok: false, reason: 'no-v2-keys' };
    if (kemApi() === undefined) return { ok: false, reason: 'v2-unavailable' };
    return { ok: true, format: 2, wrap: wrapEpochKeyV2({ cell, epoch, writer, epochKey, recipient: input.recipient.kem }) };
  }
  if (input.recipient.x25519 === undefined) return { ok: false, reason: 'no-v1-key' };
  return { ok: true, format: 1, wrap: wrapEpochKey({ cell, epoch, writer, epochKey, recipient: input.recipient.x25519 }) };
}

export interface DeviceUnwrapInput { cell: string; epoch: number; writer: string; wrap: string; x25519?: KeyObject; kem?: KemPrivateKeys }

// The one way a device opens a wrap addressed to it: v1 with its X25519 key, v2 with its post-quantum keys, chosen by the wrap's own format. A format
// the device has no key for, a later version and any failure give undefined. Never throws.
export function unwrapForDevice(input: DeviceUnwrapInput): Buffer | undefined {
  const format = wrapFormatOf(input.wrap);
  const where = { cell: input.cell, epoch: input.epoch, writer: input.writer, wrap: input.wrap };
  if (format.ok && format.format === 1 && input.x25519 !== undefined) return unwrapEpochKey({ ...where, privateKey: input.x25519 });
  if (format.ok && format.format === 2 && input.kem !== undefined) return unwrapEpochKeyV2({ ...where, privateKeys: input.kem });
  return undefined;
}

// ---- the start-up probe (D-05; 33.2-RESEARCH 7) ----

// The probe recipient: the ML-KEM-768 seed of FIPS 203 ACVP keyGen tcId 26 (d then z) with the SHA-256 of its published encapsulation key, and the
// P-256 scalar i of RFC 5903 section 8.1. Public test values; they protect nothing.
const PROBE_MLKEM_SEED = Buffer.from(
  'e582b7d75e6c80b05ae392a1fc9f7153b12390fd99930368cc67a768baebc8a01cdacb8740c0b87c4a379575f187b367cbfa3b300bf591b109f79816e9cbe8f0',
  'hex'
);
const PROBE_MLKEM_PUBLIC_SHA256 = '4158f6afb5e516c99f1da07da8c651348422b17c1f4e9a08ad73fb1f91249b3e';
const PROBE_P256_SCALAR = Buffer.from('c88f01f510d9ac3f70a292daa2316de544e9aab8afe84049c62a9c57862d1433', 'hex');
const PROBE_CELL = '0'.repeat(32);
const PROBE_WRITER = '0'.repeat(64);

// True only when this runtime makes and opens a v2 wrap correctly: the ML-KEM calls exist, the probe seed gives the published FIPS 203 key, and one
// wrap of a fixed epoch key to the probe recipient opens to the same bytes. Anything else, including a throw, is false, and the client then lacks
// wrap@2. Not cached: the feature registry calls it once at start-up.
export function probeWrapV2(): boolean {
  try {
    if (kemApi() === undefined) return false;
    const seeds = { p256: PROBE_P256_SCALAR, mlkem768: PROBE_MLKEM_SEED };
    const recipient = kemPublicFromSeeds(seeds);
    if (createHash('sha256').update(Buffer.from(recipient.mlkem768, 'base64url')).digest('hex') !== PROBE_MLKEM_PUBLIC_SHA256) return false;
    const epochKey = Buffer.alloc(EPOCH_KEY_BYTES, 0x5a);
    const wrap = wrapEpochKeyV2({ cell: PROBE_CELL, epoch: 1, writer: PROBE_WRITER, recipient, epochKey });
    const opened = unwrapEpochKeyV2({ cell: PROBE_CELL, epoch: 1, writer: PROBE_WRITER, privateKeys: kemPrivateFromSeeds(seeds), wrap });
    return opened !== undefined && opened.equals(epochKey);
  } catch {
    // Any failure of the runtime's crypto means no wrap@2 on this client.
    return false;
  }
}
