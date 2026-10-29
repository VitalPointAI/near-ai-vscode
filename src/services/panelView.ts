import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { GSD_COMMANDS } from '../domain/gsdCommands';
import { AuthService } from './auth';
import { ChatWebviewMessage } from './chatBridge';
import { attachChatToView } from './chat';

/** The NEAR AI sidebar: a compact chat in the style of VS Code's own chat panels. */
export class NearAiPanelViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'nearAiChatView';
  private view?: vscode.WebviewView;
  private pending: unknown[] = [];
  /** Set only by the extension-host tests (NEAR_AI_E2E=1) to observe both directions of the view's messages. */
  public tap?: { toView(message: unknown): void; fromView(message: unknown): void };

  public constructor(private readonly context: vscode.ExtensionContext, private readonly auth: AuthService) {}

  public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat');
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [media] };
    webviewView.onDidDispose(() => { this.view = undefined; });
    if (this.tap) {
      const tap = this.tap;
      const post = webviewView.webview.postMessage.bind(webviewView.webview);
      webviewView.webview.postMessage = (message: unknown) => { tap.toView(message); return post(message); };
      webviewView.webview.onDidReceiveMessage((message: unknown) => tap.fromView(message));
    }
    await attachChatToView(this.context, this.auth, webviewView, sidebarHtml(webviewView.webview, media));
    for (const message of this.pending.splice(0)) void webviewView.webview.postMessage(message);
  }

  /** Starts a new conversation alongside the open ones, as the view's "New Chat" title action. */
  public async newChat(): Promise<void> {
    await this.post({ type: 'reset' });
  }

  /** Reloads models, profile, and status after setup or a profile switch. */
  public async refresh(): Promise<void> {
    await this.request({ type: 'load-models' });
    await this.request({ type: 'refresh-status' });
  }

  /** Puts a command in the composer, keeping any draft, and focuses it without sending ("Use in chat" on the Tools tab). */
  public async prefill(text: string): Promise<void> {
    await this.post({ type: 'prefill', text, insert: true });
  }

  /** Asks the view to send a host-validated intent, so host actions reuse the view's own message flow. */
  public async request(payload: ChatWebviewMessage): Promise<void> {
    await this.post({ type: 'host-request', payload });
  }

  private async post(message: unknown): Promise<void> {
    await vscode.commands.executeCommand(`${NearAiPanelViewProvider.viewId}.focus`);
    if (this.view) await this.view.webview.postMessage(message);
    else this.pending.push(message);
  }
}

export function sidebarHtml(webview: Pick<vscode.Webview, 'asWebviewUri' | 'cspSource'>, media: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  // The host replaces this list with the installed Open-GSD skills once they load.
  const commands = JSON.stringify(GSD_COMMANDS.map(({ command, title, description }) => ({ command: `gsd-${command}`, title, description })));
  const start = ['new-project', 'onboard', 'progress'].map((id) => GSD_COMMANDS.find((definition) => definition.command === id)).filter((definition) => definition !== undefined);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('chat.css')}">
<title>NEAR AI</title>
</head>
<body data-commands="${escapeAttribute(commands)}">
<nav id="conversations" aria-label="Conversations">
  <div id="conversation-tabs" role="tablist" aria-label="Open conversations (Ctrl+Shift+[ and ] switch)"></div>
  <button id="new-conversation" class="icon-button" type="button" aria-label="New conversation" title="New conversation: starts alongside the ones still running"></button>
</nav>
<div id="needs-you" role="status" hidden></div>
<main id="transcript" aria-label="Conversation" aria-live="off">
  <section id="welcome">
    <h2>Private AI for this project</h2>
    <p>Ask anything about your code, or type <strong>/</strong> for Open-GSD workflows. Models marked 🔒 run inside NEAR AI's attested TEE; others are forwarded by NEAR to another provider, and every reply says which.</p>
    <div class="suggestions">
      ${start.map((definition) => `<button type="button" data-command="gsd-${definition.command}">${escapeText(definition.title)}<small>${escapeText(definition.description)}</small></button>`).join('\n      ')}
    </div>
  </section>
</main>
<footer>
  <section id="agents" aria-label="Running agents" aria-live="polite" hidden></section>
  <section id="todos" aria-label="Task list" aria-live="polite" hidden></section>
  <nav id="project-links" aria-label="Planning files" hidden></nav>
  <section id="pending" aria-label="Waiting for your input" hidden></section>
  <div class="composer">
    <div id="commands" role="listbox" aria-label="Open-GSD commands" hidden></div>
    <div id="policy-menu" role="listbox" aria-label="Approval policy" hidden></div>
    <div id="chips" class="chips" hidden></div>
    <textarea id="input" rows="1" placeholder="Ask NEAR AI, or type / for commands" aria-label="Message NEAR AI" aria-controls="commands" aria-autocomplete="list" aria-expanded="false"></textarea>
    <div class="bar">
      <button id="profile" class="chip" type="button" title="Choose the NEAR AI profile for this project">Set up</button>
      <select id="model" aria-label="Model"><option value="">Loading models…</option></select>
      <button id="policy" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="policy-menu" title="How much the agent may do without asking">Approval…</button>
      <span class="spacer"></span>
      <button id="attach" class="icon-button" type="button" aria-label="Attach files" title="Attach images, audio, or text files"></button>
      <button id="stop" class="icon-button" type="button" aria-label="Stop" title="Stop the run (Esc in an empty message box)" hidden></button>
      <button id="send" class="icon-button" type="button" aria-label="Send"></button>
    </div>
  </div>
  <button id="status" type="button">Loading project status…</button>
  <button id="spend-token" class="link" type="button" hidden></button>
</footer>
<div id="live" class="visually-hidden" aria-live="polite"></div>
<script nonce="${nonce}" src="${asset('markdown.js')}"></script>
<script nonce="${nonce}" src="${asset('pending.js')}"></script>
<script nonce="${nonce}" src="${asset('composer.js')}"></script>
<script nonce="${nonce}" src="${asset('chat.js')}"></script>
</body>
</html>`;
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}
