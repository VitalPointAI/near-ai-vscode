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

test('stream events carry usage and the inference-id billing ID, request streamed usage, and never claim TEE verification from headers', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"hi"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  let body: Record<string, unknown> = {};
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'secret', fetchFn: async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(stream, { status: 200, headers: { 'inference-id': '6f1c9a52-1111-5a3b-9c1d-2e4f6a8b0c1d', 'x-request-id': 'transport-only', 'x-near-tee-verified': 'true' } });
  } });
  const events = [];
  for await (const event of client.streamChatEvents('model-a', [{ role: 'user', content: 'hello' }])) events.push(event);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(events.map((event) => event.type), ['status', 'text', 'text', 'status', 'done']);
  assert.equal(events[1].type === 'text' && events[1].metadata?.requestId, '6f1c9a52-1111-5a3b-9c1d-2e4f6a8b0c1d');
  assert.equal(events[2].type === 'text' && events[2].metadata?.inputTokens, 3);
  assert.equal(events[3].type === 'status' && events[3].status, 'completed');
  assert.equal(events[3].type === 'status' && events[3].metadata.verificationStatus, 'unknown');
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

test('actual cost comes from POST /billing/costs keyed by inference-id, converted from nano-USD', async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const client = new NearAiClient({
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret',
    fetchFn: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ requests: [{ requestId: 'req-1', costNanoUsd: 34_000_000 }] }), { status: 200 });
    }
  });
  const usage = await client.reconcileUsage('req-1', undefined, [0]);
  assert.deepEqual(requests, [{ url: 'https://example.test/v1/billing/costs', body: { requestIds: ['req-1'] } }]);
  assert.equal(usage.actualCostUsd, 0.034);
  assert.equal(usage.estimatedCostUsd, undefined);
});

test('an unrecorded request stays without an actual cost instead of reporting $0', async () => {
  let calls = 0;
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'secret', fetchFn: async () => {
    calls += 1;
    return new Response(JSON.stringify({ requests: [{ requestId: 'req-2', costNanoUsd: 0 }], warning: 'No usage record matched.' }), { status: 200 });
  } });
  const usage = await client.reconcileUsage('req-2', undefined, [0, 1, 1]);
  assert.equal(calls, 3);
  assert.equal(usage.actualCostUsd, undefined);
});

test('a momentary gateway failure gets one quick retry, and cancellation stops retries', async () => {
  let attempts = 0;
  const client = new NearAiClient({
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret',
    maxRetries: 2,
    retryBaseDelayMs: 0,
    fetchFn: async (url) => {
      if (String(url).endsWith('/model/list')) return new Response(JSON.stringify({ models: [] }), { status: 200 });
      attempts += 1;
      return attempts < 2 ? new Response('', { status: 502 }) : new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
  });
  assert.deepEqual(await client.listModels(), []);
  assert.equal(attempts, 2, 'one quick retry (maxRetries is capped at 1)');

  let stuck = 0;
  const twice = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'secret', maxRetries: 3, retryBaseDelayMs: 0, fetchFn: async () => { stuck += 1; return new Response('', { status: 502 }); } });
  await assert.rejects(() => twice.listModels(), (error: NearAiError) => error.status === 502 && error.retryable);
  assert.equal(stuck, 2, 'never more than one quick retry');

  const controller = new AbortController();
  let cancelledAttempts = 0;
  const cancelled = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'secret', retryBaseDelayMs: 25, fetchFn: async (url) => {
    if (String(url).endsWith('/model/list')) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    cancelledAttempts += 1;
    controller.abort();
    return new Response('', { status: 502 });
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

test('model list falls back to /models when the pricing endpoint is unavailable', async () => {
  const seen: string[] = [];
  const client = new NearAiClient({
    baseUrl: 'https://example.test/v1', apiKey: 'secret', maxRetries: 0,
    fetchFn: async (url) => {
      seen.push(String(url));
      if (String(url).endsWith('/models/pricing')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-ai/DeepSeek-V3', pricing: { input: 0.27, output: 1.1 } }] }), { status: 200 });
    }
  });
  const models = await client.listModelsWithPricing();
  assert.deepEqual(seen, ['https://example.test/v1/models/pricing', 'https://example.test/v1/models', 'https://example.test/v1/model/list']);
  assert.equal(models[0]?.id, 'deepseek-ai/DeepSeek-V3');
  assert.equal(models[0]?.inputPricePerMillion, 0.27);
});

test('model privacy comes from /model/list: attested NEAR models are TEE, external ones are forwarded', async () => {
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'secret', fetchFn: async (url) => String(url).endsWith('/model/list')
    ? new Response(JSON.stringify({ models: [
      { modelId: 'z-ai/glm-5.3', metadata: { attestationSupported: true, verifiable: true, providerType: 'tinfoil' } },
      { modelId: 'deepseek/deepseek-v4.1-flash', metadata: { attestationSupported: false, providerType: 'external', providerConfig: { backend: 'openai_compatible', base_url: 'https://openrouter.ai/api/v1', api_key: '***' } } },
      { modelId: 'anthropic/claude-sonnet-5-5', metadata: { attestationSupported: false, providerType: 'external', providerConfig: { backend: 'anthropic', base_url: 'https://api.anthropic.com/v1' } } }
    ] }), { status: 200 })
    : new Response(JSON.stringify({ data: [{ id: 'z-ai/glm-5.3' }, { id: 'deepseek/deepseek-v4.1-flash' }, { id: 'anthropic/claude-sonnet-5-5' }, { id: 'unlisted/model' }] }), { status: 200 }) });
  const models = await client.listModels();
  assert.deepEqual(models.map((model) => [model.id, model.privacyBoundary, model.forwardedTo]), [
    ['z-ai/glm-5.3', 'tee', undefined],
    ['deepseek/deepseek-v4.1-flash', 'cloud', 'openrouter.ai'],
    ['anthropic/claude-sonnet-5-5', 'cloud', 'anthropic.com'],
    ['unlisted/model', undefined, undefined]
  ]);
  assert.doesNotMatch(JSON.stringify(models), /\*\*\*|api_key/);
});
