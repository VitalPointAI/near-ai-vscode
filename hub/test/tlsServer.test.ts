import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type https from 'node:https';
import path from 'node:path';
import test from 'node:test';
import tls, { type TLSSocket } from 'node:tls';
import { HealthRegistry } from '../src/health';
import { createHubServer, listen, MAX_HEADER_BYTES, SESSION_KEYING_BYTES, SESSION_KEYING_LABEL, sessionKeying, type HubServerOptions } from '../src/http/server';
import { hubRoot, startHubProcess, within, type StartedHub } from './helpers/hubProcess';
import { slowUpload } from './helpers/slowUpload';
import { makeTlsFixture, tlsGet } from './helpers/tlsFixture';

// Phase 32, plan 14 (D-26, D-29, D-30, D-35): the hub serves HTTPS itself, TLS 1.3 only, with the operator's certificate and key from secret files.
// The tracer starts the real built hub and reaches /healthz over TLS 1.3. The other tests show what TLS 1.3 only means in practice (a TLS 1.2
// client and a plain HTTP client get nothing), the 4 KiB header cap, and that both ends of one connection derive the same keying material, which
// the session answer of 32-20 binds to (Pitfall 5).

const fixture = makeTlsFixture();
test.after(() => fixture.cleanup());

async function withServer<T>(extra: Partial<HubServerOptions>, body: (port: number, server: https.Server) => Promise<T>): Promise<T> {
  const server = createHubServer({
    tls: { cert: fixture.certPem, key: fixture.keyPem },
    health: new HealthRegistry({ version: '9.9.9-test', startedAt: Date.now() }),
    ...extra,
  });
  const port = await listen(server, '127.0.0.1', 0);
  try {
    return await body(port, server);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withHub<T>(body: (hub: StartedHub) => Promise<T>): Promise<T> {
  const hub = await startHubProcess();
  try {
    return await body(hub);
  } finally {
    await within(hub.kill('SIGTERM'), 10_000, 'the hub stopping');
    hub.cleanup();
  }
}

test('tracer: the built hub starts from secret files, answers GET /healthz over TLS 1.3 with its certificate, and SIGTERM stops it with exit 0', async () => {
  const hub = await startHubProcess();
  try {
    const response = await tlsGet(hub.port, '/healthz');
    assert.equal(response.protocol, 'TLSv1.3');
    assert.ok(response.peerDer.equals(hub.tls.certDer), 'the hub presented a certificate other than the one in HUB_TLS_CERT');
    assert.equal(response.status, 200);
    assert.match(String(response.headers['content-type']), /^application\/json/);
    assert.equal(response.headers['cache-control'], 'no-store');
    const body = JSON.parse(response.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['store', 'uptimeSeconds', 'version']);
    const manifest = JSON.parse(readFileSync(path.join(hubRoot(), 'package.json'), 'utf8')) as { version: string };
    assert.equal(body.version, manifest.version);
    assert.equal(typeof body.uptimeSeconds, 'number');
    // 32-20 opens the store and gives the health check its probe, so a started hub reports its store ok.
    assert.equal(body.store, 'ok');

    const listening = hub.logs().find((line) => line.event === 'hub.listening');
    assert.ok(listening, 'no hub.listening line');
    assert.equal(listening.host, '127.0.0.1');
    assert.equal(listening.version, manifest.version);
    assert.match(String(listening.writer), /^[0-9a-f]{64}$/, 'hub.listening names the hub writer id');
  } finally {
    const exit = await within(hub.kill('SIGTERM'), 10_000, 'the hub stopping on SIGTERM');
    assert.deepEqual(exit, { code: 0, signal: null }, `stdout was: ${hub.stdout()}`);
    const events = hub.events();
    assert.ok(events.indexOf('hub.stopping') >= 0, 'no hub.stopping line');
    assert.ok(events.indexOf('hub.stopped') > events.indexOf('hub.stopping'), 'hub.stopped must follow hub.stopping');
    assert.ok(!events.includes('hub.crashed'));
    assert.equal(hub.stderr(), '', 'the hub wrote to stderr');
    hub.cleanup();
  }
});

test('a client limited to TLS 1.2 fails the handshake with the real hub', async () => {
  await withHub(async (hub) => {
    const outcome = await new Promise<string>((resolve) => {
      const socket = tls.connect({ host: '127.0.0.1', port: hub.port, rejectUnauthorized: false, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }, () => {
        resolve(`connected with ${socket.getProtocol()}`);
        socket.destroy();
      });
      socket.on('error', (error) => resolve(`refused: ${(error as NodeJS.ErrnoException).code ?? error.name}`));
    });
    assert.match(outcome, /^refused: /, outcome);
  });
});

test('a plain HTTP client on the hub port gets no 200 and no health body', async () => {
  await withHub(async (hub) => {
    const outcome = await new Promise<{ status?: number; body?: string; error?: string }>((resolve) => {
      const request = http.get({ host: '127.0.0.1', port: hub.port, path: '/healthz', agent: false, timeout: 5000 }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
        response.on('error', (error) => resolve({ error: error.message }));
      });
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', (error) => resolve({ error: (error as NodeJS.ErrnoException).code ?? error.message }));
    });
    assert.notEqual(outcome.status, 200, JSON.stringify(outcome));
    assert.ok(!(outcome.body ?? '').includes('uptimeSeconds'), 'the health body reached a plain HTTP client');
  });
});

test(`a request header over ${MAX_HEADER_BYTES} bytes gets 431 and one just under the cap is served`, async () => {
  await withServer({}, async (port) => {
    const big = await tlsGet(port, '/healthz', { headers: { 'x-fill': 'a'.repeat(MAX_HEADER_BYTES + 1) } });
    assert.equal(big.status, 431);
    const small = await tlsGet(port, '/healthz', { headers: { 'x-fill': 'a'.repeat(MAX_HEADER_BYTES - 512) } });
    assert.equal(small.status, 200);
  });
});

interface KeyingSample {
  client: string;
  server: string;
}

/** One TLS 1.3 connection: the client's keying material, and the server's as the handler saw it on the same connection. */
function keyingOnOneConnection(port: number): Promise<KeyingSample> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false, minVersion: 'TLSv1.3', servername: 'localhost' }, () => {
      const client = sessionKeying(socket).toString('hex');
      socket.write('GET /v1/keying HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      let raw = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => { raw += chunk; });
      socket.on('end', () => {
        const server = raw.slice(raw.indexOf('\r\n\r\n') + 4).trim();
        resolve({ client, server });
      });
    });
    socket.on('error', reject);
  });
}

test('exportKeyingMaterial(32, near-ai-hub-session/v1) is the same 32 bytes on both ends of one TLS 1.3 connection and different on another', async () => {
  const secured: TLSSocket[] = [];
  const protocols: (string | null)[] = [];
  const hookRanFirst: boolean[] = [];
  await withServer(
    {
      onSecureConnection: (socket) => {
        secured.push(socket);
        protocols.push(socket.getProtocol());
      },
      handler: (req, res) => {
        req.resume();
        const socket = req.socket as TLSSocket;
        // The hook ran for this connection, before its first request.
        hookRanFirst.push(secured.includes(socket));
        const body = sessionKeying(socket).toString('hex');
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      },
    },
    async (port) => {
      const first = await keyingOnOneConnection(port);
      const second = await keyingOnOneConnection(port);
      assert.equal(SESSION_KEYING_LABEL, 'near-ai-hub-session/v1');
      assert.equal(SESSION_KEYING_BYTES, 32);
      assert.match(first.client, /^[0-9a-f]{64}$/, 'the client got 32 bytes');
      assert.equal(first.server, first.client, 'both ends of one connection agree');
      assert.equal(second.server, second.client, 'both ends of the second connection agree');
      assert.notEqual(second.client, first.client, 'another connection gives other bytes');
      assert.equal(secured.length, 2, 'onSecureConnection ran once per connection');
      assert.deepEqual(protocols, ['TLSv1.3', 'TLSv1.3']);
      assert.deepEqual(hookRanFirst, [true, true], 'onSecureConnection saw each connection before its request');
    },
  );
});

// ---- Uploads on slow links (WR-03): a minimum rate, not one whole-request time ----

/** A handler that reads the whole body, the way the /v1 routes do, and answers how many bytes arrived. */
const countingHandler: HubServerOptions['handler'] = (req, res) => {
  let bytes = 0;
  req.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  req.on('end', () => {
    const body = JSON.stringify({ bytes });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
};

test('a slow link: 512 KiB sent at about 40 KiB a second (about 13 s, past ten seconds) is received whole with the hub\'s own limits', { timeout: 40_000 }, async () => {
  await withServer({ handler: countingHandler }, async (port) => {
    const body = Buffer.alloc(512 * 1024, 7);
    const result = await slowUpload(port, { method: 'PUT', path: '/v1/blobs/test', body, chunkBytes: 4 * 1024, everyMs: 100 });
    assert.equal(result.status, 200, `answered ${String(result.status)} after ${result.elapsedMs} ms having sent ${result.sent} bytes`);
    assert.deepEqual(JSON.parse(result.text), { bytes: body.length });
    assert.ok(result.elapsedMs > 10_000, `the upload took ${result.elapsedMs} ms, so it did not test past ten seconds`);
  });
});

test('slowloris: a body that trickles below the minimum rate, or stops, is cut off soon after the grace time, and a fast enough one is not', { timeout: 30_000 }, async () => {
  const timing = { graceMs: 300, minBytesPerSecond: 64 * 1024 };
  const rejections: string[] = [];
  await withServer({ handler: countingHandler, timing, onRejected: (route, _method, status) => rejections.push(`${route} ${status}`) }, async (port) => {
    const trickle = await slowUpload(port, { method: 'PUT', path: '/v1/blobs/test', body: Buffer.alloc(1024 * 1024, 1), chunkBytes: 1024, everyMs: 100 });
    assert.ok(trickle.elapsedMs < 3000, `a 10 KiB a second trickle was held ${trickle.elapsedMs} ms`);
    assert.ok(trickle.status === 408 || trickle.status === undefined, `the trickle got ${String(trickle.status)}`);
    if (trickle.status === 408) assert.equal(JSON.parse(trickle.text).error, 'too-slow');
    assert.equal(await trickle.closesWithin(2000), true, 'the trickling connection stayed open');

    const stalled = await slowUpload(port, { method: 'POST', path: '/v1/session', body: Buffer.alloc(100, 32), chunkBytes: 10, everyMs: 50, stopAfterBytes: 20 });
    assert.ok(stalled.elapsedMs < 3000, `a stalled small body was held ${stalled.elapsedMs} ms`);
    assert.equal(await stalled.closesWithin(2000), true, 'the stalled connection stayed open');
    assert.ok(rejections.includes('slow-upload 408'), `rejections: ${rejections.join(', ')}`);

    // 256 KiB at 128 KiB a second, twice the minimum: answered whole.
    const fast = await slowUpload(port, { method: 'PUT', path: '/v1/blobs/test', body: Buffer.alloc(256 * 1024, 2), chunkBytes: 8 * 1024, everyMs: 62 });
    assert.equal(fast.status, 200, `a fast enough upload got ${String(fast.status)} after ${fast.elapsedMs} ms`);
    assert.deepEqual(JSON.parse(fast.text), { bytes: 256 * 1024 });
  });
});
