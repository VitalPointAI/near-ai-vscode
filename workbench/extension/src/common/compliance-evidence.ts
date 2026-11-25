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
  /** The engine's reason code (for example no-component-applies, 44.1-05). */
  readonly reason?: string;
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
  /** The release vulnerability scan's database build date and its freshness (48.2-05, D-03). */
  readonly scan?: { readonly builtAt: string; readonly freshness: EvidenceFreshness };
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
  /** The newest collection time of your site's live facts. */
  readonly lastCollected?: string;
  /** Your site's verified evidence items by freshness. */
  readonly items?: { readonly current: number; readonly ageing: number; readonly outOfDate: number };
  /** True when your site's newest live fact is out of date (D-21): the collector may have stopped. */
  readonly outOfDate?: boolean;
  /** The live facts' out-of-date threshold in force, in hours. */
  readonly liveOutOfDateHours?: number;
  /** The operator's files (D-23): the export's signing time, the rescan's database build date, the agreements' next review date. */
  readonly exportSignedAt?: string;
  readonly rescanBuiltAt?: string;
  readonly agreementsNextReview?: string;
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
  /** A site (the mount holds site files, or the session has your organization's site key) or a single computer (UI-SPEC P1). */
  readonly setting: 'site' | 'single-computer';
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

// ---- 48.2-10: the Compliance view's words and pure presentation helpers (approved 48.2-UI-SPEC, 2026-11-25) ----
// The browser shows what these give; they decide nothing about state, freshness or verification beyond the paused overlay (D-25).

/** Every sentence and word the Compliance view shows (48.2-UI-SPEC Copywriting Contract). */
export const COMPLIANCE_TEXT = {
  title: 'Compliance',
  lead: 'Live evidence for Sterling Sovereign AI, judged against the time now. Authorization is your organization’s decision.',
  caption: 'Compliance evidence, live',
  actionCheck: 'Check evidence now',
  actionPause: 'Pause live updates',
  actionResume: 'Resume live updates',
  liveConnecting: 'Connecting to live updates',
  liveNow: 'Live · Updated just now',
  liveAge: 'Live · Updated {age}',
  livePaused: 'Live updates paused · Last updated {time}',
  liveHeld: 'Live updates paused by you · Last updated {time}',
  sourcesTitle: 'Evidence sources',
  releaseTitle: 'Release evidence',
  releaseVersion: 'Sterling Sovereign AI {version}',
  releaseDt: { release: 'Release', built: 'Built', verifiedWith: 'Verified with', checked: 'Checked', scan: 'Vulnerability scan', sbom: 'Software list (SBOM)', package: 'Compliance package' },
  anchorSite: 'your organization’s site key',
  anchorSupplier: 'the release key you configured',
  releaseScan: 'database built {time} ({age})',
  releaseSbom: 'included',
  releaseNoPackage: 'not in this release',
  releaseOnlyLine: 'This is the release’s own evidence. Nothing here shows how your site runs it.',
  releaseClockNote: 'Freshness is Unknown: this computer’s clock is earlier than the release build ({time}).',
  releaseNone: 'This workbench carries no release evidence. Images from a release carry their own; a development build does not.',
  releaseNoKey: 'Not verified: no release key is set up on this computer, so no state here is counted as met.',
  releaseNoKeySite: 'Not verified: your site’s trust settings are missing, so no state here is counted as met. Ask your organization’s administrator.',
  releaseNoSignature: 'Not verified: there is no signature for release {version} in the evidence folder, so no state here is counted as met.',
  releaseAnchorUnconfirmed: 'Not verified: this session cannot confirm that the key in its evidence settings is your organization’s site key, because it has no copy of your site key to compare it with, so no state here is counted as met. Ask your organization’s administrator.',
  releaseNoControlEvidence: 'This release carries no control evidence, so no control state can be judged. Its software list (SBOM) and vulnerability scan are shown.',
  commandIntro: 'To verify it, download sterling-release-cosign.pub and sterling-evidence-{version}.sigstore.json from the {version} release, put them in one folder, and start the workbench with that folder mounted read-only:',
  commandAfter: 'Add the last line to your docker run command. Check that the key’s fingerprint matches the one in the {version} release notes. The view checks the folder every 30 seconds, so files added to a mounted folder are picked up without a restart.',
  commandLabel: 'Commands to verify the release evidence',
  copyButton: 'Copy command',
  copyDone: 'Command copied',
  copyRefused: 'Select the text to copy it',
  checksShow: 'Show how this release was checked',
  checksHide: 'Hide how this release was checked',
  checksManifest: 'Release evidence and its signature: checked in this session at {time} with {anchor}.',
  checksImageSite: 'Image signature and signed SBOM: checked by your site’s admission policy when this session started. Not checked again here.',
  checksImageSingle: 'Image signature and signed SBOM: not checked here. Check them before you run the image:',
  checksGithub: 'Installer and compliance package signatures from GitHub: not checked here, because they need a connected computer. Check them there with:',
  siteTitle: 'Your site’s evidence',
  siteDt: { site: 'Site', lastUpdate: 'Last update', items: 'Items', policy: 'Freshness settings', export: 'Site evidence export', rescan: 'Offline rescan', agreements: 'Exchange agreements' },
  siteItems: '{c} current · {a} ageing · {o} out of date',
  sitePolicySite: 'your site’s',
  sitePolicyRelease: 'the release’s defaults',
  sitePolicyMissing: 'Your site’s freshness settings could not be checked, so the release’s defaults apply.',
  sitePolicyClamped: 'Your site set a longer time for {kind} than the release allows, so the release’s time applies.',
  siteExport: 'signed {time}',
  siteRescan: 'database built {time}',
  siteAgreements: 'next review {date}',
  siteAnchorUnconfirmed: 'Not verified: this session cannot confirm the key your site’s evidence is checked with, so no state from it is counted as met. Ask your organization’s administrator.',
  siteKeyVersion: 'Live facts not verified: they are signed with collector key version {n}, which your site’s trust document does not list. No state from them is counted as met. Ask your organization’s administrator.',
  siteNoneSite: 'No site evidence yet. It appears here within about 15 minutes of your site collector’s first run.',
  siteNoneSingle: 'This computer is not part of a site, so there is no site evidence. The release evidence is shown alone.',
  siteOutOfDate: 'Your site’s evidence was last collected {time} ({age}). Live facts are out of date after {threshold}.',
  projectionTitle: 'Published projection',
  projectionDt: { source: 'Source', commit: 'Commit', written: 'Written' },
  projectionSource: 'your copy of the published dashboard',
  projectionNotVerified: 'Not verified: checked on the computer that wrote it, but not signed. Its states are never counted.',
  projectionNoRecord: 'refresh.json does not match dashboard.json, so the published projection cannot be checked.',
  projectionShow: 'Show published projection',
  verification: { verified: 'Verified', 'not-verified': 'Not verified', 'did-not-verify': 'Did not verify' },
  freshness: { current: 'Current', ageing: 'Ageing', 'out-of-date': 'Out of date', unknown: 'Unknown', none: 'No evidence' },
  freshnessPaused: 'Unknown (live updates paused)',
  freshnessHeld: 'Unknown (live updates paused by you)',
  freshnessClock: 'Unknown (this computer’s clock is earlier than the release build)',
  source: { release: 'Release', site: 'Your site', 'reference-site': 'Supplier reference site', projection: 'Published projection' },
  sourceJoin: '{a} and {b}',
  asOf: 'as of {time}',
  countOne: '1 evidence item',
  countMany: '{n} evidence items',
  staleTitle: 'Stale: evidence out of date',
  wouldBe: 'Would be {state} if verified.',
  referenceSite: 'From the supplier’s reference site, not yours.',
  dnv: {
    missing: '{file} is missing from the release evidence.',
    extra: '{file} is in the release evidence but not in its manifest.',
    symlink: '{file} is a link, and the evidence may hold only plain files.',
    size: '{file} is not the size its manifest records.',
    hash: '{file} has changed since the evidence was signed.',
    signature: 'The signature does not match {what}.',
    otherManifest: 'The signature is for different evidence than this release carries.',
    purpose: '{file} is signed by a key that may not sign this kind of evidence.',
    format: '{file} is in a format this release does not read.',
    future: '{file} is dated more than 5 minutes ahead of this computer’s clock.',
    anchorMismatch: 'The site key in this session’s evidence settings is not your organization’s site key, the one your site checks every image against. Ask your organization’s administrator.',
    trust: 'Your site’s trust document did not verify with your organization’s site key.',
    unknownSigner: '{file} is signed by a key your site’s trust document does not name.',
    unreadable: '{file} could not be read.',
    tail: 'Nothing from this source is shown.',
  },
  thisReleaseEvidence: 'this release’s evidence',
  noticeDidNotVerify: '{source} did not verify: {reason} Nothing from it is shown.',
  noticeDidNotVerifyShared: '{sources} did not verify: {reason} Nothing from them is shown.',
  noticePaused: 'Live updates paused: the view lost its connection to the workbench. Freshness shows as Unknown until it is back. Trying again on its own.',
  noticeClock: 'This computer’s clock is earlier than the release build, so no evidence reads current. Ask your organization’s administrator to check the clock.',
  noticeClockSingle: 'This computer’s clock is earlier than the release build, so no evidence reads current. Check this computer’s clock.',
  noticeSiteOutOfDate: 'Your site’s evidence was last collected {time} ({age}), so it is out of date. The site collector may have stopped. Ask your organization’s administrator.',
  sourceName: { release: 'The release evidence', site: 'Your site’s evidence', projection: 'The published projection' },
  attentionTitle: 'Needs attention',
  attention: { 'not-met': 'Not met', 'partly-met': 'Partly met', stale: 'Stale evidence', 'out-of-date': 'Out of date', 'not-verified': 'Not verified' },
  chartStatus: 'Control status',
  chartStatusHint: 'Select a status to filter',
  chartCentre: 'Control entries',
  summaryCaption: 'Summary across levels',
  summaryHint: 'Select a level to filter. Ageing and Out of date count controls by evidence age, so they overlap the other columns.',
  summaryCols: ['Level', 'Controls', 'Met', 'Needs attention', 'Not verified', 'Ageing', 'Out of date'],
  summaryTotal: 'All levels',
  summaryNoClaim: 'No coverage claim',
  filterLevel: 'Coverage level', filterLevelAll: 'All coverage levels',
  filterState: 'Evidence state', filterStateAll: 'All states',
  filterFreshness: 'Freshness', filterFreshnessAll: 'All freshness',
  filterSource: 'Source',
  filterSourceOptions: { layered: 'Release and your site', release: 'From the release', site: 'From your site', 'reference-site': 'From the supplier reference site', projection: 'Published projection' },
  filterSearch: 'Search controls', filterSearchPlaceholder: 'ID or control name',
  filterClear: 'Clear filters',
  filterFreshnessPaused: 'Freshness filter is off while live updates are paused.',
  helpTitle: 'How current each source is',
  helpCols: ['Source', 'As of', 'How it stays current'],
  helpRows: [
    ['Release test results, CI checks and the software list (SBOM)', 'the release build', 'They describe the code this session runs, so they stay current while the session runs this release. Judged again every minute.'],
    ['Release vulnerability scan', 'the scan database’s build date', 'Ageing after 7 days, out of date after 30 days. A site rescan with a newer signed database replaces it.'],
    ['Release documents, statements and gap register', 'each document’s review date', 'Ageing after 335 days, out of date after 365 days.'],
    ['Release signature', 'when this session checked it', 'Checked at start and whenever the trust settings or the release evidence change.'],
    ['Your site’s live facts (alerts, image admission, seal, release record)', 'when each group was collected', 'Collected every 15 minutes, shown here within that time plus about 2 minutes. Out of date after 2 hours.'],
    ['Your site’s evidence export', 'when it was signed', 'Signed at least weekly. Out of date after 7 days.'],
    ['Your site’s offline rescan', 'the signed database’s build date', 'As the release vulnerability scan.'],
    ['Your site’s exchange agreements', 'each agreement’s review date', 'As documents.'],
  ],
  controlsTitle: 'Controls',
  controlsCount: '{shown} of {total} control entries',
  controlsMore: 'Show more controls',
  controlsNoMatch: 'No controls match these filters.',
  controlsNoneVerified: 'No controls to show: no evidence source verified.',
  controlsNoControlEvidence: 'No controls to show: this release carries no control evidence. Its software list and vulnerability scan are on the release card.',
  controlsNoEvidence: 'No controls to show: this workbench carries no evidence.',
  statusLoading: 'Loading evidence…',
  errorLoad: 'The evidence could not be loaded. Select Check evidence now to try again.',
  detailClose: 'Close details',
  detailNoLongerMatches: 'This control no longer matches your filters.',
  detailDt: { source: 'Source', asOf: 'As of', freshness: 'Freshness', verification: 'Verification', evidence: 'Evidence' },
  detailEvidence: 'Evidence',
  detailNoEvidence: 'No evidence for this component.',
  detailNoStatements: 'No product statements or evidence for this control.',
  detailOfficial: 'Official control text',
  detailOfficialLoading: 'Loading official text…',
  detailOfficialMissing: 'Official text is not in the verified evidence.',
  detailPassed: 'Passed',
  detailNotPassed: 'Did not pass',
  detailResponsibility: 'Responsibility: {words}',
  detailDetailsFor: 'Details for {label}',
  french: 'Français',
  ciRun: 'CI run',
  applicabilityLabel: 'Applicability: {words}',
  applicability: { implements: 'Carries out this control', supports: 'Supports this control', 'not-applicable': 'Not applicable to this component' } as Readonly<Record<string, string>>,
  applicabilityUnreviewed: 'Marked as having no part in this control, but your organization has not signed off this level’s applicability map yet, so it counts as not met.',
  applicabilityFactsNone: 'Source, as-of time, freshness and verification do not apply: this component has no part in this control.',
  applicabilityNoComponentApplies: 'No component in this level has a part in this control, so it is your organization’s responsibility.',
  announceSourceChanged: '{source} is now {verification}.',
  announceChangedOne: 'Evidence updated: 1 control changed.',
  announceChangedMany: 'Evidence updated: {n} controls changed.',
  announcePaused: 'Live updates paused.',
  announceHeld: 'Live updates paused by you.',
  announceResumed: 'Live updates resumed.',
  announceDidNotVerify: '{source} did not verify.',
  announceCopied: 'Command copied.',
  stateWords: { met: 'Met', 'partly-met': 'Partly met', 'not-met': 'Not met', stale: 'Stale', 'not-verified': 'Not verified', 'not-applicable': 'Not applicable', 'your-organizations-responsibility': 'Your organization’s responsibility' },
  responsibilityWords: { product: 'Product', shared: 'Shared', 'your-organization': 'Your organization', inherited: 'Inherited', 'not-applicable': 'Not applicable' } as Readonly<Record<string, string>>,
  kindWords: { head: 'release test results', audit: 'audits', settings: 'settings checks', harness: 'harness scans', document: 'documents', attestation: 'signed records', vulnerability: 'vulnerability scans', live: 'live site facts' } as Readonly<Record<string, string>>,
  minuteAgo: '1 minute ago', minutesAgo: '{n} minutes ago', hourAgo: '1 hour ago', hoursAgo: '{n} hours ago', daysAgo: '{n} days ago', justNow: 'just now',
  hours: '{n} hours', days: '{n} days',
} as const;

/** The commands of the single-computer block (UI-SPEC S4; 48.2-15 keeps workbench/README.md the same). */
export const RELEASE_VERIFY_COMMAND = [
  'mkdir -p sterling-evidence',
  'cp sterling-release-cosign.pub sterling-evidence/supplier.pub',
  'cp sterling-evidence-{version}.sigstore.json sterling-evidence/release-{version}.sigstore.json',
  '--mount "type=bind,source=$PWD/sterling-evidence,target=/etc/sterling/evidence,readonly"',
] as const;
/** The image check commands, shown only inside the release checks disclosure (UI-SPEC P5); `{image}` is the release image reference. */
export const IMAGE_CHECK_COMMAND = [
  'cosign verify --key sterling-release-cosign.pub --insecure-ignore-tlog {image}',
  'cosign verify-attestation --key sterling-release-cosign.pub --type cyclonedx --insecure-ignore-tlog {image}',
] as const;
/** The GitHub signature check command, shown only inside the release checks disclosure (G476). */
export const GITHUB_CHECK_COMMAND = ['gh attestation verify {file} --repo VitalPointAI/near-ai-vscode'] as const;

/** How the view is reading: live, paused because the connection was lost, or held by the person (D-25). */
export type PauseState = 'live' | 'lost' | 'held';
export interface ViewContext {
  readonly now: number;
  readonly pause: PauseState;
  /** The time zone times are written in; the browser's own unless a test fixes one. */
  readonly timeZone?: string;
  /** True when the release layer says the clock is earlier than the release build. */
  readonly clock?: boolean;
}
export type SourceFilter = 'layered' | 'release' | 'site' | 'reference-site' | 'projection';
export interface ViewFilters {
  readonly level: string;
  readonly state: string;
  readonly freshness: string;
  readonly source: SourceFilter;
  readonly query: string;
}
export interface ViewState {
  readonly filters: ViewFilters;
  /** `{level}/{control}` of the open detail pane. */
  readonly openKey?: string;
  readonly shown: number;
}
export interface Fact { readonly icon?: string; readonly words: string; readonly datetime?: string }
export interface CellFacts {
  readonly source: Fact;
  readonly asOf?: Fact;
  readonly freshness: Fact & { readonly value: EvidenceFreshness };
  readonly verification: Fact & { readonly value: 'verified' | 'not-verified' };
  readonly count?: Fact;
  /** The row's accessible name, starting with its visible line 1 (WCAG 2.5.3). */
  readonly label: string;
  readonly noComponentApplies?: string;
}
export interface Card {
  readonly layer: 'release' | 'site' | 'projection';
  readonly title: string;
  readonly icon: string;
  readonly badge?: { readonly verification: 'verified' | 'not-verified' | 'did-not-verify'; readonly icon: string; readonly words: string };
  readonly facts: readonly { readonly dt: string; readonly dd: string; readonly datetime?: string; readonly mono?: boolean }[];
  readonly messages: readonly string[];
  /** The single-computer command block (S4). */
  readonly command?: { readonly intro: string; readonly lines: readonly string[]; readonly after: string };
  /** The release-only line under the cards when there is no site layer (S2). */
  readonly onlyLine?: string;
  /** The lines of the release checks disclosure. */
  readonly checks?: readonly { readonly text: string; readonly command?: readonly string[] }[];
}
export interface Notice { readonly tone: 'error' | 'warning'; readonly text: string }

const fill = (template: string, values: Readonly<Record<string, string | number>>): string =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => (Object.hasOwn(values, key) ? String(values[key]) : match));

/** "25 Nov 2026 14:02 UTC": day, short month, year, 24-hour time and zone, whatever the browser's locale (UI-SPEC "Times"). */
export function formatTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short', ...(timeZone ? { timeZone } : {}) })
    .formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.day} ${String(parts.month).replace(/\.$/, '')} ${parts.year} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}
/** "25 Nov 2026" for a date-only value. */
export function formatDate(iso: string, timeZone?: string): string {
  return formatTime(iso, timeZone).split(' ').slice(0, 3).join(' ');
}
/** Plain age words: "just now", "2 minutes ago", "3 hours ago", "8 days ago". */
export function ageWords(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes) || minutes < 1) return COMPLIANCE_TEXT.justNow;
  if (minutes < 60) return minutes === 1 ? COMPLIANCE_TEXT.minuteAgo : fill(COMPLIANCE_TEXT.minutesAgo, { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? COMPLIANCE_TEXT.hourAgo : fill(COMPLIANCE_TEXT.hoursAgo, { n: hours });
  return fill(COMPLIANCE_TEXT.daysAgo, { n: Math.floor(hours / 24) });
}
const timeWithAge = (iso: string, context: ViewContext): string => `${formatTime(iso, context.timeZone)} (${ageWords(iso, context.now)})`;

const FRESHNESS_ICONS: Readonly<Record<EvidenceFreshness, string>> = { current: 'pulse', ageing: 'clock', 'out-of-date': 'history', unknown: 'question', none: 'circle-slash' };
const SOURCE_ICONS: Readonly<Record<EvidenceSourceName, string>> = { release: 'package', site: 'server', 'reference-site': 'references', projection: 'file' };
const VERIFICATION_ICONS = { verified: 'verified-filled', 'not-verified': 'unverified', 'did-not-verify': 'error' } as const;

/** A freshness as shown: Unknown with its reason while paused or when the clock is behind the release build. */
export function freshnessFact(freshness: EvidenceFreshness, context: ViewContext): Fact & { readonly value: EvidenceFreshness } {
  if (context.pause !== 'live' && freshness !== 'none') return { value: 'unknown', icon: 'question', words: context.pause === 'lost' ? COMPLIANCE_TEXT.freshnessPaused : COMPLIANCE_TEXT.freshnessHeld };
  if (freshness === 'unknown' && context.clock) return { value: 'unknown', icon: 'question', words: COMPLIANCE_TEXT.freshnessClock };
  return { value: freshness, icon: FRESHNESS_ICONS[freshness], words: COMPLIANCE_TEXT.freshness[freshness] };
}
/** Source words for one or more sources: "Release", "Release and your site". */
export function sourceWords(sources: readonly EvidenceSourceName[], fallback: EvidenceSourceName): string {
  const words = (sources.length ? sources : [fallback]).map((source, index) => {
    const word = COMPLIANCE_TEXT.source[source];
    return index === 0 ? word : word.charAt(0).toLowerCase() + word.slice(1);
  });
  if (words.length <= 2) return words.length === 1 ? words[0]! : fill(COMPLIANCE_TEXT.sourceJoin, { a: words[0]!, b: words[1]! });
  return fill(COMPLIANCE_TEXT.sourceJoin, { a: words.slice(0, -1).join(', '), b: words[words.length - 1]! });
}
const counted = (row: EvidenceRow): number => row.components.filter(({ facts }) => facts !== 'not-applicable').reduce((sum, { evidence }) => sum + evidence.length, 0);

/** A cell's five facts and its accessible name (UI-SPEC "Control row anatomy"). */
export function cellFacts(row: EvidenceRow, context: ViewContext): CellFacts {
  const fallback: EvidenceSourceName = row.source === 'projection' ? 'projection' : 'release';
  const source: Fact = { icon: SOURCE_ICONS[row.sources[0] ?? fallback], words: sourceWords(row.sources, fallback) };
  const asOf = row.asOf ? { icon: undefined, words: fill(COMPLIANCE_TEXT.asOf, { time: formatTime(row.asOf, context.timeZone) }), datetime: row.asOf } : undefined;
  const freshness = freshnessFact(row.freshness, context);
  const verification = { value: row.verification, icon: VERIFICATION_ICONS[row.verification], words: COMPLIANCE_TEXT.verification[row.verification] };
  const n = counted(row);
  const count = n === 0 || row.freshness === 'none' ? undefined : { icon: 'checklist', words: n === 1 ? COMPLIANCE_TEXT.countOne : fill(COMPLIANCE_TEXT.countMany, { n }) };
  const label = [`${row.label} · ${row.title}.`, `${COMPLIANCE_TEXT.stateWords[row.displayState]}.`, `Source: ${source.words}.`,
    ...(row.asOf ? [`As of ${formatTime(row.asOf, context.timeZone)}.`] : []), `Freshness: ${freshness.words}.`, `${verification.words}.`, ...(count ? [`${count.words}.`] : [])].join(' ');
  return { source, ...(asOf ? { asOf } : {}), freshness, verification, ...(count ? { count } : {}), label,
    ...(row.reason === 'no-component-applies' ? { noComponentApplies: COMPLIANCE_TEXT.applicabilityNoComponentApplies } : {}) };
}

/** A component's applicability lines (44.1 hand-off H-13): its words, the engine's reason, and whether its four facts apply. */
export function componentLines(component: EvidenceComponent): { readonly applicability?: string; readonly reason?: string; readonly factsNone?: string; readonly showFacts: boolean } {
  const applicability = component.applicability;
  if (!applicability) return { showFacts: true };
  const words = COMPLIANCE_TEXT.applicability[applicability.class] ?? applicability.class;
  const label = fill(COMPLIANCE_TEXT.applicabilityLabel, { words });
  if (component.facts === 'not-applicable') return { applicability: label, reason: applicability.reasonText || component.reasonText, factsNone: COMPLIANCE_TEXT.applicabilityFactsNone, showFacts: false };
  if (applicability.class === 'not-applicable') return { applicability: label, reason: COMPLIANCE_TEXT.applicabilityUnreviewed, showFacts: true };
  return { applicability: label, showFacts: true };
}

/** Counts by display state: Met counts only Verified cells (D-18, T-48.2-25). */
export function displayCounts(rows: readonly EvidenceRow[]): Record<DisplayState, number> {
  const counts: Record<DisplayState, number> = { met: 0, 'partly-met': 0, 'not-met': 0, stale: 0, 'not-verified': 0, 'not-applicable': 0, 'your-organizations-responsibility': 0 };
  for (const row of rows) counts[row.displayState] += 1;
  return counts;
}
/** The Needs attention counts; Out of date is hidden (undefined) while paused, because freshness is Unknown then. */
export function attentionCounts(rows: readonly EvidenceRow[], context: ViewContext): Readonly<Record<'not-met' | 'partly-met' | 'stale' | 'not-verified', number>> & { readonly 'out-of-date'?: number } {
  const counts = displayCounts(rows);
  const result: Record<string, number> = { 'not-met': counts['not-met'], 'partly-met': counts['partly-met'], stale: counts.stale };
  if (context.pause === 'live') result['out-of-date'] = rows.filter(({ freshness }) => freshness === 'out-of-date').length;
  result['not-verified'] = counts['not-verified'];
  return result as never;
}

/** The cells the view lists: the release layer's (layered with your site's), or the projection's on its Source option or with no release. */
export function viewCells(snapshot: EvidenceSnapshot, source: SourceFilter): readonly EvidenceRow[] {
  const release = snapshot.release;
  const releaseRows = release.verification === 'verified' || release.verification === 'not-verified' ? release.rows : undefined;
  const projectionRows = snapshot.projection?.verification === 'not-verified' ? snapshot.projection.rows : undefined;
  if (source === 'projection' || (release.verification === 'none' && projectionRows)) return projectionRows ?? [];
  return releaseRows ?? [];
}
/** The listed cells after the filters; the Freshness filter is not applied while paused. */
export function filterCells(rows: readonly EvidenceRow[], filters: ViewFilters, context: ViewContext): readonly EvidenceRow[] {
  const query = filters.query.trim().toLowerCase();
  return rows.filter((row) => (!filters.level || row.level === filters.level)
    && (!filters.state || row.displayState === filters.state)
    && (context.pause !== 'live' || !filters.freshness || row.freshness === filters.freshness)
    && (filters.source === 'layered' || filters.source === 'projection' || row.sources.includes(filters.source))
    && (!query || `${row.control} ${row.label} ${row.title}`.toLowerCase().includes(query)));
}
/** The view state after a new revision: filters and the page count stay; the open detail stays while its cell still exists. */
export function nextViewState(state: ViewState, snapshot: EvidenceSnapshot): ViewState {
  const rows = viewCells(snapshot, state.filters.source);
  const keep = state.openKey !== undefined && rows.some((row) => `${row.level}/${row.control}` === state.openKey);
  return { filters: state.filters, shown: state.shown, openKey: keep ? state.openKey : undefined };
}

const DNV_KEYS: Readonly<Record<string, keyof typeof COMPLIANCE_TEXT.dnv>> = {
  missing: 'missing', extra: 'extra', symlink: 'symlink', size: 'size', hash: 'hash', signature: 'signature', 'other-manifest': 'otherManifest', 'wrong-purpose': 'purpose',
  format: 'format', field: 'format', path: 'format', 'future-dated': 'future', 'anchor-mismatch': 'anchorMismatch', 'trust-signature': 'trust', 'unknown-signer': 'unknownSigner',
  unreadable: 'unreadable', 'too-large': 'size',
};
/** One plain sentence for a Did not verify reason code (UI-SPEC `dnv.*`). */
export function didNotVerifySentence(reason: string, file?: string): string {
  const key = DNV_KEYS[reason] ?? 'format';
  return fill(COMPLIANCE_TEXT.dnv[key], { file: file ?? 'trust.json', what: file && reason === 'signature' && !file.startsWith('release-') ? file : COMPLIANCE_TEXT.thisReleaseEvidence });
}

const badge = (verification: 'verified' | 'not-verified' | 'did-not-verify') => ({ verification, icon: VERIFICATION_ICONS[verification], words: COMPLIANCE_TEXT.verification[verification] });
const noSiteLayer = (snapshot: EvidenceSnapshot): boolean => snapshot.site.verification === 'none';

/** The release evidence card (UI-SPEC "Source card anatomy"). */
export function releaseCard(snapshot: EvidenceSnapshot, context: ViewContext): Card {
  const release = snapshot.release;
  const base = { layer: 'release' as const, title: COMPLIANCE_TEXT.releaseTitle, icon: 'package' };
  if (release.verification === 'none') return { ...base, facts: [], messages: [COMPLIANCE_TEXT.releaseNone] };
  if (release.verification === 'did-not-verify') return { ...base, badge: badge('did-not-verify'), facts: [], messages: [didNotVerifySentence(release.reason, release.file), COMPLIANCE_TEXT.dnv.tail] };
  const facts: { dt: string; dd: string; datetime?: string }[] = [
    { dt: COMPLIANCE_TEXT.releaseDt.release, dd: fill(COMPLIANCE_TEXT.releaseVersion, { version: release.version }) },
    { dt: COMPLIANCE_TEXT.releaseDt.built, dd: formatTime(release.asOf, context.timeZone), datetime: release.asOf },
  ];
  if (release.verification === 'verified') facts.push({ dt: COMPLIANCE_TEXT.releaseDt.verifiedWith, dd: release.anchor === 'organization' ? COMPLIANCE_TEXT.anchorSite : COMPLIANCE_TEXT.anchorSupplier });
  facts.push({ dt: COMPLIANCE_TEXT.releaseDt.checked, dd: formatTime(release.checkedAt, context.timeZone), datetime: release.checkedAt });
  if (release.scan) {
    const freshness = freshnessFact(release.scan.freshness, { ...context, clock: release.clock === 'clock-behind-build' });
    facts.push({ dt: COMPLIANCE_TEXT.releaseDt.scan, dd: `${fill(COMPLIANCE_TEXT.releaseScan, { time: formatTime(release.scan.builtAt, context.timeZone), age: ageWords(release.scan.builtAt, context.now) })} · ${freshness.words}`, datetime: release.scan.builtAt });
  }
  facts.push({ dt: COMPLIANCE_TEXT.releaseDt.sbom, dd: COMPLIANCE_TEXT.releaseSbom });
  if (release.package === 'none') facts.push({ dt: COMPLIANCE_TEXT.releaseDt.package, dd: COMPLIANCE_TEXT.releaseNoPackage });
  const messages: string[] = [];
  let command: Card['command'];
  if (release.verification === 'not-verified') {
    if (release.reason === 'no-trust-key') {
      messages.push(snapshot.setting === 'single-computer' ? COMPLIANCE_TEXT.releaseNoKey : COMPLIANCE_TEXT.releaseNoKeySite);
      if (snapshot.setting === 'single-computer') {
        command = { intro: fill(COMPLIANCE_TEXT.commandIntro, { version: release.version }), lines: RELEASE_VERIFY_COMMAND.map((line) => fill(line, { version: release.version })), after: fill(COMPLIANCE_TEXT.commandAfter, { version: release.version }) };
      }
    } else if (release.reason === 'no-signature') messages.push(fill(COMPLIANCE_TEXT.releaseNoSignature, { version: release.version }));
    else messages.push(COMPLIANCE_TEXT.releaseAnchorUnconfirmed);
  }
  if (release.bundle === 'none') messages.push(COMPLIANCE_TEXT.releaseNoControlEvidence);
  if (release.clock === 'clock-behind-build') messages.push(fill(COMPLIANCE_TEXT.releaseClockNote, { time: formatTime(release.asOf, context.timeZone) }));
  const anchorWords = release.verification === 'verified' ? (release.anchor === 'organization' ? COMPLIANCE_TEXT.anchorSite : COMPLIANCE_TEXT.anchorSupplier) : undefined;
  const checks = [
    ...(anchorWords ? [{ text: fill(COMPLIANCE_TEXT.checksManifest, { time: formatTime(release.checkedAt, context.timeZone), anchor: anchorWords }) }] : []),
    snapshot.setting === 'site' ? { text: COMPLIANCE_TEXT.checksImageSite } : { text: COMPLIANCE_TEXT.checksImageSingle, command: IMAGE_CHECK_COMMAND.map((line) => fill(line, { image: '<image reference>' })) },
    { text: COMPLIANCE_TEXT.checksGithub, command: GITHUB_CHECK_COMMAND.map((line) => fill(line, { file: '<file>' })) },
  ];
  return { ...base, badge: badge(release.verification), facts, messages, ...(command ? { command } : {}), checks,
    ...(noSiteLayer(snapshot) ? { onlyLine: COMPLIANCE_TEXT.releaseOnlyLine } : {}) };
}

const thresholdWords = (hours: number): string => (hours < 48 ? fill(COMPLIANCE_TEXT.hours, { n: hours }) : fill(COMPLIANCE_TEXT.days, { n: Math.round(hours / 24) }));

/** Your site's evidence card (UI-SPEC "Source card anatomy", S2, S5, S6b to S6e). */
export function siteCard(snapshot: EvidenceSnapshot, context: ViewContext): Card {
  const site = snapshot.site;
  const base = { layer: 'site' as const, title: COMPLIANCE_TEXT.siteTitle, icon: 'server' };
  if (site.verification === 'none') return { ...base, facts: [], messages: [snapshot.setting === 'single-computer' ? COMPLIANCE_TEXT.siteNoneSingle : COMPLIANCE_TEXT.siteNoneSite] };
  if (site.verification === 'did-not-verify') return { ...base, badge: badge('did-not-verify'), facts: [], messages: [didNotVerifySentence(site.reason ?? 'trust-signature'), COMPLIANCE_TEXT.dnv.tail] };
  if (site.verification === 'not-verified') {
    return { ...base, badge: badge('not-verified'), facts: [], messages: [site.reason === 'anchor-unconfirmed' ? COMPLIANCE_TEXT.siteAnchorUnconfirmed : COMPLIANCE_TEXT.releaseNoKeySite] };
  }
  const facts: { dt: string; dd: string; datetime?: string }[] = [];
  if (site.site) facts.push({ dt: COMPLIANCE_TEXT.siteDt.site, dd: site.site });
  if (site.lastUpdate) facts.push({ dt: COMPLIANCE_TEXT.siteDt.lastUpdate, dd: timeWithAge(site.lastUpdate, context), datetime: site.lastUpdate });
  if (site.items) {
    facts.push({ dt: COMPLIANCE_TEXT.siteDt.items, dd: context.pause === 'live'
      ? fill(COMPLIANCE_TEXT.siteItems, { c: site.items.current, a: site.items.ageing, o: site.items.outOfDate })
      : context.pause === 'lost' ? COMPLIANCE_TEXT.freshnessPaused : COMPLIANCE_TEXT.freshnessHeld });
  }
  facts.push({ dt: COMPLIANCE_TEXT.siteDt.policy, dd: site.policy.source === 'site' ? COMPLIANCE_TEXT.sitePolicySite : COMPLIANCE_TEXT.sitePolicyRelease });
  if (site.exportSignedAt) facts.push({ dt: COMPLIANCE_TEXT.siteDt.export, dd: fill(COMPLIANCE_TEXT.siteExport, { time: formatTime(site.exportSignedAt, context.timeZone) }), datetime: site.exportSignedAt });
  if (site.rescanBuiltAt) facts.push({ dt: COMPLIANCE_TEXT.siteDt.rescan, dd: fill(COMPLIANCE_TEXT.siteRescan, { time: formatTime(site.rescanBuiltAt, context.timeZone) }), datetime: site.rescanBuiltAt });
  if (site.agreementsNextReview) facts.push({ dt: COMPLIANCE_TEXT.siteDt.agreements, dd: fill(COMPLIANCE_TEXT.siteAgreements, { date: formatDate(site.agreementsNextReview, context.timeZone) }), datetime: site.agreementsNextReview });
  const messages: string[] = [];
  let worst: 'verified' | 'not-verified' = 'verified';
  for (const file of site.files) {
    if (file.file === 'trust' || file.verification === 'verified') continue;
    if (file.verification === 'not-verified') worst = 'not-verified';
    if (file.verification === 'not-verified' && file.reason === 'key-version-not-listed') messages.push(fill(COMPLIANCE_TEXT.siteKeyVersion, { n: file.keyVersion ?? '?' }));
    else if (file.verification === 'did-not-verify') messages.push(didNotVerifySentence(file.reason, `${file.file}.json`));
  }
  if (site.outOfDate && site.lastCollected) messages.push(fill(COMPLIANCE_TEXT.siteOutOfDate, { time: formatTime(site.lastCollected, context.timeZone), age: ageWords(site.lastCollected, context.now), threshold: thresholdWords(site.liveOutOfDateHours ?? 2) }));
  if (site.policy.reason === 'site-policy-refused') messages.push(COMPLIANCE_TEXT.sitePolicyMissing);
  for (const clamped of site.policy.clamped) messages.push(fill(COMPLIANCE_TEXT.sitePolicyClamped, { kind: COMPLIANCE_TEXT.kindWords[clamped.split('.')[0]!] ?? clamped }));
  return { ...base, badge: badge(worst), facts, messages };
}

/** The published projection's card (UI-SPEC S9), when it is mounted. */
export function projectionCard(snapshot: EvidenceSnapshot, context: ViewContext): Card | undefined {
  const projection = snapshot.projection;
  if (!projection) return undefined;
  const base = { layer: 'projection' as const, title: COMPLIANCE_TEXT.projectionTitle, icon: 'file' };
  if (projection.verification === 'did-not-verify') {
    return { ...base, badge: badge('did-not-verify'), facts: [], messages: [projection.reason === 'no-refresh-record' ? COMPLIANCE_TEXT.projectionNoRecord : didNotVerifySentence('format', 'dashboard.json'), COMPLIANCE_TEXT.dnv.tail] };
  }
  return { ...base, badge: badge('not-verified'), facts: [
    { dt: COMPLIANCE_TEXT.projectionDt.source, dd: COMPLIANCE_TEXT.projectionSource },
    { dt: COMPLIANCE_TEXT.projectionDt.commit, dd: projection.commit.slice(0, 12), mono: true },
    { dt: COMPLIANCE_TEXT.projectionDt.written, dd: formatTime(projection.fetchedAt, context.timeZone), datetime: projection.fetchedAt },
  ], messages: [COMPLIANCE_TEXT.projectionNotVerified] };
}

const lowerFirst = (text: string): string => (/^(The|Your) /.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text);

/** The page notices in the UI-SPEC's fixed order: Did not verify (shared by cause), paused, clock, your site's evidence out of date. */
export function notices(snapshot: EvidenceSnapshot, context: ViewContext): Notice[] {
  const failures: { source: 'release' | 'site' | 'projection'; reason: string; sentence: string }[] = [];
  const release = snapshot.release;
  if (release.verification === 'did-not-verify') failures.push({ source: 'release', reason: release.reason, sentence: didNotVerifySentence(release.reason, release.file) });
  if (snapshot.site.verification === 'did-not-verify') failures.push({ source: 'site', reason: snapshot.site.reason ?? 'trust-signature', sentence: didNotVerifySentence(snapshot.site.reason ?? 'trust-signature') });
  if (snapshot.projection?.verification === 'did-not-verify') failures.push({ source: 'projection', reason: snapshot.projection.reason, sentence: snapshot.projection.reason === 'no-refresh-record' ? COMPLIANCE_TEXT.projectionNoRecord : didNotVerifySentence('format', 'dashboard.json') });
  const result: Notice[] = [];
  const byReason = new Map<string, typeof failures>();
  for (const failure of failures) byReason.set(failure.reason, [...(byReason.get(failure.reason) ?? []), failure]);
  for (const group of byReason.values()) {
    const names = group.map(({ source }, index) => (index === 0 ? COMPLIANCE_TEXT.sourceName[source] : lowerFirst(COMPLIANCE_TEXT.sourceName[source])));
    const reason = lowerFirst(group[0]!.sentence);
    result.push({ tone: 'error', text: group.length === 1
      ? fill(COMPLIANCE_TEXT.noticeDidNotVerify, { source: names[0]!, reason })
      : fill(COMPLIANCE_TEXT.noticeDidNotVerifyShared, { sources: names.join(' and '), reason }) });
  }
  if (context.pause === 'lost') result.push({ tone: 'warning', text: COMPLIANCE_TEXT.noticePaused });
  const someVerified = release.verification === 'verified' || release.verification === 'not-verified';
  if (someVerified && release.clock === 'clock-behind-build') result.push({ tone: 'warning', text: snapshot.setting === 'single-computer' ? COMPLIANCE_TEXT.noticeClockSingle : COMPLIANCE_TEXT.noticeClock });
  const site = snapshot.site;
  if (site.verification === 'verified' && site.outOfDate && site.lastCollected) result.push({ tone: 'warning', text: fill(COMPLIANCE_TEXT.noticeSiteOutOfDate, { time: formatTime(site.lastCollected, context.timeZone), age: ageWords(site.lastCollected, context.now) }) });
  return result;
}

/** What a new revision changed that the person can see, for the polite region; undefined when nothing visible changed. */
export function changeAnnouncement(previous: EvidenceSnapshot, next: EvidenceSnapshot): string | undefined {
  const lines: string[] = [];
  const pairs: ['release' | 'site', string, string][] = [['release', previous.release.verification, next.release.verification], ['site', previous.site.verification, next.site.verification]];
  for (const [source, before, after] of pairs) {
    if (before === after || after === 'none') continue;
    lines.push(after === 'did-not-verify' ? fill(COMPLIANCE_TEXT.announceDidNotVerify, { source: COMPLIANCE_TEXT.sourceName[source] })
      : fill(COMPLIANCE_TEXT.announceSourceChanged, { source: COMPLIANCE_TEXT.sourceName[source], verification: COMPLIANCE_TEXT.verification[after as 'verified' | 'not-verified'] }));
  }
  const key = (row: EvidenceRow) => `${row.level}/${row.control}`;
  const before = new Map(viewCells(previous, 'layered').map((row) => [key(row), `${row.displayState}|${row.freshness}|${row.verification}`]));
  const changed = viewCells(next, 'layered').filter((row) => before.has(key(row)) && before.get(key(row)) !== `${row.displayState}|${row.freshness}|${row.verification}`).length;
  if (changed > 0) lines.push(changed === 1 ? COMPLIANCE_TEXT.announceChangedOne : fill(COMPLIANCE_TEXT.announceChangedMany, { n: changed }));
  return lines.length ? lines.join(' ') : undefined;
}
export { fill as fillText };
