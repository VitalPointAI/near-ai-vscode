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

// ---- The release evidence service (48.2-01, D-01, D-11, D-18) ----
// The backend reads the release evidence folder, checks it against its manifest and re-judges it with the status engine against the
// current time; the browser shows what it returns and never computes a state.

export const EVIDENCE_SERVICE_PATH = '/services/sterling-evidence';
export const SterlingEvidenceService = Symbol('SterlingEvidenceService');

export type EvidenceState = 'met' | 'partly-met' | 'not-met' | 'stale' | 'not-applicable' | 'your-organizations-responsibility';
/** A row's freshness: the worst of its results; `none` when it has no evidence. 48.2-03 adds Ageing. */
export type EvidenceFreshness = 'current' | 'out-of-date' | 'none';

export interface EvidenceResult {
  readonly rule: string;
  readonly passed: boolean;
  readonly collectedAt: string;
  readonly commit?: string;
  readonly window: string;
  readonly runUrl?: string;
}

export interface EvidenceComponent {
  readonly component: string;
  readonly responsibility: string;
  readonly state: EvidenceState;
  readonly reasonText: string;
  readonly statement?: string;
  readonly evidence: readonly EvidenceResult[];
}

/** One control at one level, judged now, with where its evidence comes from, its as-of time and its freshness. */
export interface EvidenceRow {
  readonly level: string;
  readonly control: string;
  readonly label: string;
  readonly title: string;
  readonly state: EvidenceState;
  readonly reasonText: string;
  readonly gap?: string;
  readonly textFile?: string;
  readonly components: readonly EvidenceComponent[];
  readonly source: 'release';
  /** The oldest result time of the row; absent when the row has no evidence. */
  readonly asOf?: string;
  readonly freshness: EvidenceFreshness;
}

export interface EvidenceLevel {
  readonly id: string;
  readonly title: string;
  readonly claim: boolean;
}

/** Why the release evidence did not verify: a file that is missing, extra, a link, the wrong size or changed, or an unreadable format. */
export type ReleaseDidNotVerifyReason = 'format' | 'field' | 'path' | 'missing' | 'extra' | 'symlink' | 'size' | 'hash' | 'unreadable';

/**
 * The release layer. `none`: the image carries no release evidence. `did-not-verify`: nothing from it is shown, only the reason.
 * `not-verified`: the content is shown, but no configured key vouches for it, so no row counts as Met (48.2-04 adds signatures).
 */
export type ReleaseEvidence =
  | { readonly verification: 'none' }
  | { readonly verification: 'did-not-verify'; readonly reason: ReleaseDidNotVerifyReason; readonly file: string }
  | {
    readonly verification: 'not-verified';
    readonly reason: 'no-trust-key';
    readonly version: string;
    readonly commit: string;
    /** The release build time: the as-of time of the release layer. */
    readonly asOf: string;
    readonly levels: readonly EvidenceLevel[];
    readonly rows: readonly EvidenceRow[];
  };

export interface EvidenceSnapshot {
  /** When the backend judged the rows. */
  readonly judgedAt: string;
  readonly release: ReleaseEvidence;
}

export interface SterlingEvidenceService {
  getEvidence(): Promise<EvidenceSnapshot>;
}

/** The words the Compliance view shows for release evidence (48.2-UI-SPEC copywriting contract). */
export const RELEASE_EVIDENCE_TEXT = {
  source: 'Release',
  release: 'Release {version}',
  asOf: 'as of {time}',
  verified: 'Verified',
  notVerified: 'Not verified',
  current: 'Current',
  outOfDate: 'Out of date',
  noEvidence: 'No evidence',
  noTrustKey: 'Not verified: no key from your organization’s configuration vouches for this release’s evidence, so nothing counts as Met.',
  wouldBe: 'Would be {state} if verified.',
  didNotVerify: 'The release evidence did not verify.',
  didNotVerifyTail: 'Nothing from this source is shown.',
  heading: 'Release evidence. Authorization is your organization’s decision.',
} as const;

/** One sentence per reason the release evidence did not verify (48.2-UI-SPEC `dnv.*`); `{file}` is the path inside the evidence folder. */
export const RELEASE_DID_NOT_VERIFY_TEXT: Readonly<Record<ReleaseDidNotVerifyReason, string>> = {
  missing: '{file} is missing from the release evidence.',
  extra: '{file} is in the release evidence but not in its manifest.',
  symlink: '{file} is a link, and the evidence may hold only plain files.',
  size: '{file} is not the size its manifest records.',
  hash: '{file} has changed since the evidence was signed.',
  format: '{file} is in a format this release does not read.',
  field: '{file} is in a format this release does not read.',
  path: '{file} is in a format this release does not read.',
  unreadable: '{file} could not be read.',
};
