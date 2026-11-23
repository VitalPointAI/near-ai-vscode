import type { PrivacyModeSetting } from '../../domain/config';
import { isLoopbackEndpointHost } from '../../domain/gate/endpoints';
import type { OpenGetStartedRequest } from '../../domain/setup/answers';
import type { HostKind } from '../../domain/setup/device';
import type { LandingPort } from '../../domain/setup/landing';
import { createAuditEventRegistry, GUIDE_AUDIT_EVENT_SPECS } from '../../domain/setup/records';
import type { GuideDiscoveryPort } from '../../domain/setup/screens';
import { projectLogKey } from '../../gate/decisionLog';
import type { GateHost } from '../../gate/host';
import { SetupAuditLog } from '../../gate/setupAuditLog';
import type { AuthService } from '../auth';
import type { PolicyEditorPort } from '../policyEditorWiring';
import { ProfileStore } from '../profileStore';
import { connectionStep, profileFor, type ProfileSlice } from './applyConnection';
import type { GetStartedDeps } from './getStarted';
import { createGateGuideChecks } from './guideFacts';
import type { LocalServersDeps } from './localServersOption';
import { createScopedNearAiSource } from './nearAiOption';
import { singleMachineSink } from './projectLayerSink';

type GuideProject = Readonly<{ root: string; name: string }>;
type ProjectProfiles = ProfileSlice & Pick<ProfileStore, 'getScope'>;

export function createProjectGetStartedDeps(deps: {
  readonly project: () => GuideProject | undefined;
  readonly gate: GateHost;
  readonly auth: AuthService;
  readonly globalStorageDir: string;
  readonly hostKind: HostKind;
  readonly machine: string;
  readonly privacy: (root: string) => PrivacyModeSetting;
  readonly local: LocalServersDeps;
  readonly landing: (project: GuideProject, request?: OpenGetStartedRequest) => LandingPort;
  readonly onAuditFailure: (message: string) => void;
  readonly configureConnection: (root: string) => Promise<boolean>;
  readonly projectLayerSource?: { invalidate(root: string): void };
  readonly policyEditor?: Pick<PolicyEditorPort, 'propose'>;
  readonly discovery?: (project: GuideProject, audit: SetupAuditLog) => GuideDiscoveryPort;
  readonly profiles?: (root: string) => ProjectProfiles;
  readonly fetchFn?: typeof fetch;
  readonly clock?: () => number;
}): GetStartedDeps {
  const events = createAuditEventRegistry();
  for (const spec of GUIDE_AUDIT_EVENT_SPECS) events.register(spec);
  const { gate, auth, hostKind, machine, clock } = deps;
  const profileStoreFor = deps.profiles ?? ((root) => new ProfileStore(root, auth));
  return {
    sources: { local: deps.local, device: { hostKind } },
    createRun(request, registries) {
      const current = deps.project();
      if (!current?.root) throw new Error('Open a project folder before using Get Started.');
      const project = { ...current };
      const { root, name } = project;
      // Read again after the normal connection flow, which can use a separate store instance.
      const profiles: ProfileSlice = {
        getActiveProfile: () => profileStoreFor(root).getActiveProfile(),
        list: () => profileStoreFor(root).list(),
        select: (profileId) => profileStoreFor(root).select(profileId),
        configure: (...args) => profileStoreFor(root).configure(...args),
      };
      const projectSource = createScopedNearAiSource({ auth, profiles: () => profileStoreFor(root), fetchFn: deps.fetchFn });
      const { readPolicy, check } = createGateGuideChecks({
        gate, root, privacy: () => deps.privacy(root), hostKind, registries, identify: deps.local.identify, projectSource, clock,
      });
      const audit = new SetupAuditLog({
        globalStorageDir: deps.globalStorageDir, projectRoot: root, projectKey: projectLogKey(root),
        registry: events, onWriteFailure: deps.onAuditFailure, clock,
      });
      return {
        root, machine, hostKind, readPolicy, check, clock,
        landing: deps.landing(project, request), discovery: deps.discovery?.(project, audit),
        apply: {
          audit, labelHost: gate, policyEditor: deps.policyEditor,
          sink: singleMachineSink(root, { effective: () => gate.policyLayers().effective, source: deps.projectLayerSource }),
          connection(result) {
            // A generic local profile cannot preserve the verified pin for a named server.
            const desired = profileFor([result]);
            if (!desired || result.kind === 'org-server' ||
                desired.provider === 'local' && !isLoopbackEndpointHost(new URL(desired.localBaseUrl).hostname)) return undefined;
            return connectionStep({ root, profiles, chosen: [result], projectName: name,
              configureConnection: () => deps.configureConnection(root) });
          },
        },
      };
    },
  };
}
