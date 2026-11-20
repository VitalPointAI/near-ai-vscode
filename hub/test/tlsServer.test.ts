import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { hubRoot, startHubProcess, within } from './helpers/hubProcess';
import { tlsGet } from './helpers/tlsFixture';

// Phase 32, plan 14 (D-26, D-29, D-30): the hub serves HTTPS itself, TLS 1.3 only, with the operator's certificate and key from secret files.
// The tracer starts the real built hub and reaches /healthz over TLS 1.3.

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
    assert.equal(body.store, 'not-configured');

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
