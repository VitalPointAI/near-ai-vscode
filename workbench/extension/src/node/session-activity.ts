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
