import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ModelInfo, NearAiError } from './nearAiClient';
import { redactSecrets } from '../domain/redaction';
import { GSD_COMMANDS } from '../domain/gsdCommands';
import { ActivitySessionSummary, AttributionSnapshot } from '../domain/activity';
import { normalizePrompt, PromptResponse, StructuredPrompt, isPromptId, isSessionId, progressCardFromEvent, ProgressCard, safeProgressText } from '../domain/chatProgress';
import { parseGsdPlanningState } from '../domain/gsdStatus';
import type { AnalyticsFilter, AnalyticsResult } from '../domain/analytics';
import { AuthMode, isSecureEndpoint } from '../domain/config';
import { isProfileId, OrganizationProfile } from '../domain/auth';
import type { EntitlementStatusView, StakeHistoryEntry, StakingOperation, TransactionPreviewView } from '../domain/staking';
import type { AgentCapability, AgentRole } from '../domain/agents';
import type { ActionCapability } from '../domain/policy';
import type { MemberCapabilityContract, ReusableAgentTeam, TeamBinding, TeamPreview } from '../domain/teamStudio';
import type { CapabilityRequirement } from '../domain/capabilities';
import type { AttachmentPreview, MultimodalApprovalPreview, MultimodalOperation, MultimodalOperationRecord } from '../domain/multimodal';
import type { GenerationOperationRecord, GenerationPreview, PublicationPreview } from '../domain/generation';
import type { ContextGraphEdgeDto, ContextGraphPreviewDto, ContextGraphNodeDto, MemoryApprovalOperation, MemoryApprovalPreviewDto, MemoryScope, MemorySlice } from '../domain/contextGraph';
import { CapabilityRouter } from './capabilityRouter';
import { validateMemberContract } from './teamStudio';

export type ChatWebviewMessage =
  | { type: 'load-models' }
  | { type: 'open-setup' }
  | { type: 'refresh-status' }
  | { type: 'open-command'; command: string; args?: string; model?: string }
  | { type: 'questions-reply'; id: string; answers: string[] }
  | { type: 'agent-control'; agentId: string; action: 'pause' | 'resume' | 'stop' }
  | { type: 'resume-conversation'; id: string }
  | { type: 'open-artifact'; path: string; kind: GsdArtifactKind }
  | { type: 'send'; text: string; model?: string; overrideToken?: string; attachmentIds?: string[] }
  | { type: 'attach-files' }
  | { type: 'attachment-remove'; id: string }
  | { type: 'stop' }
  | { type: 'history' }
  | { type: 'new-chat' }
  | { type: 'open-tools' }
  | { type: 'open-activity'; agentId?: string }
  | { type: 'select-profile' }
  | { type: 'approval-reply'; callId: string; decision: 'allow' | 'allow-run' | 'deny'; feedback?: string }
  | { type: 'revert-run'; runId: string }
  | { type: 'verify-response'; runId: string }
  | { type: 'insert-code'; text: string }
  | { type: 'reopen-session'; sessionId: string }
  | { type: 'continue-session'; sessionId: string }
  | { type: 'prompt-choice'; sessionId: string; promptId: string; choiceId: string }
  | { type: 'prompt-answer'; sessionId: string; promptId: string; text: string }
  | { type: 'prompt-cancel'; sessionId: string; promptId: string }
  | { type: 'prompt-resume'; sessionId: string; promptId: string }
  | ProfileWebviewMessage
  | AnalyticsWebviewMessage
  | WalletWebviewMessage
  | TeamWebviewMessage
  | MultimodalWebviewMessage
  | GenerationWebviewMessage
  | ContextGraphWebviewMessage;

export type ContextGraphWebviewMessage =
  | { type: 'memory-inspect'; scope: MemoryScope; localOnly?: boolean }
  | { type: 'memory-search'; scope: MemoryScope; query: string; nodeType?: 'fact' | 'actor' | 'function' | 'capability' | 'artifact' | 'task' }
  | { type: 'memory-slice-preview'; task: string; agentId?: string; teamId?: string; projectId?: string; sharedId?: string; scopes: MemoryScope[]; localOnly?: boolean }
  | { type: 'memory-preview'; operation: MemoryApprovalOperation; scope: MemoryScope; expectedGraphVersion: number; nodeId?: string; targetNodeId?: string; sourceNodeIds?: string[]; summary?: string; localOnly?: boolean }
  | { type: 'memory-approve'; approvalFingerprint: string; explicit: true }
  | { type: 'memory-correct'; scope: MemoryScope; nodeId: string; expectedGraphVersion: number; summary: string; explicit: true; approvalFingerprint: string }
  | { type: 'memory-merge'; scope: MemoryScope; targetNodeId: string; sourceNodeIds: string[]; expectedGraphVersion: number; explicit: true; approvalFingerprint: string }
  | { type: 'memory-retract'; scope: MemoryScope; nodeId: string; expectedGraphVersion: number; explicit: true; approvalFingerprint: string }
  | { type: 'memory-reset'; scope: MemoryScope; expectedGraphVersion: number; explicit: true; approvalFingerprint: string }
  | { type: 'memory-export'; scope: MemoryScope; expectedGraphVersion: number; explicit: true; approvalFingerprint: string };

export type MultimodalWebviewMessage =
  | { type: 'attachment-select' }
  | { type: 'attachment-cancel'; artifactId: string }
  | { type: 'multimodal-prepare'; operation: MultimodalOperation; sourceArtifactIds: string[] }
  | { type: 'multimodal-approve'; operationId: string; approvalFingerprint: string; explicit: true }
  | { type: 'multimodal-status'; operationId: string }
  | { type: 'multimodal-cancel'; operationId: string }
  | { type: 'multimodal-recover'; operationId: string };

export type GenerationWebviewMessage =
  | { type: 'generation-preview'; operation: 'image-generation' | 'image-edit' | 'video-generation'; model: string; prompt: string; sourceArtifactIds?: string[] }
  | { type: 'generation-start'; operationId: string; approvalFingerprint: string; explicit: true }
  | { type: 'generation-status'; operationId: string }
  | { type: 'generation-cancel'; operationId: string }
  | { type: 'generation-publication-preview'; operationId: string; destination: string }
  | { type: 'generation-publish'; operationId: string; publicationFingerprint: string; explicit: true };

export type ChatMultimodalMessage =
  | { type: 'attachment-staged'; preview: AttachmentPreview }
  | { type: 'attachment-cancelled'; preview: AttachmentPreview }
  | { type: 'attachment-error'; code: string; text: string }
  | { type: 'multimodal-approval-required'; preview: MultimodalApprovalPreview }
  | { type: 'multimodal-status'; operation: MultimodalStatusView }
  | { type: 'multimodal-error'; code: string; text: string };

export interface MultimodalStatusView {
  operationId: string;
  operation: MultimodalOperationRecord['operation'];
  status: MultimodalOperationRecord['status'];
  sourceArtifactIds: string[];
  derivedArtifactIds: string[];
  reason?: MultimodalOperationRecord['reason'];
  route: Pick<MultimodalOperationRecord['route'], 'provider' | 'model' | 'providerBoundary' | 'privacyBoundary' | 'capabilitySnapshotId' | 'freshness' | 'supportedOperations' | 'cancellationSupported'>;
  approval?: MultimodalApprovalPreview;
  approvalFingerprint?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  attribution?: AttributionSnapshot;
}

export function multimodalStatusMessage(operation: MultimodalOperationRecord): ChatMultimodalMessage {
  return {
    type: 'multimodal-status',
    operation: cloneWallet({
      operationId: operation.operationId,
      operation: operation.operation,
      status: operation.status,
      sourceArtifactIds: [...operation.sourceArtifactIds],
      derivedArtifactIds: [...operation.derivedArtifactIds],
      reason: operation.reason,
      route: {
        provider: operation.route.provider,
        model: operation.route.model,
        providerBoundary: operation.route.providerBoundary,
        privacyBoundary: operation.route.privacyBoundary,
        capabilitySnapshotId: operation.route.capabilitySnapshotId,
        freshness: operation.route.freshness,
        supportedOperations: [...operation.route.supportedOperations],
        cancellationSupported: operation.route.cancellationSupported
      },
      approval: operation.approval,
      approvalFingerprint: operation.approvalFingerprint,
      estimatedCostUsd: operation.estimatedCostUsd,
      actualCostUsd: operation.actualCostUsd,
      attribution: operation.attribution
    })
  };
}

export type ChatGenerationMessage =
  | { type: 'generation-preview'; preview: GenerationPreview }
  | { type: 'generation-status'; operation: Pick<GenerationOperationRecord, 'operationId' | 'skill' | 'operation' | 'status' | 'provider' | 'model' | 'estimatedCost' | 'usage' | 'artifactId' | 'publication' | 'reason'> }
  | { type: 'generation-publication-preview'; preview: PublicationPreview }
  | { type: 'generation-error'; code: string; text: string };

export type ChatContextGraphMessage =
  | { type: 'memory-inspect'; preview: ContextGraphPreviewDto }
  | { type: 'memory-search'; scope: MemoryScope; nodes: ContextGraphNodeDto[] }
  | { type: 'memory-slice-preview'; slice: Pick<MemorySlice, 'sliceId' | 'taskId' | 'scopes' | 'graphVersions' | 'nodeIds' | 'edgeIds' | 'factIds' | 'privacy' | 'suppliedAt'> }
  | { type: 'memory-approval-preview'; preview: MemoryApprovalPreviewDto }
  | { type: 'memory-updated'; scope: MemoryScope; graphVersion: number; nodeId?: string }
  | { type: 'memory-export'; scope: MemoryScope; data: string }
  | { type: 'memory-error'; code: string; text: string };

export function memoryInspectMessage(preview: ContextGraphPreviewDto): ChatContextGraphMessage { return { type: 'memory-inspect', preview: sanitizeMemoryPreview(preview) }; }
export function memorySliceMessage(slice: MemorySlice): ChatContextGraphMessage { return { type: 'memory-slice-preview', slice: cloneWallet({ sliceId: slice.sliceId, taskId: slice.taskId, scopes: slice.scopes, graphVersions: slice.graphVersions, nodeIds: slice.nodeIds, edgeIds: slice.edgeIds, factIds: slice.factIds, privacy: slice.privacy, suppliedAt: slice.suppliedAt }) }; }
export function memoryApprovalPreviewMessage(preview: MemoryApprovalPreviewDto): ChatContextGraphMessage { return { type: 'memory-approval-preview', preview: cloneWallet(preview) }; }

function safeGraphText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/(?:api[_ -]?key|refresh[-_ ]?token|bearer|secret|password|private\s+prompt|raw\s+(?:context|media)|authorization\s*[:=]|data:[^\s,;]+)/gi, '[REDACTED]').trim();
  return cleaned.slice(0, 240) || fallback;
}

function safeGraphScope(scope: MemoryScope): MemoryScope { return { kind: scope.kind, id: safeGraphText(scope.id, 'bounded-scope') }; }
export function sanitizeContextGraphNode(node: ContextGraphNodeDto): ContextGraphNodeDto {
  return { nodeId: node.nodeId, type: node.type, label: safeGraphText(node.label, 'Memory node'), summary: safeGraphText(node.summary, 'Bounded memory metadata'), scope: safeGraphScope(node.scope), confidence: Math.max(0, Math.min(1, node.confidence)), freshness: { observedAt: node.freshness.observedAt, updatedAt: node.freshness.updatedAt, decayed: Boolean(node.freshness.decayed), ...(node.freshness.expiresAt ? { expiresAt: node.freshness.expiresAt } : {}) }, provenance: { kind: node.provenance.kind, sourceId: safeGraphText(node.provenance.sourceId, 'bounded-source'), evidenceClass: node.provenance.evidenceClass, ...(node.provenance.actorId ? { actorId: safeGraphText(node.provenance.actorId, 'bounded-actor') } : {}) }, state: node.state, conflict: { status: node.conflict.status, conflictIds: node.conflict.conflictIds.slice(0, 8).map((id) => safeGraphText(id, 'bounded-conflict')) }, version: node.version };
}
function safeGraphEdge(edge: ContextGraphEdgeDto): ContextGraphEdgeDto {
  return { edgeId: edge.edgeId, type: edge.type, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId, polarity: edge.polarity, weight: Math.max(-1, Math.min(1, edge.weight)), explanation: safeGraphText(edge.explanation, 'Bounded relationship metadata'), scope: safeGraphScope(edge.scope), state: edge.state, conflict: { status: edge.conflict.status, conflictIds: edge.conflict.conflictIds.slice(0, 8).map((id) => safeGraphText(id, 'bounded-conflict')) }, version: edge.version };
}
function sanitizeMemoryPreview(preview: ContextGraphPreviewDto): ContextGraphPreviewDto { return { version: 1, scope: safeGraphScope(preview.scope), graphVersion: preview.graphVersion, nodes: preview.nodes.slice(0, 48).map(sanitizeContextGraphNode), edges: preview.edges.slice(0, 96).map(safeGraphEdge), counts: { nodes: Math.min(preview.counts.nodes, 48), edges: Math.min(preview.counts.edges, 96), facts: preview.counts.facts, conflicts: preview.counts.conflicts, retracted: preview.counts.retracted }, accessibleOutline: preview.accessibleOutline.slice(0, 96).map((line) => safeGraphText(line, 'Bounded graph detail')), localOnly: preview.localOnly }; }

export function generationPreviewMessage(preview: GenerationPreview): ChatGenerationMessage { return { type: 'generation-preview', preview: cloneWallet(preview) }; }
export function generationStatusMessage(operation: GenerationOperationRecord): ChatGenerationMessage { return { type: 'generation-status', operation: cloneWallet({ operationId: operation.operationId, skill: operation.skill, operation: operation.operation, status: operation.status, provider: operation.provider, model: operation.model, estimatedCost: operation.estimatedCost, usage: operation.usage, artifactId: operation.artifactId, publication: operation.publication, reason: operation.reason }) }; }
export function generationPublicationMessage(preview: PublicationPreview): ChatGenerationMessage { return { type: 'generation-publication-preview', preview: cloneWallet(preview) }; }

export type TeamWebviewMessage =
  | { type: 'team-list' }
  | { type: 'team-create'; displayName: string; description?: string; members: MemberCapabilityContract[]; note?: string }
  | { type: 'team-update'; teamId: string; displayName?: string; description?: string; members?: MemberCapabilityContract[]; note?: string }
  | { type: 'team-duplicate'; teamId: string; displayName?: string }
  | { type: 'team-archive'; teamId: string }
  | { type: 'team-restore'; teamId: string }
  | { type: 'team-delete'; teamId: string }
  | { type: 'team-preview'; teamId: string; version?: number }
  | { type: 'team-select-version'; teamId: string; version: number }
  | { type: 'team-bind'; teamId: string; version?: number }
  | { type: 'team-invoke'; teamId: string; version: number; role: AgentRole; task: string; requiredCapabilities: AgentCapability[]; actionCapability?: ActionCapability }
  | { type: 'team-status' }
  | { type: 'team-export'; teamId: string }
  | { type: 'team-import'; packageJson: string };

export interface TeamStatusView {
  teams: Array<Pick<ReusableAgentTeam, 'teamId' | 'displayName' | 'description' | 'currentVersion' | 'archivedAt'>>;
  binding?: Pick<TeamBinding, 'bindingId' | 'teamId' | 'teamVersion' | 'versionId' | 'teamDisplayName' | 'privacyBoundary' | 'boundAt'>;
}

export interface TeamCapabilityRouteView {
  memberId: string;
  role: string;
  skills: string[];
  provider: string;
  model?: string;
  locality: string;
  privacyBoundary: string;
  status: 'compatible' | 'unavailable' | 'refresh-required';
  readiness: string;
  freshness: string;
  pricing: 'available' | 'unavailable';
  verificationStatus: string;
  snapshotId?: string;
  reasons: string[];
}

export interface CapabilityAwareTeamPreview extends TeamPreview {
  capabilityRoutes: TeamCapabilityRouteView[];
}

export type ChatTeamMessage =
  | { type: 'team-list'; teams: TeamStatusView['teams'] }
  | { type: 'team-preview'; preview: CapabilityAwareTeamPreview }
  | { type: 'team-status'; value: TeamStatusView }
  | { type: 'team-lifecycle'; operation: 'created' | 'updated' | 'duplicated' | 'archived' | 'restored' | 'deleted' | 'imported'; team?: TeamStatusView['teams'][number]; teamId?: string; message: string }
  | { type: 'team-export'; teamId: string; packageJson: string }
  | { type: 'team-invocation-status'; value: TeamInvocationStatus }
  | { type: 'team-error'; text: string };

export interface TeamInvocationStatus {
  invocationId: string;
  teamId: string;
  versionId: string;
  role: AgentRole;
  status: 'binding' | 'dispatching' | 'running' | 'failed';
  stage: 'binding' | 'dispatching' | 'running' | 'failed';
  provider?: string;
  model?: string;
  locality?: string;
  privacyBoundary?: string;
  estimatedCostUsd?: number;
  startedAt?: string;
  updatedAt?: string;
  reason?: string;
}

export type WalletWebviewMessage =
  | { type: 'wallet-connect' }
  | { type: 'wallet-disconnect' }
  | { type: 'entitlement-refresh' }
  | { type: 'stake-preview'; operation: StakingOperation; amountYocto: string }
  | { type: 'stake-confirm'; previewId: string; fingerprint: string; explicit: true }
  | { type: 'stake-cancel'; previewId: string }
  | { type: 'transaction-status'; transactionId: string }
  | { type: 'staking-history' };

export type ChatWalletMessage =
  | { type: 'wallet-status'; status: EntitlementStatusView; message: string }
  | { type: 'wallet-preview'; preview: TransactionPreviewView }
  | { type: 'wallet-history'; entries: StakeHistoryEntry[] }
  | { type: 'wallet-error'; text: string };

export type ProfileWebviewMessage =
  | { type: 'profile-list' }
  | { type: 'profile-create'; profileId: string; displayName: string; organization: string; baseUrl: string; authMode: AuthMode }
  | { type: 'profile-update'; profileId: string; displayName?: string; organization?: string; baseUrl?: string; authMode?: AuthMode }
  | { type: 'profile-select'; profileId: string }
  | { type: 'profile-validate'; profileId: string }
  | { type: 'profile-import-legacy'; profileId: string; confirm: boolean };

export interface ProfileStatusView {
  projectScope: string;
  activeProfileId?: string;
  profiles: Array<Pick<OrganizationProfile, 'profileId' | 'displayName' | 'organization' | 'provider' | 'baseUrl' | 'authMode' | 'validation'>>;
  configured: boolean;
}
  
export type AnalyticsWebviewMessage =
  | { type: 'load-analytics'; filter: AnalyticsFilter }
  | { type: 'export-analytics'; filter: AnalyticsFilter }
  | { type: 'set-quiet-mode'; quiet: boolean }
  | { type: 'agent-drill-down'; agentId: string };

export type ChatAnalyticsMessage = { type: 'analytics'; result: AnalyticsResult };

export function walletStatusMessage(status: EntitlementStatusView): ChatWalletMessage {
  return { type: 'wallet-status', status: cloneWallet(status), message: walletStatusCopy(status) };
}

export function walletStatusCopy(status: Pick<EntitlementStatusView, 'freshness' | 'message' | 'writesEnabled'>): string {
  if (status.freshness === 'unavailable') return 'Wallet entitlement unavailable. Verified staking configuration is not available; stake-changing actions are disabled.';
  if (status.freshness === 'stale') return 'Wallet entitlement status is stale. Refresh before taking any stake-changing action.';
  return status.writesEnabled ? 'Verified read-only wallet entitlement status is current.' : 'Wallet writes are disabled until fresh verification is available.';
}

export function walletPreviewMessage(preview: TransactionPreviewView): ChatWalletMessage {
  return { type: 'wallet-preview', preview: cloneWallet(preview) };
}

export function walletHistoryMessage(entries: StakeHistoryEntry[]): ChatWalletMessage {
  return { type: 'wallet-history', entries: entries.slice(-100).map((entry) => ({ ...entry })) };
}

export function walletErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'The wallet operation could not be completed.';
  return raw.replace(/(?:api[_ -]?key|refresh[-_ ]?token|bearer|seed phrase|private key|password)\s*[:=]?\s*[^\s,;]*/gi, '[REDACTED]').replace(/[\u0000-\u001f]+/g, ' ').slice(0, 240);
}

export function profileStatusMessage(profiles: OrganizationProfile[], projectScope: string, activeProfileId: string | undefined, configured: boolean): ProfileStatusView {
  return {
    projectScope,
    activeProfileId,
    configured,
    profiles: profiles.map((profile) => ({
      profileId: profile.profileId,
      displayName: profile.displayName,
      organization: profile.organization,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      authMode: profile.authMode,
      validation: { ...profile.validation }
    }))
  };
}

export function teamListMessage(teams: ReusableAgentTeam[]): Extract<ChatTeamMessage, { type: 'team-list' }> { return { type: 'team-list', teams: teams.map((team) => ({ teamId: team.teamId, displayName: team.displayName, description: team.description, currentVersion: team.currentVersion, archivedAt: team.archivedAt })) }; }
export function teamLifecycleMessage(operation: Extract<ChatTeamMessage, { type: 'team-lifecycle' }>['operation'], team?: ReusableAgentTeam, message = `Team ${operation}.`): ChatTeamMessage { return { type: 'team-lifecycle', operation, team: team ? { teamId: team.teamId, displayName: team.displayName, description: team.description, currentVersion: team.currentVersion, archivedAt: team.archivedAt } : undefined, teamId: team?.teamId, message }; }
export function teamPreviewMessage(preview: TeamPreview, capabilityRoutes: TeamCapabilityRouteView[] = unavailableTeamRoutes(preview)): ChatTeamMessage { return { type: 'team-preview', preview: cloneWallet({ ...preview, capabilityRoutes }) }; }
export async function capabilityAwareTeamPreview(preview: TeamPreview, router?: CapabilityRouter, requirements: Record<string, CapabilityRequirement> = {}): Promise<CapabilityAwareTeamPreview> {
  const capabilityRoutes = await Promise.all(preview.members.map(async (member): Promise<TeamCapabilityRouteView> => {
    const requirement = requirements[member.memberId];
    const snapshot = router ? await router.describe(member.route.provider, member.route.model) : undefined;
    if (!snapshot) return { memberId: member.memberId, role: member.role, skills: [...member.skills], provider: member.route.provider, model: member.route.model, locality: member.route.locality, privacyBoundary: member.route.privacyBoundary, status: 'refresh-required', readiness: 'unknown', freshness: 'unknown', pricing: 'unavailable', verificationStatus: 'unknown', reasons: ['unknown-model'] };
    const evaluation = requirement ? await router?.evaluate({ provider: member.route.provider, model: member.route.model, locality: member.route.locality, privacyBoundary: member.route.privacyBoundary }, requirement) : undefined;
    const reasons = evaluation?.reasons ?? snapshot.unavailableReasons;
    const routeHasKnownPrivacy = snapshot.privacyBoundary !== 'unknown' && snapshot.verificationStatus !== 'unknown';
    const routeHasPricing = Object.values(snapshot.pricing).some((value) => value !== undefined);
    return { memberId: member.memberId, role: member.role, skills: [...member.skills], provider: member.route.provider, model: member.route.model, locality: member.route.locality, privacyBoundary: member.route.privacyBoundary, status: evaluation?.compatible || (!evaluation && snapshot.availability === 'compatible' && routeHasKnownPrivacy && routeHasPricing) ? 'compatible' : snapshot.freshness === 'unknown' ? 'refresh-required' : 'unavailable', readiness: snapshot.readiness, freshness: snapshot.freshness, pricing: routeHasPricing ? 'available' : 'unavailable', verificationStatus: snapshot.verificationStatus, snapshotId: snapshot.snapshotId, reasons };
  }));
  return cloneWallet({ ...preview, capabilityRoutes });
}
export function teamStatusMessage(teams: ReusableAgentTeam[], binding?: TeamBinding): ChatTeamMessage { return { type: 'team-status', value: { teams: teamListMessage(teams).teams, binding: binding ? { bindingId: binding.bindingId, teamId: binding.teamId, teamVersion: binding.teamVersion, versionId: binding.versionId, teamDisplayName: binding.teamDisplayName, privacyBoundary: binding.privacyBoundary, boundAt: binding.boundAt } : undefined } } as ChatTeamMessage; }
export function teamInvocationStatusMessage(value: TeamInvocationStatus): ChatTeamMessage { return { type: 'team-invocation-status', value: { ...value } }; }
  
export type ChatPromptMessage = PromptResponse;

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatModelOption {
  id: string;
  label: string;
  /** "tee" when NEAR runs the model in an attested TEE; "forwarded" when NEAR sends it to another provider. */
  privacy: 'tee' | 'local' | 'forwarded' | 'unknown';
  forwardedTo?: string;
}

/** Short, user-facing privacy wording for a model, shared by every chat surface. */
export function modelPrivacyLabel(model?: Pick<ModelInfo, 'privacyBoundary' | 'forwardedTo'>): string {
  if (model?.privacyBoundary === 'tee') return 'Private · runs in NEAR TEE';
  if (model?.privacyBoundary === 'local') return 'Local · runs on this machine';
  if (model?.privacyBoundary === 'cloud') return model.forwardedTo ? `Not private · forwarded to ${model.forwardedTo}` : 'Not private · forwarded';
  return 'Privacy unknown';
}

export interface GsdArtifactLink {
  label: string;
  path: string;
  kind: GsdArtifactKind;
}

export type GsdArtifactKind = 'file' | 'directory';

export interface ChatSessionSummary {
  sessionId: string;
  project: string;
  attribution?: AttributionSnapshot;
  phase?: string;
  plans: string[];
  agents: ActivitySessionSummary['agents'];
  models: string[];
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  approvals: ActivitySessionSummary['approvals'];
  startedAt: string;
  updatedAt: string;
  outcome: ActivitySessionSummary['outcome'];
  continuationAvailable: boolean;
  context: ActivitySessionSummary['context'];
}

export function sessionSummaryMessage(session: ActivitySessionSummary): ChatSessionSummary {
  return {
    sessionId: session.sessionId,
    project: session.project,
    attribution: session.attribution ? { ...session.attribution } : undefined,
    phase: session.phase,
    plans: [...session.plans],
    agents: { ...session.agents },
    models: [...session.models],
    estimatedCostUsd: session.estimatedCostUsd,
    actualCostUsd: session.actualCostUsd,
    approvals: { ...session.approvals },
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    outcome: session.outcome,
    continuationAvailable: session.continuationAvailable,
    context: { ...session.context }
  };
}

const artifactNames = /^(STATE|ROADMAP|.*-(?:PLAN|SUMMARY|VERIFICATION))\.md$/;

export function isSafeArtifactPath(root: string, relativePath: string): boolean {
  const planningRoot = path.resolve(root, '.planning');
  const candidate = path.resolve(root, relativePath);
  return (candidate === planningRoot || candidate.startsWith(`${planningRoot}${path.sep}`)) && !relativePath.split(/[\\/]/).includes('..');
}

export async function discoverGsdArtifacts(root: string): Promise<GsdArtifactLink[]> {
  const planningRoot = path.join(root, '.planning');
  const found: GsdArtifactLink[] = [];
  let planningState = '';
  try { planningState = await fs.readFile(path.join(planningRoot, 'STATE.md'), 'utf8'); } catch { return []; }
  const currentPhase = parseGsdPlanningState(planningState).currentPhase;
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && artifactNames.test(entry.name)) {
        const artifactPath = path.relative(root, absolute).split(path.sep).join('/');
        found.push({ label: artifactPath, path: artifactPath, kind: 'file' });
      }
    }
  };
  await visit(planningRoot);
  if (currentPhase !== null) {
    try {
      const phaseEntries = await fs.readdir(path.join(planningRoot, 'phases'), { withFileTypes: true });
      const matches = phaseEntries.filter((entry) => entry.isDirectory() && /^\d+-/.test(entry.name) && Number(entry.name.split('-', 1)[0]) === currentPhase);
      if (matches.length === 1) {
        const artifactPath = path.relative(root, path.join(planningRoot, 'phases', matches[0].name)).split(path.sep).join('/');
        found.push({ label: `${artifactPath}/`, path: artifactPath, kind: 'directory' });
      }
    } catch { /* Missing or inaccessible phase state is a safe empty result. */ }
  }
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

export interface GsdCommandProgressMessage {
  type: 'command-progress';
  state: 'started' | 'running' | 'output' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  command: string;
  text?: string;
  exitCode?: number | null;
  phase?: string;
  action?: string;
  tool?: string;
  model?: string;
  agent?: string;
  agentCount?: number;
  attempt?: number;
  retry?: boolean;
  approvalRequired?: boolean;
}

export function promptMessage(prompt: unknown): StructuredPrompt | undefined { return normalizePrompt(prompt); }

export function progressCardMessage(event: Parameters<typeof progressCardFromEvent>[0], index = 0): ProgressCard {
  return progressCardFromEvent(event, index);
}

export function promptResponseMessage(value: unknown): ChatPromptMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const message = value as Record<string, unknown>;
  if (!['prompt-choice', 'prompt-answer', 'prompt-cancel', 'prompt-resume'].includes(String(message.type)) || !isSessionId(message.sessionId) || !isPromptId(message.promptId)) return undefined;
  const allowed = message.type === 'prompt-choice' ? ['type', 'sessionId', 'promptId', 'choiceId'] : message.type === 'prompt-answer' ? ['type', 'sessionId', 'promptId', 'text'] : ['type', 'sessionId', 'promptId'];
  if (Object.keys(message).some((key) => !allowed.includes(key))) return undefined;
  if (message.type === 'prompt-choice' && typeof message.choiceId === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(message.choiceId)) return { type: 'prompt-choice', sessionId: message.sessionId, promptId: message.promptId, choiceId: message.choiceId };
  if (message.type === 'prompt-answer' && typeof message.text === 'string' && message.text.trim().length > 0 && message.text.length <= 4000 && !/(?:api[-_ ]?key|bearer\s|authorization\s*[:=])/i.test(message.text)) return { type: 'prompt-answer', sessionId: message.sessionId, promptId: message.promptId, text: message.text.trim() };
  if (message.type === 'prompt-cancel' || message.type === 'prompt-resume') return { type: message.type, sessionId: message.sessionId, promptId: message.promptId };
  return undefined;
}

export function parseChatWebviewMessage(value: unknown): ChatWebviewMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const message = value as Record<string, unknown>;
  const profileMessage = parseProfileWebviewMessage(message);
  if (profileMessage) return profileMessage;
  if (message.type === 'load-analytics' || message.type === 'export-analytics') {
    if (Object.keys(message).some((key) => key !== 'type' && key !== 'filter') || (message.filter !== undefined && !isAnalyticsFilter(message.filter))) return undefined;
    return { type: message.type, filter: normalizeAnalyticsFilter(message.filter) };
  }
  const walletMessage = parseWalletWebviewMessage(message);
  if (walletMessage) return walletMessage;
  const teamMessage = parseTeamWebviewMessage(message);
  if (teamMessage) return teamMessage;
  const multimodalMessage = parseMultimodalWebviewMessage(message);
  if (multimodalMessage) return multimodalMessage;
  const generationMessage = parseGenerationWebviewMessage(message);
  if (generationMessage) return generationMessage;
  const memoryMessage = parseContextGraphWebviewMessage(message);
  if (memoryMessage) return memoryMessage;
  if (message.type === 'set-quiet-mode' && typeof message.quiet === 'boolean' && Object.keys(message).length === 2) return { type: 'set-quiet-mode', quiet: message.quiet };
  if (message.type === 'agent-drill-down' && typeof message.agentId === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(message.agentId) && Object.keys(message).length === 2) return { type: 'agent-drill-down', agentId: message.agentId };
  if (message.type === 'approval-reply') {
    if (Object.keys(message).some((key) => !['type', 'callId', 'decision', 'feedback'].includes(key))) return undefined;
    if (typeof message.callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(message.callId)) return undefined;
    if (message.decision !== 'allow' && message.decision !== 'allow-run' && message.decision !== 'deny') return undefined;
    if (message.feedback !== undefined && (typeof message.feedback !== 'string' || message.feedback.length > 2000)) return undefined;
    return { type: 'approval-reply', callId: message.callId, decision: message.decision, ...(message.feedback ? { feedback: message.feedback as string } : {}) };
  }
  if (message.type === 'revert-run' && typeof message.runId === 'string' && /^run-\d+-[a-f0-9]{6}$/.test(message.runId) && Object.keys(message).length === 2) return { type: 'revert-run', runId: message.runId };
  if (message.type === 'verify-response' && typeof message.runId === 'string' && /^run-\d+-[a-f0-9]{6}$/.test(message.runId) && Object.keys(message).length === 2) return { type: 'verify-response', runId: message.runId };
  if (message.type === 'insert-code' && typeof message.text === 'string' && message.text.length > 0 && message.text.length <= 100_000) {
    if (Object.keys(message).some((key) => key !== 'type' && key !== 'text')) return undefined;
    return { type: 'insert-code', text: message.text };
  }
  if (message.type === 'load-models' || message.type === 'open-setup' || message.type === 'refresh-status' || message.type === 'stop' || message.type === 'history' || message.type === 'new-chat' || message.type === 'open-tools' || message.type === 'select-profile') {
    if (Object.keys(message).some((key) => key !== 'type')) return undefined;
    return { type: message.type };
  }
  if ((message.type === 'reopen-session' || message.type === 'continue-session') && typeof message.sessionId === 'string' && /^session-[a-z0-9-]{8,80}$/.test(message.sessionId)) {
    if (Object.keys(message).some((key) => key !== 'type' && key !== 'sessionId')) return undefined;
    return { type: message.type, sessionId: message.sessionId };
  }
  const promptResponse = promptResponseMessage(value);
  if (promptResponse) return promptResponse;
  if (message.type === 'open-artifact' && typeof message.path === 'string' && message.path.length > 0 && message.path.length < 300 && !message.path.startsWith('/') && !message.path.split(/[\\/]/).includes('..') && (message.kind === 'file' || message.kind === 'directory')) {
    if (Object.keys(message).some((key) => key !== 'type' && key !== 'path' && key !== 'kind')) return undefined;
    return { type: 'open-artifact', path: message.path, kind: message.kind };
  }
  // Slash commands name an installed Open-GSD skill; the host checks it exists in the installed version.
  if (message.type === 'open-command' && typeof message.command === 'string' && /^[a-z0-9][a-z0-9:_-]{0,79}$/i.test(message.command)) {
    if (Object.keys(message).some((key) => !['type', 'command', 'args', 'model'].includes(key))) return undefined;
    if (message.args !== undefined && (typeof message.args !== 'string' || message.args.length > 4000)) return undefined;
    if (message.model !== undefined && (typeof message.model !== 'string' || message.model.length > 200)) return undefined;
    return { type: 'open-command', command: message.command, ...(message.args ? { args: (message.args as string).trim() } : {}), ...(message.model ? { model: (message.model as string).trim() } : {}) };
  }
  if (message.type === 'attach-files' && Object.keys(message).length === 1) return { type: 'attach-files' };
  if (message.type === 'attachment-remove' && typeof message.id === 'string' && /^att-[a-f0-9]{12}$/.test(message.id) && Object.keys(message).length === 2) return { type: 'attachment-remove', id: message.id };
  if (message.type === 'open-activity') {
    if (Object.keys(message).some((key) => key !== 'type' && key !== 'agentId')) return undefined;
    if (message.agentId === undefined) return { type: 'open-activity' };
    return typeof message.agentId === 'string' && /^[a-z0-9][a-z0-9:_-]{0,90}-[a-f0-9]{6}$/i.test(message.agentId) ? { type: 'open-activity', agentId: message.agentId } : undefined;
  }
  if (message.type === 'agent-control' && typeof message.agentId === 'string' && /^[a-z0-9][a-z0-9:_-]{0,90}-[a-f0-9]{6}$/i.test(message.agentId) && (message.action === 'pause' || message.action === 'resume' || message.action === 'stop') && Object.keys(message).length === 3) {
    return { type: 'agent-control', agentId: message.agentId, action: message.action };
  }
  if (message.type === 'resume-conversation' && typeof message.id === 'string' && /^conv-[a-z0-9-]{6,60}$/.test(message.id) && Object.keys(message).length === 2) return { type: 'resume-conversation', id: message.id };
  if (message.type === 'questions-reply' && typeof message.id === 'string' && /^q-[a-f0-9]{12}$/.test(message.id) && Array.isArray(message.answers)) {
    if (Object.keys(message).some((key) => !['type', 'id', 'answers'].includes(key))) return undefined;
    if (message.answers.length > 4 || message.answers.some((answer) => typeof answer !== 'string' || answer.length > 4000)) return undefined;
    return { type: 'questions-reply', id: message.id, answers: message.answers as string[] };
  }
  if (message.type !== 'send' || typeof message.text !== 'string' || !message.text.trim()) return undefined;
  if (Object.keys(message).some((key) => key !== 'type' && key !== 'text' && key !== 'model' && key !== 'overrideToken' && key !== 'attachmentIds')) return undefined;
  if (message.attachmentIds !== undefined && (!Array.isArray(message.attachmentIds) || message.attachmentIds.length > 10 || message.attachmentIds.some((id) => typeof id !== 'string' || !/^att-[a-f0-9]{12}$/.test(id)))) return undefined;
  if (message.overrideToken !== undefined && (typeof message.overrideToken !== 'string' || !/^privacy-[0-9a-f-]{36}$/.test(message.overrideToken))) return undefined;
  return {
    type: 'send',
    text: message.text.trim(),
    model: typeof message.model === 'string' ? message.model.trim() || undefined : undefined,
    ...(message.overrideToken ? { overrideToken: message.overrideToken as string } : {}),
    ...(Array.isArray(message.attachmentIds) && message.attachmentIds.length ? { attachmentIds: message.attachmentIds as string[] } : {})
  };
}

function parseMultimodalWebviewMessage(message: Record<string, unknown>): MultimodalWebviewMessage | undefined {
  if (message.type === 'attachment-select') return Object.keys(message).length === 1 ? { type: 'attachment-select' } : undefined;
  if (message.type === 'attachment-cancel') {
    if (Object.keys(message).length !== 2 || typeof message.artifactId !== 'string' || !/^attachment-[a-z0-9]{20}$/.test(message.artifactId)) return undefined;
    return { type: 'attachment-cancel', artifactId: message.artifactId };
  }
  if (message.type === 'multimodal-prepare') {
    const operations: MultimodalOperation[] = ['inspect', 'transcribe', 'extract', 'summarize', 'transform', 'publish'];
    if (Object.keys(message).some((key) => !['type', 'operation', 'sourceArtifactIds'].includes(key)) || !operations.includes(message.operation as MultimodalOperation) || !Array.isArray(message.sourceArtifactIds) || message.sourceArtifactIds.length < 1 || message.sourceArtifactIds.length > 8 || message.sourceArtifactIds.some((id) => typeof id !== 'string' || !/^attachment-[a-z0-9]{20}$/.test(id))) return undefined;
    const sourceArtifactIds = [...new Set(message.sourceArtifactIds as string[])];
    if (sourceArtifactIds.length !== message.sourceArtifactIds.length) return undefined;
    return { type: 'multimodal-prepare', operation: message.operation as MultimodalOperation, sourceArtifactIds };
  }
  if (message.type === 'multimodal-status' || message.type === 'multimodal-cancel' || message.type === 'multimodal-recover') {
    if (Object.keys(message).length !== 2 || typeof message.operationId !== 'string' || !/^multimodal-op-[a-z0-9]{20}$/.test(message.operationId)) return undefined;
    return { type: message.type, operationId: message.operationId };
  }
  if (message.type === 'multimodal-approve') {
    if (Object.keys(message).length !== 4 || typeof message.operationId !== 'string' || !/^multimodal-op-[a-z0-9]{20}$/.test(message.operationId) || typeof message.approvalFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(message.approvalFingerprint) || message.explicit !== true) return undefined;
    return { type: 'multimodal-approve', operationId: message.operationId, approvalFingerprint: message.approvalFingerprint, explicit: true };
  }
  return undefined;
}

function parseGenerationWebviewMessage(message: Record<string, unknown>): GenerationWebviewMessage | undefined {
  const operationId = typeof message.operationId === 'string' && /^generation-op-[a-z0-9]{20}$/.test(message.operationId) ? message.operationId : undefined;
  if (message.type === 'generation-preview') {
    const allowed = ['type', 'operation', 'model', 'prompt', 'sourceArtifactIds'];
    if (Object.keys(message).some((key) => !allowed.includes(key)) || !['image-generation', 'image-edit', 'video-generation'].includes(String(message.operation)) || typeof message.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,160}$/.test(message.model) || typeof message.prompt !== 'string' || message.prompt.trim().length === 0 || message.prompt.length > 8000) return undefined;
    if (message.sourceArtifactIds !== undefined && (!Array.isArray(message.sourceArtifactIds) || message.sourceArtifactIds.length > 8 || message.sourceArtifactIds.some((id) => typeof id !== 'string' || !/^attachment-[a-z0-9]{20}$/.test(id)))) return undefined;
    return { type: 'generation-preview', operation: message.operation as 'image-generation' | 'image-edit' | 'video-generation', model: message.model, prompt: message.prompt.trim(), ...(message.sourceArtifactIds === undefined ? {} : { sourceArtifactIds: [...new Set(message.sourceArtifactIds as string[])] }) };
  }
  if (message.type === 'generation-status' || message.type === 'generation-cancel' || message.type === 'generation-publication-preview' || message.type === 'generation-publish' || message.type === 'generation-start') {
    if (!operationId) return undefined;
    if (message.type === 'generation-status' || message.type === 'generation-cancel') return Object.keys(message).length === 2 ? { type: message.type, operationId } : undefined;
    if (message.type === 'generation-publication-preview') return Object.keys(message).length === 3 && typeof message.destination === 'string' && message.destination.length > 0 && message.destination.length <= 240 && !message.destination.startsWith('/') && !message.destination.includes('\\') && !message.destination.split('/').includes('..') ? { type: message.type, operationId, destination: message.destination } : undefined;
    if (message.type === 'generation-start') return Object.keys(message).length === 4 && validFingerprint(message.approvalFingerprint) && message.explicit === true ? { type: message.type, operationId, approvalFingerprint: message.approvalFingerprint, explicit: true } : undefined;
    return Object.keys(message).length === 4 && validFingerprint(message.publicationFingerprint) && message.explicit === true ? { type: message.type, operationId, publicationFingerprint: message.publicationFingerprint, explicit: true } : undefined;
  }
  return undefined;
}

function parseContextGraphWebviewMessage(message: Record<string, unknown>): ContextGraphWebviewMessage | undefined {
  const scope = parseMemoryScope(message.scope);
  if ((message.type === 'memory-inspect' || message.type === 'memory-search') && scope) {
    if (message.type === 'memory-inspect' && Object.keys(message).every((key) => ['type', 'scope', 'localOnly'].includes(key)) && (message.localOnly === undefined || typeof message.localOnly === 'boolean')) return { type: 'memory-inspect', scope, localOnly: message.localOnly as boolean | undefined };
    if (message.type === 'memory-search' && Object.keys(message).every((key) => ['type', 'scope', 'query', 'nodeType'].includes(key)) && typeof message.query === 'string' && message.query.trim().length > 0 && message.query.length <= 160 && !memoryTextUnsafe(message.query) && (message.nodeType === undefined || ['fact', 'actor', 'function', 'capability', 'artifact', 'task'].includes(String(message.nodeType)))) return { type: 'memory-search', scope, query: message.query.trim(), nodeType: message.nodeType as 'fact' | 'actor' | 'function' | 'capability' | 'artifact' | 'task' | undefined };
  }
  if (message.type === 'memory-slice-preview') {
    const allowed = ['type', 'task', 'agentId', 'teamId', 'projectId', 'sharedId', 'scopes', 'localOnly'];
    if (Object.keys(message).some((key) => !allowed.includes(key)) || typeof message.task !== 'string' || message.task.trim().length === 0 || message.task.length > 480 || memoryTextUnsafe(message.task) || (message.localOnly !== undefined && typeof message.localOnly !== 'boolean') || !Array.isArray(message.scopes) || message.scopes.length < 1 || message.scopes.length > 4 || message.scopes.some((value) => !parseMemoryScope(value)) || ['agentId', 'teamId', 'projectId', 'sharedId'].some((key) => message[key] !== undefined && !safeMemoryId(message[key]))) return undefined;
    return { type: 'memory-slice-preview', task: message.task.trim(), scopes: (message.scopes as unknown[]).map((value) => parseMemoryScope(value) as MemoryScope), ...(message.agentId === undefined ? {} : { agentId: message.agentId as string }), ...(message.teamId === undefined ? {} : { teamId: message.teamId as string }), ...(message.projectId === undefined ? {} : { projectId: message.projectId as string }), ...(message.sharedId === undefined ? {} : { sharedId: message.sharedId as string }), ...(message.localOnly === undefined ? {} : { localOnly: message.localOnly as boolean }) };
  }
  if (message.type === 'memory-approve') {
    return Object.keys(message).length === 3 && validFingerprint(message.approvalFingerprint) && message.explicit === true ? { type: 'memory-approve', approvalFingerprint: message.approvalFingerprint, explicit: true } : undefined;
  }
  if (message.type === 'memory-preview' && scope) {
    const operation = message.operation;
    if (!['correct', 'merge', 'retract', 'reset', 'export'].includes(String(operation)) || typeof message.expectedGraphVersion !== 'number' || !Number.isInteger(message.expectedGraphVersion) || message.expectedGraphVersion < 0 || message.expectedGraphVersion > 2_147_483_647 || (message.localOnly !== undefined && typeof message.localOnly !== 'boolean')) return undefined;
    const common = ['type', 'operation', 'scope', 'expectedGraphVersion', 'localOnly'];
    if (operation === 'correct' && Object.keys(message).every((key) => [...common, 'nodeId', 'summary'].includes(key)) && safeMemoryId(message.nodeId) && typeof message.summary === 'string' && message.summary.trim().length > 0 && message.summary.length <= 480 && !memoryTextUnsafe(message.summary)) return { type: 'memory-preview', operation: 'correct', scope, expectedGraphVersion: message.expectedGraphVersion, nodeId: message.nodeId as string, summary: message.summary.trim(), ...(message.localOnly === undefined ? {} : { localOnly: message.localOnly as boolean }) };
    if (operation === 'merge' && Object.keys(message).every((key) => [...common, 'targetNodeId', 'sourceNodeIds', 'summary'].includes(key)) && safeMemoryId(message.targetNodeId) && Array.isArray(message.sourceNodeIds) && message.sourceNodeIds.length > 0 && message.sourceNodeIds.length <= 8 && new Set(message.sourceNodeIds).size === message.sourceNodeIds.length && message.sourceNodeIds.every(safeMemoryId) && (message.summary === undefined || (typeof message.summary === 'string' && message.summary.length <= 480 && !memoryTextUnsafe(message.summary)))) return { type: 'memory-preview', operation: 'merge', scope, expectedGraphVersion: message.expectedGraphVersion, targetNodeId: message.targetNodeId as string, sourceNodeIds: [...(message.sourceNodeIds as string[])].sort(), ...(message.summary === undefined ? {} : { summary: (message.summary as string).trim() }), ...(message.localOnly === undefined ? {} : { localOnly: message.localOnly as boolean }) };
    if (operation === 'retract' && Object.keys(message).every((key) => [...common, 'nodeId'].includes(key)) && safeMemoryId(message.nodeId)) return { type: 'memory-preview', operation: 'retract', scope, expectedGraphVersion: message.expectedGraphVersion, nodeId: message.nodeId as string, ...(message.localOnly === undefined ? {} : { localOnly: message.localOnly as boolean }) };
    if ((operation === 'reset' || operation === 'export') && Object.keys(message).every((key) => common.includes(key))) return { type: 'memory-preview', operation, scope, expectedGraphVersion: message.expectedGraphVersion, ...(message.localOnly === undefined ? {} : { localOnly: message.localOnly as boolean }) };
    return undefined;
  }
  if (['memory-correct', 'memory-merge', 'memory-retract', 'memory-reset', 'memory-export'].includes(String(message.type)) && scope) {
    const fingerprint = message.approvalFingerprint;
    if (typeof message.expectedGraphVersion !== 'number' || !Number.isInteger(message.expectedGraphVersion) || message.expectedGraphVersion < 0 || message.explicit !== true || !validFingerprint(fingerprint)) return undefined;
    if (message.type === 'memory-correct' && Object.keys(message).every((key) => ['type', 'scope', 'nodeId', 'expectedGraphVersion', 'summary', 'explicit', 'approvalFingerprint'].includes(key)) && safeMemoryId(message.nodeId) && typeof message.summary === 'string' && message.summary.trim().length > 0 && message.summary.length <= 480 && !memoryTextUnsafe(message.summary)) return { type: 'memory-correct', scope, nodeId: message.nodeId as string, expectedGraphVersion: message.expectedGraphVersion, summary: message.summary.trim(), explicit: true, approvalFingerprint: fingerprint as string };
    if (message.type === 'memory-merge' && Object.keys(message).every((key) => ['type', 'scope', 'targetNodeId', 'sourceNodeIds', 'expectedGraphVersion', 'explicit', 'approvalFingerprint'].includes(key)) && safeMemoryId(message.targetNodeId) && Array.isArray(message.sourceNodeIds) && message.sourceNodeIds.length > 0 && message.sourceNodeIds.length <= 8 && new Set(message.sourceNodeIds).size === message.sourceNodeIds.length && message.sourceNodeIds.every(safeMemoryId)) return { type: 'memory-merge', scope, targetNodeId: message.targetNodeId as string, sourceNodeIds: [...(message.sourceNodeIds as string[])].sort(), expectedGraphVersion: message.expectedGraphVersion, explicit: true, approvalFingerprint: fingerprint as string };
    if (message.type === 'memory-retract' && Object.keys(message).every((key) => ['type', 'scope', 'nodeId', 'expectedGraphVersion', 'explicit', 'approvalFingerprint'].includes(key)) && typeof message.nodeId === 'string' && safeMemoryId(message.nodeId)) return { type: 'memory-retract', scope, nodeId: message.nodeId, expectedGraphVersion: message.expectedGraphVersion, explicit: true, approvalFingerprint: fingerprint as string };
    if (message.type === 'memory-reset' && Object.keys(message).every((key) => ['type', 'scope', 'expectedGraphVersion', 'explicit', 'approvalFingerprint'].includes(key))) return { type: 'memory-reset', scope, expectedGraphVersion: message.expectedGraphVersion, explicit: true, approvalFingerprint: fingerprint as string };
    if (message.type === 'memory-export' && Object.keys(message).every((key) => ['type', 'scope', 'expectedGraphVersion', 'explicit', 'approvalFingerprint'].includes(key))) return { type: 'memory-export', scope, expectedGraphVersion: message.expectedGraphVersion, explicit: true, approvalFingerprint: fingerprint as string };
  }
  return undefined;
}

function parseMemoryScope(value: unknown): MemoryScope | undefined { if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined; const row = value as Record<string, unknown>; if (Object.keys(row).some((key) => key !== 'kind' && key !== 'id') || !['private-agent', 'team-collective', 'project', 'shared'].includes(String(row.kind)) || !safeMemoryId(row.id)) return undefined; return { kind: row.kind as MemoryScope['kind'], id: row.id as string }; }
function safeMemoryId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._:-]{1,159}$/.test(value) && !/(?:api[_ -]?key|token|secret|password|private|raw|context|media|prompt|[\\/])/i.test(value); }
function memoryTextUnsafe(value: string): boolean { return /(?:api[_ -]?key|token|secret|password|private\s+prompt|raw\s+(?:context|media)|authorization\s*[:=]|data:[^\s,;]+|file:\/\/|(?:^|[\s"'`])(?:\/|[A-Za-z]:\\)|\b(?:rm\s+-|curl\s+|wget\s+|powershell\s|bash\s+-|execute\s+command)\b)/i.test(value); }

function validFingerprint(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }

function parseTeamWebviewMessage(message: Record<string, unknown>): TeamWebviewMessage | undefined {
  if (message.type === 'team-list' || message.type === 'team-status') return Object.keys(message).length === 1 ? { type: message.type } : undefined;
  if (message.type === 'team-create') {
    const allowed = ['type', 'displayName', 'description', 'members', 'note'];
    if (Object.keys(message).some((key) => !allowed.includes(key)) || !safeTeamText(message.displayName, 80, true) || (message.description !== undefined && !safeTeamText(message.description, 240)) || (message.note !== undefined && !safeTeamText(message.note, 160)) || !Array.isArray(message.members)) return undefined;
    try { return { type: 'team-create', displayName: message.displayName as string, description: message.description as string | undefined, members: validateTeamMembers(message.members), note: message.note as string | undefined }; } catch { return undefined; }
  }
  if (message.type === 'team-update') {
    const allowed = ['type', 'teamId', 'displayName', 'description', 'members', 'note'];
    if (Object.keys(message).some((key) => !allowed.includes(key)) || !teamId(message.teamId) || (message.displayName === undefined && message.description === undefined && message.members === undefined && message.note === undefined) || (message.displayName !== undefined && !safeTeamText(message.displayName, 80, true)) || (message.description !== undefined && !safeTeamText(message.description, 240)) || (message.note !== undefined && !safeTeamText(message.note, 160)) || (message.members !== undefined && !Array.isArray(message.members))) return undefined;
    try { return { type: 'team-update', teamId: message.teamId as string, displayName: message.displayName as string | undefined, description: message.description as string | undefined, members: message.members === undefined ? undefined : validateTeamMembers(message.members), note: message.note as string | undefined }; } catch { return undefined; }
  }
  if (['team-duplicate', 'team-archive', 'team-restore', 'team-delete'].includes(String(message.type))) {
    const allowed = message.type === 'team-duplicate' ? ['type', 'teamId', 'displayName'] : ['type', 'teamId'];
    if (Object.keys(message).some((key) => !allowed.includes(key)) || !teamId(message.teamId) || (message.type === 'team-duplicate' && message.displayName !== undefined && !safeTeamText(message.displayName, 80, true))) return undefined;
    return { type: message.type as 'team-duplicate' | 'team-archive' | 'team-restore' | 'team-delete', teamId: message.teamId as string, ...(message.type === 'team-duplicate' && message.displayName !== undefined ? { displayName: message.displayName as string } : {}) } as TeamWebviewMessage;
  }
  if (message.type === 'team-preview' || message.type === 'team-select-version' || message.type === 'team-bind' || message.type === 'team-export') {
    const required = message.type === 'team-export' ? ['type', 'teamId'] : ['type', 'teamId', ...(message.version === undefined ? [] : ['version'])];
    if (message.type === 'team-select-version' && message.version === undefined) return undefined;
    if (Object.keys(message).some((key) => !required.includes(key)) || !teamId(message.teamId)) return undefined;
    if (message.version !== undefined && !teamVersion(message.version)) return undefined;
    return { type: message.type, teamId: message.teamId, ...(message.version === undefined ? {} : { version: message.version }) } as TeamWebviewMessage;
  }
  if (message.type === 'team-invoke') {
    const allowed = ['type', 'teamId', 'version', 'role', 'task', 'requiredCapabilities', 'actionCapability'];
    if (Object.keys(message).some((key) => !allowed.includes(key)) || !teamId(message.teamId) || !teamVersion(message.version) || !isTeamRole(message.role) || typeof message.task !== 'string' || message.task.trim().length === 0 || message.task.length > 480 || teamTextUnsafe(message.task) || !Array.isArray(message.requiredCapabilities) || message.requiredCapabilities.length < 1 || message.requiredCapabilities.length > 8 || message.requiredCapabilities.some((value) => !isAgentCapability(value)) || (message.actionCapability !== undefined && !isActionCapability(message.actionCapability))) return undefined;
    return { type: 'team-invoke', teamId: message.teamId as string, version: message.version as number, role: message.role, task: message.task.trim(), requiredCapabilities: [...new Set(message.requiredCapabilities as AgentCapability[])], ...(message.actionCapability === undefined ? {} : { actionCapability: message.actionCapability }) };
  }
  if (message.type === 'team-import') {
    if (Object.keys(message).length !== 2 || typeof message.packageJson !== 'string' || message.packageJson.length < 2 || message.packageJson.length > 100000 || /(?:api[_ -]?key|refresh[-_ ]?token|bearer\s|private prompt|raw context|raw media)/i.test(message.packageJson)) return undefined;
    return { type: 'team-import', packageJson: message.packageJson };
  }
  return undefined;
}

function teamId(value: unknown): value is string { return typeof value === 'string' && /^team-[a-f0-9]{12}$/.test(value); }
function teamVersion(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 50; }
function safeTeamText(value: unknown, max: number, required = false): value is string { return typeof value === 'string' && value.length <= max && !teamTextUnsafe(value) && (!required || value.trim().length > 0); }
function teamTextUnsafe(value: string): boolean { return /(?:api[_ -]?key|refresh[-_ ]?token|bearer\s|secret|password|private\s+prompt|raw\s+(?:context|media)|authorization\s*[:=]|data:[^\s,;]+|file:\/\/|(?:^|[\s"'`])(?:\/|[A-Za-z]:\\)|\b(?:rm\s+-|curl\s+|wget\s+|powershell\s|bash\s+-|execute\s+command)\b)/i.test(value); }
function validateTeamMembers(value: unknown[]): MemberCapabilityContract[] { if (value.length < 1 || value.length > 20) throw new Error('Invalid member count.'); return value.map((member) => validateMemberContract(member)); }
function isTeamRole(value: unknown): value is AgentRole { return ['planner', 'implementer', 'reviewer', 'security', 'tester', 'researcher'].includes(String(value)); }
function isAgentCapability(value: unknown): value is AgentCapability { return ['read', 'plan', 'write', 'test', 'review', 'security', 'network'].includes(String(value)); }
function isActionCapability(value: unknown): value is ActionCapability { return ['read', 'plan', 'workspaceWrite', 'shell', 'network', 'gitMutation', 'mediaGeneration', 'mediaPublication'].includes(String(value)); }

function unavailableTeamRoutes(preview: TeamPreview): TeamCapabilityRouteView[] { return preview.members.map((member) => ({ memberId: member.memberId, role: member.role, skills: [...member.skills], provider: member.route.provider, model: member.route.model, locality: member.route.locality, privacyBoundary: member.route.privacyBoundary, status: 'refresh-required', readiness: 'unknown', freshness: 'unknown', pricing: 'unavailable', verificationStatus: 'unknown', reasons: ['metadata-unknown'] })); }

function parseWalletWebviewMessage(message: Record<string, unknown>): WalletWebviewMessage | undefined {
  if (['wallet-connect', 'wallet-disconnect', 'entitlement-refresh', 'staking-history'].includes(String(message.type))) return Object.keys(message).length === 1 ? { type: message.type as 'wallet-connect' | 'wallet-disconnect' | 'entitlement-refresh' | 'staking-history' } : undefined;
  if (message.type === 'stake-preview') {
    if (Object.keys(message).length !== 3 || !['stake', 'unstake', 'withdraw'].includes(String(message.operation)) || typeof message.amountYocto !== 'string' || !/^(?:0|[1-9][0-9]{0,47})$/.test(message.amountYocto) || message.amountYocto === '0') return undefined;
    return { type: 'stake-preview', operation: message.operation as StakingOperation, amountYocto: message.amountYocto };
  }
  if (message.type === 'stake-confirm') {
    if (Object.keys(message).length !== 4 || typeof message.previewId !== 'string' || !/^stake-preview-[a-f0-9]{16}$/.test(message.previewId) || typeof message.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(message.fingerprint) || message.explicit !== true) return undefined;
    return { type: 'stake-confirm', previewId: message.previewId, fingerprint: message.fingerprint, explicit: true };
  }
  if (message.type === 'stake-cancel') {
    if (Object.keys(message).length !== 2 || typeof message.previewId !== 'string' || !/^stake-preview-[a-f0-9]{16}$/.test(message.previewId)) return undefined;
    return { type: 'stake-cancel', previewId: message.previewId };
  }
  if (message.type === 'transaction-status') {
    if (Object.keys(message).length !== 2 || typeof message.transactionId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(message.transactionId)) return undefined;
    return { type: 'transaction-status', transactionId: message.transactionId };
  }
  return undefined;
}

function parseProfileWebviewMessage(message: Record<string, unknown>): ProfileWebviewMessage | undefined {
  if (message.type === 'profile-list') return Object.keys(message).length === 1 ? { type: 'profile-list' } : undefined;
  if (message.type === 'profile-select' || message.type === 'profile-validate') {
    if (Object.keys(message).length !== 2 || !isProfileId(message.profileId)) return undefined;
    return { type: message.type, profileId: message.profileId };
  }
  if (message.type === 'profile-import-legacy') {
    if (Object.keys(message).length !== 3 || !isProfileId(message.profileId) || message.confirm !== true) return undefined;
    return { type: 'profile-import-legacy', profileId: message.profileId, confirm: true };
  }
  if (message.type !== 'profile-create' && message.type !== 'profile-update') return undefined;
  const allowed = message.type === 'profile-create' ? ['type', 'profileId', 'displayName', 'organization', 'baseUrl', 'authMode'] : ['type', 'profileId', 'displayName', 'organization', 'baseUrl', 'authMode'];
  if (Object.keys(message).some((key) => !allowed.includes(key)) || !isProfileId(message.profileId)) return undefined;
  if (message.type === 'profile-create' && (typeof message.displayName !== 'string' || typeof message.organization !== 'string' || typeof message.baseUrl !== 'string' || (message.authMode !== 'apiKey' && message.authMode !== 'nearAccount'))) return undefined;
  if (message.displayName !== undefined && !safeProfileText(message.displayName, 80)) return undefined;
  if (message.organization !== undefined && !safeProfileText(message.organization, 120)) return undefined;
  if (message.baseUrl !== undefined && !safeBaseUrl(message.baseUrl)) return undefined;
  if (message.authMode !== undefined && message.authMode !== 'apiKey' && message.authMode !== 'nearAccount') return undefined;
  const profileId = message.profileId as string;
  if (message.type === 'profile-create') return { type: 'profile-create', profileId, displayName: message.displayName as string, organization: message.organization as string, baseUrl: message.baseUrl as string, authMode: message.authMode as AuthMode };
  return { type: 'profile-update', profileId, ...(message.displayName === undefined ? {} : { displayName: message.displayName as string }), ...(message.organization === undefined ? {} : { organization: message.organization as string }), ...(message.baseUrl === undefined ? {} : { baseUrl: message.baseUrl as string }), ...(message.authMode === undefined ? {} : { authMode: message.authMode as AuthMode }) };
}

function safeProfileText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\r\n\t]/.test(value) && !/(?:api[_ -]?key|refresh[-_ ]?token|bearer\s|authorization\s*[:=]|private prompt|raw context|command\s*[:=])/i.test(value);
}

function safeBaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 300 || /(?:api[_ -]?key|token|secret|password)/i.test(value)) return false;
  return isSecureEndpoint(value);
}

function isAnalyticsFilter(value: unknown): value is AnalyticsFilter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = ['sessionId', 'projectId', 'organizationProfileId', 'phase', 'model', 'role', 'agentId', 'from', 'to', 'offset', 'limit'];
  return !Object.keys(record).some((key) => !allowed.includes(key)) && Object.entries(record).every(([key, item]) => key === 'offset' ? typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1000 : key === 'limit' ? typeof item === 'number' && Number.isFinite(item) && item >= 1 && item <= 100 : typeof item === 'string' && item.length <= 160 && !/[\r\n]/.test(item) && !/(?:api[_ -]?key|refresh[-_ ]?token|bearer\s|authorization\s*[:=]|private prompt|raw context|command\s*[:=]|[A-Za-z]:\\|^\/)/i.test(item));
}
function normalizeAnalyticsFilter(value: unknown): AnalyticsFilter {
  if (!isAnalyticsFilter(value)) return { offset: 0, limit: 50 };
  const normalized: AnalyticsFilter = { offset: Math.max(0, Math.min(1000, Math.floor(value.offset ?? 0))), limit: Math.max(1, Math.min(100, Math.floor(value.limit ?? 50))) };
  for (const key of ['sessionId', 'projectId', 'organizationProfileId', 'phase', 'model', 'role', 'agentId', 'from', 'to'] as const) if (typeof value[key] === 'string') normalized[key] = value[key];
  return normalized;
}

function cloneWallet<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

export function promptResponseMatches(response: PromptResponse, prompt: StructuredPrompt | undefined): boolean {
  if (!prompt || response.sessionId !== prompt.sessionId || response.promptId !== prompt.promptId) return false;
  if (response.type === 'prompt-choice') return prompt.choices.some((choice) => choice.id === response.choiceId);
  if (response.type === 'prompt-answer') return Boolean(prompt.freeForm?.enabled) && response.text.length <= (prompt.freeForm?.maxLength ?? 4000) && response.text.trim().length >= (prompt.freeForm?.minLength ?? 1);
  return true;
}

export function progressActivitySummary(card: ProgressCard): string {
  const state = card.state === 'approval' ? 'Approval required' : card.state[0].toUpperCase() + card.state.slice(1);
  return safeProgressText(`${state}: ${card.action}${card.tool ? ` · tool ${card.tool}` : ''}${card.phase ? ` · ${card.phase}` : ''}${card.model ? ` · model ${card.model}` : ''}${card.agent ? ` · agent ${card.agent}` : ''}${card.agentCount !== undefined ? ` · ${card.agentCount} agents` : ''}${card.attempt ? ` · attempt ${card.attempt}` : ''}${card.retry ? ' · retry' : ''}${card.approvalRequired ? ' · approval required' : ''}`);
}

/**
 * Models a run may hand work to (sub-agents, tiers, image generation) without the user picking
 * them: on the same route as the chosen model (local or cloud) and at least as private. A run on a
 * TEE model never reaches a forwarded one; a local run stays on this machine.
 */
export function modelsAsPrivateAs(models: ModelInfo[], chosen: ModelInfo | undefined): ModelInfo[] {
  const boundary = chosen?.privacyBoundary;
  if (boundary === 'local') return models.filter((model) => model.privacyBoundary === 'local');
  const cloud = models.filter((model) => model.privacyBoundary !== 'local');
  return boundary === 'tee' ? cloud.filter((model) => model.privacyBoundary === 'tee') : cloud;
}

/**
 * The auto mode's safety model: the wanted model when it runs privately (in NEAR's TEE, or on a
 * local runtime) on the same route as the chat, otherwise none, so unclear commands ask instead
 * of going to a forwarded model.
 */
export function privateSafetyModel(models: ModelInfo[], chosen: ModelInfo | undefined, wanted: string): string | undefined {
  const candidate = modelsAsPrivateAs(models, chosen).find((model) => model.id === wanted.trim());
  return candidate && (candidate.privacyBoundary === 'tee' || candidate.privacyBoundary === 'local') ? candidate.id : undefined;
}

/** Embedding, reranking, and speech models cannot hold a conversation. */
export function isChatModel(model: Pick<ModelInfo, 'id'>): boolean {
  return model.id.trim().length > 0 && !/(?:embed|rerank|whisper|tts|speech|moderation)/i.test(model.id);
}

/** The configured default when the provider offers it, otherwise the first private chat model, otherwise the first chat model. */
export function defaultChatModel(models: ModelInfo[], configured?: string): string | undefined {
  const chat = models.filter(isChatModel);
  return chat.find((model) => model.id === configured?.trim())?.id ?? chat.find((model) => model.privacyBoundary === 'tee')?.id ?? chat[0]?.id;
}

export function modelOptions(models: ModelInfo[], configured?: string): ChatModelOption[] {
  const preferred = defaultChatModel(models, configured);
  const rank = (model: ModelInfo) => (model.id === preferred ? 0 : model.privacyBoundary === 'tee' || model.privacyBoundary === 'local' ? 1 : 2);
  return models
    .filter(isChatModel)
    .sort((a, b) => rank(a) - rank(b))
    .map((model) => ({
      id: model.id,
      label: [model.id, modelPrivacyLabel(model), model.inputPricePerMillion === undefined ? undefined : `$${model.inputPricePerMillion}/$${model.outputPricePerMillion ?? 0} per 1M`].filter(Boolean).join(' · '),
      privacy: model.privacyBoundary === 'tee' ? 'tee' : model.privacyBoundary === 'local' ? 'local' : model.privacyBoundary === 'cloud' ? 'forwarded' : 'unknown',
      ...(model.forwardedTo ? { forwardedTo: model.forwardedTo } : {})
    }));
}

export function appendUserTurn(history: ConversationTurn[], text: string): ConversationTurn[] {
  return [...history, { role: 'user', content: text.trim() }];
}

export function appendAssistantTurn(history: ConversationTurn[], text: string): ConversationTurn[] {
  if (!text) return history;
  return [...history, { role: 'assistant', content: text }];
}

export function providerErrorMessage(error: unknown): string {
  if (error instanceof NearAiError) {
    const request = error.requestId ? ` Request ID: ${error.requestId}.` : '';
    if (error.status === 401 || error.status === 403) return `NEAR AI rejected the request. Check your API key in Setup.${request}`;
    if (error.status === 429) return `NEAR AI is rate limiting requests${error.model ? ` to ${error.model}` : ''}${error.detail ? ` (NEAR says: ${error.detail})` : ''}. Wait a moment and try again, or switch to another model.${request}`;
    return `${error.message}${request}`;
  }
  // The agent loop gave up after NEAR kept refusing a model; its message already says what to do.
  if (error instanceof Error && error.name === 'ModelUnavailableError') return redactSecrets(error.message);
  return 'The NEAR AI request could not be completed. Check your connection and try again.';
}
