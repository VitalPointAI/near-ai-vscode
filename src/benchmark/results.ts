import { createHash } from 'node:crypto';
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
