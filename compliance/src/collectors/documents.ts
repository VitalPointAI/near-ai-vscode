// Documentation collector (44-07, D-09, D-23, D-24). Required documents are
// checked locally for their review statement and named headings; their text is never evidence.
import path from 'node:path';
import type { Observation } from '../model.ts';
import type { Collector, CollectorContext } from './types.ts';

export interface RequiredDocument {
  readonly path: string;
  readonly reviewRequired: boolean;
  readonly headings: readonly string[];
}

/** Review statements must be at the beginning of a line and use an ISO calendar date. */
export const LAST_REVIEWED_PATTERN = /^Last reviewed: (\d{4}-\d{2}-\d{2})/m;
export const DOCUMENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export const REQUIRED_DOCUMENTS: readonly RequiredDocument[] = Object.freeze([
  { path: 'SECURITY.md', reviewRequired: true, headings: ['Supported versions', 'Known limitations', 'Reporting a vulnerability'] },
  { path: 'docs/security/incident-response.md', reviewRequired: true, headings: ['Reporting', 'Triage', 'Fix and advisory', 'Rolling back a release', 'Telling users', "Your organization's part"] },
  { path: 'docs/security/threat-model.md', reviewRequired: true, headings: ['What is protected', 'Trust boundaries', 'Threats and mitigations', 'What the product cannot stop'] },
  { path: 'docs/security/data-flow.md', reviewRequired: true, headings: ['Extension', 'Messaging relay', 'Sync hub', 'Release pipeline', 'Model endpoints'] },
  { path: 'docs/security/crypto-inventory.md', reviewRequired: true, headings: ['Algorithms', 'Basis'] },
  { path: 'docs/security/controlled-goods-and-itar.md', reviewRequired: true, headings: ['What the product does', 'What it does not do', 'Interim settings'] },
  { path: 'docs/development-workflow.md', reviewRequired: false, headings: ['8. Repository settings (owner only)'] }
]);

export interface DocumentsInput {
  readonly repoRoot: string;
}

const isMissing = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && ((error as { code?: unknown }).code === 'ENOENT' || (error as { code?: unknown }).code === 'ENOTDIR');

/** Date-only review records are made a UTC instant so freshness windows have no local-time ambiguity. */
export function reviewedAt(value: string): Date | undefined {
  const at = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value ? undefined : at;
}

function safeDocumentPath(repoRoot: string, documentPath: string): string {
  const root = path.resolve(repoRoot);
  const full = path.resolve(root, documentPath);
  if (!full.startsWith(`${root}${path.sep}`)) throw new Error(`documents collector: required path escapes repo root: ${documentPath}`);
  return full;
}

function headingsIn(text: string): ReadonlySet<string> {
  const headings = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^## (.+?)\s*$/.exec(line);
    if (match) headings.add(match[1]);
  }
  return headings;
}

/** One counts-only observation for every required document, including a missing document. */
export const documentsCollector: Collector<DocumentsInput> = Object.freeze({
  id: 'documents',
  window: 'document',
  async collect(input: DocumentsInput, context: CollectorContext): Promise<Observation[]> {
    if (!input || typeof input.repoRoot !== 'string' || input.repoRoot === '') throw new Error('documents collector: input.repoRoot is required');
    const observations: Observation[] = [];
    for (const document of REQUIRED_DOCUMENTS) {
      const subject = document.path.toLowerCase();
      let text: string | undefined;
      try {
        text = await context.readFile(safeDocumentPath(input.repoRoot, document.path));
      } catch (error) {
        if (!isMissing(error)) throw new Error(`documents collector: could not read ${document.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (text === undefined) {
        observations.push({ collector: 'documents', subject, passed: false, collectedAt: context.now.toISOString(), commit: context.commit, counts: { missing: 1, 'missing-headings': document.headings.length } });
        continue;
      }
      const headings = headingsIn(text);
      const missingHeadings = document.headings.filter((heading) => !headings.has(heading)).length;
      const reviewMatch = LAST_REVIEWED_PATTERN.exec(text.split(/\r?\n/, 40).join('\n'));
      const review = reviewMatch ? reviewedAt(reviewMatch[1]) : undefined;
      const reviewFresh = review !== undefined && context.now.getTime() - review.getTime() <= DOCUMENT_MAX_AGE_MS && context.now.getTime() >= review.getTime();
      const reviewOk = !document.reviewRequired || reviewFresh;
      observations.push({
        collector: 'documents',
        subject,
        passed: missingHeadings === 0 && reviewOk,
        collectedAt: review?.toISOString() ?? context.now.toISOString(),
        commit: context.commit,
        counts: { missing: 0, 'missing-headings': missingHeadings, ...(document.reviewRequired ? { 'missing-review': review ? 0 : 1, 'stale-review': review && !reviewFresh ? 1 : 0 } : {}) }
      });
    }
    return observations;
  }
});
