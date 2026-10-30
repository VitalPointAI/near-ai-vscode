import { DEFAULT_ROLE_MODELS, modelForTier } from '../gsd/library';
import type { ModelInfo } from './nearAiClient';

// The places a model can be put to work from Compare Models: the chat's main model, the three
// tiers, and the agent roles routed by nearAi.agent.roleModels. Pure, so the page and its tests
// agree on what each role currently uses and what applying a model writes. No VS Code imports.

export interface RoleSettings { mainModel: string; tiers: { deep: string; standard: string; fast: string }; roleModels: Record<string, string> }

export type RolePrivacy = 'tee' | 'local' | 'forwarded' | 'unknown';

export interface RoleOption {
  /** `main`, `tier:deep`, `tier:standard`, `tier:fast`, or `role:<agent name or pattern>`. */
  id: string;
  label: string;
  group: 'Chat' | 'Tiers' | 'Agent roles';
  /** The nearAi setting it writes (without the `nearAi.` prefix). */
  setting: string;
  /** The model it uses now; undefined for a role that follows its agent definition. */
  current?: string;
  currentPrivacy?: RolePrivacy;
}

/** Open-GSD agents a user is most likely to route, with plain names; any other roleModels key is listed by its own name. */
const AGENT_ROLES: Array<[string, string]> = [
  ['gsd-planner', 'Planner'],
  ['gsd-executor', 'Executor (writes the code)'],
  ['gsd-verifier', 'Verifier'],
  ['gsd-code-reviewer', 'Code reviewer'],
  ['gsd-debugger', 'Debugger'],
  ['gsd-*-researcher', 'Researchers'],
  ['gsd-research-synthesizer', 'Research synthesizer'],
  ['gsd-codebase-mapper', 'Codebase mapper'],
  ['gsd-pattern-mapper', 'Pattern mapper']
];

const TIERS: Array<['deep' | 'standard' | 'fast', string]> = [['deep', 'Deep tier'], ['standard', 'Standard tier'], ['fast', 'Fast tier']];

function privacyIn(catalog: ModelInfo[], model: string | undefined): RolePrivacy | undefined {
  if (!model) return undefined;
  const info = catalog.find((candidate) => candidate.id === model);
  if (!info) return undefined;
  return info.privacyBoundary === 'tee' ? 'tee' : info.privacyBoundary === 'local' ? 'local' : info.privacyBoundary === 'cloud' ? 'forwarded' : 'unknown';
}

export function roleOptions(settings: RoleSettings, catalog: ModelInfo[]): RoleOption[] {
  const option = (id: string, label: string, group: RoleOption['group'], setting: string, current: string | undefined): RoleOption => {
    const currentPrivacy = privacyIn(catalog, current);
    return { id, label, group, setting, ...(current ? { current } : {}), ...(currentPrivacy ? { currentPrivacy } : {}) };
  };
  const names = new Map(AGENT_ROLES);
  const roles = [...new Set([...AGENT_ROLES.map(([role]) => role), ...Object.keys(DEFAULT_ROLE_MODELS), ...Object.keys(settings.roleModels)])];
  return [
    option('main', 'Main chat model', 'Chat', 'defaultModel', settings.mainModel || undefined),
    ...TIERS.map(([tier, label]) => option(`tier:${tier}`, label, 'Tiers', `agent.${tier}Model`, settings.tiers[tier])),
    // A role without a setting follows its agent definition's tier, which the page cannot know: shown without a current model.
    ...roles.map((role) => option(`role:${role}`, `${names.get(role) ?? role} (${role})`, 'Agent roles', 'agent.roleModels', settings.roleModels[role] ? modelForTier(settings.roleModels[role], settings.tiers, settings.mainModel) : undefined))
  ];
}

/** The roles a model holds now, by label (e.g. ["Deep tier", "Planner (gsd-planner)"]). */
export function heldRoles(model: string, options: RoleOption[]): string[] {
  return options.filter((option) => option.current === model).map((option) => option.label);
}

/** A warning when moving a role from a private model to one NEAR forwards elsewhere; undefined otherwise. */
export function privacyWarning(candidate: RolePrivacy, option: RoleOption): string | undefined {
  if (candidate !== 'forwarded' && candidate !== 'unknown') return undefined;
  if (option.currentPrivacy !== 'tee' && option.currentPrivacy !== 'local') return undefined;
  return `${option.label} now uses a private model (${option.current}). This model ${candidate === 'forwarded' ? 'is forwarded outside NEAR’s TEE, so what that role sees is not private' : 'has unknown privacy'}.`;
}

/** The setting to write to give `option` the model; roleModels keeps every other role as it is. */
export function roleUpdate(option: RoleOption, model: string, roleModels: Record<string, string>): { setting: string; value: string | Record<string, string> } {
  if (!option.id.startsWith('role:')) return { setting: option.setting, value: model };
  return { setting: option.setting, value: { ...roleModels, [option.id.slice(5)]: model } };
}
