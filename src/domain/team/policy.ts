// Team policy defaults (D-13, with integer basis points from D-30). Every call returns fresh arrays and objects.
import type { DispatchWeight, Role, TeamPolicy } from './types';

export const DEFAULT_SHARED_PATHS: readonly string[] = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'CHANGELOG.md', '.planning/STATE.md', '.planning/ROADMAP.md', '.planning/REQUIREMENTS.md'];
export const DEFAULT_RESOURCES: readonly string[] = ['integrator', 'deps', 'db-schema', 'release'];
export const DEFAULT_WIP_LIMIT = 2;

export function defaultTeamPolicy(options: { integrationBranch?: string } = {}): TeamPolicy {
  const allowedModels: Record<Role, string[]> = { owner: [], lead: [], developer: [], reviewer: [], observer: [] };
  const dispatchWeightsBp: Record<DispatchWeight, number> = { roleFit: 3000, fileAffinity: 2500, continuity: 1500, capacity: 1500, budgetHeadroom: 1000, criticalPath: 500 };
  return {
    dispatchMode: 'offer', offerTimeoutMinutes: 30, leaseTtlMinutes: 60, heartbeatMinutes: 10, enforceWip: true,
    sharedPaths: [...DEFAULT_SHARED_PATHS], resources: [...DEFAULT_RESOURCES], verifyCommands: ['npm run lint', 'npm test'], reviewPolicy: 'agent-then-human',
    integrationMode: 'merge-train', integrationBranch: options.integrationBranch ?? 'main', budgetPeriod: 'monthly', unspentPolicy: 'return-to-pool',
    safetyFactorBp: 12500, overrunFactorBp: 15000, reconcileToleranceBp: 500, allowedModels, teeOnly: false,
    peerMetricsVisible: false, requireLeadConfirmation: true, developerMayIntegrate: false, dispatchWeightsBp
  };
}
