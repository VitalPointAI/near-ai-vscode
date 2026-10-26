import type { ActionCapability, ActionDecision } from './policy';

export type DataClass =
  | 'secret'
  | 'privateFile'
  | 'personalData'
  | 'sensitivePath'
  | 'scopeExpansion'
  | 'unknown'
  | 'public';

export type ProviderBoundary = 'local' | 'cloud' | 'tee' | 'unknown';
export type SovereigntyMode = 'standard' | 'local-only';
export type PrivacyRuleMode = 'block' | 'warn-and-confirm' | 'allow' | 'local-only';

export interface PrivacyRule {
  dataClass?: DataClass;
  pathPattern?: string;
  mode: PrivacyRuleMode;
}

export interface PreflightFinding {
  dataClass: DataClass;
  count: number;
  paths: string[];
  reason: string;
}

export interface RedactedPreview {
  provider: string;
  providerBoundary: ProviderBoundary;
  teeStatus?: 'verified' | 'unverified' | 'not-applicable' | 'unknown';
  paths: string[];
  context: string;
  findings: PreflightFinding[];
}

export type PrivacyOutcome = 'allow' | 'warn-and-confirm' | 'block';

export interface PrivacyDecision {
  outcome: PrivacyOutcome;
  reason: string;
  provider: string;
  providerBoundary: ProviderBoundary;
  sovereigntyMode: SovereigntyMode;
  classifications: DataClass[];
  dispatchToken?: string;
  overrideUsed?: boolean;
}

export interface PrivacyAuditRecord {
  id: string;
  timestamp: string;
  provider: string;
  providerBoundary: ProviderBoundary;
  sovereigntyMode: SovereigntyMode;
  capabilities: ActionCapability[];
  paths: string[];
  classifications: DataClass[];
  outcome: PrivacyOutcome;
  reason: string;
  overrideUsed: boolean;
  preview: RedactedPreview;
}

export interface ProviderRequest {
  provider: string;
  providerBoundary: ProviderBoundary;
  capability?: ActionCapability;
  workspaceRoot?: string;
  paths?: string[];
  context?: string;
  scope?: string;
  teeStatus?: RedactedPreview['teeStatus'];
  /** Opaque host-owned attachment IDs; never attachment bytes or provider payloads. */
  attachmentIds?: string[];
  rawContentAuthorized?: boolean;
  approvalFingerprint?: string;
}

export interface PrivacyOverride {
  token: string;
  provider: string;
  providerBoundary: ProviderBoundary;
  paths: string[];
  classifications: DataClass[];
  requestFingerprint: string;
  expiresAt: number;
}

export interface PrivacyPreflightResult {
  preview: RedactedPreview;
  decision: PrivacyDecision;
  audit: PrivacyAuditRecord;
}

