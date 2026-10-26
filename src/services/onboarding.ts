import * as vscode from 'vscode';

export interface OnboardingActions {
  openApiKeyPortal: () => Promise<void>;
  configureApiKey: () => Promise<void>;
  openStaking: () => Promise<void>;
  showProgress: () => Promise<void>;
}

export function openOnboarding(context: vscode.ExtensionContext, actions: OnboardingActions): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel('nearAiOnboarding', 'Near AI: First Project', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true
  });
  panel.webview.html = onboardingHtml(panel.webview);
  panel.webview.onDidReceiveMessage(async (message: { type?: string }) => {
    if (message.type === 'configure-api-key') await actions.configureApiKey();
    if (message.type === 'open-api-key-portal') await actions.openApiKeyPortal();
    if (message.type === 'open-staking') await actions.openStaking();
    if (message.type === 'show-progress') await actions.showProgress();
    if (message.type === 'complete') {
      void vscode.window.showInformationMessage('You are ready. Open the chat to start your first GSD project.');
      await vscode.commands.executeCommand('nearAi.openChat');
    }
  }, undefined, context.subscriptions);
  return panel;
}

function onboardingHtml(webview: vscode.Webview): string {
  const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Near AI for VSCode — First Project</title>
<style>
  :root { color-scheme: dark; --near-orange: #ffb81c; --near-purple: #8b5cf6; --panel: #171717; --muted: #a3a3a3; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 860px; margin: 0 auto; padding: 36px 28px 56px; line-height: 1.55; }
  .hero { border: 1px solid color-mix(in srgb, var(--near-orange) 45%, transparent); background: linear-gradient(135deg, color-mix(in srgb, var(--near-purple) 22%, transparent), color-mix(in srgb, var(--near-orange) 12%, transparent)); border-radius: 18px; padding: 30px; }
  .mark { display: inline-flex; width: 44px; height: 44px; align-items: center; justify-content: center; border-radius: 14px; background: linear-gradient(135deg, var(--near-orange), #ff7a18); color: #161616; font-weight: 900; font-size: 20px; animation: breathe 2.2s ease-in-out infinite; }
  @keyframes breathe { 50% { transform: translateY(-3px) scale(1.04); box-shadow: 0 0 24px color-mix(in srgb, var(--near-orange) 50%, transparent); } }
  h1 { margin: 18px 0 8px; font-size: 30px; } h2 { margin-top: 34px; font-size: 20px; } p { color: var(--muted); }
  .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 24px 0; }
  .step { border: 1px solid var(--vscode-editorWidget-border); border-radius: 12px; padding: 15px; background: color-mix(in srgb, var(--panel) 75%, transparent); }
  .number { color: var(--near-orange); font-weight: 800; } .step strong { display: block; margin: 8px 0 4px; } .step span { color: var(--muted); font-size: 13px; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; } button { border: 0; border-radius: 8px; padding: 10px 15px; cursor: pointer; font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); } button:hover { background: var(--vscode-button-hoverBackground); } button.primary { background: var(--near-orange); color: #151515; font-weight: 700; }
  .note { border-left: 3px solid var(--near-purple); padding-left: 14px; color: var(--muted); } code { color: var(--near-orange); }
  @media (prefers-reduced-motion: reduce) { .mark { animation: none; } }
</style>
</head>
<body>
  <section class="hero" aria-labelledby="title">
    <div class="mark" aria-label="NEAR">N</div>
    <h1 id="title">Build your first project with Near AI + GSD</h1>
    <p>GSD turns a big idea into a clear sequence: understand the project, plan a phase, build it, verify it, and keep going. Near AI gives the agents a private, cost-aware model provider inside your VS Code workflow.</p>
    <div class="actions"><button class="primary" data-action="complete">Start my first project</button><button data-action="show-progress">View GSD progress</button></div>
  </section>
  <h2>Your guided path</h2>
  <div class="steps" role="list">
    <div class="step" role="listitem"><div class="number">01</div><strong>Get oriented</strong><span>Understand what the agents will do and what GSD files mean.</span></div>
    <div class="step" role="listitem"><div class="number">02</div><strong>Connect privately</strong><span>Add the NEAR AI Cloud API key used for inference.</span></div>
    <div class="step" role="listitem"><div class="number">03</div><strong>Set guardrails</strong><span>Reads and planning are automatic; risky actions ask first.</span></div>
    <div class="step" role="listitem"><div class="number">04</div><strong>Describe the idea</strong><span>Chat through the project brief and let GSD create the plan.</span></div>
    <div class="step" role="listitem"><div class="number">05</div><strong>Keep momentum</strong><span>Watch phase, plan, agent, cost, and verification progress below chat.</span></div>
  </div>
  <h2>Connect NEAR AI Cloud</h2>
  <p>Inference requires a NEAR AI Cloud API key. Paste it into the extension and credentials stay in VS Code SecretStorage: they are never written into your project files or sent to an agent as configuration text.</p>
  <div class="actions"><button data-action="open-api-key-portal">Get a NEAR AI Cloud API key</button><button data-action="configure-api-key">I already have a key</button></div>
  <p class="note"><strong>Staking is separate.</strong> A NEAR account or external wallet may be connected later to view entitlement and authorize staking transactions; it does not authenticate Cloud inference or replace the API key. <button data-action="open-staking">Open staking controls</button></p>
  <p class="note"><strong>New to GSD?</strong> You do not need to memorize commands. The chat will explain each step, show what is happening, and ask before any risky change.</p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: button.dataset.action })));
  </script>
</body></html>`;
}
