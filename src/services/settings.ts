import * as vscode from 'vscode';
import { AuthMode, createDefaultSettings, NearAiSettings } from '../domain/config';
import { ActionPolicyMode } from '../domain/policy';

export function readSettings(): NearAiSettings {
  const configuration = vscode.workspace.getConfiguration('nearAi');
  const defaults = createDefaultSettings();
  const mode = configuration.get<AuthMode>('authMode', defaults.authMode);
  const actionPolicy = configuration.get<ActionPolicyMode>('actionPolicy', defaults.actionPolicy.mode);
  return {
    baseUrl: configuration.get<string>('baseUrl', defaults.baseUrl),
    authMode: mode === 'nearAccount' ? 'nearAccount' : 'apiKey',
    defaultModel: configuration.get<string>('defaultModel', defaults.defaultModel),
    actionPolicy: { mode: actionPolicy, emergencyStop: false }
  };
}

export function shouldAutoInstallGsd(): boolean {
  return vscode.workspace.getConfiguration('nearAi').get<boolean>('autoInstallGsd', true);
}
