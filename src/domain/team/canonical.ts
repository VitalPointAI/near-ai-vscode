// Canonical JSON, signing input and Ed25519 verification for the team event log (D-06).
// The canonical form is signed into every event forever, so this file is frozen by the vectors in teamCanonical.test.ts.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import type { TeamEvent, UnsignedTeamEvent } from './types';

export const MAX_DEPTH = 16;
export const MAX_EVENT_BYTES = 16 * 1024;
const MAX_FILE_LAMPORT = 999_999_999_999;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
// 12-byte SPKI prefix for Ed25519 followed by the 32 raw public key bytes.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;

export class CanonicalJsonError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

// Containers nest at most MAX_DEPTH deep: 16 nested arrays are accepted, 17 are rejected.
function write(value: unknown, path: string, depth: number): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (Object.is(value, -0)) throw new CanonicalJsonError(`${path}: negative zero is not allowed`);
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`${path}: numbers must be safe integers`);
      return String(value);
    case 'string':
      if (LONE_SURROGATE.test(value)) throw new CanonicalJsonError(`${path}: lone surrogate in string`);
      return JSON.stringify(value);
    case 'object':
      return writeContainer(value, path, depth + 1);
    default:
      throw new CanonicalJsonError(`${path}: ${typeof value} is not allowed`);
  }
}

function writeContainer(value: object, path: string, depth: number): string {
  if (depth > MAX_DEPTH) throw new CanonicalJsonError(`${path}: nested deeper than ${MAX_DEPTH} levels`);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new CanonicalJsonError(`${path}[${index}]: sparse arrays are not allowed`);
      parts.push(write(value[index], `${path}[${index}]`, depth));
    }
    return `[${parts.join(',')}]`;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError(`${path}: only plain objects are allowed`);
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  // The default sort compares UTF-16 code units, which is the order D-06 requires.
  for (const key of Object.keys(record).sort()) {
    if (LONE_SURROGATE.test(key)) throw new CanonicalJsonError(`${path}: key has a lone surrogate`);
    const child = record[key];
    if (child === undefined) throw new CanonicalJsonError(`${path}.${key}: undefined is not allowed`);
    parts.push(`${JSON.stringify(key)}:${write(child, `${path}.${key}`, depth)}`);
  }
  return `{${parts.join(',')}}`;
}

export function canonicalize(value: unknown): string {
  return write(value, '$', 0);
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8');
}

// Canonical bytes of the envelope with the signature removed: this is what a device signs.
export function signingInput(event: UnsignedTeamEvent | TeamEvent): Buffer {
  const { sig: _sig, ...rest } = event as TeamEvent;
  return canonicalBytes(rest);
}

function assertFileLamport(lamport: number): void {
  if (!Number.isSafeInteger(lamport) || lamport < 0 || lamport > MAX_FILE_LAMPORT) throw new RangeError('lamport must be an integer from 0 to 999999999999');
}

export function eventPath(event: { lamport: number; id: string }): string {
  assertFileLamport(event.lamport);
  return `events/${String(event.lamport).padStart(12, '0')}-${event.id}.json`;
}

export function snapshotPath(lamport: number): string {
  assertFileLamport(lamport);
  return `snapshots/${String(lamport).padStart(12, '0')}.json`;
}

export function fingerprintOf(publicKeyRaw: Buffer): string {
  return `dev-${createHash('sha256').update(publicKeyRaw).digest('hex').slice(0, 32)}`;
}

// Exact length, URL-safe alphabet without padding, and a decode/encode round trip so non-canonical trailing bits are rejected.
export function isStrictBase64url(value: string, byteLength: number): boolean {
  if (typeof value !== 'string' || !Number.isInteger(byteLength) || byteLength < 0) return false;
  const expectedLength = Math.ceil((byteLength * 4) / 3);
  if (value.length !== expectedLength || !BASE64URL_ALPHABET.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === byteLength && decoded.toString('base64url') === value;
}

export function verifySignature(bytes: Buffer, signature: string, publicKey: string): boolean {
  try {
    if (!isStrictBase64url(publicKey, PUBLIC_KEY_BYTES) || !isStrictBase64url(signature, SIGNATURE_BYTES)) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKey, 'base64url')]), format: 'der', type: 'spki' });
    return edVerify(null, bytes, key, Buffer.from(signature, 'base64url'));
  } catch {
    // Any parse or crypto failure means the signature is not valid; the verdict is the false return, not a thrown error.
    return false;
  }
}

export function verifyEventSignature(event: TeamEvent, publicKey: string): boolean {
  try {
    return verifySignature(signingInput(event), event.sig, publicKey);
  } catch {
    // An event that cannot be canonicalised cannot carry a valid signature.
    return false;
  }
}
