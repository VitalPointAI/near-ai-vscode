// Deployment collector (48-02, D-13, D-14 (b), D-16, VER-05, VER-06). A site runs compliance/site-export/collect.sh and the site-export command,
// which write a signed export: the extension's signed-payload envelope (signed.ts) for the purpose below, holding a strict set of facts (counts,
// booleans, a few enum values and two version strings). This collector reads that file offline, never the site. It trusts only keys listed in
// the site trust list (compliance/attestations/site-signers.json, a gate path), refuses anything else with a collector error, so every rule on
// it reads missing-result, and decides every pass itself from the facts under thresholds held here. Observations are dated at the export's
// signed time, so the `settings` window (7 days) measures the site's evidence, not the CI run that read it.
import { MAX_PAYLOAD_BYTES, verifyEnvelope } from '../signed.ts';
import { parseSigners } from '../riskAcceptance.ts';
import type { Observation } from '../model.ts';
import type { Collector, CollectorContext } from './types.ts';
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
type Leaf = { readonly kind: 'count' } | { readonly kind: 'boolean' };

const LEAVES = new WeakSet<object>();
const leaf = <T extends Leaf>(value: T): T => { const frozen = Object.freeze(value); LEAVES.add(frozen); return frozen; };
const count = leaf({ kind: 'count' });

/** The fact allow-list: every key required, nothing else accepted. */
export const FACT_SHAPE = Object.freeze({
  keycloak: Object.freeze({
    passwordAuthenticators: count,
    otpAuthenticators: count
  })
});

export interface SiteFacts {
  readonly keycloak: {
    readonly passwordAuthenticators: number;
    readonly otpAuthenticators: number;
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
  }
}

function checkShape(shape: Readonly<Record<string, unknown>>, value: unknown, at: string): void {
  if (!isRecord(value)) throw collectorError('export-wrong-fact-type', `deployment: the fact ${at} is not an object`);
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(shape, key)) throw collectorError('export-unknown-fact', `deployment: the export carries an unknown fact ${at}.${key}`);
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

/** The most enabled password authenticators a bound flow may hold. */
export const MAX_PASSWORD_AUTHENTICATORS = 0;

/** Every check, in the order its observation is written. */
export const CHECKS: readonly DeploymentCheck[] = Object.freeze([
  {
    subject: 'keycloak/no-password-authenticator',
    derive: (facts: SiteFacts) => ({ passed: facts.keycloak.passwordAuthenticators <= MAX_PASSWORD_AUTHENTICATORS, counts: { 'password-authenticators': facts.keycloak.passwordAuthenticators } })
  }
]);

export interface DeploymentInput {
  /** The signed export file. */
  readonly file: string;
  /** The site trust list (compliance/attestations/site-signers.json, or your organization's own). */
  readonly signersFile: string;
}

const isMissing = (error: unknown): boolean => isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

async function readCapped(context: CollectorContext, file: string, what: string, missingCode: string): Promise<string> {
  let text: string;
  try {
    text = await context.readFile(file);
  } catch (error) {
    if (isMissing(error)) throw collectorError(missingCode, `deployment: the ${what} file is missing`);
    throw collectorError(`${missingCode.replace(/-missing$/, '')}-unreadable`, `deployment: the ${what} file could not be read`);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_EXPORT_FILE_BYTES) throw collectorError(missingCode === 'export-missing' ? 'export-too-large' : 'signers-too-large', `deployment: the ${what} file is larger than allowed`);
  return text;
}

function parseJson(text: string, code: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw collectorError(code, `deployment: the ${what} file is not JSON`);
  }
}

/** Verifies one site export and turns its facts into one observation per check. */
export const deploymentCollector: Collector<DeploymentInput> = Object.freeze({
  id: 'deployment',
  window: 'settings',
  async collect(input: DeploymentInput, context: CollectorContext): Promise<Observation[]> {
    if (!isRecord(input) || typeof input.file !== 'string' || input.file === '' || typeof input.signersFile !== 'string' || input.signersFile === '') {
      throw collectorError('invalid-input', 'deployment: input.file and input.signersFile are required');
    }
    const signersText = await readCapped(context, input.signersFile, 'site trust list', 'signers-missing');
    let keys;
    try {
      keys = parseSigners(parseJson(signersText, 'signers-unreadable', 'site trust list'), 'site trust list');
    } catch (error) {
      if (isRecord(error) && typeof error.code === 'string') throw error;
      throw collectorError('signers-invalid', 'deployment: the site trust list is not a valid signers file');
    }
    const envelope = parseJson(await readCapped(context, input.file, 'export', 'export-missing'), 'export-unreadable', 'export');
    const verdict = verifyEnvelope(envelope, { purpose: SITE_EXPORT_PURPOSE, keys, now: context.now });
    if (!verdict.ok) throw collectorError(`export-${verdict.reason}`, `deployment: ${verdict.message}`);
    const payload = parseExportPayload(verdict.payload);
    if (payload.generatedAt !== verdict.signedAt) throw collectorError('export-time-mismatch', 'deployment: the export time is not the time it was signed');
    return CHECKS.map((check) => {
      const outcome = check.derive(payload.facts);
      return {
        collector: 'deployment',
        subject: check.subject,
        passed: outcome.passed,
        collectedAt: verdict.signedAt,
        commit: context.commit,
        counts: { ...outcome.counts },
        ...(outcome.hash ? { hash: outcome.hash } : {})
      };
    });
  }
});
