// Runs the Compare Models benchmark from a terminal, so a model can be compared against the ones in use without opening the panel: the same agent
// loop, the same task fixtures, the same graders, the same permission rules, and the same saved results (scripts/lib/model-compare.mjs).
//
// Owner, 2026-11-07: "we already have a compare models module that you could probably adapt for these tests and enable the user to re-run them
// periodically as new models are release to fine-tune their extension setup and teams." So this adds no second benchmark: it drives the one the panel
// drives, and its results land in the same store, where the panel shows them and "put this model in a role" works on them.
//
// Usage:
//   node scripts/compare-models.mjs --models a,b --task research-brief [--runs 1] [--set short] [--dry-run]
//   node scripts/compare-models.mjs --tier fast --task research-brief        # the model the fast tier uses now
//   node scripts/compare-models.mjs --new --task research-brief              # every catalog model not yet measured on that task
//
// Needs NEAR_AI_API_KEY, or a --key-file with one line in it. Nothing is written except the benchmark's own result store.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runComparison } from '../dist/benchmark/runner.js';
import { planComparison } from '../dist/benchmark/results.js';
import { ComparisonStore } from '../dist/benchmark/store.js';
import { buildLeaderboard, latestResults, needsRetest, RUN_FORMAT, privacyOf } from '../dist/benchmark/results.js';
import { loadBenchmarkTasks, tasksFor } from '../dist/benchmark/tasks.js';
import { DEFAULT_RULES } from '../dist/agent/permissions.js';
import { NearAiClient } from '../dist/services/nearAiClient.js';
import { DEFAULT_BASE_URL } from '../dist/domain/config.js';

const USAGE = `usage: node scripts/compare-models.mjs [options]

  --models a,b,c     models to compare (ids from NEAR AI's catalog)
  --tier deep|standard|fast   compare the model that tier uses now (nearAi.agent.<tier>Model)
  --new              every catalog model not yet measured on the chosen task
  --retest           every model whose result is stale, on an older task version, or missing a task
  --task id          one task: research-brief (default), phase-plan, implement, fix-bug, refactor, execute-plan, issue-fix, spec-implement
  --set full|short   instead of --task: a whole set (the panel's own sets)
  --runs N           runs per model per task (default 1; more runs smooth the variance)
  --reuse            keep a model's saved result for this task version instead of running it again (default: run again)
  --dry-run          print the plan and the cost estimate, run nothing
  --key-file <path>  read the API key from a file instead of NEAR_AI_API_KEY
  --base-url <url>   the endpoint (default ${DEFAULT_BASE_URL})
  --temp <dir>       where run folders are made (default the system temp folder)
`;

function parse(argv) {
  const options = { runs: 1, task: 'research-brief', mode: 'run', baseUrl: DEFAULT_BASE_URL, temp: tmpdir() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--models') options.models = value().split(',').map((id) => id.trim()).filter(Boolean);
    else if (arg === '--tier') options.tier = value();
    else if (arg === '--new') options.newOnly = true;
    else if (arg === '--retest') options.retest = true;
    else if (arg === '--task') { options.task = value(); options.set = undefined; }
    else if (arg === '--set') { options.set = value(); options.task = undefined; }
    else if (arg === '--runs') options.runs = Math.max(1, Number(value()) || 1);
    else if (arg === '--reuse') options.mode = 'reuse';
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--key-file') options.keyFile = value();
    else if (arg === '--base-url') options.baseUrl = value();
    else if (arg === '--temp') options.temp = value();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

/** The model a tier uses now, from the workspace settings the extension reads, falling back to its defaults. */
function tierModel(tier) {
  const settingsPath = path.join(process.cwd(), '.vscode', 'settings.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8').replace(/^\s*\/\/.*$/gm, '')); } catch { /* no workspace settings */ }
  const key = `nearAi.agent.${tier}Model`;
  const direct = settings[key];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const tiers = { deep: 'moonshotai/kimi-k3', standard: 'z-ai/glm-5.3', fast: 'Qwen/Qwen3.6-35B-A3B-FP8' };
  if (!(tier in tiers)) throw new Error(`--tier takes deep, standard or fast (got ${tier})`);
  return tiers[tier];
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) { process.stdout.write(USAGE); return; }
  const apiKey = options.keyFile ? readFileSync(options.keyFile, 'utf8').trim() : process.env.NEAR_AI_API_KEY;
  if (!apiKey) throw new Error('No API key: set NEAR_AI_API_KEY or pass --key-file <path with one line>.');
  const client = new NearAiClient({ baseUrl: options.baseUrl, apiKey });

  const all = await loadBenchmarkTasks();
  const chosen = options.set ? tasksFor(options.set, all) : all.filter((task) => task.id === options.task);
  if (!chosen.length) throw new Error(`no task "${options.task}". Tasks: ${all.map((task) => task.id).join(', ')}`);

  // The extension's own comparison store, so a run from here appears in Compare Models and its results can be put into a role there. The store lives in
  // globalStorage for the marketplace build; NEAR_AI_BENCHMARK_DIR overrides it, which is what an experiment uses to keep runs apart.
  const storeDir = process.env.NEAR_AI_BENCHMARK_DIR ?? path.join(process.cwd(), '.near-ai', 'benchmark');
  const store = new ComparisonStore(storeDir);
  const saved = await store.list();
  const latest = latestResults(saved);
  let models = options.models;
  if (options.tier) models = [tierModel(options.tier)];
  const catalog = await client.listModels().catch(() => []);
  if (options.newOnly || options.retest) {
    const board = buildLeaderboard(saved, chosen, catalog, Date.now());
    const { retest, newModels } = needsRetest(board, catalog);
    if (options.retest) {
      for (const entry of retest) process.stderr.write(`  ${entry.model}: ${entry.why.join('; ')}\n`);
      models = retest.map((entry) => entry.model);
    }
    if (options.newOnly) {
      for (const model of newModels) process.stderr.write(`  ${model}: not tested yet\n`);
      models = [...new Set([...(models ?? []), ...newModels])];
    }
    if (!models.length) { process.stdout.write('Nothing needs testing: every model this set can compare already has a current result.\n'); return; }
  }
  if (!models?.length) throw new Error('Nothing to compare: pass --models, --tier or --new.');

  const plan = planComparison(models, chosen, options.runs, options.mode, latest);
  process.stdout.write(`Comparing ${models.length} model(s) on ${chosen.length} task(s), ${options.runs} run(s) each: ${plan.toRun} run(s) to do, ${plan.reusedCells} reused.\n`);
  if (options.dryRun) {
    for (const model of models) process.stdout.write(`  ${model}\n`);
    return;
  }
  const rows = [];
  const started = Date.now();
  const id = await store.newId(`${new Date(started).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-cli`);
  const savedRun = {
    format: RUN_FORMAT, version: 1, id, startedAt: new Date(started).toISOString(), status: 'running',
    taskSet: options.set ?? 'full', mode: options.mode, runsPerTask: options.runs,
    models: models.map((model) => { const info = catalog.find((entry) => entry.id === model); return { id: model, privacy: privacyOf(info), ...(info?.forwardedTo ? { forwardedTo: info.forwardedTo } : {}), catalogVersion: String(catalog.length) }; }),
    tasks: chosen.map((task) => ({ id: task.id, kind: task.kind, version: task.version })),
    rows
  };
  const outcome = await runComparison({
    runId: `cli-${Date.now()}`,
    plan, tasks: chosen, runsPerTask: options.runs,
    clientFor: () => client,
    rules: DEFAULT_RULES,
    emergencyStopped: () => false,
    signal: new AbortController().signal,
    tempDir: options.temp,
    onProgress: ({ done, total, model, task }) => { if (model) process.stderr.write(`  ${done + 1}/${total} ${model} on ${task}\n`); },
    onRow: async (row) => { rows.push(row); await store.save({ ...savedRun, rows: [...rows] }).catch((error) => process.stderr.write(`  could not save: ${error.message}\n`)); }
  });
  await store.save({ ...savedRun, rows: [...rows], finishedAt: new Date().toISOString(), status: outcome.status, ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}) }).catch(() => undefined);
  // Ranked by score first, then by time: the point is fast AND right.
  const byModel = new Map();
  for (const row of rows) {
    const entry = byModel.get(row.model) ?? { score: 0, outOf: 0, seconds: 0, runs: 0, input: 0, output: 0, cost: 0, failures: 0 };
    entry.score += row.score; entry.outOf += row.outOf; entry.seconds += row.seconds; entry.runs += 1;
    entry.input += row.inputTokens; entry.output += row.outputTokens; entry.cost += row.costUsd ?? 0;
    if (row.outcome !== 'completed') entry.failures += 1;
    byModel.set(row.model, entry);
  }
  const ranked = [...byModel.entries()].map(([model, entry]) => ({ model, ...entry, accuracy: entry.outOf ? entry.score / entry.outOf : 0, meanSeconds: entry.seconds / Math.max(1, entry.runs) })).sort((a, b) => b.accuracy - a.accuracy || a.meanSeconds - b.meanSeconds);
  process.stdout.write(`\n${'model'.padEnd(48)} ${'right'.padStart(7)} ${'mean'.padStart(8)} ${'tokens out'.padStart(11)} ${'$'.padStart(8)} ${'failed'.padStart(7)}\n`);
  for (const row of ranked) {
    process.stdout.write(`${row.model.slice(0, 48).padEnd(48)} ${`${row.score}/${row.outOf}`.padStart(7)} ${`${row.meanSeconds}s`.padStart(8)} ${String(row.output).padStart(11)} ${row.cost.toFixed(3).padStart(8)} ${String(row.failures).padStart(7)}\n`);
  }
  process.stdout.write(`\n${outcome.status} in ${Math.round((Date.now() - started) / 1000)}s. Results are saved, so Compare Models shows them and can put a model into a role.\n`);
  if (outcome.status !== 'completed' && outcome.stopReason) process.stdout.write(`Stopped: ${outcome.stopReason}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.message ?? error}\n`); process.exitCode = 1; });
