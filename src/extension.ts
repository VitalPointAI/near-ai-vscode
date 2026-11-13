import * as vscode from 'vscode';
import { redactSecrets } from './domain/redaction';
import { homeFolder, startTeamsMove } from './domain/teamStorage';
import { migrateTeams } from './services/teamStorage';
import { cleanScratch, ensureScratch } from './services/scratch';
import { isNearAiProject } from './gsd/runtime';
import { saveHandoff } from './services/handoff';
import { AuthService } from './services/auth';
import { ProfileStore } from './services/profileStore';
import { apiKeyCopyHooks } from './services/stateApiKey';
import { editorWriter, stateHomeFor } from './services/stateHome';
import { stateKeysFor } from './services/stateKeys';
import { initProfileIndex, listSavedProfiles, runUseSavedProfile } from './services/profileIndex';
import { GsdRuntime, startRuntimeUpdates } from './gsd/runtime';
import { readAgentLimits, readModelTiers, readSettings, shouldAutoInstallGsd } from './services/settings';
import { activeProvider } from './services/providerCache';
import { modelOptions } from './services/chatBridge';
import { chatHandoff, runApprovedCommand } from './services/cyberHandoff';
import { panelCyberRunStarter } from './services/cyberAssembly';
import { openOnboarding } from './services/onboarding';
import { registerAgentActivity } from './services/activityView';
import { registerRunReport } from './services/runReportCommand';
import { registerResearchVerifiers } from './services/researchProfileCommand';
import { registerUsageExport } from './services/usageExport';
import { registerSecurityScanning } from './services/securityScan';
import { registerWebSearchSetup } from './services/webSearchSetup';
import { registerSpendingLimits } from './services/spendingLimits';
import { registerSpendTracking } from './services/spendTracking';
import { registerMcpConnections } from './services/mcpView';
import { openTools } from './services/toolsPage';
import { openCyberPanel } from './services/cyberPanel';
import { cyberPanelService } from './services/cyberService';
import { registerModelComparison } from './services/modelComparisonPanel';
import { openTeamStudio } from './services/teamStudioPanel';
import { historyItems, LOCKED_DETAIL, threadStoreFor } from './services/threadStore';
import { chooseGsdCommand } from './services/gsdCommands';
import { NearAiPanelViewProvider } from './services/panelView';
import { deriveProfileId } from './domain/auth';
import { isSecureEndpoint } from './domain/config';
import { registerChatParticipant } from './services/chatParticipant';
import { openThreadInPanel } from './services/participantRecorder';
import { registerWorkspaceCommands } from './services/workspaceCommands';
import { initEmergencyStop, isEmergencyStopped, setEmergencyStop } from './services/emergencyStop';
import { clearProviderCache } from './services/providerCache';
import { setNearAiDiagnostics } from './services/nearAiClient';
import { closeInterruptedRuns } from './services/activityStore';
import { offerProxyAdvice } from './domain/proxyAdvice';
import { offerNextStep, registerNewProfile, registerProjectSetup } from './services/setupMenu';

/** Returned only to the extension-host tests, which set NEAR_AI_E2E=1. */
export interface NearAiTestApi { auth: AuthService; sidebar: NearAiPanelViewProvider }

export function activate(context: vscode.ExtensionContext): NearAiTestApi | undefined {
  const auth = new AuthService(context.secrets);
  // Teams a person made in Team Studio now live in their home folder, so an uninstall or another VS Code keeps them (0.4.18). The one-time move of
  // the ones saved under the extension's storage must finish before anything reads the library, or a person who opens Team Studio at once sees an
  // empty list; every reader calls whenTeamsMoved() first, and a move that fails never throws.
  startTeamsMove(migrateTeams({ home: homeFolder(), globalStorage: context.globalStorageUri.fsPath }).catch(() => ({ moved: 0, skipped: 0 })));
  // Scratch work stays inside the project and leaves nothing behind (0.4.18): the folder and its .gitignore lines, and anything a killed run left.
  // Only for a project the person has actually set up (.planning/.near-ai exists), because opening a folder must still write nothing into it: that is
  // the promise the plain e2e checks. Each project is handled on its own, so nothing is shared between projects and nothing is global.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath;
    void isNearAiProject(root)
      .then((nearAi) => (nearAi ? ensureScratch(root).then(() => cleanScratch(root, { staleOnlyMs: 6 * 60 * 60 * 1000 })) : undefined))
      .catch(() => undefined);
  }
  // The computer-wide list of saved profiles (metadata only), so a profile set up in one project can be used in another (G-61-9).
  initProfileIndex(context.globalState);
  initEmergencyStop(context);
  // NEAR AI errors and rate-limit headers (status, model, request ID, Retry-After, NEAR's message), never keys or prompts.
  const nearLog = vscode.window.createOutputChannel('NEAR AI');
  setNearAiDiagnostics((line) => nearLog.appendLine(`[${new Date().toISOString()}] ${line}`));
  context.subscriptions.push(nearLog, { dispose: () => setNearAiDiagnostics(undefined) });
  // A second editor on this computer uses this project's NEAR AI key from its sealed copy in the project's state home, with no prompt (D-15). Nothing
  // is created here: the state home appears only when a key is saved, so opening a folder still writes nothing.
  const keyCopyRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (keyCopyRoot) {
    auth.keyCopy = apiKeyCopyHooks({
      projectScopeId: new ProfileStore(keyCopyRoot).projectScopeId,
      home: stateHomeFor(keyCopyRoot),
      keys: stateKeysFor(keyCopyRoot, context.secrets, () => vscode.workspace.getConfiguration('nearAi').get<boolean>('sync.keepKeyInProject', true)),
      log: (line) => nearLog.appendLine(`[${new Date().toISOString()}] ${line}`)
    });
  }
  if (shouldAutoInstallGsd()) {
    void startRuntimeUpdates(new GsdRuntime(context.globalStorageUri.fsPath), vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, (message, failed) => {
      void (failed ? vscode.window.showWarningMessage(message) : vscode.window.showInformationMessage(message));
    }).then((updates) => { if (updates) context.subscriptions.push(updates); });
  }

  // A reload cut off any run still marked running in this project's history: record it as stopped.
  const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (projectRoot) void closeInterruptedRuns(projectRoot, editorWriter(context.globalState));

  // In code-server and remote windows, suggest turning off VS Code's proxy support when no proxy is
  // used: a background browser tab otherwise stalls agent runs. Asked once; changed only on the click.
  void suggestProxySupportOff(context);

  const sidebar = new NearAiPanelViewProvider(context, auth);
  registerAgentActivity(context, sidebar);
  registerUsageExport(context);
  registerSecurityScanning(context);
  registerWebSearchSetup(context);
  registerSpendTracking(context, auth);
  registerSpendingLimits(context, auth);
  registerMcpConnections(context);
  registerModelComparison(context, auth);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NearAiPanelViewProvider.viewId, sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('nearAi.setup', () => openOnboarding(context, {
      openApiKeyPortal: () => openApiKeyPortal(),
      configureApiKey: () => configureApiKey(context, auth, sidebar),
      showProgress: () => showStatus(auth)
    })),
    vscode.commands.registerCommand('nearAi.status', () => showStatus(auth)),
    vscode.commands.registerCommand('nearAi.selectProfile', () => selectProfile(context, auth, sidebar)),
    vscode.commands.registerCommand('nearAi.removeProfile', () => removeProfile(auth, sidebar)),
    vscode.commands.registerCommand('nearAi.useSavedProfile', () => useSavedProfile(context, auth, sidebar)),
    vscode.commands.registerCommand('nearAi.emergencyStop', async () => {
      await setEmergencyStop(true);
      void vscode.window.showWarningMessage('NEAR AI emergency stop is on. Running requests and workflows were stopped (in other open windows within a few seconds), and nothing more will be sent until you resume.', 'Resume').then((choice) => { if (choice) void vscode.commands.executeCommand('nearAi.resume'); });
    }),
    vscode.commands.registerCommand('nearAi.resume', async () => {
      await setEmergencyStop(false);
      void vscode.window.showInformationMessage('NEAR AI resumed.');
    }),
    vscode.commands.registerCommand('nearAi.openChat', () => vscode.commands.executeCommand(`${NearAiPanelViewProvider.viewId}.focus`)),
    vscode.commands.registerCommand('nearAi.newChat', () => sidebar.newChat()),
    vscode.commands.registerCommand('nearAi.openTools', () => openTools(context, auth, sidebar)),
    vscode.commands.registerCommand('nearAi.openCyber', () => openCyberPanel(context, cyberPanelService(context, {
      // The provider profile is keyed by the workspace root, not by globalStorage: passing the store
      // path here found no profile and reported "no model is reachable" while chat worked fine.
      startRun: panelCyberRunStarter(context, (root) => activeProvider(root, auth).then((active) => active?.provider.client), {
        root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        model: readModelTiers().standard,
        stopped: () => isEmergencyStopped(),
        // Every ask goes to the same approval card the chat uses, so a shell or exploit step is
        // never silently allowed.
        requestApproval: async (step) => {
          const label = `${step.action}: ${step.tool} on ${step.target}`;
          const answer = await vscode.window.showInformationMessage(label, { modal: true, detail: step.expectedResult }, 'Run it', 'Skip');
          return answer === 'Run it' ? { decision: 'allow' as const } : { decision: 'deny' as const, reason: 'The user skipped this step.' };
        }
      }),
      handToChat: (input) => chatHandoff((message) => sidebar.request(message as never), { focusChat: async () => { await vscode.commands.executeCommand(`${NearAiPanelViewProvider.viewId}.focus`); } })(input),
      runApprovedCommand: (command) => runApprovedCommand(command),
      defaultModel: () => readModelTiers().standard,
      availableModels: async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const active = root ? await activeProvider(root, auth).catch(() => undefined) : undefined;
        return active ? modelOptions(active.models, readSettings().defaultModel).map((option) => option.id) : [];
      },
      // Several abliterated models: the person picks the one this scan runs on. The rule in domain/cyberModel picks one
      // silently when there is exactly one, so this is only reached when the choice is genuinely theirs.
      chooseModel: async (models) => vscode.window.showQuickPick(models, {
        title: 'Model for this scan',
        placeHolder: 'Choose the abliterated model this scan runs on. Safety-tuned models may refuse payloads.',
        ignoreFocusOut: true
      }),
      stopped: () => readSettings().actionPolicy.emergencyStop
    }))),
    vscode.commands.registerCommand('nearAi.showHistory', () => showHistory(context, sidebar)),
    // The button under every @near reply (D-07). It is a command the button calls, not a Command Palette entry: it needs a thread id.
    vscode.commands.registerCommand('nearAi.openThread', (threadId?: unknown) => openThreadInPanel(threadId, {
      focus: () => vscode.commands.executeCommand(`${NearAiPanelViewProvider.viewId}.focus`),
      resume: (id) => sidebar.request({ type: 'resume-conversation', id })
    }, (text) => { void vscode.window.showWarningMessage(text); })),
    vscode.commands.registerCommand('nearAi.gsdCommand', async () => {
      const selected = await chooseGsdCommand();
      if (selected) await sidebar.request({ type: 'open-command', command: `gsd-${selected.command}` });
    }),
    vscode.commands.registerCommand('nearAi.gsdProgress', () => sidebar.request({ type: 'open-command', command: 'gsd-progress' })),
    vscode.commands.registerCommand('nearAi.saveCheckpoint', () => saveCheckpoint())
  );

  registerRunReport(context);
  registerResearchVerifiers(context);
  registerWorkspaceCommands(context, (options) => openTeamStudio(context, auth, sidebar, options));
  registerProjectSetup(context, { secrets: context.secrets, chatVisible: () => sidebar.visible });
  registerNewProfile(context, () => configureApiKey(context, auth, sidebar));

  // `@nearAi` in VS Code's built-in Chat view; skipped on hosts without the Chat Participant API.
  registerChatParticipant(context, auth, (command, args) => sidebar.request({ type: 'open-command', command, ...(args ? { args } : {}) }));
  return process.env.NEAR_AI_E2E === '1' ? { auth, sidebar } : undefined;
}

async function suggestProxySupportOff(context: vscode.ExtensionContext): Promise<void> {
  const http = () => vscode.workspace.getConfiguration('http');
  await offerProxyAdvice({
    web: vscode.env.uiKind === vscode.UIKind.Web,
    remoteName: vscode.env.remoteName,
    proxySupport: http().get<string>('proxySupport'),
    proxy: http().get<string>('proxy'),
    env: process.env,
    state: context.globalState,
    ask: (text, ...items) => vscode.window.showInformationMessage(text, ...items),
    turnOff: () => http().update('proxySupport', 'off', vscode.ConfigurationTarget.Global),
    tell: (text, ...items) => vscode.window.showInformationMessage(text, ...items),
    reload: () => vscode.commands.executeCommand('workbench.action.reloadWindow')
  }).catch(() => undefined);
}

async function showHistory(context: vscode.ExtensionContext, sidebar: NearAiPanelViewProvider): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { void vscode.window.showInformationMessage('Open a folder to see NEAR AI conversations.'); return; }
  // D-08: the list is the thread index (the threads' small meta files); no log is opened for any item. Every thread is listed: live, archived, from the
  // Chat view, or locked on this device.
  const saved = await threadStoreFor(root, context.secrets, editorWriter(context.globalState), () => vscode.workspace.getConfiguration('nearAi').get<boolean>('sync.keepKeyInProject', true)).index();
  if (!saved.length) { void vscode.window.showInformationMessage(readAgentLimits().saveTranscripts ? 'No saved NEAR AI conversations in this project yet.' : 'Saving conversations is off (nearAi.agent.saveTranscripts).'); return; }
  // Typing filters by title (the label); the description and detail are searched too, so "Archived" or a model name also finds them.
  const picked = await vscode.window.showQuickPick(historyItems(saved), { placeHolder: 'Open a NEAR AI conversation as a tab, with its full context. Type to filter by title.', matchOnDescription: true, matchOnDetail: true });
  if (!picked) return;
  // A locked conversation is listed so it never seems to have vanished, but it cannot be opened on this device.
  if (picked.locked) { void vscode.window.showInformationMessage(LOCKED_DETAIL); return; }
  await sidebar.request({ type: 'resume-conversation', id: picked.id });
}

async function saveCheckpoint(): Promise<void> {
  const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!projectRoot) {
    void vscode.window.showWarningMessage('Open a workspace before saving a continuity checkpoint.');
    return;
  }
  const path = await saveHandoff(projectRoot, {
    reason: 'manual',
    currentAction: 'Manual checkpoint requested from VS Code',
    nextAction: 'Resume from .planning/HANDOFF.json',
    activeAgents: 0,
    pendingApprovals: 0
  });
  void vscode.window.showInformationMessage(`Continuity checkpoint saved: ${path}`);
}

/** NEAR AI: Set Up. Exported for the host tests of what follows a successful setup. */
export async function configureApiKey(context: vscode.ExtensionContext, auth: AuthService, sidebar: NearAiPanelViewProvider, options: { offerNextStep?: boolean } = {}): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { void vscode.window.showWarningMessage('Open a project folder first. NEAR AI keys and profiles are scoped to a project.'); return; }
  const kind = await vscode.window.showQuickPick([
    { label: 'NEAR AI Cloud', description: 'Private TEE models and others NEAR forwards; needs an API key', provider: 'near-ai' as const },
    { label: 'Local runtime', description: 'Ollama, LM Studio, vLLM, or any OpenAI-compatible server on this machine', provider: 'local' as const },
    { label: 'NEAR AI Cloud + local runtime', description: 'Both: pick a local or a cloud model for each chat', provider: 'hybrid' as const }
  ], { title: 'NEAR AI Set Up', placeHolder: 'Where should models run?', ignoreFocusOut: true });
  if (!kind) return;
  const usesLocal = kind.provider !== 'near-ai';
  const usesCloud = kind.provider !== 'local';
  const steps = 2 + (usesLocal ? 2 : 0) + (usesCloud ? 1 : 0);
  let step = 0;
  const title = () => `NEAR AI Set Up (${++step}/${steps})`;
  const displayName = (await vscode.window.showInputBox({
    title: title(), prompt: 'Project name', value: vscode.workspace.name ?? 'My project', ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'Enter a name for this project.'
  }))?.trim();
  if (!displayName) return;
  const organization = await vscode.window.showInputBox({ title: title(), prompt: 'Organization or company (optional, used for cost reports)', placeHolder: displayName, ignoreFocusOut: true });
  if (organization === undefined) return;
  let localBaseUrl: string | undefined;
  let localApiKey = '';
  if (usesLocal) {
    const entered = (await vscode.window.showInputBox({
      title: title(), prompt: 'Local runtime URL (OpenAI-compatible, ending in /v1)', value: 'http://localhost:11434/v1', ignoreFocusOut: true,
      validateInput: (value) => isSecureEndpoint(value.trim()) ? undefined : 'Use http://localhost, http://127.0.0.1, or an https:// URL.'
    }))?.trim();
    if (!entered) return;
    localBaseUrl = entered.replace(/\/$/, '');
    const key = await vscode.window.showInputBox({ title: title(), prompt: 'API key for the local runtime (leave empty if it needs none)', password: true, ignoreFocusOut: true });
    if (key === undefined) return;
    localApiKey = key.trim();
  }
  let cloudApiKey = '';
  if (usesCloud) {
    const key = (await vscode.window.showInputBox({
      title: title(), prompt: 'NEAR AI Cloud API key', password: true, ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? undefined : 'Paste your NEAR AI Cloud API key.'
    }))?.trim();
    if (!key) return;
    cloudApiKey = key;
  }
  const suffix = kind.provider === 'local' ? ' (local)' : kind.provider === 'hybrid' ? ' (cloud + local)' : '';
  const input = kind.provider === 'local'
    ? { baseUrl: localBaseUrl!, apiKey: localApiKey, localApiKey: '' }
    : { baseUrl: readSettings().baseUrl, apiKey: cloudApiKey, localApiKey, ...(kind.provider === 'hybrid' ? { localBaseUrl } : {}) };
  try {
    const profile = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: usesCloud ? 'Checking your NEAR AI key…' : 'Connecting to the local runtime…' }, () =>
      new ProfileStore(root, auth).configure({ profileId: deriveProfileId(root, `${displayName}${suffix}`), displayName: `${displayName}${suffix}`, organization: organization.trim() || displayName, baseUrl: input.baseUrl, authMode: 'apiKey', provider: kind.provider, ...('localBaseUrl' in input && input.localBaseUrl ? { localBaseUrl: input.localBaseUrl } : {}) }, input.apiKey, input.localApiKey));
    clearProviderCache();
    if (profile.validation.status === 'valid') {
      // The chat reloads and comes into view; its welcome shows the next steps (the "no team yet" card).
      await sidebar.refresh();
      // A caller with its own next steps (turning on Team Mode) gets only the ready message.
      if (options.offerNextStep === false) {
        void vscode.window.showInformationMessage(`NEAR AI is ready for “${profile.displayName}”. Pick a model and start chatting.`);
        return;
      }
      await offerNextStep({ secrets: context.secrets, chatVisible: () => sidebar.visible }, profile.displayName);
      return;
    }
    const retry = await vscode.window.showErrorMessage(`Setup couldn't connect: ${profile.validation.error ?? 'validation failed'}`, 'Try again', ...(usesCloud ? ['Open NEAR AI Cloud'] : []));
    if (retry === 'Try again') await configureApiKey(context, auth, sidebar, options);
    if (retry === 'Open NEAR AI Cloud') await openApiKeyPortal();
  } catch (error) {
    void vscode.window.showErrorMessage(redactSecrets(error instanceof Error ? error.message : String(error)));
  }
}

/** Deletes a profile's metadata and its key from SecretStorage, after confirmation. */
async function removeProfile(auth: AuthService, sidebar: NearAiPanelViewProvider): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { void vscode.window.showWarningMessage('Open a project folder first.'); return; }
  const profiles = new ProfileStore(root, auth);
  const metadata = await profiles.exportMetadata();
  if (!metadata.profiles.length) { void vscode.window.showInformationMessage('This project has no NEAR AI profiles.'); return; }
  const picked = await vscode.window.showQuickPick(metadata.profiles.map((profile) => ({ label: profile.displayName, description: profile.profileId === metadata.activeProfileId ? 'active' : undefined, profileId: profile.profileId })), { title: 'Remove a NEAR AI profile', placeHolder: 'Its API key is deleted from VS Code SecretStorage' });
  if (!picked) return;
  const confirm = await vscode.window.showWarningMessage(`Remove "${picked.label}" and delete its API key from this machine?`, { modal: true }, 'Remove');
  if (confirm !== 'Remove') return;
  await profiles.remove(picked.profileId);
  clearProviderCache();
  await sidebar.refresh();
  void vscode.window.showInformationMessage(`Removed "${picked.label}".`);
}

/** Switches this project's active profile, re-validating ones whose key needs checking. */
async function selectProfile(context: vscode.ExtensionContext, auth: AuthService, sidebar: NearAiPanelViewProvider): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { void vscode.window.showWarningMessage('Open a project folder first.'); return; }
  const profiles = new ProfileStore(root, auth);
  const metadata = await profiles.exportMetadata();
  const setUp = { label: '$(add) Set up a new profile…', profileId: undefined, action: 'set-up' as const };
  // A profile set up in another project can be used here without entering its key again (G-61-9).
  const saved = listSavedProfiles(profiles.projectScopeId).length
    ? [{ label: '$(folder-library) Use a profile from another project…', description: 'Its key stays where it was saved', profileId: undefined, action: 'saved' as const }]
    : [];
  const picked = await vscode.window.showQuickPick([
    ...metadata.profiles.map((profile) => ({
      label: `${profile.profileId === metadata.activeProfileId ? '$(check) ' : ''}${profile.displayName}`,
      description: profile.organization === profile.displayName ? undefined : profile.organization,
      detail: profile.validation.status === 'valid' ? 'Verified' : `Needs verification (${profile.validation.status}): select to check the key again`,
      profileId: profile.profileId,
      action: 'select' as const
    })),
    ...saved,
    setUp
  ], { title: 'NEAR AI profile for this project', placeHolder: metadata.profiles.length ? 'Choose the profile to use' : 'No profiles yet' });
  if (!picked) return;
  if (picked.action === 'saved') { await useSavedProfile(context, auth, sidebar); return; }
  if (!picked.profileId) { await configureApiKey(context, auth, sidebar); return; }
  let profile = await profiles.get(picked.profileId);
  if (profile && profile.validation.status !== 'valid') {
    profile = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking your NEAR AI key…' }, () => profiles.validate(picked.profileId));
  }
  if (profile?.validation.status !== 'valid') {
    const next = await vscode.window.showErrorMessage(`That profile's key couldn't be verified: ${profile?.validation.error ?? 'validation failed'}`, 'Re-enter key');
    if (next) await configureApiKey(context, auth, sidebar);
    return;
  }
  await profiles.select(profile.profileId);
  clearProviderCache();
  await sidebar.refresh();
}

/** Uses a NEAR AI profile set up in another project, by reference to the key stored there; the key is never read out or shown. */
async function useSavedProfile(context: vscode.ExtensionContext, auth: AuthService, sidebar: NearAiPanelViewProvider): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { void vscode.window.showWarningMessage('Open a project folder first. NEAR AI profiles are kept per project.'); return; }
  const profiles = new ProfileStore(root, auth);
  await profiles.list();
  await runUseSavedProfile({
    pick: (items, options) => Promise.resolve(vscode.window.showQuickPick(items, { ...options, matchOnDescription: true, ignoreFocusOut: true })),
    progress: (title, task) => Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task)),
    info: (message, ...actions) => Promise.resolve(vscode.window.showInformationMessage(message, ...actions)),
    error: (message, ...actions) => Promise.resolve(vscode.window.showErrorMessage(message, ...actions))
  }, {
    projectId: profiles.projectScopeId,
    use: (entry) => profiles.useSavedProfile(entry),
    setUpNew: () => configureApiKey(context, auth, sidebar),
    refresh: async () => { clearProviderCache(); await sidebar.refresh(); }
  });
}

async function openApiKeyPortal(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse('https://cloud.near.ai/'));
  void vscode.window.showInformationMessage('Create a NEAR AI Cloud API key, then run NEAR AI: Set Up again and choose “I already have a key”.');
}

async function showStatus(auth: AuthService): Promise<void> {
  const settings = readSettings();
  const model = settings.defaultModel || 'not selected';
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const profiles = root ? new ProfileStore(root, auth) : undefined;
  const metadata = profiles ? await profiles.exportMetadata() : undefined;
  const active = metadata?.activeProfileId ? metadata.profiles.find((profile) => profile.profileId === metadata.activeProfileId) : undefined;
  const configured = active && profiles ? Boolean(await auth.getScopedApiKey(profiles.getScope(active.profileId))) : false;
  const message = [
    `Profile: ${active ? `${active.displayName} · ${active.organization}` : 'none selected'}`,
    `Validation: ${active?.validation.status ?? 'setup required'}${active?.validation.validatedAt ? ` at ${active.validation.validatedAt}` : ''}${active?.validation.error ? ` · ${active.validation.error}` : ''}`,
    `API key: ${configured ? 'stored in VS Code SecretStorage' : 'not configured'}`,
    `Endpoint: ${active?.baseUrl ?? settings.baseUrl}`,
    `Default model: ${model}`,
    `Privacy mode: ${settings.privacyMode === 'tee-only' ? 'TEE-only (models NEAR forwards elsewhere are blocked)' : 'standard'}`,
    `Daily spend limit: ${settings.dailySpendLimitUsd > 0 ? `$${settings.dailySpendLimitUsd.toFixed(2)}` : 'none'}`,
    `Action policy: ${settings.actionPolicy.mode}`,
    `Emergency stop: ${settings.actionPolicy.emergencyStop ? 'ON (nothing is sent)' : 'off'}`
  ].join('\n');
  void vscode.window.showInformationMessage(message, { modal: true });
}

export function deactivate(): void {
  // Reserved for future provider and agent lifecycle cleanup.
}
