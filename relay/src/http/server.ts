import http from 'node:http';
import type { HealthRegistry } from '../health';

// The relay's HTTP surface: a literal route table, no framework, no body parsing. Only GET /healthz exists in this phase; later phases add
// their webhook routes to the same table. Responses never echo the request path or any request data.

export type RejectedRoute = 'healthz' | 'unknown';

export interface RelayServerOptions {
  health: HealthRegistry;
  onRejected?: (route: RejectedRoute, method: string, status: number) => void;
}

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

export function createRelayServer(options: RelayServerOptions): http.Server {
  const reject = (route: RejectedRoute, method: string, status: number): void => {
    try {
      // The method comes from the client: only a plain upper-case token is passed on, so nothing else can reach a log line.
      options.onRejected?.(route, /^[A-Z]{1,16}$/.test(method) ? method : 'OTHER', status);
    } catch {
      // A failing hook must never change the response.
    }
  };

  const server = http.createServer((req, res) => {
    req.resume();
    const method = req.method ?? 'GET';
    const target = req.url ?? '/';
    const query = target.indexOf('?');
    const route = query < 0 ? target : target.slice(0, query);

    const send = (status: number, body: string, extra: Record<string, string> = {}): void => {
      res.writeHead(status, { ...BASE_HEADERS, ...extra, 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (route !== '/healthz') {
      send(404, '{"error":"not-found"}');
      reject('unknown', method, 404);
      return;
    }
    if (method !== 'GET') {
      send(405, '{"error":"method-not-allowed"}', { allow: 'GET' });
      reject('healthz', method, 405);
      return;
    }
    options.health.report().then(
      ({ status, body }) => {
        send(status, JSON.stringify(body));
        if (status >= 500) reject('healthz', method, status);
      },
      () => {
        send(500, '{"error":"internal"}');
        reject('healthz', method, 500);
      },
    );
  });

  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  return server;
}

export function listen(server: http.Server, host: string, port: number): Promise<number> {
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
