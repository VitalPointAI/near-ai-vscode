// Data Integrity proofs with eddsa-jcs-2022 (W3C vc-di-eddsa 1.0, section 3.3) for verified credentials (Phase 71, D-05, VCRD-02, VCRD-03).
// Pure: node:crypto for SHA-256 and Ed25519 verification only; no I/O, no clock, no package. Signing goes through a CredentialSigner, so a device key,
// a hosted person key (asynchronous) and the offline root key all use this one path and this file never sees a private key.
//
// Canonical bytes come only from canonicalBytes in ../team/canonical (RFC 8785 for every input the profile allows; 71-01 checks that against the
// reference). So floats, -0, NaN, unsafe integers, lone surrogates and nesting deeper than 16 are refused before anything is signed.
//
// What is signed: SHA-256 of the canonical proof configuration followed by SHA-256 of the canonical document without `proof`, 64 raw bytes. A signed
// payload input starts with the text "near-ai-vscode/signed-payload/v1" and a team-event input with "{", and both are always longer than 64 bytes,
// so one Ed25519 key can sign all three without a signature of one ever verifying as another.
//
// The profile is narrower than the specification on purpose: exactly one proof (no proof sets or chains), and the proof's @context must equal the
// document's @context (the specification only asks for a prefix, which would leave the extra contexts unsigned).
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { CanonicalJsonError, canonicalBytes } from '../team/canonical';
import { MultibaseError, multibaseDecode, multibaseEncode } from './multibase';

export const DATA_INTEGRITY_PROOF = 'DataIntegrityProof';
export const EDDSA_JCS_2022 = 'eddsa-jcs-2022';
export const DATA_INTEGRITY_INPUT_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
// 'z' + base58btc of 64 bytes is at most 89 characters.
const MAX_PROOF_VALUE_LENGTH = 89;
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
// XML Schema 1.1 dateTime: year, month, day, time, optional fraction, optional time zone.
const XSD_DATE_TIME = /^-?\d{4,}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]((0\d|1[0-3]):[0-5]\d|14:00))?$/;

export type CredentialSuite = typeof EDDSA_JCS_2022;

export interface CredentialSigner {
  readonly verificationMethod: string;
  readonly suite: CredentialSuite;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export interface ProofOptions { proofPurpose: string; created?: string }

export interface DataIntegrityProof {
  type: typeof DATA_INTEGRITY_PROOF;
  cryptosuite: CredentialSuite;
  verificationMethod: string;
  proofPurpose: string;
  created?: string;
  '@context'?: unknown;
  proofValue: string;
}

// Closed list: adding a reason means adding it here with a message and a test. Messages never quote a credential value, a key or a signature.
export const DATA_INTEGRITY_FAILURES = {
  'not-canonical': 'This credential has a value that cannot be signed. Use plain text, true or false, lists, objects and whole numbers only.',
  'already-signed': 'This credential already has a proof, and only one is allowed.',
  'unsupported-suite': 'This proof uses a suite this version does not accept.',
  'bad-proof': 'This credential has no proof, more than one, or a proof with a missing or unreadable part.',
  'bad-created': 'The proof\'s creation time is not a valid date and time.',
  'context-mismatch': 'The proof\'s @context is not exactly the credential\'s @context, so part of the credential would be unsigned.',
  'wrong-purpose': 'This proof was made for a different purpose than the one it was offered for.',
  'bad-key': 'The public key is not a 32-byte Ed25519 key.',
  'bad-signature': 'The signature does not match the credential, so it was changed or was not made by this key.'
} as const;
export type DataIntegrityFailureReason = keyof typeof DATA_INTEGRITY_FAILURES;

export class DataIntegrityError extends Error {
  public readonly reason: DataIntegrityFailureReason;

  public constructor(reason: DataIntegrityFailureReason, detail?: string) {
    super(detail === undefined ? DATA_INTEGRITY_FAILURES[reason] : `${DATA_INTEGRITY_FAILURES[reason]} (${detail})`);
    this.name = 'DataIntegrityError';
    this.reason = reason;
  }
}

export type DataIntegrityVerdict =
  | { ok: true; document: Record<string, unknown>; proof: DataIntegrityProof }
  | { ok: false; reason: DataIntegrityFailureReason; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonical(value: unknown): Buffer {
  try {
    return canonicalBytes(value);
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw new DataIntegrityError('not-canonical', error.message);
    throw error;
  }
}

function sha256(bytes: Buffer): Buffer {
  return createHash('sha256').update(bytes).digest();
}

// SHA-256 of the canonical proof configuration (section 3.3.5, the proof options with the document's @context and without proofValue).
export function proofConfigHash(proofConfig: Record<string, unknown>): Buffer {
  return sha256(canonical(proofConfig));
}

// SHA-256 of the canonical document without its proof (section 3.3.3).
export function documentHash(unsecuredDocument: Record<string, unknown>): Buffer {
  return sha256(canonical(unsecuredDocument));
}

// The 64 bytes an eddsa-jcs-2022 signer signs (section 3.3.4): the proof configuration hash, then the document hash.
export function dataIntegritySigningInput(unsecuredDocument: Record<string, unknown>, proofConfig: Record<string, unknown>): Buffer {
  return Buffer.concat([proofConfigHash(proofConfig), documentHash(unsecuredDocument)]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonical(left).equals(canonical(right));
}

// Create Proof (section 3.3.1). Returns the proof; the caller attaches it as `proof`. Every refusal happens before the signer is called.
export async function createProof(unsecuredDocument: Record<string, unknown>, options: ProofOptions, signer: CredentialSigner): Promise<DataIntegrityProof> {
  if (!isPlainObject(unsecuredDocument)) throw new DataIntegrityError('not-canonical', 'the credential must be a plain object');
  if ('proof' in unsecuredDocument) throw new DataIntegrityError('already-signed');
  if (signer.suite !== EDDSA_JCS_2022) throw new DataIntegrityError('unsupported-suite');
  if (typeof signer.verificationMethod !== 'string' || signer.verificationMethod.length === 0) throw new DataIntegrityError('bad-proof', 'the signer has no verification method');
  if (typeof options.proofPurpose !== 'string' || options.proofPurpose.length === 0) throw new DataIntegrityError('bad-proof', 'the proof purpose is missing');
  if (options.created !== undefined && (typeof options.created !== 'string' || !XSD_DATE_TIME.test(options.created))) throw new DataIntegrityError('bad-created');
  const proofConfig: Omit<DataIntegrityProof, 'proofValue'> = {
    type: DATA_INTEGRITY_PROOF,
    cryptosuite: EDDSA_JCS_2022,
    ...(options.created === undefined ? {} : { created: options.created }),
    verificationMethod: signer.verificationMethod,
    proofPurpose: options.proofPurpose,
    ...('@context' in unsecuredDocument ? { '@context': unsecuredDocument['@context'] } : {})
  };
  const input = dataIntegritySigningInput(unsecuredDocument, proofConfig as unknown as Record<string, unknown>);
  const signature = await signer.sign(new Uint8Array(input));
  if (!(signature instanceof Uint8Array) || signature.length !== ED25519_SIGNATURE_BYTES) throw new DataIntegrityError('bad-signature', 'the signer did not return a 64-byte Ed25519 signature');
  return { ...proofConfig, proofValue: multibaseEncode(signature) };
}

function refuse(reason: DataIntegrityFailureReason): DataIntegrityVerdict {
  return { ok: false, reason, message: DATA_INTEGRITY_FAILURES[reason] };
}

export interface VerifyProofOptions { proofPurpose?: string }

// Verify Proof (section 3.3.2) against a raw 32-byte Ed25519 public key that the caller has already resolved from proof.verificationMethod.
// Never throws: every failure is a refusal with a reason.
export function verifyProof(securedDocument: unknown, publicKey: Uint8Array, options: VerifyProofOptions = {}): DataIntegrityVerdict {
  try {
    if (!isPlainObject(securedDocument) || !isPlainObject(securedDocument.proof)) return refuse('bad-proof');
    const { proof: rawProof, ...unsecuredDocument } = securedDocument;
    const proof = rawProof as Record<string, unknown>;
    if (proof.type !== DATA_INTEGRITY_PROOF || proof.cryptosuite !== EDDSA_JCS_2022) return refuse('unsupported-suite');
    if (typeof proof.verificationMethod !== 'string' || typeof proof.proofPurpose !== 'string' || typeof proof.proofValue !== 'string') return refuse('bad-proof');
    if (proof.created !== undefined && (typeof proof.created !== 'string' || !XSD_DATE_TIME.test(proof.created))) return refuse('bad-created');
    if (proof.proofPurpose !== (options.proofPurpose ?? 'assertionMethod')) return refuse('wrong-purpose');
    if ('@context' in proof || '@context' in unsecuredDocument) {
      if (!('@context' in proof) || !('@context' in unsecuredDocument) || !sameJson(proof['@context'], unsecuredDocument['@context'])) return refuse('context-mismatch');
    }
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== ED25519_PUBLIC_KEY_BYTES) return refuse('bad-key');
    if (proof.proofValue.length > MAX_PROOF_VALUE_LENGTH) return refuse('bad-signature');
    const signature = multibaseDecode(proof.proofValue);
    if (signature.length !== ED25519_SIGNATURE_BYTES) return refuse('bad-signature');
    const { proofValue: _proofValue, ...proofConfig } = proof;
    const input = dataIntegritySigningInput(unsecuredDocument, proofConfig);
    let key: KeyObject;
    try {
      key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]), format: 'der', type: 'spki' });
    } catch {
      // 32 bytes that node:crypto cannot read as an Ed25519 point are not a key.
      return refuse('bad-key');
    }
    if (!cryptoVerify(null, input, key, signature)) return refuse('bad-signature');
    return { ok: true, document: unsecuredDocument, proof: proof as unknown as DataIntegrityProof };
  } catch (error) {
    if (error instanceof DataIntegrityError) return refuse(error.reason);
    // A proofValue outside the base58btc alphabet cannot be a signature.
    if (error instanceof MultibaseError) return refuse('bad-signature');
    // Anything else that cannot be read is not a proof this version accepts.
    return refuse('bad-proof');
  }
}
