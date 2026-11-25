// Deployment collector (48-02, D-13, D-14 (b), D-16, VER-05, VER-06). A site runs compliance/site-export/collect.sh and the site-export command,
// which write a signed export: the extension's signed-payload envelope (signed.ts) for the purpose below, holding a strict set of facts (counts,
// booleans, a few enum values, two version strings and one hash). This collector reads that file offline, never the site. It trusts only keys
// listed in the site trust list (compliance/attestations/site-signers.json, a gate path, or your organization's own list), refuses anything else
// with a collector error, so every rule on it reads missing-result, and decides every pass itself from the facts under thresholds held here.
// Observations are dated at the export's signed time, so the `settings` window (7 days) measures the site's evidence, not the CI run.
import { verifyEnvelope } from '../signed.ts';
import { parseSigners } from '../riskAcceptance.ts';
import type { Observation } from '../model.ts';
import type { Collector, CollectorContext } from './types.ts';
import { collectorError } from './github.ts';
import { CHECKS, MAX_EXPORT_FILE_BYTES, parseExportPayload, SITE_EXPORT_PURPOSE } from './deploymentChecks.ts';

// The allow-list, parser, thresholds and checks live in deploymentChecks.ts (no loader, no validator); they are re-exported unchanged here.
export * from './deploymentChecks.ts';

export interface DeploymentInput {
  /** The signed export file. */
  readonly file: string;
  /** The site trust list (compliance/attestations/site-signers.json, or your organization's own). */
  readonly signersFile: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isMissing = (error: unknown): boolean => isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

async function readCapped(context: CollectorContext, file: string, what: 'export' | 'signers'): Promise<string> {
  const label = what === 'export' ? 'export' : 'site trust list';
  let text: string;
  try {
    text = await context.readFile(file);
  } catch (error) {
    if (isMissing(error)) throw collectorError(`${what}-missing`, `deployment: the ${label} file is missing`);
    throw collectorError(`${what}-unreadable`, `deployment: the ${label} file could not be read`);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_EXPORT_FILE_BYTES) throw collectorError(`${what}-too-large`, `deployment: the ${label} file is larger than allowed`);
  return text;
}

function parseJson(text: string, what: 'export' | 'signers'): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw collectorError(`${what}-unreadable`, `deployment: the ${what === 'export' ? 'export' : 'site trust list'} file is not JSON`);
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
    const signersDoc = parseJson(await readCapped(context, input.signersFile, 'signers'), 'signers');
    let keys;
    try {
      keys = parseSigners(signersDoc, 'site trust list');
    } catch {
      throw collectorError('signers-invalid', 'deployment: the site trust list is not a valid signers file');
    }
    const envelope = parseJson(await readCapped(context, input.file, 'export'), 'export');
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
