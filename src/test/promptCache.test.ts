import assert from 'node:assert/strict';
import test from 'node:test';
import { trimOldToolResults } from '../agent/context';
import { CompletionEvent, estimateCostUsd, NearAiClient, normalizeModelInfo, type AgentMessage } from '../services/nearAiClient';

// NEAR caches prompt prefixes automatically and bills cached input at pricing.input_cache_read.
// Estimates (and the run budget) use those prices, and trimming keeps the prefix stable.

test('NEAR\'s /v1/models prices parse per million, including the cache-read price', () => {
  // The row NEAR AI Cloud returns for GLM 5.3 (2026-10-27).
  const model = normalizeModelInfo({ id: 'z-ai/glm-5.3', pricing: { input: 1.8, output: 5.75, prompt: '0.0000018', completion: '0.00000575', image: '0', request: '0', input_cache_read: '0.00000045' }, context_length: 1_048_576 });
  assert.deepEqual([model.inputPricePerMillion, model.outputPricePerMillion, model.cachePricePerMillion, model.contextLength], [1.8, 5.75, 0.45, 1_048_576]);
  const fresh = estimateCostUsd(model, 100_000, 1_000)!;
  const cached = estimateCostUsd(model, 100_000, 1_000, 80_000)!;
  assert.ok(Math.abs(fresh - 0.18575) < 1e-9, String(fresh));
  assert.ok(Math.abs(cached - 0.07775) < 1e-9, `80% cached costs ${cached}`);
  assert.equal(estimateCostUsd({ id: 'x', inputPricePerMillion: 1, outputPricePerMillion: 2 }, 1_000_000, 0, 500_000), 1, 'without a cache price, cached tokens cost the input price');
});

test('a streamed completion reports cached tokens and prices them at the cache-read rate', async () => {
  const chunks = [{ id: 'c1', choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 50_000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 45_000 } } }];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).concat('data: [DONE]', '').join('\n\n');
  const client = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'k', fetchFn: (async (url: string) => (String(url).endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'm', pricing: { input: 1.8, output: 5.75, input_cache_read: '0.00000045' } }] })) : new Response(body))) as typeof fetch });
  await client.listModels().catch(() => undefined);
  let done: Extract<CompletionEvent, { type: 'done' }> | undefined;
  for await (const event of client.streamCompletion('m', [{ role: 'user', content: 'hi' }], [])) if (event.type === 'done') done = event;
  assert.equal(done!.usage.cachedInputTokens, 45_000);
  assert.ok(Math.abs(done!.usage.estimatedCostUsd! - (5_000 * 1.8 + 45_000 * 0.45 + 200 * 5.75) / 1e6) < 1e-9);
});

test('trimming old tool output moves in steps, so consecutive turns keep the same prefix for the cache', () => {
  const conversation = (tools: number): AgentMessage[] => [{ role: 'system', content: 'sys' }, ...Array.from({ length: tools }, (_, index): AgentMessage[] => [{ role: 'assistant', content: null, tool_calls: [{ id: `c${index}`, type: 'function', function: { name: 'Read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: `c${index}`, content: `${index}:${'x'.repeat(5_000)}` }]).flat()];
  const trimmedCount = (messages: AgentMessage[]) => messages.filter((message) => message.role === 'tool' && message.content.includes('[Older tool output trimmed')).length;
  assert.equal(trimmedCount(trimOldToolResults(conversation(17))), 0, 'fewer than a full step beyond the recent ones: nothing trimmed yet');
  assert.equal(trimmedCount(trimOldToolResults(conversation(18))), 10);
  for (const tools of [19, 20, 25, 27]) assert.equal(trimmedCount(trimOldToolResults(conversation(tools))), 10, `${tools} results: the same 10 stay trimmed, so the prefix is unchanged`);
  assert.equal(trimmedCount(trimOldToolResults(conversation(28))), 20);
  const a = trimOldToolResults(conversation(20)).slice(0, 30);
  const b = trimOldToolResults(conversation(21)).slice(0, 30);
  assert.deepEqual(a, b, 'the first 30 messages are identical from one turn to the next');
});
