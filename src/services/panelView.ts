import * as vscode from 'vscode';

export class NearAiPanelViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'nearAiChatView';

  public constructor(private readonly onOpenChat: () => Thenable<unknown> | Promise<unknown>, private readonly onSetup: () => Thenable<unknown> | Promise<unknown>) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = panelHtml();
    webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      if (message.type === 'open-chat') await this.onOpenChat();
      if (message.type === 'setup') await this.onSetup();
    });
  }
}

function panelHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    :root { color-scheme: light dark; }
    body { padding: 16px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); line-height: 1.45; }
    h2 { margin: 0 0 8px; font-size: 15px; }
    p { margin: 0 0 16px; color: var(--vscode-descriptionForeground); }
    button { width: 100%; border: 0; border-radius: 4px; padding: 8px 10px; margin: 4px 0; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .note { margin-top: 14px; font-size: 12px; }
  </style>
</head>
<body>
  <h2>NEAR AI · Open-GSD</h2>
  <p>Private, cost-aware project planning and agent orchestration for this workspace.</p>
  <button id="open">Open NEAR AI workspace</button>
  <button id="setup" class="secondary">Set up NEAR AI</button>
  <p class="note">The full chat keeps its own session, approvals, costs, agent activity, and GSD continuity.</p>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'open-chat' }));
    document.getElementById('setup').addEventListener('click', () => vscode.postMessage({ type: 'setup' }));
  </script>
</body>
</html>`;
}
