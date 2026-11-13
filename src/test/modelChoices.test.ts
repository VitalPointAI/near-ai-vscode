import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { comparisonStoreFor, ComparisonStore } from '../benchmark/store';
import type { ResultRow, SavedRun } from '../benchmark/results';
import { projectChoiceFor, readProjectChoicesSync, resolveSetting, writeProjectChoice } from '../services/modelChoices';
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
    assert.deepEqual(settings.readRoleModels(), { 'gsd-planner': 'project-planner' });
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
