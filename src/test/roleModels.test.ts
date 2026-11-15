import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { agentModelFor, DEFAULT_ROLE_MODELS, resolveModelId, roleModelFor } from '../gsd/library';
import { AgentConversation, GsdContext } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// Per-role models: research and mapping roles default to the fast tier; a team member's own
// model line wins; privacy and availability still decide.

test('role models match exact names first, then the longest * pattern', () => {
  assert.equal(roleModelFor('gsd-project-researcher', DEFAULT_ROLE_MODELS), 'fast');
  assert.equal(roleModelFor('gsd-ui-researcher', DEFAULT_ROLE_MODELS), 'fast');
  assert.equal(roleModelFor('gsd-codebase-mapper', DEFAULT_ROLE_MODELS), 'fast');
  // PERF-03 (owner, 2026-11-10): judgement roles now route to the deep tier by default; roles with no default still follow their definition.
  assert.equal(roleModelFor('gsd-planner', DEFAULT_ROLE_MODELS), 'deep');
  assert.equal(roleModelFor('gsd-executor', DEFAULT_ROLE_MODELS), undefined);
  const custom = { 'gsd-*': 'standard', 'gsd-*-researcher': 'fast', 'gsd-phase-researcher': 'z-ai/glm-5.3' };
  assert.equal(roleModelFor('gsd-phase-researcher', custom), 'z-ai/glm-5.3', 'an exact name wins');
  assert.equal(roleModelFor('gsd-domain-researcher', custom), 'fast', 'the longer pattern wins');
  assert.equal(roleModelFor('gsd-verifier', custom), 'standard');
  assert.equal(roleModelFor('gsd-x.y', { 'gsd-x.*': 'fast' }), 'fast', 'pattern characters other than * are literal');
  assert.equal(roleModelFor('gsd-xzy', { 'gsd-x.*': 'fast' }), undefined);
});

test('agents get their role\'s model; a team member\'s model line wins; an unavailable or less private model falls back', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-roles-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-roles-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const agent = (name: string, file = path.join(home, 'agents', `${name}.md`), model?: string) => ({ name, description: name, tools: ['Read'], body: `You are ${name}.`, file, ...(model ? { model } : {}) });
  const gsd: GsdContext = { home, skills: [], shellEnv: {}, agents: [agent('gsd-project-researcher', undefined, 'sonnet'), agent('gsd-planner', undefined, 'opus')] };
  const teamResearcher = agent('gsd-team-researcher', path.join(root, '.planning', '.near-ai', 'team.md'), 'deep');
  const call = (id: string, type: string): ToolCall => ({ id, type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ subagent_type: type, prompt: 'go' }) } });
  const modelsUsed = new Map<string, string>();
  const near = {
    async *streamCompletion(model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
      const who = /^You are ([\w-]+)\./.exec(String(messages[0].content))?.[1];
      if (who) { modelsUsed.set(who, model); yield { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage }; return; }
      if (!messages.some((message) => message.role === 'tool')) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'gsd-project-researcher'), call('a2', 'gsd-planner'), call('a3', 'gsd-team-researcher')] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'all done' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const tiers = { deep: 'moonshotai/kimi-k3', standard: 'z-ai/glm-5.3', fast: 'z-ai/glm-5.3-flash' };
  const send = async (availableModels: string[]) => {
    modelsUsed.clear();
    const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'));
    try {
      await conversation.send({ text: 'go', client: near as never, model: 'z-ai/glm-5.3', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd: { ...gsd, agents: [...gsd.agents, teamResearcher] }, tiers, roleModels: DEFAULT_ROLE_MODELS, availableModels });
    } finally {
      conversation.dispose();
    }
    return Object.fromEntries(modelsUsed);
  };
  assert.deepEqual(await send(['z-ai/glm-5.3', 'z-ai/glm-5.3-flash', 'moonshotai/kimi-k3']), {
    'gsd-project-researcher': 'z-ai/glm-5.3-flash',
    'gsd-planner': 'moonshotai/kimi-k3',
    'gsd-team-researcher': 'moonshotai/kimi-k3'
  }, 'the researcher runs on Flash though its definition says sonnet; the planner keeps its tier; the team member keeps its own line');
  assert.equal((await send(['z-ai/glm-5.3']))['gsd-project-researcher'], 'z-ai/glm-5.3', 'when Flash is not offered (or not private enough), the chat\'s model is used');
});

test('a short model name resolves against the models on this key; an unknown one is an error that lists them (0.4.23)', () => {
  const available = ['openai/gpt-6.1-sol', 'z-ai/glm-5.3', 'z-ai/glm-5.3-flash', 'moonshotai/kimi-k3', 'other/kimi-k3'];
  assert.equal(resolveModelId('openai/gpt-6.1-sol', available), 'openai/gpt-6.1-sol', 'the exact ID');
  assert.equal(resolveModelId('gpt-6.1-sol', available), 'openai/gpt-6.1-sol', 'the part after the last /');
  assert.equal(resolveModelId('GPT-6.1-Sol', available), 'openai/gpt-6.1-sol', 'ignoring case');
  assert.equal(resolveModelId('Z-AI/GLM-5.3', available), 'z-ai/glm-5.3', 'a whole ID ignoring case');
  assert.equal(resolveModelId('kimi-k3', available), undefined, 'ambiguous: two models share the name');
  assert.equal(resolveModelId('gpt-7', available), undefined);
  const tiers = { deep: 'moonshotai/kimi-k3', standard: 'z-ai/glm-5.3', fast: 'z-ai/glm-5.3-flash' };
  const base = { tiers, current: 'z-ai/glm-5.3', available };
  assert.deepEqual(agentModelFor({ ...base, requested: 'gpt-6.1-sol' }), { model: 'openai/gpt-6.1-sol' });
  assert.deepEqual(agentModelFor({ ...base, requested: 'fast' }), { model: 'z-ai/glm-5.3-flash' }, 'tier words keep working');
  assert.deepEqual(agentModelFor({ ...base, requested: 'opus' }), { model: 'moonshotai/kimi-k3' });
  assert.deepEqual(agentModelFor({ ...base }), { model: 'z-ai/glm-5.3' }, 'nothing asked for: the chat model');
  const unknown = agentModelFor({ ...base, requested: 'gpt-7' });
  assert.ok('error' in unknown);
  assert.match(unknown.error, /"gpt-7" is not a model on this key/);
  assert.match(unknown.error, /openai\/gpt-6\.1-sol, z-ai\/glm-5\.3, z-ai\/glm-5\.3-flash, moonshotai\/kimi-k3, other\/kimi-k3/);
  const ambiguous = agentModelFor({ ...base, requested: 'kimi-k3' });
  assert.ok('error' in ambiguous && /matches several models \(moonshotai\/kimi-k3, other\/kimi-k3\)/.test(ambiguous.error));
  const many = agentModelFor({ ...base, available: Array.from({ length: 200 }, (_, index) => `vendor/model-${index}`), requested: 'nope' });
  assert.ok('error' in many && /\(and 170 more\)/.test(many.error) && many.error.length < 1_600, 'the list is bounded');
  // Role and agent-file models keep their fallback, with a note.
  const role = agentModelFor({ ...base, roleModel: 'vendor/gone' });
  assert.deepEqual(role, { model: 'z-ai/glm-5.3', note: "The role's configured model vendor/gone is not available on this key, so it runs on z-ai/glm-5.3." });
  const own = agentModelFor({ ...base, agentModel: 'gone-model' });
  assert.ok(!('error' in own) && own.model === 'z-ai/glm-5.3' && /agent's own model gone-model is not available/.test(own.note ?? ''));
  const tierGone = agentModelFor({ ...base, available: ['z-ai/glm-5.3'], requested: 'deep' });
  assert.ok(!('error' in tierGone) && tierGone.model === 'z-ai/glm-5.3' && /deep tier's model \(moonshotai\/kimi-k3\) is not available/.test(tierGone.note ?? ''), 'a tier keeps falling back');
  const overridden = agentModelFor({ ...base, roleModel: 'fast', requested: 'gpt-6.1-sol' });
  assert.ok(!('error' in overridden) && overridden.model === 'z-ai/glm-5.3-flash' && /takes precedence over the requested gpt-6\.1-sol/.test(overridden.note ?? ''));
});

test('an Agent call with an unknown model fails and names the models; a short name runs on that model; the lead is told the model (0.4.23)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-agent-model-'));
  const call = (id: string, model: string, background = false): ToolCall => ({ id, type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ subagent_type: 'designer', description: 'design', prompt: `You are designer-${id}. go`, model, ...(background ? { run_in_background: true } : {}) }) } });
  const modelsUsed = new Map<string, string>();
  const toolResults: string[] = [];
  const near = {
    async *streamCompletion(model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
      const who = /You are (designer-\w+)\./.exec(String(messages[1]?.content ?? ''))?.[1];
      if (who && messages[0].role === 'system' && messages.length === 2) { modelsUsed.set(who, model); yield { type: 'done', message: { role: 'assistant', content: 'designed' }, finishReason: 'stop', usage }; return; }
      if (!messages.some((message) => message.role === 'tool')) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'gpt-6.1-sol'), call('a2', 'gpt-7'), call('a3', 'gpt-6.1-sol', true)] }, finishReason: 'tool_calls', usage }; return; }
      for (const message of messages) if (message.role === 'tool' && typeof message.content === 'string' && !toolResults.includes(message.content)) toolResults.push(message.content);
      yield { type: 'done', message: { role: 'assistant', content: 'all done' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const tiers = { deep: 'moonshotai/kimi-k3', standard: 'z-ai/glm-5.3', fast: 'z-ai/glm-5.3-flash' };
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'));
  try {
    await conversation.send({ text: 'go', client: near as never, model: 'z-ai/glm-5.3', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd: { home: root, skills: [], shellEnv: {}, agents: [{ name: 'designer', description: 'designs', tools: [], body: 'You design.', file: path.join(root, 'agents', 'designer.md') }] }, tiers, availableModels: ['z-ai/glm-5.3', 'openai/gpt-6.1-sol', 'z-ai/glm-5.3-flash'] });
  } finally {
    conversation.dispose();
  }
  assert.equal(modelsUsed.get('designer-a1'), 'openai/gpt-6.1-sol', 'the short name ran on the model it names');
  assert.equal(modelsUsed.get('designer-a3'), 'openai/gpt-6.1-sol');
  assert.equal(modelsUsed.has('designer-a2'), false, 'the unknown model did not run on the chat model instead');
  assert.ok(toolResults.some((text) => /designed[\s\S]*designer ran on openai\/gpt-6\.1-sol\./.test(text)), `the report names the model: ${toolResults.join(' | ')}`);
  assert.ok(toolResults.some((text) => /"gpt-7" is not a model on this key[\s\S]*Available models: z-ai\/glm-5\.3, openai\/gpt-6\.1-sol, z-ai\/glm-5\.3-flash/.test(text)), 'the error names the request and the models');
  assert.ok(toolResults.some((text) => /Started designer in the background as [\w-]+ on openai\/gpt-6\.1-sol\./.test(text)), 'the background start names the model');
});
