import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { UsageMetadata } from '../services/nearAiClient';
import { executionTaskFiles, gradeExecution, loadExecutionTasks, runNode, setUpExecutionTask, type ExecutionTask } from './execution';
import { gradePlan, gradeResearch, PLAN_PROMPT, PLAN_SPEC, RESEARCH_PROMPT, RESEARCH_SOURCES } from './graders';

// The benchmark's tasks, how each is set up and graded, and what one run of it measures. One list
// for the live eval (src/test/live.test.ts) and NEAR AI: Compare Models, so both score models the
// same way. No VS Code imports.

export type TaskKind = 'coding' | 'research' | 'planning' | 'execution';
export const TASK_KINDS: TaskKind[] = ['coding', 'research', 'planning', 'execution'];

/**
 * Bump a kind's grader version whenever its grading changes, so results graded the old way are never
 * reused or ranked as current. Task text and fixture files are hashed into the version by themselves.
 */
const GRADER_VERSIONS: Record<TaskKind, number> = { coding: 1, research: 1, planning: 1, execution: 1 };

export const CODING_TASKS: Array<{ name: string; files: Record<string, string>; prompt: string }> = [
  {
    name: 'implement',
    files: { 'slug.js': 'module.exports = function slugify(text) {\n  throw new Error("not implemented");\n};\n', 'slug.test.js': 'const test = require("node:test");\nconst assert = require("node:assert");\nconst slugify = require("./slug");\ntest("slugify", () => {\n  assert.equal(slugify("Hello, World!"), "hello-world");\n  assert.equal(slugify("  Many   spaces  "), "many-spaces");\n  assert.equal(slugify("Ünïcödé café"), "unicode-cafe");\n  assert.equal(slugify("---"), "");\n});\n' },
    prompt: 'Implement slugify in slug.js so `node --test` passes. Do not change the test.'
  },
  {
    name: 'fix-bug',
    files: { 'cart.js': 'function total(items, discount) {\n  let sum = 0;\n  for (let i = 1; i < items.length; i++) sum += items[i].price * items[i].qty;\n  return discount ? sum - sum * discount : sum;\n}\nmodule.exports = { total };\n', 'cart.test.js': 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { total } = require("./cart");\ntest("total", () => {\n  assert.equal(total([{ price: 2, qty: 3 }, { price: 1, qty: 1 }]), 7);\n  assert.equal(total([{ price: 10, qty: 1 }], 0.1), 9);\n  assert.equal(total([]), 0);\n});\n' },
    prompt: 'The tests in cart.test.js fail. Find and fix the bug in cart.js; run `node --test` to confirm.'
  },
  {
    name: 'refactor',
    files: { 'a.js': 'const { fetchUser } = require("./api");\nmodule.exports = (id) => fetchUser(id).name;\n', 'b.js': 'const { fetchUser } = require("./api");\nmodule.exports = (id) => fetchUser(id).email;\n', 'api.js': 'exports.fetchUser = (id) => ({ id, name: "n" + id, email: id + "@x" });\n', 'rename.test.js': 'const test = require("node:test");\nconst assert = require("node:assert");\ntest("renamed", () => {\n  const api = require("./api");\n  assert.equal(typeof api.getUser, "function");\n  assert.equal(api.fetchUser, undefined);\n  assert.equal(require("./a")(1), "n1");\n  assert.equal(require("./b")(2), "2@x");\n});\n' },
    prompt: 'Rename fetchUser to getUser everywhere (api.js and every caller) so `node --test` passes.'
  }
];

export interface BenchmarkTask {
  id: string;
  kind: TaskKind;
  /** A short plain-English name for tables. */
  label: string;
  prompt: string;
  /** Files written into the task's folder before the model starts. */
  files: Record<string, string>;
  execution?: ExecutionTask;
  /** The agent's turn limit (the live eval's limits). */
  maxTurns: number;
  /** How long one run may take in Compare Models before it is stopped and graded as it stands. */
  timeoutMs: number;
  /**
   * Tokens one run typically uses, for the cost estimate before a comparison: a rough guess from
   * earlier runs (input counts every turn's whole context again), not a limit.
   */
  estimate: { inputTokens: number; outputTokens: number };
  /** Changes whenever the task's text, files, hidden tests, or grader change. */
  version: string;
}

const LABELS: Record<string, string> = {
  implement: 'Write a function to pass its tests',
  'fix-bug': 'Find and fix a bug',
  refactor: 'Rename across files',
  'research-brief': 'Research brief from sources',
  'phase-plan': 'Plan from a spec',
  'execute-plan': 'Carry out a plan in a project',
  'issue-fix': 'Fix a reported issue in a project',
  'spec-implement': 'Build from a spec in a project'
};

const ESTIMATES: Record<TaskKind, BenchmarkTask['estimate']> = {
  coding: { inputTokens: 60_000, outputTokens: 3_000 },
  research: { inputTokens: 50_000, outputTokens: 4_000 },
  planning: { inputTokens: 30_000, outputTokens: 4_000 },
  execution: { inputTokens: 400_000, outputTokens: 15_000 }
};

export function taskVersion(kind: TaskKind, prompt: string, files: Record<string, string>): string {
  const hash = createHash('sha256').update(JSON.stringify({ kind, grader: GRADER_VERSIONS[kind], prompt, files: Object.entries(files).sort(([a], [b]) => a.localeCompare(b)) }));
  return hash.digest('hex').slice(0, 12);
}

function task(id: string, kind: TaskKind, prompt: string, files: Record<string, string>, versionFiles = files, execution?: ExecutionTask): BenchmarkTask {
  return {
    id, kind, label: LABELS[id] ?? id, prompt, files, ...(execution ? { execution } : {}),
    maxTurns: kind === 'execution' ? 50 : 30,
    timeoutMs: (kind === 'execution' ? 25 : 10) * 60_000,
    estimate: ESTIMATES[kind],
    version: taskVersion(kind, prompt, versionFiles)
  };
}

/** Every task, in the order the live eval has always run them. */
export async function loadBenchmarkTasks(fixtures?: string): Promise<BenchmarkTask[]> {
  const executions = await loadExecutionTasks(fixtures);
  return [
    ...CODING_TASKS.map((coding) => task(coding.name, 'coding', coding.prompt, coding.files)),
    task('research-brief', 'research', RESEARCH_PROMPT, RESEARCH_SOURCES),
    task('phase-plan', 'planning', PLAN_PROMPT, { 'spec.md': PLAN_SPEC }),
    // Building from a plan, an issue, or a spec in a multi-file project, scored by acceptance tests the model never sees.
    ...await Promise.all(executions.map(async (execution) => task(execution.name, 'execution', execution.prompt, {}, await executionTaskFiles(execution), execution)))
  ];
}

export type TaskSetId = 'full' | 'short';

export const TASK_SETS: Record<TaskSetId, { id: TaskSetId; label: string; description: string }> = {
  full: { id: 'full', label: 'Full set', description: 'All 8 tasks: coding, a research brief, a plan, and three small projects graded by tests the model never sees.' },
  short: { id: 'short', label: 'Short set', description: 'The 4 quickest tasks: three small coding tasks and a plan. Cheaper, but says less about larger work.' }
};

/** The tasks of a set; the short set leaves out the research brief and the project tasks. */
export function tasksFor(set: TaskSetId, all: BenchmarkTask[]): BenchmarkTask[] {
  return set === 'full' ? all : all.filter((candidate) => candidate.kind === 'coding' || candidate.kind === 'planning');
}

/** Writes the task's starting files into `root` (a fresh folder outside any workspace). */
export async function setUpTask(benchmark: BenchmarkTask, root: string): Promise<void> {
  for (const [name, content] of Object.entries(benchmark.files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); }
  if (benchmark.execution) await setUpExecutionTask(benchmark.execution, root);
}

/** Scores what the model left in `root`, out of 10. */
export async function gradeTask(benchmark: BenchmarkTask, root: string, signal?: AbortSignal): Promise<{ score: number; outOf: number; misses: string[] }> {
  if (benchmark.execution) {
    const { score, misses } = await gradeExecution(benchmark.execution, root, signal);
    return { score, outOf: 10, misses };
  }
  if (benchmark.kind === 'coding') {
    // Passing only counts if the tests are the ones it was given.
    const changed = [];
    for (const [name, content] of Object.entries(benchmark.files)) if (/\.test\.js$/.test(name) && await readFile(path.join(root, name), 'utf8').catch(() => '') !== content) changed.push(name);
    const misses = changed.length ? [`changed the test: ${changed.join(', ')}`] : (await runNode(['--test'], root, {}, 120_000, signal)).status !== 0 ? ['tests fail'] : [];
    return { score: misses.length ? 0 : 10, outOf: 10, misses };
  }
  const file = path.join(root, benchmark.kind === 'research' ? 'brief.md' : 'PLAN.md');
  const text = await readFile(file, 'utf8').catch(() => '');
  const graded = text ? (benchmark.kind === 'research' ? gradeResearch(text) : gradePlan(text)) : { score: 0, misses: [`no ${path.basename(file)} written`] };
  return { ...graded, outOf: 10 };
}

export interface RunMetrics { turns: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; cachePct: number; generatingMs: number; tokPerSec?: number }

/** Token counts and generation speed for one run's model turns. */
export function runMetrics(usage: UsageMetadata[]): RunMetrics {
  const inputTokens = usage.reduce((sum, turn) => sum + (turn.inputTokens ?? 0), 0);
  const cachedInputTokens = usage.reduce((sum, turn) => sum + (turn.cachedInputTokens ?? 0), 0);
  const outputTokens = usage.reduce((sum, turn) => sum + (turn.outputTokens ?? 0), 0);
  // Generation speed, not counting the wait for each reply's first token.
  const generatingMs = usage.reduce((sum, turn) => sum + Math.max(0, turn.latencyMs - (turn.firstTokenMs ?? 0)), 0);
  return {
    turns: usage.length, inputTokens, cachedInputTokens, outputTokens, generatingMs,
    cachePct: inputTokens ? Math.round((100 * cachedInputTokens) / inputTokens) : 0,
    ...(generatingMs > 0 && outputTokens ? { tokPerSec: Math.round(outputTokens / (generatingMs / 1000)) } : {})
  };
}

/** NEAR's actual cost for the turns when its billing API knows them, else the sum of the estimates. */
export async function costOf(client: { actualCostsUsd?(requestIds: string[]): Promise<number | undefined> }, usage: UsageMetadata[]): Promise<{ usd?: number; estimated: boolean }> {
  const ids = usage.map((turn) => turn.requestId!).filter(Boolean);
  const actual = ids.length && client.actualCostsUsd ? await client.actualCostsUsd(ids).catch(() => undefined) : undefined;
  const estimated = usage.reduce((sum, turn) => sum + (turn.estimatedCostUsd ?? 0), 0);
  return { usd: actual ?? (estimated > 0 ? estimated : undefined), estimated: actual === undefined };
}
