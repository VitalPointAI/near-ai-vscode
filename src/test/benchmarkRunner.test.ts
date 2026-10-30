import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { planComparison, type ResultRow } from '../benchmark/results';
import { runComparison, type BenchmarkClient } from '../benchmark/runner';
import { CODING_TASKS, costOf, gradeTask, loadBenchmarkTasks, runMetrics, setUpTask, taskVersion, tasksFor, type BenchmarkTask } from '../benchmark/tasks';
import { SpendLimitError, StreamInterruptedError, type AgentMessage, type CompletionEvent, type ToolCall } from '../services/nearAiClient';
import { currentSpendTag, type SpendTag } from '../services/spendLedger';

// The benchmark's tasks and runner, with a scripted model instead of NEAR: no live calls.

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const SLUGIFY = 'module.exports = function slugify(text) {\n  return text.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n};\n';

type Turn = { text?: string; calls?: ToolCall[] } | Error | 'hang';

/** A model that plays back fixed turns per model, records what it was sent and the spend tag of each request. */
function scripted(script: (model: string, turn: number, messages: AgentMessage[]) => Turn) {
  const seen: Array<{ model: string; messages: AgentMessage[]; tag: SpendTag }> = [];
  const client: BenchmarkClient = {
    async *streamCompletion(model: string, messages: AgentMessage[], _tools, signal?: AbortSignal): AsyncGenerator<CompletionEvent> {
      const turn = seen.filter((entry) => entry.model === model && entry.messages[1]?.content === messages[1]?.content).length;
      seen.push({ model, messages: structuredClone(messages), tag: currentSpendTag() });
      const next = script(model, turn, messages);
      if (next === 'hang') { await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true })); throw new Error('aborted'); }
      if (next instanceof Error) throw next;
      if (next.text) yield { type: 'text', text: next.text };
      yield { type: 'done', message: { role: 'assistant', content: next.text ?? null, ...(next.calls ? { tool_calls: next.calls } : {}) }, finishReason: next.calls ? 'tool_calls' : 'stop', usage: { inputTokens: 1000, outputTokens: 100, estimatedCostUsd: 0.001, verificationStatus: 'unknown', latencyMs: 600, firstTokenMs: 100 } };
    }
  };
  return { client, seen };
}

/** Solves the slugify task: read the file, write the answer, finish. */
const solver = (_model: string, turn: number): Turn => turn === 0 ? { calls: [call('c1', 'Read', { file_path: 'slug.js' })] } : turn === 1 ? { calls: [call('c2', 'Write', { file_path: 'slug.js', content: SLUGIFY })] } : { text: 'Done.' };

async function implementTask(): Promise<BenchmarkTask[]> {
  return (await loadBenchmarkTasks()).filter((task) => task.id === 'implement');
}

function options(tasks: BenchmarkTask[], models: string[], client: BenchmarkClient, extra: Partial<Parameters<typeof runComparison>[0]> = {}) {
  const rows: ResultRow[] = [];
  return {
    rows,
    run: (signal = new AbortController().signal) => runComparison({
      runId: 'run-test', plan: planComparison(models, tasks, 1, 'rerun', new Map()), tasks, runsPerTask: 1, clientFor: () => client,
      rules: DEFAULT_RULES, emergencyStopped: () => false, signal, onRow: (row) => { rows.push(row); }, now: () => new Date('2026-10-30T12:00:00Z'), ...extra
    })
  };
}

test('the task list: eight tasks in the live eval\'s order, with a short set of the four quick ones', async () => {
  const tasks = await loadBenchmarkTasks();
  assert.deepEqual(tasks.map((task) => task.id), ['implement', 'fix-bug', 'refactor', 'research-brief', 'phase-plan', 'execute-plan', 'issue-fix', 'spec-implement']);
  assert.deepEqual(tasksFor('short', tasks).map((task) => task.id), ['implement', 'fix-bug', 'refactor', 'phase-plan']);
  assert.equal(tasksFor('full', tasks).length, 8);
  assert.ok(tasks.every((task) => /^[0-9a-f]{12}$/.test(task.version) && task.label && task.estimate.inputTokens > 0 && task.timeoutMs > 0));
  assert.deepEqual(tasks.filter((task) => task.kind === 'execution').map((task) => task.maxTurns), [50, 50, 50]);
});

test('a task\'s version is stable, and changes with its prompt or files', async () => {
  const first = await loadBenchmarkTasks();
  const second = await loadBenchmarkTasks();
  assert.deepEqual(first.map((task) => task.version), second.map((task) => task.version));
  assert.equal(new Set(first.map((task) => task.version)).size, first.length, 'every task has its own version');
  const { prompt, files } = CODING_TASKS[0];
  const base = taskVersion('coding', prompt, files);
  assert.notEqual(taskVersion('coding', `${prompt} `, files), base);
  assert.notEqual(taskVersion('coding', prompt, { ...files, 'slug.js': `${files['slug.js']}// changed\n` }), base);
  assert.notEqual(taskVersion('planning', prompt, files), base, 'the grader kind is part of the version');
  assert.equal(taskVersion('coding', prompt, Object.fromEntries(Object.entries(files).reverse())), base, 'file order does not matter');
});

test('a coding task scores 10 when its tests pass, and 0 untouched or with its test changed', async () => {
  const [task] = await implementTask();
  const untouched = await mkdtemp(path.join(tmpdir(), 'near-ai-bench-'));
  await setUpTask(task, untouched);
  assert.deepEqual(await gradeTask(task, untouched), { score: 0, outOf: 10, misses: ['tests fail'] });
  const solved = await mkdtemp(path.join(tmpdir(), 'near-ai-bench-'));
  await setUpTask(task, solved);
  await writeFile(path.join(solved, 'slug.js'), SLUGIFY);
  assert.deepEqual(await gradeTask(task, solved), { score: 10, outOf: 10, misses: [] });
  await writeFile(path.join(solved, 'slug.test.js'), 'require("node:test")("nothing", () => {});\n');
  assert.deepEqual(await gradeTask(task, solved), { score: 0, outOf: 10, misses: ['changed the test: slug.test.js'] });
});

test('run metrics: tokens, cache share, and generation speed without the wait for the first token', async () => {
  const metrics = runMetrics([
    { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200, verificationStatus: 'unknown', latencyMs: 2_100, firstTokenMs: 100 },
    { inputTokens: 1000, outputTokens: 200, verificationStatus: 'unknown', latencyMs: 2_000 }
  ]);
  assert.deepEqual(metrics, { turns: 2, inputTokens: 2000, cachedInputTokens: 500, outputTokens: 400, generatingMs: 4000, cachePct: 25, tokPerSec: 100 });
  assert.equal(runMetrics([]).tokPerSec, undefined);
  // NEAR's billing figure when it answers, else the sum of the estimates.
  const usage = [{ requestId: 'r1', estimatedCostUsd: 0.01, verificationStatus: 'unknown' as const, latencyMs: 1 }, { requestId: 'r2', estimatedCostUsd: 0.02, verificationStatus: 'unknown' as const, latencyMs: 1 }];
  assert.deepEqual(await costOf({ actualCostsUsd: async () => 0.025 }, usage), { usd: 0.025, estimated: false });
  const estimated = await costOf({ actualCostsUsd: async () => undefined }, usage);
  assert.ok(estimated.estimated && Math.abs(estimated.usd! - 0.03) < 1e-9);
  assert.deepEqual(await costOf({}, []), { usd: undefined, estimated: true });
});

test('a comparison runs each model in a temporary folder, grades it, tags its spend as eval, and cleans up', async () => {
  const tasks = await implementTask();
  const { client, seen } = scripted((model, turn) => model === 'good/model' ? solver(model, turn) : { text: 'I would rather not.' });
  const temp = await mkdtemp(path.join(tmpdir(), 'near-ai-bench-temp-'));
  const progress: string[] = [];
  const { rows, run } = options(tasks, ['good/model', 'lazy/model'], client, { tempDir: temp, onProgress: (step) => progress.push(`${step.done}/${step.total} ${step.model}`) });
  assert.deepEqual(await run(), { status: 'completed' });
  assert.deepEqual(rows.map((row) => [row.model, row.task, row.score, row.outcome]), [['good/model', 'implement', 10, 'completed'], ['lazy/model', 'implement', 0, 'completed']]);
  const good = rows[0];
  assert.equal(good.taskVersion, tasks[0].version);
  assert.equal(good.turns, 3);
  assert.equal(good.outputTokens, 300);
  assert.equal(good.generatingMs, 1500);
  assert.equal(good.costEstimated, true);
  assert.ok(Math.abs(good.costUsd! - 0.003) < 1e-9);
  assert.equal(good.at, '2026-10-30T12:00:00.000Z');
  assert.deepEqual(progress, ['0/2 good/model', '1/2 lazy/model', '2/2 ']);
  assert.ok(seen.every((entry) => entry.tag.kind === 'eval' && entry.tag.runId?.startsWith('run-test/')), 'every request is billed as eval spend');
  // The model worked in a folder of its own, never the current directory, and the folder is gone.
  const roots = [...new Set(seen.map((entry) => /Workspace root: (\S+)/.exec(String(entry.messages[0].content))?.[1]))];
  assert.equal(roots.length, 2, 'one folder per run');
  for (const root of roots) assert.ok(root?.startsWith(path.join(temp, 'near-ai-compare-')), root);
  assert.deepEqual(await readdir(temp), []);
});

test('the user\'s deny list still applies inside a test run', async () => {
  const tasks = await implementTask();
  const { client, seen } = scripted((_model, turn) => turn === 0 ? { calls: [call('c1', 'Bash', { command: 'git push --force' })] } : { text: 'Stopped.' });
  const { rows, run } = options(tasks, ['m/one'], client);
  await run();
  const result = seen[1].messages.find((message) => message.role === 'tool');
  assert.match(String(result?.content), /deny list/);
  assert.equal(rows[0].score, 0);
});

test('a reply that stops responding counts as a stall; another error as a failure; both are graded as they stand', async () => {
  const tasks = await implementTask();
  const { client } = scripted((model) => model === 'stalls/model' ? new StreamInterruptedError('no data', true, 'req-1', { kind: 'stalled', retryable: false }) : new Error('boom'));
  const { rows, run } = options(tasks, ['stalls/model', 'breaks/model'], client);
  await run();
  assert.deepEqual(rows.map((row) => [row.model, row.outcome, row.score]), [['stalls/model', 'stalled', 0], ['breaks/model', 'failed', 0]]);
  assert.match(rows[0].misses[0], /stopped responding/);
  assert.match(rows[1].misses[0], /error: boom/);
});

test('the per-task time limit and the run budget stop a run, which is still graded', async () => {
  const tasks = await implementTask();
  const slow = scripted(() => 'hang');
  const timed = options(tasks, ['slow/model'], slow.client, { timeoutMs: () => 50 });
  await timed.run();
  assert.equal(timed.rows[0].outcome, 'timed-out');
  const pricey = scripted(solver);
  const budget = options(tasks, ['pricey/model'], pricey.client, { overBudget: (_tag, usage) => usage.length >= 1 ? 'stopped at the per-run cost limit' : undefined });
  await budget.run();
  assert.equal(budget.rows[0].outcome, 'over-budget');
  assert.deepEqual(budget.rows[0].misses.slice(0, 1), ['stopped at the per-run cost limit']);
  assert.equal(pricey.seen.length, 1, 'no turn after the budget was reached');
});

test('cancelling, the daily limit, and the emergency stop end the comparison without a partial row', async () => {
  const tasks = await implementTask();
  const abort = new AbortController();
  const hanging = scripted(() => { setTimeout(() => abort.abort('You cancelled the comparison.'), 10); return 'hang'; });
  const cancelled = options(tasks, ['a/model', 'b/model'], hanging.client);
  assert.deepEqual(await cancelled.run(abort.signal), { status: 'cancelled', stopReason: 'You cancelled the comparison.' });
  assert.deepEqual(cancelled.rows, []);

  const limited = scripted(() => new SpendLimitError(5, 5, 'local'));
  const daily = options(tasks, ['a/model'], limited.client);
  const outcome = await daily.run();
  assert.equal(outcome.status, 'stopped');
  assert.match(outcome.stopReason!, /daily limit/);
  assert.deepEqual(daily.rows, []);

  const stopped = options(tasks, ['a/model'], scripted(solver).client, { emergencyStopped: () => true });
  assert.deepEqual(await stopped.run(), { status: 'stopped', stopReason: 'Emergency stop is on.' });
});

test('cells reused from a saved result are not run', async () => {
  const tasks = await implementTask();
  const { client, seen } = scripted(solver);
  const saved = { model: 'a/model', task: 'implement', taskVersion: tasks[0].version, runId: '2026-10-01T00-00-00-000Z', at: '2026-10-01T00:00:00.000Z', rows: [{ outcome: 'completed' } as ResultRow] };
  const plan = planComparison(['a/model', 'b/model'], tasks, 1, 'reuse', new Map([[`a/model\u0000implement\u0000${tasks[0].version}`, saved]]));
  const rows: ResultRow[] = [];
  await runComparison({ runId: 'r', plan, tasks, runsPerTask: 1, clientFor: () => client, rules: DEFAULT_RULES, emergencyStopped: () => false, signal: new AbortController().signal, onRow: (row) => { rows.push(row); } });
  assert.deepEqual(rows.map((row) => row.model), ['b/model']);
  assert.ok(seen.every((entry) => entry.model === 'b/model'));
});

test('the execution fixtures ship outside test/ so the packaged extension has them', async () => {
  const execution = (await loadBenchmarkTasks()).filter((task) => task.kind === 'execution');
  for (const task of execution) {
    assert.match(task.execution!.dir, /resources[\\/]benchmark[\\/]execution[\\/]/);
    assert.ok(existsSync(path.join(task.execution!.dir, 'hidden')));
  }
});
