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
