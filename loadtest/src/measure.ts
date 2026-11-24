// Measurement from the cluster's own records and the site's metrics store (Phase 48 D-22), never the load generator's estimates: session start
// timelines from `kubectl get -o json` creation and condition times, operator throughput from Deployment creation times, the shared Ingress
// object's size, per-pod CPU and memory and per-claim volume use from Prometheus, and etcd from metric names resolved on the live server. Every
// number is an integer (ms, bytes, millicores). kubectl and Prometheus are injected; the defaults run kubectl with an argument array (never a
// shell string) and call Prometheus's /api/v1/query_range.
import { execFile } from 'node:child_process';
import type { Durations, IngressSample, Query, Usage, ActiveUsage, Window } from './runfile.ts';
import type { Clock, MeasuredStarts, MeasuredSteady, StageMeasure, Started } from './stages.ts';

export type Kubectl = (args: readonly string[]) => Promise<string>;
export interface Prometheus {
  /** The metric names the server holds (/api/v1/label/__name__/values). */
  readonly names: () => Promise<string[]>;
  /** A range query (/api/v1/query_range) over [from, to] in ms; returns the parsed JSON response. */
  readonly range: (query: string, from: number, to: number, stepSeconds: number) => Promise<unknown>;
}

/** kubectl through execFile with an argument array; output is capped at 256 MiB. */
export function execKubectl(binary = 'kubectl'): Kubectl {
  return (args) => new Promise((resolve, reject) => {
    execFile(binary, [...args], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/** Prometheus over HTTP; `base` is the server address, for example http://prometheus.monitoring:9090. */
export function httpPrometheus(base: string, fetchImpl: typeof fetch = fetch): Prometheus {
  const get = async (path: string): Promise<unknown> => {
    const response = await fetchImpl(new URL(path, base));
    if (!response.ok) throw new Error(`Prometheus ${path.split('?')[0]}: HTTP ${response.status}`);
    const body = (await response.json()) as { status?: string; data?: unknown };
    if (body.status !== 'success') throw new Error(`Prometheus ${path.split('?')[0]}: status ${String(body.status)}`);
    return body;
  };
  return {
    names: async () => ((await get('/api/v1/label/__name__/values')) as { data: string[] }).data,
    range: (query, from, to, stepSeconds) => get(`/api/v1/query_range?${new URLSearchParams({ query, start: String(from / 1000), end: String(to / 1000), step: String(stepSeconds) })}`)
  };
}

interface SessionRecord { readonly created: number; readonly url: string | null }
interface DeploymentRecord { readonly name: string; readonly created: number; readonly claims: readonly string[] }
interface PodRecord { readonly name: string; readonly phase: string; readonly readyAt: number | null; readonly pulled: boolean }
export interface Timeline {
  /** By the session name the service returns (`spec.name`, else `metadata.name`). */
  readonly sessions: ReadonlyMap<string, SessionRecord>;
  readonly deployments: ReadonlyMap<string, DeploymentRecord>;
  readonly pods: ReadonlyMap<string, PodRecord>;
  /** Every Deployment's creation time, for throughput. */
  readonly deploymentTimes: readonly number[];
}

type Json = Record<string, unknown>;
const items = (list: unknown): Json[] => (Array.isArray((list as { items?: unknown })?.items) ? (list as { items: Json[] }).items : []);
const field = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((at, key) => (at !== null && typeof at === 'object' ? (at as Json)[key] : undefined), value);
const time = (value: unknown): number | null => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null);

/** Links Sessions to their Deployment (owner reference) and Pod (named after the Deployment), and marks a pod cold when its image was pulled. */
export function parseTimeline(lists: { readonly sessions: unknown; readonly deployments: unknown; readonly pods: unknown; readonly events: unknown }): Timeline {
  const byObjectName = new Map<string, string>();
  const sessions = new Map<string, SessionRecord>();
  for (const item of items(lists.sessions)) {
    const objectName = String(field(item, 'metadata', 'name') ?? '');
    const name = String(field(item, 'spec', 'name') ?? objectName);
    const created = time(field(item, 'metadata', 'creationTimestamp'));
    if (!objectName || created === null) continue;
    byObjectName.set(objectName, name);
    const url = field(item, 'status', 'url');
    sessions.set(name, { created, url: typeof url === 'string' && url ? url : null });
  }
  const pulledPods = new Set(items(lists.events).filter((event) => event.reason === 'Pulling').map((event) => String(field(event, 'involvedObject', 'name') ?? '')));
  const allPods = items(lists.pods).map((pod) => {
    const ready = (field(pod, 'status', 'conditions') as Json[] | undefined ?? []).find((condition) => condition.type === 'Ready' && condition.status === 'True');
    const name = String(field(pod, 'metadata', 'name') ?? '');
    return { name, phase: String(field(pod, 'status', 'phase') ?? ''), readyAt: ready ? time(ready.lastTransitionTime) : null, pulled: pulledPods.has(name) };
  });
  const deployments = new Map<string, DeploymentRecord>();
  const pods = new Map<string, PodRecord>();
  const deploymentTimes: number[] = [];
  for (const item of items(lists.deployments)) {
    const name = String(field(item, 'metadata', 'name') ?? '');
    const created = time(field(item, 'metadata', 'creationTimestamp'));
    if (created !== null) deploymentTimes.push(created);
    const owner = (field(item, 'metadata', 'ownerReferences') as Json[] | undefined ?? []).find((reference) => reference.kind === 'Session');
    const session = owner ? byObjectName.get(String(owner.name)) : undefined;
    if (!session || created === null) continue;
    const claims = (field(item, 'spec', 'template', 'spec', 'volumes') as Json[] | undefined ?? [])
      .map((volume) => field(volume, 'persistentVolumeClaim', 'claimName')).filter((claim): claim is string => typeof claim === 'string');
    deployments.set(session, { name, created, claims });
    const pod = allPods.find((candidate) => candidate.name.startsWith(`${name}-`));
    if (pod) pods.set(session, pod);
  }
  return { sessions, deployments, pods, deploymentTimes: deploymentTimes.sort((a, b) => a - b) };
}

/** Reads the Sessions, Deployments, Pods and Events of the namespace. */
export async function readTimeline(kubectl: Kubectl, namespace: string, sessionResource: string): Promise<Timeline> {
  const get = async (kind: string): Promise<unknown> => JSON.parse(await kubectl(['get', kind, '-n', namespace, '-o', 'json']));
  const [sessions, deployments, pods, events] = await Promise.all([get(sessionResource), get('deployments'), get('pods'), get('events')]);
  return parseTimeline({ sessions, deployments, pods, events });
}

const inWindow = (at: number, window: Window): boolean => at >= window.start && at < window.end;
const sorted = (values: number[]): number[] => values.sort((a, b) => a - b);

/**
 * Start durations of the sessions whose request time is in [window.start, window.end), measured from the Session's creation: to its Deployment's
 * creation (the operator's reconcile), to its Pod's Ready transition, and to the first successful response the harness saw. A pod whose image was
 * pulled is cold; one with no pull event is warm. A negative duration (clock skew between the generator host and the cluster) is left out.
 */
export function startTimes(timeline: Timeline, sessions: readonly Started[], window: Window): MeasuredStarts {
  const out = { reconcileMs: { cold: [] as number[], warm: [] as number[] }, readyMs: { cold: [] as number[], warm: [] as number[] }, firstResponseMs: { cold: [] as number[], warm: [] as number[] } };
  for (const item of sessions) {
    if (!inWindow(item.requestedAt, window)) continue;
    const session = timeline.sessions.get(item.sessionName);
    if (!session) continue;
    const pod = timeline.pods.get(item.sessionName);
    const bucket = pod?.pulled ? 'cold' : 'warm';
    const add = (target: { cold: number[]; warm: number[] }, at: number | null | undefined): void => {
      if (typeof at === 'number' && at >= session.created) target[bucket].push(Math.round(at - session.created));
    };
    add(out.reconcileMs, timeline.deployments.get(item.sessionName)?.created);
    add(out.readyMs, pod?.readyAt);
    add(out.firstResponseMs, item.firstResponseAt);
  }
  const done = (durations: { cold: number[]; warm: number[] }): Durations => ({ cold: sorted(durations.cold), warm: sorted(durations.warm) });
  return { reconcileMs: done(out.reconcileMs), readyMs: done(out.readyMs), firstResponseMs: done(out.firstResponseMs) };
}

export const RECONCILE_WINDOW_MS = 10_000;

/** Deployments created in each 10-second window from window.start (empty windows count as 0), ascending. */
export function reconcilesPer10s(timeline: Timeline, window: Window): number[] {
  const count = Math.ceil((window.end - window.start) / RECONCILE_WINDOW_MS);
  if (count <= 0) return [];
  const windows = new Array<number>(count).fill(0);
  for (const at of timeline.deploymentTimes) if (inWindow(at, window)) windows[Math.floor((at - window.start) / RECONCILE_WINDOW_MS)] += 1;
  return sorted(windows);
}

export interface RoutedSample extends IngressSample {
  /** `host` + path of each rule, with a regular-expression suffix cut at its first "(". */
  readonly routes: readonly string[];
}

/** One sample of the shared Ingress object: its size as kubectl printed it, its rule count and the routes it holds. */
export function ingressSample(text: string, at: number): RoutedSample {
  const ingress = JSON.parse(text) as Json;
  const rules = (field(ingress, 'spec', 'rules') as Json[] | undefined) ?? [];
  const routes = new Set<string>();
  for (const rule of rules) {
    const host = typeof rule.host === 'string' ? rule.host : '';
    const paths = (field(rule, 'http', 'paths') as Json[] | undefined) ?? [];
    for (const path of paths.length > 0 ? paths : [{ path: '/' }]) routes.add(`${host}${String(path.path ?? '/').split('(')[0] || '/'}`);
  }
  return { at, bytes: Buffer.byteLength(text, 'utf8'), rules: rules.length, routes: [...routes].sort() };
}

const routeKey = (url: string): string => {
  const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
  return `${parsed.host}${parsed.pathname}`;
};
/** A rule holds a session's route when it is the session's address, or a path prefix of it longer than the site root. */
const holds = (route: string, key: string): boolean => route === key || (key.startsWith(route) && route.slice(route.indexOf('/')).length > 1);

/**
 * Route propagation per session: from the first sample whose Ingress holds the session's rule to its first successful response. A session that
 * never answered, never appeared in a sample, or answered before a sample showed its rule is counted as unmeasured, never recorded as 0.
 */
export function routePropagation(samples: readonly RoutedSample[], sessions: readonly Started[]): { propagationMs: number[]; unmeasured: number } {
  const ordered = [...samples].sort((a, b) => a.at - b.at);
  const propagationMs: number[] = [];
  let unmeasured = 0;
  for (const item of sessions) {
    const key = routeKey(item.url);
    const first = ordered.find((sample) => sample.routes.some((route) => holds(route, key)));
    if (item.firstResponseAt === null || first === undefined || item.firstResponseAt < first.at) { unmeasured += 1; continue; }
    propagationMs.push(item.firstResponseAt - first.at);
  }
  return { propagationMs: sorted(propagationMs), unmeasured };
}

type Series = { readonly metric: Record<string, string>; readonly values: ReadonlyArray<readonly [number, string]> };
const seriesOf = (response: unknown): Series[] => {
  const result = field(response, 'data', 'result');
  return Array.isArray(result) ? (result as Series[]) : [];
};
const numbers = (series: Series): number[] => series.values.map(([, value]) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0);
const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
function byLabel(response: unknown, label: string, reduce: (values: number[]) => number | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const series of seriesOf(response)) {
    const key = series.metric[label];
    const value = reduce(numbers(series));
    if (key !== undefined && value !== null) out.set(key, value);
  }
  return out;
}

/**
 * Per-session use over the hold window from Prometheus responses: CPU (cores, averaged, as millicores) and working-set memory (bytes, averaged)
 * per pod, and the largest volume use of each session's workspace claim. Sessions named in `active` are the active sample; the rest are idle.
 */
export function usageFromSeries(responses: { readonly cpu: unknown; readonly memory: unknown; readonly volume: unknown }, timeline: Timeline, sessions: readonly Started[], active: readonly string[]): { active: ActiveUsage; idle: Usage } {
  const cpu = byLabel(responses.cpu, 'pod', mean);
  const memory = byLabel(responses.memory, 'pod', mean);
  const volume = byLabel(responses.volume, 'persistentvolumeclaim', (values) => (values.length === 0 ? null : Math.max(...values)));
  const activeSet = new Set(active);
  const collect = (names: readonly string[], withVolume: boolean): ActiveUsage => {
    const out = { sessions: names.length, cpuMillicores: [] as number[], memoryBytes: [] as number[], volumeBytes: [] as number[] };
    for (const name of names) {
      const pod = timeline.pods.get(name)?.name;
      const cores = pod ? cpu.get(pod) : undefined;
      const bytes = pod ? memory.get(pod) : undefined;
      if (cores !== undefined) out.cpuMillicores.push(Math.round(cores * 1000));
      if (bytes !== undefined) out.memoryBytes.push(Math.round(bytes));
      if (withVolume) for (const claim of timeline.deployments.get(name)?.claims ?? []) { const used = volume.get(claim); if (used !== undefined) out.volumeBytes.push(Math.round(used)); }
    }
    return { sessions: out.sessions, cpuMillicores: sorted(out.cpuMillicores), memoryBytes: sorted(out.memoryBytes), volumeBytes: sorted(out.volumeBytes) };
  };
  const names = sessions.map((item) => item.sessionName);
  const { volumeBytes: _unused, ...idle } = collect(names.filter((name) => !activeSet.has(name)), false);
  return { active: collect(names.filter((name) => activeSet.has(name)), true), idle };
}

/** etcd database size and stored object count: the first of each list the live server has. Names vary by etcd and Kubernetes version. */
const DB_SIZE_NAMES = ['etcd_mvcc_db_total_size_in_bytes', 'apiserver_storage_size_bytes', 'apiserver_storage_db_total_size_in_bytes', 'etcd_db_total_size_in_bytes'];
const OBJECT_NAMES = ['apiserver_storage_objects', 'etcd_object_counts'];
export function resolveMetricNames(names: readonly string[]): { dbSize: string | null; objects: string | null } {
  const have = new Set(names);
  return { dbSize: DB_SIZE_NAMES.find((name) => have.has(name)) ?? null, objects: OBJECT_NAMES.find((name) => have.has(name)) ?? null };
}

const lastValue = (response: unknown, reduce: (values: number[]) => number): number | null => {
  const last = seriesOf(response).map((series) => numbers(series).at(-1)).filter((value): value is number => value !== undefined);
  return last.length === 0 ? null : Math.round(reduce(last));
};

export interface MeasureConfig {
  readonly kubectl: Kubectl;
  readonly prometheus: Prometheus;
  readonly clock: Clock;
  readonly namespace: string;
  /** The Session resource as kubectl names it on the rig, for example sessions.theia.cloud (check with `kubectl api-resources`). */
  readonly sessionResource: string;
  /** The AppDefinition's `ingressname`: the one Ingress object the operator edits for every session. */
  readonly ingressName: string;
  readonly pollIntervalMs: number;
  readonly stepSeconds?: number;
}

/** The StageMeasure the controller uses on a rig. Ingress samples are taken while waiting for pods and at each steady state. */
export function createMeasure(config: MeasureConfig): StageMeasure {
  const { kubectl, prometheus, clock, namespace } = config;
  const step = config.stepSeconds ?? 15;
  let samples: RoutedSample[] = [];
  /** Route propagation is computed for the sessions requested since the previous steady state, from the samples taken since then. */
  let since = 0;
  const sample = async (): Promise<void> => {
    samples.push(ingressSample(await kubectl(['get', 'ingress', config.ingressName, '-n', namespace, '-o', 'json']), clock.now()));
  };
  const timeline = (): Promise<Timeline> => readTimeline(kubectl, namespace, config.sessionResource);
  const quote = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return {
    waitReady: async (sessions, limitMs, signal) => {
      const until = clock.now() + limitMs;
      for (;;) {
        await sample();
        const current = await timeline();
        const pending = sessions.filter((item) => typeof current.pods.get(item.sessionName)?.readyAt !== 'number').length;
        if (pending === 0 || clock.now() >= until) return { pending };
        await clock.sleep(Math.min(config.pollIntervalMs, until - clock.now()), signal);
      }
    },
    startTimes: async (sessions, window) => startTimes(await timeline(), sessions, window),
    reconcilesPer10s: async (window) => reconcilesPer10s(await timeline(), window),
    steady: async ({ sessions, active, window }): Promise<MeasuredSteady> => {
      await sample();
      const ns = `namespace="${quote(namespace)}"`;
      const names = resolveMetricNames(await prometheus.names());
      const texts: Array<[string, string | null]> = [
        ['cpu', `sum by (pod) (rate(container_cpu_usage_seconds_total{${ns},container!="",container!="POD"}[1m]))`],
        ['memory', `sum by (pod) (container_memory_working_set_bytes{${ns},container!="",container!="POD"})`],
        ['volume', `max by (persistentvolumeclaim) (kubelet_volume_stats_used_bytes{${ns}})`],
        ['etcd-db-size', names.dbSize === null ? null : `max(${names.dbSize})`],
        ['etcd-objects', names.objects === null ? null : `sum(${names.objects})`]
      ];
      const queries: Query[] = [];
      const responses = new Map<string, unknown>();
      for (const [name, text] of texts) {
        if (text === null) continue;
        responses.set(name, await prometheus.range(text, window.start, window.end, step));
        queries.push({ name, text, from: window.start, to: window.end });
      }
      const current = await timeline();
      const usage = usageFromSeries({ cpu: responses.get('cpu'), memory: responses.get('memory'), volume: responses.get('volume') }, current, sessions, active);
      const taken = samples;
      const propagation = routePropagation(taken, sessions.filter((item) => item.requestedAt >= since));
      samples = [];
      since = clock.now();
      return {
        perPerson: usage,
        ingress: { samples: taken.map(({ at, bytes, rules }) => ({ at, bytes, rules })), propagationMs: propagation.propagationMs, propagationUnmeasured: propagation.unmeasured },
        etcd: { dbSizeBytes: responses.has('etcd-db-size') ? lastValue(responses.get('etcd-db-size'), (values) => Math.max(...values)) : null, objects: responses.has('etcd-objects') ? lastValue(responses.get('etcd-objects'), (values) => values.reduce((sum, value) => sum + value, 0)) : null },
        queries
      };
    }
  };
}
