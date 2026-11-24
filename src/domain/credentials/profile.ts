// Our narrow VC 2.0 credential format: the one way to make, read and hash a credential (Phase 71, D-05, D-09, VCRD-02). Pure: node:crypto for SHA-256
// only (through the proof modules); no I/O, no clock, no network, no document loader, no package.
//
// A credential is exactly: @context = [VC 2.0, ours]; type = ['VerifiableCredential', one type of types.ts]; issuer (a DID); validFrom and validUntil
// (UTC, required: nothing lasts forever); credentialSubject (exact claims); credentialStatus (one revocation and one suspension
// BitstringStatusListEntry, except on a status list credential, which has none and has an id); one DataIntegrityProof naming its suite, eddsa-jcs-2022
// or ecdsa-jcs-2019 (O8). Integers only. Anything else is refused with a named reason before any signature is checked.
//
// The caller resolves the issuer's key (it is never fetched here) and decides the time: `at` only checks the date window. readCredential gives the
// parts without a key, so a caller can find the issuer and verification method to resolve first.
import { createHash } from 'node:crypto';
import { CanonicalJsonError, canonicalBytes } from '../team/canonical';
import type { ScaleTable } from '../gate/labels';
import { isRecord, ownValue } from '../gate/shape';
import { CREDENTIAL_CONTEXTS } from './context';
import { DATA_INTEGRITY_FAILURES, DataIntegrityError, EDDSA_JCS_2022, createProof, verifyProof } from './dataIntegrity';
import type { CredentialSigner, CredentialSuite, DataIntegrityFailureReason, DataIntegrityVerdict } from './dataIntegrity';
import type { MultikeyPublicKey, MultikeyType } from './multibase';
import { STATUS_LIST_TYPE, STATUS_PURPOSES, credentialTimeMs, isCredentialType, isDid, parseClaims } from './types';
import type { Claims, CredentialType, StatusPurpose } from './types';

export const VERIFIABLE_CREDENTIAL = 'VerifiableCredential';
export const STATUS_ENTRY_TYPE = 'BitstringStatusListEntry';
export const PROOF_PURPOSE = 'assertionMethod';

/** The suites a proof may name, and the Multikey type of the key each one needs. */
export const CREDENTIAL_SUITES: readonly CredentialSuite[] = Object.freeze([EDDSA_JCS_2022]);
const SUITE_KEY_TYPE: Readonly<Record<string, MultikeyType>> = Object.freeze({ [EDDSA_JCS_2022]: 'Ed25519' });

const MAX_ID = 2048;
const STATUS_INDEX = /^(0|[1-9]\d{0,9})$/;

// Closed list: adding a reason means adding it here with a sentence and a test. Sentences never quote a credential value, a key or a signature.
const PROFILE_ONLY_REFUSALS = {
  'not-an-object': 'This is not a credential: it must be one JSON object.',
  'unknown-member': 'This credential has a part this version does not read.',
  'missing-member': 'This credential is missing a part every credential needs.',
  'wrong-context': 'This credential\'s @context must be exactly the two allowed contexts, in order, and nothing else.',
  'wrong-type': 'This credential must name VerifiableCredential and exactly one credential type this version knows.',
  'bad-id': 'The credential\'s id must be short text, and a status list must have one.',
  'bad-issuer': 'The credential\'s issuer must be a DID.',
  'bad-dates': 'validFrom and validUntil must both be UTC times, with validFrom first.',
  'bad-status': 'A credential needs exactly one revocation entry and one suspension entry in a status list; a status list needs none.',
  'bad-claims': 'The credential\'s claims are not exactly the ones its type allows.',
  'issuer-mismatch': 'The proof was made with a key that does not belong to the credential\'s issuer.',
  'suite-key-mismatch': 'The issuer\'s key is not the kind of key the proof\'s suite uses.',
  'not-yet-valid': 'This credential is not valid yet.',
  'expired': 'This credential has expired.'
} as const;

export const CREDENTIAL_PROFILE_REFUSALS: Readonly<Record<ProfileOnlyRefusal | DataIntegrityFailureReason, string>> = Object.freeze({
  ...PROFILE_ONLY_REFUSALS,
  ...DATA_INTEGRITY_FAILURES
});
type ProfileOnlyRefusal = keyof typeof PROFILE_ONLY_REFUSALS;
export type CredentialRefusalReason = keyof typeof CREDENTIAL_PROFILE_REFUSALS;

export class CredentialProfileError extends Error {
  public readonly reason: CredentialRefusalReason;

  public constructor(reason: CredentialRefusalReason, detail?: string) {
    super(detail === undefined ? CREDENTIAL_PROFILE_REFUSALS[reason] : `${CREDENTIAL_PROFILE_REFUSALS[reason]} (${detail})`);
    this.name = 'CredentialProfileError';
    this.reason = reason;
  }
}

export interface StatusEntry {
  readonly id?: string;
  readonly statusPurpose: StatusPurpose;
  readonly statusListIndex: number;
  readonly statusListCredential: string;
}

/** The parts of a credential as read, before or without its proof. */
export interface ReadCredential {
  readonly type: CredentialType;
  readonly issuer: string;
  readonly id?: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly claims: Claims;
  /** Empty for a status list credential; otherwise one revocation entry and one suspension entry, in that order. */
  readonly status: readonly StatusEntry[];
  /** Present when the credential is signed. */
  readonly proof?: { readonly suite: CredentialSuite; readonly verificationMethod: string };
}

export type CredentialRefusal = { readonly ok: false; readonly reason: CredentialRefusalReason; readonly message: string };
export type ReadResult = { readonly ok: true; readonly value: ReadCredential } | CredentialRefusal;
export type VerifiedCredential = ReadCredential & { readonly credential: Readonly<Record<string, unknown>>; readonly suite: CredentialSuite; readonly verificationMethod: string };
export type VerifyResult = ({ readonly ok: true } & VerifiedCredential) | CredentialRefusal;

function refuse(reason: CredentialRefusalReason, detail?: string): CredentialRefusal {
  return { ok: false, reason, message: detail === undefined ? CREDENTIAL_PROFILE_REFUSALS[reason] : `${CREDENTIAL_PROFILE_REFUSALS[reason]} (${detail})` };
}

const BASE_MEMBERS = ['@context', 'type', 'issuer', 'validFrom', 'validUntil', 'credentialSubject'];

function sameList(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}

function readStatusEntry(value: unknown): StatusEntry | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  const allowed = ['id', 'type', 'statusPurpose', 'statusListIndex', 'statusListCredential'];
  if (keys.some((key) => !allowed.includes(key)) || keys.length < allowed.length - 1) return undefined;
  const id = ownValue(value, 'id');
  const purpose = ownValue(value, 'statusPurpose');
  const index = ownValue(value, 'statusListIndex');
  const list = ownValue(value, 'statusListCredential');
  if (ownValue(value, 'type') !== STATUS_ENTRY_TYPE) return undefined;
  if (id !== undefined && (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID)) return undefined;
  if (typeof purpose !== 'string' || !(STATUS_PURPOSES as readonly string[]).includes(purpose)) return undefined;
  // A base-10 string (Bitstring Status List 2.3), with no leading zero so one index has one form.
  if (typeof index !== 'string' || !STATUS_INDEX.test(index) || !Number.isSafeInteger(Number(index))) return undefined;
  if (typeof list !== 'string' || list.length === 0 || list.length > MAX_ID) return undefined;
  return Object.freeze({ ...(id === undefined ? {} : { id }), statusPurpose: purpose as StatusPurpose, statusListIndex: Number(index), statusListCredential: list });
}

function readStatus(value: unknown): readonly StatusEntry[] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const entries = value.map(readStatusEntry);
  if (entries.some((entry) => entry === undefined)) return undefined;
  const revocation = entries.find((entry) => entry?.statusPurpose === 'revocation');
  const suspension = entries.find((entry) => entry?.statusPurpose === 'suspension');
  if (revocation === undefined || suspension === undefined) return undefined;
  return Object.freeze([revocation, suspension]);
}

/**
 * Reads a credential's parts against the format, without checking its proof: every refusal here happens before any signature is looked at. With
 * `signed`, a proof must be present and name a known suite and a verification method of the issuer; without it, a proof is refused.
 */
export function readCredential(value: unknown, scales: ScaleTable, options: { signed: boolean }): ReadResult {
  if (!isRecord(value)) return refuse('not-an-object');
  const rawType = ownValue(value, 'type');
  const type = Array.isArray(rawType) && rawType.length === 2 && rawType[0] === VERIFIABLE_CREDENTIAL ? rawType[1] : undefined;
  const isStatusList = type === STATUS_LIST_TYPE;
  const allowed = [...BASE_MEMBERS, 'id', ...(isStatusList ? [] : ['credentialStatus']), ...(options.signed ? ['proof'] : [])];
  const required = [...BASE_MEMBERS, ...(isStatusList ? ['id'] : ['credentialStatus']), ...(options.signed ? ['proof'] : [])];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return refuse(key === 'credentialStatus' ? 'bad-status' : key === 'proof' ? 'already-signed' : 'unknown-member');
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return refuse(key === 'credentialStatus' ? 'bad-status' : key === 'proof' ? 'bad-proof' : 'missing-member');
  }
  if (!sameList(ownValue(value, '@context'), CREDENTIAL_CONTEXTS)) return refuse('wrong-context');
  if (!isCredentialType(type)) return refuse('wrong-type');
  try {
    canonicalBytes(value);
  } catch (error) {
    if (error instanceof CanonicalJsonError) return refuse('not-canonical', error.message);
    throw error;
  }
  const id = ownValue(value, 'id');
  if (id !== undefined && (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID)) return refuse('bad-id');
  const issuer = ownValue(value, 'issuer');
  if (!isDid(issuer)) return refuse('bad-issuer');
  const validFrom = ownValue(value, 'validFrom');
  const validUntil = ownValue(value, 'validUntil');
  const fromMs = credentialTimeMs(validFrom);
  const untilMs = credentialTimeMs(validUntil);
  if (Number.isNaN(fromMs) || Number.isNaN(untilMs) || fromMs >= untilMs) return refuse('bad-dates');
  const status = isStatusList ? Object.freeze([]) : readStatus(ownValue(value, 'credentialStatus'));
  if (status === undefined) return refuse('bad-status');
  const claims = parseClaims(type, ownValue(value, 'credentialSubject'), scales);
  if (!claims.ok) return refuse('bad-claims', `${claims.reason} at ${claims.path}`);
  let proof: ReadCredential['proof'];
  if (options.signed) {
    const raw = ownValue(value, 'proof');
    if (!isRecord(raw)) return refuse('bad-proof');
    const suite = ownValue(raw, 'cryptosuite');
    if (typeof suite !== 'string' || !(CREDENTIAL_SUITES as readonly string[]).includes(suite)) return refuse('unsupported-suite');
    const method = ownValue(raw, 'verificationMethod');
    if (typeof method !== 'string') return refuse('bad-proof');
    if (!method.startsWith(`${issuer}#`)) return refuse('issuer-mismatch');
    proof = Object.freeze({ suite: suite as CredentialSuite, verificationMethod: method });
  }
  return {
    ok: true,
    value: Object.freeze({
      type, issuer, ...(id === undefined ? {} : { id: id as string }), validFrom: validFrom as string, validUntil: validUntil as string, claims: claims.value, status,
      ...(proof === undefined ? {} : { proof })
    })
  };
}

export interface VerifyCredentialOptions {
  /** The issuer's public key for the proof's verification method, resolved by the caller (never fetched here). */
  readonly publicKey: MultikeyPublicKey;
  /** The scales the claims are read against (the policy's, or the gate's presets). */
  readonly scales: ScaleTable;
  /** Epoch milliseconds: when given, the credential must be valid then (validFrom at or before, validUntil after). */
  readonly at?: number;
}

function checkProof(suite: CredentialSuite, value: unknown, key: Uint8Array): DataIntegrityVerdict {
  return verifyProof(value, key, { proofPurpose: PROOF_PURPOSE });
}

/** Verifies one credential: the format first, then the proof with the caller's key, then (with `at`) the date window. Never throws. */
export function verifyCredential(value: unknown, options: VerifyCredentialOptions): VerifyResult {
  const read = readCredential(value, options.scales, { signed: true });
  if (!read.ok) return read;
  const proof = read.value.proof as NonNullable<ReadCredential['proof']>;
  const key = options.publicKey;
  if (key === null || typeof key !== 'object' || key.type !== SUITE_KEY_TYPE[proof.suite]) return refuse('suite-key-mismatch');
  const verdict = checkProof(proof.suite, value, key.key);
  if (!verdict.ok) return refuse(verdict.reason);
  if (options.at !== undefined) {
    if (!Number.isFinite(options.at) || options.at < credentialTimeMs(read.value.validFrom)) return refuse('not-yet-valid');
    if (options.at >= credentialTimeMs(read.value.validUntil)) return refuse('expired');
  }
  return { ok: true, ...read.value, credential: value as Readonly<Record<string, unknown>>, suite: proof.suite, verificationMethod: proof.verificationMethod };
}

export interface IssueOptions {
  readonly scales: ScaleTable;
  /** The proof's creation time, as the caller's clock gives it (optional). */
  readonly created?: string;
}

/**
 * Signs one credential through the signer (a device key, a hosted person key or the offline root use the same path). The unsigned credential must
 * already be exactly the format; the signer must belong to the issuer and use `suite`. Every refusal happens before the signer is called, and throws
 * CredentialProfileError.
 */
export async function issueCredential(signer: CredentialSigner, unsigned: Record<string, unknown>, suite: CredentialSuite, options: IssueOptions): Promise<Record<string, unknown>> {
  const read = readCredential(unsigned, options.scales, { signed: false });
  if (!read.ok) throw new CredentialProfileError(read.reason);
  if (!(CREDENTIAL_SUITES as readonly string[]).includes(suite) || signer.suite !== suite) throw new CredentialProfileError('unsupported-suite');
  if (typeof signer.verificationMethod !== 'string' || !signer.verificationMethod.startsWith(`${read.value.issuer}#`)) throw new CredentialProfileError('issuer-mismatch');
  const proofOptions = { proofPurpose: PROOF_PURPOSE, ...(options.created === undefined ? {} : { created: options.created }) };
  try {
    const proof = await createProof(unsigned, proofOptions, signer);
    return { ...unsigned, proof };
  } catch (error) {
    if (error instanceof DataIntegrityError) throw new CredentialProfileError(error.reason);
    throw error;
  }
}

/** D-09: SHA-256 of the JCS bytes of the whole credential, proof included, as 64 lower-case hex characters. Entries cite credentials by this. */
export function credentialHash(credential: unknown): string {
  try {
    return createHash('sha256').update(canonicalBytes(credential)).digest('hex');
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw new CredentialProfileError('not-canonical', error.message);
    throw error;
  }
}
