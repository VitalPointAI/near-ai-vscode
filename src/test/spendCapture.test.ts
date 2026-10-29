import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compactConversation } from '../agent/context';
import { SafetyModelCheck } from '../agent/safetyModel';
import { providerErrorMessage } from '../services/chatBridge';
import { NearAiClient, NearAiError, normalizeModelInfo, SpendLimitError } from '../services/nearAiClient';
import { SpendAccount } from '../services/spendAccount';
import { totalNanoUsd, withSpendTag } from '../services/spendLedger';

// Every billable NEAR response is recorded at the client boundary, whoever sent it, with the
// caller's spend tag: the main agent, sub-agents, safety checks, summaries, attachments,
// transcription, and image generation. Interrupted and cancelled responses are recorded too.

const BASE = 'https://cloud-api.near.ai/v1';
const CHAT = 'z-ai/glm-5.3';
const IMAGE = 'black-forest-labs/flux';
const AUDIO = 'openai/whisper';

type Handler = (url: string, init: RequestInit | undefined, body: Record<string, unknown> | undefined) => Promise<Response> | Response;

function sse(chunks: unknown[], id: string): Response {
  const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), 'data: [DONE]', ''].join('\n\n');
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'inference-id': id } });
}

async function setup(handler?: Handler, options: { dailyLimitUsd?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-capture-'));
  const account = new SpendAccount('capture', { dir, timers: false, dailyLimitUsd: () => options.dailyLimitUsd ?? 0 });
  const fetched: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace(BASE, '');
    fetched.push(url);
    let body: Record<string, unknown> | undefined;
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    if (url === '/models') return Response.json({ data: [
      { id: CHAT, pricing: { input: 1, output: 2, request: '0.0001' }, max_output_length: 4096 },
      { id: IMAGE, pricing: { input: 0, output: 0, image: '0.04' } },
      { id: AUDIO, pricing: { input: 0, output: 0, request: '0.006' } }
    ] });
    if (url === '/model/list') return Response.json({ models: [] });
    if (handler) return handler(url, init, body);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const client = new NearAiClient({ baseUrl: BASE, apiKey: 'sk-test', fetchFn, spend: account, spendTag: { projectId: 'project-1' }, maxRetries: 0 });
  await client.listModels();
  return { client, account, fetched };
}

const usage = { prompt_tokens: 1000, completion_tokens: 500 };

test('the catalog\'s max_output_length and per-request price are used', () => {
  const model = normalizeModelInfo({ id: 'm', max_output_length: 8192, pricing: { input: 1, output: 2, image: '0.04', request: '0.0001' } });
  assert.equal(model.maxOutputTokens, 8192);
  assert.equal(model.imagePricePerUnit, 0.04);
  assert.equal(model.requestPricePerUnit, 0.0001);
});

test('each kind of request is recorded with its tag: main, sub-agent, safety, summary, attachment, transcription, image, generation', async () => {
  let n = 0;
  const { client, account, fetched } = await setup(async (url, _init, body) => {
    n += 1;
    const id = `inf-${n}`;
    if (url === '/chat/completions' && body?.stream) return sse([{ id: `c${n}`, choices: [{ delta: { content: 'Summary.' }, finish_reason: 'stop' }] }, { choices: [], usage }], id);
    if (url === '/chat/completions') return Response.json({ choices: [{ message: { content: '{"allow": true, "reason": "ok"}' } }], usage }, { headers: { 'inference-id': id } });
    if (url === '/audio/transcriptions') return Response.json({ text: 'hello' }, { headers: { 'inference-id': id } });
    if (url === '/images/generations') return Response.json({ data: [{ b64_json: Buffer.from('png').toString('base64') }, { b64_json: Buffer.from('png').toString('base64') }] }, { headers: { 'inference-id': id } });
    return new Response('not found', { status: 404 });
  });
  const drain = async (stream: AsyncGenerator<unknown>) => { for await (const _event of stream) { /* read it all */ } };
  await withSpendTag({ kind: 'main', runId: 'run-1', conversationId: 'conv-1', agentId: 'main-run-1' }, async () => {
    await drain(client.streamCompletion(CHAT, [{ role: 'user', content: 'hi' }], []));
    await withSpendTag({ kind: 'sub-agent', agentId: 'researcher-1' }, async () => {
      await drain(client.streamCompletion(CHAT, [{ role: 'user', content: 'research' }], []));
      // The safety model, asked from inside a sub-agent's run.
      await new SafetyModelCheck({ client, model: CHAT, task: 't' }).check('node probe.js', { root: '/w', cwd: '/w' });
    });
    const long = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: `message ${i}` }));
    await compactConversation(client, CHAT, [{ role: 'system', content: 's' }, ...long], new AbortController().signal, 2);
    await client.describeImage(CHAT, 'data:image/png;base64,AAAA', 'What is this?');
    await client.transcribeAudio(AUDIO, new Uint8Array([1, 2, 3]), 'a.wav', 'audio/wav');
    await client.generateImage(IMAGE, 'a cat', { count: 2 });
  });
  await withSpendTag({ kind: 'generation' }, () => client.generateImage(IMAGE, 'a dog'));
  const entries = account.ledger.list();
  assert.deepEqual(entries.map((entry) => entry.kind), ['main', 'sub-agent', 'safety', 'summary', 'attachment', 'transcription', 'image', 'generation']);
  assert.ok(entries.every((entry) => entry.status === 'completed' && entry.requestId && entry.projectId === 'project-1'));
  assert.deepEqual(entries.slice(0, 7).map((entry) => entry.runId), Array(7).fill('run-1'));
  assert.equal(entries[2].agentId, 'researcher-1', 'the safety check is billed to the agent that asked');
  // 1000 in at $1/M + 500 out at $2/M + $0.0001 per request.
  assert.equal(entries[0].estimateNanoUsd, 2_100_000);
  assert.equal(entries[5].estimateNanoUsd, 6_000_000, 'transcription at its per-request price');
  assert.equal(entries[6].estimateNanoUsd, 80_000_000, 'two images at $0.04 each');
  assert.equal(entries[7].estimateNanoUsd, 40_000_000);
  assert.equal(account.totals({ runId: 'run-1' }).requests, 7);
  // Catalog and billing reads are not billable and not recorded.
  assert.ok(fetched.includes('/models'));
  assert.equal(account.ledger.list({ kind: undefined }).filter((entry) => entry.path === '/models').length, 0);
});

test('a safety check that times out before NEAR answers is still recorded (estimate only, no ID to check)', async () => {
  const { client, account } = await setup(async (_url, init) => {
    await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 2_000); init?.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
    throw new DOMException('The operation was aborted.', 'AbortError');
  });
  const verdict = await withSpendTag({ kind: 'main', runId: 'run-2' }, () => new SafetyModelCheck({ client, model: CHAT, task: 't', timeoutMs: 30 }).check('make deploy', { root: '/w', cwd: '/w' }));
  assert.equal(verdict.allow, false);
  const [entry] = account.ledger.list();
  assert.equal(entry.kind, 'safety');
  assert.equal(entry.status, 'aborted');
  assert.equal(entry.requestId, undefined);
  assert.ok(entry.estimateNanoUsd > 0, 'the request it sent is estimated');
  assert.equal(account.totals({ runId: 'run-2' }).estimatedNanoUsd, entry.estimateNanoUsd);
});

test('a stream that breaks off, and one that is stopped, are recorded with their inference-id and what arrived', async () => {
  let n = 0;
  const { client, account } = await setup(async () => {
    n += 1;
    const id = `inf-${n}`;
    const encoder = new TextEncoder();
    const chunk = encoder.encode(`data: ${JSON.stringify({ id: 'x', choices: [{ delta: { content: 'Partial answer that will be lost' } }] })}\n\n`);
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        // The first drops; the second keeps streaming until the client stops reading.
        if (n === 1) setTimeout(() => controller.error(new TypeError('terminated: other side closed')), 5);
        else timer = setInterval(() => { try { controller.enqueue(chunk); } catch { clearInterval(timer); } }, 5);
      },
      cancel() { clearInterval(timer); }
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'inference-id': id } });
  });
  await assert.rejects(async () => { for await (const _event of client.streamCompletion(CHAT, [{ role: 'user', content: 'hi' }], [])) { /* read */ } }, /dropped mid-response/);
  const abort = new AbortController();
  await assert.rejects(async () => { for await (const event of client.streamCompletion(CHAT, [{ role: 'user', content: 'hi' }], [], abort.signal)) if (event.type === 'text') abort.abort(); });
  const [partial, stopped] = account.ledger.list();
  assert.equal(partial.status, 'partial');
  assert.equal(partial.requestId, 'inf-1');
  assert.equal(stopped.status, 'aborted');
  assert.equal(stopped.requestId, 'inf-2');
  for (const entry of [partial, stopped]) assert.ok(entry.estimateNanoUsd > 100_000, 'request plus streamed text, provisionally');
  assert.equal(account.ledger.pending().length, 2, 'both wait for NEAR\'s actual cost');
});

test('NEAR\'s 402 reads as "NEAR spend limit reached", and the daily limit stops requests before they are sent', async () => {
  const { client } = await setup(() => Response.json({ error: { message: 'Insufficient credits', type: 'payment_required' } }, { status: 402 }));
  const error = await client.completeOnce(CHAT, [{ role: 'user', content: 'hi' }], { maxTokens: 16 }).catch((caught: unknown) => caught);
  assert.ok(error instanceof NearAiError);
  assert.match(error.message, /^NEAR spend limit reached/);
  assert.match(providerErrorMessage(error), /^NEAR spend limit reached.*Insufficient credits/);

  const limited = await setup(() => Response.json({ choices: [{ message: { content: 'ok' } }], usage }, { headers: { 'inference-id': 'inf-x' } }), { dailyLimitUsd: 0.001 });
  await limited.client.completeOnce(CHAT, [{ role: 'user', content: 'hi' }], { maxTokens: 16 });
  const before = limited.fetched.length;
  const refused = await limited.client.completeOnce(CHAT, [{ role: 'user', content: 'again' }], { maxTokens: 16 }).catch((caught: unknown) => caught);
  assert.ok(refused instanceof SpendLimitError);
  assert.equal(limited.fetched.length, before, 'nothing was sent');
  assert.match(providerErrorMessage(refused), /daily limit of \$0\.00/);
  assert.equal(totalNanoUsd(limited.account.totals()), 2_100_000);
});
