import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogVersion, type ResultRow, type SavedRun } from '../benchmark/results';
import { catalogEntries, comparisonPageHtml, defaultSelection, estimateView, historyEntries, leaderboardRows, parseComparisonMessage, reportView, selectionProblem } from '../services/modelComparisonPage';
import { heldRoles, privacyWarning, roleOptions, roleUpdate } from '../services/modelRoles';
import type { ModelInfo } from '../services/nearAiClient';
import { parseToolsPageMessage } from '../services/toolsDirectory';

// The Compare Models page: the messages it may send, what it shows, and the roles a model can be put into.

const catalog: ModelInfo[] = [
  { id: 'moonshotai/kimi-k3', privacyBoundary: 'tee', inputPricePerMillion: 1, outputPricePerMillion: 3 },
  { id: 'z-ai/glm-5.3', privacyBoundary: 'tee' },
  { id: 'Qwen/Qwen3.6-35B-A3B-FP8', privacyBoundary: 'tee' },
  { id: 'deepseek/deepseek-v4.1-flash', privacyBoundary: 'cloud', forwardedTo: 'openrouter.ai' },
  { id: 'openai/whisper-large-v3', privacyBoundary: 'tee', outputModalities: ['text'], inputModalities: ['audio'] }
];
const settings = { mainModel: 'z-ai/glm-5.3', tiers: { deep: 'moonshotai/kimi-k3', standard: 'z-ai/glm-5.3', fast: 'Qwen/Qwen3.6-35B-A3B-FP8' }, roleModels: { 'gsd-*-researcher': 'fast', 'gsd-planner': 'deepseek/deepseek-v4.1-flash' } };

test('roles: the main model, three tiers, and agent roles, each with the model it uses now', () => {
  const roles = roleOptions(settings, catalog);
  const byId = Object.fromEntries(roles.map((role) => [role.id, role]));
  assert.deepEqual(roles.slice(0, 4).map((role) => [role.id, role.setting, role.current]), [['main', 'defaultModel', 'z-ai/glm-5.3'], ['tier:deep', 'agent.deepModel', 'moonshotai/kimi-k3'], ['tier:standard', 'agent.standardModel', 'z-ai/glm-5.3'], ['tier:fast', 'agent.fastModel', 'Qwen/Qwen3.6-35B-A3B-FP8']]);
  // A tier name resolves to the tier's model; a model ID is used as is; no setting follows the agent's definition.
  assert.equal(byId['role:gsd-*-researcher'].current, 'Qwen/Qwen3.6-35B-A3B-FP8');
  assert.equal(byId['role:gsd-planner'].current, 'deepseek/deepseek-v4.1-flash');
  assert.equal(byId['role:gsd-planner'].currentPrivacy, 'forwarded');
  assert.equal(byId['role:gsd-executor'].current, undefined);
  assert.equal(byId['role:gsd-executor'].label, 'Executor (writes the code) (gsd-executor)');
  assert.deepEqual(heldRoles('z-ai/glm-5.3', roles), ['Main chat model', 'Standard tier']);
});

test('applying a role writes one setting; an agent role keeps every other role as it was', () => {
  const roles = roleOptions(settings, catalog);
  const role = (id: string) => roles.find((candidate) => candidate.id === id)!;
  assert.deepEqual(roleUpdate(role('tier:deep'), 'deepseek/deepseek-v4.1-flash', settings.roleModels), { setting: 'agent.deepModel', value: 'deepseek/deepseek-v4.1-flash' });
  assert.deepEqual(roleUpdate(role('main'), 'moonshotai/kimi-k3', settings.roleModels), { setting: 'defaultModel', value: 'moonshotai/kimi-k3' });
  assert.deepEqual(roleUpdate(role('role:gsd-executor'), 'moonshotai/kimi-k3', settings.roleModels), { setting: 'agent.roleModels', value: { ...settings.roleModels, 'gsd-executor': 'moonshotai/kimi-k3' } });
});

test('a forwarded model taking over a role that uses a private model is warned about; other moves are not', () => {
  const roles = roleOptions(settings, catalog);
  const role = (id: string) => roles.find((candidate) => candidate.id === id)!;
  assert.match(privacyWarning('forwarded', role('tier:deep'))!, /Deep tier now uses a private model \(moonshotai\/kimi-k3\).*forwarded outside NEAR’s TEE/);
  assert.match(privacyWarning('unknown', role('main'))!, /unknown privacy/);
  assert.equal(privacyWarning('tee', role('tier:deep')), undefined);
  assert.equal(privacyWarning('forwarded', role('role:gsd-planner')), undefined, 'already forwarded');
  assert.equal(privacyWarning('forwarded', role('role:gsd-executor')), undefined, 'current model unknown');
});

test('the model list: chat models only, labelled, with what they hold, and blocked in TEE-only mode when not private', () => {
  const roles = roleOptions(settings, catalog);
  const entries = catalogEntries(catalog, roles, false);
  assert.ok(!entries.some((entry) => entry.id === 'openai/whisper-large-v3'), 'a transcription model is not a chat model');
  assert.deepEqual(entries.find((entry) => entry.id === 'z-ai/glm-5.3')!.holds, ['Main chat model', 'Standard tier']);
  const forwarded = entries.find((entry) => entry.id === 'deepseek/deepseek-v4.1-flash')!;
  assert.equal(forwarded.privacyText, 'Forwarded to openrouter.ai: not private');
  assert.equal(forwarded.blocked, undefined);
  assert.match(catalogEntries(catalog, roles, true).find((entry) => entry.id === 'deepseek/deepseek-v4.1-flash')!.blocked!, /TEE-only/);
  // Pre-selected: the main model and the tiers, once each.
  assert.deepEqual(defaultSelection(roles, entries), ['z-ai/glm-5.3', 'moonshotai/kimi-k3', 'Qwen/Qwen3.6-35B-A3B-FP8']);
});

test('a selection needs 2 to 6 models from the key\'s list that the privacy mode allows', () => {
  const entries = catalogEntries(catalog, roleOptions(settings, catalog), true);
  assert.match(selectionProblem(['z-ai/glm-5.3'], entries)!, /at least 2/);
  assert.match(selectionProblem(['a', 'b', 'c', 'd', 'e', 'f', 'g'], entries)!, /at most 6/);
  assert.match(selectionProblem(['z-ai/glm-5.3', 'made/up'], entries)!, /Not in your key’s model list: made\/up/);
  assert.match(selectionProblem(['z-ai/glm-5.3', 'deepseek/deepseek-v4.1-flash'], entries)!, /TEE-only/);
  assert.equal(selectionProblem(['z-ai/glm-5.3', 'moonshotai/kimi-k3'], entries), undefined);
});

test('only well-formed messages from the page are accepted', () => {
  const pick = { models: ['z-ai/glm-5.3', 'deepseek/deepseek-v4.1-flash'], taskSet: 'short', mode: 'reuse', runs: 2 };
  assert.deepEqual(parseComparisonMessage({ type: 'start', ...pick }), { type: 'start', ...pick });
  assert.deepEqual(parseComparisonMessage({ type: 'plan', ...pick, models: ['a/b', 'a/b'] }), { type: 'plan', ...pick, models: ['a/b'] });
  for (const bad of [
    { type: 'start', ...pick, runs: 4 }, { type: 'start', ...pick, runs: 1.5 }, { type: 'start', ...pick, taskSet: 'huge' }, { type: 'start', ...pick, mode: 'free' },
    { type: 'start', ...pick, models: ['a b'] }, { type: 'start', ...pick, models: ['1', '2', '3', '4', '5', '6', '7'] }, { type: 'start', ...pick, extra: true },
    { type: 'open-run', id: '../../secrets' }, { type: 'export', id: 'x' }, { type: 'apply-role', model: 'a/b', role: 'safety' }, { type: 'apply-role', model: 'a/b', role: 'role:x; rm' },
    { type: 'undo-role', token: 'nope' }, { type: 'cancel', now: true }, { type: 'run-shell' }, null, [], 'start'
  ]) assert.equal(parseComparisonMessage(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(parseComparisonMessage({ type: 'open-run', id: '2026-10-30T14-05-09-120Z' }), { type: 'open-run', id: '2026-10-30T14-05-09-120Z' });
  assert.deepEqual(parseComparisonMessage({ type: 'apply-role', model: 'z-ai/glm-5.3', role: 'role:gsd-*-researcher' }), { type: 'apply-role', model: 'z-ai/glm-5.3', role: 'role:gsd-*-researcher' });
  assert.deepEqual(parseComparisonMessage({ type: 'undo-role', token: '0123456789abcdef' }), { type: 'undo-role', token: '0123456789abcdef' });
});

const row = (model: string, score: number, extra: Partial<ResultRow> = {}): ResultRow => ({ model, task: 'implement', kind: 'coding', taskVersion: 'v1', run: 1, score, outOf: 10, outcome: 'completed', seconds: 10, turns: 3, inputTokens: 100, outputTokens: 50, generatingMs: 1000, costUsd: 0.02, costEstimated: false, stalls: 0, misses: [], at: '2026-10-29T00:00:00.000Z', ...extra });
const run: SavedRun = {
  format: 'near-ai-model-comparison', version: 1, id: '2026-10-29T00-00-00-000Z', startedAt: '2026-10-29T00:00:00.000Z', status: 'completed', taskSet: 'short', mode: 'reuse', runsPerTask: 1,
  models: [{ id: 'z-ai/glm-5.3', privacy: 'tee', catalogVersion: catalogVersion(catalog[1]) }, { id: 'deepseek/deepseek-v4.1-flash', privacy: 'forwarded', forwardedTo: 'openrouter.ai', catalogVersion: 'old' }],
  tasks: [{ id: 'implement', kind: 'coding', version: 'v1' }],
  rows: [row('z-ai/glm-5.3', 10, { reusedFrom: '2026-10-01T00-00-00-000Z' }), row('deepseek/deepseek-v4.1-flash', 0)]
};

test('past comparisons list what ran, what was reused, and what the new runs cost', () => {
  assert.deepEqual(historyEntries([run]), [{ id: run.id, startedAt: run.startedAt, status: 'completed', taskSet: 'short', mode: 'reuse', runsPerTask: 1, models: ['z-ai/glm-5.3', 'deepseek/deepseek-v4.1-flash'], ran: 1, reused: 1, costUsd: 0.02 }]);
});

test('a comparison\'s report ranks its models, shows the roles they hold, and flags a changed NEAR listing', () => {
  const roles = roleOptions(settings, catalog);
  const view = reportView(run, catalog, roles);
  assert.deepEqual(view.summary.map((entry) => [entry.rank, entry.model, entry.privacy, entry.catalogChanged]), [[1, 'z-ai/glm-5.3', 'tee', false], [2, 'deepseek/deepseek-v4.1-flash', 'forwarded', true]]);
  assert.deepEqual(view.summary[0].holds, ['Main chat model', 'Standard tier']);
  assert.equal(view.summary[1].privacyText, 'Forwarded to openrouter.ai: not private');
  assert.equal(view.summary[0].tasks[0].reused, true);
  const board = leaderboardRows([run], [{ id: 'implement', kind: 'coding', label: 'implement', prompt: '', files: {}, maxTurns: 30, timeoutMs: 1, estimate: { inputTokens: 1, outputTokens: 1 }, version: 'v1' }], catalog, roles, Date.parse('2026-10-30T00:00:00Z'));
  // Only the fresh row counts on the leaderboard: glm's result here was copied from a run the store no longer has.
  assert.deepEqual(board.map((entry) => entry.model), ['deepseek/deepseek-v4.1-flash']);
  assert.deepEqual(board[0].holds, ['Planner (gsd-planner)']);
});

test('the estimate view lists each reused result with its age', () => {
  const reuse = { model: 'z-ai/glm-5.3', task: 'implement', taskVersion: 'v1', runId: run.id, at: '2026-10-29T00:00:00.000Z', rows: [] };
  const plan = { cells: [{ model: 'z-ai/glm-5.3', task: 'implement', reuse }, { model: 'deepseek/deepseek-v4.1-flash', task: 'implement' }], toRun: 1, reusedCells: 1 };
  const estimate = { usd: 0.1, runs: 1, reusedCells: 1, unpriced: [], perModel: [] };
  assert.deepEqual(estimateView(plan, estimate).reused, [{ model: 'z-ai/glm-5.3', task: 'implement', at: '2026-10-29T00:00:00.000Z', runId: run.id }]);
});

test('the page loads one nonce script and one stylesheet under a strict content policy, and the Tools page may open it', () => {
  const html = comparisonPageHtml({ cspSource: 'vscode-resource:', nonce: 'abc123', script: 'compare.js', style: 'compare.css' });
  assert.match(html, /default-src 'none'; style-src vscode-resource:; script-src 'nonce-abc123';/);
  assert.equal((html.match(/<script /g) ?? []).length, 1);
  assert.match(html, /id="board"[\s\S]*id="setup"[\s\S]*id="history"/, 'the leaderboard comes first, then the controls, then past comparisons');
  assert.deepEqual(parseToolsPageMessage({ type: 'run-command', command: 'nearAi.compareModels' }), { type: 'run-command', command: 'nearAi.compareModels' });
});
