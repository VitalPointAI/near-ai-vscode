import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { formatGsdStatusLine, parseGsdPlanningState, statusSnapshot } from '../domain/gsdStatus';
import { GSD_COMMANDS } from '../domain/gsdCommands';
import { AuthService } from './auth';
import { createNearAiProvider } from './providerFactory';
import { ProfileStore } from './profileStore';
import { readSettings, shouldAutoInstallGsd } from './settings';
import { appendAssistantTurn, appendUserTurn, modelOptions, parseChatWebviewMessage, providerErrorMessage, ConversationTurn, discoverGsdArtifacts, isSafeArtifactPath, sessionSummaryMessage, promptMessage, promptResponseMatches, progressActivitySummary, progressCardMessage, GsdArtifactLink, profileStatusMessage, walletStatusMessage, walletPreviewMessage, walletHistoryMessage, walletErrorMessage, teamListMessage, teamPreviewMessage, teamStatusMessage, teamLifecycleMessage, teamInvocationStatusMessage, capabilityAwareTeamPreview, generationPreviewMessage, generationStatusMessage, generationPublicationMessage, memoryInspectMessage, memorySliceMessage, memoryApprovalPreviewMessage, multimodalStatusMessage, sanitizeContextGraphNode } from './chatBridge';
import type { ChatTeamMessage, ChatWebviewMessage, TeamWebviewMessage } from './chatBridge';
import { PromptResponse, StructuredPrompt } from '../domain/chatProgress';
import { GsdProgressEvent, GsdRunner } from './gsdRunner';
import { GsdUpdater } from './gsdUpdater';
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

export interface ChatHost {
  webview: vscode.Webview;
  onDidDispose: vscode.Event<void>;
}

/** Opens the full NEAR AI tools workspace (teams, memory, generation, analytics) in an editor tab. */
export async function openTools(context: vscode.ExtensionContext, auth: AuthService): Promise<void> {
  const panel = vscode.window.createWebviewPanel('nearAiTools', 'NEAR AI Tools', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  await initializeChat(context, auth, panel, withWalletStatusPanel(chatHtml2(panel.webview)));
}

export async function attachChatToView(context: vscode.ExtensionContext, auth: AuthService, view: vscode.WebviewView, html: string): Promise<void> {
  await initializeChat(context, auth, view, html);
}

async function initializeChat(context: vscode.ExtensionContext, auth: AuthService, panel: ChatHost, html: string, initialPrompt?: string, initialGsdCommand?: string): Promise<void> {
  const state = {
    abort: undefined as AbortController | undefined,
    model: readSettings().defaultModel,
    history: [] as ConversationTurn[],
    gsd: new GsdRunner(),
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
  };
  panel.webview.html = html;
  panel.webview.onDidReceiveMessage(async (value: unknown) => {
    const message = parseChatWebviewMessage(value);
    if (!message) return;
    if (message.type === 'stop') {
      state.abort?.abort();
      state.abort = undefined;
      state.gsd.cancel();
      panel.webview.postMessage({ type: 'assistant-cancelled', status: await readGsdStatusLine() });
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
    if (message.type === 'open-tools') {
      await vscode.commands.executeCommand('nearAi.openTools');
      return;
    }
    if (message.type === 'new-chat') {
      state.abort?.abort();
      state.abort = undefined;
      state.history = [];
      state.activeSessionId = undefined;
      state.prompt = undefined;
      return;
    }
    if (message.type === 'insert-code') {
      await insertIntoActiveEditor(message.text);
      return;
    }
    if (message.type === 'refresh-status') {
      panel.webview.postMessage({ type: 'status', value: await readGsdStatusLine() });
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
    if (message.type === 'prompt-choice' || message.type === 'prompt-answer' || message.type === 'prompt-cancel' || message.type === 'prompt-resume') {
      const response = message as PromptResponse;
      if (!promptResponseMatches(response, state.prompt) || state.activeSessionId !== response.sessionId) {
        panel.webview.postMessage({ type: 'prompt-error', text: 'That prompt is no longer active. Refresh the session and try again.' });
        return;
      }
      state.gsd.respond(response);
      if (response.type === 'prompt-cancel') {
        state.prompt = { ...state.prompt as StructuredPrompt, state: 'cancelled' };
        if (state.activity) await state.activity.append(response.sessionId, { status: 'cancelled', kind: 'session', summary: 'Structured prompt cancelled; prior session context retained.' });
      } else if (response.type === 'prompt-resume') {
        state.prompt = { ...state.prompt as StructuredPrompt, state: 'resumed' };
        if (state.activity) await state.activity.append(response.sessionId, { status: 'waiting', kind: 'session', summary: 'Structured prompt resumed from the existing session.' });
      } else {
        state.prompt = { ...state.prompt as StructuredPrompt, state: 'answered' };
        if (state.activity) await state.activity.append(response.sessionId, { status: 'running', kind: 'message', summary: 'Structured prompt response accepted; session context retained.' });
      }
      // The runner owns the process boundary. This typed message is the only value
      // sent back across it; no raw command or stored prompt is replayed by the UI.
      panel.webview.postMessage({ type: 'prompt-response-accepted', responseType: response.type, sessionId: response.sessionId, promptId: response.promptId });
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
    if (message.type === 'open-command') {
      const definition = GSD_COMMANDS.find((candidate) => candidate.command === message.command);
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (definition && root) { state.activity = state.activity ?? new ActivityStore(root); await ensureOpenGsd(root); await runGsdCommand(panel, state.gsd, definition.command, root, state.activity, (prompt) => { state.prompt = prompt; state.activeSessionId = prompt.sessionId; }); }
      else panel.webview.postMessage({ type: 'command-progress', state: 'failed', command: message.command, text: 'Open a workspace before running an Open-GSD workflow.' });
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
      await loadModels(panel, auth);
      return;
    }
    if (message.type !== 'send' || !message.text?.trim()) return;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const profiles = root ? new ProfileStore(root, auth) : undefined;
    const activeProfile = profiles ? await profiles.getActiveProfile() : undefined;
    const activeSelection = profiles ? await profiles.getActiveSelection() : undefined;
    if (!profiles || !activeProfile || !activeSelection || activeProfile.validation.status !== 'valid') {
      // Nothing is written here: a chat attempt before setup must not turn the workspace into a NEAR AI project.
      await sendProfileStatus(panel, auth, profiles);
      panel.webview.postMessage({ type: 'auth-required', text: 'Select and validate a named NEAR AI organization profile in Setup before chatting.' });
      return;
    }
    const model = message.model?.trim() || state.model;
    if (!model) { panel.webview.postMessage({ type: 'assistant-error', text: 'Choose a model from the list below the message box.' }); return; }
    state.model = model;
    state.abort?.abort();
    const abort = new AbortController();
    state.abort = abort;
    let provider;
    try {
      provider = await createNearAiProvider({ auth, profile: activeProfile, scope: profiles.getScope(activeSelection.profileId) });
    } catch (error) {
      state.providerProfileId = undefined;
      panel.webview.postMessage({ type: 'auth-required', text: providerErrorMessage(error) });
      return;
    }
    state.providerProfileId = provider.profileId;
    const client = provider.client;
    if (root) {
      state.activity = state.activity ?? new ActivityStore(root);
      const attribution = hostAttribution(profiles.projectScopeId, path.basename(root), activeProfile.profileId, activeProfile.organization);
      const session = await state.activity.start({ project: path.basename(root), attribution, model, summary: 'Chat session started.' });
      state.activeSessionId = session.sessionId;
      await state.activity.append(session.sessionId, { status: 'running', kind: 'message', model, summary: 'User message received.' });
    }
    state.history = appendUserTurn(state.history, message.text);
    panel.webview.postMessage({ type: 'assistant-start', model, status: await readGsdStatusLine() });
    let assistantText = '';
    try {
      for await (const event of client.streamChatEvents(model, state.history, abort.signal)) {
        if (state.abort !== abort) break;
        if (event.type === 'text') {
          assistantText += event.text;
          panel.webview.postMessage({ type: 'assistant-delta', text: event.text, status: await readGsdStatusLine() });
        } else if (event.type === 'status' && event.status === 'started') {
          if (state.activity && state.activeSessionId) await state.activity.append(state.activeSessionId, { status: 'running', kind: 'model', model, requestId: event.metadata.requestId, summary: 'Provider request started.' });
        } else if (event.type === 'done') {
          let metadata = event.metadata;
          if (metadata.requestId && metadata.actualCostUsd === undefined) {
            try {
              const reconciled = await client.reconcileUsage(metadata.requestId, abort.signal);
              metadata = { ...metadata, ...reconciled, estimatedCostUsd: metadata.estimatedCostUsd };
            } catch {
              // Provider reporting is best effort; unavailable actuals remain unavailable.
            }
          }
          state.history = appendAssistantTurn(state.history, assistantText);
          if (state.activity && state.activeSessionId) await state.activity.append(state.activeSessionId, { status: 'completed', kind: 'message', model, requestId: metadata.requestId, summary: 'Assistant response completed.', estimatedCostUsd: metadata.estimatedCostUsd, actualCostUsd: metadata.actualCostUsd, inputTokens: metadata.inputTokens, outputTokens: metadata.outputTokens, durationMs: metadata.latencyMs });
          panel.webview.postMessage({ type: 'assistant-done', usage: metadata });
          if (state.activity) await sendHistory(panel, state.activity);
        } else if (event.type === 'status' && event.status === 'cancelled') {
          if (state.activity && state.activeSessionId) await state.activity.append(state.activeSessionId, { status: 'cancelled', summary: 'Chat request cancelled by the user.' });
          panel.webview.postMessage({ type: 'assistant-cancelled', status: await readGsdStatusLine() });
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        if (state.activity && state.activeSessionId) await state.activity.append(state.activeSessionId, { status: 'failed', summary: 'Chat request failed.', errorCode: error instanceof Error ? error.name : 'unknown' });
        panel.webview.postMessage({ type: 'assistant-error', text: providerErrorMessage(error) });
      }
    } finally {
      if (state.abort === abort) state.abort = undefined;
    }
  }, undefined, context.subscriptions);
  panel.onDidDispose(() => state.abort?.abort(), undefined, context.subscriptions);
  if (initialPrompt) panel.webview.postMessage({ type: 'prefill', text: initialPrompt });
  panel.webview.postMessage({ type: 'status', value: await readGsdStatusLine() });
  panel.webview.postMessage({ type: 'commands', commands: GSD_COMMANDS });
  await sendArtifacts(panel);
  state.activity = createActivityStore();
  await sendHistory(panel, state.activity);
  await sendProfileStatus(panel, auth);
  await sendStakingStatus(panel, state.staking);
  await loadModels(panel, auth);
  if (initialGsdCommand) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) { state.activity = state.activity ?? new ActivityStore(root); await ensureOpenGsd(root); await runGsdCommand(panel, state.gsd, initialGsdCommand, root, state.activity, (prompt) => { state.prompt = prompt; state.activeSessionId = prompt.sessionId; }); }
  }
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

/** Running an Open-GSD command from the extension is what makes a workspace a NEAR AI project, so a missing runtime is installed only here. */
async function ensureOpenGsd(root: string): Promise<void> {
  if (shouldAutoInstallGsd()) await new GsdUpdater(undefined, root).ensureInstalled();
}

export async function runGsdCommand(panel: ChatHost, runner: GsdRunner, command: string, root: string, activity: ActivityStore, onPrompt?: (prompt: StructuredPrompt) => void): Promise<void> {
  const session = await activity.start({ project: path.basename(root), plans: [command], summary: `Open-GSD /${command} started.` });
  try {
    let progressIndex = 0;
    let activityWrites = Promise.resolve();
    await runner.run(command, root, (event: GsdProgressEvent) => {
      const card = progressCardMessage({ ...event, sessionId: session.sessionId, phase: command }, progressIndex++);
      panel.webview.postMessage({ type: 'progress-card', card });
      panel.webview.postMessage({ type: 'command-progress', ...event, sessionId: session.sessionId });
      activityWrites = activityWrites.then(async () => { await activity.append(session.sessionId, { status: event.state === 'completed' ? 'completed' : event.state === 'cancelled' ? 'cancelled' : event.state === 'failed' ? 'failed' : event.state === 'waiting' ? 'waiting' : 'running', kind: event.state === 'waiting' || card.approvalRequired ? 'approval' : 'tool', approvalRequired: card.approvalRequired === true || event.state === 'waiting', summary: progressActivitySummary(card), phase: card.phase, tool: card.tool, action: card.action, model: card.model, agentId: card.agent, agentCount: card.agentCount, attempt: card.attempt, retry: card.retry, plan: command }); });
      const parsedPrompt = promptMessage((event as GsdProgressEvent & { prompt?: unknown }).prompt);
      const runtimePrompt = parsedPrompt ? { ...parsedPrompt, sessionId: session.sessionId } : undefined;
      if (runtimePrompt) { onPrompt?.(runtimePrompt); panel.webview.postMessage({ type: 'structured-prompt', prompt: runtimePrompt }); }
      if (event.state === 'completed' || event.state === 'failed' || event.state === 'cancelled') {
        void readGsdStatusLine().then((value) => panel.webview.postMessage({ type: 'status', value }));
        void sendArtifacts(panel);
      }
    });
    await activityWrites;
    await sendHistory(panel, activity);
  } catch (error) {
    await activity.append(session.sessionId, { status: 'failed', summary: 'Open-GSD command could not be started.' });
    panel.webview.postMessage({ type: 'command-progress', state: 'failed', command, text: error instanceof Error ? error.message : 'Open-GSD could not be started.' });
    await sendHistory(panel, activity);
  }
}

function createActivityStore(): ActivityStore | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? new ActivityStore(root) : undefined;
}

function projectIdForWorkspace(root: string): string { return `project-${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 32)}`; }
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

function withWalletStatusPanel(html: string): string {
  const panel = '<section aria-labelledby="wallet-entitlement-heading" data-wallet-status="unavailable"><h2 id="wallet-entitlement-heading">Wallet entitlement</h2><p>Unavailable — verified staking configuration is not supplied; stake-changing actions are disabled.</p><p>Connect only an external wallet when verified network and entitlement configuration is available. This extension never reads local wallet credential files.</p></section>';
  return html.replace('</header>', `${panel}</header>`);
}

async function loadModels(panel: ChatHost, auth: AuthService): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const profiles = root ? new ProfileStore(root, auth) : undefined;
  const activeProfile = profiles ? await profiles.getActiveProfile() : undefined;
  const activeSelection = profiles ? await profiles.getActiveSelection() : undefined;
  if (!profiles || !activeProfile || !activeSelection || activeProfile.validation.status !== 'valid') {
    panel.webview.postMessage({ type: 'models', models: [] });
    return;
  }
  try {
    const provider = await createNearAiProvider({ auth, profile: activeProfile, scope: profiles.getScope(activeSelection.profileId) });
    const models = await provider.client.listModelsWithPricing();
    panel.webview.postMessage({ type: 'models', models: modelOptions(models, readSettings().defaultModel) });
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

async function readGsdStatusLine(): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return 'No workspace · GSD not initialized · Agents 0';
  const statePath = path.join(root, '.planning', 'STATE.md');
  const roadmapPath = path.join(root, '.planning', 'ROADMAP.md');
  try {
    const [state, roadmap] = await Promise.all([fs.readFile(statePath, 'utf8'), fs.readFile(roadmapPath, 'utf8')]);
    return formatGsdStatusLine(statusSnapshot(parseGsdPlanningState(state, roadmap)));
  } catch {
    return 'GSD not initialized · Run setup to begin · Agents 0';
  }
}

function chatHtml2(_webview?: vscode.Webview): string {
  const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:18px}button,select,textarea,input{font:inherit}button{margin:4px;padding:6px 9px}.messages{max-width:900px;margin:12px auto}.msg,.progress-card,.prompt-card{padding:10px;margin:8px 0;border:1px solid var(--vscode-panel-border);white-space:pre-wrap}.progress-card[data-state="failed"]{border-color:var(--vscode-errorForeground)}.progress-card[data-state="completed"]{border-color:var(--vscode-testing-iconPassed)}.label{font-size:11px;color:var(--vscode-descriptionForeground);text-transform:uppercase}.status{color:var(--vscode-descriptionForeground);margin:8px 0}.artifact-list{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0 14px}.artifact-list button{font-size:12px}.history-list{max-height:180px;overflow:auto;border:1px solid var(--vscode-panel-border);padding:6px;margin:6px 0 12px}.history-item{display:flex;justify-content:space-between;gap:8px;align-items:center;border-bottom:1px solid var(--vscode-panel-border);padding:5px}.composer{display:flex;gap:8px;max-width:900px;margin:auto}.composer textarea{flex:1;min-height:54px}.near{color:#ffb81c} @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important;scroll-behavior:auto!important}}
  </style></head><body><header><h1 class="near">Near AI · Open-GSD</h1><div id="status" class="status" aria-live="polite">Loading project status…</div><div id="motion" class="status" aria-live="polite">Ready</div></header><section id="team-studio" aria-labelledby="team-studio-heading"><h2 id="team-studio-heading">Reusable team studio</h2><p>Host derives project identity, binding, provider, model, capabilities, privacy, and cost; this panel only sends the team and version you choose.</p><p id="team-status" aria-live="polite">Loading reusable teams…</p><div id="team-list" role="list"></div><div id="team-preview" aria-live="polite"></div></section><section aria-labelledby="attachments-heading"><h2 id="attachments-heading">Local attachments</h2><p id="attachment-status" aria-live="polite">Raw media stays local until an explicit approved operation.</p><div id="attachments" role="list"></div><button id="attach" type="button">Attach local file</button><label for="multimodal-operation">Attachment operation</label><select id="multimodal-operation"><option value="inspect">Inspect metadata</option><option value="summarize">Summarize</option><option value="transcribe">Transcribe audio/video</option><option value="extract">Extract text</option><option value="transform">Transform</option></select><button id="multimodal-prepare" type="button">Prepare approved attachment operation</button><div id="multimodal-operations" aria-live="polite" aria-atomic="false"></div></section><section><strong>Planning artifacts</strong><div id="artifacts" class="artifact-list"></div></section><section><strong>Session history</strong><div id="history" class="history-list" aria-live="polite">No recorded sessions yet.</div></section><section><input id="search" aria-label="Search Open-GSD commands" placeholder="Search Open-GSD commands…"><div id="commands"></div></section><main id="messages" class="messages"><div class="msg">Choose an Open-GSD workflow or send a provider message.</div></main><div class="composer"><textarea id="input" aria-label="Message" placeholder="Describe your project or ask what to do next…"></textarea><button id="send">Send</button><button id="stop" disabled>Stop</button><select id="model" aria-label="Model"><option value="">Loading models…</option></select></div><script nonce="${nonce}">
  const vscode=acquireVsCodeApi(),messages=document.getElementById('messages'),input=document.getElementById('input'),status=document.getElementById('status'),motion=document.getElementById('motion'),commands=document.getElementById('commands'),search=document.getElementById('search'),artifacts=document.getElementById('artifacts'),history=document.getElementById('history'),model=document.getElementById('model'),send=document.getElementById('send'),stop=document.getElementById('stop'),attach=document.getElementById('attach'),attachmentStatus=document.getElementById('attachment-status'),attachments=document.getElementById('attachments'),multimodalOperation=document.getElementById('multimodal-operation'),multimodalPrepare=document.getElementById('multimodal-prepare'),multimodalOperations=document.getElementById('multimodal-operations');let definitions=[],current,active=false,promptState,analyticsFilter={limit:50},stagedAttachments=new Map();
  const memorySection=document.createElement('section');memorySection.setAttribute('aria-labelledby','memory-heading');memorySection.innerHTML='<h2 id="memory-heading">Scoped context memory</h2><p id="memory-help">Private agent and collective team memory are separate, local-first evidence graphs. Inspect the equivalent keyboard table; conflicts, stale facts, provenance, and scope remain visible.</p><div><label>Scope kind <select id="memory-scope-kind" aria-label="Memory scope kind"><option value="private-agent">Private agent</option><option value="team-collective">Team collective</option><option value="project">Project</option><option value="shared">Explicit shared</option></select></label><label>Scope ID <input id="memory-scope-id" aria-label="Memory scope ID" maxlength="160"></label><button id="memory-inspect" type="button">Inspect memory</button></div><div><label>Search graph <input id="memory-search" aria-label="Search graph" maxlength="160"></label><button id="memory-search-button" type="button">Search</button><label>Task slice <input id="memory-task" aria-label="Task slice description" maxlength="480"></label><button id="memory-slice" type="button">Preview task slice</button></div><p id="memory-status" aria-live="polite">No graph selected.</p><div id="memory-table" role="region" aria-label="Memory graph table" tabindex="0">Use Inspect memory to load a bounded outline.</div>';document.querySelector('header')?.after(memorySection);const memoryKind=document.getElementById('memory-scope-kind'),memoryId=document.getElementById('memory-scope-id'),memoryStatus=document.getElementById('memory-status'),memoryTable=document.getElementById('memory-table');function memoryScope(){return {kind:memoryKind.value,id:memoryId.value.trim()}}function renderMemoryPreview(preview){memoryStatus.textContent=preview.scope.kind+' · '+preview.scope.id+' · graph version '+preview.graphVersion+' · '+preview.counts.nodes+' nodes · '+preview.counts.edges+' edges · local-only '+preview.localOnly;memoryTable.replaceChildren();const table=document.createElement('table');table.setAttribute('aria-label','Memory nodes and provenance');const head=document.createElement('thead');head.innerHTML='<tr><th scope="col">Type</th><th scope="col">Label</th><th scope="col">Scope</th><th scope="col">Confidence</th><th scope="col">Freshness</th><th scope="col">Provenance</th><th scope="col">State</th></tr>';table.appendChild(head);const body=document.createElement('tbody');(preview.nodes||[]).forEach(node=>{const row=document.createElement('tr');[node.type,node.label,node.scope.kind+':'+node.scope.id,node.confidence.toFixed(2),node.freshness.decayed?'stale/decayed':'current',node.provenance.kind+':'+node.provenance.sourceId,node.state+(node.conflict.status==='conflicted'?' · conflict':'')].forEach(value=>{const cell=document.createElement('td');cell.textContent=String(value);row.appendChild(cell)});body.appendChild(row)});table.appendChild(body);const outline=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Accessible outline and edge details';outline.appendChild(summary);const list=document.createElement('ul');(preview.accessibleOutline||[]).forEach(value=>{const item=document.createElement('li');item.textContent=value;list.appendChild(item)});outline.appendChild(list);memoryTable.append(table,outline)}document.getElementById('memory-inspect').onclick=()=>vscode.postMessage({type:'memory-inspect',scope:memoryScope(),localOnly:true});document.getElementById('memory-search-button').onclick=()=>vscode.postMessage({type:'memory-search',scope:memoryScope(),query:document.getElementById('memory-search').value});document.getElementById('memory-slice').onclick=()=>vscode.postMessage({type:'memory-slice-preview',task:document.getElementById('memory-task').value,scopes:[memoryScope()],projectId:memoryKind.value==='project'?memoryId.value.trim():undefined,agentId:memoryKind.value==='private-agent'?memoryId.value.trim():undefined,teamId:memoryKind.value==='team-collective'?memoryId.value.trim():undefined,sharedId:memoryKind.value==='shared'?memoryId.value.trim():undefined,localOnly:true});
  const generationStudio=document.createElement('section');generationStudio.setAttribute('aria-labelledby','generation-heading');generationStudio.innerHTML='<h2 id="generation-heading">Image and video generation</h2><p>Only current provider-advertised capabilities can run. Review model, privacy, attribution, estimate, and approval before dispatch.</p><button id="preview-image" type="button">Preview image generation</button><button id="preview-video" type="button">Preview video generation</button><div id="generation-review" class="history-list" aria-live="polite">No generation requested.</div>';document.querySelector('header').after(generationStudio);const generationReview=document.getElementById('generation-review'),previewImage=document.getElementById('preview-image'),previewVideo=document.getElementById('preview-video');let generationPreview;function generationRequest(operation){const prompt=input.value.trim();if(!prompt){generationReview.textContent='Enter a prompt in the composer before requesting a review.';return}vscode.postMessage({type:'generation-preview',operation,model:model.value,prompt})}previewImage.onclick=()=>generationRequest('image-generation');previewVideo.onclick=()=>generationRequest('video-generation');function renderGenerationPreview(preview){generationPreview=preview;generationReview.replaceChildren();const facts=document.createElement('div');facts.textContent=preview.operation+' · '+preview.provider+'/'+preview.model+' · '+preview.privacyBoundary+' · '+preview.providerBoundary+' · estimate '+(preview.estimatedCost?('$'+preview.estimatedCost.amountUsd.toFixed(2)+' '+preview.estimatedCost.basis):'unavailable')+' · '+preview.attribution.organizationDisplayName+' / '+preview.attribution.projectLabel;const approve=document.createElement('button');approve.type='button';approve.textContent='Approve exact generation';approve.onclick=()=>vscode.postMessage({type:'generation-start',operationId:preview.operationId,approvalFingerprint:preview.approval.approvalFingerprint,explicit:true});generationReview.append(facts,approve)}function renderGenerationStatus(operation){generationReview.replaceChildren();const facts=document.createElement('div');facts.textContent=operation.operation+' · '+operation.provider+'/'+operation.model+' · '+operation.status+(operation.usage?.actualCostUsd===undefined?'':' · actual $'+operation.usage.actualCostUsd.toFixed(2))+(operation.publication?' · publication '+operation.publication:'');generationReview.append(facts);if(operation.status==='completed'&&operation.artifactId){const destination=document.createElement('input');destination.placeholder='workspace-relative publication path';destination.maxLength=240;destination.setAttribute('aria-label','Publication destination');const review=document.createElement('button');review.type='button';review.textContent='Review publication';review.onclick=()=>vscode.postMessage({type:'generation-publication-preview',operationId:operation.operationId,destination:destination.value});generationReview.append(destination,review)}if(['queued','in-progress'].includes(operation.status)){const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel generation';cancel.onclick=()=>vscode.postMessage({type:'generation-cancel',operationId:operation.operationId});generationReview.append(cancel)}}function renderPublicationPreview(preview){generationReview.replaceChildren();const facts=document.createElement('div');facts.textContent='Publish '+preview.artifactId+' to workspace path '+preview.destination+' · separate approval required';const approve=document.createElement('button');approve.type='button';approve.textContent='Approve publication';approve.onclick=()=>vscode.postMessage({type:'generation-publish',operationId:preview.operationId,publicationFingerprint:preview.approval.approvalFingerprint,explicit:true});generationReview.append(facts,approve)}
  attach.onclick=()=>vscode.postMessage({type:'attachment-select'});function renderAttachments(){attachments.replaceChildren();stagedAttachments.forEach(preview=>{const row=document.createElement('div');row.textContent=preview.label+' · '+preview.modality+' · '+preview.byteSize+' bytes · '+preview.lifecycle+' · '+(preview.privacy.localOnly?'local-only':'provider boundary pending');const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Remove attachment';cancel.setAttribute('aria-label','Remove attachment '+preview.label);cancel.onclick=()=>vscode.postMessage({type:'attachment-cancel',artifactId:preview.artifactId});row.appendChild(cancel);attachments.appendChild(row)})}function renderMultimodalStatus(operation){multimodalOperations.replaceChildren();const card=document.createElement('article');card.tabIndex=-1;card.setAttribute('aria-live','polite');card.setAttribute('aria-label','Attachment operation '+operation.status);const text=document.createElement('p');text.textContent=operation.operation+' · '+operation.status+' · '+operation.route.providerBoundary+'/'+operation.route.provider+' · '+operation.route.model+' · source '+operation.sourceArtifactIds.length+' · derived '+operation.derivedArtifactIds.length+(operation.reason?' · '+operation.reason:'');card.appendChild(text);if(operation.approval){const approve=document.createElement('button');approve.type='button';approve.textContent='Approve exact attachment operation';approve.onclick=()=>vscode.postMessage({type:'multimodal-approve',operationId:operation.operationId,approvalFingerprint:operation.approval.approvalFingerprint,explicit:true});card.appendChild(approve)}if(operation.status==='paused'||operation.reason==='restart-requires-approval'){const recover=document.createElement('button');recover.type='button';recover.textContent='Recover attachment operation';recover.onclick=()=>vscode.postMessage({type:'multimodal-recover',operationId:operation.operationId});card.appendChild(recover)}if(!['completed','failed','cancelled','budget-blocked'].includes(operation.status)){const cancelOperation=document.createElement('button');cancelOperation.type='button';cancelOperation.textContent='Cancel attachment operation';cancelOperation.onclick=()=>vscode.postMessage({type:'multimodal-cancel',operationId:operation.operationId});card.appendChild(cancelOperation)}multimodalOperations.appendChild(card);card.focus()}multimodalPrepare.onclick=()=>{const sourceArtifactIds=[...stagedAttachments.keys()].slice(0,8);if(!sourceArtifactIds.length){attachmentStatus.textContent='Attachment operation unavailable · stage a local attachment first';return}vscode.postMessage({type:'multimodal-prepare',operation:multimodalOperation.value,sourceArtifactIds})}
  const fleetSection=document.createElement('section');fleetSection.setAttribute('aria-labelledby','fleet-heading');fleetSection.innerHTML='<strong id="fleet-heading">Live agent fleet and analytics</strong><div><label>Organization profile <input id="analytics-profile" aria-label="Filter by organization profile" maxlength="80"></label><label>Workspace project <input id="analytics-project" aria-label="Filter by workspace project" maxlength="80"></label><button id="fleet-refresh" type="button">Refresh analytics</button><button id="fleet-export" type="button">Export filtered analytics</button><label><input id="quiet-mode" type="checkbox"> Quiet presentation</label></div><div id="fleet" class="history-list" aria-live="polite">No analytics loaded.</div>';document.querySelector('header').after(fleetSection);const fleet=document.getElementById('fleet'),analyticsProfile=document.getElementById('analytics-profile'),analyticsProject=document.getElementById('analytics-project');
  const teamList=document.getElementById('team-list'),teamStatus=document.getElementById('team-status'),teamPreview=document.getElementById('team-preview');let selectedTeamId,selectedTeamVersion;function renderTeams(teams){teamList.replaceChildren();if(!teams.length){teamList.textContent='No reusable teams saved yet.';return}teams.forEach(team=>{const card=document.createElement('article');card.setAttribute('role','listitem');const title=document.createElement('strong');title.textContent=team.displayName+' · v'+team.currentVersion;const description=document.createElement('p');description.textContent=team.description||'Bounded role team';const preview=document.createElement('button');preview.type='button';preview.textContent='Preview';preview.setAttribute('aria-label','Preview '+team.displayName+' version '+team.currentVersion);preview.onclick=()=>{selectedTeamId=team.teamId;selectedTeamVersion=team.currentVersion;vscode.postMessage({type:'team-preview',teamId:team.teamId,version:team.currentVersion})};card.append(title,description,preview);teamList.appendChild(card)})}function renderTeamPreview(preview){teamPreview.replaceChildren();const heading=document.createElement('h3');heading.textContent=preview.displayName+' · exact '+preview.versionId;const facts=document.createElement('p');facts.textContent='Privacy: '+preview.privacyBoundary+' · estimated request $'+preview.estimatedRequestUsd.toFixed(2)+' · project budget $'+preview.estimatedProjectUsd.toFixed(2);const members=document.createElement('ul');preview.members.forEach(member=>{const row=document.createElement('li');row.textContent=member.role+' · '+member.responsibilities.join(', ')+' · '+member.route.locality+'/'+member.route.provider+(member.route.model?' · '+member.route.model:'')+' · approval '+member.approval;members.appendChild(row)});const capabilityStatus=document.createElement('div');capabilityStatus.setAttribute('aria-live','polite');capabilityStatus.textContent='Capability metadata: '+((preview.capabilityRoutes||[]).some(route=>route.status==='refresh-required')?'refresh required':'reviewing current provider declarations');(preview.capabilityRoutes||[]).forEach(route=>{const item=document.createElement('p');item.textContent=route.role+' · skills '+route.skills.join(', ')+' · '+route.status+' · '+route.locality+'/'+route.provider+(route.model?' · '+route.model:'')+' · readiness '+route.readiness+' · metadata '+route.freshness+' · pricing '+route.pricing+' · privacy '+route.privacyBoundary+(route.reasons.length?' · '+route.reasons.join(', '):'');capabilityStatus.appendChild(item)});const bind=document.createElement('button');bind.type='button';bind.textContent='Bind exact version to this project';bind.onclick=()=>vscode.postMessage({type:'team-bind',teamId:preview.teamId,version:preview.version});teamPreview.append(heading,facts,members,capabilityStatus,bind)}window.addEventListener('message',event=>{const message=event.data;if(message.type==='team-list')renderTeams(message.teams||[]);if(message.type==='team-preview')renderTeamPreview(message.preview);if(message.type==='team-status'){const binding=message.value?.binding;teamStatus.textContent=binding?'Bound to '+binding.teamDisplayName+' · '+binding.versionId+' · '+binding.privacyBoundary:'No reusable team is bound to this project.';renderTeams(message.value?.teams||[])}if(message.type==='team-error')teamStatus.textContent=message.text});vscode.postMessage({type:'team-list'});vscode.postMessage({type:'team-status'});
  function add(text,label){const el=document.createElement('div');el.className='msg';const head=document.createElement('div');head.className='label';head.textContent=label;const body=document.createElement('div');body.textContent=text;el.append(head,body);messages.appendChild(el);messages.scrollTop=messages.scrollHeight;return body}
  function renderCommands(){commands.replaceChildren();const q=search.value.toLowerCase().trim();definitions.filter(x=>!q||[x.command,x.title,x.category,x.description].some(v=>v.toLowerCase().includes(q))).slice(0,8).forEach(x=>{const b=document.createElement('button');b.textContent=x.title;b.title='/'+x.command+' · '+x.description;b.onclick=()=>vscode.postMessage({type:'open-command',command:x.command});commands.appendChild(b)})}
  search.oninput=renderCommands;send.onclick=()=>{const text=input.value.trim();if(!text||active)return;add(text,'You');input.value='';vscode.postMessage({type:'send',text,model:model.value})};stop.onclick=()=>vscode.postMessage({type:'stop'});function refreshAnalytics(){analyticsFilter={limit:50,...(analyticsProfile.value.trim()?{organizationProfileId:analyticsProfile.value.trim()}:{}),...(analyticsProject.value.trim()?{projectId:analyticsProject.value.trim()}: {})};vscode.postMessage({type:'load-analytics',filter:analyticsFilter})}function renderFleet(result){fleet.replaceChildren();const c=result.counts||{};const counts=document.createElement('div');counts.textContent=['deployed','active','waiting','completed','failed','cancelled'].map(k=>k+': '+(c[k]||0)).join(' · ');fleet.appendChild(counts);(result.agents||[]).forEach(a=>{const row=document.createElement('button');row.type='button';row.textContent=a.label+' · '+a.task+' · '+(a.tokens===undefined?'tokens unavailable':a.tokens+' tokens')+' · '+(a.estimatedCostUsd===undefined?'estimate unavailable':'est. $'+a.estimatedCostUsd)+(a.actualCostUsd===undefined?' · actual unavailable':' · actual $'+a.actualCostUsd);row.setAttribute('aria-label','Inspect agent '+a.agentId);row.onclick=()=>vscode.postMessage({type:'agent-drill-down',agentId:a.agentId});fleet.appendChild(row)});const summary=document.createElement('div');summary.textContent='Estimated $'+(result.cost?.estimatedUsd===undefined?'unavailable':result.cost.estimatedUsd)+' · Actual $'+(result.cost?.actualUsd===undefined?'unavailable':result.cost.actualUsd)+' · latency '+(result.latency?.averageMs===undefined?'unavailable':result.latency.averageMs+'ms avg')+' · models '+Object.keys(result.models||{}).join(', ');fleet.appendChild(summary);(result.cost?.groups||[]).forEach(g=>{const group=document.createElement('div');group.textContent=g.attribution.organizationDisplayName+' · '+g.attribution.projectLabel+' · estimated '+(g.estimatedUsd===undefined?'unavailable':g.estimatedUsd)+' · actual '+(g.actualUsd===undefined?'unavailable':g.actualUsd);fleet.appendChild(group)});(result.timeline||[]).forEach(e=>{const item=document.createElement('div');item.textContent=new Date(e.timestamp).toLocaleTimeString()+' · '+e.label;fleet.appendChild(item)})}document.getElementById('fleet-refresh').onclick=refreshAnalytics;document.getElementById('fleet-export').onclick=()=>{refreshAnalytics();vscode.postMessage({type:'export-analytics',filter:analyticsFilter})};document.getElementById('analytics-profile').onchange=refreshAnalytics;document.getElementById('analytics-project').onchange=refreshAnalytics;document.getElementById('quiet-mode').onchange=e=>vscode.postMessage({type:'set-quiet-mode',quiet:e.target.checked});
  function renderCard(card){const el=document.createElement('article');el.className='progress-card';el.dataset.state=card.state;el.setAttribute('aria-live',card.live);el.setAttribute('aria-label','Progress: '+card.state);const title=document.createElement('strong');title.textContent=(card.phase?card.phase+' · ':'')+card.action+' · '+card.state;const body=document.createElement('div');body.textContent=card.summary;el.append(title,body);if(card.tool){const meta=document.createElement('small');meta.textContent='Tool: '+card.tool;el.append(meta)}if(card.model){const meta=document.createElement('small');meta.textContent='Model: '+card.model;el.append(meta)}if(card.agent||card.agentCount!==undefined){const meta=document.createElement('small');meta.textContent='Agent: '+(card.agent||'active')+(card.agentCount===undefined?'':' · '+card.agentCount+' total');el.append(meta)}if(card.attempt!==undefined||card.retry){const meta=document.createElement('small');meta.textContent='Attempt: '+(card.attempt||1)+(card.retry?' · retry':'');el.append(meta)}if(card.approvalRequired){const meta=document.createElement('small');meta.textContent='Approval required';el.append(meta)}if(card.recovery){const recovery=document.createElement('div');recovery.textContent=card.recovery;el.append(recovery)}messages.appendChild(el);messages.scrollTop=messages.scrollHeight}
  function renderPrompt(prompt){promptState=prompt;const el=document.createElement('section');el.className='prompt-card';el.setAttribute('aria-labelledby','prompt-'+prompt.promptId);const heading=document.createElement('h2');heading.id='prompt-'+prompt.promptId;heading.textContent='Open-GSD needs your input';const question=document.createElement('p');question.textContent=prompt.question;el.append(heading,question);prompt.choices.forEach(choice=>{const b=document.createElement('button');b.type='button';b.textContent=choice.label;b.setAttribute('aria-describedby','prompt-'+prompt.promptId);b.onclick=()=>{vscode.postMessage({type:'prompt-choice',sessionId:prompt.sessionId,promptId:prompt.promptId,choiceId:choice.id});el.remove()};el.append(b)});if(prompt.freeForm?.enabled){const form=document.createElement('form');const field=document.createElement('textarea');field.required=true;field.maxLength=prompt.freeForm.maxLength||4000;field.placeholder=prompt.freeForm.placeholder||'Type a response';field.setAttribute('aria-label',prompt.freeForm.label||'Your response');const answer=document.createElement('button');answer.type='submit';answer.textContent='Answer';form.append(field,answer);form.onsubmit=e=>{e.preventDefault();if(!field.value.trim())return;vscode.postMessage({type:'prompt-answer',sessionId:prompt.sessionId,promptId:prompt.promptId,text:field.value});el.remove()};el.append(form)}const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel prompt';cancel.onclick=()=>{vscode.postMessage({type:'prompt-cancel',sessionId:prompt.sessionId,promptId:prompt.promptId});el.remove()};el.append(cancel);messages.appendChild(el);el.scrollIntoView({behavior:'smooth',block:'nearest'})}
  function renderHistory(sessions){history.replaceChildren();if(!sessions.length){history.textContent='No recorded sessions yet. Activity is stored locally without raw prompts.';return}sessions.forEach(s=>{const row=document.createElement('div');row.className='history-item';const label=document.createElement('span');label.textContent=(s.phase||s.project)+' · '+s.outcome+' · '+new Date(s.updatedAt).toLocaleString();const reopen=document.createElement('button');reopen.textContent='Reopen';reopen.onclick=()=>vscode.postMessage({type:'reopen-session',sessionId:s.sessionId});row.append(label,reopen);if(s.continuationAvailable){const cont=document.createElement('button');cont.textContent='Continue';cont.onclick=()=>vscode.postMessage({type:'continue-session',sessionId:s.sessionId});row.appendChild(cont)}history.appendChild(row)})}
  window.addEventListener('message',e=>{const m=e.data;if(m.type==='attachment-staged'){stagedAttachments.set(m.preview.artifactId,m.preview);renderAttachments();attachmentStatus.textContent='Staged locally · metadata only';}if(m.type==='attachment-cancelled'){stagedAttachments.delete(m.preview.artifactId);renderAttachments();attachmentStatus.textContent='Attachment removed locally';}if(m.type==='attachment-error'){attachmentStatus.textContent='Attachment unavailable · '+m.code;}if(m.type==='multimodal-status')renderMultimodalStatus(m.operation);if(m.type==='multimodal-approval-required'){attachmentStatus.textContent='Exact attachment approval required · '+m.preview.operation+' · '+m.preview.providerBoundary;}if(m.type==='multimodal-error'){multimodalOperations.textContent='Attachment operation unavailable · '+m.code+' · '+m.text;}if(m.type==='analytics')renderFleet(m.result);if(m.type==='analytics-export'){const blob=new Blob([m.data],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='near-ai-analytics.json';a.click();URL.revokeObjectURL(url)}});
  vscode.postMessage({type:'load-analytics',filter:analyticsFilter});window.addEventListener('message',e=>{const m=e.data;if(m.type==='memory-inspect')renderMemoryPreview(m.preview);if(m.type==='memory-search'){memoryStatus.textContent='Search returned '+(m.nodes||[]).length+' bounded nodes; inspect the graph for provenance and conflicts.'}if(m.type==='memory-slice-preview'){memoryStatus.textContent='Task slice '+m.slice.sliceId+' · '+m.slice.factIds.length+' facts · '+m.slice.scopes.map(s=>s.kind+':'+s.id).join(', ')+' · '+m.slice.privacy.providerBoundary+' boundary'}if(m.type==='memory-error'){memoryStatus.textContent='Memory unavailable · '+m.code+' · '+m.text}});window.addEventListener('message',e=>{const m=e.data;if(m.type==='generation-preview')renderGenerationPreview(m.preview);if(m.type==='generation-status')renderGenerationStatus(m.operation);if(m.type==='generation-publication-preview')renderPublicationPreview(m.preview);if(m.type==='generation-error'){generationReview.textContent='Generation unavailable · '+m.code+' · '+m.text}});
  window.addEventListener('message',e=>{const m=e.data;if(m.type==='commands'){definitions=m.commands||[];renderCommands()}if(m.type==='status')status.textContent=m.value;if(m.type==='artifacts'){artifacts.replaceChildren();(m.artifacts||[]).forEach(x=>{const b=document.createElement('button');b.textContent=x.kind==='directory'?x.label+' (open folder)':x.label;b.setAttribute('aria-label',x.kind==='directory'?'Open current GSD phase directory '+x.label:'Open '+x.label);b.onclick=()=>vscode.postMessage({type:'open-artifact',path:x.path,kind:x.kind});artifacts.appendChild(b)})}if(m.type==='history'){renderHistory(m.sessions||[])}if(m.type==='history-error'){history.textContent=m.text}if(m.type==='session-reopened'){add('Reopened '+m.session.project+' · '+m.session.outcome+'. No stored command was replayed.','Session context')}if(m.type==='models'){model.replaceChildren();(m.models||[]).forEach(x=>{const o=document.createElement('option');o.value=x.id;o.textContent=x.label;model.appendChild(o)})}if(m.type==='progress-card'){renderCard(m.card);active=!['completed','failed','cancelled'].includes(m.card.state);motion.textContent=m.card.summary}if(m.type==='structured-prompt'){active=true;renderPrompt(m.prompt);motion.textContent='Waiting — your input is required'}if(m.type==='prompt-error'){add(m.text,'Error');motion.textContent='Needs attention'}if(m.type==='assistant-start'){active=true;stop.disabled=false;send.disabled=true;current=add('',m.model);motion.textContent='Reasoning — preparing a response'}if(m.type==='assistant-delta'&&current){current.textContent+=m.text;motion.textContent='Streaming — receiving the response'}if(m.type==='assistant-done'||m.type==='assistant-cancelled'){active=false;stop.disabled=true;send.disabled=false;motion.textContent=m.type==='assistant-done'?'Complete':'Waiting — stopped safely'}if(m.type==='assistant-error'){active=false;stop.disabled=true;send.disabled=false;add(m.text,'Error');motion.textContent='Needs attention'}if(m.type==='command-progress'){if(m.state==='started'||m.state==='running')active=true;if(m.state==='completed'||m.state==='failed'||m.state==='cancelled'){active=false;stop.disabled=true;send.disabled=false}}});vscode.postMessage({type:'load-models'});vscode.postMessage({type:'refresh-status'});vscode.postMessage({type:'history'});
  </script></body></html>`;
  return html.replace('</script></body></html>', () => `</script>${panelLayoutEnhancementHtml(nonce)}${memoryExplorerEnhancementHtml(nonce)}${teamStudioEnhancementHtml(nonce)}</body></html>`);
}

function panelLayoutEnhancementHtml(nonce: string): string {
  return `<style nonce="${nonce}">
  :root{color-scheme:light dark}
  body{box-sizing:border-box;padding:0 12px 12px;background:var(--vscode-sideBar-background,var(--vscode-editor-background));font-size:var(--vscode-font-size);line-height:1.45}
  header{position:sticky;top:0;z-index:4;padding:10px 2px 8px;background:var(--vscode-sideBar-background,var(--vscode-editor-background));border-bottom:1px solid var(--vscode-panel-border)}
  header h1{margin:0;font-size:13px;font-weight:600;letter-spacing:.01em;color:var(--vscode-foreground)}
  header .near{color:var(--vscode-foreground)}
  .status{margin:3px 0 0;font-size:11px;color:var(--vscode-descriptionForeground)}
  body>section:not(#messages),body>details{max-width:720px;margin:8px auto}
  details.advanced-section{border:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);}
  details.advanced-section>summary{cursor:pointer;list-style:none;padding:8px 10px;color:var(--vscode-foreground);font-weight:500}
  details.advanced-section>summary::-webkit-details-marker{display:none}
  details.advanced-section>summary:before{content:'›';display:inline-block;width:16px;color:var(--vscode-descriptionForeground);transition:transform .1s ease}
  details.advanced-section[open]>summary:before{transform:rotate(90deg)}
  details.advanced-section>section{margin:0;padding:0 10px 10px;border:0}
  section h2{font-size:12px;margin:6px 0;color:var(--vscode-foreground)}
  section p{font-size:12px;color:var(--vscode-descriptionForeground);margin:5px 0 8px}
  .messages{max-width:720px;min-height:220px;margin:10px auto 0;padding:0 2px;overflow:auto}
  .msg,.progress-card,.prompt-card{border:0;border-bottom:1px solid var(--vscode-panel-border);border-radius:0;padding:10px 2px;margin:0;white-space:pre-wrap}
  .msg:first-child{border-top:0}
  .label{font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);text-transform:none;margin-bottom:3px}
  .composer{position:sticky;bottom:0;z-index:3;display:flex;flex-wrap:wrap;gap:6px;max-width:720px;margin:10px auto 0;padding:8px 0 0;background:var(--vscode-sideBar-background,var(--vscode-editor-background));border-top:1px solid var(--vscode-panel-border)}
  .composer textarea{box-sizing:border-box;flex:1 1 100%;min-height:64px;resize:vertical;padding:8px;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:2px;color:var(--vscode-input-foreground);background:var(--vscode-input-background)}
  button,select,input{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:2px;padding:4px 8px}
  button:hover{background:var(--vscode-button-hoverBackground)}
  select,input{color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border))}
  .composer #send{margin-left:auto}
  .artifact-list{margin:4px 0;gap:4px}.history-list{max-height:180px;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border)}
  @media(prefers-reduced-motion:reduce){*{transition:none!important}}
  </style>`;
}

/** Test-only seam for executing the production chat webview scripts without opening a panel. */
export function chatWebviewHtmlForTest(): string {
  return chatHtml2();
}

function memoryExplorerEnhancementHtml(nonce: string): string {
  return `<script nonce="${nonce}">
  (()=>{const wrap=(section,title)=>{if(!section||section.closest('details'))return;const details=document.createElement('details');details.className='advanced-section';const summary=document.createElement('summary');summary.textContent=title;details.appendChild(summary);section.parentNode.insertBefore(details,section);details.appendChild(section)};document.querySelectorAll('body>section').forEach(section=>{if(section.id==='messages')return;const heading=section.querySelector('h2,strong');wrap(section,heading?.textContent?.trim()||'More tools')})})();
  const memoryActions=document.createElement('section');memoryActions.id='memory-actions';memoryActions.setAttribute('aria-labelledby','memory-actions-heading');const memoryActionsHeading=document.createElement('h3');memoryActionsHeading.id='memory-actions-heading';memoryActionsHeading.textContent='Memory actions require an exact host preview';memoryActions.appendChild(memoryActionsHeading);
  const correctionLabel=document.createElement('label');correctionLabel.textContent='Correction summary ';const correction=document.createElement('input');correction.id='memory-correction-summary';correction.maxLength=480;correction.setAttribute('aria-label','Bounded correction summary');correctionLabel.appendChild(correction);memoryActions.appendChild(correctionLabel);
  function memoryButton(label,handler){const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('aria-label',label);button.onclick=handler;memoryActions.appendChild(button);return button}
  let currentPreview, selectedNodeIds=new Set(), lastFocused, selectedEdgeId, currentApprovalFingerprint;
  function readMemoryScope(){return {kind:document.getElementById('memory-scope-kind').value,id:document.getElementById('memory-scope-id').value.trim()}}
  function selectedIds(){return [...selectedNodeIds].filter(id=>id)}
  function preview(operation,values={}){if(!currentPreview){memoryStatus.textContent='Inspect a graph before requesting a memory action.';return}lastFocused=document.activeElement;vscode.postMessage({type:'memory-preview',operation,scope:readMemoryScope(),expectedGraphVersion:currentPreview.graphVersion,localOnly:true,...values})}
  memoryButton('Preview correction',()=>preview('correct',{nodeId:selectedIds()[0],summary:correction.value.trim()}));
  memoryButton('Preview merge of selected nodes',()=>{const ids=selectedIds();if(ids.length<2){memoryStatus.textContent='Select at least two nodes before previewing a merge.';return}preview('merge',{targetNodeId:ids[0],sourceNodeIds:ids.slice(1)})});
  memoryButton('Preview retraction',()=>preview('retract',{nodeId:selectedIds()[0]}));
  memoryButton('Preview reset graph',()=>preview('reset'));
  memoryButton('Preview local export',()=>preview('export'));
  memoryTable.parentElement.insertBefore(memoryActions,memoryTable);
  const filterSection=document.createElement('fieldset');filterSection.id='memory-filters';const filterLegend=document.createElement('legend');filterLegend.textContent='Filter bounded graph';filterSection.appendChild(filterLegend);
  function filterSelect(labelText,id,values){const label=document.createElement('label');label.textContent=labelText+' ';const select=document.createElement('select');select.id=id;select.setAttribute('aria-label',labelText);values.forEach(value=>{const option=document.createElement('option');option.value=value;option.textContent=value==='all'?'All':value;select.appendChild(option)});label.appendChild(select);filterSection.appendChild(label);return select}
  const typeFilter=filterSelect('Node type','memory-filter-type',['all','fact','actor','function','capability','artifact','task']);const stateFilter=filterSelect('Record state','memory-filter-state',['all','active','corrected','merged','retracted']);const scopeFilter=filterSelect('Scope kind','memory-filter-scope',['all','private-agent','team-collective','project','shared']);
  [typeFilter,stateFilter,scopeFilter].forEach(select=>select.onchange=()=>{if(currentPreview){renderGraph(currentPreview);renderMemoryTable(currentPreview)}});memoryTable.parentElement.insertBefore(filterSection,memoryActions);
  const graph=document.createElement('section');graph.id='memory-graph';graph.setAttribute('aria-labelledby','memory-graph-heading');const graphHeading=document.createElement('h3');graphHeading.id='memory-graph-heading';graphHeading.textContent='Interactive memory graph';graph.appendChild(graphHeading);const graphHelp=document.createElement('p');graphHelp.textContent='Use Tab and Enter on a node to select it. The table and outline below remain the accessible fallback.';graph.appendChild(graphHelp);const graphCanvas=document.createElement('div');graphCanvas.setAttribute('role','group');graphCanvas.setAttribute('aria-label','Interactive context graph');graph.appendChild(graphCanvas);memoryTable.parentElement.insertBefore(graph,memoryTable);
  function nodeLabel(node){return node.type+' '+node.label+'; confidence '+node.confidence.toFixed(2)+'; '+(node.freshness.decayed?'stale or decayed':'fresh')+'; provenance '+node.provenance.kind+'; '+(node.conflict.status==='conflicted'?'conflicted':'no conflict')}
  function filteredNodes(preview){return (preview.nodes||[]).filter(node=>(typeFilter.value==='all'||node.type===typeFilter.value)&&(stateFilter.value==='all'||node.state===stateFilter.value)&&(scopeFilter.value==='all'||node.scope.kind===scopeFilter.value)).slice(0,48)}
  function edgeLabel(edge){return edge.type+' relationship; '+edge.polarity+' tension; weight '+edge.weight.toFixed(2)+'; state '+edge.state+'; scope '+edge.scope.kind+':'+edge.scope.id+'; '+(edge.conflict.status==='conflicted'?'conflicted':'no conflict')}
  function showSelectionDetails(label){const details=document.getElementById('memory-selection-details')||document.createElement('p');details.id='memory-selection-details';details.setAttribute('aria-live','polite');details.textContent=label;graphCanvas.parentElement.appendChild(details)}
  function renderGraph(preview){currentPreview=preview;graphCanvas.replaceChildren();const nodes=filteredNodes(preview),nodeIds=new Set(nodes.map(node=>node.nodeId)),edges=(preview.edges||[]).filter(edge=>nodeIds.has(edge.fromNodeId)&&nodeIds.has(edge.toNodeId)).slice(0,96);const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 720 420');svg.setAttribute('role','img');svg.setAttribute('aria-label','Interactive graph of '+nodes.length+' bounded memory nodes');const positions=new Map();nodes.forEach((node,index)=>{const x=90+(index%6)*120,y=70+Math.floor(index/6)*70;positions.set(node.nodeId,{x,y})});edges.forEach(edge=>{const from=positions.get(edge.fromNodeId),to=positions.get(edge.toNodeId);if(!from||!to)return;const line=document.createElementNS('http://www.w3.org/2000/svg','line');line.setAttribute('x1',String(from.x));line.setAttribute('y1',String(from.y));line.setAttribute('x2',String(to.x));line.setAttribute('y2',String(to.y));line.setAttribute('stroke',edge.polarity==='negative'?'var(--vscode-errorForeground)':'var(--vscode-descriptionForeground)');line.setAttribute('stroke-width',String(Math.max(1,Math.abs(edge.weight)*3)));line.setAttribute('role','button');line.setAttribute('tabindex','0');line.setAttribute('aria-label',edgeLabel(edge));line.dataset.edgeId=edge.edgeId;const selectEdge=()=>{selectedEdgeId=edge.edgeId;showSelectionDetails('Selected edge '+edgeLabel(edge));};line.onclick=selectEdge;line.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectEdge()}});svg.appendChild(line)});nodes.forEach((node,index)=>{const position=positions.get(node.nodeId);const group=document.createElementNS('http://www.w3.org/2000/svg','g');group.setAttribute('tabindex','0');group.setAttribute('role','button');group.setAttribute('aria-label',nodeLabel(node)+'; scope '+node.scope.kind+':'+node.scope.id+'; state '+node.state);group.setAttribute('transform','translate('+position.x+' '+position.y+')');group.dataset.nodeId=node.nodeId;const circle=document.createElementNS('http://www.w3.org/2000/svg','circle');circle.setAttribute('r','24');circle.setAttribute('fill',selectedNodeIds.has(node.nodeId)?'var(--near)':'var(--vscode-button-background)');circle.setAttribute('stroke',node.conflict.status==='conflicted'?'var(--vscode-errorForeground)':'var(--vscode-panel-border)');const text=document.createElementNS('http://www.w3.org/2000/svg','text');text.setAttribute('text-anchor','middle');text.setAttribute('dy','4');text.textContent=String(index+1);group.append(circle,text);const select=()=>{if(selectedNodeIds.has(node.nodeId))selectedNodeIds.delete(node.nodeId);else selectedNodeIds.add(node.nodeId);renderGraph(preview);renderMemoryTable(preview);showSelectionDetails('Selected node '+nodeLabel(node))};group.onclick=select;group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select()}});svg.appendChild(group)});graphCanvas.appendChild(svg);showSelectionDetails(selectedEdgeId?'Selected edge '+selectedEdgeId:'Select a graph node or edge to inspect its bounded details.')}
  function renderMemoryTable(preview){memoryTable.replaceChildren();const table=document.createElement('table');table.setAttribute('aria-label','Memory nodes with provenance confidence freshness tension and conflict');const head=document.createElement('thead');const headerRow=document.createElement('tr');['Select','Type','Label','Scope','Confidence','Freshness','Provenance','Conflict'].forEach(value=>{const cell=document.createElement('th');cell.scope='col';cell.textContent=value;headerRow.appendChild(cell)});head.appendChild(headerRow);table.appendChild(head);const body=document.createElement('tbody');filteredNodes(preview).forEach(node=>{const row=document.createElement('tr');const selectCell=document.createElement('td');const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=selectedNodeIds.has(node.nodeId);checkbox.setAttribute('aria-label','Select memory node '+node.label);checkbox.onchange=()=>{if(checkbox.checked)selectedNodeIds.add(node.nodeId);else selectedNodeIds.delete(node.nodeId);renderGraph(preview)};selectCell.appendChild(checkbox);row.appendChild(selectCell);[node.type,node.label,node.scope.kind+':'+node.scope.id,node.confidence.toFixed(2),node.freshness.decayed?'stale or decayed':'fresh',node.provenance.kind+':'+node.provenance.sourceId,node.state+(node.conflict.status==='conflicted'?' · conflict':' · no conflict')].forEach(value=>{const cell=document.createElement('td');cell.textContent=String(value);row.appendChild(cell)});body.appendChild(row)});table.appendChild(body);const outline=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Accessible outline fallback with edge tension details';outline.appendChild(summary);const list=document.createElement('ul');(preview.accessibleOutline||[]).forEach(value=>{const item=document.createElement('li');item.textContent=value;list.appendChild(item)});(preview.edges||[]).filter(edge=>filteredNodes(preview).some(node=>node.nodeId===edge.fromNodeId||node.nodeId===edge.toNodeId)).forEach(edge=>{const item=document.createElement('li');item.textContent=edgeLabel(edge);list.appendChild(item)});outline.appendChild(list);memoryTable.append(table,outline)}
  function renderApproval(preview){currentPreview={...currentPreview,graphVersion:preview.expectedGraphVersion};currentApprovalFingerprint=preview.approvalFingerprint;const region=document.getElementById('memory-approval-preview')||document.createElement('section');region.id='memory-approval-preview';region.setAttribute('aria-live','assertive');region.replaceChildren();const heading=document.createElement('h3');heading.textContent='Exact memory approval preview';const facts=document.createElement('p');facts.textContent=preview.operation+' · '+preview.scope.kind+':'+preview.scope.id+' · graph version '+preview.expectedGraphVersion+' · '+(preview.localOnly?'local-only':'provider boundary '+preview.providerBoundary)+' · expires '+preview.expiresAt;const bounded=document.createElement('p');bounded.textContent='Bounded target IDs '+preview.nodeIds.join(', ')+(preview.sourceNodeIds.length?' · source IDs '+preview.sourceNodeIds.join(', '):'')+(preview.summaryLength===undefined?'':' · correction digest '+preview.summaryDigest.slice(0,16)+' · '+preview.summaryLength+' characters');const approve=document.createElement('button');approve.type='button';approve.textContent='Approve exact memory action once';approve.setAttribute('aria-label','Approve exact '+preview.operation+' memory action once');approve.onclick=()=>{if(!currentApprovalFingerprint)return;const fingerprint=currentApprovalFingerprint;currentApprovalFingerprint=undefined;approve.disabled=true;memoryStatus.textContent='Pending approval confirmation for '+preview.operation+'; awaiting host result.';vscode.postMessage({type:'memory-approve',approvalFingerprint:fingerprint,explicit:true})};region.append(heading,facts,bounded,approve);memoryActions.appendChild(region);approve.focus()}
  window.addEventListener('message',event=>{const message=event.data;if(message.type==='memory-inspect'){currentPreview=message.preview;selectedEdgeId=undefined;renderGraph(message.preview);renderMemoryTable(message.preview)}if(message.type==='memory-approval-preview')renderApproval(message.preview);if(message.type==='memory-updated'){memoryStatus.textContent='Memory action committed at graph version '+message.graphVersion+'. Refreshing the bounded graph.';lastFocused?.focus();document.getElementById('memory-inspect').click()}if(message.type==='memory-export'){memoryStatus.textContent='Local memory export is ready; no provider boundary was used.';const blob=new Blob([message.data],{type:'application/json'});const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download='near-ai-memory-export.json';anchor.click();URL.revokeObjectURL(url);lastFocused?.focus()}if(message.type==='memory-error'){memoryStatus.textContent='Memory action unavailable · '+message.code+' · '+message.text;memoryStatus.focus();lastFocused?.focus()}});
  </script>`;
}

function teamStudioEnhancementHtml(nonce: string): string {
  return `<script nonce="${nonce}">
  const studio=document.getElementById('team-studio'),teamActionStatus=document.createElement('p');teamActionStatus.id='team-action-status';teamActionStatus.tabIndex=-1;teamActionStatus.setAttribute('aria-live','assertive');studio.appendChild(teamActionStatus);
  const lifecycle=document.createElement('form');lifecycle.setAttribute('aria-labelledby','team-lifecycle-heading');const heading=document.createElement('h3');heading.id='team-lifecycle-heading';heading.textContent='Complete reusable team lifecycle';lifecycle.appendChild(heading);
  function teamField(labelText,id,type){const label=document.createElement('label');label.textContent=labelText+' ';const input=document.createElement('input');input.id=id;input.type=type||'text';input.maxLength=type==='number'?2:480;input.setAttribute('aria-label',labelText);label.appendChild(input);lifecycle.appendChild(label);return input}
  const name=teamField('Team name','team-name'),description=teamField('Team description','team-description'),id=teamField('Team ID','team-id'),version=teamField('Exact team version','team-version','number'),task=teamField('Invocation task','team-task');
  const role=document.createElement('select');role.id='team-role';role.setAttribute('aria-label','Team member role');['planner','implementer','reviewer','security','tester','researcher'].forEach(value=>{const option=document.createElement('option');option.value=value;option.textContent=value;role.appendChild(option)});const roleLabel=document.createElement('label');roleLabel.textContent='Member role ';roleLabel.appendChild(role);lifecycle.appendChild(roleLabel);
  const action=document.createElement('select');action.id='team-action';action.setAttribute('aria-label','Invocation action capability');['plan','read','workspaceWrite','mediaGeneration'].forEach(value=>{const option=document.createElement('option');option.value=value;option.textContent=value;action.appendChild(option)});const actionLabel=document.createElement('label');actionLabel.textContent='Invocation action ';actionLabel.appendChild(action);lifecycle.appendChild(actionLabel);
  const packageLabel=document.createElement('label');packageLabel.textContent='Team package JSON ';const packageInput=document.createElement('textarea');packageInput.id='team-package-json';packageInput.maxLength=100000;packageInput.setAttribute('aria-label','Team package JSON for import or export');packageLabel.appendChild(packageInput);lifecycle.appendChild(packageLabel);
  const note=document.createElement('p');note.textContent='Exact version, provider/model capability, privacy boundary, route, project binding, and cost are host-derived. Webview fields are requests only.';lifecycle.appendChild(note);
  function button(labelText,handler,submit){const button=document.createElement('button');button.type=submit?'submit':'button';button.textContent=labelText;button.setAttribute('aria-label',labelText);button.onclick=handler;lifecycle.appendChild(button)}
  function member(){const skills=role.value==='implementer'?['read','plan','write']:['read','plan'];return {memberId:'member-studio0001',role:role.value,responsibilities:['Complete the assigned role within the accepted team.'],skillIds:skills,capabilities:skills,tools:['read','plan'],providerRoute:{provider:'near-ai',locality:'local',privacyBoundary:'local'},personality:{personality:'professional',tone:'concise',style:'structured'},autonomy:'bounded',approval:{mode:'risky',capabilities:['read']},budget:{requestUsd:1,sessionUsd:5,projectUsd:20,maxDurationMs:3600000}}}
  lifecycle.onsubmit=event=>{event.preventDefault();vscode.postMessage({type:'team-create',displayName:name.value,description:description.value,members:[member()]})};button('Create team',()=>{},true);button('Update team',()=>vscode.postMessage({type:'team-update',teamId:id.value,displayName:name.value,description:description.value}));button('Duplicate team',()=>vscode.postMessage({type:'team-duplicate',teamId:id.value,displayName:name.value}));button('Archive team',()=>vscode.postMessage({type:'team-archive',teamId:id.value}));button('Restore team',()=>vscode.postMessage({type:'team-restore',teamId:id.value}));button('Delete team',()=>{if(window.confirm('Delete this reusable team?'))vscode.postMessage({type:'team-delete',teamId:id.value})});button('Preview exact version',()=>vscode.postMessage({type:'team-select-version',teamId:id.value,version:Number(version.value)}));button('Bind exact version',()=>vscode.postMessage({type:'team-bind',teamId:id.value,version:Number(version.value)}));button('Import team package',()=>vscode.postMessage({type:'team-import',packageJson:packageInput.value}));button('Export team package',()=>vscode.postMessage({type:'team-export',teamId:id.value}));button('Invoke exact version',()=>vscode.postMessage({type:'team-invoke',teamId:id.value,version:Number(version.value),role:role.value,task:task.value,requiredCapabilities:role.value==='implementer'?['write']:['read'],actionCapability:action.value}));studio.insertBefore(lifecycle,document.getElementById('team-list'));
  window.addEventListener('message',event=>{const message=event.data;if(message.type==='team-lifecycle'){teamActionStatus.textContent=message.message;teamActionStatus.focus()}if(message.type==='team-export'){packageInput.value=message.packageJson;teamActionStatus.textContent='Exported bounded team package; review the JSON before saving it.';teamActionStatus.focus()}if(message.type==='team-invocation-status'){const value=message.value;teamActionStatus.textContent='Invocation '+value.status+' · exact '+value.versionId+' · '+(value.locality||'host route')+'/'+(value.provider||'provider unavailable')+' · model '+(value.model||'unavailable')+' · privacy '+(value.privacyBoundary||'host-derived')+' · cost '+(value.estimatedCostUsd===undefined?'unavailable':'$'+value.estimatedCostUsd.toFixed(2))+(value.reason?' · '+value.reason:'');teamActionStatus.focus()}if(message.type==='team-status'&&message.value?.binding){id.value=message.value.binding.teamId;version.value=String(message.value.binding.teamVersion);teamActionStatus.textContent='Bound exact '+message.value.binding.versionId+' · '+message.value.binding.privacyBoundary+' privacy boundary'}if(message.type==='team-error'){teamActionStatus.textContent='Team operation unavailable · '+message.text;teamActionStatus.focus()}});
  </script>`;
}
