// A scripted stand-in for your organization's sync hub (32-23), for the transport and one-shot sync tests: an HTTPS server on 127.0.0.1 with the
// cyber fixture certificate, TLS 1.3 only, the hub's session protocol (a challenge per connection, the answer checked with readSessionAnswer against
// the hub's writer id, the project, the challenge and that connection's keying material, a token bound to that connection), a log of every request
// with the connection it came on, and scripted answers. Tokens are never logged by value: the log says which connection's token a request carried.
// All data is fictional.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { entryHash } from '../../domain/replica/entry';
import type { SealedEntry } from '../../domain/replica/entry';
import { SESSION_KEYING_BYTES, SESSION_KEYING_LABEL, readSessionAnswer } from '../../domain/replica/hubFile';
import { canonicalBytes } from '../../domain/team/canonical';

export const CERTS_DIR = path.resolve(__dirname, '../../../test/fixtures/cyber/certs');
export const FIXTURE_CA = readFileSync(path.join(CERTS_DIR, 'patched', 'ca.pem'), 'utf8');
export const FIXTURE_CERT = readFileSync(path.join(CERTS_DIR, 'patched', 'server.pem'), 'utf8');
const FIXTURE_KEY = readFileSync(path.join(CERTS_DIR, 'patched', 'server.key'), 'utf8');
/** A self-signed certificate the fixture CA did not issue. */
export const OTHER_CERT = readFileSync(path.join(CERTS_DIR, 'vulnerable', 'server.pem'), 'utf8');
const OTHER_KEY = readFileSync(path.join(CERTS_DIR, 'vulnerable', 'server.key'), 'utf8');

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** The connection this request came on, numbered from 1 in the order the server accepted them. */
  connection: number;
  /** The connection whose session issued the token this request carried; undefined when it carried none, 0 for a token the server never issued. */
  tokenOf?: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
  json(): unknown;
}

export interface FakeAnswer {
  status?: number;
  json?: unknown;
  bytes?: Buffer;
  headers?: Record<string, string>;
  /** Destroy the connection without answering. */
  destroy?: boolean;
  /** Answer, then close the connection (as the hub does after its idle timeout). */
  closeAfter?: boolean;
  /** Take over the response, for a stream. */
  stream?: (res: ServerResponse) => void;
}

export type FakeHandler = (req: FakeRequest) => FakeAnswer | Promise<FakeAnswer>;

/** One session answer the server read; features is what the device signed it announces (POST-01, D-07). */
export interface SessionSeen { connection: number; keying: Buffer; answerOk: boolean; reason?: string; features?: string[] }

export interface FakeHubOptions {
  project: string;
  /** The hub's writer id the challenge names and the answer must sign. */
  hub: string;
  /** Present the self-signed certificate the fixture CA did not issue. */
  otherCert?: boolean;
  /** Every call after the session. */
  handle?: FakeHandler;
  /** Overrides the challenge or answer step: return an answer to send instead of the built-in one. */
  session?: (step: 'challenge' | 'answer', req: FakeRequest) => FakeAnswer | undefined;
  /** Answer the token check of each call: undefined lets the built-in one decide. */
  tokenCheck?: (req: FakeRequest) => FakeAnswer | undefined;
}

export class FakeHubServer {
  public readonly requests: FakeRequest[] = [];
  public readonly sessions: SessionSeen[] = [];
  public port = 0;
  private readonly server: https.Server;
  private readonly sockets = new Map<TLSSocket, number>();
  private readonly challenges = new Map<number, Buffer>();
  private readonly tokens = new Map<string, number>();
  private readonly forgotten: string[] = [];
  private connectionCount = 0;

  private constructor(private readonly options: FakeHubOptions) {
    this.server = https.createServer({
      cert: options.otherCert === true ? OTHER_CERT : FIXTURE_CERT,
      key: options.otherCert === true ? OTHER_KEY : FIXTURE_KEY,
      minVersion: 'TLSv1.3'
    }, (req, res) => { void this.serve(req, res); });
    this.server.on('secureConnection', (socket: TLSSocket) => {
      this.connectionCount += 1;
      this.sockets.set(socket, this.connectionCount);
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.server.keepAliveTimeout = 60_000;
  }

  public static async start(options: FakeHubOptions): Promise<FakeHubServer> {
    const fake = new FakeHubServer(options);
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    fake.port = (fake.server.address() as AddressInfo).port;
    return fake;
  }

  public get address(): string {
    return `127.0.0.1:${this.port}`;
  }

  /** How many TLS connections finished their handshake. */
  public get connections(): number {
    return this.connectionCount;
  }

  /** Requests other than the session calls. */
  public calls(): FakeRequest[] {
    return this.requests.filter((req) => req.path !== '/v1/session');
  }

  /** Closes every open connection, as the hub does to an idle one. */
  public dropConnections(): void {
    for (const socket of this.sockets.keys()) socket.destroy();
  }

  /** The token texts this server issued, only so a test can search what the client saved for them. */
  public issuedTokens(): string[] {
    return [...this.forgotten, ...this.tokens.keys()];
  }

  /** Forgets every token, so the next call is refused unknown-token. */
  public forgetTokens(): void {
    for (const token of this.tokens.keys()) this.forgotten.push(token);
    this.tokens.clear();
  }

  public async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const socket = req.socket as TLSSocket;
    const connection = this.sockets.get(socket) ?? 0;
    const url = new URL(req.url ?? '/', 'https://hub.invalid');
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const request: FakeRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      connection,
      headers: req.headers,
      body,
      json: () => JSON.parse(body.toString('utf8')) as unknown
    };
    if (token !== undefined) request.tokenOf = this.tokens.get(token) ?? 0;
    this.requests.push(request);
    let answer: FakeAnswer;
    try {
      answer = await this.answer(request, socket, token);
    } catch (error) {
      answer = { status: 500, json: { error: 'internal', message: String(error) } };
    }
    this.send(res, socket, answer);
  }

  private async answer(req: FakeRequest, socket: TLSSocket, token: string | undefined): Promise<FakeAnswer> {
    if (req.path === '/v1/session') return this.session(req, socket);
    if (req.path === '/v1/enrol') return this.options.handle?.(req) ?? { status: 404, json: { error: 'not-found', message: 'Nothing here.' } };
    const scripted = this.options.tokenCheck?.(req);
    if (scripted !== undefined) return scripted;
    if (token === undefined) return { status: 401, json: { error: 'unauthenticated', reason: 'no-token', message: 'No token.' } };
    const owner = this.tokens.get(token);
    if (owner === undefined) return { status: 401, json: { error: 'unauthenticated', reason: 'unknown-token', message: 'Unknown token.' } };
    if (owner !== req.connection) return { status: 401, json: { error: 'unauthenticated', reason: 'other-connection', message: 'Other connection.' } };
    return this.options.handle?.(req) ?? { status: 404, json: { error: 'not-found', message: 'Nothing here.' } };
  }

  private session(req: FakeRequest, socket: TLSSocket): FakeAnswer {
    let value: unknown;
    try {
      value = req.json();
    } catch {
      return { status: 400, json: { error: 'malformed', message: 'Malformed.' } };
    }
    const step = typeof value === 'object' && value !== null && 'answer' in value ? 'answer' : 'challenge';
    const scripted = this.options.session?.(step, req);
    if (scripted !== undefined) return scripted;
    if (step === 'challenge') {
      const challenge = randomBytes(32);
      this.challenges.set(req.connection, challenge);
      return { json: { project: this.options.project, hub: this.options.hub, challenge: challenge.toString('base64url') } };
    }
    const challenge = this.challenges.get(req.connection);
    this.challenges.delete(req.connection);
    const keying = socket.exportKeyingMaterial(SESSION_KEYING_BYTES, SESSION_KEYING_LABEL, undefined as unknown as Buffer);
    const read = challenge === undefined
      ? { ok: false as const, reason: 'wrong-challenge' }
      : readSessionAnswer((value as { answer: unknown }).answer, { hub: this.options.hub, project: this.options.project, challenge, keying });
    this.sessions.push({ connection: req.connection, keying, answerOk: read.ok, ...(read.ok ? { features: read.features } : { reason: read.reason }) });
    if (!read.ok) return { status: 403, json: { error: 'session-refused', reason: read.reason, message: 'Refused.' } };
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(token, req.connection);
    return { json: { project: this.options.project, token, expiresAt: '2026-11-20T10:15:00.000Z' } };
  }

  private send(res: ServerResponse, socket: TLSSocket, answer: FakeAnswer): void {
    if (answer.destroy === true) {
      socket.destroy();
      return;
    }
    if (answer.stream !== undefined) {
      answer.stream(res);
      return;
    }
    const headers: Record<string, string | number> = { 'cache-control': 'no-store', ...(answer.headers ?? {}) };
    let payload: Buffer;
    if (answer.bytes !== undefined) {
      payload = answer.bytes;
      headers['content-type'] ??= 'application/octet-stream';
    } else {
      payload = Buffer.from(JSON.stringify(answer.json ?? {}), 'utf8');
      headers['content-type'] ??= 'application/json';
    }
    if (headers['content-length'] === undefined && headers['transfer-encoding'] === undefined) headers['content-length'] = payload.length;
    if (answer.closeAfter === true) headers.connection = 'close';
    res.writeHead(answer.status ?? 200, headers);
    res.end(payload, () => { if (answer.closeAfter === true) socket.end(); });
  }
}

// ---- a scripted hub with state, for the one-shot sync tests ----

/** What the scripted hub holds and how it misbehaves. Every knob is off by default, so the hub is honest. */
export interface FakeHubState {
  project: string;
  rosterHead: string;
  /** Entries per stream and writer, in seq order. */
  logs: Map<string, SealedEntry[]>;
  blobs: Map<string, Buffer>;
  /** Signed grants by hash. */
  grants: Map<string, unknown>;
  /** The latest checkpoint heads, append and entries attach. */
  checkpoint?: unknown;
  /** What the checkpoint ask answers with; the latest checkpoint when absent. */
  askAnswer?: unknown;
  /** Checkpoints handed back through the ask, in order. */
  handedBack: unknown[];
  appends: Array<{ entries: SealedEntry[]; grants: unknown[]; blobRefs: Array<{ entry: string; blob: string }> }>;
  /** Entries per page. */
  pageSize: number;
  /** Faults. */
  reversePages?: boolean;
  /** Writers whose pages leave out this seq. */
  skipSeq?: Map<string, number>;
  /** Extra raw entries added to every page of this writer. */
  extra?: Map<string, unknown[]>;
  /** Blob hashes served with other bytes. */
  corruptBlobs?: Set<string>;
  /** Heads answers name another project. */
  wrongProjectHeads?: string;
  /** Heads answers show these writer heads instead of the real ones (key stream/writer). */
  headsOverride?: Map<string, { seq: number; hash: string }>;
  /**
   * Grants the hub places only once an entry is held, as a cell's grant needs its cell.create (grant hash to that entry's hash), and the entries the
   * grant opens, refused not-on-access-list until it is placed. A grant offered before then is refused grant-not-placed.
   */
  grantRules?: Map<string, { after: string; opens: ReadonlySet<string> }>;
}

const sha256OfBytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const logKey = (stream: string, writer: string): string => `${stream}/${writer}`;

export function fakeHubState(project: string, rosterHead: string): FakeHubState {
  return { project, rosterHead, logs: new Map(), blobs: new Map(), grants: new Map(), handedBack: [], appends: [], pageSize: 1000 };
}

/** Puts entries in the scripted hub as an honest hub holds them: per writer, in seq order. */
export function seedHub(state: FakeHubState, entries: readonly SealedEntry[]): void {
  for (const entry of entries) {
    const key = logKey(entry.header.stream, entry.header.writer);
    const log = state.logs.get(key) ?? [];
    if (log.some((item) => entryHash(item.header) === entryHash(entry.header))) continue;
    log.push(entry);
    log.sort((a, b) => a.header.seq - b.header.seq);
    state.logs.set(key, log);
  }
}

export function seedGrants(state: FakeHubState, grants: readonly unknown[]): void {
  for (const grant of grants) state.grants.set(sha256OfBytes(canonicalBytes(grant)), grant);
}

/** The routes of the scripted hub: heads, entries, append, blobs and the checkpoint ask, shaped like hub/src/http/routes.ts. */
export function hubRoutes(state: FakeHubState): FakeHandler {
  const withCheckpoint = (body: Record<string, unknown>): Record<string, unknown> => (state.checkpoint === undefined ? body : { ...body, checkpoint: state.checkpoint });
  return (req) => {
    const base = `/v1/projects/${state.project}`;
    if (req.method === 'GET' && req.path === `${base}/heads`) {
      const streams = new Map<string, Array<{ writer: string; seq: number; hash: string }>>();
      for (const log of state.logs.values()) {
        const last = log[log.length - 1];
        if (last === undefined) continue;
        const override = state.headsOverride?.get(logKey(last.header.stream, last.header.writer));
        const row = streams.get(last.header.stream) ?? [];
        row.push({ writer: last.header.writer, seq: override?.seq ?? last.header.seq, hash: override?.hash ?? entryHash(last.header) });
        streams.set(last.header.stream, row);
      }
      return { json: withCheckpoint({ project: state.wrongProjectHeads ?? state.project, rosterHead: state.rosterHead, streams: [...streams].map(([stream, heads]) => ({ stream, heads })), grants: [...state.grants.keys()] }) };
    }
    if (req.method === 'GET' && req.path === `${base}/entries`) {
      const stream = req.query.get('stream') as string;
      const writer = req.query.get('writer') as string;
      const from = Number(req.query.get('from'));
      const key = logKey(stream, writer);
      const skip = state.skipSeq?.get(key);
      const all = (state.logs.get(key) ?? []).filter((entry) => entry.header.seq >= from && entry.header.seq !== skip);
      const page: unknown[] = all.slice(0, state.pageSize);
      const last = page[page.length - 1] as SealedEntry | undefined;
      const head = last === undefined ? null : { seq: last.header.seq, hash: entryHash(last.header) };
      const listed = [...page, ...(state.extra?.get(key) ?? [])];
      if (state.reversePages === true) listed.reverse();
      return { json: withCheckpoint({ project: state.project, stream, writer, entries: listed, more: all.length > page.length, head }) };
    }
    if (req.method === 'POST' && req.path === `${base}/append`) {
      const body = req.json() as { entries: SealedEntry[]; grants?: unknown[]; blobRefs?: Array<{ entry: string; blob: string }> };
      for (const ref of body.blobRefs ?? []) if (!state.blobs.has(ref.blob)) return { status: 409, json: { error: 'blob-missing', message: 'Missing.' } };
      state.appends.push({ entries: body.entries, grants: body.grants ?? [], blobRefs: body.blobRefs ?? [] });
      const offered = (body.grants ?? []).map((grant, index) => ({ index, grant, hash: sha256OfBytes(canonicalBytes(grant)) }));
      const holds = (hash: string): boolean => [...state.logs.values()].some((log) => log.some((item) => entryHash(item.header) === hash));
      const place = (): void => {
        for (const item of offered) {
          const rule = state.grantRules?.get(item.hash);
          if (rule === undefined || holds(rule.after)) seedGrants(state, [item.grant]);
        }
      };
      place();
      const accepted: string[] = [];
      const refused: Array<{ index: number; hash: string; reason: string }> = [];
      body.entries.forEach((entry, index) => {
        const hash = entryHash(entry.header);
        const gate = [...(state.grantRules ?? [])].find(([, rule]) => rule.opens.has(hash))?.[0];
        if (gate !== undefined && !state.grants.has(gate)) {
          place();
          if (!state.grants.has(gate)) { refused.push({ index, hash, reason: 'not-on-access-list' }); return; }
        }
        const key = logKey(entry.header.stream, entry.header.writer);
        const log = state.logs.get(key) ?? [];
        const last = log[log.length - 1];
        if (log.some((item) => entryHash(item.header) === hash)) { accepted.push(hash); return; }
        if (entry.header.seq !== (last === undefined ? 0 : last.header.seq + 1)) { refused.push({ index, hash, reason: 'seq-gap' }); return; }
        if (entry.header.prev !== (last === undefined ? '0'.repeat(64) : entryHash(last.header))) { refused.push({ index, hash, reason: 'prev-mismatch' }); return; }
        log.push(entry);
        state.logs.set(key, log);
        accepted.push(hash);
      });
      place();
      const grantsRefused = offered.filter((item) => !state.grants.has(item.hash)).map((item) => ({ index: item.index, reason: 'grant-not-placed' }));
      return { json: withCheckpoint({ project: state.project, accepted, refused, rosterHead: state.rosterHead, ...(grantsRefused.length === 0 ? {} : { grantsRefused }) }) };
    }
    if (req.method === 'PUT' && req.path.startsWith('/v1/blobs/')) {
      const hash = req.path.slice('/v1/blobs/'.length);
      if (sha256OfBytes(req.body) !== hash) return { status: 400, json: { error: 'blob-mismatch', message: 'Mismatch.' } };
      const had = state.blobs.has(hash);
      state.blobs.set(hash, req.body);
      return { status: had ? 200 : 201, json: { project: state.project, hash } };
    }
    if (req.method === 'GET' && req.path.startsWith('/v1/blobs/')) {
      const hash = req.path.slice('/v1/blobs/'.length);
      const grant = state.grants.get(hash);
      if (grant !== undefined) return { bytes: canonicalBytes(grant), headers: { 'x-near-ai-project': state.project } };
      const bytes = state.blobs.get(hash);
      if (bytes === undefined) return { status: 404, json: { error: 'not-found', message: 'Nothing here.' } };
      return { bytes: state.corruptBlobs?.has(hash) === true ? Buffer.concat([bytes, Buffer.from('!')]) : bytes, headers: { 'x-near-ai-project': state.project } };
    }
    if (req.method === 'POST' && req.path === `${base}/checkpoint`) {
      const known = (req.json() as { known?: unknown[] }).known ?? [];
      state.handedBack.push(...known);
      const answer = state.askAnswer ?? state.checkpoint;
      return { json: { project: state.project, kept: known.length, ...(answer === undefined ? {} : { checkpoint: answer }) } };
    }
    return { status: 404, json: { error: 'not-found', message: 'Nothing here.' } };
  };
}
