// The feature ids of policy bundle v2 and the sections they name (FND-02, Phase 41 D-05, D-06, D-50, D-60). Pure: no I/O, no clock, no vscode, no package,
// and no import at all, so any file may read these lists at load time without a cycle.
// A feature id is `name@N`, lowercase. A policy names in `requires` every feature it uses; a client that lacks one says "update the extension", never Reset
// (coherence review S6). The list is append-only: an id, once released, keeps its meaning, and a changed meaning is a new id (`labels@2`) beside the old one.

/**
 * Every feature this version knows, in the order they were added. Phase 41 registers all of its own here at once (D-06), so no later plan edits the list;
 * `export-control@1` is the exportControl section (D-60, lowercase so a client with the safety patch's id pattern reads it as "update").
 */
export const FEATURE_IDS = Object.freeze([
  'labels@1', 'endpoints@1', 'authorizations@1', 'residency@1', 'models@1', 'agents@1', 'people@1', 'onboarding@1', 'limits@1', 'layers@1', 'export-control@1',
  // Phase 71 (D-12): trusted issuers, status lists, freshness and sensitivity requirements; organization-to-organization agreements.
  'credentials@1', 'agreements@1',
  // Phase 70.1 (D-16): how a label may be proposed and raised. Appended after Phase 71's ids; 45.1's label-interop@1 lands after it.
  'classification@1',
  // Phase 45.1 (D-02): how your organization's labels are written for allies.
  'label-interop@1'
] as const);
export type FeatureId = (typeof FEATURE_IDS)[number];

/** The sections of a v2 policy document, in the order the policy editor shows them (POLICY-SCHEMA section 2). `reserved` holds today's reserved v1 fields. */
export const POLICY_SECTIONS = Object.freeze([
  'labels', 'endpoints', 'authorizations', 'models', 'agents', 'residency', 'people', 'onboarding', 'limits', 'reserved', 'exportControl', 'credentials', 'agreements',
  'classification',
  'labelInterop'
] as const);
export type PolicySectionName = (typeof POLICY_SECTIONS)[number];

/** The features every v2 document names whatever it holds: its envelope (`layer`, `parent`) and its two required sections. */
export const ALWAYS_REQUIRED_FEATURES: readonly FeatureId[] = Object.freeze(['agents@1', 'labels@1', 'layers@1'] as const);

const SECTION_FEATURES: Readonly<Record<PolicySectionName, FeatureId | undefined>> = Object.freeze({
  labels: 'labels@1',
  endpoints: 'endpoints@1',
  authorizations: 'authorizations@1',
  models: 'models@1',
  agents: 'agents@1',
  residency: 'residency@1',
  people: 'people@1',
  onboarding: 'onboarding@1',
  limits: 'limits@1',
  // Reserved fields keep today's meaning (validated and ignored), so they need no feature of their own.
  reserved: undefined,
  exportControl: 'export-control@1',
  credentials: 'credentials@1',
  agreements: 'agreements@1',
  classification: 'classification@1',
  labelInterop: 'label-interop@1'
});

/** The feature a section needs in `requires`, or undefined for `reserved`. The envelope's `layer` and `parent` belong to `layers@1`, which every v2 document lists. */
export function featureForSection(section: PolicySectionName): FeatureId | undefined {
  return Object.prototype.hasOwnProperty.call(SECTION_FEATURES, section) ? SECTION_FEATURES[section] : undefined;
}

export function isFeatureId(value: unknown): value is FeatureId {
  return typeof value === 'string' && (FEATURE_IDS as readonly string[]).includes(value);
}

export function isPolicySectionName(value: unknown): value is PolicySectionName {
  return typeof value === 'string' && (POLICY_SECTIONS as readonly string[]).includes(value);
}
