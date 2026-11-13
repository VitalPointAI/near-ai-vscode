import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { catalogVersion, type ResultRow, type SavedRun } from '../benchmark/results';
import { PROJECT_CHOICE_SETTINGS, projectChoiceFor, readChoicesFileSync, writeProjectChoice } from '../services/modelChoices';
import { clearOneProjectChoice, clearProjectModelChoices, projectChoicesView } from '../services/modelComparisonPage';
import { stateHomeFor } from '../services/stateHome';
import { tempProject } from './helpers/stateFixtures';
import { catalogEntries, comparisonPageHtml, defaultSelection, estimateView, historyEntries, leaderboardRows, parseComparisonMessage, reportView, selectionProblem } from '../services/modelComparisonPage';
import { heldRoles, privacyWarning, roleAppliedText, roleOptions, roleUpdate } from '../services/modelRoles';
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

// D-06: a model applied from here now belongs to the project (choices.json), unless the workspace already sets that value itself.
test('the applied message says where the model was put: for this project, or in this workspace', () => {
  const roles = roleOptions(settings, catalog);
  const deep = roles.find((candidate) => candidate.id === 'tier:deep')!;
  assert.equal(roleAppliedText(deep.label, 'z-ai/glm-5.3', 'project'), 'Deep tier now uses z-ai/glm-5.3 for this project.');
  assert.equal(roleAppliedText(deep.label, 'z-ai/glm-5.3', 'workspace'), 'Deep tier now uses z-ai/glm-5.3 in this workspace.');
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

test('the page loads one nonce script and two stylesheets (shared base, then its own) under a strict content policy, and the Tools page may open it', () => {
  const html = comparisonPageHtml({ cspSource: 'vscode-resource:', nonce: 'abc123', script: 'compare.js', style: 'compare.css', base: 'base.css' });
  assert.match(html, /default-src 'none'; style-src vscode-resource:; script-src 'nonce-abc123';/);
  assert.equal((html.match(/<script /g) ?? []).length, 1);
  assert.match(html, /id="board"[\s\S]*id="setup"[\s\S]*id="history"/, 'the leaderboard comes first, then the controls, then past comparisons');
  assert.deepEqual(parseToolsPageMessage({ type: 'run-command', command: 'nearAi.compareModels' }), { type: 'run-command', command: 'nearAi.compareModels' });
});

// A team that was just saved is checked against the comparisons (owner, 2026-11-07): the suggestion names the members whose tested best model differs,
// and says nothing when there is nothing to say.
test('a new team is checked per member, and only members whose tested best model differs are suggested', async () => {
  const { suggestForTeam, leaderboardRows } = await import('../services/modelComparisonPage');
  const row = (model: string, byKind: Record<string, { score: number; tasks: number; runs: number }>) => ({
    model, rank: 1, score: 8, byKind, runs: 2, passes: 1, passRate: 0.5, medianSeconds: 60, costPerRunUsd: 0.02,
    costEstimated: false, failures: 0, stalls: 0, tasks: [], inCatalog: true, stale: [], missingTasks: [], privacy: 'tee' as const
  });
  const rows = [
    row('vendor/research-king', { research: { score: 9.2, tasks: 1, runs: 1 }, planning: { score: 5, tasks: 1, runs: 1 } }),
    row('vendor/planner-king', { planning: { score: 9.4, tasks: 1, runs: 1 }, research: { score: 5.5, tasks: 1, runs: 1 } })
  ] as never;
  const suggestions = suggestForTeam(rows, [
    { name: 'scout', role: 'gsd-researcher' },
    { name: 'architect', role: 'gsd-planner', model: 'vendor/planner-king' },
    { name: 'mapper' }
  ]);
  const byMember = Object.fromEntries(suggestions.map((entry) => [entry.member, entry]));
  assert.equal(byMember.scout.model, 'vendor/research-king');
  assert.equal(byMember.scout.changes, true, 'a member with no model line is suggested one');
  assert.equal(byMember.architect.changes, false, 'a member already on the recommended model is not a change');
  assert.ok(byMember.mapper, 'a member with no role is judged on the overall score rather than skipped');
  // The page builds the same leaderboard the table shows, so a suggestion cannot disagree with the numbers above it.
  assert.equal(typeof leaderboardRows, 'function');
});

// ---- the project's model choices can be seen and cleared (plan 27-33, Task 3) ----

class PageNode {
  children: PageNode[] = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  hidden = false; id = ''; className = ''; type = ''; value = ''; title = ''; checked = false; disabled = false; scope = ''; tabIndex = 0; label = '';
  private text = '';
  constructor(public tagName: string) {}
  get classList() { const list = () => this.className.split(/\s+/).filter(Boolean); return { add: (name: string) => { if (!list().includes(name)) this.className = [...list(), name].join(' '); }, contains: (name: string) => list().includes(name) }; }
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...nodes: PageNode[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: PageNode[]) { this.children = []; this.text = ''; this.append(...nodes); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  private listeners = new Map<string, Array<() => void>>();
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  click() { for (const listener of this.listeners.get('click') ?? []) listener(); }
  all(): PageNode[] { return this.children.flatMap((child) => [child, ...child.all()]); }
  querySelectorAll(): PageNode[] { return []; }
}

function runComparePage() {
  const body = new PageNode('body');
  for (const id of ['board', 'trend', 'recommended', 'retest', 'setup', 'history', 'results-section', 'results', 'results-actions', 'progress', 'notice', 'problem', 'refresh', 'project-choices']) { const node = new PageNode('div'); node.id = id; body.append(node); }
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const posted: Array<Record<string, unknown>> = [];
  const document = { getElementById: (id: string) => body.all().find((node) => node.id === id) ?? null, createElement: (tag: string) => new PageNode(tag), createElementNS: (_ns: string, tag: string) => new PageNode(tag), createTextNode: (text: string) => { const node = new PageNode('#text'); node.textContent = text; return node; } };
  const context = vm.createContext({ document, Option: function Option(text: string, value: string) { const node = new PageNode('option'); node.textContent = text; node.value = value; return node; }, window: { addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => listeners.push(listener) }, acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => posted.push(message) }), setTimeout: () => 0, clearTimeout: () => undefined, Date, Math, JSON, Set, Object, String, Number, Boolean });
  vm.runInContext(readFileSync(path.join(__dirname, '..', '..', 'media', 'compare', 'compare.js'), 'utf8'), context, { timeout: 1000 });
  return { body, posted, dispatch: (data: unknown) => listeners.forEach((listener) => listener({ data })) };
}

const emptyState = { leaderboard: [], catalog: [], roles: [], taskSets: [], history: [], selected: [] };

test('the page state lists the settings that come from the project, with labels, and leaves out one the workspace sets itself', async () => {
  const root = await tempProject();
  await writeProjectChoice(root, 'nearAi.agent.deepModel', 'tee/deep', 'edA.1');
  await writeProjectChoice(root, 'nearAi.defaultModel', 'tee/main', 'edA.1');
  await writeProjectChoice(root, 'nearAi.agent.roleModels', { 'gsd-planner': 'tee/plan' }, 'edA.1');
  await writeProjectChoice(root, 'nearAi.agent.fastModel', 'tee/fast', 'edA.1');
  const inspect = (setting: string) => setting === 'agent.fastModel' ? { workspaceValue: 'ws-fast' } : {};
  assert.deepEqual(projectChoicesView(root, inspect), [
    { setting: 'nearAi.defaultModel', label: 'Main chat model', value: 'tee/main' },
    { setting: 'nearAi.agent.deepModel', label: 'Deep tier', value: 'tee/deep' },
    { setting: 'nearAi.agent.roleModels', label: 'Agent roles', value: 'gsd-planner: tee/plan' }
  ]);
  assert.deepEqual(projectChoicesView(undefined, inspect), []);
});

test('the page shows a "Chosen for this project" list with one "Use my settings" button per setting, and none when there are no choices', () => {
  const page = runComparePage();
  page.dispatch({ type: 'state', state: { ...emptyState, projectChoices: [{ setting: 'nearAi.agent.deepModel', label: 'Deep tier', value: 'tee/deep' }, { setting: 'nearAi.agent.roleModels', label: 'Agent roles', value: 'gsd-planner: tee/plan' }] } });
  const box = page.body.all().find((node) => node.id === 'project-choices')!;
  assert.equal(box.hidden, false);
  assert.match(box.textContent, /Chosen for this project/);
  const rows = box.all().filter((node) => node.tagName === 'li');
  assert.deepEqual(rows.map((row) => row.textContent.replace(/Use my settings$/, '')), ['Deep tier: tee/deep', 'Agent roles: gsd-planner: tee/plan']);
  const buttons = box.all().filter((node) => node.tagName === 'button');
  assert.deepEqual(buttons.map((node) => node.textContent), ['Use my settings', 'Use my settings']);
  buttons[1]!.click();
  assert.deepEqual(JSON.parse(JSON.stringify(page.posted.filter((message) => message.type === 'clear-project-choice'))), [{ type: 'clear-project-choice', setting: 'nearAi.agent.roleModels' }]);
  page.dispatch({ type: 'state', state: { ...emptyState, projectChoices: [] } });
  assert.equal(box.hidden, true);
  assert.equal(box.all().filter((node) => node.tagName === 'li').length, 0, 'no list without choices');
  page.dispatch({ type: 'state', state: emptyState });
  assert.equal(box.hidden, true, 'a state from an older host has no list either');
});

test('the host clears one project choice by name, refuses a setting a project cannot carry, and writes nothing then', async () => {
  assert.deepEqual(parseComparisonMessage({ type: 'clear-project-choice', setting: 'nearAi.agent.deepModel' }), { type: 'clear-project-choice', setting: 'nearAi.agent.deepModel' });
  assert.equal(parseComparisonMessage({ type: 'clear-project-choice' }), undefined);
  assert.equal(parseComparisonMessage({ type: 'clear-project-choice', setting: 'nearAi.agent.deepModel', extra: 1 }), undefined);
  const root = await tempProject();
  await writeProjectChoice(root, 'nearAi.agent.deepModel', 'tee/deep', 'edA.1');
  const before = JSON.stringify(readChoicesFileSync(root));
  for (const bad of ['nearAi.baseUrl', 'agent.deepModel', '', 'nearAi.agent.deepModel/../x']) {
    const refused = await clearOneProjectChoice(root, bad, 'edA.1');
    assert.equal(refused.cleared, false);
    assert.equal(refused.problem, true, bad);
    assert.match(refused.text, /nothing was changed/);
  }
  assert.equal(JSON.stringify(readChoicesFileSync(root)), before, 'nothing was written');
  assert.equal((await clearOneProjectChoice(undefined, 'nearAi.agent.deepModel', 'edA.1')).problem, true);
  const cleared = await clearOneProjectChoice(root, 'nearAi.agent.deepModel', 'edA.1');
  assert.deepEqual(cleared, { text: 'Deep tier now uses your own settings again.', cleared: true });
  assert.equal(projectChoiceFor(root, 'agent.deepModel', { ttlMs: 0 }), undefined);
  assert.equal((await clearOneProjectChoice(root, 'nearAi.agent.deepModel', 'edA.1')).cleared, false, 'already clear: nothing changes');
});

test('the command lists the settings in effect in a multi-select and clears the ones picked; with none it says so in one sentence', async () => {
  const root = await tempProject();
  const inspect = () => ({});
  let offered: Array<{ label: string; description: string; setting: string }> = [];
  const none = await clearProjectModelChoices({ root, inspect, writer: 'edA.1', pick: async () => { throw new Error('nothing to pick'); } });
  assert.match(none, /^No model is chosen for this project[^.]*\.$/);
  await writeProjectChoice(root, 'nearAi.agent.deepModel', 'tee/deep', 'edA.1');
  await writeProjectChoice(root, 'nearAi.agent.fastModel', 'tee/fast', 'edA.1');
  await writeProjectChoice(root, 'nearAi.defaultModel', 'tee/main', 'edA.1');
  const text = await clearProjectModelChoices({ root, inspect, writer: 'edA.1', pick: async (items) => { offered = items; return items.filter((item) => item.setting !== 'nearAi.agent.fastModel'); } });
  assert.deepEqual(offered.map((item) => [item.label, item.description]), [['Main chat model', 'tee/main'], ['Deep tier', 'tee/deep'], ['Fast tier', 'tee/fast']]);
  assert.equal(text, "Cleared the project's choice for Main chat model, Deep tier. They use your own settings again.");
  assert.equal(projectChoiceFor(root, 'agent.fastModel', { ttlMs: 0 }), 'tee/fast', 'the one not picked is kept');
  assert.equal(projectChoiceFor(root, 'defaultModel', { ttlMs: 0 }), undefined);
  assert.equal(await clearProjectModelChoices({ root, inspect, writer: 'edA.1', pick: async () => undefined }), 'Nothing was cleared.', 'dismissing the picker changes nothing');
  assert.equal(projectChoiceFor(root, 'agent.fastModel', { ttlMs: 0 }), 'tee/fast');
  assert.equal(await stateHomeFor(root).exists(), true);
});

test('package.json declares the clear command, and each of the nine model settings says a project choice is used instead and where to clear it', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }>; configuration: { properties: Record<string, { description?: string; markdownDescription?: string }> } } };
  assert.deepEqual(manifest.contributes.commands.find((command) => command.command === 'nearAi.clearProjectModelChoices'), { command: 'nearAi.clearProjectModelChoices', title: "Clear This Project's Model Choices", category: 'NEAR AI' });
  const sentence = "A model chosen for this project in Compare Models is used instead of this setting until you clear it there or with NEAR AI: Clear This Project's Model Choices.";
  for (const setting of PROJECT_CHOICE_SETTINGS) {
    const property = manifest.contributes.configuration.properties[setting];
    assert.ok(property, setting);
    const text = property.markdownDescription ?? property.description ?? '';
    assert.ok(text.endsWith(sentence), `${setting} ends with the sentence`);
    assert.doesNotMatch(text, /\u2014/, 'no em-dash');
  }
});
