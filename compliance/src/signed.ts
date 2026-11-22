// A dependency-free verifier for the extension's signed-payload envelope (44-04, D-20). Phase 44 may not change src/, so this file follows
// src/domain/team/signedPayload.ts and src/domain/team/canonical.ts exactly, using node:crypto only; signedParity.test.ts proves that an envelope
// the extension's own signPayload made verifies here, and that the domain string below equals the extension's.
//
// What is signed: the UTF-8 text of the domain, a newline, the purpose and a newline, followed by the canonical JSON of the envelope without sig.
// The verifier takes the purpose it expects from its caller, never from the envelope, so a signature made for one purpose never verifies as another.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { FUTURE_TOLERANCE_MS } from './status.ts';

/** The signing domain of the extension's signed payloads (src/domain/team/signedPayload.ts). */
export const PAYLOAD_DOMAIN = 'near-ai-vscode/signed-payload/v1';
export const PAYLOAD_VERSION = 1;
/** The largest canonical envelope accepted, as in the extension. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
/** Containers nest at most this deep, as in the extension's canonical form. */
export const MAX_DEPTH = 16;

const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
// The 12-byte SPKI prefix of an Ed25519 public key; the 32 raw key bytes follow it.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;

export class CanonicalJsonError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function write(value: unknown, at: string, depth: number): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (Object.is(value, -0)) throw new CanonicalJsonError(`${at}: negative zero is not allowed`);
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`${at}: numbers must be safe integers`);
      return String(value);
    case 'string':
      if (LONE_SURROGATE.test(value)) throw new CanonicalJsonError(`${at}: lone surrogate in string`);
      return JSON.stringify(value);
    case 'object':
      return writeContainer(value, at, depth + 1);
    default:
      throw new CanonicalJsonError(`${at}: ${typeof value} is not allowed`);
  }
}

function writeContainer(value: object, at: string, depth: number): string {
  if (depth > MAX_DEPTH) throw new CanonicalJsonError(`${at}: nested deeper than ${MAX_DEPTH} levels`);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new CanonicalJsonError(`${at}[${index}]: sparse arrays are not allowed`);
      parts.push(write(value[index], `${at}[${index}]`, depth));
    }
    return `[${parts.join(',')}]`;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError(`${at}: only plain objects are allowed`);
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  // The default sort compares UTF-16 code units, the order the extension's canonical form uses.
  for (const key of Object.keys(record).sort()) {
    if (LONE_SURROGATE.test(key)) throw new CanonicalJsonError(`${at}: key has a lone surrogate`);
    const child = record[key];
    if (child === undefined) throw new CanonicalJsonError(`${at}.${key}: undefined is not allowed`);
    parts.push(`${JSON.stringify(key)}:${write(child, `${at}.${key}`, depth)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Canonical JSON: sorted keys, no whitespace, whole numbers only, at most MAX_DEPTH deep; refuses undefined and anything but plain values. */
export function canonicalize(value: unknown): string {
  return write(value, '$', 0);
}

/** `dev-` and the first 32 hex characters of the SHA-256 of the raw 32-byte public key. */
export function fingerprintOf(rawPublicKey: Buffer): string {
  return `dev-${createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 32)}`;
}

/** Exact length, URL-safe alphabet without padding, and a decode and encode round trip. */
export function isStrictBase64url(value: unknown, byteLength: number): value is string {
  if (typeof value !== 'string' || !Number.isInteger(byteLength) || byteLength < 0) return false;
  if (value.length !== Math.ceil((byteLength * 4) / 3) || !BASE64URL_ALPHABET.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === byteLength && decoded.toString('base64url') === value;
}

/** The bytes a signer signs for one envelope (its sig left out). */
export function signingInput(purpose: string, unsigned: Readonly<Record<string, unknown>>): Buffer {
  const { sig: _sig, ...rest } = unsigned;
  return Buffer.concat([Buffer.from(`${PAYLOAD_DOMAIN}\n${purpose}\n`, 'utf8'), Buffer.from(canonicalize(rest), 'utf8')]);
}

function verifySignature(bytes: Buffer, signature: string, publicKey: string): boolean {
  try {
    if (!isStrictBase64url(publicKey, PUBLIC_KEY_BYTES) || !isStrictBase64url(signature, SIGNATURE_BYTES)) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKey, 'base64url')]), format: 'der', type: 'spki' });
    return edVerify(null, bytes, key, Buffer.from(signature, 'base64url'));
  } catch {
    // Any parse or crypto failure means the signature is not valid.
    return false;
  }
}

/** Why an envelope was refused, each with one plain sentence. */
export const ENVELOPE_FAILURES = Object.freeze({
  'malformed': 'This is not a signed item in the format this tool reads.',
  'unsupported-version': 'This was signed in a newer format than this tool reads.',
  'too-large': 'This signed item is larger than the allowed size.',
  'wrong-purpose': 'This signed item was made for a different use than the one it was offered for.',
  'key-mismatch': 'The key named in this signed item does not match its fingerprint.',
  'signed-in-future': 'This signed item claims a signing time in the future, beyond the allowed clock difference.',
  'bad-signature': 'The signature does not match the content, so it was changed or was not made by this key.',
  'unknown-key': 'This key is not in the signer list, so the signature is not trusted.'
} as const);
export type EnvelopeFailure = keyof typeof ENVELOPE_FAILURES;

/** A key the verifier trusts. */
export interface TrustedKey {
  readonly fingerprint: string;
  readonly publicKey: string;
}

export interface VerifyOptions {
  /** The purpose the caller expects. */
  readonly purpose: string;
  readonly keys: readonly TrustedKey[];
  readonly now: Date;
  readonly maxBytes?: number;
}

export type EnvelopeVerdict =
  | { readonly ok: true; readonly payload: unknown; readonly signer: TrustedKey; readonly signedAt: string }
  | { readonly ok: false; readonly reason: EnvelopeFailure; readonly message: string };

const refuse = (reason: EnvelopeFailure): EnvelopeVerdict => ({ ok: false, reason, message: ENVELOPE_FAILURES[reason] });
const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

/**
 * Verifies one envelope. Never throws. The first failing check decides the reason, in this order: shape and version, size, purpose, key and
 * fingerprint, signing time (a valid ISO time no further ahead of the clock than the allowed skew), signature, and finally the trusted keys.
 */
export function verifyEnvelope(envelope: unknown, options: VerifyOptions): EnvelopeVerdict {
  try {
    return check(envelope, options);
  } catch {
    return refuse('malformed');
  }
}

function check(envelope: unknown, options: VerifyOptions): EnvelopeVerdict {
  // Canonicalising first reads the input exactly once; everything below checks the same bytes that were measured.
  let text: string;
  try {
    text = canonicalize(envelope);
  } catch {
    return refuse('malformed');
  }
  const parsed: unknown = JSON.parse(text);
  if (!isPlainRecord(parsed)) return refuse('malformed');
  if (typeof parsed.v === 'number' && Number.isInteger(parsed.v) && parsed.v !== PAYLOAD_VERSION) return refuse('unsupported-version');
  if (parsed.v !== PAYLOAD_VERSION || !hasExactKeys(parsed, ['v', 'purpose', 'signer', 'signedAt', 'payload', 'sig'])) return refuse('malformed');
  const { purpose, signer, signedAt, payload, sig } = parsed;
  if (typeof purpose !== 'string' || typeof signedAt !== 'string' || typeof sig !== 'string') return refuse('malformed');
  // memberId is optional in the extension's signer reference, so it is allowed here and signed like any other field.
  if (!isPlainRecord(signer) || !hasExactKeys(signer, ['fingerprint', 'publicKey'], ['memberId'])) return refuse('malformed');
  if (typeof signer.fingerprint !== 'string' || typeof signer.publicKey !== 'string' || (signer.memberId !== undefined && typeof signer.memberId !== 'string')) return refuse('malformed');
  if (Buffer.byteLength(text, 'utf8') > (options.maxBytes ?? MAX_PAYLOAD_BYTES)) return refuse('too-large');
  if (purpose !== options.purpose) return refuse('wrong-purpose');
  if (!isStrictBase64url(signer.publicKey, PUBLIC_KEY_BYTES)) return refuse('malformed');
  if (fingerprintOf(Buffer.from(signer.publicKey, 'base64url')) !== signer.fingerprint) return refuse('key-mismatch');
  const signedAtMillis = Date.parse(signedAt);
  if (Number.isNaN(signedAtMillis) || new Date(signedAtMillis).toISOString() !== signedAt) return refuse('malformed');
  if (!(options.now instanceof Date) || Number.isNaN(options.now.getTime())) return refuse('malformed');
  if (signedAtMillis > options.now.getTime() + FUTURE_TOLERANCE_MS) return refuse('signed-in-future');
  if (!verifySignature(signingInput(purpose, parsed), sig, signer.publicKey)) return refuse('bad-signature');
  const trusted = options.keys.find((key) => key.fingerprint === signer.fingerprint && key.publicKey === signer.publicKey);
  if (!trusted) return refuse('unknown-key');
  return { ok: true, payload, signer: { fingerprint: signer.fingerprint, publicKey: signer.publicKey }, signedAt };
}
