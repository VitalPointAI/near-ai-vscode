import type { AgentCapability, AgentLocality, AgentRole } from './agents';

export const TEAM_STUDIO_VERSION = 1 as const;

export type TeamSkillId = AgentCapability;
export type TeamToolCapability = 'read' | 'plan' | 'workspaceWrite' | 'shell' | 'network' | 'gitMutation' | 'mediaGeneration' | 'mediaPublication';
export type TeamPersonality = 'professional' | 'warm' | 'direct' | 'playful';
export type TeamTone = 'quiet' | 'concise' | 'verbose';
export type TeamStyle = 'structured' | 'conversational' | 'checklist';
export type TeamAutonomy = 'supervised' | 'bounded' | 'autonomous';
export type TeamApprovalMode = 'none' | 'risky' | 'every-action';
export type TeamPrivacyBoundary = 'local' | 'cloud' | 'hybrid';

export interface MemberProviderRoute {
  provider: string;
  model?: string;
  locality: AgentLocality;
  privacyBoundary: TeamPrivacyBoundary;
}

export interface MemberPersonality {
  personality: TeamPersonality;
  tone: TeamTone;
  style: TeamStyle;
  displayGuidance?: string;
}

export interface MemberApprovalContract {
  mode: TeamApprovalMode;
  capabilities: TeamToolCapability[];
}

export interface MemberBudgetContract {
  requestUsd: number;
  sessionUsd: number;
  projectUsd: number;
  maxDurationMs: number;
}

/**
 * A member is an operational contract, never a prompt, credential, or tool
 * implementation. All fields are intentionally bounded and allowlisted.
 */
export interface MemberCapabilityContract {
  memberId: string;
  profileId?: string;
  role: AgentRole;
  responsibilities: string[];
  skillIds: TeamSkillId[];
  /** Alias used by routing integrations; normalized to the same allowlist. */
  capabilities: TeamSkillId[];
  tools: TeamToolCapability[];
  providerRoute: MemberProviderRoute;
  personality: MemberPersonality;
  autonomy: TeamAutonomy;
  approval: MemberApprovalContract;
  budget: MemberBudgetContract;
}

export interface TeamVersion {
  version: typeof TEAM_STUDIO_VERSION;
  teamVersion: number;
  versionId: string;
  createdAt: string;
  note?: string;
  members: MemberCapabilityContract[];
  sourceVersionId?: string;
  importedAt?: string;
}

export interface ReusableAgentTeam {
  version: typeof TEAM_STUDIO_VERSION;
  teamId: string;
  displayName: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  currentVersion: number;
  archivedAt?: string;
  deletedAt?: string;
  duplicatedFromTeamId?: string;
  versions: TeamVersion[];
}

export interface CreateTeamInput {
  displayName: string;
  description?: string;
  members: MemberCapabilityContract[];
  note?: string;
}

export interface UpdateTeamInput {
  displayName?: string;
  description?: string;
  members?: MemberCapabilityContract[];
  note?: string;
}

export interface TeamBinding {
  version: typeof TEAM_STUDIO_VERSION;
  bindingId: string;
  projectId: string;
  teamId: string;
  teamVersion: number;
  versionId: string;
  teamDisplayName: string;
  boundAt: string;
  privacyBoundary: TeamPrivacyBoundary;
  members: MemberCapabilityContract[];
  /** Host-created integrity marker for the immutable bound snapshot. */
  bindingFingerprint: string;
  source: 'global-team-library';
}

export interface TeamPreviewMember {
  memberId: string;
  role: AgentRole;
  responsibilities: string[];
  skills: TeamSkillId[];
  tools: TeamToolCapability[];
  route: Pick<MemberProviderRoute, 'provider' | 'model' | 'locality' | 'privacyBoundary'>;
  personality: Pick<MemberPersonality, 'personality' | 'tone' | 'style'>;
  autonomy: TeamAutonomy;
  approval: TeamApprovalMode;
  budget: Pick<MemberBudgetContract, 'requestUsd' | 'sessionUsd' | 'projectUsd'>;
}

export interface TeamPreview {
  teamId: string;
  version: number;
  versionId: string;
  displayName: string;
  members: TeamPreviewMember[];
  privacyBoundary: TeamPrivacyBoundary;
  coordinationTradeoff: string;
  estimatedRequestUsd: number;
  estimatedProjectUsd: number;
  bindingRequired: true;
  unavailable?: string;
}

export interface TeamStudioExport {
  packageVersion: typeof TEAM_STUDIO_VERSION;
  exportedAt: string;
  team: Pick<ReusableAgentTeam, 'teamId' | 'displayName' | 'description' | 'createdAt' | 'updatedAt' | 'currentVersion' | 'versions' | 'duplicatedFromTeamId'>;
  provenance: { source: 'near-ai-team-studio'; importedFrom?: string };
}

export function isTeamRole(value: unknown): value is AgentRole {
  return ['planner', 'implementer', 'reviewer', 'security', 'tester', 'researcher'].includes(String(value));
}

export function cloneTeam<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
