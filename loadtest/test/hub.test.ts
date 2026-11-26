import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { renderCapacity } from '../src/capacity.ts';
import { hashRun, verifyRunFile, writeRunFile } from '../src/runfile.ts';
import type { UnhashedRun } from '../src/runfile.ts';
import { fakeClock, fakeMeasure, fakeService, people } from './fixtures/fakes.ts';
import { makeRun, stage } from './fixtures/run.ts';
import { runStages } from '../src/stages.ts';

const sample = {
  label: 'fixture-hub', persons: 5, streams: 5, appends: 1, durationMs: 5000,
  refusals: 0, appendMs: [4], healthMs: [2], cpuMillicores: null, memoryBytes: null
} as const;
const wire = (value: unknown) => JSON.stringify({ ...(value as object), hash: hashRun(value as UnhashedRun) });

test('the canonical reader verifies a bounded hub experiment beside unchanged schema 1', () => {
  const legacy = makeRun();
  const initial = makeRun({ id: '20261123T120000Z-hub-smoke', rig: 'hub-smoke', kind: 'experiment', stages: [stage(5)] });
  const experiment = {
    ...initial,
    schema: 2,
    inputs: { ...initial.inputs, holdMs: 5000 },
    stages: [{ ...stage(5), hubs: [sample] }]
  };
  const before = verifyRunFile(wire(legacy));
  const verified = verifyRunFile(wire(experiment));
  assert.equal(verified.schema, 2);
  assert.deepEqual(verified.stages, experiment.stages);
  assert.deepEqual(verifyRunFile(wire(legacy)), before);
  assert.equal(renderCapacity([before, verified]), renderCapacity([before]));
  const file = writeRunFile(mkdtempSync(path.join(tmpdir(), 'hub-smoke-unit-')), experiment as UnhashedRun);
  assert.deepEqual(verifyRunFile(readFileSync(file, 'utf8')), verified);

  for (const candidate of [
    { ...experiment, kind: 'load' },
    { ...experiment, schema: 1 },
    { ...experiment, schema: 3 },
    { ...experiment, stages: [{ ...stage(5), hubs: [{ ...sample, streams: 6 }] }] },
    { ...experiment, stages: [{ ...stage(5), hubs: [{ ...sample, appends: 0, appendMs: [] }] }] },
    { ...experiment, stages: [{ ...stage(5), hubs: [{ ...sample, healthMs: [1, 2, 3, 4, 5, 6] }] }] },
    { ...experiment, stages: [{ ...stage(5), hubs: [{ ...sample, endpoint: 'fixture evidence must omit this' }] }] },
  ]) assert.throws(() => verifyRunFile(wire(candidate)));
});

test('the fixture rejects every unregistered target before it dials', async () => {
  const { openFixtureHub } = await import('../src/hub.ts');
  const origin = 'https://127.0.0.1:28454';
  let dials = 0;
  const connect = async (port: number) => { dials++; return port; };
  for (const target of [
    'https://registry.example:28454', 'https://192.0.2.1:28454', 'https://[::1]:28454',
    'https://127.1:28454', 'https://127.0.0.1:28455', `${origin}/`, 'https://name@127.0.0.1:28454',
  ]) await assert.rejects(openFixtureHub(target, origin, connect), /fixture listener/);
  await assert.rejects(openFixtureHub(origin, undefined, connect), /fixture listener/);
  assert.equal(dials, 0);
  assert.equal(await openFixtureHub(origin, origin, connect), 28454);
  assert.equal(dials, 1);
});

test('only a reached fake stage receives the bounded hub observation', async () => {
  const clock = fakeClock();
  const source = makeRun({ stages: [stage(5)] });
  const plan = { ...source.inputs, holdMs: 5000 };
  let calls = 0;
  const hubs = async () => { calls++; return sample; };
  const complete = await runStages({ plan, people: people(5), clock, service: fakeService(clock), measure: fakeMeasure(), hubs });
  assert.deepEqual(complete.stages[0]?.hubs, [sample]);
  const incomplete = await runStages({ plan, people: people(4), clock, service: fakeService(clock), measure: fakeMeasure(), hubs });
  assert.equal(calls, 1);
  assert.equal(Object.hasOwn(incomplete.stages[0]!, 'hubs'), false);
});
