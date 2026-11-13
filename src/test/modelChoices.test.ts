import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { comparisonStoreFor, ComparisonStore } from '../benchmark/store';
import type { ResultRow, SavedRun } from '../benchmark/results';
import { readProjectChoicesSync, resolveSetting, writeProjectChoice } from '../services/modelChoices';
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
