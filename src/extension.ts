import * as vscode from 'vscode';
import { redactSecrets } from './domain/redaction';
import { saveHandoff } from './services/handoff';
import { AuthService } from './services/auth';
import { ProfileStore } from './services/profileStore';
import { GsdUpdater } from './services/gsdUpdater';
import { readSettings } from './services/settings';
import { openOnboarding } from './services/onboarding';
import { openChat } from './services/chat';
import { chooseGsdCommand } from './services/gsdCommands';
import { StakingService } from './services/stakingService';
import { walletStatusCopy } from './services/chatBridge';

export function activate(context: vscode.ExtensionContext): void {
  const auth = new AuthService(context.secrets);
  new GsdUpdater().start(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('nearAi.setup', () => openOnboarding(context, {
      openApiKeyPortal: () => openApiKeyPortal(),
      configureApiKey: () => configureApiKey(auth),
      useNearAccount: () => useNearAccount(),
      showProgress: () => showStatus(auth)
    })),
    vscode.commands.registerCommand('nearAi.status', () => showStatus(auth)),
    vscode.commands.registerCommand('nearAi.openChat', () => openChat(context, auth)),
    vscode.commands.registerCommand('nearAi.gsdCommand', async () => {
      const selected = await chooseGsdCommand();
      if (!selected) return;
      await openChat(context, auth, undefined, selected.command);
    }),
    vscode.commands.registerCommand('nearAi.gsdProgress', () => openChat(context, auth, undefined, 'progress')),
    vscode.commands.registerCommand('nearAi.saveCheckpoint', () => saveCheckpoint())
  );
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

async function runSetup(auth: AuthService): Promise<void> {
  const choice = await vscode.window.showQuickPick(
    ['Configure API key', 'Use NEAR account sign-in', 'Show current status'],
    { placeHolder: 'Choose how Near AI for VSCode should connect' }
  );
  if (choice === 'Configure API key') {
    const value = await vscode.window.showInputBox({ prompt: 'Enter your NEAR AI Cloud API key', password: true, ignoreFocusOut: true });
    if (value === undefined) return;
    try {
      await saveProfileCredential(auth, value);
    } catch (error) {
      void vscode.window.showErrorMessage(redactSecrets(error instanceof Error ? error.message : String(error)));
    }
  } else if (choice === 'Use NEAR account sign-in') {
    await vscode.workspace.getConfiguration('nearAi').update('authMode', 'nearAccount', vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage('NEAR account sign-in is prepared but the provider token exchange is not yet configured.');
  } else if (choice === 'Show current status') {
    await showStatus(auth);
  } else if (!choice) {
    return;
  }
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
  const profileId = await vscode.window.showInputBox({ prompt: 'Stable profile ID (for example, profile-company)', placeHolder: 'profile-company', ignoreFocusOut: true });
  if (profileId === undefined) return;
  const displayName = await vscode.window.showInputBox({ prompt: 'Profile name', value: profileId, ignoreFocusOut: true });
  if (displayName === undefined) return;
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
    void vscode.window.showInformationMessage(`Profile “${validated.displayName}” is validated for this workspace. Select it explicitly from Chat Setup before dispatch.`);
  } else {
    void vscode.window.showWarningMessage(`Profile “${validated.displayName}” was saved but provider validation did not pass. Review Setup before dispatch.`);
  }
}

async function openApiKeyPortal(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse('https://cloud.near.ai/'));
  void vscode.window.showInformationMessage('Create your NEAR AI Cloud API key, then return here and choose “I already have a key”.');
}

async function useNearAccount(): Promise<void> {
  await vscode.workspace.getConfiguration('nearAi').update('authMode', 'nearAccount', vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage('NEAR account sign-in is prepared but the provider token exchange is not yet configured.');
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
