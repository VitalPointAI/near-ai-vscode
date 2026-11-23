import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { findEndpoint, isLoopbackEndpointHost, type PolicyEndpoint } from '../../domain/gate/endpoints';
import type { DiscoverySection } from '../../domain/gate/sections';
import { cleanFreeText, fillSlots } from '../../domain/setup/answers';
import type { HostKind } from '../../domain/setup/device';
import { buildScanRecord } from '../../domain/setup/guideRecord';
import { discoveryWays, NOT_LISTED_NETWORK_TEXT, type NetworkFactsReader } from '../../domain/setup/network';
import type { GuidePolicy } from '../../domain/setup/policy';
import type { FoundServerRow, GuideDiscoveryPort, ScanOffer } from '../../domain/setup/screens';
import type { Identification, ServerCandidate, ServerIdentity } from '../../domain/setup/servers';
import type { SetupAuditLog } from '../../gate/setupAuditLog';
import type { PolicyEditorPort } from '../policyEditorWiring';
import { endpointProposalFor, foundEndpointId } from './approval';
import { readSpkiPin, type TlsConnectLike } from './certPin';
import { createIdentify } from './identify';
import { browseAnnounced, MAX_ANNOUNCED, type DatagramLike, type DiscoveryClock } from './mdns';
import { probeOrigin } from './probe';
import { proposalStep } from './proposals';
import { planScan, runScan, SCAN_CONFIRM_TEXT, SCAN_STOPPED_TEXT, type ScanPlan } from './scan';
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
  readonly editor?: Pick<PolicyEditorPort, 'propose'>;
  readonly audit?: Pick<SetupAuditLog, 'append'>;
  readonly hostKind?: HostKind;
  readonly tcpConnect?: Parameters<typeof runScan>[0]['connect'];
}

export const FOUND_DEFAULT_REGION = 'unstated';
export const FOUND_DEFAULT_MAX_LABEL = ['org/Internal'] as const;

interface DiscoveredRow {
  readonly row: FoundServerRow;
  readonly proof?: { readonly candidate: ServerCandidate; readonly identity: ServerIdentity; readonly pin: string };
}

interface PublishedScope {
  readonly discovery: DiscoverySection;
  readonly networkId: string;
  readonly signal: AbortSignal;
}

interface ScanReview {
  readonly scope: PublishedScope;
  readonly plan: ScanPlan;
}

interface ActiveScan {
  readonly controller: AbortController;
  readonly review: ScanReview;
  done: number;
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
    setMulticastTTL: socket.setMulticastTTL?.bind(socket),
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
  let approval: AbortController | undefined;
  let publishedRows: readonly DiscoveredRow[] = [];
  let publishedScope: PublishedScope | undefined;
  let scanReview: ScanReview | undefined;
  let scanning: ActiveScan | undefined;
  let scanNote: string | undefined;

  function authorizedDiscovery(): DiscoverySection | undefined {
    try {
      const policy = deps.policy();
      const section = policy.state === 'ready' ? policy.discovery : undefined;
      return section && section.networks.length > 0 && (section.announce || section.scanRanges.length > 0) ? section : undefined;
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

  function notify(): void {
    for (const listener of listeners) {
      try { listener(); } catch { /* Presentation observers do not own discovery work. */ }
    }
  }

  function publish(rows: readonly DiscoveredRow[], scope?: PublishedScope): void {
    const changed = !isDeepStrictEqual(publishedRows.map(({ row }) => row), rows.map(({ row }) => row));
    publishedRows = rows;
    publishedScope = scope;
    if (changed) notify();
  }

  function currentScope(scope: PublishedScope): boolean {
    return !scope.signal.aborted && isDeepStrictEqual(authorizedDiscovery(), scope.discovery);
  }

  function offerScan(review?: ScanReview, note?: string): void {
    const changed = scanReview !== review || scanNote !== note;
    scanReview = review;
    scanNote = note;
    if (changed) notify();
  }

  function candidatePin(candidate: ServerCandidate, permitted: () => boolean, signal: AbortSignal) {
    return readSpkiPin(candidate.target, { signal, connect(options) {
      if (!permitted()) throw new Error('Discovery authority changed before connecting');
      return deps.tlsConnect(options);
    } });
  }

  async function inspect(candidate: ServerCandidate, scope: DiscoverySection, permitted: () => boolean, signal: AbortSignal,
    verifyNetwork?: (signal: AbortSignal) => Promise<boolean>): Promise<DiscoveredRow | undefined> {
    const { target } = candidate;
    const { host, port } = target;
    if (!permitted() || (verifyNetwork && !await verifyNetwork(signal))) return undefined;
    const row = { id: foundEndpointId(host, port), host, port, name: cleanFreeText(candidate.name ?? '', 63).trim() || host };
    const pinned = await candidatePin(candidate, permitted, signal);
    if (!permitted()) return undefined;
    if (!pinned.ok) return { row: { ...row, state: 'no-tls', action: 'none' } };

    const identify = createIdentify({
      fetch: cannotRequest,
      fetchForPin(pin) {
        if (pin !== pinned.pin || !permitted()) return cannotRequest;
        const transport = deps.fetchForPin(pin);
        return async (input, options) => {
          const requestSignal = options?.signal ?? signal;
          if (!permitted() || (verifyNetwork && !await verifyNetwork(requestSignal)) || !permitted()) {
            return cannotRequest(input, options);
          }
          return transport(input, options);
        };
      }
    });
    let identity: Identification;
    try {
      identity = await identify({ ...target, tlsPin: pinned.pin }, signal);
    } catch {
      identity = { state: 'unknown-server' };
    }
    if (!permitted()) return undefined;
    if (identity.state !== 'identified') return { row: { ...row, state: 'unknown-server', action: 'none' } };
    const found = { kind: identity.kind, version: identity.version && cleanFreeText(identity.version, 40) };
    return {
      row: { ...row, ...found, state: 'found', action: action(scope) },
      proof: { candidate, identity: found, pin: pinned.pin }
    };
  }

  async function approve(id: string): ReturnType<GuideDiscoveryPort['approve']> {
    const scope = publishedScope;
    const entry = publishedRows.find(({ row }) => row.id === id && row.state === 'found');
    const proof = entry?.proof;
    if (approval || !scope || !entry || !proof || isLoopbackEndpointHost(entry.row.host)) return 'not-allowed';

    const role = { ...deps.organization };
    const run = new AbortController();
    const samePublication = () => publishedScope === scope && publishedRows.includes(entry);
    const signal = AbortSignal.any([run.signal, scope.signal]);
    const permitted = () => !signal.aborted && samePublication() && isDeepStrictEqual(role, deps.organization) &&
      currentScope(scope) && action(scope.discovery) === 'approve' && !listed(entry.row);

    try {
      if (!permitted()) return 'not-allowed';
      const { editor, audit } = deps;
      if (!editor || !audit) return 'failed';
      approval = run;
      const facts = await deps.networkFacts(signal);
      if (!permitted() || facts.source === 'unknown' || discoveryWays(scope.discovery, facts).network?.id !== scope.networkId) return 'not-allowed';
      const pin = await candidatePin(proof.candidate, permitted, signal);
      if (!permitted() || !pin.ok || pin.pin !== proof.pin) return 'not-allowed';
      const personalApprovals = scope.discovery.personalApprovals;
      const proposal = endpointProposalFor({
        ...proof, region: FOUND_DEFAULT_REGION, organization: role.present, personalApprovals,
        maxLabel: role.present && !personalApprovals ? FOUND_DEFAULT_MAX_LABEL : ['org/Public']
      });
      // A first personal endpoint list narrows the inherited list. Keep the effective entries
      // so adding the discovered host alone does not remove existing organization services.
      const inherited = proposal.target === 'personal' && role.present ? [...deps.endpoints()] : undefined;
      const change = inherited === undefined ? proposal : {
        ...proposal,
        next(current: Parameters<typeof proposal.next>[0]) {
          return proposal.next(current.endpoints === undefined ? { ...current, endpoints: inherited } : current);
        }
      };
      if (!permitted()) return 'not-allowed';
      const result = await proposalStep({
        port: editor, audit,
        proposal: { id: randomUUID(), kind: 'endpoint-approval', change,
          detail: { endpointId: id, serverKind: proof.identity.kind, pin: proof.pin } }
      }).run();
      if (result.outcome !== 'proposal-opened') return 'failed';
      if (!signal.aborted && samePublication()) {
        publish(publishedRows.map((existing) => existing === entry
          ? { row: { ...entry.row, state: 'proposed', action: 'none' } } : existing), scope);
      }
      return 'opened';
    } catch {
      return 'failed';
    } finally {
      if (approval === run) approval = undefined;
    }
  }

  function scanOffer(): ScanOffer {
    if (scanning) return { ...scanOff, running: true, done: scanning.done, total: scanning.review.plan.hosts };
    if (!scanReview || !currentScope(scanReview.scope)) return scanNote ? { ...scanOff, reasonOff: scanNote } : scanOff;
    const { ranges, ports, estimatedSeconds, hosts } = scanReview.plan;
    const minutes = Math.max(1, Math.ceil(estimatedSeconds / 60));
    const confirm = fillSlots(SCAN_CONFIRM_TEXT, {
      ranges: ranges.join(', '), ports: ports.join(', '), hosts: String(hosts), minutes: String(minutes)
    });
    return { offered: true, running: false, ranges, confirmText: minutes === 1 ? confirm.replace('1 minutes', '1 minute') : confirm };
  }

  async function runConfirmedScan(run: ActiveScan, depsForScan: {
    readonly connect: NonNullable<GuideDiscoveryDeps['tcpConnect']>;
    readonly audit: NonNullable<GuideDiscoveryDeps['audit']>;
    readonly hostKind: HostKind;
  }): Promise<void> {
    const { controller, review: { scope, plan } } = run;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    const permitted = () => !signal.aborted && currentScope(scope);
    let note: string | undefined = SCAN_STOPPED_TEXT;
    let inspecting = Promise.resolve();
    const queued = new Set<string>();
    async function verifyNetwork(checkSignal: AbortSignal): Promise<boolean> {
      if (!permitted() || checkSignal.aborted) return false;
      const facts = await deps.networkFacts(checkSignal).catch(() => undefined);
      if (!permitted() || checkSignal.aborted) return false;
      if (!facts || facts.source === 'unknown' || discoveryWays(scope.discovery, facts).network?.id !== scope.networkId) {
        note = NOT_LISTED_NETWORK_TEXT;
        controller.abort();
        return false;
      }
      return true;
    }
    try {
      const facts = await deps.networkFacts(signal);
      if (!permitted()) return;
      const ways = discoveryWays(scope.discovery, facts);
      if (facts.source === 'unknown' || ways.network?.id !== scope.networkId) {
        note = NOT_LISTED_NETWORK_TEXT;
        return;
      }
      const current = planScan({ ways, requested: plan.ranges, ports: plan.ports });
      if (!current.ok || !isDeepStrictEqual(current.plan, plan)) return;
      const capacity = MAX_ANNOUNCED - publishedRows.length;
      const noDiscovery = discoveryWays(undefined, facts);
      const result = await runScan({
        plan, confirmed: true, ways: () => permitted() ? ways : noDiscovery,
        async connect(host, port, timeout, transportSignal) {
          const started = deps.clock.now();
          if (!await verifyNetwork(transportSignal) || transportSignal.aborted) return false;
          const remaining = timeout - Math.max(0, deps.clock.now() - started);
          if (remaining <= 0) { controller.abort(); return false; }
          return depsForScan.connect(host, port, remaining, transportSignal);
        },
        clock: deps.clock, signal,
        async record(phase, detail) {
          const saved = await depsForScan.audit.append('setup.discovery.scan', buildScanRecord({
            phase, ...detail, hostKind: depsForScan.hostKind
          }));
          if (!saved.ok) throw new Error('The scan record could not be written');
        },
        onProgress(done) {
          run.done = done;
          notify();
        },
        onFound(candidate) {
          const { host, port } = candidate.target;
          const id = foundEndpointId(host, port);
          const stillCandidate = () => permitted() && publishedScope === scope &&
            !listed(candidate.target) && !publishedRows.some(({ row }) => row.id === id);
          if (queued.size >= capacity || queued.has(id) || !stillCandidate()) return;
          queued.add(id);
          inspecting = inspecting.then(async () => {
            const found = await inspect(candidate, scope.discovery, stillCandidate, signal, verifyNetwork);
            if (found && stillCandidate()) publish([...publishedRows, found], scope);
          }).catch(() => undefined);
        }
      });
      if (result.stopped) controller.abort();
      await inspecting;
      if (!result.stopped && permitted()) note = undefined;
    } catch {
      controller.abort();
      await inspecting;
    } finally {
      scanning = undefined;
      if (!scope.signal.aborted) scanNote = note;
      notify();
    }
  }

  return {
    rows() {
      const current = authorizedDiscovery();
      if (!publishedScope || publishedScope.signal.aborted || !current || !isDeepStrictEqual(current, publishedScope.discovery)) return [];
      return publishedRows.map(({ row }) => row).filter((row) => !listed(row)).map((row) =>
        row.state === 'found' ? { ...row, action: action(current) } : row);
    },
    async refresh(parent) {
      active?.abort();
      approval?.abort();
      const run = new AbortController();
      active = run;
      const signal = AbortSignal.any([parent, run.signal]);
      try {
        publish([]);
        offerScan();
        const discovery = authorizedDiscovery();
        if (signal.aborted || !discovery) return;
        const scope = structuredClone(discovery);
        const permitted = () => !signal.aborted && isDeepStrictEqual(authorizedDiscovery(), scope);
        const facts = await deps.networkFacts(signal);
        if (!permitted()) return;
        const ways = discoveryWays(scope, facts);
        if (facts.source === 'unknown' || !ways.network) {
          if (scope.scanRanges.length > 0) offerScan(undefined, NOT_LISTED_NETWORK_TEXT);
          return;
        }
        const publication = { discovery: scope, networkId: ways.network.id, signal };
        const groups = ways.announce ? await Promise.all([
          browseAnnounced({ ways, createSocket() {
            if (!permitted()) throw new Error('Discovery authority changed before listening');
            return guardedDatagram(deps.createSocket(), permitted);
          }, clock: deps.clock, signal }),
          lookupAnnouncedSrv({ ways, networks: scope.networks, resolver: { resolveSrv(name, request) {
            return permitted() ? deps.resolver.resolveSrv(name, request) : Promise.resolve([]);
          } }, clock: deps.clock, signal })
        ]) : [];
        if (!permitted()) return;
        const rows: DiscoveredRow[] = [];
        for (const candidate of announcedCandidates(groups, ({ target }) => !listed(target))) {
          if (!permitted()) return;
          const stillCandidate = () => permitted() && !listed(candidate.target);
          const row = await inspect(candidate, scope, stillCandidate, signal);
          if (row) rows.push(row);
        }
        if (!permitted()) return;
        publish(rows, publication);
        if (deps.tcpConnect && deps.audit && deps.hostKind) {
          const offer = planScan({ ways });
          if (offer.ok) offerScan({ scope: publication, plan: offer.plan });
        }
      } catch {
        // A failed source must never leave a row from an unchecked or cancelled refresh.
      }
    },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    scanOffer,
    async startScan(ranges) {
      const review = scanReview;
      const { tcpConnect, audit, hostKind } = deps;
      if (scanning || !review || !currentScope(review.scope) || !isDeepStrictEqual(ranges, review.plan.ranges) ||
          !tcpConnect || !audit || !hostKind) return;
      const run = { controller: new AbortController(), review, done: 0 };
      scanning = run;
      offerScan();
      void runConfirmedScan(run, { connect: tcpConnect, audit, hostKind });
    },
    stopScan() { scanning?.controller.abort(); },
    approve
  };
}
