// The hub's event streams (D-37): server-sent events, one stream per device per project, opened with GET /v1/projects/:p/events on the connection
// the device's session was opened on (32-RESEARCH.md prior art "Server-sent events", Pitfall 3).
//
// A stream starts with a retry: line holding a jittered reconnect delay. Every frame is `event: <name>`, `id: <n>` and `data: <compact JSON>` and a
// blank line; ids are a counter per connection starting at 1, used by the client for gap detection only. Last-Event-ID is never read: after any
// reconnect the client runs heads catch-up, so no event decides correctness. Frame data is built by the hub from what it stored, never from
// request text. A comment line every 15 seconds keeps proxies from closing a quiet stream.
//
// States (D-58): open; replaced (a second stream for the same device and project ends the first); refused 429 past 4 streams per device or 300 per
// address (LIMITS, WR-04) (the route answers 204 before this file for a token or standing that does not pass); ended by the client; ended by the hub when the
// roster revokes or quarantines the device (routes.ts calls end), when the session's token expires (seen at the next keep-alive tick), when the
// unsent budget runs out (resync, then the end), or at shutdown (closeAll).
//
// Memory (T-32-80). Each connection has a 1 MiB unsent budget: the bytes Node holds for the response (writableLength) plus the frames this file
// queued. While write() returns false the hub queues frames here and waits for 'drain' instead of handing Node more. A frame that would take the
// unsent bytes past the budget is not queued: resync goes in its place, the queue drains, and the stream ends. So a stuck reader costs at most the
// budget plus one frame, and a reader that never reads again is cut off 30 seconds after its budget ran out.
//
// Audiences are decided by the caller at send time (routes.ts reads them from the roster cache when it publishes), so a roster change is never
// outrun by a cached list. The in-process channel tells 32-22's checkpoint signer when entries were accepted and when a client asked for a checkpoint.
import type http from 'node:http';
import { LIMITS } from '../limits';

export const EVENT_NAMES = ['heads', 'presence', 'checkpoint', 'roster', 'equivocation', 'join-request', 'resync'] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const EVENT_TIMING = Object.freeze({
  /** The reconnect delay a stream starts with: 2 seconds plus a random jitter below 2 seconds, so devices do not all come back at once. */
  retryMs: 2000,
  retryJitterMs: 2000,
  /** A comment line this often keeps proxies open. */
  keepAliveMs: 15_000,
  /** A stream whose budget ran out and whose reader has not drained the queue by then is cut off. */
  stuckMs: 30_000,
  /** Retry-After of a refused stream. */
  retryAfterSeconds: 30,
});

/** The unsent bytes one connection may hold (D-37). */
export const EVENT_BUDGET_BYTES = 1024 * 1024;

const KEEP_ALIVE = ': keep-alive\n\n';

/** A timer handle of a Scheduler. */
export type Timer = unknown;

/** The timers the event streams use; real timers (unref'd) unless a test moves time by hand. */
export interface Scheduler {
  setTimeout(run: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
  setInterval(run: () => void, ms: number): Timer;
  clearInterval(timer: Timer): void;
}

export const realScheduler: Scheduler = {
  setTimeout(run, ms) {
    const timer = setTimeout(run, ms);
    timer.unref();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  setInterval(run, ms) {
    const timer = setInterval(run, ms);
    timer.unref();
    return timer;
  },
  clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
};

/** Who hears an event: decided per device at send time. */
export type Audience = (writer: string) => boolean;
export type FrameData = Record<string, unknown>;
/** The data of one event, the same for every device or built per device (undefined: nothing for that device). */
export type FrameSource = FrameData | ((writer: string) => FrameData | undefined);

/** What a stream belongs to. */
export interface StreamOwner {
  project: string;
  writer: string;
}

/** Everything the route knows about a stream it opens. */
export interface StreamSession extends StreamOwner {
  /** The client's address, for the per-address limit. */
  address: string;
  /** When the session's token expires, in milliseconds. */
  expiresAt: number;
  /**
   * Asked at every keep-alive tick: false ends the stream (the device is no longer admitted at the roster head). A promise is waited for (the
   * roster is not in memory and is loaded again); one that fails ends the stream, so a check that cannot be made never keeps a stream open (IN-07).
   */
  allowed: () => boolean | Promise<boolean>;
}

export type OpenResult = { ok: true } | { ok: false; status: 429; reason: 'device' | 'address'; retryAfterSeconds: number };

export type LiveSignal = 'entries' | 'checkpoint';

/** The in-process channel: entries accepted for a project, and a client asked for a checkpoint of a project. */
export class LiveChannel {
  private readonly listeners: Record<LiveSignal, Set<(project: string) => void>> = { entries: new Set(), checkpoint: new Set() };

  /** Listens for a signal; returns the function that stops listening. */
  on(signal: LiveSignal, listener: (project: string) => void): () => void {
    this.listeners[signal].add(listener);
    return () => {
      this.listeners[signal].delete(listener);
    };
  }

  emit(signal: LiveSignal, project: string): void {
    for (const listener of [...this.listeners[signal]]) {
      try {
        listener(project);
      } catch {
        // A failing listener never changes what the hub answered or sends.
      }
    }
  }
}

export interface StreamStats extends StreamOwner {
  /** Bytes handed to the response so far. */
  handed: number;
  /** Bytes handed to the response when the budget ran out (all handed so far when it has not). */
  handedAtOverflow: number;
  /** Bytes queued when the budget ran out, resync included (0 when it has not). */
  queuedAtOverflow: number;
  /** Unsent bytes now: Node's buffer for the response plus the queue. */
  unsent: number;
  overflowed: boolean;
}

export interface EventHubOptions {
  scheduler?: Scheduler;
  /** A number in [0, 1) for the retry jitter. */
  random?: () => number;
  /** Milliseconds; the clock token expiry is checked against. */
  now?: () => number;
  budgetBytes?: number;
  /** Streams one address may hold; LIMITS.eventStreamsPerAddress unless a test lowers it. */
  streamsPerAddress?: number;
}

interface OpenStream extends StreamSession {
  res: http.ServerResponse;
  nextId: number;
  queue: string[];
  queued: number;
  waiting: boolean;
  /** No more frames are taken: resync is queued, or the stream is being ended. */
  ending: boolean;
  closed: boolean;
  overflowed: boolean;
  handed: number;
  handedAtOverflow: number | undefined;
  queuedAtOverflow: number;
  keepAlive: Timer;
  stuck: Timer | undefined;
  /** A standing check that had to load the roster is still running. */
  checking: boolean;
}

const STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

export class EventHub {
  readonly channel = new LiveChannel();
  private readonly streams = new Set<OpenStream>();
  private readonly scheduler: Scheduler;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly budget: number;
  private readonly perAddress: number;
  private peak = 0;

  constructor(options: EventHubOptions = {}) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.budget = options.budgetBytes ?? EVENT_BUDGET_BYTES;
    this.perAddress = options.streamsPerAddress ?? LIMITS.eventStreamsPerAddress;
  }

  /**
   * Opens a stream on this response for a device that has passed the session check. A stream the device already has for this project is ended
   * first; past 4 streams of the device (across projects) or 300 from the address nothing is written and the caller answers 429.
   */
  open(res: http.ServerResponse, session: StreamSession): OpenResult {
    const replaced = [...this.streams].filter((stream) => stream.writer === session.writer && stream.project === session.project);
    const others = [...this.streams].filter((stream) => !replaced.includes(stream));
    if (others.filter((stream) => stream.writer === session.writer).length >= LIMITS.eventStreamsPerDevice) {
      return { ok: false, status: 429, reason: 'device', retryAfterSeconds: EVENT_TIMING.retryAfterSeconds };
    }
    if (others.filter((stream) => stream.address === session.address).length >= this.perAddress) {
      return { ok: false, status: 429, reason: 'address', retryAfterSeconds: EVENT_TIMING.retryAfterSeconds };
    }
    for (const stream of replaced) this.finish(stream);

    const stream: OpenStream = {
      ...session,
      res,
      nextId: 1,
      queue: [],
      queued: 0,
      waiting: false,
      ending: false,
      closed: false,
      overflowed: false,
      handed: 0,
      handedAtOverflow: undefined,
      queuedAtOverflow: 0,
      keepAlive: undefined,
      stuck: undefined,
      checking: false,
    };
    this.streams.add(stream);
    res.on('close', () => this.forget(stream));
    res.writeHead(200, STREAM_HEADERS);
    res.socket?.setNoDelay(true);
    const retry = EVENT_TIMING.retryMs + Math.floor(this.random() * EVENT_TIMING.retryJitterMs);
    this.send(stream, `retry: ${retry}\n\n`);
    stream.keepAlive = this.scheduler.setInterval(() => this.keepAlive(stream), EVENT_TIMING.keepAliveMs);
    return { ok: true };
  }

  /** Writes one frame to every open stream of the project whose device is in the audience. Returns how many streams took it. */
  publish(project: string, audience: Audience, event: EventName, data: FrameSource): number {
    let sent = 0;
    for (const stream of [...this.streams]) {
      if (stream.ending || stream.project !== project || !audience(stream.writer)) continue;
      const payload = typeof data === 'function' ? data(stream.writer) : data;
      if (payload === undefined) continue;
      if (this.frame(stream, event, payload)) sent += 1;
    }
    return sent;
  }

  /** Ends, without another frame, every stream whose owner matches. Returns how many were ended. */
  end(match: (owner: StreamOwner) => boolean): number {
    let ended = 0;
    for (const stream of [...this.streams]) {
      if (!match({ project: stream.project, writer: stream.writer })) continue;
      this.finish(stream);
      ended += 1;
    }
    return ended;
  }

  /** Ends every stream, for shutdown. */
  closeAll(): void {
    for (const stream of [...this.streams]) this.finish(stream);
  }

  /** How many streams are open. */
  get size(): number {
    return this.streams.size;
  }

  /** The most unsent bytes any open stream holds now. */
  unsentBytes(): number {
    let most = 0;
    for (const stream of this.streams) most = Math.max(most, this.unsentOf(stream));
    return most;
  }

  /** The most unsent bytes any stream has held since the hub started. */
  peakUnsentBytes(): number {
    return this.peak;
  }

  stats(): StreamStats[] {
    return [...this.streams].map((stream) => ({
      project: stream.project,
      writer: stream.writer,
      handed: stream.handed,
      handedAtOverflow: stream.handedAtOverflow ?? stream.handed,
      queuedAtOverflow: stream.queuedAtOverflow,
      unsent: this.unsentOf(stream),
      overflowed: stream.overflowed,
    }));
  }

  private unsentOf(stream: OpenStream): number {
    return stream.res.writableLength + stream.queued;
  }

  private note(stream: OpenStream): void {
    this.peak = Math.max(this.peak, this.unsentOf(stream));
  }

  private keepAlive(stream: OpenStream): void {
    if (stream.ending || stream.checking) return;
    if (this.now() >= stream.expiresAt) {
      this.finish(stream);
      return;
    }
    let verdict: boolean | Promise<boolean>;
    try {
      verdict = stream.allowed();
    } catch {
      this.finish(stream);
      return;
    }
    if (typeof verdict === 'boolean') {
      this.afterCheck(stream, verdict);
      return;
    }
    stream.checking = true;
    verdict.then(
      (allowed) => {
        stream.checking = false;
        this.afterCheck(stream, allowed === true);
      },
      () => {
        stream.checking = false;
        this.afterCheck(stream, false);
      },
    );
  }

  /** The keep-alive comment for a device still admitted; the end of the stream otherwise. */
  private afterCheck(stream: OpenStream, allowed: boolean): void {
    if (stream.ending || stream.closed) return;
    if (allowed) this.send(stream, KEEP_ALIVE);
    else this.finish(stream);
  }

  /** One numbered frame, or resync and the end when it would take the stream past its budget. Returns whether the frame was taken. */
  private frame(stream: OpenStream, event: EventName, data: FrameData): boolean {
    const text = `event: ${event}\nid: ${stream.nextId}\ndata: ${JSON.stringify(data)}\n\n`;
    if (!this.send(stream, text)) return false;
    stream.nextId += 1;
    return true;
  }

  /** Hands text to the response, or queues it while the response waits for drain. False when the budget would be passed (the stream then ends). */
  private send(stream: OpenStream, text: string): boolean {
    if (stream.ending) return false;
    const size = Buffer.byteLength(text);
    if (this.unsentOf(stream) + size > this.budget) {
      this.overflow(stream);
      return false;
    }
    if (stream.waiting) {
      stream.queue.push(text);
      stream.queued += size;
      this.note(stream);
      return true;
    }
    this.hand(stream, text, size);
    return true;
  }

  private hand(stream: OpenStream, text: string, size: number): void {
    stream.handed += size;
    const more = stream.res.write(text);
    this.note(stream);
    if (!more && !stream.waiting) {
      stream.waiting = true;
      stream.res.once('drain', () => this.drain(stream));
    }
  }

  /** The budget ran out: resync goes at the end of the queue, nothing more is taken, and the stream ends once the reader has drained it. */
  private overflow(stream: OpenStream): void {
    stream.overflowed = true;
    stream.handedAtOverflow = stream.handed;
    const text = `event: resync\nid: ${stream.nextId}\ndata: ${JSON.stringify({ project: stream.project })}\n\n`;
    stream.nextId += 1;
    stream.ending = true;
    this.scheduler.clearInterval(stream.keepAlive);
    stream.stuck = this.scheduler.setTimeout(() => {
      if (!stream.closed) stream.res.destroy();
    }, EVENT_TIMING.stuckMs);
    const size = Buffer.byteLength(text);
    stream.queue.push(text);
    stream.queued += size;
    stream.queuedAtOverflow = stream.queued;
    this.note(stream);
    if (!stream.waiting) this.drain(stream);
  }

  /** Hands queued frames to the response until it asks to wait again; ends the stream once an ending stream's queue is empty. */
  private drain(stream: OpenStream): void {
    stream.waiting = false;
    if (stream.closed) return;
    while (stream.queue.length > 0) {
      const text = stream.queue.shift() as string;
      const size = Buffer.byteLength(text);
      stream.queued -= size;
      this.hand(stream, text, size);
      if (stream.waiting) return;
    }
    if (stream.ending) this.close(stream);
  }

  /** Ends the stream now, dropping anything still queued. */
  private finish(stream: OpenStream): void {
    stream.ending = true;
    stream.queue.length = 0;
    stream.queued = 0;
    this.close(stream);
  }

  private close(stream: OpenStream): void {
    this.forget(stream);
    stream.res.end();
  }

  private forget(stream: OpenStream): void {
    if (stream.closed) return;
    stream.closed = true;
    this.scheduler.clearInterval(stream.keepAlive);
    if (stream.stuck !== undefined) this.scheduler.clearTimeout(stream.stuck);
    this.streams.delete(stream);
  }
}
