// Documentation collector (44-07, D-09, D-23, D-24). Required documents are
// checked locally for their review statement and named headings; their text is never evidence.
import path from 'node:path';
import type { Observation } from '../model.ts';
import type { Collector, CollectorContext } from './types.ts';
import { loadBlocks, staleBlocks, type Block } from '../hosted/generate.ts';

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
  { path: 'docs/security/hosted-verification-records.md', reviewRequired: true, headings: ['Section 10 conditions', 'Verification register', 'Keycloak CVE-2026-6856 fix version', 'HSM FIPS 140-3 certificates', 'Go Cryptographic Module certificates', 'Traefik and the Theia Cloud chart', 'OpenBao kms-pkcs11 plugin release', 'Theia Cloud project health', 'Prewarm pool and personal volumes', 'Theia 1.77 supported Node range', 'RHEL 9 OpenSSL FIPS provider certificate', 'Bouncy Castle FIPS Java certificates', 'Harbor and Zot FIPS builds'] },
  { path: 'docs/development-workflow.md', reviewRequired: false, headings: ['8. Repository settings (owner only)'] },
  // 48.1-01 (D-06, D-08): the hosted SA&A documents, registered with their fixed headings before they are written, so a document not yet
  // written reads as failing evidence. Generated blocks inside them are checked too (stale-blocks, D-09).
  { path: 'docs/security/hosted-interconnections.md', reviewRequired: true, headings: ['Exchanges and interconnections', 'Exchange diagram', 'Agreements'] },
  { path: 'docs/security/hosted-external-services.md', reviewRequired: true, headings: ['External services', 'Adding a service'] },
  { path: 'docs/security/hosted-architecture.md', reviewRequired: true, headings: ['Network and boundary', 'Ports, protocols and services', 'Workload rights'] },
  { path: 'docs/security/hosted-system-description.md', reviewRequired: true, headings: ['System', 'Information types', 'Authorization boundary', 'What the site inherits', 'Users and roles', 'Diagrams'] },
  { path: 'docs/security/hosted-audit.md', reviewRequired: true, headings: ['Alerts', 'Audit review', 'Archive and integrity', 'Retention'] },
  { path: 'docs/security/hosted-key-management.md', reviewRequired: true, headings: ['Key inventory', 'Lifecycle', 'Hardware security module', 'Signing keys', 'Compromise and revocation', 'Known limits'] },
  { path: 'docs/security/hosted-crypto-inventory.md', reviewRequired: true, headings: ['Components', 'Open conditions'] },
  { path: 'docs/security/hosted-suppliers.md', reviewRequired: true, headings: ['Suppliers', 'Assessment and notification'] },
  { path: 'docs/security/hosted-roles-and-duties.md', reviewRequired: true, headings: ['Roles', 'Separation of duties', 'Training'] },
  { path: 'docs/security/hosted-privacy.md', reviewRequired: true, headings: ['Personal information inventory', 'Retention and disposal', 'Testing and training data', 'Privacy impact assessment inputs'] },
  { path: 'docs/security/hosted-incident-playbooks.md', reviewRequired: true, headings: ['Signing key compromise', 'HQ root or intermediate compromise', 'HSM loss or tamper', 'Unseal failure', 'Person key or passkey compromise', 'Spill to an observer', 'Credential issuer or status-list key compromise', 'Stale status list at an edge'] },
  { path: 'docs/security/hosted-continuous-monitoring.md', reviewRequired: true, headings: ['What is monitored', 'Cadence', 'Disconnected sites', 'Reviews and triggers'] },
  { path: 'docs/security/hosted-observers.md', reviewRequired: true, headings: ['Releasability tokens', 'Authority', 'Agreements and clearances', 'Rules of behaviour'] }
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
    const blocks: readonly Block[] = await loadBlocks();
    const source = { readText: (relativePath: string) => context.readFile(safeDocumentPath(input.repoRoot, relativePath)) };
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
      // A document with generated blocks (48.1-01, D-09) fails while any block differs from what its source produces.
      const hasBlocks = blocks.some((block) => block.document === document.path) || text.includes('<!-- generated:');
      const stale = hasBlocks ? (await staleBlocks(text, document.path, blocks, source)).length : 0;
      observations.push({
        collector: 'documents',
        subject,
        passed: missingHeadings === 0 && reviewOk && stale === 0,
        collectedAt: review?.toISOString() ?? context.now.toISOString(),
        commit: context.commit,
        counts: { missing: 0, 'missing-headings': missingHeadings, ...(document.reviewRequired ? { 'missing-review': review ? 0 : 1, 'stale-review': review && !reviewFresh ? 1 : 0 } : {}), ...(hasBlocks ? { 'stale-blocks': stale } : {}) }
      });
    }
    return observations;
  }
});
