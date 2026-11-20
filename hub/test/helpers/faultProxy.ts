import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type http from 'node:http';
import type https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyFile } from '../../src/keys';
import { startHub } from './hubHarness';
import type { Hub, StartOptions } from './hubHarness';
import { makeTlsFixture } from './tlsFixture';
import type { TlsFixture } from './tlsFixture';

// The malicious-hub fault layer (Phase 32, plan 26; D-53). A hostile operator controls the hub process, so the layer sits inside it: it takes the
// hub's own request listener off the https server and puts one in front of it in the same process. The client's TLS connection still ends at the
// real hub, so the session answer stays bound to that connection's keying material (D-35), which a network proxy that ended TLS could never keep.
//
// For each request the layer may answer instead of the hub (refuse), hold the request before the hub sees it (delay), or let the hub answer and
// then rewrite, drop or hold what it answered (JSON and blob answers are buffered whole); event stream frames can be dropped one by one. The layer
// never changes hub source and never sees anything the hub does not already see: it reads the same request, the same store and the same answer.
//
// A rollback or a forked view needs the hub's state as it was: keptHub() keeps one hub's keys and certificate and starts instances of it on any
// state folder, so a test can stop it cleanly, copy the folder and start the same hub (or two of it) on the copies.

/** The routes a fault can name, from the path alone. */
export type FaultRoute = 'session' | 'enrol' | 'heads' | 'append' | 'entries' | 'events' | 'presence' | 'checkpoint' | 'blob-get' | 'blob-put' | 'other';

export interface FaultRequest {
  route: FaultRoute;
  method: string;
  /** The project in the path, when the route has one. */
  project?: string;
  query: URLSearchParams;
  /** The writer id of the device whose session the request carries, as the hub's own session check reads it; undefined without a session. */
  device?: string;
  req: http.IncomingMessage;
}

/** A whole answer: status, headers and body bytes. */
export interface FaultAnswer {
  status: number;
  headers: Record<string, string | number>;
  body: Buffer;
}

export interface FaultPlan {
  /** Answer instead of the hub: the request never reaches it. */
  refuse?(request: FaultRequest): FaultAnswer | undefined | Promise<FaultAnswer | undefined>;
  /** Hold the request before the hub sees it, until the promise settles. */
  hold?(request: FaultRequest): Promise<void> | undefined;
  /** Rewrite what the hub answered; 'drop' closes the connection with no answer. Return the answer itself to pass it on unchanged. */
  answer?(request: FaultRequest, answer: FaultAnswer): FaultAnswer | 'drop' | Promise<FaultAnswer | 'drop'>;
  /** One event stream frame as the hub wrote it; undefined drops it. */
  frame?(request: FaultRequest, frame: string): string | undefined;
}

export interface FaultLayer {
  /** Puts a plan in place for every request from now on; {} is honest. */
  set(plan: FaultPlan): void;
  clear(): void;
  /** How many requests each route saw, how many answers the plan changed and how many frames it dropped. */
  readonly stats: { requests: Record<string, number>; rewritten: number; refused: number; dropped: number; framesDropped: number };
  /** Puts the hub's own listeners back. */
  restore(): void;
}

const PROJECT_ROUTES: Readonly<Record<string, FaultRoute>> = {
  heads: 'heads', append: 'append', entries: 'entries', events: 'events', presence: 'presence', checkpoint: 'checkpoint'
};

function routeOf(method: string, pathname: string): { route: FaultRoute; project?: string } {
  const parts = pathname.split('/').filter((part) => part.length > 0);
  if (parts[0] !== 'v1') return { route: 'other' };
  if (parts.length === 2 && parts[1] === 'session') return { route: 'session' };
  if (parts.length === 2 && parts[1] === 'enrol') return { route: 'enrol' };
  if (parts.length === 4 && parts[1] === 'projects') return { route: PROJECT_ROUTES[parts[3] as string] ?? 'other', project: parts[2] };
  if (parts.length === 3 && parts[1] === 'blobs') return { route: method === 'PUT' ? 'blob-put' : 'blob-get' };
  return { route: 'other' };
}

/** A JSON answer as the hub writes one. */
export function jsonAnswer(status: number, value: unknown, extra: Record<string, string> = {}): FaultAnswer {
  return { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }, body: Buffer.from(JSON.stringify(value)) };
}

/** The answer's body as JSON; undefined when it is not JSON. */
export function readAnswer<T = Record<string, unknown>>(answer: FaultAnswer): T | undefined {
  try {
    return JSON.parse(answer.body.toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

/** The same answer with a new JSON body. */
export function withJson(answer: FaultAnswer, value: unknown): FaultAnswer {
  return { status: answer.status, headers: { ...answer.headers }, body: Buffer.from(JSON.stringify(value)) };
}

type Listener = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/**
 * Wraps the hub's request listener. identify, when given, names the device a request's session belongs to (pass the hub's own session check, which
 * only reads the request's token and socket).
 */
export function wrapHub(server: https.Server, options: { identify?: (req: http.IncomingMessage, project?: string) => Promise<string | undefined> } = {}): FaultLayer {
  const original = server.listeners('request') as Listener[];
  server.removeAllListeners('request');
  let plan: FaultPlan = {};
  const stats: FaultLayer['stats'] = { requests: {}, rewritten: 0, refused: 0, dropped: 0, framesDropped: 0 };
  const pass = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    for (const listener of original) listener.call(server, req, res);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const target = req.url ?? '/';
    const at = target.indexOf('?');
    const pathname = at < 0 ? target : target.slice(0, at);
    const method = req.method ?? 'GET';
    const { route, project } = routeOf(method, pathname);
    stats.requests[route] = (stats.requests[route] ?? 0) + 1;
    const current = plan;
    if (current.refuse === undefined && current.hold === undefined && current.answer === undefined && current.frame === undefined) {
      pass(req, res);
      return;
    }
    const hasToken = typeof req.headers.authorization === 'string';
    const device = hasToken && options.identify !== undefined ? await options.identify(req, project) : undefined;
    const request: FaultRequest = { route, method, query: new URLSearchParams(at < 0 ? '' : target.slice(at + 1)), req, ...(project === undefined ? {} : { project }), ...(device === undefined ? {} : { device }) };

    const instead = current.refuse === undefined ? undefined : await current.refuse(request);
    if (instead !== undefined) {
      stats.refused += 1;
      req.resume();
      res.writeHead(instead.status, { ...instead.headers, 'content-length': instead.body.length });
      res.end(instead.body);
      return;
    }
    const held = current.hold?.(request);
    if (held !== undefined) await held;

    if (route === 'events' && current.frame !== undefined) {
      const write = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
      const filter = current.frame;
      (res as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]): boolean => {
        const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : undefined;
        if (text === undefined || !text.includes('\n\n') || text.startsWith(':') || text.startsWith('retry:')) return write(chunk, ...rest);
        const kept = filter(request, text);
        if (kept === undefined) {
          stats.framesDropped += 1;
          const done = rest.find((item) => typeof item === 'function') as (() => void) | undefined;
          if (done !== undefined) queueMicrotask(done);
          return true;
        }
        return write(kept, ...rest);
      };
      pass(req, res);
      return;
    }

    if (current.answer === undefined || route === 'events') {
      pass(req, res);
      return;
    }
    // Buffer the hub's whole answer: the routes write a status and headers once and the body with end().
    const rewrite = current.answer;
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => http.ServerResponse;
    const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
    let status = 200;
    let headers: Record<string, string | number> = {};
    const chunks: Buffer[] = [];
    const patched = res as unknown as Record<string, unknown>;
    patched.writeHead = (code: number, ...rest: unknown[]): http.ServerResponse => {
      status = code;
      const given = rest.find((item) => typeof item === 'object' && item !== null) as Record<string, string | number> | undefined;
      if (given !== undefined) headers = { ...given };
      return res;
    };
    patched.write = (chunk: unknown): boolean => {
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') chunks.push(Buffer.from(chunk as string));
      return true;
    };
    patched.end = (...args: unknown[]): http.ServerResponse => {
      const chunk = args[0];
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') chunks.push(Buffer.from(chunk as string));
      delete patched.writeHead;
      delete patched.write;
      delete patched.end;
      void (async () => {
        const given: FaultAnswer = { status, headers, body: Buffer.concat(chunks) };
        const changed = await rewrite(request, given);
        if (changed === 'drop') {
          stats.dropped += 1;
          res.socket?.destroy();
          return;
        }
        if (changed !== given) stats.rewritten += 1;
        const out = { ...changed.headers };
        for (const key of Object.keys(out)) if (key.toLowerCase() === 'content-length') delete out[key];
        writeHead(changed.status, { ...out, 'content-length': changed.body.length });
        end(changed.body);
      })();
      return res;
    };
    pass(req, res);
  };

  const listener: Listener = (req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end();
    });
  };
  server.on('request', listener);

  return {
    set(next) {
      plan = next;
    },
    clear() {
      plan = {};
    },
    stats,
    restore() {
      server.removeListener('request', listener);
      for (const item of original) server.on('request', item);
    },
  };
}

/** wrapHub on a harness hub, with the hub's own session check naming the device. */
export function wrapHarnessHub(hub: Hub): FaultLayer {
  return wrapHub(hub.server, {
    identify: async (req, project) => {
      const auth = await hub.sessions.authenticate(req, project);
      return auth.ok ? auth.session.writer : undefined;
    },
  });
}

/** One hub's identity kept across instances: its key lines and TLS pair, and a folder for its state folders and their copies. */
export interface KeptHub {
  root: string;
  keys: { signing: string; encryption: string };
  tls: TlsFixture;
  /** A new empty state folder under the root. */
  folder(name: string): string;
  /** Copies a closed hub's state folder to a new folder under the root (the operator's cold backup) and returns its path. */
  copy(from: string, name: string): string;
  /** Replaces a state folder with a copy of another (the operator's restore). */
  restore(backup: string, into: string): void;
  /** Starts this hub on a state folder, with its own keys and certificate. */
  start(dir: string, options?: Omit<StartOptions, 'dir' | 'keys' | 'tls'>): Promise<Hub>;
  /** Removes the root and the certificate files. Close every instance first. */
  cleanup(): void;
}

export function keptHub(): KeptHub {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-kept-'));
  const tls = makeTlsFixture();
  const keys = { signing: generateKeyFile('signing'), encryption: generateKeyFile('encryption') };
  const copyInto = (from: string, to: string): void => {
    cpSync(from, to, { recursive: true });
    chmodSync(to, 0o700);
  };
  return {
    root,
    keys,
    tls,
    folder(name) {
      const dir = path.join(root, name);
      mkdirSync(dir, { mode: 0o700 });
      return dir;
    },
    copy(from, name) {
      const to = path.join(root, name);
      copyInto(from, to);
      return to;
    },
    restore(backup, into) {
      rmSync(into, { recursive: true, force: true });
      copyInto(backup, into);
    },
    start(dir, options = {}) {
      return startHub({ ...options, dir, keys, tls });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      tls.cleanup();
    },
  };
}
