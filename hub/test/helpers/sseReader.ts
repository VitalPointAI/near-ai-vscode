import assert from 'node:assert/strict';
import type http from 'node:http';
import https from 'node:https';
import { buildSessionAnswer } from '@ext/domain/replica/hubFile';
import type { PayloadSigner } from '@ext/domain/team/signedPayload';
import type { Scheduler, Timer } from '../../src/live/events';
import type { HubConnection, HubResponse } from './hubClient';

/** What a reader needs of a hub: the in-process test hub (hubHarness.ts) or a hub process the test reaches by port and pin. */
export interface HubEndpoint {
  port: number;
  /** Milliseconds; the time a session answer is signed at. */
  now(): number;
  connect(): Promise<HubConnection>;
}

// The event stream as a device reads it (32-21), over the same pinned TLS connection its session was opened on. Every request here is written
// straight onto that one socket (no agent pools it), with connection: keep-alive, so a stream that ends leaves the connection usable for the next
// request and the token bound to it. The reader parses the stream into frames {event, id, data}, comment lines and retry lines, counts the bytes it
// read, and can pause the socket so the hub sees a stuck reader. All data is fictional.

export interface Frame {
  event: string;
  id: string | undefined;
  data: unknown;
}

export interface CallOptions {
  json?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

/** One request on the connection's own socket, answered in full. */
export function callOn(connection: HubConnection, port: number, method: string, target: string, options: CallOptions = {}): Promise<HubResponse> {
  return new Promise((resolve, reject) => {
    const request = rawRequest(connection, port, method, target, options, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body, text, json: <T>() => JSON.parse(text) as T });
      });
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

function rawRequest(connection: HubConnection, port: number, method: string, target: string, options: CallOptions, onResponse: (response: http.IncomingMessage) => void): http.ClientRequest {
  const headers: Record<string, string> = { connection: 'keep-alive', ...(options.headers ?? {}) };
  let body: Buffer | undefined;
  if (options.json !== undefined) {
    body = Buffer.from(JSON.stringify(options.json), 'utf8');
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(body.length);
  }
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const request = https.request({ createConnection: () => connection.socket, host: '127.0.0.1', port, method, path: target, headers }, onResponse);
  request.end(body);
  return request;
}

/** One open event stream, or the answer that refused it. */
export class EventStream {
  readonly frames: Frame[] = [];
  readonly comments: string[] = [];
  readonly retries: number[] = [];
  /** Bytes of the response body read so far. */
  bytes = 0;
  ended = false;
  private text = '';
  private readonly waiters = new Set<() => void>();

  constructor(
    readonly response: http.IncomingMessage,
    private readonly connection: HubConnection,
  ) {
    response.on('data', (chunk: Buffer) => {
      this.bytes += chunk.length;
      this.text += chunk.toString('utf8');
      this.parse();
      this.wake();
    });
    const done = (): void => {
      this.ended = true;
      this.wake();
    };
    response.on('end', done);
    response.on('close', done);
    response.on('error', done);
  }

  get status(): number {
    return this.response.statusCode ?? 0;
  }

  get headers(): http.IncomingHttpHeaders {
    return this.response.headers;
  }

  /** The body read so far, for a refused stream. */
  get body(): string {
    return this.text;
  }

  private parse(): void {
    for (;;) {
      const at = this.text.indexOf('\n\n');
      if (at < 0) return;
      const block = this.text.slice(0, at);
      this.text = this.text.slice(at + 2);
      const fields = new Map<string, string>();
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) {
          this.comments.push(line);
          continue;
        }
        const colon = line.indexOf(':');
        const name = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        fields.set(name, value);
      }
      if (fields.has('retry')) this.retries.push(Number(fields.get('retry')));
      if (fields.has('event') || fields.has('data')) {
        const data = fields.get('data');
        this.frames.push({ event: fields.get('event') ?? 'message', id: fields.get('id'), data: data === undefined ? undefined : (JSON.parse(data) as unknown) });
      }
    }
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  /** Waits until the condition holds, failing after ms. */
  until(condition: (stream: EventStream) => boolean, what: string, ms = 5000): Promise<void> {
    if (condition(this)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`timed out waiting for ${what}; frames ${JSON.stringify(this.frames.map((frame) => frame.event))}, ended ${this.ended}`));
      }, ms);
      const check = (): void => {
        if (!condition(this)) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      this.waiters.add(check);
    });
  }

  /** The nth frame (1-based), once it has arrived. */
  async frame(n: number, ms = 5000): Promise<Frame> {
    await this.until((stream) => stream.frames.length >= n, `frame ${n}`, ms);
    return this.frames[n - 1] as Frame;
  }

  /** Resolves when the stream has ended. */
  async end(ms = 5000): Promise<void> {
    await this.until((stream) => stream.ended, 'the end of the stream', ms);
  }

  /** Stops reading: the response and the socket are paused, so the hub's writes back up. */
  pause(): void {
    this.response.pause();
    this.connection.socket.pause();
  }

  resume(): void {
    this.connection.socket.resume();
    this.response.resume();
  }

  /** Ends the stream from the client side by closing the connection. */
  close(): void {
    this.connection.close();
  }
}

/** A device's connection with a session, opened with requests written straight on its socket. */
export class EventClient {
  private constructor(
    readonly hub: HubEndpoint,
    readonly connection: HubConnection,
    readonly token: string,
    readonly project: string,
  ) {}

  static async open(hub: HubEndpoint, device: { signer: PayloadSigner }, project: string): Promise<EventClient> {
    const connection = await hub.connect();
    const challenge = await callOn(connection, hub.port, 'POST', '/v1/session', { json: { project } });
    assert.equal(challenge.status, 200, challenge.text);
    const body = challenge.json<{ hub: string; challenge: string }>();
    const answer = buildSessionAnswer(device.signer, { hub: body.hub, project, challenge: body.challenge, keying: connection.keying(), now: new Date(hub.now()) });
    const opened = await callOn(connection, hub.port, 'POST', '/v1/session', { json: { answer } });
    assert.equal(opened.status, 200, opened.text);
    return new EventClient(hub, connection, opened.json<{ token: string }>().token, project);
  }

  call(method: string, target: string, options: CallOptions = {}): Promise<HubResponse> {
    return callOn(this.connection, this.hub.port, method, target, { token: this.token, ...options });
  }

  /** GET /v1/projects/:p/events; resolves once the answer's headers have arrived. */
  events(options: { token?: string; headers?: Record<string, string>; project?: string } = {}): Promise<EventStream> {
    const project = options.project ?? this.project;
    return new Promise((resolve, reject) => {
      const request = rawRequest(
        this.connection,
        this.hub.port,
        'GET',
        `/v1/projects/${project}/events`,
        { token: options.token ?? this.token, headers: { accept: 'text/event-stream', ...(options.headers ?? {}) } },
        (response) => resolve(new EventStream(response, this.connection)),
      );
      request.on('error', reject);
    });
  }

  close(): void {
    this.connection.close();
  }
}

/** A scheduler the test moves by hand. onAdvance is called with each step, so the hub's clock can move with it. */
export class ManualScheduler implements Scheduler {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; every?: number; run: () => void }>();
  onAdvance: (ms: number) => void = () => undefined;

  setTimeout(run: () => void, ms: number): Timer {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, run });
    return id;
  }

  clearTimeout(timer: Timer): void {
    this.timers.delete(timer as number);
  }

  setInterval(run: () => void, ms: number): Timer {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, every: ms, run });
    return id;
  }

  clearInterval(timer: Timer): void {
    this.timers.delete(timer as number);
  }

  /** How many timers are set. */
  get pending(): number {
    return this.timers.size;
  }

  /** Moves time forward by ms, running every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let next: [number, { at: number; every?: number; run: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= target && (next === undefined || entry[1].at < next[1].at)) next = entry;
      if (next === undefined) break;
      const [id, timer] = next;
      this.step(timer.at - this.time);
      if (timer.every === undefined) this.timers.delete(id);
      else timer.at += timer.every;
      timer.run();
    }
    this.step(target - this.time);
  }

  private step(ms: number): void {
    if (ms <= 0) return;
    this.time += ms;
    this.onAdvance(ms);
  }
}
