// Entry format version 2 for the replication core (MUS-01, D-03, D-04, D-05, D-31, D-32). Pure: node:crypto and relative files under src/domain only.
//
// An entry is a signed header plus a sealed body. The header is visible to a hub; the body is AES-256-GCM ciphertext under the cell's epoch key.
// - The header is signed through signPayload with purpose staff-replica and a constant signedAt, so signing the same header twice gives identical
//   bytes and a crash-and-retry is never mistaken for equivocation (D-32). The key status given to verifyPayload is always active: who may write
//   comes from the roster view at the roster hash the entry cites, never from a clock.
// - The AES-GCM associated data is the header without sig and without body.hash but with body.size (D-31): body.hash is the hash of the ciphertext,
//   so it cannot be an input to making the ciphertext.
// - Bodies over INLINE_BODY_MAX_BYTES serialised move their data into a content-addressed sealed blob and carry its hash instead (D-04).
// - Re-sealing the same plaintext gives a new ciphertext and so a new body.hash and a second signed header at the same seq. Callers must therefore
//   persist the finished entry that buildEntry returns before they send it (Phase 31's store writes before it sends).
import { createHash } from 'node:crypto';
import { canonicalBytes, fingerprintOf, isStrictBase64url } from '../team/canonical';
import type { KeyStatusLookup } from '../team/keyStatus';
import { payloadSigningInput, signPayload, signPayloadAsync, verifyPayload } from '../team/signedPayload';
import type { AsyncPayloadSigner, PayloadSigner, SignRefused } from '../team/signedPayload';
import { isRecord, isSafeIntegerInRange } from '../team/validate';
import { IV_BYTES, KEY_BYTES, TAG_BYTES, openRaw, sealRaw } from '../state/keys';

export const ENTRY_VERSION = 2;
export const GENESIS_PREV = '0'.repeat(64);
export const REPLICA_SIGNED_AT = '1970-01-01T00:00:00.000Z';
export const HEADER_MAX_BYTES = 4096;
export const INLINE_BODY_MAX_BYTES = 16 * 1024;
export const BLOB_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_DEPS = 16;
export const STREAM_ID_PATTERN = /^[0-9a-f]{32}$/;
export const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SIG_BYTES = 64;
const PUBLIC_KEY_BYTES = 32;
// iv plus tag: what sealing adds to the plaintext length.
export const SEALED_OVERHEAD = IV_BYTES + TAG_BYTES;
const HEADER_KEYS = ['v', 'stream', 'writer', 'seq', 'prev', 'epoch', 'body', 'sig'] as const;

export interface Dep { writer: string; seq: number; hash: string }
// A person actor may name the position the act is made as (Phase 33.1 D-10): inside the sealed body, accepted only behind positions@1.
export type Actor = { kind: 'person'; position?: string } | { kind: 'agent'; member: string; run: string } | { kind: 'hub'; watch: string };

export interface EntryHeader {
  v: 2;
  stream: string;
  writer: string;
  seq: number;
  prev: string;
  epoch: number;
  body: { hash: string; size: number };
  sig: string;
}
export type UnsignedHeader = Omit<EntryHeader, 'sig'>;

// The body once opened. Exactly one of data or blob is present.
export interface EntryBody {
  deps: Dep[];
  roster: string;
  lamport: number;
  at: string;
  actor: Actor;
  kind: string;
  data?: unknown;
  blob?: string;
}

// An entry as it travels: the signed header and the sealed body as base64url of iv, then tag, then data.
export interface SealedEntry { header: EntryHeader; body: string }
// A content-addressed sealed blob: hash is sha256 of the wire bytes, bytes is their base64url.
export interface SealedBlob { hash: string; bytes: string }

export interface BuiltEntry { entry: SealedEntry; hash: string; blobs: SealedBlob[] }

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// The writer id of a device: sha256 of the raw 32-byte Ed25519 key, given as the base64url key a signer carries.
export function writerIdOf(publicKey: string): string {
  return sha256Hex(Buffer.from(publicKey, 'base64url'));
}

interface AadFields { v?: number; stream: string; writer: string; seq: number; prev: string; epoch: number; body: { size: number } }

// D-31: no sig and no body.hash, but body.size, so the plaintext is bound to its place in a chain.
export function headerAad(header: AadFields): Buffer {
  return canonicalBytes({ v: ENTRY_VERSION, stream: header.stream, writer: header.writer, seq: header.seq, prev: header.prev, epoch: header.epoch, size: header.body.size });
}

export function blobAad(stream: string, epoch: number): Buffer {
  return canonicalBytes({ v: ENTRY_VERSION, blob: true, stream, epoch });
}

// Authority is the roster view's job (D-32), so the key status handed to verifyPayload is always active.
const ALWAYS_ACTIVE: KeyStatusLookup = () => ({ state: 'active' });

const HEADER_SIGNING = { now: () => new Date(REPLICA_SIGNED_AT), maxBytes: HEADER_MAX_BYTES };

export function signHeader(signer: PayloadSigner, unsigned: UnsignedHeader): EntryHeader {
  const envelope = signPayload(signer, 'staff-replica', unsigned, HEADER_SIGNING);
  return { ...unsigned, sig: envelope.sig };
}

// signHeader with a signer that answers later (Phase 33 D-60). The same key gives the same header, because the signed bytes are the same.
export async function signHeaderAsync(signer: AsyncPayloadSigner | PayloadSigner, unsigned: UnsignedHeader): Promise<EntryHeader | SignRefused> {
  const envelope = await signPayloadAsync(signer, 'staff-replica', unsigned, HEADER_SIGNING);
  return 'refused' in envelope ? envelope : { ...unsigned, sig: envelope.sig };
}

// Never throws. False unless the key hashes to the writer id and the signature over the header is valid.
export function verifyHeader(header: EntryHeader, publicKey: string): boolean {
  try {
    if (!isStrictBase64url(publicKey, PUBLIC_KEY_BYTES)) return false;
    const raw = Buffer.from(publicKey, 'base64url');
    if (sha256Hex(raw) !== header.writer) return false;
    const { sig, ...payload } = header;
    const envelope = { v: 1, purpose: 'staff-replica', signer: { fingerprint: fingerprintOf(raw), publicKey }, signedAt: REPLICA_SIGNED_AT, payload, sig };
    return verifyPayload(envelope, { purpose: 'staff-replica', status: ALWAYS_ACTIVE, maxBytes: HEADER_MAX_BYTES }).ok;
  } catch {
    // A header that cannot be canonicalised or checked is not a valid signed header.
    return false;
  }
}

export function entryHash(header: EntryHeader): string {
  return sha256Hex(canonicalBytes(header));
}

// Wire form of a sealed body or blob: iv, then tag, then data.
export function toWire(sealed: { iv: Buffer; tag: Buffer; data: Buffer }): Buffer {
  return Buffer.concat([sealed.iv, sealed.tag, sealed.data]);
}

export function fromWire(wire: Buffer): { iv: Buffer; tag: Buffer; data: Buffer } | undefined {
  if (wire.length < SEALED_OVERHEAD) return undefined;
  return { iv: wire.subarray(0, IV_BYTES), tag: wire.subarray(IV_BYTES, SEALED_OVERHEAD), data: wire.subarray(SEALED_OVERHEAD) };
}

export function sealBody(key: Buffer, ids: Omit<UnsignedHeader, 'v' | 'body'>, plaintext: Buffer): Buffer {
  const aad = headerAad({ ...ids, body: { size: plaintext.length + SEALED_OVERHEAD } });
  return toWire(sealRaw(key, plaintext, aad));
}

// Undefined for any failure: wrong key, changed byte, different header, short input.
export function openBody(key: Buffer, header: EntryHeader, wire: Buffer): Buffer | undefined {
  try {
    const parts = fromWire(wire);
    if (parts === undefined || key.length !== KEY_BYTES) return undefined;
    return openRaw(key, parts, headerAad(header));
  } catch {
    // Every failure of the cipher is the same answer: the body is not readable with this key and header.
    return undefined;
  }
}

export function sealBlob(key: Buffer, stream: string, epoch: number, plaintext: Buffer): SealedBlob {
  const wire = toWire(sealRaw(key, plaintext, blobAad(stream, epoch)));
  return { hash: sha256Hex(wire), bytes: wire.toString('base64url') };
}

// The hash a blob's bytes actually have, so a caller can tell a wrong copy (hold, a good one may come) from an unreadable one (reject).
export function blobBytesHash(blob: SealedBlob): string | undefined {
  try {
    return sha256Hex(Buffer.from(blob.bytes, 'base64url'));
  } catch {
    return undefined;
  }
}

export function openBlob(key: Buffer, stream: string, epoch: number, blob: SealedBlob): Buffer | undefined {
  try {
    const parts = fromWire(Buffer.from(blob.bytes, 'base64url'));
    if (parts === undefined || key.length !== KEY_BYTES) return undefined;
    return openRaw(key, parts, blobAad(stream, epoch));
  } catch {
    // Same single answer as openBody.
    return undefined;
  }
}

export interface NewBody { deps: Dep[]; roster: string; lamport: number; at: string; actor: Actor; kind: string; data: unknown }

export interface BuildEntryInput {
  signer: PayloadSigner;
  key: Buffer;
  stream: string;
  seq: number;
  prev: string;
  epoch: number;
  body: NewBody;
}

// Seals and signs one entry. A body longer than INLINE_BODY_MAX_BYTES serialised moves its data into a sealed blob first.
export function buildEntry(input: BuildEntryInput): BuiltEntry {
  const sealed = sealEntry(input);
  return builtOf(signHeader(input.signer, sealed.unsigned), sealed);
}

// buildEntry with a signer that answers later (Phase 33 D-60): sealed the same way, signed through signHeaderAsync. A signer's refusal comes back as
// it is, and nothing is built.
export async function buildEntryAsync(input: Omit<BuildEntryInput, 'signer'> & { signer: AsyncPayloadSigner | PayloadSigner }): Promise<BuiltEntry | SignRefused> {
  const sealed = sealEntry(input);
  const header = await signHeaderAsync(input.signer, sealed.unsigned);
  return 'refused' in header ? header : builtOf(header, sealed);
}

export interface PreparedEntrySigning {
  signingBytes(): Buffer;
  finish(signature: string): BuiltEntry | undefined;
  matches(candidate: BuiltEntry): boolean;
}

/** Seal once. A checked signer sees the bytes of exactly this header and cannot change the entry or its blobs. */
export function prepareEntrySigning(input: Omit<BuildEntryInput, 'signer'> & { signer: Pick<PayloadSigner, 'publicKey' | 'fingerprint'> }): PreparedEntrySigning {
  const { fingerprint, publicKey } = input.signer;
  const sealed = sealEntry(input);
  const expected = payloadSigningInput({ v: 1, purpose: 'staff-replica', signer: { fingerprint, publicKey }, signedAt: REPLICA_SIGNED_AT, payload: sealed.unsigned });
  let signed: Buffer | undefined;
  return Object.freeze({
    signingBytes: () => Buffer.from(expected),
    finish(signature: string) {
      const header = { ...sealed.unsigned, sig: signature };
      if (!verifyHeader(header, publicKey)) return undefined;
      const built = builtOf(header, sealed);
      const bytes = canonicalBytes(built);
      if (signed !== undefined && !signed.equals(bytes)) return undefined;
      signed = bytes;
      return JSON.parse(bytes.toString('utf8')) as BuiltEntry;
    },
    matches(candidate: BuiltEntry): boolean {
      try { return signed?.equals(canonicalBytes(candidate)) === true; } catch { return false; }
    }
  });
}

interface SealedParts { unsigned: UnsignedHeader; body: string; blobs: SealedBlob[] }

function builtOf(header: EntryHeader, sealed: SealedParts): BuiltEntry {
  return { entry: { header, body: sealed.body }, hash: entryHash(header), blobs: sealed.blobs };
}

function sealEntry(input: Omit<BuildEntryInput, 'signer'> & { signer: { publicKey: string } }): SealedParts {
  const { signer, key, stream, seq, prev, epoch, body } = input;
  const writer = writerIdOf(signer.publicKey);
  const blobs: SealedBlob[] = [];
  let stored: EntryBody = { deps: body.deps, roster: body.roster, lamport: body.lamport, at: body.at, actor: body.actor, kind: body.kind, data: body.data };
  let plaintext = canonicalBytes(stored);
  if (plaintext.length > INLINE_BODY_MAX_BYTES) {
    const blob = sealBlob(key, stream, epoch, canonicalBytes(body.data));
    blobs.push(blob);
    stored = { deps: body.deps, roster: body.roster, lamport: body.lamport, at: body.at, actor: body.actor, kind: body.kind, blob: blob.hash };
    plaintext = canonicalBytes(stored);
  }
  const ids = { stream, writer, seq, prev, epoch };
  const wire = sealBody(key, ids, plaintext);
  const unsigned: UnsignedHeader = { v: ENTRY_VERSION, stream, writer, seq, prev, epoch, body: { hash: sha256Hex(wire), size: wire.length } };
  return { unsigned, body: wire.toString('base64url'), blobs };
}

export type HeaderShapeReason = 'malformed-header' | 'unknown-header-version' | 'header-too-large';
export type HeaderShape = { ok: true; header: EntryHeader } | { ok: false; reason: HeaderShapeReason };

// Checks the exact header keys and patterns. Reads the input once and never throws.
export function parseHeaderShape(value: unknown): HeaderShape {
  try {
    if (!isRecord(value)) return { ok: false, reason: 'malformed-header' };
    if (typeof value.v === 'number' && Number.isInteger(value.v) && value.v !== ENTRY_VERSION) return { ok: false, reason: 'unknown-header-version' };
    if (value.v !== ENTRY_VERSION) return { ok: false, reason: 'malformed-header' };
    const keys = Object.keys(value);
    if (keys.length !== HEADER_KEYS.length || !HEADER_KEYS.every((key) => keys.includes(key))) return { ok: false, reason: 'malformed-header' };
    const { stream, writer, seq, prev, epoch, body, sig } = value;
    if (typeof stream !== 'string' || !STREAM_ID_PATTERN.test(stream)) return { ok: false, reason: 'malformed-header' };
    if (typeof writer !== 'string' || !HASH_PATTERN.test(writer)) return { ok: false, reason: 'malformed-header' };
    if (!isSafeIntegerInRange(seq, 0, Number.MAX_SAFE_INTEGER) || !isSafeIntegerInRange(epoch, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'malformed-header' };
    if (typeof prev !== 'string' || !HASH_PATTERN.test(prev)) return { ok: false, reason: 'malformed-header' };
    if (typeof sig !== 'string' || !isStrictBase64url(sig, SIG_BYTES)) return { ok: false, reason: 'malformed-header' };
    if (!isRecord(body)) return { ok: false, reason: 'malformed-header' };
    const bodyKeys = Object.keys(body);
    if (bodyKeys.length !== 2 || !bodyKeys.includes('hash') || !bodyKeys.includes('size')) return { ok: false, reason: 'malformed-header' };
    if (typeof body.hash !== 'string' || !HASH_PATTERN.test(body.hash)) return { ok: false, reason: 'malformed-header' };
    if (!isSafeIntegerInRange(body.size, SEALED_OVERHEAD, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'malformed-header' };
    const header: EntryHeader = { v: ENTRY_VERSION, stream, writer, seq, prev, epoch, body: { hash: body.hash, size: body.size }, sig };
    if (canonicalBytes(header).length > HEADER_MAX_BYTES) return { ok: false, reason: 'header-too-large' };
    return { ok: true, header };
  } catch {
    // Anything that cannot be read as a plain header is malformed; hostile input never throws out of here.
    return { ok: false, reason: 'malformed-header' };
  }
}

// The closed actor shapes (D-06). Slugs and run ids are short, lowercase-safe words so a name can never carry markup or a path.
const ACTOR_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function isActorShape(value: unknown): value is Actor {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const only = (...allowed: string[]): boolean => keys.length === allowed.length && allowed.every((key) => keys.includes(key));
  if (value.kind === 'person') return only('kind') || (only('kind', 'position') && typeof value.position === 'string' && ACTOR_NAME.test(value.position));
  if (value.kind === 'agent') return only('kind', 'member', 'run') && typeof value.member === 'string' && ACTOR_NAME.test(value.member) && typeof value.run === 'string' && RUN_ID.test(value.run);
  if (value.kind === 'hub') return only('kind', 'watch') && typeof value.watch === 'string' && ACTOR_NAME.test(value.watch);
  return false;
}
