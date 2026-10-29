import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { formatGsdStatusLine, parseGsdPlanningState, statusSnapshot, withLiveStatus } from '../domain/gsdStatus';
import { GSD_COMMANDS } from '../domain/gsdCommands';
import { AuthService } from './auth';
import { createNearAiProvider } from './providerFactory';
import { activeProvider, clientFor } from './providerCache';
import { projectMemoryScope } from '../agent/extraTools';
import { AGENT_MEMORY_ACTOR, AgentConversation, findSkill, GsdContext, spendAccountOf } from './agentSession';
import { GsdHost } from '../gsd/host';
import { findRipgrep } from '../agent/tools';
import { isEmergencyStopped, onDidChangeEmergencyStop } from './emergencyStop';
import { applyPolicyChoice, PolicyConfiguration, policyStateMessage } from './approvalPolicy';
import { OutboundGuard } from './outboundGuard';
import { configureSpendTracking, spendAccountForRoot } from './spendTracking';
import { shownSpendAccount, showSpendAccount, SpendAccount } from './spendAccount';
import { withSpendTag } from './spendLedger';
import { ProfileStore } from './profileStore';
import { readAgentLimits, readAgentModels, readAgentRules, readModelTiers, readRoleModels, readSafetyModel, readSettings, shouldAutoInstallGsd, readRunBudget } from './settings';
import { sharedTranscriptKey, TranscriptStore } from './transcripts';
import { prepareAttachments, stageAttachment, StagedAttachment } from '../agent/attachments';
import { TeamDefinition, TeamLibrary, teamAgents } from '../agent/teams';
import type { GsdAgent } from '../gsd/library';
import { appendAssistantTurn, appendUserTurn, modelOptions, modelPrivacyLabel, modelsAsPrivateAs, privateSafetyModel, parseChatWebviewMessage, providerErrorMessage, ConversationTurn, discoverGsdArtifacts, isSafeArtifactPath, sessionSummaryMessage, promptMessage, promptResponseMatches, progressActivitySummary, progressCardMessage, GsdArtifactLink, profileStatusMessage, walletStatusMessage, walletPreviewMessage, walletHistoryMessage, walletErrorMessage, teamListMessage, teamPreviewMessage, teamStatusMessage, teamLifecycleMessage, teamInvocationStatusMessage, capabilityAwareTeamPreview, generationPreviewMessage, generationStatusMessage, generationPublicationMessage, memoryInspectMessage, memorySliceMessage, memoryApprovalPreviewMessage, multimodalStatusMessage, sanitizeContextGraphNode } from './chatBridge';
import type { ChatTeamMessage, ChatWebviewMessage, TeamWebviewMessage } from './chatBridge';
import { PromptResponse, StructuredPrompt } from '../domain/chatProgress';
import { sharedActivityFeed } from './activityView';
import { AGENT_DEFAULTS } from '../domain/agentDefaults';
import type { ModelInfo } from './nearAiClient';
import { RED_TEAM_WORKFLOW_STEP, redTeamEnabled } from '../agent/projectTypes';
import { securityAccess } from './securityScan';
import { webSearchProvider } from './webSearchSetup';
import { mcpRegistry } from './mcpView';
import { ActivityStore } from './activityStore';
import { AnalyticsStore } from './analyticsStore';
import { AuditStore } from './auditStore';
import { ReputationStore } from './reputation';
import { buildFleetView } from './fleetView';
import { hostAttribution } from '../domain/activity';
import { StakingService } from './stakingService';
import { TeamStudioStore } from './teamStudio';
import { ProjectInitialization } from './projectInitialization';
import { invokeBoundTeam } from './agentOrchestrator';
import { CapabilityRouter } from './capabilityRouter';
import { MultimodalIntake, MultimodalIntakeError } from './multimodalIntake';
import { MultimodalOperationError, MultimodalOrchestrator, multimodalCatalogRouter, selectMultimodalRoute } from './multimodalOrchestrator';
import type { MultimodalExecutionInput, MultimodalExecutionOutput } from './multimodalOrchestrator';
import { PrivacyPreflight } from './privacyPreflight';
import { GenerationError, GenerationService, NearAiGenerationAdapter } from './generationService';
import { ApprovalService } from './approvalService';
import { PolicyGate } from './policyGate';
import { defaultActionPolicy } from '../domain/policy';
import { ContextGraphMemory, ContextGraphError } from './contextGraphMemory';
import { MemoryApprovalError, MemoryApprovalRegistry } from './memoryApproval';
import type { HostMemoryApprovalAuthorization } from './memoryApproval';
import type { MemoryApprovalDescriptor, MemoryScope } from '../domain/contextGraph';

/** Chat model and safety model pairs already told that auto approve has no private safety model. */
const warnedSafetyModels = new Set<string>();

export interface ChatHost {
  webview: vscode.Webview;
  onDidDispose: vscode.Event<void>;
}

export async function attachChatToView(context: vscode.ExtensionContext, auth: AuthService, view: vscode.WebviewView, html: string): Promise<void> {
  await initializeChat(context, auth, view, html);
}

async function initializeChat(context: vscode.ExtensionContext, auth: AuthService, panel: ChatHost, html: string, initialPrompt?: string, initialGsdCommand?: string): Promise<void> {
  configureSpendTracking(context);
  const state = {
    abort: undefined as AbortController | undefined,
    model: readSettings().defaultModel,
    history: [] as ConversationTurn[],
    activity: undefined as ActivityStore | undefined,
    activeSessionId: undefined as string | undefined,
    prompt: undefined as StructuredPrompt | undefined,
    progressIndex: 0
    ,quiet: false,
    providerProfileId: undefined as string | undefined,
    staking: StakingService.unavailable(),
    teams: new TeamStudioStore(context.globalStorageUri.fsPath)
    ,intake: undefined as MultimodalIntake | undefined
    ,multimodal: undefined as MultimodalOrchestrator | undefined
    ,multimodalRoot: undefined as string | undefined
    ,multimodalProfileId: undefined as string | undefined
    ,multimodalAborts: new Map<string, AbortController>()
    ,generation: undefined as GenerationService | undefined
    ,generationRoot: undefined as string | undefined
    ,generationProfileId: undefined as string | undefined
    ,generationAbort: undefined as AbortController | undefined
    ,contextMemory: undefined as ContextGraphMemory | undefined
    ,memoryApprovals: undefined as MemoryApprovalRegistry | undefined
    ,memorySessionId: undefined as string | undefined
    ,guard: undefined as OutboundGuard | undefined
    ,agent: undefined as AgentConversation | undefined
    ,attachments: new Map<string, StagedAttachment>()
    ,memory: undefined as ContextGraphMemory | undefined
    ,guardSettings: undefined as string | undefined
    /** Message handlers for a turn (send or command) still in progress, from validation to the run's end. */
    ,turns: 0
    /** The catalog entry of the model the current turn uses, for checking messages sent to it mid-run. */
    ,modelInfo: undefined as ModelInfo | undefined
    /** The spend account the status line follows, and its change subscription. */
    ,spend: undefined as SpendAccount | undefined
    ,spendWatch: undefined as { dispose(): void } | undefined
    ,spendTimer: undefined as ReturnType<typeof setTimeout> | undefined
  };
  // The status line follows the key's ledger and NEAR's usage summary as they settle, at most once a second.
  const followSpend = (account: SpendAccount | undefined): void => {
    if (!account || account === state.spend) return;
    showSpendAccount(account);
    state.spendWatch?.dispose();
    state.spend = account;
    state.spendWatch = account.onChange(() => {
      state.spendTimer ??= setTimeout(() => { state.spendTimer = undefined; void statusMessage({ agents: state.agent?.runningAgents ?? 0, account }).then((status) => panel.webview.postMessage(status)); }, 1_000);
      state.spendTimer.unref?.();
    });
  };
  panel.webview.html = html;
  const handle = async (value: unknown): Promise<void> => {
    const message = parseChatWebviewMessage(value);
    if (!message) return;
    if (message.type === 'stop') {
      state.abort?.abort();
      state.abort = undefined;
      state.agent?.stop();
      panel.webview.postMessage({ type: 'assistant-cancelled', status: await readGsdStatusLine() });
      return;
    }
    // Only the user's own choice in the composer's picker changes the approval policy.
    if (message.type === 'set-action-policy') {
      try {
        const result = await applyPolicyChoice(message.mode, policyConfiguration(), vscode.ConfigurationTarget, async (text) => await vscode.window.showWarningMessage(text, { modal: true }, FULL_AUTO_CONFIRM) === FULL_AUTO_CONFIRM);
        panel.webview.postMessage({ type: 'notice', text: result.text });
      } catch (error) {
        panel.webview.postMessage({ type: 'notice', text: `The approval policy could not be saved: ${providerErrorMessage(error)}` });
      }
      sendPolicyState(panel);
      return;
    }
    // A reloaded view asks again for the prompts still waiting, so they are pinned again.
    if (message.type === 'chat-ready') {
      for (const prompt of state.agent?.waitingPrompts() ?? []) panel.webview.postMessage(prompt);
      showWaitingBadge(panel, state.agent?.waitingPrompts().length ?? 0);
      return;
    }
    if (message.type === 'questions-reply') {
      state.agent?.answerQuestions(message.id, message.answers);
      return;
    }
    if (message.type === 'attach-files') {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach', title: 'Attach files to your message' });
      for (const uri of picked ?? []) {
        try {
          const attachment = await stageAttachment(uri.fsPath);
          state.attachments.set(attachment.id, attachment);
          panel.webview.postMessage({ type: 'attachment-staged', id: attachment.id, name: attachment.name, kind: attachment.kind, size: attachment.size });
          if (attachment.note) panel.webview.postMessage({ type: 'notice', text: attachment.note });
        } catch (error) {
          panel.webview.postMessage({ type: 'notice', text: providerErrorMessage(error) });
        }
      }
      return;
    }
    if (message.type === 'attachment-remove') {
      state.attachments.delete(message.id);
      return;
    }
    if (message.type === 'agent-control') {
      state.agent?.controlAgent(message.agentId, message.action);
      return;
    }
    if (message.type === 'resume-conversation') {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      state.agent = state.agent ?? conversationFor(context, root, panel);
      const turns = await state.agent.restore(message.id);
      panel.webview.postMessage(turns ? { type: 'transcript', turns } : { type: 'history-error', text: 'That conversation is no longer saved on this machine.' });
      return;
    }
    if (message.type === 'attachment-select') {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { panel.webview.postMessage({ type: 'attachment-error', code: 'workspace-containment', text: 'Open a workspace before attaching a file.' }); return; }
      const selected = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Attach bounded local file', filters: { 'Supported multimodal files': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'flac', 'm4a', 'pdf', 'txt', 'md', 'docx', 'json', 'csv'] } });
      if (!selected?.[0]) return;
      state.intake = state.intake ?? new MultimodalIntake(root, { privacy: new PrivacyPreflight() });
      try {
        const relative = path.relative(root, selected[0].fsPath).replaceAll(path.sep, '/');
        const result = await state.intake.stage({ sourcePath: relative, sourceKind: 'user-selected-file', consent: true });
        panel.webview.postMessage({ type: 'attachment-staged', preview: result.preview });
      } catch (error) {
        const code = error instanceof MultimodalIntakeError ? error.code : 'invalid-reference';
        panel.webview.postMessage({ type: 'attachment-error', code, text: safeMultimodalError(error) });
      }
      return;
    }
    if (message.type === 'attachment-cancel') {
      try {
        const preview = state.intake?.cancel(message.artifactId);
        if (!preview) throw new Error('Attachment is not available in this chat session.');
        panel.webview.postMessage({ type: 'attachment-cancelled', preview });
      } catch (error) { panel.webview.postMessage({ type: 'attachment-error', code: 'invalid-reference', text: safeMultimodalError(error) }); }
      return;
    }
    if (message.type === 'multimodal-prepare' || message.type === 'multimodal-approve' || message.type === 'multimodal-status' || message.type === 'multimodal-cancel' || message.type === 'multimodal-recover') {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { panel.webview.postMessage({ type: 'multimodal-error', code: 'workspace-containment', text: 'Open a workspace before using attachment operations.' }); return; }
      try {
        const context = await getMultimodalContext(root, auth, state);
        if (message.type === 'multimodal-prepare') {
          const sourceRecords = message.sourceArtifactIds.map((artifactId) => state.intake?.get(artifactId));
          if (sourceRecords.some((record) => !record)) throw new MultimodalOperationError('invalid-reference', 'Every selected attachment must be staged in this chat.');
          const route = await selectMultimodalRoute(context.router, context.profile.provider, readSettings().defaultModel, message.operation, sourceRecords.map((record) => record!.modality));
          const prepared = await context.orchestrator.prepare({ operation: message.operation, sourceArtifactIds: message.sourceArtifactIds, route, rawContentRequested: true, sessionId: state.activeSessionId ?? `session-multimodal-${Date.now()}`, projectId: projectIdForWorkspace(root), attribution: hostAttribution(context.profiles.projectScopeId, path.basename(root), context.profile.profileId, context.profile.organization) });
          panel.webview.postMessage(multimodalStatusMessage(prepared));
          if (prepared.approval) panel.webview.postMessage({ type: 'multimodal-approval-required', preview: prepared.approval });
        }
        if (message.type === 'multimodal-approve') {
          const approved = await context.orchestrator.approve(message.operationId, message.approvalFingerprint);
          panel.webview.postMessage(multimodalStatusMessage(approved));
          const abort = new AbortController();
          state.multimodalAborts.set(message.operationId, abort);
          try {
            const completed = await context.orchestrator.run(message.operationId, message.approvalFingerprint, abort.signal);
            panel.webview.postMessage(multimodalStatusMessage(completed));
          } finally {
            if (state.multimodalAborts.get(message.operationId) === abort) state.multimodalAborts.delete(message.operationId);
          }
        }
        if (message.type === 'multimodal-status') panel.webview.postMessage(multimodalStatusMessage(requireMultimodalOperation(context.orchestrator, message.operationId)));
        if (message.type === 'multimodal-cancel') {
          state.multimodalAborts.get(message.operationId)?.abort();
          panel.webview.postMessage(multimodalStatusMessage(await context.orchestrator.cancel(message.operationId)));
        }
        if (message.type === 'multimodal-recover') {
          const recovered = await context.orchestrator.recover(message.operationId);
          panel.webview.postMessage(multimodalStatusMessage(recovered));
          if (recovered.approval) panel.webview.postMessage({ type: 'multimodal-approval-required', preview: recovered.approval });
        }
      } catch (error) {
        const code = error instanceof MultimodalOperationError ? error.code : 'provider-failed';
        panel.webview.postMessage({ type: 'multimodal-error', code, text: safeMultimodalError(error) });
      }
      return;
    }
    if (message.type === 'memory-inspect' || message.type === 'memory-search' || message.type === 'memory-slice-preview' || message.type === 'memory-preview' || message.type === 'memory-approve' || message.type === 'memory-correct' || message.type === 'memory-merge' || message.type === 'memory-retract' || message.type === 'memory-reset' || message.type === 'memory-export') {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { panel.webview.postMessage({ type: 'memory-error', code: 'workspace-required', text: 'Open a workspace before inspecting local memory.' }); return; }
      state.contextMemory = state.contextMemory ?? new ContextGraphMemory(root);
      state.memoryApprovals = state.memoryApprovals ?? new MemoryApprovalRegistry();
      state.memorySessionId = state.memorySessionId ?? state.activeSessionId ?? `session-memory-${Date.now()}`;
      try {
        if (message.type === 'memory-inspect') { panel.webview.postMessage(memoryInspectMessage(await state.contextMemory.inspect(message.scope, { localOnly: message.localOnly }))); return; }
        if (message.type === 'memory-search') { panel.webview.postMessage({ type: 'memory-search', scope: message.scope, nodes: (await state.contextMemory.search(message.scope, message.query, { type: message.nodeType })).slice(0, 48).map(sanitizeContextGraphNode) }); return; }
        if (message.type === 'memory-slice-preview') { panel.webview.postMessage(memorySliceMessage(await state.contextMemory.slice({ task: message.task, scopes: message.scopes, agentId: message.agentId, teamId: message.teamId, projectId: message.projectId, sharedId: message.sharedId, localOnly: message.localOnly === true, providerBoundary: 'local' }))); return; }
        if (message.type === 'memory-preview') {
          if (message.localOnly === false) throw new ContextGraphError('local-only', 'Memory actions remain local-only in this host path.');
          const graph = await state.contextMemory.inspect(message.scope, { localOnly: true });
          if (graph.graphVersion !== message.expectedGraphVersion) throw new ContextGraphError('stale-version', 'Graph changed; refresh before creating an approval preview.');
          const descriptor = memoryApprovalDescriptor(message, graph.graphVersion, state.memorySessionId, projectIdForWorkspace(root));
          panel.webview.postMessage(memoryApprovalPreviewMessage(state.memoryApprovals.create(descriptor)));
          return;
        }
        if (message.type === 'memory-approve') {
          const authorization = state.memoryApprovals.consume(message.approvalFingerprint);
          const descriptor = authorization.descriptor;
          const result = await executeApprovedMemoryAction(state.contextMemory, authorization, descriptor);
          if (descriptor.operation === 'export') panel.webview.postMessage({ type: 'memory-export', scope: descriptor.scope, data: result as string });
          else panel.webview.postMessage({ type: 'memory-updated', scope: descriptor.scope, graphVersion: (await state.contextMemory.inspect(descriptor.scope, { localOnly: true })).graphVersion, ...(typeof result === 'object' && result && 'nodeId' in result ? { nodeId: result.nodeId as string } : {}) });
          return;
        }
        if (message.type === 'memory-correct' || message.type === 'memory-merge' || message.type === 'memory-retract' || message.type === 'memory-reset' || message.type === 'memory-export') {
          const descriptor = memoryApprovalDescriptor(message, message.expectedGraphVersion, state.memorySessionId, projectIdForWorkspace(root));
          const authorization = state.memoryApprovals.consume(message.approvalFingerprint, descriptor);
          const result = await executeApprovedMemoryAction(state.contextMemory, authorization, descriptor);
          if (descriptor.operation === 'export') panel.webview.postMessage({ type: 'memory-export', scope: descriptor.scope, data: result as string });
          else panel.webview.postMessage({ type: 'memory-updated', scope: descriptor.scope, graphVersion: (await state.contextMemory.inspect(descriptor.scope, { localOnly: true })).graphVersion, ...(typeof result === 'object' && result && 'nodeId' in result ? { nodeId: result.nodeId as string } : {}) });
          return;
        }
      } catch (error) { const code = error instanceof ContextGraphError || error instanceof MemoryApprovalError ? error.code : 'memory-unavailable'; panel.webview.postMessage({ type: 'memory-error', code, text: safeMemoryError(error) }); }
      return;
    }
    if (message.type === 'generation-preview' || message.type === 'generation-start' || message.type === 'generation-status' || message.type === 'generation-cancel' || message.type === 'generation-publication-preview' || message.type === 'generation-publish') {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { panel.webview.postMessage({ type: 'generation-error', code: 'invalid-request', text: 'Open a workspace before using generation skills.' }); return; }
      try {
        const generation = await getGenerationService(root, auth, state);
        if (message.type === 'generation-preview') {
          const operation = message.operation;
          const skill = operation === 'video-generation' ? 'generate_video' : 'generate_image';
          const record = await generation.prepare({ operation, skill, provider: 'near-ai', model: message.model, prompt: message.prompt, sessionId: state.activeSessionId ?? `session-generation-${Date.now()}`, projectId: projectIdForWorkspace(root), attribution: await generationAttribution(root, auth), providerBoundary: 'cloud', privacyBoundary: 'cloud', sourceArtifactIds: message.sourceArtifactIds });
          panel.webview.postMessage(generationPreviewMessage(generation.preview(record.operationId)));
        }
        if (message.type === 'generation-start') {
          const approved = await generation.approve(message.operationId, message.approvalFingerprint);
          state.generationAbort?.abort(); state.generationAbort = new AbortController();
          panel.webview.postMessage(generationStatusMessage(approved));
          const completed = await generation.run(message.operationId, message.approvalFingerprint, state.generationAbort.signal);
          panel.webview.postMessage(generationStatusMessage(completed));
        }
        if (message.type === 'generation-status') {
          const operation = generation.get(message.operationId);
          if (!operation) throw new GenerationError('invalid-request', 'The generation operation is not available.');
          panel.webview.postMessage(generationStatusMessage(operation));
        }
        if (message.type === 'generation-cancel') {
          state.generationAbort?.abort();
          panel.webview.postMessage(generationStatusMessage(await generation.cancel(message.operationId, state.generationAbort?.signal)));
        }
        if (message.type === 'generation-publication-preview') panel.webview.postMessage(generationPublicationMessage(await generation.preparePublication({ operationId: message.operationId, destination: message.destination, attribution: await generationAttribution(root, auth) })));
        if (message.type === 'generation-publish') panel.webview.postMessage(generationStatusMessage(await generation.publishOperation(message.operationId, message.publicationFingerprint)));
      } catch (error) {
        const code = error instanceof GenerationError ? error.code : 'provider-failed';
        panel.webview.postMessage({ type: 'generation-error', code, text: safeGenerationError(error) });
      }
      return;
    }
    if (message.type === 'open-setup') {
      await vscode.commands.executeCommand('nearAi.setup');
      return;
    }
    if (message.type === 'select-profile') {
      await vscode.commands.executeCommand('nearAi.selectProfile');
      return;
    }
    if (message.type === 'open-activity') {
      await vscode.commands.executeCommand('nearAi.openAgentActivity', message.agentId);
      return;
    }
    if (message.type === 'open-tools') {
      await vscode.commands.executeCommand('nearAi.openTools');
      return;
    }
    if (message.type === 'new-chat') {
      state.abort?.abort();
      state.abort = undefined;
      state.agent?.reset();
      state.history = [];
      state.activeSessionId = undefined;
      state.prompt = undefined;
      return;
    }
    if (message.type === 'approval-reply') {
      state.agent?.answerApproval(message.callId, { decision: message.decision, feedback: message.feedback });
      return;
    }
    if (message.type === 'revert-run') {
      const restored = await state.agent?.revert(message.runId) ?? [];
      panel.webview.postMessage({ type: 'run-reverted', runId: message.runId, files: restored });
      return;
    }
    if (message.type === 'verify-response') {
      const result = state.agent ? await state.agent.verifyRun(message.runId).catch((error: Error) => ({ outcome: 'unavailable' as const, summary: `Verification failed: ${providerErrorMessage(error)}`, checks: {}, notChecked: [] })) : undefined;
      panel.webview.postMessage({ type: 'response-verification', runId: message.runId, result: result ?? { outcome: 'unavailable', summary: 'Nothing to verify.', checks: {}, notChecked: [] } });
      return;
    }
    if (message.type === 'insert-code') {
      await insertIntoActiveEditor(message.text);
      return;
    }
    if (message.type === 'refresh-status') {
      panel.webview.postMessage(await statusMessage({ agents: state.agent?.runningAgents ?? 0, account: state.spend }));
      await sendProfileStatus(panel, auth);
      await sendStakingStatus(panel, state.staking);
      await sendArtifacts(panel);
      return;
    }
    if (message.type === 'wallet-connect' || message.type === 'wallet-disconnect' || message.type === 'entitlement-refresh' || message.type === 'stake-preview' || message.type === 'stake-confirm' || message.type === 'stake-cancel' || message.type === 'transaction-status' || message.type === 'staking-history') {
      try {
        if (message.type === 'wallet-connect') { await state.staking.connectWallet(); await sendStakingStatus(panel, state.staking); }
        if (message.type === 'wallet-disconnect') { await state.staking.disconnectWallet(); await sendStakingStatus(panel, state.staking); }
        if (message.type === 'entitlement-refresh') await sendStakingStatus(panel, state.staking, true);
        if (message.type === 'stake-preview') panel.webview.postMessage(walletPreviewMessage(await state.staking.createPreview(message.operation, message.amountYocto)));
        if (message.type === 'stake-confirm') panel.webview.postMessage({ type: 'wallet-outcome', outcome: await state.staking.confirmPreview(message.previewId, { fingerprint: message.fingerprint, explicit: true }) });
        if (message.type === 'stake-cancel') { await state.staking.cancelPreview(message.previewId); await sendStakingStatus(panel, state.staking); }
        if (message.type === 'transaction-status') panel.webview.postMessage({ type: 'wallet-transaction-status', outcome: await state.staking.transactionStatus(message.transactionId) });
        if (message.type === 'staking-history') panel.webview.postMessage(walletHistoryMessage(await state.staking.history()));
      } catch (error) {
        panel.webview.postMessage({ type: 'wallet-error', text: walletErrorMessage(error) });
        await sendStakingStatus(panel, state.staking);
      }
      return;
    }
    if (message.type === 'team-list' || message.type === 'team-create' || message.type === 'team-update' || message.type === 'team-duplicate' || message.type === 'team-archive' || message.type === 'team-restore' || message.type === 'team-delete' || message.type === 'team-preview' || message.type === 'team-select-version' || message.type === 'team-bind' || message.type === 'team-invoke' || message.type === 'team-status' || message.type === 'team-export' || message.type === 'team-import') {
      try {
        if (message.type === 'team-list') { panel.webview.postMessage(teamListMessage(await state.teams.list())); return; }
        if (message.type === 'team-create') { const team = await state.teams.create(message); panel.webview.postMessage(teamLifecycleMessage('created', team, `Created ${team.displayName} at exact version ${team.versions.at(-1)?.versionId ?? 'v1'}.`)); await sendTeamStatus(panel, state.teams); return; }
        if (message.type === 'team-update') { const { type: _type, teamId, ...input } = message; const team = await state.teams.update(teamId, input); panel.webview.postMessage(teamLifecycleMessage('updated', team, `Updated ${team.displayName} and created exact version ${team.versions.at(-1)?.versionId ?? `v${team.currentVersion}`}.`)); await sendTeamStatus(panel, state.teams); return; }
        if (message.type === 'team-duplicate') { const team = await state.teams.duplicate(message.teamId, message.displayName); panel.webview.postMessage(teamLifecycleMessage('duplicated', team, `Duplicated ${team.displayName} at exact version ${team.versions.at(-1)?.versionId ?? 'v1'}.`)); await sendTeamStatus(panel, state.teams); return; }
        if (message.type === 'team-archive') { const team = await state.teams.archive(message.teamId); panel.webview.postMessage(teamLifecycleMessage('archived', team, `Archived ${team.displayName}.`)); await sendTeamStatus(panel, state.teams); return; }
        if (message.type === 'team-restore') { const team = await state.teams.restore(message.teamId); panel.webview.postMessage(teamLifecycleMessage('restored', team, `Restored ${team.displayName}.`)); await sendTeamStatus(panel, state.teams); return; }
        if (message.type === 'team-delete') { const deleted = await state.teams.delete(message.teamId); panel.webview.postMessage(teamLifecycleMessage('deleted', undefined, deleted ? `Deleted ${message.teamId}.` : `Team ${message.teamId} was already unavailable.`)); await sendTeamStatus(panel, state.teams); return; }
        if (message.type === 'team-import') { const team = await state.teams.importPackage(message.packageJson); panel.webview.postMessage(teamLifecycleMessage('imported', team, `Imported ${team.displayName} at exact version ${team.versions.at(-1)?.versionId ?? `v${team.currentVersion}`}.`)); await sendTeamStatus(panel, state.teams); return; }
        if (message.type === 'team-export') { panel.webview.postMessage({ type: 'team-export', teamId: message.teamId, packageJson: await state.teams.export(message.teamId) }); return; }
        if (message.type === 'team-invoke') {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!root) throw new Error('Open a workspace before invoking a reusable team.');
          panel.webview.postMessage(teamInvocationStatusMessage({ invocationId: `team-invoke-${createHash('sha256').update(`${root}:${message.teamId}:${message.version}:${Date.now()}`).digest('hex').slice(0, 16)}`, teamId: message.teamId, versionId: `${message.teamId}-v${message.version}`, role: message.role, status: 'binding', stage: 'binding' }));
          panel.webview.postMessage(await invokeTeamFromHost(root, state.teams, message));
          return;
        }
        const preview = message.type === 'team-preview' || message.type === 'team-select-version' ? await state.teams.preview(message.teamId, message.version) : undefined;
        if (preview) { panel.webview.postMessage(teamPreviewMessage(await loadCapabilityAwarePreview(preview, auth))); return; }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (message.type === 'team-status') { const initialization = root ? new ProjectInitialization(root) : undefined; panel.webview.postMessage(teamStatusMessage(await state.teams.list({ includeArchived: true }), initialization ? await initialization.getReusableBinding() : undefined)); return; }
        if (!root) throw new Error('Open a workspace before binding a reusable team.');
        const initialization = new ProjectInitialization(root);
        const binding = await state.teams.bindProject(root, { teamId: message.teamId, version: message.version, projectId: projectIdForWorkspace(root) }, initialization);
        panel.webview.postMessage(teamStatusMessage(await state.teams.list({ includeArchived: true }), binding));
      } catch (error) {
        if (message.type === 'team-invoke') panel.webview.postMessage(teamInvocationStatusMessage({ invocationId: `team-invoke-failed-${createHash('sha256').update(`${message.teamId}:${message.version}:${message.role}`).digest('hex').slice(0, 16)}`, teamId: message.teamId, versionId: `${message.teamId}-v${message.version}`, role: message.role, status: 'failed', stage: 'failed', reason: safeTeamError(error) }));
        panel.webview.postMessage({ type: 'team-error', text: safeTeamError(error) });
      }
      return;
    }
    if (message.type === 'profile-list' || message.type === 'profile-create' || message.type === 'profile-update' || message.type === 'profile-select' || message.type === 'profile-validate' || message.type === 'profile-import-legacy') {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { panel.webview.postMessage({ type: 'profile-error', text: 'Open a workspace before configuring a project profile.' }); return; }
      const profiles = new ProfileStore(root, auth);
      try {
        if (message.type === 'profile-create') await profiles.create(message);
        if (message.type === 'profile-update') { const { type: _type, ...input } = message; await profiles.update(input); state.providerProfileId = undefined; }
        if (message.type === 'profile-select') { await profiles.select(message.profileId); state.providerProfileId = undefined; }
        if (message.type === 'profile-validate') await profiles.validate(message.profileId);
        if (message.type === 'profile-import-legacy') { await profiles.importLegacy(message.profileId, message.confirm); state.providerProfileId = undefined; }
        await sendProfileStatus(panel, auth, profiles);
      } catch (error) {
        panel.webview.postMessage({ type: 'profile-error', text: providerErrorMessage(error) });
      }
      return;
    }
    if (message.type === 'history') {
      await sendHistory(panel, state.activity ?? createActivityStore());
      return;
    }
    if (message.type === 'set-quiet-mode') { state.quiet = message.quiet; panel.webview.postMessage({ type: 'quiet-mode', quiet: state.quiet }); return; }
    if (message.type === 'load-analytics' || message.type === 'export-analytics' || message.type === 'agent-drill-down') {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { panel.webview.postMessage({ type: 'analytics-error', text: 'Open a workspace to inspect local analytics.' }); return; }
      const activity = state.activity ?? new ActivityStore(root); state.activity = activity;
      state.contextMemory = state.contextMemory ?? new ContextGraphMemory(root);
      const analytics = new AnalyticsStore({ sessions: await activity.list() }, new AuditStore(root), new ReputationStore(root), undefined, state.contextMemory);
      const filter = message.type === 'agent-drill-down' ? { agentId: message.agentId, limit: 50 } : message.filter;
      const result = await analytics.query(filter);
      if (message.type === 'export-analytics') panel.webview.postMessage({ type: 'analytics-export', data: await analytics.export(filter) });
      else panel.webview.postMessage({ type: 'analytics', result: buildFleetView(result.fleet, state.quiet) });
      return;
    }
    if (message.type === 'reopen-session' || message.type === 'continue-session') {
      const store = state.activity ?? createActivityStore();
      state.activity = store;
      if (!store) { panel.webview.postMessage({ type: 'history-error', text: 'Open a workspace to reopen local session history.' }); return; }
      const session = await store.get(message.sessionId);
      if (!session) { panel.webview.postMessage({ type: 'history-error', text: 'That session is no longer available. Refresh history to recover.' }); return; }
      state.activeSessionId = session.sessionId;
      state.history = [{ role: 'assistant', content: `Reopened ${session.project}${session.phase ? ` · ${session.phase}` : ''}. Prior prompts are not retained by default. The recorded outcome was ${session.outcome}; no command was replayed.` }];
      panel.webview.postMessage({ type: 'session-reopened', session: sessionSummaryMessage(session), continuation: session.continuationAvailable });
      if (message.type === 'continue-session') panel.webview.postMessage({ type: 'prefill', text: 'Continue from the reopened project context without replaying the completed process.' });
      return;
    }
    if (message.type === 'open-artifact') {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root || !isSafeArtifactPath(root, message.path)) return;
      const artifacts = await discoverGsdArtifacts(root);
      await openGsdArtifact(root, message, artifacts);
      return;
    }
    if (message.type === 'load-models') {
      sendPolicyState(panel);
      await loadModels(panel, auth);
      return;
    }
    if (message.type !== 'send' && message.type !== 'open-command') return;
    if (message.type === 'send' && !message.text?.trim()) return;
    if (isEmergencyStopped()) { panel.webview.postMessage({ type: 'outbound-blocked', text: '', model: '', reason: 'Emergency stop is on. Run "NEAR AI: Resume" to continue.', confirm: false }); return; }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let active;
    try {
      active = root ? await activeProvider(root, auth) : undefined;
    } catch (error) {
      panel.webview.postMessage({ type: 'auth-required', text: providerErrorMessage(error) });
      return;
    }
    if (!root || !active) {
      // Nothing is written here: a chat attempt before setup must not turn the workspace into a NEAR AI project.
      await sendProfileStatus(panel, auth);
      panel.webview.postMessage({ type: 'auth-required', text: 'Set up a NEAR AI profile for this project to start chatting.' });
      return;
    }
    const model = message.model?.trim() || state.model;
    if (!model) { panel.webview.postMessage({ type: 'assistant-error', text: 'Choose a model from the list below the message box.' }); return; }
    const modelInfo = active.models.find((candidate) => candidate.id === model);
    // Open-GSD: a slash command installs it when missing; plain chat uses it only if already installed.
    const gsdHost = gsdHostFor(context);
    let gsd: GsdContext | undefined;
    let skill: { name: string; args: string } | undefined;
    let team: TeamDefinition | undefined;
    let redTeamStep: { addendum: string; agents: GsdAgent[] } | undefined;
    try {
      if (message.type === 'open-command' && message.command.startsWith('team:')) {
        team = await new TeamLibrary(context.globalStorageUri.fsPath).find(message.command.slice(5), root).catch((error: Error) => { throw new Error(`That team file has a problem: ${error.message}`); });
        if (!team) { panel.webview.postMessage({ type: 'assistant-error', text: `There is no team called ${message.command.slice(5)}. Create one with NEAR AI: Manage Teams.` }); return; }
        if (!message.args?.trim()) { panel.webview.postMessage({ type: 'assistant-error', text: `Tell the team what to do: /team:${team.slug} <task>` }); return; }
        gsd = await gsdHost.context();
      } else if (message.type === 'open-command') {
        if (!(await gsdHost.context())) {
          if (!shouldAutoInstallGsd()) { panel.webview.postMessage({ type: 'assistant-error', text: 'Open-GSD is not installed. Turn on nearAi.autoInstallGsd to install it when you run a workflow.' }); return; }
          panel.webview.postMessage({ type: 'notice', text: 'Installing Open-GSD for NEAR AI (first workflow only)…' });
        }
        gsd = await gsdHost.ensure();
        const found = findSkill(gsd.skills, message.command);
        if (!found) { panel.webview.postMessage({ type: 'assistant-error', text: `Open-GSD ${await gsdHost.runtime.installedVersion()} has no /${message.command} command.` }); return; }
        skill = { name: found.name, args: message.args ?? '' };
        // Projects set up with a red-team stage add it to GSD workflows that end in verification.
        if (/^gsd-(?:execute-phase|verify-work|autonomous)$/.test(found.name) && await redTeamEnabled(root)) {
          const project = await new TeamLibrary(context.globalStorageUri.fsPath).find('project', root).catch(() => undefined);
          const redTeam = project ? teamAgents(project).filter((agent) => agent.name === 'red-team') : [];
          redTeamStep = { addendum: RED_TEAM_WORKFLOW_STEP, agents: redTeam };
        }
        panel.webview.postMessage({ type: 'commands', commands: await commandList(gsdHost, context.globalStorageUri.fsPath, root) });
      } else {
        gsd = await gsdHost.context();
      }
    } catch (error) {
      panel.webview.postMessage({ type: 'assistant-error', text: providerErrorMessage(error) });
      return;
    }
    const text = message.type === 'send' ? message.text : team ? `/team:${team.slug} ${message.args ?? ''}`.trim() : `/${skill!.name}${skill!.args ? ` ${skill!.args}` : ''}`;
    // Attachments the user staged for this message.
    const staged = message.type === 'send' ? (message.attachmentIds ?? []).map((id) => state.attachments.get(id)).filter((item): item is StagedAttachment => Boolean(item)) : [];
    const agentModels = readAgentModels();
    if (readSettings().privacyMode === 'tee-only') {
      const needs = [...(staged.some((item) => item.kind === 'image') && !(modelInfo?.inputModalities ?? []).includes('image') ? [agentModels.visionModel] : []), ...(staged.some((item) => item.kind === 'audio') ? [agentModels.transcriptionModel] : [])];
      const forwarded = needs.find((id) => active.models.find((candidate) => candidate.id === id)?.privacyBoundary !== 'tee');
      if (forwarded) { panel.webview.postMessage({ type: 'outbound-blocked', text, model, reason: `TEE-only mode is on, and ${forwarded}, which would read your attachment, does not run in NEAR's TEE.`, confirm: false }); return; }
    }
    state.activity = state.activity ?? new ActivityStore(root);
    const settings = readSettings();
    if (!state.guard || state.guardSettings !== JSON.stringify([settings.privacyMode, settings.dailySpendLimitUsd, settings.actionPolicy])) {
      state.guard = new OutboundGuard(settings);
      state.guardSettings = JSON.stringify([settings.privacyMode, settings.dailySpendLimitUsd, settings.actionPolicy]);
    }
    // Documents are checked by their extracted text, which is what is sent.
    const attachedText = staged.map((item) => item.kind === 'text' ? item.bytes.toString('utf8') : item.kind === 'document' ? item.text ?? '' : '').filter(Boolean).join('\n');
    // Today's spend from the key's ledger (or NEAR's own total), never from activity history.
    const account = spendAccountOf(active.provider.client);
    followSpend(account);
    // Picks up what other windows on this computer spent with the same key.
    await account?.ledger.refresh();
    const spentToday = account?.spentTodayUsd().usd ?? 0;
    const verdict = state.guard.check({ model, modelInfo, text: attachedText ? `${text}\n${attachedText}` : text, overrideToken: message.type === 'send' ? message.overrideToken : undefined }, spentToday);
    // One run, with all its sub-agents, may spend at most the per-run cap and what is left of today's limit.
    const runBudget = readRunBudget();
    if (settings.dailySpendLimitUsd > 0) runBudget.maxCostUsd = Math.max(0, Math.min(runBudget.maxCostUsd, settings.dailySpendLimitUsd - spentToday));
    if (verdict.outcome !== 'allow') {
      panel.webview.postMessage({ type: 'outbound-blocked', text, model, reason: verdict.reason, overrideToken: message.type === 'send' ? verdict.overrideToken : undefined, confirm: verdict.outcome === 'confirm' });
      return;
    }
    state.model = model;
    state.modelInfo = modelInfo;
    state.providerProfileId = active.provider.profileId;
    const attribution = hostAttribution(active.profiles.projectScopeId, path.basename(root), active.profile.profileId, active.profile.organization);
    const session = await state.activity.start({ project: path.basename(root), attribution, model, ...(skill ? { plans: [skill.name] } : {}), summary: skill ? `/${skill.name} started.` : 'Agent conversation turn started.' });
    state.activeSessionId = session.sessionId;
    state.agent = state.agent ?? conversationFor(context, root, panel);
    const runId = AgentConversation.newRunId();
    const conversationId = state.agent.id;
    try {
      const route = clientFor(active, model);
      const limits = readAgentLimits();
      let attachments;
      if (staged.length) {
        try {
          // Reading attachments (vision, transcription) is billed to the run they are for.
          attachments = await withSpendTag({ kind: 'attachment', runId, conversationId }, () => prepareAttachments(staged, { client: route.client, model, models: active.models, visionModel: agentModels.visionModel, transcriptionModel: agentModels.transcriptionModel, question: text }));
        } catch (error) {
          panel.webview.postMessage({ type: 'assistant-error', text: providerErrorMessage(error) });
          return;
        }
        for (const item of staged) state.attachments.delete(item.id);
        panel.webview.postMessage({ type: 'attachments-cleared' });
      }
      state.memory = state.memory ?? new ContextGraphMemory(root, { trustedActorIds: [AGENT_MEMORY_ACTOR] });
      const delegable = modelsAsPrivateAs(active.models, modelInfo);
      // MCP tools are optional for a message: if they can't be prepared, it is sent without them.
      const mcp = await (async () => { try { return await mcpRegistry(context).agentTools(); } catch (error) { return { tools: [], problems: [`MCP tools are unavailable: ${(error as Error).message}`] }; } })();
      for (const problem of mcp.problems) panel.webview.postMessage({ type: 'notice', text: problem });
      const imageModel = delegable.find((candidate) => candidate.id === agentModels.imageModel && (candidate.outputModalities ?? []).includes('image'));
      // Auto approve's safety model must run privately; without one, unclear commands ask.
      const safetyModel = settings.actionPolicy.mode === 'auto' ? privateSafetyModel(active.models, modelInfo, readSafetyModel()) : undefined;
      if (settings.actionPolicy.mode === 'auto' && !safetyModel && !warnedSafetyModels.has(`${model}|${readSafetyModel()}`)) {
        warnedSafetyModels.add(`${model}|${readSafetyModel()}`);
        panel.webview.postMessage({ type: 'notice', text: `Auto approve: ${readSafetyModel()} is not available as a private (TEE) model here, so commands the rules cannot decide will ask you.` });
      }
      await state.agent.send({ text, skill, gsd, team, attachments, memory: { store: state.memory, projectScope: { kind: 'project', id: projectIdForWorkspace(root) } }, imageModel: route.local ? undefined : imageModel, reputation: new ReputationStore(root), tiers: readModelTiers(), roleModels: readRoleModels(), safetyModel, availableModels: delegable.map((candidate) => candidate.id), contextWindows: Object.fromEntries(active.models.map((candidate) => [candidate.id, candidate.contextLength])), maxParallelAgents: limits.maxParallelAgents, maxTurns: limits.maxTurns, client: route.client, model, privacy: modelPrivacyLabel(modelInfo), policy: settings.actionPolicy, rules: readAgentRules(), activity: { store: state.activity, sessionId: session.sessionId }, local: route.local, security: securityAccess(context, root), webSearch: await webSearchProvider(context.secrets), budget: runBudget, mcpTools: mcp.tools, maxOutputTokens: Math.max(1_000, Math.min(1_000_000, Number(vscode.workspace.getConfiguration('nearAi').get<number>('agent.maxOutputTokens', AGENT_DEFAULTS.maxOutputTokens)) || AGENT_DEFAULTS.maxOutputTokens)), shellEnvAllow: vscode.workspace.getConfiguration('nearAi').get<string[]>('agent.shellEnvAllow', []).filter((name) => typeof name === 'string'), runId, ...(redTeamStep ? { skillAddendum: redTeamStep.addendum, projectAgents: redTeamStep.agents } : {}) });
      await sendHistory(panel, state.activity);
      panel.webview.postMessage(await statusMessage({ agents: 0, account }));
      await sendArtifacts(panel);
    } catch (error) {
      await state.activity.append(session.sessionId, { status: 'failed', summary: 'Agent run failed.', errorCode: error instanceof Error ? error.name : 'unknown' });
      panel.webview.postMessage({ type: 'assistant-error', text: providerErrorMessage(error) });
    }
  };
  // A message typed while a turn is in progress steers it: the running agent sees it before its
  // next model request. Once nothing is running it is an ordinary new message.
  const steer = async (message: Extract<ChatWebviewMessage, { type: 'steer' }>): Promise<void> => {
    if (!state.turns && !state.agent?.running) {
      panel.webview.postMessage({ type: 'steer-state', id: message.id, state: 'sent-new' });
      await receive({ type: 'send', text: message.text, ...(state.model ? { model: state.model } : {}) });
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    // It goes to the provider like any message, so it passes the same outbound check.
    let reason: string | undefined;
    if (isEmergencyStopped()) reason = 'Emergency stop is on. Run "NEAR AI: Resume" to continue.';
    else {
      const guard = state.guard ?? new OutboundGuard(readSettings());
      const verdict = guard.check({ model: state.model ?? '', modelInfo: state.modelInfo, text: message.text }, state.spend?.spentTodayUsd().usd ?? 0);
      if (verdict.outcome !== 'allow') reason = `${verdict.reason} It was not sent to the running agent; send it after the run to choose what to do.`;
    }
    if (reason) { panel.webview.postMessage({ type: 'steer-state', id: message.id, state: 'blocked', reason, text: message.text }); return; }
    state.agent = state.agent ?? conversationFor(context, root, panel);
    state.agent.steer(message.id, message.text);
  };
  const receive = async (value: unknown): Promise<void> => {
    const message = parseChatWebviewMessage(value);
    if (message?.type === 'steer') { await steer(message); return; }
    const turn = message?.type === 'send' || message?.type === 'open-command';
    if (turn) state.turns += 1;
    try {
      await handle(value);
    } finally {
      if (turn) state.turns -= 1;
    }
    // Messages queued for a run that ended before taking them become the next turn, in order.
    if (!turn || state.turns || state.agent?.running) return;
    const left = state.agent?.takeUndelivered() ?? [];
    if (!left.length) return;
    for (const item of left) panel.webview.postMessage({ type: 'steer-state', id: item.id, state: 'sent-new' });
    await receive({ type: 'send', text: left.map((item) => item.text).join('\n\n'), ...(state.model ? { model: state.model } : {}) });
  };
  panel.webview.onDidReceiveMessage(receive, undefined, context.subscriptions);
  // The picker follows settings.json edits and the emergency stop; each run reads the setting afresh.
  const policyWatch = vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('nearAi.actionPolicy')) sendPolicyState(panel); });
  panel.onDidDispose(() => { state.abort?.abort(); state.agent?.dispose(); policyWatch.dispose(); state.spendWatch?.dispose(); if (state.spendTimer) clearTimeout(state.spendTimer); }, undefined, context.subscriptions);
  onDidChangeEmergencyStop(async (engaged) => {
    sendPolicyState(panel);
    if (!engaged) return;
    state.abort?.abort();
    state.abort = undefined;
    state.agent?.stop();
    panel.webview.postMessage({ type: 'assistant-cancelled', status: await readGsdStatusLine() });
  }, undefined, context.subscriptions);
  sendPolicyState(panel);
  if (initialPrompt) panel.webview.postMessage({ type: 'prefill', text: initialPrompt });
  followSpend(await spendAccountForRoot(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, auth));
  panel.webview.postMessage(await statusMessage({ agents: 0, account: state.spend }));
  panel.webview.postMessage({ type: 'commands', commands: await commandList(gsdHostFor(context), context.globalStorageUri.fsPath, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) });
  await sendArtifacts(panel);
  state.activity = createActivityStore();
  await sendHistory(panel, state.activity);
  await sendProfileStatus(panel, auth);
  await sendStakingStatus(panel, state.staking);
  await loadModels(panel, auth);
}

export async function openGsdArtifact(root: string, requested: Pick<GsdArtifactLink, 'path' | 'kind'>, artifacts: GsdArtifactLink[]): Promise<boolean> {
  const artifact = artifacts.find((candidate) => candidate.path === requested.path);
  if (!artifact || artifact.kind !== requested.kind || !isSafeArtifactPath(root, requested.path)) return false;
  const candidate = path.resolve(root, requested.path);
  const workspaceRoot = await fs.realpath(root).catch(() => path.resolve(root));
  const resolved = await fs.realpath(candidate).catch(() => undefined);
  if (!resolved || (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`))) return false;
  const stats = await fs.stat(resolved).catch(() => undefined);
  if (requested.kind === 'directory') {
    if (!stats?.isDirectory()) return false;
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(resolved));
    return true;
  }
  if (!stats?.isFile()) return false;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
  await vscode.window.showTextDocument(document, { preview: true });
  return true;
}

async function insertIntoActiveEditor(text: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { void vscode.window.showInformationMessage('Open a file to insert code at the cursor.'); return; }
  await editor.edit((edit) => editor.selections.forEach((selection) => edit.replace(selection, text)));
}

function ripgrepPath(): string | undefined {
  const appRoot = (vscode.env as { appRoot?: string } | undefined)?.appRoot;
  return appRoot ? findRipgrep(appRoot, (candidate) => existsSync(candidate)) : undefined;
}

function conversationFor(context: vscode.ExtensionContext, root: string, panel: ChatHost): AgentConversation {
  const storage = context.globalStorageUri.fsPath;
  const transcripts = readAgentLimits().saveTranscripts ? new TranscriptStore(storage, root, sharedTranscriptKey(context.secrets)) : undefined;
  const post = (outbound: Record<string, unknown>) => {
    void panel.webview.postMessage(outbound);
    // An agent held for approval or an answer waits; say so when the chat isn't on screen.
    if ((outbound.type === 'approval-request' || outbound.type === 'questions-request') && (panel as { visible?: boolean }).visible === false) {
      const text = outbound.type === 'approval-request' ? `An agent is waiting for your approval: ${String(outbound.title ?? 'an action')}` : 'NEAR AI has a question for you and is waiting for the answer.';
      void vscode.window.showWarningMessage(text, 'Show chat').then((choice) => { if (choice) void vscode.commands.executeCommand('nearAiChatView.focus'); });
    }
  };
  const conversation = new AgentConversation(root, post, path.join(storage, 'checkpoints'), ripgrepPath(), transcripts, sharedActivityFeed());
  conversation.onWaitingChange = (count) => showWaitingBadge(panel, count);
  const minutes = vscode.workspace.getConfiguration('nearAi').get<number>('agent.approvalTimeoutMinutes', AGENT_DEFAULTS.approvalTimeoutMinutes);
  conversation.approvalTimeoutMs = Math.max(0, Math.min(1_440, typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : AGENT_DEFAULTS.approvalTimeoutMinutes)) * 60_000;
  return conversation;
}

/** The view's badge while prompts wait for the user. */
export function waitingBadge(count: number): { value: number; tooltip: string } | undefined {
  return count > 0 ? { value: count, tooltip: 'NEAR AI is waiting for you' } : undefined;
}

function showWaitingBadge(panel: ChatHost, count: number): void {
  if ('badge' in panel) (panel as { badge?: { value: number; tooltip: string } }).badge = waitingBadge(count);
}

/** One GSD host per extension storage folder, shared by the sidebar chat and the Tools tab. */
const gsdHosts = new Map<string, GsdHost>();
export function gsdHostFor(context: vscode.ExtensionContext): GsdHost {
  const storage = context.globalStorageUri.fsPath;
  let host = gsdHosts.get(storage);
  if (!host) { host = new GsdHost(storage); gsdHosts.set(storage, host); }
  return host;
}

/** Slash commands for the composer: the installed skills, or the core workflows before the first install. */
async function commandList(host: GsdHost, storageDir?: string, root?: string): Promise<Array<{ command: string; title: string; description: string; argumentHint?: string }>> {
  const teams = storageDir ? (await new TeamLibrary(storageDir).list(root).catch(() => [])).flatMap((entry) => entry.team ? [{ command: `team:${entry.project ? 'project' : entry.team.slug}`, title: entry.team.name, description: `Run the "${entry.team.name}" team${entry.team.description ? ` — ${entry.team.description}` : ''}`, argumentHint: '<task for the team>' }] : []) : [];
  return [...teams, ...await gsdCommandList(host)];
}

async function gsdCommandList(host: GsdHost): Promise<Array<{ command: string; title: string; description: string; argumentHint?: string }>> {
  const installed = await host.commands().catch(() => []);
  if (installed.length) return installed.map((command) => ({ command: command.name, title: command.name, description: command.description, ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}) }));
  return GSD_COMMANDS.map((definition) => ({ command: `gsd-${definition.command}`, title: definition.title, description: definition.description }));
}

function createActivityStore(): ActivityStore | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? new ActivityStore(root) : undefined;
}

function projectIdForWorkspace(root: string): string { return projectMemoryScope(root).id; }
export async function invokeTeamFromHost(workspaceRoot: string, teams: TeamStudioStore, request: Extract<TeamWebviewMessage, { type: 'team-invoke' }>): Promise<ChatTeamMessage> {
  const agent = await invokeBoundTeam(workspaceRoot, teams, request);
  const validatedBinding = await new ProjectInitialization(workspaceRoot).requireReusableBinding();
  if (!validatedBinding) throw new Error('Bind a reusable team version to this project before invocation.');
  return teamInvocationStatusMessage({ invocationId: agent.id, teamId: validatedBinding.teamId, versionId: validatedBinding.versionId, role: agent.role, status: agent.status === 'running' ? 'running' : 'failed', stage: agent.status === 'running' ? 'running' : 'failed', provider: agent.routeSnapshot?.provider, model: agent.routeSnapshot?.model ?? agent.model, locality: agent.routeSnapshot?.locality, privacyBoundary: agent.routeSnapshot?.privacyBoundary, estimatedCostUsd: agent.costUsd, startedAt: agent.startedAt, updatedAt: agent.updatedAt });
}

async function sendTeamStatus(panel: ChatHost, teams: TeamStudioStore): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const initialization = root ? new ProjectInitialization(root) : undefined;
  panel.webview.postMessage(teamStatusMessage(await teams.list({ includeArchived: true }), initialization ? await initialization.getReusableBinding() : undefined));
}
function safeTeamError(error: unknown): string { const raw = error instanceof Error ? error.message : 'The team operation could not be completed.'; return raw.replace(/(?:api[_ -]?key|refresh[-_ ]?token|bearer|secret|password|private prompt|raw context|command)\s*[:=]?\s*[^\s,;]*/gi, '[REDACTED]').slice(0, 240); }
function safeMultimodalError(error: unknown): string { const raw = error instanceof Error ? error.message : 'The attachment could not be staged.'; return raw.replace(/(?:api[_ -]?key|refresh[-_ ]?token|bearer|secret|password|private prompt|raw context|provider[_ -]?payload|raw[_ -]?handles?|managed[_ -]?path|contentHash)\s*[:=]?\s*[^\s,;]+/gi, '[REDACTED]').replace(/(?:^|[\s("'`])(?:\/|[A-Za-z]:[\\/]|\\\\)[^\s,;)}\]]+/g, '$1[PATH_REDACTED]').replace(/data:[^\s,;]+/gi, '[REDACTED]').replace(/[\r\n\t]+/g, ' ').slice(0, 240); }
function safeGenerationError(error: unknown): string { const raw = error instanceof Error ? error.message : 'The generation operation could not be completed.'; return raw.replace(/(?:api[_ -]?key|refresh[-_ ]?token|bearer|secret|password|private prompt|raw context|data:[^\s,;]+)/gi, '[REDACTED]').replace(/[\r\n\t]+/g, ' ').slice(0, 240); }
function safeMemoryError(error: unknown): string { const raw = error instanceof Error ? error.message : 'The memory operation could not be completed.'; return raw.replace(/(?:api[_ -]?key|refresh[-_ ]?token|bearer|secret|password|private prompt|raw context|raw media|data:[^\s,;]+)/gi, '[REDACTED]').replace(/[\r\n\t]+/g, ' ').slice(0, 240); }
function userMemoryProvenance(value: string): { kind: 'user'; sourceId: string; sourceHash: string; capturedAt: string; evidenceClass: 'user-assertion'; actorId: 'user' } { return { kind: 'user', sourceId: 'chat-memory-edit', sourceHash: createHash('sha256').update(value).digest('hex'), capturedAt: new Date().toISOString(), evidenceClass: 'user-assertion', actorId: 'user' }; }

type MemoryActionMessage = Extract<ChatWebviewMessage, { type: 'memory-preview' | 'memory-correct' | 'memory-merge' | 'memory-retract' | 'memory-reset' | 'memory-export' }>;

function memoryApprovalDescriptor(message: MemoryActionMessage, expectedGraphVersion: number, sessionId = 'session-memory-host', projectId = 'project-host'): MemoryApprovalDescriptor {
  let operation: MemoryApprovalDescriptor['operation'];
  let nodeIds: string[] = [];
  let sourceNodeIds: string[] = [];
  let targetNodeId: string | undefined;
  let summary: string | undefined;
  if (message.type === 'memory-preview') {
    operation = message.operation;
    if (operation === 'correct' || operation === 'retract') nodeIds = [message.nodeId as string];
    if (operation === 'merge') { targetNodeId = message.targetNodeId; sourceNodeIds = message.sourceNodeIds ?? []; summary = message.summary; }
    if (operation === 'correct') summary = message.summary;
  } else if (message.type === 'memory-correct') {
    operation = 'correct'; nodeIds = [message.nodeId]; summary = message.summary;
  } else if (message.type === 'memory-merge') {
    operation = 'merge'; targetNodeId = message.targetNodeId; sourceNodeIds = message.sourceNodeIds;
  } else if (message.type === 'memory-retract') {
    operation = 'retract'; nodeIds = [message.nodeId];
  } else if (message.type === 'memory-reset') {
    operation = 'reset';
  } else {
    operation = 'export';
  }
  return {
    operation,
    scope: message.scope,
    expectedGraphVersion,
    nodeIds: operation === 'merge' ? [targetNodeId as string] : nodeIds,
    sourceNodeIds,
    ...(summary === undefined ? {} : { summary }),
    localOnly: message.type === 'memory-preview' ? message.localOnly !== false : true,
    providerBoundary: 'local',
    sessionId,
    projectId
  };
}

async function executeApprovedMemoryAction(memory: ContextGraphMemory, authorization: HostMemoryApprovalAuthorization, descriptor: MemoryApprovalDescriptor): Promise<unknown> {
  if (descriptor.operation === 'correct') return memory.correct({ scope: descriptor.scope, nodeId: descriptor.nodeIds[0], expectedGraphVersion: descriptor.expectedGraphVersion, summary: descriptor.summary as string, provenance: userMemoryProvenance(descriptor.summary as string), authoringActorId: 'user' }, authorization);
  if (descriptor.operation === 'merge') return memory.merge({ scope: descriptor.scope, targetNodeId: descriptor.nodeIds[0], sourceNodeIds: descriptor.sourceNodeIds, expectedGraphVersion: descriptor.expectedGraphVersion, ...(descriptor.summary === undefined ? {} : { summary: descriptor.summary }), provenance: userMemoryProvenance(`${descriptor.nodeIds[0]}:${descriptor.sourceNodeIds.join(',')}`), authoringActorId: 'user' }, authorization);
  if (descriptor.operation === 'retract') return memory.retract(descriptor.scope, descriptor.nodeIds[0], descriptor.expectedGraphVersion, authorization);
  if (descriptor.operation === 'reset') return memory.reset(descriptor.scope, descriptor.expectedGraphVersion, authorization);
  return memory.export(descriptor.scope, { expectedGraphVersion: descriptor.expectedGraphVersion, approval: authorization });
}

type MultimodalChatState = {
  intake?: MultimodalIntake;
  multimodal?: MultimodalOrchestrator;
  multimodalRoot?: string;
  multimodalProfileId?: string;
  multimodalAborts: Map<string, AbortController>;
  activity?: ActivityStore;
};

type GenerationChatState = { generation?: GenerationService; generationRoot?: string; generationProfileId?: string; generationAbort?: AbortController; activity?: ActivityStore; intake?: MultimodalIntake };

async function getMultimodalContext(root: string, auth: AuthService, state: MultimodalChatState) {
  const profiles = new ProfileStore(root, auth);
  const profile = await profiles.getActiveProfile();
  const selection = await profiles.getActiveSelection();
  if (!profile || !selection || profile.validation.status !== 'valid') throw new MultimodalOperationError('approval-required', 'Select and validate a project provider profile before using attachment operations.');
  const provider = await createNearAiProvider({ auth, profile, scope: profiles.getScope(selection.profileId) });
  const router = multimodalCatalogRouter(await provider.client.listModelsWithPricing());
  if (state.multimodal && state.multimodalRoot === root && state.multimodalProfileId === profile.profileId && state.intake) return { orchestrator: state.multimodal, router, profile, profiles };
  const privacy = new PrivacyPreflight();
  state.intake = state.intake ?? new MultimodalIntake(root, { privacy });
  state.activity = state.activity ?? new ActivityStore(root);
  const orchestrator = new MultimodalOrchestrator(root, {
    intake: state.intake,
    privacy,
    policyGate: new PolicyGate(defaultActionPolicy(), privacy),
    activity: state.activity,
    audit: new AuditStore(root),
    execute: hostMultimodalExecution
  });
  state.multimodal = orchestrator;
  state.multimodalRoot = root;
  state.multimodalProfileId = profile.profileId;
  return { orchestrator, router, profile, profiles };
}

function requireMultimodalOperation(orchestrator: MultimodalOrchestrator, operationId: string) {
  const operation = orchestrator.list().find((candidate) => candidate.operationId === operationId);
  if (!operation) throw new MultimodalOperationError('invalid-reference', 'Unknown multimodal operation.');
  return operation;
}

async function hostMultimodalExecution(input: MultimodalExecutionInput): Promise<MultimodalExecutionOutput> {
  if (input.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  if (input.route.providerBoundary !== 'local') throw new MultimodalOperationError('operation-not-supported', 'No documented host adapter is available for this provider boundary; cloud execution will not fall back locally.');
  const kind: MultimodalExecutionOutput['kind'] = input.operation === 'transcribe' ? 'transcript' : input.operation === 'extract' ? 'extracted-text' : input.operation === 'summarize' ? 'summary' : input.operation === 'inspect' ? 'thumbnail' : 'transformed';
  return { kind, label: `${kind} derived artifact`, safePreview: `${kind} derived from ${input.sourceArtifactIds.length} approved staged attachment(s)`, actualCostUsd: 0 };
}

async function getGenerationService(root: string, auth: AuthService, state: GenerationChatState): Promise<GenerationService> {
  const profiles = new ProfileStore(root, auth);
  const profile = await profiles.getActiveProfile();
  const selection = await profiles.getActiveSelection();
  if (!profile || !selection || profile.validation.status !== 'valid') throw new GenerationError('approval-required', 'Select and validate a project provider profile before using generation skills.');
  if (state.generation && state.generationRoot === root && state.generationProfileId === profile.profileId) return state.generation;
  const provider = await createNearAiProvider({ auth, profile, scope: profiles.getScope(selection.profileId) });
  const privacy = new PrivacyPreflight();
  state.activity = state.activity ?? new ActivityStore(root);
  const service = new GenerationService(root, {
    router: new CapabilityRouter({ catalog: await provider.client.listModelsWithPricing() }),
    adapters: [new NearAiGenerationAdapter(provider.client)],
    approval: new ApprovalService(new PolicyGate(defaultActionPolicy(), privacy), { audit: new AuditStore(root) }),
    activity: state.activity,
    intake: state.intake,
    privacy
  });
  state.generation = service;
  state.generationRoot = root;
  state.generationProfileId = profile.profileId;
  return service;
}

async function generationAttribution(root: string, auth: AuthService) {
  const profiles = new ProfileStore(root, auth);
  const profile = await profiles.getActiveProfile();
  if (!profile) throw new GenerationError('approval-required', 'The selected provider profile is unavailable.');
  return hostAttribution(profiles.projectScopeId, path.basename(root), profile.profileId, profile.organization);
}

async function loadCapabilityAwarePreview(preview: import('../domain/teamStudio').TeamPreview, auth: AuthService): Promise<import('./chatBridge').CapabilityAwareTeamPreview> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return capabilityAwareTeamPreview(preview);
  const profiles = new ProfileStore(root, auth);
  const active = await profiles.getActiveProfile();
  const selection = await profiles.getActiveSelection();
  if (!active || !selection || active.validation.status !== 'valid') return capabilityAwareTeamPreview(preview);
  try {
    const provider = await createNearAiProvider({ auth, profile: active, scope: profiles.getScope(selection.profileId) });
    const models = await provider.client.listModelsWithPricing();
    return capabilityAwareTeamPreview(preview, new CapabilityRouter({ catalog: models }));
  } catch {
    return capabilityAwareTeamPreview(preview);
  }
}

async function sendHistory(panel: ChatHost, store: ActivityStore | undefined): Promise<void> {
  panel.webview.postMessage({ type: 'history', sessions: store ? (await store.list()).map(sessionSummaryMessage) : [] });
}

async function sendArtifacts(panel: ChatHost): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  panel.webview.postMessage({ type: 'artifacts', artifacts: root ? await discoverGsdArtifacts(root) : [] });
}

async function sendStakingStatus(panel: ChatHost, staking: StakingService, refresh = false): Promise<void> {
  const status = refresh ? await staking.refreshStatus() : staking.getStatus();
  panel.webview.postMessage(walletStatusMessage(status));
}


const FULL_AUTO_CONFIRM = 'Switch to Full auto';

function policyConfiguration(): PolicyConfiguration {
  return vscode.workspace.getConfiguration('nearAi');
}

function sendPolicyState(panel: ChatHost): void {
  panel.webview.postMessage(policyStateMessage(policyConfiguration(), isEmergencyStopped()));
}

async function loadModels(panel: ChatHost, auth: AuthService): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  try {
    const active = root ? await activeProvider(root, auth) : undefined;
    panel.webview.postMessage({ type: 'models', models: active ? modelOptions(active.models, readSettings().defaultModel) : [] });
  } catch (error) {
    panel.webview.postMessage({ type: 'models-error', text: providerErrorMessage(error) });
  }
}

async function sendProfileStatus(panel: ChatHost, auth: AuthService, existing?: ProfileStore): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    panel.webview.postMessage({ type: 'profile-status', value: profileStatusMessage([], 'No workspace', undefined, false) });
    return;
  }
  const profiles = existing ?? new ProfileStore(root, auth);
  const exported = await profiles.exportMetadata();
  const active = exported.activeProfileId;
  const configured = active ? Boolean(await auth.getScopedApiKey(profiles.getScope(active))) : false;
  const value = profileStatusMessage(exported.profiles, exported.projectId, active, configured);
  panel.webview.postMessage({ type: 'profile-status', value });
}

/** The status line with today's spend from the key's ledger (or NEAR's total), and what the figure means. */
async function statusMessage(live: { agents: number; account?: SpendAccount }): Promise<{ type: 'status'; value: string; tooltip?: string }> {
  const account = live.account ?? shownSpendAccount();
  const today = account?.today();
  const shown = today && (today.near || today.totals.requests > 0) ? today : undefined;
  return { type: 'status', value: await readGsdStatusLine({ agents: live.agents, spend: shown?.text }), ...(shown ? { tooltip: shown.tooltip } : {}) };
}

async function readGsdStatusLine(live?: { agents: number; spend?: string }): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return 'No workspace';
  const statePath = path.join(root, '.planning', 'STATE.md');
  const roadmapPath = path.join(root, '.planning', 'ROADMAP.md');
  let line: string;
  try {
    const [state, roadmap] = await Promise.all([fs.readFile(statePath, 'utf8'), fs.readFile(roadmapPath, 'utf8')]);
    line = formatGsdStatusLine(statusSnapshot(parseGsdPlanningState(state, roadmap)));
  } catch {
    line = 'No GSD project yet · type /gsd-new-project to start · Agents 0';
  }
  if (!live?.spend) { const today = shownSpendAccount()?.today(); if (today && (today.near || today.totals.requests > 0)) live = { agents: live?.agents ?? 0, spend: today.text }; }
  return withLiveStatus(line, { agents: live?.agents ?? 0, spend: live?.spend });
}
