import assert from 'node:assert/strict';
import type https from 'node:https';
import test from 'node:test';
import tls from 'node:tls';
import { HealthRegistry } from '../src/health';
import { createHubServer, listen, REQUEST_TIMING, requestBackstopMs, type HubServerOptions } from '../src/http/server';
import { makeTlsFixture, tlsGet } from './helpers/tlsFixture';

// Phase 32, plan 14 (D-26, D-28), ported from relay/test/health.test.ts: the /healthz contract. The registry is tested directly, the HTTPS surface
// through a real hub server on port 0 with a certificate made for the run.

const fixture = makeTlsFixture();
test.after(() => fixture.cleanup());

function registry(options: { probeTimeoutMs?: number } = {}): HealthRegistry {
  return new HealthRegistry({ version: '9.9.9-test', startedAt: 1_000_000, now: () => 1_042_000, ...options });
}

type Rejection = [route: string, method: string, status: number];

async function withServer<T>(
  health: HealthRegistry,
  body: (port: number, server: https.Server, rejections: Rejection[]) => Promise<T>,
  extra: Partial<HubServerOptions> = {},
): Promise<T> {
  const rejections: Rejection[] = [];
  const server = createHubServer({
    tls: { cert: fixture.certPem, key: fixture.keyPem },
    health,
    onRejected: (route, method, status) => rejections.push([route, method, status]),
    ...extra,
  });
  const port = await listen(server, '127.0.0.1', 0);
  try {
    return await body(port, server, rejections);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('the report body has exactly version, uptimeSeconds and store, and the uptime counts whole seconds', async () => {
  const { status, body } = await registry().report();
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['store', 'uptimeSeconds', 'version']);
  assert.equal(body.version, '9.9.9-test');
  assert.equal(body.uptimeSeconds, 42);
  assert.equal(body.store, 'not-configured');
});

test('a store probe that resolves ok reports ok with 200', async () => {
  const health = registry();
  health.setStoreProbe(async () => 'ok');
  assert.deepEqual(await health.report(), { status: 200, body: { version: '9.9.9-test', uptimeSeconds: 42, store: 'ok' } });
});

test('a store probe that resolves down, throws, or is slower than probeTimeoutMs reports down with 503', async () => {
  for (const probe of [async () => 'down' as const, async (): Promise<'ok'> => { throw new Error('store unreadable'); }]) {
    const health = registry();
    health.setStoreProbe(probe);
    const { status, body } = await health.report();
    assert.equal(status, 503);
    assert.equal(body.store, 'down');
  }
  const slow = registry({ probeTimeoutMs: 40 });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  slow.setStoreProbe(async () => { await gate; return 'ok'; });
  const started = Date.now();
  const report = await slow.report();
  release();
  assert.deepEqual([report.status, report.body.store], [503, 'down']);
  assert.ok(Date.now() - started < 2000, 'the report waited for the slow probe');
});

test('GET /healthz answers 200 with the three fields over TLS, with no-store and nosniff', async () => {
  await withServer(registry(), async (port, _server, rejections) => {
    const response = await tlsGet(port, '/healthz');
    assert.equal(response.status, 200);
    assert.match(String(response.headers['content-type']), /^application\/json/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(JSON.parse(response.body), { version: '9.9.9-test', uptimeSeconds: 42, store: 'not-configured' });
    assert.deepEqual(rejections, [], 'a successful /healthz call must not be reported as rejected');
  });
});

test('a failing store probe answers HTTP 503 with store down, the failure text stays out of the answer, and onRejected sees the 503', async () => {
  const health = registry();
  health.setStoreProbe(async () => { throw new Error('store unreadable'); });
  await withServer(health, async (port, _server, rejections) => {
    const response = await tlsGet(port, '/healthz');
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.body), { version: '9.9.9-test', uptimeSeconds: 42, store: 'down' });
    assert.ok(!response.body.includes('unreadable'));
    assert.deepEqual(rejections, [['healthz', 'GET', 503]]);
  });
});

test('POST /healthz answers 405 with Allow GET; an unknown path answers 404 with error and message and echoes neither path nor query', async () => {
  await withServer(registry(), async (port, _server, rejections) => {
    const post = await tlsGet(port, '/healthz', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET');
    assert.equal((JSON.parse(post.body) as { error: string }).error, 'method-not-allowed');
    const missing = await tlsGet(port, `/<script>alert(1)</script>?q=${'a'.repeat(1000)}`);
    assert.equal(missing.status, 404);
    const body = JSON.parse(missing.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['error', 'message']);
    assert.equal(body.error, 'not-found');
    assert.ok(!missing.body.includes('script') && !missing.body.includes('aaaa'), 'the path or query was echoed');
    assert.deepEqual(rejections, [['healthz', 'POST', 405], ['unknown', 'GET', 404]]);
  });
});

test('paths outside the route table go to the handler, and /healthz with a query stays the table route', async () => {
  const seen: string[] = [];
  await withServer(
    registry(),
    async (port, _server, rejections) => {
      const routed = await tlsGet(port, '/v1/projects/p/heads');
      assert.equal(routed.status, 418);
      const health = await tlsGet(port, '/healthz?probe=1');
      assert.equal(health.status, 200);
      assert.deepEqual(seen, ['/v1/projects/p/heads']);
      assert.deepEqual(rejections, []);
    },
    {
      handler: (req, res) => {
        seen.push(req.url ?? '');
        req.resume();
        res.writeHead(418, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"error":"handled"}');
      },
    },
  );
});

test('the server closes slow clients: headers within 5 s, bodies at 16 KiB a second after a 10 s grace, Node\'s whole-request limit only as a backstop', async () => {
  await withServer(registry(), async (_port, server) => {
    assert.equal(server.headersTimeout, 5000);
    // An idle connection, and so its session, stays for 2 minutes between requests (WR-04).
    assert.equal(server.keepAliveTimeout, 120_000);
    assert.deepEqual({ graceMs: REQUEST_TIMING.graceMs, minBytesPerSecond: REQUEST_TIMING.minBytesPerSecond }, { graceMs: 10_000, minBytesPerSecond: 16 * 1024 });
    // The backstop leaves room for the largest body (an 8 MiB blob) at the minimum rate, after the grace (WR-03).
    assert.equal(server.requestTimeout, requestBackstopMs(REQUEST_TIMING));
    assert.equal(server.requestTimeout, 10_000 + Math.ceil(((8 * 1024 * 1024) / (16 * 1024)) * 1000));
  });
});

test('a TLS client that stops in the middle of its headers is closed after about 5 s, not after the 30 s default check', { timeout: 20_000 }, async () => {
  await withServer(registry(), async (port) => {
    const started = Date.now();
    const closedAfter = await new Promise<number>((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, () =>
        socket.write('GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: '),
      );
      socket.on('data', () => undefined); // the 408 the server may send before closing
      socket.on('error', () => undefined); // a reset also counts as closed
      socket.on('close', () => resolve(Date.now() - started));
      setTimeout(() => {
        socket.destroy();
        reject(new Error('the stalled connection was still open after 15 s'));
      }, 15_000);
    });
    assert.ok(closedAfter >= 4_500, `closed after ${closedAfter} ms, before the 5 s headers timeout`);
    assert.ok(closedAfter < 8_000, `closed after ${closedAfter} ms; the headers timeout must apply within about a second of 5 s`);
  });
});
