// The deployment collector's pure part (48-02, split out in 48.2-06): the export's fact allow-list, its parser, the thresholds and the checks
// that decide every pass. It imports no loader or validator, so the site evidence code (48.2-06) and the workbench's engine bundle (48.2-08)
// use these one definitions without pulling in the schema validator. collectors/deployment.ts re-exports everything here.
import { MAX_PAYLOAD_BYTES } from '../signed.ts';
import { collectorError } from './github.ts';

/** The signed-payload purpose of a site export. It is inside every signature, so it never changes once one is signed. */
export const SITE_EXPORT_PURPOSE = 'site-evidence-export';
/** The export payload's schema number. */
export const SITE_EXPORT_SCHEMA = 1;
/** A site id: the subject id pattern of redact.ts. */
export const SITE_ID = /^[a-z0-9][a-z0-9._/@:-]{0,127}$/;
/** The largest export or trust list file read. Exports are canonical JSON well under the envelope cap; this leaves room for indentation. */
export const MAX_EXPORT_FILE_BYTES = 2 * MAX_PAYLOAD_BYTES;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** One leaf of the fact allow-list. */
type Leaf =
  | { readonly kind: 'count' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'version' }
  | { readonly kind: 'sha256' };

const LEAVES = new WeakSet<object>();
const leaf = <T extends Leaf>(value: T): T => { const frozen = Object.freeze(value); LEAVES.add(frozen); return frozen; };
const count = leaf({ kind: 'count' });
const flag = leaf({ kind: 'boolean' });
const version = leaf({ kind: 'version' });
const sha256 = leaf({ kind: 'sha256' });
const oneOf = (values: readonly string[]) => leaf({ kind: 'enum', values });

/** A version string: three numbers and an optional build suffix (a Red Hat build carries `.redhat-NNNNN`). */
export const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[.+-][0-9A-Za-z.+-]{1,64})?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const KEYCLOAK_DISTRIBUTIONS = Object.freeze(['upstream', 'redhat', 'other'] as const);
export const KEYCLOAK_FIPS_MODES = Object.freeze(['strict', 'non-strict', 'disabled'] as const);
export const SEAL_TYPES = Object.freeze(['pkcs11', 'shamir', 'transit', 'other'] as const);
export const REGISTRY_KINDS = Object.freeze(['zot', 'harbor', 'other'] as const);

/** The fact allow-list: every key required, nothing else accepted. */
export const FACT_SHAPE = Object.freeze({
  keycloak: Object.freeze({
    distribution: oneOf(KEYCLOAK_DISTRIBUTIONS),
    version,
    fipsMode: oneOf(KEYCLOAK_FIPS_MODES),
    passwordAuthenticators: count,
    otpAuthenticators: count,
    loadTestClients: count,
    userEventsEnabled: flag,
    adminEventsEnabled: flag,
    eventsLastDay: count
  }),
  openbao: Object.freeze({
    version,
    sealType: oneOf(SEAL_TYPES),
    auditDevices: count,
    auditEventsLastDay: count
  }),
  kubernetes: Object.freeze({
    auditPolicySha256: sha256,
    sessionsAudited: flag,
    workspacesAudited: flag,
    auditEventsLastDay: count,
    nodes: count,
    fipsNodes: count
  }),
  registry: Object.freeze({
    kind: oneOf(REGISTRY_KINDS),
    enforcingImagePolicies: count,
    unsignedImageResults: count,
    auditEventsLastDay: count
  }),
  images: Object.freeze({
    locked: count,
    signatureVerified: count,
    sbomVerified: count,
    provenanceVerified: count
  }),
  workbench: Object.freeze({
    sampledSessions: count,
    fipsSessions: count
  })
});

export interface SiteFacts {
  readonly keycloak: {
    readonly distribution: (typeof KEYCLOAK_DISTRIBUTIONS)[number];
    readonly version: string;
    readonly fipsMode: (typeof KEYCLOAK_FIPS_MODES)[number];
    readonly passwordAuthenticators: number;
    readonly otpAuthenticators: number;
    readonly loadTestClients: number;
    readonly userEventsEnabled: boolean;
    readonly adminEventsEnabled: boolean;
    /** Keycloak user and admin events the log store holds from the last day. */
    readonly eventsLastDay: number;
  };
  readonly openbao: {
    readonly version: string;
    readonly sealType: (typeof SEAL_TYPES)[number];
    readonly auditDevices: number;
    readonly auditEventsLastDay: number;
  };
  readonly kubernetes: {
    readonly auditPolicySha256: string;
    readonly sessionsAudited: boolean;
    readonly workspacesAudited: boolean;
    readonly auditEventsLastDay: number;
    readonly nodes: number;
    readonly fipsNodes: number;
  };
  readonly registry: {
    readonly kind: (typeof REGISTRY_KINDS)[number];
    /** Admission policies that verify image signatures and deny on failure. */
    readonly enforcingImagePolicies: number;
    /** Current failed or errored results of those policies in the policy reports: images running without a verified signature. */
    readonly unsignedImageResults: number;
    readonly auditEventsLastDay: number;
  };
  readonly images: {
    /** Images in the site's image lock list. */
    readonly locked: number;
    readonly signatureVerified: number;
    readonly sbomVerified: number;
    readonly provenanceVerified: number;
  };
  readonly workbench: {
    readonly sampledSessions: number;
    readonly fipsSessions: number;
  };
}

/** The export payload inside the envelope. */
export interface SiteExportPayload {
  readonly schema: typeof SITE_EXPORT_SCHEMA;
  readonly site: string;
  readonly generatedAt: string;
  readonly facts: SiteFacts;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isLeaf = (value: unknown): value is Leaf => typeof value === 'object' && value !== null && LEAVES.has(value);

function leafOk(leaf: Leaf, value: unknown): boolean {
  switch (leaf.kind) {
    case 'count': return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    case 'boolean': return typeof value === 'boolean';
    case 'enum': return typeof value === 'string' && leaf.values.includes(value);
    case 'version': return typeof value === 'string' && VERSION_PATTERN.test(value);
    case 'sha256': return typeof value === 'string' && SHA256_PATTERN.test(value);
  }
}

function checkShape(shape: Readonly<Record<string, unknown>>, value: unknown, at: string): void {
  if (!isRecord(value)) throw collectorError('export-wrong-fact-type', `deployment: the fact ${at} is not an object`);
  for (const key of Object.keys(value)) {
    // The message never repeats the key: it is text from the site.
    if (!Object.hasOwn(shape, key)) throw collectorError('export-unknown-fact', `deployment: the export carries a fact under ${at} that is not in the allow-list`);
  }
  for (const [key, expected] of Object.entries(shape)) {
    if (!Object.hasOwn(value, key)) throw collectorError('export-missing-fact', `deployment: the export lacks the fact ${at}.${key}`);
    if (isLeaf(expected)) {
      if (!leafOk(expected, value[key])) throw collectorError('export-wrong-fact-type', `deployment: the fact ${at}.${key} has the wrong type`);
    } else {
      checkShape(expected as Readonly<Record<string, unknown>>, value[key], `${at}.${key}`);
    }
  }
}

/** Checks a payload against the allow-list and returns it typed, or throws a collector error naming the reason. */
export function parseExportPayload(payload: unknown): SiteExportPayload {
  if (!isRecord(payload)) throw collectorError('export-invalid-payload', 'deployment: the export payload is not an object');
  const keys = Object.keys(payload).sort().join(',');
  if (keys !== 'facts,generatedAt,schema,site') throw collectorError('export-invalid-payload', 'deployment: the export payload must hold schema, site, generatedAt and facts only');
  if (payload.schema !== SITE_EXPORT_SCHEMA) throw collectorError('export-invalid-payload', 'deployment: the export schema is not one this tool reads');
  if (typeof payload.site !== 'string' || !SITE_ID.test(payload.site)) throw collectorError('export-invalid-payload', 'deployment: the export site id is not a plain id');
  if (typeof payload.generatedAt !== 'string' || !ISO_TIME.test(payload.generatedAt) || new Date(payload.generatedAt).toISOString() !== payload.generatedAt) {
    throw collectorError('export-invalid-payload', 'deployment: the export time is not an ISO time');
  }
  checkShape(FACT_SHAPE, payload.facts, 'facts');
  return payload as unknown as SiteExportPayload;
}

/** What one check says about the facts. Counts follow the redact pattern; the facts themselves never leave the export. */
export interface CheckOutcome {
  readonly passed: boolean;
  readonly counts: Readonly<Record<string, number>>;
  readonly hash?: string;
}

export interface DeploymentCheck {
  readonly subject: string;
  readonly derive: (facts: SiteFacts) => CheckOutcome;
}

// Thresholds. Every pass is decided here from the facts; the export has no pass field this collector would accept.
export const MAX_PASSWORD_AUTHENTICATORS = 0;
export const MAX_OTP_AUTHENTICATORS = 0;
export const MAX_LOAD_TEST_CLIENTS = 0;
/**
 * The lowest upstream Keycloak release with CVE-2026-6856 fixed (48-RESEARCH verification register row 3: the fix commits are ancestors of
 * 26.8.0). A Red Hat build fails until its fix version is confirmed, and so does a build of unknown origin.
 */
export const KEYCLOAK_MIN_FIXED = '26.8.0';
export const KEYCLOAK_FIXED_DISTRIBUTION = 'upstream';
export const REQUIRED_KEYCLOAK_FIPS_MODE = 'strict';
export const REQUIRED_SEAL_TYPE = 'pkcs11';
/** The fewest events a stream must have shipped to the log store in the last day. */
export const MIN_EVENTS_LAST_DAY = 1;
export const MIN_AUDIT_DEVICES = 1;
export const MIN_NODES = 1;
export const MIN_ENFORCING_IMAGE_POLICIES = 1;
export const MAX_UNSIGNED_IMAGE_RESULTS = 0;
export const MIN_LOCKED_IMAGES = 1;
export const MIN_SAMPLED_SESSIONS = 1;

/** Compares two version strings by their three leading numbers. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string): number[] => value.split(/[.+-]/, 3).map((part) => Number.parseInt(part, 10));
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  return 0;
}

const bit = (value: boolean): number => (value ? 1 : 0);
/** At least `minimum` of `total`, and every one of them good. */
const allOf = (total: number, good: number, minimum: number): boolean => total >= minimum && good === total;

/** Every check, in the order its observation is written. */
export const CHECKS: readonly DeploymentCheck[] = Object.freeze([
  { subject: 'keycloak/no-password-authenticator', derive: ({ keycloak }: SiteFacts) => ({ passed: keycloak.passwordAuthenticators <= MAX_PASSWORD_AUTHENTICATORS, counts: { 'password-authenticators': keycloak.passwordAuthenticators } }) },
  { subject: 'keycloak/no-otp-authenticator', derive: ({ keycloak }: SiteFacts) => ({ passed: keycloak.otpAuthenticators <= MAX_OTP_AUTHENTICATORS, counts: { 'otp-authenticators': keycloak.otpAuthenticators } }) },
  { subject: 'keycloak/no-load-test-client', derive: ({ keycloak }: SiteFacts) => ({ passed: keycloak.loadTestClients <= MAX_LOAD_TEST_CLIENTS, counts: { 'load-test-clients': keycloak.loadTestClients } }) },
  {
    subject: 'keycloak/cve-2026-6856-fixed',
    derive: ({ keycloak }: SiteFacts) => {
      const below = compareVersions(keycloak.version, KEYCLOAK_MIN_FIXED) < 0;
      const unconfirmed = keycloak.distribution !== KEYCLOAK_FIXED_DISTRIBUTION;
      return { passed: !below && !unconfirmed, counts: { 'below-fixed-version': bit(below), 'unconfirmed-build': bit(unconfirmed) } };
    }
  },
  {
    subject: 'keycloak/events-shipped',
    derive: ({ keycloak }: SiteFacts) => ({
      passed: keycloak.userEventsEnabled && keycloak.adminEventsEnabled && keycloak.eventsLastDay >= MIN_EVENTS_LAST_DAY,
      counts: { 'events-last-day': keycloak.eventsLastDay, 'user-events-off': bit(!keycloak.userEventsEnabled), 'admin-events-off': bit(!keycloak.adminEventsEnabled) }
    })
  },
  { subject: 'keycloak/fips-strict', derive: ({ keycloak }: SiteFacts) => ({ passed: keycloak.fipsMode === REQUIRED_KEYCLOAK_FIPS_MODE, counts: { 'not-strict': bit(keycloak.fipsMode !== REQUIRED_KEYCLOAK_FIPS_MODE) } }) },
  {
    subject: 'openbao/audit-device',
    derive: ({ openbao }: SiteFacts) => ({
      passed: openbao.auditDevices >= MIN_AUDIT_DEVICES && openbao.auditEventsLastDay >= MIN_EVENTS_LAST_DAY,
      counts: { 'audit-devices': openbao.auditDevices, 'events-last-day': openbao.auditEventsLastDay }
    })
  },
  { subject: 'openbao/hsm-seal', derive: ({ openbao }: SiteFacts) => ({ passed: openbao.sealType === REQUIRED_SEAL_TYPE, counts: { 'not-pkcs11': bit(openbao.sealType !== REQUIRED_SEAL_TYPE) } }) },
  {
    subject: 'kubernetes/audit-session-workspace',
    derive: ({ kubernetes }: SiteFacts) => ({
      passed: kubernetes.sessionsAudited && kubernetes.workspacesAudited && kubernetes.auditEventsLastDay >= MIN_EVENTS_LAST_DAY,
      counts: { 'unaudited-resources': bit(!kubernetes.sessionsAudited) + bit(!kubernetes.workspacesAudited), 'events-last-day': kubernetes.auditEventsLastDay },
      hash: kubernetes.auditPolicySha256
    })
  },
  { subject: 'kubernetes/fips-nodes', derive: ({ kubernetes }: SiteFacts) => ({ passed: allOf(kubernetes.nodes, kubernetes.fipsNodes, MIN_NODES), counts: { nodes: kubernetes.nodes, 'fips-nodes': kubernetes.fipsNodes } }) },
  {
    subject: 'registry/signature-enforced',
    derive: ({ registry }: SiteFacts) => ({
      passed: registry.enforcingImagePolicies >= MIN_ENFORCING_IMAGE_POLICIES && registry.unsignedImageResults <= MAX_UNSIGNED_IMAGE_RESULTS,
      counts: { 'enforcing-policies': registry.enforcingImagePolicies, 'unsigned-results': registry.unsignedImageResults }
    })
  },
  { subject: 'registry/audit', derive: ({ registry }: SiteFacts) => ({ passed: registry.auditEventsLastDay >= MIN_EVENTS_LAST_DAY, counts: { 'events-last-day': registry.auditEventsLastDay } }) },
  { subject: 'images/signed', derive: ({ images }: SiteFacts) => ({ passed: allOf(images.locked, images.signatureVerified, MIN_LOCKED_IMAGES), counts: { images: images.locked, verified: images.signatureVerified } }) },
  { subject: 'images/sbom', derive: ({ images }: SiteFacts) => ({ passed: allOf(images.locked, images.sbomVerified, MIN_LOCKED_IMAGES), counts: { images: images.locked, verified: images.sbomVerified } }) },
  { subject: 'images/provenance', derive: ({ images }: SiteFacts) => ({ passed: allOf(images.locked, images.provenanceVerified, MIN_LOCKED_IMAGES), counts: { images: images.locked, verified: images.provenanceVerified } }) },
  {
    subject: 'workbench/fips-provider',
    derive: ({ workbench }: SiteFacts) => ({ passed: allOf(workbench.sampledSessions, workbench.fipsSessions, MIN_SAMPLED_SESSIONS), counts: { sampled: workbench.sampledSessions, 'fips-on': workbench.fipsSessions } })
  }
]);
