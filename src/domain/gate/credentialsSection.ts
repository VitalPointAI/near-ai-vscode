// The credentials section of a signed policy (feature credentials@1; Phase 71, D-07, D-11, D-12, D-14, DCAC-01): the one place that says who may issue
// what, which status lists count and how fresh evidence must be. Pure: no I/O, no clock, no vscode, no package.
//
// Who holds a role is a role credential from your organization's root (revocable); what a role may issue is this section. Shape:
//   { v: 1, root: { did, scid? }, issuance: { <person-attribute type>: { role, ceiling? } }, suites, didMethods, statusLists: [{ uri, purpose, key }],
//     statusTtl, maxOfflineAge: { 'scale/level': seconds }, requiredBySensitivity: { 'scale/level': [types] }, fallbackPersonKeys? }
// Numbers are whole seconds (every policy number is a safe, non-negative integer). With did:webvh allowed, the root is a did:webvh whose SCID is pinned
// here; under the D-03 fallback (did:webvh not allowed) the root and the officers' person keys are did:keys this section names (D-07, owner item 2).
// When this section is present, the reserved v1 slots statusLists and maxOfflineAge must be empty, so Phase 70's OFFL-03 slot is filled in one place.
import { parseMaxOfflineAge, parseStatusList, MAX_STATUS_LISTS } from './bundle';
import { levelIndex, splitLabelKey } from './labels';
import type { ScaleTable } from './labels';
import { openSection } from './sections';
import { childPath, isRecord, ownValue, refused } from './shape';
import type { Fields, Parsed } from './shape';
import { decodePublicKeyMultibase, MultibaseError } from '../credentials/multibase';
import { PERSON_ATTRIBUTE_TYPES, ROLE_TYPES } from '../credentials/types';
import type { PersonAttributeType, RoleType } from '../credentials/types';

export const CREDENTIAL_SUITE_IDS = Object.freeze(['ecdsa-jcs-2019', 'eddsa-jcs-2022'] as const);
export const DID_METHOD_IDS = Object.freeze(['did:key', 'did:webvh'] as const);
export type DidMethodId = (typeof DID_METHOD_IDS)[number];

/**
 * O6's examples, for the issuer tool's template (whole seconds): an edge may work offline 7 days at Protected A, 72 hours at Protected B and 24 hours at
 * any classified level. Never applied silently: a policy that leaves a level out has no offline allowance for it.
 */
export const DEFAULT_OFFLINE_AGE_EXAMPLES: Readonly<Record<string, number>> = Object.freeze({
  'ca-protected/Protected A': 7 * 24 * 60 * 60,
  'ca-protected/Protected B': 72 * 60 * 60,
  'ca-classified/Confidential': 24 * 60 * 60,
  'ca-classified/Secret': 24 * 60 * 60,
  'ca-classified/Top Secret': 24 * 60 * 60
});
/** O6's connected time to live for a status list, in seconds (15 minutes). */
export const DEFAULT_STATUS_TTL_SECONDS = 900;

export const CREDENTIALS_LOOSENED_TEXT =
  'This update from your organization would ask less of people before they see sensitive data than the policy in force. It was not applied. Ask your organization\'s security officer for an update that keeps every requirement.';

export interface IssuanceRule {
  /** The role credential an issuer of this type must present. */
  readonly role: RoleType;
  /** The highest level the role may issue, on one scale. */
  readonly ceiling?: { readonly scale: string; readonly upTo: string };
}

export interface StatusListPolicy {
  /** The list credential's id, which status entries name. */
  readonly uri: string;
  readonly purpose: 'revocation' | 'suspension';
  /** The status-list key that must sign this list (Multikey), checked by every verifier (D-14). */
  readonly key: string;
}

export interface CredentialsSection {
  readonly v: 1;
  readonly root: { readonly did: string; readonly scid?: string };
  readonly issuance: Readonly<Partial<Record<PersonAttributeType, IssuanceRule>>>;
  readonly suites: readonly string[];
  readonly didMethods: readonly DidMethodId[];
  readonly statusLists: readonly StatusListPolicy[];
  /** Seconds. */
  readonly statusTtl: number;
  /** `scale/level` to whole seconds. */
  readonly maxOfflineAge: Readonly<Record<string, number>>;
  /** `scale/level` to the person-attribute types a holder must present, each list sorted. */
  readonly requiredBySensitivity: Readonly<Record<string, readonly PersonAttributeType[]>>;
  /** D-03 fallback only: officers' person keys (did:key) that may issue. */
  readonly fallbackPersonKeys?: readonly string[];
}

const SCID = /^[1-9A-HJ-NP-Za-km-z]{46}$/;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const MAX_KEYS = 64;

function sortedUnique<T extends string>(value: unknown, path: string, allowed: (entry: string) => boolean, max: number, allowEmpty = false): Parsed<readonly T[]> {
  if (!Array.isArray(value) || value.length > max) return refused('wrong-type', path);
  if (value.length === 0 && !allowEmpty) return refused('empty-list', path);
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (typeof entry !== 'string' || !allowed(entry)) return refused('not-allowed-here', `${path}[${String(index)}]`);
    if (index > 0) {
      const before = value[index - 1] as string;
      if (entry === before) return refused('duplicate', `${path}[${String(index)}]`);
      if (entry < before) return refused('not-sorted', `${path}[${String(index)}]`);
    }
  }
  return { ok: true, value: Object.freeze([...(value as T[])]) };
}

function isMultikey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false;
  try {
    decodePublicKeyMultibase(value);
    return true;
  } catch (error) {
    if (error instanceof MultibaseError) return false;
    throw error;
  }
}

function isDidKeyText(value: string): boolean {
  return value.startsWith('did:key:') && isMultikey(value.slice('did:key:'.length));
}

function isLevelKey(key: string, scales: ScaleTable): boolean {
  const split = splitLabelKey(key);
  return split !== undefined && levelIndex(scales, split.scale, split.level) >= 0;
}

function parseRoot(value: unknown, path: string, webvh: boolean): Parsed<CredentialsSection['root']> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const did = ownValue(value, 'did');
  const scid = ownValue(value, 'scid');
  for (const key of Object.keys(value)) if (key !== 'did' && key !== 'scid') return refused('unknown-field', childPath(path, key.slice(0, 40)));
  if (typeof did !== 'string' || did.length > 2048) return refused('wrong-type', childPath(path, 'did'));
  if (webvh) {
    // The root is pinned by its SCID, never by its domain (did:webvh 1.0, DID Portability).
    if (typeof scid !== 'string' || !SCID.test(scid)) return refused('missing-field', childPath(path, 'scid'));
    if (!did.startsWith(`did:webvh:${scid}:`)) return refused('not-allowed-here', childPath(path, 'did'));
    return { ok: true, value: Object.freeze({ did, scid }) };
  }
  if (scid !== undefined) return refused('not-allowed-here', childPath(path, 'scid'));
  if (!isDidKeyText(did)) return refused('not-allowed-here', childPath(path, 'did'));
  return { ok: true, value: Object.freeze({ did }) };
}

function parseIssuance(value: unknown, path: string, scales: ScaleTable): Parsed<CredentialsSection['issuance']> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const out: Record<string, IssuanceRule> = {};
  for (const type of Object.keys(value)) {
    const where = childPath(path, type.slice(0, 40));
    // Only person attributes are issued under this table: role credentials come from the root alone, a device binding from its person (D-12, D-13).
    if (!(PERSON_ATTRIBUTE_TYPES as readonly string[]).includes(type)) return refused('not-allowed-here', where);
    const rule = ownValue(value, type);
    if (!isRecord(rule)) return refused('wrong-type', where);
    for (const key of Object.keys(rule)) if (key !== 'role' && key !== 'ceiling') return refused('unknown-field', childPath(where, key.slice(0, 40)));
    const role = ownValue(rule, 'role');
    if (typeof role !== 'string') return refused('missing-field', childPath(where, 'role'));
    if (!(ROLE_TYPES as readonly string[]).includes(role)) return refused('not-allowed-here', childPath(where, 'role'));
    const entry: { role: RoleType; ceiling?: { scale: string; upTo: string } } = { role: role as RoleType };
    if (Object.prototype.hasOwnProperty.call(rule, 'ceiling')) {
      const ceiling = ownValue(rule, 'ceiling');
      const at = childPath(where, 'ceiling');
      if (!isRecord(ceiling) || Object.keys(ceiling).length !== 2) return refused('wrong-type', at);
      const scale = ownValue(ceiling, 'scale');
      const upTo = ownValue(ceiling, 'upTo');
      if (typeof scale !== 'string' || typeof upTo !== 'string' || levelIndex(scales, scale, upTo) < 0) return refused('not-allowed-here', at);
      entry.ceiling = Object.freeze({ scale, upTo });
    }
    out[type] = Object.freeze(entry);
  }
  return { ok: true, value: Object.freeze(out) };
}

function parseStatusListPolicy(value: unknown, path: string): Parsed<StatusListPolicy> {
  if (!isRecord(value)) return refused('wrong-type', path);
  for (const key of Object.keys(value)) if (key !== 'uri' && key !== 'purpose' && key !== 'key') return refused('unknown-field', childPath(path, key.slice(0, 40)));
  // D-14: every list names the key that must sign it; a list without one could be checked through no key at all.
  const key = ownValue(value, 'key');
  if (key === undefined) return refused('missing-field', childPath(path, 'key'));
  if (!isMultikey(key)) return refused('wrong-type', childPath(path, 'key'));
  const ref = parseStatusList({ uri: ownValue(value, 'uri'), purpose: ownValue(value, 'purpose') }, path);
  if (!ref.ok) return ref;
  if (ref.value.purpose !== 'revocation' && ref.value.purpose !== 'suspension') return refused('not-allowed-here', childPath(path, 'purpose'));
  return { ok: true, value: Object.freeze({ uri: ref.value.uri, purpose: ref.value.purpose, key }) };
}

function parseRequirements(value: unknown, path: string, scales: ScaleTable): Parsed<CredentialsSection['requiredBySensitivity']> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const out: Record<string, readonly PersonAttributeType[]> = {};
  for (const key of Object.keys(value)) {
    const where = childPath(path, key.slice(0, 40));
    if (!isLevelKey(key, scales)) return refused('unknown-field', where);
    const list = sortedUnique<PersonAttributeType>(ownValue(value, key), where, (entry) => (PERSON_ATTRIBUTE_TYPES as readonly string[]).includes(entry), PERSON_ATTRIBUTE_TYPES.length);
    if (!list.ok) return list;
    out[key] = list.value;
  }
  return { ok: true, value: Object.freeze(out) };
}

const REQUIRED = ['root', 'issuance', 'suites', 'didMethods', 'statusLists', 'statusTtl', 'maxOfflineAge', 'requiredBySensitivity'] as const;

/** Reads the credentials section against the document's scales. Exact keys, own properties, frozen; list orders are fixed so one meaning has one hash. */
export function parseCredentialsSection(value: unknown, scales: ScaleTable, path = 'credentials'): Parsed<CredentialsSection> {
  const section = openSection(value, path, REQUIRED, ['fallbackPersonKeys']);
  if (!section.ok) return section;
  const opened: Fields = section.value;
  const didMethods = sortedUnique<DidMethodId>(ownValue(opened, 'didMethods'), childPath(path, 'didMethods'), (entry) => (DID_METHOD_IDS as readonly string[]).includes(entry), DID_METHOD_IDS.length);
  if (!didMethods.ok) return didMethods;
  const webvh = didMethods.value.includes('did:webvh');
  const root = parseRoot(ownValue(opened, 'root'), childPath(path, 'root'), webvh);
  if (!root.ok) return root;
  const issuance = parseIssuance(ownValue(opened, 'issuance'), childPath(path, 'issuance'), scales);
  if (!issuance.ok) return issuance;
  const suites = sortedUnique<string>(ownValue(opened, 'suites'), childPath(path, 'suites'), (entry) => (CREDENTIAL_SUITE_IDS as readonly string[]).includes(entry), CREDENTIAL_SUITE_IDS.length);
  if (!suites.ok) return suites;
  const rawLists = ownValue(opened, 'statusLists');
  if (!Array.isArray(rawLists) || rawLists.length > MAX_STATUS_LISTS) return refused('wrong-type', childPath(path, 'statusLists'));
  const statusLists: StatusListPolicy[] = [];
  for (let index = 0; index < rawLists.length; index += 1) {
    const list = parseStatusListPolicy(rawLists[index], `${childPath(path, 'statusLists')}[${String(index)}]`);
    if (!list.ok) return list;
    if (statusLists.some((other) => other.uri === list.value.uri)) return refused('duplicate', `${childPath(path, 'statusLists')}[${String(index)}]`);
    statusLists.push(list.value);
  }
  const statusTtl = ownValue(opened, 'statusTtl');
  if (typeof statusTtl !== 'number' || !Number.isSafeInteger(statusTtl) || statusTtl < 1 || statusTtl > MAX_TTL_SECONDS) return refused('wrong-type', childPath(path, 'statusTtl'));
  const maxOfflineAge = parseMaxOfflineAge(ownValue(opened, 'maxOfflineAge'), scales, childPath(path, 'maxOfflineAge'));
  if (!maxOfflineAge.ok) return maxOfflineAge;
  const required = parseRequirements(ownValue(opened, 'requiredBySensitivity'), childPath(path, 'requiredBySensitivity'), scales);
  if (!required.ok) return required;
  const out: Record<string, unknown> = {
    v: 1, root: root.value, issuance: issuance.value, suites: suites.value, didMethods: didMethods.value, statusLists: Object.freeze(statusLists),
    statusTtl, maxOfflineAge: maxOfflineAge.value, requiredBySensitivity: required.value
  };
  if (Object.prototype.hasOwnProperty.call(opened, 'fallbackPersonKeys')) {
    // Person keys as did:keys exist only under the fallback; with did:webvh allowed, every person is a did:webvh (D-07).
    if (webvh) return refused('not-allowed-here', childPath(path, 'fallbackPersonKeys'));
    const keys = sortedUnique<string>(ownValue(opened, 'fallbackPersonKeys'), childPath(path, 'fallbackPersonKeys'), isDidKeyText, MAX_KEYS);
    if (!keys.ok) return keys;
    out.fallbackPersonKeys = keys.value;
  }
  return { ok: true, value: Object.freeze(out) as unknown as CredentialsSection };
}

/**
 * D-12, 48.1 D-25: true when `next` asks at least as much as `active` at every sensitivity: every level `active` names is in `next` with every type
 * `active` requires there. A requirement dropped, or moved to another level only, is a loosening. No active section means nothing to keep.
 */
export function requirementsOnlyTighten(active: CredentialsSection | undefined, next: CredentialsSection | undefined): boolean {
  if (active === undefined) return true;
  if (next === undefined) return Object.values(active.requiredBySensitivity).every((types) => types.length === 0);
  for (const [level, types] of Object.entries(active.requiredBySensitivity)) {
    const kept = Object.prototype.hasOwnProperty.call(next.requiredBySensitivity, level) ? next.requiredBySensitivity[level] ?? [] : [];
    if (!types.every((type) => kept.includes(type))) return false;
  }
  return true;
}
