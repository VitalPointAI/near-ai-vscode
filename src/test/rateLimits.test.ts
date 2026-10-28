import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentEvent, AgentRun, AgentRunError, AgentRunOptions, ModelUnavailableError, RETRY_GIVE_UP_MS } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { providerErrorMessage } from '../services/chatBridge';
import { deriveProfileId } from '../domain/auth';
import { AuthService, SecretStorageLike } from '../services/auth';
import { activeProvider, clearProviderCache } from '../services/providerCache';
import { ProfileStore } from '../services/profileStore';
import { CompletionEvent, MAX_RETRY_AFTER_MS, NearAiClient, NearAiError, parseRetryAfter, setNearAiDiagnostics } from '../services/nearAiClient';

// The 429/5xx retry storm (debug session near-429-storm): one retry layer that honours Retry-After
// with jitter, a per-model cooldown shared by every caller of a client, a bounded number of minutes
// of retrying, and NEAR's own error text and request ID surfaced instead of discarded.

const BASE = 'https://example.test/v1';
const usage = { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown' as const, latencyMs: 1 };
const sseBody = (text: string) => [`data: ${JSON.stringify({ id: 'chat-1', choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}`, 'data: [DONE]', ''].join('\n\n');
const tooMany = (headers: Record<string, string> = {}, body = '{"error":{"message":"Rate limit exceeded","type":"rate_limit_exceeded"}}') => new Response(body, { status: 429, headers: { 'content-type': 'application/json', ...headers } });

async function drain(stream: AsyncGenerator<CompletionEvent>): Promise<void> {
  for await (const _event of stream) { /* read to the end */ }
}

/** An AgentRun with no tools around `client`; extra options (clock, sleep, RNG, ladder) override the defaults. */
async function agentRun(client: AgentRunOptions['client'], extra: Partial<AgentRunOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-rate-'));
  const shell = new ShellSession(root);
  const events: AgentEvent[] = [];
  const run = new AgentRun({
    client, model: 'z-ai/glm-5.3', tools: [],
    context: { root, checkpoints: new RunCheckpoints('rate'), shell, readFiles: new Set() },
    policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES,
    requestApproval: async () => ({ decision: 'allow' }), emit: (event) => events.push(event),
    ...extra
  });
  return { run, events, dispose: () => shell.dispose() };
}

/** A model client whose first `failures` turns throw the given errors, then answers. */
function scriptedModel(failures: Error[]) {
  let turn = 0;
  return {
    calls: () => turn,
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      const failure = failures[turn++];
      if (failure) throw failure;
      yield { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage };
    }
  };
}

const retries = (events: AgentEvent[]) => events.filter((event): event is Extract<AgentEvent, { type: 'retry' }> => event.type === 'retry');

test('Retry-After is read as delta-seconds or an HTTP-date, capped, and garbage is ignored', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  assert.equal(parseRetryAfter('5', now), 5_000);
  assert.equal(parseRetryAfter(' 0 ', now), 0);
  assert.equal(parseRetryAfter('1.5', now), 1_500);
  assert.equal(parseRetryAfter('Wed, 28 Oct 2026 12:00:12 GMT', now), 12_000);
  assert.equal(parseRetryAfter('Wed, 28 Oct 2026 11:59:00 GMT', now), 0, 'a date in the past means now');
  assert.equal(parseRetryAfter('3600', now), MAX_RETRY_AFTER_MS, 'capped at 60 s');
  assert.equal(parseRetryAfter('Fri, 30 Oct 2026 12:00:00 GMT', now), MAX_RETRY_AFTER_MS);
  for (const garbage of ['soon', '-5', '5s', '', undefined, null, 'NaN']) assert.equal(parseRetryAfter(garbage as string, now), undefined, String(garbage));
  assert.equal(parseRetryAfter('250', now, 'ms'), 250, 'retry-after-ms');
});

test('a 429 or 503 is never retried inside the client; Retry-After rides on the error', async () => {
  for (const status of [429, 503]) {
    let fetches = 0;
    const client = new NearAiClient({ baseUrl: BASE, apiKey: 'k', maxRetries: 3, retryBaseDelayMs: 0, fetchFn: (async () => { fetches += 1; return new Response('', { status, headers: { 'retry-after': '7' } }); }) as typeof fetch });
    await assert.rejects(() => drain(client.streamCompletion('m', [{ role: 'user', content: 'hi' }], [])), (error: NearAiError) => error.status === status && error.retryable && error.retryAfterMs === 7_000);
    assert.equal(fetches, 1, `HTTP ${status}: exactly one request`);
  }
});

test('NEAR\'s error message, type, and request ID reach the error and the user, with secrets removed', async () => {
  const lines: string[] = [];
  setNearAiDiagnostics((line) => lines.push(line));
  let served: Response | undefined;
  try {
    const client = new NearAiClient({
      baseUrl: BASE, apiKey: 'sk-live-0123456789', fetchFn: (async () => (served = tooMany(
        { 'x-request-id': 'xr-42', 'retry-after': '3', 'x-ratelimit-remaining-requests': '0' },
        JSON.stringify({ error: { message: 'Too many concurrent requests for sk-live-0123456789 (Bearer abc.def)', type: 'rate_limit_exceeded', code: 'org_model_concurrency' } })
      ))) as typeof fetch
    });
    const error = await drain(client.streamCompletion('z-ai/glm-5.3', [{ role: 'user', content: 'hi' }], [])).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof NearAiError);
    assert.equal(error.requestId, 'xr-42', 'x-request-id when there is no inference-id');
    assert.equal(error.errorType, 'rate_limit_exceeded');
    assert.equal(error.errorCode, 'org_model_concurrency');
    assert.equal(error.model, 'z-ai/glm-5.3');
    assert.match(error.message, /HTTP 429 for z-ai\/glm-5\.3: Too many concurrent requests/);
    assert.match(error.message, /rate_limit_exceeded, org_model_concurrency/);
    const shown = providerErrorMessage(error);
    assert.match(shown, /NEAR says: Too many concurrent requests/);
    assert.match(shown, /Request ID: xr-42/);
    assert.match(shown, /switch to another model/);
    for (const text of [error.message, error.detail ?? '', shown, ...lines]) {
      assert.doesNotMatch(text, /sk-live-0123456789/);
      assert.doesNotMatch(text, /abc\.def/);
    }
    assert.equal(served?.bodyUsed, true, 'the error body is consumed, not left open');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /HTTP 429 POST \/chat\/completions model=z-ai\/glm-5\.3 request=xr-42/);
    assert.match(lines[0], /retry-after=3/);
    assert.match(lines[0], /x-ratelimit-remaining-requests=0/);
    assert.match(lines[0], /cooldown=3s/);

    const both = new NearAiClient({ baseUrl: BASE, apiKey: 'k', fetchFn: (async () => new Response('upstream busy', { status: 400, headers: { 'inference-id': 'inf-1', 'x-request-id': 'xr-1' } })) as typeof fetch });
    await assert.rejects(() => both.listModels(), (caught: NearAiError) => caught.requestId === 'inf-1' && /HTTP 400: upstream busy\./.test(caught.message));
  } finally {
    setNearAiDiagnostics(undefined);
  }
});

test('the turn retry waits at least Retry-After, on the ladder, jittered by the injected RNG', async () => {
  const limited = (retryAfterMs?: number) => new NearAiError(429, 'NEAR AI request failed with HTTP 429.', true, undefined, retryAfterMs === undefined ? {} : { retryAfterMs });
  const model = scriptedModel([limited(10_000), limited(10_000), limited(), new NearAiError(502, 'bad gateway', true)]);
  const draws = [0, 0.99, 0.5, 0.25];
  const slept: number[] = [];
  const { run, events, dispose } = await agentRun(model, { retryDelaysMs: [2_000, 5_000, 15_000], random: () => draws.shift() ?? 0.5, sleep: async (ms) => { slept.push(ms); } });
  try {
    const result = await run.run([{ role: 'user', content: 'go' }], new AbortController().signal);
    assert.equal(result.outcome, 'completed');
    // max(Retry-After, step) × (0.5 + random): 10 000 × 0.5, 10 000 × 1.49, 15 000 × 1.0, 15 000 × 0.75.
    assert.deepEqual(slept, [5_000, 14_900, 15_000, 11_250]);
    assert.deepEqual(retries(events).map((event) => event.delayMs), slept, 'the notice shows the real wait');
  } finally { dispose(); }
});

test('after RETRY_GIVE_UP_MS of continuous 429s a turn stops with a clear message (fake clock)', async () => {
  let now = 0;
  let calls = 0;
  const client = {
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      calls += 1;
      now += 50;
      throw new NearAiError(429, 'NEAR AI request failed with HTTP 429 for z-ai/glm-5.3: Rate limit exceeded.', true, `xr-${calls}`, { retryAfterMs: 5_000 });
    }
  };
  const { run, dispose } = await agentRun(client, { now: () => now, random: () => 0.5, sleep: async (ms) => { now += ms; } });
  try {
    const error = await run.run([{ role: 'user', content: 'go' }], new AbortController().signal).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof AgentRunError);
    const cause = error.cause;
    assert.ok(cause instanceof ModelUnavailableError, String(cause));
    assert.equal(cause.retryable, false);
    assert.ok(cause.elapsedMs >= RETRY_GIVE_UP_MS && cause.elapsedMs <= RETRY_GIVE_UP_MS + 1_000, `stopped at ${cause.elapsedMs} ms`);
    assert.ok(now <= RETRY_GIVE_UP_MS + 1_000, 'no wait runs past the limit');
    assert.equal(cause.attempts, calls);
    // Ladder 2, 5, 15, 30, 60, 60 … s: about 8 requests in 4 minutes, not hundreds.
    assert.ok(calls >= 6 && calls <= 10, `${calls} requests`);
    const shown = providerErrorMessage(cause);
    assert.match(shown, /kept rate limiting z-ai\/glm-5\.3 for about 4 minutes/);
    assert.match(shown, /wait a few minutes and send a message to continue, switch to another model, or leave it stopped/);
    assert.match(shown, /Rate limit exceeded/);
    assert.match(shown, new RegExp(`Request ID: xr-${calls}`));
  } finally { dispose(); }

  // A stall in between is a different failure: it resets the count, so a run that is slowly recovering is not cut off.
  now = 0;
  const failures: Error[] = [];
  for (let index = 0; index < 10; index += 1) failures.push(index === 6 ? Object.assign(new Error('stalled'), { retryable: true, stalled: true }) : new NearAiError(503, 'busy', true));
  const recovering = await agentRun(scriptedModel(failures), { now: () => now, random: () => 0.5, sleep: async (ms) => { now += ms; } });
  try {
    assert.equal((await recovering.run.run([{ role: 'user', content: 'go' }], new AbortController().signal)).outcome, 'completed');
  } finally { recovering.dispose(); }
});

test('stopping a run cancels a retry wait at once', async () => {
  const { run, dispose } = await agentRun(scriptedModel([new NearAiError(429, 'limited', true, undefined, { retryAfterMs: 60_000 })]), { retryDelaysMs: [60_000] });
  try {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    const result = await run.run([{ role: 'user', content: 'go' }], controller.signal);
    assert.equal(result.outcome, 'cancelled');
    assert.ok(Date.now() - started < 2_000, 'the 60 s wait did not run');
  } finally { dispose(); }
});

test('stopping cancels a wait for a model\'s cooldown, and nothing is sent', async () => {
  let fetches = 0;
  const client = new NearAiClient({ baseUrl: BASE, apiKey: 'k', fetchFn: (async () => { fetches += 1; return tooMany({ 'retry-after': '60' }); }) as typeof fetch });
  await assert.rejects(() => drain(client.streamCompletion('m', [{ role: 'user', content: 'a' }], [])));
  assert.ok(client.cooldownRemainingMs('m') > 55_000);
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(() => drain(client.streamCompletion('m', [{ role: 'user', content: 'b' }], [], controller.signal)), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.ok(Date.now() - started < 2_000);
  assert.equal(fetches, 1);
});

test('the auto mode\'s safety check shares the cooldown: one request on a 429, none while the model cools', async () => {
  let now = 1_000;
  const sent: string[] = [];
  let healthy = false;
  const client = new NearAiClient({
    baseUrl: BASE, apiKey: 'k', maxRetries: 1, retryBaseDelayMs: 0, now: () => now,
    fetchFn: (async (_url: string, init?: RequestInit) => {
      sent.push(String(JSON.parse(String(init?.body)).model));
      if (healthy) return new Response(JSON.stringify({ choices: [{ message: { content: '{"allow":true,"reason":"ok"}' } }] }), { status: 200 });
      return tooMany();
    }) as typeof fetch
  });
  const ask = (model: string) => client.completeOnce(model, [{ role: 'user', content: 'npm ci' }], { maxTokens: 50 });
  await assert.rejects(() => ask('safe-model'), (error: NearAiError) => error.status === 429 && !error.cooling);
  assert.deepEqual(sent, ['safe-model'], 'exactly one request on a 429');
  await assert.rejects(() => ask('safe-model'), (error: NearAiError) => error.status === 429 && error.cooling === true);
  assert.deepEqual(sent, ['safe-model'], 'nothing sent while the model cools');
  // An agent's 429 on its model holds the safety check for that model too, and only that model.
  await assert.rejects(() => drain(client.streamCompletion('agent-model', [{ role: 'user', content: 'x' }], [])));
  await assert.rejects(() => ask('agent-model'), (error: NearAiError) => error.cooling === true);
  assert.deepEqual(sent, ['safe-model', 'agent-model']);
  now += 6_000;
  healthy = true;
  assert.match((await ask('safe-model')).text, /allow/);
  assert.equal(client.cooldownRemainingMs('safe-model'), 0, 'a success ends the cooldown');
});

test('four parallel sub-agents on one client send one probe per cooldown, not a synchronized burst (probe run D)', async () => {
  const model = 'Qwen/Qwen3.6-35B-A3B-FP8';
  const started = Date.now();
  const windowMs = 700;
  const requests: Array<{ start: number; end: number; status: number }> = [];
  let inFlight = 0;
  const client = new NearAiClient({
    baseUrl: BASE, apiKey: 'k', cooldownBaseMs: 100,
    fetchFn: (async () => {
      const record = { start: Date.now() - started, end: 0, status: 0 };
      requests.push(record);
      inFlight += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        record.status = record.start < windowMs ? 429 : 200;
        return record.status === 429 ? tooMany() : new Response(sseBody('report'));
      } finally {
        inFlight -= 1;
        record.end = Date.now() - started;
      }
    }) as typeof fetch
  });
  const agents = await Promise.all([0, 1, 2, 3].map(() => agentRun(client, { model, retryDelaysMs: [50, 100], random: () => 0.5 })));
  try {
    const results = await Promise.all(agents.map((agent) => agent.run.run([{ role: 'user', content: 'research' }], new AbortController().signal)));
    assert.deepEqual(results.map((result) => result.outcome), ['completed', 'completed', 'completed', 'completed']);
  } finally { for (const agent of agents) agent.dispose(); }
  const refused = requests.filter((request) => request.status === 429);
  const firstAnswer = Math.min(...refused.map((request) => request.end));
  const afterFirst = requests.filter((request) => request.start >= firstAnswer).sort((a, b) => a.start - b.start);
  // Once NEAR has said 429, requests to the model go out one at a time: each starts after the previous one ended.
  for (let index = 1; index < afterFirst.length; index += 1) {
    const [before, after] = [afterFirst[index - 1], afterFirst[index]];
    if (before.status === 429) assert.ok(after.start >= before.end, `request at ${after.start} ms overlapped the probe at ${before.start}–${before.end} ms`);
  }
  // Old behaviour: 4 agents × 3 HTTP attempts per loop attempt, every cycle (36 × 429 over a 10 s outage).
  assert.ok(refused.length <= 4 + 5, `${refused.length} × 429 in a ${windowMs} ms outage`);
  assert.equal(requests.filter((request) => request.status === 200).length, 4, 'each agent sends its turn once NEAR recovers');
  assert.equal(inFlight, 0);
});

test('the catalog keeps serving the last good list when a refresh fails, and /models/pricing is not asked again once absent', async () => {
  const seen: string[] = [];
  let failing = false;
  const client = new NearAiClient({
    baseUrl: BASE, apiKey: 'k', fetchFn: (async (url: string) => {
      seen.push(String(url).replace(BASE, ''));
      if (failing) return tooMany();
      if (String(url).endsWith('/models/pricing')) return new Response('{}', { status: 404 });
      if (String(url).endsWith('/model/list')) return new Response(JSON.stringify({ models: [] }));
      return new Response(JSON.stringify({ data: [{ id: 'm1' }] }));
    }) as typeof fetch
  });
  assert.deepEqual((await client.listModelsWithPricing()).map((model) => model.id), ['m1']);
  assert.deepEqual(seen.splice(0), ['/models/pricing', '/models', '/model/list']);
  await client.listModelsWithPricing();
  assert.deepEqual(seen.splice(0), ['/models', '/model/list'], 'the missing pricing endpoint is remembered');
  failing = true;
  await assert.rejects(() => client.listModelsWithPricing(), (error: NearAiError) => error.status === 429);
  assert.deepEqual(seen.splice(0), ['/models'], 'one request, no fast retries');
});

class MemorySecrets implements SecretStorageLike {
  private readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

test('the provider cache serves the last good catalog when a refresh fails, and drops only a failed first load', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-catalog-'));
  const auth = new AuthService(new MemorySecrets());
  const profiles = new ProfileStore(root, auth, { validator: async () => undefined });
  await profiles.configure({ profileId: deriveProfileId(root, 'Demo'), displayName: 'Demo', organization: 'Demo', baseUrl: 'https://cloud-api.near.ai/v1', authMode: 'apiKey' }, 'sk-test-key');
  const original = globalThis.fetch;
  let failing = true;
  let fetches = 0;
  globalThis.fetch = (async (url: string) => {
    fetches += 1;
    if (failing) return tooMany();
    if (String(url).endsWith('/models/pricing')) return new Response('{}', { status: 404 });
    if (String(url).endsWith('/model/list')) return new Response(JSON.stringify({ models: [] }));
    return new Response(JSON.stringify({ data: [{ id: 'z-ai/glm-5.3' }] }));
  }) as typeof fetch;
  let now = 1_000_000;
  const load = () => activeProvider(root, auth, { now: () => now });
  try {
    clearProviderCache();
    await assert.rejects(load, (error: NearAiError) => error.status === 429, 'a failed first load fails');
    failing = false;
    assert.deepEqual((await load())?.models.map((model) => model.id), ['z-ai/glm-5.3'], 'and the next call tries again');
    failing = true;
    now += 11 * 60_000;
    fetches = 0;
    assert.deepEqual((await load())?.models.map((model) => model.id), ['z-ai/glm-5.3'], 'a failed refresh keeps the cached catalog');
    assert.equal(fetches, 1, 'one request for the refresh: no fast retries, no pricing endpoint');
    await new Promise((resolve) => setImmediate(resolve));
    now += 30_000;
    await load();
    assert.equal(fetches, 1, 'not retried right away');
    now += 31_000;
    failing = false;
    assert.deepEqual((await load())?.models.map((model) => model.id), ['z-ai/glm-5.3']);
    assert.equal(fetches, 3, 'tried again a minute after the failure');
  } finally {
    globalThis.fetch = original;
    clearProviderCache();
  }
});
