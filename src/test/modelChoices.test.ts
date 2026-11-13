import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { comparisonStoreFor, ComparisonStore } from '../benchmark/store';
import type { ResultRow, SavedRun } from '../benchmark/results';
import { choicesInEffect, CHOICES_STAT_TTL_MS, declineImport, importOffer, mergeProjectChoices, PROJECT_CHOICE_SETTINGS, planApply, projectChoiceFor, projectUndoFor, readChoicesFileSync, readProjectChoicesSync, removeProjectChoice, resolveRoleModels, resolveSetting, undoProjectChoice, writeProjectChoice, type ProjectUndo } from '../services/modelChoices';
import { roleUpdate, type RoleOption } from '../services/modelRoles';
import { DEFAULT_ROLE_MODELS } from '../gsd/library';
import { stateHomeFor } from '../services/stateHome';
import { tempProject } from './helpers/stateFixtures';

// Model comparisons and applied model choices follow the project (D-06, SYNC-06): kept in the project's state home, so a comparison or an applied
// recommendation made in one editor is listed and effective in another. Plain node, with real files.

function row(model: string): ResultRow {
  return { model, task: 'implement', kind: 'coding', taskVersion: 'implement-v1', run: 1, score: 8, outOf: 10, outcome: 'completed', seconds: 60, turns: 5, inputTokens: 1000, outputTokens: 500, generatingMs: 5000, costUsd: 0.01, costEstimated: false, stalls: 0, misses: [], at: '2026-11-12T00:00:00.000Z' };
}

function run(id: string, startedAt: string, model = 'tee/a'): SavedRun {
  return { format: 'near-ai-model-comparison', version: 1, id, startedAt, status: 'completed', taskSet: 'full', mode: 'rerun', runsPerTask: 1, models: [{ id: model, privacy: 'tee', catalogVersion: 'x' }], tasks: [{ id: 'implement', kind: 'coding', version: 'implement-v1' }], rows: [row(model)] };
}

async function editors(): Promise<{ root: string; globalA: string; globalB: string }> {
  const root = await tempProject();
  const globals = await mkdtemp(path.join(tmpdir(), 'near-ai-global-'));
  return { root, globalA: path.join(globals, 'a'), globalB: path.join(globals, 'b') };
}

test('tracer: a comparison saved in one editor is listed in another editor on the same host', async () => {
  const { root, globalA, globalB } = await editors();
  const editorA = comparisonStoreFor(globalA, root);
  const editorB = comparisonStoreFor(globalB, root);
  assert.deepEqual(await editorB.list(), [], 'nothing anywhere: the existing empty state');
  const saved = run('2026-11-12T10-00-00-000Z', '2026-11-12T10:00:00.000Z');
  await editorA.save(saved);
  assert.deepEqual(await readdir(path.join(globalB)).catch(() => []), [], "editor B's own folder holds nothing");
  assert.deepEqual((await editorB.list()).map((entry) => entry.id), [saved.id]);
  assert.deepEqual(await editorB.load(saved.id), saved);
  // The run also went to editor A's own folder, so other projects on that editor keep reusing it.
  assert.deepEqual((await new ComparisonStore(path.join(globalA, 'evals')).list()).map((entry) => entry.id), [saved.id]);
});

test('tracer: a model choice written by one editor is read, and wins over the user value, in another', async () => {
  const root = await tempProject();
  assert.deepEqual(readProjectChoicesSync(root), {}, 'no choices.json: empty');
  assert.equal(await writeProjectChoice(root, 'nearAi.agent.fastModel', 'm-fast', 'edA.1'), true);
  const choices = readProjectChoicesSync(root);
  assert.equal(choices['nearAi.agent.fastModel']?.value, 'm-fast');
  assert.equal(choices['nearAi.agent.fastModel']?.writer, 'edA.1');
  assert.equal(resolveSetting({ globalValue: 'user-fast', defaultValue: 'default-fast' }, choices['nearAi.agent.fastModel']?.value as string, 'default-fast'), 'm-fast');
  assert.equal(resolveSetting({ globalValue: 'user-fast' }, undefined, 'default-fast'), 'user-fast');
});

test('reading a project writes nothing, and a comparison run is never started to fill a gap', async () => {
  const { root, globalA } = await editors();
  const store = comparisonStoreFor(globalA, root);
  await store.list();
  await store.load('2026-11-12T10-00-00-000Z');
  await store.newId('2026-11-12T10-00-00-000Z');
  readProjectChoicesSync(root);
  assert.equal(await stateHomeFor(root).exists(), false, 'the state home was not created by reading');
  assert.deepEqual(await readdir(root), []);
});

// ---- resolution order and the project file (Task 2) ----

test('resolveSetting: folder value beats workspace value beats project choice beats user value beats default; an empty project value is ignored', () => {
  assert.equal(resolveSetting({ workspaceFolderValue: 'folder', workspaceValue: 'ws', globalValue: 'user' }, 'project', 'def'), 'folder');
  assert.equal(resolveSetting({ workspaceValue: 'ws', globalValue: 'user' }, 'project', 'def'), 'ws');
  assert.equal(resolveSetting({ globalValue: 'user' }, 'project', 'def'), 'project');
  assert.equal(resolveSetting({ globalValue: 'user' }, undefined, 'def'), 'user');
  assert.equal(resolveSetting({}, undefined, 'def'), 'def');
  assert.equal(resolveSetting(undefined, undefined, 'def'), 'def');
  assert.equal(resolveSetting({ globalValue: 'user' }, '', 'def'), 'user', 'an empty project value is not a choice');
  assert.equal(resolveSetting({ workspaceValue: '', globalValue: 'user' }, 'project', 'def'), 'project', 'an empty workspace value is not an explicit value either');
});

test('SYNC-06 empty edge: with no choices.json every reader falls back to the user value, then the default', async () => {
  const root = await tempProject();
  assert.deepEqual(readProjectChoicesSync(root), {});
  assert.deepEqual(readProjectChoicesSync(undefined), {});
  assert.equal(resolveSetting({ globalValue: 'user' }, projectChoiceFor(root, 'agent.fastModel') as string | undefined, 'def'), 'user');
  assert.equal(resolveSetting({}, projectChoiceFor(root, 'agent.fastModel') as string | undefined, 'def'), 'def');
});

test('SYNC-06 concurrency edge: two editors writing at once keep every setting either wrote, and the file is valid JSON', async () => {
  const root = await tempProject();
  await Promise.all([
    writeProjectChoice(root, 'nearAi.agent.fastModel', 'm-fast', 'edA.1'),
    writeProjectChoice(root, 'nearAi.agent.deepModel', 'm-deep', 'edB.1'),
    writeProjectChoice(root, 'nearAi.defaultModel', 'm-main', 'edC.1')
  ]);
  const file = JSON.parse(await readFile(stateHomeFor(root).paths.choices, 'utf8')) as { values: Record<string, { value: string }> };
  assert.deepEqual(Object.fromEntries(Object.entries(file.values).map(([name, entry]) => [name, entry.value])), { 'nearAi.agent.fastModel': 'm-fast', 'nearAi.agent.deepModel': 'm-deep', 'nearAi.defaultModel': 'm-main' });
  assert.deepEqual(Object.keys(readProjectChoicesSync(root)).sort(), ['nearAi.agent.deepModel', 'nearAi.agent.fastModel', 'nearAi.defaultModel']);
  assert.deepEqual((await readdir(stateHomeFor(root).dir)).filter((name) => name.includes('.tmp') || name.endsWith('.lock')), [], 'no temporary or lock file is left');
});

test('SYNC-06 concurrency edge: for one setting the later (at, writer) wins, whatever order the writes ran in', async () => {
  const root = await tempProject();
  await Promise.all(Array.from({ length: 12 }, (_unused, n) => writeProjectChoice(root, 'nearAi.agent.fastModel', `m-${n}`, `ed${n}.1`)));
  const entry = readProjectChoicesSync(root)['nearAi.agent.fastModel']!;
  const file = JSON.parse(await readFile(stateHomeFor(root).paths.choices, 'utf8')) as { values: Record<string, { value: string; at: string; writer: string }> };
  assert.equal(file.values['nearAi.agent.fastModel']?.value, entry.value);
  assert.match(entry.value as string, /^m-\d+$/);
  assert.equal(entry.writer, `ed${(entry.value as string).slice(2)}.1`, 'the value and the writer that wrote it stay together');
});

test('SYNC-06 idempotency edge: writing the same value twice leaves the file byte-identical and says nothing changed', async () => {
  const root = await tempProject();
  assert.equal(await writeProjectChoice(root, 'nearAi.agent.fastModel', 'm-fast', 'edA.1'), true);
  const first = await readFile(stateHomeFor(root).paths.choices, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await writeProjectChoice(root, 'nearAi.agent.fastModel', 'm-fast', 'edB.1'), false);
  assert.equal(await readFile(stateHomeFor(root).paths.choices, 'utf8'), first);
  // A role map is compared by content, not by key order.
  assert.equal(await writeProjectChoice(root, 'nearAi.agent.roleModels', { a: 'x', b: 'y' }, 'edA.1'), true);
  assert.equal(await writeProjectChoice(root, 'nearAi.agent.roleModels', { b: 'y', a: 'x' }, 'edA.1'), false);
});

test('a damaged choices.json, an unknown setting and an empty value are ignored, never trusted', async () => {
  const root = await tempProject();
  await stateHomeFor(root).ensure();
  const file = stateHomeFor(root).paths.choices;
  await writeFile(file, '{ broken');
  assert.deepEqual(readProjectChoicesSync(root), {});
  const entry = (value: unknown) => ({ value, at: '2026-11-12T00:00:00.000Z', writer: 'w' });
  await writeFile(file, JSON.stringify({ version: 1, values: { 'nearAi.agent.fastModel': entry('m-fast'), 'nearAi.baseUrl': entry('https://evil.example'), 'nearAi.agent.deepModel': entry('  '), 'nearAi.agent.standardModel': entry(7), 'nearAi.agent.roleModels': entry({ a: 5 }) } }));
  assert.deepEqual(Object.keys(readProjectChoicesSync(root)), ['nearAi.agent.fastModel']);
  await writeFile(file, JSON.stringify({ version: 2, values: { 'nearAi.agent.fastModel': entry('m-fast') } }));
  assert.deepEqual(readProjectChoicesSync(root), {}, 'a version this editor does not know is not read');
  await assert.rejects(writeProjectChoice(root, 'nearAi.baseUrl', 'x', 'w'), /not a setting a project can carry/);
});

test('the settings readers use the project choice unless the workspace sets the value explicitly', async () => {
  const root = await tempProject();
  const values: Record<string, { globalValue?: unknown; workspaceValue?: unknown }> = {
    'agent.fastModel': { globalValue: 'user-fast' },
    'agent.deepModel': { globalValue: 'user-deep', workspaceValue: 'ws-deep' },
    'agent.standardModel': { globalValue: 'user-standard' },
    defaultModel: { globalValue: 'user-main' },
    'agent.safetyModel': { globalValue: 'user-safety' },
    'agent.visionModel': { globalValue: 'user-vision' }
  };
  const stub = {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: root } }],
      getConfiguration: () => ({
        get: (key: string, fallback?: unknown) => values[key]?.workspaceValue ?? values[key]?.globalValue ?? fallback,
        inspect: (key: string) => values[key] ?? {}
      })
    }
  };
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? stub : originalLoad(request, parent, isMain);
  try {
    const settings = require('../services/settings') as typeof import('../services/settings');
    assert.deepEqual(settings.readModelTiers().fast, 'user-fast', 'no choices.json: the user value, as in 0.4.19');
    await writeProjectChoice(root, 'nearAi.agent.fastModel', 'project-fast', 'edA.1');
    await writeProjectChoice(root, 'nearAi.agent.deepModel', 'project-deep', 'edA.1');
    await writeProjectChoice(root, 'nearAi.defaultModel', 'project-main', 'edA.1');
    await writeProjectChoice(root, 'nearAi.agent.safetyModel', 'project-safety', 'edA.1');
    await writeProjectChoice(root, 'nearAi.agent.visionModel', 'project-vision', 'edA.1');
    await writeProjectChoice(root, 'nearAi.agent.roleModels', { 'gsd-planner': 'project-planner' }, 'edA.1');
    const tiers = settings.readModelTiers();
    assert.equal(tiers.fast, 'project-fast', 'the project choice beats the user value');
    assert.equal(tiers.deep, 'ws-deep', 'an explicit workspace value beats the project choice');
    assert.equal(tiers.standard, 'user-standard', 'no project choice: the user value');
    assert.equal(settings.readSettings().defaultModel, 'project-main');
    assert.equal(settings.readSafetyModel(tiers), 'project-safety');
    assert.equal(settings.readAgentModels().visionModel, 'project-vision');
    assert.equal(settings.readAgentModels().imageModel, 'black-forest-labs/FLUX.2-klein-4B', 'nothing set anywhere: the default');
    assert.deepEqual(settings.readRoleModels(), { ...DEFAULT_ROLE_MODELS, 'gsd-planner': 'project-planner' }, 'role by role: the project names one role, the rest keep the defaults');
  } finally {
    nodeModule._load = originalLoad;
  }
});

test('the tools directory names the project choice as the source of a model, and only then', async () => {
  const { resolveAgentModel } = await import('../services/toolsDirectory');
  const root = await tempProject();
  await writeProjectChoice(root, 'nearAi.agent.fastModel', 'project-fast', 'edA.1');
  const { choicesInEffect } = await import('../services/modelChoices');
  const inspect = (explicit: string[]) => (setting: string) => explicit.includes(setting) ? { workspaceValue: 'x' } : {};
  assert.deepEqual(choicesInEffect(root, inspect([])), ['nearAi.agent.fastModel']);
  assert.deepEqual(choicesInEffect(root, inspect(['agent.fastModel'])), [], 'an explicit workspace value means the project choice is not in effect');
  assert.deepEqual(choicesInEffect(undefined, inspect([])), []);
  const base = { policy: { mode: 'approve-risky' as const, emergencyStop: false }, rules: { allowCommands: [], denyCommands: [] }, webSearch: false, securityConsented: false, mcp: [], settings: { mainModel: 'main', tiers: { deep: 'd', standard: 's', fast: 'f' }, roleModels: { 'gsd-planner': 'fast' }, visionModel: 'v', transcriptionModel: 't', imageModel: 'i', safetyModel: 'sf' } };
  const plain = resolveAgentModel('gsd-planner', undefined, base as never, false);
  const fromProject = resolveAgentModel('gsd-planner', undefined, { ...base, settings: { ...base.settings, fromProject: ['nearAi.agent.roleModels'] } } as never, false);
  assert.equal(plain.source, 'role setting');
  assert.equal(fromProject.source, 'project choice');
  assert.equal(fromProject.model, 'f');
});

// ---- apply, undo and the import offer (Task 3) ----

test('planApply: the workspace when it sets the value explicitly (workspace or folder), otherwise the project; never user settings', () => {
  assert.equal(planApply({ workspaceValue: 'x' }), 'workspace');
  assert.equal(planApply({ workspaceFolderValue: 'x' }), 'workspace');
  assert.equal(planApply({ globalValue: 'user' }), 'project');
  assert.equal(planApply({}), 'project');
  assert.equal(planApply(undefined), 'project');
});

test('applying then undoing: a previous project choice comes back, a first-time choice is cleared, and no user setting is involved', async () => {
  const root = await tempProject();
  const setting = 'nearAi.agent.deepModel';
  // First time: there was no project choice, so undo removes it.
  const first = projectUndoFor(root, setting);
  assert.equal(first.previous, undefined);
  assert.equal(await writeProjectChoice(root, setting, 'm-1', 'edA.1'), true);
  assert.equal(projectChoiceFor(root, setting), 'm-1');
  // Second time: the previous project choice is m-1.
  const second = projectUndoFor(root, setting);
  assert.equal(second.previous, 'm-1');
  assert.equal(await writeProjectChoice(root, setting, 'm-2', 'edA.1'), true);
  assert.equal(projectChoiceFor(root, setting), 'm-2');
  await undoProjectChoice(second, 'edA.1');
  assert.equal(projectChoiceFor(root, setting), 'm-1', 'undo restores exactly what was there');
  await undoProjectChoice(first, 'edA.1');
  assert.equal(projectChoiceFor(root, setting), undefined, 'undoing a first-time choice removes it');
  // Plan 27-33: the undo is kept as a cleared entry, so another computer's older copy cannot bring the choice back.
  const file = JSON.parse(await readFile(stateHomeFor(root).paths.choices, 'utf8')) as { values: Record<string, { value: unknown }> };
  assert.deepEqual(Object.entries(file.values).map(([name, entry]) => [name, entry.value]), [['nearAi.agent.deepModel', null]], 'choices.json keeps a cleared entry for that setting');
});

test('undoing a role map unwinds several changes in reverse order and keeps other settings', async () => {
  const root = await tempProject();
  await writeProjectChoice(root, 'nearAi.agent.fastModel', 'm-fast', 'edA.1');
  const undoRoles: ProjectUndo[] = [];
  for (const [name, model] of [['gsd-planner', 'm-a'], ['gsd-verifier', 'm-b']] as const) {
    undoRoles.push(projectUndoFor(root, 'nearAi.agent.roleModels'));
    const current = (projectChoiceFor(root, 'nearAi.agent.roleModels') ?? {}) as Record<string, string>;
    await writeProjectChoice(root, 'nearAi.agent.roleModels', { ...current, [name]: model }, 'edA.1');
  }
  assert.deepEqual(projectChoiceFor(root, 'nearAi.agent.roleModels'), { 'gsd-planner': 'm-a', 'gsd-verifier': 'm-b' });
  for (const entry of [...undoRoles].reverse()) await undoProjectChoice(entry, 'edA.1');
  assert.equal(projectChoiceFor(root, 'nearAi.agent.roleModels'), undefined);
  assert.equal(projectChoiceFor(root, 'nearAi.agent.fastModel'), 'm-fast', 'another setting is untouched by the undo');
});

test('SYNC-06 idempotency edge: applying the same recommendation twice leaves choices.json byte-identical and records no second undo', async () => {
  const root = await tempProject();
  const applyOnce = async (): Promise<boolean> => writeProjectChoice(root, 'nearAi.agent.deepModel', 'm-best', 'edA.1');
  assert.equal(await applyOnce(), true);
  const bytes = await readFile(stateHomeFor(root).paths.choices, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await applyOnce(), false, 'nothing changed, so the panel records no undo entry');
  assert.equal(await readFile(stateHomeFor(root).paths.choices, 'utf8'), bytes);
});

test('removing a choice that is not there writes nothing, and never creates the state home', async () => {
  const root = await tempProject();
  assert.equal(await removeProjectChoice(root, 'nearAi.agent.deepModel', 'edA.1'), false);
  assert.equal(await stateHomeFor(root).exists(), false);
});

test('importOffer lists user-level choices that differ from the default, and nothing is copied by listing', async () => {
  const root = await tempProject();
  const inspected = {
    'nearAi.agent.deepModel': { globalValue: 'user-deep', defaultValue: 'default-deep' },
    'nearAi.agent.fastModel': { globalValue: 'default-fast', defaultValue: 'default-fast' },
    'nearAi.agent.standardModel': { defaultValue: 'default-standard' },
    'nearAi.agent.roleModels': { globalValue: { 'gsd-planner': 'user-p' }, defaultValue: { 'gsd-planner': 'fast' } }
  };
  const offer = importOffer(inspected, { version: 1, values: {} });
  assert.deepEqual(offer, [{ setting: 'nearAi.agent.deepModel', value: 'user-deep' }, { setting: 'nearAi.agent.roleModels', value: { 'gsd-planner': 'user-p' } }]);
  assert.deepEqual(readProjectChoicesSync(root), {}, 'listing copied nothing');
  assert.equal(await stateHomeFor(root).exists(), false);
  // The panel's short names work as well as the full ones.
  assert.deepEqual(importOffer({ 'agent.deepModel': { globalValue: 'u', defaultValue: 'd' } }, { version: 1, values: {} }), [{ setting: 'nearAi.agent.deepModel', value: 'u' }]);
});

test('SYNC-06 adjacency edge: no offer when the user value equals the project choice or the default, or every setting already has a project choice', async () => {
  const root = await tempProject();
  await writeProjectChoice(root, 'nearAi.agent.deepModel', 'same', 'edA.1');
  const choices = readChoicesFileSync(root);
  assert.deepEqual(importOffer({ 'nearAi.agent.deepModel': { globalValue: 'same', defaultValue: 'd' } }, choices), [], 'equal to the project choice');
  assert.deepEqual(importOffer({ 'nearAi.agent.deepModel': { globalValue: 'other', defaultValue: 'd' } }, choices), [], 'the project already has its own choice, which is never replaced silently');
  assert.deepEqual(importOffer({ 'nearAi.agent.fastModel': { globalValue: 'd', defaultValue: 'd' } }, choices), [], 'equal to the default');
  for (const setting of PROJECT_CHOICE_SETTINGS) await writeProjectChoice(root, setting, setting === 'nearAi.agent.roleModels' ? { a: 'x' } : `m-${setting}`, 'edA.1');
  const all = Object.fromEntries(PROJECT_CHOICE_SETTINGS.map((setting) => [setting, { globalValue: setting === 'nearAi.agent.roleModels' ? { z: 'q' } : 'user-value', defaultValue: setting === 'nearAi.agent.roleModels' ? {} : 'd' }]));
  assert.deepEqual(importOffer(all, readChoicesFileSync(root)), []);
});

test("'Not now' is remembered for the project: no further offer, and the other choices are kept", async () => {
  const root = await tempProject();
  const inspected = { 'nearAi.agent.deepModel': { globalValue: 'user-deep', defaultValue: 'd' } };
  assert.equal(importOffer(inspected, readChoicesFileSync(root)).length, 1);
  await writeProjectChoice(root, 'nearAi.agent.fastModel', 'm-fast', 'edA.1');
  await declineImport(root, 'edA.1');
  const choices = readChoicesFileSync(root);
  assert.equal(choices.importDeclined, true);
  assert.deepEqual(importOffer(inspected, choices), []);
  assert.equal(projectChoiceFor(root, 'agent.fastModel'), 'm-fast');
  assert.equal(projectChoiceFor(root, 'agent.deepModel'), undefined, 'nothing was copied without a click');
});

test("'Use for this project' writes each offered value, and then there is nothing left to offer", async () => {
  const root = await tempProject();
  const inspected = { 'nearAi.agent.deepModel': { globalValue: 'user-deep', defaultValue: 'd' }, 'nearAi.defaultModel': { globalValue: 'user-main', defaultValue: 'd' } };
  const offer = importOffer(inspected, readChoicesFileSync(root));
  assert.equal(offer.length, 2);
  for (const candidate of offer) await writeProjectChoice(root, candidate.setting, candidate.value, 'edA.1');
  assert.equal(projectChoiceFor(root, 'defaultModel'), 'user-main');
  assert.deepEqual(importOffer(inspected, readChoicesFileSync(root)), []);
});

// ---- one role writes one role (plan 27-33, Task 1) ----

const plannerOption = { id: 'role:gsd-planner', label: 'Planner (gsd-planner)', group: 'Agent roles', setting: 'agent.roleModels' } as RoleOption;
const verifierOption = { id: 'role:gsd-verifier', label: 'Verifier (gsd-verifier)', group: 'Agent roles', setting: 'agent.roleModels' } as RoleOption;
const executorOption = { id: 'role:gsd-executor', label: 'Executor (gsd-executor)', group: 'Agent roles', setting: 'agent.roleModels' } as RoleOption;

test('tracer: putting a model into one role writes only that role into the project, and the others keep following the user setting', async () => {
  const root = await tempProject();
  const user = { 'gsd-executor': 'user-y' };
  const inspect = (globalValue: Record<string, string>) => ({ defaultValue: DEFAULT_ROLE_MODELS, globalValue });
  // The apply starts from the project's own layer (empty), never from the resolved roles.
  const layer = (projectChoiceFor(root, 'agent.roleModels') ?? {}) as Record<string, string>;
  const update = roleUpdate(plannerOption, 'model-x', layer);
  assert.deepEqual(update, { setting: 'agent.roleModels', value: { 'gsd-planner': 'model-x' } });
  assert.equal(await writeProjectChoice(root, 'nearAi.agent.roleModels', update.value as Record<string, string>, 'edA.1'), true);
  assert.deepEqual(projectChoiceFor(root, 'agent.roleModels'), { 'gsd-planner': 'model-x' }, 'exactly the one role');
  const resolved = resolveRoleModels(inspect(user), projectChoiceFor(root, 'agent.roleModels'), DEFAULT_ROLE_MODELS);
  assert.equal(resolved['gsd-planner'], 'model-x');
  assert.equal(resolved['gsd-executor'], 'user-y');
  for (const [role, model] of Object.entries(DEFAULT_ROLE_MODELS)) if (role !== 'gsd-planner' && role !== 'gsd-executor') assert.equal(resolved[role], model, `${role} keeps its default`);
  // The person changes their own setting later: it still takes effect for the roles the project did not choose.
  assert.equal(resolveRoleModels(inspect({ 'gsd-executor': 'user-z' }), projectChoiceFor(root, 'agent.roleModels'), DEFAULT_ROLE_MODELS)['gsd-executor'], 'user-z');
});

test('when the workspace already sets roleModels, the apply extends only the workspace value and nothing goes to the project', async () => {
  const root = await tempProject();
  const workspaceValue = { 'gsd-verifier': 'model-w' };
  assert.equal(planApply({ workspaceValue }), 'workspace');
  assert.deepEqual(roleUpdate(plannerOption, 'model-x', workspaceValue), { setting: 'agent.roleModels', value: { 'gsd-verifier': 'model-w', 'gsd-planner': 'model-x' } });
  assert.equal(projectChoiceFor(root, 'agent.roleModels'), undefined, 'nothing was written to the project');
  assert.equal(await stateHomeFor(root).exists(), false);
});

test('apply recommended for three roles writes a project roleModels holding only those roles, plus what the project had chosen before', async () => {
  const root = await tempProject();
  await writeProjectChoice(root, 'nearAi.agent.roleModels', { 'gsd-debugger': 'earlier' }, 'edA.1');
  let layer = { ...(projectChoiceFor(root, 'agent.roleModels') as Record<string, string>) };
  for (const [option, model] of [[plannerOption, 'm-1'], [verifierOption, 'm-2'], [executorOption, 'm-3']] as const) {
    const update = roleUpdate(option, model, layer);
    assert.equal(await writeProjectChoice(root, 'nearAi.agent.roleModels', update.value as Record<string, string>, 'edA.1'), true);
    layer = { ...(update.value as Record<string, string>) };
  }
  assert.deepEqual(projectChoiceFor(root, 'agent.roleModels'), { 'gsd-debugger': 'earlier', 'gsd-planner': 'm-1', 'gsd-verifier': 'm-2', 'gsd-executor': 'm-3' });
});

test('resolveRoleModels resolves role by role: default, user, project, workspace, folder; empty and non-string entries are ignored', () => {
  const resolved = resolveRoleModels(
    { defaultValue: { a: 'd-a', b: 'd-b', c: 'd-c', d: 'd-d', e: 'd-e' }, globalValue: { b: 'u-b', c: 'u-c', d: 'u-d', e: 'u-e' }, workspaceValue: { d: 'w-d', e: 'w-e' }, workspaceFolderValue: { e: 'f-e' } },
    { c: 'p-c', d: 'p-d', e: 'p-e' },
    { never: 'used' }
  );
  assert.deepEqual(resolved, { a: 'd-a', b: 'u-b', c: 'p-c', d: 'w-d', e: 'f-e' });
  assert.deepEqual(resolveRoleModels({ globalValue: { a: '  ', b: 5, c: null, d: ' ok ', '': 'x' } as never }, undefined, { z: 'fallback' }), { z: 'fallback', d: 'ok' }, 'the fallback stands in when there is no default; junk is dropped');
  assert.deepEqual(resolveRoleModels({ globalValue: 'not an object' as never, workspaceValue: ['x'] as never }, 'nope', {}), {});
  assert.deepEqual(resolveRoleModels(undefined, undefined, { a: 'x' }), { a: 'x' });
});

test('the settings readers stat choices.json at most once a second, and a write or a clear here is seen at once', async () => {
  const root = await tempProject();
  await writeProjectChoice(root, 'nearAi.agent.fastModel', 'm-fast', 'edA.1');
  const file = stateHomeFor(root).paths.choices;
  let stats = 0;
  let clock = 1_000_000;
  const options = { status: (path: string) => { stats += 1; return statSync(path); }, now: () => clock };
  for (let n = 0; n < 50; n += 1) for (const setting of PROJECT_CHOICE_SETTINGS) projectChoiceFor(root, setting, options);
  assert.equal(stats, 1, '450 resolutions inside one second looked at the file once');
  assert.equal(projectChoiceFor(root, 'agent.fastModel', options), 'm-fast');
  clock += CHOICES_STAT_TTL_MS + 1;
  projectChoiceFor(root, 'agent.fastModel', options);
  assert.equal(stats, 2, 'after the window it looks again');
  // A write in this process is seen at once, with no wait for the window.
  assert.equal(await writeProjectChoice(root, 'nearAi.agent.fastModel', 'm-newer', 'edA.1'), true);
  assert.equal(projectChoiceFor(root, 'agent.fastModel', options), 'm-newer');
  assert.equal(await removeProjectChoice(root, 'nearAi.agent.fastModel', 'edA.1'), true);
  assert.equal(projectChoiceFor(root, 'agent.fastModel', options), undefined);
  assert.deepEqual(choicesInEffect(root, () => ({}), options), []);
  assert.equal(await mergeProjectChoices(root, { 'nearAi.defaultModel': { value: 'm-merged', at: '2999-01-01T00:00:00.000Z', writer: 'edB.1' } }), true);
  assert.equal(projectChoiceFor(root, 'defaultModel', options), 'm-merged');
  assert.ok(file.endsWith('choices.json'));
});
