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
//
// The cell's label is sealed inside each grant under a key derived from the epoch key (sealLabel), so only a device that opens a wrap learns what the
// cell is (DESIGN 4.1, 8.2). planRekey turns a removal, a revocation or a lowered clearance into one new epoch per affected cell (D-23), and
// grantPages.ts earlierEpochGrants gives a device admitted later the epochs before it, so history stays readable (D-45).
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { canonicalBytes, isStrictBase64url } from '../team/canonical';
import type { KeyStatusLookup } from '../team/keyStatus';
import { signPayload, signPayloadAsync, verifyPayload } from '../team/signedPayload';
import type { AsyncPayloadSigner, PayloadSigner, SignRefused, SignedPayload } from '../team/signedPayload';
import { isRecord, isSafeIntegerInRange } from '../team/validate';
import { HASH_PATTERN, REPLICA_SIGNED_AT, STREAM_ID_PATTERN, writerIdOf } from './entry';
import { CELL_REKEY_REASONS } from './kindSchemas/roster';

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
// The cell label sealed under the epoch key (sealLabel), as base64url; empty when the grant carries no label.
export const MAX_LABEL_SEALED_CHARS = 8192;
// A grant page (33.2 D-04, D-12; grantPages.ts) carries pages: the sorted hashes of the other pages of its epoch grant, empty on a page that is not
// the founding one. Only a page may hold a cell-wrap/v2 wrap: version byte 2 and WRAP_V2_WIRE_BYTES bytes (cellWrapV2.ts WRAP_V2_BYTES, repeated
// here because cellWrapV2.ts imports this file). A grant without pages is exactly the v1 grant, with v1 wraps only.
const WRAP_V2_WIRE_BYTES = 1214;
export const MAX_GRANT_PAGES = 7;
// The largest signed grant, in canonical bytes. One wrap takes about 210 bytes, so a grant to MAX_GRANT_WRAPS devices with the longest label is about
// 880 KiB: over the 256 KiB every other signed payload is held to, so grants are signed and read with this limit instead (MN-04).
export const GRANT_MAX_BYTES = 1024 * 1024;
export const CELL_LABEL_INFO = 'near-ai/cell-label/v1';
// The largest label sealLabel accepts, so the sealed form (iv, tag, ciphertext as base64url) always fits MAX_LABEL_SEALED_CHARS.
export const MAX_LABEL_BYTES = Math.floor((MAX_LABEL_SEALED_CHARS * 3) / 4) - 12 - 16;

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
export interface CellGrant { cell: string; epoch: number; roster: string; labelSealed: string; wraps: GrantWrap[]; pages?: string[] }

// A copy holding only the grant's own fields; pages only when the grant has them.
function grantCopy(grant: CellGrant): CellGrant {
  const copy: CellGrant = { cell: grant.cell, epoch: grant.epoch, roster: grant.roster, labelSealed: grant.labelSealed, wraps: grant.wraps.map((item) => ({ writer: item.writer, wrap: item.wrap })) };
  if (grant.pages !== undefined) copy.pages = [...grant.pages];
  return copy;
}

const isV2WrapText = (wrap: string): boolean => isStrictBase64url(wrap, WRAP_V2_WIRE_BYTES) && Buffer.from(wrap, 'base64url')[0] === 2;

// Authority comes from the roster at the grant's roster hash, never from a clock, so the key status given to verifyPayload is always active.
const ALWAYS_ACTIVE: KeyStatusLookup = () => ({ state: 'active' });

// Signs a grant. signedAt is the constant replica time, so the grant hash depends only on the grant and the signer.
export function buildGrant(signer: PayloadSigner, grant: CellGrant): SignedPayload<CellGrant> {
  const problem = grantProblem(grant);
  if (problem !== undefined) throw new Error(`The grant was not signed: ${problem}.`);
  return signPayload(signer, 'staff-cell-grant', grantCopy(grant), { now: () => new Date(REPLICA_SIGNED_AT), maxBytes: GRANT_MAX_BYTES });
}

// buildGrant with a signer that answers later: the person key in a hosted session signs grants as the device the roster names (Phase 33 D-60,
// 33-27). Same payload and signing time, so the grant and its hash are the ones buildGrant makes with that key; a refusal comes back as it is.
export function buildGrantAsync(signer: PayloadSigner | AsyncPayloadSigner, grant: CellGrant): Promise<SignedPayload<CellGrant> | SignRefused> {
  const problem = grantProblem(grant);
  if (problem !== undefined) throw new Error(`The grant was not signed: ${problem}.`);
  return signPayloadAsync(signer, 'staff-cell-grant', grantCopy(grant), { now: () => new Date(REPLICA_SIGNED_AT), maxBytes: GRANT_MAX_BYTES });
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

export function grantProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return 'not an object';
  const keys = Object.keys(value);
  const paged = keys.includes('pages');
  const expected = paged ? ['cell', 'epoch', 'roster', 'labelSealed', 'wraps', 'pages'] : ['cell', 'epoch', 'roster', 'labelSealed', 'wraps'];
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) return 'wrong fields';
  if (paged) {
    const pages = value.pages;
    if (!Array.isArray(pages) || pages.length > MAX_GRANT_PAGES) return 'bad pages';
    for (let index = 0; index < pages.length; index += 1) {
      const page: unknown = pages[index];
      if (typeof page !== 'string' || !HASH_PATTERN.test(page) || (index > 0 && !((pages[index - 1] as string) < page))) return 'bad pages';
    }
  }
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
    if (typeof item.wrap !== 'string' || !(isStrictBase64url(item.wrap, WRAP_BYTES) || (paged && isV2WrapText(item.wrap)))) return 'bad wrap bytes';
    seen.add(item.writer);
  }
  return undefined;
}

// Checks the shape and the signature of a grant read from anywhere. Never throws. Who signed it and whether the wraps name admitted devices is the
// roster fold's question.
export function readGrant(value: unknown): GrantRead {
  try {
    const verdict = verifyPayload<unknown>(value, { purpose: 'staff-cell-grant', status: ALWAYS_ACTIVE, maxBytes: GRANT_MAX_BYTES });
    if (!verdict.ok) return { ok: false, reason: verdict.reason === 'bad-signature' ? 'bad-signature' : 'malformed' };
    const payload = verdict.payload;
    if (grantProblem(payload) !== undefined) return { ok: false, reason: 'malformed' };
    const grant = grantCopy(payload as CellGrant);
    return { ok: true, grant, hash: grantHash(value), signer: { publicKey: verdict.signer.publicKey, writer: writerIdOf(verdict.signer.publicKey) } };
  } catch {
    // Hostile input never throws out of the reader.
    return { ok: false, reason: 'malformed' };
  }
}

// ---- the cell label (DESIGN 4.1, 8.2) ----

function labelInfo(cell: string, epoch: number): Buffer {
  if (!STREAM_ID_PATTERN.test(cell)) throw new Error('A cell id is 32 lowercase hex characters.');
  if (!isSafeIntegerInRange(epoch, 1, Number.MAX_SAFE_INTEGER)) throw new Error('A cell epoch is a whole number from 1.');
  return Buffer.from(`${CELL_LABEL_INFO}\0${cell}\0${epoch}`, 'utf8');
}

// The label key is derived from the epoch key (HKDF-SHA256, info = CELL_LABEL_INFO NUL cell NUL epoch), so the label and the entries sealed under the
// same epoch key never share a key.
function labelKey(epochKey: Buffer, info: Buffer): Buffer {
  if (epochKey.length !== EPOCH_KEY_BYTES) throw new Error('An epoch key must be 32 bytes.');
  return Buffer.from(hkdfSync('sha256', epochKey, Buffer.alloc(0), info, 32));
}

// Seals a cell's label (any value canonicalBytes accepts, normally a Phase 70 label) for the grant's labelSealed field: AES-256-GCM under the label
// key, with the cell and epoch as associated data. Wire form: iv (12) | tag (16) | ciphertext, as base64url. Throws on a label over MAX_LABEL_BYTES.
export function sealLabel(epochKey: Buffer, cell: string, epoch: number, label: unknown): string {
  const info = labelInfo(cell, epoch);
  const plain = canonicalBytes(label);
  if (plain.length > MAX_LABEL_BYTES) throw new Error('A cell label is too long to seal in a grant.');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', labelKey(epochKey, info), iv);
  cipher.setAAD(info);
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

// The label, or undefined for any failure: another epoch key, another cell or epoch, a changed byte, an empty or malformed field. Never throws. The
// caller checks the value with the Phase 70 label reader before it trusts its shape.
export function openLabel(epochKey: Buffer, cell: string, epoch: number, sealed: string): unknown {
  try {
    if (sealed.length === 0 || !/^[A-Za-z0-9_-]+$/.test(sealed)) return undefined;
    const wire = Buffer.from(sealed, 'base64url');
    if (wire.length < IV_BYTES + TAG_BYTES || wire.toString('base64url') !== sealed) return undefined;
    const info = labelInfo(cell, epoch);
    const decipher = createDecipheriv('aes-256-gcm', labelKey(epochKey, info), wire.subarray(0, IV_BYTES));
    decipher.setAAD(info);
    decipher.setAuthTag(wire.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const opened = Buffer.concat([decipher.update(wire.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    return JSON.parse(opened.toString('utf8')) as unknown;
  } catch {
    // A label that does not open under this key, cell and epoch has one answer: none.
    return undefined;
  }
}

// ---- rekey planning (D-23) ----

// What the lead is told about retained work and the pending or verified key change (D-23, DESIGN 8.3).
export const REKEY_KEEP_TEXT = 'They keep what they already received.';
export const REKEY_PENDING_TEXT = 'Until the affected parts have verified new keys, devices that held the old keys may still read new work encrypted with them.';
export const REKEY_VERIFIED_TEXT = 'Devices excluded from the new keys cannot read work encrypted with those keys.';

export type RekeyReason = (typeof CELL_REKEY_REASONS)[number];

// One cell.rekey to write: the new epoch's key goes to recipients only. dropped are the devices that held the current epoch and will not hold the
// next one; they keep the epochs they already had.
export interface RekeyPlan { cell: string; reason: RekeyReason; recipients: string[]; dropped: string[]; text: string }

export interface RekeyInput {
  // writers: the devices the change is about (the removed member's devices, the revoked device or hub device, the devices of the member whose
  // clearance was lowered). Empty for a scheduled rekey.
  change: { kind: RekeyReason; writers: readonly string[] };
  // For each cell: the devices holding its current epoch (cellGrantees) and the devices cleared for it now, which the host computes with Phase 70
  // dominance at write time (the fold never recomputes it).
  cells: ReadonlyArray<{ cell: string; grantees: readonly string[]; clearedNow: readonly string[] }>;
}

// Turns one change into one plan per affected cell, sorted by cell (D-23). The recipients are the current grantees that are still cleared and are
// not named by the change, so the new key is never wrapped to a device that is not cleared for the cell (P-31-20). A removal, a revocation or a hub
// revocation always drops the named devices; a lowered clearance drops a named device only from the cells it is no longer cleared for. A cell the
// change drops nobody from gets no plan, except a scheduled rekey, which plans every cell given with the same cleared recipients. Throws on a reason
// outside CELL_REKEY_REASONS. An empty recipients list means nobody cleared is left: the host must not write that rekey.
export function planRekey(input: RekeyInput): RekeyPlan[] {
  const kind = input.change.kind;
  if (!(CELL_REKEY_REASONS as readonly string[]).includes(kind)) throw new Error('A rekey reason must be one of the closed list.');
  const named = new Set(input.change.writers);
  const plans: RekeyPlan[] = [];
  for (const item of input.cells) {
    const cleared = new Set(item.clearedNow);
    const grantees = [...new Set(item.grantees)].sort();
    const leaves = (writer: string): boolean => !cleared.has(writer) || (kind !== 'clearance-lowered' && named.has(writer));
    const dropped = grantees.filter(leaves);
    const touched = kind === 'scheduled' || dropped.some((writer) => named.has(writer));
    if (!touched) continue;
    plans.push({ cell: item.cell, reason: kind, recipients: grantees.filter((writer) => !leaves(writer)), dropped, text: REKEY_KEEP_TEXT });
  }
  return plans.sort((a, b) => (a.cell < b.cell ? -1 : a.cell > b.cell ? 1 : 0));
}
