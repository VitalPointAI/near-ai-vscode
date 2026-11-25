// The one release decision (Phase 71, D-10, O5, DCAC-03): every wrap, release and serve asks mayRelease with the data's label and the holder's facts
// from verified credentials. Pure: no I/O, no clock, no package. Built on whyNotDominated (src/domain/gate/dominance.ts), so there is one dominance
// algorithm: level on the label's scale or through an approved mapping, every compartment, and releasability for every holder (staff, observers and
// guests alike; an empty releasability is unrestricted; RELEASABLE-TO-NONE never matches). On top of dominance: an ExportEligibilityCredential for each
// CGP, ITAR or EAR compartment, and the credentials the policy requires at the label's sensitivity. Handling flags are the gate's routing, not this.
import { whyNotDominated } from '../gate/dominance';
import type { DominanceReason } from '../gate/dominance';
import { LABEL_TOKEN_PATTERN, RELEASABILITY_NONE, RESERVED_EXPORT_COMPARTMENTS, labelKey, levelIndex, splitLabelKey } from '../gate/labels';
import type { Clearance, Label, ScaleMapping, ScaleTable } from '../gate/labels';
import type { Agreement } from '../gate/agreementsSection';
import type { CredentialsSection } from '../gate/credentialsSection';
import type { VerifiedCredential } from './profile';
import { credentialTimeMs } from './types';

/** What a holder's checked credentials say, frozen. Made only by factsFrom; anything else is not facts and gives nothing. */
export interface CredentialFacts {
  /** The holder's DID (every credential's subject). */
  readonly subject?: string;
  /** Every clearance threshold held: { scale, level } per ClearanceCredential. */
  readonly thresholds: readonly { readonly scale: string; readonly level: string }[];
  /** Compartments from CompartmentCredential, and the regimes of ExportEligibilityCredential (sorted, distinct). */
  readonly compartments: readonly string[];
  /** Releasability tokens from NationalityCredential and AffiliationCredential (sorted, distinct). */
  readonly tokens: readonly string[];
  readonly regimes: readonly string[];
  readonly agreements: readonly string[];
  readonly serves: readonly string[];
  /** Every credential type held. */
  readonly types: readonly string[];
  /** The earliest validUntil of the credentials used, epoch milliseconds. */
  readonly until: number;
}

/** A credential the caller has checked (proof, issuer authority, status): only these become facts. */
export interface CheckedCredential {
  readonly credential: VerifiedCredential;
  readonly status: 'clear';
}

const MADE = new WeakSet<object>();

function sortedDistinct(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function claim(credential: VerifiedCredential, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(credential.claims, key) ? (credential.claims as Readonly<Record<string, unknown>>)[key] : undefined;
}

/** Builds facts from checked credentials only: an item without `status: 'clear'` is ignored, and so is a credential about another subject. */
export function factsFrom(checked: readonly CheckedCredential[]): CredentialFacts {
  const usable = checked.filter((item) => typeof item === 'object' && item !== null && item.status === 'clear' && typeof item.credential?.type === 'string');
  const subject = usable[0]?.credential.claims.id;
  const mine = usable.map((item) => item.credential).filter((credential) => credential.claims.id === subject);
  const thresholds: Array<{ scale: string; level: string }> = [];
  const compartments: string[] = [];
  const tokens: string[] = [];
  const regimes: string[] = [];
  const agreements: string[] = [];
  const serves: string[] = [];
  let until = Number.POSITIVE_INFINITY;
  for (const credential of mine) {
    until = Math.min(until, credentialTimeMs(credential.validUntil));
    switch (credential.type) {
      case 'ClearanceCredential': thresholds.push(Object.freeze({ scale: claim(credential, 'scale') as string, level: claim(credential, 'atLeast') as string })); break;
      case 'CompartmentCredential': compartments.push(claim(credential, 'compartment') as string); break;
      case 'NationalityCredential': tokens.push(claim(credential, 'nationality') as string); break;
      case 'AffiliationCredential': {
        // An affiliation counts for releasability only when its organization is written as a label token (a group such as NATO).
        const organization = claim(credential, 'organization');
        if (typeof organization === 'string' && LABEL_TOKEN_PATTERN.test(organization) && organization !== RELEASABILITY_NONE) tokens.push(organization);
        break;
      }
      case 'ExportEligibilityCredential': regimes.push(claim(credential, 'regime') as string); break;
      case 'AccessAgreementCredential': agreements.push(claim(credential, 'agreement') as string); break;
      case 'ServiceCredential': serves.push(claim(credential, 'serves') as string); break;
      default: break;
    }
  }
  const facts: CredentialFacts = Object.freeze({
    ...(subject === undefined ? {} : { subject }),
    thresholds: Object.freeze(thresholds), compartments: sortedDistinct([...compartments, ...regimes]), tokens: sortedDistinct(tokens),
    regimes: sortedDistinct(regimes), agreements: sortedDistinct(agreements), serves: sortedDistinct(serves), types: sortedDistinct(mine.map((credential) => credential.type)),
    until
  });
  MADE.add(facts);
  return facts;
}

/**
 * A partner organization's facts from one agreement of your organization's signed policy (Phase 45.1, D-05): its level ceiling as the one threshold,
 * its compartments and its releasability tokens, until it ends. An agreement is a policy record, never a credential; it is the holder an export is
 * released to, so the export goes through the same mayRelease as every release. It names no person and no credential type, and covers no
 * export-controlled kind (`regimes` is empty).
 */
export function factsFromAgreement(agreement: Agreement): CredentialFacts {
  const ceiling = splitLabelKey(agreement.levelCeiling);
  const until = Date.parse(agreement.until);
  const facts: CredentialFacts = Object.freeze({
    thresholds: Object.freeze(ceiling === undefined ? [] : [Object.freeze({ scale: ceiling.scale, level: ceiling.level })]),
    compartments: sortedDistinct(agreement.compartments), tokens: sortedDistinct(agreement.tokens.filter((token) => token !== RELEASABILITY_NONE)),
    regimes: Object.freeze([]), agreements: Object.freeze([agreement.id]), serves: Object.freeze([]), types: Object.freeze([]),
    until: Number.isNaN(until) ? 0 : until
  });
  MADE.add(facts);
  return facts;
}

/** Whether these facts were made by factsFrom or factsFromAgreement (forged or hand-built facts are not). */
export function isCheckedFacts(facts: unknown): facts is CredentialFacts {
  return typeof facts === 'object' && facts !== null && MADE.has(facts);
}

/** The highest threshold held on each scale, as the gate's Clearance (compartments and releasability from the same facts). */
export function clearancesOf(facts: CredentialFacts, scales: ScaleTable): readonly Clearance[] {
  if (!isCheckedFacts(facts)) return Object.freeze([]);
  const best = new Map<string, string>();
  for (const { scale, level } of facts.thresholds) {
    const held = best.get(scale);
    if (levelIndex(scales, scale, level) < 0) continue;
    if (held === undefined || levelIndex(scales, scale, level) > levelIndex(scales, scale, held)) best.set(scale, level);
  }
  const expiresAt = Number.isFinite(facts.until) ? new Date(facts.until).toISOString() : undefined;
  return Object.freeze([...best.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([scale, level]) => Object.freeze({
    scale, level, compartments: facts.compartments, releasability: facts.tokens, ...(expiresAt === undefined ? {} : { expiresAt })
  })));
}

// Closed list; one plain sentence each, naming no person, token or credential value.
export const RELEASE_REFUSALS = {
  'no-clearance': 'This person holds no verified clearance on this scale.',
  'scale': 'This person\'s clearance is on another scale, and your organization approves no mapping that covers it.',
  'level': 'This person\'s verified clearance is below this data\'s level.',
  'compartment': 'This person does not hold every compartment this data is in.',
  'releasability': 'This data is not releasable to this person\'s nationality or organization.',
  'releasable-to-none': 'This data is releasable to no one.',
  'expired': 'A credential this person relies on has ended.',
  'export-eligibility': 'This data is export-controlled, and this person has no verified eligibility for that kind of export control.',
  'required-credential': 'Your organization requires a credential for this level that this person does not hold.',
  'below-required-clearance': 'This person\'s verified clearance is below what the position requires.',
  'serves-not-eligible': 'The way this person serves is not one this position is open to.'
} as const;
export type ReleaseRefusal = keyof typeof RELEASE_REFUSALS;
export type ReleaseResult = { readonly ok: true } | { readonly ok: false; readonly reason: ReleaseRefusal; readonly message: string };

function refuse(reason: ReleaseRefusal): ReleaseResult {
  return { ok: false, reason, message: RELEASE_REFUSALS[reason] };
}

export interface ReleaseContext {
  readonly scales: ScaleTable;
  /** The mappings your organization's signed policy approves. */
  readonly mappings: readonly ScaleMapping[];
  /** The credentials section of the policy in force, for the credentials required by sensitivity. */
  readonly policy?: CredentialsSection;
  /** Epoch milliseconds: a credential that has ended by then is not relied on. */
  readonly now: number;
}

/** The dominance answer for these facts: undefined when one of the holder's clearances dominates the label, else the most telling reason. */
export function releaseDominance(facts: CredentialFacts, label: Label, context: ReleaseContext): DominanceReason | undefined {
  const clearances = clearancesOf(facts, context.scales);
  if (clearances.length === 0) return 'no-clearance';
  const dominance = { scales: context.scales, mappings: context.mappings, now: context.now };
  const reasons = clearances.map((clearance) => ({ clearance, reason: whyNotDominated(clearance, label, dominance) }));
  if (reasons.some((entry) => entry.reason === undefined)) return undefined;
  // The clearance on the label's own scale explains best; otherwise the first.
  return (reasons.find((entry) => entry.clearance.scale === label.scale) ?? reasons[0])?.reason ?? 'no-clearance';
}

/** D-10: may this holder receive data with this label? Every condition, in order; the first that fails is the reason. */
export function mayRelease(facts: CredentialFacts, label: Label, context: ReleaseContext): ReleaseResult {
  if (!isCheckedFacts(facts)) return refuse('no-clearance');
  if (label.releasability.includes(RELEASABILITY_NONE)) return refuse('releasable-to-none');
  const dominance = releaseDominance(facts, label, context);
  if (dominance !== undefined) return refuse(dominance === 'no-clearance' ? 'no-clearance' : dominance);
  for (const regime of RESERVED_EXPORT_COMPARTMENTS) {
    if (label.compartments.includes(regime) && !facts.regimes.includes(regime)) return refuse('export-eligibility');
  }
  const policy = context.policy;
  if (policy !== undefined) {
    const key = labelKey(label);
    const required = Object.prototype.hasOwnProperty.call(policy.requiredBySensitivity, key) ? policy.requiredBySensitivity[key] ?? [] : [];
    if (!required.every((type) => facts.types.includes(type))) return refuse('required-credential');
  }
  return { ok: true };
}

/** A position's requirements (33.1 D-15, D-29): the clearance it needs, as `scale/level`, and the ways of serving it is open to. */
export interface PositionRequirements {
  readonly requiredClearance?: string;
  readonly eligibleServes: readonly string[];
}

/** Posting check: required clearance and eligibleServes from credentials only, never a roster field (D-10). */
export function eligibleForPosition(facts: CredentialFacts, position: PositionRequirements, scales: ScaleTable): ReleaseResult {
  if (!isCheckedFacts(facts)) return refuse('below-required-clearance');
  if (position.requiredClearance !== undefined) {
    const need = splitLabelKey(position.requiredClearance);
    const needRank = need === undefined ? -1 : levelIndex(scales, need.scale, need.level);
    const held = facts.thresholds.some((entry) => need !== undefined && entry.scale === need.scale && needRank >= 0 && levelIndex(scales, entry.scale, entry.level) >= needRank);
    if (!held) return refuse('below-required-clearance');
  }
  if (!facts.serves.some((serves) => position.eligibleServes.includes(serves))) return refuse('serves-not-eligible');
  return { ok: true };
}
