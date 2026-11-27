// The stage controller (Phase 48 D-02, D-10, D-20): ramp to each stage's target through the Theia Cloud service, hold a steady state while the
// bulk sessions report activity, measure, start a burst on top, measure it, stop the burst and move on. Everything it touches is injected: the
// session driver (service.ts), the measure (measure.ts) and the clock, so the tests run it against fakes.
import type { StageResult, StartTimes, Window } from './runfile.ts';
import type { HubSmoke } from './hub.ts';

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
  /** One test-realm identity per simulated person (research Pitfall 9); needs the top target, the burst and any failed starts. */
  readonly people: readonly string[];
  readonly service: SessionDriver;
  readonly measure: StageMeasure;
  readonly clock: Clock;
  readonly signal?: AbortSignal;
  readonly hubs?: (signal?: AbortSignal) => Promise<HubSmoke>;
  /** Completed local fixture samples supplied as data. Ordinary load runs do not supply these. */
  readonly localSamples?: readonly { readonly sessionName: string; readonly finishedAt: number }[];
}

export interface StagesOutcome {
  readonly stages: StageResult[];
  readonly peakConcurrency: number;
}

interface StartOutcome { readonly started: Started[]; readonly failed: number; readonly timedOut: number }

const emptyDurations = (): MeasuredStarts => ({ reconcileMs: { cold: [], warm: [] }, readyMs: { cold: [], warm: [] }, firstResponseMs: { cold: [], warm: [] } });
const counted = (requested: number, outcome?: StartOutcome): StartTimes => ({ requested, failed: outcome?.failed ?? 0, timedOut: outcome?.timedOut ?? 0, ...emptyDurations() });
const grouped = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const answered = (sessions: readonly Started[]): Started[] => sessions.filter((item) => item.firstResponseAt !== null);

/** Thrown inside a stage when the run's signal aborts; the stage is then recorded as interrupted. */
class Interrupted extends Error {}

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Interrupted('interrupted');
}

/** Starts one session and polls its address until it answers or the start timeout passes. Every started session goes into `live` at once. */
async function startOne(input: RunStagesInput, user: string, live: Map<string, Started>): Promise<Started | 'failed'> {
  const { service, clock, plan, signal } = input;
  const requestedAt = clock.now();
  let session: { sessionName: string; url: string };
  try {
    session = await service.startSession(user, signal);
  } catch {
    checkSignal(signal);
    return 'failed';
  }
  const waiting: Started = { user, sessionName: session.sessionName, url: session.url, requestedAt, firstResponseAt: null };
  live.set(session.sessionName, waiting);
  while (clock.now() - requestedAt < plan.startTimeoutMs) {
    checkSignal(signal);
    if (await service.probe(session.url, signal).catch(() => false)) {
      const done = { ...waiting, firstResponseAt: clock.now() };
      live.set(session.sessionName, done);
      return done;
    }
    await clock.sleep(plan.pollIntervalMs, signal).catch(() => checkSignal(signal));
  }
  return waiting;
}

/** Starts sessions for `users`, at most `concurrency` at a time; waits for every worker before it returns or throws, so none is left behind. */
async function startMany(input: RunStagesInput, users: readonly string[], concurrency: number, live: Map<string, Started>): Promise<StartOutcome> {
  const started: Started[] = [];
  let failed = 0;
  let timedOut = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < users.length) {
      checkSignal(input.signal);
      const outcome = await startOne(input, users[next++], live);
      if (outcome === 'failed') failed += 1;
      else { started.push(outcome); if (outcome.firstResponseAt === null) timedOut += 1; }
    }
  };
  if (users.length === 0) return { started, failed, timedOut };
  const settled = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(concurrency, users.length)) }, worker));
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (rejected) throw rejected.reason;
  return { started, failed, timedOut };
}

async function stopAll(service: SessionDriver, sessions: readonly Started[], live: Map<string, Started>): Promise<void> {
  await Promise.all(sessions.map(async (item) => {
    live.delete(item.sessionName);
    await service.stopSession(item.user, item.sessionName).catch(() => undefined);
  }));
}

/** Why a set of starts is not reached, or null: failures and timeouts together above the configured share. */
function startFailure(requested: number, outcome: StartOutcome, plan: StagePlan): string | null {
  if (requested === 0 || (outcome.failed + outcome.timedOut) * 100 <= plan.maxFailedPercent * requested) return null;
  const parts: string[] = [];
  if (outcome.failed > 0) parts.push(`${grouped(outcome.failed)} of ${grouped(requested)} starts failed`);
  if (outcome.timedOut > 0) parts.push(`${grouped(outcome.timedOut)} of ${grouped(requested)} starts timed out after ${grouped(plan.startTimeoutMs)} ms`);
  return `${parts.join('; ')} (above the ${grouped(plan.maxFailedPercent)}% limit)`;
}

const pendingReason = (pending: number, plan: StagePlan): string => `${grouped(pending)} pods Pending past ${grouped(plan.pendingLimitMs)} ms`;

async function hold(input: RunStagesInput, sessions: readonly Started[]): Promise<void> {
  const { clock, plan, service, signal } = input;
  const until = clock.now() + plan.holdMs;
  while (clock.now() < until) {
    checkSignal(signal);
    await Promise.all(sessions.map((item) => service.reportActivity(item.user, item.sessionName).catch(() => undefined)));
    await clock.sleep(Math.max(1, Math.min(plan.activityIntervalMs, until - clock.now())), signal).catch(() => checkSignal(signal));
  }
}

function unreached(target: number, reason: string, sessions: number, window: Window, start: StartTimes, burstSize: number): StageResult {
  return {
    target, reached: false, reason, window, sessions, start,
    burst: { size: burstSize, reached: false, reason: 'not attempted', peakConcurrency: 0, window: { start: window.end, end: window.end }, start: counted(0), reconcilesPer10s: [] },
    perPerson: { active: { sessions: 0, cpuMillicores: [], memoryBytes: [], volumeBytes: [] }, idle: { sessions: 0, cpuMillicores: [], memoryBytes: [] } },
    ingress: { samples: [], propagationMs: [], propagationUnmeasured: 0 },
    etcd: { dbSizeBytes: null, objects: null },
    queries: []
  };
}

/**
 * Runs the plan's stages in ascending order. Each stage ramps to its target (one test-realm user per person, never reused), waits for the pods,
 * holds while the bulk sessions report activity, measures, then starts a burst on top, measures it and stops it. The first stage that is not
 * reached ends the run: later stages are recorded as not attempted, and nothing is extrapolated (D-10). An abort records the current stage as
 * interrupted. Every session the run started is stopped before it returns.
 */
export async function runStages(input: RunStagesInput): Promise<StagesOutcome> {
  const { plan, clock, measure, service, signal } = input;
  const targets = [...new Set(plan.stages)].sort((a, b) => a - b);
  const live = new Map<string, Started>();
  const bulk: Started[] = [];
  const stages: StageResult[] = [];
  let nextPerson = 0;
  let peak = 0;
  let ended: string | null = null;
  try {
    for (const target of targets) {
      if (ended !== null) { stages.push(unreached(target, ended, 0, { start: 0, end: 0 }, counted(0), plan.burst)); continue; }
      const rampStart = clock.now();
      const needed = Math.max(0, target - bulk.length);
      let ramp: StartOutcome | undefined;
      try {
        if (nextPerson + needed > input.people.length) {
          stages.push(unreached(target, `not enough test-realm users: ${grouped(input.people.length)} for a stage of ${grouped(target)}`, bulk.length, { start: rampStart, end: clock.now() }, counted(0), plan.burst));
          ended = `not attempted: stage ${grouped(target)} was not reached`;
          continue;
        }
        const users = input.people.slice(nextPerson, nextPerson + needed);
        nextPerson += needed;
        ramp = await startMany(input, users, plan.rampConcurrency, live);
        bulk.push(...answered(ramp.started));
        await stopAll(service, ramp.started.filter((item) => item.firstResponseAt === null), live);
        peak = Math.max(peak, bulk.length);
        let failure = startFailure(users.length, ramp, plan);
        if (failure === null) {
          const { pending } = await measure.waitReady(bulk, plan.pendingLimitMs, signal);
          if (pending > 0) failure = pendingReason(pending, plan);
        }
        if (failure !== null) {
          stages.push(unreached(target, failure, bulk.length, { start: rampStart, end: clock.now() }, counted(users.length, ramp), plan.burst));
          ended = `not attempted: stage ${grouped(target)} was not reached`;
          continue;
        }
        const holdStart = clock.now();
        await hold(input, bulk);
        const window = { start: holdStart, end: clock.now() };
        const stageNames = new Set(bulk.map(({ sessionName }) => sessionName));
        const active = new Set<string>();
        for (const { sessionName, finishedAt } of input.localSamples ?? []) {
          if (stageNames.has(sessionName) && Number.isSafeInteger(finishedAt) && finishedAt >= window.start && finishedAt < window.end) {
            active.add(sessionName);
          }
        }
        const steady = await measure.steady({ sessions: bulk, active: [...active], window });
        const hub = input.hubs ? await input.hubs(signal) : undefined;
        if (input.hubs) checkSignal(signal);

        // The burst uses the next identities without consuming them: its sessions are stopped before the next stage ramps.
        const burstStart = clock.now();
        const burstUsers = input.people.slice(nextPerson, nextPerson + plan.burst);
        const burst = await startMany(input, burstUsers, Math.max(1, plan.burst), live);
        const burstAnswered = answered(burst.started);
        let burstReason = plan.burst === 0
          ? 'no burst configured'
          : burstUsers.length < plan.burst ? `not enough test-realm users: ${grouped(burstUsers.length)} for a burst of ${grouped(plan.burst)}` : startFailure(burstUsers.length, burst, plan);
        if (burstReason === null) {
          const { pending } = await measure.waitReady(burstAnswered, plan.pendingLimitMs, signal);
          if (pending > 0) burstReason = pendingReason(pending, plan);
        }
        const peakConcurrency = bulk.length + burstAnswered.length;
        peak = Math.max(peak, peakConcurrency);
        const measuredAt = clock.now();
        const burstWindow = { start: burstStart, end: measuredAt };
        const burstStarts = burst.started.length > 0 ? await measure.startTimes(burst.started, burstWindow) : emptyDurations();
        const reconciles = plan.burst > 0 ? await measure.reconcilesPer10s(burstWindow) : [];
        await stopAll(service, burst.started, live);
        stages.push({
          target,
          reached: true,
          reason: '',
          window: { start: rampStart, end: measuredAt },
          sessions: bulk.length,
          start: { ...counted(users.length, ramp), ...(await measure.startTimes(ramp.started, { start: rampStart, end: burstStart })) },
          burst: {
            size: plan.burst, reached: burstReason === null, reason: burstReason ?? '', peakConcurrency, window: burstWindow,
            start: { ...counted(burstUsers.length, burst), ...burstStarts }, reconcilesPer10s: reconciles
          },
          ...steady,
          ...(hub === undefined ? {} : { hubs: [hub] })
        });
      } catch (error) {
        if (!(error instanceof Interrupted) && !signal?.aborted) throw error;
        stages.push(unreached(target, 'interrupted', bulk.length, { start: rampStart, end: clock.now() }, counted(needed, ramp), plan.burst));
        ended = 'not attempted: the run was interrupted';
      }
    }
  } finally {
    await stopAll(service, [...live.values()], live);
  }
  return { stages, peakConcurrency: peak };
}
