// Builds run files for the tests: every field the schema needs, with values a test can override. Not a real run.
import type { RunFile, StageResult, StartTimes, UnhashedRun } from '../../src/runfile.ts';

export const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);

export function emptyStart(): StartTimes {
  return { requested: 0, failed: 0, timedOut: 0, reconcileMs: { cold: [], warm: [] }, readyMs: { cold: [], warm: [] }, firstResponseMs: { cold: [], warm: [] } };
}

export function ascending(count: number, from: number, step: number): number[] {
  return Array.from({ length: count }, (_, index) => from + index * step);
}

export function stage(target: number, overrides: Partial<StageResult> = {}): StageResult {
  return {
    target,
    reached: true,
    reason: '',
    window: { start: T0, end: T0 + 60_000 },
    sessions: target,
    start: { ...emptyStart(), requested: target, readyMs: { cold: ascending(target, 10_000, 10), warm: [] } },
    burst: { size: 0, reached: false, reason: 'not attempted', peakConcurrency: target, window: { start: T0 + 60_000, end: T0 + 60_000 }, start: emptyStart(), reconcilesPer10s: [] },
    perPerson: { active: { sessions: 0, cpuMillicores: [], memoryBytes: [], volumeBytes: [] }, idle: { sessions: 0, cpuMillicores: [], memoryBytes: [] } },
    ingress: { samples: [], propagationMs: [], propagationUnmeasured: 0 },
    etcd: { dbSizeBytes: null, objects: null },
    queries: [],
    ...overrides
  };
}

export function notReached(target: number, reason: string): StageResult {
  return stage(target, { reached: false, reason, sessions: 0, window: { start: 0, end: 0 }, start: emptyStart() });
}

export function makeRun(overrides: Partial<UnhashedRun> = {}): UnhashedRun {
  const stages = overrides.stages ?? [stage(50)];
  return {
    schema: 1,
    kind: 'load',
    id: '20261123T120000Z-rig1',
    rig: 'rig1',
    startedAt: T0,
    endedAt: T0 + 3_600_000,
    inputs: {
      stages: stages.map((item) => item.target),
      burst: 0,
      holdMs: 60_000,
      activityIntervalMs: 30_000,
      pollIntervalMs: 500,
      rampConcurrency: 25,
      startTimeoutMs: 180_000,
      pendingLimitMs: 300_000,
      maxFailedPercent: 1,
      idleTimeoutMinutes: 30,
      activeSample: 0,
      profile: { id: 'activity', version: '1', sha256: 'sha256:' + '0'.repeat(64) },
      appDefinition: { name: 'workbench-loadtest', image: 'registry.example/workbench@sha256:' + '1'.repeat(64) },
      sessionsPerUser: 1,
      testRealm: { name: 'loadtest-sterling', differences: ['password grant on for loadtest-client', 'attestation not required'] }
    },
    hardware: {
      nodes: [{ name: 'node-1', role: 'worker', cpuMillicores: 64_000, memoryBytes: 512 * 1024 ** 3, maxPods: 110 }],
      storageClass: 'encrypted-local',
      imagesPreloaded: true,
      network: '25 GbE'
    },
    versions: {
      workbenchImage: 'sha256:' + '1'.repeat(64),
      theiaCloud: { chart: '1.1.0', commit: 'abc123', operatorImage: 'sha256:' + '2'.repeat(64) },
      keycloak: '26.0.0',
      openbao: '2.1.0',
      ingress: { kind: 'haproxy', version: '3.1.0' },
      rke2: 'v1.31.0+rke2r1',
      hub: 'sha256:' + '3'.repeat(64)
    },
    peakConcurrency: Math.max(0, ...stages.map((item) => item.burst.peakConcurrency)),
    stages,
    ...overrides
  };
}

export type { RunFile };
