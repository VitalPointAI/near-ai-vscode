import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { AWAITING_APPROVAL_PREFIX } from '../agent/loop';
import { AgentConversation } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// PERF-01: a sub-agent's approval that nobody answers no longer parks the run for 15 minutes. The call returns "awaiting approval" after a short wait,
// the card stays queued, three in a row pause the run with a message, and answering one carries on (and tells the lead).

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };

async function until<T>(find: () => T | undefined, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error('the expected message never arrived');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('unanswered sub-agent approvals return "awaiting approval", three pause the run, and a late answer resumes it and reaches the lead', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-approval-stalls-'));
  const subResults: string[] = [];
  const leadTranscripts: AgentMessage[][] = [];
  let subTurn = 0;
  let leadTurn = 0;
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const sub = String(messages[0]?.content ?? '').startsWith('You help');
      if (sub) {
        for (const message of messages) if (message.role === 'tool' && !subResults.includes(String(message.content))) subResults.push(String(message.content));
        subTurn += 1;
        if (subTurn <= 4) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call(`s${subTurn}`, 'Write', { file_path: `out-${subTurn}.md`, content: 'x' })] }, finishReason: 'tool_calls', usage }; return; }
        yield { type: 'done', message: { role: 'assistant', content: 'Helper report: four writes are waiting for approval.' }, finishReason: 'stop', usage };
        return;
      }
      leadTranscripts.push(structuredClone(messages));
      leadTurn += 1;
      if (leadTurn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'Agent', { subagent_type: 'helper', prompt: 'write the notes', description: 'write notes' })] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.subagentApprovalWaitMs = 20;
  conversation.approvalTimeoutsBeforePause = 3;
  const running = conversation.send({
    text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES,
    projectAgents: [{ name: 'helper', description: 'helper', tools: ['Write'], body: 'You help.', file: path.join(root, 'team.md') }]
  });
  try {
    const paused = await until(() => posted.find((message) => message.type === 'notice' && /^Paused: 3 approvals in a row went unanswered/.test(String(message.text))));
    assert.ok(paused);
    assert.equal(posted.filter((message) => message.type === 'tool-end' && String(message.output).startsWith(AWAITING_APPROVAL_PREFIX)).length, 3, 'each unanswered call returned at once with "awaiting approval"');
    assert.ok(subResults.every((result) => result.startsWith(AWAITING_APPROVAL_PREFIX)), 'the sub-agent saw the awaiting-approval result');
    assert.equal(subTurn, 3, 'the sub-agent is held before its next model turn while the run is paused');
    assert.equal(conversation.waitingPrompts().length, 3, 'the cards stay queued for the user');
    const first = conversation.waitingPrompts().find((prompt) => String(prompt.callId).endsWith(':s1'))!;
    conversation.answerApproval(String(first.callId), { decision: 'allow' });
    await until(() => posted.find((message) => message.type === 'notice' && message.text === 'Resumed.'));
    // The fourth write also goes unanswered; the run is not paused again until three more in a row.
    await running;
  } finally {
    conversation.dispose();
  }
  assert.equal(subTurn, 5, 'after the answer the sub-agent carried on and finished');
  const delivered = leadTranscripts.at(-1)!.map((message) => String(message.content ?? ''));
  assert.ok(delivered.some((content) => content.startsWith('<approval-update agent="helper" decision="allowed">')), 'the lead is told about the late allow');
  assert.ok(delivered.some((content) => content.includes('Helper report')), 'the lead got the helper\'s report');
});

test('the main conversation keeps the 0.4.19 behaviour: its approvals wait for the person rather than returning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-approval-main-'));
  let turn = 0;
  const near = {
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      turn += 1;
      if (turn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('w1', 'Write', { file_path: 'notes.md', content: 'x' })] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.subagentApprovalWaitMs = 10;
  const running = conversation.send({ text: 'write', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES });
  try {
    const request = await until(() => posted.find((message) => message.type === 'approval-request'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(turn, 1, 'the main run is still waiting on its card');
    conversation.answerApproval(String(request.callId), { decision: 'allow' });
    await running;
  } finally {
    conversation.dispose();
  }
  assert.ok(posted.some((message) => message.type === 'tool-end' && message.callId === 'w1' && message.ok === true));
});

// Agent review of PR 34: the streak is per agent, and the pause also holds the next call of a batch.
test('one agent\'s unanswered approvals pause the run even while another agent\'s are answered, and the pause holds the rest of a batch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-approval-agents-'));
  const turns: Record<string, number> = { alpha: 0, beta: 0 };
  let leadTurn = 0;
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const system = String(messages[0]?.content ?? '');
      const who = system.startsWith('You are alpha') ? 'alpha' : system.startsWith('You are beta') ? 'beta' : undefined;
      if (who === 'alpha') {
        turns.alpha += 1;
        // One turn with four writes: the pause after the third must hold the fourth.
        if (turns.alpha === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [1, 2, 3, 4].map((n) => call(`a${n}`, 'Write', { file_path: `alpha-${n}.md`, content: 'x' })) }, finishReason: 'tool_calls', usage }; return; }
        yield { type: 'done', message: { role: 'assistant', content: 'alpha done' }, finishReason: 'stop', usage };
        return;
      }
      if (who === 'beta') {
        turns.beta += 1;
        if (turns.beta <= 3) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call(`b${turns.beta}`, 'Write', { file_path: `beta-${turns.beta}.md`, content: 'x' })] }, finishReason: 'tool_calls', usage }; return; }
        yield { type: 'done', message: { role: 'assistant', content: 'beta done' }, finishReason: 'stop', usage };
        return;
      }
      leadTurn += 1;
      if (leadTurn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('l1', 'Agent', { subagent_type: 'alpha', prompt: 'write', description: 'alpha' }), call('l2', 'Agent', { subagent_type: 'beta', prompt: 'write', description: 'beta' })] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.subagentApprovalWaitMs = 40;
  conversation.approvalTimeoutsBeforePause = 3;
  // Someone answers beta's cards at once; alpha's are left alone.
  const answering = setInterval(() => {
    for (const prompt of conversation.waitingPrompts()) if (/^beta-/.test(String(prompt.callId))) conversation.answerApproval(String(prompt.callId), { decision: 'allow' });
  }, 2);
  const agents = [
    { name: 'alpha', description: 'alpha', tools: ['Write'], body: 'You are alpha.', file: path.join(root, 'team.md') },
    { name: 'beta', description: 'beta', tools: ['Write'], body: 'You are beta.', file: path.join(root, 'team.md') }
  ];
  const running = conversation.send({ text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, projectAgents: agents });
  try {
    await until(() => posted.find((message) => message.type === 'notice' && /^Paused: 3 approvals in a row went unanswered for one agent/.test(String(message.text))));
    const started = (id: string) => posted.some((message) => message.type === 'tool-start' && String(message.callId).endsWith(`:${id}`));
    assert.ok(started('a3'), 'alpha\'s third write ran into its third timeout');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(started('a4'), false, 'the fourth call of the same batch waits while the run is paused');
    clearInterval(answering);
    const alphaCard = conversation.waitingPrompts().find((prompt) => /^alpha-/.test(String(prompt.callId)))!;
    conversation.answerApproval(String(alphaCard.callId), { decision: 'allow' });
    await until(() => (started('a4') ? true : undefined));
    for (const prompt of conversation.waitingPrompts()) conversation.answerApproval(String(prompt.callId), { decision: 'allow' });
    const answerLater = setInterval(() => { for (const prompt of conversation.waitingPrompts()) conversation.answerApproval(String(prompt.callId), { decision: 'allow' }); }, 2);
    await running;
    clearInterval(answerLater);
  } finally {
    clearInterval(answering);
    conversation.dispose();
  }
  assert.ok(posted.some((message) => message.type === 'tool-end' && String(message.callId).endsWith(':b1') && message.ok === true), 'beta\'s answered writes ran');
});

// Review of PR 34 (major): a late allow of a queued Bash card grants that exact command, and the lead is told so only because it did.
test('a late allow of a sub-agent\'s Bash command grants that command for the run, and the lead\'s own run of it does not ask again', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-late-bash-'));
  const command = 'echo late > late.txt';
  let subTurn = 0;
  let leadTurn = 0;
  const leadSaw: AgentMessage[][] = [];
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      if (String(messages[0]?.content ?? '').startsWith('You help')) {
        subTurn += 1;
        if (subTurn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('s1', 'Bash', { command })] }, finishReason: 'tool_calls', usage }; return; }
        yield { type: 'done', message: { role: 'assistant', content: 'Queued the write; it is waiting for approval.' }, finishReason: 'stop', usage };
        return;
      }
      leadSaw.push(structuredClone(messages));
      leadTurn += 1;
      if (leadTurn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'Agent', { subagent_type: 'helper', prompt: 'write it', description: 'write' })] }, finishReason: 'tool_calls', usage }; return; }
      const told = messages.some((message) => String(message.content ?? '').startsWith('<approval-update agent="helper" decision="allowed">'));
      if (told && !messages.some((message) => message.role === 'tool' && message.tool_call_id === 'l2')) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('l2', 'Bash', { command })] }, finishReason: 'tool_calls', usage }; return; }
      if (!told) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call(`wait${leadTurn}`, 'Bash', { command: 'pwd' })] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.subagentApprovalWaitMs = 20;
  const rules = { allowCommands: ['pwd'], denyCommands: DEFAULT_RULES.denyCommands };
  const running = conversation.send({ text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules, projectAgents: [{ name: 'helper', description: 'helper', tools: ['Bash'], body: 'You help.', file: path.join(root, 'team.md') }] });
  try {
    const card = await until(() => posted.find((message) => message.type === 'approval-request' && String(message.callId).endsWith(':s1')));
    await until(() => (posted.some((message) => message.type === 'tool-end' && String(message.output).startsWith(AWAITING_APPROVAL_PREFIX)) ? true : undefined));
    conversation.answerApproval(String(card.callId), { decision: 'allow' });
    await running;
  } finally {
    conversation.dispose();
  }
  const cards = posted.filter((message) => message.type === 'approval-request');
  assert.equal(cards.length, 1, 'only the sub-agent\'s card was ever shown: the lead\'s run of the same command was allowed by the grant');
  assert.ok(posted.some((message) => message.type === 'tool-end' && message.callId === 'l2' && message.ok === true), 'the lead ran the command');
  const { readFile } = await import('node:fs/promises');
  assert.equal((await readFile(path.join(root, 'late.txt'), 'utf8')).trim(), 'late');
});

// Review of PR 34: stopping a sub-agent removes its parked cards; answering one afterwards does nothing.
test('stopping a sub-agent removes its parked approval cards, and a later answer for one grants and reports nothing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-parked-stop-'));
  let subTurn = 0;
  const leadSaw: AgentMessage[][] = [];
  let leadTurn = 0;
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[], _tools: unknown, signal?: AbortSignal): AsyncGenerator<CompletionEvent> {
      if (String(messages[0]?.content ?? '').startsWith('You help')) {
        subTurn += 1;
        if (subTurn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('s1', 'Bash', { command: 'echo parked > parked.txt' })] }, finishReason: 'tool_calls', usage }; return; }
        // The sub-agent thinks until it is stopped.
        await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
        return;
      }
      leadSaw.push(structuredClone(messages));
      leadTurn += 1;
      if (leadTurn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'Agent', { subagent_type: 'helper', prompt: 'write it', description: 'write' })] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.subagentApprovalWaitMs = 20;
  const running = conversation.send({ text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, projectAgents: [{ name: 'helper', description: 'helper', tools: ['Bash'], body: 'You help.', file: path.join(root, 'team.md') }] });
  let callId = '';
  try {
    const card = await until(() => posted.find((message) => message.type === 'approval-request' && String(message.callId).endsWith(':s1')));
    callId = String(card.callId);
    await until(() => (subTurn >= 2 ? true : undefined));
    assert.equal(conversation.waitingPrompts().length, 1, 'the card is parked while the agent works on');
    const agentId = callId.slice(0, callId.lastIndexOf(':'));
    assert.equal(conversation.controlAgent(agentId, 'stop'), true);
    await until(() => (conversation.waitingPrompts().length === 0 ? true : undefined));
    assert.ok(posted.some((message) => message.type === 'prompt-closed' && message.id === callId && message.outcome === 'cancelled'), 'the view is told to drop the card');
    conversation.answerApproval(callId, { decision: 'allow' });
    await running;
  } finally {
    conversation.dispose();
  }
  const updates = leadSaw.flat().filter((message) => String(message.content ?? '').startsWith('<approval-update'));
  assert.equal(updates.length, 0, 'a late answer for a stopped agent is a no-op: nothing is reported to the lead');
  const { stat } = await import('node:fs/promises');
  assert.equal(await stat(path.join(root, 'parked.txt')).then(() => true, () => false), false, 'and nothing ran');
});

// Review of PR 34: the run-wide pause has an end, and the person coming back releases it.
async function pausedRun(after: (conversation: AgentConversation, posted: Array<Record<string, unknown>>) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-pause-limit-'));
  let subTurn = 0;
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      if (String(messages[0]?.content ?? '').startsWith('You help')) {
        subTurn += 1;
        if (subTurn <= 3) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call(`s${subTurn}`, 'Write', { file_path: `p-${subTurn}.md`, content: 'x' })] }, finishReason: 'tool_calls', usage }; return; }
        yield { type: 'done', message: { role: 'assistant', content: 'helper done' }, finishReason: 'stop', usage };
        return;
      }
      const delegated = messages.some((message) => message.role === 'tool');
      yield { type: 'done', message: delegated ? { role: 'assistant', content: 'Done.' } : { role: 'assistant', content: null, tool_calls: [call('a1', 'Agent', { subagent_type: 'helper', prompt: 'write', description: 'write' })] }, finishReason: delegated ? 'stop' : 'tool_calls', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.subagentApprovalWaitMs = 10;
  conversation.approvalTimeoutsBeforePause = 3;
  conversation.runPauseLimitMs = 150;
  const running = conversation.send({ text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, projectAgents: [{ name: 'helper', description: 'helper', tools: ['Write'], body: 'You help.', file: path.join(root, 'team.md') }] });
  try {
    await until(() => posted.find((message) => message.type === 'notice' && /^Paused: 3 approvals/.test(String(message.text))));
    await after(conversation, posted);
    await running;
  } finally {
    conversation.dispose();
  }
  return { posted, subTurn: () => subTurn };
}

test('a run paused on unanswered approvals is stopped cleanly when the pause reaches its limit', async () => {
  const { posted, subTurn } = await pausedRun(async () => undefined);
  assert.ok(posted.some((message) => message.type === 'notice' && /^Stopped the run: it was paused for .* on approvals nobody answered\. Everything it did is kept/.test(String(message.text))));
  assert.equal(subTurn(), 3, 'nothing ran after the pause');
  assert.ok(posted.some((message) => message.type === 'assistant-cancelled'), 'the run ended as stopped, not left open');
});

test('the person coming back releases the pause before its limit', async () => {
  const { posted, subTurn } = await pausedRun(async (conversation, seen) => {
    conversation.userActive();
    await until(() => seen.find((message) => message.type === 'notice' && message.text === 'Resumed.'));
    for (const prompt of conversation.waitingPrompts()) conversation.answerApproval(String(prompt.callId), { decision: 'deny' });
  });
  assert.equal(subTurn(), 4, 'the helper carried on and finished');
  assert.equal(posted.some((message) => message.type === 'notice' && /^Stopped the run: it was paused/.test(String(message.text))), false, 'the limit never fired');
});

// Merge with #36: the emergency stop reaches a run paused on unanswered approvals; it ends at once, and the pause's limit never fires afterwards.
test('a stop (as the emergency stop sends to every conversation) ends a run paused on unanswered approvals', async () => {
  let stoppedAt = 0;
  const { posted, subTurn } = await pausedRun(async (conversation) => {
    stoppedAt = Date.now();
    conversation.stop();
  });
  assert.ok(Date.now() - stoppedAt < 5_000);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(subTurn(), 3, 'nothing ran after the pause');
  assert.equal(posted.some((message) => message.type === 'notice' && /^Stopped the run: it was paused/.test(String(message.text))), false, 'the pause limit was cleared by the stop');
  assert.equal(posted.some((message) => message.type === 'notice' && message.text === 'Resumed.'), false, 'a stop is not announced as resuming');
  assert.ok(posted.some((message) => message.type === 'assistant-cancelled'));
});
