// Base TDF objects from the public OpenTDF specification (Phase 45.1, D-07, XCHG-04): a manifest and an encrypted payload, the payload key wrapped to a
// partner's public key, and an object addressed to your organization opened through a decrypt callback (OpenBao Transit at a site, a test key in tests).
// Pure apart from node:crypto: no I/O, no clock, no vscode, no package. The ZIP container is packed where the file is handed over.
//
// Every choice here is recorded with its source in 45.1-RESEARCH.md: the OpenTDF specification at commit 0a30366b (VERSION 4.3.0) and, where the text is
// silent, the reference implementation (opentdf/platform at f353c9b6). The wrapping (RSA-OAEP with the hash the recipient names, or ECDH on P-256 with
// HKDF-SHA256 and the salt SHA-256("TDF")), the policy binding (Base64 of the hex HMAC-SHA256), the GMAC segment hashes and HS256 root signature, and the
// assertion's JWS follow the reference, so a partner's TDF tools can read the object. Interoperability is unverified until Phase 45.2's round trip.
// Nothing here is ZTDF or XML; the label travels in one assertion holding your organization's signed label binding (45.1-01).
import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, privateDecrypt,
  publicEncrypt, randomBytes, randomUUID, timingSafeEqual, constants as cryptoConstants
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { canonicalBytes } from '../team/canonical';
import type { LabelInteropTable } from '../gate/labelInteropSection';
import type { Label } from '../gate/labels';
import { contentHashOf, verifyLabelBinding } from './labelBinding';
import type { LabelBinding, LabelBindingRefusal } from './labelBinding';
import { mapIn } from './labelInterop';
import type { ExternalLabel } from './labelInterop';

export const TDF_FORMAT = 'tdf';
export const TDF_SPEC_VERSION = '4.3.0';
export const TDF_PAYLOAD_NAME = '0.payload';
export const TDF_LABEL_ASSERTION_ID = 'label-binding';
export const TDF_KEY_ALGORITHMS = Object.freeze(['ec:secp256r1', 'rsa:2048'] as const);
export type TdfKeyAlgorithm = (typeof TDF_KEY_ALGORITHMS)[number];
export const OAEP_HASHES = Object.freeze(['sha1', 'sha256'] as const);
export type OaepHash = (typeof OAEP_HASHES)[number];

const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SEGMENT_OVERHEAD = NONCE_BYTES + TAG_BYTES;
export const DEFAULT_SEGMENT_BYTES = 2 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
const MAX_SEGMENTS = 4096;
const MIN_RSA_BITS = 2048;
const TDF_SALT = createHash('sha256').update('TDF').digest();
const JWS_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

/** A partner's key, as your organization holds it for one export. 45.2-06 moves where these come from into its partner records (hand-off H-2). */
export interface TdfRecipient {
  readonly url: string;
  readonly kid: string;
  readonly alg: TdfKeyAlgorithm;
  /** SPKI PEM. */
  readonly publicKey: string;
  /** RSA only, and required: the OAEP hash the partner's server unwraps with (the OpenTDF reference server uses sha1, 45.1-RESEARCH section 5). */
  readonly oaepHash?: OaepHash;
}

/** A TDF object as two parts: the manifest (manifest.json) and the encrypted payload (0.payload). */
export interface TdfObject {
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly payload: Uint8Array;
}

/** The key access a decrypt callback is asked to open. */
export interface TdfKeyAccess {
  readonly type: 'wrapped' | 'ec-wrapped';
  readonly url: string;
  readonly kid?: string;
  readonly wrappedKey: Uint8Array;
  /** EC only: the sender's one-time public key, SPKI PEM. */
  readonly ephemeralPublicKey?: string;
}

export const TDF_REFUSALS = Object.freeze({
  'malformed': 'This file is not a TDF object this version can read.',
  'unsupported': 'This TDF object uses something this version does not read yet.',
  'key-access': 'The key of this TDF object could not be opened with your organization\'s receiving key.',
  'policy-binding': 'The policy of this TDF object does not match its key, so it was changed.',
  'integrity': 'The content of this TDF object does not match its integrity record, so it was changed.',
  'payload': 'The content of this TDF object could not be decrypted, so it was changed or damaged.',
  'assertion': 'A statement in this TDF object does not match its binding, so it was changed or moved from another object.',
  'no-label': 'This TDF object carries no label binding from a sender your organization works with.',
  'signer-unknown': 'The label of this TDF object was bound by a key your organization does not know.',
  'label-binding': 'The label of this TDF object does not match its signed binding, or the content changed after it was bound.',
  'label-mapping': 'The label of this TDF object cannot be read through your organization\'s table for allies.'
} as const);
export type TdfRefusal = keyof typeof TDF_REFUSALS;

export class TdfError extends Error {
  public readonly reason: TdfRefusal;

  public constructor(reason: TdfRefusal) {
    super(TDF_REFUSALS[reason]);
    this.name = 'TdfError';
    this.reason = reason;
  }
}

export type TdfReadResult =
  | { readonly ok: true; readonly content: Uint8Array; readonly label: Label; readonly external: ExternalLabel; readonly binding: LabelBinding; readonly mimeType: string }
  | { readonly ok: false; readonly reason: TdfRefusal; readonly message: string; readonly bindingReason?: LabelBindingRefusal };

function refuse(reason: TdfRefusal, bindingReason?: LabelBindingRefusal): Extract<TdfReadResult, { ok: false }> {
  return Object.freeze({ ok: false, reason, message: TDF_REFUSALS[reason], ...(bindingReason === undefined ? {} : { bindingReason }) });
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const hmac = (key: Uint8Array, data: Uint8Array | string): Buffer => createHmac('sha256', key).update(data).digest();

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function sameText(a: string, b: string): boolean {
  return sameBytes(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Key wrapping (45.1-RESEARCH findings 3 and 5)

function readPublicKey(recipient: TdfRecipient): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(recipient.publicKey);
  } catch {
    throw new TdfError('malformed');
  }
  const details = key.asymmetricKeyDetails ?? {};
  if (recipient.alg === 'ec:secp256r1' && (key.asymmetricKeyType !== 'ec' || details.namedCurve !== 'prime256v1')) throw new TdfError('unsupported');
  if (recipient.alg === 'rsa:2048' && (key.asymmetricKeyType !== 'rsa' || (details.modulusLength ?? 0) < MIN_RSA_BITS)) throw new TdfError('unsupported');
  return key;
}

function ecSessionKey(privateKey: KeyObject, publicKey: KeyObject): Buffer {
  const shared = diffieHellman({ privateKey, publicKey });
  return Buffer.from(hkdfSync('sha256', shared, TDF_SALT, Buffer.alloc(0), KEY_BYTES));
}

function seal(key: Uint8Array, plaintext: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER, key, nonce);
  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** AES-256-GCM sealed as nonce, ciphertext, tag; undefined when it does not open. */
function open(key: Uint8Array, sealed: Uint8Array): Buffer | undefined {
  if (sealed.length < SEGMENT_OVERHEAD) return undefined;
  try {
    const decipher = createDecipheriv(CIPHER, key, sealed.subarray(0, NONCE_BYTES));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch {
    return undefined;
  }
}

function wrapFor(recipient: TdfRecipient, payloadKey: Uint8Array): { type: 'wrapped' | 'ec-wrapped'; wrappedKey: string; ephemeralPublicKey?: string } {
  const key = readPublicKey(recipient);
  if (recipient.alg === 'rsa:2048') {
    if (recipient.oaepHash === undefined || !(OAEP_HASHES as readonly string[]).includes(recipient.oaepHash)) throw new TdfError('unsupported');
    return { type: 'wrapped', wrappedKey: b64(publicEncrypt({ key, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: recipient.oaepHash }, payloadKey)) };
  }
  const ephemeral = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sealed = seal(ecSessionKey(ephemeral.privateKey, key), payloadKey);
  return { type: 'ec-wrapped', wrappedKey: b64(sealed), ephemeralPublicKey: ephemeral.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/**
 * Opens a key access with a private key held in process: an EC key (ECDH and HKDF) or an RSA key with the OAEP hash it was wrapped with. For tests and
 * for keys a site holds as an envelope; your organization's receiving key is opened inside OpenBao Transit instead. Throws TdfError('key-access').
 */
export function unwrapWithPrivateKey(access: TdfKeyAccess, privateKeyPem: string, oaepHash: OaepHash = 'sha256'): Uint8Array {
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    if (access.type === 'wrapped') return new Uint8Array(privateDecrypt({ key: privateKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash }, access.wrappedKey));
    if (access.ephemeralPublicKey === undefined) throw new TdfError('key-access');
    const opened = open(ecSessionKey(privateKey, createPublicKey(access.ephemeralPublicKey)), access.wrappedKey);
    if (opened === undefined) throw new TdfError('key-access');
    return new Uint8Array(opened);
  } catch {
    throw new TdfError('key-access');
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The assertion and its JWS (45.1-RESEARCH findings 8 and 9)

/** The fields of an assertion the reference hashes, in its projection: no binding, `appliesToState` and `schema` only when present. */
function assertionHash(assertion: Readonly<Record<string, unknown>>): Buffer {
  const statement = assertion['statement'] as Readonly<Record<string, unknown>>;
  const projected: Record<string, unknown> = {
    id: assertion['id'], type: assertion['type'], scope: assertion['scope'],
    statement: { format: statement['format'], value: statement['value'], ...(statement['schema'] === undefined ? {} : { schema: statement['schema'] }) }
  };
  if (assertion['appliesToState'] !== undefined) projected['appliesToState'] = assertion['appliesToState'];
  return createHash('sha256').update(canonicalBytes(projected)).digest();
}

function assertionJws(assertion: Readonly<Record<string, unknown>>, aggregate: Uint8Array, payloadKey: Uint8Array): string {
  const hash = assertionHash(assertion);
  const claims = Buffer.from(JSON.stringify({ assertionHash: hash.toString('hex'), assertionSig: b64(Buffer.concat([aggregate, hash])) })).toString('base64url');
  const signature = hmac(payloadKey, `${JWS_HEADER}.${claims}`).toString('base64url');
  return `${JWS_HEADER}.${claims}.${signature}`;
}

function checkAssertionJws(assertion: Readonly<Record<string, unknown>>, aggregate: Uint8Array, payloadKey: Uint8Array): boolean {
  const binding = assertion['binding'];
  if (!isRecord(binding) || binding['method'] !== 'jws' || typeof binding['signature'] !== 'string') return false;
  const parts = binding['signature'].split('.');
  if (parts.length !== 3) return false;
  const [header, claims, signature] = parts as [string, string, string];
  let parsedHeader: unknown;
  let parsedClaims: unknown;
  try {
    parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    parsedClaims = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!isRecord(parsedHeader) || parsedHeader['alg'] !== 'HS256' || !isRecord(parsedClaims)) return false;
  if (!sameBytes(Buffer.from(signature, 'base64url'), hmac(payloadKey, `${header}.${claims}`))) return false;
  const hash = assertionHash(assertion);
  return parsedClaims['assertionHash'] === hash.toString('hex') && parsedClaims['assertionSig'] === b64(Buffer.concat([aggregate, hash]));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Writing

export interface BuildTdfInput {
  readonly content: Uint8Array;
  /** The label in the partner form (mapOut) and its signed binding over this content (bindLabel). */
  readonly external: ExternalLabel;
  readonly binding: LabelBinding;
  readonly recipient: TdfRecipient;
  readonly mimeType?: string;
  readonly segmentBytes?: number;
}

/**
 * A TDF object for the recipient: a fresh 32-byte payload key, the content in AES-256-GCM segments with GMAC hashes and an HS256 root signature, one key
 * access object wrapped to the recipient's key with its policy binding, and the label binding assertion. Throws TdfError when the binding is not over this
 * content or this mapping version, or the recipient's key is not one this version wraps to.
 */
export function buildTdf(input: BuildTdfInput): TdfObject {
  if (input.binding.contentHash !== contentHashOf(input.content) || input.binding.mapping !== input.external.mapping) throw new TdfError('label-binding');
  const segmentBytes = input.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
  if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 1 || segmentBytes > MAX_SEGMENT_BYTES) throw new TdfError('unsupported');
  const count = Math.max(1, Math.ceil(input.content.length / segmentBytes));
  if (count > MAX_SEGMENTS) throw new TdfError('unsupported');
  const payloadKey = randomBytes(KEY_BYTES);
  const sealed: Buffer[] = [];
  const segments: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    const plain = input.content.subarray(index * segmentBytes, Math.min(input.content.length, (index + 1) * segmentBytes));
    const segment = seal(payloadKey, plain);
    sealed.push(segment);
    segments.push({ hash: b64(segment.subarray(segment.length - TAG_BYTES)), segmentSize: plain.length, encryptedSegmentSize: segment.length });
  }
  const aggregate = Buffer.concat(sealed.map((segment) => segment.subarray(segment.length - TAG_BYTES)));
  const policy = Buffer.from(JSON.stringify({ uuid: randomUUID(), body: { dataAttributes: [], dissem: [] } })).toString('base64');
  const wrapped = wrapFor(input.recipient, payloadKey);
  const keyAccess: Record<string, unknown> = {
    type: wrapped.type, url: input.recipient.url, protocol: 'kas', kid: input.recipient.kid, sid: '0', schemaVersion: '1.0', wrappedKey: wrapped.wrappedKey,
    policyBinding: { alg: 'HS256', hash: b64(Buffer.from(hmac(payloadKey, policy).toString('hex'))) },
    ...(wrapped.ephemeralPublicKey === undefined ? {} : { ephemeralPublicKey: wrapped.ephemeralPublicKey })
  };
  const assertion: Record<string, unknown> = {
    id: TDF_LABEL_ASSERTION_ID, type: 'handling', scope: 'payload', appliesToState: 'unencrypted',
    statement: { format: 'string', value: canonicalBytes({ external: input.external, binding: input.binding }).toString('utf8') }
  };
  assertion['binding'] = { method: 'jws', signature: assertionJws(assertion, aggregate, payloadKey) };
  const manifest = {
    schemaVersion: TDF_SPEC_VERSION,
    tdf_spec_version: TDF_SPEC_VERSION,
    payload: {
      type: 'reference', url: TDF_PAYLOAD_NAME, protocol: 'zip', isEncrypted: true, mimeType: input.mimeType ?? 'application/octet-stream', tdf_spec_version: TDF_SPEC_VERSION
    },
    encryptionInformation: {
      type: 'split',
      keyAccess: [keyAccess],
      method: { algorithm: 'AES-256-GCM', isStreamable: true, iv: b64((sealed[0] as Buffer).subarray(0, NONCE_BYTES)) },
      integrityInformation: {
        rootSignature: { alg: 'HS256', sig: b64(hmac(payloadKey, aggregate)) },
        segmentHashAlg: 'GMAC',
        segmentSizeDefault: segmentBytes,
        encryptedSegmentSizeDefault: segmentBytes + SEGMENT_OVERHEAD,
        segments
      },
      policy
    },
    assertions: [assertion]
  };
  payloadKey.fill(0);
  return Object.freeze({ manifest: JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>, payload: new Uint8Array(Buffer.concat(sealed)) });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Reading

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const isBase64 = (value: unknown): value is string => typeof value === 'string' && value.length % 4 === 0 && BASE64.test(value);

export interface TdfManifestView {
  readonly specVersion: string;
  readonly mimeType: string;
  readonly keyAccess: readonly Readonly<Record<string, unknown>>[];
  readonly policy: string;
  readonly integrity: Readonly<Record<string, unknown>>;
  readonly segments: readonly Readonly<Record<string, unknown>>[];
  readonly assertions: readonly Readonly<Record<string, unknown>>[];
}

/**
 * The structure of a manifest, read by the fields `manifest.md` and its pages mark required: a specification version in any of its three places,
 * the payload, the key access list, the method, the integrity information and the policy. Unknown fields are left alone; nothing is decrypted.
 */
export function readTdfManifest(value: unknown): { ok: true; value: TdfManifestView } | Extract<TdfReadResult, { ok: false }> {
  if (!isRecord(value)) return refuse('malformed');
  const payload = value['payload'];
  const info = value['encryptionInformation'];
  if (!isRecord(payload) || !isRecord(info)) return refuse('malformed');
  const version = [value['schemaVersion'], value['tdf_spec_version'], payload['tdf_spec_version']].find(isText);
  if (version === undefined) return refuse('unsupported');
  if (payload['type'] !== 'reference' || !isText(payload['url']) || !isText(payload['protocol']) || payload['isEncrypted'] !== true) return refuse('malformed');
  if (payload['mimeType'] !== undefined && typeof payload['mimeType'] !== 'string') return refuse('malformed');
  const keyAccess = info['keyAccess'];
  const method = info['method'];
  const integrity = info['integrityInformation'];
  if (!isText(info['type']) || !Array.isArray(keyAccess) || keyAccess.length === 0 || !isRecord(method) || !isRecord(integrity) || !isBase64(info['policy'])) return refuse('malformed');
  for (const access of keyAccess as unknown[]) {
    if (!isRecord(access) || !isText(access['type']) || !isText(access['url']) || access['protocol'] !== 'kas' || !isBase64(access['wrappedKey'])) return refuse('malformed');
    const binding = access['policyBinding'];
    if (!isRecord(binding) || !isText(binding['alg']) || !isBase64(binding['hash'])) return refuse('malformed');
  }
  if (!isText(method['algorithm']) || typeof method['isStreamable'] !== 'boolean') return refuse('malformed');
  const root = integrity['rootSignature'];
  const segments = integrity['segments'];
  if (!isRecord(root) || !isText(root['alg']) || !isBase64(root['sig']) || !isText(integrity['segmentHashAlg']) || !isCount(integrity['segmentSizeDefault'])) return refuse('malformed');
  if (!Array.isArray(segments) || segments.length > MAX_SEGMENTS || !(segments as unknown[]).every((segment) => isRecord(segment) && isBase64(segment['hash']))) return refuse('malformed');
  const assertions = value['assertions'] ?? [];
  if (!Array.isArray(assertions) || !(assertions as unknown[]).every((entry) => isRecord(entry) && isText(entry['id']) && isRecord(entry['statement']))) return refuse('malformed');
  return {
    ok: true,
    value: {
      specVersion: version, mimeType: typeof payload['mimeType'] === 'string' ? payload['mimeType'] : 'application/octet-stream', keyAccess: keyAccess as Record<string, unknown>[],
      policy: info['policy'] as string, integrity, segments: segments as Record<string, unknown>[], assertions: assertions as Record<string, unknown>[]
    }
  };
}

export interface ReadTdfOptions {
  /** Opens the payload key: OpenBao Transit decrypt on exchange-receive-<site> at a site (45.1-04), a test key in tests. */
  readonly decryptKey: (access: TdfKeyAccess) => Promise<Uint8Array>;
  /** Your organization's table for allies, to read the label back (mapIn). */
  readonly table: LabelInteropTable | undefined;
  /** The raw Ed25519 public key your organization trusts for a binding's signer, or undefined when it trusts none for that signer. */
  readonly bindingKey: (signer: string) => Uint8Array | undefined;
}

/** The plaintext segments, checked against their GMAC hashes and the root signature; undefined with the reason when any check fails. */
function openSegments(view: TdfManifestView, payload: Uint8Array, payloadKey: Uint8Array): { content: Buffer; aggregate: Buffer } | TdfRefusal {
  const integrity = view.integrity;
  if (integrity['segmentHashAlg'] !== 'GMAC' || (integrity['rootSignature'] as Record<string, unknown>)['alg'] !== 'HS256') return 'unsupported';
  const fallback = integrity['encryptedSegmentSizeDefault'];
  const tags: Buffer[] = [];
  const plain: Buffer[] = [];
  let offset = 0;
  for (const segment of view.segments) {
    const size = segment['encryptedSegmentSize'] ?? fallback;
    if (!isCount(size) || size < SEGMENT_OVERHEAD || offset + size > payload.length) return 'integrity';
    const sealed = payload.subarray(offset, offset + size);
    offset += size;
    const tag = Buffer.from(segment['hash'] as string, 'base64');
    if (!sameBytes(tag, sealed.subarray(sealed.length - TAG_BYTES))) return 'integrity';
    tags.push(tag);
    const opened = open(payloadKey, sealed);
    if (opened === undefined) return 'payload';
    plain.push(opened);
  }
  if (offset !== payload.length || view.segments.length === 0) return 'integrity';
  const aggregate = Buffer.concat(tags);
  if (!sameText((integrity['rootSignature'] as Record<string, unknown>)['sig'] as string, b64(hmac(payloadKey, aggregate)))) return 'integrity';
  return { content: Buffer.concat(plain), aggregate };
}

function policyBound(access: Readonly<Record<string, unknown>>, policy: string, payloadKey: Uint8Array): boolean {
  const binding = access['policyBinding'] as Record<string, unknown>;
  if (binding['alg'] !== 'HS256') return false;
  const mac = hmac(payloadKey, policy);
  const hash = binding['hash'] as string;
  // The reference writes Base64 of the hex HMAC; the specification's words read as Base64 of the HMAC itself. Both are accepted.
  return sameText(hash, b64(Buffer.from(mac.toString('hex')))) || sameText(hash, b64(mac));
}

function readLabelStatement(assertions: readonly Readonly<Record<string, unknown>>[]): { external: unknown; binding: unknown } | undefined {
  const found = assertions.filter((entry) => entry['id'] === TDF_LABEL_ASSERTION_ID);
  if (found.length !== 1) return undefined;
  const statement = (found[0] as Record<string, unknown>)['statement'] as Record<string, unknown>;
  if (statement['format'] !== 'string' || typeof statement['value'] !== 'string') return undefined;
  try {
    const value: unknown = JSON.parse(statement['value']);
    if (!isRecord(value) || Object.keys(value).length !== 2 || !('external' in value) || !('binding' in value)) return undefined;
    return { external: value['external'], binding: value['binding'] };
  } catch {
    return undefined;
  }
}

/**
 * Opens a TDF object addressed to your organization and checks it, in order: the manifest's structure, the one key access (opened by the callback), the
 * policy binding, every segment hash and the root signature, the payload, every assertion's JWS, then the label binding against the content and the label
 * read back through your organization's table. Each refusal names its reason. Never throws.
 */
export async function readTdf(object: TdfObject, options: ReadTdfOptions): Promise<TdfReadResult> {
  try {
    const read = readTdfManifest(object.manifest);
    if (!read.ok) return read;
    const view = read.value;
    if (view.keyAccess.length !== 1) return refuse('unsupported');
    const access = view.keyAccess[0] as Record<string, unknown>;
    const type = access['type'];
    const kid = access['kid'];
    const ephemeral = access['ephemeralPublicKey'];
    if (type !== 'wrapped' && type !== 'ec-wrapped') return refuse('unsupported');
    if (type === 'ec-wrapped' && !isText(ephemeral)) return refuse('malformed');
    let payloadKey: Uint8Array;
    try {
      payloadKey = await options.decryptKey(Object.freeze({
        type, url: access['url'] as string, ...(isText(kid) ? { kid } : {}),
        wrappedKey: new Uint8Array(Buffer.from(access['wrappedKey'] as string, 'base64')),
        ...(isText(ephemeral) ? { ephemeralPublicKey: ephemeral } : {})
      }));
    } catch {
      return refuse('key-access');
    }
    if (!(payloadKey instanceof Uint8Array) || payloadKey.length !== KEY_BYTES) return refuse('key-access');
    if (!policyBound(access, view.policy, payloadKey)) return refuse('policy-binding');
    const opened = openSegments(view, object.payload, payloadKey);
    if (typeof opened === 'string') return refuse(opened);
    for (const assertion of view.assertions) if (!checkAssertionJws(assertion, opened.aggregate, payloadKey)) return refuse('assertion');
    const statement = readLabelStatement(view.assertions);
    if (statement === undefined) return refuse('no-label');
    const signer = isRecord(statement.binding) ? statement.binding['signer'] : undefined;
    const publicKey = typeof signer === 'string' ? options.bindingKey(signer) : undefined;
    if (publicKey === undefined) return refuse('signer-unknown');
    const label = mapIn(statement.external, options.table);
    if (!label.ok) return refuse('label-mapping');
    const external = statement.external as ExternalLabel;
    const verdict = verifyLabelBinding(statement.binding, opened.content, { publicKey, mapping: external.mapping, label: label.value });
    if (!verdict.ok) return refuse('label-binding', verdict.reason);
    return Object.freeze({ ok: true, content: new Uint8Array(opened.content), label: verdict.label, external, binding: verdict.binding, mimeType: view.mimeType });
  } catch {
    return refuse('malformed');
  }
}
