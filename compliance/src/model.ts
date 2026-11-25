// The shared contract of the compliance package (Phase 44, plan 44-01). Every later plan imports these names; they are never renamed, and later
// plans only append. No input type here has a status, state or met field: a State is produced by computeStatus (status.ts) and nothing else.

/** The `ns` of every prop this project adds to an OSCAL document. The standard OSCAL props `label` and `sort-id` carry no `ns`. */
export const NS = 'urn:near-ai-vscode:compliance';

/** The OSCAL version stamped into every document we generate (D-43). Vendored documents may carry a later 1.2 patch version. */
export const OSCAL_VERSION = '1.2.1';

/** The six states (D-05). */
export const STATES = ['met', 'partly-met', 'not-met', 'stale', 'not-applicable', 'your-organizations-responsibility'] as const;
export type State = (typeof STATES)[number];

/** The words shown for each state (D-05). */
export const STATE_WORDS: Readonly<Record<State, string>> = Object.freeze({
  'met': 'Met',
  'partly-met': 'Partly met',
  'not-met': 'Not met',
  'stale': 'Stale',
  'not-applicable': 'Not applicable',
  'your-organizations-responsibility': "Your organization's responsibility"
});

/** Who carries a control for a component (DESIGN section 7). A responsibility is never a state. */
export const RESPONSIBILITIES = ['product', 'shared', 'your-organization', 'inherited', 'not-applicable'] as const;
export type Responsibility = (typeof RESPONSIBILITIES)[number];

/**
 * Every reason a state can carry, each with one plain sentence. Templates may hold `{date}`, `{reason}`, `{text}`, `{question}` or `{provider}`,
 * filled from StatusOutcome.detail. The words say what evidence shows and that your organization decides; they never claim compliance (D-05).
 */
export const REASONS = Object.freeze({
  'met': 'Evidence shows every statement for this control backed by passing, current results. Your organization decides whether that is enough.',
  'no-statement': 'No statement yet: the product does not yet describe how it supports this control.',
  'no-rules': 'A statement exists, but no evidence rule ties it to a test or a check yet.',
  'missing-result': 'An evidence rule has no result yet, so evidence does not show this control.',
  'test-missing-file': 'The mapped test file is no longer in the repository.',
  'test-missing-name': 'The mapped test is no longer in its test file.',
  'test-skipped': 'The mapped test was skipped in the last run.',
  'test-todo': 'The mapped test is marked as still to do.',
  'test-failed': 'The mapped test failed in the last run.',
  'test-not-run': 'The mapped test did not run in the last report.',
  'observation-failed': 'The last check of this evidence did not pass.',
  'stale': 'Evidence passed, but the oldest result, from {date}, is outside its freshness window, so it counts as not met.',
  'your-organization': 'Your organization decides and carries out this control; the product supplies no evidence for it.',
  'inherited': 'This control is inherited from {provider}; your organization decides whether that is enough.',
  'not-applicable': 'Not applicable: {reason}',
  'not-applicable-unreviewed': 'Marked not applicable without a reviewed tailoring record, so it counts as not met.',
  'partly-statements': 'Evidence shows some statements for this control, but not all of them.',
  'limitation': 'Evidence shows the statement, with a known limitation: {text}',
  'unsettled': 'This depends on an unsettled question, so evidence cannot show it yet: {question}',
  'self-signed': "This needs an official's signature; a self-signed decision counts as not met.",
  'risk-accepted': 'Not met. A named person accepted the risk until {date}.',
  'appliance-only': 'Only the appliance can provide this; the extension and its services make no claim for it.'
} as const);
export type ReasonCode = keyof typeof REASONS;

/** The placeholders a REASONS template may hold. */
export type ReasonPlaceholder = 'date' | 'reason' | 'text' | 'question' | 'provider';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Freshness windows (D-09). `head` means the result must come from the commit being judged (the current main head or the release tag); every
 * other window is the most a result may age, in milliseconds, before it is Stale.
 */
export const FRESHNESS = Object.freeze({
  head: 'head',
  audit: 24 * HOUR_MS,
  settings: 7 * DAY_MS,
  harness: 30 * DAY_MS,
  document: 365 * DAY_MS,
  attestation: 365 * DAY_MS,
  // 48.2-03 (D-13): a vulnerability scan ages from its database build date; live site facts from their collection time.
  vulnerability: 30 * DAY_MS,
  live: 2 * HOUR_MS
} as const);
export type WindowKind = keyof typeof FRESHNESS;

/**
 * When evidence starts Ageing (48.2-03, D-12, D-13): past this age a result is Ageing, and past its FRESHNESS window it is Out of date, which
 * is exactly Stale. `head` evidence has no ageing: it is about the commit being judged.
 */
export const AGEING: Readonly<Record<Exclude<WindowKind, 'head'>, number>> = Object.freeze({
  audit: 18 * HOUR_MS,
  settings: 5 * DAY_MS,
  harness: 23 * DAY_MS,
  document: 335 * DAY_MS,
  attestation: 335 * DAY_MS,
  vulnerability: 7 * DAY_MS,
  live: 30 * 60 * 1000
});

/** The out-of-date window of each kind in force: FRESHNESS, or a site policy's tighter values (judgement.ts effectivePolicy). */
export type FreshnessWindows = Readonly<Partial<Record<WindowKind, number | 'head'>>>;

/** The names of the props we add under NS. */
export const PROP_NAMES = Object.freeze([
  'responsibility',
  'limitation',
  'unsettled',
  'requires-official-signature',
  'inherited-from',
  'component-id',
  'source-id',
  'lang',
  'canada-specific',
  'profile-suggestion',
  'profile-note',
  'suggested-placeholder',
  'ours'
] as const);
export type PropName = (typeof PROP_NAMES)[number];

/** The source folders under compliance/. Nothing in them may carry a status (D-17, D-44). */
export const SOURCE_DIRS = Object.freeze([
  'catalogs',
  'profiles',
  'mappings',
  'components',
  'responsibility',
  'evidence-rules',
  'tailoring',
  'poam',
  'attestations',
  'import-reports'
] as const);

/** The source files at the top of compliance/. */
export const SOURCE_FILES = Object.freeze(['sources.json', 'gaps.json', 'levels.json', 'resources.json'] as const);

/** Key and prop names no source file may use (D-17). */
export const FORBIDDEN_STATUS_NAMES = Object.freeze(['status', 'state', 'met'] as const);

/**
 * The one allowed form: a prop named `status` with value `withdrawn` on a control in a file under catalogs/. It is the publisher's lifecycle marker
 * for a withdrawn control (the NIST catalogue uses it), not our assessment (plan 44-01 choice 3).
 */
export const ALLOWED_STATUS_FORM = Object.freeze({ dir: 'catalogs', propName: 'status', value: 'withdrawn', on: 'control' } as const);

/** The OSCAL mapping model requires this lifecycle field; it is not a product assessment. */
export const ALLOWED_MAPPING_PROVENANCE_STATUS = Object.freeze({ dir: 'mappings', trail: ['mapping-collection', 'provenance'] as const } as const);

/** The only unsettled questions a component statement may name (D-19). */
export const UNSETTLED_QUESTIONS = Object.freeze({
  'tee-question': 'Whether a model service in a trusted execution environment run by a third party may receive this content.',
  'third-party-encrypted-storage': 'Whether encrypted storage at a third party counts as possession, release or export.'
} as const);

/** One statement of an implemented requirement in a component definition. */
export interface Statement {
  /** The OSCAL statement id, for example `ac-02_smt.a`. */
  readonly id: string;
  readonly description: string;
  /** What your organization does for this statement (the statement's `remarks`). */
  readonly yourOrganizationDoes?: string;
  /** A known limitation; must match a row of SECURITY.md's "Known limitations" table (44-04). */
  readonly limitation?: string;
  /** The code of an unsettled question this statement depends on (D-19). */
  readonly unsettled?: string;
  /** True when only an official's signature can settle it (D-19). */
  readonly requiresOfficialSignature?: boolean;
}

/** Ties one statement to a test or a collector's observation (D-21). Stored in compliance/evidence-rules/*.json as `{ rules: EvidenceRule[] }`. */
export interface EvidenceRule {
  readonly id: string;
  readonly component: string;
  readonly control: string;
  readonly statement: string;
  readonly kind: 'test' | 'observation';
  /** The source test: `file` is the source path (for example `src/test/gateDecide.test.ts`), `path` the suite names, `name` the test name. */
  readonly test?: { readonly file: string; readonly path: readonly string[]; readonly name: string };
  readonly observation?: { readonly collector: string; readonly subject: string };
}

/** One line of the per-test NDJSON report (44-02). `file` is the report path relative to the package the tests ran in. */
export interface TestReportRow {
  readonly file: string;
  readonly path: readonly string[];
  readonly name: string;
  readonly status: 'passed' | 'failed' | 'skipped' | 'todo';
  readonly skip: string | null;
  readonly ms: number;
}

/** What a collector saw: ids, counts, hashes, run addresses, times and pass or fail only (D-24). */
export interface Observation {
  readonly collector: string;
  readonly subject: string;
  readonly passed: boolean;
  /** ISO time. */
  readonly collectedAt: string;
  readonly commit?: string;
  readonly runUrl?: string;
  readonly counts?: Readonly<Record<string, number>>;
  readonly hash?: string;
}

/** The outcome of one evidence rule. */
export interface RuleResult {
  readonly rule: string;
  readonly passed: boolean;
  readonly reason: ReasonCode;
  /** ISO time. */
  readonly collectedAt: string;
  readonly commit?: string;
  readonly window: WindowKind;
  readonly runUrl?: string;
}

/** A reviewed not-applicable decision (44-04 loads these from compliance/tailoring/). */
export interface TailoringRecord {
  readonly level: string;
  readonly control: string;
  readonly component: string;
  readonly reason: string;
  readonly reviewer: string;
  /** ISO date. */
  readonly reviewedAt: string;
}

/** A risk acceptance whose signature has been verified (D-20, 44-04). */
export interface VerifiedRiskAcceptance {
  readonly id: string;
  readonly gap: string;
  readonly controls: readonly string[];
  readonly levels?: readonly string[];
  readonly reason: string;
  readonly namedPerson: { readonly name: string; readonly role: string };
  /** ISO time. */
  readonly issuedAt: string;
  /** ISO time, at most 365 days after issuedAt. */
  readonly expiresAt: string;
}

/** Everything computeStatus reads for one level, control and component. No field is a state. */
export interface StatusInput {
  readonly control: string;
  readonly component: string;
  readonly level: string;
  readonly responsibility: Responsibility;
  readonly statements: readonly Statement[];
  /** Statement id to the rules tied to it. */
  readonly rulesByStatement: Readonly<Record<string, readonly EvidenceRule[]>>;
  /** Rule id to its result. A rule with no entry has no result. */
  readonly results: Readonly<Record<string, RuleResult>>;
  readonly tailoring?: TailoringRecord;
  /** The code of an unsettled question (D-19). */
  readonly unsettled?: string;
  /** True when the decision this row depends on was signed by ourselves rather than an official (D-19). */
  readonly selfSigned?: boolean;
  /** A declared known limitation (D-18). */
  readonly limitation?: string;
  readonly riskAcceptance?: VerifiedRiskAcceptance;
  /** The commit being judged: the current main head or the release tag. */
  readonly head: string;
  readonly now: Date;
  /** The windows in force (48.2-03); FRESHNESS when absent, so nothing changes for an input without a policy. */
  readonly windows?: FreshnessWindows;
}

/** What computeStatus returns. `detail` fills the placeholders of the reason's REASONS template. */
export interface StatusOutcome {
  readonly state: State;
  readonly reason: ReasonCode;
  readonly detail?: Readonly<Partial<Record<ReasonPlaceholder, string>>>;
}

/** One component's part of a dashboard row. */
export interface ComponentRow {
  readonly component: string;
  readonly state: State;
  readonly reason: ReasonCode;
  readonly detail?: Readonly<Partial<Record<ReasonPlaceholder, string>>>;
  readonly responsibility: Responsibility;
  readonly evidence: readonly RuleResult[];
}

/** One control at one level. Its state comes from computeStatus only. */
export interface DashboardRow {
  readonly level: string;
  readonly control: string;
  readonly state: State;
  readonly reason: ReasonCode;
  readonly detail?: Readonly<Partial<Record<ReasonPlaceholder, string>>>;
  readonly components: readonly ComponentRow[];
}

/** The generated dashboard JSON (44-05 adds fields, never renames these). */
export interface Dashboard {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly commit: string;
  readonly rows: readonly DashboardRow[];
}

/** A level (or overlay) in scope: its controls and the components assessed for it. */
export interface LevelInput {
  readonly id: string;
  readonly title: string;
  readonly controls: readonly string[];
  readonly components: readonly string[];
}

/** A component and what it implements, as loaded from its OSCAL component definition (44-05). */
export interface ComponentInput {
  readonly id: string;
  readonly implemented: readonly {
    readonly control: string;
    readonly responsibility: Responsibility;
    readonly statements: readonly Statement[];
    readonly inheritedFrom?: string;
  }[];
}

/** Everything buildDashboard reads. */
export interface DashboardInput {
  /** The commit the evidence (test rows) was collected at. */
  readonly commit: string;
  readonly generatedAt: string;
  readonly now: Date;
  readonly levels: readonly LevelInput[];
  readonly components: readonly ComponentInput[];
  readonly rules: readonly EvidenceRule[];
  readonly testRows: readonly TestReportRow[];
  readonly observations: readonly Observation[];
  /** The commit being judged. */
  readonly head: string;
}


/**
 * Maps a per-test report path to the source path evidence rules name.
 * Root: `dist/test/X.test.js` becomes `src/test/X.test.ts` (and `dist/test/<sub>/X.test.js` becomes `src/test/<sub>/X.test.ts`).
 * With a package prefix such as `relay` or `hub`: `dist/test/<sub>/X.test.js` becomes `<prefix>/test/<sub>/X.test.ts`.
 * `.mjs` and `.ts` report paths stay as they are, under the prefix when one is given. Mapping an already mapped path changes nothing.
 */
export function sourcePathForReport(file: string, packagePrefix?: string): string {
  const prefix = (packagePrefix ?? '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  let rel = file.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
  if (prefix && rel.startsWith(`${prefix}/`)) rel = rel.slice(prefix.length + 1);
  const compiled = /^dist\/test\/(.+)\.js$/.exec(rel);
  if (compiled) {
    const stem = compiled[1];
    return prefix ? `${prefix}/test/${stem}.ts` : `src/test/${stem}.ts`;
  }
  return prefix ? `${prefix}/${rel}` : rel;
}
