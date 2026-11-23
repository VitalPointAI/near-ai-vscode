import { Resolver } from 'node:dns/promises';
import type { DiscoveryNetwork } from '../../domain/gate/sections';
import { ANNOUNCED_SERVICE } from '../../domain/setup/network';
import type { DiscoveryWays } from '../../domain/setup/network';
import type { ServerCandidate } from '../../domain/setup/servers';
import { MAX_ANNOUNCED } from './mdns';
import type { DiscoveryClock } from './mdns';

interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

export interface SrvResolverLike {
  resolveSrv(name: string, signal?: AbortSignal): Promise<readonly SrvRecord[]>;
}

/** Use the host resolver without keeping DNS work alive beyond this discovery attempt. */
export const hostSrvResolver: SrvResolverLike = {
  async resolveSrv(name, signal) {
    signal?.throwIfAborted();
    const resolver = new Resolver();
    const cancel = () => resolver.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await resolver.resolveSrv(name);
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  },
};

interface LookupInput {
  readonly ways: DiscoveryWays;
  readonly networks: readonly DiscoveryNetwork[];
  readonly resolver: SrvResolverLike;
  readonly clock: DiscoveryClock;
  readonly signal?: AbortSignal;
}

const SRV_TIMEOUT_MS = 3000;
const MAX_DNS_HOST_LENGTH = 253;
const MAX_PORT = 65535;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeHost(name: string): string | undefined {
  if (/[^a-zA-Z0-9.-]/.test(name)) return undefined;
  const host = name.toLowerCase().replace(/\.$/, '');
  if (host.length > MAX_DNS_HOST_LENGTH) return undefined;
  const labels = host.split('.');
  if (!labels.every(label => DNS_LABEL.test(label))) return undefined;
  // URL parsers interpret a numeric final label as an IPv4 address or alias.
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(labels[labels.length - 1])) return undefined;
  return host;
}

function resolveBeforeDeadline(input: LookupInput, query: string): Promise<readonly SrvRecord[]> {
  const { clock, signal, resolver } = input;
  const deadline = clock.now() + SRV_TIMEOUT_MS;
  return new Promise(resolve => {
    let finished = false;
    const request = new AbortController();
    const stop = (): void => {
      finish([]);
      request.abort();
    };
    const finish = (records: readonly SrvRecord[]): void => {
      if (finished) return;
      finished = true;
      clock.clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve(records);
    };
    const timer = clock.setTimeout(stop, SRV_TIMEOUT_MS);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) return stop();
    try {
      void resolver.resolveSrv(query, request.signal).then(
        records => finish(clock.now() < deadline ? records : []),
        stop,
      );
    } catch {
      stop();
    }
  });
}

export async function lookupAnnouncedSrv(input: LookupInput): Promise<readonly ServerCandidate[]> {
  const { ways, networks, clock, signal } = input;
  if (!ways.announce || !ways.network?.dnsSuffix || signal?.aborted) return [];
  const current = ways.network;
  const listed = networks.find(network => network.id === current.id && network.dnsSuffix === current.dnsSuffix);
  const suffix = listed?.dnsSuffix && normalizeHost(listed.dnsSuffix);
  if (!suffix) return [];
  const query = `${ANNOUNCED_SERVICE}.${suffix}`;
  if (query.length > MAX_DNS_HOST_LENGTH) return [];

  const records = await resolveBeforeDeadline(input, query);
  if (signal?.aborted) return [];
  const candidates: ServerCandidate[] = [];
  const endpoints = new Set<string>();
  for (const record of [...records].sort((a, b) => a.priority - b.priority || a.weight - b.weight)) {
    const host = normalizeHost(record.name);
    const { port } = record;
    if (!host || !Number.isInteger(port) || port < 1 || port > MAX_PORT) continue;
    const endpoint = `${host}:${port}`;
    if (endpoints.has(endpoint)) continue;
    endpoints.add(endpoint);
    candidates.push({ target: { host, port, scheme: 'https', source: 'announced' }, foundBy: 'announced', foundAt: clock.now() });
    if (candidates.length === MAX_ANNOUNCED) break;
  }
  return candidates;
}
