// did:key for devices and agents (Phase 71, D-13, DLGT-01, VCRD-06; did:key method 0.9, https://w3c-ccg.github.io/did-key-spec/). Pure: no I/O.
// A Phase 69 device key is Ed25519 and becomes did:key:z6Mk... as it is: no new key and no conversion. A P-256 did:key (zDn...) exists only for the
// strict-FIPS fallback of O8, where an officer's P-256 person key is named in the signed policy (D-07); it is never a device's own identity.
//
// A did:key URL with a fragment must repeat its body exactly (did:key:<mb>#<mb>): the body is the key, and a different fragment would let a proof
// claim one key while signing with another (did:webvh 1.0, Witness DIDs; DIF negative vector did-key-body-fragment-mismatch).
import { isStrictBase64url } from '../team/canonical';
import { MultibaseError, decodePublicKeyMultibase, encodePublicKeyMultibase } from '../credentials/multibase';
import type { MultikeyPublicKey, MultikeyType } from '../credentials/multibase';
import { DID_CORE_CONTEXT, readDidDocument } from './didDocument';
import type { DidDocument, VerificationMethod } from './didDocument';

export const DID_KEY_PREFIX = 'did:key:';
export const MULTIKEY_CONTEXT = 'https://w3id.org/security/multikey/v1';
const ED25519_KEY_BYTES = 32;
// 'z' + base58btc of a 2-byte header and a 33-byte key is at most 49 characters.
const MAX_BODY = 64;

export const DID_KEY_FAILURES = {
  'not-did-key': 'This is not a did:key.',
  'bad-key': 'This did:key does not hold an Ed25519 or P-256 public key.',
  'fragment-mismatch': 'This did:key URL names a different key in its fragment than in its body.'
} as const;
export type DidKeyFailure = keyof typeof DID_KEY_FAILURES;

export type DidKeyResult =
  | { readonly ok: true; readonly did: string; readonly publicKey: MultikeyPublicKey; readonly method: VerificationMethod; readonly document: DidDocument }
  | { readonly ok: false; readonly reason: DidKeyFailure; readonly message: string };

function refuse(reason: DidKeyFailure): DidKeyResult {
  return { ok: false, reason, message: DID_KEY_FAILURES[reason] };
}

/** The did:key of a Multikey public key. Throws MultibaseError for a key of the wrong length or form. */
export function didKeyFromPublicKey(type: MultikeyType, key: Uint8Array): string {
  return `${DID_KEY_PREFIX}${encodePublicKeyMultibase(type, key)}`;
}

/** The did:key of a Phase 69 device or agent key, given as its record keeps it (32 bytes, strict base64url). Throws for anything else. */
export function didKeyFromDevice(publicKey: string): string {
  if (!isStrictBase64url(publicKey, ED25519_KEY_BYTES)) throw new MultibaseError('A device public key must be 32 bytes written as base64url.');
  return didKeyFromPublicKey('Ed25519', new Uint8Array(Buffer.from(publicKey, 'base64url')));
}

/** The verification method id of a did:key: the DID, `#`, and the body again. */
export function didKeyMethodId(did: string): string {
  return `${did}#${did.slice(DID_KEY_PREFIX.length)}`;
}

/**
 * Resolves a did:key, or a did:key URL whose fragment repeats its body, to its key and its minimal DID document (one method, used for authentication
 * and assertion). Never throws, never fetches.
 */
export function resolveDidKey(didOrUrl: unknown): DidKeyResult {
  if (typeof didOrUrl !== 'string' || !didOrUrl.startsWith(DID_KEY_PREFIX)) return refuse('not-did-key');
  const hash = didOrUrl.indexOf('#');
  const did = hash < 0 ? didOrUrl : didOrUrl.slice(0, hash);
  const body = did.slice(DID_KEY_PREFIX.length);
  if (body.length === 0 || body.length > MAX_BODY || !body.startsWith('z') || /[^A-Za-z0-9]/.test(body)) return refuse('not-did-key');
  if (hash >= 0 && didOrUrl.slice(hash + 1) !== body) return refuse('fragment-mismatch');
  let publicKey: MultikeyPublicKey;
  try {
    publicKey = decodePublicKeyMultibase(body);
  } catch (error) {
    if (error instanceof MultibaseError) return refuse('bad-key');
    throw error;
  }
  // One key, one form: the body must be exactly what encoding the key gives (no leading-zero or other variants of the same key).
  if (encodePublicKeyMultibase(publicKey.type, publicKey.key) !== body) return refuse('bad-key');
  const methodId = didKeyMethodId(did);
  const read = readDidDocument({
    '@context': [DID_CORE_CONTEXT, MULTIKEY_CONTEXT],
    id: did,
    verificationMethod: [{ id: methodId, type: 'Multikey', controller: did, publicKeyMultibase: body }],
    authentication: [methodId],
    assertionMethod: [methodId]
  }, did);
  if (!read.ok) return refuse('bad-key');
  return { ok: true, did, publicKey: Object.freeze(publicKey), method: read.document.verificationMethod[0] as VerificationMethod, document: read.document };
}

/** Whether a value is a well-formed did:key (or did:key URL) holding an Ed25519 or P-256 key. */
export function isDidKey(value: unknown): boolean {
  return resolveDidKey(value).ok;
}
