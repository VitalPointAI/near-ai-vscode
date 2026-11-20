// The hub's event streams (D-37): server-sent events, one stream per device per project, opened with GET /v1/projects/:p/events on the connection
// the device's session was opened on (32-RESEARCH.md prior art "Server-sent events").
//
// A stream starts with a retry: line holding a jittered reconnect delay. Every frame is `event: <name>`, `id: <n>` and `data: <compact JSON>` and a
// blank line; ids are a counter per connection starting at 1, used by the client for gap detection only. Last-Event-ID is never read: after any
// reconnect the client runs heads catch-up, so no event decides correctness. Frame data is built by the hub from what it stored, never from
// request text.
//
// Audiences are decided by the caller at send time (routes.ts reads them from the roster cache when it publishes), so a roster change is never
// outrun by a cached list.
import type http from 'node:http';

export const EVENT_NAMES = ['heads', 'presence', 'checkpoint', 'roster', 'equivocation', 'join-request', 'resync'] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const EVENT_TIMING = Object.freeze({
  /** The reconnect delay a stream starts with: 2 seconds plus a random jitter below 2 seconds, so devices do not all come back at once. */
  retryMs: 2000,
  retryJitterMs: 2000,
});

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

/** What a stream belongs to. */
export interface StreamOwner {
  project: string;
  writer: string;
}

export interface EventHubOptions {
  scheduler?: Scheduler;
  /** A number in [0, 1) for the retry jitter. */
  random?: () => number;
}

interface OpenStream extends StreamOwner {
  res: http.ServerResponse;
  nextId: number;
  closed: boolean;
}

const STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

export class EventHub {
  private readonly streams = new Set<OpenStream>();
  private readonly random: () => number;

  constructor(options: EventHubOptions = {}) {
    this.random = options.random ?? Math.random;
  }

  /** Opens a stream on this response for a device that has passed the session check. */
  open(res: http.ServerResponse, owner: StreamOwner): void {
    const stream: OpenStream = { project: owner.project, writer: owner.writer, res, nextId: 1, closed: false };
    this.streams.add(stream);
    res.on('close', () => this.forget(stream));
    res.writeHead(200, STREAM_HEADERS);
    res.socket?.setNoDelay(true);
    const retry = EVENT_TIMING.retryMs + Math.floor(this.random() * EVENT_TIMING.retryJitterMs);
    res.write(`retry: ${retry}\n\n`);
  }

  /** Writes one frame to every open stream of the project whose device is in the audience. Returns how many streams it was written to. */
  publish(project: string, audience: Audience, event: EventName, data: FrameData): number {
    let sent = 0;
    for (const stream of this.streams) {
      if (stream.closed || stream.project !== project || !audience(stream.writer)) continue;
      const id = stream.nextId;
      stream.nextId += 1;
      stream.res.write(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
      sent += 1;
    }
    return sent;
  }

  /** How many streams are open. */
  get size(): number {
    return this.streams.size;
  }

  /** Ends every stream, for shutdown. */
  closeAll(): void {
    for (const stream of [...this.streams]) {
      this.forget(stream);
      stream.res.end();
    }
  }

  private forget(stream: OpenStream): void {
    stream.closed = true;
    this.streams.delete(stream);
  }
}
