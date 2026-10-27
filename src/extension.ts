import * as vscode from 'vscode';
import { redactSecrets } from './domain/redaction';
import { saveHandoff } from './services/handoff';
import { AuthService } from './services/auth';
import { ProfileStore } from './services/profileStore';
import { GsdRuntime, startRuntimeUpdates } from './gsd/runtime';
import { readAgentLimits, readSettings, shouldAutoInstallGsd } from './services/settings';
import { openOnboarding } from './services/onboarding';
import { openTools } from './services/chat';
import { TranscriptStore } from './services/transcripts';
import { chooseGsdCommand } from './services/gsdCommands';
import { NearAiPanelViewProvider } from './services/panelView';
import { deriveProfileId } from './domain/auth';
import { isSecureEndpoint } from './domain/config';
import { registerChatParticipant } from './services/chatParticipant';
import { initEmergencyStop, setEmergencyStop } from './services/emergencyStop';
import { clearProviderCache } from './services/providerCache';

export function activate(context: vscode.ExtensionContext): void {
  const auth = new AuthService(context.secrets);
  initEmergencyStop(context);
  if (shouldAutoInstallGsd()) {
    void startRuntimeUpdates(new GsdRuntime(context.globalStorageUri.fsPath), vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, (message, failed) => {
      void (failed ? vscode.window.showWarningMessage(message) : vscode.window.showInformationMessage(message));
    }).then((updates) => { if (updates) context.subscriptions.push(updates); });
  }

  const sidebar = new NearAiPanelViewProvider(context, auth);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NearAiPanelViewProvider.viewId, sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('nearAi.setup', () => openOnboarding(context, {
      openApiKeyPortal: () => openApiKeyPortal(),
      configureApiKey: () => configureApiKey(auth, sidebar),
      showProgress: () => showStatus(auth)
    })),
    vscode.commands.registerCommand('nearAi.status', () => showStatus(auth)),
    vscode.commands.registerCommand('nearAi.selectProfile', () => selectProfile(auth, sidebar)),
    vscode.commands.registerCommand('nearAi.removeProfile', () => removeProfile(auth, sidebar)),
    vscode.commands.registerCommand('nearAi.emergencyStop', async () => {
      await setEmergencyStop(true);
      void vscode.window.showWarningMessage('NEAR AI emergency stop is on. Running requests and workflows were stopped, and nothing more will be sent until you resume.', 'Resume').then((choice) => { if (choice) void vscode.commands.executeCommand('nearAi.resume'); });
    }),
    vscode.commands.registerCommand('nearAi.resume', async () => {
      await setEmergencyStop(false);
      void vscode.window.showInformationMessage('NEAR AI resumed.');
    }),
    vscode.commands.registerCommand('nearAi.openChat', () => vscode.commands.executeCommand(`${NearAiPanelViewProvider.viewId}.focus`)),
    vscode.commands.registerCommand('nearAi.newChat', () => sidebar.newChat()),
    vscode.commands.registerCommand('nearAi.openTools', () => openTools(context, auth)),
    vscode.commands.registerCommand('nearAi.showHistory', () => showHistory(context, sidebar)),
    vscode.commands.registerCommand('nearAi.gsdCommand', async () => {
      const selected = await chooseGsdCommand();
      if (selected) await sidebar.request({ type: 'open-command', command: `gsd-${selected.command}` });
    }),
    vscode.commands.registerCommand('nearAi.gsdProgress', () => sidebar.request({ type: 'open-command', command: 'gsd-progress' })),
    vscode.commands.registerCommand('nearAi.saveCheckpoint', () => saveCheckpoint())
  );

  // `@nearAi` in VS Code's built-in Chat view; skipped on hosts without the Chat Participant API.
  registerChatParticipant(context, auth, (command, args) => sidebar.request({ type: 'open-command', command, ...(args ? { args } : {}) }));
}

async function showHistory(context: vscode.ExtensionContext, sidebar: NearAiPanelViewProvider): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { void vscode.window.showInformationMessage('Open a folder to see NEAR AI conversations.'); return; }
  const saved = await new TranscriptStore(context.globalStorageUri.fsPath, root).list();
  if (!saved.length) { void vscode.window.showInformationMessage(readAgentLimits().saveTranscripts ? 'No saved NEAR AI conversations in this project yet.' : 'Saving conversations is off (nearAi.agent.saveTranscripts).'); return; }
  const picked = await vscode.window.showQuickPick(saved.map((conversation) => ({
    label: conversation.title,
    description: `${conversation.turns} message${conversation.turns === 1 ? '' : 's'}`,
    detail: `${new Date(conversation.updatedAt).toLocaleString()} · ${conversation.model}`,
    id: conversation.id
  })), { placeHolder: 'Resume a NEAR AI conversation with its full context', matchOnDescription: true, matchOnDetail: true });
  if (picked) await sidebar.request({ type: 'resume-conversation', id: picked.id });
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

async function configureApiKey(auth: AuthService, sidebar: NearAiPanelViewProvider): Promise<void> {
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
      await sidebar.refresh();
      void vscode.window.showInformationMessage(`NEAR AI is ready for “${profile.displayName}”. Pick a model and start chatting.`);
      return;
    }
    const retry = await vscode.window.showErrorMessage(`Setup couldn't connect: ${profile.validation.error ?? 'validation failed'}`, 'Try again', ...(usesCloud ? ['Open NEAR AI Cloud'] : []));
    if (retry === 'Try again') await configureApiKey(auth, sidebar);
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
async function selectProfile(auth: AuthService, sidebar: NearAiPanelViewProvider): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { void vscode.window.showWarningMessage('Open a project folder first.'); return; }
  const profiles = new ProfileStore(root, auth);
  const metadata = await profiles.exportMetadata();
  const setUp = { label: '$(add) Set up a new profile…', profileId: undefined };
  const picked = await vscode.window.showQuickPick([
    ...metadata.profiles.map((profile) => ({
      label: `${profile.profileId === metadata.activeProfileId ? '$(check) ' : ''}${profile.displayName}`,
      description: profile.organization === profile.displayName ? undefined : profile.organization,
      detail: profile.validation.status === 'valid' ? 'Verified' : `Needs verification (${profile.validation.status}): select to check the key again`,
      profileId: profile.profileId
    })),
    setUp
  ], { title: 'NEAR AI profile for this project', placeHolder: metadata.profiles.length ? 'Choose the profile to use' : 'No profiles yet' });
  if (!picked) return;
  if (!picked.profileId) { await configureApiKey(auth, sidebar); return; }
  let profile = await profiles.get(picked.profileId);
  if (profile && profile.validation.status !== 'valid') {
    profile = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking your NEAR AI key…' }, () => profiles.validate(picked.profileId));
  }
  if (profile?.validation.status !== 'valid') {
    const next = await vscode.window.showErrorMessage(`That profile's key couldn't be verified: ${profile?.validation.error ?? 'validation failed'}`, 'Re-enter key');
    if (next) await configureApiKey(auth, sidebar);
    return;
  }
  await profiles.select(profile.profileId);
  clearProviderCache();
  await sidebar.refresh();
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
