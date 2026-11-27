import { canonicalBytes } from '../../../domain/team/canonical';
import type { InstitutionalBriefBinding, InstitutionalDraftReview, InstitutionalLibraryRemitEvidence } from './institutionalBrief';
import { canonicalDigest, institutionalBriefMaxBytes, record, requireCatalogue, text } from './institutionalEvidence';

export type InstitutionalRenditionSource = Extract<InstitutionalDraftReview, { kind: 'library-service-remits' }>;

const languages = ['en-CA', 'fr-CA'] as const;

/**
 * Bind exact, manually authored language versions to the review evidence from a
 * reopened draft. Preparing the manifest does not confer review or export rights.
 */
export function prepareInstitutionalRenditions(source: InstitutionalRenditionSource, input: unknown) {
  const supplied = record(input, languages);
  const content = languages.map((language) => {
    const candidate = record(supplied[language], ['title', 'text']);
    return {
      language,
      title: text(candidate.title, 240),
      text: text(candidate.text, institutionalBriefMaxBytes),
    };
  });
  const manifest = {
    schema: 1 as const,
    product: source.productId,
    project: source.project,
    directory: source.directory,
    sourceVersion: source.version,
    policyRevision: source.policyRevision,
    sourceScope: source.scopeDigest,
    sources: source.sources.map(({ id, revision, date, label, hash }) => ({ id, revision, date, label, hash })),
    renditions: content.map((rendition) => ({
      language: rendition.language,
      origin: 'manual' as const,
      digest: canonicalDigest(rendition),
    })),
  };
  requireCatalogue(canonicalBytes({ manifest, content }).length <= institutionalBriefMaxBytes);
  return { manifest, content, digest: canonicalDigest(manifest) };
}

type InstitutionalRenditionPair = ReturnType<typeof prepareInstitutionalRenditions>;

export interface InstitutionalRenditionHost {
  readonly currentRenditions: () => unknown;
  readonly currentReview: () => unknown;
  readonly currentAccess: () => unknown;
}

export interface InstitutionalRenditionRequest {
  readonly version: string;
  readonly selection: string;
  readonly requester: string;
  readonly purpose: string;
}

export function verifyInstitutionalRenditionReview(pair: Pick<InstitutionalRenditionPair, 'manifest' | 'digest'>, review: unknown) {
  const expected = {
    pairDigest: pair.digest, policyRevision: pair.manifest.policyRevision, decision: 'approved',
    reviewer: 'fictional-library-language-reviewer', role: 'fictional-language-pair-reviewer',
    issuer: 'fictional-library-review-office', operation: 'review-rendition-pair',
  };
  requireCatalogue(canonicalDigest(review) === canonicalDigest(expected));
  return expected;
}

export function verifyInstitutionalRenditionAccess(pair: InstitutionalRenditionPair, request: InstitutionalRenditionRequest, access: unknown): void {
  const { project, directory, product, sourceVersion, policyRevision } = pair.manifest;
  const expected = {
    project, directory, product, sourceVersion, policyRevision,
    requester: request.requester, purpose: request.purpose, operation: 'record-current-renditions', decision: 'allow',
  };
  requireCatalogue(canonicalDigest(access) === canonicalDigest(expected));
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function renderInstitutionalRenditions(pair: InstitutionalRenditionPair, selection: string): string {
  const selected = pair.content.find(({ language }) => language === selection);
  requireCatalogue(selected || selection === 'bilingual');
  const lang = selected?.language ?? 'en-CA';
  const title = selected?.title ?? 'Library services / Services de bibliothèque';
  const heading = selected ? '' : '<h1>Library services / <span lang="fr-CA">Services de bibliothèque</span></h1>';
  const level = selected ? 'h1' : 'h2';
  const sections = (selected ? [selected] : pair.content).map(({ language, title, text }) =>
    `<section lang="${language}"><${level}>${escapeHtml(title)}</${level}><p>${escapeHtml(text)}</p></section>`);
  const citations = pair.manifest.sources.map(({ id, revision, hash }) =>
    `<li>${escapeHtml(id)}, ${escapeHtml(revision)}, <code>${escapeHtml(hash)}</code></li>`);
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body><main>${heading}${sections.join('')}<h2>Sources</h2><ul>${citations.join('')}</ul></main></body></html>`;
}

export type InstitutionalRenditionHistoryRequest = Omit<InstitutionalRenditionRequest, 'selection'> & {
  readonly pairDigest: string;
};

export interface InstitutionalRenditionHistoryHost {
  readonly formerPair: (digest: string) => { readonly manifest: InstitutionalRenditionPair['manifest']; readonly review: unknown } | undefined;
  readonly currentHistoryAccess: () => unknown;
}

export function institutionalRenditionHistoryMetadata(
  request: InstitutionalRenditionHistoryRequest, former: ReturnType<InstitutionalRenditionHistoryHost['formerPair']>,
  access: unknown, binding: InstitutionalBriefBinding, admitted: InstitutionalLibraryRemitEvidence,
) {
  requireCatalogue(former);
  const { manifest } = former;
  const digest = canonicalDigest(manifest);
  requireCatalogue(digest === request.pairDigest && manifest.sourceVersion === request.version &&
    manifest.project === binding.project && manifest.directory === binding.directory &&
    manifest.product === 'library-service-remits' && manifest.product === admitted.productId &&
    request.purpose === admitted.purpose && admitted.records.length === 2);
  requireCatalogue(manifest.renditions.length === languages.length && manifest.renditions.every(({ language, origin }, index) =>
    language === languages[index] && origin === 'manual'));

  const sourceIds = manifest.sources.map(({ id }) => id).sort();
  const admittedIds = [admitted.liaisonLead.sourceId, ...admitted.records.flatMap(({ mandate, consent }) =>
    mandate ? [mandate.sourceId, consent.evidence.sourceId] : [consent.evidence.sourceId])].sort();
  requireCatalogue(canonicalDigest(sourceIds) === canonicalDigest(admittedIds));

  const expected = {
    project: binding.project, directory: binding.directory, product: admitted.productId,
    formerVersion: manifest.sourceVersion, pairDigest: digest, sourceIds, requester: request.requester, purpose: admitted.purpose,
    policyRevision: admitted.policyRevision, currentScopeDigest: canonicalDigest(admitted),
    operation: 'read-historical-review-metadata', decision: 'allow',
  };
  requireCatalogue(canonicalDigest(access) === canonicalDigest(expected));
  const review = verifyInstitutionalRenditionReview({ manifest, digest }, former.review);
  return {
    sourceVersion: manifest.sourceVersion,
    renditions: manifest.renditions.map(({ language, origin, digest }) => ({ language, origin, digest })),
    review,
  };
}
