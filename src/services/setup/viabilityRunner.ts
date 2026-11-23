import { optionIdOf } from '../../domain/setup/ids';
import type { OptionKind } from '../../domain/setup/ids';
import { CHECKING_CEILING_MS, initialViability, nextViability } from '../../domain/setup/viability';
import type { OptionCheckInput, OptionSource, ViabilityResult } from '../../domain/setup/viability';
import { namedLocalEndpoints } from './localServersOption';

interface ViabilityClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> | number;
  clearTimeout(handle: ReturnType<typeof setTimeout> | number): void;
}

export interface RunViabilityInput {
  readonly sources: readonly OptionSource[];
  readonly input: Omit<OptionCheckInput, 'now' | 'progress'> & Partial<Pick<OptionCheckInput, 'now' | 'progress'>>;
  readonly clock?: ViabilityClock;
  readonly ceilingMs?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (result: ViabilityResult) => void;
}

export interface ViabilityRun {
  readonly results: readonly ViabilityResult[];
  readonly stillChecking: readonly string[];
  dispose(): void;
}

export async function runViability({
  sources, input, clock, ceilingMs = CHECKING_CEILING_MS, signal: parent, onProgress
}: RunViabilityInput): Promise<ViabilityRun> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const now = clock ? () => clock.now() : input.now ?? Date.now;
  const start = (kind: OptionKind, id = optionIdOf(kind)) =>
    nextViability({ ...initialViability(id, kind, input.hostKind), policyHash: input.policyHash }, { type: 'start', at: now() });
  const expected = sources.map((source) => source.kinds.flatMap((kind) => kind === 'org-server'
    ? namedLocalEndpoints(input.endpoints).map((endpoint) => ({ ...start(kind, optionIdOf(kind, endpoint.id)), endpoint }))
    : [start(kind)]));
  const results = new Map(expected.flat().map((result) => [result.optionId, result]));

  const publish = (result: ViabilityResult) => {
    if (signal.aborted || results.get(result.optionId) === result) return;
    results.set(result.optionId, result);
    input.progress?.(result);
    if (onProgress !== input.progress) onProgress?.(result);
  };
  const fail = (row: ViabilityResult) => publish(nextViability(row, {
    type: 'failed', at: now(), check: 'detected', reasonCode: 'not-detected',
  }));
  const checks = sources.map(async (source, index) => {
    if (signal.aborted) return;
    const progress = (result: ViabilityResult) => {
      if (source.kinds.includes(result.kind)) publish(result);
    };
    try {
      progress(await source.check({ ...input, now, progress }, signal));
    } catch {
      for (const kind of source.kinds) {
        if (!expected[index]?.some((row) => row.kind === kind)) fail(start(kind));
      }
    }
    for (const row of expected[index] ?? []) {
      const latest = results.get(row.optionId);
      if (latest?.state === 'checking') fail(latest);
    }
  });
  const setTimer = clock ? clock.setTimeout.bind(clock) : setTimeout;
  const clearTimer = clock ? clock.clearTimeout.bind(clock) : clearTimeout;
  let timer: ReturnType<typeof setTimer>;
  const ceiling = new Promise<void>((resolve) => { timer = setTimer(resolve, ceilingMs); });
  let onAbort!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    await Promise.race([Promise.all(checks), ceiling, cancelled]);
    signal.throwIfAborted();
  } finally {
    clearTimer(timer!);
    signal.removeEventListener('abort', onAbort);
  }
  const snapshot = [...results.values()].map((row) => nextViability(row, { type: 'ceiling', at: now() }));
  return {
    results: snapshot,
    stillChecking: snapshot.filter(({ reasonCode }) => reasonCode === 'still-checking').map(({ optionId }) => optionId),
    dispose: () => controller.abort(),
  };
}
