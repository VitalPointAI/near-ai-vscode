import { isNearCloudEndpoint, type PrivacyModeSetting } from '../../domain/config';
import { authorizationCovers, SELF_SIGNED_TEXT } from '../../domain/gate/authorizations';
import { isDefaultBundle } from '../../domain/gate/bundle';
import { labelKey, type Label } from '../../domain/gate/labels';
import type { UseTier } from '../../domain/gate/models';
import { narrowResidency } from '../../domain/gate/residency';
import type { RouteFacts, RoutePolicy, RoutingTier } from '../../domain/gate/routing';
import type { YesNoUnsure } from '../../domain/setup/changes';
import type { ViabilityResult } from '../../domain/setup/viability';
import type { GateHost } from '../../gate/host';
import { floorFor } from '../privateRoute';
import type { GuideControllerDeps } from './guideController';
import { readProjectLayer } from './projectStore';

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

/** Adapter for the guide's decisions. Expired or unreadable policies never supply a usable route. */
export function gateGuidePolicy(gate: GateHost, root: string, privacy: () => PrivacyModeSetting): GuideControllerDeps['readPolicy'] {
  return async (now) => {
    const runtime = await gate.runtimeFor({ root, actor: { kind: 'person', sessionId: 'get-started' }, presence: 'person', context: 'interactive' });
    const initial = runtime.bundleState();
    const label = initial.state === 'valid' ? await gate.labelsFor(root).view(initial.bundle.scales) : undefined;
    const state = runtime.bundleState();
    const layers = gate.policyLayers();
    const organization = layers.organization;
    const route = runtime.routePolicy?.(now);
    if (initial.state !== 'valid' || state.state !== 'valid' || state.hash !== initial.hash || !route || !label || organization.state === 'failed') {
      return { view: {
        organization: 'failed', startingRules: false, issuedHere: false,
        failedSentence: state.state === 'failed-closed' ? state.sentence : undefined,
        failedContacts: organization.state === 'none' ? undefined : organization.contacts
      } };
    }
    const resolved = label.resolve('', state.bundle.defaultLabel);
    if (!['verified', 'none'].includes(label.state) || resolved.mark.length > 1 || resolved.raisedByUnverified) {
      return { view: { organization: 'failed', startingRules: false, issuedHere: false,
        failedSentence: 'Review this project’s labels before choosing a connection.' } };
    }
    const project = readProjectLayer(root, state.bundle.scales);
    if (project.state === 'unreadable') {
      return { view: { organization: 'failed', startingRules: false, issuedHere: false,
        failedSentence: 'Review this project’s settings before choosing a connection.' } };
    }
    return {
      view: { organization: organization.state, effective: layers.effective,
        startingRules: organization.state === 'none' && isDefaultBundle(state.bundle),
        issuedHere: organization.state === 'valid' && organization.document.issuer.fingerprint === runtime.actor.deviceFingerprint },
      hash: state.hash, route: { ...route, residency: narrowResidency(route.residency, project.state === 'valid' ? project.layer.residency : undefined) },
      routing: state.bundle.routing, defaultLabel: state.bundle.defaultLabel,
      projectLabel: resolved.mark[0], floor: floorTierOf(privacy())
    };
  };
}
