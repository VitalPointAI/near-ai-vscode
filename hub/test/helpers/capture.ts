// The byte capture of the hub's ciphertext-only tests (Phase 32 plan 27), moved here unchanged by Phase 33 plan 14 so the live leak test
// (liveLeak.test.ts) searches the same places with the same canary forms: the canary search over every encoding, the hub composed in process as
// the binary composes it with every request and response byte of every connection recorded, its log lines kept, and its state folder read raw.
// All names and data in the tests that use it are fictional.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import type http from 'node:http';
import type https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writerIdOf } from '@ext/domain/replica/entry';
import { hubIdentityOf } from '../../src/enrol';
import type { HubIdentity } from '../../src/enrol';
import { HealthRegistry } from '../../src/health';
import { listen } from '../../src/http/server';
import { generateKeyFile, readEncryptionKey, readSigningKey } from '../../src/keys';
import { Logger } from '../../src/log/logger';
import { Redactor } from '../../src/log/redact';
import { composeHub } from '../../src/main';
import type { ComposedHub } from '../../src/main';
import { openHubStore } from '../../src/store/hubStore';
import type { HubStore } from '../../src/store/hubStore';
import { HUB_ADDRESS, NOW_MS } from './hubWorld';
import { makeTlsFixture } from './tlsFixture';
import type { TlsFixture } from './tlsFixture';

// ---- The search -------------------------------------------------------------------------------------------------------------------------------

/** One place searched: what it is (a file, a request, a log line) and its bytes. */
export interface Place {
  where: string;
  bytes: Buffer;
}

export interface Hit {
  where: string;
  encoding: string;
}

/** base64 and base64url forms of some bytes at each of the three byte offsets they can start at inside a longer encoded value (only the characters
 *  fully decided by those bytes are kept, so the form matches wherever the bytes sit). */
export function encodedForms(bytes: Buffer, prefix = ''): Array<{ encoding: string; bytes: Buffer }> {
  const forms: Array<{ encoding: string; bytes: Buffer }> = [];
  for (const encoding of ['base64', 'base64url'] as const) {
    for (let offset = 0; offset < 3; offset += 1) {
      const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(encoding).replace(/=+$/, '');
      const first = Math.ceil((8 * offset) / 6);
      const last = Math.floor((8 * (offset + bytes.length) - 6) / 6);
      forms.push({ encoding: `${prefix}${encoding}@${offset}`, bytes: Buffer.from(encoded.slice(first, last + 1), 'ascii') });
    }
  }
  return forms;
}

/**
 * The forms a canary takes in bytes: UTF-8, UTF-16LE, hex (both cases), base64 and base64url at all three offsets, and (beyond the plan's five)
 * each base64 or base64url form encoded once more, so text a document update carries (UTF-8 inside base64url update bytes) is found even inside a
 * body that was stored or sent without its seal.
 */
export function canaryForms(value: string): Array<{ encoding: string; bytes: Buffer }> {
  const bytes = Buffer.from(value, 'utf8');
  const once = encodedForms(bytes);
  return [
    { encoding: 'utf8', bytes },
    { encoding: 'utf16le', bytes: Buffer.from(value, 'utf16le') },
    { encoding: 'hex', bytes: Buffer.from(bytes.toString('hex'), 'ascii') },
    { encoding: 'HEX', bytes: Buffer.from(bytes.toString('hex').toUpperCase(), 'ascii') },
    ...once,
    ...once.flatMap((form) => encodedForms(form.bytes, `${form.encoding} in `)),
  ];
}

/** Every place and encoding a canary is found in. */
export function search(places: readonly Place[], canary: string): Hit[] {
  const forms = canaryForms(canary);
  const hits: Hit[] = [];
  for (const place of places) for (const form of forms) if (place.bytes.includes(form.bytes)) hits.push({ where: place.where, encoding: form.encoding });
  return hits;
}

/** Asserts that none of the canaries is in any of the places, naming each hit. */
export function assertNowhere(places: readonly Place[], canaries: readonly string[], what: string): void {
  assert.ok(places.length > 0, `${what}: there are bytes to search`);
  const hits = canaries.flatMap((canary) => search(places, canary).map((hit) => `${canary} as ${hit.encoding} in ${hit.where}`));
  assert.deepEqual(hits, [], `${what}: a canary was found`);
}

/** Every file under a folder (recursing), its path from the folder and its bytes, the name searched with the bytes. */
export function filesUnder(dir: string, label: string): Place[] {
  const out: Place[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const file = path.join(at, name);
      if (statSync(file).isDirectory()) walk(file);
      else out.push({ where: `${label}:${path.relative(dir, file)}`, bytes: Buffer.concat([Buffer.from(`${path.relative(dir, file)}\n`, 'utf8'), readFileSync(file)]) });
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// ---- The hub in process, captured ---------------------------------------------------------------------------------------------------------

/** One request and its response, as the hub's request listener saw them, on one connection. */
export interface Exchange {
  socket: object;
  method: string;
  path: string;
  request: Buffer[];
  response: Buffer[];
}

export interface Capture {
  exchanges: Exchange[];
  /** The device that opened a session on a connection (from the session answer the hub accepted). */
  deviceOf(socket: object): string | undefined;
}

const toBuffer = (chunk: unknown, encoding?: unknown): Buffer => {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string') return Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
  return Buffer.alloc(0);
};

/**
 * Replaces the hub server's request listener with one that tees every request (method, path, headers and each body chunk as the hub's own reader
 * receives it) and every response (status, headers, and each chunk given to write and end, event stream frames included) before passing both on.
 */
export function captureServer(server: https.Server): Capture {
  const listeners = server.listeners('request') as Array<(req: http.IncomingMessage, res: http.ServerResponse) => void>;
  assert.equal(listeners.length, 1, 'the hub has one request listener');
  server.removeAllListeners('request');
  const exchanges: Exchange[] = [];
  const devices = new WeakMap<object, string>();
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const exchange: Exchange = { socket: req.socket, method: req.method ?? '', path: (req.url ?? '').split('?')[0] as string, request: [], response: [] };
    exchanges.push(exchange);
    exchange.request.push(Buffer.from(`${req.method ?? ''} ${req.url ?? ''}\n${req.rawHeaders.join('\n')}\n\n`, 'utf8'));
    const emit = req.emit.bind(req);
    req.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
      if (event === 'data') exchange.request.push(toBuffer(args[0]));
      return emit(event, ...args);
    }) as typeof req.emit;
    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    res.write = ((...args: unknown[]): boolean => {
      exchange.response.push(toBuffer(args[0], args[1]));
      return write(...args);
    }) as typeof res.write;
    const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
    res.end = ((...args: unknown[]): http.ServerResponse => {
      if (typeof args[0] !== 'function') exchange.response.push(toBuffer(args[0], args[1]));
      return end(...args);
    }) as typeof res.end;
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => http.ServerResponse;
    res.writeHead = ((...args: unknown[]): http.ServerResponse => {
      exchange.response.push(Buffer.from(`${String(args[0])}\n${JSON.stringify(args.slice(1))}\n`, 'utf8'));
      return writeHead(...args);
    }) as typeof res.writeHead;
    res.on('finish', () => {
      exchange.response.push(Buffer.from(`${JSON.stringify(res.getHeaders())}\n`, 'utf8'));
      // A session answer the hub accepted names the device of this connection.
      if (exchange.path === '/v1/session' && res.statusCode === 200) {
        try {
          const body = JSON.parse(Buffer.concat(exchange.request.slice(1)).toString('utf8')) as { answer?: { signer?: { publicKey?: unknown } } };
          const publicKey = body.answer?.signer?.publicKey;
          if (typeof publicKey === 'string') devices.set(req.socket, writerIdOf(publicKey));
        } catch {
          // A challenge call: no device yet.
        }
      }
    });
    for (const listener of listeners) listener.call(server, req, res);
  });
  return { exchanges, deviceOf: (socket) => devices.get(socket) };
}

export interface CapturedHub {
  port: number;
  dir: string;
  identity: HubIdentity;
  store: HubStore;
  composed: ComposedHub;
  capture: Capture;
  logLines: string[];
  logger: Logger;
  now(): number;
  advance(ms: number): void;
  /** The state folder read raw now (the hub running: the write-ahead log and shared memory file are there). */
  snapshot(label: string): Place[];
  /** Stops the hub cleanly (as the binary's stop does), then reads the state folder raw once more. */
  close(): Promise<Place[]>;
  /** Removes the state folder and the TLS fixture. */
  cleanup(): void;
}

/** The hub as the binary composes it, with the binary's log wiring onto a Logger whose sink records every line, and the capture on its server. */
export async function startCapturedHub(): Promise<CapturedHub> {
  const tls: TlsFixture = makeTlsFixture();
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-capture-'));
  const dir = path.join(root, 'state');
  mkdirSync(dir, { mode: 0o700 });
  const store = await openHubStore(dir);
  const signing = readSigningKey(generateKeyFile('signing'));
  const identity = hubIdentityOf(signing, readEncryptionKey(generateKeyFile('encryption'), signing), tls.certPem, HUB_ADDRESS);
  let clock = NOW_MS;
  const logLines: string[] = [];
  const logger = new Logger(new Redactor(), (line) => logLines.push(line), () => clock);
  const health = new HealthRegistry({ version: '0.0.0-test', startedAt: clock, now: () => clock });
  // The same hooks main.ts wires for the binary.
  const composed = composeHub({
    store,
    identity,
    tls: { cert: tls.certPem, key: tls.keyPem },
    health,
    now: () => clock,
    onFailure: (route, error) => logger.error('http.failed', { route, name: error instanceof Error ? error.name : 'NonError' }),
    onCheckpointLog: (level, event, fields) => logger[level](event, fields),
    onJoinLog: (level, event, fields) => logger[level](event, fields),
    onRejected: (route, method, status) => {
      const fields = { route, method, status };
      if (status >= 500) logger.error('http.rejected', fields);
      else logger.warn('http.rejected', fields);
    },
  });
  const capture = captureServer(composed.server);
  const port = await listen(composed.server, '127.0.0.1', 0);
  let closed = false;
  return {
    port,
    dir,
    identity,
    store,
    composed,
    capture,
    logLines,
    logger,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    snapshot: (label) => filesUnder(dir, label),
    async close() {
      if (!closed) {
        closed = true;
        composed.checkpoints?.stop();
        await composed.checkpoints?.settled();
        composed.join.stop();
        composed.events.closeAll();
        composed.presence.close();
        composed.sessions.close();
        composed.server.closeAllConnections();
        await new Promise<void>((resolve) => composed.server.close(() => resolve()));
        store.close();
      }
      return filesUnder(dir, 'closed');
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      tls.cleanup();
    },
  };
}

/** Every byte the hub received or sent at the application layer, one place per request and one per response. */
export function wireOf(capture: Capture, filter: (exchange: Exchange) => boolean = () => true): Place[] {
  return capture.exchanges.filter(filter).flatMap((exchange, index) => [
    { where: `request ${index} ${exchange.method} ${exchange.path}`, bytes: Buffer.concat(exchange.request) },
    { where: `response ${index} ${exchange.method} ${exchange.path}`, bytes: Buffer.concat(exchange.response) },
  ]);
}

export const logsOf = (hub: CapturedHub): Place[] => hub.logLines.map((line, index) => ({ where: `log line ${index}`, bytes: Buffer.from(line, 'utf8') }));
