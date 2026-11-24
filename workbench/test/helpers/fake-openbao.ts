// A fake OpenBao for the workbench unit tests (46-02; 46-07 reuses it with routes of its own): an http or https server on 127.0.0.1 with a
// free port, answering from a route table the test supplies ('POST /v1/auth/jwt/login': handler). Every call is recorded with its method,
// path, query, body and token header, so a test can assert what was asked and with which token. A route that is not in the table answers 404.
// Nothing here logs: the recorded tokens stay in the test's memory.
import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';

export interface FakeCall {
  readonly method: string;
  /** The path without the query, for example /v1/auth/token/lookup-self. */
  readonly path: string;
  readonly query: string;
  /** The parsed JSON body, or undefined when there was none (or it was not JSON). */
  readonly body: unknown;
  /** Whether an X-Vault-Token header was sent, and its value. */
  readonly hasToken: boolean;
  readonly token: string | undefined;
}

export interface FakeAnswer {
  readonly status?: number;
  readonly json?: unknown;
  /** Sent as is instead of json (for invalid JSON or an oversized body). */
  readonly raw?: string | Buffer;
  /** Waits this long before answering (for timeouts). */
  readonly delayMs?: number;
}

export type FakeRoute = (call: FakeCall) => FakeAnswer | Promise<FakeAnswer>;

export interface FakeOpenBao {
  /** For example http://127.0.0.1:41234 */
  readonly url: string;
  readonly calls: FakeCall[];
  /** Calls whose "METHOD /path" equals key. */
  callsTo(key: string): FakeCall[];
  close(): Promise<void>;
}

export async function startFakeOpenBao(routes: Record<string, FakeRoute>, options: { tls?: { certPem: string; keyPem: string } } = {}): Promise<FakeOpenBao> {
  const calls: FakeCall[] = [];
  const sockets = new Set<net.Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://fake.invalid');
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
      const header = request.headers['x-vault-token'];
      const token = Array.isArray(header) ? header[0] : header;
      const call: FakeCall = { method: request.method ?? 'GET', path: url.pathname, query: url.search, body, hasToken: token !== undefined, token };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      void Promise.resolve(route ? route(call) : { status: 404, json: { errors: [] } }).then((answer) => {
        const send = (): void => {
          if (response.destroyed) return;
          const payload = answer.raw ?? (answer.json === undefined ? '' : JSON.stringify(answer.json));
          response.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json' });
          response.end(payload);
        };
        if (answer.delayMs) {
          const timer = setTimeout(() => { timers.delete(timer); send(); }, answer.delayMs);
          timers.add(timer);
        } else {
          send();
        }
      });
    });
  };
  const server = options.tls ? https.createServer({ cert: options.tls.certPem, key: options.tls.keyPem }, handler) : http.createServer(handler);
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('secureConnection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // A refused TLS handshake (the client does not trust the test CA) is expected in some tests; keep it off the console.
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    calls,
    callsTo: (key) => calls.filter((call) => `${call.method} ${call.path}` === key),
    close: () => new Promise<void>((resolve) => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

/**
 * Records everything written to the console and to stdout and stderr from now until stop(), while still passing it through, so a test file
 * can assert that no token string ever reached the output (T-46-06). Call it once per file, before the first test.
 */
export function captureOutput(): { text(): string; stop(): void } {
  const seen: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map((name) => console[name]);
  methods.forEach((name, index) => {
    console[name] = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); originals[index].apply(console, args); };
  });
  const streams = [process.stdout, process.stderr];
  const writes = streams.map((stream) => stream.write);
  streams.forEach((stream, index) => {
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      seen.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return (writes[index] as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
    }) as typeof stream.write;
  });
  return {
    text: () => seen.join('\n'),
    stop: () => {
      methods.forEach((name, index) => { console[name] = originals[index]; });
      streams.forEach((stream, index) => { stream.write = writes[index]; });
    },
  };
}

/** A free 127.0.0.1 port with nothing listening on it (for "connection refused"). */
export async function closedPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
