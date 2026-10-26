import type { AttributionSnapshot } from './activity';
import type { ModelCapabilitySnapshot, CapabilityPrivacyBoundary } from './capabilities';
import type { ProviderBoundary } from './privacy';

export const GENERATION_VERSION = 1 as const;
export const MAX_GENERATION_PROMPT = 8_000;
export const MAX_GENERATION_SOURCES = 8;
export const MAX_VIDEO_POLLS = 20;

export type GenerationSkill = 'generate_image' | 'generate_video';
export type GenerationOperation = 'image-generation' | 'image-edit' | 'video-generation';
export type VideoProviderState = 'queued' | 'in-progress' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type GenerationLifecycle = 'awaiting-approval' | 'queued' | 'in-progress' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'budget-blocked';
export type PublicationLifecycle = 'unpublished' | 'awaiting-approval' | 'published' | 'failed' | 'cancelled';
export type GenerationReasonCode =
  | 'invalid-request'
  | 'unknown-model'
  | 'metadata-unknown'
  | 'stale-metadata'
  | 'metadata-contradictory'
  | 'model-not-ready'
  | 'unsupported-skill'
  | 'unsupported-operation'
  | 'unsupported-provider-operation'
  | 'unsupported-provider-endpoint'
  | 'unsupported-cancellation'
  | 'unsupported-publication'
  | 'privacy-mismatch'
  | 'unavailable-pricing'
  | 'approval-required'
  | 'approval-mismatch'
  | 'approval-expired'
  | 'budget-blocked'
  | 'emergency-stop'
  | 'provider-failed'
  | 'unknown-provider-state'
  | 'cancelled'
  | 'output-storage-failed'
  | 'publication-approval-required'
  | 'publication-destination-invalid'
  | 'publication-not-eligible'
  | 'publication-failed'
  | 'raw-content-not-approved';

export interface GenerationParameters {
  count?: number;
  size?: string;
  quality?: string;
  durationSeconds?: number;
}

export interface GenerationRequest {
  operation: GenerationOperation;
  skill: GenerationSkill;
  provider: string;
  model: string;
  prompt: string;
  sessionId: string;
  projectId: string;
  attribution: AttributionSnapshot;
  providerBoundary: ProviderBoundary;
  privacyBoundary: CapabilityPrivacyBoundary;
  sourceArtifactIds?: string[];
  parameters?: GenerationParameters;
  rawContentRequested?: boolean;
}

export interface GenerationRouteSnapshot {
  provider: string;
  model: string;
  operation: GenerationOperation;
  capabilitySnapshotId: string;
  capabilityMetadata: Pick<ModelCapabilitySnapshot, 'version' | 'snapshotId' | 'provider' | 'modelId' | 'inputModalities' | 'outputModalities' | 'supportedFeatures' | 'providerOperations' | 'readiness' | 'pricing' | 'privacyBoundary' | 'locality' | 'verificationStatus' | 'metadataStatus' | 'freshness' | 'source'>;
  providerBoundary: ProviderBoundary;
  privacyBoundary: CapabilityPrivacyBoundary;
  capturedAt: string;
}

export interface GenerationCostEstimate {
  amountUsd: number;
  currency: 'USD';
  basis: 'image-unit' | 'video-unit' | 'request-unit';
  quantity: number;
}

export interface GenerationUsage {
  requestId?: string;
  providerJobId?: string;
  inputTokens?: number;
  outputTokens?: number;
  units?: number;
  actualCostUsd?: number;
  verificationStatus?: 'verified' | 'unverified' | 'unknown';
}

export interface GenerationApproval {
  previewId: string;
  approvalFingerprint: string;
  expiresAt: string;
  action: 'generation' | 'publication';
}

export interface GeneratedArtifact {
  version: typeof GENERATION_VERSION;
  artifactId: string;
  operationId: string;
  sourceArtifactIds: string[];
  promptFingerprint: string;
  route: GenerationRouteSnapshot;
  managedReference: string;
  storageBoundary: 'workspace-managed';
  provenance: 'provider-generated' | 'provider-edited';
  privacyBoundary: CapabilityPrivacyBoundary;
  attribution: AttributionSnapshot;
  estimatedCostUsd?: number;
  usage?: GenerationUsage;
  publication: PublicationLifecycle;
  createdAt: string;
}

export interface GenerationOperationRecord {
  version: typeof GENERATION_VERSION;
  operationId: string;
  skill: GenerationSkill;
  operation: GenerationOperation;
  provider: string;
  model: string;
  promptFingerprint: string;
  sourceArtifactIds: string[];
  parameters: GenerationParameters;
  route: GenerationRouteSnapshot;
  status: GenerationLifecycle;
  approval?: GenerationApproval;
  providerJobId?: string;
  estimatedCost?: GenerationCostEstimate;
  usage?: GenerationUsage;
  artifactId?: string;
  publication: PublicationLifecycle;
  attribution: AttributionSnapshot;
  sessionId: string;
  projectId: string;
  reason?: GenerationReasonCode;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationPreview {
  operationId: string;
  skill: GenerationSkill;
  operation: GenerationOperation;
  provider: string;
  model: string;
  capabilitySnapshotId: string;
  capabilityFreshness: 'current' | 'stale' | 'unknown';
  providerBoundary: ProviderBoundary;
  privacyBoundary: CapabilityPrivacyBoundary;
  estimatedCost?: GenerationCostEstimate;
  approval: GenerationApproval;
  attribution: AttributionSnapshot;
  sourceArtifactIds: string[];
  publication: PublicationLifecycle;
}

export interface PublicationRequest {
  operationId: string;
  destination: string;
  attribution: AttributionSnapshot;
}

export interface PublicationPreview {
  operationId: string;
  artifactId: string;
  destination: string;
  approval: GenerationApproval;
  attribution: AttributionSnapshot;
  provenance: 'provider-generated' | 'provider-edited';
}

export interface GenerationProviderInput {
  operationId: string;
  provider: string;
  model: string;
  prompt: string;
  parameters: GenerationParameters;
  sourceArtifactIds: string[];
  rawContentHandles: readonly { artifactId: string; managedPath: string; contentHash: string }[];
  signal: AbortSignal;
}

export interface ProviderGenerationResult {
  status: 'completed' | 'queued' | 'in-progress' | 'failed';
  requestId?: string;
  providerJobId?: string;
  bytes?: Uint8Array;
  usage?: GenerationUsage;
  errorCode?: string;
}

export interface ProviderVideoStatus {
  status: VideoProviderState;
  providerJobId: string;
  requestId?: string;
  bytes?: Uint8Array;
  usage?: GenerationUsage;
  errorCode?: string;
}

export interface GenerationProviderAdapter {
  provider: string;
  operations: readonly GenerationOperation[];
  providerOperations: readonly string[];
  createImage(input: GenerationProviderInput): Promise<ProviderGenerationResult>;
  editImage(input: GenerationProviderInput): Promise<ProviderGenerationResult>;
  createVideo?(input: GenerationProviderInput): Promise<ProviderGenerationResult>;
  pollVideo?(providerJobId: string, signal: AbortSignal): Promise<ProviderVideoStatus>;
  cancelVideo?(providerJobId: string, signal: AbortSignal): Promise<void>;
}

export function cloneGeneration<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
