import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRetryableFailure, estimateCostUsd, NearAiClient, NearAiError } from '../services/nearAiClient';

test('model catalog normalizes provider metadata', async () => {
  const client = new NearAiClient({
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret',
    fetchFn: async (url) => {
      assert.equal(url, 'https://example.test/v1/models/pricing');
      return new Response(JSON.stringify({ data: [{ model: 'qwen', context_length: 32000, pricing: { input_per_million: 0.2, output_per_million: 0.8 } }] }), { status: 200 });
    }
  });
  assert.deepEqual(await client.listModelsWithPricing(), [{ id: 'qwen', contextLength: 32000, inputPricePerMillion: 0.2, outputPricePerMillion: 0.8, supportsReasoning: false }]);
});

test('streaming chat emits ordered deltas and final usage', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'));
      controller.close();
    }
  });
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'secret', fetchFn: async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer secret');
    return new Response(stream, { status: 200 });
  } });
  const deltas = [];
  for await (const delta of client.streamChat('qwen', [{ role: 'user', content: 'hi' }])) deltas.push(delta);
  assert.deepEqual(deltas.map((delta) => delta.text), ['hello', ' world', '']);
  assert.equal(deltas.at(-1)?.done, true);
});

test('transient errors are classified for retry', async () => {
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'secret', fetchFn: async () => new Response('', { status: 429 }) });
  await assert.rejects(() => client.listModels(), (error: NearAiError) => error.retryable && error.status === 429);
});

test('image generation adapters use only documented NEAR image endpoints and managed base64 output', async () => {
  const calls: string[] = [];
  const client = new NearAiClient({
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret',
    fetchFn: async (url, init) => {
      calls.push(`${url} ${(init?.method ?? 'GET')}`);
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer secret');
      return new Response(JSON.stringify({ request_id: 'image-req-1', usage: { actual_cost_usd: 0.5 }, data: [{ b64_json: Buffer.from([1, 2, 3]).toString('base64') }] }), { status: 200 });
    }
  });
  const generated = await client.generateImage('image-model', 'bounded prompt', { count: 1, size: '1024x1024' });
  assert.deepEqual([...generated.bytes ?? []], [1, 2, 3]);
  assert.equal(generated.usage?.actualCostUsd, 0.5);
  const edited = await client.editImage('image-model', 'bounded edit', new Uint8Array([4, 5]), { size: '1024x1024' });
  assert.deepEqual([...edited.bytes ?? []], [1, 2, 3]);
  assert.deepEqual(calls, ['https://example.test/v1/images/generations POST', 'https://example.test/v1/images/edits POST']);
});

test('image clients do not silently fetch or persist provider-hosted media URLs', async () => {
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'secret', fetchFn: async () => new Response(JSON.stringify({ data: [{ url: 'https://provider.example/generated.png' }] }), { status: 200 }) });
  const result = await client.generateImage('image-model', 'bounded prompt');
  assert.equal(result.remoteUrlPresent, true);
  assert.equal(result.bytes, undefined);
});

test('request construction keeps credentials out of errors and normalizes headers', async () => {
  const client = new NearAiClient({
    baseUrl: 'https://example.test/v1/',
    apiKey: 'super-secret',
    fetchFn: async (url, init) => {
      assert.equal(url, 'https://example.test/v1/models');
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer super-secret');
      return new Response(JSON.stringify({ data: [{ id: 'model-a', display_name: 'Model A', max_context_length: 8192, inputPricePerMillion: 1.2, outputPricePerMillion: 2.4 }] }), {
        status: 200,
        headers: { 'x-request-id': 'req-123', 'x-provider': 'near', 'x-verification-status': 'verified' }
      });
    }
  });
  assert.deepEqual(await client.listModels(), [{ id: 'model-a', name: 'Model A', contextLength: 8192, inputPricePerMillion: 1.2, outputPricePerMillion: 2.4, supportsReasoning: false }]);

  const failing = new NearAiClient({ baseUrl: 'https://example.test', apiKey: 'secret', fetchFn: async () => new Response('Bearer secret', { status: 401 }) });
  await assert.rejects(() => failing.listModels(), (error: NearAiError) => !error.message.includes('secret') && !error.message.includes('Bearer'));
});

test('stream events include ordered status, usage, request identity, and verification metadata', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"id":"stream-1","choices":[{"delta":{"content":"hi"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'secret', fetchFn: async () => new Response(stream, {
    status: 200,
    headers: { 'x-request-id': 'header-id', 'x-provider': 'near', 'x-near-tee-verified': 'true' }
  }) });
  const events = [];
  for await (const event of client.streamChatEvents('model-a', [{ role: 'user', content: 'hello' }])) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ['status', 'text', 'text', 'status', 'done']);
  assert.equal(events[1].type === 'text' && events[1].metadata?.requestId, 'stream-1');
  assert.equal(events[2].type === 'text' && events[2].metadata?.inputTokens, 3);
  assert.equal(events[3].type === 'status' && events[3].status, 'completed');
  assert.equal(events[3].type === 'status' && events[3].metadata.verificationStatus, 'verified');
});

test('cancellation ends a stream without a completion event', async () => {
  const controller = new AbortController();
  const stream = new ReadableStream({
    async pull(streamController) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (controller.signal.aborted) {
        streamController.close();
        return;
      }
      streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"part"}}]}\n\n'));
    }
  });
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'secret', fetchFn: async () => new Response(stream, { status: 200 }) });
  const events = [];
  for await (const event of client.streamChatEvents('model-a', [], controller.signal)) {
    events.push(event);
    controller.abort();
  }
  const last = events.at(-1);
  assert.equal(last?.type, 'status');
  if (last?.type === 'status') assert.equal(last.status, 'cancelled');
});

test('authentication, malformed request, policy, and cancellation failures are not retryable', () => {
  assert.equal(classifyRetryableFailure(401), false);
  assert.equal(classifyRetryableFailure(400), false);
  assert.equal(classifyRetryableFailure(403), false);
  assert.equal(classifyRetryableFailure(422), false);
  const controller = new AbortController();
  controller.abort();
  assert.equal(classifyRetryableFailure(503, controller.signal), false);
});

test('cost estimates use normalized per-million pricing and remain unavailable without both prices', () => {
  assert.equal(estimateCostUsd({ id: 'model-a', inputPricePerMillion: 1, outputPricePerMillion: 2 }, 10_000, 5_000), 0.02);
  assert.equal(estimateCostUsd({ id: 'model-a', inputPricePerMillion: 1 }, 10_000, 5_000), undefined);
});

test('provider reconciliation preserves actual cost separately from estimates', async () => {
  const client = new NearAiClient({
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret',
    fetchFn: async (url) => {
      assert.equal(url, 'https://example.test/v1/usage/req%2F1');
      return new Response(JSON.stringify({ data: { request_id: 'req/1', input_tokens: '12', output_tokens: 8, actual_cost_usd: '0.034', provider: 'near', verification_status: 'verified' } }), { status: 200, headers: { 'x-request-id': 'header-id' } });
    }
  });
  const usage = await client.reconcileUsage('req/1');
  assert.equal(usage.requestId, 'req/1');
  assert.equal(usage.inputTokens, 12);
  assert.equal(usage.outputTokens, 8);
  assert.equal(usage.actualCostUsd, 0.034);
  assert.equal(usage.estimatedCostUsd, undefined);
});

test('transient failures use bounded exponential retry and cancellation stops retries', async () => {
  let attempts = 0;
  const client = new NearAiClient({
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret',
    maxRetries: 2,
    retryBaseDelayMs: 0,
    fetchFn: async () => {
      attempts += 1;
      return attempts < 3 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
  });
  assert.deepEqual(await client.listModels(), []);
  assert.equal(attempts, 3);

  const controller = new AbortController();
  let cancelledAttempts = 0;
  const cancelled = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'secret', retryBaseDelayMs: 25, fetchFn: async () => {
    cancelledAttempts += 1;
    controller.abort();
    return new Response('', { status: 503 });
  } });
  await assert.rejects(() => cancelled.listModels(controller.signal), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(cancelledAttempts, 1);
});

test('api key is never sent to a plain-HTTP remote endpoint', async () => {
  let called = false;
  const client = new NearAiClient({ baseUrl: 'http://example.test/v1', apiKey: 'secret', fetchFn: async () => { called = true; return new Response('[]'); } });
  await assert.rejects(() => client.listModels(), /must use HTTPS/);
  assert.equal(called, false);
});

test('plain HTTP is allowed for a localhost runtime', async () => {
  const client = new NearAiClient({ baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'secret', fetchFn: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) });
  assert.deepEqual(await client.listModels(), []);
});

test('a provider that never responds times out instead of hanging', async () => {
  const client = new NearAiClient({
    baseUrl: 'https://example.test/v1', apiKey: 'secret', maxRetries: 0, responseTimeoutMs: 20,
    fetchFn: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  });
  await assert.rejects(() => client.listModels(), (error: unknown) => error instanceof NearAiError && error.status === 408 && error.retryable);
});
