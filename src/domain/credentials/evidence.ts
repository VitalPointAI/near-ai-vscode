// Evidence by hash (Phase 71, D-09, D-14, DCAC-02; research section 3.3): an entry that relies on a person's attributes cites the credentials and the
// status lists it was checked with, and every replica checks only that cited data, at the entry's signed time, under the cited policy. Pure: no I/O,
// no clock, no package. The function takes no list or credential that is not cited and no clock, so two replicas holding different newer lists, folding
// in different orders, give the same answer (research pitfall 1). Freshness against newer lists is the enforcement points' job (freshness.ts).
//
// A cited status list is checked only against the status-list key that the cited policy's credentials@1.statusLists names for that list id (D-14):
// never through the person-issuer rule, so a self-signed list, or one signed by an officer or by another list's key, cannot clear a revocation.
import { decodePublicKeyMultibase, MultibaseError } from './multibase';
import type { MultikeyPublicKey } from './multibase';
import { credentialHash, readCredential, verifyCredential } from './profile';
import type { VerifiedCredential } from './profile';
import { listHash, statusAt, verifyStatusList } from './statusList';
import type { StatusListState } from './statusList';
import { issuerAuthority } from './issuerAuthority';
import type { IssuerDidState, IssuerPolicy, RoleEvidence } from './issuerAuthority';
import { factsFrom } from './mayRelease';
import type { CredentialFacts } from './mayRelease';
import { DEVICE_BINDING_TYPE, credentialTimeMs, isRoleType } from './types';
import { resolveDidKey } from '../did/didKey';
import { methodsAt } from '../did/didWebvh';

/** What an entry cites (PLAN-IDS.md, proposed shape; 33.1-01's checkpoint settles it in the entry kinds). */
export interface EvidenceCitation {
  /** Credential hashes: the member's own credentials, and the role credentials and device bindings their issuers rely on. */
  readonly evidence: readonly string[];
  /** Each status list checked: its id, its hash and its validFrom. */
  readonly status: readonly { readonly list: string; readonly hash: string; readonly validFrom: string }[];
}

export interface EvidenceContext {
  /** Credential blobs by hash. Only cited hashes are read. */
  readonly credentials: Readonly<Record<string, unknown>>;
  /** Signed status lists by hash. Only cited hashes are read. */
  readonly lists: Readonly<Record<string, unknown>>;
  /** The policy the entry cites (project.mode): its credentials section and scales. */
  readonly policy: IssuerPolicy;
  /** Verified DID states, and the device bindings and delegations the replica knows. Cited device bindings are added to them. */
  readonly didState: IssuerDidState;
  /** The member the entry is about: every one of their credentials names this DID. */
  readonly member: string;
  /** The key the entry was signed with (Multikey), when the caller checks it was the member's in force then. */
  readonly memberKey?: string;
  /** The entry's time from credentialClock, epoch milliseconds. */
  readonly signedAt: number;
  /** The entry's sensitivity as `scale/level`, for the maximum offline age of the cited lists. */
  readonly level?: string;
}

// Closed list; sentences quote no hash, key, DID or claim.
export const EVIDENCE_REFUSALS = {
  'no-evidence': 'The entry cites no credential of this person.',
  'credential-missing': 'A credential the entry cites is not available here.',
  'credential-hash': 'A cited credential is not the one its citation names.',
  'credential-invalid': 'A cited credential cannot be read or its signature does not match.',
  'credential-expired': 'A cited credential was not valid at the time of the entry.',
  'issuer-key': 'The key that signed a cited credential was not known as the signer\'s own key at that time.',
  'issuer-authority': 'Whoever signed a cited credential did not have the authority to issue it.',
  'subject-mismatch': 'A cited credential is about someone else.',
  'member-key': 'The entry was not signed with a key that was this person\'s at that time.',
  'list-missing': 'A status list the entry cites is not available here.',
  'list-hash': 'A cited status list is not the one its citation names.',
  'list-not-in-policy': 'A cited status list is not one your organization\'s policy names.',
  'status-list-signer': 'A cited status list was not signed by the key your organization\'s policy names for it.',
  'list-invalid': 'A cited status list cannot be read or its signature does not match.',
  'list-out-of-date': 'A cited status list was not valid at the time of the entry.',
  'list-too-old': 'A cited status list is older than this level allows to be used offline.',
  'status-not-cited': 'A cited credential\'s status was not checked against a cited list.',
  'revoked': 'A cited credential is revoked.',
  'suspended': 'A cited credential is suspended.'
} as const;
export type EvidenceRefusal = keyof typeof EVIDENCE_REFUSALS;

export type EvidenceResult =
  | { readonly ok: true; readonly facts: CredentialFacts; readonly credentials: readonly VerifiedCredential[] }
  | { readonly ok: false; readonly reason: EvidenceRefusal; readonly message: string };

class Refused extends Error {
  public constructor(public readonly reason: EvidenceRefusal) {
    super(EVIDENCE_REFUSALS[reason]);
  }
}

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function multikey(text: string): MultikeyPublicKey | undefined {
  try {
    return decodePublicKeyMultibase(text);
  } catch (error) {
    if (error instanceof MultibaseError) return undefined;
    throw error;
  }
}

/** The cited lists, each verified against the cited policy's key for its id and valid at the entry's time within the level's offline age. */
function citedLists(citation: EvidenceCitation, context: EvidenceContext): Map<string, StatusListState> {
  const section = context.policy.section;
  const out = new Map<string, StatusListState>();
  for (const cited of citation.status) {
    const blob = own(context.lists, cited.hash);
    if (blob === undefined) throw new Refused('list-missing');
    if (listHash(blob) !== cited.hash) throw new Refused('list-hash');
    const named = section.statusLists.find((entry) => entry.uri === cited.list);
    if (named === undefined) throw new Refused('list-not-in-policy');
    const key = multikey(named.key);
    if (key === undefined) throw new Refused('list-not-in-policy');
    const verified = verifyStatusList(blob, key);
    if (!verified.ok) throw new Refused(verified.reason === 'status-list-signer' ? 'status-list-signer' : 'list-invalid');
    const list = verified.list;
    if (list.id !== cited.list || list.purpose !== named.purpose || list.validFrom !== cited.validFrom) throw new Refused('list-hash');
    const from = credentialTimeMs(list.validFrom);
    if (!(from <= context.signedAt && context.signedAt < credentialTimeMs(list.validUntil))) throw new Refused('list-out-of-date');
    if (context.level !== undefined) {
      const age = own(section.maxOfflineAge, context.level);
      if (age !== undefined && context.signedAt - from > age * 1000) throw new Refused('list-too-old');
    }
    out.set(cited.list, list);
  }
  return out;
}

/** The issuer's key for a cited credential, in force at its validFrom: from the issuer's verified DID state, or the did:key itself. */
function issuerKey(credential: { readonly issuer: string; readonly verificationMethod: string; readonly validFrom: string }, context: EvidenceContext): MultikeyPublicKey {
  if (credential.issuer.startsWith('did:key:')) {
    const resolved = resolveDidKey(credential.verificationMethod);
    if (!resolved.ok || resolved.did !== credential.issuer) throw new Refused('issuer-key');
    return resolved.publicKey;
  }
  const state = own(context.didState.states, credential.issuer);
  const method = state === undefined ? undefined : methodsAt(state, credentialTimeMs(credential.validFrom)).find((entry) => entry.id === credential.verificationMethod);
  if (method === undefined) throw new Refused('issuer-key');
  return method.publicKey;
}

function checkOne(hash: string, lists: Map<string, StatusListState>, context: EvidenceContext): VerifiedCredential {
  const blob = own(context.credentials, hash);
  if (blob === undefined) throw new Refused('credential-missing');
  if (credentialHash(blob) !== hash) throw new Refused('credential-hash');
  const read = readCredential(blob, context.policy.scales, { signed: true });
  if (!read.ok || read.value.proof === undefined) throw new Refused('credential-invalid');
  const key = issuerKey({ issuer: read.value.issuer, verificationMethod: read.value.proof.verificationMethod, validFrom: read.value.validFrom }, context);
  const verified = verifyCredential(blob, { publicKey: key, scales: context.policy.scales, at: context.signedAt });
  if (!verified.ok) throw new Refused(verified.reason === 'expired' || verified.reason === 'not-yet-valid' ? 'credential-expired' : 'credential-invalid');
  for (const entry of verified.status) {
    const list = lists.get(entry.statusListCredential);
    if (list === undefined) throw new Refused('status-not-cited');
    const set = statusAt(list, entry.statusListIndex, entry.statusPurpose);
    if (set === undefined) throw new Refused('status-not-cited');
    if (set) throw new Refused(entry.statusPurpose === 'revocation' ? 'revoked' : 'suspended');
  }
  return verified;
}

/** Whether `memberKey` was the member's at `at`: a method of their DID then, their own did:key, or a device they bound with a cited or known binding. */
function memberKeyInForce(memberKey: string, bindings: readonly VerifiedCredential[], context: EvidenceContext): boolean {
  if (context.member.startsWith('did:key:')) return context.member === `did:key:${memberKey}`;
  const state = own(context.didState.states, context.member);
  if (state !== undefined) {
    const methods = [...methodsAt(state, context.signedAt, 'authentication'), ...methodsAt(state, context.signedAt, 'assertionMethod')];
    if (methods.some((method) => method.publicKeyMultibase === memberKey)) return true;
  }
  return bindings.some((binding) => binding.issuer === context.member && binding.claims.id === `did:key:${memberKey}`
    && credentialTimeMs(binding.validFrom) <= context.signedAt && context.signedAt < credentialTimeMs(binding.validUntil));
}

/**
 * Checks an entry's cited evidence (D-09). Every cited list and credential must be present, be the one cited, verify, and hold at the entry's time;
 * every cited credential's status must be clear in a cited list; the member's credentials must come from an issuer with authority under the cited
 * policy, with the role credentials and device bindings also cited. Returns the member's facts, or one refusal. Never throws.
 */
export function checkEvidence(citation: EvidenceCitation, context: EvidenceContext): EvidenceResult {
  try {
    if (!Number.isFinite(context.signedAt)) throw new Refused('credential-expired');
    const lists = citedLists(citation, context);
    const checked = citation.evidence.map((hash) => checkOne(hash, lists, context));
    // The member's own credentials (a role the member holds included); other role credentials are their issuers'; device bindings name devices.
    const roles: RoleEvidence[] = checked.filter((credential) => isRoleType(credential.type)).map((credential) => ({ credential, statusClear: true }));
    const bindings = checked.filter((credential) => credential.type === DEVICE_BINDING_TYPE);
    const mine = checked.filter((credential) => credential.type !== DEVICE_BINDING_TYPE && (credential.claims.id === context.member || !isRoleType(credential.type)));
    if (mine.some((credential) => credential.claims.id !== context.member)) throw new Refused('subject-mismatch');
    if (mine.length === 0) throw new Refused('no-evidence');
    const didState: IssuerDidState = { ...context.didState, deviceBindings: [...(context.didState.deviceBindings ?? []), ...bindings] };
    for (const credential of [...mine, ...bindings]) {
      if (!issuerAuthority(credential, roles, context.policy, didState).ok) throw new Refused('issuer-authority');
    }
    if (context.memberKey !== undefined && !memberKeyInForce(context.memberKey, [...(context.didState.deviceBindings ?? []), ...bindings], context)) {
      throw new Refused('member-key');
    }
    const facts = factsFrom(mine.map((credential) => ({ credential, status: 'clear' as const })));
    return { ok: true, facts, credentials: Object.freeze(mine) };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason, message: EVIDENCE_REFUSALS[error.reason] };
    // Anything unreadable in cited data is a credential that does not verify.
    return { ok: false, reason: 'credential-invalid', message: EVIDENCE_REFUSALS['credential-invalid'] };
  }
}
