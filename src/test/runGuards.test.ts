import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentRun } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { CORE_TOOLS } from '../agent/tools';
import { AgentConversation, GsdContext } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// Guards against runs that burn tokens without producing anything: an agent repeating the same
// action is nudged and then stopped, and a run stops at its cost or token budget.

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

async function runScript(next: (turn: number, messages: AgentMessage[]) => ToolCall[] | string) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-loop-guard-'));
  let turn = 0;
  const transcripts: AgentMessage[][] = [];
  const client = { async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> { transcripts.push(structuredClone(messages)); const step = next(turn++, messages); yield { type: 'done', message: typeof step === 'string' ? { role: 'assistant', content: step } : { role: 'assistant', content: null, tool_calls: step }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } }; } };
  const shell = new ShellSession(root);
  const texts: string[] = [];
  try {
    const run = new AgentRun({ client, model: 'm', tools: CORE_TOOLS, maxTurns: 60, context: { root, checkpoints: new RunCheckpoints('guard'), shell, readFiles: new Set() }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'allow' }), emit: (event) => { if (event.type === 'text') texts.push(event.text); } });
    const result = await run.run([{ role: 'user', content: 'go' }], new AbortController().signal);
    return { result, turns: turn, transcripts, texts };
  } finally {
    shell.dispose();
  }
}

test('an agent repeating the same action is nudged once, then stopped', async () => {
  const { result, turns, transcripts, texts } = await runScript((turn) => [call(`w${turn}`, 'Write', { file_path: '.planning/probe.cjs', content: `// attempt ${turn}` })]);
  assert.equal(result.outcome, 'max-turns');
  assert.equal(turns, 14, 'stopped at the 14th repetition, not the 60-turn limit');
  const nudges = transcripts.at(-1)!.filter((message) => message.role === 'user' && String(message.content).startsWith('<loop-guard>You have repeated'));
  assert.equal(nudges.length, 1, 'nudged once, at the 8th repetition');
  assert.match(String(nudges[0].content), /Write \.planning\/probe\.cjs.*8 times/);
  assert.match(texts.join(''), /Stopped this agent: it repeated the same action \(Write \.planning\/probe\.cjs\) 14 times/);
});

test('varied work, and reading one file in chunks, are not treated as a loop', async () => {
  const { result, turns } = await runScript((turn) => (turn < 30 ? [call(`c${turn}`, turn % 2 ? 'Write' : 'Read', turn % 2 ? { file_path: `src/file${turn}.js`, content: 'x' } : { file_path: 'big.log', offset: turn * 100 })] : 'done'));
  assert.equal(result.outcome, 'completed');
  assert.equal(turns, 31);
});

test('a run stops at its cost budget, counting its sub-agents, and keeps its work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-budget-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-budget-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-worker', description: 'Works', tools: ['Read'], body: 'You are the worker.', file: path.join(home, 'agents', 'gsd-worker.md') }], shellEnv: {} };
  let childTurns = 0;
  let parentTurns = 0;
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const usage = { inputTokens: 10_000, outputTokens: 500, estimatedCostUsd: 1, verificationStatus: 'unknown' as const, latencyMs: 1 };
      if (String(messages[0].content).startsWith('You are the worker.')) { childTurns += 1; yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call(`r${childTurns}`, 'Read', { file_path: `f${childTurns}.txt` })] }, finishReason: 'tool_calls', usage }; return; }
      parentTurns += 1;
      yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'Agent', { subagent_type: 'gsd-worker', prompt: 'keep going' })] }, finishReason: 'tool_calls', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  try {
    await conversation.send({ text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd, budget: { maxCostUsd: 3.5, maxTokens: 10_000_000 } });
  } finally {
    conversation.dispose();
  }
  assert.equal(parentTurns + childTurns, 4, `stopped after $4 of $3.50 (parent ${parentTurns}, child ${childTurns})`);
  assert.ok(posted.some((message) => message.type === 'notice' && /Stopped the run: its estimated cost reached \$4\.00, the limit for one run \(\$3\.50/.test(String(message.text))));
  assert.ok(posted.some((message) => message.type === 'assistant-cancelled'));
});

test('an approval nobody answers is declined after the timeout, and the run carries on', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-approval-timeout-'));
  let turn = 0;
  let toolResult = '';
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
      turn += 1;
      if (turn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('w1', 'Write', { file_path: 'notes.md', content: 'x' })] }, finishReason: 'tool_calls', usage }; return; }
      toolResult = String(messages.at(-1)?.content);
      yield { type: 'done', message: { role: 'assistant', content: 'Could not write notes.md: it needs your approval.' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.approvalTimeoutMs = 50;
  try {
    await conversation.send({ text: 'write notes', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES });
  } finally {
    conversation.dispose();
  }
  assert.ok(posted.some((message) => message.type === 'approval-request'));
  assert.match(String(posted.find((message) => message.type === 'approval-expired')?.text), /No one approved "Write notes\.md" within 0 minutes, so it was declined/);
  assert.match(toolResult, /declined[\s\S]*Nobody answered within 0 minutes/);
  assert.ok(posted.some((message) => message.type === 'assistant-done'), 'the run finished instead of waiting');
});

test('each reply is capped, a cut-off reply asks for a shorter continuation and its tool call is not run, and repeated cut-offs stop the agent', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const { NearAiClient } = await import('../services/nearAiClient');
  const capped = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'k', fetchFn: (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'small', max_output_tokens: 8_000 }, { id: 'big' }] }));
    sent.push(JSON.parse(String(init?.body)));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }) as typeof fetch });
  await capped.listModels().catch(() => undefined);
  for await (const event of capped.streamCompletion('small', [{ role: 'user', content: 'hi' }], [])) void event;
  for await (const event of capped.streamCompletion('big', [{ role: 'user', content: 'hi' }], [], undefined, { maxOutputTokens: 12_000 })) void event;
  assert.deepEqual(sent.map((body) => body.max_tokens), [8_000, 12_000], 'the default 32,000 is lowered to the model\'s own limit; a setting applies otherwise');

  const { result, turns, transcripts, texts } = await runScriptWithFinish((turn) => (turn === 0 ? { calls: [call('w1', 'Write', { file_path: 'half.md', content: 'trunc' })], finish: 'length' } : turn < 6 ? { text: 'and so on and so on', finish: 'length' } : { text: 'done', finish: 'stop' }));
  assert.match(String(transcripts[1].at(-1)?.content), /^<output-limit>Your last reply hit the output limit and was cut off/);
  assert.ok(!transcripts[1].some((message) => message.role === 'tool'), 'the cut-off tool call was not run');
  assert.equal(result.outcome, 'max-turns');
  assert.equal(turns, 4, 'stopped at the fourth cut-off reply');
  assert.match(texts.join(''), /replies kept running past the output limit/);
});

async function runScriptWithFinish(next: (turn: number) => { calls?: ToolCall[]; text?: string; finish: string }) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-output-limit-'));
  let turn = 0;
  const transcripts: AgentMessage[][] = [];
  const client = { async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> { transcripts.push(structuredClone(messages)); const step = next(turn++); yield { type: 'done', message: { role: 'assistant', content: step.text ?? null, ...(step.calls ? { tool_calls: step.calls } : {}) }, finishReason: step.finish, usage: { verificationStatus: 'unknown', latencyMs: 1 } }; } };
  const shell = new ShellSession(root);
  const texts: string[] = [];
  try {
    const run = new AgentRun({ client, model: 'm', tools: CORE_TOOLS, maxTurns: 30, context: { root, checkpoints: new RunCheckpoints('limit'), shell, readFiles: new Set() }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'allow' }), emit: (event) => { if (event.type === 'text') texts.push(event.text); } });
    return { result: await run.run([{ role: 'user', content: 'go' }], new AbortController().signal), turns: turn, transcripts, texts };
  } finally {
    shell.dispose();
  }
}
