// GUIDE-03, GUIDE-06. Pure: no I/O, no clock, no vscode, no package.
import type { ConnectionBindingFact } from '../gate/routing';
import type { EndpointClass, EndpointRegion, EndpointScheme, PolicyEndpoint } from '../gate/endpoints';
import type { DeviceFacts, HostKind } from './device';
import type { IdentifyServer, ServerCandidate, ServerIdentity, ServerModel, TestRequest } from './servers';
import type { OptionKind } from './ids';

export const VIABILITY_STATES = Object.freeze(['unknown', 'checking', 'viable', 'not-detected', 'not-configured', 'not-allowed', 'test-failed', 'stale'] as const);
export type ViabilityState = (typeof VIABILITY_STATES)[number];
export const VIABILITY_CHECKS = Object.freeze(['detected', 'configured', 'allowed', 'answered'] as const);
export type ViabilityCheck = (typeof VIABILITY_CHECKS)[number];
export const VIABILITY_REASON_CODES = Object.freeze(['test-failed', 'stale-time', 'stale-network', 'stale-server', 'stale-policy', 'still-checking', 'not-detected', 'not-configured', 'not-allowed'] as const);
export type ViabilityReasonCode = (typeof VIABILITY_REASON_CODES)[number];
export const VIABILITY_FIX_ACTIONS = Object.freeze(['install', 'configure', 'ask-administrator', 'retry'] as const);
export interface ViabilityFix { readonly action: (typeof VIABILITY_FIX_ACTIONS)[number]; readonly label: string; }
export interface OptionEndpoint { readonly id?: string; readonly class: EndpointClass; readonly region: EndpointRegion; readonly host: string; readonly scheme: EndpointScheme; readonly tlsPins: readonly string[]; }
export interface OptionRouteFacts { readonly clientRoute: 'near' | 'local'; readonly host: string; readonly model?: { readonly id: string; readonly privacyBoundary?: string }; readonly binding?: ConnectionBindingFact; }
export interface ViabilityResult { readonly optionId: string; readonly kind: OptionKind; readonly state: ViabilityState; readonly failedAt?: ViabilityCheck; readonly reasonCode?: ViabilityReasonCode; readonly sentence?: string; readonly fix?: ViabilityFix; readonly checkedAt?: number; readonly answeredAt?: number; readonly server?: ServerIdentity; readonly models: readonly ServerModel[]; readonly endpoint?: OptionEndpoint; readonly routeFacts?: OptionRouteFacts; readonly hostKind: HostKind; readonly policyHash?: string; }
export const VIABILITY_MAX_AGE_MS = 600_000;
export const CHECKING_CEILING_MS = 90_000;
export type ViabilityEvent = { readonly type: 'start'; readonly at: number } | { readonly type: 'answered'; readonly at: number; readonly models: readonly ServerModel[]; readonly server?: ServerIdentity; readonly endpoint?: OptionEndpoint; readonly routeFacts?: OptionRouteFacts } | { readonly type: 'failed'; readonly at: number; readonly check: ViabilityCheck; readonly reasonCode: ViabilityReasonCode; readonly sentence?: string; readonly fix?: ViabilityFix } | { readonly type: 'tick'; readonly at: number } | { readonly type: 'ceiling'; readonly at: number } | { readonly type: 'network-changed'; readonly at: number } | { readonly type: 'server-stopped'; readonly at: number } | { readonly type: 'policy-changed'; readonly at: number; readonly policyHash: string };
export function initialViability(optionId: string, kind: OptionKind, hostKind: HostKind): ViabilityResult { return { optionId, kind, state: 'unknown', models: [], hostKind }; }
const stale = (current: ViabilityResult, reasonCode: ViabilityReasonCode, policyHash = current.policyHash): ViabilityResult => ({ ...current, state: 'stale', reasonCode, policyHash });
export function nextViability(current: ViabilityResult, event: ViabilityEvent): ViabilityResult { switch (event.type) { case 'start': return { ...current, state: 'checking', checkedAt: event.at, reasonCode: undefined, failedAt: undefined }; case 'answered': return { ...current, state: 'viable', answeredAt: event.at, models: event.models, server: event.server, endpoint: event.endpoint, routeFacts: event.routeFacts, reasonCode: undefined }; case 'failed': return { ...current, state: event.check === 'detected' ? 'not-detected' : event.check === 'configured' ? 'not-configured' : event.check === 'allowed' ? 'not-allowed' : 'test-failed', failedAt: event.check, reasonCode: event.reasonCode, sentence: event.sentence, fix: event.fix }; case 'tick': return current.answeredAt !== undefined && event.at - current.answeredAt >= VIABILITY_MAX_AGE_MS ? stale(current, 'stale-time') : current; case 'ceiling': return current.state === 'checking' ? { ...current, reasonCode: 'still-checking' } : current; case 'network-changed': return stale(current, 'stale-network'); case 'server-stopped': return stale(current, 'stale-server'); case 'policy-changed': return stale(current, 'stale-policy', event.policyHash); } }
export function isChoosable(result: ViabilityResult, now: number): boolean { return result.state === 'viable' && result.answeredAt !== undefined && now - result.answeredAt < VIABILITY_MAX_AGE_MS; }
export interface OptionCheckInput { now(): number; readonly hostKind: HostKind; readonly device: DeviceFacts; readonly endpoints: readonly PolicyEndpoint[]; readonly policyHash: string; readonly candidates: readonly ServerCandidate[]; readonly floorOn: boolean; readonly identify: IdentifyServer; readonly testRequest: TestRequest; progress(result: ViabilityResult): void; }
export interface OptionSource { readonly id: string; readonly kinds: readonly OptionKind[]; readonly supersedes?: readonly string[]; check(input: OptionCheckInput, signal: AbortSignal): Promise<ViabilityResult>; }
export interface OptionSourceRegistry { register(source: OptionSource): { dispose(): void }; active(): readonly OptionSource[]; }
export function createOptionSourceRegistry(): OptionSourceRegistry {
  const entries = new Set<{ source: OptionSource }>();
  return {
    register(source) {
      for (const existing of entries) {
        if (existing.source.id === source.id) throw new Error(`Option source already registered: ${source.id}`);
      }
      const entry = { source };
      entries.add(entry);
      return { dispose: () => entries.delete(entry) };
    },
    active() {
      const sources = [...entries].map(({ source }) => source);
      const superseded = new Set(sources.flatMap((source) => source.supersedes ?? []));
      return sources.filter((source) => !superseded.has(source.id));
    },
  };
}
export const NO_LOCAL_SERVER_TEXT = 'No local AI server was found. This computer has {memory} of memory.';
/** Owner D7, D-49: a hosted session never probes its own loopback; only the servers your organization lists are checked. */
export const HOSTED_NO_LOOPBACK_TEXT = "This Sterling session runs on your organization's servers, so it checks only the AI servers your organization's rules list.";
export const NO_ADAPTER_TEXT = 'This version cannot connect to it yet. Update the extension.';
export const NOT_IN_POLICY_TEXT = 'This option is not in your organization\'s rules.';
export const STILL_CHECKING_TEXT = 'Still checking {option}.';
export const FLOOR_ON_TEXT = 'Your organization\'s minimum rules apply.';
export const NEAR_NO_KEY_TEXT = 'Add a key before checking this option.';
export const NEAR_UNREACHABLE_TEXT = 'The service did not answer.';
export const SERVER_TEST_FAILED_TEXT = 'The server test did not finish: {cause}.';
export const SERVER_NEEDS_KEY_TEXT = 'This server needs a key.';
export const UNKNOWN_SERVER_TEXT = 'The server did not identify itself.';
export const SERVER_NO_ALLOWED_MODEL_TEXT = 'No allowed model was found on {server}.';
