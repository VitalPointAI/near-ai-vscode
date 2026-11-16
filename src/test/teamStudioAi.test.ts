import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrivateRoute } from '../services/agentSession';
import type { AgentMessage, ModelInfo } from '../services/nearAiClient';
import { chooseTeamModel, teamModelCall, type TeamAiDeps } from '../services/teamStudioAi';

// 0.4.27: every Team Studio model call (drafting a team, Improve with AI) passes the same outbound check as chat, and a call that needs a private model
// gets a NEAR TEE model on an attested route or a local model, or does not happen.

const TEE: ModelInfo = { id: 'z-ai/glm-5.3', privacyBoundary: 'tee', attestationSupported: true, inputPricePerMillion: 1, outputPricePerMillion: 2 };
const FORWARDED: ModelInfo = { id: 'deepseek/flash', privacyBoundary: 'cloud', forwardedTo: 'openrouter.ai' };
const LOCAL: ModelInfo = { id: 'local/qwen', privacyBoundary: 'local' };
const IMAGE: ModelInfo = { id: 'img/maker', privacyBoundary: 'tee', outputModalities: ['image'] };
const NEAR: PrivateRoute = { kind: 'near', attestation: true };
const OTHER_ENDPOINT: PrivateRoute = { kind: 'near', attestation: false };
const LOCAL_ROUTE: PrivateRoute = { kind: 'local', attestation: false };

const routes = (near: PrivateRoute = NEAR) => (model: ModelInfo) => (model.privacyBoundary === 'local' ? LOCAL_ROUTE : near);
const standard = { privacyMode: 'standard' as const, dailySpendLimitUsd: 0, actionPolicy: { mode: 'approve-risky' as const, emergencyStop: false } };

function deps(overrides: Partial<TeamAiDeps> = {}): TeamAiDeps & { sent: Array<{ model: string; messages: AgentMessage[] }> } {
  const sent: Array<{ model: string; messages: AgentMessage[] }> = [];
  return {
    models: [FORWARDED, TEE, LOCAL], preferred: [FORWARDED.id, TEE.id], routeFor: routes(), privacyMode: 'standard',
    settings: standard, spentTodayUsd: async () => 0,
    complete: async (model, messages) => { sent.push({ model, messages }); return { text: '{"ok":true}', finishReason: 'stop' }; },
    ...overrides, sent
  };
}
const call = { need: 'any' as const, messages: [{ role: 'system' as const, content: 'Design a team.' }, { role: 'user' as const, content: 'A research team' }], maxTokens: 100 };

test('a Team Studio call passes the outbound check and then goes to the preferred model', async () => {
  const d = deps();
  const result = await teamModelCall(d, call);
  assert.deepEqual(result, { ok: true, text: '{"ok":true}', model: FORWARDED.id, private: false, finishReason: 'stop' });
  assert.equal(d.sent.length, 1);
});

test('TEE-only mode: a Team Studio call never goes to a forwarded model, and with only forwarded models nothing is sent', async () => {
  const teeOnly = { ...standard, privacyMode: 'tee-only' as const };
  const d = deps({ settings: teeOnly, privacyMode: 'tee-only' });
  const result = await teamModelCall(d, call);
  assert.equal(result.ok && result.model, TEE.id, 'the forwarded deep-tier model is passed over for a TEE one');
  const none = deps({ settings: teeOnly, privacyMode: 'tee-only', models: [FORWARDED] });
  const refused = await teamModelCall(none, call);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.reason, /TEE-only mode is on/);
  assert.equal(none.sent.length, 0, 'nothing reached a provider');
  // Even when the choice is forced onto a forwarded model, the guard itself refuses it.
  const forced = deps({ settings: teeOnly, privacyMode: 'standard', models: [FORWARDED] });
  const guarded = await teamModelCall(forced, call);
  assert.equal(guarded.ok, false);
  assert.match(guarded.ok ? '' : guarded.reason, /TEE-only mode is on, and deepseek\/flash does not run in NEAR's TEE \(NEAR forwards it to openrouter\.ai\)/);
  assert.equal(forced.sent.length, 0);
});

test('the daily spend limit and emergency stop stop a Team Studio call before it is sent', async () => {
  const limited = deps({ settings: { ...standard, dailySpendLimitUsd: 5 }, spentTodayUsd: async () => 5.25 });
  const result = await teamModelCall(limited, call);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /Today's NEAR AI spend \(\$5\.25\) has reached your daily limit of \$5\.00/);
  assert.equal(limited.sent.length, 0);
  const under = deps({ settings: { ...standard, dailySpendLimitUsd: 5 }, spentTodayUsd: async () => 4.99 });
  assert.equal((await teamModelCall(under, call)).ok, true);
  const stopped = deps({ settings: { ...standard, actionPolicy: { mode: 'approve-risky', emergencyStop: true } } });
  const halted = await teamModelCall(stopped, call);
  assert.match(halted.ok ? '' : halted.reason, /Emergency stop is on/);
  assert.equal(stopped.sent.length, 0);
});

test('a credential or personal data in what would be sent is refused in plain words, with no override', async () => {
  const d = deps();
  const key = ['api_key=sk', 'live', '123456'].join('-');
  const secret = await teamModelCall(d, { ...call, messages: [{ role: 'user', content: `Call it with ${key}.` }] });
  assert.equal(secret.ok, false);
  assert.match(secret.ok ? '' : secret.reason, /credential/);
  const personal = await teamModelCall(d, { ...call, messages: [{ role: 'user', content: 'Email jane@example.com the brief.' }] });
  assert.match(personal.ok ? '' : personal.reason, /personal data.*Team Studio cannot send it; remove it and try again\./);
  assert.equal(d.sent.length, 0);
});

test('a cancelled call sends nothing', async () => {
  const d = deps();
  const controller = new AbortController();
  controller.abort();
  const result = await teamModelCall(d, { ...call, signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(d.sent.length, 0);
});

test('model choice skips image-only models and says so when the key has no chat model', () => {
  const choice = chooseTeamModel('any', { models: [IMAGE, TEE], preferred: [IMAGE.id], routeFor: routes(), privacyMode: 'standard' });
  assert.equal(choice.ok && choice.model, TEE.id);
  const none = chooseTeamModel('any', { models: [IMAGE], preferred: [], routeFor: routes(), privacyMode: 'standard' });
  assert.match(none.ok ? '' : none.reason, /no chat models/);
});

