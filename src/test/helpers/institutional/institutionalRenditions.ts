import { canonicalBytes } from '../../../domain/team/canonical';
import type { InstitutionalDraftReview } from './institutionalBrief';
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
