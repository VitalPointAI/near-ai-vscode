// May this released version leave for a partner? (Phase 45.1, D-05, XCHG-03.) Pure: no I/O, no clock, no vscode, no package.
// An export is a release to an outside party, so it is decided by the same mayRelease as every release, with the partner organization's facts taken
// from its agreement in your organization's signed policy (factsFromAgreement); there is no second release rule. Around that one decision: the agreement
// must be in force, the releasing person must hold a ReleaseAuthorityCredential, the label must name the partner in its releasability, export-controlled
// content waits for Phase 45, and the label must be written through your organization's table for allies (label-interop@1). The agreement stands for the
// partner's people only when your organization has recorded that it vetted the partner's clearance process (owner decision D-12); otherwise the
// recipient's own checked credentials, bound to the recipient's DID here, go through the same mayRelease with the credentials section in force.
import { factsFromAgreement, isCheckedFacts, mayRelease } from '../credentials/mayRelease';
import type { CredentialFacts, ReleaseRefusal } from '../credentials/mayRelease';
import type { Agreement } from '../gate/agreementsSection';
import type { CredentialsSection } from '../gate/credentialsSection';
import type { LabelInteropTable } from '../gate/labelInteropSection';
import { RESERVED_EXPORT_COMPARTMENTS } from '../gate/labels';
import type { Label, ScaleMapping, ScaleTable } from '../gate/labels';
import { isRecord, parseIsoMillis } from '../gate/shape';
import { mapOut } from './labelInterop';
import type { ExternalLabel, LabelInteropRefusal } from './labelInterop';

/** The credential a releasing person must hold (71-03's type name). */
export const RELEASE_AUTHORITY_TYPE = 'ReleaseAuthorityCredential';

// Closed list; one plain sentence each, naming no label part, partner token or person.
export const EXPORT_REFUSALS = Object.freeze({
  'no-agreement': 'Your organization has no agreement with this partner, so nothing can be sent to them.',
  'agreement-ended': 'Your organization\'s agreement with this partner has ended.',
  'no-release-authority': 'You do not hold a verified release authority credential, so you cannot send this to a partner.',
  'export-controlled': 'This content is export-controlled, and sending it to a partner waits for your organization\'s export decisions.',
  'no-table': 'Your organization\'s security officer has not set how labels are written for allies yet, so nothing can be sent to a partner.',
  'no-mapping': 'This label has a part that your organization\'s table for allies does not cover.',
  'handling': 'This label carries handling rules that stay inside your organization.',
  'releasable-to-none': 'This content is releasable to no one.',
  'not-releasable': 'This content is not marked releasable to this partner.',
  'above-ceiling': 'This content is above the highest level your organization\'s agreement with this partner covers.',
  'compartment-not-covered': 'This content is in a compartment your organization\'s agreement with this partner does not cover.',
  'not-released': 'The release check refused this content for this partner.',
  // D-12, the owner's words, written verbatim.
  'partner-not-vetted': "This partner's clearance process hasn't been vetted. Vet it first, or the recipient must provide their clearance details.",
  'no-credential-policy': 'Your organization\'s policy in force sets no credential requirements, so a recipient\'s own clearance details cannot be checked.',
  'recipient-mismatch': 'The clearance details given are not verified credentials about the person this is being sent to.',
  'recipient-not-partner': 'The recipient is not a member of a nation or organization this agreement covers.',
  'recipient-not-cleared': 'The recipient\'s verified clearance details do not allow them to receive this content.'
} as const);
export type ExportRefusal = keyof typeof EXPORT_REFUSALS;

/** What the export relied on for the partner's people (D-12): your organization's vetting of the partner, or the recipient's own credentials. */
export type ExportBasis = 'vetted-partner' | 'recipient-credentials';

/** A passed check: the label in the partner form, for this agreement. Made only by canExport, so an export cannot skip it. */
export interface ExportDecision {
  readonly ok: true;
  readonly label: Label;
  readonly agreement: string;
  readonly external: ExternalLabel;
  readonly basis: ExportBasis;
  /** For the recipient-credentials basis: the recipient's DID, the subject of the credentials relied on. */
  readonly recipient?: string;
}

export type ExportCheck = ExportDecision | { readonly ok: false; readonly reason: ExportRefusal; readonly message: string; readonly releaseReason?: ReleaseRefusal };

/**
 * The person an export to an unvetted partner is for (D-12): their DID, the facts factsFrom made from credentials the caller checked with the wallet's
 * checker (about that DID), and the credentials section of the policy in force, so the credentials it requires at the label's level always apply.
 */
export interface ExportRecipient {
  readonly did: string;
  readonly facts: CredentialFacts;
  readonly policy: CredentialsSection;
}

export interface ExportContext {
  /** The releasing person's facts, from their checked credentials (factsFrom). */
  readonly releaser: CredentialFacts;
  /** Needed only when your organization has not vetted the partner's clearance process. */
  readonly recipient?: ExportRecipient;
  /** Your organization's table for allies; absent means nothing can leave. */
  readonly table: LabelInteropTable | undefined;
  readonly scales: ScaleTable;
  readonly mappings: readonly ScaleMapping[];
  /** Epoch milliseconds. */
  readonly now: number;
}

const DECISIONS = new WeakSet<object>();

function refuse(reason: ExportRefusal, releaseReason?: ReleaseRefusal): ExportCheck {
  return Object.freeze({ ok: false, reason, message: EXPORT_REFUSALS[reason], ...(releaseReason === undefined ? {} : { releaseReason }) });
}

const INTEROP_TO_EXPORT: Readonly<Record<LabelInteropRefusal, ExportRefusal>> = Object.freeze({
  'not-set': 'no-table', 'no-mapping': 'no-mapping', 'handling': 'handling', 'releasable-to-none': 'releasable-to-none', 'mapping-version': 'no-mapping', 'malformed': 'no-mapping'
});

const RELEASE_TO_EXPORT: Readonly<Partial<Record<ReleaseRefusal, ExportRefusal>>> = Object.freeze({
  'releasable-to-none': 'releasable-to-none', 'releasability': 'not-releasable', 'level': 'above-ceiling', 'scale': 'above-ceiling', 'no-clearance': 'above-ceiling',
  'compartment': 'compartment-not-covered', 'expired': 'agreement-ended', 'export-eligibility': 'export-controlled'
});

/** Whether this decision was made by canExport for this label (a hand-built or copied decision is not). */
export function isExportDecision(value: unknown): value is ExportDecision {
  return typeof value === 'object' && value !== null && DECISIONS.has(value);
}

/** D-12: vetted only when the record is whole and dated on or before now; absent, malformed or future-dated is not vetted (fail closed). */
function vettedBy(agreement: Agreement, now: number): boolean {
  const vetting: unknown = agreement.clearanceProcessVetted;
  if (!isRecord(vetting)) return false;
  const { by, on, basis } = vetting;
  if (typeof by !== 'string' || by === '' || typeof basis !== 'string' || basis === '' || typeof on !== 'string') return false;
  const when = parseIsoMillis(on);
  return !Number.isNaN(when) && when <= now;
}

/** The credentials section at run time: a cast or plain JavaScript caller may pass anything, and mayRelease asks requiredBySensitivity only when given one. */
function isCredentialsSection(value: unknown): value is CredentialsSection {
  return isRecord(value) && value.v === 1 && isRecord(value.requiredBySensitivity);
}

type RecipientCheck = { readonly ok: true; readonly did: string } | { readonly ok: false; readonly reason: ExportRefusal; readonly releaseReason?: ReleaseRefusal };

/** D-12, for a partner your organization has not vetted: the recipient's own checked credentials, about their DID, through the same mayRelease. */
function checkRecipient(label: Label, agreement: Agreement, context: ExportContext): RecipientCheck {
  const recipient: unknown = context.recipient;
  if (!isRecord(recipient)) return { ok: false, reason: 'partner-not-vetted' };
  const { did, facts, policy } = recipient as Partial<ExportRecipient>;
  if (!isCredentialsSection(policy)) return { ok: false, reason: 'no-credential-policy' };
  // Bound here, in the domain, so every caller (45.2's NATO-format exports too) inherits it: the facts must be checked and about this DID.
  if (typeof did !== 'string' || did === '' || !isCheckedFacts(facts) || facts.subject !== did) return { ok: false, reason: 'recipient-mismatch' };
  if (!facts.tokens.some((token) => agreement.tokens.includes(token))) return { ok: false, reason: 'recipient-not-partner' };
  const released = mayRelease(facts, label, { scales: context.scales, mappings: context.mappings, policy, now: context.now });
  if (!released.ok) return { ok: false, reason: 'recipient-not-cleared', releaseReason: released.reason };
  return { ok: true, did };
}

/**
 * Every condition, in order, the first failing one its reason: an agreement in force; the releasing person's ReleaseAuthorityCredential; no
 * export-controlled compartment (until Phase 45); the label names one of the partner's tokens in its releasability (an unrestricted label is not
 * released abroad by default); mayRelease with the partner's facts from the agreement (its ceiling, compartments and tokens), which bound every export;
 * then what vouches for the partner's people; and the label written through your organization's table.
 *
 * The agreement stands for the partner's people only when your organization has recorded, in its signed policy, that it vetted the partner's own
 * clearance process (clearanceProcessVetted, dated on or before now; D-12). Otherwise the recipient's own credentials decide: they must be checked
 * facts about the recipient's DID, name a nationality or organization among the agreement's tokens, and pass mayRelease with the credentials section
 * of the policy in force, so the credentials it requires at the label's level always apply. A recipient's credentials never lift the agreement.
 */
export function canExport(label: Label, agreement: Agreement | undefined, context: ExportContext): ExportCheck {
  if (agreement === undefined) return refuse('no-agreement');
  const until = Date.parse(agreement.until);
  if (Number.isNaN(until) || until <= context.now) return refuse('agreement-ended');
  if (!isCheckedFacts(context.releaser) || !context.releaser.types.includes(RELEASE_AUTHORITY_TYPE) || context.releaser.until <= context.now) {
    return refuse('no-release-authority');
  }
  if (RESERVED_EXPORT_COMPARTMENTS.some((kind) => label.compartments.includes(kind))) return refuse('export-controlled');
  if (!label.releasability.some((token) => agreement.tokens.includes(token))) {
    return refuse(label.releasability.includes('RELEASABLE-TO-NONE') ? 'releasable-to-none' : 'not-releasable');
  }
  const released = mayRelease(factsFromAgreement(agreement), label, { scales: context.scales, mappings: context.mappings, now: context.now });
  if (!released.ok) return refuse(RELEASE_TO_EXPORT[released.reason] ?? 'not-released', released.reason);
  let basis: ExportBasis = 'vetted-partner';
  let recipient: string | undefined;
  if (!vettedBy(agreement, context.now)) {
    const person = checkRecipient(label, agreement, context);
    if (!person.ok) return refuse(person.reason, person.releaseReason);
    basis = 'recipient-credentials';
    recipient = person.did;
  }
  const external = mapOut(label, context.table);
  if (!external.ok) return refuse(INTEROP_TO_EXPORT[external.reason]);
  const decision: ExportDecision = Object.freeze({
    ok: true, label, agreement: agreement.id, external: external.value, basis, ...(recipient === undefined ? {} : { recipient })
  });
  DECISIONS.add(decision);
  return decision;
}
