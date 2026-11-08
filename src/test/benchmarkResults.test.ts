import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildLeaderboard, catalogVersion, needsRetest, performanceTrend, RUN_ID, recommendRoles, recommendTiers, estimateComparisonCost, latestResults, median, parseSavedRun, planComparison, rankSummaries, reusedRows, runIdFor, serializeRun, summarizeModel, summarizeRun, type ModelSummary, type ResultRow, type SavedRun } from '../benchmark/results';
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

// What is worth testing again (owner, 2026-11-07: "enable the user to re-run them periodically as new models are release").
test('the retest plan names models with a stale result or a missing task, and models added since the last run', () => {
  const now = Date.parse('2026-11-07T00:00:00.000Z');
  // tee/a was tested on every task, recently. local/c was tested on everything but two days ago is fine; nopricing/d was tested on an OLD task version.
  const complete = saved('2026-11-05T00-00-00-000Z', '2026-11-05T00:00:00.000Z', [
    ...TASKS.map((entry) => row('tee/a', entry.id, 8, { at: '2026-11-05T01:00:00.000Z' })),
    ...TASKS.map((entry) => row('local/c', entry.id, 7, { at: '2026-11-05T01:00:00.000Z' })),
    ...TASKS.map((entry) => row('nopricing/d', entry.id, 5, { at: '2026-09-01T01:00:00.000Z', taskVersion: 'old-version' }))
  ]);
  const board = buildLeaderboard([complete], TASKS, [...catalog, { id: 'brand/new', privacyBoundary: 'tee' }], now);
  const { retest, newModels } = needsRetest(board, [...catalog, { id: 'brand/new', privacyBoundary: 'tee' }]);
  const retestIds = retest.map((entry) => entry.model);
  assert.ok(retestIds.includes('nopricing/d'), 'an old task version and an old date both make it stale');
  assert.match(retest.find((entry) => entry.model === 'nopricing/d')!.why.join(' '), /older version/);
  assert.equal(retestIds.includes('tee/a'), false, 'a current result needs no retest');
  // A model in the catalog with no result at all is new, and is offered separately because it has nothing to compare yet. fwd/b is one of those here:
  // it is in the catalog and this run never tested it.
  assert.deepEqual(newModels, ['fwd/b', 'brand/new']);
  // A model that is only an embedding model cannot do the benchmark, so it is not offered.
  const withEmbedding = needsRetest(board, [...catalog, { id: 'brand/new', privacyBoundary: 'tee' }, { id: 'embed/x', privacyBoundary: 'tee', outputModalities: ['image'] }]);
  assert.equal(withEmbedding.newModels.includes('embed/x'), false);
});

// The setup a comparison points to (owner, 2026-11-07): applied with one button, accuracy before speed, per role rather than one blanket winner, and
// cyber work kept on an abliterated model because a refusal is not a wrong answer, it is no answer.
function boardRow(model: string, extra: Partial<ModelSummary & { inCatalog: boolean }> = {}) {
  return {
    model, rank: 1, score: 8, byKind: {}, runs: 2, passes: 1, passRate: 0.5, medianSeconds: 60, costPerRunUsd: 0.02,
    costEstimated: false, failures: 0, stalls: 0, tasks: [], inCatalog: true, stale: [], missingTasks: [], privacy: 'tee' as const, ...extra
  };
}

test('the recommended tiers are chosen on accuracy first, then time, then cost, so a faster model never wins by being worse', () => {
  const entries = [
    boardRow('tee/best', { score: 9, medianSeconds: 120, costPerRunUsd: 0.05 }),
    // Much quicker and much cheaper, but 0.8 behind: outside the half point that counts as "as good", so it never wins.
    boardRow('tee/fast-but-worse', { score: 8.2, medianSeconds: 20, costPerRunUsd: 0.001 }),
    boardRow('tee/near-fast', { score: 8.7, medianSeconds: 45, costPerRunUsd: 0.03 }),
    boardRow('tee/gone', { score: 9.6, medianSeconds: 10, inCatalog: false })
  ];
  const recommendations = recommendTiers(entries, { deep: 'old/deep', fast: 'old/fast', standard: 'old/standard' });
  const byTier = Object.fromEntries(recommendations.map((entry) => [entry.tier, entry]));
  // Accuracy decides the deep tier, whatever it costs in time or money.
  assert.equal(byTier.deep.model, 'tee/best');
  // A model missing from the catalog is never recommended, however good it looks.
  assert.equal(recommendations.some((entry) => entry.model === 'tee/gone'), false);
  // The fast tier takes the quickest model that is still within half a point, which is not the quickest overall.
  assert.equal(byTier.fast.model, 'tee/near-fast', 'the quickest model loses on accuracy, so it is not the fast tier');
  // The standard tier takes the best value among the accurate ones.
  assert.equal(byTier.standard.model, 'tee/near-fast');
  // And the tier that had it already says so, so the button writes only what changed.
  const settled = recommendTiers(entries, { deep: 'tee/best', fast: 'tee/near-fast', standard: 'tee/near-fast' });
  assert.equal(settled.filter((entry) => entry.tier !== 'cyber').every((entry) => entry.changes === false), true);
});

test('a cyber recommendation is always an abliterated model, and says so when the results cannot judge refusal', () => {
  const entries = [
    boardRow('vendor/aligned-best', { score: 9.6, medianSeconds: 30 }),
    boardRow('vendor/model-abliterated', { score: 8.1, medianSeconds: 90 }),
    boardRow('vendor/other-abliterated', { score: 8.4, medianSeconds: 120 })
  ];
  const cyber = recommendTiers(entries, { deep: 'vendor/aligned-best', cyber: 'vendor/model-abliterated' }).find((entry) => entry.tier === 'cyber')!;
  assert.equal(cyber.model, 'vendor/other-abliterated', 'among the abliterated models, the best score wins even though it is slower');
  assert.equal(cyber.abliterated, true);
  assert.match(cyber.note ?? '', /do not test refusal/);
  // With no abliterated model tested, the scan keeps the one it uses and the note explains why.
  const alignedOnly = recommendTiers([boardRow('vendor/aligned-best', { score: 9 })], { cyber: 'vendor/model-abliterated' }).find((entry) => entry.tier === 'cyber')!;
  assert.equal(alignedOnly.model, 'vendor/model-abliterated');
  assert.equal(alignedOnly.changes, false);
});

test('each role is given the model that is best at its own kind of work, not the overall winner', () => {
  const entries = [
    // Best overall at planning, weak at research.
    boardRow('vendor/planner-king', { score: 8, byKind: { planning: { score: 9.5, tasks: 1, runs: 1 }, research: { score: 5, tasks: 1, runs: 1 } } }),
    // The reverse: the best researcher, a poor planner.
    boardRow('vendor/research-king', { score: 8, byKind: { planning: { score: 5, tasks: 1, runs: 1 }, research: { score: 9.4, tasks: 1, runs: 1 } } })
  ];
  const roles = recommendRoles(entries, [
    { id: 'role:gsd-planner', current: 'vendor/research-king' },
    { id: 'role:gsd-*-researcher', current: 'vendor/planner-king' },
    { id: 'role:gsd-executor' }
  ]);
  const byRole = Object.fromEntries(roles.map((entry) => [entry.role, entry]));
  assert.equal(byRole['gsd-planner'].model, 'vendor/planner-king', 'the planner gets the best planner');
  assert.equal(byRole['gsd-planner'].changes, true);
  assert.match(byRole['gsd-planner'].why, /planning/);
  assert.equal(byRole['gsd-*-researcher'].model, 'vendor/research-king', 'the researcher gets the best researcher, the opposite model');
  // A role whose kind has no results of its own is judged on the overall score rather than left empty.
  assert.ok(byRole['gsd-executor']);
  assert.equal(byRole['gsd-executor'].model, 'vendor/planner-king');
  for (const entry of roles) assert.equal(entry.setting, 'agent.roleModels');
});

// Performance over time (owner, 2026-11-07): score as a percentage against the date, with coding, research, planning and execution kept apart.
test('the trend is one point per day of fresh results, per task type, and a reused copy never looks like progress', () => {
  const day = (date: string, rows: ResultRow[]): SavedRun => ({ format: 'near-ai-model-comparison', version: 1, id: date, startedAt: `${date}T00:00:00.000Z`, status: 'completed', taskSet: 'full', mode: 'rerun', runsPerTask: 1, models: [{ id: 'tee/a', privacy: 'tee', catalogVersion: 'x' }], tasks: TASKS.map((task) => ({ id: task.id, kind: task.kind, version: task.version })), rows });
  const first = day('2026-11-01', [row('tee/a', 'implement', 5, { at: '2026-11-01T10:00:00.000Z' }), row('tee/a', 'phase-plan', 5, { at: '2026-11-01T11:00:00.000Z' })]);
  const second = day('2026-11-05', [row('tee/a', 'implement', 9, { at: '2026-11-05T10:00:00.000Z' }), row('tee/a', 'phase-plan', 7, { at: '2026-11-05T11:00:00.000Z' })]);
  // A third day whose results were all copied from the second: it is not a new measurement.
  const copied = day('2026-11-06', [{ ...row('tee/a', 'implement', 1, { at: '2026-11-06T10:00:00.000Z' }), reusedFrom: second.id }]);
  const trend = performanceTrend([first, second, copied]);
  assert.deepEqual(trend.overall.map((point) => [point.date, point.percent]), [['2026-11-01', 50], ['2026-11-05', 80]], 'the copied day adds no point');
  const byKind = Object.fromEntries(trend.byKind.map((entry) => [entry.kind, entry.points.map((point) => point.percent)]));
  assert.deepEqual(byKind.coding, [50, 90], 'coding improved');
  assert.deepEqual(byKind.planning, [50, 70], 'planning improved, by less');
  assert.equal(byKind.research, undefined, 'a kind with no results has no line rather than a flat zero');
});

// A comparison run from the terminal must show up in Compare Models (owner, 2026-11-08: "make sure the results will be saved and accessible by the
// UI"). The CLI builds a saved run itself, so this writes one exactly as it does and reads it back through the store and the parser the tab uses. A
// hand-made run ID failed RUN_ID and every save was refused, which this now catches.
test('a comparison saved the way the CLI saves it is readable by the tab', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-cli-save-'));
  const store = new ComparisonStore(dir);
  const at = new Date('2026-11-08T12:00:00.000Z');
  const id = await store.newId(runIdFor(at));
  assert.match(id, RUN_ID, 'the CLI uses the store\'s own ID format');
  const savedRun: SavedRun = {
    format: 'near-ai-model-comparison', version: 1, id, startedAt: at.toISOString(), status: 'completed', taskSet: 'full', mode: 'rerun', runsPerTask: 1,
    models: [{ id: 'z-ai/glm-5.3-flash', privacy: 'tee', catalogVersion: '64' }],
    tasks: [{ id: 'research-brief', kind: 'research', version: 'abc123' }],
    rows: [row('z-ai/glm-5.3-flash', 'research-brief', 9, { kind: 'research', taskVersion: 'abc123' })]
  };
  await store.save(savedRun);
  const listed = await store.list();
  assert.equal(listed.length, 1, 'the store lists the run the CLI wrote');
  assert.equal(listed[0]?.rows.length, 1, 'and its rows survive the round trip');
  // The tab builds its table from exactly this list plus the catalog.
  const board = buildLeaderboard(listed, [task('research-brief', 'research', 'abc123')], [], at.getTime());
  assert.equal(board.length, 1);
  assert.equal(board[0]?.model, 'z-ai/glm-5.3-flash');
});

test('the trend weights each model once per day, so five runs by one model do not outweigh one run by another', () => {
  const at = '2026-11-08T10:00:00.000Z';
  const day = (rows: ResultRow[]): SavedRun => ({ format: 'near-ai-model-comparison', version: 1, id: at, startedAt: at, status: 'completed', taskSet: 'full', mode: 'rerun', runsPerTask: 1, models: [], tasks: [], rows });
  // Model A scores 10/10 five times; model B scores 0/10 once. Averaging every row gives 83%, averaging per model first gives 50%.
  const rows: ResultRow[] = [
    ...Array.from({ length: 5 }, () => row('tee/a', 'implement', 10, { at })),
    row('tee/b', 'implement', 0, { at })
  ];
  const trend = performanceTrend([day(rows)]);
  assert.equal(trend.overall[0]?.percent, 50, 'each model counts once, not once per run');
});
