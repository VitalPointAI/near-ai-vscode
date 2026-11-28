import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStages, type StagePlan } from '../src/stages.ts';
import { verifyRunFile, writeRunFile } from '../src/runfile.ts';
import { findCapacityFigures, renderCapacityPage } from '../src/capacity.ts';
import { fakeClock, fakeMeasure, fakeService, people } from './fixtures/fakes.ts';
import { makeRun } from './fixtures/run.ts';

const plan = (overrides: Partial<StagePlan> = {}): StagePlan => ({
  stages: [50],
  burst: 50,
  holdMs: 60_000,
  activityIntervalMs: 30_000,
  pollIntervalMs: 500,
  rampConcurrency: 25,
  startTimeoutMs: 180_000,
  pendingLimitMs: 300_000,
  maxFailedPercent: 1,
  ...overrides
});

test('tracer: one stage against a fake service becomes a verified run file and a capacity page with no stray figure', async () => {
  const clock = fakeClock();
  const service = fakeService(clock, { delayMs: 40 });
  const result = await runStages({ plan: plan(), people: people(100), service, measure: fakeMeasure(), clock });
  assert.equal(result.stages.length, 1);
  const [only] = result.stages;
  assert.equal(only.target, 50);
  assert.equal(only.reached, true);
  assert.equal(only.start.readyMs.cold.length, 50);
  assert.equal(only.burst.size, 50);
  assert.equal(only.burst.start.readyMs.cold.length, 50);
  assert.equal(result.peakConcurrency, 100);

  const run = makeRun({ stages: result.stages, peakConcurrency: result.peakConcurrency, inputs: { ...makeRun().inputs, burst: 50 } });
  const dir = mkdtempSync(join(tmpdir(), 'loadtest-tracer-'));
  const file = writeRunFile(dir, run);
  const verified = verifyRunFile(readFileSync(file, 'utf8'));
  const page = renderCapacityPage([verified]);
  const row = page.split('\n').find((line) => line.startsWith('| Session to Pod Ready, cold |'));
  assert.ok(row, page);
  const cells = row.split('|').map((cell) => cell.trim());
  assert.equal(cells[2], '50');
  assert.match(cells[3], /^\d+ ms$/);
  assert.match(cells[4], /^\d+ ms$/);
  assert.equal(cells[5], 'n too small');
  assert.deepEqual(findCapacityFigures(page), []);
  assert.equal(service.running.size, 0, 'every session is stopped at the end of the run');
});

const targets = (result: { stages: readonly { target: number }[] }): number[] => result.stages.map((item) => item.target);

test('stages run in ascending order, each ramping only the sessions it adds, with windows that follow one another', async () => {
  const clock = fakeClock();
  const service = fakeService(clock, { delayMs: 10 });
  const result = await runStages({ plan: plan({ stages: [250, 50], burst: 20 }), people: people(400), service, measure: fakeMeasure(), clock });
  assert.deepEqual(targets(result), [50, 250]);
  assert.equal(result.stages[1].start.requested, 200);
  assert.equal(result.stages[1].sessions, 250);
  assert.ok(result.stages[0].window.end <= result.stages[1].window.start);
  assert.ok(service.activity.length > 0, 'bulk sessions report activity during the hold');
  assert.equal(service.running.size, 0);
});

test('after the hold a burst of the configured size starts, its start times are kept apart, and it is stopped before the next stage', async () => {
  const clock = fakeClock();
  let runningAtSecondRamp = -1;
  const service = fakeService(clock, { delayMs: 10, onStart: (call) => { if (call === 50 + 30) runningAtSecondRamp = service.running.size; } });
  const result = await runStages({ plan: plan({ stages: [50, 100], burst: 30 }), people: people(200), service, measure: fakeMeasure(), clock });
  const [first] = result.stages;
  assert.equal(first.start.readyMs.cold.length, 50);
  assert.equal(first.burst.start.requested, 30);
  assert.equal(first.burst.start.readyMs.cold.length, 30);
  assert.equal(first.burst.peakConcurrency, 80);
  assert.ok(first.burst.window.start >= first.window.start && first.burst.window.end === first.window.end);
  assert.equal(runningAtSecondRamp, 50, 'only the bulk sessions are running when the next ramp starts');
  assert.equal(result.peakConcurrency, 130);
});

test('a stage whose starts fail above the configured share is not reached with that reason, and later stages are not attempted', async () => {
  const clock = fakeClock();
  const service = fakeService(clock, { fails: (call) => call >= 60 && call < 70 });
  const result = await runStages({ plan: plan({ stages: [50, 250, 500], burst: 0 }), people: people(600), service, measure: fakeMeasure(), clock });
  assert.deepEqual(targets(result), [50, 250, 500]);
  assert.equal(result.stages[0].reached, true);
  assert.equal(result.stages[1].reached, false);
  assert.match(result.stages[1].reason, /10 of 200 starts failed/);
  assert.equal(result.stages[2].reached, false);
  assert.match(result.stages[2].reason, /not attempted/);
  assert.equal(service.calls(), 250, 'no start is made for the stage after the one not reached');
  assert.equal(service.running.size, 0);
});

test('a stage whose sessions never answer within the start timeout is not reached as timed out', async () => {
  const clock = fakeClock();
  const service = fakeService(clock, { answers: (url) => !/user-(005[1-9]|00[6-9]\d|0100)\//.test(url) });
  const result = await runStages({ plan: plan({ stages: [50, 100], burst: 0, startTimeoutMs: 5_000 }), people: people(200), service, measure: fakeMeasure(), clock });
  assert.equal(result.stages[0].reached, true);
  assert.equal(result.stages[1].reached, false);
  assert.match(result.stages[1].reason, /50 of 50 starts timed out after 5,000 ms/);
  assert.equal(result.stages[1].start.timedOut, 50);
  assert.equal(service.running.size, 0, 'a session that never answered is stopped too');
});

test('a stage that leaves pods Pending past the limit is not reached with that reason', async () => {
  const clock = fakeClock();
  const service = fakeService(clock);
  const measure = fakeMeasure({ pending: (sessions) => (sessions.length > 50 ? 7 : 0) });
  const result = await runStages({ plan: plan({ stages: [50, 100], burst: 0 }), people: people(200), service, measure, clock });
  assert.equal(result.stages[0].reached, true);
  assert.equal(result.stages[1].reached, false);
  assert.match(result.stages[1].reason, /7 pods Pending past 300,000 ms/);
});

test('a burst the rig cannot hold is not reached for that burst only, and the run goes on', async () => {
  const clock = fakeClock();
  const service = fakeService(clock, { fails: (call) => call >= 50 && call < 60 });
  const result = await runStages({ plan: plan({ stages: [50, 100], burst: 20 }), people: people(200), service, measure: fakeMeasure(), clock });
  assert.equal(result.stages[0].reached, true);
  assert.equal(result.stages[0].burst.reached, false);
  assert.match(result.stages[0].burst.reason, /10 of 20 starts failed/);
  assert.equal(result.stages[1].reached, true);
});

test('an abort during a stage stops every started session and records the stage as interrupted', async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  const service = fakeService(clock, { onStart: (call) => { if (call === 120) controller.abort(new Error('SIGINT')); } });
  const result = await runStages({ plan: plan({ stages: [50, 250, 500], burst: 0 }), people: people(600), service, measure: fakeMeasure(), clock, signal: controller.signal });
  assert.deepEqual(result.stages.map((item) => [item.target, item.reached, item.reason]), [[50, true, ''], [250, false, 'interrupted'], [500, false, 'not attempted: the run was interrupted']]);
  assert.equal(service.running.size, 0);
  assert.ok(service.stopped.length >= 120);
});

test('a run with too few test-realm users for a stage does not reuse one: the stage is not reached', async () => {
  const clock = fakeClock();
  const service = fakeService(clock);
  const result = await runStages({ plan: plan({ stages: [50, 250], burst: 0 }), people: people(100), service, measure: fakeMeasure(), clock });
  assert.equal(result.stages[1].reached, false);
  assert.match(result.stages[1].reason, /test-realm users/);
  assert.equal(service.calls(), 50);
});

test('the local sample reports only completed in-window sessions to per-person accounting', async () => {
  const clock = fakeClock();
  const measure = fakeMeasure();
  const tracked: string[][] = [];
  const start = clock.now();
  const [active, idle] = people(2).map(user => `ws-${user}`);
  const result = await runStages({
    plan: plan({ stages: [2, 3], burst: 0 }), people: people(3), service: fakeService(clock), clock,
    measure: { ...measure, steady: async (input) => {
      tracked.push([...input.active]);
      const steady = await measure.steady(input);
      return { ...steady, perPerson: {
        active: { ...steady.perPerson.active, sessions: input.active.length },
        idle: { ...steady.perPerson.idle, sessions: input.sessions.length - input.active.length },
      } };
    } },
    localSamples: [
      { sessionName: active, finishedAt: start },
      { sessionName: active, finishedAt: start + 1 },
      { sessionName: idle, finishedAt: start + 60_000 },
      { sessionName: 'outside-stage', finishedAt: start + 1 },
    ],
  });
  assert.equal(tracked.length, 2);
  assert.equal(tracked[0].length, 1);
  assert.deepEqual(tracked[1], [idle]);
  const figures = result.stages.map(stage => [stage.perPerson.active.sessions, stage.perPerson.idle.sessions]);
  assert.deepEqual(figures, [[1, 1], [1, 2]]);
});
