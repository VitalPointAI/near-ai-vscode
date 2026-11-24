// Pure checks shared by the Compliance and Documentation views. No DOM and no Theia imports, so Node tests them directly.

const FULL_COMMIT = /^[0-9a-f]{40}$/;

/**
 * compliance:refresh writes refresh.json beside the dashboard only after the bundle's manifest hashes check out.
 * The record vouches for the dashboard only when it says the manifest was verified and names exactly the same full commit:
 * a shared prefix is not enough, because two different commits can share one.
 */
export function refreshRecordMatches(value: unknown, dashboardCommit: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (entry.manifest !== 'verified') return false;
  if (!['source', 'commit', 'fetchedAt', 'attestation'].every(key => typeof entry[key] === 'string')) return false;
  if (typeof dashboardCommit !== 'string') return false;
  const recorded = (entry.commit as string).toLowerCase();
  return FULL_COMMIT.test(recorded) && recorded === dashboardCommit.toLowerCase();
}

export interface DocumentationPage {
  readonly source: string;
  readonly route: string;
  readonly category: string;
  readonly title: string;
  /** The page as HTML, made at build time (workbench/tools/documentation-render.mjs); the view sanitizes it again before showing it. */
  readonly html: string;
  /** The page's plain text, for search. */
  readonly text: string;
}

/** The bundled documentation collection: a non-empty list of pages whose six fields are all strings. */
export function isDocumentationPages(value: unknown): value is DocumentationPage[] {
  return Array.isArray(value) && value.length > 0 && value.every(page =>
    typeof page === 'object' && page !== null &&
    ['source', 'route', 'category', 'title', 'html', 'text'].every(key => typeof (page as Record<string, unknown>)[key] === 'string'));
}
