// The stage controller (Phase 48 D-02, D-20): ramp to each stage's target through the Theia Cloud service, hold a steady state while the bulk
// sessions report activity, measure, start a burst on top, measure it, stop the burst and move on. Everything it touches is injected: the
// session driver (service.ts), the measure (measure.ts) and the clock, so the tests run it against fakes.
import type { StageResult, StartTimes, Window } from './runfile.ts';

export interface Clock {
  readonly now: () => number;
  /** Waits `ms`, or rejects when the signal aborts. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The service calls the controller makes, by test-realm user; the driver holds the tokens, the controller never sees one. */
export interface SessionDriver {
  readonly startSession: (user: string, signal?: AbortSignal) => Promise<{ readonly sessionName: string; readonly url: string }>;
  /** True when the session's address answers successfully through the ingress. */
  readonly probe: (url: string, signal?: AbortSignal) => Promise<boolean>;
  readonly reportActivity: (user: string, sessionName: string) => Promise<void>;
  readonly stopSession: (user: string, sessionName: string) => Promise<void>;
}

/** A session the controller started, with the times the harness itself saw. */
export interface Started {
  readonly user: string;
  readonly sessionName: string;
  readonly url: string;
  readonly requestedAt: number;
  readonly firstResponseAt: number | null;
}

export type MeasuredStarts = Pick<StartTimes, 'reconcileMs' | 'readyMs' | 'firstResponseMs'>;
export type MeasuredSteady = Pick<StageResult, 'perPerson' | 'ingress' | 'etcd' | 'queries'>;

/** What the controller asks of the cluster's own records and metrics (measure.ts). */
export interface StageMeasure {
  /** Waits up to `limitMs` for the sessions' pods to be Ready; returns how many are still Pending. */
  readonly waitReady: (sessions: readonly Started[], limitMs: number, signal?: AbortSignal) => Promise<{ readonly pending: number }>;
  /** Start durations of the sessions whose request time falls in [window.start, window.end). */
  readonly startTimes: (sessions: readonly Started[], window: Window) => Promise<MeasuredStarts>;
  /** Deployments created per 10-second window in the window, ascending. */
  readonly reconcilesPer10s: (window: Window) => Promise<number[]>;
  /** Per-person use, the shared Ingress and etcd over the hold window; `active` names the active-sample sessions. */
  readonly steady: (input: { readonly sessions: readonly Started[]; readonly active: readonly string[]; readonly window: Window }) => Promise<MeasuredSteady>;
}

export interface StagePlan {
  readonly stages: readonly number[];
  readonly burst: number;
  readonly holdMs: number;
  readonly activityIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly rampConcurrency: number;
  readonly startTimeoutMs: number;
  readonly pendingLimitMs: number;
  readonly maxFailedPercent: number;
}

export interface RunStagesInput {
  readonly plan: StagePlan;
  /** One test-realm identity per simulated person (research Pitfall 9); needs the top target plus the burst. */
  readonly people: readonly string[];
  readonly service: SessionDriver;
  readonly measure: StageMeasure;
  readonly clock: Clock;
  readonly signal?: AbortSignal;
}

export interface StagesOutcome {
  readonly stages: StageResult[];
  readonly peakConcurrency: number;
}

interface StartOutcome { readonly started: Started[]; readonly failed: number; readonly timedOut: number }

const emptyDurations = (): MeasuredStarts => ({ reconcileMs: { cold: [], warm: [] }, readyMs: { cold: [], warm: [] }, firstResponseMs: { cold: [], warm: [] } });

/** Starts one session and polls its address until it answers or the start timeout passes. */
async function startOne(input: RunStagesInput, user: string): Promise<Started | 'failed'> {
  const { service, clock, plan, signal } = input;
  const requestedAt = clock.now();
  let session: { sessionName: string; url: string };
  try {
    session = await service.startSession(user, signal);
  } catch {
    if (signal?.aborted) throw signal.reason ?? new Error('interrupted');
    return 'failed';
  }
  while (clock.now() - requestedAt < plan.startTimeoutMs) {
    if (await service.probe(session.url, signal).catch(() => false)) return { user, sessionName: session.sessionName, url: session.url, requestedAt, firstResponseAt: clock.now() };
    await clock.sleep(plan.pollIntervalMs, signal);
  }
  return { user, sessionName: session.sessionName, url: session.url, requestedAt, firstResponseAt: null };
}

/** Starts sessions for `users`, at most `concurrency` at a time. */
async function startMany(input: RunStagesInput, users: readonly string[], concurrency: number): Promise<StartOutcome> {
  const started: Started[] = [];
  let failed = 0;
  let timedOut = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < users.length) {
      const user = users[next++];
      const outcome = await startOne(input, user);
      if (outcome === 'failed') failed += 1;
      else { started.push(outcome); if (outcome.firstResponseAt === null) timedOut += 1; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, users.length)) }, worker));
  return { started, failed, timedOut };
}

async function stopAll(service: SessionDriver, sessions: Iterable<Started>): Promise<void> {
  await Promise.all([...sessions].map((item) => service.stopSession(item.user, item.sessionName).catch(() => undefined)));
}

async function hold(input: RunStagesInput, sessions: readonly Started[]): Promise<void> {
  const { clock, plan, service, signal } = input;
  const until = clock.now() + plan.holdMs;
  while (clock.now() < until) {
    await Promise.all(sessions.map((item) => service.reportActivity(item.user, item.sessionName).catch(() => undefined)));
    await clock.sleep(Math.min(plan.activityIntervalMs, until - clock.now()), signal);
  }
}

/** Runs the plan's stages in ascending order; every session it started is stopped before it returns. */
export async function runStages(input: RunStagesInput): Promise<StagesOutcome> {
  const { plan, clock, measure, service } = input;
  const targets = [...plan.stages].sort((a, b) => a - b);
  const bulk: Started[] = [];
  const stages: StageResult[] = [];
  let peak = 0;
  try {
    for (const target of targets) {
      const rampStart = clock.now();
      const rampUsers = input.people.slice(bulk.length, target);
      const ramp = await startMany(input, rampUsers, plan.rampConcurrency);
      bulk.push(...ramp.started.filter((item) => item.firstResponseAt !== null));
      await measure.waitReady(bulk, plan.pendingLimitMs, input.signal);
      const holdStart = clock.now();
      await hold(input, bulk);
      const holdEnd = clock.now();
      const steady = await measure.steady({ sessions: bulk, active: [], window: { start: holdStart, end: holdEnd } });
      const burstStart = clock.now();
      const burst = await startMany(input, input.people.slice(target, target + plan.burst), plan.burst);
      const peakConcurrency = bulk.length + burst.started.filter((item) => item.firstResponseAt !== null).length;
      peak = Math.max(peak, peakConcurrency);
      await stopAll(service, burst.started);
      const burstEnd = clock.now();
      const rampWindow = { start: rampStart, end: burstStart };
      const burstWindow = { start: burstStart, end: burstEnd };
      stages.push({
        target,
        reached: true,
        reason: '',
        window: { start: rampStart, end: burstEnd },
        sessions: bulk.length,
        start: { requested: rampUsers.length, failed: ramp.failed, timedOut: ramp.timedOut, ...(await measure.startTimes(ramp.started, rampWindow)) },
        burst: {
          size: plan.burst, reached: true, reason: '', peakConcurrency, window: burstWindow,
          start: { requested: plan.burst, failed: burst.failed, timedOut: burst.timedOut, ...(plan.burst > 0 ? await measure.startTimes(burst.started, burstWindow) : emptyDurations()) },
          reconcilesPer10s: await measure.reconcilesPer10s(burstWindow)
        },
        ...steady
      });
    }
  } finally {
    await stopAll(service, bulk);
  }
  return { stages, peakConcurrency: peak };
}
