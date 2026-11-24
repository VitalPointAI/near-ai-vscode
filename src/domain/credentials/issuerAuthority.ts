// Who may issue what (Phase 71, D-07, D-12, DCAC-01): the one rule that decides whether a credential's issuer had the authority to issue it. Pure: no
// I/O, no clock, no package. The caller has already verified every credential's proof (profile.ts) and the status of every role credential; this file
// decides authority only.
//
// The chain is short and fixed: your organization's root (pinned in credentials@1) issues role credentials, offline, and nothing else; a person holding
// a current role credential from the root issues the person attributes the policy's issuance table gives that role, within the role's and the policy's
// ceiling. Agents and devices never issue (coordinator 2026-11-24, owner item 2): a did:key issuer, an issuer whose signing key is the subject of a
// DeviceBindingCredential or a delegation, and a role credential naming such a subject are refused whatever the policy says. No setting turns this off.
// Under the D-03 fallback (the policy does not allow did:webvh) the only did:keys that may issue are the root and the officers' person keys the policy
// names (fallbackPersonKeys); that branch cannot be reached while did:webvh is allowed.
import { levelIndex } from '../gate/labels';
import type { ScaleTable } from '../gate/labels';
import type { CredentialsSection } from '../gate/credentialsSection';
import { resolveDidKey } from '../did/didKey';
import { methodsAt } from '../did/didWebvh';
import type { WebvhState } from '../did/didWebvh';
import type { VerifiedCredential } from './profile';
import { DEVICE_BINDING_TYPE, PERSON_ATTRIBUTE_TYPES, credentialTimeMs, isRoleType } from './types';

// Closed list: one plain sentence each; none quotes a DID, a key or a claim.
export const ISSUER_REFUSALS = {
  'device-or-agent-issuer': 'A device or an agent cannot issue credentials. Only a person with a role from your organization can, and your organization itself for roles.',
  'role-subject-not-person': 'A role can only be given to a person, never to a device or an agent.',
  'unknown-issuer': 'The DID history of whoever signed this credential is not available here, so who signed cannot be checked.',
  'key-not-in-force': 'The key that signed this credential was not the signer\'s own key on the day the credential starts.',
  'method-not-allowed': 'Your organization\'s policy does not accept credentials from this kind of DID.',
  'suite-not-allowed': 'Your organization\'s policy does not accept this kind of signature.',
  'role-not-from-root': 'Only your organization itself may give roles.',
  'root-issues-roles-only': 'Your organization\'s own key gives roles only; a person with the right role issues everything else.',
  'not-issuable': 'Your organization\'s policy names no role that may issue this kind of credential.',
  'no-role': 'Whoever signed this credential does not hold a current role that allows issuing it.',
  'above-ceiling': 'This credential is above what the signer\'s role allows.'
} as const;
export type IssuerRefusal = keyof typeof ISSUER_REFUSALS;

/** A role credential the issuer presents: its proof already verified, and its status already checked by the caller in the cited lists. */
export interface RoleEvidence {
  readonly credential: VerifiedCredential;
  /** False when its revocation or suspension bit is set, or its status could not be checked. */
  readonly statusClear: boolean;
}

/** The parts of the policy the rule reads: the credentials section and the scales its levels are on. */
export interface IssuerPolicy {
  readonly section: CredentialsSection;
  readonly scales: ScaleTable;
}

/** What the verifier knows about identities: verified did:webvh states by DID, and the keys bound to devices or delegated (never issuers). */
export interface IssuerDidState {
  readonly states: Readonly<Record<string, WebvhState>>;
  /** Verified DeviceBindingCredentials: their subjects are device keys. */
  readonly deviceBindings?: readonly VerifiedCredential[];
  /** did:keys that are the subject of a delegation (Phase 71.1). */
  readonly delegatedKeys?: readonly string[];
}

export type IssuerAuthorityResult =
  | { readonly ok: true; readonly role?: VerifiedCredential }
  | { readonly ok: false; readonly reason: IssuerRefusal; readonly message: string };

function refuse(reason: IssuerRefusal): IssuerAuthorityResult {
  return { ok: false, reason, message: ISSUER_REFUSALS[reason] };
}

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** Whether a did:key is a device's or an agent's: the subject of a device binding the verifier knows, or of a delegation. */
function isBoundKey(didKey: string, didState: IssuerDidState): boolean {
  if ((didState.delegatedKeys ?? []).includes(didKey)) return true;
  return (didState.deviceBindings ?? []).some((binding) => binding.type === DEVICE_BINDING_TYPE && binding.claims.id === didKey);
}

/** The D-03 fallback branch: did:keys may stand for people only when the policy does not allow did:webvh, and only the ones it names. */
function fallbackPersonKey(did: string, section: CredentialsSection): boolean {
  return !section.didMethods.includes('did:webvh') && (did === section.root.did || (section.fallbackPersonKeys ?? []).includes(did));
}

/**
 * The one place that decides "a person, not a device or an agent" (D-07): a did:webvh whose signing key in force at `at` (when a method is given) is not
 * bound to a device or delegated, or, under the fallback only, a did:key the policy names as a person key or the root.
 */
export function isPersonIssuer(did: string, didState: IssuerDidState, section: CredentialsSection, at?: number, verificationMethod?: string): boolean {
  return issuerKeyCheck(did, verificationMethod, at, section, didState) === undefined;
}

function issuerKeyCheck(did: string, verificationMethod: string | undefined, at: number | undefined, section: CredentialsSection, didState: IssuerDidState): IssuerRefusal | undefined {
  if (did.startsWith('did:key:')) {
    if (!fallbackPersonKey(did, section) || isBoundKey(did, didState)) return 'device-or-agent-issuer';
    if (verificationMethod === undefined) return undefined;
    const resolved = resolveDidKey(verificationMethod);
    return resolved.ok && resolved.did === did && verificationMethod.includes('#') ? undefined : 'key-not-in-force';
  }
  if (!did.startsWith('did:webvh:')) return 'method-not-allowed';
  if (!section.didMethods.includes('did:webvh')) return 'method-not-allowed';
  const state = own(didState.states, did);
  if (state === undefined) return 'unknown-issuer';
  if (verificationMethod === undefined || at === undefined) {
    // Without a method to check, a person DID is a person only if none of its current keys is bound to a device.
    const current = methodsAt(state, Number.MAX_SAFE_INTEGER);
    return current.some((method) => isBoundKey(`did:key:${method.publicKeyMultibase}`, didState)) ? 'device-or-agent-issuer' : undefined;
  }
  const method = methodsAt(state, at).find((entry) => entry.id === verificationMethod);
  if (method === undefined) return 'key-not-in-force';
  return isBoundKey(`did:key:${method.publicKeyMultibase}`, didState) ? 'device-or-agent-issuer' : undefined;
}

/** A role's subject is a person: a did:webvh this verifier knows with no device-bound key, or under the fallback a named person key. */
function isPersonSubject(did: string, section: CredentialsSection, didState: IssuerDidState): boolean {
  if (did.startsWith('did:key:')) return fallbackPersonKey(did, section) && !isBoundKey(did, didState);
  return did.startsWith('did:webvh:') && issuerKeyCheck(did, undefined, undefined, section, didState) === undefined;
}

function claim(credential: VerifiedCredential, key: string): unknown {
  return own(credential.claims as Readonly<Record<string, unknown>>, key);
}

/** Whether a credential's level, compartment or regime is within a role's claims and the policy's ceiling for its type. */
function withinCeiling(credential: VerifiedCredential, role: VerifiedCredential, policy: IssuerPolicy): boolean {
  const scales = policy.scales;
  const level = claim(credential, 'atLeast');
  const scale = claim(credential, 'scale');
  const ceilings: Array<{ scale: unknown; upTo: unknown }> = [];
  if (claim(role, 'scale') !== undefined) ceilings.push({ scale: claim(role, 'scale'), upTo: claim(role, 'upTo') });
  const rule = own(policy.section.issuance as Readonly<Record<string, { ceiling?: { scale: string; upTo: string } }>>, credential.type);
  if (rule?.ceiling !== undefined) ceilings.push(rule.ceiling);
  if (typeof level === 'string' && typeof scale === 'string') {
    for (const ceiling of ceilings) {
      if (ceiling.scale !== scale || typeof ceiling.upTo !== 'string') return false;
      const rank = levelIndex(scales, scale, level);
      if (rank < 0 || rank > levelIndex(scales, scale, ceiling.upTo)) return false;
    }
  }
  const compartments = claim(role, 'compartments');
  const compartment = claim(credential, 'compartment');
  if (Array.isArray(compartments) && typeof compartment === 'string' && !compartments.includes(compartment)) return false;
  const regimes = claim(role, 'regimes');
  const regime = claim(credential, 'regime');
  if (Array.isArray(regimes) && typeof regime === 'string' && !regimes.includes(regime)) return false;
  return true;
}

/**
 * Whether `credential`'s issuer had the authority to issue it, at its validFrom, under `policy`. `roles` are the issuer's role credentials (verified,
 * with their status). Returns the role relied on, or one refusal. Never throws.
 */
export function issuerAuthority(credential: VerifiedCredential, roles: readonly RoleEvidence[], policy: IssuerPolicy, didState: IssuerDidState): IssuerAuthorityResult {
  const section = policy.section;
  if (!section.suites.includes(credential.suite)) return refuse('suite-not-allowed');
  const at = credentialTimeMs(credential.validFrom);
  const keyProblem = issuerKeyCheck(credential.issuer, credential.verificationMethod, at, section, didState);
  if (keyProblem !== undefined) return refuse(keyProblem);
  if (isRoleType(credential.type)) {
    if (credential.issuer !== section.root.did) return refuse('role-not-from-root');
    return isPersonSubject(credential.claims.id, section, didState) ? { ok: true } : refuse('role-subject-not-person');
  }
  if (credential.type === DEVICE_BINDING_TYPE) {
    // A person binds their own computer; the binding itself makes that computer's key a device key, never an issuer.
    return credential.issuer === section.root.did ? refuse('root-issues-roles-only') : { ok: true };
  }
  if (!(PERSON_ATTRIBUTE_TYPES as readonly string[]).includes(credential.type)) return refuse('not-issuable');
  if (credential.issuer === section.root.did) return refuse('root-issues-roles-only');
  const rule = own(section.issuance as Readonly<Record<string, { role: string }>>, credential.type);
  if (rule === undefined) return refuse('not-issuable');
  let aboveCeiling = false;
  for (const evidence of roles) {
    const role = evidence.credential;
    if (role.type !== rule.role || role.claims.id !== credential.issuer || !evidence.statusClear) continue;
    if (credentialTimeMs(role.validFrom) > at || at >= credentialTimeMs(role.validUntil)) continue;
    if (rule.role === 'IssuerRoleCredential' && claim(role, 'credentialType') !== credential.type) continue;
    if (!issuerAuthority(role, [], policy, didState).ok) continue;
    if (!withinCeiling(credential, role, policy)) {
      aboveCeiling = true;
      continue;
    }
    return { ok: true, role };
  }
  return refuse(aboveCeiling ? 'above-ceiling' : 'no-role');
}
