import { firstUsableHost, hostCount, hostsOf, parseCidr, type Cidr } from '../../domain/setup/cidr';
import type { DiscoveryWays } from '../../domain/setup/network';
import { createTokenBucket, SCAN_HOSTS_PER_SECOND } from '../../domain/setup/rateLimit';
import { MODEL_SERVER_PORTS, type ServerCandidate } from '../../domain/setup/servers';
import type { DiscoveryClock } from './mdns';

export const MAX_HOSTS_PER_SCAN = 65_536;
export const SCAN_CONNECT_TIMEOUT_MS = 800;
export const SCAN_CONFIRM_TEXT = 'This scan tries {hosts} addresses in {ranges} on ports {ports}. It takes about {minutes} minutes and runs in the background. Your network team may see this as a scan.';
export const SCAN_RUNNING_TEXT = 'Checking {done} of {total} addresses.';
export const SCAN_STOPPED_TEXT = 'The scan stopped.';

export interface ScanPlan {
  readonly networkId: string;
  readonly ranges: readonly string[];
  readonly ports: readonly number[];
  readonly hosts: number;
  readonly estimatedSeconds: number;
}

type Refusal = 'not-listed-network' | 'no-ranges' | 'range-not-listed' | 'too-many-hosts' | 'port-not-allowed';

function listedRanges(ways: DiscoveryWays): ReadonlySet<string> {
  const networkId = ways.network?.id;
  return new Set(ways.scanRanges.filter(({ network }) => network === undefined || network === networkId).map(({ cidr }) => cidr));
}

function* distinctHosts(ranges: readonly string[]): Generator<string> {
  const visited = new Set<string>();
  const cidrs = new Set<string>();
  for (const range of ranges) {
    const cidr = parseCidr(range);
    if (!cidr) continue;
    const key = String(cidr.base) + '/' + String(cidr.prefix);
    if (cidrs.has(key)) continue;
    cidrs.add(key);
    for (const host of hostsOf(cidr, MAX_HOSTS_PER_SCAN)) {
      if (visited.has(host)) continue;
      visited.add(host);
      yield host;
    }
  }
}

function distinctHostCount(cidrs: readonly Cidr[]): number {
  const spans = cidrs.map((cidr) => ({ start: firstUsableHost(cidr), count: hostCount(cidr) }))
    .sort((left, right) => left.start - right.start);
  let end = 0;
  let total = 0;
  for (const { start, count } of spans) {
    const nextEnd = start + count;
    if (nextEnd <= end) continue;
    total += nextEnd - Math.max(start, end);
    end = nextEnd;
  }
  return total;
}

export function planScan({ ways, requested, ports: requestedPorts = MODEL_SERVER_PORTS }: {
  readonly ways: DiscoveryWays;
  readonly requested?: readonly string[];
  readonly ports?: readonly number[];
}): { ok: true; plan: ScanPlan } | { ok: false; reason: Refusal } {
  if (!ways.network) return { ok: false, reason: 'not-listed-network' };
  const configured = listedRanges(ways);
  const ranges = [...new Set(requested ?? configured)];
  if (configured.size === 0 || ranges.length === 0) return { ok: false, reason: 'no-ranges' };
  const cidrs: Cidr[] = [];
  for (const range of ranges) {
    const cidr = configured.has(range) ? parseCidr(range) : undefined;
    if (!cidr) return { ok: false, reason: 'range-not-listed' };
    cidrs.push(cidr);
  }
  const ports = [...new Set(requestedPorts)];
  const known: readonly number[] = MODEL_SERVER_PORTS;
  if (ports.length === 0 || ports.some((port) => !known.includes(port))) return { ok: false, reason: 'port-not-allowed' };
  const hosts = distinctHostCount(cidrs);
  if (hosts > MAX_HOSTS_PER_SCAN) return { ok: false, reason: 'too-many-hosts' };
  return { ok: true, plan: Object.freeze({
    networkId: ways.network.id, ranges: Object.freeze(ranges), ports: Object.freeze(ports),
    hosts, estimatedSeconds: Math.ceil(hosts / SCAN_HOSTS_PER_SECOND),
  }) };
}

export type ScanRecorder = (phase: 'start' | 'end', detail: {
  readonly ranges: readonly string[];
  readonly ports: readonly number[];
  readonly found: number;
}) => void | PromiseLike<void>;

interface ScanInput {
  readonly plan: ScanPlan;
  readonly confirmed: true;
  /** Current verified policy and network facts, supplied by the guide host. */
  ways(): DiscoveryWays;
  /** Resolves after the transport has closed. No request data crosses this port. */
  connect(host: string, port: number, timeoutMs: number, signal: AbortSignal): PromiseLike<boolean>;
  readonly clock: DiscoveryClock;
  readonly signal: AbortSignal;
  onFound(candidate: ServerCandidate): void;
  onProgress(done: number, total: number): void;
  record: ScanRecorder;
}

function liveWays(input: ScanInput): DiscoveryWays | undefined {
  try { return input.ways(); } catch { return undefined; }
}

function currentPlan(input: ScanInput): ScanPlan | undefined {
  if (input.confirmed !== true || input.signal.aborted) return undefined;
  if (!Array.isArray(input.plan?.ranges) || !Array.isArray(input.plan.ports)) return undefined;
  const ways = liveWays(input);
  if (!ways || ways.network?.id !== input.plan.networkId) return undefined;
  const review = planScan({ ways, requested: input.plan.ranges, ports: input.plan.ports });
  if (!review.ok || review.plan.hosts !== input.plan.hosts || review.plan.estimatedSeconds !== input.plan.estimatedSeconds) return undefined;
  return review.plan;
}

function stillAllowed(input: ScanInput, plan: ScanPlan): boolean {
  if (input.signal.aborted) return false;
  const ways = liveWays(input);
  if (!ways || ways.network?.id !== plan.networkId) return false;
  const configured = listedRanges(ways);
  return plan.ranges.every((range) => configured.has(range));
}

function waitForSlot(input: ScanInput, delay: number): Promise<void> {
  return new Promise((resolve) => {
    const { clock, signal } = input;
    const finish = () => {
      clock.clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = clock.setTimeout(finish, delay);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

type Attempt = 'open' | 'closed' | 'stopped';

function attempt(input: ScanInput, plan: ScanPlan, host: string, port: number): Promise<Attempt> {
  return new Promise((resolve) => {
    const { clock, signal } = input;
    const transport = new AbortController();
    let finished = false;
    let timer: unknown;
    const stop = () => finish('stopped');
    function finish(result: Attempt) {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      if (result === 'stopped') transport.abort();
      resolve(result);
    }
    signal.addEventListener('abort', stop, { once: true });
    if (!stillAllowed(input, plan) || finished) return stop();
    try {
      const connection = input.connect(host, port, SCAN_CONNECT_TIMEOUT_MS, transport.signal);
      // Let the adapter close an ordinary timed-out port before applying the watchdog.
      if (!finished) timer = clock.setTimeout(stop, SCAN_CONNECT_TIMEOUT_MS);
      void Promise.resolve(connection).then((open) => finish(open ? 'open' : 'closed'), () => finish('closed'));
    } catch {
      finish('closed');
    }
  });
}

export async function runScan(input: ScanInput): Promise<{ found: number; stopped: boolean }> {
  const plan = currentPlan(input);
  if (!plan) return { found: 0, stopped: true };
  // A single-token burst spaces the starts even when every port closes immediately.
  const pace = createTokenBucket({ ratePerSecond: SCAN_HOSTS_PER_SECOND, burst: 1 });
  let found = 0;
  let done = 0;
  const { ranges, ports, hosts } = plan;
  await input.record('start', { ranges, ports, found });
  try {
    for (const host of distinctHosts(ranges)) {
      const delay = pace.wait(input.clock.now());
      if (!Number.isFinite(delay)) return { found, stopped: true };
      if (delay > 0) await waitForSlot(input, delay);
      if (!pace.take(input.clock.now())) return { found, stopped: true };
      for (const port of ports) {
        const result = await attempt(input, plan, host, port);
        if (result === 'stopped' || !stillAllowed(input, plan)) return { found, stopped: true };
        if (result !== 'open') continue;
        found++;
        input.onFound({ target: { host, port, scheme: 'https', source: 'scanned' }, foundBy: 'scanned', foundAt: input.clock.now() });
      }
      input.onProgress(++done, hosts);
    }
    return { found, stopped: input.signal.aborted };
  } finally {
    await input.record('end', { ranges, ports, found });
  }
}
