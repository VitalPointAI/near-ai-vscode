import type { ActionCapability, ActionDecision } from './policy';
import type { DataClass, ProviderBoundary, PrivacyDecision, RedactedPreview } from './privacy';
import type { AttributionSnapshot } from './activity';
import type { StakeHistoryEntry } from './staking';

export type ApprovalDecision = 'approved' | 'denied' | 'expired' | 'stale' | 'pending';
export type BudgetScope = 'request' | 'session' | 'project';
export type BudgetStatus = 'ok' | 'warning' | 'hard-stop';
export type AuditEventType =
  | 'preflight' | 'route' | 'preview' | 'approval' | 'dispatch' | 'denial' | 'retry'
  | 'pause' | 'resume' | 'cancellation' | 'budget' | 'emergency-stop'
  | 'completed' | 'failed' | 'setup-blocked' | 'near-wallet';

export interface CostEstimate { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; currency: 'USD'; }
export interface BudgetState { limitUsd: number; spentUsd: number; reservedUsd: number; remainingUsd: number; status: BudgetStatus; warningAtUsd: number; }

export interface ApprovalRequest {
  requestId: string;
  sessionId: string;
  projectId: string;
  attribution?: AttributionSnapshot;
  phase?: string;
  agentId?: string;
  agentRole?: string;
  capability: ActionCapability;
  action: string;
  targetScope: string;
  provider: string;
  providerBoundary: ProviderBoundary;
  context?: string;
  paths?: string[];
  scope?: string;
  estimated: CostEstimate;
  reversible: boolean;
  policyVersion?: string;
}

export interface ApprovalPreview {
  version: 1;
  previewId: string;
  requestId: string;
  sessionId: string;
  projectId: string;
  attribution: AttributionSnapshot;
  phase?: string;
  agentId?: string;
  capability: ActionCapability;
  action: string;
  targetScope: string;
  provider: string;
  providerBoundary: ProviderBoundary;
  verificationStatus: 'verified' | 'unverified' | 'not-applicable' | 'unknown';
  dataClasses: DataClass[];
  dataSummary: string;
  redactedPrivacyPreview: RedactedPreview;
  estimated: CostEstimate;
  budgetBefore: Record<BudgetScope, BudgetState>;
  budgetAfter: Record<BudgetScope, BudgetState>;
  reversible: boolean;
  riskExplanation: string;
  requiresApproval: boolean;
  expiresAt: string;
  policyVersion: string;
}

export interface ApprovalRecord { previewId: string; requestId: string; decision: ApprovalDecision; decidedAt: string; reason: string; }

export interface AuditEvent {
  version: 1;
  id: string;
  timestamp: string;
  type: AuditEventType;
  sessionId?: string;
  projectId?: string;
  attribution?: AttributionSnapshot;
  phase?: string;
  agentId?: string;
  agentRole?: string;
  model?: string;
  provider?: string;
  capability?: ActionCapability;
  requestId?: string;
  previewId?: string;
  outcome?: string;
  reason?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  estimatedTokens?: number;
  actualTokens?: number;
  budgetStatus?: BudgetStatus;
  dataClasses?: DataClass[];
  scopeSummary?: string;
  wallet?: StakeHistoryEntry;
  metadata?: Record<string, string | number | boolean | undefined>;
}

export interface AuditFilter { sessionId?: string; projectId?: string; organizationProfileId?: string; phase?: string; agentId?: string; agentRole?: string; model?: string; from?: string; to?: string; type?: AuditEventType; }

export interface ApprovalServiceOptions { now?: () => number; requestLimitUsd?: number; sessionLimitUsd?: number; projectLimitUsd?: number; warningRatio?: number; approvalTtlMs?: number; audit?: { append(event: AuditEvent): Promise<void> | void }; }

export type PolicyEvaluation = { action: ActionDecision; allowed: boolean; reason: string; preflight?: { preview: RedactedPreview; decision: PrivacyDecision } };
