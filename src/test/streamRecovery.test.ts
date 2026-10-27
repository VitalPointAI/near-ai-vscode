import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentEvent, AgentRun, AgentRunError } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { CORE_TOOLS } from '../agent/tools';
import { AgentConversation, GsdContext } from '../services/agentSession';
import { AgentMessage, CompletionEvent, NearAiClient, NearAiError, StreamInterruptedError, ToolCall } from '../services/nearAiClient';

// A stalled or dropped NEAR AI stream must neither hang a run nor end it: the turn is retried
// until it succeeds, and nothing the run already did is lost.

const usage = { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown' as const, latencyMs: 1 };
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const sse = (chunk: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);

/** A response body that sends `chunks` with `gapMs` between them, then optionally stops sending without closing. */
function slowBody(chunks: Uint8Array[], gapMs: number, hang = false): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      if (index < chunks.length) { controller.enqueue(chunks[index++]); return; }
      if (hang) { await new Promise(() => undefined); return; }
      controller.close();
    }
  });
}

function client(body: () => ReadableStream<Uint8Array>, streamIdleTimeoutMs: number) {
  return new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'k', maxRetries: 0, streamIdleTimeoutMs, fetchFn: (async () => new Response(body())) as typeof fetch });
}

async function collect(stream: AsyncGenerator<CompletionEvent>): Promise<CompletionEvent[]> {
  const events: CompletionEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('a long answer that keeps arriving is never cut off: the limit is on silence, not total time', async () => {
  const words = Array.from({ length: 12 }, (_, index) => sse({ choices: [{ delta: { content: `w${index} ` } }] }));
  const near = client(() => slowBody([...words, sse({ choices: [{ delta: {}, finish_reason: 'stop' }] })], 30), 100);
  const started = Date.now();
  const events = await collect(near.streamCompletion('m', [{ role: 'user', content: 'hi' }], []));
  assert.ok(Date.now() - started > 300, 'the whole answer took longer than the silence limit');
  const done = events.at(-1);
  assert.equal(done?.type === 'done' && done.message.content, words.map((_, index) => `w${index} `).join(''));
});

test('a stream that stops sending, or drops, ends with a retryable error instead of hanging', async () => {
  const stalled = client(() => slowBody([sse({ choices: [{ delta: { content: 'partial' } }] })], 5, true), 60);
  await assert.rejects(() => collect(stalled.streamCompletion('m', [{ role: 'user', content: 'hi' }], [])), (error: unknown) => {
    assert.ok(error instanceof StreamInterruptedError);
    assert.equal(error.retryable, true);
    assert.equal(error.stalled, true);
    assert.match(error.message, /stopped sending/);
    return true;
  });
  const dropped = client(() => new ReadableStream({ pull(controller) { controller.error(new TypeError('terminated')); } }), 1_000);
  await assert.rejects(() => collect(dropped.streamCompletion('m', [{ role: 'user', content: 'hi' }], [])), (error: unknown) => error instanceof StreamInterruptedError && error.retryable && !error.stalled && /dropped mid-response \(terminated\)/.test(error.message));
});

/** Fails the first `failures` model turns with the given errors (after streaming some text), then plays `turns`. */
function flakyModel(failures: Error[], turns: Array<{ text?: string; calls?: ToolCall[] }>) {
  let failed = 0;
  let played = 0;
  const idleTimeouts: Array<number | undefined> = [];
  return {
    idleTimeouts,
    async *streamCompletion(_model: string, _messages: AgentMessage[], _tools: unknown, _signal?: AbortSignal, options: { idleTimeoutMs?: number } = {}): AsyncGenerator<CompletionEvent> {
      idleTimeouts.push(options.idleTimeoutMs);
      if (failed < failures.length) {
        yield { type: 'text', text: 'half an ans' };
        throw failures[failed++];
      }
      const turn = turns[played++] ?? { text: 'done' };
      if (turn.text) yield { type: 'text', text: turn.text };
      yield { type: 'done', message: { role: 'assistant', content: turn.text ?? null, ...(turn.calls ? { tool_calls: turn.calls } : {}) }, finishReason: turn.calls ? 'tool_calls' : 'stop', usage };
    }
  };
}

async function runWith(model: ReturnType<typeof flakyModel>) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-recover-'));
  const events: AgentEvent[] = [];
  const shell = new ShellSession(root);
  try {
    const run = new AgentRun({
      client: model, model: 'm', tools: CORE_TOOLS, retryDelaysMs: [1, 2], idleTimeoutMs: 1_000,
      context: { root, checkpoints: new RunCheckpoints('recover'), shell, readFiles: new Set() },
      policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES,
      requestApproval: async () => ({ decision: 'allow' }), emit: (event) => events.push(event)
    });
    return { result: await run.run([{ role: 'user', content: 'go' }], new AbortController().signal).catch((error: unknown) => error), events };
  } finally {
    shell.dispose();
  }
}

test('a failed turn is retried until it succeeds, past the list of delays, and the run finishes on its own', async () => {
  const stall = new StreamInterruptedError('NEAR AI stopped sending the response (nothing for 1 seconds).', true);
  const busy = new NearAiError(503, 'NEAR AI request failed with HTTP 503.', true);
  const model = flakyModel([stall, busy, stall, busy, busy], [{ calls: [call('g1', 'Glob', { pattern: '*' })] }, { text: 'all done' }]);
  const { result, events } = await runWith(model);
  assert.ok(!(result instanceof Error), String(result));
  const run = result as Awaited<ReturnType<AgentRun['run']>>;
  assert.equal(run.outcome, 'completed');
  assert.equal(run.messages.at(-1)?.content, 'all done');
  const retries = events.filter((event): event is Extract<AgentEvent, { type: 'retry' }> => event.type === 'retry');
  assert.deepEqual(retries.map((event) => [event.attempt, event.delayMs]), [[1, 1], [2, 2], [3, 2], [4, 2], [5, 2]], 'the last delay repeats; there is no retry limit');
  assert.ok(retries.every((event) => event.discardText === 'half an ans'.length), 'each failed attempt reports the partial text to discard');
  assert.deepEqual(model.idleTimeouts.slice(0, 4), [1_000, 2_000, 2_000, 4_000], 'each stall gives the next attempt a longer silence limit');
});

test('an error retrying cannot fix still ends the run, but hands back everything it did', async () => {
  const model = flakyModel([], [{ calls: [call('g1', 'Glob', { pattern: '*' })] }]);
  const original = model.streamCompletion.bind(model);
  let turns = 0;
  model.streamCompletion = async function* (...args: Parameters<typeof original>) {
    if (++turns === 2) throw new NearAiError(400, 'NEAR AI request failed with HTTP 400.', false);
    yield* original(...args);
  };
  const { result } = await runWith(model);
  assert.ok(result instanceof AgentRunError);
  assert.match(result.message, /HTTP 400/);
  assert.deepEqual(result.messages.map((message) => message.role), ['user', 'assistant', 'tool'], 'the tool round trip is kept');
});

test('a sub-agent recovers by itself, and a failed run\'s work stays in the conversation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-recover-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-recover-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-worker', description: 'Works', tools: ['Read'], body: 'You are the worker.', file: path.join(home, 'agents', 'gsd-worker.md') }], shellEnv: {} };
  let childFailures = 1;
  let parentTurn = 0;
  let resumedWith: AgentMessage[] = [];
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      if (messages[0]?.content?.startsWith('You are the worker.')) {
        if (childFailures-- > 0) throw new StreamInterruptedError('NEAR AI stopped sending the response (nothing for 120 seconds).', true);
        yield { type: 'done', message: { role: 'assistant', content: 'worker report' }, finishReason: 'stop', usage };
        return;
      }
      parentTurn += 1;
      if (parentTurn === 1) yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'Agent', { subagent_type: 'gsd-worker', prompt: 'work' })] }, finishReason: 'tool_calls', usage };
      else if (parentTurn === 2) throw new NearAiError(401, 'NEAR AI request failed with HTTP 401.', false);
      else { resumedWith = structuredClone(messages); yield { type: 'done', message: { role: 'assistant', content: 'continued' }, finishReason: 'stop', usage }; }
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  const request = { text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky' as const, emergencyStop: false }, rules: DEFAULT_RULES, gsd };
  try {
    await assert.rejects(() => conversation.send(request), /HTTP 401/);
    const workerResult = posted.find((message) => message.type === 'tool-end' && message.callId === 'a1');
    assert.equal(workerResult?.output, 'worker report', 'the sub-agent retried its stalled turn and reported');
    assert.ok(posted.some((message) => message.type === 'notice' && /^gsd-worker: NEAR AI stopped sending/.test(String(message.text))));
    await conversation.send({ ...request, text: 'continue' });
    assert.equal(posted.filter((message) => message.type === 'assistant-done').length, 1);
    assert.equal(parentTurn, 3);
    const toolResult = resumedWith.find((message) => message.role === 'tool');
    assert.equal(toolResult?.content, 'worker report', 'the next message continues with the sub-agent\'s result from the failed run');
    assert.equal(resumedWith.at(-1)?.content, 'continue');
  } finally {
    conversation.dispose();
  }
});
