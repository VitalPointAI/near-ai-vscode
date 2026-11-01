// SyncScheduler under fake timers: focus-aware intervals, clamping, exponential backoff to 10 minutes, single flight, nudge and stop (D-19, D-25).
// A fake clock also covers G-60-1: focus events that change nothing never starve polling, a focus loss is counted from the last run,
// and the cadence follows the live focused() value after every run.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_BACKOFF_MS, SyncScheduler, UNFOCUSED_POLL_MS } from '../team/syncScheduler';
import type { SchedulerTimers } from '../team/syncScheduler';

interface Request { id: number; ms: number; due: number; callback: () => void; cleared: boolean; fired: boolean }

class FakeTimers implements SchedulerTimers {
  public readonly requests: Request[] = [];
  // Milliseconds on the fake clock. It only moves when a test fires a timer or calls advanceTo.
  public clock = 0;
  public now(): number {
    return this.clock;
  }
  public set(callback: () => void, ms: number): unknown {
    const request: Request = { id: this.requests.length, ms, due: this.clock + ms, callback, cleared: false, fired: false };
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
    this.clock = Math.max(this.clock, request.due);
    request.callback();
  }
  // Fires every live timer that is due at or before the target, earliest first, letting each run settle, then moves the clock to the target.
  public async advanceTo(target: number): Promise<void> {
    for (;;) {
      const due = this.live.filter((request) => request.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (due === undefined) break;
      due.fired = true;
      this.clock = Math.max(this.clock, due.due);
      due.callback();
      await settle();
    }
    this.clock = target;
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

interface Harness { scheduler: SyncScheduler; timers: FakeTimers; runs: Deferred[]; errors: unknown[]; focus: { value: boolean }; poll: { value: number }; runCount: { value: number } }

// Each run waits on a deferred the test settles, so the test controls when a run ends and what it reports.
function harness(options: { focused?: boolean; pollSeconds?: number; instant?: Array<boolean | Error>; always?: boolean } = {}): Harness {
  const timers = new FakeTimers();
  const runs: Deferred[] = [];
  const errors: unknown[] = [];
  const focus = { value: options.focused ?? true };
  const poll = { value: options.pollSeconds ?? 15 };
  const instant = [...(options.instant ?? [])];
  const runCount = { value: 0 };
  const scheduler = new SyncScheduler({
    run: () => {
      runCount.value += 1;
      if (options.always !== undefined) return Promise.resolve(options.always);
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
  return { scheduler, timers, runs, errors, focus, poll, runCount };
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

test('a focus event that does not change focus neither re-arms the wait nor starts a run', async () => {
  const focusedHarness = harness({ instant: [true] });
  focusedHarness.scheduler.start();
  await settle();
  assert.deepEqual(focusedHarness.timers.delays(), [15_000]);
  for (let index = 0; index < 10; index += 1) focusedHarness.scheduler.focusChanged(true);
  await settle();
  assert.equal(focusedHarness.timers.requests.length, 1, 'no new timer was requested');
  assert.equal(focusedHarness.timers.requests[0]?.cleared, false, 'the pending timer was not cleared');
  assert.equal(focusedHarness.runCount.value, 1, 'no run was started');
  focusedHarness.scheduler.stop();

  const unfocusedHarness = harness({ focused: false, instant: [true] });
  unfocusedHarness.scheduler.start();
  await settle();
  assert.deepEqual(unfocusedHarness.timers.delays(), [UNFOCUSED_POLL_MS]);
  for (let index = 0; index < 10; index += 1) unfocusedHarness.scheduler.focusChanged(false);
  await settle();
  assert.equal(unfocusedHarness.timers.requests.length, 1, 'no new timer was requested');
  assert.equal(unfocusedHarness.timers.requests[0]?.cleared, false, 'the pending timer was not cleared');
  assert.equal(unfocusedHarness.runCount.value, 1, 'no run was started');
  unfocusedHarness.scheduler.stop();
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

// An hour of fake time. Every run here resolves at once, so the run count only depends on when polls are armed.
const ONE_HOUR_MS = 3_600_000;

async function runsInAnHour(options: { always: boolean; focused: boolean; eventEveryMs?: number }): Promise<number> {
  const h = harness({ focused: options.focused, always: options.always });
  h.scheduler.start();
  await settle();
  if (options.eventEveryMs === undefined) {
    await h.timers.advanceTo(ONE_HOUR_MS);
  } else {
    for (let at = options.eventEveryMs; at <= ONE_HOUR_MS; at += options.eventEveryMs) {
      await h.timers.advanceTo(at);
      h.scheduler.focusChanged(options.focused);
    }
    await h.timers.advanceTo(ONE_HOUR_MS);
  }
  h.scheduler.stop();
  return h.runCount.value;
}

test('unchanged focus events every 100 s for an hour still give every 120 s poll (G-60-1)', async () => {
  const baseline = await runsInAnHour({ always: true, focused: false });
  assert.ok(baseline >= 30, `the baseline is the start run plus one every 120 s, got ${baseline}`);
  const withEvents = await runsInAnHour({ always: true, focused: false, eventEveryMs: 100_000 });
  assert.equal(withEvents, baseline);
});

test('unchanged focus events every 200 s with a failing remote still give every backed-off poll (G-60-1)', async () => {
  const baseline = await runsInAnHour({ always: false, focused: false });
  assert.ok(baseline >= 6, `the backed-off baseline polls at 240 s, 480 s, then every 600 s, got ${baseline}`);
  const withEvents = await runsInAnHour({ always: false, focused: false, eventEveryMs: 200_000 });
  assert.equal(withEvents, baseline);
});

test('losing focus moves the next poll to 120 s after the last run, not after the event', async () => {
  const h = harness({ pollSeconds: 15, always: true });
  h.scheduler.start();
  await settle();
  assert.deepEqual(h.timers.delays(), [15_000]);
  await h.timers.advanceTo(10_000);
  h.focus.value = false;
  h.scheduler.focusChanged(false);
  assert.equal(h.timers.requests[0]?.cleared, true);
  assert.deepEqual(h.timers.delays(), [15_000, 110_000]);
  await h.timers.advanceTo(119_999);
  assert.equal(h.runCount.value, 1, 'no run before 120 s after the last run');
  await h.timers.advanceTo(120_000);
  assert.equal(h.runCount.value, 2, 'one run at 120 s after the last run');
  assert.equal(h.timers.delays().at(-1), UNFOCUSED_POLL_MS, 'and the next poll is 120 s after that run');
  h.scheduler.stop();
});

test('losing focus after more than 120 s since the last run polls at once', async () => {
  const h = harness({ pollSeconds: 3600, always: true });
  h.scheduler.start();
  await settle();
  assert.deepEqual(h.timers.delays(), [3_600_000]);
  await h.timers.advanceTo(200_000);
  h.focus.value = false;
  h.scheduler.focusChanged(false);
  assert.deepEqual(h.timers.delays(), [3_600_000, 0]);
  await h.timers.advanceTo(200_000);
  assert.equal(h.runCount.value, 2);
  h.scheduler.stop();
});

test('the cadence follows focused() after each run even when no focus event arrived', async () => {
  const gain = harness({ focused: false, pollSeconds: 5 });
  gain.scheduler.start();
  await settle();
  gain.focus.value = true;
  gain.runs[0]?.resolve(true);
  await settle();
  assert.deepEqual(gain.timers.delays(), [5_000]);
  assert.equal(gain.runCount.value, 1, 'a refreshed gain only shortens the wait and starts no run');
  gain.scheduler.stop();

  const loss = harness({ focused: true, pollSeconds: 5 });
  loss.scheduler.start();
  await settle();
  loss.focus.value = false;
  loss.runs[0]?.resolve(true);
  await settle();
  assert.deepEqual(loss.timers.delays(), [UNFOCUSED_POLL_MS]);
  loss.scheduler.stop();
});
