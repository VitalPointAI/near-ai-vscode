// A dependency-free verifier for the cosign key-mode Sigstore bundles our release and site keys make (48.2-04, D-19): cosign 3.1.4
// `sign-blob --key <ECDSA P-256 key> --signing-config <empty> --bundle`, no certificate, no transparency log entry. The session has no cosign,
// so the workbench verifies the release evidence manifest with this, offline. deploy/test/sigstore-parity.test.mjs holds it equal to the
// pinned cosign on accept and refuse. Node built-ins only; it never throws for bad input.
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/** The Sigstore bundle media type cosign 3.1.4 writes. */
export const SIGSTORE_BUNDLE_MEDIA_TYPE = 'application/vnd.dev.sigstore.bundle.v0.3+json';

export type SigstoreRefusal = 'bundle-format' | 'not-key-mode' | 'key' | 'key-type' | 'digest' | 'signature';
export type SigstoreCheck = { readonly ok: true } | { readonly ok: false; readonly reason: SigstoreRefusal };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The ECDSA P-256 public key in `pem`, or undefined for anything else (another curve, RSA, Ed25519, a private key, malformed text). */
function p256Key(pem: string): KeyObject | 'key' | 'key-type' {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: pem, format: 'pem' });
  } catch {
    return 'key';
  }
  if (key.type !== 'public') return 'key';
  return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : 'key-type';
}

/** The SHA-256 of the key's DER SubjectPublicKeyInfo, hex; the same value cosign puts, base64, in a key-mode bundle's public key hint. */
export function publicKeyFingerprint(pem: string): string | undefined {
  try {
    const key = createPublicKey({ key: pem, format: 'pem' });
    if (key.type !== 'public') return undefined;
    return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Verifies a cosign key-mode Sigstore bundle over `content` with the ECDSA P-256 public key `publicKeyPem`: the bundle must be the v0.3
 * key-mode form (a message signature with a SHA-256 message digest, a public key as its verification material, no certificate); the digest
 * must equal SHA-256 of the content; the signature must verify over the content with the key. Any other key type is refused. The public key
 * hint is not used, as cosign does not use it: the key is the caller's, from configuration.
 */
export function verifySigstoreBundle(content: Uint8Array, bundle: unknown, publicKeyPem: string): SigstoreCheck {
  const refuse = (reason: SigstoreRefusal): SigstoreCheck => ({ ok: false, reason });
  if (!isRecord(bundle) || bundle.mediaType !== SIGSTORE_BUNDLE_MEDIA_TYPE || !isRecord(bundle.verificationMaterial) || !isRecord(bundle.messageSignature)) return refuse('bundle-format');
  const material = bundle.verificationMaterial;
  if (!isRecord(material.publicKey) || 'certificate' in material || 'x509CertificateChain' in material || 'dsseEnvelope' in bundle) return refuse('not-key-mode');
  const signature = bundle.messageSignature;
  const digest = signature.messageDigest;
  if (!isRecord(digest) || digest.algorithm !== 'SHA2_256' || typeof digest.digest !== 'string' || !BASE64.test(digest.digest)
    || typeof signature.signature !== 'string' || !BASE64.test(signature.signature)) return refuse('bundle-format');
  const key = p256Key(publicKeyPem);
  if (typeof key === 'string') return refuse(key);
  const expected = createHash('sha256').update(content).digest();
  const recorded = Buffer.from(digest.digest, 'base64');
  if (recorded.length !== expected.length || !recorded.equals(expected)) return refuse('digest');
  try {
    return verify('sha256', content, key, Buffer.from(signature.signature, 'base64')) ? { ok: true } : refuse('signature');
  } catch {
    return refuse('signature');
  }
}
