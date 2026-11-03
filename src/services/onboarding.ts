import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { layoutProbeAsset, layoutProbeTag, registerLayoutProbe, sharedMedia } from './layoutProbe';

export interface OnboardingActions {
  openApiKeyPortal: () => Promise<void>;
  configureApiKey: () => Promise<void>;
  showProgress: () => Promise<void>;
}

export function openOnboarding(context: vscode.ExtensionContext, actions: OnboardingActions): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel('nearAiOnboarding', 'Near AI: First Project', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [onboardingMedia(context.extensionUri), sharedMedia(context.extensionUri)]
  });
  panel.webview.html = onboardingHtml(panel.webview, context.extensionUri);
  registerLayoutProbe('onboarding', panel.webview);
  panel.webview.onDidReceiveMessage(async (message: { type?: string }) => {
    if (message.type === 'configure-api-key') await actions.configureApiKey();
    if (message.type === 'open-api-key-portal') await actions.openApiKeyPortal();
    if (message.type === 'show-progress') await actions.showProgress();
    if (message.type === 'complete') {
      void vscode.window.showInformationMessage('You are ready. Open the chat to start your first GSD project.');
      await vscode.commands.executeCommand('nearAi.openChat');
    }
  }, undefined, context.subscriptions);
  return panel;
}

function onboardingHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const shared = sharedMedia(extensionUri);
  const asset = (folder: vscode.Uri, file: string) => webview.asWebviewUri(vscode.Uri.joinPath(folder, file)).toString();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<title>Near AI for VSCode: First Project</title>
<link rel="stylesheet" href="${asset(shared, 'base.css')}">
<link rel="stylesheet" href="${asset(onboardingMedia(extensionUri), 'onboarding.css')}">
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
  <p class="note"><strong>New to GSD?</strong> You do not need to memorize commands. The chat will explain each step, show what is happening, and ask before any risky change.</p>
  ${layoutProbeTag(nonce, layoutProbeAsset(webview, shared))}<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: button.dataset.action })));
    window.addEventListener('message', (event) => { if (event.data && event.data.type === 'layout-probe' && window.nearAiLayoutProbe) vscode.postMessage(window.nearAiLayoutProbe()); });
  </script>
</body></html>`;
}

function onboardingMedia(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'media', 'onboarding');
}
