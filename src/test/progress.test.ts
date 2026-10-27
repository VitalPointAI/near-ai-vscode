import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { AgentConversation, GsdContext } from '../services/agentSession';
import { parseChatWebviewMessage } from '../services/chatBridge';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// Long runs show they are moving: each sub-agent's current action, clock, and counts reach the
// agents strip (throttled), and a progress line appears in the chat when nothing else has.

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a quiet run reports each agent\'s progress in the chat and in the agents strip, without flooding either', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-progress-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-progress-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  for (let n = 1; n <= 6; n += 1) await writeFile(path.join(root, `f${n}.txt`), `file ${n}`);
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-worker', description: 'Works', tools: ['Read'], body: 'You are the worker.', file: path.join(home, 'agents', 'gsd-worker.md') }], shellEnv: {} };
  let childTurns = 0;
  let parentTurns = 0;
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
      if (String(messages[0].content).startsWith('You are the worker.')) {
        childTurns += 1;
        await wait(350);
        yield { type: 'reasoning', text: 'considering the next file' } as CompletionEvent;
        if (childTurns <= 6) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call(`r${childTurns}`, 'Read', { file_path: `f${childTurns}.txt` })] }, finishReason: 'tool_calls', usage }; return; }
        yield { type: 'done', message: { role: 'assistant', content: 'Read all six files.' }, finishReason: 'stop', usage };
        return;
      }
      parentTurns += 1;
      if (parentTurns === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'Agent', { subagent_type: 'gsd-worker', description: 'Read the files', prompt: 'read f1 to f6' })] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.progressTiming = { firstMs: 600, everyMs: 900, checkMs: 50 };
  try {
    await conversation.send({ text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd });
  } finally {
    conversation.dispose();
  }
  assert.equal(childTurns, 7);

  const strips = posted.filter((message) => message.type === 'agents') as Array<{ agents: Array<Record<string, unknown>> }>;
  const statuses = strips.flatMap((strip) => strip.agents);
  // Tools finish quickly and the model's next turn is the slow part, so while it thinks the strip says what it just did.
  assert.ok(statuses.some((agent) => agent.activity === 'Thinking' && /^Read .*f\d\.txt/.test(String(agent.lastAction))), `the strip shows the agent's last action while it thinks (${statuses.map((agent) => `${agent.activity}/${agent.lastAction}`).join(', ')})`);
  const last = statuses.at(-1)!;
  assert.equal(last.description, 'Read the files');
  assert.ok(Number(last.toolCalls) >= 5 && Number(last.turns) >= 5, `counts are kept (${last.toolCalls} tools, ${last.turns} turns)`);
  assert.equal(typeof last.startedAt, 'number');
  // About 21 child events over roughly 2.5 seconds, sent at most once a second plus the start and end updates.
  assert.ok(strips.length <= 6, `the strip is throttled (${strips.length} updates)`);

  const progress = posted.filter((message) => message.type === 'progress').map((message) => String(message.text));
  assert.ok(progress.length >= 1 && progress.length <= 4, `progress lines appear while the sub-agent works, not on every check (${progress.length})`);
  assert.match(progress[0], /^Still working \(\d+s\): Read the files: .+ \(\d+s, \d+ tool calls?\)\.$/);
});

test('the agents strip can open Agent Activity filtered to one agent; other agent IDs are rejected', () => {
  assert.deepEqual(parseChatWebviewMessage({ type: 'open-activity' }), { type: 'open-activity' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'open-activity', agentId: 'gsd-project-researcher-a1b2c3' }), { type: 'open-activity', agentId: 'gsd-project-researcher-a1b2c3' });
  assert.equal(parseChatWebviewMessage({ type: 'open-activity', agentId: '../../etc' }), undefined);
  assert.equal(parseChatWebviewMessage({ type: 'open-activity', agentId: 'x-a1b2c3', extra: 1 }), undefined);
});
