import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { TeamLibrary } from '../agent/teams';
import { AuthService } from './auth';
import { gsdHostFor } from './chat';
import { providerErrorMessage } from './chatBridge';
import { isEmergencyStopped, onDidChangeEmergencyStop } from './emergencyStop';
import { mcpRegistry } from './mcpView';
import { activeProvider } from './providerCache';
import { securityConsented } from './securityScan';
import { readAgentModels, readAgentRules, readModelTiers, readRoleModels, readSafetyModel, readSettings } from './settings';
import { buildToolsDirectory, DirectoryInput, parseToolsPageMessage, ToolsDirectory, toolsPageHtml } from './toolsDirectory';
import { webSearchProvider } from './webSearchSetup';

// The NEAR AI Tools tab: the directory of what the agents can use. It reads; the only things it
// changes are through existing actions (switching an MCP server on for this project, which the
// MCP Connections page also does, and NEAR AI commands). It never sends anything to a model.

/** Where "Use in chat" puts the command: the sidebar chat's composer. */
export interface ChatPrefill { prefill(text: string): Promise<void> }

export interface ToolsPageDeps {
  gather(): Promise<DirectoryInput>;
  sidebar: ChatPrefill;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown> | Promise<unknown>;
  mcp: { setEnabledHere(id: string, enabled: boolean): Promise<void>; connectServer(id: string): Promise<unknown>; onDidChange(listener: () => void): { dispose(): void } };
  /** Configuration, emergency stop, and visibility changes that should refresh the page. */
  onDidChangeConfiguration(listener: (event: { affectsConfiguration(section: string): boolean }) => void): { dispose(): void };
  onDidChangeEmergencyStop(listener: () => void): { dispose(): void };
}

interface PageHost {
  webview: { postMessage(message: unknown): Thenable<boolean> | Promise<boolean>; onDidReceiveMessage(listener: (message: unknown) => unknown): { dispose(): void } };
  onDidDispose(listener: () => void): { dispose(): void };
  onDidChangeViewState?(listener: (event: { webviewPanel: { visible: boolean } }) => void): { dispose(): void };
}

/** Wires a page to its data and actions; returns a refresh function (for tests and the host). */
export function attachToolsPage(host: PageHost, deps: ToolsPageDeps): { refresh(): Promise<void>; dispose(): void } {
  let current: ToolsDirectory | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const refresh = async (): Promise<void> => {
    const mine = ++generation;
    let directory: ToolsDirectory;
    try {
      directory = buildToolsDirectory(await deps.gather());
    } catch (error) {
      if (mine === generation) void host.webview.postMessage({ type: 'error', text: providerErrorMessage(error) });
      return;
    }
    // A slower earlier refresh never overwrites a newer one.
    if (mine !== generation) return;
    current = directory;
    void host.webview.postMessage({ type: 'directory', directory });
  };
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void refresh(); }, 150);
    timer.unref?.();
  };
  const subscriptions = [
    deps.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('nearAi')) soon(); }),
    deps.onDidChangeEmergencyStop(() => soon()),
    deps.mcp.onDidChange(() => soon()),
    ...(host.onDidChangeViewState ? [host.onDidChangeViewState((event) => { if (event.webviewPanel.visible) soon(); })] : []),
    host.webview.onDidReceiveMessage(async (value) => {
      const message = parseToolsPageMessage(value);
      if (!message) return;
      try {
        switch (message.type) {
          case 'ready': case 'refresh': await refresh(); break;
          case 'use-in-chat': {
            // Only a command the directory lists, so the page cannot put arbitrary text in the composer.
            const known = current ? [...current.skills.map((skill) => skill.insert), ...current.teams.map((team) => team.insert)] : [];
            if (known.includes(message.text)) await deps.sidebar.prefill(message.text);
            break;
          }
          case 'run-command': await deps.executeCommand(message.command); break;
          case 'open-setting': await deps.executeCommand('workbench.action.openSettings', message.key); break;
          case 'mcp-enable': if (current?.mcp.some((server) => server.id === message.id)) await deps.mcp.setEnabledHere(message.id, message.enabled); break;
          case 'mcp-connect': if (current?.mcp.some((server) => server.id === message.id && server.enabledHere)) await deps.mcp.connectServer(message.id); break;
        }
      } catch (error) {
        void host.webview.postMessage({ type: 'error', text: providerErrorMessage(error) });
        await refresh();
      }
    })
  ];
  const dispose = () => { if (timer) clearTimeout(timer); for (const subscription of subscriptions) subscription.dispose(); };
  host.onDidDispose(dispose);
  return { refresh, dispose };
}

/** Everything the directory shows, read from the same settings, files, and registries a run uses. */
export async function gatherDirectoryInput(context: vscode.ExtensionContext, auth: AuthService): Promise<DirectoryInput> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const settings = readSettings();
  const tiers = readModelTiers();
  const agentModels = readAgentModels();
  const host = gsdHostFor(context);
  const mcp = mcpRegistry(context);
  const [gsd, version, teams, webSearch, servers, catalog] = await Promise.all([
    host.context().catch(() => undefined),
    host.runtime.installedVersion().catch(() => null),
    new TeamLibrary(context.globalStorageUri.fsPath).list(root).catch(() => []),
    webSearchProvider(context.secrets).then((provider) => Boolean(provider), () => false),
    mcp.status().catch(() => []),
    // The catalog list (cached per profile); no completion is requested.
    (root ? activeProvider(root, auth) : Promise.resolve(undefined)).then((active) => ({ models: active?.models, problem: active ? undefined : root ? 'Set up a NEAR AI profile for this project to see the models your key can use.' : 'Open a folder to see the models your key can use.' }), (error: unknown) => ({ models: undefined, problem: providerErrorMessage(error) }))
  ]);
  return {
    ...(gsd ? { gsd: { skills: gsd.skills, agents: gsd.agents, ...(version ? { version } : {}) } } : {}),
    teams,
    policy: { ...settings.actionPolicy, emergencyStop: isEmergencyStopped() },
    rules: readAgentRules(),
    webSearch,
    securityConsented: root ? securityConsented(context) : false,
    mcp: servers,
    ...(catalog.models ? { models: catalog.models } : {}),
    ...(catalog.problem ? { modelsProblem: catalog.problem } : {}),
    settings: { mainModel: settings.defaultModel, tiers, roleModels: readRoleModels(), visionModel: agentModels.visionModel, transcriptionModel: agentModels.transcriptionModel, imageModel: agentModels.imageModel, safetyModel: readSafetyModel(tiers) }
  };
}

let panel: vscode.WebviewPanel | undefined;

/** Opens (or shows) the NEAR AI Tools tab. */
export function openTools(context: vscode.ExtensionContext, auth: AuthService, sidebar: ChatPrefill): void {
  if (panel) { panel.reveal(); return; }
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'tools');
  const view = vscode.window.createWebviewPanel('nearAiTools', 'NEAR AI Tools', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media] });
  panel = view;
  view.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  const asset = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  view.webview.html = toolsPageHtml({ cspSource: view.webview.cspSource, nonce: randomBytes(16).toString('base64'), script: asset('tools.js'), style: asset('tools.css') });
  const mcp = mcpRegistry(context);
  attachToolsPage(view, {
    gather: () => gatherDirectoryInput(context, auth),
    sidebar,
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    mcp: { setEnabledHere: (id, enabled) => mcp.setEnabledHere(id, enabled), connectServer: (id) => mcp.connectServer(id), onDidChange: (listener) => mcp.onDidChange(listener) },
    onDidChangeConfiguration: (listener) => vscode.workspace.onDidChangeConfiguration(listener),
    onDidChangeEmergencyStop: (listener) => onDidChangeEmergencyStop(listener)
  });
  view.onDidDispose(() => { panel = undefined; }, undefined, context.subscriptions);
}
