import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compactConversation, contextStatus, trimOldToolResults } from '../agent/context';
import { DEFAULT_RULES } from '../agent/permissions';
import { ActivityStore } from '../services/activityStore';
import { AnalyticsStore } from '../services/analyticsStore';
import { AgentConversation, AgentTurnRequest, GsdContext, visibleTurns } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';
import { TranscriptStore } from '../services/transcripts';

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const usage = { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown' as const, latencyMs: 1 };

type Step = { text?: string; calls?: ToolCall[]; delayMs?: number };

/** A model that answers by script, keyed by who is asking (the parent, or a sub-agent by its system prompt). */
function scriptedClient(scripts: { parent: Step[]; child?: Step[] }, log: string[] = []) {
  const counters = { parent: 0, child: 0 };
  return {
    log,
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const isChild = messages[0]?.content?.startsWith('You are the planner.');
      const who = isChild ? 'child' : 'parent';
      const step = (isChild ? scripts.child ?? [] : scripts.parent)[counters[who]++] ?? { text: 'done' };
      log.push(`${who}:${counters[who]}`);
      if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      yield { type: 'done', message: { role: 'assistant', content: step.text ?? null, ...(step.calls ? { tool_calls: step.calls } : {}) }, finishReason: step.calls ? 'tool_calls' : 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
}

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-fleet-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-fleet-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-planner', description: 'Plans', tools: ['Read'], body: 'You are the planner.', file: path.join(home, 'agents', 'gsd-planner.md') }], shellEnv: {} };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  return { root, gsd, posted, conversation };
}

function request(client: ReturnType<typeof scriptedClient>, gsd: GsdContext, extra: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return { text: 'go', client: client as never, model: 'z-ai/glm-5.3', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, gsd, ...extra };
}

test('a background agent returns at once, and the run waits for its report before finishing', async () => {
  const { root, gsd, posted, conversation } = await project();
  const store = new ActivityStore(root);
  const session = await store.start({ project: 'demo', model: 'z-ai/glm-5.3' });
  const client = scriptedClient({
    parent: [
      { calls: [call('a1', 'Agent', { subagent_type: 'gsd-planner', description: 'Draft a plan', prompt: 'Plan it.', run_in_background: true })] },
      { text: 'Started the planner; waiting for it.' },
      { text: 'The planner says: plan ready.' }
    ],
    child: [{ text: 'plan ready', delayMs: 50 }]
  });
  await conversation.send(request(client, gsd, { activity: { store, sessionId: session.sessionId } }));
  assert.deepEqual(client.log, ['parent:1', 'child:1', 'parent:2', 'parent:3'], 'the agent starts at once, in parallel with the parent, and the final parent turn comes after its report');
  const agentResult = posted.find((message) => message.type === 'tool-end' && message.callId === 'a1');
  assert.match(String(agentResult?.output), /Started gsd-planner in the background as gsd-planner-[a-f0-9]{6}/);
  assert.ok(posted.some((message) => message.type === 'notice' && /Waiting for 1 background agent/.test(String(message.text))));
  const fleet = (await new AnalyticsStore({ sessions: await store.list() }).query()).fleet;
  assert.equal(fleet.agents.length, 1);
  assert.equal(fleet.agents[0].role, 'gsd-planner');
  assert.equal(fleet.agents[0].status, 'completed');
});

test('the parallel-agent limit runs extra agents one after another', async () => {
  const { gsd, conversation } = await project();
  let running = 0;
  let peak = 0;
  const client = scriptedClient({ parent: [{ calls: [1, 2, 3].map((n) => call(`a${n}`, 'Agent', { subagent_type: 'gsd-planner', prompt: `task ${n}` })) }, { text: 'all done' }] });
  const original = client.streamCompletion.bind(client);
  client.streamCompletion = async function* (model: string, messages: AgentMessage[]) {
    const isChild = messages[0]?.content?.startsWith('You are the planner.');
    if (isChild) { running += 1; peak = Math.max(peak, running); await new Promise((resolve) => setTimeout(resolve, 20)); }
    yield* original(model, messages);
    if (isChild) running -= 1;
  };
  await conversation.send(request(client, gsd, { maxParallelAgents: 1 }));
  assert.equal(peak, 1);
});

test('each sub-agent has its own shell, so its commands neither wait behind the parent\'s nor move the parent\'s directory', async () => {
  const { root, gsd, posted, conversation } = await project();
  gsd.agents.push({ name: 'gsd-worker', description: 'Works', tools: ['Bash'], body: 'You are the planner.', file: path.join(gsd.home, 'agents', 'gsd-worker.md') });
  const client = scriptedClient({
    parent: [
      { calls: [call('a1', 'Agent', { subagent_type: 'gsd-worker', prompt: 'work', run_in_background: true })] },
      { calls: [call('p1', 'Bash', { command: 'sleep 2; pwd' })] },
      { text: 'waiting' },
      { text: 'done' }
    ],
    child: [{ calls: [call('c1', 'Bash', { command: 'mkdir -p sub && cd sub && pwd' })], delayMs: 100 }, { text: 'child done' }]
  });
  try {
    await conversation.send(request(client, gsd, { policy: { mode: 'fully-autonomous', emergencyStop: false } }));
  } finally {
    conversation.dispose();
  }
  const ends = posted.filter((message) => message.type === 'tool-end').map((message) => String(message.callId));
  const child = ends.findIndex((id) => id.endsWith(':c1'));
  assert.ok(child >= 0 && child < ends.indexOf('p1'), `the sub-agent's command finished during the parent's sleep (order: ${ends.join(', ')})`);
  const parentOutput = String(posted.find((message) => message.type === 'tool-end' && message.callId === 'p1')?.output).trim();
  assert.ok(parentOutput.split('\n').includes(root), `the sub-agent's cd did not move the parent (got: ${parentOutput})`);
});

test('a paused agent waits before its next turn until resumed', async () => {
  const { gsd, posted, conversation } = await project();
  const client = scriptedClient({
    parent: [{ calls: [call('a1', 'Agent', { subagent_type: 'gsd-planner', prompt: 'two steps' })] }, { text: 'finished' }],
    child: [{ calls: [call('r1', 'Read', { file_path: 'missing.txt' })], delayMs: 30 }, { text: 'report' }]
  });
  const running = conversation.send(request(client, gsd));
  let agentId: string | undefined;
  for (let attempt = 0; attempt < 100 && !agentId; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    agentId = (posted.filter((message) => message.type === 'agents').at(-1)?.agents as Array<{ id: string }> | undefined)?.[0]?.id;
  }
  assert.ok(agentId);
  assert.equal(conversation.controlAgent(agentId, 'pause'), true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(client.log, ['parent:1', 'child:1'], 'the second child turn has not started while paused');
  conversation.controlAgent(agentId, 'resume');
  await running;
  assert.deepEqual(client.log, ['parent:1', 'child:1', 'child:2', 'parent:2']);
});

test('context: old tool output is trimmed, thresholds follow Open-GSD, and compaction keeps tool calls with their results', async () => {
  const big = 'x'.repeat(5_000);
  const messages: AgentMessage[] = [{ role: 'system', content: 'sys' }];
  for (let n = 0; n < 12; n += 1) messages.push({ role: 'assistant', content: null, tool_calls: [call(`c${n}`, 'Read', {})] }, { role: 'tool', tool_call_id: `c${n}`, content: big });
  const trimmed = trimOldToolResults(messages);
  const toolContents = trimmed.filter((message) => message.role === 'tool').map((message) => message.content.length);
  assert.equal(toolContents.filter((length) => length === 5_000).length, 8, 'the eight most recent tool results are kept whole');
  assert.equal(contextStatus(70_000, 100_000).level, 'warning');
  assert.equal(contextStatus(80_000, 100_000).level, 'critical');
  assert.equal(contextStatus(10_000, 100_000).level, 'normal');
  const long: AgentMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'first goal' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'second' }, { role: 'assistant', content: null, tool_calls: [call('t1', 'Read', {})] }, { role: 'tool', tool_call_id: 't1', content: 'file' }, { role: 'assistant', content: 'read it' }, { role: 'user', content: 'third' }, { role: 'assistant', content: 'done third' }];
  const summarizer = { async *streamCompletion(): AsyncGenerator<CompletionEvent> { yield { type: 'done', message: { role: 'assistant', content: 'SUMMARY' }, finishReason: 'stop', usage }; } };
  const compacted = await compactConversation(summarizer, 'm', long, new AbortController().signal, 3);
  assert.equal(compacted[0].content, 'sys');
  assert.match(String(compacted[1].content), /SUMMARY/);
  assert.equal(compacted[3].role, 'user', 'the kept part starts at a user message');
  assert.equal(compacted.some((message, index) => message.role === 'tool' && compacted[index - 1]?.role !== 'assistant'), false);
});

test('at the critical threshold the conversation is summarized and a handoff is saved', async () => {
  const { root, gsd, posted, conversation } = await project();
  await mkdir(path.join(root, '.planning'), { recursive: true });
  const client = scriptedClient({ parent: [{ text: 'first answer' }, { text: 'SUMMARY OF WORK' }, { text: 'second answer' }] });
  await conversation.send(request(client, gsd, { contextWindows: { 'z-ai/glm-5.3': 1_000_000 } }));
  await writeFile(path.join(root, 'filler.txt'), '');
  await conversation.send(request(client, gsd, { text: 'y'.repeat(6_000), contextWindows: { 'z-ai/glm-5.3': 2_000 } }));
  assert.ok(posted.some((message) => message.type === 'notice' && /summarized to stay within/.test(String(message.text))));
  const handoff = JSON.parse(await readFile(path.join(root, '.planning', 'HANDOFF.json'), 'utf8')) as { reason: string };
  assert.equal(handoff.reason, 'context-critical');
});

test('a saved conversation resumes with its full context', async () => {
  const { root, gsd, conversation } = await project();
  const client = scriptedClient({ parent: [{ calls: [call('r1', 'Read', { file_path: 'note.md' })] }, { text: 'The note says hello.' }, { text: 'Still remembered.' }] });
  await writeFile(path.join(root, 'note.md'), 'hello');
  await conversation.send(request(client, gsd, { text: 'What does note.md say?' }));
  const store = new TranscriptStore(path.join(root, '.store'), root);
  const [saved] = await store.list();
  assert.equal(saved.title, 'What does note.md say?');
  const resumed = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, store);
  const turns = await resumed.restore(saved.id);
  assert.deepEqual(turns?.map((turn) => [turn.role, turn.text, turn.tools]), [['user', 'What does note.md say?', 0], ['assistant', 'The note says hello.', 1]]);
  const seen: AgentMessage[][] = [];
  const recorder = { ...client, async *streamCompletion(model: string, messages: AgentMessage[]) { seen.push(structuredClone(messages)); yield* client.streamCompletion(model, messages); } };
  await resumed.send(request(recorder as never, gsd, { text: 'and now?' }));
  assert.ok(seen[0].some((message) => message.role === 'tool' && message.content.includes('hello')), 'the earlier tool result is back in context');
  assert.deepEqual(visibleTurns(seen[0]).map((turn) => turn.text), ['What does note.md say?', 'The note says hello.', 'and now?']);
});
