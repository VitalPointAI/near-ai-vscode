// Bitstring Status List (W3C Recommendation 15 May 2025) for revocation and suspension that a device checks offline from a cached list (Phase 71,
// D-14, VCRD-04; 71-RESEARCH.md "(c) Status lists"). Pure: node:zlib's synchronous gzip (no I/O) and the credential format; no clock and no random
// source of its own (the caller passes both).
//
// A list is a BitstringStatusListCredential signed by your organization's status-list key (`status-list-<site>` in OpenBao Transit, D-14). Its issuer
// is that key's did:key, and every verifier checks it against the public key the cited policy's credentials@1.statusLists names for the list, never
// through the person-issuer rule. Index 0 is the left-most bit. A list carries our `version`, raised by every change, so two copies of one list are
// ordered without a clock; the hub's compare-and-swap (71-09) uses it.
//
// Revocation never clears: there is no function that clears a revocation bit, and a newer copy that clears one is refused. Suspension clears only
// through clearSuspension, which the issuer of that type runs after a step-up (71-12).
import { gunzipSync, gzipSync } from 'node:zlib';
import type { ScaleTable } from '../gate/labels';
import { resolveDidKey } from '../did/didKey';
import type { CredentialSigner, CredentialSuite } from './dataIntegrity';
import type { MultikeyPublicKey } from './multibase';
import { CREDENTIAL_CONTEXTS } from './context';
import { credentialHash, issueCredential, readCredential, verifyCredential } from './profile';
import type { StatusEntry } from './profile';
import { STATUS_LIST_TYPE, credentialTimeMs } from './types';
import type { StatusPurpose } from './types';

/** The specification's minimum for herd privacy: 131,072 entries (16 KB uncompressed). One list per purpose per site has exactly this many. */
export const STATUS_LIST_ENTRIES = 131_072;
/** The largest list read: twice the minimum, so a decompressed list is never more than 32 KB. */
export const MAX_STATUS_LIST_ENTRIES = 2 * STATUS_LIST_ENTRIES;
/** A new list pair starts when half the indexes are allocated (65,536), so random draws stay fast and the crowd stays large. */
export const STATUS_LIST_ALLOCATION_LIMIT = STATUS_LIST_ENTRIES / 2;
/** `ttl` in milliseconds: the connected time to live of O6 (15 minutes). */
export const STATUS_LIST_TTL_MS = 900_000;
/** validUntil = validFrom + the longest maximum offline age in the policy (default 7 days, Protected A); each verifier applies its own level's age. */
export const STATUS_LIST_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
/** Level 9: smaller at the low fill HQ expects (339 bytes against 431 at 0.1 percent), and verifiers do not care. */
export const STATUS_LIST_GZIP_LEVEL = 9;
const MAX_RANDOM_DRAWS = 64;
const NO_SCALES: ScaleTable = Object.freeze({});

// Closed list. Sentences never quote a list, an index or a key.
export const STATUS_LIST_FAILURES = {
  'status-list-signer': 'This status list was not signed by the key your organization\'s policy names for it.',
  'status-list-invalid': 'This status list cannot be read or its signature does not match, so it was changed or is not a status list.',
  'status-list-too-short': 'This status list has fewer entries than the minimum, which would make a credential easier to pick out.',
  'status-list-expired': 'This status list is outside the time it is valid for.',
  'status-unavailable': 'The status of this credential cannot be checked: its status list is missing, cannot be verified or is out of date.',
  'not-newer': 'This status list is not a newer copy of the one already held.',
  'revocation-cleared': 'This status list clears a revocation, and a revocation can never be undone.'
} as const;
export type StatusListFailure = keyof typeof STATUS_LIST_FAILURES;

export type StatusListRefusal = { readonly ok: false; readonly reason: StatusListFailure; readonly message: string };

/** A list as read: its bits and the fields of its credential. */
export interface StatusListState {
  readonly id: string;
  readonly issuer: string;
  readonly purpose: StatusPurpose;
  readonly version: number;
  readonly size: number;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly ttl?: number;
  readonly bits: Uint8Array;
}

export interface StatusListInput {
  /** The list credential's id, which status entries name in statusListCredential. */
  readonly id: string;
  /** The did:key of the site's status-list key. */
  readonly issuer: string;
  readonly purpose: StatusPurpose;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly version: number;
  readonly ttl?: number;
  /** Default STATUS_LIST_ENTRIES, every bit clear. */
  readonly size?: number;
  readonly bits?: Uint8Array;
}

function refuse(reason: StatusListFailure): StatusListRefusal {
  return { ok: false, reason, message: STATUS_LIST_FAILURES[reason] };
}

function checkSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < STATUS_LIST_ENTRIES || size > MAX_STATUS_LIST_ENTRIES || size % 8 !== 0) {
    throw new RangeError(`A status list has from ${String(STATUS_LIST_ENTRIES)} to ${String(MAX_STATUS_LIST_ENTRIES)} entries, a multiple of 8.`);
  }
}

/** `u` + base64url without padding of the GZIP of the bits (Bitstring Status List 2.2). */
export function encodeBits(bits: Uint8Array): string {
  checkSize(bits.length * 8);
  return `u${gzipSync(bits, { level: STATUS_LIST_GZIP_LEVEL }).toString('base64url')}`;
}

/** The bits of an encodedList, or undefined when it is not one (a bad prefix or alphabet, not GZIP, larger than the largest list, or too short). */
export function decodeBits(encodedList: unknown): { bits: Uint8Array } | { reason: 'status-list-invalid' | 'status-list-too-short' } {
  if (typeof encodedList !== 'string' || !/^u[A-Za-z0-9_-]+$/.test(encodedList)) return { reason: 'status-list-invalid' };
  let bytes: Buffer;
  try {
    // The output cap stops a small GZIP that expands without end.
    bytes = gunzipSync(Buffer.from(encodedList.slice(1), 'base64url'), { maxOutputLength: MAX_STATUS_LIST_ENTRIES / 8 });
  } catch {
    // Not GZIP, truncated, or larger than the largest list.
    return { reason: 'status-list-invalid' };
  }
  if (bytes.length * 8 < STATUS_LIST_ENTRIES) return { reason: 'status-list-too-short' };
  return { bits: new Uint8Array(bytes) };
}

function bitAt(bits: Uint8Array, index: number): boolean {
  return ((bits[index >> 3] as number) & (0x80 >> (index & 7))) !== 0;
}

function withBit(bits: Uint8Array, index: number, set: boolean): Uint8Array {
  const copy = new Uint8Array(bits);
  copy[index >> 3] = set ? (copy[index >> 3] as number) | (0x80 >> (index & 7)) : (copy[index >> 3] as number) & ~(0x80 >> (index & 7));
  return copy;
}

/** The unsigned list credential (no credentialStatus, D-05). Sign it with signStatusList. */
export function buildStatusList(input: StatusListInput): Record<string, unknown> {
  const size = input.size ?? STATUS_LIST_ENTRIES;
  checkSize(size);
  const bits = input.bits ?? new Uint8Array(size / 8);
  if (bits.length * 8 !== size) throw new RangeError('The bits do not have the list\'s size.');
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new RangeError('A status list version is a whole number from 1.');
  return {
    '@context': [...CREDENTIAL_CONTEXTS],
    id: input.id,
    type: ['VerifiableCredential', STATUS_LIST_TYPE],
    issuer: input.issuer,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    credentialSubject: {
      id: `${input.id}#list`, type: 'BitstringStatusList', statusPurpose: input.purpose, encodedList: encodeBits(bits), version: input.version,
      ...(input.ttl === undefined ? {} : { ttl: input.ttl })
    }
  };
}

/** Signs a list through the status-list key's signer (Transit, after an officer's step-up; D-14). */
export async function signStatusList(signer: CredentialSigner, unsigned: Record<string, unknown>, suite: CredentialSuite): Promise<Record<string, unknown>> {
  return issueCredential(signer, unsigned, suite, { scales: NO_SCALES });
}

function sameKey(left: MultikeyPublicKey, right: MultikeyPublicKey): boolean {
  return left.type === right.type && left.key.length === right.key.length && left.key.every((byte, index) => byte === right.key[index]);
}

export type VerifiedStatusList = { readonly ok: true; readonly list: StatusListState; readonly hash: string } | StatusListRefusal;

/**
 * Verifies a signed list against the one public key the policy names for it (D-14): the proof's key must be that key ('status-list-signer'), the
 * signature must match, the list must be long enough, and with `at` the list must be inside validFrom to validUntil. Never throws.
 */
export function verifyStatusList(value: unknown, issuerKey: MultikeyPublicKey, at?: number): VerifiedStatusList {
  try {
    const read = readCredential(value, NO_SCALES, { signed: true });
    if (!read.ok || read.value.type !== STATUS_LIST_TYPE || read.value.proof === undefined || read.value.id === undefined) return refuse('status-list-invalid');
    const signer = resolveDidKey(read.value.proof.verificationMethod);
    if (!signer.ok || !read.value.proof.verificationMethod.includes('#') || !sameKey(signer.publicKey, issuerKey)) return refuse('status-list-signer');
    const verified = verifyCredential(value, { publicKey: issuerKey, scales: NO_SCALES, ...(at === undefined ? {} : { at }) });
    if (!verified.ok) return refuse(verified.reason === 'expired' || verified.reason === 'not-yet-valid' ? 'status-list-expired' : 'status-list-invalid');
    const claims = verified.claims as unknown as { statusPurpose: StatusPurpose; encodedList: string; version: number; ttl?: number };
    const decoded = decodeBits(claims.encodedList);
    if (!('bits' in decoded)) return refuse(decoded.reason);
    const list: StatusListState = Object.freeze({
      id: read.value.id, issuer: read.value.issuer, purpose: claims.statusPurpose, version: claims.version, size: decoded.bits.length * 8,
      validFrom: read.value.validFrom, validUntil: read.value.validUntil, ...(claims.ttl === undefined ? {} : { ttl: claims.ttl }), bits: decoded.bits
    });
    return { ok: true, list, hash: credentialHash(value) };
  } catch {
    // Anything unreadable is not a list this version accepts.
    return refuse('status-list-invalid');
  }
}

/** One bit of a verified list for one purpose; undefined when the purpose is not the list's or the index is outside it. */
export function statusAt(list: StatusListState, index: number, purpose: StatusPurpose): boolean | undefined {
  if (purpose !== list.purpose || !Number.isSafeInteger(index) || index < 0 || index >= list.size) return undefined;
  return bitAt(list.bits, index);
}

export interface StatusCheckOptions {
  /** The key the policy names for this list. */
  readonly issuerKey: MultikeyPublicKey;
  /** The time of the check, epoch milliseconds: the list must be valid then. */
  readonly at: number;
}

/**
 * A credential's status in one list, failing closed: when the list is missing, does not verify against the policy key, is outside its validity at
 * `at`, is not the list the entry names or is for another purpose, the answer is 'status-unavailable', never "not revoked".
 */
export function checkCredentialStatus(entry: StatusEntry, listCredential: unknown, options: StatusCheckOptions):
{ readonly ok: true; readonly set: boolean; readonly listHash: string; readonly validFrom: string } | StatusListRefusal {
  if (listCredential === undefined) return refuse('status-unavailable');
  const verified = verifyStatusList(listCredential, options.issuerKey, options.at);
  if (!verified.ok || verified.list.id !== entry.statusListCredential) return refuse('status-unavailable');
  const set = statusAt(verified.list, entry.statusListIndex, entry.statusPurpose);
  if (set === undefined) return refuse('status-unavailable');
  return { ok: true, set, listHash: verified.hash, validFrom: verified.list.validFrom };
}

/**
 * A random index never allocated before (71-RESEARCH.md: random, never reused). `random` gives a number in [0, 1) from the caller's source (a CSPRNG in
 * production, seeded in tests). Undefined once the allocation limit is reached: start a new list pair then.
 */
export function nextIndex(allocated: ReadonlySet<number>, random: () => number, size: number = STATUS_LIST_ENTRIES): number | undefined {
  checkSize(size);
  if (allocated.size >= size / 2) return undefined;
  for (let draw = 0; draw < MAX_RANDOM_DRAWS; draw += 1) {
    const index = Math.floor(random() * size);
    if (Number.isSafeInteger(index) && index >= 0 && index < size && !allocated.has(index)) return index;
  }
  // A source that keeps repeating itself is still answered: the first free index after a random start.
  const start = Math.floor(Math.abs(random()) * size) % size;
  for (let step = 0; step < size; step += 1) {
    const index = (start + step) % size;
    if (!allocated.has(index)) return index;
  }
  return undefined;
}

/** The list with one bit set for its own purpose and its version raised. The caller re-signs it with a new validFrom. */
export function setBit(list: StatusListState, index: number, purpose: StatusPurpose): StatusListState {
  if (statusAt(list, index, purpose) === undefined) throw new RangeError('That index or purpose is not this list\'s.');
  return Object.freeze({ ...list, version: list.version + 1, bits: withBit(list.bits, index, true) });
}

/** A suspension list with one bit cleared and its version raised. A revocation list is refused: a revocation is never undone. */
export function clearSuspension(list: StatusListState, index: number): StatusListState {
  if (list.purpose !== 'suspension') throw new RangeError('Only a suspension can be lifted; a revocation is never undone.');
  if (statusAt(list, index, 'suspension') === undefined) throw new RangeError('That index is not this list\'s.');
  return Object.freeze({ ...list, version: list.version + 1, bits: withBit(list.bits, index, false) });
}

/** What entries cite (D-09): the credential hash of the signed list. */
export function listHash(listCredential: unknown): string {
  return credentialHash(listCredential);
}

/** True only for the same list (issuer and id) with a higher version and a later validFrom. */
export function newerThan(candidate: StatusListState, held: StatusListState): boolean {
  return candidate.issuer === held.issuer && candidate.id === held.id && candidate.purpose === held.purpose && candidate.version > held.version
    && credentialTimeMs(candidate.validFrom) > credentialTimeMs(held.validFrom);
}

/** Whether every revocation bit set in `held` is still set in `candidate` (always true for a suspension list). */
export function keepsRevocations(candidate: StatusListState, held: StatusListState): boolean {
  if (held.purpose !== 'revocation') return true;
  if (candidate.bits.length < held.bits.length) return false;
  return held.bits.every((byte, index) => ((candidate.bits[index] as number) & byte) === byte);
}

/**
 * A list handed over by another device or the hub (stapling, identity research 5.3 step 4): accepted only when it verifies against the policy key at
 * `at`, is newer than the one held (if any), and clears no revocation.
 */
export function acceptStapled(held: StatusListState | undefined, offered: unknown, options: StatusCheckOptions): VerifiedStatusList {
  const verified = verifyStatusList(offered, options.issuerKey, options.at);
  if (!verified.ok || held === undefined) return verified;
  if (!newerThan(verified.list, held)) return refuse('not-newer');
  if (!keepsRevocations(verified.list, held)) return refuse('revocation-cleared');
  return verified;
}
