import { DEFAULT_BASE_URL } from '../domain/config';
import type { NearAiSettings } from '../domain/config';
import { DEFAULT_ROUTING, decideRoute } from '../domain/gate/routing';
import type { RouteFacts } from '../domain/gate/routing';
import type { Label } from '../domain/gate/labels';
import type { DataClass, ProviderBoundary } from '../domain/privacy';
import type { ModelInfo } from './nearAiClient';
import { PrivacyPreflight } from './privacyPreflight';
import { floorFor } from './privateRoute';

export type OutboundOutcome =
  | { outcome: 'allow'; boundary: ProviderBoundary }
  | { outcome: 'confirm' | 'block'; boundary: ProviderBoundary; reason: string; overrideToken?: string };

export interface OutboundRequest {
  model: string;
  /** The catalog entry for `model`, used for its privacy boundary; unknown models are treated as forwarded. */
  modelInfo?: ModelInfo;
  /** Only what this turn adds; earlier turns were checked when they were sent. */
  text: string;
  overrideToken?: string;
}

const FINDINGS: Partial<Record<DataClass, string>> = {
  secret: 'what looks like a credential (API key, token, password, or private key)',
  personalData: 'what looks like personal data (an email address or similar)',
  privateFile: 'a reference to a private or credential file'
};

const ORG_PUBLIC: Label = Object.freeze({ scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] });
const THIS_COMPUTER = 'http://127.0.0.1';

/**
 * Whether decideRoute would refuse this model under the private floor of `privacyMode` (D-37): the chat's early refusal is that decision said before
 * anything is sent. The preview is org Public with the default routing, the model's own client (this computer for a local catalogue entry, NEAR AI Cloud
 * otherwise) and a fresh bound fact, so it refuses only for the model; the client decides each send again with the real facts.
 */
function floorRefuses(request: OutboundRequest, privacyMode: NearAiSettings['privacyMode'], now: number): boolean {
  const floor = floorFor({ privateOnly: privacyMode === 'tee-only' });
  if (floor.tier === undefined) return false;
  const boundary = request.modelInfo?.privacyBoundary;
  const local = boundary === 'local';
  const host = local ? THIS_COMPUTER : DEFAULT_BASE_URL;
  const facts: RouteFacts = {
    clientRoute: local ? 'local' : 'near', host, nearEndpoint: !local, attestationFailed: false, now, binding: { state: 'bound', host, checkedAt: now },
    model: request.modelInfo === undefined ? undefined : { id: request.model, ...(boundary === undefined ? {} : { privacyBoundary: boundary }) }
  };
  return !decideRoute([], DEFAULT_ROUTING, facts, ORG_PUBLIC, floor.tier).allowed;
}

/**
 * The single check every outbound chat turn passes before it reaches a provider: emergency stop,
 * daily spend limit, TEE-only mode, and the privacy preflight. One instance per chat surface,
 * because a one-time override is only valid for the instance that issued it.
 */
export class OutboundGuard {
  private readonly privacy: PrivacyPreflight;

  public constructor(private readonly settings: Pick<NearAiSettings, 'privacyMode' | 'dailySpendLimitUsd' | 'actionPolicy'>, private readonly now: () => number = Date.now) {
    // D-37: the preflight keeps its data-class checks only; routing (TEE-only mode) is decideRoute's, previewed below.
    this.privacy = new PrivacyPreflight({ now });
  }

  public check(request: OutboundRequest, spentTodayUsd: number): OutboundOutcome {
    const boundary: ProviderBoundary = request.modelInfo?.privacyBoundary === 'tee' ? 'tee' : request.modelInfo?.privacyBoundary === 'local' ? 'local' : 'cloud';
    if (this.settings.actionPolicy.emergencyStop) return { outcome: 'block', boundary, reason: 'Emergency stop is on. Run "NEAR AI: Resume" to send again.' };
    const limit = this.settings.dailySpendLimitUsd;
    if (limit > 0 && spentTodayUsd >= limit) return { outcome: 'block', boundary, reason: `Today's NEAR AI spend ($${spentTodayUsd.toFixed(2)}) has reached your daily limit of $${limit.toFixed(2)}. Raise nearAi.dailySpendLimitUsd to continue.` };
    const providerRequest = { provider: `near-ai:${request.model}`, providerBoundary: boundary, capability: 'network' as const, context: request.text };
    const result = this.privacy.preflight(providerRequest, request.overrideToken);
    // TEE-only mode: decideRoute's private floor, said before anything is sent, in the words it always used (D-37). No override lifts it.
    if (floorRefuses(request, this.settings.privacyMode, this.now())) {
      const where = request.modelInfo?.forwardedTo ? ` (NEAR forwards it to ${request.modelInfo.forwardedTo})` : '';
      return { outcome: 'block', boundary, reason: `TEE-only mode is on, and ${request.model} does not run in NEAR's TEE${where}. Pick a model marked "Private", or turn off nearAi.privacyMode.` };
    }
    if (result.decision.outcome === 'allow') return { outcome: 'allow', boundary };
    const found = result.decision.classifications.map((dataClass) => FINDINGS[dataClass]).filter((value): value is string => Boolean(value));
    const reason = `This message contains ${found.join(' and ') || 'content the privacy check flagged'}.`;
    const overrideToken = this.privacy.issueOverride(providerRequest).token;
    return { outcome: result.decision.outcome === 'block' ? 'block' : 'confirm', boundary, reason, overrideToken };
  }
}

