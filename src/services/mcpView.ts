import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { McpApproval, McpServerConfig, validateServerUrl } from '../mcp/client';
import { McpRegistry, SERVER_ID } from './mcpRegistry';

// The MCP Connections page: add, edit, and remove servers, switch them on for this project,
// choose how calls are approved, switch tools off, and see what is connected and how it is used.
// Secret values go from the form straight to SecretStorage and are never sent back to the page.

let registry: McpRegistry | undefined;
let panel: vscode.WebviewPanel | undefined;

export function mcpRegistry(context: vscode.ExtensionContext): McpRegistry {
  if (!registry) {
    registry = new McpRegistry(context.globalState, context.workspaceState, context.secrets, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    const current = registry;
    context.subscriptions.push({ dispose: () => { void current.dispose(); } });
  }
  return registry;
}

export function registerMcpConnections(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('nearAi.manageMcp', () => openMcpConnections(context)));
}

const APPROVALS: McpApproval[] = ['ask-for-changes', 'ask-every-call', 'trusted'];
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const pairs = (value: unknown): Array<[string, string]> => (Array.isArray(value) ? value.filter((pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string').map(([key, val]) => [key.trim(), val] as [string, string]).filter(([key]) => /^[A-Za-z0-9_-]{1,100}$/.test(key)).slice(0, 30) : []);

function slug(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'server';
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`.slice(0, 31);
  return id;
}

export function openMcpConnections(context: vscode.ExtensionContext): void {
  if (panel) { panel.reveal(); return; }
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'mcp');
  const view = vscode.window.createWebviewPanel('nearAiMcp', 'MCP Connections', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media] });
  panel = view;
  view.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  view.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('mcp.css')}"><title>MCP Connections</title></head><body>
<header><h1>MCP connections</h1><p class="hint">Servers you add are available to every project once you switch them on for it. URLs, header values, and environment values are stored in VS Code's encrypted secret storage and never shown here. Tool arguments are sent to the server; its results are treated as outside content.</p><button id="add" type="button">Add server</button></header>
<section id="form" hidden aria-labelledby="form-title"></section>
<section aria-labelledby="servers-title"><h2 id="servers-title">Servers</h2><div id="servers" aria-live="polite"></div><p id="empty" class="hint">No MCP servers yet. Add one with its URL (for a remote server) or its command (for one that runs on this computer).</p></section>
<script nonce="${nonce}" src="${asset('mcp.js')}"></script></body></html>`;
  const mcp = mcpRegistry(context);
  const send = async (saved = false) => { void view.webview.postMessage({ type: 'state', servers: await mcp.status(), project: vscode.workspace.workspaceFolders?.[0]?.name ?? '', saved }); };
  const listener = mcp.onDidChange(() => { if (view.visible) void send(); });
  view.onDidDispose(() => { listener.dispose(); panel = undefined; }, undefined, context.subscriptions);
  view.onDidChangeViewState((event) => { if (event.webviewPanel.visible) void send(); }, undefined, context.subscriptions);
  view.webview.onDidReceiveMessage(async (message: Record<string, unknown>) => {
    let saved = false;
    try {
      const id = typeof message.id === 'string' && SERVER_ID.test(message.id) ? message.id : undefined;
      const known = id ? mcp.servers().find((server) => server.id === id) : undefined;
      switch (message.type) {
        case 'ready': break;
        case 'save': saved = await saveServer(mcp, message, known); break;
        case 'remove': {
          if (!known) break;
          const confirm = await vscode.window.showWarningMessage(`Remove ${known.name}? Its stored URL, headers, and environment values are deleted.`, { modal: true }, 'Remove');
          if (confirm === 'Remove') await mcp.remove(known.id);
          break;
        }
        case 'enable-here': if (known) await mcp.setEnabledHere(known.id, message.enabled === true); break;
        case 'approval': if (known && APPROVALS.includes(message.approval as McpApproval)) await mcp.update(known.id, { approval: message.approval as McpApproval }); break;
        case 'tool': {
          if (!known || typeof message.tool !== 'string') break;
          const disabled = new Set(known.disabledTools ?? []);
          if (message.enabled === true) disabled.delete(message.tool); else disabled.add(message.tool);
          await mcp.update(known.id, { disabledTools: [...disabled] });
          break;
        }
        case 'connect': if (known) await mcp.connectServer(known.id); break;
        case 'disconnect': if (known) await mcp.disconnect(known.id); break;
      }
    } catch (error) {
      void view.webview.postMessage({ type: 'error', text: (error as Error).message.slice(0, 500) });
    }
    await send(saved);
  }, undefined, context.subscriptions);
}

/** Saves the form; false when the user declined to let a local command run. */
async function saveServer(mcp: McpRegistry, message: Record<string, unknown>, existing: McpServerConfig | undefined): Promise<boolean> {
  const name = text(message.name, 80);
  if (!name) throw new Error('Give the server a name.');
  const transport = message.transport === 'stdio' ? 'stdio' : 'http';
  const approval = APPROVALS.includes(message.approval as McpApproval) ? message.approval as McpApproval : 'ask-for-changes';
  const url = text(message.url, 2_000);
  const headers = pairs(message.headers);
  const env = pairs(message.env);
  const config: McpServerConfig = { id: existing?.id ?? slug(name, mcp.servers().map((server) => server.id)), name, transport, approval, ...(existing?.disabledTools ? { disabledTools: existing.disabledTools } : {}) };
  if (transport === 'http') {
    if (!existing && !url) throw new Error('Enter the server URL.');
    const problem = url ? validateServerUrl(url) : undefined;
    if (problem) throw new Error(problem);
  } else {
    config.command = text(message.command, 500);
    config.args = Array.isArray(message.args) ? message.args.filter((arg): arg is string => typeof arg === 'string').map((arg) => arg.slice(0, 1_000)).slice(0, 50) : [];
    if (!config.command) throw new Error('Enter the command that starts the server.');
    const changed = !existing || existing.command !== config.command || JSON.stringify(existing.args ?? []) !== JSON.stringify(config.args);
    if (changed) {
      const run = await vscode.window.showWarningMessage(`${name} runs a program on this computer:\n\n${[config.command, ...config.args].join(' ')}\n\nIt starts when an agent first uses the server, with only a minimal environment plus the variables you set. Add it only if you trust this program.`, { modal: true }, 'Add and allow it to run');
      if (run !== 'Add and allow it to run') return false;
    }
  }
  // Blank secret fields keep what is stored; filled ones replace it.
  await mcp.save(config, {
    ...(url ? { url } : {}),
    ...(headers.length || message.clearHeaders === true ? { headers: Object.fromEntries(headers) } : {}),
    ...(env.length || message.clearEnv === true ? { env: Object.fromEntries(env) } : {})
  });
  return true;
}
