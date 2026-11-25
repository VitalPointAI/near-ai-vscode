// The model a job uses (Phase 74.1 D-18, D-18a; glossary "Models by job"). Pure: no I/O, no clock, no vscode. The order is a person's own value, then
// your organization's default for the job, then the shipped preference in AGENT_DEFAULTS.models; each passport id is mapped to the first catalogue model
// that resolvePassport resolves to it and the gate allows for the job. In report mode, while none is in the catalogue, today's model for the job
// (AGENT_DEFAULTS.reportFallback) keeps the product working; under enforce it is never used.
import { AGENT_DEFAULTS } from '../agentDefaults';
import { resolvePassport } from './models';
import type { ModelJob, ModelsSection } from './models';

/** The words of a job that has no model (glossary: "Models by job", use words). */
export const JOB_RESOLUTION_TEXT = Object.freeze({
  none: 'No model your organization approved for this job is available here. Ask your organization\'s security contact, or choose a model in Models by job.'
});

export interface JobModelInput {
  /** The person's own setting for the job, at any scope; empty means not set. */
  readonly setByPerson?: string;
  /** The catalogue the client holds. */
  readonly catalog: ReadonlyArray<{ readonly id: string }>;
  /** Whether the gate allows `modelId` for the job's use (decideRoute through the caller). */
  readonly allows: (modelId: string, job: ModelJob) => boolean;
  /** The effective policy's models section; absent is report mode with the shipped passports. */
  readonly models: ModelsSection | undefined;
  readonly now: number;
}

export type JobModel =
  | { readonly model: string; readonly source: 'set-by-you' | 'organization' | 'shipped' | 'report-fallback' }
  | { readonly model: undefined; readonly reason: string };

/** The first catalogue model whose passport is `passportId` and that the gate allows for the job. */
function firstAllowed(passportId: string, input: JobModelInput, job: ModelJob): string | undefined {
  return input.catalog.find((entry) => resolvePassport(input.models, entry.id, input.now)?.passport.id === passportId && input.allows(entry.id, job))?.id;
}

export function resolveJobModel(job: ModelJob, input: JobModelInput): JobModel {
  const own = input.setByPerson?.trim() ?? '';
  if (own !== '') return { model: own, source: 'set-by-you' };
  const organization = input.models?.defaults?.[job];
  if (organization !== undefined) {
    const model = firstAllowed(organization, input, job);
    if (model !== undefined) return { model, source: 'organization' };
  }
  for (const passportId of AGENT_DEFAULTS.models[job]) {
    const model = firstAllowed(passportId, input, job);
    if (model !== undefined) return { model, source: 'shipped' };
  }
  const fallback = (AGENT_DEFAULTS.reportFallback as Readonly<Partial<Record<ModelJob, string>>>)[job];
  const reporting = input.models?.mode !== 'enforce';
  if (reporting && fallback !== undefined && (input.catalog.length === 0 || input.catalog.some((entry) => entry.id === fallback))) return { model: fallback, source: 'report-fallback' };
  return { model: undefined, reason: JOB_RESOLUTION_TEXT.none };
}
