import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { findEndpoint, type PolicyEndpoint } from '../../domain/gate/endpoints';
import type { DiscoverySection } from '../../domain/gate/sections';
import { cleanFreeText } from '../../domain/setup/answers';
import { discoveryWays, type NetworkFactsReader } from '../../domain/setup/network';
import type { GuidePolicy } from '../../domain/setup/policy';
import type { FoundServerRow, GuideDiscoveryPort, ScanOffer } from '../../domain/setup/screens';
import type { Identification, ServerCandidate } from '../../domain/setup/servers';
import { foundEndpointId } from './approval';
import { readSpkiPin, type TlsConnectLike } from './certPin';
import { createIdentify } from './identify';
import { browseAnnounced, MAX_ANNOUNCED, type DatagramLike, type DiscoveryClock } from './mdns';
import { probeOrigin } from './probe';
import { lookupAnnouncedSrv, type SrvResolverLike } from './srv';

export interface GuideDiscoveryDeps {
  policy(): GuidePolicy;
  endpoints(): readonly PolicyEndpoint[];
  readonly organization: { readonly present: boolean; readonly issuedHere: boolean };
  readonly networkFacts: NetworkFactsReader;
  createSocket(): DatagramLike;
  readonly resolver: SrvResolverLike;
  readonly tlsConnect: TlsConnectLike;
  fetchForPin(pin: string): typeof fetch;
  readonly clock: DiscoveryClock;
}

const scanOff: ScanOffer = Object.freeze({ offered: false, ranges: Object.freeze([]), running: false });
const cannotRequest: typeof fetch = async () => { throw new Error('No authorized pinned signature request'); };

function announcedCandidates(groups: readonly (readonly ServerCandidate[])[], eligible: (candidate: ServerCandidate) => boolean): readonly ServerCandidate[] {
  const candidates = new Map<string, ServerCandidate>();
  const ids = new Set<string>();
  for (const candidate of groups.flat()) {
    const address = candidate.target.host;
    const origin = probeOrigin({ ...candidate.target, host: isIP(address) === 6 ? `[${address}]` : address });
    if (origin?.protocol !== 'https:') continue;
    const host = origin.hostname;
    const { port } = candidate.target;
    const id = foundEndpointId(host, port);
    if (candidates.has(origin.origin) || ids.has(id)) continue;
    const normalized = { ...candidate, target: { ...candidate.target, host } };
    if (!eligible(normalized)) continue;
    ids.add(id);
    candidates.set(origin.origin, normalized);
    if (candidates.size === MAX_ANNOUNCED) break;
  }
  return [...candidates.values()];
}

function guardedDatagram(socket: DatagramLike, permitted: () => boolean): DatagramLike {
  return {
    bind: socket.bind.bind(socket),
    on: socket.on.bind(socket),
    addListener: socket.addListener?.bind(socket),
    address: socket.address.bind(socket),
    close: socket.close.bind(socket),
    send(bytes, port, address, callback) {
      if (!permitted()) {
        callback?.(new Error('Discovery authority changed before sending'));
        return;
      }
      socket.send(bytes, port, address, callback);
    }
  };
}

export function createGuideDiscovery(deps: GuideDiscoveryDeps): GuideDiscoveryPort {
  const listeners = new Set<() => void>();
  let active: AbortController | undefined;
  let publishedRows: readonly FoundServerRow[] = [];
  let publishedScope: DiscoverySection | undefined;

  function authorizedDiscovery(): DiscoverySection | undefined {
    try {
      const policy = deps.policy();
      const section = policy.state === 'ready' ? policy.discovery : undefined;
      return section?.announce && section.networks.length > 0 ? section : undefined;
    } catch {
      return undefined;
    }
  }

  function listed(candidate: Pick<FoundServerRow, 'host' | 'port'>): boolean {
    return findEndpoint(deps.endpoints(), `https://${candidate.host}:${candidate.port}`).kind === 'listed';
  }

  function action(scope: DiscoverySection): FoundServerRow['action'] {
    const { present, issuedHere } = deps.organization;
    return !present || issuedHere || scope.personalApprovals ? 'approve' : 'ask';
  }

  function publish(rows: readonly FoundServerRow[], scope?: DiscoverySection): void {
    const changed = !isDeepStrictEqual(publishedRows, rows);
    publishedRows = rows;
    publishedScope = scope;
    if (changed) for (const listener of listeners) listener();
  }

  async function inspect(candidate: ServerCandidate, scope: DiscoverySection, permitted: () => boolean, signal: AbortSignal): Promise<FoundServerRow | undefined> {
    const { target } = candidate;
    const { host, port } = target;
    if (!permitted()) return undefined;
    const row = { id: foundEndpointId(host, port), host, port, name: cleanFreeText(candidate.name ?? '', 63).trim() || host };
    const pinned = await readSpkiPin(target, { signal, connect(options) {
      if (!permitted()) throw new Error('Discovery authority changed before connecting');
      return deps.tlsConnect(options);
    } });
    if (!permitted()) return undefined;
    if (!pinned.ok) return { ...row, state: 'no-tls', action: 'none' };

    const identify = createIdentify({
      fetch: cannotRequest,
      fetchForPin(pin) {
        if (pin !== pinned.pin || !permitted()) return cannotRequest;
        const transport = deps.fetchForPin(pin);
        return (input, options) => permitted() ? transport(input, options) : cannotRequest(input, options);
      }
    });
    let identity: Identification;
    try {
      identity = await identify({ ...target, tlsPin: pinned.pin }, signal);
    } catch {
      identity = { state: 'unknown-server' };
    }
    if (!permitted()) return undefined;
    if (identity.state !== 'identified') return { ...row, state: 'unknown-server', action: 'none' };
    return { ...row, state: 'found', kind: identity.kind, version: identity.version && cleanFreeText(identity.version, 40), action: action(scope) };
  }

  return {
    rows() {
      const current = authorizedDiscovery();
      if (!publishedScope || !current || !isDeepStrictEqual(current, publishedScope)) return [];
      return publishedRows.filter((row) => !listed(row)).map((row) =>
        row.state === 'found' ? { ...row, action: action(current) } : row);
    },
    async refresh(parent) {
      active?.abort();
      const run = new AbortController();
      active = run;
      const signal = AbortSignal.any([parent, run.signal]);
      try {
        publish([]);
        const discovery = authorizedDiscovery();
        if (signal.aborted || !discovery) return;
        const scope = structuredClone(discovery);
        const permitted = () => !signal.aborted && isDeepStrictEqual(authorizedDiscovery(), scope);
        const facts = await deps.networkFacts(signal);
        if (!permitted() || facts.source === 'unknown') return;
        const ways = discoveryWays(scope, facts);
        if (!ways.announce || !ways.network) return;
        const groups = await Promise.all([
          browseAnnounced({ ways, createSocket() {
            if (!permitted()) throw new Error('Discovery authority changed before listening');
            return guardedDatagram(deps.createSocket(), permitted);
          }, clock: deps.clock, signal }),
          lookupAnnouncedSrv({ ways, networks: scope.networks, resolver: { resolveSrv(name) {
            return permitted() ? deps.resolver.resolveSrv(name) : Promise.resolve([]);
          } }, clock: deps.clock, signal })
        ]);
        if (!permitted()) return;
        const rows: FoundServerRow[] = [];
        for (const candidate of announcedCandidates(groups, ({ target }) => !listed(target))) {
          if (!permitted()) return;
          const stillCandidate = () => permitted() && !listed(candidate.target);
          const row = await inspect(candidate, scope, stillCandidate, signal);
          if (row) rows.push(row);
        }
        if (permitted()) publish(rows, scope);
      } catch {
        // A failed source must never leave a row from an unchecked or cancelled refresh.
      } finally {
        if (active === run) active = undefined;
      }
    },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    // Scan execution and proposal effects are composed in the next tasks.
    scanOffer: () => scanOff,
    async startScan() {},
    stopScan() {},
    async approve() { return 'not-allowed'; }
  };
}
