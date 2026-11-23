import { readGuidePolicy, type GuidePolicy } from '../../domain/setup/policy';
import type { GuideDiscoveryPort } from '../../domain/setup/screens';
import type { GateHost } from '../../gate/host';
import type { GuideControllerDeps, GuideRouteSnapshot } from './guideController';
import { createGuideDiscovery, type GuideDiscoveryDeps } from './guideDiscovery';
import { readHostNetworkFacts } from './networkFacts';

export type ProjectDiscoveryTransports =
  Omit<GuideDiscoveryDeps, 'policy' | 'endpoints' | 'organization' | 'audit' | 'editor' | 'hostKind' | 'networkFacts'> &
  Partial<Pick<GuideDiscoveryDeps, 'networkFacts'>>;

interface DiscoveryAttempt {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  authority?: { readonly snapshot: GuideRouteSnapshot; readonly policy: GuidePolicy };
}

const unavailable: GuidePolicy = { state: 'failed-closed', sentence: 'The project rules could not be verified.', contacts: [] };

/** Give an injected discovery transport the current signed authority of one project run. */
export function createProjectGuideDiscovery(deps: {
  readonly root: string;
  readonly currentRoot: () => string | undefined;
  readonly gate: Pick<GateHost, 'bundleState' | 'onDidChange'>;
  readonly readPolicy: GuideControllerDeps['readPolicy'];
  readonly clock?: () => number;
  readonly transports: ProjectDiscoveryTransports;
} & Pick<GuideDiscoveryDeps, 'audit' | 'editor' | 'hostKind'>): GuideDiscoveryPort {
  let active: DiscoveryAttempt | undefined;
  const now = deps.clock ?? Date.now;
  function authority() {
    const attempt = active;
    if (!attempt?.authority || attempt.signal.aborted) return undefined;
    const state = deps.gate.bundleState();
    if (deps.currentRoot() !== deps.root || state.state !== 'valid' || state.hash !== attempt.authority.snapshot.hash) {
      attempt.controller.abort();
      return undefined;
    }
    return attempt.authority;
  }
  const discovery = createGuideDiscovery({
    ...deps.transports, audit: deps.audit, editor: deps.editor, hostKind: deps.hostKind,
    networkFacts: deps.transports.networkFacts ?? readHostNetworkFacts,
    policy: () => authority()?.policy ?? unavailable,
    endpoints: () => authority()?.snapshot.route.endpoints ?? [],
    get organization() {
      const view = authority()?.snapshot.view;
      return { present: view?.organization === 'valid', issuedHere: view?.issuedHere === true };
    },
  });
  return {
    ...discovery,
    async refresh(parent) {
      active?.controller.abort();
      const controller = new AbortController();
      const signal = AbortSignal.any([parent, controller.signal]);
      const attempt: DiscoveryAttempt = { controller, signal };
      active = attempt;
      if (signal.aborted || deps.currentRoot() !== deps.root) return;
      const snapshot = await deps.readPolicy(now()).catch(() => undefined);
      if (signal.aborted || !snapshot || !('route' in snapshot)) return;
      const policy = readGuidePolicy(snapshot.view);
      if (policy.state !== 'ready') return;
      attempt.authority = { snapshot, policy };
      if (!authority()) return;
      const unsubscribe = deps.gate.onDidChange(authority);
      signal.addEventListener('abort', unsubscribe, { once: true });
      await discovery.refresh(signal);
    },
  };
}
