// The signed shapes the sync hub and its clients exchange (D-29, D-35, D-41, D-51, D-60). Hub-side and pure: Node built-ins (node:crypto, and
// node:net for its IPv6 text check) and src/domain only, no clock (the caller passes now), no I/O. The hub (32-19, 32-20) and the extension (32-23,
// 32-24) share these definitions, so the two sides can never disagree about what is signed or checked.
//
// - Hub file (purpose staff-hub-file, extension .near-staff-hub), signed by the hub's own Ed25519 key: the hub id, its public address, the pin of its
//   TLS certificate, its Ed25519 and X25519 public keys with the binding signature, an enrolment id, the one-time enrolment secret and the expiry. The
//   operator prints it with --hub-file and gives it to the lead by any channel; the hub keeps only the secret's hash. It is read as hostile input: text
//   is size-capped before it is parsed, fields are read as own properties only, and parsed input is never spread into a result.
// - Certificate pin: sha256 hex of the certificate's SubjectPublicKeyInfo DER, so a certificate renewed with the same key keeps its pin (D-29).
//
// Refusal reasons are a closed record of plain sentences that carry no secret, MAC or key.
import { X509Certificate, createHash, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { canonicalBytes, isStrictBase64url, verifySignature } from '../team/canonical';
import type { KeyStatusLookup } from '../team/keyStatus';
import { signPayload, verifyPayload } from '../team/signedPayload';
import type { PayloadSigner, SignedPayload } from '../team/signedPayload';
import { isRecord } from '../team/validate';
import { HASH_PATTERN, writerIdOf } from './entry';
import { X25519_KEY_BYTES, x25519BindingBytes } from './cellKeys';

export const HUB_FILE_EXTENSION = '.near-staff-hub';
export const HUB_FILE_VERSION = 1;
/** A hub file is a few hundred bytes; anything over this is refused before it is parsed. */
export const HUB_FILE_MAX_BYTES = 16 * 1024;
export const ENROLMENT_SECRET_BYTES = 32;
/** A hub id: hub- and the first 16 hex characters of the hub's writer id, a slug the roster's hub.admit carries. */
export const HUB_ID_PATTERN = /^hub-[0-9a-f]{16}$/;
/** An enrolment id: enr- and 16 hex characters. */
export const ENROLMENT_ID_PATTERN = /^enr-[0-9a-f]{16}$/;
const MAX_ADDRESS_CHARS = 253;
const ED25519_PUBLIC_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HUB_FILE_KEYS = ['v', 'hub', 'address', 'certPin', 'publicKey', 'writer', 'x25519', 'x25519Sig', 'enrolment', 'enrolmentSecret', 'expiresAt'] as const;

export interface HubFilePayload {
  v: 1;
  hub: string;
  address: string;
  certPin: string;
  publicKey: string;
  writer: string;
  x25519: string;
  x25519Sig: string;
  enrolment: string;
  enrolmentSecret: string;
  expiresAt: string;
}

export const HUB_FILE_REFUSALS = {
  malformed: 'This is not a hub file this version can read. Ask the hub operator for a new hub file.',
  'too-large': 'This file is larger than a hub file can be, so it was not opened. Ask the hub operator for a new hub file.',
  'bad-signature': 'The signature on this hub file does not match its content or the hub\'s key, so it was changed or made by someone else. Ask the hub operator for a new hub file.',
  expired: 'This hub file has expired. Ask the hub operator for a new hub file.',
  'bad-binding': 'The two keys in this hub file do not belong together, so it cannot be used. Ask the hub operator for a new hub file.'
} as const;
export type HubFileRefusal = keyof typeof HUB_FILE_REFUSALS;
export type HubFileFailure = { ok: false; reason: HubFileRefusal; message: string };
export type HubFileRead = { ok: true; hubFile: HubFilePayload } | HubFileFailure;

const refuseFile = (reason: HubFileRefusal): HubFileFailure => ({ ok: false, reason, message: HUB_FILE_REFUSALS[reason] });

// An own property of a parsed record, never one inherited from a prototype.
const own = (record: Record<string, unknown>, key: string): unknown => (Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined);
// Every required key present and nothing else. Object.keys lists own keys only, so a parsed "__proto__" key is an extra key.
const hasKeys = (value: Record<string, unknown>, required: readonly string[]): boolean => {
  const present = Object.keys(value);
  return present.length === required.length && required.every((key) => present.includes(key));
};
const isKey = (value: unknown, bytes: number): value is string => typeof value === 'string' && isStrictBase64url(value, bytes);
const isTime = (value: unknown): value is string => typeof value === 'string' && ISO_TIME.test(value) && new Date(Date.parse(value)).toISOString() === value;
const isHash = (value: unknown): value is string => typeof value === 'string' && HASH_PATTERN.test(value);

// Input as it arrives: JSON text, measured before it is parsed, or a value a caller already parsed, measured by its canonical form. A value that has
// no canonical form (a function, a cycle, a non-plain object) is malformed.
function inputValue(value: unknown, maxBytes: number): { ok: true; value: unknown } | { ok: false; tooLarge: boolean } {
  try {
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > maxBytes) return { ok: false, tooLarge: true };
      return { ok: true, value: JSON.parse(value) as unknown };
    }
    if (canonicalBytes(value).length > maxBytes) return { ok: false, tooLarge: true };
    return { ok: true, value };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

// The envelope's signer must be the key the payload names, so the status lookup answers active for that key only.
const onlyKey = (publicKey: string): KeyStatusLookup => (key) => ({ state: key.publicKey === publicKey ? 'active' : 'unknown' });

/** The hub id of a hub's writer id: hub- and its first 16 hex characters. Throws a plain error for text that is not a writer id. */
export function hubIdOf(writer: string): string {
  if (!isHash(writer)) throw new Error('A hub id is made from a writer id, which is 64 lowercase hex characters.');
  return `hub-${writer.slice(0, 16)}`;
}

const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4_SHAPE = /^\d+(?:\.\d+){3}$/;
const IPV4_OCTET = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const PORT = /^[1-9]\d{0,4}$/;

function isHost(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) return isIPv6(host.slice(1, -1));
  if (IPV4_SHAPE.test(host)) return host.split('.').every((octet) => IPV4_OCTET.test(octet));
  const labels = host.split('.');
  // A name whose last label is all digits is neither a DNS name nor a valid IPv4 address (999.0.2.10 was refused above, 192.0.2 is refused here).
  return labels.every((label) => DNS_LABEL.test(label)) && !/^\d+$/.test(labels[labels.length - 1] as string);
}

/** A hub's public address: a DNS name, an IPv4 address or a bracketed IPv6 address, a colon and a port 1 to 65535, at most 253 characters. */
export function isHubAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ADDRESS_CHARS) return false;
  const colon = value.lastIndexOf(':');
  if (colon <= 0) return false;
  const host = value.slice(0, colon);
  const port = value.slice(colon + 1);
  if (!PORT.test(port) || Number(port) > 65535) return false;
  return isHost(host);
}

/** The pin of a public key (or of a private key's public half): sha256 hex of its SubjectPublicKeyInfo DER. */
export function spkiPin(key: KeyObject): string {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

/** The pin of a certificate given as PEM text or DER bytes. Throws a plain error for anything that is not a certificate. */
export function certPinOf(certificate: string | Buffer): string {
  let parsed: X509Certificate;
  try {
    parsed = new X509Certificate(certificate);
  } catch {
    throw new Error('This is not a certificate the hub can use. Give the hub\'s certificate as PEM text or DER bytes.');
  }
  return spkiPin(parsed.publicKey);
}

/** A hub file payload read from hostile input: exact keys, every field of its shape, and the hub id and writer id derived from the signing key. */
function hubFilePayloadOf(value: unknown): HubFilePayload | undefined {
  if (!isRecord(value) || !hasKeys(value, HUB_FILE_KEYS)) return undefined;
  const [v, hub, address, certPin, publicKey, writer, x25519, x25519Sig, enrolment, enrolmentSecret, expiresAt] = HUB_FILE_KEYS.map((key) => own(value, key));
  if (v !== HUB_FILE_VERSION || !isHubAddress(address) || !isHash(certPin)) return undefined;
  if (!isKey(publicKey, ED25519_PUBLIC_BYTES) || !isKey(x25519, X25519_KEY_BYTES) || !isKey(x25519Sig, ED25519_SIGNATURE_BYTES)) return undefined;
  if (typeof writer !== 'string' || writer !== writerIdOf(publicKey) || typeof hub !== 'string' || hub !== hubIdOf(writer)) return undefined;
  if (typeof enrolment !== 'string' || !ENROLMENT_ID_PATTERN.test(enrolment) || !isKey(enrolmentSecret, ENROLMENT_SECRET_BYTES) || !isTime(expiresAt)) return undefined;
  return { v: HUB_FILE_VERSION, hub, address, certPin, publicKey, writer, x25519, x25519Sig, enrolment, enrolmentSecret, expiresAt };
}

const isBound = (file: Pick<HubFilePayload, 'x25519' | 'x25519Sig' | 'writer' | 'publicKey'>): boolean => verifySignature(x25519BindingBytes(file.x25519, file.writer), file.x25519Sig, file.publicKey);

/** x25519Sig is the hub's Ed25519 signature over x25519BindingBytes(x25519, the hub's writer id). now is the signing time; expiresAt must be after it. */
export interface BuildHubFileInput {
  address: string;
  certPin: string;
  x25519: string;
  x25519Sig: string;
  enrolment: string;
  enrolmentSecret: string;
  expiresAt: string;
  now: Date;
}

// Signs a hub file with the hub's own key. Throws a plain error, naming no secret, when a field is not valid, the expiry is not after now or the
// X25519 key is not bound to the signing key.
export function buildHubFile(signer: PayloadSigner, input: BuildHubFileInput): SignedPayload<HubFilePayload> {
  const writer = writerIdOf(signer.publicKey);
  const payload: HubFilePayload = {
    v: HUB_FILE_VERSION,
    hub: hubIdOf(writer),
    address: input.address,
    certPin: input.certPin,
    publicKey: signer.publicKey,
    writer,
    x25519: input.x25519,
    x25519Sig: input.x25519Sig,
    enrolment: input.enrolment,
    enrolmentSecret: input.enrolmentSecret,
    expiresAt: input.expiresAt
  };
  if (!isHubAddress(payload.address)) throw new Error('The hub file was not made: the address must be a host name or IP address and a port, such as hub.example.org:8443.');
  if (hubFilePayloadOf(payload) === undefined) throw new Error('The hub file was not made: one of its fields is not valid.');
  if (Date.parse(payload.expiresAt) <= input.now.getTime()) throw new Error('The hub file was not made: its expiry must be after the time it is made.');
  if (!isBound(payload)) throw new Error('The hub file was not made: the X25519 key is not bound to the hub\'s signing key.');
  return signPayload(signer, 'staff-hub-file', payload, { now: () => input.now });
}

// Reads a hub file (its JSON text or its parsed content) at time now. Checks, in order: size before parsing, shape (with the writer id and hub id
// derived from the named key), that the named key signed it, the X25519 binding, then the expiry (a file read at the expiry instant is still good).
// Whether the hub may hold the project is the roster's answer, written by hub.admit. Never throws.
export function readHubFile(file: unknown, now: Date): HubFileRead {
  try {
    const input = inputValue(file, HUB_FILE_MAX_BYTES);
    if (!input.ok) return refuseFile(input.tooLarge ? 'too-large' : 'malformed');
    const value = input.value;
    const payload = isRecord(value) ? hubFilePayloadOf(own(value, 'payload')) : undefined;
    if (payload === undefined) return refuseFile('malformed');
    const verdict = verifyPayload<unknown>(value, { purpose: 'staff-hub-file', status: onlyKey(payload.publicKey), maxBytes: HUB_FILE_MAX_BYTES });
    if (!verdict.ok) return refuseFile(verdict.reason === 'bad-signature' || verdict.reason === 'unknown-key' ? 'bad-signature' : 'malformed');
    if (!isBound(payload)) return refuseFile('bad-binding');
    if (now.getTime() > Date.parse(payload.expiresAt)) return refuseFile('expired');
    return { ok: true, hubFile: payload };
  } catch {
    // Hostile input never throws out of the reader.
    return refuseFile('malformed');
  }
}
