import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALLOWED_HOSTS, createFetcher, type FetchResponse } from '../src/import/lib/fetch.ts';

const response = (url: string, status = 200, headers: Record<string, string> = {}, body = 'ok'): FetchResponse => {
  const data = Buffer.from(body);
  return { status, url, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
};

test('fetcher has the fixed permitted host list', () => assert.deepEqual(ALLOWED_HOSTS, ['www.cyber.gc.ca', 'cyber.gc.ca', 'open.canada.ca', 'laws-lois.justice.gc.ca', 'www.ecfr.gov', 'raw.githubusercontent.com', 'www.canada.ca', 'www.tbs-sct.canada.ca']));
test('fetcher refuses http before calling fetch', async () => { let calls = 0; const fetcher = createFetcher({ fetchImpl: async () => { calls++; return response('https://www.cyber.gc.ca/x'); } }); await assert.rejects(fetcher.get('http://www.cyber.gc.ca/x'), /https/); assert.equal(calls, 0); });
test('fetcher refuses an unlisted host', async () => { const fetcher = createFetcher({ fetchImpl: async () => response('https://example.invalid/x') }); await assert.rejects(fetcher.get('https://example.invalid/x'), /host/); });
test('fetcher follows a same-host redirect only', async () => { let count = 0; const fetcher = createFetcher({ fetchImpl: async (url) => ++count === 1 ? response(url, 302, { location: '/next' }) : response(url), sleep: async () => {} }); const got = await fetcher.get('https://www.cyber.gc.ca/start'); assert.equal(got.url, 'https://www.cyber.gc.ca/next'); });
test('fetcher follows the Cyber Centre bare-host canonical redirect', async () => { let count = 0; const fetcher = createFetcher({ fetchImpl: async (url) => ++count === 1 ? response(url, 302, { location: 'https://www.cyber.gc.ca/next' }) : response(url), sleep: async () => {} }); const got = await fetcher.get('https://cyber.gc.ca/start'); assert.equal(got.url, 'https://www.cyber.gc.ca/next'); });
test('fetcher refuses an off-host redirect', async () => { const fetcher = createFetcher({ fetchImpl: async (url) => response(url, 302, { location: 'https://example.invalid/x' }) }); await assert.rejects(fetcher.get('https://www.cyber.gc.ca/start'), /redirect/); });
test('fetcher caps response bytes', async () => { const fetcher = createFetcher({ fetchImpl: async (url) => response(url, 200, {}, 'abcd') }); await assert.rejects(fetcher.get('https://www.cyber.gc.ca/x', { maxBytes: 3 }), /byte/); });
test('fetcher aborts an undeclared oversized response while streaming', async () => {
  let requestSignal: AbortSignal | null | undefined;
  const fetcher = createFetcher({ fetchImpl: async (_url, init) => {
    requestSignal = init.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2));
        controller.enqueue(new Uint8Array(2));
      },
    });
    return new Response(body);
  } });
  await assert.rejects(fetcher.get('https://www.cyber.gc.ca/x', { maxBytes: 3 }), /byte cap/);
  assert.equal(requestSignal?.aborted, true);
});
test('fetcher spaces requests to one host and sends an honest user agent', async () => { let now = 0; const waits: number[] = []; const headers: string[] = []; const fetcher = createFetcher({ now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; }, fetchImpl: async (url, init) => { headers.push(String((init.headers as Record<string, string>)['user-agent'])); return response(url); } }); await fetcher.get('https://www.cyber.gc.ca/one'); await fetcher.get('https://www.cyber.gc.ca/two'); assert.ok(waits.some((wait) => wait >= 400)); assert.match(headers[0], /NEAR AI compliance importer/i); });
