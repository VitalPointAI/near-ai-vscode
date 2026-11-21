// Secret-scan collector (44-07, D-23, D-24). Its JSON has aggregate counts only;
// findings and their masked text remain in the CI log, never in compliance evidence.
import type { Observation } from '../model.ts';
import type { Collector, CollectorContext } from './types.ts';

export interface SecretScanInput {
  readonly jsonFile: string;
}

interface SecretScanReport {
  readonly mode: string;
  readonly files: number;
  readonly findings: number;
  readonly clean: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function reportOf(value: unknown): SecretScanReport {
  if (!isRecord(value)) throw new Error('secret-scan collector: JSON must contain mode, non-negative files and findings counts, and clean');
  const { mode, files, findings, clean } = value;
  if (typeof mode !== 'string' || typeof files !== 'number' || !Number.isSafeInteger(files) || files < 0 || typeof findings !== 'number' || !Number.isSafeInteger(findings) || findings < 0 || typeof clean !== 'boolean') {
    throw new Error('secret-scan collector: JSON must contain mode, non-negative files and findings counts, and clean');
  }
  return { mode, files, findings, clean };
}

/** One observation for a secret-scan JSON result. Invalid JSON is an error, never passing evidence. */
export const secretScanCollector: Collector<SecretScanInput> = Object.freeze({
  id: 'secret-scan',
  window: 'head',
  async collect(input: SecretScanInput, context: CollectorContext): Promise<Observation[]> {
    if (!input || typeof input.jsonFile !== 'string' || input.jsonFile === '') throw new Error('secret-scan collector: input.jsonFile is required');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await context.readFile(input.jsonFile));
    } catch (error) {
      throw new Error(`secret-scan collector: could not read JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const report = reportOf(parsed);
    const observation: Observation = {
      collector: 'secret-scan',
      subject: report.mode,
      passed: report.clean,
      collectedAt: context.now.toISOString(),
      commit: context.commit,
      ...(context.runUrl ? { runUrl: context.runUrl } : {}),
      counts: { files: report.files, findings: report.findings }
    };
    return [observation];
  }
});
