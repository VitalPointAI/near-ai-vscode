export const AGENT_PROFILE_VERSION = 1 as const;
export const AGENT_TEAM_VERSION = 1 as const;

export type AgentLifecycle = 'ready' | 'paused' | 'retired';
export type AgentLocality = 'cloud' | 'local' | 'hybrid';
export type AgentRole = 'planner' | 'implementer' | 'reviewer' | 'security' | 'tester' | 'researcher';
export type AgentCapability = 'read' | 'plan' | 'write' | 'test' | 'review' | 'security' | 'network';

export interface AgentIdentity {
  profileId: string;
  memorableName: string;
  role: AgentRole;
  humorEnabled: boolean;
}

export interface AgentRoutingParameters {
  preferredProvider: string;
  locality: AgentLocality;
  preferredModel?: string;
  priority: number;
}

export interface AgentReputationReference {
  evidenceCount: number;
  reliability: number;
  updatedAt: string;
}

export interface AgentProfile {
  version: typeof AGENT_PROFILE_VERSION;
  identity: AgentIdentity;
  capabilities: AgentCapability[];
  routing: AgentRoutingParameters;
  lifecycle: AgentLifecycle;
  reputation: AgentReputationReference;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileExport {
  version: typeof AGENT_PROFILE_VERSION;
  exportedAt: string;
  profiles: AgentProfile[];
}

export interface AgentOperationalFacts {
  role: string;
  task: string;
  model: string;
  route: string;
  status: string;
  costUsd?: number;
  error?: string;
}

export interface AgentIdentityPresentation extends AgentOperationalFacts {
  name: string;
  copy: string;
}

export interface AgentDiscoveryAnswers {
  goal: string;
  riskLevel: 'low' | 'medium' | 'high';
  preferredProvider: string;
  locality: AgentLocality;
  workShape: 'feature' | 'bugfix' | 'refactor' | 'research' | 'release';
}

export interface AgentDiscoveryQuestion {
  id: keyof AgentDiscoveryAnswers;
  prompt: string;
  choices?: string[];
}

export interface AgentTeamRole {
  role: AgentRole;
  profileId: string;
  responsibility: string;
  coordination: string;
  modelTradeoff: string;
  privacyBoundary: string;
}

export interface AgentTeamRecommendation {
  version: typeof AGENT_TEAM_VERSION;
  recommendationId: string;
  rationale: string;
  roles: AgentTeamRole[];
  estimatedCost: 'low' | 'medium' | 'high';
  coordinationTradeoff: string;
}

export interface AcceptedAgentTeam extends AgentTeamRecommendation {
  accepted: true;
  acceptedAt: string;
  revision: number;
}

export interface ProjectTeamArtifact {
  version: typeof AGENT_TEAM_VERSION;
  accepted: AcceptedAgentTeam | undefined;
  history: AcceptedAgentTeam[];
  reusableBinding?: import('./teamStudio').TeamBinding;
}
