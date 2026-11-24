// The signed shapes the sync hub and its clients exchange (D-29, D-35, D-41, D-51, D-60). Hub-side and pure: Node built-ins (node:crypto, and
// node:net for its IPv6 text check) and src/domain only, no clock (the caller passes now), no I/O. The hub (32-19, 32-20) and the extension (32-23,
// 32-24) share these definitions, so the two sides can never disagree about what is signed or checked.
//
// - Hub file (purpose staff-hub-file, extension .near-staff-hub), signed by the hub's own Ed25519 key: the hub id, its public address, the pin of its
//   TLS certificate, its Ed25519 and X25519 public keys with the binding signature, an enrolment id, the one-time enrolment secret and the expiry. The
//   operator prints it with --hub-file and gives it to the lead by any channel; the hub keeps only the secret's hash. It is read as hostile input: text
//   is size-capped before it is parsed, fields are read as own properties only, and parsed input is never spread into a result.
// - Certificate pin: sha256 hex of the certificate's SubjectPublicKeyInfo DER, so a certificate renewed with the same key keeps its pin (D-29).
// - Session answer (purpose staff-hub-session), signed by a device: the hub's writer id, the project, the hub's fresh challenge and 32 bytes of TLS
//   keying material from exportKeyingMaterial(SESSION_KEYING_BYTES, SESSION_KEYING_LABEL), so the answer works only for that hub and project on that
//   one TLS connection (D-35). This module checks the answer against what the hub expects; the device's standing in the roster is the hub's question.
//   Version 2 adds the features the device folds (POST-01, D-07): at most MAX_FEATURES name@N ids, sorted and unique, signed with the rest, so a hub
//   can refuse a session whose features do not cover the project's required set. An answer with no features field reads as an empty announcement.
// - Enrolment MAC: HMAC-SHA256 under the hub file's enrolment secret over the enrolment id, hub id, project, genesis hash and roster head. The lead's
//   device makes it and the hub checks it with the one function here (D-41).
//
// Refusal reasons are a closed record of plain sentences that carry no secret, MAC or key.
import { X509Certificate, createHash, createHmac, createPublicKey, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { canonicalBytes, isStrictBase64url, verifySignature } from '../team/canonical';
import type { KeyStatusLookup } from '../team/keyStatus';
import { signPayload, verifyPayload } from '../team/signedPayload';
import type { PayloadSigner, SignedPayload } from '../team/signedPayload';
import { isRecord } from '../team/validate';
import { HASH_PATTERN, INLINE_BODY_MAX_BYTES, SEALED_OVERHEAD, STREAM_ID_PATTERN, entryHash, parseHeaderShape, writerIdOf } from './entry';
import type { SealedEntry } from './entry';
import { X25519_KEY_BYTES, x25519BindingBytes } from './cellKeys';
import { MAX_FEATURES, isReplicaFeature } from './features';

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

// ---- The session answer (D-35). ----

/** The label both ends pass to TLSSocket.exportKeyingMaterial; it must be identical on the hub and the device. */
export const SESSION_KEYING_LABEL = 'near-ai-hub-session/v1';
export const SESSION_KEYING_BYTES = 32;
export const CHALLENGE_BYTES = 32;
export const SESSION_VERSION = 2;
/** A session answer is well under 1 KiB; anything over this is refused before it is parsed. */
export const SESSION_ANSWER_MAX_BYTES = 8 * 1024;
const SESSION_KEYS = ['v', 'hub', 'project', 'challenge', 'keying', 'features'] as const;
// Every key but features: an answer without the field reads as an empty announcement.
const SESSION_KEYS_WITHOUT_FEATURES = SESSION_KEYS.slice(0, -1);
const BASE64URL_TEXT = /^[A-Za-z0-9_-]+$/;

/**
 * hub is the hub's writer id (64 hex), project the project's stream id (32 hex), challenge and keying base64url of 32 bytes each, features the
 * replica features the device folds (at most MAX_FEATURES name@N ids, sorted and unique). certificate and certificateEntry, only in an answer signed
 * by a person's session key (Phase 33 D-62), are the entry hash of the session.certify that vouches for that key and the sealed entry itself, so the
 * hub can check the chain to the person's device before its first push has stored it. A device's answer carries neither.
 */
export interface SessionAnswerPayload { v: 2; hub: string; project: string; challenge: string; keying: string; features: string[]; certificate?: string; certificateEntry?: SealedEntry }
/** Bytes or their base64url text. */
export type SessionBytes = Uint8Array | string;
/** What the hub expects: its own writer id, the project asked for, the challenge it gave on this connection and this connection's keying material. */
export interface SessionExpectation { hub: string; project: string; challenge: SessionBytes; keying: SessionBytes }
/** features: the replica features the device folds (KNOWN_REPLICA_FEATURES), in any order; signed sorted. None given signs an empty list. */
export interface BuildSessionAnswerInput extends SessionExpectation { features?: readonly string[]; certificateEntry?: SealedEntry; now: Date }

export const SESSION_REFUSALS = {
  malformed: 'This is not a session answer this version can read. Open a new session and answer its challenge.',
  'bad-signature': 'The signature on this session answer does not match its content or its device, so it was not accepted. Open a new session and answer its challenge.',
  'wrong-hub': 'This session answer was made for a different hub. Open a new session with this hub and answer its challenge.',
  'wrong-project': 'This session answer was made for a different project. Open a new session for this project and answer its challenge.',
  'wrong-challenge': 'This session answer does not answer the challenge this hub gave. Open a new session and answer its challenge.',
  'wrong-connection': 'This session answer was made on a different connection to the hub. Open a new session on this connection and answer its challenge.'
} as const;
export type SessionRefusal = keyof typeof SESSION_REFUSALS;
export type SessionFailure = { ok: false; reason: SessionRefusal; message: string };
export type SessionRead = { ok: true; publicKey: string; writer: string; features: string[]; certificate?: string; certificateEntry?: SealedEntry } | SessionFailure;

const refuseSession = (reason: SessionRefusal): SessionFailure => ({ ok: false, reason, message: SESSION_REFUSALS[reason] });

// Bytes as base64url text, or undefined when the value is neither bytes nor strict base64url text of that length.
function sessionText(value: unknown, bytes: number): string | undefined {
  if (value instanceof Uint8Array) return value.length === bytes ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64url') : undefined;
  return isKey(value, bytes) ? value : undefined;
}

// Bytes from bytes or base64url text, for a comparison; an empty buffer for anything else, so the length check refuses it.
function sessionBytes(value: unknown): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return typeof value === 'string' && BASE64URL_TEXT.test(value) ? Buffer.from(value, 'base64url') : Buffer.alloc(0);
}

// Constant time for equal lengths; a length that differs is refused without comparing.
function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

// A feature list read from hostile input as a fresh copy: an array of at most MAX_FEATURES name@N ids in strictly increasing order (so sorted and
// unique), or undefined.
function featureListOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_FEATURES) return undefined;
  const list: string[] = [];
  for (const id of value as unknown[]) {
    if (!isReplicaFeature(id)) return undefined;
    const last = list[list.length - 1];
    if (last !== undefined && !(last < id)) return undefined;
    list.push(id);
  }
  return list;
}

function sessionPayloadOf(value: unknown): SessionAnswerPayload | undefined {
  if (!isRecord(value)) return undefined;
  // A session key's answer carries both certificate fields or neither.
  const certified = Object.prototype.hasOwnProperty.call(value, 'certificate');
  const extra = certified ? ['certificate', 'certificateEntry'] : [];
  const announced = hasKeys(value, [...SESSION_KEYS, ...extra]);
  if (!announced && !hasKeys(value, [...SESSION_KEYS_WITHOUT_FEATURES, ...extra])) return undefined;
  const certificateEntry = certified ? certificateEntryOf(own(value, 'certificateEntry')) : undefined;
  if (certified && (certificateEntry === undefined || entryHash(certificateEntry.header) !== own(value, 'certificate'))) return undefined;
  const [v, hub, project, challenge, keying] = SESSION_KEYS_WITHOUT_FEATURES.map((key) => own(value, key));
  if (v !== SESSION_VERSION || !isHash(hub) || typeof project !== 'string' || !STREAM_ID_PATTERN.test(project)) return undefined;
  if (!isKey(challenge, CHALLENGE_BYTES) || !isKey(keying, SESSION_KEYING_BYTES)) return undefined;
  const features = announced ? featureListOf(own(value, 'features')) : [];
  if (features === undefined) return undefined;
  return { v: SESSION_VERSION, hub, project, challenge, keying, features, ...(certificateEntry === undefined ? {} : { certificate: entryHash(certificateEntry.header), certificateEntry }) };
}

// A sealed entry read from hostile input as a fresh copy: an exact header and a base64url body no larger than an inline body, or undefined.
function certificateEntryOf(value: unknown): SealedEntry | undefined {
  if (!isRecord(value) || !hasKeys(value, ['header', 'body'])) return undefined;
  const shape = parseHeaderShape(own(value, 'header'));
  const body = own(value, 'body');
  if (!shape.ok || typeof body !== 'string' || !BASE64URL_TEXT.test(body) || body.length > Math.ceil(((INLINE_BODY_MAX_BYTES + SEALED_OVERHEAD) * 4) / 3)) return undefined;
  return { header: shape.header, body };
}

// The caller's features as a sorted copy, or the value itself when it is not a list, so the shape check refuses it. None given is an empty list.
function sortedFeatures(value: unknown): unknown {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...(value as unknown[])].sort() : value;
}

// Signs a device's answer to the hub's challenge. Throws a plain error when a field is not valid.
export function buildSessionAnswer(signer: PayloadSigner, input: BuildSessionAnswerInput): SignedPayload<SessionAnswerPayload> {
  const challenge = sessionText(input.challenge, CHALLENGE_BYTES);
  const keying = sessionText(input.keying, SESSION_KEYING_BYTES);
  const certificate = input.certificateEntry === undefined ? {} : { certificate: entryHash(input.certificateEntry.header), certificateEntry: input.certificateEntry };
  const payload = { v: SESSION_VERSION, hub: input.hub, project: input.project, challenge, keying, features: sortedFeatures(input.features), ...certificate };
  const checked = sessionPayloadOf(payload);
  if (checked === undefined) {
    throw new Error(`The session answer was not made: the hub must be a writer id, the project a project id, the challenge and keying material 32 bytes each, and the features at most ${String(MAX_FEATURES)} different feature ids such as require@1.`);
  }
  return signPayload(signer, 'staff-hub-session', checked, { now: () => input.now });
}

// The hub's check of a session answer (its JSON text or its parsed content) against what it expects on this connection. Checks, in order: size and
// shape, the signature by the key the envelope names, then the hub, the project, the challenge and the keying material, with the last two compared in
// constant time. Returns the device's key, writer id and announced features; whether that device may open a session is the roster's answer, and
// whether its features cover the project's required set is the hub's check. Never throws.
export function readSessionAnswer(answer: unknown, expected: SessionExpectation): SessionRead {
  try {
    const input = inputValue(answer, SESSION_ANSWER_MAX_BYTES);
    if (!input.ok) return refuseSession('malformed');
    const value = input.value;
    if (!isRecord(value)) return refuseSession('malformed');
    const payload = sessionPayloadOf(own(value, 'payload'));
    const signer = own(value, 'signer');
    const publicKey = isRecord(signer) ? own(signer, 'publicKey') : undefined;
    if (payload === undefined || !isKey(publicKey, ED25519_PUBLIC_BYTES)) return refuseSession('malformed');
    const verdict = verifyPayload<unknown>(value, { purpose: 'staff-hub-session', status: onlyKey(publicKey), maxBytes: SESSION_ANSWER_MAX_BYTES });
    if (!verdict.ok) return refuseSession(verdict.reason === 'bad-signature' || verdict.reason === 'unknown-key' || verdict.reason === 'key-mismatch' ? 'bad-signature' : 'malformed');
    if (payload.hub !== expected.hub) return refuseSession('wrong-hub');
    if (payload.project !== expected.project) return refuseSession('wrong-project');
    if (!sameBytes(Buffer.from(payload.challenge, 'base64url'), sessionBytes(expected.challenge))) return refuseSession('wrong-challenge');
    if (!sameBytes(Buffer.from(payload.keying, 'base64url'), sessionBytes(expected.keying))) return refuseSession('wrong-connection');
    const certificate = payload.certificateEntry === undefined ? {} : { certificate: payload.certificate as string, certificateEntry: payload.certificateEntry };
    return { ok: true, publicKey, writer: writerIdOf(publicKey), features: payload.features, ...certificate };
  } catch {
    // Hostile input never throws out of the check.
    return refuseSession('malformed');
  }
}

// ---- The enrolment MAC (D-41). ----

/** hub is the hub id from the hub file (hubIdOf of its writer id), as hub.admit names it. */
export interface EnrolmentMacFields { enrolment: string; hub: string; project: string; genesisHash: string; rosterHead: string }

const MAC_BYTES = 32;

function enrolmentMessage(fields: EnrolmentMacFields): Buffer {
  // Only these five fields, copied by name, so an extra property on the input is never covered.
  return canonicalBytes({ enrolment: fields.enrolment, hub: fields.hub, project: fields.project, genesisHash: fields.genesisHash, rosterHead: fields.rosterHead });
}

// HMAC-SHA256 under the enrolment secret over the canonical bytes of the five fields, as base64url. Throws a plain error, naming no secret, when the
// secret is not 32 bytes of base64url.
export function enrolmentMac(secret: string, fields: EnrolmentMacFields): string {
  if (!isKey(secret, ENROLMENT_SECRET_BYTES)) throw new Error('The enrolment check was not made: the enrolment secret must be 32 bytes written as base64url.');
  return createHmac('sha256', Buffer.from(secret, 'base64url')).update(enrolmentMessage(fields)).digest('base64url');
}

// True only for the MAC of exactly these fields under this secret, compared in constant time. False, never a throw, for anything else.
export function checkEnrolmentMac(secret: string, fields: EnrolmentMacFields, mac: string): boolean {
  try {
    if (!isKey(mac, MAC_BYTES)) return false;
    return sameBytes(Buffer.from(enrolmentMac(secret, fields), 'base64url'), Buffer.from(mac, 'base64url'));
  } catch {
    return false;
  }
}
