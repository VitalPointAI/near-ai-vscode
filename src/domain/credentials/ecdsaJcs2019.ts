// Data Integrity proofs with ecdsa-jcs-2019 on P-256 (W3C vc-di-ecdsa 1.0, section 3.3, a W3C Recommendation of 15 May 2025): the second credential
// suite O8 keeps ready for a site that must use only FIPS 140-3 approved signatures (gap G350). Pure: node:crypto only; no I/O, no clock, no package.
//
// It mirrors dataIntegrity.ts and shares its steps: the same proof configuration, the same canonical bytes and the same 64-byte input (SHA-256 of the
// proof configuration, then SHA-256 of the document). The ECDSA signature hashes that input once more with SHA-256, and proofValue is the 64-byte
// IEEE P1363 form (r then s, 32 bytes each). A DER signature is refused, so one signature has one encoding (T-71-09).
//
// node:crypto signs with a random nonce, so two signatures of the same input differ; the specification's deterministic variant is a SHOULD, and
// verification does not depend on it.
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  DataIntegrityError, ECDSA_JCS_2019, dataIntegritySigningInput, proofConfigFor, proofSignature, readSecuredProof, refuseProof
} from './dataIntegrity';
import type { CredentialSigner, DataIntegrityProof, DataIntegrityVerdict, ProofOptions, VerifyProofOptions } from './dataIntegrity';
import { MultibaseError, multibaseEncode } from './multibase';

export { ECDSA_JCS_2019 };
const P256_COMPRESSED_KEY_BYTES = 33;
const P256_SIGNATURE_BYTES = 64;
// SubjectPublicKeyInfo DER for an EC key on prime256v1 with a 33-byte compressed point: SEQUENCE { SEQUENCE { id-ecPublicKey, prime256v1 },
// BIT STRING (no unused bits) }.
const SPKI_P256_COMPRESSED_PREFIX = Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex');
// The signature encoding the suite fixes: r then s, never DER.
const DSA_ENCODING = 'ieee-p1363';

export const ECDSA_BAD_KEY_TEXT = 'The public key is not a compressed 33-byte P-256 key.';

/** The P-256 public key node:crypto reads from a compressed Multikey key, or undefined when the bytes are not a point on the curve. */
export function p256PublicKey(compressed: Uint8Array): KeyObject | undefined {
  if (!(compressed instanceof Uint8Array) || compressed.length !== P256_COMPRESSED_KEY_BYTES || (compressed[0] !== 0x02 && compressed[0] !== 0x03)) return undefined;
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_P256_COMPRESSED_PREFIX, compressed]), format: 'der', type: 'spki' });
  } catch {
    // 33 bytes that are not a point on P-256 are not a key.
    return undefined;
  }
}

// Create Proof (section 3.3.1 for ecdsa-jcs-2019). The signer returns the 64-byte r then s signature of the 64-byte input, hashed with SHA-256.
export async function createEcdsaProof(unsecuredDocument: Record<string, unknown>, options: ProofOptions, signer: CredentialSigner): Promise<DataIntegrityProof> {
  const proofConfig = proofConfigFor(unsecuredDocument, options, signer, ECDSA_JCS_2019);
  const input = dataIntegritySigningInput(unsecuredDocument, proofConfig as unknown as Record<string, unknown>);
  const signature = await signer.sign(new Uint8Array(input));
  if (!(signature instanceof Uint8Array) || signature.length !== P256_SIGNATURE_BYTES) {
    throw new DataIntegrityError('bad-signature', 'the signer did not return a 64-byte P-256 signature (r then s)');
  }
  return { ...proofConfig, proofValue: multibaseEncode(signature) };
}

// Verify Proof (section 3.3.2 for ecdsa-jcs-2019) against a compressed P-256 public key the caller resolved from proof.verificationMethod.
// Never throws: every failure is a refusal with a reason.
export function verifyEcdsaProof(securedDocument: unknown, publicKey: Uint8Array, options: VerifyProofOptions = {}): DataIntegrityVerdict {
  try {
    const read = readSecuredProof(securedDocument, ECDSA_JCS_2019, options);
    if (!read.ok) return read;
    const { unsecuredDocument, proof } = read;
    const key = p256PublicKey(publicKey);
    if (key === undefined) return refuseProof('bad-key', ECDSA_BAD_KEY_TEXT);
    const signature = proofSignature(proof.proofValue);
    if (signature === undefined) return refuseProof('bad-signature');
    const { proofValue: _proofValue, ...proofConfig } = proof;
    const input = dataIntegritySigningInput(unsecuredDocument, proofConfig);
    if (!cryptoVerify('sha256', input, { key, dsaEncoding: DSA_ENCODING }, signature)) return refuseProof('bad-signature');
    return { ok: true, document: unsecuredDocument, proof: proof as unknown as DataIntegrityProof };
  } catch (error) {
    if (error instanceof DataIntegrityError) return refuseProof(error.reason);
    if (error instanceof MultibaseError) return refuseProof('bad-signature');
    return refuseProof('bad-proof');
  }
}
