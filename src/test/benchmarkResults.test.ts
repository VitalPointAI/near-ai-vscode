import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildLeaderboard, catalogVersion, estimateComparisonCost, latestResults, median, parseSavedRun, planComparison, rankSummaries, reusedRows, runIdFor, serializeRun, summarizeModel, summarizeRun, type ResultRow, type SavedRun } from '../benchmark/results';
import { ComparisonStore } from '../benchmark/store';
import type { BenchmarkTask, TaskKind } from '../benchmark/tasks';
import type { ModelInfo } from '../services/nearAiClient';

// Saved comparisons: what is reused, the cost estimate, the summaries and ranking, the
// leaderboard, and reading them back. Pure, with hand-made results.

const task = (id: string, kind: TaskKind, version = `${id}-v1`): BenchmarkTask => ({ id, kind, label: id, prompt: '', files: {}, maxTurns: 30, timeoutMs: 1000, estimate: { inputTokens: 100_000, outputTokens: 10_000 }, version });
const TASKS = [task('implement', 'coding'), task('fix-bug', 'coding'), task('phase-plan', 'planning'), task('issue-fix', 'execution')];

let counter = 0;
function row(model: string, taskId: string, score: number, extra: Partial<ResultRow> = {}): ResultRow {
  const known = TASKS.find((candidate) => candidate.id === taskId);
  counter += 1;
  return { model, task: taskId, kind: known?.kind ?? 'coding', taskVersion: known?.version ?? 'v1', run: 1, score, outOf: 10, outcome: 'completed', seconds: 60, turns: 5, inputTokens: 1000, outputTokens: 500, generatingMs: 5000, costUsd: 0.01, costEstimated: false, stalls: 0, misses: [], at: `2026-10-${String(10 + (counter % 10)).padStart(2, '0')}T00:00:00.000Z`, ...extra };
}

function saved(id: string, startedAt: string, rows: ResultRow[], models = [...new Set(rows.map((entry) => entry.model))]): SavedRun {
  return { format: 'near-ai-model-comparison', version: 1, id, startedAt, status: 'completed', taskSet: 'full', mode: 'reuse', runsPerTask: 1, models: models.map((model) => ({ id: model, privacy: 'tee', catalogVersion: 'x' })), tasks: TASKS.map((entry) => ({ id: entry.id, kind: entry.kind, version: entry.version })), rows };
}

const catalog: ModelInfo[] = [
  { id: 'tee/a', privacyBoundary: 'tee', inputPricePerMillion: 1, outputPricePerMillion: 2 },
  { id: 'fwd/b', privacyBoundary: 'cloud', forwardedTo: 'openrouter.ai', inputPricePerMillion: 3, outputPricePerMillion: 15 },
  { id: 'local/c', privacyBoundary: 'local' },
  { id: 'nopricing/d', privacyBoundary: 'tee' }
];

test('the latest fresh result per model, task, and task version; reused copies never count as new', () => {
  const older = saved('2026-10-01T00-00-00-000Z', '2026-10-01T00:00:00.000Z', [row('tee/a', 'implement', 0, { at: '2026-10-01T01:00:00.000Z' })]);
  const newer = saved('2026-10-05T00-00-00-000Z', '2026-10-05T00:00:00.000Z', [row('tee/a', 'implement', 10, { at: '2026-10-05T01:00:00.000Z' }), row('tee/a', 'implement', 8, { at: '2026-10-05T02:00:00.000Z', run: 2 })]);
  const copy = saved('2026-10-09T00-00-00-000Z', '2026-10-09T00:00:00.000Z', [{ ...row('tee/a', 'implement', 0, { at: '2026-10-09T01:00:00.000Z' }), reusedFrom: older.id }]);
  const latest = latestResults([older, copy, newer]);
  const result = latest.get('tee/a\u0000implement\u0000implement-v1')!;
  assert.equal(result.runId, newer.id);
  assert.deepEqual(result.rows.map((entry) => entry.score), [10, 8]);
  assert.equal(result.at, '2026-10-05T02:00:00.000Z');
  assert.deepEqual(reusedRows(result).map((entry) => entry.reusedFrom), [newer.id, newer.id]);
});

test('reuse mode runs only what has no usable saved result; rerun mode runs everything', () => {
  const tasks = TASKS.slice(0, 2);
  const runs = [saved('2026-10-01T00-00-00-000Z', '2026-10-01T00:00:00.000Z', [
    row('tee/a', 'implement', 10),
    row('tee/a', 'fix-bug', 0, { outcome: 'stalled' }),
    row('fwd/b', 'implement', 10, { taskVersion: 'implement-v0' })
  ])];
  const latest = latestResults(runs);
  const plan = planComparison(['tee/a', 'fwd/b'], tasks, 1, 'reuse', latest);
  // tee/a implement: reused. tee/a fix-bug: it stalled, so run again. fwd/b implement: an older task version, so run again.
  assert.deepEqual(plan.cells.map((cell) => [cell.model, cell.task, Boolean(cell.reuse)]), [['tee/a', 'implement', true], ['tee/a', 'fix-bug', false], ['fwd/b', 'implement', false], ['fwd/b', 'fix-bug', false]]);
  assert.equal(plan.toRun, 3);
  assert.equal(plan.reusedCells, 1);
  assert.equal(planComparison(['tee/a', 'fwd/b'], tasks, 2, 'reuse', latest).reusedCells, 0, 'one saved run is not enough for two runs per task');
  const all = planComparison(['tee/a', 'fwd/b'], tasks, 2, 'rerun', latest);
  assert.equal(all.reusedCells, 0);
  assert.equal(all.toRun, 8);
});

test('the cost estimate counts only what will run; local models are free and unpriced ones are named', () => {
  const tasks = TASKS.slice(0, 2);
  const latest = latestResults([saved('2026-10-01T00-00-00-000Z', '2026-10-01T00:00:00.000Z', [row('tee/a', 'implement', 10), row('tee/a', 'implement', 10, { run: 2 })])]);
  const plan = planComparison(['tee/a', 'fwd/b', 'local/c', 'nopricing/d'], tasks, 2, 'reuse', latest);
  const estimate = estimateComparisonCost(plan, tasks, 2, catalog);
  // Per run: 100k in, 10k out. tee/a: $0.12 x 2 runs of fix-bug only. fwd/b: $0.45 x 4 runs.
  assert.equal(estimate.runs, 14);
  assert.equal(estimate.reusedCells, 1);
  assert.ok(Math.abs(estimate.usd - (0.24 + 1.8)) < 1e-9, String(estimate.usd));
  assert.deepEqual(estimate.unpriced, ['nopricing/d']);
  assert.deepEqual(estimate.perModel.map((entry) => [entry.model, entry.runs, entry.usd === undefined ? undefined : Math.round(entry.usd * 100) / 100]), [['tee/a', 2, 0.24], ['fwd/b', 4, 1.8], ['local/c', 4, 0], ['nopricing/d', 4, undefined]]);
  assert.equal(estimateComparisonCost(planComparison(['tee/a'], tasks.slice(0, 1), 1, 'reuse', latest), tasks, 1, catalog).usd, 0, 'all reused: nothing to pay');
});

test('a model\'s summary averages each task first, then over tasks and categories', () => {
  const rows = [
    row('tee/a', 'implement', 10, { seconds: 30, outputTokens: 1000, generatingMs: 10_000 }),
    row('tee/a', 'implement', 0, { run: 2, seconds: 90, outcome: 'stalled', stalls: 2, costUsd: undefined }),
    row('tee/a', 'fix-bug', 10, { seconds: 50 }),
    row('tee/a', 'phase-plan', 6, { seconds: 70, costEstimated: true }),
    row('fwd/b', 'implement', 10)
  ];
  const summary = summarizeModel('tee/a', rows);
  // implement: (10 + 0) / 2 = 5; fix-bug 10; phase-plan 6 → overall (5 + 10 + 6) / 3 = 7.
  assert.equal(summary.score, 7);
  assert.deepEqual(summary.byKind, { coding: { score: 7.5, tasks: 2, runs: 3 }, planning: { score: 6, tasks: 1, runs: 1 } });
  assert.equal(summary.runs, 4);
  assert.equal(summary.passes, 2);
  assert.equal(summary.passRate, 0.5);
  assert.equal(summary.medianSeconds, 60);
  assert.equal(summary.tokPerSec, Math.round(2500 / 25));
  assert.ok(Math.abs(summary.costUsd! - 0.03) < 1e-9);
  assert.ok(Math.abs(summary.costPerRunUsd! - 0.01) < 1e-9, 'per run with a known cost');
  assert.equal(summary.costEstimated, true);
  assert.equal(summary.failures, 1);
  assert.equal(summary.stalls, 2);
  assert.deepEqual(summary.tasks.map((entry) => [entry.task, entry.score, entry.runs]), [['fix-bug', 10, 1], ['implement', 5, 2], ['phase-plan', 6, 1]]);
  assert.equal(median([]), undefined);
  assert.equal(median([3, 1, 2]), 2);
});

test('ranking: score first, then pass rate, failures, cost per run, and speed; ties share a rank', () => {
  const base = { byKind: {}, runs: 4, passes: 2, passRate: 0.5, costEstimated: false, failures: 0, stalls: 0, tasks: [], medianSeconds: 60, costPerRunUsd: 0.1 };
  const ranked = rankSummaries([
    { ...base, model: 'cheap', score: 8 },
    { ...base, model: 'pricey', score: 8, costPerRunUsd: 0.5 },
    { ...base, model: 'best', score: 9 },
    { ...base, model: 'reliable', score: 8, passRate: 0.75 },
    { ...base, model: 'twin', score: 8 },
    { ...base, model: 'flaky', score: 8, failures: 2 },
    { ...base, model: 'unknown-cost', score: 8, costPerRunUsd: undefined }
  ]);
  assert.deepEqual(ranked.map((entry) => [entry.rank, entry.model]), [[1, 'best'], [2, 'reliable'], [3, 'cheap'], [3, 'twin'], [5, 'pricey'], [6, 'unknown-cost'], [7, 'flaky']]);
});

test('the leaderboard ranks every model ever tested on its latest result per task, and marks stale or missing models', () => {
  const now = Date.parse('2026-10-30T00:00:00.000Z');
  const runs = [
    saved('2026-10-20T00-00-00-000Z', '2026-10-20T00:00:00.000Z', [
      row('tee/a', 'implement', 0, { at: '2026-10-20T00:00:00.000Z' }),
      row('fwd/b', 'implement', 10, { at: '2026-10-20T00:00:00.000Z' }),
      row('gone/e', 'implement', 10, { at: '2026-10-20T00:00:00.000Z' })
    ]),
    saved('2026-10-25T00-00-00-000Z', '2026-10-25T00:00:00.000Z', [
      row('tee/a', 'implement', 10, { at: '2026-10-25T00:00:00.000Z' }),
      row('tee/a', 'fix-bug', 10, { at: '2026-10-25T00:00:00.000Z' }),
      row('tee/a', 'phase-plan', 8, { at: '2026-10-25T00:00:00.000Z' }),
      row('tee/a', 'issue-fix', 6, { at: '2026-10-25T00:00:00.000Z' }),
      // An older version of fix-bug: used, but marked stale.
      row('fwd/b', 'fix-bug', 10, { taskVersion: 'fix-bug-v0', at: '2026-10-25T00:00:00.000Z' })
    ]),
    saved('2026-08-01T00-00-00-000Z', '2026-08-01T00:00:00.000Z', [row('tee/old', 'implement', 10, { at: '2026-08-01T00:00:00.000Z' })])
  ];
  const board = buildLeaderboard(runs, TASKS, [...catalog, { id: 'tee/old', privacyBoundary: 'tee' }], now);
  const byModel = Object.fromEntries(board.map((entry) => [entry.model, entry]));
  assert.deepEqual(board.map((entry) => entry.model).sort(), ['fwd/b', 'gone/e', 'tee/a', 'tee/old']);
  // tee/a's latest implement result (10) replaces the earlier 0.
  assert.equal(byModel['tee/a'].score, 8.5);
  assert.deepEqual(byModel['tee/a'].byKind, { coding: { score: 10, tasks: 2, runs: 2 }, planning: { score: 8, tasks: 1, runs: 1 }, execution: { score: 6, tasks: 1, runs: 1 } });
  assert.deepEqual(byModel['tee/a'].stale, []);
  assert.deepEqual(byModel['tee/a'].missingTasks, []);
  assert.equal(byModel['tee/a'].lastTested, '2026-10-25T00:00:00.000Z');
  assert.deepEqual(byModel['fwd/b'].stale, ['Tested on an older version of: fix-bug']);
  assert.deepEqual(byModel['fwd/b'].missingTasks, ['phase-plan', 'issue-fix']);
  assert.equal(byModel['fwd/b'].privacy, 'forwarded');
  assert.equal(byModel['fwd/b'].forwardedTo, 'openrouter.ai');
  assert.equal(byModel['gone/e'].inCatalog, false);
  assert.equal(byModel['gone/e'].privacy, 'tee', 'privacy from the saved run when the catalog no longer lists it');
  assert.deepEqual(byModel['tee/old'].stale, ['Last tested 90 days ago']);
  assert.ok(board.every((entry, index) => index === 0 || entry.rank >= board[index - 1].rank));
});

test('a saved comparison reads back as written; damaged or foreign files are refused', () => {
  const original = saved(runIdFor(new Date('2026-10-30T14:05:09.120Z')), '2026-10-30T14:05:09.120Z', [row('tee/a', 'implement', 10), { ...row('fwd/b', 'implement', 5), reusedFrom: '2026-10-01T00-00-00-000Z' }]);
  assert.equal(original.id, '2026-10-30T14-05-09-120Z');
  assert.deepEqual(parseSavedRun(serializeRun(original)), original);
  assert.equal(parseSavedRun('not json'), undefined);
  assert.equal(parseSavedRun(JSON.stringify({ ...original, format: 'something-else' })), undefined);
  assert.equal(parseSavedRun(JSON.stringify({ ...original, id: '../escape' })), undefined);
  // A bad row is dropped, not the whole run; a run cut off mid-way reads as stopped.
  const damaged = parseSavedRun(JSON.stringify({ ...original, status: 'running', rows: [...original.rows, { model: 'x' }] }))!;
  assert.equal(damaged.rows.length, 2);
  assert.equal(damaged.status, 'stopped');
  assert.match(damaged.stopReason!, /closed/);
  assert.deepEqual(summarizeRun(original).map((entry) => [entry.rank, entry.model]), [[1, 'tee/a'], [2, 'fwd/b']]);
});

test('the catalog version changes when NEAR\'s listing of a model changes', () => {
  const base: ModelInfo = { id: 'tee/a', privacyBoundary: 'tee', inputPricePerMillion: 1, outputPricePerMillion: 2 };
  assert.equal(catalogVersion(base), catalogVersion({ ...base, fetchedAt: 'later' }));
  assert.notEqual(catalogVersion(base), catalogVersion({ ...base, outputPricePerMillion: 3 }));
  assert.notEqual(catalogVersion(base), catalogVersion({ ...base, privacyBoundary: 'cloud' }));
});

test('the store saves each comparison as its own file, lists them newest first, and skips damaged files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-evals-'));
  const store = new ComparisonStore(dir);
  assert.deepEqual(await store.list(), []);
  const first = saved('2026-10-01T00-00-00-000Z', '2026-10-01T00:00:00.000Z', [row('tee/a', 'implement', 10)]);
  const second = saved('2026-10-02T00-00-00-000Z', '2026-10-02T00:00:00.000Z', [row('fwd/b', 'implement', 5)]);
  await store.save(first);
  await store.save(second);
  await writeFile(path.join(dir, '2026-10-03T00-00-00-000Z.json'), '{ broken');
  await writeFile(path.join(dir, 'notes.json'), '{}');
  assert.deepEqual((await store.list()).map((entry) => entry.id), [second.id, first.id]);
  assert.deepEqual(await store.load(first.id), first);
  assert.equal(await store.newId(first.id), `${first.id}-2`);
  assert.equal(await store.newId('2026-10-04T00-00-00-000Z'), '2026-10-04T00-00-00-000Z');
  assert.throws(() => store.fileFor('../../etc/passwd'), /Not a saved comparison/);
});
