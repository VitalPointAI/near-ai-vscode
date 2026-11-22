// GUIDE-03, GUIDE-06. Pure: no I/O, no clock, no vscode, no package.
import type { DiscoveryNetwork, DiscoverySection, ScanRange } from '../gate/sections';
export interface NetworkFacts { readonly dnsSearch: readonly string[]; readonly gateway?: string; readonly source: 'linux' | 'darwin' | 'win32' | 'unknown'; }
export type NetworkFactsReader = (signal?: AbortSignal) => Promise<NetworkFacts>;
export const ANNOUNCED_SERVICE = '_near-ai-models._tcp';
const normalizeSuffix = (value: string): string => value.toLowerCase().replace(/\.$/, '');
export function listedNetworkOf(facts: NetworkFacts, discovery?: Pick<DiscoverySection, 'networks'>): DiscoveryNetwork | undefined { return discovery?.networks.find((network) => (network.gateway !== undefined && facts.gateway !== undefined && network.gateway === facts.gateway) || (network.dnsSuffix !== undefined && facts.dnsSearch.some((suffix) => normalizeSuffix(suffix) === normalizeSuffix(network.dnsSuffix as string)))); }
export interface DiscoveryWays { readonly named: true; readonly announce: boolean; readonly scanRanges: readonly ScanRange[]; readonly network?: DiscoveryNetwork; readonly reason?: 'no-discovery-section' | 'network-not-listed'; }
export function discoveryWays(discovery: DiscoverySection | undefined, facts: NetworkFacts): DiscoveryWays { if (!discovery) return { named: true, announce: false, scanRanges: [], reason: 'no-discovery-section' }; const network = listedNetworkOf(facts, discovery); if (!network) return { named: true, announce: false, scanRanges: [], reason: 'network-not-listed' }; return { named: true, announce: discovery.announce, scanRanges: discovery.scanRanges.filter((range) => range.network === undefined || range.network === network.id), network }; }
export const NOT_LISTED_NETWORK_TEXT = "This computer is on a network your organization's rules do not list, so scanning is off.";
