// SyncScheduler under fake timers: focus-aware intervals, clamping, exponential backoff to 10 minutes, single flight, nudge and stop (D-19, D-25).
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_BACKOFF_MS, SyncScheduler, UNFOCUSED_POLL_MS } from '../team/syncScheduler';
import type { SchedulerTimers } from '../team/syncScheduler';

interface Request { id: number; ms: number; callback: () => void; cleared: boolean; fired: boolean }

class FakeTimers implements SchedulerTimers {
  public readonly requests: Request[] = [];
  public set(callback: () => void, ms: number): unknown {
    const request: Request = { id: this.requests.length, ms, callback, cleared: false, fired: false };
    this.requests.push(request);
    return request;
  }
  public clear(handle: unknown): void {
    (handle as Request).cleared = true;
  }
  public get live(): Request[] {
    return this.requests.filter((request) => !request.cleared && !request.fired);
  }
  public delays(): number[] {
    return this.requests.map((request) => request.ms);
  }
  public fire(): void {
    const request = this.live[this.live.length - 1];
    assert.ok(request !== undefined, 'a timer is waiting');
    request.fired = true;
    request.callback();
  }
}

const turn = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await turn();
}

interface Deferred { promise: Promise<boolean>; resolve(value: boolean): void; reject(error: unknown): void }
function deferred(): Deferred {
  let resolve!: (value: boolean) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<boolean>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

interface Harness { scheduler: SyncScheduler; timers: FakeTimers; runs: Deferred[]; errors: unknown[]; focus: { value: boolean }; poll: { value: number } }

// Each run waits on a deferred the test settles, so the test controls when a run ends and what it reports.
function harness(options: { focused?: boolean; pollSeconds?: number; instant?: Array<boolean | Error> } = {}): Harness {
  const timers = new FakeTimers();
  const runs: Deferred[] = [];
  const errors: unknown[] = [];
  const focus = { value: options.focused ?? true };
  const poll = { value: options.pollSeconds ?? 15 };
  const instant = [...(options.instant ?? [])];
  const scheduler = new SyncScheduler({
    run: () => {
      const next = instant.shift();
      if (next instanceof Error) return Promise.reject(next);
      if (next !== undefined) return Promise.resolve(next);
      const pending = deferred();
      runs.push(pending);
      return pending.promise;
    },
    pollSeconds: () => poll.value,
    focused: () => focus.value,
    timers,
    onError: (error) => { errors.push(error); }
  });
  return { scheduler, timers, runs, errors, focus, poll };
}

test('start runs once at once, then waits pollSeconds when focused', async () => {
  const h = harness({ pollSeconds: 15 });
  h.scheduler.start();
  await settle();
  assert.equal(h.runs.length, 1);
  assert.deepEqual(h.timers.delays(), [], 'no timer while the first run is in flight');
  h.runs[0]?.resolve(true);
  await settle();
  assert.deepEqual(h.timers.delays(), [15_000]);
  h.timers.fire();
  await settle();
  assert.equal(h.runs.length, 2);
  h.scheduler.stop();
});

test('pollSeconds is clamped to 5..3600 and a non-number falls back to the default', async () => {
  for (const [configured, expected] of [[1, 5_000], [0, 5_000], [-20, 5_000], [99_999, 3_600_000], [Number.NaN, 15_000], [Number.POSITIVE_INFINITY, 15_000], [60, 60_000]] as const) {
    const h = harness({ pollSeconds: configured, instant: [true] });
    h.scheduler.start();
    await settle();
    assert.deepEqual(h.timers.delays(), [expected], `pollSeconds ${configured}`);
    h.scheduler.stop();
  }
});

test('an unfocused window polls every 120 seconds', async () => {
  const h = harness({ focused: false, instant: [true] });
  h.scheduler.start();
  await settle();
  assert.deepEqual(h.timers.delays(), [UNFOCUSED_POLL_MS]);
  assert.equal(UNFOCUSED_POLL_MS, 120_000);
  h.scheduler.stop();
});

test('an unhealthy or throwing run doubles the delay per failure up to 10 minutes and a healthy run resets it', async () => {
  const boom = new Error('network is down');
  const h = harness({ pollSeconds: 15, instant: [false, boom, false, false, false, false, false] });
  h.scheduler.start();
  await settle();
  for (let index = 0; index < 6; index += 1) {
    h.timers.fire();
    await settle();
  }
  assert.deepEqual(h.timers.delays(), [30_000, 60_000, 120_000, 240_000, 480_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
  assert.equal(MAX_BACKOFF_MS, 600_000);
  assert.equal(h.scheduler.failures, 7);
  assert.deepEqual(h.errors, [boom], 'the thrown error reached onError');
  h.timers.fire();
  await settle();
  assert.equal(h.runs.length, 1);
  h.runs[0]?.resolve(true);
  await settle();
  assert.equal(h.scheduler.failures, 0);
  assert.equal(h.timers.delays().at(-1), 15_000);
  h.scheduler.stop();
});

test('backoff for an unfocused window starts from 120 seconds and also stops at 10 minutes', async () => {
  const h = harness({ focused: false, instant: [false, false, false, false] });
  h.scheduler.start();
  await settle();
  for (let index = 0; index < 3; index += 1) {
    h.timers.fire();
    await settle();
  }
  assert.deepEqual(h.timers.delays(), [240_000, 480_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
  h.scheduler.stop();
});

test('a failure never shortens a poll interval that is already longer than the cap', async () => {
  const h = harness({ pollSeconds: 3600, instant: [false] });
  h.scheduler.start();
  await settle();
  assert.deepEqual(h.timers.delays(), [3_600_000]);
  h.scheduler.stop();
});

test('focusChanged(true) cancels the wait and runs at once, keeping the failure count until a run succeeds', async () => {
  const h = harness({ focused: false, instant: [false] });
  h.scheduler.start();
  await settle();
  assert.deepEqual(h.timers.delays(), [240_000]);
  h.focus.value = true;
  h.scheduler.focusChanged(true);
  await settle();
  assert.equal(h.timers.requests[0]?.cleared, true, 'the long wait was cancelled');
  assert.equal(h.runs.length, 1, 'the retry started without waiting');
  h.runs[0]?.resolve(false);
  await settle();
  assert.equal(h.scheduler.failures, 2);
  assert.equal(h.timers.delays().at(-1), 60_000);
  h.scheduler.stop();
});

test('focusChanged(false) reschedules with the unfocused interval', async () => {
  const h = harness({ instant: [true] });
  h.scheduler.start();
  await settle();
  assert.deepEqual(h.timers.delays(), [15_000]);
  h.focus.value = false;
  h.scheduler.focusChanged(false);
  assert.equal(h.timers.requests[0]?.cleared, true);
  assert.deepEqual(h.timers.delays(), [15_000, UNFOCUSED_POLL_MS]);
  h.scheduler.stop();
});

test('losing focus during a run applies the unfocused interval when the run ends', async () => {
  const h = harness();
  h.scheduler.start();
  await settle();
  h.focus.value = false;
  h.scheduler.focusChanged(false);
  assert.deepEqual(h.timers.delays(), []);
  h.runs[0]?.resolve(true);
  await settle();
  assert.deepEqual(h.timers.delays(), [UNFOCUSED_POLL_MS]);
  h.scheduler.stop();
});

test('a nudge during a run causes exactly one follow-up run right after it, even after two nudges', async () => {
  const h = harness();
  h.scheduler.start();
  await settle();
  h.scheduler.nudge();
  h.scheduler.nudge();
  await settle();
  assert.equal(h.runs.length, 1, 'runs never overlap');
  h.runs[0]?.resolve(true);
  await settle();
  assert.equal(h.runs.length, 2, 'one follow-up started at once');
  assert.deepEqual(h.timers.delays(), [], 'no timer while the follow-up runs');
  h.runs[1]?.resolve(true);
  await settle();
  assert.equal(h.runs.length, 2, 'two nudges still gave one follow-up');
  assert.deepEqual(h.timers.delays(), [15_000]);
  h.scheduler.stop();
});

test('a nudge while waiting cancels the wait and runs at once', async () => {
  const h = harness({ instant: [true] });
  h.scheduler.start();
  await settle();
  assert.equal(h.timers.live.length, 1);
  h.scheduler.nudge();
  await settle();
  assert.equal(h.timers.live.length, 0);
  assert.equal(h.runs.length, 1);
  h.scheduler.stop();
});

test('stop clears the timer, and a run in flight finishes without scheduling or following up', async () => {
  const h = harness({ instant: [true] });
  h.scheduler.start();
  await settle();
  h.scheduler.stop();
  assert.equal(h.timers.live.length, 0);
  h.scheduler.nudge();
  h.scheduler.focusChanged(true);
  await settle();
  assert.equal(h.runs.length, 0, 'nothing runs after stop');

  const busy = harness();
  busy.scheduler.start();
  await settle();
  busy.scheduler.nudge();
  busy.scheduler.stop();
  busy.runs[0]?.resolve(true);
  await settle();
  assert.equal(busy.runs.length, 1, 'no follow-up after stop');
  assert.deepEqual(busy.timers.delays(), [], 'nothing rescheduled after stop');
});

test('start after stop begins again and an error handler that throws does not break the loop', async () => {
  const timers = new FakeTimers();
  let calls = 0;
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]): void => { logged.push(args); };
  try {
    const scheduler = new SyncScheduler({
      run: async () => { calls += 1; throw new Error('first'); },
      pollSeconds: () => 15,
      focused: () => true,
      timers,
      onError: () => { throw new Error('handler broke'); }
    });
    scheduler.start();
    await settle();
    assert.equal(calls, 1);
    assert.equal(logged.length, 1, 'the handler failure was written to the host log');
    assert.deepEqual(timers.delays(), [30_000]);
    scheduler.stop();
    scheduler.start();
    await settle();
    assert.equal(calls, 2);
    scheduler.stop();
  } finally {
    console.error = original;
  }
});
