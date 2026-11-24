// Every credential type of the data-centric access research and its exact claims (Phase 71, D-06, VCRD-01, VCRD-05; PLAN-IDS.md "Credential types").
// Pure: no I/O, no clock, no vscode, no package. Claims are read with exact keys, own properties only, and returned frozen, in the refusal style of
// src/domain/gate/shape.ts. Scales come from the caller (the policy's scales, or the gate's presets where the gate reads them), never imported here,
// so a credential is read against the same scales as the label it is checked against (architecture rule scale-presets).
//
// Type names and claim names are PERMANENT once a credential is issued: they are signed into every credential and cited by hash in shared logs. The
// list below is append-only. A changed claim shape is a new context version, never an edit in place.
import { LABEL_TOKEN_PATTERN, RELEASABILITY_NONE, RESERVED_EXPORT_COMPARTMENTS, levelIndex, scaleOf } from '../gate/labels';
import type { ScaleTable } from '../gate/labels';
import { checkKeys, childPath, isRecord, isSafeIntegerInRange, ownValue, refused } from '../gate/shape';
import type { Fields, Parsed } from '../gate/shape';

/** About one person: issued under the policy's `credentials@1` issuance rules by a holder of the matching role credential. */
export const PERSON_ATTRIBUTE_TYPES = Object.freeze([
  'MembershipCredential', 'ClearanceCredential', 'CompartmentCredential', 'ServiceCredential', 'NationalityCredential', 'AffiliationCredential',
  'ExportEligibilityCredential', 'AccessAgreementCredential', 'VisitClearanceCredential', 'ObserverAccessCredential'
] as const);

/** Authority (role) credentials: who holds a role. Only your organization's root issues them (D-12, D-13); ClassificationAuthorityCredential is one. */
export const ROLE_TYPES = Object.freeze([
  'IssuerRoleCredential', 'SecurityContactCredential', 'ReleaseAuthorityCredential', 'ClassificationAuthorityCredential', 'RoleCredential'
] as const);

export const DEVICE_BINDING_TYPE = 'DeviceBindingCredential';
export const STATUS_LIST_TYPE = 'BitstringStatusListCredential';
/** Reserved for Phase 71.1 (agent delegation). Refused until that phase defines its claims. */
export const RESERVED_TYPES = Object.freeze(['DelegationCredential'] as const);

/** Every type this version reads. Append-only: names are permanent once issued. */
export const CREDENTIAL_TYPES = Object.freeze([...PERSON_ATTRIBUTE_TYPES, ...ROLE_TYPES, DEVICE_BINDING_TYPE, STATUS_LIST_TYPE] as const);
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];
export type PersonAttributeType = (typeof PERSON_ATTRIBUTE_TYPES)[number];
export type RoleType = (typeof ROLE_TYPES)[number];

/** How a person serves (33.1 D-21 and D-29): the four internal ways, then allied military and industry. */
export const SERVES_VALUES = Object.freeze(['regular-force', 'reserve-force', 'public-servant', 'contractor', 'allied-military', 'industry'] as const);
/** The device classes of a DeviceBindingCredential (identity research, section 3). */
export const DEVICE_CLASSES = Object.freeze(['managed', 'personal', 'edge'] as const);
export const STATUS_PURPOSES = Object.freeze(['revocation', 'suspension'] as const);
export type StatusPurpose = (typeof STATUS_PURPOSES)[number];

export interface ClearanceClaims { readonly scale: string; readonly atLeast: string }
export interface ClassificationAuthorityClaims { readonly scale: string; readonly upTo: string; readonly scope: string }
export interface IssuerRoleClaims {
  readonly credentialType: PersonAttributeType;
  readonly scale?: string;
  readonly upTo?: string;
  readonly compartments?: readonly string[];
  readonly regimes?: readonly string[];
}
export interface StatusListClaims { readonly type: 'BitstringStatusList'; readonly statusPurpose: StatusPurpose; readonly encodedList: string; readonly ttl?: number; readonly version: number }

/** Claims as read: the subject's `id` and the type's own fields, frozen. */
export type Claims = Readonly<Record<string, unknown>> & { readonly id: string };

const MAX_TEXT = 256;
const MAX_ENCODED_LIST = 64 * 1024;
const MAX_CELLS = 256;
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,2048}$/;
const DEVICE_FINGERPRINT = /^dev-[0-9a-f]{32}$/;
const ROLE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const SCOPED = /^(project|section):[A-Za-z0-9._-]{1,128}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const OWN_ITEMS = 'own-items';
const ORGANIZATION_SCOPE = 'organization';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** A credential time: UTC with a capital Z, seconds or exactly three fraction digits, no date that rolls over. Epoch milliseconds, or NaN. */
export function credentialTimeMs(value: unknown): number {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return Number.NaN;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return Number.NaN;
  const iso = new Date(ms).toISOString();
  return iso === value || iso.replace('.000Z', 'Z') === value ? ms : Number.NaN;
}

export function isDid(value: unknown): value is string {
  return typeof value === 'string' && DID_PATTERN.test(value);
}

export function isCredentialType(value: unknown): value is CredentialType {
  return typeof value === 'string' && (CREDENTIAL_TYPES as readonly string[]).includes(value);
}

export function isRoleType(value: unknown): value is RoleType {
  return typeof value === 'string' && (ROLE_TYPES as readonly string[]).includes(value);
}

/**
 * VCRD-05: the thresholds a holder cleared to `level` on `scale` holds, lowest first: one ClearanceCredential per level up to and including it, so a
 * check that asks for Confidential is shown that one and nothing higher. Empty when the scale or level is unknown.
 */
export function thresholdsFor(scales: ScaleTable, scale: string, level: string): readonly string[] {
  const rank = levelIndex(scales, scale, level);
  const found = scaleOf(scales, scale);
  if (found === undefined || rank < 0) return Object.freeze([]);
  return Object.freeze(found.levels.slice(0, rank + 1));
}

type Reader = (value: Fields, path: string, scales: ScaleTable) => Parsed<Record<string, unknown>>;

function text(value: Fields, key: string, path: string): Parsed<string> {
  const found = ownValue(value, key);
  if (typeof found !== 'string' || found.length === 0 || found.length > MAX_TEXT) return refused('wrong-type', childPath(path, key));
  return { ok: true, value: found };
}

function token(value: Fields, key: string, path: string): Parsed<string> {
  const found = ownValue(value, key);
  if (typeof found !== 'string' || !LABEL_TOKEN_PATTERN.test(found)) return refused('wrong-type', childPath(path, key));
  if (found === RELEASABILITY_NONE) return refused('not-allowed-here', childPath(path, key));
  return { ok: true, value: found };
}

function oneOf<T extends string>(value: Fields, key: string, path: string, allowed: readonly T[]): Parsed<T> {
  const found = ownValue(value, key);
  if (typeof found !== 'string') return refused('wrong-type', childPath(path, key));
  if (!(allowed as readonly string[]).includes(found)) return refused('not-allowed-here', childPath(path, key));
  return { ok: true, value: found as T };
}

function time(value: Fields, key: string, path: string): Parsed<string> {
  const found = ownValue(value, key);
  if (Number.isNaN(credentialTimeMs(found))) return refused('wrong-type', childPath(path, key));
  return { ok: true, value: found as string };
}

/** `organization`, `project:<id>` or `section:<id>`; `own-items` too where the type allows it. */
function scope(value: Fields, path: string, allowOwnItems: boolean): Parsed<string> {
  const found = ownValue(value, 'scope');
  if (typeof found !== 'string') return refused('wrong-type', childPath(path, 'scope'));
  if (found === ORGANIZATION_SCOPE || SCOPED.test(found) || (allowOwnItems && found === OWN_ITEMS)) return { ok: true, value: found };
  return refused('not-allowed-here', childPath(path, 'scope'));
}

function scaleLevel(value: Fields, path: string, scales: ScaleTable, levelKey: string): Parsed<{ scale: string; level: string }> {
  const scale = ownValue(value, 'scale');
  if (typeof scale !== 'string') return refused('wrong-type', childPath(path, 'scale'));
  if (scaleOf(scales, scale) === undefined) return refused('not-allowed-here', childPath(path, 'scale'));
  const level = ownValue(value, levelKey);
  if (typeof level !== 'string') return refused('wrong-type', childPath(path, levelKey));
  if (levelIndex(scales, scale, level) < 0) return refused('not-allowed-here', childPath(path, levelKey));
  return { ok: true, value: { scale, level } };
}

/** A non-empty, strictly ascending list of distinct entries that each pass `check`. */
function sortedList(value: unknown, path: string, check: (entry: unknown) => boolean, max: number): Parsed<readonly string[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return refused(Array.isArray(value) && value.length === 0 ? 'empty-list' : 'wrong-type', path);
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (typeof entry !== 'string' || !check(entry)) return refused('wrong-type', `${path}[${String(index)}]`);
    if (index > 0) {
      const before = value[index - 1] as string;
      if (entry === before) return refused('duplicate', `${path}[${String(index)}]`);
      if (entry < before) return refused('not-sorted', `${path}[${String(index)}]`);
    }
  }
  return { ok: true, value: Object.freeze([...(value as string[])]) };
}

function fields<T extends Record<string, Parsed<unknown>>>(parts: T): Parsed<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, part] of Object.entries(parts)) {
    if (!part.ok) return part;
    out[key] = part.value;
  }
  return { ok: true, value: out };
}

const READERS: Readonly<Record<CredentialType, { readonly claims: readonly string[]; readonly optional?: readonly string[]; readonly read: Reader }>> = {
  MembershipCredential: { claims: ['organization'], read: (v, p) => fields({ organization: text(v, 'organization', p) }) },
  ClearanceCredential: {
    claims: ['scale', 'atLeast'],
    read: (v, p, scales) => {
      const found = scaleLevel(v, p, scales, 'atLeast');
      return found.ok ? { ok: true, value: { scale: found.value.scale, atLeast: found.value.level } } : found;
    }
  },
  CompartmentCredential: { claims: ['compartment'], read: (v, p) => fields({ compartment: token(v, 'compartment', p) }) },
  ServiceCredential: { claims: ['serves'], read: (v, p) => fields({ serves: oneOf(v, 'serves', p, SERVES_VALUES) }) },
  // ISO 3166-1 alpha-3 codes are label tokens, and so are 48.1 D-25's group tokens; "releasable to no one" is never a nationality.
  NationalityCredential: { claims: ['nationality'], read: (v, p) => fields({ nationality: token(v, 'nationality', p) }) },
  AffiliationCredential: { claims: ['organization'], read: (v, p) => fields({ organization: text(v, 'organization', p) }) },
  ExportEligibilityCredential: {
    claims: ['regime', 'basis'],
    read: (v, p) => fields({ regime: oneOf(v, 'regime', p, RESERVED_EXPORT_COMPARTMENTS), basis: text(v, 'basis', p) })
  },
  AccessAgreementCredential: { claims: ['agreement', 'scope'], read: (v, p) => fields({ agreement: text(v, 'agreement', p), scope: scope(v, p, false) }) },
  VisitClearanceCredential: {
    claims: ['request', 'site', 'from', 'until'],
    read: (v, p) => {
      const read = fields({ request: text(v, 'request', p), site: text(v, 'site', p), from: time(v, 'from', p), until: time(v, 'until', p) });
      if (read.ok && credentialTimeMs(read.value.from) >= credentialTimeMs(read.value.until)) return refused('not-allowed-here', childPath(p, 'until'));
      return read;
    }
  },
  ObserverAccessCredential: {
    claims: ['project', 'position', 'cells', 'until'],
    read: (v, p) => fields({
      project: text(v, 'project', p),
      position: text(v, 'position', p),
      cells: sortedList(ownValue(v, 'cells'), childPath(p, 'cells'), (entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_TEXT, MAX_CELLS),
      until: time(v, 'until', p)
    })
  },
  IssuerRoleCredential: {
    claims: ['credentialType'],
    optional: ['scale', 'upTo', 'compartments', 'regimes'],
    read: (v, p, scales) => {
      const credentialType = oneOf(v, 'credentialType', p, PERSON_ATTRIBUTE_TYPES);
      if (!credentialType.ok) return credentialType;
      const out: Record<string, unknown> = { credentialType: credentialType.value };
      const hasScale = Object.prototype.hasOwnProperty.call(v, 'scale');
      const hasUpTo = Object.prototype.hasOwnProperty.call(v, 'upTo');
      // A ceiling is a scale and a level together, never one without the other.
      if (hasScale !== hasUpTo) return refused('missing-field', childPath(p, hasScale ? 'upTo' : 'scale'));
      if (hasScale) {
        const ceiling = scaleLevel(v, p, scales, 'upTo');
        if (!ceiling.ok) return ceiling;
        out.scale = ceiling.value.scale;
        out.upTo = ceiling.value.level;
      }
      if (Object.prototype.hasOwnProperty.call(v, 'compartments')) {
        const list = sortedList(ownValue(v, 'compartments'), childPath(p, 'compartments'), (entry) => typeof entry === 'string' && LABEL_TOKEN_PATTERN.test(entry) && entry !== RELEASABILITY_NONE, 64);
        if (!list.ok) return list;
        out.compartments = list.value;
      }
      if (Object.prototype.hasOwnProperty.call(v, 'regimes')) {
        const list = sortedList(ownValue(v, 'regimes'), childPath(p, 'regimes'), (entry) => (RESERVED_EXPORT_COMPARTMENTS as readonly unknown[]).includes(entry), 3);
        if (!list.ok) return list;
        out.regimes = list.value;
      }
      return { ok: true, value: out };
    }
  },
  SecurityContactCredential: { claims: ['scope'], read: (v, p) => fields({ scope: scope(v, p, false) }) },
  ReleaseAuthorityCredential: { claims: ['scope'], read: (v, p) => fields({ scope: scope(v, p, false) }) },
  ClassificationAuthorityCredential: {
    claims: ['scale', 'upTo', 'scope'],
    read: (v, p, scales) => {
      const ceiling = scaleLevel(v, p, scales, 'upTo');
      if (!ceiling.ok) return ceiling;
      const where = scope(v, p, true);
      return where.ok ? { ok: true, value: { scale: ceiling.value.scale, upTo: ceiling.value.level, scope: where.value } } : where;
    }
  },
  RoleCredential: {
    claims: ['role', 'scope'],
    read: (v, p) => {
      const role = ownValue(v, 'role');
      if (typeof role !== 'string' || !ROLE_NAME.test(role)) return refused('wrong-type', childPath(p, 'role'));
      return fields({ role: { ok: true, value: role }, scope: scope(v, p, false) });
    }
  },
  DeviceBindingCredential: {
    claims: ['device', 'class'],
    read: (v, p) => {
      const device = ownValue(v, 'device');
      if (typeof device !== 'string' || !DEVICE_FINGERPRINT.test(device)) return refused('wrong-type', childPath(p, 'device'));
      return fields({ device: { ok: true, value: device }, class: oneOf(v, 'class', p, DEVICE_CLASSES) });
    }
  },
  // The W3C status list (Bitstring Status List v1.0, 2.2) plus our `version`, which orders two lists of the same id (71-05).
  BitstringStatusListCredential: {
    claims: ['type', 'statusPurpose', 'encodedList', 'version'],
    optional: ['ttl'],
    read: (v, p) => {
      if (ownValue(v, 'type') !== 'BitstringStatusList') return refused('not-allowed-here', childPath(p, 'type'));
      const encodedList = ownValue(v, 'encodedList');
      if (typeof encodedList !== 'string' || encodedList.length < 2 || encodedList.length > MAX_ENCODED_LIST || !/^u[A-Za-z0-9_-]+$/.test(encodedList)) {
        return refused('wrong-type', childPath(p, 'encodedList'));
      }
      const version = ownValue(v, 'version');
      if (!isSafeIntegerInRange(version, 1, Number.MAX_SAFE_INTEGER)) return refused('wrong-type', childPath(p, 'version'));
      const out: Record<string, unknown> = { type: 'BitstringStatusList', encodedList, version };
      const purpose = oneOf(v, 'statusPurpose', p, STATUS_PURPOSES);
      if (!purpose.ok) return purpose;
      out.statusPurpose = purpose.value;
      if (Object.prototype.hasOwnProperty.call(v, 'ttl')) {
        const ttl = ownValue(v, 'ttl');
        if (!isSafeIntegerInRange(ttl, 1, ONE_YEAR_MS)) return refused('wrong-type', childPath(p, 'ttl'));
        out.ttl = ttl;
      }
      return { ok: true, value: out };
    }
  }
};

/**
 * Reads the claims of one credential type from its `credentialSubject`: the subject's `id` (a DID; a did:key for a DeviceBindingCredential) and exactly
 * the type's claims, nothing missing, nothing extra and nothing of the wrong kind. An unknown or reserved type is refused. The result is frozen.
 */
export function parseClaims(type: string, credentialSubject: unknown, scales: ScaleTable, path = 'credentialSubject'): Parsed<Claims> {
  if (!isCredentialType(type)) return refused('not-available-yet', 'type');
  if (!isRecord(credentialSubject)) return refused('wrong-type', path);
  const reader = READERS[type];
  const keys = checkKeys(credentialSubject, path, ['id', ...reader.claims], reader.optional ?? []);
  if (keys !== undefined) return keys;
  const id = ownValue(credentialSubject, 'id');
  if (type === STATUS_LIST_TYPE) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 2048) return refused('wrong-type', childPath(path, 'id'));
  } else if (!isDid(id)) {
    return refused('wrong-type', childPath(path, 'id'));
  } else if (type === DEVICE_BINDING_TYPE && !id.startsWith('did:key:')) {
    return refused('not-allowed-here', childPath(path, 'id'));
  }
  const read = reader.read(credentialSubject, path, scales);
  if (!read.ok) return read;
  return { ok: true, value: Object.freeze({ id: id as string, ...read.value }) };
}
