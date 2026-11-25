import { DEFAULT_ROLE_MODELS, modelForTier } from '../gsd/library';
import type { ModelInfo } from './nearAiClient';
import { JOB_MINIMUM_TIER, USE_TIERS } from '../domain/gate/models';
import type { UseTier } from '../domain/gate/models';
import { ROW_USE_WORDS, catalogRows } from '../domain/gate/modelRow';
import type { ModelsSection } from '../domain/gate/models';

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
  /** The use the job needs (74.1 D-18): the chat panel and every agent role are agent work. */
  use: UseTier;
}

/** Compare Models' words about approvals (74.1-UI-SPEC S3). Placeholders in braces are filled by code. */
export const ROLE_APPROVAL_TEXT = Object.freeze({
  laneLine: 'Compare Models runs made-up tasks in the research workspace, so models approved for research only can be compared here. Putting a model to work for a job needs its approval for that job.',
  openWorkspace: 'Open Research Workspace',
  roleNotApproved: '{job} (not approved)',
  reasonLine: '{model} is approved for {use}, so jobs that need more are not offered.',
  reasonNone: '{model} is approved for research only, so it cannot be put to work for any job.',
  applyAllLeftOne: '{n} recommended change left out: its model is not approved for that job.',
  applyAllLeftMany: '{n} recommended changes left out: their models are not approved for those jobs.',
  applyRefused: 'Not applied. {model} is approved for {use}, and the {job} needs {need}. No setting was changed.'
});

/** What a model's approval covers, from its row (modelRow's `covers`). */
export interface ModelApproval { readonly covers: UseTier }

const fill = (template: string, values: Readonly<Record<string, string>>): string => template.replace(/\{([a-z]+)\}/g, (whole, key: string) => values[key] ?? whole);
const rankOf = (tier: UseTier): number => USE_TIERS.indexOf(tier);

/** Whether a model may be put to work for a job: its approval covers the job's use. A model with no approval covers research only. */
export function roleApproved(approval: ModelApproval | undefined, option: Pick<RoleOption, 'use'>): boolean {
  return rankOf(approval?.covers ?? 'T0') >= rankOf(option.use);
}

/** The reason line under a model's job control when at least one job is not offered; undefined when every job is. */
export function roleReason(model: string, approval: ModelApproval | undefined, options: readonly RoleOption[]): string | undefined {
  if (options.every((option) => roleApproved(approval, option))) return undefined;
  const covers = approval?.covers ?? 'T0';
  return covers === 'T0' ? fill(ROLE_APPROVAL_TEXT.reasonNone, { model }) : fill(ROLE_APPROVAL_TEXT.reasonLine, { model, use: ROW_USE_WORDS[covers] });
}

/** The host's refusal of a crafted apply for a job the model is not approved for. */
export function applyRefusedText(model: string, approval: ModelApproval | undefined, option: RoleOption): string {
  return fill(ROLE_APPROVAL_TEXT.applyRefused, { model, use: ROW_USE_WORDS[approval?.covers ?? 'T0'], job: option.label, need: ROW_USE_WORDS[option.use] });
}

/** The line under Apply all when recommended changes were left out. */
export function applyAllLeftOutText(count: number): string {
  return fill(count === 1 ? ROLE_APPROVAL_TEXT.applyAllLeftOne : ROLE_APPROVAL_TEXT.applyAllLeftMany, { n: String(count) });
}

/** What each model's approval covers, from its passport now (catalogRows, the picker's helper). A model with no passport covers research only. */
export function modelApprovals(ids: readonly string[], catalog: readonly ModelInfo[], section: ModelsSection | undefined, now: number): Record<string, ModelApproval> {
  const rows = catalogRows(ids.map((id) => catalog.find((model) => model.id === id) ?? { id }), section, now, { organization: false });
  return Object.fromEntries(rows.map((entry) => [entry.id, { covers: entry.row.covers }]));
}

/** A disabled job's option text. */
export function roleNotApprovedText(label: string): string {
  return fill(ROLE_APPROVAL_TEXT.roleNotApproved, { job: label });
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
    const use: UseTier = id.startsWith('tier:') ? JOB_MINIMUM_TIER[id.slice(5) as 'deep' | 'standard' | 'fast'] : 'T2';
    return { id, label, group, setting, ...(current ? { current } : {}), ...(currentPrivacy ? { currentPrivacy } : {}), use };
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
  return `${option.label} now uses ${option.current ?? 'a model'}, which runs on NEAR AI private hardware or this computer. This model runs on ${candidate === 'forwarded' ? 'an outside provider, so what that role sees leaves private hardware' : 'a place your rules do not name'}.`;
}

/**
 * The setting to write to give `option` the model. For an agent role, `layerRoles` is the roles of the layer being written (the project's own choice, or
 * the workspace value), never the resolved roles of every layer: the role is added to that layer and every other role keeps following the person's settings.
 */
export function roleUpdate(option: RoleOption, model: string, layerRoles: Record<string, string>): { setting: string; value: string | Record<string, string> } {
  if (!option.id.startsWith('role:')) return { setting: option.setting, value: model };
  return { setting: option.setting, value: { ...layerRoles, [option.id.slice(5)]: model } };
}

/** The confirmation after applying one model: a project choice (the usual case) or an explicit workspace setting. */
export function roleAppliedText(label: string, model: string, where: 'project' | 'workspace'): string {
  return `${label} now uses ${model} ${where === 'project' ? 'for this project' : 'in this workspace'}.`;
}
