// Copied from relay/src/http/server.ts and adapted for the hub (D-28): node:https instead of node:http, TLS 1.3 only (D-29).
import type http from 'node:http';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { HealthRegistry } from '../health';

// The hub's HTTPS surface: a literal route table, no framework, no body parsing here. The hub ends TLS itself with the operator's certificate, so
// a device's session answer can bind to this TLS connection's keying material (D-29, D-35). Only TLS 1.3 is offered: a TLS 1.2 client fails the
// handshake, and a plain HTTP client never gets an answer. GET /healthz is the one route this file owns; the hub's /v1 routes (32-20) arrive
// through `handler`. Responses never echo the request path or any request data.

export type RejectedRoute = 'healthz' | 'unknown';

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

export function createHubServer(options: HubServerOptions): https.Server {
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

  // The literal route table. Paths are compared exactly, after the query is cut off.
  const routes: Readonly<Record<string, HubHandler>> = { '/healthz': healthz };

  // headersTimeout and requestTimeout are enforced only when Node checks the open connections, every 30 s by default, so a client that stalls
  // in its headers would be held for up to 30 s. Checking every second makes the 5 s and 10 s limits real.
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

  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
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
