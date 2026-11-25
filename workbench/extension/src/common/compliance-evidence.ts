// The Compliance view's model, shared by the backend evidence service and the browser (48.2-01 to 48.2-08). Plain data only: it crosses
// JSON-RPC. No DOM and no Theia imports. The backend computes every state, freshness and verification here from the one status engine; the
// browser only shows it (D-01, D-11, D-18).

export const EVIDENCE_SERVICE_PATH = '/services/sterling-evidence';
export const SterlingEvidenceService = Symbol('SterlingEvidenceService');

/** The files of the projected evidence mount (/etc/sterling/evidence, D-22): one folder from four ConfigMaps. 48.2-11 to 48.2-13 write them. */
export const EVIDENCE_MOUNT_FILES = Object.freeze({
  /** Your organization's site key (sterling-evidence-trust; the install identity writes it, 48.2-17). */
  organizationKey: 'organization.pub',
  /** The supplier release key a person mounts on a single computer without a site. */
  supplierKey: 'supplier.pub',
  /** The site trust document and your site key's signature over it (sterling-evidence-trust). */
  trust: 'trust.json',
  trustSignature: 'trust.json.sigstore.json',
  /** The collector's live feed (sterling-site-evidence-live). */
  live: 'live.json',
  /** The operator's signed files (sterling-site-evidence-operator). */
  export: 'export.json',
  rescan: 'rescan.json',
  agreements: 'agreements.json',
} as const);
/** The release evidence signature in the mount (sterling-release-evidence): one per release the site holds. */
export const releaseSignatureFile = (version: string): string => `release-${version}.sigstore.json`;

export type EvidenceState = 'met' | 'partly-met' | 'not-met' | 'stale' | 'not-applicable' | 'your-organizations-responsibility';
/** What a cell shows: the engine state when its sources verified, "Not verified" otherwise (never counted as Met, D-18). */
export type DisplayState = EvidenceState | 'not-verified';
/** A result's or cell's freshness (D-12): the worst of its results; `none` with no evidence; `unknown` when the clock cannot be trusted. */
export type EvidenceFreshness = 'current' | 'ageing' | 'out-of-date' | 'unknown' | 'none';
/** Where a result comes from (D-24): the release, your site, the supplier's reference site, or the published projection. */
export type EvidenceSourceName = 'release' | 'site' | 'reference-site' | 'projection';

export interface EvidenceResult {
  readonly rule: string;
  readonly passed: boolean;
  readonly collectedAt: string;
  readonly commit?: string;
  readonly window: string;
  readonly runUrl?: string;
  readonly freshness: EvidenceFreshness;
  readonly source: EvidenceSourceName;
}

/** A component's applicability (44.1 hand-off H-12): present only once the judgement carries it (44.1-05). */
export interface EvidenceApplicability {
  readonly class: string;
  readonly reasonText: string;
}

export interface EvidenceComponent {
  readonly component: string;
  readonly responsibility: string;
  readonly state: EvidenceState;
  readonly reasonText: string;
  readonly statement?: string;
  readonly evidence: readonly EvidenceResult[];
  readonly applicability?: EvidenceApplicability;
  /** `not-applicable` for a component the signed applicability map excludes: its source, as-of, freshness and verification do not apply. */
  readonly facts?: 'not-applicable';
}

/** One cell: a control at one level, judged now, with its sources, as-of time, freshness, verification and display state. */
export interface EvidenceRow {
  readonly level: string;
  readonly control: string;
  readonly label: string;
  readonly title: string;
  readonly state: EvidenceState;
  readonly displayState: DisplayState;
  readonly reasonText: string;
  readonly gap?: string;
  readonly textFile?: string;
  readonly components: readonly EvidenceComponent[];
  /** The layer the row belongs to. */
  readonly source: 'release' | 'projection';
  /** The distinct sources of its results. */
  readonly sources: readonly EvidenceSourceName[];
  /** The oldest result time of the row; absent when the row has no evidence. */
  readonly asOf?: string;
  readonly freshness: EvidenceFreshness;
  /** Verified only when a key from configuration vouches for the row's judgement; a Not verified row never counts as Met (D-18). */
  readonly verification: 'verified' | 'not-verified';
}

export interface EvidenceLevel {
  readonly id: string;
  readonly title: string;
  readonly claim: boolean;
}

/**
 * Why the release evidence did not verify (D-18): a file that is missing, extra, a link, the wrong size or changed; an unreadable format;
 * a bad signature or one for other evidence; or a site key in the trust folder that is not your organization's site key.
 */
export type ReleaseDidNotVerifyReason = 'format' | 'field' | 'path' | 'missing' | 'extra' | 'symlink' | 'size' | 'hash' | 'unreadable'
  | 'signature' | 'other-manifest' | 'anchor-mismatch';
/** Why the release evidence is Not verified: no key from configuration, no signature for this release, or a site key the session cannot confirm. */
export type ReleaseNotVerifiedReason = 'no-trust-key' | 'no-signature' | 'anchor-unconfirmed';
/** Which configured key vouches for the release: your organization's site key, or the supplier release key a person mounted (D-17). */
export type EvidenceAnchor = 'organization' | 'supplier';

/** A release layer that checked out: its content is shown, Verified or Not verified. */
export interface ReleaseLayer {
  readonly version: string;
  readonly commit: string;
  /** The release build time: the as-of time of the release layer. */
  readonly asOf: string;
  /** When the backend last checked the trust anchors and the signature. */
  readonly checkedAt: string;
  /** Present when the session clock is earlier than the release build: freshness is Unknown and nothing is Met (D-14). */
  readonly clock?: 'clock-behind-build';
  /** Whether the release folder carries an evidence bundle and a compliance package (48.2-05). */
  readonly bundle: 'included' | 'none';
  readonly package: 'included' | 'none';
  readonly levels: readonly EvidenceLevel[];
  readonly rows: readonly EvidenceRow[];
}

/**
 * The release layer. `none`: the image carries no release evidence. `did-not-verify`: nothing from it is shown, only the reason.
 * `not-verified`: the content is shown, but no configured key vouches for it, so no row counts as Met. `verified`: a configured key does.
 */
export type ReleaseEvidence =
  | { readonly verification: 'none' }
  | { readonly verification: 'did-not-verify'; readonly reason: ReleaseDidNotVerifyReason; readonly file: string }
  | (ReleaseLayer & { readonly verification: 'not-verified'; readonly reason: ReleaseNotVerifiedReason; readonly anchor?: EvidenceAnchor })
  | (ReleaseLayer & { readonly verification: 'verified'; readonly anchor: EvidenceAnchor });

/** One site file's outcome (48.2-06): trust, live, export, rescan, agreements. */
export type SiteFileOutcome =
  | { readonly file: string; readonly verification: 'verified'; readonly signedAt: string; readonly keyVersion?: number }
  | { readonly file: string; readonly verification: 'not-verified'; readonly reason: string; readonly keyVersion?: number }
  | { readonly file: string; readonly verification: 'did-not-verify'; readonly reason: string };

/** The site's freshness policy in force (D-13): your site's, or the release defaults with the reason. */
export interface SitePolicy {
  readonly source: 'site' | 'release-defaults';
  readonly reason?: 'no-site-policy' | 'site-policy-refused';
  /** Values in the site's policy that would have loosened a release default, kept at the default. */
  readonly clamped: readonly string[];
}

/**
 * The site layer (D-04, D-22): `none` when the mount holds no site files; otherwise the trust document's outcome (with the anchor checked
 * against the site key in the session's environment, 48.2-04) and each site file's.
 */
export interface SiteLayer {
  readonly verification: 'none' | 'verified' | 'not-verified' | 'did-not-verify';
  readonly reason?: string;
  readonly site?: string;
  /** The newest signing time of the verified site files. */
  readonly lastUpdate?: string;
  readonly files: readonly SiteFileOutcome[];
  readonly policy: SitePolicy;
  readonly notes: readonly string[];
}

/**
 * The README's mounted public projection (D-26): hash-checked on the host by compliance:refresh, not signed, so Not verified and never
 * counted as passing. `did-not-verify` when its refresh record does not match the dashboard, and then nothing from it is shown.
 */
export type ProjectionLayer =
  | { readonly verification: 'not-verified'; readonly reason: 'host-checked-not-signed'; readonly source: string; readonly commit: string; readonly fetchedAt: string; readonly generatedAt: string; readonly levels: readonly EvidenceLevel[]; readonly rows: readonly EvidenceRow[] }
  | { readonly verification: 'did-not-verify'; readonly reason: 'no-refresh-record' | 'format' };

export interface EvidenceSnapshot {
  /** Bumped whenever the view model differs from the last one the backend computed (D-25). */
  readonly revision: number;
  /** When the backend judged the rows. */
  readonly judgedAt: string;
  readonly release: ReleaseEvidence;
  readonly site: SiteLayer;
  /** Present when the projection is mounted. */
  readonly projection?: ProjectionLayer;
}

/** Official control text from a verified source (48.2-08): only files the source's manifest lists and its dashboard indexes. */
export type ControlTextResult = { readonly kind: 'ready'; readonly source: 'release' | 'projection'; readonly text: unknown } | { readonly kind: 'refused' };

export interface SterlingEvidenceService {
  getEvidence(): Promise<EvidenceSnapshot>;
  /** Resolves at once when the revision is newer than `afterRevision`, otherwise on the next change or after 55 seconds (D-25). */
  waitForEvidence(afterRevision: number): Promise<EvidenceSnapshot>;
  getControlText(file: string): Promise<ControlTextResult>;
}

/** The words the Compliance view shows for release evidence (48.2-UI-SPEC copywriting contract). */
export const RELEASE_EVIDENCE_TEXT = {
  source: 'Release',
  release: 'Release {version}',
  asOf: 'as of {time}',
  verified: 'Verified',
  notVerified: 'Not verified',
  current: 'Current',
  ageing: 'Ageing',
  outOfDate: 'Out of date',
  unknown: 'Unknown',
  noEvidence: 'No evidence',
  noTrustKey: 'Not verified: no key from your organization’s configuration vouches for this release’s evidence, so nothing counts as Met.',
  noSignature: 'Not verified: there is no signature for this release’s evidence, so nothing counts as Met.',
  anchorUnconfirmed: 'Not verified: this session cannot confirm your organization’s site key, so nothing counts as Met. Ask your organization’s administrator.',
  verifiedOrganization: 'Verified with your organization’s site key.',
  verifiedSupplier: 'Verified with the supplier release key mounted on this computer.',
  checkedAt: 'checked {time}',
  clockNote: 'Freshness is Unknown: this computer’s clock is earlier than the release build ({time}).',
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
  signature: 'The signature does not match this release’s evidence.',
  'other-manifest': 'The signature is for different evidence than this release carries.',
  'anchor-mismatch': 'The site key in this session’s evidence settings is not your organization’s site key, the one your site checks every image against. Ask your organization’s administrator.',
};
