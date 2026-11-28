import { canonicalBytes } from '../../../domain/team/canonical';
import type { InstitutionalBriefBinding, InstitutionalBriefReview, InstitutionalBriefSource, PreparedInstitutionalDraft } from './institutionalBrief';
import {
  canonicalDigest, catalogueId, institutionalBriefDigest, institutionalBriefMaxBytes, list, metadataDate, metadataSource,
  record, requestedCatalogueRows, requireCatalogue, sourceReferences, type InstitutionalCatalogueSource,
} from './institutionalEvidence';
import { STAFF_SLUG } from '../../../domain/staff/parse';

export const institutionalLegalReferencesDirectory = '.planning/staff/institutional/special/legal-references';

const legalPurpose = 'fictional-office-booking-ss-01';
const legalReferences = [
  { kind: 'booking-guidance', title: 'Fictional Meeting Room Booking Guide', section: 'Booking hours' },
  { kind: 'posted-notice', title: 'Fictional Meeting Room Notice', section: 'Weekday postings' },
] as const;

interface LegalReferenceRecord {
  readonly id: string;
  readonly kind: typeof legalReferences[number]['kind'];
  readonly title: string;
  readonly date: string;
  readonly edition: string;
  readonly section: string;
  readonly language: 'en';
  readonly rendition: 'SRC';
  readonly evidence: InstitutionalCatalogueSource;
}

interface LegalFactualQuestion {
  readonly kind: 'edition-posted-on-recorded-date';
  readonly date: string;
  readonly referenceIds: readonly string[];
  readonly status: 'open';
}

export interface InstitutionalLegalReferencesEvidence {
  readonly purpose: typeof legalPurpose;
  readonly requester: 'fictional-legal-reference-reviewer';
  readonly productId: string;
  readonly policyRevision: string;
  readonly adviser: InstitutionalCatalogueSource;
  readonly custodian: InstitutionalCatalogueSource;
  readonly records: readonly LegalReferenceRecord[];
  readonly question: LegalFactualQuestion;
}

export interface InstitutionalLegalReferencesReview extends Omit<InstitutionalBriefReview, 'duty' | 'kind'> {
  readonly duty: 'SS-01';
  readonly kind: 'legal-references';
  readonly policyRevision: string;
  readonly scopeDigest: string;
  readonly adviser: InstitutionalCatalogueSource;
  readonly custodian: InstitutionalCatalogueSource;
  readonly advice: 'pending';
}

export function admittedInstitutionalLegalReferences(
  raw: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[],
): InstitutionalLegalReferencesEvidence {
  const { receipt, rows } = record(raw, ['receipt', 'rows']);
  const authorization = record(receipt, ['project', 'directory', 'requester', 'purpose', 'productId', 'policyRevision', 'adviser', 'custodian', 'recordIds', 'question']);
  const { requester, productId, policyRevision } = authorization;
  requireCatalogue(authorization.project === binding.project && authorization.directory === binding.directory &&
    requester === 'fictional-legal-reference-reviewer' && authorization.purpose === legalPurpose &&
    typeof productId === 'string' && STAFF_SLUG.test(productId) &&
    typeof policyRevision === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(policyRevision));
  const adviser = metadataSource(sources, authorization.adviser, 'fictional-legal-adviser');
  const custodian = metadataSource(sources, authorization.custodian, 'fictional-reference-custodian');
  const sourceIds = new Set([adviser.sourceId, custodian.sourceId]);
  requireCatalogue(sourceIds.size === 2);
  const authorizedIds = list(authorization.recordIds, catalogueId, legalReferences.length);
  const ids = new Set(authorizedIds);
  requireCatalogue(ids.size === legalReferences.length && authorizedIds.length === ids.size);

  const records: LegalReferenceRecord[] = [];
  for (const candidate of list(rows, (entry) => entry)) {
    requireCatalogue(candidate && typeof candidate === 'object' && !Array.isArray(candidate));
    const { id } = candidate as { id?: unknown };
    if (typeof id !== 'string' || !ids.has(id)) continue;
    const row = record(candidate, ['id', 'kind', 'title', 'date', 'edition', 'section', 'language', 'evidence']);
    const reference = legalReferences.find(({ kind }) => kind === row.kind);
    requireCatalogue(reference && row.title === reference.title && row.section === reference.section && row.language === 'en' &&
      typeof row.edition === 'string' && /^edition-[1-9][0-9]?$/.test(row.edition));
    const date = metadataDate(row.date);
    const evidence = metadataSource(sources, row.evidence, 'fictional-legal-reference-attestor');
    requireCatalogue(!sourceIds.has(evidence.sourceId) && sources.some((source) => source.id === evidence.sourceId && source.date === date));
    sourceIds.add(evidence.sourceId);
    records.push({ id, ...reference, date, edition: row.edition, language: 'en', rendition: 'SRC', evidence });
  }
  requireCatalogue(records.length === legalReferences.length && new Set(records.map(({ id }) => id)).size === records.length &&
    new Set(records.map(({ kind }) => kind)).size === records.length);
  const question = record(authorization.question, ['kind', 'date', 'referenceIds']);
  const referenceIds = list(question.referenceIds, catalogueId, legalReferences.length);
  requireCatalogue(question.kind === 'edition-posted-on-recorded-date' && referenceIds.length === ids.size &&
    new Set(referenceIds).size === ids.size && referenceIds.every((id) => ids.has(id)));
  return { purpose: legalPurpose, requester, productId, policyRevision, adviser, custodian,
    records: records.sort((a, b) => a.id.localeCompare(b.id)),
    question: { kind: question.kind, date: metadataDate(question.date), referenceIds: referenceIds.sort(), status: 'open' } };
}

export function prepareInstitutionalLegalReferences(
  input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[], accepted: InstitutionalLegalReferencesEvidence,
): PreparedInstitutionalDraft {
  const records = requestedCatalogueRows(input, accepted);
  requireCatalogue(records.length === accepted.question.referenceIds.length);
  const evidenceIds = new Set([accepted.adviser.sourceId, accepted.custodian.sourceId, ...records.map(({ evidence }) => evidence.sourceId)]);
  const identity = { ...binding, duty: 'SS-01' as const, echelon: 'L3' as const, kind: 'legal-references' as const,
    productId: accepted.productId, policyRevision: accepted.policyRevision, scopeDigest: canonicalDigest(accepted),
    adviser: accepted.adviser, custodian: accepted.custodian, advice: 'pending' as const,
    sources: sourceReferences(sources.filter(({ id }) => evidenceIds.has(id))) };
  const bytes = canonicalBytes({ schema: 1, ...identity, body: { records, question: accepted.question } });
  requireCatalogue(bytes.length <= institutionalBriefMaxBytes);
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalLegalReferencesDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}

export const institutionalPolicySourcesDirectory = '.planning/staff/institutional/special/policy-sources';

const policyPurpose = 'fictional-office-help-policy-ss-16';
const policySources = {
  'documented-provision': {
    title: 'Fictional Office Appointment Notice', owner: 'Fictional Office Help Desk',
    extract: 'The fictional office notice lists Tuesday as the earliest weekday for desk appointments.',
    attestor: 'fictional-policy-notice-attestor',
  },
  commentary: {
    title: 'Fictional Office Service Bulletin', owner: 'Fictional Office Service Board',
    extract: 'The fictional bulletin suggests reviewing whether other weekdays would help.',
    attestor: 'fictional-policy-commentary-attestor',
  },
} as const;

interface PolicySourceRecord {
  readonly id: string;
  readonly kind: keyof typeof policySources;
  readonly title: string;
  readonly owner: string;
  readonly date: string;
  readonly language: 'en';
  readonly rendition: 'SRC';
  readonly extract: string;
  readonly span: { readonly start: number; readonly end: number };
  readonly evidence: InstitutionalCatalogueSource;
}

export interface InstitutionalPolicySourcesEvidence {
  readonly purpose: typeof policyPurpose;
  readonly requester: 'fictional-policy-source-reviewer';
  readonly productId: string;
  readonly policyRevision: string;
  readonly adviser: InstitutionalCatalogueSource;
  readonly custodian: InstitutionalCatalogueSource;
  readonly records: readonly PolicySourceRecord[];
  readonly consultation: {
    readonly kind: 'confirm-office-desk-consultation';
    readonly referenceIds: readonly string[];
    readonly status: 'open';
  };
}

export interface InstitutionalPolicySourcesReview extends Omit<InstitutionalBriefReview, 'duty' | 'kind'> {
  readonly duty: 'SS-16';
  readonly kind: 'policy-sources';
  readonly policyRevision: string;
  readonly scopeDigest: string;
  readonly adviser: InstitutionalCatalogueSource;
  readonly custodian: InstitutionalCatalogueSource;
  readonly advice: 'pending';
  readonly signoff: 'pending';
}

export function admittedInstitutionalPolicySources(
  raw: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[],
): InstitutionalPolicySourcesEvidence {
  const { receipt, rows } = record(raw, ['receipt', 'rows']);
  const authorization = record(receipt, ['project', 'directory', 'requester', 'purpose', 'productId', 'policyRevision', 'adviser', 'custodian', 'recordIds', 'consultation']);
  const { requester, productId, policyRevision } = authorization;
  requireCatalogue(authorization.project === binding.project && authorization.directory === binding.directory &&
    requester === 'fictional-policy-source-reviewer' && authorization.purpose === policyPurpose &&
    typeof productId === 'string' && STAFF_SLUG.test(productId) &&
    typeof policyRevision === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(policyRevision));
  const adviser = metadataSource(sources, authorization.adviser, 'fictional-institutional-policy-adviser');
  const custodian = metadataSource(sources, authorization.custodian, 'fictional-public-reference-custodian');
  const sourceIds = new Set([adviser.sourceId, custodian.sourceId]);
  requireCatalogue(sourceIds.size === 2);
  const authorizedIds = list(authorization.recordIds, catalogueId, 2);
  const ids = new Set(authorizedIds);
  requireCatalogue(ids.size === 2 && authorizedIds.length === ids.size);

  const records: PolicySourceRecord[] = [];
  for (const candidate of list(rows, (entry) => entry)) {
    requireCatalogue(candidate && typeof candidate === 'object' && !Array.isArray(candidate));
    const { id } = candidate as { id?: unknown };
    if (typeof id !== 'string' || !ids.has(id)) continue;
    const row = record(candidate, ['id', 'kind', 'title', 'owner', 'date', 'language', 'extract', 'evidence']);
    const { kind } = row;
    requireCatalogue(kind === 'documented-provision' || kind === 'commentary');
    const { title, owner, extract, attestor } = policySources[kind];
    requireCatalogue(row.title === title && row.owner === owner && row.extract === extract && row.language === 'en');
    const date = metadataDate(row.date);
    const evidence = metadataSource(sources, row.evidence, attestor);
    const source = sources.find(({ id, revision }) => id === evidence.sourceId && revision === evidence.revision);
    requireCatalogue(source?.date === date && !sourceIds.has(evidence.sourceId));
    const matching = source.spans.filter(({ start, end }) => source.text.slice(start, end) === extract);
    requireCatalogue(matching.length === 1);
    const { start, end } = matching[0];
    sourceIds.add(evidence.sourceId);
    records.push({ id, kind, title, owner, date, language: 'en', rendition: 'SRC', extract, span: { start, end }, evidence });
  }
  requireCatalogue(records.length === ids.size && new Set(records.map(({ id }) => id)).size === ids.size &&
    new Set(records.map(({ kind }) => kind)).size === ids.size);
  const consultation = record(authorization.consultation, ['kind', 'referenceIds']);
  const referenceIds = list(consultation.referenceIds, catalogueId, 2);
  requireCatalogue(consultation.kind === 'confirm-office-desk-consultation' && referenceIds.length === ids.size &&
    new Set(referenceIds).size === ids.size && referenceIds.every((id) => ids.has(id)));
  return { purpose: policyPurpose, requester, productId, policyRevision, adviser, custodian,
    records: records.sort((a, b) => a.id.localeCompare(b.id)),
    consultation: { kind: consultation.kind, referenceIds: referenceIds.sort(), status: 'open' } };
}

export function prepareInstitutionalPolicySources(
  input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[], accepted: InstitutionalPolicySourcesEvidence,
): PreparedInstitutionalDraft {
  const records = requestedCatalogueRows(input, accepted);
  requireCatalogue(records.length === accepted.consultation.referenceIds.length);
  const evidenceIds = new Set([accepted.adviser.sourceId, accepted.custodian.sourceId, ...records.map(({ evidence }) => evidence.sourceId)]);
  const identity = { ...binding, duty: 'SS-16' as const, echelon: 'L3' as const, kind: 'policy-sources' as const,
    productId: accepted.productId, policyRevision: accepted.policyRevision, scopeDigest: canonicalDigest(accepted),
    adviser: accepted.adviser, custodian: accepted.custodian, advice: 'pending' as const, signoff: 'pending' as const,
    sources: sourceReferences(sources.filter(({ id }) => evidenceIds.has(id))) };
  const bytes = canonicalBytes({ schema: 1, ...identity, body: { records, consultation: accepted.consultation } });
  requireCatalogue(bytes.length <= institutionalBriefMaxBytes);
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalPolicySourcesDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}
