import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentEvent, AgentRun, ApprovalRequest } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { CORE_TOOLS } from '../agent/tools';
import { AgentMessage, CompletionEvent, NearAiClient, ToolCall } from '../services/nearAiClient';

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** A model that plays back fixed turns and records what it was sent. */
function scriptedModel(turns: Array<{ text?: string; calls?: ToolCall[] }>) {
  const seen: AgentMessage[][] = [];
  return {
    seen,
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      seen.push(structuredClone(messages));
      const turn = turns[seen.length - 1] ?? { text: 'done' };
      if (turn.text) yield { type: 'text', text: turn.text };
      yield { type: 'done', message: { role: 'assistant', content: turn.text ?? null, ...(turn.calls ? { tool_calls: turn.calls } : {}) }, finishReason: turn.calls ? 'tool_calls' : 'stop', usage: { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown', latencyMs: 1 } };
    }
  };
}

async function setup(turns: Parameters<typeof scriptedModel>[0], decide: (request: ApprovalRequest) => 'allow' | 'deny') {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-loop-'));
  await writeFile(path.join(root, 'a.ts'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'b.ts'), 'export const other = 2;\n');
  const model = scriptedModel(turns);
  const events: AgentEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const shell = new ShellSession(root);
  const run = new AgentRun({
    client: model, model: 'z-ai/glm-5.3', tools: CORE_TOOLS,
    context: { root, checkpoints: new RunCheckpoints('loop'), shell, readFiles: new Set() },
    policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES,
    requestApproval: async (request) => { approvals.push(request); return { decision: decide(request) }; },
    emit: (event) => events.push(event)
  });
  return { root, model, events, approvals, run, shell };
}

test('reads run without asking, an edit asks with a diff, and results flow back to the model', async () => {
  const { root, model, events, approvals, run, shell } = await setup([
    { text: 'Looking.', calls: [call('c1', 'Read', { file_path: 'a.ts' }), call('c2', 'Read', { file_path: 'b.ts' })] },
    { calls: [call('c3', 'Edit', { file_path: 'a.ts', old_string: 'value = 1', new_string: 'value = 42' })] },
    { text: 'Changed value to 42.' }
  ], () => 'allow');
  try {
    const result = await run.run([{ role: 'user', content: 'Set value to 42' }], new AbortController().signal);
    assert.equal(result.outcome, 'completed');
    assert.equal(await readFile(path.join(root, 'a.ts'), 'utf8'), 'export const value = 42;\n');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].tool, 'Edit');
    assert.match(approvals[0].preview?.kind === 'diff' ? approvals[0].preview.diff : '', /-export const value = 1;\n\+export const value = 42;/);
    const secondTurn = model.seen[1];
    assert.deepEqual(secondTurn.slice(-2).map((message) => message.role === 'tool' ? [message.tool_call_id, message.content] : []), [['c1', '1\texport const value = 1;'], ['c2', '1\texport const other = 2;']]);
    assert.deepEqual(events.filter((event) => event.type === 'tool-end').map((event) => event.type === 'tool-end' && event.ok), [true, true, true]);
    assert.equal(result.usage.length, 3);
  } finally {
    shell.dispose();
  }
});

test('a declined edit is reported to the model and the file is untouched', async () => {
  const { root, model, run, shell } = await setup([
    { calls: [call('c1', 'Read', { file_path: 'a.ts' })] },
    { calls: [call('c2', 'Write', { file_path: 'a.ts', content: 'gone' })] },
    { text: 'Understood, leaving it.' }
  ], () => 'deny');
  try {
    await run.run([{ role: 'user', content: 'wipe a.ts' }], new AbortController().signal);
    assert.equal(await readFile(path.join(root, 'a.ts'), 'utf8'), 'export const value = 1;\n');
    const toolResult = model.seen[2].at(-1);
    assert.match(toolResult?.role === 'tool' ? toolResult.content : '', /declined/);
  } finally {
    shell.dispose();
  }
});

test('bad arguments and unknown tools come back as errors the model can correct', async () => {
  const { model, run, shell } = await setup([
    { calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{not json' } }, call('c2', 'Teleport', {}), call('c3', 'Read', {})] },
    { text: 'ok' }
  ], () => 'allow');
  try {
    await run.run([{ role: 'user', content: 'go' }], new AbortController().signal);
    const results = model.seen[1].filter((message) => message.role === 'tool').map((message) => message.role === 'tool' ? message.content : '');
    assert.match(results[0], /not valid JSON/);
    assert.match(results[1], /unknown tool "Teleport"/);
    assert.match(results[2], /Missing required parameter "file_path"/);
  } finally {
    shell.dispose();
  }
});

test('the client assembles streamed tool-call fragments into whole calls with usage', async () => {
  const chunks = [
    { choices: [{ delta: { content: 'Let me check.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'Read', arguments: '{"file_' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'Glob', arguments: '{"pattern":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'path":"a.ts"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"**/*.ts"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } }
  ];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).concat('data: [DONE]', '').join('\n\n');
  let sent: Record<string, unknown> = {};
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'k', fetchFn: async (_url, init) => { sent = JSON.parse(String(init?.body)); return new Response(body, { headers: { 'inference-id': 'inf-1' } }); } });
  const events: CompletionEvent[] = [];
  for await (const event of client.streamCompletion('m', [{ role: 'user', content: 'hi' }], [{ type: 'function', function: { name: 'Read', description: 'r', parameters: {} } }])) events.push(event);
  assert.equal(sent.tool_choice, 'auto');
  const done = events.at(-1);
  assert.equal(done?.type, 'done');
  if (done?.type !== 'done') return;
  assert.equal(done.message.content, 'Let me check.');
  assert.deepEqual(done.message.tool_calls, [
    { id: 'call_a', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } },
    { id: 'call_b', type: 'function', function: { name: 'Glob', arguments: '{"pattern":"**/*.ts"}' } }
  ]);
  assert.equal(done.finishReason, 'tool_calls');
  assert.equal(done.usage.inputTokens, 120);
  assert.equal(done.usage.requestId, 'inf-1');
});
