/**
 * The answer to Theia Cloud's activity tracker (Theia Cloud 1.2.0, MonitorActivityTracker; the same protocol as its monitor-theia extension).
 * Each minute the operator calls, through the session's own oauth2-proxy (which lets /monitor/* through without sign-in):
 *
 *   GET  /monitor/activity/lastActivity   Authorization: Bearer <the session secret>   200 with the last use in epoch milliseconds, as text
 *   POST /monitor/activity/popup          the same header                              200; the browser then warns the person
 *
 * Without a 200 the operator keeps the time the session started, so a session that never answers stops timeoutAfter minutes after it
 * started, however much it is used. The session secret is THEIACLOUD_SESSION_SECRET, set per session by the operator; the tracker is on
 * only when THEIACLOUD_MONITOR_ENABLE_ACTIVITY_TRACKER is `true`. Every other /monitor path, the operator's free-text /monitor/message
 * included, is 404: the workbench shows only its own words. An answer carries a number or one fixed word, never anything about the person.
 * Nothing here imports Theia.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { SessionActivityState } from '../common/session-activity.js';

export const SessionActivity = Symbol('SessionActivity');

export interface MonitorAnswer {
  readonly status: number;
  readonly body: string;
}

export interface SessionActivity {
  /** The person used the page: the last use is now, and any warning is over. */
  report(): SessionActivityState;
  state(): SessionActivityState;
  /** The answer to a request under /monitor, or undefined for any other path (the request is not the tracker's). */
  answer(method: string, path: string, authorization: string | undefined): MonitorAnswer | undefined;
}

const LAST_ACTIVITY = '/monitor/activity/lastActivity';
const POPUP = '/monitor/activity/popup';
const BEARER = /^Bearer ([^\s]+)$/;

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** True only for exactly `Bearer <secret>`, compared in constant time. */
function authorized(secret: string, header: string | undefined): boolean {
  const token = header === undefined ? undefined : BEARER.exec(header)?.[1];
  return token !== undefined && timingSafeEqual(digest(token), digest(secret));
}

export function createSessionActivity(env: NodeJS.ProcessEnv, clock: () => number = Date.now): SessionActivity {
  const secret = env.THEIACLOUD_SESSION_SECRET?.trim() ?? '';
  const enabled = secret !== '' && env.THEIACLOUD_MONITOR_ENABLE_ACTIVITY_TRACKER?.trim() === 'true';
  // Until the person first uses the page, the session's start is its last use (the operator's own starting point).
  let lastUse = clock();
  let warned = false;
  const state = (): SessionActivityState => (!enabled ? 'off' : warned ? 'idle-warned' : 'active');

  return {
    report() {
      if (enabled) {
        lastUse = Math.max(lastUse, clock());
        warned = false;
      }
      return state();
    },
    state,
    answer(method, path, authorization) {
      if (path !== '/monitor' && !path.startsWith('/monitor/')) return undefined;
      if (!enabled) return { status: 404, body: 'Not found' };
      if (!authorized(secret, authorization)) return { status: 401, body: 'Unauthorized' };
      if (method === 'GET' && path === LAST_ACTIVITY) return { status: 200, body: String(lastUse) };
      if (method === 'POST' && path === POPUP) {
        warned = true;
        return { status: 200, body: 'ok' };
      }
      return { status: 404, body: 'Not found' };
    },
  };
}

/** The workbench's port (bin/start.mjs passes it to Theia; the AppDefinition's port and monitor port). */
export const WORKBENCH_PORT = 3000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

/**
 * Where Theia Cloud's activity tracker reaches the session, when that is not where Theia listens (workbench/README.md, STERLING_LISTEN_HOST).
 * The operator calls the app port on the pod's own address (its session-...-int Service), not through the oauth2-proxy sidecar, while the
 * sidecar reaches Theia on 127.0.0.1. So in hosted mode a pod IP in STERLING_LISTEN_HOST (downward API status.podIP) keeps Theia on loopback
 * (bin/start.mjs) and opens only the tracker's answers on that address. Undefined in local mode, and when the setting is unset, loopback or a
 * wildcard (Theia itself answers there). In hosted mode anything else that is not one IP address stops the backend, naming the setting.
 */
export function trackerAddress(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.STERLING_OPENBAO_ADDR?.trim()) return undefined;
  const host = env.STERLING_LISTEN_HOST?.trim();
  if (!host || LOOPBACK_HOSTS.has(host) || WILDCARD_HOSTS.has(host)) return undefined;
  if (net.isIP(host) === 0) {
    throw new Error('STERLING_LISTEN_HOST must be 127.0.0.1, 0.0.0.0 or the pod\'s IP address (status.podIP) in hosted mode.');
  }
  return host;
}

/**
 * The listener on the tracker address: the tracker's answers and a plain 404 for every other path, so the pod address serves nothing of the
 * workbench itself (no page, no WebSocket, no file, no terminal); those stay behind the sidecar's sign-in on loopback. No body is read.
 */
export function createTrackerServer(activity: SessionActivity): http.Server {
  const server = http.createServer((request, response) => {
    request.resume();
    let path = '/';
    try {
      path = new URL(request.url ?? '/', 'http://tracker.invalid').pathname;
    } catch {
      // A target that is not a path is answered 404 below.
    }
    const answer = activity.answer(request.method ?? '', path, request.headers.authorization) ?? { status: 404, body: 'Not found' };
    response.writeHead(answer.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(answer.body);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  return server;
}
