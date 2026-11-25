// The /v1/trust routes (Phase 71, 71-09; D-14, D-16, DCAC-06): the hub hosts your organization's people's did:webvh logs and its signed status
// lists, which every check reads. routes.ts mounts them; they live here so the project routes stay one file under its size limit.
//
//   GET  /v1/trust/did/<path>/did.jsonl          the log, byte for byte as stored          POST the whole log (it may only grow)
//   GET  /v1/trust/did/<path>/did-witness.json   the witness file, when the log has one    PUT  a witness file the held log verifies with
//   GET  /v1/trust/status/<name>                 the newest copy of a list                 PUT  the next version of a list
//
// <path> is the DID's own path, one segment per ':' part (did:webvh DID-to-HTTPS; '.well-known' for a DID with no path), and a status list's id in
// your organization's policy is https://<host>/v1/trust/status/<name>. The site's ingress maps the public addresses onto these routes.
//
// Who. Every route needs a session, as the project routes do (401 without one). Only a staff member's device is served: the roster at the hub's
// head must give the device's member the 'member' role. An observer, an outside observer's guest account, or anyone else the roster does not make
// a member is refused 403 on every trust route, logs and lists alike, so no staff identity reaches them (33.1 D-27, D-35). The answer names no DID
// and no key. The member kind comes from the hub's roster, never from a token claim or a group. Without your organization's policy, verified, the
// routes answer 503 with one sentence; the project routes keep working. No route deletes anything.
import type http from 'node:http';
import type { RosterCache } from '../append/rosterCache';
import { MAX_LOG_BYTES, MAX_STATUS_LIST_BYTES, MAX_WITNESS_BYTES, TRUST_REFUSALS } from '../store/trustStore';
import type { PutResult, TrustStore } from '../store/trustStore';
import { readBody, sendError } from './body';
import { BASE_HEADERS, sendJson } from './server';
import type { SessionRegistry } from './session';

export const TRUST_PREFIX = '/v1/trust/';

export const TRUST_ROUTE_TEXT = {
  'not-staff': 'Only staff members of a project on this hub can read identities and status lists here.',
} as const;

export interface TrustRouteDeps {
  trust: TrustStore;
  cache: RosterCache;
  sessions: SessionRegistry;
  now: () => number;
  /** Called after a new list version is stored, so the hub can end the event streams of members it now refuses. */
  onListStored?: () => void;
}

export type TrustHandler = (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => Promise<void>;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,99}$/;
const MAX_SEGMENTS = 16;
const LIST_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

type Target =
  | { kind: 'log'; path: string }
  | { kind: 'witness'; path: string }
  | { kind: 'list'; name: string };

/** The trust target a path names, or undefined for an address the trust routes do not have. */
export function trustTargetOf(pathname: string): Target | undefined {
  if (!pathname.startsWith(TRUST_PREFIX)) return undefined;
  const segments = pathname.slice(TRUST_PREFIX.length).split('/');
  if (segments[0] === 'status') return segments.length === 2 && LIST_NAME.test(segments[1] as string) ? { kind: 'list', name: segments[1] as string } : undefined;
  if (segments[0] !== 'did' || segments.length < 3) return undefined;
  const file = segments[segments.length - 1];
  const parts = segments.slice(1, -1);
  const wellKnown = parts.length === 1 && parts[0] === '.well-known';
  if (parts.length > MAX_SEGMENTS || (!wellKnown && !parts.every((part) => SEGMENT.test(part)))) return undefined;
  const path = parts.join('/');
  if (file === 'did.jsonl') return { kind: 'log', path };
  if (file === 'did-witness.json') return { kind: 'witness', path };
  return undefined;
}

const METHODS: Readonly<Record<Target['kind'], readonly string[]>> = { log: ['GET', 'POST'], witness: ['GET', 'PUT'], list: ['GET', 'PUT'] };

function sendText(res: http.ServerResponse, text: string, type: string): void {
  const bytes = Buffer.from(text, 'utf8');
  res.writeHead(200, { ...BASE_HEADERS, 'content-type': type, 'content-length': bytes.length });
  res.end(bytes);
}

function sendPut(res: http.ServerResponse, result: PutResult): void {
  if (result.ok) sendJson(res, result.stored ? 201 : 200, JSON.stringify({ stored: result.stored }));
  else sendJson(res, result.status, JSON.stringify({ error: result.reason, message: result.message }));
}

/** UTF-8 text when the bytes are exactly that, else undefined. */
function utf8(bytes: Buffer): string | undefined {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : undefined;
}

export function createTrustRoutes(deps: TrustRouteDeps): TrustHandler {
  const { trust, cache, sessions } = deps;

  /** The staff session of the request, or undefined after answering 401 or 403. */
  const staffOnly = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const auth = await sessions.authenticate(req);
    if (!auth.ok) {
      req.resume();
      sendJson(res, auth.status, JSON.stringify({ error: auth.status === 401 ? 'unauthenticated' : 'forbidden', reason: auth.reason, message: auth.message }));
      return false;
    }
    const roster = await cache.get(auth.session.project);
    const member = roster.view.deviceKey(auth.session.writer)?.member;
    if (member === undefined || !roster.view.hasRole(member, 'member', roster.head)) {
      req.resume();
      sendJson(res, 403, JSON.stringify({ error: 'forbidden', reason: 'not-staff', message: TRUST_ROUTE_TEXT['not-staff'] }));
      return false;
    }
    return true;
  };

  return async (req, res, pathname) => {
    const target = trustTargetOf(pathname);
    if (target === undefined) {
      req.resume();
      sendError(res, 404, 'not-found');
      return;
    }
    const method = req.method ?? 'GET';
    if (!METHODS[target.kind].includes(method)) {
      req.resume();
      sendError(res, 405, 'method-not-allowed', { allow: METHODS[target.kind].join(', ') });
      return;
    }
    if (!(await staffOnly(req, res))) return;
    const now = deps.now();
    if (!trust.policy(now).ok) {
      req.resume();
      sendJson(res, 503, JSON.stringify({ error: 'no-policy', message: TRUST_REFUSALS['no-policy'] }));
      return;
    }

    if (target.kind === 'list') {
      const entry = trust.listEntry(now, target.name);
      if (entry === undefined) {
        req.resume();
        sendError(res, 404, 'not-found');
        return;
      }
      if (method === 'GET') {
        req.resume();
        const held = trust.newestList(entry.uri);
        if (held === undefined) sendError(res, 404, 'not-found');
        else sendText(res, held.body, 'application/json; charset=utf-8');
        return;
      }
      const bytes = await readBody(req, res, MAX_STATUS_LIST_BYTES);
      if (bytes === undefined) return;
      const text = utf8(bytes);
      let value: unknown;
      try {
        value = text === undefined ? undefined : (JSON.parse(text) as unknown);
      } catch {
        value = undefined;
      }
      if (text === undefined || value === undefined) {
        sendError(res, 400, 'malformed');
        return;
      }
      const result = trust.putStatusList(entry, value, text, deps.now());
      sendPut(res, result);
      if (result.ok && result.stored) {
        try {
          deps.onListStored?.();
        } catch {
          // Ending streams never changes what the hub stored or answered.
        }
      }
      return;
    }

    if (method === 'GET') {
      req.resume();
      const held = trust.getLog(target.path);
      const text = target.kind === 'log' ? held?.log : held?.witness;
      if (text === undefined) sendError(res, 404, 'not-found');
      else sendText(res, text, target.kind === 'log' ? 'text/jsonl; charset=utf-8' : 'application/json; charset=utf-8');
      return;
    }
    const bytes = await readBody(req, res, target.kind === 'log' ? MAX_LOG_BYTES : MAX_WITNESS_BYTES);
    if (bytes === undefined) return;
    const text = utf8(bytes);
    if (text === undefined || text.length === 0) {
      sendError(res, 400, 'malformed');
      return;
    }
    sendPut(res, target.kind === 'log' ? trust.putLog(target.path, text, undefined, deps.now()) : trust.putWitness(target.path, text, deps.now()));
  };
}
