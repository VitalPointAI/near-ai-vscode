// One load-test run, one file (Phase 48 D-09, D-22): loadtest/runs/<id>.run.json, where <id> is the UTC start time and the rig name. The file
// holds the run's inputs, the hardware and versions it ran on, and every raw value the capacity page's figures come from, and its hash is the
// sha256 of the canonical form (sorted keys, integers only) of everything else. The reader is strict: an unknown key, a missing field, a number
// that is not a non-negative safe integer, or raw values out of ascending order are refused, so a figure cannot enter by a hand edit.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize } from '../../compliance/src/signed.ts';
import { matchRules } from '../../scripts/lib/workflow.mjs';
import { HUB_HOLD_MS, HUB_PEOPLE, readHubSmoke, type HubSmoke } from './hub.ts';

export const RUN_SCHEMA = 1;
const EXPERIMENT_SCHEMA = 2;
export const RUN_KINDS = ['load', 'experiment', 'dry-run'] as const;
export type RunKind = (typeof RUN_KINDS)[number];
/** The largest run file accepted. Long metric series are not stored, only the queries and their time ranges. */
export const MAX_RUN_BYTES = 5 * 1024 * 1024;
/** `<UTC start yyyymmddThhmmssZ>-<rig>`; the rig name is lower case letters, digits and hyphens. */
export const RUN_ID = /^\d{8}T\d{6}Z-[a-z0-9][a-z0-9-]{0,62}$/;
export const RUN_SUFFIX = '.run.json';
/** A bearer token (JWT) never belongs in a run file; the repository's secret rules do not cover it, so the run file checks for it too. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

/** Integer milliseconds, cold (image pulled on the node) and warm (image already present), each ascending. */
export interface Durations { readonly cold: readonly number[]; readonly warm: readonly number[] }
export interface StartTimes {
  readonly requested: number;
  /** Starts the service refused or that failed. */
  readonly failed: number;
  /** Starts with no successful response within the start timeout. */
  readonly timedOut: number;
  /** Session creation to Deployment creation (the operator's reconcile). */
  readonly reconcileMs: Durations;
  /** Session creation to the Pod Ready transition. */
  readonly readyMs: Durations;
  /** Session creation to the first successful response the harness saw through the ingress (poll interval in the inputs). */
  readonly firstResponseMs: Durations;
}
export interface Window { readonly start: number; readonly end: number }
export interface Usage {
  readonly sessions: number;
  /** Per-pod averages over the hold window, ascending. */
  readonly cpuMillicores: readonly number[];
  readonly memoryBytes: readonly number[];
}
export interface ActiveUsage extends Usage {
  /** Per-claim workspace volume use, ascending. */
  readonly volumeBytes: readonly number[];
}
export interface IngressSample { readonly at: number; readonly bytes: number; readonly rules: number }
export interface Query { readonly name: string; readonly text: string; readonly from: number; readonly to: number }
export interface Burst {
  readonly size: number;
  readonly reached: boolean;
  readonly reason: string;
  readonly peakConcurrency: number;
  readonly window: Window;
  readonly start: StartTimes;
  /** Deployments created per 10-second window during the burst, ascending. */
  readonly reconcilesPer10s: readonly number[];
}
export interface StageResult {
  readonly target: number;
  readonly reached: boolean;
  readonly reason: string;
  /** [start, end): a session belongs to the stage whose window holds its request time. */
  readonly window: Window;
  /** Sessions held through the steady state. */
  readonly sessions: number;
  readonly start: StartTimes;
  readonly burst: Burst;
  /** Per-person figures come only from the active sample; the idle (no frontend) population is kept apart (D-21). */
  readonly perPerson: { readonly active: ActiveUsage; readonly idle: Usage };
  readonly ingress: { readonly samples: readonly IngressSample[]; readonly propagationMs: readonly number[]; readonly propagationUnmeasured: number };
  readonly etcd: { readonly dbSizeBytes: number | null; readonly objects: number | null };
  readonly queries: readonly Query[];
  readonly hubs?: readonly HubSmoke[];
}
export interface RunInputs {
  readonly stages: readonly number[];
  readonly burst: number;
  readonly holdMs: number;
  readonly activityIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly rampConcurrency: number;
  readonly startTimeoutMs: number;
  readonly pendingLimitMs: number;
  readonly maxFailedPercent: number;
  readonly idleTimeoutMinutes: number;
  readonly activeSample: number;
  readonly profile: { readonly id: string; readonly version: string; readonly sha256: string };
  readonly appDefinition: { readonly name: string; readonly image: string };
  readonly sessionsPerUser: number;
  readonly testRealm: { readonly name: string; readonly differences: readonly string[] };
}
export interface RunNode { readonly name: string; readonly role: string; readonly cpuMillicores: number; readonly memoryBytes: number; readonly maxPods: number }
export interface RunHardware { readonly nodes: readonly RunNode[]; readonly storageClass: string; readonly imagesPreloaded: boolean; readonly network: string }
export interface RunVersions {
  readonly workbenchImage: string;
  readonly theiaCloud: { readonly chart: string; readonly commit: string; readonly operatorImage: string };
  readonly keycloak: string;
  readonly openbao: string;
  readonly ingress: { readonly kind: string; readonly version: string };
  readonly rke2: string;
  readonly hub: string;
}
export interface UnhashedRun {
  readonly schema: typeof RUN_SCHEMA | typeof EXPERIMENT_SCHEMA;
  readonly kind: RunKind;
  readonly id: string;
  readonly rig: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly inputs: RunInputs;
  readonly hardware: RunHardware;
  readonly versions: RunVersions;
  readonly peakConcurrency: number;
  readonly stages: readonly StageResult[];
}
export interface RunFile extends UnhashedRun { readonly hash: string }

export class RunFileError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RunFileError';
  }
}

// The schema, as a small spec: 'n' a non-negative safe integer, 'n?' the same or null, 'asc' an ascending array of 'n', 's' a string, 'b' a
// boolean; an array of one spec is an array of that; an object is an object with exactly those keys.
type Spec = 'n' | 'n?' | 'asc' | 's' | 'b' | 'hub' | readonly [Spec] | { readonly [key: string]: Spec };
const DURATIONS: Spec = { cold: 'asc', warm: 'asc' };
const START: Spec = { requested: 'n', failed: 'n', timedOut: 'n', reconcileMs: DURATIONS, readyMs: DURATIONS, firstResponseMs: DURATIONS };
const WINDOW: Spec = { start: 'n', end: 'n' };
const STAGE: Readonly<Record<string, Spec>> = {
  target: 'n', reached: 'b', reason: 's', window: WINDOW, sessions: 'n', start: START,
  burst: { size: 'n', reached: 'b', reason: 's', peakConcurrency: 'n', window: WINDOW, start: START, reconcilesPer10s: 'asc' },
  perPerson: { active: { sessions: 'n', cpuMillicores: 'asc', memoryBytes: 'asc', volumeBytes: 'asc' }, idle: { sessions: 'n', cpuMillicores: 'asc', memoryBytes: 'asc' } },
  ingress: { samples: [{ at: 'n', bytes: 'n', rules: 'n' }], propagationMs: 'asc', propagationUnmeasured: 'n' },
  etcd: { dbSizeBytes: 'n?', objects: 'n?' },
  queries: [{ name: 's', text: 's', from: 'n', to: 'n' }]
};
const RUN: { readonly [key: string]: Spec } = {
  schema: 'n', kind: 's', id: 's', rig: 's', startedAt: 'n', endedAt: 'n',
  inputs: {
    stages: 'asc', burst: 'n', holdMs: 'n', activityIntervalMs: 'n', pollIntervalMs: 'n', rampConcurrency: 'n', startTimeoutMs: 'n', pendingLimitMs: 'n',
    maxFailedPercent: 'n', idleTimeoutMinutes: 'n', activeSample: 'n', profile: { id: 's', version: 's', sha256: 's' }, appDefinition: { name: 's', image: 's' },
    sessionsPerUser: 'n', testRealm: { name: 's', differences: ['s'] }
  },
  hardware: { nodes: [{ name: 's', role: 's', cpuMillicores: 'n', memoryBytes: 'n', maxPods: 'n' }], storageClass: 's', imagesPreloaded: 'b', network: 's' },
  versions: { workbenchImage: 's', theiaCloud: { chart: 's', commit: 's', operatorImage: 's' }, keycloak: 's', openbao: 's', ingress: { kind: 's', version: 's' }, rke2: 's', hub: 's' },
  peakConcurrency: 'n',
  stages: [STAGE]
};
const EXPERIMENT: Spec = { ...RUN, stages: [{ ...STAGE, hubs: ['hub'] }] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);

function check(value: unknown, spec: Spec, at: string): void {
  if (spec === 'hub') {
    if (!readHubSmoke(value)) throw new RunFileError(`${at}: invalid bounded hub observation`);
    return;
  }
  if (spec === 'n' || spec === 'n?') {
    if (spec === 'n?' && value === null) return;
    if (!isCount(value)) throw new RunFileError(`${at}: must be a non-negative integer`);
    return;
  }
  if (spec === 's') { if (typeof value !== 'string') throw new RunFileError(`${at}: must be a string`); return; }
  if (spec === 'b') { if (typeof value !== 'boolean') throw new RunFileError(`${at}: must be true or false`); return; }
  if (spec === 'asc') {
    if (!Array.isArray(value)) throw new RunFileError(`${at}: must be an array`);
    value.forEach((item, index) => {
      if (!isCount(item)) throw new RunFileError(`${at}[${index}]: must be a non-negative integer`);
      if (index > 0 && item < value[index - 1]) throw new RunFileError(`${at}: must be in ascending order`);
    });
    return;
  }
  if (Array.isArray(spec)) {
    if (!Array.isArray(value)) throw new RunFileError(`${at}: must be an array`);
    value.forEach((item, index) => check(item, spec[0], `${at}[${index}]`));
    return;
  }
  if (!isRecord(value)) throw new RunFileError(`${at}: must be an object`);
  const fields = spec as { readonly [key: string]: Spec };
  for (const key of Object.keys(value)) if (!(key in fields)) throw new RunFileError(`${at}.${key}: unknown key`);
  for (const [key, child] of Object.entries(fields)) {
    if (!(key in value)) throw new RunFileError(`${at}.${key}: missing`);
    check(value[key], child, `${at}.${key}`);
  }
}

/** Refuses anything that is not a complete, well-formed run (hash not included). */
export function checkRun(value: unknown): asserts value is UnhashedRun {
  const { hash: _hash, ...rest } = isRecord(value) ? value : { hash: undefined };
  const schema = (rest as Record<string, unknown>).schema;
  check(rest, schema === EXPERIMENT_SCHEMA ? EXPERIMENT : RUN, '$');
  const run = rest as unknown as UnhashedRun;
  if (run.schema !== RUN_SCHEMA && run.schema !== EXPERIMENT_SCHEMA) throw new RunFileError(`$.schema: unrecognized schema`);
  if (!(RUN_KINDS as readonly string[]).includes(run.kind)) throw new RunFileError(`$.kind: must be one of ${RUN_KINDS.join(', ')}`);
  if (run.schema === EXPERIMENT_SCHEMA) {
    const stage = run.stages[0];
    const hub = stage?.hubs?.[0];
    if (run.kind !== 'experiment' || run.stages.length !== 1 || stage?.target !== HUB_PEOPLE || !stage.reached ||
        run.inputs.stages.length !== 1 || run.inputs.stages[0] !== HUB_PEOPLE || run.inputs.holdMs !== HUB_HOLD_MS ||
        run.inputs.burst !== 0 || stage.hubs?.length !== 1 || !hub || hub.streams !== HUB_PEOPLE ||
        hub.appends === 0 || hub.healthMs.length === 0) {
      throw new RunFileError('schema 2 requires one successful bounded hub experiment stage');
    }
  }
  if (!RUN_ID.test(run.id)) throw new RunFileError('$.id: must be <UTC start yyyymmddThhmmssZ>-<rig>');
  if (!run.id.endsWith(`-${run.rig}`)) throw new RunFileError('$.id: must end with the rig name');
  run.stages.forEach((item, index) => {
    if (index > 0 && item.target <= run.stages[index - 1].target) throw new RunFileError('$.stages: targets must be in ascending order');
    item.ingress.samples.forEach((sample, at) => {
      if (at > 0 && sample.at < item.ingress.samples[at - 1].at) throw new RunFileError(`$.stages[${index}].ingress.samples: must be in ascending order of time`);
    });
  });
}

/** `sha256:` and the hex SHA-256 of the canonical JSON of the run without its hash. */
export function hashRun(run: UnhashedRun | RunFile): string {
  const { hash: _hash, ...rest } = run as RunFile;
  return `sha256:${createHash('sha256').update(canonicalize(rest), 'utf8').digest('hex')}`;
}

/** Throws when the canonical text holds anything secret-shaped. Uses the rules without the allow marker: nothing in a run file may opt out. */
function refuseSecrets(text: string): void {
  const rules = matchRules(text);
  if (rules.length > 0) throw new RunFileError(`run file holds a secret-shaped string (${rules.join(', ')})`);
  if (JWT.test(text)) throw new RunFileError('run file holds a token-shaped string (jwt)');
}

/** Parses and checks one run file's text, without checking the hash. */
export function readRun(text: string): RunFile {
  if (Buffer.byteLength(text, 'utf8') > MAX_RUN_BYTES) throw new RunFileError(`run file is over the size cap of ${MAX_RUN_BYTES} bytes`);
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || typeof value.hash !== 'string') throw new RunFileError('$.hash: missing');
  checkRun(value);
  return value as unknown as RunFile;
}

/** Parses, checks and verifies one run file's text: a run whose hash does not match its content is refused. */
export function verifyRunFile(text: string): RunFile {
  const run = readRun(text);
  if (hashRun(run) !== run.hash) throw new RunFileError(`${run.id}: hash does not match the content`);
  refuseSecrets(canonicalize(run));
  return run;
}

/** Checks, hashes and writes a run into `dir` as `<id>.run.json`, created exclusively: an existing file is never overwritten. Returns the path. */
export function writeRunFile(dir: string, run: UnhashedRun): string {
  checkRun(run);
  const canonical = canonicalize(run);
  refuseSecrets(canonical);
  const sealed: RunFile = { ...run, hash: hashRun(run) };
  // Pretty-printed with sorted keys, so a reviewer's diff reads the way the hash is taken.
  const text = `${JSON.stringify(JSON.parse(canonicalize(sealed)), null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_RUN_BYTES) throw new RunFileError(`run file would be over the size cap of ${MAX_RUN_BYTES} bytes`);
  const file = join(dir, `${run.id}${RUN_SUFFIX}`);
  const fd = openSync(file, 'wx', 0o644);
  try { writeSync(fd, text); } finally { closeSync(fd); }
  return file;
}

/** Every `*.run.json` in `dir`, verified, in id order; a missing folder is no runs. A file whose name is not its id is refused. */
export function loadRunFiles(dir: string): RunFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(RUN_SUFFIX))
    .map((entry) => {
      const run = verifyRunFile(readFileSync(join(dir, entry.name), 'utf8'));
      if (entry.name !== `${run.id}${RUN_SUFFIX}`) throw new RunFileError(`${entry.name}: file name must be the run id ${run.id}${RUN_SUFFIX}`);
      return run;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
