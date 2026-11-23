import { isNearCloudEndpoint, type PrivacyModeSetting } from '../../domain/config';
import { authorizationCovers, SELF_SIGNED_TEXT } from '../../domain/gate/authorizations';
import { labelKey, type Label } from '../../domain/gate/labels';
import type { UseTier } from '../../domain/gate/models';
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

export function approvedDeviceName(policy: RoutePolicy, label: Label, use: UseTier, now: number): string | undefined {
  if (policy.deviceId === undefined) return undefined;
  const question = {
    kind: 'accredited-device' as const, subject: { device: policy.deviceId },
    project: policy.project, label: labelKey(label), use: use.toLowerCase()
  };
  const approval = policy.authorizations.find(({ body }) => authorizationCovers(body, question, now));
  if (!approval) return undefined;
  const { name } = approval.body.namedPerson;
  return approval.selfSigned ? `${name} (${SELF_SIGNED_TEXT})` : name;
}

export function floorTierOf(privacyMode: PrivacyModeSetting): RoutingTier | undefined {
  return floorFor({ privateOnly: privacyMode === 'tee-only' }).tier;
}
