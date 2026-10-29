import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyProjectType } from '../agent/projectTypes';
import { TeamLibrary } from '../agent/teams';
import { AuthService } from './auth';
import { attachTeamStudio, StudioTarget, teamStudioHtml } from './teamStudioPage';
import { ChatPrefill, gatherDirectoryInput } from './toolsPage';
import { onDidChangeEmergencyStop } from './emergencyStop';

// The NEAR AI Team Studio tab. One tab at a time; opening it again shows it (and, for the project
// team setup, starts the guided builder).

const DRAFT_KEY = 'nearAi.teamStudio.draft';
let current: { panel: vscode.WebviewPanel; startWizard(target: StudioTarget): Promise<void> } | undefined;

export function openTeamStudio(context: vscode.ExtensionContext, auth: AuthService, sidebar: ChatPrefill, options: { wizard?: StudioTarget } = {}): void {
  if (current) {
    current.panel.reveal();
    if (options.wizard) void current.startWizard(options.wizard);
    return;
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const library = new TeamLibrary(context.globalStorageUri.fsPath);
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'teams');
  const panel = vscode.window.createWebviewPanel('nearAiTeamStudio', 'NEAR AI Team Studio', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  const asset = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  panel.webview.html = teamStudioHtml({ cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString('base64'), script: asset('teams.js'), style: asset('teams.css') });
  const studio = attachTeamStudio(panel, {
    library, root,
    gather: () => gatherDirectoryInput(context, auth),
    knowledgeBase: async () => Boolean(root && await stat(path.join(root, '.near-kb')).catch(() => undefined)),
    sidebar,
    openFile: async (file) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: false, viewColumn: vscode.ViewColumn.Beside }),
    openSetting: (key) => Promise.resolve(vscode.commands.executeCommand('workbench.action.openSettings', key)),
    confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
    ask: (prompt, value) => Promise.resolve(vscode.window.showInputBox({ title: 'Team Studio', prompt, value, validateInput: (text) => text.trim() ? undefined : 'Enter a name.' })),
    pickExportTarget: async (name) => (await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(root ?? context.globalStorageUri.fsPath, name)), filters: { 'Team file': ['md'] }, title: 'Export team' }))?.fsPath,
    pickImportSource: async () => (await vscode.window.showOpenDialog({ filters: { 'Team file': ['md'] }, title: 'Import a NEAR AI team file', canSelectMany: false }))?.[0]?.fsPath,
    applyProjectType: (projectRoot, type, goal) => applyProjectType(projectRoot, type, goal),
    drafts: { get: () => context.globalState.get(DRAFT_KEY), set: (value) => Promise.resolve(context.globalState.update(DRAFT_KEY, value)) },
    watch: (listener) => {
      const watchers = [new vscode.RelativePattern(vscode.Uri.file(library.directory), '{*.md,.archived/*.md}'), ...(root ? [new vscode.RelativePattern(vscode.Uri.file(path.dirname(TeamLibrary.projectTeamFile(root))), 'team.md')] : [])]
        .map((pattern) => vscode.workspace.createFileSystemWatcher(pattern));
      const subscriptions = watchers.flatMap((watcher) => [watcher.onDidChange((uri) => listener(uri.fsPath)), watcher.onDidCreate((uri) => listener(uri.fsPath)), watcher.onDidDelete((uri) => listener(uri.fsPath)), watcher]);
      return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
    },
    onDidChangeSettings: (listener) => {
      const subscriptions = [vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('nearAi')) listener(); }), onDidChangeEmergencyStop(() => listener())];
      return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
    }
  });
  current = { panel, startWizard: (target) => studio.startWizard(target) };
  if (options.wizard) void studio.startWizard(options.wizard);
  panel.onDidDispose(() => { current = undefined; }, undefined, context.subscriptions);
}
