import type { NearAiSettings } from '../domain/config';
import type { DataClass, ProviderBoundary } from '../domain/privacy';
import type { ModelInfo } from './nearAiClient';
import { PrivacyPreflight } from './privacyPreflight';

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

/**
 * The single check every outbound chat turn passes before it reaches a provider: emergency stop,
 * daily spend limit, TEE-only mode, and the privacy preflight. One instance per chat surface,
 * because a one-time override is only valid for the instance that issued it.
 */
export class OutboundGuard {
  private readonly privacy: PrivacyPreflight;

  public constructor(private readonly settings: Pick<NearAiSettings, 'privacyMode' | 'dailySpendLimitUsd' | 'actionPolicy'>, now: () => number = Date.now) {
    this.privacy = new PrivacyPreflight({ mode: settings.privacyMode, now });
  }

  public check(request: OutboundRequest, spentTodayUsd: number): OutboundOutcome {
    const boundary: ProviderBoundary = request.modelInfo?.privacyBoundary === 'tee' ? 'tee' : request.modelInfo?.privacyBoundary === 'local' ? 'local' : 'cloud';
    if (this.settings.actionPolicy.emergencyStop) return { outcome: 'block', boundary, reason: 'Emergency stop is on. Run "NEAR AI: Resume" to send again.' };
    const limit = this.settings.dailySpendLimitUsd;
    if (limit > 0 && spentTodayUsd >= limit) return { outcome: 'block', boundary, reason: `Today's NEAR AI spend ($${spentTodayUsd.toFixed(2)}) has reached your daily limit of $${limit.toFixed(2)}. Raise nearAi.dailySpendLimitUsd to continue.` };
    const providerRequest = { provider: `near-ai:${request.model}`, providerBoundary: boundary, capability: 'network' as const, context: request.text };
    const result = this.privacy.preflight(providerRequest, request.overrideToken);
    if (result.decision.outcome === 'allow') return { outcome: 'allow', boundary };
    if (this.settings.privacyMode === 'tee-only' && boundary === 'cloud') {
      const where = request.modelInfo?.forwardedTo ? ` (NEAR forwards it to ${request.modelInfo.forwardedTo})` : '';
      return { outcome: 'block', boundary, reason: `TEE-only mode is on, and ${request.model} does not run in NEAR's TEE${where}. Pick a model marked "Private", or turn off nearAi.privacyMode.` };
    }
    const found = result.decision.classifications.map((dataClass) => FINDINGS[dataClass]).filter((value): value is string => Boolean(value));
    const reason = `This message contains ${found.join(' and ') || 'content the privacy check flagged'}.`;
    const overrideToken = this.privacy.issueOverride(providerRequest).token;
    return { outcome: result.decision.outcome === 'block' ? 'block' : 'confirm', boundary, reason, overrideToken };
  }
}

