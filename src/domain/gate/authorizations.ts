// One exception record (authorizations@1, FND-04, Phase 41 D-15, D-23, D-29 to D-32). Pure: no I/O, no clock (the caller passes `now`), no vscode, no package.
// Each entry of `authorizations[]` is a SignedPayload with purpose `policy-authorization`, signed by the named person's own key, so its key and signature
// travel in `publicKey` and `sig`, the only names the secret scanner exempts. The body says what is allowed (kind, subject, scope, conditions), on what
// evidence, by whom, and until when; each kind has a maximum length.
// Key sources are never mixed (D-15, D-31): an authorization verifies only against the signers your organization's layer lists (`people.signers`), or, when
// there is no organization layer, only against this device's own key, which every screen then calls "self-signed on this computer". This file never
// combines two key sources.
// Imported values are used only inside functions, never at module load.
import { CLOCK_SKEW_MS, parseTimestamp } from './bundle';
import { checkKeys, childPath, isRecord, ownValue, parseIsoMillis, refused } from './shape';
import type { Parsed } from './shape';
import { fingerprintOf, isStrictBase64url } from '../team/canonical';
import type { KeyStatusLookup } from '../team/keyStatus';
import { verifyPayload } from '../team/signedPayload';
import type { PayloadFailureReason, SignedPayload } from '../team/signedPayload';

/** The kinds of exception (D-29): Protected B on a named place, a T1 model risk, an accredited device, a residency exception, a declassification. */
export const AUTHORIZATION_KINDS = Object.freeze(['protected-b', 't1-risk', 'accredited-device', 'residency-exception', 'declassify'] as const);
export type AuthorizationKind = (typeof AUTHORIZATION_KINDS)[number];

/** What each kind is about. */
export const SUBJECT_KINDS = Object.freeze(['endpoint', 'model', 'device', 'item'] as const);
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const SUBJECT_FOR_KIND: Readonly<Record<AuthorizationKind, SubjectKind>> = Object.freeze({
  'protected-b': 'endpoint',
  't1-risk': 'model',
  'accredited-device': 'device',
  'residency-exception': 'endpoint',
  declassify: 'item'
});

/**
 * The longest each kind may run, in days (D-30): t1-risk 90 (provenance O3), protected-b 365 (Cohere 6.3), accredited-device 365, residency-exception 90.
 * declassify has none, like today's label-declassify records, which keep working unchanged (D-32).
 */
export const MAX_DAYS_BY_KIND: Readonly<Record<AuthorizationKind, number | undefined>> = Object.freeze({
  'protected-b': 365,
  't1-risk': 90,
  'accredited-device': 365,
  'residency-exception': 90,
  declassify: undefined
});

/** Said wherever an authorization, an acceptance or a trust line cites a record this device signed itself (D-23). */
export const SELF_SIGNED_TEXT = 'self-signed on this computer';

export type AuthorizationSubject =
  | { readonly endpoint: string }
  | { readonly model: string }
  | { readonly device: string }
  | { readonly item: string };

/** Which projects, labels (`scale/level`) and uses (lowercase tokens such as `t1`) a record covers. An absent list covers any; a present one is never empty. */
export interface AuthorizationScope {
  readonly projects?: readonly string[];
  readonly labels?: readonly string[];
  readonly uses?: readonly string[];
}

export interface NamedPerson {
  readonly name: string;
  readonly role: string;
}

export interface AuthorizationBody {
  readonly v: 1;
  readonly id: string;
  readonly kind: AuthorizationKind;
  readonly subject: AuthorizationSubject;
  readonly scope: AuthorizationScope;
  /** Plain conditions the person attached, 0 to 8 texts. */
  readonly conditions: readonly string[];
  /** A reference to the assessment in your organization's own files. */
  readonly evidence: string;
  readonly namedPerson: NamedPerson;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** Set when the record was revoked, naming what revoked it; a revoked record never counts. */
  readonly revokedBy?: string;
}

/** A person your organization's layer lists as one who may sign authorizations, with the key they sign with (D-31). */
export interface PolicySigner {
  readonly name: string;
  readonly role: string;
  /** The raw 32 byte Ed25519 key as base64url. */
  readonly publicKey: string;
  /** fingerprintOf the key, repeated so a list can be read and sorted without decoding keys. */
  readonly fingerprint: string;
}

export const MAX_AUTHORIZATIONS = 256;
export const MAX_POLICY_SIGNERS = 64;
const MAX_SCOPE_ENTRIES = 64;
const MAX_CONDITIONS = 8;
const MAX_CONDITION_TEXT = 280;
const MAX_EVIDENCE = 200;
const MAX_PERSON_TEXT = 64;
const MAX_REVOKED_BY = 128;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const DAY_MS = 24 * 60 * 60 * 1000;
export const AUTHORIZATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A subject or project id: an endpoint id, a model id (`org/model:tag`), a device fingerprint or an item path, 1 to 128 characters. */
export const SUBJECT_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const USE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const LABEL_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}\/[^\u0000-\u001F\u007F/][^\u0000-\u001F\u007F]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

function parseText(value: unknown, path: string, max: number): Parsed<string> {
  if (typeof value !== 'string' || value === '' || value.length > max || CONTROL_CHARACTERS.test(value)) return refused('wrong-type', path);
  return { ok: true, value };
}

function parseChoice<T extends string>(value: unknown, path: string, allowed: readonly T[]): Parsed<T> {
  if (typeof value !== 'string') return refused('wrong-type', path);
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined ? refused('not-allowed-here', path) : { ok: true, value: found };
}

/** A non-empty, sorted, unique list of at most `max` texts, each matching `pattern`. */
function parseTokenSet(value: unknown, path: string, max: number, pattern: RegExp): Parsed<readonly string[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  if (value.length === 0) return refused('empty-list', path);
  if (value.length > max) return refused('not-allowed-here', path);
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const where = `${path}[${String(index)}]`;
    const item: unknown = value[index];
    if (typeof item !== 'string' || !pattern.test(item)) return refused('wrong-type', where);
    const before = out[out.length - 1];
    if (before !== undefined && item === before) return refused('duplicate', where);
    if (before !== undefined && item < before) return refused('not-sorted', where);
    out.push(item);
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseNamedPerson(value: unknown, path: string): Parsed<NamedPerson> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['name', 'role']);
  if (keys !== undefined) return keys;
  const name = parseText(ownValue(value, 'name'), childPath(path, 'name'), MAX_PERSON_TEXT);
  if (!name.ok) return name;
  const role = parseText(ownValue(value, 'role'), childPath(path, 'role'), MAX_PERSON_TEXT);
  if (!role.ok) return role;
  return { ok: true, value: Object.freeze({ name: name.value, role: role.value }) };
}

/** Exactly one subject key, the one the kind is about. */
function parseSubject(value: unknown, kind: AuthorizationKind, path: string): Parsed<AuthorizationSubject> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const expected = SUBJECT_FOR_KIND[kind];
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!(SUBJECT_KINDS as readonly string[]).includes(key)) return refused('unknown-field', childPath(path, key.slice(0, 40)));
    if (key !== expected) return refused('not-allowed-here', childPath(path, key));
  }
  if (keys.length !== 1) return refused('missing-field', childPath(path, expected));
  const id = ownValue(value, expected);
  if (typeof id !== 'string' || !SUBJECT_VALUE_PATTERN.test(id)) return refused('wrong-type', childPath(path, expected));
  return { ok: true, value: Object.freeze({ [expected]: id }) as AuthorizationSubject };
}

function parseScope(value: unknown, path: string): Parsed<AuthorizationScope> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, [], ['projects', 'labels', 'uses']);
  if (keys !== undefined) return keys;
  const out: Record<string, readonly string[]> = {};
  const lists: ReadonlyArray<readonly [string, RegExp]> = [['projects', SUBJECT_VALUE_PATTERN], ['labels', LABEL_KEY_PATTERN], ['uses', USE_PATTERN]];
  for (const [key, pattern] of lists) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const list = parseTokenSet(ownValue(value, key), childPath(path, key), MAX_SCOPE_ENTRIES, pattern);
    if (!list.ok) return list;
    out[key] = list.value;
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseConditionTexts(value: unknown, path: string): Parsed<readonly string[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  if (value.length > MAX_CONDITIONS) return refused('not-allowed-here', path);
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const text = parseText(value[index], `${path}[${String(index)}]`, MAX_CONDITION_TEXT);
    if (!text.ok) return text;
    out.push(text.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

const BODY_REQUIRED = ['v', 'id', 'kind', 'subject', 'scope', 'conditions', 'evidence', 'namedPerson', 'issuedAt', 'expiresAt'] as const;

/** The body of one authorization, with exact keys at every level. Shape only: the signature, the signer and the times are verifyAuthorization's. */
export function parseAuthorizationBody(value: unknown, path = ''): Parsed<AuthorizationBody> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const v = ownValue(value, 'v');
  if (typeof v === 'number' && v !== 1) return refused('unknown-version', childPath(path, 'v'));
  const keys = checkKeys(value, path, BODY_REQUIRED, ['revokedBy']);
  if (keys !== undefined) return keys;
  if (v !== 1) return refused('wrong-type', childPath(path, 'v'));
  const id = ownValue(value, 'id');
  if (typeof id !== 'string' || !AUTHORIZATION_ID_PATTERN.test(id)) return refused('wrong-type', childPath(path, 'id'));
  const kind = parseChoice(ownValue(value, 'kind'), childPath(path, 'kind'), AUTHORIZATION_KINDS);
  if (!kind.ok) return kind;
  const subject = parseSubject(ownValue(value, 'subject'), kind.value, childPath(path, 'subject'));
  if (!subject.ok) return subject;
  const scope = parseScope(ownValue(value, 'scope'), childPath(path, 'scope'));
  if (!scope.ok) return scope;
  const conditions = parseConditionTexts(ownValue(value, 'conditions'), childPath(path, 'conditions'));
  if (!conditions.ok) return conditions;
  const evidence = parseText(ownValue(value, 'evidence'), childPath(path, 'evidence'), MAX_EVIDENCE);
  if (!evidence.ok) return evidence;
  const namedPerson = parseNamedPerson(ownValue(value, 'namedPerson'), childPath(path, 'namedPerson'));
  if (!namedPerson.ok) return namedPerson;
  const issuedAt = parseTimestamp(ownValue(value, 'issuedAt'), childPath(path, 'issuedAt'));
  if (!issuedAt.ok) return issuedAt;
  const expiresAt = parseTimestamp(ownValue(value, 'expiresAt'), childPath(path, 'expiresAt'));
  if (!expiresAt.ok) return expiresAt;
  if (parseIsoMillis(expiresAt.value) <= parseIsoMillis(issuedAt.value)) return refused('wrong-type', childPath(path, 'expiresAt'));
  const out: Record<string, unknown> = {
    v: 1, id, kind: kind.value, subject: subject.value, scope: scope.value, conditions: conditions.value, evidence: evidence.value,
    namedPerson: namedPerson.value, issuedAt: issuedAt.value, expiresAt: expiresAt.value
  };
  if (Object.prototype.hasOwnProperty.call(value, 'revokedBy')) {
    const revokedBy = parseText(ownValue(value, 'revokedBy'), childPath(path, 'revokedBy'), MAX_REVOKED_BY);
    if (!revokedBy.ok) return revokedBy;
    out['revokedBy'] = revokedBy.value;
  }
  return { ok: true, value: Object.freeze(out) as unknown as AuthorizationBody };
}

/** One authorization envelope, shape only: exact keys, version 1, purpose policy-authorization, a strict key and signature, no member id, the body parsed. */
function parseAuthorizationEnvelope(value: unknown, path: string): Parsed<SignedPayload<AuthorizationBody>> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const v = ownValue(value, 'v');
  if (typeof v === 'number' && v !== 1) return refused('unknown-version', childPath(path, 'v'));
  const keys = checkKeys(value, path, ['v', 'purpose', 'signer', 'signedAt', 'payload', 'sig']);
  if (keys !== undefined) return keys;
  if (v !== 1) return refused('wrong-type', childPath(path, 'v'));
  if (ownValue(value, 'purpose') !== 'policy-authorization') return refused('not-allowed-here', childPath(path, 'purpose'));
  const signerPath = childPath(path, 'signer');
  const signer = ownValue(value, 'signer');
  if (!isRecord(signer)) return refused('wrong-type', signerPath);
  const signerKeys = checkKeys(signer, signerPath, ['fingerprint', 'publicKey']);
  if (signerKeys !== undefined) return signerKeys;
  const publicKey = ownValue(signer, 'publicKey');
  if (typeof publicKey !== 'string' || !isStrictBase64url(publicKey, PUBLIC_KEY_BYTES)) return refused('wrong-type', childPath(signerPath, 'publicKey'));
  const fingerprint = ownValue(signer, 'fingerprint');
  if (typeof fingerprint !== 'string' || fingerprint !== fingerprintOf(Buffer.from(publicKey, 'base64url'))) return refused('wrong-type', childPath(signerPath, 'fingerprint'));
  const signedAt = parseTimestamp(ownValue(value, 'signedAt'), childPath(path, 'signedAt'));
  if (!signedAt.ok) return signedAt;
  const sig = ownValue(value, 'sig');
  if (typeof sig !== 'string' || !isStrictBase64url(sig, SIGNATURE_BYTES)) return refused('wrong-type', childPath(path, 'sig'));
  const body = parseAuthorizationBody(ownValue(value, 'payload'), childPath(path, 'payload'));
  if (!body.ok) return body;
  return {
    ok: true,
    value: Object.freeze({ v: 1, purpose: 'policy-authorization', signer: Object.freeze({ fingerprint, publicKey }), signedAt: signedAt.value, payload: body.value, sig })
  };
}

/** authorizations[]: at most MAX_AUTHORIZATIONS envelopes, sorted by body id and unique. Shape only; verifyAuthorization decides whether one counts. */
export function parseAuthorizations(value: unknown, path = 'authorizations'): Parsed<readonly SignedPayload<AuthorizationBody>[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  if (value.length > MAX_AUTHORIZATIONS) return refused('not-allowed-here', path);
  const out: SignedPayload<AuthorizationBody>[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const where = `${path}[${String(index)}]`;
    const envelope = parseAuthorizationEnvelope(value[index], where);
    if (!envelope.ok) return envelope;
    const before = out[out.length - 1];
    if (out.some((other) => other.payload.id === envelope.value.payload.id)) return refused('duplicate', where);
    if (before !== undefined && envelope.value.payload.id < before.payload.id) return refused('not-sorted', where);
    out.push(envelope.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseSigner(value: unknown, path: string): Parsed<PolicySigner> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['name', 'role', 'publicKey', 'fingerprint']);
  if (keys !== undefined) return keys;
  const name = parseText(ownValue(value, 'name'), childPath(path, 'name'), MAX_PERSON_TEXT);
  if (!name.ok) return name;
  const role = parseText(ownValue(value, 'role'), childPath(path, 'role'), MAX_PERSON_TEXT);
  if (!role.ok) return role;
  const publicKey = ownValue(value, 'publicKey');
  if (typeof publicKey !== 'string' || !isStrictBase64url(publicKey, PUBLIC_KEY_BYTES)) return refused('wrong-type', childPath(path, 'publicKey'));
  const fingerprint = ownValue(value, 'fingerprint');
  if (typeof fingerprint !== 'string' || fingerprint !== fingerprintOf(Buffer.from(publicKey, 'base64url'))) return refused('wrong-type', childPath(path, 'fingerprint'));
  return { ok: true, value: Object.freeze({ name: name.value, role: role.value, publicKey, fingerprint }) };
}

/** people.signers: at most MAX_POLICY_SIGNERS, sorted by fingerprint and unique (D-31). */
export function parsePolicySigners(value: unknown, path = 'signers'): Parsed<readonly PolicySigner[]> {
  if (!Array.isArray(value)) return refused('wrong-type', path);
  if (value.length > MAX_POLICY_SIGNERS) return refused('not-allowed-here', path);
  const out: PolicySigner[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const where = `${path}[${String(index)}]`;
    const signer = parseSigner(value[index], where);
    if (!signer.ok) return signer;
    const before = out[out.length - 1];
    if (before !== undefined && signer.value.fingerprint === before.fingerprint) return refused('duplicate', where);
    if (before !== undefined && signer.value.fingerprint < before.fingerprint) return refused('not-sorted', where);
    out.push(signer.value);
  }
  return { ok: true, value: Object.freeze(out) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Verifying one authorization (D-15, D-29 to D-31)

/** Every reason an authorization does not count, each one plain sentence. A reason is added here with its sentence and a test, never at a call site. */
export const AUTHORIZATION_REFUSALS = Object.freeze({
  malformed: 'This approval is not one this version of NEAR AI can read.',
  'wrong-purpose': 'This signed item is not an approval.',
  'too-large': 'This approval is larger than the allowed size.',
  'bad-signature': 'This approval was changed after it was signed, or was not signed by the key it names.',
  'unknown-signer': 'This approval was not signed by a person your organization lists as one who may approve, so it does not count.',
  'signer-mismatch': 'This approval says it was made at a different time than its signature says.',
  'named-person-mismatch': 'The person named in this approval is not the person your organization lists for the key that signed it.',
  'not-yet-valid': 'This approval starts later than the time on this computer.',
  expired: 'This approval has ended. Ask the person who signed it for a new one.',
  'too-long': 'This approval runs longer than the longest time allowed for its kind, so it does not count.',
  revoked: 'This approval was revoked, so it does not count.'
} as const);
export type AuthorizationRefusal = keyof typeof AUTHORIZATION_REFUSALS;

/** The verifier's reasons in this file's words. Keeps a new verifier reason from compiling until it has a meaning here. */
const FROM_PAYLOAD: Readonly<Record<PayloadFailureReason, AuthorizationRefusal>> = Object.freeze({
  malformed: 'malformed',
  'unsupported-version': 'malformed',
  'unknown-purpose': 'wrong-purpose',
  'wrong-purpose': 'wrong-purpose',
  'too-large': 'too-large',
  'key-mismatch': 'bad-signature',
  'bad-signature': 'bad-signature',
  'unknown-key': 'unknown-signer',
  'key-revoked': 'unknown-signer',
  'key-rotated': 'unknown-signer'
});

export interface VerifyAuthorizationOptions {
  /**
   * The signers your organization's layer lists (`people.signers`). Pass them, possibly empty, whenever an organization layer exists; then only they count,
   * and this device counts only when it is one of them (D-31).
   */
  readonly signers?: readonly PolicySigner[];
  /** This device's own key. With no `signers` it is the only key that counts ("self-signed on this computer"); it is never added to `signers`. */
  readonly thisDevice?: { readonly fingerprint: string; readonly publicKey: string };
  /** Epoch milliseconds. */
  readonly now: number;
}

export type AuthorizationVerdict =
  | { readonly ok: true; readonly body: AuthorizationBody; readonly selfSigned: boolean }
  | { readonly ok: false; readonly reason: AuthorizationRefusal; readonly message: string };

function refuse(reason: AuthorizationRefusal): AuthorizationVerdict {
  return { ok: false, reason, message: AUTHORIZATION_REFUSALS[reason] };
}

function sameKey(a: { readonly fingerprint: string; readonly publicKey: string }, b: { readonly fingerprint: string; readonly publicKey: string }): boolean {
  return a.fingerprint === b.fingerprint && a.publicKey === b.publicKey;
}

/** The latest expiry the kind allows for this body, in epoch milliseconds; undefined when the kind has no maximum (declassify). */
export function latestExpiryFor(body: Pick<AuthorizationBody, 'kind' | 'issuedAt'>): number | undefined {
  const days = MAX_DAYS_BY_KIND[body.kind];
  return days === undefined ? undefined : parseIsoMillis(body.issuedAt) + days * DAY_MS;
}

/**
 * Whether one authorization envelope counts now. The key source is exactly one (D-15): the listed signers when `signers` is given, otherwise this device
 * alone; a lookup built here from that one source is the only status the verifier sees. Then the body, issuedAt equal to the signing time, the listed
 * signer's name and role equal to the named person (with signers), not revoked, not too long for its kind, started (within the clock skew) and not ended.
 * Never throws.
 */
export function verifyAuthorization(envelope: unknown, options: VerifyAuthorizationOptions): AuthorizationVerdict {
  try {
    const signers = options.signers;
    const device = options.thisDevice;
    const status: KeyStatusLookup = signers !== undefined
      ? (key) => (signers.some((signer) => sameKey(signer, key)) ? { state: 'active' } : { state: 'unknown' })
      : (key) => (device !== undefined && sameKey(device, key) ? { state: 'active' } : { state: 'unknown' });
    const verdict = verifyPayload<unknown>(envelope, { purpose: 'policy-authorization', status });
    if (!verdict.ok) return refuse(FROM_PAYLOAD[verdict.reason]);
    if (verdict.signer.memberId !== undefined) return refuse('malformed');
    const body = parseAuthorizationBody(verdict.payload);
    if (!body.ok) return refuse('malformed');
    if (body.value.issuedAt !== verdict.signedAt) return refuse('signer-mismatch');
    if (signers !== undefined) {
      const listed = signers.find((signer) => sameKey(signer, verdict.signer));
      if (listed === undefined) return refuse('unknown-signer');
      if (listed.name !== body.value.namedPerson.name || listed.role !== body.value.namedPerson.role) return refuse('named-person-mismatch');
    }
    if (body.value.revokedBy !== undefined) return refuse('revoked');
    const issued = parseIsoMillis(body.value.issuedAt);
    const expires = parseIsoMillis(body.value.expiresAt);
    const latest = latestExpiryFor(body.value);
    if (latest !== undefined && !(expires <= latest)) return refuse('too-long');
    if (!Number.isFinite(options.now) || issued > options.now + CLOCK_SKEW_MS) return refuse('not-yet-valid');
    if (options.now >= expires) return refuse('expired');
    return { ok: true, body: body.value, selfSigned: device !== undefined && sameKey(device, verdict.signer) };
  } catch {
    return refuse('malformed');
  }
}

/** What a caller asks an authorization to cover. An absent field asks nothing of the matching scope list. */
export interface AuthorizationQuestion {
  readonly kind: AuthorizationKind;
  readonly subject: AuthorizationSubject;
  readonly project?: string;
  /** A `scale/level` key. */
  readonly label?: string;
  /** A lowercase use token such as `t1`. */
  readonly use?: string;
}

function coversOne(list: readonly string[] | undefined, asked: string | undefined): boolean {
  if (list === undefined) return true;
  return asked !== undefined && list.includes(asked);
}

function subjectEquals(a: AuthorizationSubject, b: AuthorizationSubject): boolean {
  const left = Object.keys(a);
  const right = Object.keys(b);
  if (left.length !== 1 || right.length !== 1 || left[0] !== right[0]) return false;
  const key = left[0] as keyof AuthorizationSubject;
  return (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key];
}

/**
 * Whether a verified body covers one question now: the same kind and subject; each scope list absent (any) or holding the asked value (a present list
 * with no asked value covers nothing, D-54); started within the clock skew, not ended, not revoked. The signature is verifyAuthorization's to check.
 */
export function authorizationCovers(body: AuthorizationBody, question: AuthorizationQuestion, now: number): boolean {
  if (body.kind !== question.kind || !subjectEquals(body.subject, question.subject)) return false;
  if (!coversOne(body.scope.projects, question.project) || !coversOne(body.scope.labels, question.label) || !coversOne(body.scope.uses, question.use)) return false;
  if (body.revokedBy !== undefined || !Number.isFinite(now)) return false;
  return parseIsoMillis(body.issuedAt) <= now + CLOCK_SKEW_MS && now < parseIsoMillis(body.expiresAt);
}

