import * as vscode from 'vscode';
import { AuthService } from './auth';
import { attachChatToView } from './chat';

export class NearAiPanelViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'nearAiChatView';

  public constructor(private readonly context: vscode.ExtensionContext, private readonly auth: AuthService) {}

  public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    webviewView.webview.options = { enableScripts: true };
    await attachChatToView(this.context, this.auth, webviewView);
  }
}
