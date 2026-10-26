import * as vscode from 'vscode';
import { createDefaultSettings, NearAiSettings } from '../domain/config';
import { ActionPolicyMode } from '../domain/policy';
import { isEmergencyStopped } from './emergencyStop';
import { DEFAULT_RULES, PermissionRules } from '../agent/permissions';

const POLICY_MODES: ActionPolicyMode[] = ['approve-risky', 'mostly-autonomous', 'fully-autonomous'];

export function readSettings(): NearAiSettings {
  const configuration = vscode.workspace.getConfiguration('nearAi');
  const defaults = createDefaultSettings();
  const policy = configuration.get<ActionPolicyMode>('actionPolicy', defaults.actionPolicy.mode);
  const limit = configuration.get<number>('dailySpendLimitUsd', defaults.dailySpendLimitUsd);
  return {
    baseUrl: configuration.get<string>('baseUrl', defaults.baseUrl),
    authMode: 'apiKey',
    defaultModel: configuration.get<string>('defaultModel', defaults.defaultModel),
    actionPolicy: { mode: POLICY_MODES.includes(policy) ? policy : defaults.actionPolicy.mode, emergencyStop: isEmergencyStopped() },
    privacyMode: configuration.get<string>('privacyMode') === 'tee-only' ? 'tee-only' : 'standard',
    dailySpendLimitUsd: Number.isFinite(limit) && limit > 0 ? limit : 0
  };
}

export function shouldAutoInstallGsd(): boolean {
  return vscode.workspace.getConfiguration('nearAi').get<boolean>('autoInstallGsd', true);
}

/** Command allow and deny lists for the agent's Bash tool. */
export function readAgentRules(): PermissionRules {
  const configuration = vscode.workspace.getConfiguration('nearAi');
  const list = (key: string, fallback: string[]) => {
    const value = configuration.get<unknown>(key, fallback);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : fallback;
  };
  return { allowCommands: list('agent.allowCommands', DEFAULT_RULES.allowCommands), denyCommands: list('agent.denyCommands', DEFAULT_RULES.denyCommands) };
}
