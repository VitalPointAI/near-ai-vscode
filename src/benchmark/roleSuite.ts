// Running a team's roles against their own tasks, so a new team ends with models chosen from evidence (owner, 2026-11-08: "we should also run tests and
// set proper models for each role as a final step when a new team is added").
//
// Pure planning plus one runner: the plan says which runs will happen and roughly what they cost, so the studio can show the cost before starting, and
// the runner does them one at a time so a cancelled step leaves the finished results usable.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gradeRoleAnswer } from './roleGraders';
import { fallbackRoleTask, type RoleTask } from './roleTasks';
import { runAgentInFolder, type BenchmarkClient } from './runner';
import type { PermissionRules } from '../agent/permissions';

export interface RoleRun { member: string; role: string; model: string; task: RoleTask; written: boolean }
export interface RolePlan { runs: RoleRun[]; members: number; models: number; estimatedRuns: number }

/**
 * Which runs a team needs. Each member is measured on its own role's task with each candidate model, so the winner is the best model FOR THAT ROLE. A
 * member with no role uses its name, which is how a team member is addressed anyway.
 */
export function planRoleSuite(members: Array<{ name: string; role?: string }>, models: string[]): RolePlan {
  const runs: RoleRun[] = [];
  for (const member of members) {
    const role = member.role?.trim() || member.name;
    const { task, written } = fallbackRoleTask(role);
    for (const model of models) runs.push({ member: member.name, role, model, task, written });
  }
  return { runs, members: members.length, models: models.length, estimatedRuns: runs.length };
}

/** What one member's runs came to: the best model for its role, and every score, so the studio can show why. */
export interface RoleOutcome {
  member: string;
  role: string;
  /** The model with the best score, then the fastest; undefined when every run failed. */
  best?: string;
  /** The model it uses now, when the caller names it. */
  current?: string;
  results: Array<{ model: string; score: number; outOf: number; seconds: number; failed: boolean; misses: string[] }>;
  written: boolean;
}

export const bestOf = (outcomes: RoleOutcome[]): Array<{ member: string; role: string; model: string; current?: string; why: string }> =>
  outcomes.flatMap((outcome) => {
    if (!outcome.best) return [];
    const winner = outcome.results.find((result) => result.model === outcome.best) as { score: number; outOf: number; seconds: number };
    return [{
      member: outcome.member, role: outcome.role, model: outcome.best,
      ...(outcome.current ? { current: outcome.current } : {}),
      why: outcome.results.length === 1
        ? `the only model tested: ${winner.score}/${winner.outOf} on its role task`
        : `best on its role task (${winner.score}/${winner.outOf}), then the quickest of the best`
    }];
  });

export interface RoleSuiteOptions {
  clientFor(model: string): BenchmarkClient;
  rules: PermissionRules;
  signal: AbortSignal;
  /** The model each member uses now, so the studio can say what changed. */
  current?: (member: string) => string | undefined;
  onRun?(): void;
}

/** Runs the plan, one run at a time, and grades each answer from the files it left behind. */
export async function runRoleSuite(plan: RolePlan, options: RoleSuiteOptions): Promise<RoleOutcome[]> {
  const outcomes = new Map<string, RoleOutcome>();
  for (const run of plan.runs) {
    if (options.signal.aborted) break;
    options.onRun?.();
    const existing = outcomes.get(run.member) ?? { member: run.member, role: run.role, ...(options.current?.(run.member) ? { current: options.current(run.member) } : {}), results: [], written: run.written };
    const root = await mkdtemp(path.join(tmpdir(), 'near-ai-role-run-'));
    const started = Date.now();
    let score = 0;
    let outOf = 0;
    let misses: string[] = [];
    let failed = true;
    try {
      for (const [name, content] of Object.entries(run.task.files)) {
        await mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await writeFile(path.join(root, name), content);
      }
      // Each task declares a wall-clock limit, so one slow model cannot hold a whole team's tests open (0.4.19 review: it was set and never passed).
      const abort = new AbortController();
      const forward = () => abort.abort();
      if (options.signal.aborted) abort.abort();
      else options.signal.addEventListener('abort', forward, { once: true });
      const limit = setTimeout(() => abort.abort(), run.task.timeoutMs);
      let result: Awaited<ReturnType<typeof runAgentInFolder>>;
      try {
        result = await runAgentInFolder(options.clientFor(run.model), run.model, root, run.task.prompt, {
          maxTurns: run.task.maxTurns, signal: abort.signal, rules: options.rules
        });
      } finally {
        clearTimeout(limit);
        options.signal.removeEventListener('abort', forward);
      }
      const graded = gradeRoleAnswer(run.role, root, run.task.files, run.task.kind, run.task.role);
      score = graded.score;
      outOf = graded.outOf;
      misses = graded.misses;
      failed = result.outcome !== 'completed';
    } catch (error) {
      if (options.signal.aborted) break;
      misses = [(error as Error).message.slice(0, 160)];
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    existing.results.push({ model: run.model, score, outOf, seconds: Math.round((Date.now() - started) / 1000), failed, misses });
    // A failed run never wins, however good its partial score.
    const usable = existing.results.filter((result) => !result.failed && result.outOf > 0);
    existing.best = [...usable].sort((a, b) => (b.score / b.outOf) - (a.score / a.outOf) || a.seconds - b.seconds || a.model.localeCompare(b.model))[0]?.model;
    outcomes.set(run.member, existing);
  }
  return [...outcomes.values()];
}
