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
      configureApiKey: () => configureApiKey(auth),
      openStaking: () => openTools(context, auth),
      showProgress: () => showStatus(auth)
    })),
    vscode.commands.registerCommand('nearAi.status', () => showStatus(auth)),
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

async function configureApiKey(auth: AuthService): Promise<void> {
  const value = await vscode.window.showInputBox({ prompt: 'Enter your NEAR AI Cloud API key', password: true, ignoreFocusOut: true });
  if (value === undefined) return;
  try {
    await saveProfileCredential(auth, value);
  } catch (error) {
    void vscode.window.showErrorMessage(redactSecrets(error instanceof Error ? error.message : String(error)));
  }
}

async function saveProfileCredential(auth: AuthService, apiKey: string): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { void vscode.window.showWarningMessage('Open a workspace before configuring a project profile.'); return; }
  const profiles = new ProfileStore(root, auth);
  const displayName = await vscode.window.showInputBox({ prompt: 'Project name', value: vscode.workspace.name ?? 'My project', placeHolder: 'Anything you want to call this project', ignoreFocusOut: true });
  if (displayName === undefined) return;
  const profileId = deriveProfileId(root, displayName);
  const organization = await vscode.window.showInputBox({ prompt: 'Organization or company', ignoreFocusOut: true });
  if (organization === undefined) return;
  const settings = readSettings();
  const existing = await profiles.get(profileId);
  if (existing) {
    await profiles.update({ profileId, displayName, organization, baseUrl: settings.baseUrl, authMode: 'apiKey' });
  } else {
    await profiles.create({ profileId, displayName, organization, baseUrl: settings.baseUrl, authMode: 'apiKey' });
  }
  await profiles.saveProfileApiKey(profileId, apiKey);
  const validated = await profiles.validate(profileId);
  if (validated.validation.status === 'valid') {
    void vscode.window.showInformationMessage(`Project “${validated.displayName}” is validated for this workspace. Select it explicitly from Chat Setup before dispatch.`);
  } else {
    void vscode.window.showWarningMessage(`Project “${validated.displayName}” was saved but provider validation did not pass. Review Setup before dispatch.`);
  }
}

async function openApiKeyPortal(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse('https://cloud.near.ai/'));
  void vscode.window.showInformationMessage('Create your NEAR AI Cloud API key, then return here and choose “I already have a key”.');
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
