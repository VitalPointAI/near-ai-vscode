// The concrete model of every job a run needs (Phase 74.1 D-18): a person's own setting, read through settings.ts, then resolveJobModel's order. It reads
// settings and writes none; the one Models by job store, when it comes (32.2-11), feeds the same reader.
import { resolveJobModel } from '../domain/gate/jobModel';
import type { JobModel } from '../domain/gate/jobModel';
import type { ModelJob, ModelsSection } from '../domain/gate/models';
import { readJobSettings } from './settings';
import type { SettableJob } from './settings';

/** The jobs a run starts with. */
export const RUN_JOBS = Object.freeze(['standard', 'deep', 'fast', 'safety', 'backup', 'vision', 'transcription', 'image'] as const satisfies readonly SettableJob[]);
export type RunJob = (typeof RUN_JOBS)[number];

export interface JobModelsOptions {
  /** A person's own model per job ("" when unset); settings.ts by default. */
  readonly read?: () => Readonly<Record<SettableJob, string>>;
  /** The effective policy's models section; absent is report mode with the shipped passports. */
  readonly models?: ModelsSection;
  readonly now?: number;
}

/** The model of every run job, each resolved by resolveJobModel over the catalogue and the gate's `allows`. */
export function jobModelsFor(catalog: ReadonlyArray<{ readonly id: string }>, allows: (modelId: string, job: ModelJob) => boolean, options: JobModelsOptions = {}): Readonly<Record<RunJob, JobModel>> {
  const own = (options.read ?? readJobSettings)();
  const now = options.now ?? Date.now();
  return Object.freeze(Object.fromEntries(RUN_JOBS.map((job) => [job, resolveJobModel(job, { setByPerson: own[job], catalog, allows, models: options.models, now })])) as Record<RunJob, JobModel>);
}
