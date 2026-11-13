import { AGENT_DEFAULTS } from '../domain/agentDefaults';
import { DEFAULT_ROLE_MODELS } from '../gsd/library';
import * as vscode from 'vscode';
import { createDefaultSettings, NearAiSettings } from '../domain/config';
import { ActionPolicyMode } from '../domain/policy';
import { clampLiveConversations, LIVE_CONVERSATIONS_DEFAULT } from '../domain/state/retention';
import { isEmergencyStopped } from './emergencyStop';
import { DEFAULT_RULES, PermissionRules } from '../agent/permissions';
import { projectChoiceFor, resolveSetting, type InspectedSetting } from './modelChoices';

const POLICY_MODES: ActionPolicyMode[] = ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'];

/**
 * 0.4.20 (D-06): a model setting resolves as an explicit workspace or folder value, then the project's choice (the state home's choices.json, which
 * every interface and computer shares), then the user value, then the default. Without a folder, or without a choice, it is exactly what it was.
 */
function projectRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function inspectedSetting(configuration: vscode.WorkspaceConfiguration, key: string): InspectedSetting | undefined {
  return typeof configuration.inspect === 'function' ? configuration.inspect(key) as InspectedSetting | undefined : undefined;
}

function projectString(key: string): string | undefined {
  const value = projectChoiceFor(projectRoot(), key);
  return typeof value === 'string' ? value : undefined;
}

export function readSettings(): NearAiSettings {
  const configuration = vscode.workspace.getConfiguration('nearAi');
  const defaults = createDefaultSettings();
  const policy = configuration.get<ActionPolicyMode>('actionPolicy', defaults.actionPolicy.mode);
  const limit = configuration.get<number>('dailySpendLimitUsd', defaults.dailySpendLimitUsd);
  return {
    baseUrl: configuration.get<string>('baseUrl', defaults.baseUrl),
    authMode: 'apiKey',
    defaultModel: resolveSetting(inspectedSetting(configuration, 'defaultModel') as InspectedSetting<string> | undefined, projectString('defaultModel'), configuration.get<string>('defaultModel', defaults.defaultModel)),
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

/** NEAR models for Open-GSD's model tiers (opus → deep, sonnet → standard, haiku → fast). */
/** Model or tier per agent role, defaulting research and mapping roles to the fast tier. */
export function readRoleModels(): Record<string, string> {
  const configuration = vscode.workspace.getConfiguration('nearAi');
  const projectRoles = projectChoiceFor(projectRoot(), 'agent.roleModels');
  const value = resolveSetting(inspectedSetting(configuration, 'agent.roleModels'), typeof projectRoles === 'object' ? projectRoles : undefined, configuration.get<unknown>('agent.roleModels', DEFAULT_ROLE_MODELS));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_ROLE_MODELS };
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0).map(([role, model]) => [role.trim(), model.trim()]));
}

export function readModelTiers(): { deep: string; standard: string; fast: string } {
  const configuration = vscode.workspace.getConfiguration('nearAi');
  const pick = (key: string, fallback: string) => {
    const value = resolveSetting(inspectedSetting(configuration, key), projectString(key), configuration.get<unknown>(key, fallback));
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  };
  return { deep: pick('agent.deepModel', AGENT_DEFAULTS.tiers.deep), standard: pick('agent.standardModel', AGENT_DEFAULTS.tiers.standard), fast: pick('agent.fastModel', AGENT_DEFAULTS.tiers.fast) };
}

/** The auto mode's safety model (nearAi.agent.safetyModel); empty means the fast tier's model. */
export function readSafetyModel(tiers: { fast: string } = readModelTiers()): string {
  const configuration = vscode.workspace.getConfiguration('nearAi');
  const value = resolveSetting(inspectedSetting(configuration, 'agent.safetyModel'), projectString('agent.safetyModel'), configuration.get<unknown>('agent.safetyModel', ''));
  return typeof value === 'string' && value.trim() ? value.trim() : tiers.fast;
}

/** 0.4.17: the two kinds of risk a project can allow once, so the same kind is not asked again. */
export function readRiskSwitches(): { outsideWorkspace: boolean; installs: boolean } {
  const configuration = vscode.workspace.getConfiguration('nearAi');
  return {
    outsideWorkspace: configuration.get<boolean>('agent.autoAllowOutsideWorkspace', false) === true,
    installs: configuration.get<boolean>('agent.autoAllowInstalls', false) === true
  };
}

/** Limits for agent runs and whether conversations are saved for resuming. */
/** Caps for one run, including its sub-agents. */
export function readRunBudget(): { maxCostUsd: number; maxTokens: number } {
  const configuration = vscode.workspace.getConfiguration('nearAi');
  const bounded = (key: string, fallback: number, min: number, max: number) => {
    const value = configuration.get<unknown>(key, fallback);
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  return { maxCostUsd: bounded('agent.maxRunCostUsd', AGENT_DEFAULTS.maxRunCostUsd, 0.1, 1_000), maxTokens: bounded('agent.maxRunTokens', AGENT_DEFAULTS.maxRunTokens, 10_000, 100_000_000) };
}

/** How many of the most recently used conversations stay live; the rest are archived, never deleted (nearAi.history.liveConversations, 1 to 50). */
export function readHistoryLimits(): { liveConversations: number } {
  const configuration = vscode.workspace.getConfiguration('nearAi');
  return { liveConversations: clampLiveConversations(configuration.get<unknown>('history.liveConversations', LIVE_CONVERSATIONS_DEFAULT)) };
}

/** How long and how much Agent Activity keeps in memory. */
export function readActivityLimits(): { maxAgeMs: number; maxBytes: number } {
  const configuration = vscode.workspace.getConfiguration('nearAi');
  const bounded = (key: string, fallback: number, min: number, max: number) => {
    const value = configuration.get<unknown>(key, fallback);
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  return { maxAgeMs: bounded('activity.retentionMinutes', 60, 5, 1_440) * 60_000, maxBytes: bounded('activity.maxMegabytes', 8, 1, 64) * 1024 * 1024 };
}

export function readAgentLimits(): { maxParallelAgents: number; maxTurns: number; saveTranscripts: boolean } {
  const configuration = vscode.workspace.getConfiguration('nearAi');
  const bounded = (key: string, fallback: number, min: number, max: number) => {
    const value = configuration.get<unknown>(key, fallback);
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
  };
  return { maxParallelAgents: bounded('agent.maxParallelAgents', AGENT_DEFAULTS.maxParallelAgents, 1, 16), maxTurns: bounded('agent.maxTurns', AGENT_DEFAULTS.maxTurns, 5, 500), saveTranscripts: configuration.get<boolean>('agent.saveTranscripts', true) !== false };
}

/** Models used for attachments and image generation. */
export function readAgentModels(): { visionModel: string; transcriptionModel: string; imageModel: string } {
  const configuration = vscode.workspace.getConfiguration('nearAi');
  const pick = (key: string, fallback: string) => {
    const value = resolveSetting(inspectedSetting(configuration, key), projectString(key), configuration.get<unknown>(key, fallback));
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  };
  return { visionModel: pick('agent.visionModel', 'z-ai/glm-5.3-flash'), transcriptionModel: pick('agent.transcriptionModel', 'openai/whisper-large-v3'), imageModel: pick('agent.imageModel', 'black-forest-labs/FLUX.2-klein-4B') };
}
