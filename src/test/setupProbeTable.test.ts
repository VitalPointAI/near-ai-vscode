import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERVER_PROBE_TABLE } from '../domain/setup/servers';
import type { ProbeTarget } from '../domain/setup/servers';
import { createIdentify, listServerModels } from '../services/setup/identify';
import { probeGet } from '../services/setup/probe';
import { createFakeModelServer } from './helpers/fakeModelServers';

function target(port: number, source: ProbeTarget['source'] = 'loopback'): ProbeTarget {
  return { host: '127.0.0.1', port, scheme: 'http-loopback', source };
}

for (const row of SERVER_PROBE_TABLE) {
  test(`probe table recognises ${row.kind}`, async () => {
    const fake = createFakeModelServer(row.kind, { port: 49160 });
    const at = target(fake.port, row.kind === 'openai-compatible' ? 'entered' : 'loopback');
    const deps = { fetch: fake.fetch, rows: [fake.row] };
    const signal = new AbortController().signal;
    const result = await createIdentify(deps)(at, signal);
    if (row.kind === 'jan') {
      assert.deepEqual(result, { state: 'needs-key' });
    } else {
      assert.equal(result.state, 'identified');
      if (result.state !== 'identified') return;
      assert.equal(result.kind, row.kind);
      const models = await listServerModels(at, row.kind, deps, signal);
      assert.deepEqual(models.map((model) => model.id), ['example-model']);
      assert.equal(models[0]?.sha256, undefined);
      if (row.kind === 'ollama' || row.kind === 'lm-studio') assert.equal(models[0]?.sizeBytes, 12);
    }
    assert.deepEqual(fake.requests.slice(0, row.signatures.length).map((r) => r.path), row.signatures.map((r) => r.path));
    for (const request of fake.requests) {
      assert.equal(request.method, 'GET');
      assert.equal(request.bodyBytes, 0);
      assert.equal(request.headerNames.includes('authorization'), false);
      assert.equal(request.headerNames.includes('cookie'), false);
    }
  });
}

test('two matching signatures on a shared port leave the server unknown', async () => {
  const fake = createFakeModelServer('nim', {
    answer: (r) => r.path === '/version' ? Response.json({ version: '1.2.3' }) : undefined,
  });
  const result = await createIdentify({ fetch: fake.fetch })(target(8000), new AbortController().signal);
  assert.equal(result.state, 'unknown-server');
  assert.deepEqual(fake.requests.map((r) => r.path), [
    '/v1/health', '/api/v1/health', '/version', '/v1/health/ready', '/v1/metadata',
  ]);
});

test('a health-only service stays unknown', async () => {
  const fake = createFakeModelServer('nim', {
    answer: (r) => new Response(null, { status: r.path === '/health' ? 200 : 404 }),
  });
  assert.equal((await createIdentify({ fetch: fake.fetch })(target(8000), new AbortController().signal)).state, 'unknown-server');
});

test('a redirect is returned without following it', async () => {
  const fake = createFakeModelServer('ollama', {
    answer: () => new Response(null, { status: 302, headers: { location: '/api/tags' } }),
  });
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const response = await fake.fetch(url, init);
    return init?.redirect === 'manual' ? response : fake.fetch(new URL('/api/tags', String(url)));
  };
  assert.equal((await probeGet(target(fake.port), '/api/version', { fetch }))?.status, 302);
  assert.deepEqual(fake.requests.map(({ path }) => path), ['/api/version']);
});

test('the response cap stops a streamed signature above one MiB', async () => {
  let cancelled = false;
  const fake = createFakeModelServer('ollama', {
    answer: () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024)); },
      cancel() { cancelled = true; },
    })),
  });
  const result = await createIdentify({ fetch: fake.fetch })(target(fake.port), new AbortController().signal);
  assert.equal(result.state, 'no-answer');
  assert.equal(cancelled, true);
});

test('an unresponsive transport is cancelled at the signature timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | null | undefined;
  const result = probeGet(target(11434), '/api/version', {
    timeoutMs: 30,
    fetch: (_url, init) => {
      signal = init?.signal;
      return new Promise(() => {});
    },
  });
  await Promise.resolve();
  t.mock.timers.tick(30);
  assert.equal(await result, undefined);
  assert.equal(signal?.aborted, true);
});

test('plain HTTP and off-origin paths are refused before fetch', async () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => { requests += 1; return new Response(); };
  assert.equal(await probeGet({ ...target(443), host: 'models.example.test' }, '/v1/models', { fetch }), undefined);
  assert.equal(await probeGet(target(11434), '//models.example.test/v1/models', { fetch }), undefined);
  assert.equal(requests, 0);
});
