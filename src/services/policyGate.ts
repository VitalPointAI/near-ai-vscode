import type { ActionCapability, ActionDecision, ActionPolicy } from '../domain/policy';
import type { PrivacyPreflightResult, ProviderRequest } from '../domain/privacy';
import { decideAction } from '../domain/policy';
import { PrivacyPreflight } from './privacyPreflight';

export interface PolicyGateDecision {
  action: ActionDecision;
  preflight?: PrivacyPreflightResult;
  allowed: boolean;
  reason: string;
}

export class PolicyGate {
  public constructor(private readonly actionPolicy: ActionPolicy, private readonly privacy: PrivacyPreflight) {}

  public decideAction(capability: ActionCapability, request?: ProviderRequest, overrideToken?: string): PolicyGateDecision {
    const action = decideAction(this.actionPolicy, capability);
    if (this.actionPolicy.emergencyStop) return { action: 'deny', allowed: false, reason: 'emergency stop denies every capability and outbound request' };
    const preflight = request ? this.privacy.preflight({ ...request, capability }, overrideToken) : undefined;
    if (action === 'deny') return { action, preflight, allowed: false, reason: 'action policy denied the capability' };
    if (action !== 'allow') return { action, preflight, allowed: false, reason: 'approval is required by the existing action policy' };
    if (preflight && preflight.decision.outcome !== 'allow') return { action, preflight, allowed: false, reason: preflight.decision.reason };
    return { action, preflight, allowed: true, reason: preflight?.decision.reason ?? 'action policy allowed the capability' };
  }

  public preflightOutbound(request: ProviderRequest, overrideToken?: string): PolicyGateDecision {
    return this.decideAction(request.capability ?? 'network', request, overrideToken);
  }
}

