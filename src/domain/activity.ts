export type ActivityStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'setup-blocked';

export type ActivityKind = 'session' | 'phase' | 'agent' | 'model' | 'tool' | 'approval' | 'message';

export type AttributionStatus = 'attributed' | 'legacy-unknown';

/** Ownership captured by the extension host when a request/session starts. */
export interface AttributionSnapshot {
  version: 1;
  status: AttributionStatus;
  projectId: string;
  projectLabel: string;
  organizationProfileId: string;
  organizationDisplayName: string;
}

export const UNKNOWN_ATTRIBUTION: AttributionSnapshot = {
  version: 1,
  status: 'legacy-unknown',
  projectId: 'unknown-project',
  projectLabel: 'Unknown project',
  organizationProfileId: 'unknown-profile',
  organizationDisplayName: 'Legacy / unknown organization'
};

export function hostAttribution(projectId: string, projectLabel: string, organizationProfileId: string, organizationDisplayName: string): AttributionSnapshot {
  return {
    version: 1,
    status: 'attributed',
    projectId: safeLabel(projectId, 80) ?? UNKNOWN_ATTRIBUTION.projectId,
    projectLabel: safeLabel(projectLabel, 160) ?? UNKNOWN_ATTRIBUTION.projectLabel,
    organizationProfileId: safeLabel(organizationProfileId, 80) ?? UNKNOWN_ATTRIBUTION.organizationProfileId,
    organizationDisplayName: safeLabel(organizationDisplayName, 120) ?? UNKNOWN_ATTRIBUTION.organizationDisplayName
  };
}

export function normalizeAttribution(value: unknown, legacyProjectLabel?: string): AttributionSnapshot {
  if (!value || typeof value !== 'object') return { ...UNKNOWN_ATTRIBUTION, projectLabel: safeLabel(legacyProjectLabel, 160) ?? UNKNOWN_ATTRIBUTION.projectLabel };
  const source = value as Partial<AttributionSnapshot>;
  if (source.status !== 'attributed' || source.version !== 1) return { ...UNKNOWN_ATTRIBUTION, projectLabel: safeLabel(legacyProjectLabel, 160) ?? UNKNOWN_ATTRIBUTION.projectLabel };
  const projectId = safeLabel(source.projectId, 80);
  const projectLabel = safeLabel(source.projectLabel, 160);
  const profileId = safeLabel(source.organizationProfileId, 80);
  const organization = safeLabel(source.organizationDisplayName, 120);
  return projectId && projectLabel && profileId && organization
    ? { version: 1, status: 'attributed', projectId, projectLabel, organizationProfileId: profileId, organizationDisplayName: organization }
    : { ...UNKNOWN_ATTRIBUTION, projectLabel: safeLabel(legacyProjectLabel, 160) ?? UNKNOWN_ATTRIBUTION.projectLabel };
}

export interface ActivityEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  attribution?: AttributionSnapshot;
  kind: ActivityKind;
  status: ActivityStatus;
  summary: string;
  phase?: string;
  agentId?: string;
  agentRole?: string;
  model?: string;
  tool?: string;
  action?: string;
  route?: string;
  requestId?: string;
  cacheHit?: boolean;
  agentCount?: number;
  attempt?: number;
  retry?: boolean;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  approvalRequired?: boolean;
  errorCode?: string;
}

export type SessionOutcome = 'running' | 'completed' | 'failed' | 'cancelled' | 'setup-blocked';
export interface ActivityApprovalSummary { required: number; approved: number; pending: number; }
export interface ActivityContextSummary { userTurns: number; assistantTurns: number; lastEvent?: string; }
export interface ActivitySessionSummary {
  version: 1;
  sessionId: string;
  project: string;
  attribution?: AttributionSnapshot;
  phase?: string;
  plans: string[];
  agents: AgentCounts;
  models: string[];
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  approvals: ActivityApprovalSummary;
  startedAt: string;
  updatedAt: string;
  outcome: SessionOutcome;
  continuationAvailable: boolean;
  context: ActivityContextSummary;
  events: ActivityEvent[];
}
export interface ActivityLedger { version: 1; sessions: ActivitySessionSummary[]; }

export interface AgentCounts {
  deployed: number;
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export function emptyAgentCounts(): AgentCounts {
  return { deployed: 0, active: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 };
}

export function summarizeAgentCounts(events: ActivityEvent[]): AgentCounts {
  const counts = emptyAgentCounts();
  for (const event of events) {
    if (event.kind !== 'agent') continue;
    counts.deployed += 1;
    if (event.status === 'running') counts.active += 1;
    if (event.status === 'waiting') counts.waiting += 1;
    if (event.status === 'completed') counts.completed += 1;
    if (event.status === 'failed') counts.failed += 1;
    if (event.status === 'cancelled') counts.cancelled += 1;
  }
  return counts;
}

export function sessionOutcome(status: ActivityStatus): SessionOutcome {
  if (status === 'setup-blocked') return 'setup-blocked';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'completed';
  return 'running';
}

function safeLabel(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || /[\r\n\t]/.test(value) || /(?:api[_ -]?key|refresh[-_ ]?token|bearer\s|authorization\s*[:=]|private prompt|raw context|command\s*[:=]|[A-Za-z]:\\|^\/)/i.test(value)) return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}
