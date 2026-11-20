// One exception record (authorizations@1, FND-04, Phase 41 D-15, D-23, D-29 to D-32). Pure: no I/O, no clock (the caller passes `now`), no vscode, no package.
// Each entry of `authorizations[]` is a SignedPayload with purpose `policy-authorization`, signed by the named person's own key, so its key and signature
// travel in `publicKey` and `sig`, the only names the secret scanner exempts. The body says what is allowed (kind, subject, scope, conditions), on what
// evidence, by whom, and until when; each kind has a maximum length.
// Key sources are never mixed (D-15, D-31): an authorization verifies only against the signers your organization's layer lists (`people.signers`), or, when
// there is no organization layer, only against this device's own key, which every screen then calls "self-signed on this computer". This file never
// combines two key sources.
// Two kinds record export-control decisions (D-61): `export-person` (who may see controlled technical data, per regime) and `export-endpoint` (which AI
// service may receive it). Their conditions hold only a basis, an extent, an authority and dates, never citizenship, a birth date or assessment content,
// which stay in your organization's security files; strict keys refuse every such field. Nothing grants access with them in this phase (Phase 45).
// Imported values are used only inside functions, never at module load.
import { CLOCK_SKEW_MS, parseTimestamp } from './bundle';
import { ENDPOINT_REGIONS } from './endpoints';
import type { EndpointClass, EndpointRegion } from './endpoints';
import { parseRegimes } from './sections';
import type { ExportRegime } from './sections';
import { checkKeys, childPath, isRecord, ownValue, parseIsoMillis, refused } from './shape';
import type { Parsed } from './shape';
import { fingerprintOf, isStrictBase64url } from '../team/canonical';
import type { KeyStatusLookup } from '../team/keyStatus';
import { verifyPayload } from '../team/signedPayload';
import type { PayloadFailureReason, SignedPayload } from '../team/signedPayload';

/**
 * The kinds of exception (D-29): Protected B on a named place, a T1 model risk, an accredited device, a residency exception, a declassification; then the
 * two export-control decisions about a person and an AI service (D-61). Append-only.
 */
export const AUTHORIZATION_KINDS = Object.freeze([
  'protected-b', 't1-risk', 'accredited-device', 'residency-exception', 'declassify', 'export-person', 'export-endpoint'
] as const);
export type AuthorizationKind = (typeof AUTHORIZATION_KINDS)[number];

/** What each kind is about. */
export const SUBJECT_KINDS = Object.freeze(['endpoint', 'model', 'device', 'item', 'person'] as const);
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const SUBJECT_FOR_KIND: Readonly<Record<AuthorizationKind, SubjectKind>> = Object.freeze({
  'protected-b': 'endpoint',
  't1-risk': 'model',
  'accredited-device': 'device',
  'residency-exception': 'endpoint',
  declassify: 'item',
  'export-person': 'person',
  'export-endpoint': 'endpoint'
});

/**
 * The longest each kind may run, in days (D-30): t1-risk 90 (provenance O3), protected-b 365 (Cohere 6.3), accredited-device 365, residency-exception 90.
 * declassify has none, like today's label-declassify records, which keep working unchanged (D-32). export-endpoint 365 (D-61); export-person is measured in
 * calendar years per regime by latestExpiryFor.
 */
export const MAX_DAYS_BY_KIND: Readonly<Record<AuthorizationKind, number | undefined>> = Object.freeze({
  'protected-b': 365,
  't1-risk': 90,
  'accredited-device': 365,
  'residency-exception': 90,
  declassify: undefined,
  'export-person': undefined,
  'export-endpoint': 365
});

/** The CGP bases of an export-person decision: assessed (CGR s. 13, five years) or one of the exemptions (three years). */
export const CGP_BASES = Object.freeze([
  'assessed', 'exempt-us-itar-registered', 'exempt-us-official', 'exempt-temporary-worker', 'exempt-student', 'exempt-visitor'
] as const);
export type CgpBasis = (typeof CGP_BASES)[number];

/** What the designated official allows under CGR s. 13(a). */
export const CGP_EXTENTS = Object.freeze(['examine', 'possess', 'transfer'] as const);
export type CgpExtent = (typeof CGP_EXTENTS)[number];

/** The ITAR and EAR bases of an export-person decision. */
export const US_EXPORT_BASES = Object.freeze([
  'us-person', 'canadian-registered-person', 'licence', 'agreement', 'dual-third-country-126.18', 'exempt-other'
] as const);
export type UsExportBasis = (typeof US_EXPORT_BASES)[number];

/** Whether an AI service holds only ciphertext or decrypts to compute. */
export const EXPORT_PLAINTEXT = Object.freeze(['none', 'processes'] as const);

/** Classes your organization runs or that run on this computer: an export-endpoint record for any other class must cite its legal basis (D-61). */
export const LEGAL_BASIS_EXEMPT_CLASSES: readonly EndpointClass[] = Object.freeze(['local', 'org-plain', 'org-tee'] as const);

export interface CgpPersonCondition {
  readonly basis: CgpBasis;
  readonly extent: readonly CgpExtent[];
  readonly authority?: string;
  readonly excludes?: readonly string[];
}

export interface UsExportPersonCondition {
  readonly basis: UsExportBasis;
  /** The licence, agreement or exemption cited; required for licence, agreement and exempt-other. */
  readonly authority?: string;
  /** The cited licence or agreement's own end; required for licence and agreement, and the decision never runs past it. */
  readonly authorityExpiresAt?: string;
  readonly excludes?: readonly string[];
}

/** One entry per regime of `scope.regimes`, and nothing about the person beyond the basis (D-61). */
export interface ExportPersonConditions {
  readonly CGP?: CgpPersonCondition;
  readonly EAR?: UsExportPersonCondition;
  readonly ITAR?: UsExportPersonCondition;
}

export interface ExportEndpointConditions {
  readonly regimes: readonly ExportRegime[];
  readonly region: EndpointRegion;
  /** Who runs it: your organization, or the provider with its registration references. */
  readonly operator: string;
  /** Who can reach the data in the clear. */
  readonly access: string;
  readonly crypto?: string;
  readonly plaintext: (typeof EXPORT_PLAINTEXT)[number];
  /** The written opinion or authorization relied on; required for a class outside LEGAL_BASIS_EXEMPT_CLASSES. */
  readonly legalBasis?: string;
}

export type AuthorizationConditions = readonly string[] | ExportPersonConditions | ExportEndpointConditions;

const EXPORT_KINDS: readonly AuthorizationKind[] = Object.freeze(['export-person', 'export-endpoint'] as const);

/** Said wherever an authorization, an acceptance or a trust line cites a record this device signed itself (D-23). */
export const SELF_SIGNED_TEXT = 'self-signed on this computer';

export type AuthorizationSubject =
  | { readonly endpoint: string }
  | { readonly model: string }
  | { readonly device: string }
  | { readonly item: string }
  | { readonly person: string };

/** Which projects, labels (`scale/level`) and uses (lowercase tokens such as `t1`) a record covers. An absent list covers any; a present one is never empty. */
export interface AuthorizationScope {
  readonly projects?: readonly string[];
  readonly labels?: readonly string[];
  readonly uses?: readonly string[];
  /** The export regimes an export-person or export-endpoint record covers; required for those kinds, refused for the others. */
  readonly regimes?: readonly ExportRegime[];
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
  /** Plain conditions the person attached, 0 to 8 texts; for the export kinds, their structured conditions (D-61). */
  readonly conditions: AuthorizationConditions;
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

function parseScope(value: unknown, kind: AuthorizationKind, path: string): Parsed<AuthorizationScope> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, [], ['projects', 'labels', 'uses', 'regimes']);
  if (keys !== undefined) return keys;
  const out: Record<string, readonly string[]> = {};
  const exportKind = EXPORT_KINDS.includes(kind);
  if (Object.prototype.hasOwnProperty.call(value, 'regimes')) {
    if (!exportKind) return refused('not-allowed-here', childPath(path, 'regimes'));
    const regimes = parseRegimes(ownValue(value, 'regimes'), childPath(path, 'regimes'));
    if (!regimes.ok) return regimes;
    out['regimes'] = regimes.value;
  } else if (exportKind) {
    return refused('missing-field', childPath(path, 'regimes'));
  }
  const lists: ReadonlyArray<readonly [string, RegExp]> = [['projects', SUBJECT_VALUE_PATTERN], ['labels', LABEL_KEY_PATTERN], ['uses', USE_PATTERN]];
  for (const [key, pattern] of lists) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const list = parseTokenSet(ownValue(value, key), childPath(path, key), MAX_SCOPE_ENTRIES, pattern);
    if (!list.ok) return list;
    out[key] = list.value;
  }
  return { ok: true, value: Object.freeze(out) as AuthorizationScope };
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

const AUTHORITY_MAX = 64;
const MAX_EXCLUDES = 16;
const EXCLUDE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function parseOptionalText(value: Record<string, unknown>, key: string, path: string, max: number, out: Record<string, unknown>): Parsed<true> {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return { ok: true, value: true };
  const text = parseText(ownValue(value, key), childPath(path, key), max);
  if (!text.ok) return text;
  out[key] = text.value;
  return { ok: true, value: true };
}

function parseExcludes(value: Record<string, unknown>, path: string, out: Record<string, unknown>): Parsed<true> {
  if (!Object.prototype.hasOwnProperty.call(value, 'excludes')) return { ok: true, value: true };
  const list = parseTokenSet(ownValue(value, 'excludes'), childPath(path, 'excludes'), MAX_EXCLUDES, EXCLUDE_PATTERN);
  if (!list.ok) return list;
  out['excludes'] = list.value;
  return { ok: true, value: true };
}

function parseCgpCondition(value: unknown, path: string): Parsed<CgpPersonCondition> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['basis', 'extent'], ['authority', 'excludes']);
  if (keys !== undefined) return keys;
  const basis = parseChoice(ownValue(value, 'basis'), childPath(path, 'basis'), CGP_BASES);
  if (!basis.ok) return basis;
  const extentPath = childPath(path, 'extent');
  const extent = parseTokenSet(ownValue(value, 'extent'), extentPath, CGP_EXTENTS.length, /^[a-z]+$/);
  if (!extent.ok) return extent;
  for (let index = 0; index < extent.value.length; index += 1) {
    if (!(CGP_EXTENTS as readonly string[]).includes(extent.value[index] as string)) return refused('not-allowed-here', `${extentPath}[${String(index)}]`);
  }
  const out: Record<string, unknown> = { basis: basis.value, extent: extent.value };
  const authority = parseOptionalText(value, 'authority', path, AUTHORITY_MAX, out);
  if (!authority.ok) return authority;
  const excludes = parseExcludes(value, path, out);
  if (!excludes.ok) return excludes;
  return { ok: true, value: Object.freeze(out) as unknown as CgpPersonCondition };
}

function parseUsCondition(value: unknown, path: string): Parsed<UsExportPersonCondition> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['basis'], ['authority', 'authorityExpiresAt', 'excludes']);
  if (keys !== undefined) return keys;
  const basis = parseChoice(ownValue(value, 'basis'), childPath(path, 'basis'), US_EXPORT_BASES);
  if (!basis.ok) return basis;
  const out: Record<string, unknown> = { basis: basis.value };
  const authority = parseOptionalText(value, 'authority', path, AUTHORITY_MAX, out);
  if (!authority.ok) return authority;
  const cited = basis.value === 'licence' || basis.value === 'agreement';
  if ((cited || basis.value === 'exempt-other') && out['authority'] === undefined) return refused('missing-field', childPath(path, 'authority'));
  if (Object.prototype.hasOwnProperty.call(value, 'authorityExpiresAt')) {
    const at = parseTimestamp(ownValue(value, 'authorityExpiresAt'), childPath(path, 'authorityExpiresAt'));
    if (!at.ok) return at;
    out['authorityExpiresAt'] = at.value;
  } else if (cited) {
    return refused('missing-field', childPath(path, 'authorityExpiresAt'));
  }
  const excludes = parseExcludes(value, path, out);
  if (!excludes.ok) return excludes;
  return { ok: true, value: Object.freeze(out) as unknown as UsExportPersonCondition };
}

/** export-person conditions: exactly one entry per regime of the scope, CGP with its basis and extent, ITAR and EAR with theirs (D-61). */
function parseExportPersonConditions(value: unknown, regimes: readonly ExportRegime[], path: string): Parsed<ExportPersonConditions> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, regimes);
  if (keys !== undefined) return keys;
  const out: Record<string, unknown> = {};
  for (const regime of regimes) {
    const where = childPath(path, regime);
    const parsed = regime === 'CGP' ? parseCgpCondition(ownValue(value, regime), where) : parseUsCondition(ownValue(value, regime), where);
    if (!parsed.ok) return parsed;
    out[regime] = parsed.value;
  }
  return { ok: true, value: Object.freeze(out) as ExportPersonConditions };
}

function parseExportEndpointConditions(value: unknown, regimes: readonly ExportRegime[], path: string): Parsed<ExportEndpointConditions> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['regimes', 'region', 'operator', 'access', 'plaintext'], ['crypto', 'legalBasis']);
  if (keys !== undefined) return keys;
  const listed = parseRegimes(ownValue(value, 'regimes'), childPath(path, 'regimes'));
  if (!listed.ok) return listed;
  if (listed.value.join(',') !== regimes.join(',')) return refused('not-allowed-here', childPath(path, 'regimes'));
  const region = parseChoice(ownValue(value, 'region'), childPath(path, 'region'), ENDPOINT_REGIONS);
  if (!region.ok) return region;
  const operator = parseText(ownValue(value, 'operator'), childPath(path, 'operator'), 128);
  if (!operator.ok) return operator;
  const access = parseText(ownValue(value, 'access'), childPath(path, 'access'), MAX_CONDITION_TEXT);
  if (!access.ok) return access;
  const plaintext = parseChoice(ownValue(value, 'plaintext'), childPath(path, 'plaintext'), EXPORT_PLAINTEXT);
  if (!plaintext.ok) return plaintext;
  const out: Record<string, unknown> = { regimes: listed.value, region: region.value, operator: operator.value, access: access.value, plaintext: plaintext.value };
  const crypto = parseOptionalText(value, 'crypto', path, MAX_CONDITION_TEXT, out);
  if (!crypto.ok) return crypto;
  const legalBasis = parseOptionalText(value, 'legalBasis', path, MAX_EVIDENCE, out);
  if (!legalBasis.ok) return legalBasis;
  return { ok: true, value: Object.freeze(out) as unknown as ExportEndpointConditions };
}

function parseConditions(value: unknown, kind: AuthorizationKind, scope: AuthorizationScope, path: string): Parsed<AuthorizationConditions> {
  if (kind === 'export-person') return parseExportPersonConditions(value, scope.regimes ?? [], path);
  if (kind === 'export-endpoint') return parseExportEndpointConditions(value, scope.regimes ?? [], path);
  return parseConditionTexts(value, path);
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
  const scope = parseScope(ownValue(value, 'scope'), kind.value, childPath(path, 'scope'));
  if (!scope.ok) return scope;
  const conditions = parseConditions(ownValue(value, 'conditions'), kind.value, scope.value, childPath(path, 'conditions'));
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

function plusYears(ms: number, years: number): number {
  const date = new Date(ms);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.getTime();
}

/**
 * The latest expiry the kind allows for this body, in epoch milliseconds; undefined when the kind has no maximum (declassify). An export-person decision is
 * measured in UTC calendar years per regime: CGP assessed five, a CGP exemption three, ITAR or EAR five and never past the cited authority's own end; the
 * earliest regime wins (D-61).
 */
export function latestExpiryFor(body: Pick<AuthorizationBody, 'kind' | 'issuedAt' | 'scope' | 'conditions'>): number | undefined {
  const issued = parseIsoMillis(body.issuedAt);
  if (body.kind !== 'export-person') {
    const days = MAX_DAYS_BY_KIND[body.kind];
    return days === undefined ? undefined : issued + days * DAY_MS;
  }
  const conditions = body.conditions as ExportPersonConditions;
  let latest = Number.NaN;
  for (const regime of body.scope.regimes ?? []) {
    let limit: number;
    if (regime === 'CGP') {
      limit = plusYears(issued, conditions.CGP?.basis === 'assessed' ? 5 : 3);
    } else {
      limit = plusYears(issued, 5);
      const cited = conditions[regime]?.authorityExpiresAt;
      if (cited !== undefined) limit = Math.min(limit, parseIsoMillis(cited));
    }
    latest = Number.isNaN(latest) ? limit : Math.min(latest, limit);
  }
  // An export-person record with no regime has no length that could be allowed (the parser already refuses one).
  return Number.isNaN(latest) ? issued : latest;
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
  /** An export regime (export-person and export-endpoint records). */
  readonly regime?: ExportRegime;
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
  if (!coversOne(body.scope.regimes, question.regime)) return false;
  if (body.revokedBy !== undefined || !Number.isFinite(now)) return false;
  return parseIsoMillis(body.issuedAt) <= now + CLOCK_SKEW_MS && now < parseIsoMillis(body.expiresAt);
}

