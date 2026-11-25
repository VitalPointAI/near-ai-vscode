// The picker and the model directory rows (74.1-12 Task 1, D-21, 74.1-UI-SPEC S4, S5, Q1, Q5): where each model runs, where it comes from, its family
// and what it is approved for; under enforce a model the chat's use forbids is disabled with the reason as text; in report mode it is marked; no bare
// "Private" and no tier name; the picker and the directory read the same words.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelInfo } from '../domain/provider/messages';
import { PRIVATE_MODEL_LABEL, modelOptions } from '../services/chatBridge';
import { buildToolsDirectory } from '../services/toolsDirectory';
import type { DirectoryInput } from '../services/toolsDirectory';
import { DEFAULT_RULES } from '../agent/permissions';
import { setModelRowContext } from '../services/chatBridge';

const NOW = Date.parse('2026-11-25T00:00:00Z');
const catalog: ModelInfo[] = [
  { id: 'openai/gpt-oss-120b', privacyBoundary: 'tee' },
  { id: 'z-ai/glm-5.3', privacyBoundary: 'tee' },
  { id: 'anthropic/claude-sonnet-5', privacyBoundary: 'cloud', forwardedTo: 'anthropic' },
  { id: 'llama3.3:70b', privacyBoundary: 'local' }
];
const enforce = { section: { v: 1 as const, mode: 'enforce' as const, unknownMaxTier: 'T0' as const }, organization: true, use: 'T2' as const, now: NOW };
const report = { organization: false, use: 'T2' as const, now: NOW };
const option = (options: ReturnType<typeof modelOptions>, id: string) => options.find((entry) => entry.id === id);

test('D-21, Q5: gpt-oss-120b on NEAR AI private hardware reads its Runs on words, United States, GPT and "Approved for agent work until {date}"', () => {
  const gpt = option(modelOptions(catalog, undefined, enforce), 'openai/gpt-oss-120b');
  assert.equal(gpt?.group, 'Runs on NEAR AI private hardware (checked each time it is used)');
  assert.match(gpt?.text ?? '', /^gpt-oss-120b · United States · GPT · Approved for agent work until \d{1,2} [A-Z][a-z]{2} \d{4}$/);
  assert.equal(gpt?.disabled, false);
  assert.match(gpt?.label ?? '', /^openai\/gpt-oss-120b · United States · GPT · /, 'the title repeats the row with the full model id');
});

test('D-21, Q1: under enforce, GLM reads China and Research only, and is disabled with "Approved for research only; this chat is agent work" as text', () => {
  const glm = option(modelOptions(catalog, undefined, enforce), 'z-ai/glm-5.3');
  assert.equal(glm?.text, 'glm-5.3 · China · GLM · Research only; this chat is agent work');
  assert.equal(glm?.disabled, true);
  assert.equal(glm?.savedForbidden, 'z-ai/glm-5.3 is not approved for this chat\'s use, so this chat uses openai/gpt-oss-120b instead.');
});

test('Q1: in report mode nothing is disabled for its approval; a row outside the policy says so (your rules, with no organization layer)', () => {
  const glm = option(modelOptions(catalog, undefined, report), 'z-ai/glm-5.3');
  assert.equal(glm?.disabled, false);
  assert.equal(glm?.text, 'glm-5.3 · China · GLM · Research only; outside your rules for models (report only)');
  const organization = option(modelOptions(catalog, undefined, { ...report, organization: true }), 'z-ai/glm-5.3');
  assert.match(organization?.text ?? '', /outside your organization's model policy \(report only\)$/);
});

test('D-21: a forwarded model reads "outside provider ({name})", a local one "this computer"; groups come in the contract\'s order', () => {
  const options = modelOptions(catalog, undefined, report);
  assert.equal(option(options, 'anthropic/claude-sonnet-5')?.group, 'Runs on outside provider (anthropic)');
  assert.equal(option(options, 'llama3.3:70b')?.group, 'Runs on this computer');
  assert.deepEqual([...new Set(options.map((entry) => entry.group))], ['Runs on this computer', 'Runs on NEAR AI private hardware (checked each time it is used)', 'Runs on outside provider (anthropic)']);
  assert.equal(option(options, 'llama3.3:70b')?.text, 'llama3.3:70b · origin unknown · family unknown · Research only; outside your rules for models (report only)');
});

test('D-21, S4: no row says a bare "Private" or names a tier; PRIVATE_MODEL_LABEL is the NEAR AI place words', () => {
  assert.equal(PRIVATE_MODEL_LABEL, 'NEAR AI private hardware (checked each time it is used)');
  for (const entry of [...modelOptions(catalog, undefined, enforce), ...modelOptions(catalog, undefined, report)]) {
    for (const words of [entry.group, entry.text, entry.label]) {
      assert.doesNotMatch(words, /(^|[^a-z])Private\b/, words);
      assert.doesNotMatch(words, /\bT[0-3]\b|tier/i, words);
    }
  }
});

test('T-74.1-48: the model directory\'s facts line uses the same words as the picker for the same model', () => {
  const stop = setModelRowContext(() => enforce);
  try {
    const directory = buildToolsDirectory({
      teams: [], policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, webSearch: false, securityConsented: true, mcp: [], models: catalog,
      settings: { mainModel: '', tiers: { deep: '', standard: '', fast: '' }, roleModels: {}, visionModel: '', transcriptionModel: '', imageModel: '', safetyModel: '' }
    } as DirectoryInput);
    const picker = modelOptions(catalog, undefined, enforce);
    for (const model of directory.models) {
      const row = option(picker, model.id);
      assert.ok(row, model.id);
      // The facts line is "Runs on {place} · {origin} · {family} · {approval}"; the picker row is "{short} · {origin} · {family} · {approval}".
      const [place, ...rest] = model.facts.split(' · ');
      assert.equal(place, row.group);
      assert.ok(row.label.startsWith(`${model.id} · ${rest.slice(0, 2).join(' · ')}`), `${model.id}: ${model.facts} / ${row.label}`);
      assert.doesNotMatch(model.facts, /this chat is/, 'the directory greys nothing');
    }
    assert.equal(directory.models.find((model) => model.id === 'z-ai/glm-5.3')?.facts, 'Runs on NEAR AI private hardware (checked each time it is used) · China · GLM · Research only');
  } finally {
    stop();
  }
});
