// Schema and pre-dial restriction for the standalone loopback fixture.
export const HUB_PEOPLE = 5;
export const HUB_HOLD_MS = 5000;

export interface HubSmoke {
  readonly label: 'fixture-hub';
  readonly persons: number;
  readonly streams: number;
  readonly appends: number;
  readonly durationMs: number;
  readonly refusals: number;
  readonly appendMs: readonly number[];
  readonly healthMs: readonly number[];
  readonly cpuMillicores: null;
  readonly memoryBytes: null;
}

export async function openFixtureHub<T>(candidate: string, registered: string | undefined, connect: (port: number) => Promise<T>): Promise<T> {
  const match = /^https:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(candidate);
  const port = Number(match?.[1]);
  if (!match || candidate !== registered || match[0] !== candidate || port > 65535) {
    throw new Error('The hub target is outside the registered fixture listener.');
  }
  return connect(port);
}

const bounded = (value: unknown, limit: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0 && value <= limit;

function samples(value: unknown): value is readonly number[] {
  if (!Array.isArray(value) || value.length > HUB_PEOPLE) return false;
  let previous = 0;
  for (const sample of value) {
    if (!bounded(sample, HUB_HOLD_MS) || sample < previous) return false;
    previous = sample;
  }
  return true;
}

export function readHubSmoke(value: unknown): HubSmoke | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'appendMs,appends,cpuMillicores,durationMs,healthMs,label,memoryBytes,persons,refusals,streams' ||
      row.label !== 'fixture-hub' || row.persons !== HUB_PEOPLE || row.durationMs !== HUB_HOLD_MS ||
      row.cpuMillicores !== null || row.memoryBytes !== null ||
      !bounded(row.streams, HUB_PEOPLE) || !bounded(row.appends, HUB_PEOPLE) || !bounded(row.refusals, HUB_PEOPLE * 2) ||
      !samples(row.appendMs) || row.appendMs.length !== row.appends || !samples(row.healthMs)) return undefined;
  return value as HubSmoke;
}
