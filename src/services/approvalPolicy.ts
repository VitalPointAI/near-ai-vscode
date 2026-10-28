import type { ActionPolicyMode } from '../domain/policy';

/**
 * The chat's approval-policy picker. Only the user's own choice in the chat composer reaches
 * {@link applyPolicyChoice}; no agent tool or model output path writes `nearAi.actionPolicy`.
 * This module takes its VS Code dependencies as arguments so it stays testable without a host.
 */

export const POLICY_MODES: readonly ActionPolicyMode[] = ['approve-risky', 'mostly-autonomous', 'auto', 'fully-autonomous'];

export function isPolicyMode(value: unknown): value is ActionPolicyMode {
  return typeof value === 'string' && (POLICY_MODES as readonly string[]).includes(value);
}

/** Short labels for the composer, with the setting's enumDescriptions (package.json) as tooltips. */
export const POLICY_OPTIONS: ReadonlyArray<{ mode: ActionPolicyMode; label: string; description: string; risky: boolean }> = [
  { mode: 'approve-risky', label: 'Ask before edits', description: 'File edits and shell commands ask first; reads and searches run automatically.', risky: false },
  { mode: 'mostly-autonomous', label: 'Edits auto', description: 'File edits run automatically; shell commands still ask unless allow-listed.', risky: false },
  { mode: 'auto', label: 'Auto', description: 'Auto approve: file edits run, and shell commands run when they pass the safety check. Clear cases are decided by fixed rules (builds, tests, and read-only git run; pushes, deletes, publishing, and credential paths ask); only commands the rules cannot decide go to a private (TEE) model, and anything it cannot clear asks.', risky: false },
  { mode: 'fully-autonomous', label: 'Full auto', description: 'Everything runs without asking except deny-listed commands. Use only in throwaway workspaces.', risky: true }
];

/** The scope the effective value comes from. */
export type PolicyScope = 'global' | 'workspace' | 'workspaceFolder' | 'default';

export interface PolicyInspection {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/** The subset of vscode.WorkspaceConfiguration (section `nearAi`) the picker uses. */
export interface PolicyConfiguration {
  get<T>(key: string, fallback: T): T;
  inspect(key: string): PolicyInspection | undefined;
  update(key: string, value: unknown, target: number): Thenable<void> | Promise<void>;
}

/** vscode.ConfigurationTarget, passed in so this module does not import vscode. */
export interface PolicyTargets { Global: number; Workspace: number; WorkspaceFolder: number }

export interface PolicyStateMessage {
  type: 'action-policy';
  mode: ActionPolicyMode;
  stopped: boolean;
  scope: PolicyScope;
  options: Array<{ mode: ActionPolicyMode; label: string; description: string; risky: boolean }>;
}

export function effectivePolicyScope(inspection: PolicyInspection | undefined): PolicyScope {
  if (isPolicyMode(inspection?.workspaceFolderValue)) return 'workspaceFolder';
  if (isPolicyMode(inspection?.workspaceValue)) return 'workspace';
  if (isPolicyMode(inspection?.globalValue)) return 'global';
  return 'default';
}

export function policyStateMessage(configuration: PolicyConfiguration, stopped: boolean): PolicyStateMessage {
  const value = configuration.get<unknown>('actionPolicy', 'approve-risky');
  return {
    type: 'action-policy',
    mode: isPolicyMode(value) ? value : 'approve-risky',
    stopped,
    scope: effectivePolicyScope(configuration.inspect('actionPolicy')),
    options: POLICY_OPTIONS.map((option) => ({ ...option }))
  };
}

export interface PolicyChoiceResult {
  written: boolean;
  scope?: Exclude<PolicyScope, 'default'>;
  text: string;
}

/**
 * Writes the user's choice. It goes to user settings, unless the effective value comes from the
 * workspace or folder settings: then it is written there, or it would have no effect.
 * Full auto needs a modal confirmation first; declining writes nothing.
 */
export async function applyPolicyChoice(mode: unknown, configuration: PolicyConfiguration, targets: PolicyTargets, confirm: (message: string) => Promise<boolean>): Promise<PolicyChoiceResult> {
  if (!isPolicyMode(mode)) return { written: false, text: 'That approval policy is not recognised.' };
  const option = POLICY_OPTIONS.find((candidate) => candidate.mode === mode)!;
  if (mode === 'fully-autonomous' && !(await confirm('Switch NEAR AI to Full auto? Every file edit and shell command will run without asking, except deny-listed commands. Use this only in a throwaway workspace.'))) {
    return { written: false, text: 'Approval policy unchanged.' };
  }
  const found = effectivePolicyScope(configuration.inspect('actionPolicy'));
  const scope = found === 'default' ? 'global' : found;
  const target = scope === 'workspaceFolder' ? targets.WorkspaceFolder : scope === 'workspace' ? targets.Workspace : targets.Global;
  await configuration.update('actionPolicy', mode, target);
  const where = scope === 'workspaceFolder' ? ' in this folder\'s settings (it is set there, so user settings would not apply)' : scope === 'workspace' ? ' in this workspace\'s settings (it is set there, so user settings would not apply)' : '';
  return { written: true, scope, text: `Approval policy: ${option.label}${where}.` };
}
