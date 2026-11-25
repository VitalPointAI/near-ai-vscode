// May this released version leave for a partner? (Phase 45.1, D-05, XCHG-03.) Pure: no I/O, no clock, no vscode, no package.
// An export is a release to an outside party, so it is decided by the same mayRelease as every release, with the partner organization's facts taken
// from its agreement in your organization's signed policy (factsFromAgreement); there is no second release rule. Around that one decision: the agreement
// must be in force, the releasing person must hold a ReleaseAuthorityCredential, the label must name the partner in its releasability, export-controlled
// content waits for Phase 45, and the label must be written through your organization's table for allies (label-interop@1).
import { factsFromAgreement, isCheckedFacts, mayRelease } from '../credentials/mayRelease';
import type { CredentialFacts, ReleaseRefusal } from '../credentials/mayRelease';
import type { Agreement } from '../gate/agreementsSection';
import type { LabelInteropTable } from '../gate/labelInteropSection';
import { RESERVED_EXPORT_COMPARTMENTS } from '../gate/labels';
import type { Label, ScaleMapping, ScaleTable } from '../gate/labels';
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
  'not-released': 'The release check refused this content for this partner.'
} as const);
export type ExportRefusal = keyof typeof EXPORT_REFUSALS;

/** A passed check: the label in the partner form, for this agreement. Made only by canExport, so an export cannot skip it. */
export interface ExportDecision {
  readonly ok: true;
  readonly label: Label;
  readonly agreement: string;
  readonly external: ExternalLabel;
}

export type ExportCheck = ExportDecision | { readonly ok: false; readonly reason: ExportRefusal; readonly message: string; readonly releaseReason?: ReleaseRefusal };

export interface ExportContext {
  /** The releasing person's facts, from their checked credentials (factsFrom). */
  readonly releaser: CredentialFacts;
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

/**
 * Every condition, in order, the first failing one its reason: an agreement in force; the releasing person's ReleaseAuthorityCredential; no
 * export-controlled compartment (until Phase 45); the label names one of the partner's tokens in its releasability (an unrestricted label is not
 * released abroad by default); mayRelease with the partner's facts from the agreement (its ceiling, compartments and tokens); and the label written
 * through your organization's table. Per-person credential requirements (credentials@1 requiredBySensitivity) are not asked of the partner: the
 * agreement, signed in the same policy, stands for the partner organization's own vetting.
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
  const external = mapOut(label, context.table);
  if (!external.ok) return refuse(INTEROP_TO_EXPORT[external.reason]);
  const decision: ExportDecision = Object.freeze({ ok: true, label, agreement: agreement.id, external: external.value });
  DECISIONS.add(decision);
  return decision;
}
