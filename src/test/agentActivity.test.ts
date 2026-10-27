import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { ActivityChange, ActivityFeed, redactForDisplay } from '../services/agentActivity';
import { AgentConversation, GsdContext } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

const usage = (inputTokens: number, outputTokens: number, estimatedCostUsd: number) => ({ inputTokens, outputTokens, estimatedCostUsd, verificationStatus: 'unknown' as const, latencyMs: 500 });

function feedAt(start = 1_000_000, limits = { maxAgeMs: 60 * 60_000, maxBytes: 8 * 1024 * 1024 }) {
  let now = start;
  const feed = new ActivityFeed(limits, () => now);
  return { feed, advance: (ms: number) => { now += ms; } };
}

test('streamed text becomes one entry per reply, tool rows get their result, and stats add up', () => {
  const { feed, advance } = feedAt();
  feed.agentStarted({ agentId: 'main-1', agent: 'agent', runId: 'run-1', model: 'z-ai/glm-5.3' }, 'Fix the bug', 'You are NEAR AI…');
  feed.stream('main-1', 'reasoning', 'Look at ');
  feed.stream('main-1', 'reasoning', 'cart.js');
  feed.stream('main-1', 'text', 'Let me ');
  feed.stream('main-1', 'text', 'check.');
  feed.toolStarted('main-1', 'c1', 'Bash npm test', '{"command":"npm test"}');
  advance(1_500);
  feed.toolEnded('main-1', 'c1', false, '1 failing');
  feed.turn('main-1', usage(1_200, 80, 0.002));
  feed.stream('main-1', 'text', 'Fixed.');
  feed.turn('main-1', usage(1_400, 20, 0.001));
  feed.retry('main-1', 'NEAR AI stopped sending the response. Retrying in 2 s (attempt 2).');
  feed.agentEnded('main-1', 'completed');
  const { snapshot, dispose } = feed.subscribe(() => undefined);
  dispose();
  assert.deepEqual(snapshot.map((entry) => [entry.kind, entry.text ?? entry.title]), [
    ['agent-start', 'agent started on z-ai/glm-5.3'], ['system', 'You are NEAR AI…'], ['prompt', 'Fix the bug'],
    ['reasoning', 'Look at cart.js'], ['text', 'Let me check.'], ['tool', '1 failing'], ['text', 'Fixed.'],
    ['retry', 'NEAR AI stopped sending the response. Retrying in 2 s (attempt 2).'], ['agent-end', 'agent completed']
  ]);
  const tool = snapshot.find((entry) => entry.kind === 'tool')!;
  assert.deepEqual([tool.title, tool.input, tool.ok, tool.ms], ['Bash npm test', '{"command":"npm test"}', false, 1_500]);
  const [stat] = feed.agentStats();
  assert.deepEqual({ turns: stat.turns, inputTokens: stat.inputTokens, outputTokens: stat.outputTokens, toolCalls: stat.toolCalls, toolErrors: stat.toolErrors, retries: stat.retries, status: stat.status, modelMs: stat.modelMs }, { turns: 2, inputTokens: 2_600, outputTokens: 100, toolCalls: 1, toolErrors: 1, retries: 1, status: 'completed', modelMs: 1_000 });
  assert.ok(Math.abs(stat.costUsd - 0.003) < 1e-9);
});

test('secrets are masked and oversized content is capped before it is kept', () => {
  const { feed } = feedAt();
  feed.agentStarted({ agentId: 'a', agent: 'a', runId: 'r', model: 'm' });
  feed.toolStarted('a', 'c1', 'Read .env', '{}');
  feed.toolEnded('a', 'c1', true, `OPENAI=sk-abcdefghijklmnopqrstuvwxyz012345\nGH=ghp_${'a'.repeat(36)}\napi_key=hunter2\n-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n${'x'.repeat(20_000)}`);
  const { snapshot } = feed.subscribe(() => undefined);
  const output = snapshot.find((entry) => entry.kind === 'tool')!.text!;
  assert.doesNotMatch(output, /sk-abc|ghp_a|hunter2|MIIE/);
  assert.match(output, /more characters not kept\]$/);
  assert.ok(output.length < 8_200);
  assert.doesNotMatch(redactForDisplay('Authorization: Bearer abc.def'), /abc\.def/);
});

test('old entries are dropped by age and by size, while agent totals survive', () => {
  const { feed, advance } = feedAt(1_000_000, { maxAgeMs: 10 * 60_000, maxBytes: 64 * 1024 });
  feed.agentStarted({ agentId: 'a', agent: 'worker', runId: 'r', model: 'm' }, 'first prompt');
  advance(11 * 60_000);
  feed.prompt('a', 'second prompt');
  let kept = feed.subscribe(() => undefined).snapshot;
  assert.deepEqual(kept.map((entry) => entry.text ?? entry.title), ['second prompt'], 'entries older than the window are gone');
  for (let index = 0; index < 50; index += 1) feed.prompt('a', `p${index} ${'y'.repeat(2_000)}`);
  kept = feed.subscribe(() => undefined).snapshot;
  assert.ok(feed.usage.bytes <= 64 * 1024, `kept ${feed.usage.bytes} bytes`);
  assert.ok(kept.length < 51 && kept.at(-1)!.text!.startsWith('p49'), 'the newest entries are kept');
  assert.equal(feed.agentStats()[0].agent, 'worker', 'stats are kept after their entries are dropped');
});

test('listeners hear about changes only while subscribed, and clearing keeps running agents', () => {
  const { feed } = feedAt();
  feed.agentStarted({ agentId: 'done', agent: 'done', runId: 'r', model: 'm' });
  feed.agentEnded('done', 'completed');
  feed.agentStarted({ agentId: 'live', agent: 'live', runId: 'r', model: 'm' });
  const changes: ActivityChange[] = [];
  const subscription = feed.subscribe((change) => changes.push({ entries: change.entries.map((entry) => ({ ...entry })), cleared: change.cleared }));
  feed.stream('live', 'text', 'hello');
  feed.stream('live', 'text', ' world');
  subscription.dispose();
  feed.stream('live', 'text', '!');
  assert.deepEqual(changes.map((change) => change.entries.map((entry) => entry.text)), [['hello'], ['hello world']]);
  assert.equal(feed.watched, false);
  feed.clear();
  assert.deepEqual(feed.agentStats().map((stat) => stat.agentId), ['live']);
  assert.equal(feed.usage.entries, 0);
});

test('a conversation records the main agent and its sub-agents, with prompts, tool calls, and tokens', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-planner', description: 'Plans', tools: ['Read'], body: 'You are the planner.', file: path.join(home, 'agents', 'gsd-planner.md') }], shellEnv: {} };
  const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const child = String(messages[0]?.content).startsWith('You are the planner.');
      const last = messages.at(-1)!;
      if (child) {
        if (last.role === 'user') { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('r1', 'Read', { file_path: 'missing.md' })] }, finishReason: 'tool_calls', usage: usage(300, 10, 0.0005) }; return; }
        yield { type: 'text', text: 'Plan: one step.' };
        yield { type: 'done', message: { role: 'assistant', content: 'Plan: one step.' }, finishReason: 'stop', usage: usage(400, 6, 0.0006) };
        return;
      }
      if (!messages.some((message) => message.role === 'tool')) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'Agent', { subagent_type: 'gsd-planner', description: 'Plan it', prompt: 'Make a plan.' })] }, finishReason: 'tool_calls', usage: usage(1_000, 20, 0.002) }; return; }
      yield { type: 'text', text: 'Done.' };
      yield { type: 'done', message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop', usage: usage(1_100, 4, 0.001) };
    },
    async actualCostsUsd() { return undefined; }
  };
  const feed = new ActivityFeed({ maxAgeMs: 60 * 60_000, maxBytes: 8 * 1024 * 1024 });
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, undefined, feed);
  try {
    await conversation.send({ text: 'Plan the work', client: near as never, model: 'z-ai/glm-5.3', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, gsd });
  } finally {
    conversation.dispose();
  }
  const stats = feed.agentStats();
  const main = stats.find((stat) => stat.agentId.startsWith('main-'))!;
  const planner = stats.find((stat) => stat.agent === 'gsd-planner')!;
  assert.equal(planner.parentId, main.agentId);
  assert.deepEqual([main.status, main.turns, main.inputTokens, main.outputTokens, main.toolCalls], ['completed', 2, 2_100, 24, 1]);
  assert.deepEqual([planner.status, planner.turns, planner.inputTokens, planner.toolCalls, planner.toolErrors], ['completed', 2, 700, 1, 1]);
  const entries = feed.subscribe(() => undefined).snapshot;
  const of = (agentId: string) => entries.filter((entry) => entry.agentId === agentId).map((entry) => entry.kind);
  assert.deepEqual(of(main.agentId), ['agent-start', 'system', 'prompt', 'tool', 'text', 'agent-end']);
  assert.deepEqual(of(planner.agentId), ['agent-start', 'system', 'prompt', 'tool', 'text', 'agent-end']);
  assert.equal(entries.find((entry) => entry.agentId === planner.agentId && entry.kind === 'prompt')!.text, 'Make a plan.');
  assert.match(entries.find((entry) => entry.agentId === main.agentId && entry.kind === 'tool')!.input!, /"subagent_type":"gsd-planner"/);
});
