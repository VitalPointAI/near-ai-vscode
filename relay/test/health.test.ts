import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { HealthRegistry } from '../src/health';
import { createRelayServer, listen } from '../src/http/server';

// Phase 68, plan 02 (RELAY-02, D-12): the /healthz contract. The registry is tested directly, the HTTP surface through a real server on port 0.

function registry(options: { probeTimeoutMs?: number } = {}): HealthRegistry {
  return new HealthRegistry({ version: '9.9.9-test', startedAt: 1_000_000, now: () => 1_042_000, ...options });
}

type Rejection = [route: string, method: string, status: number];

async function withServer<T>(health: HealthRegistry, body: (port: number, server: http.Server, rejections: Rejection[]) => Promise<T>): Promise<T> {
  const rejections: Rejection[] = [];
  const server = createRelayServer({ health, onRejected: (route, method, status) => rejections.push([route, method, status]) });
  const port = await listen(server, '127.0.0.1', 0);
  try {
    return await body(port, server, rejections);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Sends the path exactly as given, so a literal script tag reaches the server unencoded. */
function rawRequest(port: number, method: string, target: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: target }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('the report body has exactly the five fields and the uptime counts whole seconds', async () => {
  const { status, body } = await registry().report();
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['inFlightRuns', 'signal', 'teams', 'uptimeSeconds', 'version']);
  assert.equal(body.version, '9.9.9-test');
  assert.equal(body.uptimeSeconds, 42);
  assert.equal(body.teams, 'not-configured');
  assert.equal(body.signal, 'not-configured');
  assert.equal(body.inFlightRuns, 0);
});

test('a probe that resolves ok reports ok, and a component without a probe stays not-configured', async () => {
  const health = registry();
  health.setProbe('teams', async () => 'ok');
  const { body } = await health.report();
  assert.equal(body.teams, 'ok');
  assert.equal(body.signal, 'not-configured');
});

test('a probe that resolves down, or throws, reports down and the status stays 200', async () => {
  const health = registry();
  health.setProbe('teams', async () => 'down');
  health.setProbe('signal', async () => { throw new Error('probe failed'); });
  const { status, body } = await health.report();
  assert.equal(status, 200);
  assert.equal(body.teams, 'down');
  assert.equal(body.signal, 'down');
});

test('a probe slower than probeTimeoutMs reports down', async () => {
  const health = registry({ probeTimeoutMs: 40 });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  health.setProbe('signal', async () => { await gate; return 'ok'; });
  const started = Date.now();
  const { body } = await health.report();
  release();
  assert.equal(body.signal, 'down');
  assert.ok(Date.now() - started < 2000, 'the report waited for the slow probe');
});

test('an in-flight source returning 3 reports 3', async () => {
  const health = registry();
  health.setInFlightRuns(() => 3);
  assert.equal((await health.report()).body.inFlightRuns, 3);
  health.setInFlightRuns(async () => 5);
  assert.equal((await health.report()).body.inFlightRuns, 5);
});

test('a throwing in-flight source answers HTTP 503 with inFlightRuns null, and onRejected sees the 503', async () => {
  const health = registry();
  health.setInFlightRuns(() => { throw new Error('store unreadable'); });
  await withServer(health, async (port, _server, rejections) => {
    const response = await rawRequest(port, 'GET', '/healthz');
    assert.equal(response.status, 503);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    assert.equal(body.inFlightRuns, null);
    assert.deepEqual(Object.keys(body).sort(), ['inFlightRuns', 'signal', 'teams', 'uptimeSeconds', 'version']);
    assert.ok(!response.body.includes('store unreadable'), 'the failure text reached the response');
    assert.deepEqual(rejections, [['healthz', 'GET', 503]]);
  });
});

test('GET /healthz answers 200 with the five fields over HTTP', async () => {
  const health = registry();
  health.setInFlightRuns(() => 3);
  await withServer(health, async (port, _server, rejections) => {
    const response = await rawRequest(port, 'GET', '/healthz');
    assert.equal(response.status, 200);
    assert.match(String(response.headers['content-type']), /^application\/json/);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['inFlightRuns', 'signal', 'teams', 'uptimeSeconds', 'version']);
    assert.equal(body.inFlightRuns, 3);
    assert.deepEqual(rejections, [], 'a successful /healthz call must not be reported as rejected');
  });
});

test('POST /healthz answers 405 with Allow GET and is reported with its route and method', async () => {
  await withServer(registry(), async (port, _server, rejections) => {
    const response = await rawRequest(port, 'POST', '/healthz');
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'GET');
    assert.deepEqual(rejections, [['healthz', 'POST', 405]]);
  });
});

test('a path with a script tag and a long query answers 404 and echoes neither, and onRejected gets no path', async () => {
  await withServer(registry(), async (port, _server, rejections) => {
    const longQuery = `q=${'a'.repeat(2000)}`;
    const response = await rawRequest(port, 'GET', `/<script>alert(1)</script>?${longQuery}`);
    assert.equal(response.status, 404);
    assert.ok(!response.body.includes('script'), 'the path was echoed');
    assert.ok(!response.body.includes('aaaa'), 'the query was echoed');
    assert.deepEqual(rejections, [['unknown', 'GET', 404]]);
    assert.ok(!JSON.stringify(rejections).includes('script'));
  });
});

test('responses carry cache-control no-store and nosniff, on 200, 404 and 405', async () => {
  await withServer(registry(), async (port) => {
    for (const [method, target] of [['GET', '/healthz'], ['GET', '/nowhere'], ['POST', '/healthz']] as const) {
      const response = await rawRequest(port, method, target);
      assert.equal(response.headers['cache-control'], 'no-store', `${method} ${target}`);
      assert.equal(response.headers['x-content-type-options'], 'nosniff', `${method} ${target}`);
    }
  });
});

test('the server closes slow clients: headersTimeout 5000 and requestTimeout 10000', async () => {
  await withServer(registry(), async (_port, server) => {
    assert.equal(server.headersTimeout, 5000);
    assert.equal(server.requestTimeout, 10000);
  });
});
