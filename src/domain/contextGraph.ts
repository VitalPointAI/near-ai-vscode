export const CONTEXT_GRAPH_VERSION = 1 as const;

export type MemoryScopeKind = 'private-agent' | 'team-collective' | 'project' | 'shared';
export type ContextNodeType = 'fact' | 'actor' | 'function' | 'capability' | 'artifact' | 'task';
export type ContextEdgeType = 'supports' | 'contradicts' | 'depends-on' | 'authored-by' | 'derived-from' | 'relates-to' | 'fulfills' | 'requires' | 'has-capability' | 'affects' | 'assigned-to' | 'cites' | 'supersedes';
export type TensionPolarity = 'positive' | 'negative' | 'neutral';
export type MemoryRecordState = 'active' | 'corrected' | 'merged' | 'retracted';
export type ProvenanceKind = 'user' | 'agent' | 'provider' | 'derived' | 'imported' | 'system';
export type MemoryApprovalOperation = 'correct' | 'merge' | 'retract' | 'reset' | 'export';
export type MemoryProviderBoundary = 'local' | 'cloud' | 'tee' | 'unknown';

export interface MemoryScope {
  kind: MemoryScopeKind;
  id: string;
}

export interface MemoryProvenance {
  kind: ProvenanceKind;
  sourceId: string;
  sourceHash: string;
  capturedAt: string;
  evidenceClass: 'observation' | 'user-assertion' | 'provider-output' | 'derived-metadata' | 'imported-record' | 'system-record';
  actorId?: string;
}

export interface FreshnessPolicy {
  observedAt: string;
  updatedAt: string;
  halfLifeDays: number;
  expiresAfterDays?: number;
}

export interface ConflictState {
  status: 'none' | 'conflicted';
  conflictIds: string[];
  explanation?: string;
}

export interface ContextGraphNode {
  version: typeof CONTEXT_GRAPH_VERSION;
  nodeId: string;
  type: ContextNodeType;
  label: string;
  summary: string;
  scope: MemoryScope;
  provenance: MemoryProvenance;
  confidence: number;
  freshness: FreshnessPolicy;
  state: MemoryRecordState;
  conflict: ConflictState;
  authoringActorId: string;
  createdAt: string;
  updatedAt: string;
  correctedFromNodeId?: string;
  mergedFromNodeIds?: string[];
  retractedAt?: string;
}

export interface ContextGraphEdge {
  version: typeof CONTEXT_GRAPH_VERSION;
  edgeId: string;
  type: ContextEdgeType;
  fromNodeId: string;
  toNodeId: string;
  scope: MemoryScope;
  polarity: TensionPolarity;
  weight: number;
  explanation: string;
  provenance: MemoryProvenance;
  confidence: number;
  freshness: FreshnessPolicy;
  state: MemoryRecordState;
  conflict: ConflictState;
  authoringActorId: string;
  createdAt: string;
  updatedAt: string;
  retractedAt?: string;
}

export interface ContextGraph {
  version: typeof CONTEXT_GRAPH_VERSION;
  scope: MemoryScope;
  graphVersion: number;
  nodes: ContextGraphNode[];
  edges: ContextGraphEdge[];
  updatedAt: string;
  resetAt?: string;
  audit?: MemoryAuditMetadata[];
}

export interface MemorySliceRequest {
  agentId?: string;
  teamId?: string;
  projectId?: string;
  sharedId?: string;
  taskId?: string;
  task: string;
  scopes: MemoryScope[];
  providerBoundary?: MemoryProviderBoundary;
  localOnly?: boolean;
  outboundApproved?: boolean;
  approvalFingerprint?: string;
  maxNodes?: number;
  maxEdges?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface MemorySlice {
  version: typeof CONTEXT_GRAPH_VERSION;
  sliceId: string;
  taskId: string;
  scopes: MemoryScope[];
  graphVersions: Record<string, number>;
  nodeIds: string[];
  edgeIds: string[];
  nodes: ContextGraphNode[];
  edges: ContextGraphEdge[];
  factIds: string[];
  privacy: { localOnly: boolean; providerBoundary: MemoryProviderBoundary; outboundApproved: boolean };
  suppliedAt: string;
}

export interface ContextGraphNodeDto {
  nodeId: string;
  type: ContextNodeType;
  label: string;
  summary: string;
  scope: MemoryScope;
  confidence: number;
  freshness: { observedAt: string; updatedAt: string; decayed: boolean; expiresAt?: string };
  provenance: { kind: ProvenanceKind; sourceId: string; evidenceClass: MemoryProvenance['evidenceClass']; actorId?: string };
  state: MemoryRecordState;
  conflict: ConflictState;
  version: number;
}

export interface ContextGraphEdgeDto {
  edgeId: string;
  type: ContextEdgeType;
  fromNodeId: string;
  toNodeId: string;
  polarity: TensionPolarity;
  weight: number;
  explanation: string;
  scope: MemoryScope;
  state: MemoryRecordState;
  conflict: ConflictState;
  version: number;
}

export interface ContextGraphPreviewDto {
  version: typeof CONTEXT_GRAPH_VERSION;
  scope: MemoryScope;
  graphVersion: number;
  nodes: ContextGraphNodeDto[];
  edges: ContextGraphEdgeDto[];
  counts: { nodes: number; edges: number; facts: number; conflicts: number; retracted: number };
  accessibleOutline: string[];
  localOnly: boolean;
}

export interface MemoryApprovalDescriptor {
  operation: MemoryApprovalOperation;
  scope: MemoryScope;
  expectedGraphVersion: number;
  nodeIds: string[];
  sourceNodeIds: string[];
  summary?: string;
  localOnly: boolean;
  providerBoundary: MemoryProviderBoundary;
  sessionId: string;
  projectId: string;
}

export interface MemoryApprovalPreviewDto {
  version: 1;
  previewId: string;
  operation: MemoryApprovalOperation;
  scope: MemoryScope;
  expectedGraphVersion: number;
  nodeIds: string[];
  sourceNodeIds: string[];
  summaryLength?: number;
  summaryDigest?: string;
  localOnly: boolean;
  providerBoundary: MemoryProviderBoundary;
  sessionId: string;
  projectId: string;
  expiresAt: string;
  approvalFingerprint: string;
}

export type MemoryApprovalOutcome = 'created' | 'consumed' | 'denied' | 'expired' | 'replayed' | 'mismatch';

export interface MemoryApprovalAuditMetadata {
  timestamp: string;
  operation: MemoryApprovalOperation;
  scope: MemoryScope;
  graphVersion: number;
  nodeIds: string[];
  sourceNodeIds: string[];
  outcome: MemoryApprovalOutcome;
  reason?: string;
}

export interface MemoryAuditMetadata {
  timestamp: string;
  operation: 'slice' | 'inspect' | 'search' | 'correct' | 'merge' | 'retract' | 'reset' | 'export' | 'write' | 'edge';
  scope: MemoryScope;
  graphVersion: number;
  nodeIds: string[];
  edgeIds: string[];
  outcome: 'allowed' | 'denied' | 'conflict' | 'cancelled';
  reason?: string;
  provenanceKinds?: ProvenanceKind[];
  approvalOutcome?: MemoryApprovalOutcome;
}

export function scopeKey(scope: MemoryScope): string {
  return `${scope.kind}:${scope.id}`;
}

export function cloneContext<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
