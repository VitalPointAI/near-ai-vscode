import type { AgentCapability, AgentLocality, AgentRole, AgentProfile } from './agents';
import type { CapabilityEvaluation, CapabilityRequirement, ModelCapabilitySnapshot } from './capabilities';
import type { MemoryScope, MemorySlice, MemorySliceRequest } from './contextGraph';

export const ROUTING_VERSION = 1 as const;
export type ReputationEvidenceKind = 'verifiedOutcome' | 'rework' | 'reliability' | 'latency' | 'costEfficiency' | 'userFeedback';
export type AgentLifecycleStatus = 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'limit-blocked';

export interface ReputationEvidence {
  version: typeof ROUTING_VERSION;
  evidenceId: string;
  profileId: string;
  role: AgentRole;
  kind: ReputationEvidenceKind;
  value: number;
  recordedAt: string;
  source: 'runtime' | 'user';
  outcome?: 'success' | 'failure' | 'partial';
  capabilityRequirementId?: string;
  capabilitySnapshotId?: string;
}

export interface ReputationScore {
  profileId: string;
  role: AgentRole;
  score: number;
  components: Record<ReputationEvidenceKind, number>;
  evidenceCount: number;
  decayedAt: string;
  optedOut: boolean;
}

export interface ReputationDecayConfig {
  halfLifeDays: number;
  explorationRate: number;
  minimumEligibility: number;
}

export interface RouteCandidate {
  profile: AgentProfile;
  role: AgentRole;
  capabilities: AgentCapability[];
  provider: string;
  locality: AgentLocality;
  model?: string;
  reputation: ReputationScore;
  eligible: boolean;
  exclusions: string[];
  privacyBoundary?: 'local' | 'cloud' | 'tee' | 'hybrid' | 'unknown';
  capability?: CapabilityEvaluation;
}

export interface RoutingRequest {
  role: AgentRole;
  task: string;
  requiredCapabilities: AgentCapability[];
  provider?: string;
  locality?: AgentLocality;
  model?: string;
  privacyBoundary?: 'local' | 'cloud' | 'tee' | 'unknown';
  capabilityRequirement?: CapabilityRequirement;
  /** Alias kept for callers that describe the request as a capability. */
  capability?: CapabilityRequirement;
  now?: string;
  memory?: Omit<MemorySliceRequest, 'task' | 'scopes'> & { scopes?: MemoryScope[] };
}

export interface RoutingExplanation {
  role: AgentRole;
  task: string;
  candidatesConsidered: Array<{ profileId: string; name: string; eligible: boolean; score: number; exclusions: string[]; capability?: { status: string; reasons: string[]; snapshotId?: string; freshness?: string } }>;
  constraints: string[];
  scoreComponents: Record<ReputationEvidenceKind, number>;
  decayTimestamp: string;
  exploration: { applied: boolean; rate: number; reason: string };
  selectedProfileId?: string;
  selectedRoute?: { provider: string; locality: AgentLocality; model?: string };
  capabilityRequirementId?: string;
  capabilitySnapshotId?: string;
  capabilityFreshness?: string;
  reason: string;
  memory?: Pick<MemorySlice, 'sliceId' | 'scopes' | 'graphVersions' | 'nodeIds' | 'edgeIds' | 'factIds' | 'privacy'>;
}

export interface RouteSelection {
  candidate: RouteCandidate;
  explanation: RoutingExplanation;
}

export interface AgentLifecycleEvent {
  version: typeof ROUTING_VERSION;
  id: string;
  timestamp: string;
  agentId: string;
  profileId: string;
  role: AgentRole;
  task: string;
  model: string;
  route: string;
  status: AgentLifecycleStatus;
  costUsd?: number;
  durationMs?: number;
  approvalRequired: boolean;
  error?: string;
  outcome?: 'success' | 'failure' | 'partial';
  projectId?: string;
  organizationProfileId?: string;
  capabilityRequirementId?: string;
  capabilitySnapshotId?: string;
  routeSnapshot?: {
    provider: string;
    model?: string;
    locality: AgentLocality;
    privacyBoundary?: string;
    capturedAt: string;
  };
}

export interface AgentLimits { maxConcurrent: number; maxSpendUsd: number; maxDurationMs: number; }

