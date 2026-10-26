import type { AgentCounts, ActivityEvent, AttributionSnapshot } from './activity';
import type { AuditEvent } from './approval';
import type { AuditFilter } from './approval';
import type { ReputationEvidence, ReputationScore } from './routing';
import type { MemoryAuditMetadata } from './contextGraph';

export interface AnalyticsFilter { sessionId?: string; projectId?: string; organizationProfileId?: string; phase?: string; model?: string; role?: string; agentId?: string; from?: string; to?: string; offset?: number; limit?: number; }
export interface AnalyticsCostGroup { attribution: AttributionSnapshot; requests: number; inputTokens?: number; outputTokens?: number; estimatedUsd?: number; actualUsd?: number; cacheHits: number; }
export interface AnalyticsCostSummary { requests: number; inputTokens?: number; outputTokens?: number; estimatedUsd?: number; actualUsd?: number; cacheHits: number; budgetRemainingUsd?: number; groups?: AnalyticsCostGroup[]; }
export interface AnalyticsLatencySummary { count: number; totalMs: number; averageMs?: number; p95Ms?: number; }
export interface AgentSnapshot { agentId: string; role?: string; task: string; model?: string; route?: string; status: ActivityEvent['status']; tokens?: number; estimatedCostUsd?: number; actualCostUsd?: number; durationMs?: number; approvalRequired: boolean; errorCode?: string; outcome?: string; updatedAt: string; attribution?: AttributionSnapshot; }
export interface AnalyticsTimelineEvent { id: string; timestamp: string; source: 'activity' | 'audit' | 'reputation' | 'memory'; kind: string; summary: string; sessionId?: string; projectId?: string; projectLabel?: string; organizationProfileId?: string; organizationDisplayName?: string; attributionStatus?: AttributionSnapshot['status']; phase?: string; agentId?: string; role?: string; model?: string; route?: string; status?: string; requestId?: string; evidenceId?: string; scope?: string; nodeIds?: string[]; edgeIds?: string[]; }
export interface ReputationEvidenceSummary { profileId: string; role: ReputationScore['role']; score?: number; evidenceCount: number; components?: ReputationScore['components']; evidence: Array<Pick<ReputationEvidence, 'evidenceId' | 'kind' | 'value' | 'recordedAt' | 'source' | 'outcome'>>; }
export interface AnalyticsResult { filter: AnalyticsFilter; fleet: AgentFleetSnapshot; timeline: AnalyticsTimelineEvent[]; agents: AgentSnapshot[]; cost: AnalyticsCostSummary; latency: AnalyticsLatencySummary; models: Record<string, number>; reputation: ReputationEvidenceSummary[]; totalEvents: number; }
export interface AgentFleetSnapshot { counts: AgentCounts; agents: AgentSnapshot[]; timeline: AnalyticsTimelineEvent[]; cost: AnalyticsCostSummary; latency: AnalyticsLatencySummary; models: Record<string, number>; reputation: ReputationEvidenceSummary[]; }
export interface AnalyticsExport { version: 1; exportedAt: string; result: AnalyticsResult; }

export type AnalyticsActivitySource = { sessions: Array<{ sessionId: string; project: string; attribution?: AttributionSnapshot; phase?: string; events: ActivityEvent[] }> };
export type AnalyticsAuditSource = { list(filter?: AuditFilter): Promise<AuditEvent[]> };
export type AnalyticsReputationSource = { list(): Promise<ReputationEvidence[]>; getScore(profileId: string, role: ReputationScore['role']): Promise<ReputationScore> };
export type AnalyticsMemorySource = { getAudit(): Promise<MemoryAuditMetadata[]> };
