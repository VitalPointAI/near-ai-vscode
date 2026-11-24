// In-process fakes for the stage controller: a service, a clock and a measure. Nothing here talks to a cluster.
import type { Clock, SessionDriver, StageMeasure, Started } from '../../src/stages.ts';

export interface FakeClock extends Clock {
  readonly advance: (ms: number) => void;
}

/** A clock that never waits: sleeping moves time forward at once, and an abort ends the sleep. */
export function fakeClock(start = Date.UTC(2026, 10, 23, 12, 0, 0)): FakeClock {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      now += ms;
      await Promise.resolve();
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    }
  };
}

export interface FakeServiceOptions {
  readonly delayMs?: number;
  /** Returns true for the start numbers (0-based, in call order) that should fail. */
  readonly fails?: (call: number, user: string) => boolean;
  /** Called before each start, with the number of the call; can abort or advance time. */
  readonly onStart?: (call: number, user: string) => void;
  /** False for the session addresses that never answer. */
  readonly answers?: (url: string) => boolean;
}

export interface FakeService extends SessionDriver {
  readonly running: Set<string>;
  readonly stopped: string[];
  readonly activity: string[];
  readonly calls: () => number;
}

export function fakeService(clock: FakeClock, options: FakeServiceOptions = {}): FakeService {
  const running = new Set<string>();
  const stopped: string[] = [];
  const activity: string[] = [];
  let calls = 0;
  return {
    running,
    stopped,
    activity,
    calls: () => calls,
    startSession: async (user) => {
      const call = calls++;
      options.onStart?.(call, user);
      clock.advance(options.delayMs ?? 0);
      await Promise.resolve();
      if (options.fails?.(call, user)) throw new Error(`start refused for ${user}`);
      const sessionName = `ws-${user}`;
      running.add(sessionName);
      return { sessionName, url: `https://site.example/${sessionName}/` };
    },
    probe: async (url) => options.answers?.(url) ?? true,
    reportActivity: async (_user, sessionName) => { activity.push(sessionName); },
    stopSession: async (_user, sessionName) => { running.delete(sessionName); stopped.push(sessionName); }
  };
}

export interface FakeMeasureOptions {
  readonly pending?: (sessions: readonly Started[]) => number;
}

/** Start durations are the harness-observed times (first response minus request); everything else is empty. */
export function fakeMeasure(options: FakeMeasureOptions = {}): StageMeasure & { readonly windows: Array<{ start: number; end: number }> } {
  const windows: Array<{ start: number; end: number }> = [];
  return {
    windows,
    waitReady: async (sessions) => ({ pending: options.pending?.(sessions) ?? 0 }),
    startTimes: async (sessions, window) => {
      windows.push(window);
      const durations = sessions.filter((item) => item.requestedAt >= window.start && item.requestedAt < window.end && item.firstResponseAt !== null)
        .map((item) => (item.firstResponseAt as number) - item.requestedAt).sort((a, b) => a - b);
      return { reconcileMs: { cold: [], warm: [] }, readyMs: { cold: durations, warm: [] }, firstResponseMs: { cold: durations, warm: [] } };
    },
    reconcilesPer10s: async () => [],
    steady: async () => ({
      perPerson: { active: { sessions: 0, cpuMillicores: [], memoryBytes: [], volumeBytes: [] }, idle: { sessions: 0, cpuMillicores: [], memoryBytes: [] } },
      ingress: { samples: [], propagationMs: [], propagationUnmeasured: 0 },
      etcd: { dbSizeBytes: null, objects: null },
      queries: []
    })
  };
}

export function people(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `loadtest-user-${String(index + 1).padStart(4, '0')}`);
}
