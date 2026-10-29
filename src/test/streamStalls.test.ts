// Regression tests for runs on moonshotai/kimi-k3 that started and then silently stopped (0.4.4):
// NEAR answered 200, then the stream ended about 90 s later without a final chunk, and the client
// took that for a finished, empty answer, so the run "completed" with nothing to show. A stream
// that only sent keep-alive comments hung forever, and a stop landed only at the next chunk.
//
// Against a real HTTP fake NEAR AI (the client's own fetch, so a stall must really close the
// connection): (a) headers then nothing, (b) keep-alive comments only, (c) reasoning then silence,
// (d) the connection closed without [DONE], (e) reasoning that streams for a long time and must not
// be cut off, plus mid-stream error events, stop, and the per-turn cap; then the loop's retry budget
// and what the chat, Agent Activity, and the spend ledger show once it runs out.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentEvent, AgentRun, AgentRunError, ModelStalledError, STALL_RETRIES } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { ActivityFeed } from '../services/agentActivity';
import { AgentConversation, retryNotice } from '../services/agentSession';
import { providerErrorMessage } from '../services/chatBridge';
import { CompletionEvent, NearAiClient, NearAiError, StreamInterruptedError } from '../services/nearAiClient';
import { SpendAccount, SpendSink } from '../services/spendAccount';
import type { SpendFinish, SpendStart } from '../services/spendLedger';

const MODEL = 'moonshotai/kimi-k3';
type Behaviour = (res: http.ServerResponse) => void;

const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const delta = (value: Record<string, unknown>, extra: Record<string, unknown> = {}) => data({ id: 'chatcmpl-1', choices: [{ index: 0, delta: value, ...extra }] });
const finish = (reason = 'stop') => delta({}, { finish_reason: reason });
const usageChunk = data({ id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
/** Writes `chunks` every `everyMs` until the client goes away; returns nothing (the stream never ends on its own). */
const every = (everyMs: number, chunks: () => string): Behaviour => (res) => { const timer = setInterval(() => res.write(chunks()), everyMs); res.on('close', () => clearInterval(timer)); };

const BEHAVIOURS: Record<string, Behaviour> = {
  /** (a) 200 and SSE headers, then nothing at all. */
  silent: () => undefined,
  /** (b) only SSE keep-alive comments, forever. */
  keepAlive: every(20, () => ': keep-alive\n\n'),
  /** (c) reasoning deltas, then silence with the connection held open. */
  reasoningThenSilence: (res) => { res.write(delta({ role: 'assistant' })); res.write(delta({ reasoning_content: 'Let me look at ' })); res.write(delta({ reasoning_content: 'the failing test.' })); },
  /** (d) the stream ends with no finish_reason and no [DONE] (a gateway cutting it at its timeout). */
  closedEarly: (res) => { res.write(delta({ role: 'assistant' })); setTimeout(() => res.end(), 30); },
  /** [DONE] with no answer and no finish_reason. */
  doneWithNothing: (res) => { res.write(delta({ role: 'assistant' })); res.end('data: [DONE]\n\n'); },
  /** NEAR's error event in the middle of the stream. */
  midStreamError: (res) => { res.write(delta({ role: 'assistant' })); res.end(data({ error: { message: 'upstream timed out', type: 'upstream_error', code: 504 } })); },
  midStreamBadRequest: (res) => { res.end(data({ error: { message: 'context length exceeded', type: 'invalid_request_error', code: 400 } })); },
  finishError: (res) => { res.write(delta({ reasoning_content: 'hmm' })); res.end(delta({}, { finish_reason: 'error', error: { message: 'provider crashed' } })); },
  /** A whole, ordinary answer. */
  answer: (res) => { res.write(delta({ content: 'All done.' })); res.write(finish()); res.write(usageChunk); res.end('data: [DONE]\n\n'); }
};

/** (e) reasoning (with keep-alives between) for `totalMs`, then an answer. */
function longReasoning(totalMs: number, everyMs = 25): Behaviour {
  return (res) => {
    const started = Date.now();
    let step = 0;
    const timer = setInterval(() => {
      if (Date.now() - started < totalMs) { res.write(delta({ reasoning_content: `step ${++step}. ` })); res.write(': keep-alive\n\n'); return; }
      clearInterval(timer);
      res.write(delta({ content: 'The answer.' }));
      res.write(finish());
      res.write(usageChunk);
      res.end('data: [DONE]\n\n');
    }, everyMs);
    res.on('close', () => clearInterval(timer));
  };
}

interface FakeNear { base: string; requests: number; clientClosed: number; rids: string[]; billed: string[]; close(): Promise<void> }

/** A fake NEAR AI on localhost: each /chat/completions request plays the next behaviour (the last repeats). */
async function fakeNear(plan: Behaviour[]): Promise<FakeNear> {
  const state = { requests: 0, clientClosed: 0, rids: [] as string[], billed: [] as string[] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      if (req.url?.endsWith('/billing/costs')) {
        const ids = (JSON.parse(body || '{}') as { requestIds?: string[] }).requestIds ?? [];
        state.billed.push(...ids);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ requests: ids.map((requestId) => ({ requestId, costNanoUsd: 1_000_000 })) }));
        return;
      }
      if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
      const index = state.requests++;
      const rid = `inf-${index + 1}`;
      state.rids.push(rid);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'inference-id': rid });
      res.flushHeaders();
      res.on('close', () => { if (!res.writableEnded) state.clientClosed += 1; });
      (plan[Math.min(index, plan.length - 1)])(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    get requests() { return state.requests; }, get clientClosed() { return state.clientClosed; }, get rids() { return state.rids; }, get billed() { return state.billed; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}

/** The spend ledger's view of each response: how it started and how (whether) it ended. */
function ledger() {
  const entries: Array<{ start: SpendStart; end?: SpendFinish }> = [];
  const sink: SpendSink = {
    begin: (start) => { const entry: { start: SpendStart; end?: SpendFinish } = { start }; entries.push(entry); return (end) => { entry.end ??= end; }; },
    limitReached: () => undefined,
    attach: () => undefined
  };
  return { sink, entries };
}

async function collect(stream: AsyncGenerator<CompletionEvent>): Promise<CompletionEvent[]> {
  const events: CompletionEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Waits until `check` holds (the server notices a closed socket a moment after the client closes it). */
async function eventually(check: () => boolean, ms = 1_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  return check();
}

async function streamOnce(behaviour: Behaviour, options: { idleMs?: number; turnMs?: number; signal?: AbortSignal } = {}) {
  const near = await fakeNear([behaviour]);
  const spend = ledger();
  const client = new NearAiClient({ baseUrl: near.base, apiKey: 'k', maxRetries: 0, streamIdleTimeoutMs: options.idleMs ?? 150, ...(options.turnMs ? { streamTurnTimeoutMs: options.turnMs } : {}), spend: spend.sink });
  const events: CompletionEvent[] = [];
  const started = Date.now();
  let error: unknown;
  try {
    for await (const event of client.streamCompletion(MODEL, [{ role: 'user', content: 'fix the test' }], [], options.signal)) events.push(event);
  } catch (caught) { error = caught; }
  const elapsedMs = Date.now() - started;
  const closedByClient = await eventually(() => near.clientClosed > 0, 500);
  await near.close();
  return { events, error, elapsedMs, closedByClient, entries: spend.entries, rids: near.rids };
}

function assertStalled(result: Awaited<ReturnType<typeof streamOnce>>, idleMs: number): void {
  assert.ok(result.error instanceof StreamInterruptedError, `expected a stall, got ${String(result.error)}`);
  assert.equal(result.error.kind, 'stalled');
  assert.equal(result.error.stalled, true);
  assert.equal(result.error.retryable, true);
  assert.equal(result.error.idleMs, idleMs);
  assert.match(result.error.message, /stopped sending the response \(no data for 0\.2 seconds\)/);
  assert.ok(result.elapsedMs >= idleMs - 20 && result.elapsedMs < idleMs + 1_000, `stalled after ${result.elapsedMs} ms`);
  assert.ok(result.closedByClient, 'the stall closed the HTTP connection itself, not just the reader');
  assert.equal(result.events.some((event) => event.type === 'done'), false);
  assert.deepEqual(result.entries.map((entry) => [entry.start.status, entry.end?.status, entry.end?.requestId]), [['open', 'partial', result.rids[0]]], 'the spend entry is closed as partial, with its inference-id for reconciliation');
}

test('(a) headers and then nothing: the stream stalls after the idle limit and the connection is closed', async () => {
  assertStalled(await streamOnce(BEHAVIOURS.silent, { idleMs: 200 }), 200);
});

test('(b) keep-alive comments are not progress: a stream of nothing but comments still stalls', async () => {
  // Before the fix every comment restarted the timer, so this never ended and the spend entry stayed open.
  assertStalled(await streamOnce(BEHAVIOURS.keepAlive, { idleMs: 200 }), 200);
});

test('(c) reasoning and then silence: the reasoning streams, then the stream stalls', async () => {
  const result = await streamOnce(BEHAVIOURS.reasoningThenSilence, { idleMs: 200 });
  assertStalled(result, 200);
  assert.deepEqual(result.events.map((event) => event.type === 'reasoning' ? event.text : event.type), ['Let me look at ', 'the failing test.']);
});

test('(d) a stream that ends without [DONE] or a finish_reason is cut off, not an empty answer', async () => {
  // The 0.4.4 symptom: this resolved as { content: null, finishReason: 'stop' } and the run "completed".
  const result = await streamOnce(BEHAVIOURS.closedEarly);
  assert.ok(result.error instanceof StreamInterruptedError, `expected an interruption, got ${String(result.error)} with ${JSON.stringify(result.events)}`);
  assert.equal(result.error.kind, 'closed');
  assert.equal(result.error.retryable, true);
  assert.equal(result.error.requestId, result.rids[0]);
  assert.match(result.error.message, /closed the stream before the reply finished/);
  assert.equal(result.events.length, 0);
  assert.deepEqual(result.entries.map((entry) => [entry.end?.status, entry.end?.requestId]), [['partial', result.rids[0]]], 'never recorded as completed');

  const empty = await streamOnce(BEHAVIOURS.doneWithNothing);
  assert.ok(empty.error instanceof StreamInterruptedError && empty.error.kind === 'closed' && /without sending an answer/.test(empty.error.message), String(empty.error));
});

test('(e) reasoning that keeps streaming far past the idle limit is never cut off', async () => {
  const result = await streamOnce(longReasoning(800), { idleMs: 150 });
  assert.equal(result.error, undefined, String(result.error));
  assert.ok(result.elapsedMs >= 800, 'the reply took more than five idle limits');
  const done = result.events.at(-1);
  assert.equal(done?.type === 'done' && done.message.content, 'The answer.');
  assert.ok(result.events.filter((event) => event.type === 'reasoning').length > 10);
  assert.deepEqual(result.entries.map((entry) => [entry.end?.status, entry.end?.requestId, entry.end?.outputTokens]), [['completed', result.rids[0], 20]]);
});

test('a whole answer still ends normally, and a lingering connection after [DONE] does not hold the turn', async () => {
  const result = await streamOnce(BEHAVIOURS.answer);
  assert.equal(result.error, undefined, String(result.error));
  const done = result.events.at(-1);
  assert.deepEqual(done?.type === 'done' ? [done.message.content, done.finishReason] : [], ['All done.', 'stop']);
  const lingering = await streamOnce((res) => { res.write(delta({ content: 'Yes.' })); res.write(finish()); res.write('data: [DONE]\n\n'); /* never closes */ }, { idleMs: 5_000 });
  assert.equal(lingering.error, undefined, String(lingering.error));
  assert.ok(lingering.elapsedMs < 3_000, `the turn ended ${lingering.elapsedMs} ms after [DONE] instead of waiting out the idle limit`);
  assert.equal(lingering.entries[0].end?.status, 'completed');
});

test('an error event mid-stream is reported, not swallowed into an empty answer', async () => {
  const upstream = await streamOnce(BEHAVIOURS.midStreamError);
  assert.ok(upstream.error instanceof StreamInterruptedError, String(upstream.error));
  assert.equal(upstream.error.kind, 'error');
  assert.equal(upstream.error.retryable, true);
  assert.match(upstream.error.message, /reported an error mid-response: upstream timed out/);
  assert.equal(upstream.entries[0].end?.status, 'partial');
  const crashed = await streamOnce(BEHAVIOURS.finishError);
  assert.ok(crashed.error instanceof StreamInterruptedError && crashed.error.kind === 'error' && /provider crashed/.test(crashed.error.message), String(crashed.error));
  // A client error NEAR only found mid-stream is not retried: the same request would fail again.
  const bad = await streamOnce(BEHAVIOURS.midStreamBadRequest);
  assert.ok(bad.error instanceof NearAiError && !(bad.error instanceof StreamInterruptedError), String(bad.error));
  assert.equal(bad.error.status, 400);
  assert.equal(bad.error.retryable, false);
});

test('stop lands at once while no byte is arriving, closes the connection, and records the request as aborted', async () => {
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100);
  const result = await streamOnce(BEHAVIOURS.silent, { idleMs: 10_000, signal: stop.signal });
  assert.ok(result.error instanceof DOMException && result.error.name === 'AbortError', String(result.error));
  assert.ok(result.elapsedMs < 1_000, `stop took ${result.elapsedMs} ms (before the fix it waited for the idle limit or the next chunk)`);
  assert.ok(result.closedByClient);
  assert.deepEqual(result.entries.map((entry) => [entry.end?.status, entry.end?.requestId]), [['aborted', result.rids[0]]]);
});

test('a reply that keeps streaming past the per-turn cap is stopped, and not retried', async () => {
  const result = await streamOnce(longReasoning(5_000), { idleMs: 1_000, turnMs: 300 });
  assert.ok(result.error instanceof StreamInterruptedError, String(result.error));
  assert.equal(result.error.kind, 'turn-limit');
  assert.equal(result.error.retryable, false);
  assert.match(result.error.message, /moonshotai\/kimi-k3's reply was still streaming after 1 minute, the most one model turn may take/);
  assert.ok(result.elapsedMs >= 280 && result.elapsedMs < 1_500, `capped after ${result.elapsedMs} ms`);
  assert.ok(result.closedByClient);
  assert.equal(result.entries[0].end?.status, 'partial');
});

async function runLoop(plan: Behaviour[], options: { idleMs?: number; stallRetries?: number } = {}) {
  const near = await fakeNear(plan);
  const spend = ledger();
  const client = new NearAiClient({ baseUrl: near.base, apiKey: 'k', maxRetries: 0, streamIdleTimeoutMs: options.idleMs ?? 100, spend: spend.sink });
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-stall-'));
  const events: AgentEvent[] = [];
  const shell = new ShellSession(root);
  const run = new AgentRun({
    client, model: MODEL, tools: [], retryDelaysMs: [5, 10, 20], random: () => 0.5, ...(options.stallRetries !== undefined ? { stallRetries: options.stallRetries } : {}),
    context: { root, checkpoints: new RunCheckpoints('stall'), shell, readFiles: new Set() }, policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES,
    requestApproval: async () => ({ decision: 'allow' }), emit: (event) => events.push(event)
  });
  const outcome = await run.run([{ role: 'user', content: 'fix the test' }], new AbortController().signal).catch((error: unknown) => error);
  shell.dispose();
  await near.close();
  return { outcome, events, entries: spend.entries, near };
}

const retriesOf = (events: AgentEvent[]) => events.filter((event): event is Extract<AgentEvent, { type: 'retry' }> => event.type === 'retry');

test('a stream that keeps closing early is retried with backoff, then the run stops with a clear message', async () => {
  const { outcome, events, entries, near } = await runLoop([BEHAVIOURS.closedEarly]);
  assert.ok(outcome instanceof AgentRunError, String(outcome));
  assert.ok(outcome.cause instanceof ModelStalledError);
  assert.equal(outcome.message, `moonshotai/kimi-k3 stopped responding (the stream closed before the reply finished) — retried ${STALL_RETRIES} times; your work is kept: resend your message to continue, switch to another model, or stop. Request ID: inf-${STALL_RETRIES + 1}.`);
  assert.equal(near.requests, STALL_RETRIES + 1);
  assert.deepEqual(retriesOf(events).map((event) => [event.delayMs, event.stall]), [[5, { retry: 1, of: 3 }], [10, { retry: 2, of: 3 }], [20, { retry: 3, of: 3 }]], 'the existing backoff, with the stall count');
  assert.match(retryNotice(retriesOf(events)[0]), /closed the stream before the reply finished\. Retrying in 0 s \(attempt 2, retry 1 of 3 before the run stops\)/);
  assert.deepEqual(outcome.messages.map((message) => message.role), ['user'], 'the transcript (the work so far) is handed back');
  assert.deepEqual(entries.map((entry) => [entry.end?.status, entry.end?.requestId]), near.rids.map((rid) => ['partial', rid]), 'every attempt is closed as partial with its own inference-id');
});

test('keep-alive stalls double the idle limit from the one the client used, then give up with "no data for N s"', async () => {
  const { outcome, events, near } = await runLoop([BEHAVIOURS.keepAlive], { idleMs: 100, stallRetries: 2 });
  assert.ok(outcome instanceof AgentRunError && outcome.cause instanceof ModelStalledError, String(outcome));
  assert.match(outcome.message, /^moonshotai\/kimi-k3 stopped responding \(no data for 0\.4 s\) — retried 2 times; your work is kept: resend your message to continue, switch to another model, or stop\./);
  assert.deepEqual(retriesOf(events).map((event) => /no data for ([\d.]+) seconds/.exec(event.reason)?.[1]), ['0.1', '0.2']);
  assert.equal(near.requests, 3);
});

test('a turn that stalls and then answers finishes the run as usual', async () => {
  const { outcome, events, entries } = await runLoop([BEHAVIOURS.reasoningThenSilence, BEHAVIOURS.closedEarly, BEHAVIOURS.answer]);
  assert.ok(!(outcome instanceof Error), String(outcome));
  const result = outcome as Awaited<ReturnType<AgentRun['run']>>;
  assert.equal(result.outcome, 'completed');
  assert.equal(result.messages.at(-1)?.content, 'All done.');
  assert.equal(retriesOf(events).length, 2);
  assert.deepEqual(entries.map((entry) => entry.end?.status), ['partial', 'partial', 'completed']);
});

test('after the retries run out the chat says so, Agent Activity shows the run failed, and the spend is reconciled', async () => {
  const loop = require('../agent/loop') as typeof import('../agent/loop');
  const delays = [...loop.RETRY_DELAYS_MS];
  loop.RETRY_DELAYS_MS.splice(0, delays.length, ...delays.map(() => 5));
  const near = await fakeNear([BEHAVIOURS.closedEarly]);
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-stall-session-'));
  const account = new SpendAccount('key-stall', { dir: path.join(root, '.global'), timers: false });
  await account.ready;
  const client = new NearAiClient({ baseUrl: near.base, apiKey: 'k', maxRetries: 0, streamIdleTimeoutMs: 200, spend: account });
  const feed = new ActivityFeed({ maxAgeMs: 60 * 60_000, maxBytes: 8 * 1024 * 1024 });
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'), undefined, undefined, feed);
  let error: unknown;
  try {
    await conversation.send({ text: 'Fix the failing test', client: client as never, model: MODEL, privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES });
  } catch (caught) {
    error = caught;
  } finally {
    conversation.dispose();
    loop.RETRY_DELAYS_MS.splice(0, delays.length, ...delays);
  }
  assert.ok(error instanceof ModelStalledError, String(error));
  // What the chat shows (chat.ts posts providerErrorMessage as an assistant-error).
  assert.equal(providerErrorMessage(error), `moonshotai/kimi-k3 stopped responding (the stream closed before the reply finished) — retried 3 times; your work is kept: resend your message to continue, switch to another model, or stop. Request ID: inf-4.`);
  assert.equal(posted.filter((message) => message.type === 'assistant-retry').length, 3, 'each retry was announced while it happened');
  assert.equal(posted.some((message) => message.type === 'assistant-done'), false, 'the run never claims to have finished');
  // Agent Activity: failed with the reason, never left running.
  const main = feed.agentStats().find((stat) => stat.agentId.startsWith('main-'))!;
  assert.equal(main.status, 'failed');
  assert.equal(main.retries, 3);
  const ended = feed.subscribe(() => undefined).snapshot.find((entry) => entry.kind === 'agent-end');
  assert.equal(ended?.title, 'agent failed');
  assert.equal(ended?.text, providerErrorMessage(error));
  // The ledger: every attempt closed as partial with its inference-id, and NEAR's figure settles them.
  assert.ok(await eventually(() => account.ledger.list({}).every((entry) => entry.actualNanoUsd !== undefined), 2_000), 'the stopped run was reconciled');
  const entries = account.ledger.list({});
  assert.deepEqual(entries.map((entry) => [entry.status, entry.requestId, entry.actualNanoUsd]), near.rids.map((rid) => ['partial', rid, 1_000_000]));
  assert.ok(near.rids.every((rid) => near.billed.includes(rid)));
  account.reconciler.stop();
  account.usage.stop();
  await account.ledger.flush();
  await near.close();
});
