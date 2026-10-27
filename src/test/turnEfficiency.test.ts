import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentRun } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { CORE_TOOLS } from '../agent/tools';
import { makeWebFetchTool } from '../agent/webTools';
import { ActivityFeed, timeBreakdown } from '../services/agentActivity';
import { CompletionEvent, NearAiClient, type AgentMessage, type ToolCall } from '../services/nearAiClient';

// Fewer, faster turns without doing less: independent lookups from one turn run together, and
// each agent's time is split into waiting, generating, and tools so slow runs can be diagnosed.

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('web fetches requested in one turn run at the same time; a write between them still runs alone and in order', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-together-'));
  const shell = new ShellSession(root);
  let inFlight = 0;
  let peak = 0;
  const order: string[] = [];
  const slowWeb = (async (url: string) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 150));
    inFlight -= 1;
    order.push(String(url));
    return new Response(`page ${url}`, { headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  const webFetch = makeWebFetchTool({ lookup: async () => ['93.184.216.34'], fetch: slowWeb });
  const turns: Array<ToolCall[] | string> = [[
    call('f1', 'WebFetch', { url: 'https://a.example/' }), call('f2', 'WebFetch', { url: 'https://b.example/' }), call('f3', 'WebFetch', { url: 'https://c.example/' }),
    call('w1', 'Write', { file_path: 'notes.md', content: 'after the first three' }),
    call('f4', 'WebFetch', { url: 'https://d.example/' })
  ], 'done'];
  let turn = 0;
  const client = { async *streamCompletion(): AsyncGenerator<CompletionEvent> { const next = turns[turn++]; yield { type: 'done', message: typeof next === 'string' ? { role: 'assistant', content: next } : { role: 'assistant', content: null, tool_calls: next }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } }; } };
  try {
    const run = new AgentRun({ client, model: 'm', tools: [...CORE_TOOLS, webFetch], context: { root, checkpoints: new RunCheckpoints('together'), shell, readFiles: new Set() }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'allow' }), emit: () => undefined });
    const started = Date.now();
    const result = await run.run([{ role: 'user', content: 'research' } as AgentMessage], new AbortController().signal);
    const elapsed = Date.now() - started;
    assert.equal(peak, 3, 'the three fetches before the write ran together');
    assert.ok(elapsed < 450, `two rounds of 150 ms, not four (${elapsed} ms)`);
    assert.deepEqual(order.slice(-1), ['https://d.example/'], 'the fetch after the write ran after it');
    assert.equal(await readFile(path.join(root, 'notes.md'), 'utf8'), 'after the first three');
    const ids = result.messages.filter((message) => message.role === 'tool').map((message) => (message as { tool_call_id: string }).tool_call_id);
    assert.deepEqual(ids, ['f1', 'f2', 'f3', 'w1', 'f4'], 'results come back in the order the model asked');
  } finally {
    shell.dispose();
  }
});

test('a streamed reply reports time to first token and how much was reasoning', async () => {
  const chunks = [{ id: 'c1', choices: [{ delta: { reasoning_content: 'x'.repeat(300) } }] }, { choices: [{ delta: { content: 'y'.repeat(100) } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 1_000, completion_tokens: 100 } }];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).concat('data: [DONE]', '').join('\n\n');
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'k', fetchFn: (async () => { await new Promise((resolve) => setTimeout(resolve, 40)); return new Response(body); }) as typeof fetch });
  let done: Extract<CompletionEvent, { type: 'done' }> | undefined;
  for await (const event of client.streamCompletion('m', [{ role: 'user', content: 'hi' }], [])) if (event.type === 'done') done = event;
  assert.ok(done!.usage.firstTokenMs! >= 35 && done!.usage.firstTokenMs! <= done!.usage.latencyMs, `first token after ${done!.usage.firstTokenMs} ms of ${done!.usage.latencyMs}`);
  assert.deepEqual([done!.usage.reasoningChars, done!.usage.answerChars, done!.usage.reasoningTokens], [300, 100, undefined]);

  const reported = chunks.slice(0, 3).concat({ choices: [], usage: { prompt_tokens: 1_000, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 70 } } } as never);
  const client2 = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'k', fetchFn: (async () => new Response(reported.map((chunk) => `data: ${JSON.stringify(chunk)}`).concat('data: [DONE]', '').join('\n\n'))) as typeof fetch });
  for await (const event of client2.streamCompletion('m', [{ role: 'user', content: 'hi' }], [])) if (event.type === 'done') done = event;
  assert.equal(done!.usage.reasoningTokens, 70);
});

test('agent stats split time into waiting, generating, and tools, with speed that excludes the wait', () => {
  let now = 0;
  const feed = new ActivityFeed({ maxAgeMs: 3_600_000, maxBytes: 1_048_576 }, () => now);
  feed.agentStarted({ agentId: 'r-abc123', agent: 'gsd-project-researcher', runId: 'run', model: 'z-ai/glm-5.3-flash' });
  feed.turn('r-abc123', { verificationStatus: 'unknown', latencyMs: 30_000, firstTokenMs: 10_000, outputTokens: 1_000, reasoningChars: 3_000, answerChars: 1_000 });
  feed.turn('r-abc123', { verificationStatus: 'unknown', latencyMs: 20_000, firstTokenMs: 5_000, outputTokens: 500, reasoningTokens: 100 });
  now = 80_000;
  const stat = feed.agentStats()[0];
  const time = timeBreakdown(stat, now);
  assert.deepEqual([time.elapsedMs, time.waitMs, time.generateMs, time.otherMs], [80_000, 15_000, 35_000, 30_000]);
  assert.ok(Math.abs(time.tokensPerSecond! - 1_500 / 35) < 1e-9);
  assert.equal(stat.reasoningTokens, 750 + 100, 'estimated from characters where not reported, reported otherwise');
  assert.equal(stat.reasoningEstimated, true);
  assert.ok(Math.abs(time.reasoningShare! - 850 / 1_500) < 1e-9);
});
