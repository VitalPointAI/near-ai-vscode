import { isDeepStrictEqual } from 'node:util';
import { isNearCloudEndpoint, type PrivacyModeSetting } from '../../domain/config';
import { authorizationCovers, SELF_SIGNED_TEXT } from '../../domain/gate/authorizations';
import { isDefaultBundle } from '../../domain/gate/bundle';
import { labelKey, type Label } from '../../domain/gate/labels';
import type { UseTier } from '../../domain/gate/models';
import { narrowResidency } from '../../domain/gate/residency';
import type { RouteFacts, RoutePolicy, RoutingTier } from '../../domain/gate/routing';
import { parseGuidePrefill, type OpenGetStartedRequest } from '../../domain/setup/answers';
import type { YesNoUnsure } from '../../domain/setup/changes';
import type { HostKind } from '../../domain/setup/device';
import { isGetStartedTarget } from '../../domain/setup/ids';
import type { SetupRegistries } from '../../domain/setup/registries';
import type { IdentifyServer } from '../../domain/setup/servers';
import type { StartSessionInput } from '../../domain/setup/session';
import { CHECKING_CEILING_MS, type OptionSource, type ViabilityResult } from '../../domain/setup/viability';
import type { GateHost, RuntimeRequest } from '../../gate/host';
import { sessionRouteFrom } from '../../gate/sessionMark';
import { floorFor } from '../privateRoute';
import { memoryOnlyDeviceProvider } from './deviceFacts';
import type { GuideControllerDeps } from './guideController';
import { readProjectLayer } from './projectStore';
import { withCheckTimeout } from './probe';
import { runTestRequest } from './testRequest';
import { runViability } from './viabilityRunner';

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

export function guideSessionPrefill(request?: OpenGetStartedRequest): StartSessionInput['prefill'] {
  if (request?.step !== undefined && !isGetStartedTarget(request.step)) return undefined;
  const prefill = parseGuidePrefill(request?.prefill);
  const projectName = prefill?.projectName;
  // Until the project stream supplies trusted answers, a join request carries only the display name.
  if (request?.step !== 'join' && (request?.step === 'staff-team' || prefill?.section !== undefined)) {
    return { projectName, section: prefill?.section, kindOfWork: 'staff' };
  }
  return projectName === undefined ? undefined : { projectName };
}

/** Who Get Started acts as in a project: the person, in that project's policy and log. Its policy reads and its test requests use the same one. */
function guideRuntime(root: string): RuntimeRequest {
  return { root, actor: { kind: 'person', sessionId: 'get-started' }, presence: 'person', context: 'interactive' };
}

/** Adapter for the guide's decisions. Expired or unreadable policies never supply a usable route. */
export function gateGuidePolicy(gate: GateHost, root: string, privacy: () => PrivacyModeSetting): GuideControllerDeps['readPolicy'] {
  return async (now) => {
    const runtime = await gate.runtimeFor(guideRuntime(root));
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

/** Supply the policy and check adapters for one project's Get Started run. */
export function createGateGuideChecks(deps: {
  readonly gate: GateHost;
  readonly root: string;
  readonly privacy: () => PrivacyModeSetting;
  readonly hostKind: HostKind;
  readonly registries: Pick<SetupRegistries, 'devices' | 'options'>;
  readonly identify: IdentifyServer;
  readonly projectSource?: OptionSource;
  readonly clock?: () => number;
}): Pick<GuideControllerDeps, 'readPolicy' | 'check'> {
  const { gate, root, privacy, hostKind, registries, identify, clock = Date.now } = deps;
  const readPolicy = gateGuidePolicy(gate, root, privacy);
  const fallback = memoryOnlyDeviceProvider({ hostKind });
  return {
    readPolicy,
    async check(snapshot, progress, signal) {
      const provider = registries.devices.best() ?? fallback;
      const device = await withCheckTimeout(signal, CHECKING_CEILING_MS, (checkSignal) => provider.read(checkSignal));
      const current = await readPolicy(clock());
      signal.throwIfAborted();
      if (!('route' in current) || current.hash !== snapshot.hash || current.floor !== snapshot.floor ||
          !isDeepStrictEqual(current.projectLabel, snapshot.projectLabel)) {
        throw new Error('The project rules changed before checking connections.');
      }
      // CLAS-06: each test request runs inside this project's session route, so its policy, residency and labels decide it and its log records it.
      const route = sessionRouteFrom(await gate.runtimeFor(guideRuntime(root)));
      signal.throwIfAborted();
      const sources = registries.options.active();
      const { projectSource } = deps;
      const useProjectSource = projectSource && !sources.some(({ id, supersedes }) =>
        id === projectSource.id || supersedes?.includes(projectSource.id));
      return runViability({
        sources: useProjectSource ? [...sources, projectSource] : sources, signal, onProgress: progress,
        input: {
          now: clock, hostKind, device, identify, candidates: [], endpoints: current.route.endpoints,
          testRequest: (client, model, testSignal) => runTestRequest(client, model, { route, signal: testSignal }),
          policyHash: current.hash, floorOn: current.floor !== undefined,
        },
      });
    },
  };
}
