import * as vscode from 'vscode';
import { buildSetupMenu, projectHasTeam, SETUP_STEPS, SetupContext, SetupStep, START_CHATTING } from './setupSteps';
import { webSearchProvider } from './webSearchSetup';

// The setup menu shown after NEAR AI is connected, and by "NEAR AI: Project Setup…" at any time.
// The steps and their order live in setupSteps.ts; this file only asks VS Code.

export const PROJECT_SETUP_COMMAND = 'nearAi.projectSetup';
export const REVIEW_PROJECT_TEAM = 'Review project team';

function setupContext(context: Pick<vscode.ExtensionContext, 'secrets'>, root: string): SetupContext {
  return {
    root,
    setting: (key) => vscode.workspace.getConfiguration('nearAi').get(key),
    webSearchReady: async () => Boolean(await webSearchProvider(context.secrets))
  };
}

/**
 * Shows the setup steps and runs the one picked. Closing the menu (Escape) is the same as
 * "Start chatting": it opens the chat and asks nothing more.
 */
export async function showSetupMenu(context: Pick<vscode.ExtensionContext, 'secrets'>, options: { title?: string; steps?: readonly SetupStep[] } = {}): Promise<string | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { void vscode.window.showWarningMessage('Open a project folder first.'); return undefined; }
  const items = await buildSetupMenu(options.steps ?? SETUP_STEPS, setupContext(context, root));
  const picked = await vscode.window.showQuickPick(items.map((item) => ({ label: item.label, detail: item.detail, command: item.command })), {
    title: options.title ?? 'Project Setup',
    placeHolder: 'Pick a step. You can come back to these with NEAR AI: Project Setup.',
    ignoreFocusOut: true
  });
  const command = picked?.command ?? START_CHATTING.command;
  await vscode.commands.executeCommand(command);
  return command;
}

/**
 * After a profile is set up and its key checked: a project without a team gets the setup menu;
 * a project with one gets the ready message and a way to review its team.
 */
export async function offerNextStep(context: Pick<vscode.ExtensionContext, 'secrets'>, profileName: string): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root && !await projectHasTeam(root)) {
    await showSetupMenu(context, { title: `NEAR AI is ready for “${profileName}”. What next?` });
    return;
  }
  const choice = await vscode.window.showInformationMessage(`NEAR AI is ready for “${profileName}”. Pick a model and start chatting.`, REVIEW_PROJECT_TEAM);
  if (choice === REVIEW_PROJECT_TEAM) await vscode.commands.executeCommand('nearAi.manageTeams');
}

export function registerProjectSetup(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(PROJECT_SETUP_COMMAND, () => showSetupMenu(context)));
}
