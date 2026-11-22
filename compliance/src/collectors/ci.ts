// CI job collector (44-07, D-23, D-24). It turns the trusted workflow's `needs`
// results into compact observations and deliberately never copies job outputs or logs.
import { CI_CHECKS } from '../../../scripts/lib/workflow.mjs';
import type { Observation } from '../model.ts';
import type { Collector, CollectorContext } from './types.ts';

export interface CiInput {
  /** JSON serialization of the GitHub Actions `needs` context for this workflow run. */
  readonly needsFile: string;
}

type NeedsEntry = { readonly result: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function needsOf(value: unknown): Readonly<Record<string, NeedsEntry>> {
  if (!isRecord(value)) throw new Error('CI collector: needs file must contain an object');
  const needs: Record<string, NeedsEntry> = {};
  for (const [job, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.result !== 'string') continue;
    needs[job] = { result: entry.result };
  }
  return needs;
}

/** The required CI jobs plus docs, which runs for every pull request but is not protected yet. */
export const CI_OBSERVATION_JOBS: readonly string[] = Object.freeze([...CI_CHECKS, 'docs']);

/** One observation per available CI job. Only exactly `success` is passing evidence. */
export const ciCollector: Collector<CiInput> = Object.freeze({
  id: 'ci',
  window: 'head',
  async collect(input: CiInput, context: CollectorContext): Promise<Observation[]> {
    if (!input || typeof input.needsFile !== 'string' || input.needsFile === '') throw new Error('CI collector: input.needsFile is required');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await context.readFile(input.needsFile));
    } catch (error) {
      throw new Error(`CI collector: could not read needs file: ${error instanceof Error ? error.message : String(error)}`);
    }
    const needs = needsOf(parsed);
    const observations: Observation[] = [];
    for (const job of CI_OBSERVATION_JOBS) {
      const result = needs[job];
      if (!result) continue;
      observations.push({
        collector: 'ci',
        subject: job,
        passed: result.result === 'success',
        collectedAt: context.now.toISOString(),
        commit: context.commit,
        ...(context.runUrl ? { runUrl: context.runUrl } : {})
      });
    }
    return observations;
  }
});
