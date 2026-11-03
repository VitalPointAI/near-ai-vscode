import * as vscode from 'vscode';
import { buildSetupMenu, collectSetupContext, projectHasTeam, registerSetupFacts, SETUP_STEPS, START_CHATTING } from './setupSteps';
import { webSearchProvider } from './webSearchSetup';

// The setup menu shown after NEAR AI is connected, and by "NEAR AI: Project Setup…" at any time.
// The steps, their order and the facts they read live in setupSteps.ts; this file only asks VS Code.

export const PROJECT_SETUP_COMMAND = 'nearAi.projectSetup';
export const REVIEW_PROJECT_TEAM = 'Review project team';
export const MORE_SETUP_STEPS = 'More setup steps';

export interface SetupMenuHost {
  secrets: Pick<vscode.SecretStorage, 'get'>;
  /** Whether the NEAR AI chat is on screen now. */
  chatVisible?: () => boolean;
}

/**
 * Shows the setup steps (SETUP_STEPS, read now) and runs the one picked. "Start chatting" opens
 * the chat. Closing the menu without a choice opens the chat only when it is not already on
 * screen, so a menu replaced by another prompt (the Command Palette) never pulls focus away.
 */
export async function showSetupMenu(host: SetupMenuHost, options: { title?: string } = {}): Promise<string | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { void vscode.window.showWarningMessage('Open a project folder first.'); return undefined; }
  const ctx = await collectSetupContext({ root, setting: (key) => vscode.workspace.getConfiguration('nearAi').get(key) });
  const items = await buildSetupMenu(SETUP_STEPS, ctx);
  const picked = await vscode.window.showQuickPick(items.map((item) => ({ label: item.label, detail: item.detail, command: item.command })), {
    title: options.title ?? 'Project Setup',
    placeHolder: 'Pick a step. You can come back to these with NEAR AI: Project Setup.',
    ignoreFocusOut: true
  });
  if (!picked && host.chatVisible?.()) return undefined;
  const command = picked?.command ?? START_CHATTING.command;
  await vscode.commands.executeCommand(command);
  return command;
}

/**
 * After a profile is set up and its key checked: a project without a team gets the setup menu;
 * a project with one gets the ready message, with ways to review its team or see the other steps.
 */
export async function offerNextStep(host: SetupMenuHost, profileName: string): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root && !await projectHasTeam(root)) {
    await showSetupMenu(host, { title: `NEAR AI is ready for “${profileName}”. What next?` });
    return;
  }
  const choice = await vscode.window.showInformationMessage(`NEAR AI is ready for “${profileName}”. Pick a model and start chatting.`, REVIEW_PROJECT_TEAM, MORE_SETUP_STEPS);
  if (choice === REVIEW_PROJECT_TEAM) await vscode.commands.executeCommand('nearAi.manageTeams');
  if (choice === MORE_SETUP_STEPS) await vscode.commands.executeCommand(PROJECT_SETUP_COMMAND);
}

/** Registers NEAR AI: Project Setup, and the web search fact its step reads. */
export function registerProjectSetup(context: Pick<vscode.ExtensionContext, 'subscriptions'>, host: SetupMenuHost): void {
  context.subscriptions.push(
    registerSetupFacts('webSearchReady', async () => Boolean(await webSearchProvider(host.secrets as vscode.SecretStorage))),
    vscode.commands.registerCommand(PROJECT_SETUP_COMMAND, () => showSetupMenu(host))
  );
}

export const NEW_PROFILE_COMMAND = 'nearAi.newProfile';

/** NEAR AI: Set Up a New Profile… (the chat welcome's button): straight to the key setup, without the welcome page. */
export function registerNewProfile(context: Pick<vscode.ExtensionContext, 'subscriptions'>, configure: () => Promise<void>): void {
  context.subscriptions.push(vscode.commands.registerCommand(NEW_PROFILE_COMMAND, () => configure()));
}
