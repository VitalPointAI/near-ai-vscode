import { canonicalBytes } from '../../../domain/team/canonical';
import type { InstitutionalBriefBinding, InstitutionalBriefReview, InstitutionalBriefSource, PreparedInstitutionalDraft } from './institutionalBrief';
import {
  canonicalDigest, catalogueId, institutionalBriefDigest, institutionalBriefMaxBytes, list, metadataSource,
  record, requestedCatalogueRows, requireCatalogue, sourceReferences, type InstitutionalCatalogueSource,
} from './institutionalEvidence';
import { STAFF_SLUG } from '../../../domain/staff/parse';

export const institutionalAccessibilityDirectory = '.planning/staff/institutional/special/accessibility-reviews';

const purpose = 'fictional-help-sheet-accessibility-ss-18';
const sheetId = 'item-5a000010';
const sheetRevision = 'r5';
const checklistVersion = 'r1';
const checklist = [
  ['item-5a000001', 'heading-structure'],
  ['item-5a000002', 'descriptive-link-labels'],
  ['item-5a000003', 'alternative-format-evidence'],
] as const;
type AccessibilityCheck = typeof checklist[number][1];

interface AccessibilitySheetReference {
  readonly id: typeof sheetId;
  readonly revision: typeof sheetRevision;
  readonly evidence: InstitutionalCatalogueSource;
}

interface AccessibilityObservation {
  readonly id: string;
  readonly check: AccessibilityCheck;
  readonly condition: 'documented-observation' | 'observed-issue' | 'missing-evidence';
  readonly evidence: InstitutionalCatalogueSource | null;
  readonly issueObserved: boolean;
  readonly evidenceGap: boolean;
}

export interface InstitutionalAccessibilityEvidence {
  readonly purpose: typeof purpose;
  readonly requester: 'fictional-accessibility-reviewer';
  readonly productId: string;
  readonly policyRevision: string;
  readonly sheet: AccessibilitySheetReference;
  readonly checklistVersion: typeof checklistVersion;
  readonly adviser: InstitutionalCatalogueSource;
  readonly productOwner: InstitutionalCatalogueSource;
  readonly records: readonly AccessibilityObservation[];
}

export interface InstitutionalAccessibilityReview extends Omit<InstitutionalBriefReview, 'duty' | 'kind'> {
  readonly duty: 'SS-18';
  readonly kind: 'accessibility-review';
  readonly policyRevision: string;
  readonly scopeDigest: string;
  readonly sheet: AccessibilitySheetReference;
  readonly checklistVersion: typeof checklistVersion;
  readonly adviser: InstitutionalCatalogueSource;
  readonly productOwner: InstitutionalCatalogueSource;
  readonly advice: 'pending';
  readonly remediation: 'pending';
}

export function admittedInstitutionalAccessibility(
  raw: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[],
): InstitutionalAccessibilityEvidence {
  const { receipt, rows } = record(raw, ['receipt', 'rows']);
  const authorization = record(receipt, ['project', 'directory', 'requester', 'purpose', 'policyRevision', 'productId',
    'sheetId', 'sheetRevision', 'checklistVersion', 'sheet', 'adviser', 'productOwner', 'recordIds']);
  const { requester, policyRevision, productId } = authorization;
  requireCatalogue(authorization.project === binding.project && authorization.directory === binding.directory &&
    requester === 'fictional-accessibility-reviewer' && authorization.purpose === purpose &&
    authorization.sheetId === sheetId && authorization.sheetRevision === sheetRevision &&
    authorization.checklistVersion === checklistVersion &&
    typeof policyRevision === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(policyRevision) &&
    typeof productId === 'string' && STAFF_SLUG.test(productId));
  const sheetEvidence = metadataSource(sources, authorization.sheet, 'fictional-help-sheet-attestor');
  const adviser = metadataSource(sources, authorization.adviser, 'fictional-accessibility-adviser');
  const productOwner = metadataSource(sources, authorization.productOwner, 'fictional-help-sheet-product-owner');
  const authoritySources = new Set([sheetEvidence.sourceId, adviser.sourceId, productOwner.sourceId]);
  requireCatalogue(sheetEvidence.revision === sheetRevision && authoritySources.size === 3);
  const ids = list(authorization.recordIds, catalogueId);
  requireCatalogue(ids.length === checklist.length && checklist.every(([id]) => ids.includes(id)));

  const records: AccessibilityObservation[] = [];
  for (const candidate of list(rows, (entry) => entry)) {
    requireCatalogue(candidate && typeof candidate === 'object' && !Array.isArray(candidate));
    const { id } = candidate as { id?: unknown };
    const checklistItem = checklist.find(([approvedId]) => approvedId === id);
    if (!checklistItem) continue;
    const [approvedId, check] = checklistItem;
    const row = record(candidate, ['id', 'check', 'condition', 'evidence']);
    const { condition } = row;
    requireCatalogue(row.check === check && (condition === 'documented-observation' || condition === 'observed-issue' || condition === 'missing-evidence'));
    const evidenceGap = condition === 'missing-evidence';
    requireCatalogue(evidenceGap === (row.evidence === null));
    const evidence = evidenceGap ? null : metadataSource(sources, row.evidence, 'fictional-checklist-evidence-reviewer');
    requireCatalogue(!evidence || !authoritySources.has(evidence.sourceId));
    records.push({ id: approvedId, check, condition, evidence, issueObserved: condition === 'observed-issue', evidenceGap });
  }
  requireCatalogue(records.length === checklist.length && new Set(records.map(({ id }) => id)).size === records.length);
  return { purpose, requester, productId, policyRevision, sheet: { id: sheetId, revision: sheetRevision, evidence: sheetEvidence },
    checklistVersion, adviser, productOwner, records: records.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function prepareInstitutionalAccessibility(
  input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[], accepted: InstitutionalAccessibilityEvidence,
): PreparedInstitutionalDraft {
  const records = requestedCatalogueRows(input, accepted);
  requireCatalogue(records.length === checklist.length);
  const evidenceIds = new Set([accepted.sheet.evidence.sourceId, accepted.adviser.sourceId, accepted.productOwner.sourceId,
    ...records.map(({ evidence }) => evidence?.sourceId)]);
  const identity = { ...binding, duty: 'SS-18' as const, echelon: 'L3' as const, kind: 'accessibility-review' as const,
    productId: accepted.productId, policyRevision: accepted.policyRevision, scopeDigest: canonicalDigest(accepted),
    sheet: accepted.sheet, checklistVersion: accepted.checklistVersion, adviser: accepted.adviser, productOwner: accepted.productOwner,
    advice: 'pending' as const, remediation: 'pending' as const, sources: sourceReferences(sources.filter(({ id }) => evidenceIds.has(id))) };
  const bytes = canonicalBytes({ schema: 1, ...identity, body: { records } });
  requireCatalogue(bytes.length <= institutionalBriefMaxBytes);
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalAccessibilityDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}
