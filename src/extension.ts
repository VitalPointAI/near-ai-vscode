import * as vscode from 'vscode';
import { redactSecrets } from './domain/redaction';
import { saveHandoff } from './services/handoff';
import { AuthService } from './services/auth';
import { ProfileStore } from './services/profileStore';
import { GsdUpdater } from './services/gsdUpdater';
import { readSettings, shouldAutoInstallGsd } from './services/settings';
import { openOnboarding } from './services/onboarding';
import { openTools } from './services/chat';
import { ActivityStore } from './services/activityStore';
import { chooseGsdCommand } from './services/gsdCommands';
import { StakingService } from './services/stakingService';
import { walletStatusCopy } from './services/chatBridge';
import { NearAiPanelViewProvider } from './services/panelView';
import { deriveProfileId } from './domain/auth';
import { registerChatParticipant } from './services/chatParticipant';

export function activate(context: vscode.ExtensionContext): void {
  const auth = new AuthService(context.secrets);
  if (shouldAutoInstallGsd()) void new GsdUpdater().start(context);

  const sidebar = new NearAiPanelViewProvider(context, auth);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NearAiPanelViewProvider.viewId, sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('nearAi.setup', () => openOnboarding(context, {
      openApiKeyPortal: () => openApiKeyPortal(),
      configureApiKey: () => configureApiKey(auth, sidebar),
      openStaking: () => openTools(context, auth),
      showProgress: () => showStatus(auth)
    })),
    vscode.commands.registerCommand('nearAi.status', () => showStatus(auth)),
    vscode.commands.registerCommand('nearAi.selectProfile', () => selectProfile(auth, sidebar)),
    vscode.commands.registerCommand('nearAi.openChat', () => vscode.commands.executeCommand(`${NearAiPanelViewProvider.viewId}.focus`)),
    vscode.commands.registerCommand('nearAi.newChat', () => sidebar.newChat()),
    vscode.commands.registerCommand('nearAi.openTools', () => openTools(context, auth)),
    vscode.commands.registerCommand('nearAi.showHistory', () => showHistory(sidebar)),
    vscode.commands.registerCommand('nearAi.gsdCommand', async () => {
      const selected = await chooseGsdCommand();
      if (selected) await sidebar.request({ type: 'open-command', command: selected.command });
    }),
    vscode.commands.registerCommand('nearAi.gsdProgress', () => sidebar.request({ type: 'open-command', command: 'progress' })),
    vscode.commands.registerCommand('nearAi.saveCheckpoint', () => saveCheckpoint())
  );

  // `@nearAi` in VS Code's built-in Chat view; skipped on hosts without the Chat Participant API.
  registerChatParticipant(context, auth);
}

async function showHistory(sidebar: NearAiPanelViewProvider): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { void vscode.window.showInformationMessage('Open a folder to see NEAR AI session history.'); return; }
  const sessions = await new ActivityStore(root).list();
  if (!sessions.length) { void vscode.window.showInformationMessage('No NEAR AI sessions in this project yet.'); return; }
  const picked = await vscode.window.showQuickPick(sessions.slice().reverse().map((session) => ({
    label: session.plans.length ? session.plans.map((plan) => `/${plan}`).join(', ') : 'Chat',
    description: session.outcome,
    detail: [new Date(session.updatedAt).toLocaleString(), session.models.join(', ')].filter(Boolean).join(' · '),
    sessionId: session.sessionId
  })), { placeHolder: 'Reopen a NEAR AI session', matchOnDetail: true });
  if (picked) await sidebar.request({ type: 'reopen-session', sessionId: picked.sessionId });
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
  const displayName = (await vscode.window.showInputBox({
    title: 'NEAR AI Set Up (1/3)', prompt: 'Project name', value: vscode.workspace.name ?? 'My project', ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'Enter a name for this project.'
  }))?.trim();
  if (!displayName) return;
  const organization = await vscode.window.showInputBox({ title: 'NEAR AI Set Up (2/3)', prompt: 'Organization or company (optional, used for cost reports)', placeHolder: displayName, ignoreFocusOut: true });
  if (organization === undefined) return;
  const apiKey = (await vscode.window.showInputBox({
    title: 'NEAR AI Set Up (3/3)', prompt: 'NEAR AI Cloud API key', password: true, ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'Paste your NEAR AI Cloud API key.'
  }))?.trim();
  if (!apiKey) return;
  try {
    const profile = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking your NEAR AI key…' }, () =>
      new ProfileStore(root, auth).configure({ profileId: deriveProfileId(root, displayName), displayName, organization: organization.trim() || displayName, baseUrl: readSettings().baseUrl, authMode: 'apiKey' }, apiKey));
    if (profile.validation.status === 'valid') {
      await sidebar.refresh();
      void vscode.window.showInformationMessage(`NEAR AI is ready for “${profile.displayName}”. Pick a model and start chatting.`);
      return;
    }
    const retry = await vscode.window.showErrorMessage(`NEAR AI couldn't verify that key: ${profile.validation.error ?? 'validation failed'}`, 'Re-enter key', 'Open NEAR AI Cloud');
    if (retry === 'Re-enter key') await configureApiKey(auth, sidebar);
    if (retry === 'Open NEAR AI Cloud') await openApiKeyPortal();
  } catch (error) {
    void vscode.window.showErrorMessage(redactSecrets(error instanceof Error ? error.message : String(error)));
  }
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
    `Provider: ${active?.provider ?? 'near-ai'} · project scope: ${metadata?.projectId ?? 'no workspace'}`,
    `Validation: ${active?.validation.status ?? 'setup required'}${active?.validation.validatedAt ? ` at ${active.validation.validatedAt}` : ''}${active?.validation.error ? ` · ${active.validation.error}` : ''}`,
    `Credential: ${configured ? 'configured' : 'not configured'}`,
    `Endpoint: ${active?.baseUrl ?? settings.baseUrl}`,
    `Model: ${model}`,
    `Policy: ${settings.actionPolicy.mode}`,
    `Wallet entitlement: ${walletStatusCopy(StakingService.unavailable().getStatus())}`,
    'TEE verification: available when returned by the provider'
  ].join('\n');
  void vscode.window.showInformationMessage(message, { modal: true });
}

export function deactivate(): void {
  // Reserved for future provider and agent lifecycle cleanup.
}
