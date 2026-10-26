import type { AttributionSnapshot } from './activity';
import type { CapabilityPrivacyBoundary } from './capabilities';
import type { DataClass, ProviderBoundary, SovereigntyMode } from './privacy';

export const MULTIMODAL_VERSION = 1 as const;
export const MAX_ATTACHMENT_LABEL = 120;
export const MAX_LINEAGE_SOURCES = 8;
export const MAX_DERIVED_ARTIFACTS = 16;

export type MultimodalModality = 'image' | 'video' | 'audio' | 'document' | 'structured';
export type AttachmentLifecycle = 'staged' | 'rejected' | 'cancelled';
export type ArtifactKind = 'thumbnail' | 'frame' | 'transcript' | 'extracted-text' | 'structured-projection' | 'summary' | 'transformed';
export type MultimodalOperation = 'inspect' | 'transcribe' | 'extract' | 'summarize' | 'transform' | 'publish';
export type OperationLifecycle = 'prepared' | 'awaiting-approval' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'budget-blocked';
export type MultimodalReasonCode =
  | 'invalid-reference'
  | 'path-traversal'
  | 'absolute-path'
  | 'workspace-containment'
  | 'symlink-escape'
  | 'missing-file'
  | 'not-a-file'
  | 'oversized'
  | 'empty-file'
  | 'unsupported-modality'
  | 'unsupported-mime'
  | 'content-mismatch'
  | 'malformed-structured-data'
  | 'unsupported-codec'
  | 'sensitive-source'
  | 'privacy-blocked'
  | 'consent-required'
  | 'provenance-mismatch'
  | 'unknown-capability'
  | 'stale-capability'
  | 'unavailable-pricing'
  | 'operation-not-supported'
  | 'cloud-transfer-not-approved'
  | 'approval-required'
  | 'approval-fingerprint-mismatch'
  | 'approval-expired'
  | 'scope-escalation'
  | 'budget-blocked'
  | 'emergency-stop'
  | 'cancelled'
  | 'provider-failed'
  | 'restart-requires-approval';

export interface ModalityValidationProfile {
  modality: MultimodalModality;
  mimeTypes: string[];
  extensions: string[];
  maxBytes: number;
}

export interface AttachmentProvenance {
  sourceKind: 'workspace-file' | 'user-selected-file';
  sourceReference: string;
  workspaceRootFingerprint: string;
  contained: true;
  selectedAt: string;
  sourceHash: string;
}

export interface AttachmentPrivacyState {
  classification: DataClass;
  sovereigntyMode: SovereigntyMode;
  localOnly: boolean;
  consent: 'not-required' | 'required' | 'granted' | 'revoked';
  redaction: 'metadata-only' | 'redacted' | 'not-redacted';
  providerBoundary: ProviderBoundary;
}

export interface AttachmentPreview {
  artifactId: string;
  label: string;
  modality: MultimodalModality;
  detectedMime: string;
  byteSize: number;
  contentHash: string;
  dimensions?: { width: number; height: number };
  durationMs?: number;
  privacy: Pick<AttachmentPrivacyState, 'classification' | 'sovereigntyMode' | 'localOnly' | 'redaction'>;
  lifecycle: AttachmentLifecycle;
}

/** Safe metadata only. Raw bytes and host filesystem handles are deliberately absent. */
export interface AttachmentRecord {
  version: typeof MULTIMODAL_VERSION;
  artifactId: string;
  label: string;
  modality: MultimodalModality;
  declaredMime: string;
  detectedMime: string;
  byteSize: number;
  contentHash: string;
  sourcePath: string;
  managedReference: string;
  provenance: AttachmentProvenance;
  privacy: AttachmentPrivacyState;
  lifecycle: AttachmentLifecycle;
  createdAt: string;
}

/** Host-only capability to read staged bytes. Never serialize or send this value to a provider by default. */
export interface RawContentHandle {
  readonly artifactId: string;
  readonly managedPath: string;
  readonly contentHash: string;
  readonly authorized: boolean;
}

export interface MultimodalRoute {
  provider: string;
  model: string;
  providerBoundary: ProviderBoundary;
  privacyBoundary: CapabilityPrivacyBoundary;
  capabilitySnapshotId: string;
  freshness: 'current' | 'stale' | 'unknown';
  supportedOperations: readonly MultimodalOperation[];
  cancellationSupported: boolean;
}

export interface MultimodalApprovalPreview {
  operationId: string;
  approvalFingerprint: string;
  operation: MultimodalOperation;
  sourceArtifactIds: string[];
  provider: string;
  model: string;
  providerBoundary: ProviderBoundary;
  rawContentRequested: boolean;
  expiresAt: string;
  reason: string;
}

export interface LineageEdge {
  sourceArtifactId: string;
  derivedArtifactId: string;
  operationId: string;
  operation: MultimodalOperation;
  transformationVersion: string;
  createdAt: string;
}

export interface DerivedArtifact {
  version: typeof MULTIMODAL_VERSION;
  artifactId: string;
  operationId: string;
  kind: ArtifactKind;
  label: string;
  sourceArtifactIds: string[];
  inputFingerprint: string;
  contentHash?: string;
  managedReference?: string;
  safePreview?: string;
  privacy: AttachmentPrivacyState;
  provenance: AttachmentProvenance;
  transformationVersion: string;
  route: Pick<MultimodalRoute, 'provider' | 'model' | 'providerBoundary' | 'privacyBoundary' | 'capabilitySnapshotId'>;
  attribution?: AttributionSnapshot;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  publicationEligible: boolean;
  createdAt: string;
}

export interface MultimodalOperationRecord {
  version: typeof MULTIMODAL_VERSION;
  operationId: string;
  operation: MultimodalOperation;
  sourceArtifactIds: string[];
  route: MultimodalRoute;
  sessionId?: string;
  projectId?: string;
  status: OperationLifecycle;
  approval?: MultimodalApprovalPreview;
  approvalFingerprint?: string;
  attribution?: AttributionSnapshot;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  derivedArtifactIds: string[];
  reason?: MultimodalReasonCode;
  createdAt: string;
  updatedAt: string;
}

export interface MultimodalLedger {
  version: typeof MULTIMODAL_VERSION;
  attachments: AttachmentRecord[];
  operations: MultimodalOperationRecord[];
  derivedArtifacts: DerivedArtifact[];
  lineage: LineageEdge[];
}

export function cloneMultimodal<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function attachmentPreview(record: AttachmentRecord): AttachmentPreview {
  return {
    artifactId: record.artifactId,
    label: record.label,
    modality: record.modality,
    detectedMime: record.detectedMime,
    byteSize: record.byteSize,
    contentHash: record.contentHash,
    privacy: { classification: record.privacy.classification, sovereigntyMode: record.privacy.sovereigntyMode, localOnly: record.privacy.localOnly, redaction: record.privacy.redaction },
    lifecycle: record.lifecycle
  };
}
