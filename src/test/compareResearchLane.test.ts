// Compare Models in the research lane, and putting a model to work (74.1-10 Task 2, D-17, D-18, 74.1-UI-SPEC S3): task requests carry a synthetic
// comparison in the research lane (lane t0 in records); a job is offered only when the model's approval covers the job's use, otherwise it is disabled
// with the reason in words, and the host refuses a crafted apply.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { COMPARE_USE, runAgentInFolder } from '../benchmark/runner';
import { SHIPPED_DEFAULT_LABEL } from '../domain/gate/bundle';
import { DEFAULT_ROUTING } from '../domain/gate/routing';
import { useTierFor } from '../domain/gate/useTier';
import type { CompletionEvent } from '../domain/provider/messages';
import { currentSessionRoute, routeRecordFor } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { applyAllLeftOutText, applyRefusedText, modelApprovals, roleApproved, roleNotApprovedText, roleOptions, roleReason } from '../services/modelRoles';
import { parseComparisonMessage } from '../services/modelComparisonPage';
import { testGateRuntime } from './helpers/gatedRuns';

const GLM = 'z-ai/glm-5.3';
const GPT_OSS = 'openai/gpt-oss-120b';
const NOW = Date.parse('2026-11-25T00:00:00Z');
const catalog = [{ id: GLM, privacyBoundary: 'tee' as const }, { id: GPT_OSS, privacyBoundary: 'tee' as const }];
const roles = roleOptions({ mainModel: GPT_OSS, tiers: { deep: GPT_OSS, standard: GPT_OSS, fast: GPT_OSS }, roleModels: {} }, catalog);

test('D-17: a comparison task\'s requests run in a synthetic comparison in the research lane, research only, and their records say lane t0', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'compare-lane-'));
  const seen: SessionRoute[] = [];
  const client = {
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      seen.push(currentSessionRoute() as SessionRoute);
      yield { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } } as CompletionEvent;
    },
    async completeOnce() { return { text: '', usage: {} as never }; }
  };
  await runAgentInFolder(client as never, GLM, root, 'solve it', { maxTurns: 1, rules: DEFAULT_RULES, gate: testGateRuntime({ presence: 'none', context: 'unattended' }) });
  const use = seen[0]?.useOf?.();
  assert.equal(use?.compare, 'synthetic');
  assert.equal(use?.lane, 'research');
  assert.equal(useTierFor(use ?? {}), 'T0', 'unattended with tools, still research only');
  const facts = { clientRoute: 'near' as const, host: 'https://cloud-api.near.ai/v1', nearEndpoint: true, model: { id: GLM, privacyBoundary: 'tee' as const }, attestationFailed: false };
  const record = routeRecordFor(seen[0] as SessionRoute, { allowed: true, tier: 'any-cloud', rule: 'route.any-cloud' }, facts, { model: GLM }, { mark: [], defaultLabel: SHIPPED_DEFAULT_LABEL, bundleHash: '', routing: DEFAULT_ROUTING });
  assert.equal(record.unmapped.nearAi.lane, 't0');
  assert.deepEqual(COMPARE_USE, { compare: 'synthetic', lane: 'research' });
});

test('D-18: a PRC-origin model is approved for research only, so every job is not offered and the reason says why', () => {
  const approvals = modelApprovals([GLM], catalog, undefined, NOW);
  assert.equal(approvals[GLM]?.covers, 'T0');
  assert.ok(roles.length > 4);
  for (const role of roles) assert.equal(roleApproved(approvals[GLM], role), false, role.id);
  assert.equal(roleReason(GLM, approvals[GLM], roles), 'z-ai/glm-5.3 is approved for research only, so it cannot be put to work for any job.');
  assert.equal(roleNotApprovedText('Standard tier'), 'Standard tier (not approved)');
});

test('D-18: gpt-oss-120b is approved for agent work, so the standard job is offered and no reason line shows', () => {
  const approvals = modelApprovals([GPT_OSS], catalog, undefined, NOW);
  assert.equal(approvals[GPT_OSS]?.covers, 'T2');
  const standard = roles.find((role) => role.id === 'tier:standard');
  assert.ok(standard);
  assert.equal(roleApproved(approvals[GPT_OSS], standard), true);
  assert.equal(roleReason(GPT_OSS, approvals[GPT_OSS], roles), undefined);
});

test('D-18: a model approved for chat you review is offered no job that needs agent work, with the reason line', () => {
  const reviewed = { covers: 'T1' as const };
  assert.equal(roles.every((role) => !roleApproved(reviewed, role)), true);
  assert.equal(roleReason('example/model', reviewed, roles), 'example/model is approved for chat you review, so jobs that need more are not offered.');
});

test('T-74.1-33: the host\'s refusal of a crafted apply names the model, its approval and the job\'s need, and says nothing changed', () => {
  const standard = roles.find((role) => role.id === 'tier:standard');
  assert.ok(standard);
  assert.equal(applyRefusedText(GLM, { covers: 'T0' }, standard), 'Not applied. z-ai/glm-5.3 is approved for research only, and the Standard tier needs agent work. No setting was changed.');
  assert.equal(applyAllLeftOutText(1), '1 recommended change left out: its model is not approved for that job.');
  assert.equal(applyAllLeftOutText(3), '3 recommended changes left out: their models are not approved for those jobs.');
});

test('the lane line\'s link is a message the host accepts only bare', () => {
  assert.deepEqual(parseComparisonMessage({ type: 'open-research-workspace' }), { type: 'open-research-workspace' });
  assert.equal(parseComparisonMessage({ type: 'open-research-workspace', path: '/etc' }), undefined);
});
