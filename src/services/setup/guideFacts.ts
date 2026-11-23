import { isNearCloudEndpoint, type PrivacyModeSetting } from '../../domain/config';
import { narrowResidency } from '../../domain/gate/residency';
import type { RouteFacts, RoutePolicy, RoutingTier } from '../../domain/gate/routing';
import type { YesNoUnsure } from '../../domain/setup/changes';
import type { ViabilityResult } from '../../domain/setup/viability';
import { floorFor } from '../privateRoute';

export function routeFactsOf(result: ViabilityResult, now: number): RouteFacts | undefined {
  const observed = result.routeFacts;
  if (!observed?.host) return undefined;
  return { ...observed, model: observed.model, nearEndpoint: isNearCloudEndpoint(observed.host), attestationFailed: false, now };
}

export function proposedRoutePolicy(policy: RoutePolicy, canada: YesNoUnsure | undefined): RoutePolicy {
  if (canada !== 'yes' && canada !== 'not-sure') return policy;
  return { ...policy, residency: narrowResidency(policy.residency, { required: ['CA'] }) };
}

export function floorTierOf(privacyMode: PrivacyModeSetting): RoutingTier | undefined {
  return floorFor({ privateOnly: privacyMode === 'tee-only' }).tier;
}
