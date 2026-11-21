// Copied from relay/src/http/server.ts and adapted for the hub (D-28): node:https instead of node:http, TLS 1.3 only (D-29).
import type http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { HealthRegistry } from '../health';
import { LIMITS } from '../limits';

// The hub's HTTPS surface: a literal route table, no framework, no body parsing here. The hub ends TLS itself with the operator's certificate, so
// a device's session answer can bind to this TLS connection's keying material (D-29, D-35). Only TLS 1.3 is offered: a TLS 1.2 client fails the
// handshake, and a plain HTTP client never gets an answer. GET /healthz is the one route this file owns; the hub's /v1 routes (32-20) arrive
// through `handler`. Responses never echo the request path or any request data.

export type RejectedRoute = 'healthz' | 'unknown' | 'slow-upload';

export interface HubTls {
  /** The certificate chain, PEM. */
  cert: string;
  /** The certificate's private key, PEM. */
  key: string;
}

export type HubHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export interface HubServerOptions {
  tls: HubTls;
  health: HealthRegistry;
  /** Every request that is not a route of this table. Without one, the answer is 404. */
  handler?: HubHandler;
  /** Called once per TLS connection after its handshake, before any request (32-20 starts its authentication deadline here). */
  onSecureConnection?: (socket: TLSSocket) => void;
  onRejected?: (route: RejectedRoute, method: string, status: number) => void;
  /** The request timing; REQUEST_TIMING unless a test shortens it. */
  timing?: Partial<RequestTiming>;
}

/**
 * How long the hub waits for a request (WR-03). Headers must be in within headersMs. A body then gets graceMs, and from there on the bytes that
 * have arrived must keep up with minBytesPerSecond: a small body (a session call, a join) is in long before the grace ends, a large one (an 8 MiB
 * blob, a 4 MiB append or enrolment) may take as long as a slow site link needs, and a client that trickles or stalls (slowloris) is cut off
 * within about a second of falling behind, with 408 too-slow. Holding a connection longer costs a client real upload bandwidth, never only time.
 */
export interface RequestTiming {
  /** The request line and headers. */
  headersMs: number;
  /** The time any body gets before the minimum rate applies. */
  graceMs: number;
  /** The slowest upload the hub waits for: 16 KiB a second (128 kbit/s), so an 8 MiB blob may take about eight and a half minutes. */
  minBytesPerSecond: number;
  /**
   * How long an idle connection stays open between requests (WR-04). A session belongs to its connection, so this is how long a device keeps its
   * session between exchanges: 2 minutes, well inside the 15 minute token, so a site behind one address does not spend its session bucket (D-39)
   * on a new session per exchange. A connection that never opened a session is still closed at the authentication deadline.
   */
  keepAliveMs: number;
}

export const REQUEST_TIMING: Readonly<RequestTiming> = Object.freeze({
  headersMs: 5000,
  graceMs: 10_000,
  minBytesPerSecond: 16 * 1024,
  keepAliveMs: 120_000,
});

/** The largest body any route takes. */
const LARGEST_BODY_BYTES = Math.max(LIMITS.blobBytes, LIMITS.appendBodyBytes, LIMITS.enrolBodyBytes);

/** Node's whole-request limit, kept only as a backstop behind the minimum rate: the largest body at the minimum rate, after the grace. */
export function requestBackstopMs(timing: RequestTiming): number {
  return timing.graceMs + Math.ceil((LARGEST_BODY_BYTES / timing.minBytesPerSecond) * 1000);
}

/** The request on each connection whose body is being read, so the authentication deadline can let an upload under way finish (session.ts). */
const uploads = new WeakMap<Socket, { req: http.IncomingMessage; res: http.ServerResponse }>();

/** The request whose body is still arriving on this connection, if any. */
export function uploadUnderWay(socket: Socket): { req: http.IncomingMessage; res: http.ServerResponse } | undefined {
  const upload = uploads.get(socket);
  return upload !== undefined && !upload.req.complete ? upload : undefined;
}

/** Each server's requests whose body is still arriving, so stopping can end them (endUploads). */
const serverUploads = new WeakMap<https.Server, Set<http.IncomingMessage>>();

/**
 * At stop: ends every request whose body is still arriving, so a slow upload cannot hold the hub past its stopping grace. Such a request has
 * touched nothing yet (its route is still reading the body), and the device sends it again on its next exchange. Requests already read are
 * answered as usual. Returns how many were ended.
 */
export function endUploads(server: https.Server): number {
  let ended = 0;
  for (const req of serverUploads.get(server) ?? []) {
    if (req.complete) continue;
    req.socket.destroy();
    ended += 1;
  }
  return ended;
}

/** True when the request carries a body: a content-length above zero, or a chunked body. */
function carriesBody(req: http.IncomingMessage): boolean {
  const length = req.headers['content-length'];
  if (length !== undefined) return length !== '0';
  return req.headers['transfer-encoding'] !== undefined;
}

export const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

export const CONNECTIONS_CHECKING_INTERVAL_MS = 1000;
/** Request headers larger than this are answered 431 by Node's parser before any handler runs. */
export const MAX_HEADER_BYTES = 4096;
export const TLS_VERSION = 'TLSv1.3';

/** The TLS exporter label a device's session answer binds to (D-35). */
export const SESSION_KEYING_LABEL = 'near-ai-hub-session/v1';
export const SESSION_KEYING_BYTES = 32;

/**
 * exportKeyingMaterial(32, 'near-ai-hub-session/v1') of one TLS 1.3 connection, without a context: both ends of that connection get the same 32
 * bytes and any other connection gets others (Pitfall 5). Node's types ask for a context argument; leaving it out is the call D-35 names.
 */
export function sessionKeying(socket: TLSSocket): Buffer {
  return socket.exportKeyingMaterial(SESSION_KEYING_BYTES, SESSION_KEYING_LABEL, undefined as unknown as Buffer);
}

export function sendJson(res: http.ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...BASE_HEADERS, ...extra, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const NOT_FOUND = JSON.stringify({ error: 'not-found', message: 'There is nothing at this address on the hub.' });
const METHOD_NOT_ALLOWED = JSON.stringify({ error: 'method-not-allowed', message: 'This address answers GET only.' });
const INTERNAL = JSON.stringify({ error: 'internal', message: 'The hub could not answer this request.' });
const TOO_SLOW = JSON.stringify({ error: 'too-slow', message: 'The request arrived too slowly for the hub to keep waiting. Try again when the link is faster.' });

export function createHubServer(options: HubServerOptions): https.Server {
  const timing: RequestTiming = { ...REQUEST_TIMING, ...(options.timing ?? {}) };
  const active = new Set<http.IncomingMessage>();
  const checkEveryMs = Math.max(50, Math.min(CONNECTIONS_CHECKING_INTERVAL_MS, timing.graceMs));
  const reject = (route: RejectedRoute, method: string, status: number): void => {
    try {
      // The method comes from the client: only a plain upper-case token is passed on, so nothing else can reach a log line.
      options.onRejected?.(route, /^[A-Z]{1,16}$/.test(method) ? method : 'OTHER', status);
    } catch {
      // A failing hook must never change the response.
    }
  };

  const healthz = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    req.resume();
    const method = req.method ?? 'GET';
    if (method !== 'GET') {
      sendJson(res, 405, METHOD_NOT_ALLOWED, { allow: 'GET' });
      reject('healthz', method, 405);
      return;
    }
    options.health.report().then(
      ({ status, body }) => {
        sendJson(res, status, JSON.stringify(body));
        if (status >= 500) reject('healthz', method, status);
      },
      () => {
        sendJson(res, 500, INTERNAL);
        reject('healthz', method, 500);
      },
    );
  };

  /** Answers 408 too-slow when it still can, then closes the connection, so the rest of the body is never read. */
  const tooSlow = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const socket = req.socket;
    reject('slow-upload', req.method ?? 'POST', 408);
    if (res.headersSent) {
      socket.destroy();
      return;
    }
    res.writeHead(408, { ...BASE_HEADERS, connection: 'close', 'content-length': Buffer.byteLength(TOO_SLOW) });
    res.end(TOO_SLOW, () => socket.destroy());
    // A client that reads nothing never lets the answer drain: the connection is closed regardless.
    setTimeout(() => socket.destroy(), CONNECTIONS_CHECKING_INTERVAL_MS).unref();
  };

  /** The minimum-rate rule for one request's body (see RequestTiming). Bytes are counted on the connection, so the routes read the body as before. */
  const watchUpload = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (!carriesBody(req) || req.complete) return;
    const socket = req.socket;
    const started = Date.now();
    const before = socket.bytesRead;
    uploads.set(socket, { req, res });
    active.add(req);
    const stop = (): void => {
      clearInterval(timer);
      active.delete(req);
      if (uploads.get(socket)?.req === req) uploads.delete(socket);
    };
    const timer = setInterval(() => {
      if (req.complete || socket.destroyed) {
        stop();
        return;
      }
      const elapsed = Date.now() - started;
      if (elapsed <= timing.graceMs) return;
      const arrived = socket.bytesRead - before;
      if (arrived >= ((elapsed - timing.graceMs) / 1000) * timing.minBytesPerSecond) return;
      stop();
      tooSlow(req, res);
    }, checkEveryMs);
    timer.unref();
    res.once('close', stop);
  };

  // The literal route table. Paths are compared exactly, after the query is cut off.
  const routes: Readonly<Record<string, HubHandler>> = { '/healthz': healthz };

  // headersTimeout and requestTimeout are enforced only when Node checks the open connections, every 30 s by default, so a client that stalls
  // in its headers would be held for up to 30 s. Checking every second makes the 5 s header limit real. Bodies are timed by the minimum-rate
  // rule above; Node's whole-request limit stays only as a backstop sized for the largest body at that rate.
  const server = https.createServer(
    {
      cert: options.tls.cert,
      key: options.tls.key,
      minVersion: TLS_VERSION,
      maxVersion: TLS_VERSION,
      maxHeaderSize: MAX_HEADER_BYTES,
      connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS,
    },
    (req, res) => {
      watchUpload(req, res);
      const target = req.url ?? '/';
      const query = target.indexOf('?');
      const route = query < 0 ? target : target.slice(0, query);
      const own = Object.hasOwn(routes, route) ? routes[route] : undefined;
      if (own) {
        own(req, res);
        return;
      }
      if (options.handler) {
        options.handler(req, res);
        return;
      }
      req.resume();
      sendJson(res, 404, NOT_FOUND);
      reject('unknown', req.method ?? 'GET', 404);
    },
  );
  if (options.onSecureConnection) {
    const hook = options.onSecureConnection;
    server.on('secureConnection', (socket: TLSSocket) => {
      try {
        hook(socket);
      } catch {
        // A failing hook closes that connection only.
        socket.destroy();
      }
    });
  }

  server.headersTimeout = timing.headersMs;
  server.requestTimeout = requestBackstopMs(timing);
  server.keepAliveTimeout = timing.keepAliveMs;
  server.maxHeadersCount = 50;
  serverUploads.set(server, active);
  return server;
}

export function listen(server: https.Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}
