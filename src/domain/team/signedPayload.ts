// One signer and one verifier for every signed thing that is not a team event (TMR-05, D-08, D-10, D-20, D-21). Pure: no I/O, no vscode.
// Policy bundles (Phase 70), grants (Phase 71), approval answers (Phase 80) and the staff product ledger (design 10, 4.1) all call signPayload and
// verifyPayload and add no second signer.
//
// What is signed: the UTF-8 text of PAYLOAD_DOMAIN, a newline, the purpose and a newline, followed by the canonical JSON of the envelope without sig.
// That text starts with the letter n. A team event is signed as canonical JSON, which starts with {, so a payload signature can never be an event
// signature or the other way round. The purpose is inside the signed bytes, and the verifier takes the purpose it expects from its caller, never
// from the envelope, so a signature made for one purpose never verifies as another.
//
// The signer is any Ed25519 signer with a public key, a fingerprint and a sign function. The person's device identity and Phase 71's per-agent keys
// use the same call. The envelope carries the raw 32 byte public key as base64url, so the NEAR implicit account id (the key bytes in lowercase hex)
// and a DID verification method can be derived offline from it.
//
// Numbers: the canonical form accepts whole numbers only. Money is nano-USD and shares are basis points, never a fraction. A payload with a fraction
// is refused on signing with a plain message.
//
// Rotation and revocation (D-21): a rotated key is refused for payloads whose claimed signedAt is at or after the rotation. The signing time is
// written by the signer, so a copied old key can claim an earlier time and nothing offline can disprove it. Only revoking the key stops that, and a
// revoked key is refused for everything. The messages below say so.
import { CanonicalJsonError, canonicalBytes, canonicalize, fingerprintOf, isStrictBase64url, verifySignature } from './canonical';
import type { KeyState, KeyStatusLookup } from './keyStatus';
import { SecretLeakError, assertNoSecrets } from './secrets';

export const PAYLOAD_DOMAIN = 'near-ai-vscode/signed-payload/v1';
export const PAYLOAD_VERSION = 1;
export const PAYLOAD_PURPOSES = ['policy-bundle', 'grant', 'approval-answer', 'key-record', 'label-map', 'label-declassify', 'staff-ledger', 'staff-ledger-head', 'staff-decision', 'staff-replica'] as const;
export type PayloadPurpose = typeof PAYLOAD_PURPOSES[number];
export const MAX_PAYLOAD_BYTES = 256 * 1024;
const PUBLIC_KEY_BYTES = 32;

export interface PayloadSigner { readonly fingerprint: string; readonly publicKey: string; sign(bytes: Buffer): string }
// memberId is left out when absent: the canonical form refuses an undefined value.
export interface PayloadSignerRef { fingerprint: string; publicKey: string; memberId?: string }

export interface SignedPayload<T = unknown> {
  v: 1;
  purpose: PayloadPurpose;
  signer: PayloadSignerRef;
  // The signer's own claim of the signing time, inside the signed bytes.
  signedAt: string;
  payload: T;
  sig: string;
}

export class PayloadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PayloadError';
  }
}

// Closed list: adding a reason means adding it here with a message and a test. No message uses an em-dash.
export const PAYLOAD_FAILURES = {
  malformed: 'This is not a signed item this version can read.',
  'unsupported-version': 'This was signed in a newer format. Update the extension to check it.',
  'unknown-purpose': 'This signed item is meant for something this version does not know.',
  'wrong-purpose': 'This signed item was made for a different use than the one it was offered for.',
  'too-large': 'This signed item is larger than the allowed size.',
  'key-mismatch': 'The key named in this signed item does not match its fingerprint.',
  'bad-signature': 'The signature does not match the content, so it was changed or was not made by this key.',
  'unknown-key': 'This key is not known on this computer, so the signature cannot be trusted.',
  'key-revoked': 'This key was revoked, so nothing it signed is accepted.',
  'key-rotated': 'This key was replaced by a newer one and this was signed at or after the replacement. The signing time is written by the signer, so a copied old key could claim an earlier time. Only revoking the old key stops that.'
} as const;
export type PayloadFailureReason = keyof typeof PAYLOAD_FAILURES;

export type PayloadVerdict<T = unknown> =
  | { ok: true; payload: T; signer: PayloadSignerRef; signedAt: string; keyState: KeyState }
  | { ok: false; reason: PayloadFailureReason; message: string };

function isPurpose(value: unknown): value is PayloadPurpose {
  return typeof value === 'string' && (PAYLOAD_PURPOSES as readonly string[]).includes(value);
}

// The bytes a signer signs. The purpose in the first lines comes from the envelope being signed or checked.
export function payloadSigningInput(unsigned: Omit<SignedPayload, 'sig'>): Buffer {
  const { sig: _sig, ...rest } = unsigned as SignedPayload;
  return Buffer.concat([Buffer.from(`${PAYLOAD_DOMAIN}\n${unsigned.purpose}\n`, 'utf8'), canonicalBytes(rest)]);
}

// The NEAR implicit account id of an Ed25519 key: the 32 raw key bytes as lowercase hex (64 characters).
export function implicitAccountId(publicKey: string): string {
  if (!isStrictBase64url(publicKey, PUBLIC_KEY_BYTES)) throw new PayloadError('The public key must be 32 bytes written as base64url.');
  return Buffer.from(publicKey, 'base64url').toString('hex');
}

export interface SignPayloadOptions { now?: () => Date; memberId?: string; maxBytes?: number }

// Builds and signs one envelope. It never sees or returns a private key: the signer holds that. Every refusal is a PayloadError with a plain message.
export function signPayload<T>(signer: PayloadSigner, purpose: PayloadPurpose, payload: T, options: SignPayloadOptions = {}): SignedPayload<T> {
  if (!isPurpose(purpose)) throw new PayloadError(`Nothing was signed: "${String(purpose)}" is not a known purpose. Known purposes are ${PAYLOAD_PURPOSES.join(', ')}.`);
  if (!isStrictBase64url(signer.publicKey, PUBLIC_KEY_BYTES) || fingerprintOf(Buffer.from(signer.publicKey, 'base64url')) !== signer.fingerprint) {
    throw new PayloadError('Nothing was signed: the signer\'s public key does not match its fingerprint.');
  }
  const ref: PayloadSignerRef = { fingerprint: signer.fingerprint, publicKey: signer.publicKey };
  if (options.memberId !== undefined) {
    if (typeof options.memberId !== 'string' || options.memberId.length === 0) throw new PayloadError('Nothing was signed: the member id must be a non-empty text.');
    ref.memberId = options.memberId;
  }
  const maxBytes = options.maxBytes ?? MAX_PAYLOAD_BYTES;
  const signedAtDate = (options.now ?? (() => new Date()))();
  if (!(signedAtDate instanceof Date) || Number.isNaN(signedAtDate.getTime())) throw new PayloadError('Nothing was signed: the clock gave no valid time.');
  const unsigned: Omit<SignedPayload<T>, 'sig'> = { v: PAYLOAD_VERSION, purpose, signer: ref, signedAt: signedAtDate.toISOString(), payload };
  let input: Buffer;
  try {
    input = payloadSigningInput(unsigned);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw new PayloadError(`Nothing was signed: ${error.message}. Use plain text, true or false, lists and objects, and whole numbers only (for money use nano-USD or basis points).`);
    }
    throw error;
  }
  try {
    assertNoSecrets(payload, 'signed payload');
  } catch (error) {
    if (error instanceof SecretLeakError) throw new PayloadError(`Nothing was signed: the payload has a secret-like value at ${error.paths[0] ?? '$'}.`);
    throw error;
  }
  const sig = signer.sign(input);
  const signed: SignedPayload<T> = { ...unsigned, sig };
  const size = canonicalBytes(signed).length;
  if (size > maxBytes) throw new PayloadError(`Nothing was signed: the payload is ${size} bytes, which is over the ${maxBytes} byte limit.`);
  if (!verifySignature(input, sig, signer.publicKey)) throw new PayloadError('Nothing was signed: the signer\'s signature does not match its public key.');
  return signed;
}

function refuse(reason: PayloadFailureReason): { ok: false; reason: PayloadFailureReason; message: string } {
  return { ok: false, reason, message: PAYLOAD_FAILURES[reason] };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

export interface VerifyPayloadExpectation { purpose: PayloadPurpose; status: KeyStatusLookup; maxBytes?: number }

// Never throws. The first failing check decides the reason, in this order: shape and version, size, purpose, key and fingerprint, signing time,
// signature, key status.
export function verifyPayload<T = unknown>(envelope: unknown, expected: VerifyPayloadExpectation): PayloadVerdict<T> {
  try {
    return check<T>(envelope, expected);
  } catch {
    // Any unexpected failure on hostile input means the item is not acceptable; the verdict is the refusal, not a thrown error.
    return refuse('malformed');
  }
}

function check<T>(envelope: unknown, expected: VerifyPayloadExpectation): PayloadVerdict<T> {
  // Canonicalising first reads the input exactly once, so everything below checks the same bytes that were measured and returned (a getter that
  // answers differently on a second read cannot show one thing to the check and another to the caller).
  // The input is already parsed JSON in memory, so callers cap what they read before they get here (the key history caps its file at
  // MAX_KEY_HISTORY_BYTES); the size limit below measures the canonical form and is the limit on what is signed and kept.
  let text: string;
  try {
    text = canonicalize(envelope);
  } catch {
    return refuse('malformed');
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (!isPlainRecord(parsed)) return refuse('malformed');
  if (typeof parsed.v === 'number' && Number.isInteger(parsed.v) && parsed.v !== PAYLOAD_VERSION) return refuse('unsupported-version');
  if (parsed.v !== PAYLOAD_VERSION || !hasExactKeys(parsed, ['v', 'purpose', 'signer', 'signedAt', 'payload', 'sig'])) return refuse('malformed');
  const { purpose, signer, signedAt, payload, sig } = parsed;
  if (typeof purpose !== 'string' || typeof signedAt !== 'string' || typeof sig !== 'string') return refuse('malformed');
  if (!isPlainRecord(signer) || !hasExactKeys(signer, ['fingerprint', 'publicKey'], ['memberId'])) return refuse('malformed');
  if (typeof signer.fingerprint !== 'string' || typeof signer.publicKey !== 'string' || (signer.memberId !== undefined && typeof signer.memberId !== 'string')) return refuse('malformed');
  if (bytes > (expected.maxBytes ?? MAX_PAYLOAD_BYTES)) return refuse('too-large');
  if (!isPurpose(purpose)) return refuse('unknown-purpose');
  if (purpose !== expected.purpose) return refuse('wrong-purpose');
  if (!isStrictBase64url(signer.publicKey, PUBLIC_KEY_BYTES)) return refuse('malformed');
  if (fingerprintOf(Buffer.from(signer.publicKey, 'base64url')) !== signer.fingerprint) return refuse('key-mismatch');
  const signedAtMillis = Date.parse(signedAt);
  if (Number.isNaN(signedAtMillis) || new Date(signedAtMillis).toISOString() !== signedAt) return refuse('malformed');
  const { sig: _sig, ...unsigned } = parsed as unknown as SignedPayload;
  if (!verifySignature(payloadSigningInput(unsigned), sig, signer.publicKey)) return refuse('bad-signature');
  const ref: PayloadSignerRef = { fingerprint: signer.fingerprint, publicKey: signer.publicKey };
  if (typeof signer.memberId === 'string') ref.memberId = signer.memberId;
  let status;
  try {
    status = expected.status({ fingerprint: ref.fingerprint, publicKey: ref.publicKey });
  } catch {
    // A status source that fails cannot vouch for the key, so the key is treated as not known.
    return refuse('unknown-key');
  }
  if (status.state === 'revoked') return refuse('key-revoked');
  if (status.state === 'rotated') {
    const since = status.since === undefined ? Number.NaN : Date.parse(status.since);
    // A rotation time that cannot be read cannot clear the signing time, so the key is refused.
    if (Number.isNaN(since) || signedAtMillis >= since) return refuse('key-rotated');
  } else if (status.state !== 'active') {
    return refuse('unknown-key');
  }
  return { ok: true, payload: payload as T, signer: ref, signedAt, keyState: status.state };
}
