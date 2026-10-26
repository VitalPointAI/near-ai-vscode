import type { AgentLocality } from './agents';

export const CAPABILITY_SNAPSHOT_VERSION = 1 as const;

export type CapabilityModality = 'text' | 'image' | 'video' | 'audio' | 'document' | 'structured';
export type SkillCapability = 'analyze' | 'transcribe' | 'generate_image' | 'generate_video';
export type GenerationOperation = 'image' | 'video';
export type ProviderOperation = 'chat' | 'image-analysis' | 'audio-transcription' | 'image-generation' | 'image-edit' | 'video-generation' | 'video-status' | 'video-content' | 'video-cancel';
export type CapabilityReadiness = 'ready' | 'not-ready' | 'unknown';
export type CapabilityFreshness = 'current' | 'stale' | 'unknown';
export type CapabilityAvailability = 'compatible' | 'unavailable' | 'denied';
export type CapabilityPrivacyBoundary = 'local' | 'cloud' | 'tee' | 'hybrid' | 'unknown';
export type CapabilityMetadataStatus = 'current' | 'unknown' | 'contradictory';

export type CapabilityReasonCode =
  | 'missing-member-skill'
  | 'unsupported-input-modality'
  | 'unsupported-output-modality'
  | 'unsupported-skill'
  | 'unsupported-generation'
  | 'unsupported-provider-operation'
  | 'unknown-model'
  | 'metadata-unknown'
  | 'metadata-contradictory'
  | 'stale-metadata'
  | 'model-not-ready'
  | 'locality-mismatch'
  | 'privacy-mismatch'
  | 'unavailable-pricing'
  | 'cancellation-unsupported'
  | 'publication-unsupported';

export interface CapabilityPricing {
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  cachePricePerMillion?: number;
  imagePricePerUnit?: number;
  videoPricePerUnit?: number;
  requestPricePerUnit?: number;
}

export interface GenerationCapability {
  operations: GenerationOperation[];
  cancellationSupported?: boolean;
  publicationSupported?: boolean;
}

export interface ModelCapabilitySnapshot {
  version: typeof CAPABILITY_SNAPSHOT_VERSION;
  snapshotId: string;
  provider: string;
  modelId: string;
  displayName?: string;
  inputModalities: CapabilityModality[];
  outputModalities: CapabilityModality[];
  supportedFeatures: SkillCapability[];
  providerOperations: ProviderOperation[];
  generation?: GenerationCapability;
  readiness: CapabilityReadiness;
  contextLength?: number;
  maxOutputTokens?: number;
  pricing: CapabilityPricing;
  privacyBoundary: CapabilityPrivacyBoundary;
  locality: AgentLocality | 'unknown';
  verificationStatus: 'verified' | 'unverified' | 'unknown';
  attestationStatus?: string;
  metadataStatus: CapabilityMetadataStatus;
  freshness: CapabilityFreshness;
  fetchedAt?: string;
  source: string;
  availability: CapabilityAvailability;
  unavailableReasons: CapabilityReasonCode[];
}

export interface CapabilityRequirement {
  requirementId: string;
  modality?: CapabilityModality;
  inputModality?: CapabilityModality;
  outputModality?: CapabilityModality;
  skill?: SkillCapability;
  generationOperation?: GenerationOperation;
  providerOperation?: ProviderOperation;
  locality?: AgentLocality;
  privacyBoundary?: CapabilityPrivacyBoundary;
  requiresCostEstimate?: boolean;
  requiresCancellation?: boolean;
  requiresPublication?: boolean;
  maxCostUsd?: number;
}

export interface CapabilityRouteInput {
  profileId?: string;
  provider: string;
  model?: string;
  locality: AgentLocality;
  privacyBoundary?: CapabilityPrivacyBoundary;
  memberSkills?: string[];
  estimatedCostUsd?: number;
}

export interface CapabilityEvaluation {
  requirementId: string;
  status: CapabilityAvailability;
  compatible: boolean;
  reasons: CapabilityReasonCode[];
  explanation: string;
  snapshot?: ModelCapabilitySnapshot;
  costAvailable: boolean;
}

export interface CapabilityRouteResult {
  requirement: CapabilityRequirement;
  compatibleCandidates: Array<{ candidate: CapabilityRouteInput; evaluation: CapabilityEvaluation }>;
  excludedCandidates: Array<{ candidate: CapabilityRouteInput; evaluation: CapabilityEvaluation }>;
  reason: string;
}

export function cloneCapability<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
