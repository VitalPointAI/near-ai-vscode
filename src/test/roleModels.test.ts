import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { DEFAULT_ROLE_MODELS, roleModelFor } from '../gsd/library';
import { AgentConversation, GsdContext } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// Per-role models: research and mapping roles default to the fast tier; a team member's own
// model line wins; privacy and availability still decide.

test('role models match exact names first, then the longest * pattern', () => {
  assert.equal(roleModelFor('gsd-project-researcher', DEFAULT_ROLE_MODELS), 'fast');
  assert.equal(roleModelFor('gsd-ui-researcher', DEFAULT_ROLE_MODELS), 'fast');
  assert.equal(roleModelFor('gsd-codebase-mapper', DEFAULT_ROLE_MODELS), 'fast');
  assert.equal(roleModelFor('gsd-planner', DEFAULT_ROLE_MODELS), undefined);
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
