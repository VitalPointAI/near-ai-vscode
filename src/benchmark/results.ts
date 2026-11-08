import { createHash } from 'node:crypto';
import { isAbliteratedModel } from '../domain/cyberModel';
import { estimateCostUsd, type ModelInfo } from '../services/nearAiClient';
import { TASK_KINDS, type BenchmarkTask, type TaskKind, type TaskSetId } from './tasks';

// Results of model comparisons: the saved-run format, which earlier results a new comparison can
// reuse, the cost estimate before it starts, and the summaries, ranking, and leaderboard the
// Compare Models page shows. Pure: no I/O, no clock unless passed in, no VS Code.

export const RUN_FORMAT = 'near-ai-model-comparison';

/**
 * How one run of a task ended. `completed` and `max-turns` are the model's own result;
 * `timed-out` hit the per-task time limit; `stalled` means the model stopped responding (NEAR's
 * stream stalled or dropped through every retry); `over-budget` hit the per-run cost limit;
 * `failed` is any other error.
 */
export type RowOutcome = 'completed' | 'max-turns' | 'timed-out' | 'stalled' | 'over-budget' | 'failed';
const OUTCOMES: RowOutcome[] = ['completed', 'max-turns', 'timed-out', 'stalled', 'over-budget', 'failed'];
/** Outcomes that say something about the model; a stall or error may be NEAR's, so it is run again. */
const REUSABLE: RowOutcome[] = ['completed', 'max-turns', 'timed-out'];

export interface ResultRow {
  model: string;
  task: string;
  kind: TaskKind;
  taskVersion: string;
  /** 1-based run number of this model on this task within the comparison that produced it. */
  run: number;
  score: number;
  outOf: number;
  outcome: RowOutcome;
  seconds: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** Time spent streaming output (after each reply's first token), for tokens per second. */
  generatingMs: number;
  costUsd?: number;
  /** The cost is NEAR's estimate, not its billing figure. */
  costEstimated: boolean;
  /** Times the model stopped responding mid-reply and the turn was retried. */
  stalls: number;
  misses: string[];
  /** ISO time the run finished. */
  at: string;
  /** Set when the row was copied from an earlier comparison instead of being run again. */
  reusedFrom?: string;
}

export interface SavedModel { id: string; privacy: 'tee' | 'local' | 'forwarded' | 'unknown'; forwardedTo?: string; catalogVersion: string }

export interface SavedRun {
  format: typeof RUN_FORMAT;
  version: 1;
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'cancelled' | 'stopped';
  stopReason?: string;
  taskSet: TaskSetId;
  mode: RunMode;
  runsPerTask: number;
  models: SavedModel[];
  tasks: Array<{ id: string; kind: TaskKind; version: string }>;
  rows: ResultRow[];
}

/** `reuse`: run only what has no saved result for the current task version; `rerun`: run everything. */
export type RunMode = 'reuse' | 'rerun';

export function privacyOf(model: Pick<ModelInfo, 'privacyBoundary'> | undefined): SavedModel['privacy'] {
  return model?.privacyBoundary === 'tee' ? 'tee' : model?.privacyBoundary === 'local' ? 'local' : model?.privacyBoundary === 'cloud' ? 'forwarded' : 'unknown';
}

/** Changes when NEAR's catalog entry for the model changes (prices, privacy, context), so a saved run says which listing it ran against. */
export function catalogVersion(model: ModelInfo): string {
  const listed = { id: model.id, privacy: model.privacyBoundary, forwardedTo: model.forwardedTo, context: model.contextLength, input: model.inputPricePerMillion, output: model.outputPricePerMillion, cache: model.cachePricePerMillion, request: model.requestPricePerUnit };
  return createHash('sha256').update(JSON.stringify(listed)).digest('hex').slice(0, 12);
}

export function savedModel(model: ModelInfo): SavedModel {
  const privacy = privacyOf(model);
  return { id: model.id, privacy, ...(privacy === 'forwarded' && model.forwardedTo ? { forwardedTo: model.forwardedTo } : {}), catalogVersion: catalogVersion(model) };
}

/** A file-safe, sortable ID from the start time, e.g. 2026-10-30T14-05-09-120Z. */
export function runIdFor(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/;

/** The latest fresh (not reused) result of each model on each task version, across saved runs. */
export interface LatestResult { model: string; task: string; taskVersion: string; runId: string; at: string; rows: ResultRow[] }

const cellKey = (model: string, task: string, version: string) => `${model}\u0000${task}\u0000${version}`;

export function latestResults(runs: SavedRun[]): Map<string, LatestResult> {
  const groups = new Map<string, LatestResult>();
  for (const saved of runs) {
    const mine = new Map<string, LatestResult>();
    for (const row of saved.rows) {
      if (row.reusedFrom) continue;
      const key = cellKey(row.model, row.task, row.taskVersion);
      const group = mine.get(key) ?? { model: row.model, task: row.task, taskVersion: row.taskVersion, runId: saved.id, at: row.at, rows: [] };
      group.rows.push(row);
      if (row.at > group.at) group.at = row.at;
      mine.set(key, group);
    }
    for (const [key, group] of mine) {
      const known = groups.get(key);
      if (!known || group.at > known.at) groups.set(key, group);
    }
  }
  return groups;
}

export function latestFor(latest: Map<string, LatestResult>, model: string, task: string, version: string): LatestResult | undefined {
  return latest.get(cellKey(model, task, version));
}

/** A saved result counts for reuse when every run in it ended in a way that reflects the model, and there are enough runs. */
export function reusable(result: LatestResult | undefined, runsPerTask: number): result is LatestResult {
  return Boolean(result && result.rows.length >= runsPerTask && result.rows.every((row) => REUSABLE.includes(row.outcome)));
}

export interface PlanCell { model: string; task: string; reuse?: LatestResult }
export interface ComparisonPlan { cells: PlanCell[]; toRun: number; reusedCells: number }

/** What a comparison will run: in `reuse` mode, a model's saved result for the current task version is used instead of running it again. */
export function planComparison(models: string[], tasks: BenchmarkTask[], runsPerTask: number, mode: RunMode, latest: Map<string, LatestResult>): ComparisonPlan {
  const cells: PlanCell[] = [];
  for (const model of models) {
    for (const benchmark of tasks) {
      const saved = latestFor(latest, model, benchmark.id, benchmark.version);
      cells.push(mode === 'reuse' && reusable(saved, runsPerTask) ? { model, task: benchmark.id, reuse: saved } : { model, task: benchmark.id });
    }
  }
  const reusedCells = cells.filter((cell) => cell.reuse).length;
  return { cells, toRun: (cells.length - reusedCells) * runsPerTask, reusedCells };
}

export interface CostEstimate {
  /** Sum over runs whose model has prices; local models count as free. */
  usd: number;
  runs: number;
  reusedCells: number;
  /** Models with runs to do but no published prices: their cost is not in `usd`. */
  unpriced: string[];
  perModel: Array<{ model: string; runs: number; usd?: number }>;
}

export function estimateComparisonCost(plan: ComparisonPlan, tasks: BenchmarkTask[], runsPerTask: number, catalog: ModelInfo[]): CostEstimate {
  const perModel = new Map<string, { model: string; runs: number; usd?: number }>();
  const unpriced = new Set<string>();
  for (const cell of plan.cells) {
    const entry = perModel.get(cell.model) ?? { model: cell.model, runs: 0, usd: 0 };
    perModel.set(cell.model, entry);
    if (cell.reuse) continue;
    const benchmark = tasks.find((candidate) => candidate.id === cell.task);
    const info = catalog.find((candidate) => candidate.id === cell.model);
    entry.runs += runsPerTask;
    if (!benchmark) continue;
    const one = info?.privacyBoundary === 'local' ? 0 : info ? estimateCostUsd(info, benchmark.estimate.inputTokens, benchmark.estimate.outputTokens) : undefined;
    if (one === undefined) { unpriced.add(cell.model); entry.usd = undefined; } else if (entry.usd !== undefined) entry.usd += one * runsPerTask;
  }
  const models = [...perModel.values()];
  return { usd: models.reduce((sum, entry) => sum + (entry.usd ?? 0), 0), runs: plan.toRun, reusedCells: plan.reusedCells, unpriced: [...unpriced].filter((model) => (perModel.get(model)?.runs ?? 0) > 0), perModel: models };
}

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export interface TaskSummary { task: string; kind: TaskKind; taskVersion: string; runs: number; score: number; outOf: number; passes: number; medianSeconds?: number; tokPerSec?: number; costUsd?: number; failures: number; stalls: number; misses: string[]; at: string; reused: boolean }

export interface ModelSummary {
  model: string;
  rank: number;
  /** Average over tasks of each task's average score, out of 10; each task counts once, however many runs it had. */
  score: number;
  byKind: Partial<Record<TaskKind, { score: number; tasks: number; runs: number }>>;
  runs: number;
  passes: number;
  /** Share of runs with full marks, 0–1. */
  passRate: number;
  medianSeconds?: number;
  /** Output tokens per second of generation, over all runs. */
  tokPerSec?: number;
  costUsd?: number;
  costPerRunUsd?: number;
  costEstimated: boolean;
  /** Runs that ended stalled, failed, or over budget. */
  failures: number;
  /** Mid-reply stalls that were retried, over all runs. */
  stalls: number;
  lastTested?: string;
  tasks: TaskSummary[];
}

/** One model's summary over the rows given (any mix of tasks; each task averaged first). */
export function summarizeModel(model: string, rows: ResultRow[]): Omit<ModelSummary, 'rank'> {
  const mine = rows.filter((row) => row.model === model);
  const byTask = new Map<string, ResultRow[]>();
  for (const row of mine) byTask.set(row.task, [...(byTask.get(row.task) ?? []), row]);
  const tasks: TaskSummary[] = [...byTask.values()].map((list) => {
    const speed = speedOf(list);
    const costs = list.map((row) => row.costUsd).filter((value): value is number => value !== undefined);
    return {
      task: list[0].task, kind: list[0].kind, taskVersion: list[0].taskVersion, runs: list.length,
      score: round1(list.reduce((sum, row) => sum + (10 * row.score) / (row.outOf || 10), 0) / list.length), outOf: 10,
      passes: list.filter((row) => row.score >= row.outOf).length,
      ...(median(list.map((row) => row.seconds)) !== undefined ? { medianSeconds: median(list.map((row) => row.seconds)) } : {}),
      ...(speed !== undefined ? { tokPerSec: speed } : {}),
      ...(costs.length ? { costUsd: costs.reduce((sum, value) => sum + value, 0) } : {}),
      failures: list.filter((row) => isFailure(row.outcome)).length,
      stalls: list.reduce((sum, row) => sum + row.stalls, 0),
      misses: [...new Set(list.flatMap((row) => row.misses))],
      at: list.reduce((latest, row) => (row.at > latest ? row.at : latest), list[0].at),
      reused: list.every((row) => Boolean(row.reusedFrom))
    };
  });
  const byKind: ModelSummary['byKind'] = {};
  for (const kind of TASK_KINDS) {
    const list = tasks.filter((summary) => summary.kind === kind);
    if (list.length) byKind[kind] = { score: round1(list.reduce((sum, summary) => sum + summary.score, 0) / list.length), tasks: list.length, runs: list.reduce((sum, summary) => sum + summary.runs, 0) };
  }
  const costs = mine.map((row) => row.costUsd).filter((value): value is number => value !== undefined);
  const speed = speedOf(mine);
  const passes = mine.filter((row) => row.score >= row.outOf).length;
  const costUsd = costs.length ? costs.reduce((sum, value) => sum + value, 0) : undefined;
  return {
    model,
    score: tasks.length ? round1(tasks.reduce((sum, summary) => sum + summary.score, 0) / tasks.length) : 0,
    byKind, runs: mine.length, passes, passRate: mine.length ? passes / mine.length : 0,
    ...(median(mine.map((row) => row.seconds)) !== undefined ? { medianSeconds: median(mine.map((row) => row.seconds)) } : {}),
    ...(speed !== undefined ? { tokPerSec: speed } : {}),
    ...(costUsd !== undefined ? { costUsd, costPerRunUsd: costUsd / costs.length } : {}),
    costEstimated: mine.some((row) => row.costUsd !== undefined && row.costEstimated),
    failures: mine.filter((row) => isFailure(row.outcome)).length,
    stalls: mine.reduce((sum, row) => sum + row.stalls, 0),
    ...(mine.length ? { lastTested: mine.reduce((latest, row) => (row.at > latest ? row.at : latest), mine[0].at) } : {}),
    tasks: tasks.sort((a, b) => TASK_KINDS.indexOf(a.kind) - TASK_KINDS.indexOf(b.kind) || a.task.localeCompare(b.task))
  };
}

function isFailure(outcome: RowOutcome): boolean { return outcome === 'stalled' || outcome === 'failed' || outcome === 'over-budget'; }

function speedOf(rows: ResultRow[]): number | undefined {
  const output = rows.reduce((sum, row) => sum + row.outputTokens, 0);
  const ms = rows.reduce((sum, row) => sum + row.generatingMs, 0);
  return output && ms > 0 ? Math.round(output / (ms / 1000)) : undefined;
}

/**
 * Best first: the higher score; on a tie, the higher pass rate, then fewer failures, then the lower
 * cost per run (unknown cost last), then the faster median time. Equal models share a rank.
 */
export function rankSummaries<T extends Omit<ModelSummary, 'rank'>>(summaries: T[]): Array<T & { rank: number }> {
  const cost = (summary: T) => summary.costPerRunUsd ?? Number.POSITIVE_INFINITY;
  const order = (a: T, b: T) => b.score - a.score || b.passRate - a.passRate || (a.failures / Math.max(1, a.runs)) - (b.failures / Math.max(1, b.runs)) || cost(a) - cost(b) || (a.medianSeconds ?? Infinity) - (b.medianSeconds ?? Infinity);
  const sorted = [...summaries].sort((a, b) => order(a, b) || a.model.localeCompare(b.model));
  let rank = 0;
  return sorted.map((summary, index) => {
    if (index === 0 || order(sorted[index - 1], summary) !== 0) rank = index + 1;
    return { ...summary, rank };
  });
}

/** One comparison's results, ranked. */
export function summarizeRun(saved: SavedRun): ModelSummary[] {
  return rankSummaries(saved.models.map((model) => summarizeModel(model.id, saved.rows)));
}

export interface LeaderboardEntry extends ModelSummary {
  privacy: SavedModel['privacy'];
  forwardedTo?: string;
  inCatalog: boolean;
  /** Why this model's numbers may be out of date; empty when they are current. */
  stale: string[];
  /** Tasks of the current set it has no result for. */
  missingTasks: string[];
}

export const STALE_AFTER_DAYS = 30;

/**
 * Every model ever tested, ranked on its most recent result per task: the current task version
 * when it has one, else its latest result on an older version (marked stale). Tasks that no
 * longer exist are left out.
 */
export function buildLeaderboard(runs: SavedRun[], current: BenchmarkTask[], catalog: ModelInfo[], now: number, staleAfterDays = STALE_AFTER_DAYS): LeaderboardEntry[] {
  const all = [...latestResults(runs).values()];
  const known = new Map<string, SavedModel>();
  for (const saved of [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) for (const model of saved.models) known.set(model.id, model);
  const models = [...new Set(all.map((result) => result.model))];
  const entries = models.map((model) => {
    const rows: ResultRow[] = [];
    const olderVersions: string[] = [];
    const missingTasks: string[] = [];
    for (const benchmark of current) {
      const results = all.filter((result) => result.model === model && result.task === benchmark.id).sort((a, b) => b.at.localeCompare(a.at));
      const chosen = results.find((result) => result.taskVersion === benchmark.version) ?? results[0];
      if (!chosen) { missingTasks.push(benchmark.id); continue; }
      if (chosen.taskVersion !== benchmark.version) olderVersions.push(benchmark.id);
      rows.push(...chosen.rows);
    }
    const summary = summarizeModel(model, rows);
    const info = catalog.find((candidate) => candidate.id === model);
    const saved = known.get(model);
    const privacy = info ? privacyOf(info) : saved?.privacy ?? 'unknown';
    const forwardedTo = info ? info.forwardedTo : saved?.forwardedTo;
    const stale: string[] = [];
    if (olderVersions.length) stale.push(`Tested on an older version of: ${olderVersions.join(', ')}`);
    const age = summary.lastTested ? Math.floor((now - Date.parse(summary.lastTested)) / 86_400_000) : undefined;
    if (age !== undefined && age > staleAfterDays) stale.push(`Last tested ${age} days ago`);
    return { ...summary, privacy, ...(privacy === 'forwarded' && forwardedTo ? { forwardedTo } : {}), inCatalog: Boolean(info), stale, missingTasks };
  }).filter((entry) => entry.runs > 0);
  return rankSummaries(entries);
}

/**
 * The models worth testing again on the current tasks (owner, 2026-11-07: "enable the user to re-run them periodically as new models are released").
 * Three reasons to re-run one: its saved result is on an older version of a task, it was tested more than `staleAfterDays` ago, or it has no result for a
 * task in the set. `newModels` are catalog models with no result at all, which is what a release of a new model looks like here.
 */
export function needsRetest(leaderboard: LeaderboardEntry[], catalog: ModelInfo[], staleAfterDays = STALE_AFTER_DAYS): { retest: Array<{ model: string; why: string[] }>; newModels: string[] } {
  const tested = new Set(leaderboard.map((entry) => entry.model));
  const retest = leaderboard
    .filter((entry) => entry.inCatalog && (entry.stale.length > 0 || entry.missingTasks.length > 0))
    .map((entry) => ({ model: entry.model, why: [...entry.stale, ...(entry.missingTasks.length ? [`No result for: ${entry.missingTasks.join(', ')}`] : [])] }));
  const newModels = catalog.filter((entry) => !tested.has(entry.id) && isDelegable(entry)).map((entry) => entry.id);
  return { retest, newModels };
}

/** Whether a model can do the benchmark's work at all: text in, text out. */
function isDelegable(model: ModelInfo): boolean {
  const output = model.outputModalities ?? model.architectureOutputModalities;
  const input = model.inputModalities ?? model.architectureInputModalities;
  return (!output || output.includes('text')) && (!input || input.includes('text'));
}

/** Which model suits an agent role, and the tier the agents actually resolve against (src/services/agentSession.ts). `cyber` is the Cybersecurity engagement's own model. */
export type RecommendationTier = 'fast' | 'standard' | 'deep' | 'cyber';

export interface TierRecommendation {
  tier: RecommendationTier;
  /** The model this tier should use. */
  model: string;
  current?: string;
  /** Why this one, in the person's words. */
  why: string;
  score: number;
  seconds?: number;
  costUsd?: number;
  /** False when the model is already what the tier uses. */
  changes: boolean;
  /** The model's safety tuning was removed, which cyber work needs. */
  abliterated: boolean;
  /** Why the choice cannot be judged from these tasks alone, when that is so. */
  note?: string;
}

/**
 * The best model for each tier from one leaderboard (owner, 2026-11-07: "the optimal combination of models tested for each task is then implementable
 * by the user confirming with a button which changes all the models appropriately").
 *
 * Accuracy decides first, then time, then cost. Speed never wins on its own: a model that is 10% faster and 5% less accurate is not recommended, which is
 * the "fast and right" rule. Roles map to tiers the way agents resolve them: fast-tier roles are the mappers, researchers and synthesizer as the defaults
 * set them, standard is everything else, and deep is the tier Open-GSD's heavy roles ask for. Only models that were actually tested and are still in the
 * catalog are recommended, so this cannot pick something the key cannot run.
 */
export function recommendTiers(leaderboard: LeaderboardEntry[], current: { fast?: string; standard?: string; deep?: string; cyber?: string }): TierRecommendation[] {
  const usable = leaderboard.filter((entry) => entry.inCatalog && entry.runs > 0);
  if (!usable.length) return [];
  // A real ordering: accuracy first, then time, then cost. A comparator that only ever returned "a is better or equal" makes sort's result depend on
  // the input order, which is how a slower, less accurate model once reached the top.
  const rankOf = (entry: LeaderboardEntry): [number, number, number] => [-(Math.round(entry.score * 100) / 100), entry.medianSeconds ?? Number.POSITIVE_INFINITY, entry.costPerRunUsd ?? Number.POSITIVE_INFINITY];
  // A TOTAL order, so sort never depends on the input order: accuracy, then time, then cost, with no tolerance band inside the comparator (a band makes
  // the comparison non-transitive, so a > b and b > c but c > a, and sort's answer changes with the array's order). The "within half a point counts as
  // good enough" idea is applied AFTER sorting, when the near-best set is chosen.
  const best = (a: LeaderboardEntry, b: LeaderboardEntry): number => {
    const [scoreA, timeA, costA] = rankOf(a);
    const [scoreB, timeB, costB] = rankOf(b);
    if (scoreA !== scoreB) return scoreA - scoreB;
    if (timeA !== timeB) return timeA - timeB;
    return costA - costB;
  };
  // Each tier means something different, or "apply" would just point all three at one model:
  //   deep     the most accurate model, whatever it costs, because its work is the hardest;
  //   fast     the quickest model that is still close to the best, because it is called most;
  //   standard everything else, which wants the best value: the cheapest model that is still close.
  // "Close" is half a point out of ten, and it is a floor, not an average: a model must be that accurate to be considered at all, so speed and price
  // never buy a place on their own.
  const CLOSE = 0.5;
  const top = [...usable].sort(best)[0] as LeaderboardEntry;
  const near = usable.filter((entry) => entry.score >= top.score - CLOSE);
  const quickest = [...near].sort((a, b) => (a.medianSeconds ?? Number.POSITIVE_INFINITY) - (b.medianSeconds ?? Number.POSITIVE_INFINITY) || b.score - a.score || (a.costPerRunUsd ?? 0) - (b.costPerRunUsd ?? 0))[0] as LeaderboardEntry;
  const cheapest = [...near].sort((a, b) => (a.costPerRunUsd ?? Number.POSITIVE_INFINITY) - (b.costPerRunUsd ?? Number.POSITIVE_INFINITY) || b.score - a.score)[0] as LeaderboardEntry;
  const whyFor = (tier: RecommendationTier, entry: LeaderboardEntry): string => {
    if (tier === 'deep') return `the most accurate on these tasks (${entry.score.toFixed(1)}/10)`;
    if (tier === 'fast') return entry === top ? `the most accurate, so nothing closer was quicker (${entry.score.toFixed(1)}/10)` : `within ${CLOSE} of the best (${entry.score.toFixed(1)}/10) and the quickest at ${Math.round(entry.medianSeconds ?? 0)}s`;
    return entry === top ? `the most accurate, so it is also the best value (${entry.score.toFixed(1)}/10)` : `within ${CLOSE} of the best (${entry.score.toFixed(1)}/10) and the cheapest per task`;
  };
  const pick: Array<[RecommendationTier, LeaderboardEntry]> = [
    ['deep', top],
    ['standard', cheapest],
    ['fast', quickest]
  ];
  const recommendations: TierRecommendation[] = pick.map(([tier, entry]) => ({
    tier, model: entry.model, ...(current[tier] ? { current: current[tier] } : {}), why: whyFor(tier, entry),
    score: entry.score, ...(entry.medianSeconds !== undefined ? { seconds: entry.medianSeconds } : {}), ...(entry.costPerRunUsd !== undefined ? { costUsd: entry.costPerRunUsd } : {}),
    changes: current[tier] !== entry.model, abliterated: isAbliteratedModel(entry.model)
  }));
  // A Cybersecurity engagement sends exploits and payloads, which a safety-tuned model refuses or waters down, so "right" is only reachable on an
  // abliterated model (owner, 2026-11-07, and src/domain/cyberModel.ts which already runs scans that way). These tasks say nothing about refusal, so the
  // cyber model is chosen among the abliterated ones by the same accuracy-then-speed rule, and never handed a model that would refuse the work.
  const abliterated = usable.filter((entry) => isAbliteratedModel(entry.model));
  const cyberPick = [...abliterated].sort(best)[0];
  if (cyberPick) {
    recommendations.push({
      tier: 'cyber', model: cyberPick.model, ...(current.cyber ? { current: current.cyber } : {}),
      why: `it does not refuse the work, and scores ${cyberPick.score.toFixed(1)}/10 with the best speed among the abliterated models tested`,
      score: cyberPick.score, ...(cyberPick.medianSeconds !== undefined ? { seconds: cyberPick.medianSeconds } : {}), ...(cyberPick.costPerRunUsd !== undefined ? { costUsd: cyberPick.costPerRunUsd } : {}),
      changes: current.cyber !== cyberPick.model, abliterated: true,
      note: 'These tasks do not test refusal, so the cyber model is the best scoring abliterated model rather than a general winner.'
    });
  } else if (current.cyber) {
    // 0.4.19 review: with no abliterated model tested, the one in use is kept, and it may be safety-tuned. That is said plainly rather than presented as a
    // guarantee: the cyber model is only known to be abliterated when an abliterated model has actually been measured.
    const keepsAbliterated = isAbliteratedModel(current.cyber);
    recommendations.push({
      tier: 'cyber', model: current.cyber, current: current.cyber,
      why: keepsAbliterated ? 'no abliterated model has been tested here, so it keeps the one it uses now, which does not refuse' : 'no abliterated model has been tested here, so it keeps the one it uses now, which may refuse attack payloads',
      score: 0, changes: false, abliterated: keepsAbliterated,
      note: keepsAbliterated ? 'Test another abliterated model to compare it.' : 'Test an abliterated model and this stops being a guess. Until then the current model can refuse attack payloads, which fails the work rather than answering it wrongly.'
    });
  }
  return recommendations;
}

/**
 * The kind of work each agent role does, so a role is given the model that is best at THAT work rather than one blanket winner (owner, 2026-11-07:
 * "we also need to make sure that the teams are using the best models per role and not just defaulting to some overarching combination of models").
 * A role's kind is what its task is: a planner plans, an executor carries out, a researcher researches. Anything unlisted is judged on the overall score.
 */
const ROLE_KIND: Array<[RegExp, TaskKind]> = [
  [/plan|roadmap/i, 'planning'],
  [/research|synthesi|red-team/i, 'research'],
  [/execut|worker|implement/i, 'execution'],
  [/verif|review|debug|test/i, 'coding'],
  [/map|pattern/i, 'coding']
];

export function kindForRole(role: string): TaskKind | undefined {
  return ROLE_KIND.find(([pattern]) => pattern.test(role))?.[1];
}

export interface RoleRecommendation {
  /** The Agent role key as nearAi.agent.roleModels holds it (an exact name or a * pattern). */
  role: string;
  /** The setting it writes, and the model. */
  setting: string;
  model: string;
  current?: string;
  kind?: TaskKind;
  /** The score on that kind, and on everything when the role has no kind. */
  score: number;
  seconds?: number;
  costUsd?: number;
  changes: boolean;
  abliterated: boolean;
  why: string;
}

/**
 * The best model for each role, from its own kind's results. A role is only given a model that was actually tested on that kind (when any was), so a
 * planner gets the best planner rather than a model that happened to win overall. Roles already on the recommended model are returned with
 * `changes: false`, so the person sees the whole setup and the button only writes what is different.
 *
 * Ties are broken by time and then cost, never by speed alone: a model must be as accurate as the best for that kind.
 */
export function recommendRoles(leaderboard: LeaderboardEntry[], roles: Array<{ id: string; current?: string }>): RoleRecommendation[] {
  const usable = leaderboard.filter((entry) => entry.inCatalog && entry.runs > 0);
  const recommendations: RoleRecommendation[] = [];
  for (const option of roles) {
    const role = option.id.startsWith('role:') ? option.id.slice(5) : option.id;
    const kind = kindForRole(role);
    const scored = usable.map((entry) => {
      const part = kind ? entry.byKind[kind] : undefined;
      return { entry, score: part ? part.score : entry.score, measured: Boolean(part) };
    }).filter((candidate) => !kind || candidate.measured || usable.every((other) => !other.byKind[kind!]));
    if (!scored.length) continue;
    const best = Math.max(...scored.map((candidate) => candidate.score));
    const tied = scored.filter((candidate) => candidate.score >= best - 0.05);
    const pick = [...tied].sort((a, b) => (a.entry.medianSeconds ?? Number.POSITIVE_INFINITY) - (b.entry.medianSeconds ?? Number.POSITIVE_INFINITY) || (a.entry.costPerRunUsd ?? 0) - (b.entry.costPerRunUsd ?? 0))[0] as { entry: LeaderboardEntry; score: number };
    recommendations.push({
      role, setting: 'agent.roleModels', model: pick.entry.model,
      ...(option.current ? { current: option.current } : {}),
      ...(kind ? { kind } : {}),
      score: pick.score,
      ...(pick.entry.medianSeconds !== undefined ? { seconds: pick.entry.medianSeconds } : {}),
      ...(pick.entry.costPerRunUsd !== undefined ? { costUsd: pick.entry.costPerRunUsd } : {}),
      changes: option.current !== pick.entry.model,
      abliterated: isAbliteratedModel(pick.entry.model),
      why: kind
        ? `best at ${kind} work (${pick.score.toFixed(1)}/10 on those tasks)`
        : `best overall (${pick.score.toFixed(1)}/10)`
    });
  }
  return recommendations;
}

/**
 * Model performance over time (owner, 2026-11-07: "keeping track of and visualizing model performance over time ... a line graph with percentage
 * score on y axis and time on x axis", and "categorize the results by type of task"). One point per day on which comparisons ran, using only that day's
 * fresh results, so a reused copy from an older comparison never looks like progress. `overall` is every task; `byKind` keeps coding, research,
 * planning and execution apart, because a change can help one and hurt another. Percent is score out of the maximum, which is how the page shows it.
 */
export interface TrendPoint { date: string; percent: number; runs: number }
export interface TrendSeries { name: string; kind?: TaskKind; points: TrendPoint[] }

const TREND_KINDS: TaskKind[] = ['coding', 'research', 'planning', 'execution'];

export function performanceTrend(runs: SavedRun[]): { overall: TrendPoint[]; byKind: Array<{ kind: TaskKind; points: TrendPoint[] }> } {
  // Day by day, fresh rows only, and one average per model per day so a model tested five times does not outweigh one tested once.
  const byDate = new Map<string, ResultRow[]>();
  for (const saved of runs) {
    for (const row of saved.rows) {
      if (row.reusedFrom) continue;
      const date = row.at.slice(0, 10);
      byDate.set(date, [...(byDate.get(date) ?? []), row]);
    }
  }
  const pointFor = (rows: ResultRow[]): TrendPoint | undefined => {
    const scored = rows.filter((row) => row.outOf > 0);
    if (!scored.length) return undefined;
    const total = scored.reduce((sum, row) => sum + row.score / row.outOf, 0);
    return { date: '', percent: Math.round((100 * total) / scored.length), runs: scored.length };
  };
  const dates = [...byDate.keys()].sort();
  const overall: TrendPoint[] = [];
  const byKind = new Map<TaskKind, TrendPoint[]>(TREND_KINDS.map((kind) => [kind, []]));
  for (const date of dates) {
    const rows = byDate.get(date) ?? [];
    const all = pointFor(rows);
    if (all) overall.push({ ...all, date });
    for (const kind of TREND_KINDS) {
      const point = pointFor(rows.filter((row) => row.kind === kind));
      if (point) byKind.get(kind)?.push({ ...point, date });
    }
  }
  return { overall, byKind: TREND_KINDS.map((kind) => ({ kind, points: byKind.get(kind) ?? [] })).filter((entry) => entry.points.length > 0) };
}

/** A row copied from a saved result into a new comparison, marked as reused. */
export function reusedRows(result: LatestResult): ResultRow[] {
  return result.rows.map((row) => ({ ...row, reusedFrom: result.runId }));
}

// ---- reading saved runs back ----

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parseRow(value: unknown): ResultRow | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (!isString(row.model) || !isString(row.task) || !TASK_KINDS.includes(row.kind as TaskKind) || !isString(row.taskVersion) || !OUTCOMES.includes(row.outcome as RowOutcome) || !isString(row.at)) return undefined;
  for (const key of ['run', 'score', 'outOf', 'seconds', 'turns', 'inputTokens', 'outputTokens', 'generatingMs', 'stalls']) if (!isNumber(row[key])) return undefined;
  if (row.costUsd !== undefined && !isNumber(row.costUsd)) return undefined;
  return {
    model: row.model, task: row.task, kind: row.kind as TaskKind, taskVersion: row.taskVersion, run: row.run as number, score: row.score as number, outOf: row.outOf as number,
    outcome: row.outcome as RowOutcome, seconds: row.seconds as number, turns: row.turns as number, inputTokens: row.inputTokens as number, outputTokens: row.outputTokens as number,
    generatingMs: row.generatingMs as number, ...(row.costUsd !== undefined ? { costUsd: row.costUsd as number } : {}), costEstimated: row.costEstimated === true,
    stalls: row.stalls as number, misses: Array.isArray(row.misses) ? row.misses.filter(isString) : [], at: row.at, ...(isString(row.reusedFrom) ? { reusedFrom: row.reusedFrom } : {})
  };
}

/** A saved comparison read back from disk; undefined when it is not one (or is damaged). Unreadable rows are dropped. */
export function parseSavedRun(text: string): SavedRun | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  const run = value as Record<string, unknown>;
  if (run.format !== RUN_FORMAT || run.version !== 1 || !isString(run.id) || !RUN_ID.test(run.id) || !isString(run.startedAt)) return undefined;
  if (!['running', 'completed', 'cancelled', 'stopped'].includes(run.status as string) || !['full', 'short'].includes(run.taskSet as string) || !['reuse', 'rerun'].includes(run.mode as string) || !isNumber(run.runsPerTask)) return undefined;
  const models = Array.isArray(run.models) ? run.models.filter((model): model is SavedModel => Boolean(model) && isString((model as SavedModel).id) && ['tee', 'local', 'forwarded', 'unknown'].includes((model as SavedModel).privacy) && isString((model as SavedModel).catalogVersion)) : [];
  const tasks = Array.isArray(run.tasks) ? run.tasks.filter((entry): entry is SavedRun['tasks'][number] => Boolean(entry) && isString((entry as { id: unknown }).id) && TASK_KINDS.includes((entry as { kind: TaskKind }).kind) && isString((entry as { version: unknown }).version)) : [];
  const rows = Array.isArray(run.rows) ? run.rows.map(parseRow).filter((row): row is ResultRow => Boolean(row)) : [];
  return {
    format: RUN_FORMAT, version: 1, id: run.id, startedAt: run.startedAt, ...(isString(run.finishedAt) ? { finishedAt: run.finishedAt } : {}),
    // A run still marked running was cut off (VS Code closed): it is shown as stopped.
    status: run.status === 'running' ? 'stopped' : run.status as SavedRun['status'], ...(isString(run.stopReason) ? { stopReason: run.stopReason } : run.status === 'running' ? { stopReason: 'VS Code closed before it finished.' } : {}),
    taskSet: run.taskSet as TaskSetId, mode: run.mode as RunMode, runsPerTask: run.runsPerTask, models: models.map((model) => ({ id: model.id, privacy: model.privacy, ...(isString(model.forwardedTo) ? { forwardedTo: model.forwardedTo } : {}), catalogVersion: model.catalogVersion })),
    tasks: tasks.map((entry) => ({ id: entry.id, kind: entry.kind, version: entry.version })), rows
  };
}

export function serializeRun(saved: SavedRun): string {
  return `${JSON.stringify(saved, null, 2)}\n`;
}
