// Your organization's enrolment file, the twelve words that name its key, and the check of every later rules file (FND-01, Phase 41 D-11 to D-17).
// Pure: node:crypto and src/domain only, no clock (the caller passes now), no I/O. The host reads and keeps the files (41-09); this module builds and
// checks their content.
//
// - Enrolment file (`.near-org-enrolment`, purpose org-enrolment, D-11): signed by the issuer key it names. It holds your organization's name and
//   contacts, the issuer's public key (and a DID slot unused until Phase 71), the dates, a serial, an optional key handover and the first organization
//   layer, so "enrolled with no rules" cannot exist. At most 64 KiB (D-56): a first set of rules that does not fit goes out later as a rules update.
// - Rules file (`.near-org-rules`, purpose org-policy-layer, D-09, D-14): one organization layer, up to 1 MiB, checked against the one key this computer
//   pinned for your organization and nothing else (D-15), never older than the last one accepted.
// - Twelve words (D-12): sha256 of ISSUER_WORDS_DOMAIN, NUL, then the raw key as a 4-byte big-endian length and its bytes; the first 132 bits pick
//   twelve words of the safety code list, 11 bits each from the most significant bit. The six-word safety code is safe only because it is interactive
//   with a fresh nonce; a fixed issuer key can be attacked offline without limit, so the issuer gets twelve words under a domain of its own.
// - Key handover (D-14): a new enrolment file signed by the new key whose `rotation.sig` is the pinned key's signature over rotationSigningInput (the
//   new key, the previous key, the serial and the time, under ROTATION_DOMAIN), with a higher serial than the pin's.
//
// Files arrive by mail, chat or USB and are read as hostile input (the rule of src/domain/replica/invite.ts): text is size-capped before it is parsed,
// fields are read as own properties only, parsed input is never spread into a result, and refusal reasons are closed records of plain sentences that
// carry no key or signature. No reader throws.
import { createHash } from 'node:crypto';
import { SAFETY_WORDS } from '../replica/safetyWords';
import { canonicalBytes, canonicalize, isStrictBase64url } from '../team/canonical';
import type { KeyStatusLookup } from '../team/keyStatus';
import { signPayload, verifyPayload } from '../team/signedPayload';
import type { PayloadFailureReason, PayloadSigner, SignedPayload } from '../team/signedPayload';
import { CLOCK_SKEW_MS, effectiveNow } from './bundle';
import type { BundleFailureReason } from './bundle';
import { ALWAYS_REQUIRED_FEATURES, featureForSection, isPolicySectionName } from './features';
import type { FeatureId } from './features';
import { MAX_ORGANIZATION_LAYER_BYTES, parsePolicyDocument, verifyPolicyLayer } from './policyDocument';
import type { PolicyDocument } from './policyDocument';
import { parseContacts } from './sections';
import type { PolicyContact } from './sections';
import { isRecord, parseIsoMillis } from './shape';
import { GATE_VOCABULARY_VERSION } from './vocabulary';

export const ENROLMENT_FILE_EXTENSION = '.near-org-enrolment';
export const ORGANIZATION_RULES_FILE_EXTENSION = '.near-org-rules';
/** An enrolment file is capped at 64 KiB before it is parsed (D-11, D-56). */
export const MAX_ENROLMENT_FILE_BYTES = 64 * 1024;
/** The enrolment payload's own version. */
export const ENROLMENT_VERSION = 1;

/** The twelve words' domain (D-12): distinct from the safety code's, so the two can never name the same thing. Read by every later version; never changes. */
export const ISSUER_WORDS_DOMAIN = 'near-ai/org-issuer/v1';
export const ISSUER_WORD_COUNT = 12;
const BITS_PER_WORD = 11;
/** 132 bits fit in the first 17 bytes of the hash (136 bits). */
const WORD_HASH_BYTES = 17;

/** The longest life the builders give: an enrolment file 90 days, an organization layer 366 days (D-17). The readers take any later expiry. */
export const MAX_ENROLMENT_DAYS = 90;
export const MAX_ORGANIZATION_LAYER_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SERIAL = 2 ** 31;
const MAX_ORGANIZATION_NAME = 120;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const MAX_DID = 256;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const ENROLMENT_KEYS = ['v', 'organization', 'issuer', 'issuedAt', 'expiresAt', 'serial', 'layer'] as const;
/** The keys of a v2 document that the builder writes itself; a rules file names sections only. */
const ENVELOPE_KEYS = ['bundleVersion', 'vocabulary', 'issuer', 'issuedAt', 'expiresAt', 'layer', 'requires', 'parent', 'minClient'] as const;

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The twelve words (D-12)

function lengthPrefixed(bytes: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function rawKey(publicKey: string): Buffer {
  if (typeof publicKey !== 'string' || !isStrictBase64url(publicKey, PUBLIC_KEY_BYTES)) throw new TypeError('The issuer key must be 32 bytes written as base64url.');
  return Buffer.from(publicKey, 'base64url');
}

/** The twelve lower-case words that name an issuer key. The same key gives the same words on every machine; a changed bit gives other words. */
export function issuerWords(publicKey: string): string[] {
  const digest = createHash('sha256').update(Buffer.from(`${ISSUER_WORDS_DOMAIN}\0`, 'utf8')).update(lengthPrefixed(rawKey(publicKey))).digest();
  let bits = 0n;
  for (let index = 0; index < WORD_HASH_BYTES; index += 1) bits = (bits << 8n) | BigInt(digest[index]);
  const total = WORD_HASH_BYTES * 8;
  const words: string[] = [];
  for (let word = 0; word < ISSUER_WORD_COUNT; word += 1) {
    const shift = BigInt(total - BITS_PER_WORD * (word + 1));
    words.push(SAFETY_WORDS[Number((bits >> shift) & 2047n)]);
  }
  return words;
}

/** The words as a screen shows them: lower case, one space between words. */
export function issuerWordsText(words: readonly string[]): string {
  return words.map((word) => word.toLowerCase()).join(' ');
}

/** sha256 of the raw key as 64 hex characters in groups of four, for the details line under the words. */
export function issuerFingerprintHex(publicKey: string): string {
  const hex = createHash('sha256').update(rawKey(publicKey)).digest('hex');
  return hex.match(/.{4}/g)!.join(' ');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Refusals

/** Every reason an enrolment file is refused, each one plain sentence naming what happened and the fix. Never Reset; no key or signature text. */
export const ENROLMENT_REFUSALS = {
  malformed: 'This is not an enrolment file from your organization that this version can read. Ask your organization\'s security contact for a new one.',
  'too-large': 'This file is larger than an enrolment file can be, so it was not opened. Ask your organization\'s security contact for a new one.',
  'bad-signature': 'The signature on this enrolment file does not match its content or the key it names, so it was changed or made by someone else. Nothing was changed. Ask your organization\'s security contact for a new one.',
  'clock-behind': 'This computer\'s clock is earlier than the time this enrolment file was signed. Set the clock to the right time, then open the file again.',
  'enrolment-expired': 'This enrolment file has expired. Ask your organization\'s security contact for a new one.',
  'own-key': 'This file was signed with this computer\'s own key, so it cannot hold your organization\'s rules. Nothing was changed.',
  'rotation-invalid': 'This file says your organization replaced its key, but the handover was not signed by the key it names, so nothing was changed. Ask your organization\'s security contact.',
  'other-organization': 'This computer already uses rules signed by another key, and this file carries no handover from that key, so nothing was changed. Ask your organization\'s security contact.',
  'older-file': 'This file is not newer than the key handover already in use on this computer, so nothing was changed. Ask your organization\'s security contact for the current file.',
  'needs-update': 'This file needs a newer version of NEAR AI. Update the NEAR AI extension, then open the file again.',
  'layer-refused': 'The rules inside this enrolment file could not be used, so nothing was changed. Ask your organization\'s security contact for a new enrolment file.'
} as const;
export type EnrolmentRefusal = keyof typeof ENROLMENT_REFUSALS;

/** Every reason an organization layer (a rules file, or the first rules inside an enrolment file) is refused. */
export const ORGANIZATION_LAYER_REFUSALS = {
  malformed: 'Your organization\'s rules are not in a form this version of NEAR AI can read, so they were not used. Ask your organization\'s security contact for a new rules file.',
  'too-large': 'Your organization\'s rules file is larger than the allowed size, so it was not opened. Ask your organization\'s security contact for a new rules file.',
  'needs-update': 'Your organization\'s rules need a feature this version of NEAR AI does not have. Update the NEAR AI extension to use them. Until then only reading and planning run.',
  'unknown-key': 'Your organization\'s rules were not signed by the key this computer uses for your organization, so they were not used.',
  'bad-signature': 'Your organization\'s rules were changed after they were signed, so they were not used. Ask your organization\'s security contact for a new rules file.',
  'signer-mismatch': 'Your organization\'s rules name a different signer than the key that signed them, so they were not used. Ask your organization\'s security contact for a new rules file.',
  'clock-behind': 'This computer\'s clock is earlier than the time your organization\'s rules were signed. Set the clock to the right time, then reload the window.',
  expired: 'Your organization\'s rules have ended. Ask your organization\'s security contact for the current rules.',
  older: 'These rules are older than the rules from your organization already in use on this computer, so they were not used.'
} as const;
export type OrganizationLayerRefusal = keyof typeof ORGANIZATION_LAYER_REFUSALS;

/** verifyPolicyLayer's failure reasons as organization layer refusals (D-07: every update reason says update, never Reset). */
function layerRefusalOf(reason: BundleFailureReason): OrganizationLayerRefusal {
  switch (reason) {
    case 'unknown-key':
    case 'too-large':
    case 'signer-mismatch':
    case 'clock-behind':
    case 'expired':
      return reason;
    case 'bad-signature':
    case 'key-mismatch':
      return 'bad-signature';
    case 'needs-update':
    case 'unsupported-version':
    case 'vocabulary-unknown':
    case 'unknown-field':
      return 'needs-update';
    default:
      return 'malformed';
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Shapes

export interface EnrolmentOrganization {
  /** One line, 1 to 120 characters. */
  readonly name: string;
  /** The onboarding.contacts shape: up to 8, sorted by topic then name. */
  readonly contacts: readonly PolicyContact[];
}

export interface EnrolmentIssuer {
  /** The raw 32 byte Ed25519 key as base64url. */
  readonly publicKey: string;
  /** A slot for Phase 71's DID; unused now. */
  readonly did?: string;
}

/** A key handover: the pinned key's signature over rotationSigningInput (D-14). */
export interface EnrolmentRotation {
  readonly previous: { readonly publicKey: string };
  readonly sig: string;
}

export interface EnrolmentPayload {
  readonly v: 1;
  readonly organization: EnrolmentOrganization;
  readonly issuer: EnrolmentIssuer;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** 1 to 2^31; a handover needs a higher serial than the pin's. */
  readonly serial: number;
  readonly rotation?: EnrolmentRotation;
  /** The first organization layer (purpose org-policy-layer), signed by the same issuer key. */
  readonly layer: SignedPayload;
}

const own = (record: Record<string, unknown>, key: string): unknown => (Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined);
// Every required key present and nothing outside required plus optional. Object.keys lists own keys only, so a parsed "__proto__" key is an extra key.
const hasKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const present = Object.keys(value);
  return required.every((key) => present.includes(key)) && present.every((key) => required.includes(key) || optional.includes(key));
};
const isLine = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() === value && !CONTROL.test(value);
const isPublicKey = (value: unknown): value is string => typeof value === 'string' && isStrictBase64url(value, PUBLIC_KEY_BYTES);
const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(parseIsoMillis(value));
const isSerial = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SERIAL;
const isDid = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_DID && DID_PATTERN.test(value);

function organizationOf(value: unknown): EnrolmentOrganization | undefined {
  if (!isRecord(value) || !hasKeys(value, ['name', 'contacts'])) return undefined;
  const name = own(value, 'name');
  if (!isLine(name, MAX_ORGANIZATION_NAME)) return undefined;
  const contacts = parseContacts(own(value, 'contacts'), 'organization.contacts');
  if (!contacts.ok) return undefined;
  return Object.freeze({ name, contacts: contacts.value });
}

function issuerOf(value: unknown): EnrolmentIssuer | undefined {
  if (!isRecord(value) || !hasKeys(value, ['publicKey'], ['did'])) return undefined;
  const publicKey = own(value, 'publicKey');
  if (!isPublicKey(publicKey)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, 'did')) return Object.freeze({ publicKey });
  const did = own(value, 'did');
  return isDid(did) ? Object.freeze({ publicKey, did }) : undefined;
}

function rotationOf(value: unknown): EnrolmentRotation | undefined {
  if (!isRecord(value) || !hasKeys(value, ['previous', 'sig'])) return undefined;
  const previous = own(value, 'previous');
  const sig = own(value, 'sig');
  if (!isRecord(previous) || !hasKeys(previous, ['publicKey'])) return undefined;
  const publicKey = own(previous, 'publicKey');
  if (!isPublicKey(publicKey) || typeof sig !== 'string' || !isStrictBase64url(sig, SIGNATURE_BYTES)) return undefined;
  return Object.freeze({ previous: Object.freeze({ publicKey }), sig });
}

type PayloadShape = { ok: true; payload: EnrolmentPayload } | { ok: false; reason: 'malformed' | 'needs-update' };

/** The enrolment payload read from hostile input: exact keys, own properties, a fresh value. The layer is checked later, by verifyOrganizationLayer. */
function enrolmentPayloadOf(value: unknown): PayloadShape {
  if (!isRecord(value)) return { ok: false, reason: 'malformed' };
  const version = own(value, 'v');
  // A newer enrolment format is read as "update the extension", never as a broken file (D-07).
  if (typeof version === 'number' && Number.isSafeInteger(version) && version > ENROLMENT_VERSION) return { ok: false, reason: 'needs-update' };
  if (version !== ENROLMENT_VERSION || !hasKeys(value, ENROLMENT_KEYS, ['rotation'])) return { ok: false, reason: 'malformed' };
  const organization = organizationOf(own(value, 'organization'));
  const issuer = issuerOf(own(value, 'issuer'));
  const issuedAt = own(value, 'issuedAt');
  const expiresAt = own(value, 'expiresAt');
  const serial = own(value, 'serial');
  const layer = own(value, 'layer');
  if (organization === undefined || issuer === undefined || !isTime(issuedAt) || !isTime(expiresAt) || !isSerial(serial) || !isRecord(layer)) {
    return { ok: false, reason: 'malformed' };
  }
  if (parseIsoMillis(expiresAt) <= parseIsoMillis(issuedAt)) return { ok: false, reason: 'malformed' };
  const payload: { -readonly [K in keyof EnrolmentPayload]: EnrolmentPayload[K] } = {
    v: ENROLMENT_VERSION, organization, issuer, issuedAt, expiresAt, serial, layer: JSON.parse(canonicalize(layer)) as SignedPayload
  };
  if (Object.prototype.hasOwnProperty.call(value, 'rotation')) {
    const rotation = rotationOf(own(value, 'rotation'));
    if (rotation === undefined) return { ok: false, reason: 'malformed' };
    payload.rotation = rotation;
  }
  return { ok: true, payload: Object.freeze(payload) };
}

// A file as it arrives: JSON text, measured before it is parsed, or a value a caller already parsed, measured by its canonical form. A value that has no
// canonical form (a function, a cycle, a non-plain object) is malformed.
function fileValue(file: unknown, maxBytes: number): { ok: true; value: unknown } | { ok: false; reason: 'too-large' | 'malformed' } {
  try {
    if (typeof file === 'string') {
      if (Buffer.byteLength(file, 'utf8') > maxBytes) return { ok: false, reason: 'too-large' };
      return { ok: true, value: JSON.parse(file) as unknown };
    }
    if (canonicalBytes(file).length > maxBytes) return { ok: false, reason: 'too-large' };
    return { ok: true, value: file };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

// The envelope's signer must be the one key the caller names, so the status lookup answers active for that key only (D-15).
const onlyKey = (publicKey: string): KeyStatusLookup => (key) => ({ state: key.publicKey === publicKey ? 'active' : 'unknown' });

function timeOf(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  return typeof value === 'string' ? parseIsoMillis(value) : Number.NaN;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Verifying an organization layer (D-09, D-14, D-15)

export interface VerifyOrganizationLayerOptions {
  /** The one key this layer may be signed by: the pinned issuer key, or the issuer an enrolment file names. */
  readonly issuerPublicKey: string;
  /** Epoch milliseconds from the wall clock. */
  readonly now: number;
  /** The issuedAt of the last organization layer this computer accepted (ISO time or epoch milliseconds): an older one is refused. */
  readonly lastIssuedAt?: string | number;
  /** Epoch milliseconds of the last time a policy was seen valid, so turning the clock back never revives an expired layer. */
  readonly lastValidAt?: number;
}

export type OrganizationLayerRead =
  | { readonly ok: true; readonly document: PolicyDocument; readonly hash: string; readonly issuedAt: string; readonly expiresAt: string; readonly renewDue: boolean }
  | { readonly ok: false; readonly reason: OrganizationLayerRefusal; readonly message: string; readonly failure: BundleFailureReason };

const layerRefused = (reason: OrganizationLayerRefusal, failure: BundleFailureReason): OrganizationLayerRead => ({ ok: false, reason, message: ORGANIZATION_LAYER_REFUSALS[reason], failure });

/**
 * Checks one organization layer (its JSON text or its parsed envelope) against exactly one key. The text is capped at 1 MiB before it is parsed; then
 * verifyPolicyLayer checks size, the purpose against the layer, the repeat of signer and signing time, the clock and the expiry, with a key source that
 * knows `issuerPublicKey` only, so any other key (this computer's included) is unknown-key. Last, the layer may not be older than `lastIssuedAt`; an equal
 * time is accepted and the caller compares hashes. Never throws.
 */
export function verifyOrganizationLayer(file: unknown, options: VerifyOrganizationLayerOptions): OrganizationLayerRead {
  try {
    const parsed = fileValue(file, MAX_ORGANIZATION_LAYER_BYTES);
    if (!parsed.ok) return layerRefused(parsed.reason, parsed.reason);
    if (!isPublicKey(options.issuerPublicKey)) return layerRefused('unknown-key', 'unknown-key');
    const options2 = { purpose: 'org-policy-layer' as const, status: onlyKey(options.issuerPublicKey), now: options.now };
    const state = verifyPolicyLayer(parsed.value, options.lastValidAt === undefined ? options2 : { ...options2, lastValidAt: options.lastValidAt });
    if (state.state !== 'valid') return layerRefused(layerRefusalOf(state.reason), state.reason);
    const last = timeOf(options.lastIssuedAt);
    if (last !== undefined) {
      // A last time that cannot be read cannot clear any layer, so the layer is refused as older (fail closed).
      if (Number.isNaN(last) || parseIsoMillis(state.document.issuedAt) < last) return layerRefused('older', 'replaced');
    }
    return { ok: true, document: state.document, hash: state.hash, issuedAt: state.document.issuedAt, expiresAt: state.expiresAt, renewDue: state.renewDue };
  } catch {
    return layerRefused('malformed', 'malformed');
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Reading an enrolment file (D-11)

export interface ReadEnrolmentOptions {
  /** Epoch milliseconds from the wall clock. */
  readonly now: number;
  /** This computer's own public key (or its identity): a file signed with it is refused own-key (D-15). */
  readonly deviceKey?: string | { readonly publicKey: string };
  /** Epoch milliseconds of the last time a policy was seen valid (the clock marker). */
  readonly lastValidAt?: number;
}

export type EnrolmentRead =
  | {
    readonly ok: true;
    readonly enrolment: EnrolmentPayload;
    readonly layer: Extract<OrganizationLayerRead, { ok: true }>;
    /** The twelve words of the issuer key, to compare aloud before anything is kept (D-12). */
    readonly words: readonly string[];
    readonly fingerprintHex: string;
  }
  | { readonly ok: false; readonly reason: EnrolmentRefusal; readonly message: string; readonly layerReason?: OrganizationLayerRefusal };

const enrolmentRefused = (reason: EnrolmentRefusal): Extract<EnrolmentRead, { ok: false }> => ({ ok: false, reason, message: ENROLMENT_REFUSALS[reason] });

function enrolmentReasonOf(reason: PayloadFailureReason): EnrolmentRefusal {
  switch (reason) {
    case 'too-large':
      return 'too-large';
    case 'bad-signature':
    case 'key-mismatch':
    case 'unknown-key':
    case 'key-revoked':
    case 'key-rotated':
      return 'bad-signature';
    case 'unsupported-version':
      return 'needs-update';
    default:
      return 'malformed';
  }
}

/**
 * Reads an enrolment file (its JSON text or its parsed envelope) at `now`. Order: the 64 KiB cap before parsing, the payload's exact shape, the signature
 * by the issuer key the payload names (and nothing else), the signing time equal to issuedAt, the key handover, this computer's own key, the clock and
 * expiry, and last the first layer through verifyOrganizationLayer with the same issuer key. Never throws.
 */
export function readEnrolmentFile(file: unknown, options: ReadEnrolmentOptions): EnrolmentRead {
  try {
    const parsed = fileValue(file, MAX_ENROLMENT_FILE_BYTES);
    if (!parsed.ok) return enrolmentRefused(parsed.reason);
    const value = parsed.value;
    if (!isRecord(value)) return enrolmentRefused('malformed');
    const shape = enrolmentPayloadOf(own(value, 'payload'));
    if (!shape.ok) return enrolmentRefused(shape.reason);
    const payload = shape.payload;
    const verdict = verifyPayload<unknown>(value, { purpose: 'org-enrolment', status: onlyKey(payload.issuer.publicKey), maxBytes: MAX_ENROLMENT_FILE_BYTES });
    if (!verdict.ok) return enrolmentRefused(enrolmentReasonOf(verdict.reason));
    if (verdict.signedAt !== payload.issuedAt) return enrolmentRefused('malformed');
    const rotation = rotationRefusal(payload);
    if (rotation !== undefined) return enrolmentRefused(rotation);
    const deviceKey = typeof options.deviceKey === 'string' ? options.deviceKey : options.deviceKey?.publicKey;
    if (deviceKey !== undefined && (payload.issuer.publicKey === deviceKey || payload.rotation?.previous.publicKey === deviceKey)) return enrolmentRefused('own-key');
    const effective = effectiveNow(options.now, options.lastValidAt);
    if (Number.isNaN(effective) || parseIsoMillis(payload.issuedAt) > effective + CLOCK_SKEW_MS) return enrolmentRefused('clock-behind');
    if (effective >= parseIsoMillis(payload.expiresAt)) return enrolmentRefused('enrolment-expired');
    const layerOptions = { issuerPublicKey: payload.issuer.publicKey, now: options.now };
    const layer = verifyOrganizationLayer(payload.layer, options.lastValidAt === undefined ? layerOptions : { ...layerOptions, lastValidAt: options.lastValidAt });
    if (!layer.ok) {
      const reason: EnrolmentRefusal = layer.reason === 'needs-update' ? 'needs-update' : 'layer-refused';
      return { ...enrolmentRefused(reason), layerReason: layer.reason };
    }
    return { ok: true, enrolment: payload, layer, words: Object.freeze(issuerWords(payload.issuer.publicKey)), fingerprintHex: issuerFingerprintHex(payload.issuer.publicKey) };
  } catch {
    // Hostile input never throws out of the reader.
    return enrolmentRefused('malformed');
  }
}

/** Filled in by the key handover check (Task 2 of 41-03); a file with no handover needs none. */
function rotationRefusal(payload: EnrolmentPayload): EnrolmentRefusal | undefined {
  return payload.rotation === undefined ? undefined : 'rotation-invalid';
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Building the files (the issuer tool, D-17)

export interface BuildLayerOptions {
  /** Epoch milliseconds: the layer's issuedAt and signing time. */
  readonly now: number;
  /** The layer's life, 1 to 366 days. */
  readonly days: number;
  readonly did?: string;
}

function checkDays(days: number, max: number, what: string): void {
  if (!Number.isSafeInteger(days) || days < 1 || days > max) throw new Error(`${what} must last from 1 to ${max} days.`);
}

function checkNow(now: number): Date {
  const date = new Date(now);
  if (!Number.isSafeInteger(now) || Number.isNaN(date.getTime())) throw new Error('The clock gave no valid time.');
  return date;
}

/**
 * Builds and signs one organization layer from its sections (purpose org-policy-layer, up to 1 MiB). The sections are the rules only: the builder writes
 * the envelope (bundleVersion, vocabulary, issuer, dates, layer 'organization' and `requires`, the sorted features of the sections present), and a key it
 * writes itself is refused in `sections`. The document must parse as a v2 policy, else the error names the refusal. Throws a plain Error.
 */
export function buildOrganizationLayer(signer: PayloadSigner, sections: Record<string, unknown>, options: BuildLayerOptions): SignedPayload<PolicyDocument> {
  if (!isRecord(sections)) throw new Error('The rules must be one JSON object of sections.');
  checkDays(options.days, MAX_ORGANIZATION_LAYER_DAYS, 'Your organization\'s rules');
  const issued = checkNow(options.now);
  const requires = new Set<FeatureId>(ALWAYS_REQUIRED_FEATURES);
  for (const key of Object.keys(sections)) {
    const shown = JSON.stringify(key.slice(0, 40));
    if ((ENVELOPE_KEYS as readonly string[]).includes(key)) throw new Error(`The rules may not set ${shown}: the tool writes it. Remove it from the rules file.`);
    if (!isPolicySectionName(key)) throw new Error(`The rules name a section this version does not know: ${shown}.`);
    const feature = featureForSection(key);
    if (feature !== undefined) requires.add(feature);
  }
  const issuer: Record<string, string> = { fingerprint: signer.fingerprint, publicKey: signer.publicKey };
  if (options.did !== undefined) issuer['did'] = options.did;
  const candidate: Record<string, unknown> = {
    bundleVersion: 2,
    vocabulary: GATE_VOCABULARY_VERSION,
    issuer,
    issuedAt: issued.toISOString(),
    expiresAt: new Date(options.now + options.days * DAY_MS).toISOString(),
    layer: 'organization',
    requires: [...requires].sort()
  };
  for (const key of Object.keys(sections)) candidate[key] = own(sections, key);
  const document = parsePolicyDocument(JSON.parse(JSON.stringify(candidate)) as unknown);
  if (!document.ok) throw new Error(`Your organization's rules were not signed: ${document.message}`);
  // A parsed document is its own v2 wire form, so the document itself is what is signed.
  return signPayload(signer, 'org-policy-layer', document.value, { now: () => issued, maxBytes: MAX_ORGANIZATION_LAYER_BYTES });
}

export interface BuildEnrolmentInput {
  readonly organization: EnrolmentOrganization;
  /** The first organization layer, signed by the same key (buildOrganizationLayer). */
  readonly layer: SignedPayload;
  /** Epoch milliseconds: the file's issuedAt and signing time. */
  readonly now: number;
  /** The file's life, 1 to 90 days. */
  readonly days: number;
  readonly serial: number;
  readonly did?: string;
  /** For a key handover (D-14): the pinned key, which signs the handover to `signer`. */
  readonly rotation?: PayloadSigner;
}

/** The bytes of a file as the issuer tool writes it: compact JSON and a newline. */
export function fileTextOf(signed: SignedPayload): string {
  return `${JSON.stringify(signed)}\n`;
}

/**
 * Builds and signs an enrolment file (purpose org-enrolment) and reads it back with readEnrolmentFile before returning it. Throws a plain Error when a
 * field is not valid, when the file would be over 64 KiB (the first rules are then too large: D-56), or when the file does not read back.
 */
export function buildEnrolment(signer: PayloadSigner, input: BuildEnrolmentInput): SignedPayload<EnrolmentPayload> {
  checkDays(input.days, MAX_ENROLMENT_DAYS, 'An enrolment file');
  const issued = checkNow(input.now);
  if (organizationOf(JSON.parse(JSON.stringify(input.organization)) as unknown) === undefined) {
    throw new Error('The enrolment file was not made: the organization needs a name of 1 to 120 characters on one line and at most 8 contacts, sorted by topic then name.');
  }
  if (!isSerial(input.serial)) throw new Error(`The enrolment file was not made: the serial must be a whole number from 1 to ${MAX_SERIAL}.`);
  if (input.did !== undefined && !isDid(input.did)) throw new Error('The enrolment file was not made: the DID is not valid.');
  const issuer: { publicKey: string; did?: string } = { publicKey: signer.publicKey };
  if (input.did !== undefined) issuer.did = input.did;
  const payload: Record<string, unknown> = {
    v: ENROLMENT_VERSION,
    organization: JSON.parse(JSON.stringify(input.organization)) as unknown,
    issuer,
    issuedAt: issued.toISOString(),
    expiresAt: new Date(input.now + input.days * DAY_MS).toISOString(),
    serial: input.serial,
    layer: input.layer
  };
  if (input.rotation !== undefined) payload['rotation'] = rotationFor(input.rotation, signer.publicKey, input.serial, issued.toISOString());
  const envelope = signPayload(signer, 'org-enrolment', payload as unknown as EnrolmentPayload, { now: () => issued, maxBytes: MAX_ORGANIZATION_LAYER_BYTES * 2 });
  const bytes = Buffer.byteLength(fileTextOf(envelope), 'utf8');
  if (bytes > MAX_ENROLMENT_FILE_BYTES) {
    throw new Error(`The enrolment file would be ${bytes} bytes, over the ${MAX_ENROLMENT_FILE_BYTES} byte limit. Enrol with a smaller first set of rules and send the rest as a rules update.`);
  }
  const read = readEnrolmentFile(fileTextOf(envelope), { now: input.now });
  if (!read.ok) throw new Error(`The enrolment file was not made: it does not read back. ${read.layerReason === undefined ? read.message : ORGANIZATION_LAYER_REFUSALS[read.layerReason]}`);
  return envelope;
}

/** Filled in by the key handover (Task 2 of 41-03). */
function rotationFor(_previous: PayloadSigner, _newPublicKey: string, _serial: number, _issuedAt: string): EnrolmentRotation {
  throw new Error('A key handover is not available yet.');
}
