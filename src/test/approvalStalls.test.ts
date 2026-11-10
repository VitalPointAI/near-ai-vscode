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
