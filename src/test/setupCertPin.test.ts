import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ProbeTarget } from '../domain/setup/servers';
import { peerFingerprint } from '../services/connectionBinding';
import { NO_TLS_TEXT, readSpkiPin, type TlsConnectLike } from '../services/setup/certPin';

const certificate = new X509Certificate(readFileSync(path.resolve(__dirname, '../../test/fixtures/cyber/certs/patched/server.pem')));
const loopback: ProbeTarget = { host: '127.0.0.1', port: 11434, scheme: 'https', source: 'announced' };
const unavailable = { ok: false, cause: NO_TLS_TEXT } as const;

class FakeSocket extends EventEmitter {
  reads = 0;
  closes = 0;

  getPeerCertificate(detailed: true) {
    assert.equal(detailed, true);
    this.reads++;
    return { raw: certificate.raw };
  }

  destroy() {
    this.closes++;
    this.emit('close');
  }
}

test('reads the SPKI from one loopback TLS handshake using a socket with no application data methods', async () => {
  const socket = new FakeSocket();
  let options: Parameters<TlsConnectLike>[0] | undefined;
  const result = await readSpkiPin(loopback, { connect(input) {
    options = input;
    queueMicrotask(() => socket.emit('secureConnect'));
    return socket;
  } });
  const expected = peerFingerprint({ raw: certificate.raw }, 'public-key-sha256');
  assert.ok(expected);
  assert.deepEqual(result, { ok: true, pin: expected });
  assert.deepEqual(options, { host: '127.0.0.1', port: 11434, rejectUnauthorized: false });
  assert.equal(socket.reads, 1);
  assert.equal(socket.closes, 1);
});

test('a TLS error closes the socket and yields no pin', async () => {
  const socket = new FakeSocket();
  const result = await readSpkiPin(loopback, { connect() {
    queueMicrotask(() => socket.emit('error', new Error('Fixture TLS error')));
    return socket;
  } });
  assert.deepEqual(result, unavailable);
  assert.equal(socket.reads, 0);
  assert.equal(socket.closes, 1);
});

test('timing out or cancelling closes the socket and discards a late handshake', async () => {
  const timedOut = new FakeSocket();
  assert.deepEqual(await readSpkiPin(loopback, { connect: () => timedOut, timeoutMs: 1 }), unavailable);
  timedOut.emit('secureConnect');
  assert.equal(timedOut.reads, 0);
  assert.equal(timedOut.closes, 1);

  const controller = new AbortController();
  const cancelled = new FakeSocket();
  const result = readSpkiPin(loopback, { signal: controller.signal, connect() {
    queueMicrotask(() => controller.abort());
    return cancelled;
  } });
  assert.deepEqual(await result, unavailable);
  assert.equal(cancelled.reads, 0);
  assert.equal(cancelled.closes, 1);
});

test('invalid targets never open a socket', async () => {
  const connect: TlsConnectLike = () => assert.fail('A malformed target must never open a connection');
  for (const target of [
    { ...loopback, scheme: 'http-loopback' as const },
    { ...loopback, port: 0 },
    { ...loopback, host: '127.0.0.1/invalid' }
  ]) assert.deepEqual(await readSpkiPin(target, { connect }), unavailable);
});
