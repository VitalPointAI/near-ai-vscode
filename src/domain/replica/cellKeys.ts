// Cell epoch keys, the wraps that carry them to one device, and the signed grant objects that hold the wraps (D-19, D-21, D-22, D-24, D-44).
// Hub-side and pure: node:crypto and src/domain only, no clock, no I/O. Private keys are passed in by host code as KeyObjects; nothing here stores,
// logs or returns one (D-19, D-24).
//
// A wrap is HPKE base mode in shape (D-21), so a standard library can replace it later as a new format version:
// - X25519 agreement between a fresh ephemeral key and the device's X25519 public key;
// - HKDF-SHA256 with the ephemeral public key as salt and info = CELL_WRAP_INFO NUL cell NUL epoch NUL device writer, giving a 32-byte key;
// - AES-256-GCM over the 32-byte epoch key with the same info as associated data.
// Wire form: ephemeral public (32) | iv (12) | tag (16) | ciphertext (32) = 92 bytes, as base64url. Because the info names the cell, the epoch and
// the receiving device, a wrap copied to another device, cell or epoch fails authentication.
//
// A grant is a signed object outside the streams (purpose staff-cell-grant): { cell, epoch, roster, labelSealed, wraps }. The roster entry that
// founds an epoch (project.genesis cells, cell.create, cell.rekey) commits to the founding grant by grantHash; a later grant of an existing epoch is
// valid when a roster writer at the roster it names signed it (checked by the roster fold, not here).
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { canonicalBytes, isStrictBase64url } from '../team/canonical';
import type { KeyStatusLookup } from '../team/keyStatus';
import { signPayload, verifyPayload } from '../team/signedPayload';
import type { PayloadSigner, SignedPayload } from '../team/signedPayload';
import { isRecord, isSafeIntegerInRange } from '../team/validate';
import { HASH_PATTERN, REPLICA_SIGNED_AT, STREAM_ID_PATTERN, writerIdOf } from './entry';

export const CELL_WRAP_INFO = 'near-ai/cell-wrap/v1';
// The text a device signs with its Ed25519 key to bind its X25519 key to itself (D-19). The roster entry that admits the device carries the signature.
export const X25519_BINDING_DOMAIN = 'near-ai-vscode/device-x25519/v1\n';
export const X25519_KEY_BYTES = 32;
export const EPOCH_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const WRAP_BYTES = X25519_KEY_BYTES + IV_BYTES + TAG_BYTES + EPOCH_KEY_BYTES;
// One wrap per device; slots are capped at 4095, so a grant never names more devices than that.
export const MAX_GRANT_WRAPS = 4095;
// The cell label sealed under the epoch key (31-15 fills it), as base64url; empty when the grant carries no label.
const MAX_LABEL_SEALED_CHARS = 8192;

// DER prefixes of a raw X25519 key: SubjectPublicKeyInfo for the public key, PKCS8 for the 32-byte private seed.
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

const toRaw = (value: Buffer | string): Buffer => (typeof value === 'string' ? Buffer.from(value, 'base64url') : value);

// Throws on a key that is not 32 raw bytes. The bytes come from a roster entry or a request, so the length is checked before the DER is built.
export function importX25519Public(raw: Buffer | string): KeyObject {
  if (typeof raw === 'string' && !isStrictBase64url(raw, X25519_KEY_BYTES)) throw new Error('An X25519 public key must be 32 bytes written as base64url.');
  const bytes = toRaw(raw);
  if (bytes.length !== X25519_KEY_BYTES) throw new Error('An X25519 public key must be 32 bytes.');
  return createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, bytes]), format: 'der', type: 'spki' });
}

// The raw 32 bytes of an X25519 public key (or of the public half of a private key).
export function x25519PublicRaw(key: KeyObject): Buffer {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  return Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
}

// An X25519 private key from its 32-byte seed. For tests and for the host's re-import of a key it keeps in SecretStorage; never for a key read from
// the project folder.
export function x25519PrivateFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== X25519_KEY_BYTES) throw new Error('An X25519 private key seed must be 32 bytes.');
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

// The bytes a device signs to bind its X25519 key: the domain line, the 32 raw key bytes, then the device's writer id in hex.
export function x25519BindingBytes(rawX25519: Buffer | string, writer: string): Buffer {
  const bytes = toRaw(rawX25519);
  if (bytes.length !== X25519_KEY_BYTES) throw new Error('An X25519 public key must be 32 bytes.');
  if (!HASH_PATTERN.test(writer)) throw new Error('A writer id is 64 lowercase hex characters.');
  return Buffer.concat([Buffer.from(X25519_BINDING_DOMAIN, 'utf8'), bytes, Buffer.from(writer, 'utf8')]);
}

function wrapInfo(cell: string, epoch: number, writer: string): Buffer {
  if (!STREAM_ID_PATTERN.test(cell)) throw new Error('A cell id is 32 lowercase hex characters.');
  if (!isSafeIntegerInRange(epoch, 1, Number.MAX_SAFE_INTEGER)) throw new Error('A cell epoch is a whole number from 1.');
  if (!HASH_PATTERN.test(writer)) throw new Error('A writer id is 64 lowercase hex characters.');
  return Buffer.from(`${CELL_WRAP_INFO}\0${cell}\0${epoch}\0${writer}`, 'utf8');
}

function wrapKey(shared: Buffer, ephemeralRaw: Buffer, info: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, ephemeralRaw, info, 32));
}

// 32 fresh random bytes: the key of one cell epoch.
export function newEpochKey(): Buffer {
  return randomBytes(EPOCH_KEY_BYTES);
}

export interface WrapInput { cell: string; epoch: number; writer: string; recipient: Buffer | string; epochKey: Buffer }

// Wraps an epoch key to one device's X25519 public key. Throws on a recipient key or epoch key of the wrong size.
export function wrapEpochKey(input: WrapInput): string {
  const info = wrapInfo(input.cell, input.epoch, input.writer);
  if (input.epochKey.length !== EPOCH_KEY_BYTES) throw new Error('An epoch key must be 32 bytes.');
  const recipient = importX25519Public(input.recipient);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralRaw = x25519PublicRaw(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = wrapKey(shared, ephemeralRaw, info);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(info);
  const sealed = Buffer.concat([cipher.update(input.epochKey), cipher.final()]);
  return Buffer.concat([ephemeralRaw, iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

export interface UnwrapInput { cell: string; epoch: number; writer: string; privateKey: KeyObject; wrap: string }

// The epoch key, or undefined for any failure: another device's key, another cell, epoch or writer, a changed byte, a low-order ephemeral key or a
// wrong length. Never throws.
export function unwrapEpochKey(input: UnwrapInput): Buffer | undefined {
  try {
    if (!isStrictBase64url(input.wrap, WRAP_BYTES)) return undefined;
    const wire = Buffer.from(input.wrap, 'base64url');
    const ephemeralRaw = wire.subarray(0, X25519_KEY_BYTES);
    const iv = wire.subarray(X25519_KEY_BYTES, X25519_KEY_BYTES + IV_BYTES);
    const tag = wire.subarray(X25519_KEY_BYTES + IV_BYTES, X25519_KEY_BYTES + IV_BYTES + TAG_BYTES);
    const sealed = wire.subarray(X25519_KEY_BYTES + IV_BYTES + TAG_BYTES);
    const info = wrapInfo(input.cell, input.epoch, input.writer);
    const shared = diffieHellman({ privateKey: input.privateKey, publicKey: importX25519Public(Buffer.from(ephemeralRaw)) });
    const key = wrapKey(shared, Buffer.from(ephemeralRaw), info);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(info);
    decipher.setAuthTag(tag);
    const opened = Buffer.concat([decipher.update(sealed), decipher.final()]);
    return opened.length === EPOCH_KEY_BYTES ? opened : undefined;
  } catch {
    // A wrap that does not open for this device, cell and epoch has one answer: no key.
    return undefined;
  }
}

export interface GrantWrap { writer: string; wrap: string }
// roster: the roster hash the grant is valid at (its signer must be a roster writer there and every wrap must name a device admitted there).
export interface CellGrant { cell: string; epoch: number; roster: string; labelSealed: string; wraps: GrantWrap[] }

// Authority comes from the roster at the grant's roster hash, never from a clock, so the key status given to verifyPayload is always active.
const ALWAYS_ACTIVE: KeyStatusLookup = () => ({ state: 'active' });

// Signs a grant. signedAt is the constant replica time, so the grant hash depends only on the grant and the signer.
export function buildGrant(signer: PayloadSigner, grant: CellGrant): SignedPayload<CellGrant> {
  const problem = grantProblem(grant);
  if (problem !== undefined) throw new Error(`The grant was not signed: ${problem}.`);
  const copy: CellGrant = { cell: grant.cell, epoch: grant.epoch, roster: grant.roster, labelSealed: grant.labelSealed, wraps: grant.wraps.map((item) => ({ writer: item.writer, wrap: item.wrap })) };
  return signPayload(signer, 'staff-cell-grant', copy, { now: () => new Date(REPLICA_SIGNED_AT) });
}

// sha256 hex of the canonical signed grant: what project.genesis cells, cell.create and cell.rekey commit to.
export function grantHash(signed: unknown): string {
  return createHash('sha256').update(canonicalBytes(signed)).digest('hex');
}

export const GRANT_REFUSALS = {
  malformed: 'The cell grant is not in a shape this version can read.',
  'bad-signature': 'The cell grant signature does not match its content, so it was changed or was not made by the key it names.'
} as const;
export type GrantRefusal = keyof typeof GRANT_REFUSALS;

export type GrantRead =
  | { ok: true; grant: CellGrant; hash: string; signer: { publicKey: string; writer: string } }
  | { ok: false; reason: GrantRefusal };

function grantProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return 'not an object';
  const keys = Object.keys(value);
  const expected = ['cell', 'epoch', 'roster', 'labelSealed', 'wraps'];
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) return 'wrong fields';
  if (typeof value.cell !== 'string' || !STREAM_ID_PATTERN.test(value.cell)) return 'bad cell';
  if (!isSafeIntegerInRange(value.epoch, 1, Number.MAX_SAFE_INTEGER)) return 'bad epoch';
  if (typeof value.roster !== 'string' || !HASH_PATTERN.test(value.roster)) return 'bad roster';
  if (typeof value.labelSealed !== 'string' || value.labelSealed.length > MAX_LABEL_SEALED_CHARS || !/^[A-Za-z0-9_-]*$/.test(value.labelSealed)) return 'bad label';
  if (!Array.isArray(value.wraps) || value.wraps.length === 0 || value.wraps.length > MAX_GRANT_WRAPS) return 'bad wraps';
  const seen = new Set<string>();
  for (const item of value.wraps as unknown[]) {
    if (!isRecord(item)) return 'bad wrap';
    const itemKeys = Object.keys(item);
    if (itemKeys.length !== 2 || !itemKeys.includes('writer') || !itemKeys.includes('wrap')) return 'bad wrap';
    if (typeof item.writer !== 'string' || !HASH_PATTERN.test(item.writer) || seen.has(item.writer)) return 'bad wrap writer';
    if (typeof item.wrap !== 'string' || !isStrictBase64url(item.wrap, WRAP_BYTES)) return 'bad wrap bytes';
    seen.add(item.writer);
  }
  return undefined;
}

// Checks the shape and the signature of a grant read from anywhere. Never throws. Who signed it and whether the wraps name admitted devices is the
// roster fold's question.
export function readGrant(value: unknown): GrantRead {
  try {
    const verdict = verifyPayload<unknown>(value, { purpose: 'staff-cell-grant', status: ALWAYS_ACTIVE });
    if (!verdict.ok) return { ok: false, reason: verdict.reason === 'bad-signature' ? 'bad-signature' : 'malformed' };
    const payload = verdict.payload;
    if (grantProblem(payload) !== undefined) return { ok: false, reason: 'malformed' };
    const raw = payload as CellGrant;
    const grant: CellGrant = { cell: raw.cell, epoch: raw.epoch, roster: raw.roster, labelSealed: raw.labelSealed, wraps: raw.wraps.map((item) => ({ writer: item.writer, wrap: item.wrap })) };
    return { ok: true, grant, hash: grantHash(value), signer: { publicKey: verdict.signer.publicKey, writer: writerIdOf(verdict.signer.publicKey) } };
  } catch {
    // Hostile input never throws out of the reader.
    return { ok: false, reason: 'malformed' };
  }
}
