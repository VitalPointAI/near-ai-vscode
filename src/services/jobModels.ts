// The concrete model of every job a run needs (Phase 74.1 D-18): a person's own setting, read through settings.ts, then resolveJobModel's order. It reads
// settings and writes none; the one Models by job store, when it comes (32.2-11), feeds the same reader.
import { resolveJobModel } from '../domain/gate/jobModel';
import type { JobModel } from '../domain/gate/jobModel';
import type { ModelJob, ModelsSection } from '../domain/gate/models';
import { readJobSettings, readModelTiers } from './settings';
import type { ModelInfo } from '../domain/provider/messages';
import { defaultSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { safetyCheckersFor } from './chatBridge';
import { gateAllows } from './privateRoute';
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

/** What a run starts with (74.1 D-18, D-19): its model tiers by job and, in auto mode, its safety checkers of another family. */
export interface RunModels {
  readonly tiers: { readonly deep: string; readonly standard: string; readonly fast: string };
  readonly safetyModel?: string;
  readonly safetyFallbackModel?: string;
  /** Said once when auto mode has no checker: why a person decides. */
  readonly safetyNotice?: string;
}

/**
 * The models a run starts on: each tier by jobModelsFor with the gate's preview for the run's route (the default route, which carries this host's
 * policy), a tier with no model keeping today's setting so the request's own refusal names the way forward; the safety checkers by safetyCheckersFor.
 */
export function runModelsFor(input: {
  readonly models: ModelInfo[]; readonly chosen: ModelInfo | undefined; readonly author: string; readonly local: boolean; readonly host: string; readonly auto: boolean;
  readonly route?: SessionRoute; readonly read?: () => Readonly<Record<SettableJob, string>>; readonly now?: number;
}): RunModels {
  const now = input.now ?? Date.now();
  const route = input.route ?? defaultSessionRoute();
  let policyModels: ModelsSection | undefined;
  try { policyModels = route.routePolicy?.(now)?.models; } catch { policyModels = undefined; }
  const allows = gateAllows({ route, catalog: input.models, clientRoute: input.local ? 'local' : 'near', host: input.host, now });
  const read = input.read ?? readJobSettings;
  const jobs = jobModelsFor(input.models, allows, { read, ...(policyModels === undefined ? {} : { models: policyModels }), now });
  const today = readModelTiers();
  const tiers = { deep: jobs.deep.model ?? today.deep, standard: jobs.standard.model ?? today.standard, fast: jobs.fast.model ?? today.fast };
  if (!input.auto) return { tiers };
  const checkers = safetyCheckersFor({ models: input.models, chosen: input.chosen, author: input.author, configured: read().safety, allows, ...(policyModels === undefined ? {} : { policyModels }), now });
  return {
    tiers,
    ...(checkers.safetyModel === undefined ? {} : { safetyModel: checkers.safetyModel }),
    ...(checkers.safetyFallbackModel === undefined ? {} : { safetyFallbackModel: checkers.safetyFallbackModel }),
    ...(checkers.person === undefined ? {} : { safetyNotice: `Auto approve: ${checkers.person.reason} Commands the rules cannot decide will ask you.` })
  };
}
