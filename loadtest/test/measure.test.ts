import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMeasure, ingressSample, parseTimeline, readTimeline, reconcilesPer10s, resolveMetricNames, routePropagation, startTimes, usageFromSeries,
  type Kubectl, type Prometheus
} from '../src/measure.ts';
import { percentile, renderCapacity } from '../src/capacity.ts';
import type { Started } from '../src/stages.ts';
import { hashRun } from '../src/runfile.ts';
import * as cluster from './fixtures/cluster.ts';
import { ascending, makeRun, notReached, stage } from './fixtures/run.ts';
import { fakeClock } from './fixtures/fakes.ts';

const timeline = () => parseTimeline({ sessions: cluster.sessions, deployments: cluster.deployments, pods: cluster.pods, events: cluster.events });
const started: Started[] = [
  { user: 'loadtest-user-0001', sessionName: 'ws-a', url: 'https://site.example/ws-a/', requestedAt: cluster.ms('11:59:59') + 500, firstResponseAt: cluster.ms('12:00:33') },
  { user: 'loadtest-user-0002', sessionName: 'ws-b', url: 'https://site.example/ws-b/', requestedAt: cluster.ms('12:00:09') + 800, firstResponseAt: cluster.ms('12:00:41') },
  { user: 'loadtest-user-0003', sessionName: 'ws-c', url: 'https://site.example/ws-c/', requestedAt: cluster.ms('12:00:19') + 900, firstResponseAt: null }
];
const all = { start: cluster.ms('11:00:00'), end: cluster.ms('13:00:00') };

test('start durations come from Session creation to Deployment creation, to Pod Ready, and to the first response, split cold and warm', () => {
  const measured = startTimes(timeline(), started, all);
  assert.deepEqual(measured.reconcileMs, { cold: [2_000], warm: [1_000, 5_000] });
  assert.deepEqual(measured.readyMs, { cold: [30_000], warm: [30_000] });
  assert.deepEqual(measured.firstResponseMs, { cold: [33_000], warm: [31_000] });
});

test('a session whose request time equals a stage boundary belongs only to the stage whose [start, end) holds it', () => {
  const boundary = started[1].requestedAt;
  const first = startTimes(timeline(), started, { start: all.start, end: boundary });
  const second = startTimes(timeline(), started, { start: boundary, end: started[2].requestedAt });
  assert.deepEqual(first.reconcileMs, { cold: [2_000], warm: [] });
  assert.deepEqual(second.reconcileMs, { cold: [], warm: [5_000] });
});

test('reconcile throughput is the Deployments created per 10-second window, including empty windows, ascending', () => {
  assert.deepEqual(reconcilesPer10s(timeline(), { start: cluster.ms('12:00:00'), end: cluster.ms('12:00:40') }), [0, 1, 1, 2]);
  assert.deepEqual(reconcilesPer10s(timeline(), { start: cluster.ms('12:10:00'), end: cluster.ms('12:10:00') }), []);
});

test('an Ingress sample records its bytes, its rule count and the session routes it holds', () => {
  const text = JSON.stringify(cluster.ingressSecond);
  const sample = ingressSample(text, 1_000);
  assert.equal(sample.bytes, Buffer.byteLength(text));
  assert.equal(sample.rules, 3);
  assert.deepEqual(sample.routes, ['site.example/', 'site.example/ws-a', 'site.example/ws-b']);
});

test('route propagation runs from the first sample holding a session rule to that session first response', () => {
  const first = ingressSample(JSON.stringify(cluster.ingressFirst), cluster.ms('12:00:25'));
  const second = ingressSample(JSON.stringify(cluster.ingressSecond), cluster.ms('12:00:38'));
  const result = routePropagation([second, first], started);
  // ws-a: 12:00:33 - 12:00:25; ws-b: 12:00:41 - 12:00:38; ws-c never answered. The site root rule does not count as anyone's route.
  assert.deepEqual(result, { propagationMs: [3_000, 8_000], unmeasured: 1 });
  // A response before any sample showed the rule cannot be measured, so it is counted, never recorded as 0.
  const late = ingressSample(JSON.stringify(cluster.ingressSecond), cluster.ms('12:00:50'));
  assert.deepEqual(routePropagation([late], started.slice(0, 2)), { propagationMs: [], unmeasured: 2 });
});

test('per-pod CPU and memory are averaged over the hold window and split into the active sample and the idle set by pod name', () => {
  const usage = usageFromSeries({ cpu: cluster.cpu, memory: cluster.memory, volume: cluster.volume }, timeline(), started, ['ws-a']);
  assert.deepEqual(usage.active, { sessions: 1, cpuMillicores: [250], memoryBytes: [1_100_000_001], volumeBytes: [700_000_000] });
  assert.deepEqual(usage.idle, { sessions: 2, cpuMillicores: [20], memoryBytes: [300_000_000] });
});

test('workspace volume use per active-sample session comes from the kubelet volume series for its own claim', () => {
  const usage = usageFromSeries({ cpu: cluster.cpu, memory: cluster.memory, volume: cluster.volume }, timeline(), started, ['ws-a', 'ws-b']);
  assert.deepEqual(usage.active.volumeBytes, [100_000_000, 700_000_000]);
  assert.deepEqual(usage.idle, { sessions: 1, cpuMillicores: [], memoryBytes: [] });
});

test('etcd and apiserver metric names are resolved from the live name list, and none is invented when absent', () => {
  assert.deepEqual(resolveMetricNames(cluster.metricNames), { dbSize: 'etcd_mvcc_db_total_size_in_bytes', objects: 'apiserver_storage_objects' });
  assert.deepEqual(resolveMetricNames(['etcd_db_total_size_in_bytes', 'etcd_object_counts']), { dbSize: 'etcd_db_total_size_in_bytes', objects: 'etcd_object_counts' });
  assert.deepEqual(resolveMetricNames(['up']), { dbSize: null, objects: null });
});

test('the measure reads the cluster with argument arrays and Prometheus by query_range, and stores the query texts it used', async () => {
  const kubectlCalls: string[][] = [];
  const kubectl: Kubectl = async (args) => {
    kubectlCalls.push([...args]);
    const kind = args[1];
    if (kind === 'ingress') return JSON.stringify(cluster.ingressSecond);
    const body = { 'sessions.theia.cloud': cluster.sessions, deployments: cluster.deployments, pods: cluster.pods, events: cluster.events }[kind];
    return JSON.stringify(body);
  };
  const queries: string[] = [];
  const prometheus: Prometheus = {
    names: async () => cluster.metricNames,
    range: async (query) => {
      queries.push(query);
      if (query.includes('container_cpu_usage_seconds_total')) return cluster.cpu;
      if (query.includes('container_memory_working_set_bytes')) return cluster.memory;
      if (query.includes('kubelet_volume_stats_used_bytes')) return cluster.volume;
      if (query.includes('etcd_mvcc_db_total_size_in_bytes')) return cluster.etcdSize;
      return cluster.etcdObjects;
    }
  };
  const measure = createMeasure({ kubectl, prometheus, clock: fakeClock(), namespace: 'theia-cloud', sessionResource: 'sessions.theia.cloud', ingressName: 'theia-cloud-ingress', pollIntervalMs: 1_000 });
  const window = { start: cluster.ms('12:01:00'), end: cluster.ms('12:01:30') };
  const steady = await measure.steady({ sessions: started, active: ['ws-a'], window });
  assert.ok(kubectlCalls.every((args) => args.includes('-o') && args.includes('json') && args.includes('theia-cloud')));
  assert.deepEqual(steady.etcd, { dbSizeBytes: 100_000_000, objects: 3_100 });
  assert.deepEqual(steady.perPerson.active.cpuMillicores, [250]);
  assert.equal(steady.ingress.samples.length, 1);
  assert.deepEqual(steady.queries.map((query) => query.name), ['cpu', 'memory', 'volume', 'etcd-db-size', 'etcd-objects']);
  assert.ok(steady.queries.every((query) => query.from === window.start && query.to === window.end && queries.includes(query.text)));
  assert.match(steady.queries[0].text, /namespace="theia-cloud"/);
  const pending = await measure.waitReady(started, 2_000);
  assert.equal(pending.pending, 1, 'ws-c is still Pending past the limit');
  assert.deepEqual((await readTimeline(kubectl, 'theia-cloud', 'sessions.theia.cloud')).sessions.size, 3);
});

test('nearest-rank percentiles: equal values return that value, the boundary ranks are exact, and no values is undefined', () => {
  assert.equal(percentile([7, 7, 7, 7], 95), 7);
  assert.equal(percentile(ascending(20, 1, 1), 95), 19);
  assert.equal(percentile(ascending(100, 1, 1), 99), 99);
  assert.equal(percentile(ascending(100, 1, 1), 50), 50);
  assert.equal(percentile([5], 99), 5);
  assert.equal(percentile([], 50), undefined);
});

test('sizing defaults per site size class come from the run, and a class whose stage was not reached prints "not measured"', () => {
  const mib = 1024 ** 2;
  const gib = 1024 ** 3;
  const active = { sessions: 20, cpuMillicores: ascending(20, 100, 10), memoryBytes: ascending(20, 1_000 * mib, mib), volumeBytes: ascending(20, gib, 10 * mib) };
  const idle = { sessions: 20, cpuMillicores: ascending(20, 5, 1), memoryBytes: ascending(20, 300 * mib, mib) };
  const perPerson = { active, idle };
  const run = makeRun({
    stages: [stage(100, { perPerson }), stage(200, { perPerson, start: { ...stage(200).start, readyMs: { cold: ascending(20, 40_000, 100), warm: [] } } }), notReached(400, 'pods Pending past the limit')],
    inputs: { ...makeRun().inputs, stages: [100, 200, 400], idleTimeoutMinutes: 45 }
  });
  const block = renderCapacity([{ ...run, hash: hashRun(run) }]);
  const rows = block.split('\n').filter((line) => line.startsWith('| Up to '));
  assert.equal(rows.length, 3, block);
  // p95 of 1000..1019 MiB is 1018 MiB, rounded up to 1,024 MiB; p95 volume is 1 GiB + 180 MiB, doubled and rounded up to 3 GiB.
  assert.equal(rows[0], `| Up to 100 people | ${run.id} | 1,024 MiB | 3 GiB | 45 minutes | 318 MiB | 10,940 ms |`);
  assert.match(rows[1], /^\| Up to 200 people \| .* \| 45 minutes \| 318 MiB \| 41,800 ms \|$/);
  assert.equal(rows[2], '| Up to 400 people | not measured | | | | | |');
});

test('a reached stage above the HQ target is headroom: no size class of its own, and the stage table marks it', () => {
  const run = makeRun({ stages: [stage(400), stage(600)], inputs: { ...makeRun().inputs, stages: [400, 600] } });
  const block = renderCapacity([{ ...run, hash: hashRun(run) }]);
  assert.ok(!block.includes('| Up to 600 people'), block);
  assert.ok(block.split('\n').some((line) => line.startsWith('| 400 | reached |')), block);
  assert.ok(block.split('\n').some((line) => line.startsWith('| 600 | reached (headroom) |')), block);
});
