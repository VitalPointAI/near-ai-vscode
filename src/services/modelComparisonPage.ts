import { buildLeaderboard, catalogVersion, privacyOf, RUN_ID, summarizeRun, type CostEstimate, type ComparisonPlan, type LeaderboardEntry, type ModelSummary, type RunMode, type SavedRun } from '../benchmark/results';
import { TASK_SETS, tasksFor, type BenchmarkTask, type TaskSetId } from '../benchmark/tasks';
import { isChatModel } from './chatBridge';
import { heldRoles, type RoleOption } from './modelRoles';
import type { ModelInfo } from './nearAiClient';

// The Compare Models page: what the host sends it and accepts from it. Everything here is
// computed from saved comparisons, the key's model catalog, and the role settings; the page
// renders it with textContent. No VS Code imports, so the tests run it directly.

export const MIN_MODELS = 2;
export const MAX_MODELS = 6;
export const MAX_RUNS_PER_TASK = 3;

export interface CatalogEntry { id: string; privacy: ReturnType<typeof privacyOf>; privacyText: string; inputPerMillion?: number; outputPerMillion?: number; holds: string[]; blocked?: string }
export interface HistoryEntry { id: string; startedAt: string; status: SavedRun['status']; stopReason?: string; taskSet: TaskSetId; mode: RunMode; runsPerTask: number; models: string[]; ran: number; reused: number; costUsd?: number }
export interface LeaderboardRow extends LeaderboardEntry { holds: string[] }

export interface PageState {
  leaderboard: LeaderboardRow[];
  catalog: CatalogEntry[];
  /** Pre-selected: the models the main chat and tiers use now. */
  selected: string[];
  roles: RoleOption[];
  taskSets: Array<{ id: TaskSetId; label: string; description: string; tasks: Array<{ id: string; label: string; kind: string }> }>;
  history: HistoryEntry[];
  running?: { runId: string };
  teeOnly: boolean;
  problem?: string;
}

const PRIVACY_TEXT: Record<CatalogEntry['privacy'], string> = { tee: 'Private: runs in NEAR’s TEE', local: 'Local: runs on this machine', forwarded: 'Forwarded: not private', unknown: 'Privacy unknown' };

export function privacyText(privacy: CatalogEntry['privacy'], forwardedTo?: string): string {
  return privacy === 'forwarded' && forwardedTo ? `Forwarded to ${forwardedTo}: not private` : PRIVACY_TEXT[privacy];
}

export function catalogEntries(models: ModelInfo[], roles: RoleOption[], teeOnly: boolean): CatalogEntry[] {
  const rank = (entry: CatalogEntry) => (entry.holds.length ? 0 : entry.privacy === 'tee' || entry.privacy === 'local' ? 1 : 2);
  return models.filter(isChatModel).map((model) => {
    const privacy = privacyOf(model);
    return {
      id: model.id, privacy, privacyText: privacyText(privacy, model.forwardedTo),
      ...(model.inputPricePerMillion !== undefined ? { inputPerMillion: model.inputPricePerMillion } : {}),
      ...(model.outputPricePerMillion !== undefined ? { outputPerMillion: model.outputPricePerMillion } : {}),
      holds: heldRoles(model.id, roles).filter((label) => !label.includes('(')),
      ...(teeOnly && privacy !== 'tee' && privacy !== 'local' ? { blocked: 'TEE-only mode is on, so models that are not private cannot be tested.' } : {})
    };
  }).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/** The main model and the three tiers, as many as the catalog offers (and the privacy mode allows), without repeats. */
export function defaultSelection(roles: RoleOption[], catalog: CatalogEntry[]): string[] {
  const usable = new Set(catalog.filter((entry) => !entry.blocked).map((entry) => entry.id));
  return [...new Set(roles.filter((role) => role.group !== 'Agent roles').map((role) => role.current).filter((model): model is string => Boolean(model && usable.has(model))))].slice(0, MAX_MODELS);
}

export function historyEntries(runs: SavedRun[]): HistoryEntry[] {
  return runs.map((saved) => {
    const fresh = saved.rows.filter((row) => !row.reusedFrom);
    const costs = fresh.map((row) => row.costUsd).filter((value): value is number => value !== undefined);
    return {
      id: saved.id, startedAt: saved.startedAt, status: saved.status, ...(saved.stopReason ? { stopReason: saved.stopReason } : {}), taskSet: saved.taskSet, mode: saved.mode, runsPerTask: saved.runsPerTask,
      models: saved.models.map((model) => model.id), ran: fresh.length, reused: saved.rows.length - fresh.length,
      ...(costs.length ? { costUsd: costs.reduce((sum, value) => sum + value, 0) } : {})
    };
  });
}

export function leaderboardRows(runs: SavedRun[], tasks: BenchmarkTask[], catalog: ModelInfo[], roles: RoleOption[], now: number): LeaderboardRow[] {
  return buildLeaderboard(runs, tasks, catalog, now).map((entry) => ({ ...entry, holds: heldRoles(entry.model, roles) }));
}

export function taskSetsView(tasks: BenchmarkTask[]): PageState['taskSets'] {
  return (Object.keys(TASK_SETS) as TaskSetId[]).map((id) => ({ ...TASK_SETS[id], tasks: tasksFor(id, tasks).map((task) => ({ id: task.id, label: task.label, kind: task.kind })) }));
}

/** What the page shows next to the estimate: which cells reuse a saved result, and from when. */
export function estimateView(plan: ComparisonPlan, estimate: CostEstimate): { estimate: CostEstimate; reused: Array<{ model: string; task: string; at: string; runId: string }> } {
  return { estimate, reused: plan.cells.filter((cell) => cell.reuse).map((cell) => ({ model: cell.model, task: cell.task, at: cell.reuse!.at, runId: cell.reuse!.runId })) };
}

/** A saved comparison for the page: the run and its ranked per-model summaries, with whether each model's catalog listing changed since. */
export function reportView(saved: SavedRun, catalog: ModelInfo[], roles: RoleOption[]): { run: SavedRun; summary: Array<ModelSummary & { holds: string[]; privacy: string; privacyText: string; catalogChanged: boolean; inCatalog: boolean }> } {
  return {
    run: saved,
    summary: summarizeRun(saved).map((summary) => {
      const listed = saved.models.find((model) => model.id === summary.model);
      const info = catalog.find((model) => model.id === summary.model);
      return { ...summary, holds: heldRoles(summary.model, roles), privacy: listed?.privacy ?? 'unknown', privacyText: privacyText(listed?.privacy ?? 'unknown', listed?.forwardedTo), inCatalog: Boolean(info), catalogChanged: Boolean(info && listed && catalogVersion(info) !== listed.catalogVersion) };
    })
  };
}

export interface Selection { models: string[]; taskSet: TaskSetId; mode: RunMode; runs: number }

export type ComparisonPageMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | ({ type: 'plan' } & Selection)
  | ({ type: 'start' } & Selection)
  | { type: 'cancel' }
  | { type: 'open-run'; id: string }
  | { type: 'export'; id: string }
  | { type: 'apply-role'; model: string; role: string }
  | { type: 'undo-role'; token: string };

const MODEL_ID = /^[\w.:@+/-]{1,200}$/;
const ROLE_ID = /^(?:main|tier:(?:deep|standard|fast)|role:[\w*.:-]{1,120})$/;

function selection(message: Record<string, unknown>): Selection | undefined {
  const { models, taskSet, mode, runs } = message;
  if (!Array.isArray(models) || models.length > MAX_MODELS || !models.every((model) => typeof model === 'string' && MODEL_ID.test(model))) return undefined;
  if (taskSet !== 'full' && taskSet !== 'short') return undefined;
  if (mode !== 'reuse' && mode !== 'rerun') return undefined;
  if (typeof runs !== 'number' || !Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS_PER_TASK) return undefined;
  return { models: [...new Set(models as string[])], taskSet, mode, runs };
}

/** Validates a message from the page; anything else is ignored. */
export function parseComparisonMessage(value: unknown): ComparisonPageMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  const keys = Object.keys(message);
  const only = (...allowed: string[]) => keys.every((key) => key === 'type' || allowed.includes(key));
  switch (message.type) {
    case 'ready': case 'refresh': case 'cancel': return only() ? { type: message.type } : undefined;
    case 'plan': case 'start': {
      const picked = only('models', 'taskSet', 'mode', 'runs') ? selection(message) : undefined;
      return picked ? { type: message.type, ...picked } : undefined;
    }
    case 'open-run': case 'export': return only('id') && typeof message.id === 'string' && RUN_ID.test(message.id) ? { type: message.type, id: message.id } : undefined;
    case 'apply-role': return only('model', 'role') && typeof message.model === 'string' && MODEL_ID.test(message.model) && typeof message.role === 'string' && ROLE_ID.test(message.role) ? { type: 'apply-role', model: message.model, role: message.role } : undefined;
    case 'undo-role': return only('token') && typeof message.token === 'string' && /^[a-f0-9]{16}$/.test(message.token) ? { type: 'undo-role', token: message.token } : undefined;
    default: return undefined;
  }
}

/** Why a selection cannot start, in plain words; undefined when it can. */
export function selectionProblem(models: string[], catalog: CatalogEntry[]): string | undefined {
  if (models.length < MIN_MODELS) return `Choose at least ${MIN_MODELS} models to compare.`;
  if (models.length > MAX_MODELS) return `Choose at most ${MAX_MODELS} models.`;
  const missing = models.filter((model) => !catalog.some((entry) => entry.id === model));
  if (missing.length) return `Not in your key’s model list: ${missing.join(', ')}.`;
  const blocked = models.filter((model) => catalog.find((entry) => entry.id === model)?.blocked);
  if (blocked.length) return `TEE-only mode is on, so these cannot be tested: ${blocked.join(', ')}.`;
  return undefined;
}

/** The page's HTML: one nonce script and one stylesheet, everything else rendered by the script with textContent. */
export function comparisonPageHtml(options: { cspSource: string; nonce: string; script: string; style: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource}; script-src 'nonce-${options.nonce}';">
<link rel="stylesheet" href="${options.style}"><title>Compare Models</title></head><body>
<header class="top"><div><h1>Compare Models</h1><p class="hint">Test NEAR AI models on the same coding, research, and planning tasks, graded automatically, and put the best one to work.</p></div>
<div class="actions"><button id="refresh" type="button" class="secondary">Refresh</button></div></header>
<p id="problem" class="error" role="alert" hidden></p>
<div id="notice" class="notice" role="status" aria-live="polite" hidden></div>
<main>
<section aria-labelledby="board-title"><div class="section-head"><h2 id="board-title">Leaderboard</h2></div>
<p class="hint">Every model tested on this computer, ranked on its latest result for each task. Scores are out of 10.</p><div id="board"><p class="hint">Loading…</p></div></section>
<section aria-labelledby="run-title"><h2 id="run-title">Run a comparison</h2><div id="setup"></div><div id="progress" hidden></div></section>
<section aria-labelledby="results-title" id="results-section" hidden><div class="section-head"><h2 id="results-title">Results</h2><div class="actions" id="results-actions"></div></div><div id="results"></div></section>
<section aria-labelledby="history-title"><h2 id="history-title">Past comparisons</h2><div id="history"></div></section>
</main>
<script nonce="${options.nonce}" src="${options.script}"></script></body></html>`;
}
