import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AGENT_DEFAULTS } from '../domain/agentDefaults';
import { DEFAULT_MODEL } from '../domain/config';
import { DEFAULT_ROLE_MODELS } from '../gsd/library';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

// The defaults users see in Settings (package.json) are the ones the code and the live tests use.

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
// Loaded after the stub: these modules import vscode.
const settings = require('../services/settings') as typeof import('../services/settings');
const jobModels = require('../services/jobModels') as typeof import('../services/jobModels');
test.after(() => { uninstall(); });

const ROOT = path.join(__dirname, '..', '..');
const MODEL_SETTINGS = ['nearAi.defaultModel', 'nearAi.agent.standardModel', 'nearAi.agent.deepModel', 'nearAi.agent.fastModel', 'nearAi.agent.safetyModel', 'nearAi.agent.backupModel', 'nearAi.agent.visionModel', 'nearAi.agent.transcriptionModel', 'nearAi.agent.imageModel'];

function packageProps(): Record<string, { default: unknown; description?: string; markdownDescription?: string }> {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const configuration = pkg.contributes.configuration;
  return (Array.isArray(configuration) ? configuration[0] : configuration).properties;
}

test('package.json declares the same agent defaults the code and the live tests use', () => {
  const props = packageProps();
  const expected: Record<string, unknown> = {
    'nearAi.agent.maxTurns': AGENT_DEFAULTS.maxTurns, 'nearAi.agent.maxParallelAgents': AGENT_DEFAULTS.maxParallelAgents,
    'nearAi.agent.maxRunCostUsd': AGENT_DEFAULTS.maxRunCostUsd, 'nearAi.agent.maxRunTokens': AGENT_DEFAULTS.maxRunTokens,
    'nearAi.agent.maxOutputTokens': AGENT_DEFAULTS.maxOutputTokens, 'nearAi.agent.approvalTimeoutMinutes': AGENT_DEFAULTS.approvalTimeoutMinutes,
    'nearAi.agent.roleModels': DEFAULT_ROLE_MODELS, 'nearAi.agent.imageReview': AGENT_DEFAULTS.imageReview
  };
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(props[key]?.default, value, key);
});

test('74.1 D-18: every model setting defaults to empty, and its description says empty means your organization\'s default, else the shipped one', () => {
  const props = packageProps();
  for (const key of MODEL_SETTINGS) {
    assert.equal(props[key]?.default, '', key);
    if (key.endsWith('safetyModel') || key.endsWith('backupModel')) continue;
    assert.match(props[key]?.description ?? props[key]?.markdownDescription ?? '', /Empty \(the default\): your organization's default for this job, else the shipped one\./, key);
  }
});

test('74.1-05 (coordinator option a): an unset model setting reads as the report fallback, never empty; a person\'s value is read exactly', () => {
  // As VS Code reads an unset setting: its package default, "".
  for (const key of MODEL_SETTINGS) stub.setConfig(key, '');
  assert.deepEqual(settings.readModelTiers(), { deep: AGENT_DEFAULTS.reportFallback.deep, standard: AGENT_DEFAULTS.reportFallback.standard, fast: AGENT_DEFAULTS.reportFallback.fast });
  assert.deepEqual(settings.readAgentModels(), { visionModel: AGENT_DEFAULTS.reportFallback.vision, transcriptionModel: AGENT_DEFAULTS.reportFallback.transcription, imageModel: AGENT_DEFAULTS.reportFallback.image });
  assert.equal(settings.readSafetyModel(), AGENT_DEFAULTS.reportFallback.fast);
  assert.equal(settings.readSettings().defaultModel, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, AGENT_DEFAULTS.reportFallback.standard, 'derived, not a second literal');
  assert.deepEqual(Object.values(settings.readJobSettings()).filter((value) => value !== ''), [], 'the person\'s own values: none set');
  stub.setConfig('nearAi.agent.standardModel', 'example/Western-Chat-8B');
  assert.equal(settings.readModelTiers().standard, 'example/Western-Chat-8B');
  assert.equal(settings.readJobSettings().standard, 'example/Western-Chat-8B');
});

test('74.1 D-18: jobModelsFor resolves every run job through resolveJobModel, a person\'s own value first', () => {
  const unset = { standard: '', deep: '', fast: '', safety: '', backup: '', vision: '', transcription: '', image: '' };
  const catalog = [{ id: 'openai/gpt-oss-120b' }, { id: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8' }];
  const models = jobModels.jobModelsFor(catalog, () => true, { read: () => ({ ...unset, deep: 'example/Western-Chat-8B' }), models: { v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [] }, now: Date.parse('2026-12-01T00:00:00Z') });
  assert.deepEqual(models.standard, { model: 'openai/gpt-oss-120b', source: 'shipped' });
  assert.deepEqual(models.fast, { model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8', source: 'shipped' });
  assert.deepEqual(models.safety, { model: 'openai/gpt-oss-120b', source: 'shipped' });
  assert.deepEqual(models.deep, { model: 'example/Western-Chat-8B', source: 'set-by-you' });
  assert.equal(models.vision.model, undefined, 'no Command A+ in this catalogue, and enforce has no fallback');
});

/** Every .ts file under src/, test files and folders excluded. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== 'test') sourceFiles(full, out); } else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('74.1 D-18: no file under src/ but agentDefaults.ts and shippedPassports.ts holds a model id literal outside comments', () => {
  const prefixes = ['z-ai', 'zai-org', 'moonshotai', 'Qwen', 'deepseek-ai', 'nvidia', 'openai', 'anthropic', 'google', 'x-ai', 'black-forest-labs', 'CohereLabs', 'ibm-granite'];
  const literal = new RegExp(`['"\`](?:${prefixes.join('|')})/[A-Za-z0-9._-]+['"\`]`);
  const allowed = new Set(['src/domain/agentDefaults.ts', 'src/domain/gate/shippedPassports.ts']);
  const found: string[] = [];
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (allowed.has(relative)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => { if (!/^\s*(\/\/|\*|\/\*)/.test(line) && literal.test(line)) found.push(`${relative}:${String(index + 1)}`); });
  }
  assert.deepEqual(found, []);
});
