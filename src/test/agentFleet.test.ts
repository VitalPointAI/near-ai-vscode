import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
  // The child holds on a latch the test controls, so the hold is deterministic: while the child is latched the run has a live background agent and nothing
  // drained, so the waiting notice MUST appear — no timer race, which is what flaked CI (on a loaded runner the child finished during the parent's turn and
  // the notice was rightly absent, because the report was already ready). The interleaving is asserted, not hoped for.
  const gate: { release?: () => void; held: number } = { held: 0 };
  const latch = new Promise<void>((resolve) => { gate.release = resolve; });
  const client = scriptedClient({
    parent: [
      { calls: [call('a1', 'Agent', { subagent_type: 'gsd-planner', description: 'Draft a plan', prompt: 'Plan it.', run_in_background: true })] },
      { text: 'Started the planner; waiting for it.' },
      { text: 'The planner says: plan ready.' }
    ],
    child: [{ text: 'plan ready' }]
  });
  const streamed = client.streamCompletion.bind(client);
  client.streamCompletion = async function* (model: string, messages: AgentMessage[]) {
    if (String(messages[0]?.content ?? '').startsWith('You are the planner.')) {
      gate.held += 1;
      await latch;
    }
    yield * streamed(model, messages);
  };
  const running = conversation.send(request(client, gsd, { activity: { store, sessionId: session.sessionId } }));
  let notice: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 400 && !notice; attempt += 1) {
    notice = posted.find((message) => message.type === 'notice' && /Waiting for 1 background agent/.test(String(message.text)));
    if (!notice) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  try {
    assert.ok(gate.held >= 1, 'the child turn was held by the latch');
    assert.ok(notice, 'the run says why it is holding while the child works');
  } finally {
    // The send is awaited even when an assertion above throws, so a failed run cannot leave an unhandled rejection behind (fifth 0.4.19 review, NIT).
    gate.release?.();
    await running.catch(() => undefined);
  }
  assert.deepEqual(client.log, ['parent:1', 'parent:2', 'child:1', 'parent:3'], 'the agent starts at once, in parallel with the parent, and the final parent turn comes after its report');
  const agentResult = posted.find((message) => message.type === 'tool-end' && message.callId === 'a1');
  assert.match(String(agentResult?.output), /Started gsd-planner in the background as gsd-planner-[a-f0-9]{6}/);
  const fleet = (await new AnalyticsStore({ sessions: await store.list() }).query()).fleet;
  assert.equal(fleet.agents.length, 1);
  assert.equal(fleet.agents[0].role, 'gsd-planner');
  assert.equal(fleet.agents[0].status, 'completed');
});

test('a report that arrived while the parent streamed feeds the run at once, with no hold and no notice', async () => {
  // The other interleaving the drain-first wait describes (seventh 0.4.19 review, MINOR): the child finishes DURING the parent's turn, so when the parent
  // goes to wait the report is already drained — the run feeds it and completes without announcing a hold that instantly ends. The parent's second turn is
  // held until the child's generator has RESOLVED, so the drain is provably non-empty at wait time: a timer here would be the mirror image of the flake.
  const { gsd, posted, conversation } = await project();
  const gate: { release?: () => void } = {};
  const childResolved = new Promise<void>((resolve) => { gate.release = resolve; });
  const client = scriptedClient({
    parent: [
      { calls: [call('a1', 'Agent', { subagent_type: 'gsd-planner', description: 'Draft a plan', prompt: 'Plan it.', run_in_background: true })] },
      { text: 'Started the planner; waiting for it.' },
      { text: 'The planner says: plan ready.' }
    ],
    child: [{ text: 'plan ready' }]
  });
  const streamed = client.streamCompletion.bind(client);
  let parentTurns = 0;
  client.streamCompletion = async function* (model: string, messages: AgentMessage[]) {
    if (String(messages[0]?.content ?? '').startsWith('You are the planner.')) {
      yield * streamed(model, messages);
      gate.release?.();
      return;
    }
    parentTurns += 1;
    if (parentTurns === 2) await childResolved;
    yield * streamed(model, messages);
  };
  try {
    await conversation.send(request(client, gsd));
    assert.deepEqual(client.log, ['parent:1', 'child:1', 'parent:2', 'parent:3'], 'the child finished inside the parent turn and the final parent turn came after its report');
    assert.equal(posted.some((message) => message.type === 'notice' && /Waiting for/.test(String(message.text))), false, 'no hold was announced, because there was none');
  } finally {
    // The session and its timers are disposed even when an assertion above throws, so a failed run cannot leak them (sixteenth 0.4.19 review, MINOR).
    conversation.dispose();
  }
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
  // Trimming advances in steps of 10 past the 8 most recent (see promptCache.test.ts), so use 18.
  for (let n = 0; n < 18; n += 1) messages.push({ role: 'assistant', content: null, tool_calls: [call(`c${n}`, 'Read', {})] }, { role: 'tool', tool_call_id: `c${n}`, content: big });
  const trimmed = trimOldToolResults(messages);
  const toolContents = trimmed.filter((message) => message.role === 'tool').map((message) => message.content.length);
  assert.equal(toolContents.filter((length) => length === 5_000).length, 8, 'the eight most recent tool results are kept whole');
  assert.equal(contextStatus(70_000, 100_000).level, 'warning');
  assert.equal(contextStatus(80_000, 100_000).level, 'critical');
  assert.equal(contextStatus(10_000, 100_000).level, 'normal');
  const long: AgentMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'first goal' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'second' }, { role: 'assistant', content: null, tool_calls: [call('t1', 'Read', {})] }, { role: 'tool', tool_call_id: 't1', content: 'file' }, { role: 'assistant', content: 'read it' }, { role: 'user', content: 'third' }, { role: 'assistant', content: 'done third' }];
  const summarizer = { async *streamCompletion(): AsyncGenerator<CompletionEvent> { yield { type: 'done', message: { role: 'assistant', content: 'SUMMARY' }, finishReason: 'stop', usage }; } };
  const compacted = (await compactConversation(summarizer, 'm', long, new AbortController().signal, 3))!;
  assert.equal(compacted[0].content, 'sys');
  assert.match(String(compacted[1].content), /SUMMARY/);
  assert.deepEqual(compacted.slice(2).map((message) => message.content), ['read it', 'third', 'done third'], 'the kept part starts at an assistant message, right after the summary');
  assert.equal(compacted.some((message, index) => message.role === 'tool' && compacted[index - 1]?.role !== 'assistant'), false);
  const atUser = (await compactConversation(summarizer, 'm', long, new AbortController().signal, 2))!;
  assert.deepEqual(atUser.slice(2).map((message) => message.role), ['assistant', 'user', 'assistant'], 'a cut at a user message keeps the acknowledgement after the summary');

  // One request followed by a long run of tool calls: the cut lands where a tool-call group starts, never between a call and its result.
  const single: AgentMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do the whole job' }];
  for (let n = 0; n < 10; n += 1) single.push({ role: 'assistant', content: null, tool_calls: [call(`s${n}a`, 'Read', {}), call(`s${n}b`, 'Read', {})] }, { role: 'tool', tool_call_id: `s${n}a`, content: 'a' }, { role: 'tool', tool_call_id: `s${n}b`, content: 'b' });
  const summarized = (await compactConversation(summarizer, 'm', single, new AbortController().signal, 8))!;
  assert.ok(summarized.length < single.length);
  assert.equal(summarized[1].role, 'user');
  assert.equal(summarized[2].role, 'assistant');
  assert.ok((summarized[2] as { tool_calls?: unknown[] }).tool_calls?.length, 'the kept part starts with a tool-call group');
  const ids = new Set(summarized.flatMap((message) => (message.role === 'assistant' ? (message.tool_calls ?? []).map((tool) => tool.id) : [])));
  assert.ok(summarized.every((message) => message.role !== 'tool' || ids.has(message.tool_call_id)), 'every kept tool result keeps its call');

  // Nothing older than the recent messages: no summary request, and the caller is told.
  let asked = 0;
  const counting = { async *streamCompletion(): AsyncGenerator<CompletionEvent> { asked += 1; yield { type: 'done', message: { role: 'assistant', content: 'SUMMARY' }, finishReason: 'stop', usage }; } };
  assert.equal(await compactConversation(counting, 'm', [{ role: 'system', content: 'sys' }, { role: 'user', content: 'x'.repeat(9_000) }], new AbortController().signal), undefined);
  assert.equal(asked, 0);
});

test('at the critical threshold the conversation is summarized and a handoff is saved', async () => {
  const { root, gsd, posted, conversation } = await project();
  await mkdir(path.join(root, '.planning'), { recursive: true });
  await writeFile(path.join(root, 'filler.txt'), `${'x'.repeat(100)}\n`.repeat(30));
  // Enough history before the second request that there is something older to summarize.
  const reads = Array.from({ length: 5 }, (_, n) => ({ calls: [call(`f${n}`, 'Read', { file_path: 'filler.txt' })] }));
  const client = scriptedClient({ parent: [...reads, { text: 'first answer' }, { text: 'SUMMARY OF WORK' }, { text: 'second answer' }] });
  await conversation.send(request(client, gsd, { contextWindows: { 'z-ai/glm-5.3': 1_000_000 } }));
  await conversation.send(request(client, gsd, { text: 'y'.repeat(6_000), contextWindows: { 'z-ai/glm-5.3': 2_000 } }));
  assert.ok(posted.some((message) => message.type === 'notice' && /summarized to stay within/.test(String(message.text))));
  const handoff = JSON.parse(await readFile(path.join(root, '.planning', 'HANDOFF.json'), 'utf8')) as { reason: string };
  assert.equal(handoff.reason, 'context-critical');
});

test('at the critical threshold with nothing older to summarize, no summary or handoff is announced', async () => {
  const { root, gsd, posted, conversation } = await project();
  await mkdir(path.join(root, '.planning'), { recursive: true });
  const client = scriptedClient({ parent: [{ text: 'the answer' }] });
  await conversation.send(request(client, gsd, { text: 'y'.repeat(6_000), contextWindows: { 'z-ai/glm-5.3': 2_000 } }));
  assert.ok(!posted.some((message) => message.type === 'notice' && /summarized to stay within/.test(String(message.text))));
  assert.equal(existsSync(path.join(root, '.planning', 'HANDOFF.json')), false);
  assert.deepEqual(client.log, ['parent:1'], 'no summary was requested');
});

test('a run that fails while it is being prepared does not leave the conversation running', async () => {
  const { gsd, conversation } = await project();
  const client = scriptedClient({ parent: [{ text: 'never' }] });
  await assert.rejects(() => conversation.send(request(client, gsd, { skill: { name: 'no-such-skill', args: '' } })), /no skill named/);
  assert.equal(conversation.running, false);
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

// ---- Check now (0.4.19 review) ----------------------------------------------------------------------------------------------------------
// The button interrupts a wait at once, but only a turn that is actually in flight may be cut: an interrupt queued behind a pause would be swallowed
// and then fire on a later, unrelated turn.
test('Check now interrupts a working agent and only queues for a paused one', async () => {
  const { gsd, posted, conversation } = await project();
  const client = scriptedClient({
    parent: [{ calls: [call('a1', 'Agent', { subagent_type: 'gsd-planner', prompt: 'long job' })] }, { text: 'finished' }],
    child: [{ calls: [call('r1', 'Read', { file_path: 'missing.txt' })], delayMs: 200 }, { text: 'report' }]
  });
  const running = conversation.send(request(client, gsd));
  let agentId: string | undefined;
  for (let attempt = 0; attempt < 200 && !agentId; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    agentId = (posted.filter((message) => message.type === 'agents').at(-1)?.agents as Array<{ id: string }> | undefined)?.[0]?.id;
  }
  assert.ok(agentId, 'the sub-agent started');
  // Working: the check lands as an interruption, which ends the wait at once.
  posted.length = 0;
  assert.equal(conversation.controlAgent(agentId, 'nudge'), true);
  assert.deepEqual(posted.filter((message) => message.type === 'steer-state').map((message) => message.state), ['queued', 'interrupting']);
  // Paused: the check is refused, because it would arrive on a later, unrelated turn, which is worse than doing nothing.
  conversation.controlAgent(agentId, 'pause');
  posted.length = 0;
  assert.equal(conversation.controlAgent(agentId, 'nudge'), false, 'a paused agent takes no check');
  assert.deepEqual(posted.filter((message) => message.type === 'steer-state'), [], 'nothing was queued behind the pause');
  conversation.controlAgent(agentId, 'stop');
  await running.catch(() => undefined);
  conversation.dispose();
});

test('Check now for an agent that has gone is refused, so the button cannot claim the check ran', async () => {
  const { gsd, posted, conversation } = await project();
  await conversation.send(request(scriptedClient({ parent: [{ text: 'done' }] }), gsd));
  assert.equal(conversation.controlAgent('gsd-planner-gone', 'nudge'), false);
  assert.deepEqual(posted.filter((message) => message.type === 'steer-state'), [], 'nothing was queued for an agent that is not there');
});

test('the prompt advises handing work to sub-agents only when the run has the Agent tool', async () => {
  const { gsd, conversation } = await project();
  const systems: string[] = [];
  const client = scriptedClient({ parent: [{ calls: [call('a1', 'Agent', { subagent_type: 'gsd-planner', prompt: 'plan it' })] }, { text: 'done' }] });
  const original = client.streamCompletion.bind(client);
  client.streamCompletion = async function* (model: string, messages: AgentMessage[]) {
    if (!systems.includes(String(messages[0]?.content))) systems.push(String(messages[0]?.content));
    yield* original(model, messages);
  };
  await conversation.send(request(client, gsd));
  const [lead, planner] = systems;
  assert.match(lead, /Fan out every multi-part task/);
  assert.match(lead, /use the Agent tool with that subagent_type/);
  // The planner's tool list is Read only, so it has no Agent tool and is not told to use one.
  assert.ok(planner.startsWith('You are the planner.'));
  assert.doesNotMatch(planner, /Fan out every multi-part task|use the Agent tool|Agent call's task/);
  assert.match(planner, /You have no Agent tool here/);

  // A plain chat with no agents to start has no Agent tool either.
  const plain = await project();
  const plainSystems: string[] = [];
  const plainClient = scriptedClient({ parent: [{ text: 'hi' }] });
  const plainOriginal = plainClient.streamCompletion.bind(plainClient);
  plainClient.streamCompletion = async function* (model: string, messages: AgentMessage[]) { plainSystems.push(String(messages[0]?.content)); yield* plainOriginal(model, messages); };
  await plain.conversation.send({ ...request(plainClient, plain.gsd), gsd: undefined });
  assert.doesNotMatch(plainSystems[0], /Fan out every multi-part task|Agent call's task/);
});

test('with one parallel slot, a sub-agent that starts its own foreground agent does not wait for ever on its own slot', { timeout: 20_000 }, async () => {
  const { gsd, posted, conversation } = await project();
  const nested: GsdContext = { ...gsd, agents: [
    { name: 'gsd-lead', description: 'Leads', tools: ['Read', 'Agent'], body: 'You are the lead.', file: path.join(gsd.home, 'agents', 'gsd-lead.md') },
    ...gsd.agents
  ] };
  const counters = { parent: 0, lead: 0, planner: 0 };
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const system = String(messages[0]?.content);
      const who = system.startsWith('You are the lead.') ? 'lead' : system.startsWith('You are the planner.') ? 'planner' : 'parent';
      const turn = counters[who]++;
      const reply = (content: string | null, calls?: ToolCall[]): CompletionEvent => ({ type: 'done', message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finishReason: calls ? 'tool_calls' : 'stop', usage });
      if (who === 'parent') yield turn === 0 ? reply(null, [call('p1', 'Agent', { subagent_type: 'gsd-lead', prompt: 'lead it' })]) : reply('all done');
      else if (who === 'lead') yield turn === 0 ? reply(null, [call('l1', 'Agent', { subagent_type: 'gsd-planner', prompt: 'plan it' })]) : reply(`lead report: ${String(messages.at(-1)?.content)}`);
      else yield reply('planner report');
    },
    async actualCostsUsd() { return undefined; }
  };
  await conversation.send(request(client as never, nested, { maxParallelAgents: 1 }));
  assert.match(String(posted.find((message) => message.type === 'tool-end' && message.callId === 'p1')?.output), /lead report: planner report/);
  assert.deepEqual(counters, { parent: 2, lead: 2, planner: 1 });
});

test('with one parallel slot, a sub-agent that starts a BACKGROUND agent finishes and frees its slot, and the background agent then runs', { timeout: 20_000 }, async () => {
  // A background call returns at once and no tool lets a sub-agent block on its report, so the sub-agent ends its own turn and releases the slot;
  // the background agent queues behind it rather than deadlocking.
  const { gsd, posted, conversation } = await project();
  const nested: GsdContext = { ...gsd, agents: [
    { name: 'gsd-lead', description: 'Leads', tools: ['Read', 'Agent'], body: 'You are the lead.', file: path.join(gsd.home, 'agents', 'gsd-lead.md') },
    ...gsd.agents
  ] };
  const counters = { parent: 0, lead: 0, planner: 0 };
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const system = String(messages[0]?.content);
      const who = system.startsWith('You are the lead.') ? 'lead' : system.startsWith('You are the planner.') ? 'planner' : 'parent';
      const turn = counters[who]++;
      const reply = (content: string | null, calls?: ToolCall[]): CompletionEvent => ({ type: 'done', message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finishReason: calls ? 'tool_calls' : 'stop', usage });
      if (who === 'parent') yield turn === 0 ? reply(null, [call('p1', 'Agent', { subagent_type: 'gsd-lead', prompt: 'lead it' })]) : reply('all done');
      else if (who === 'lead') yield turn === 0 ? reply(null, [call('l1', 'Agent', { subagent_type: 'gsd-planner', prompt: 'plan it', run_in_background: true })]) : reply('lead started the planner');
      else yield reply('planner report');
    },
    async actualCostsUsd() { return undefined; }
  };
  try {
    await conversation.send(request(client as never, nested, { maxParallelAgents: 1 }));
    // Asserted before dispose: the main run waits for its background agents before send returns, so the planner has run by now.
    assert.match(String(posted.find((message) => message.type === 'tool-end' && message.callId === 'p1')?.output), /lead started the planner/);
    assert.equal(counters.planner, 1, 'the background planner ran once the lead had freed the slot');
  } finally {
    conversation.dispose();
  }
});

test('at the critical threshold when summarizing cannot free space, the user is told once', async () => {
  const { root, gsd, posted, conversation } = await project();
  await writeFile(path.join(root, 'small.txt'), 'x\n');
  const client = scriptedClient({ parent: [{ calls: [call('r1', 'Read', { file_path: 'small.txt' })] }, { calls: [call('r2', 'Read', { file_path: 'small.txt' })] }, { text: 'the answer' }] });
  await conversation.send(request(client, gsd, { text: 'y'.repeat(6_000), contextWindows: { 'z-ai/glm-5.3': 2_000 } }));
  const notices = posted.filter((message) => message.type === 'notice' && /summarizing could not free space/.test(String(message.text)));
  assert.equal(notices.length, 1, 'one notice across the run\'s three turns');
  assert.ok(!posted.some((message) => message.type === 'notice' && /summarized to stay within/.test(String(message.text))));
});
