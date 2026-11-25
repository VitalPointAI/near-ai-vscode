// The model a sub-agent runs on (moved out of agentSession.ts unchanged, Phase 74.1-09), and the different-family rule for checking roles (74.1 D-19):
// a reviewer, plan checker, verifier, editor, red team, release guard or tradecraft reviewer runs on a model of none of the families the run has written
// with, allowed by the gate for a checking job; with none, it is not started and the lead and the person read why. No vscode import.
import { AGENT_DEFAULTS } from '../domain/agentDefaults';
import { DEFAULT_BASE_URL } from '../domain/config';
import { checkerForAuthors, checkingRoleOf, familyOf, preferredModels } from '../domain/gate/lineage';
import type { ModelsSection } from '../domain/gate/models';
import { ToolError } from '../agent/workspace';
import { agentModelFor, privateModelFor, roleModelFor, tierOf } from '../gsd/library';
import type { PrivacyCandidate } from '../gsd/library';
import { defaultSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { gateAllows, privateRefusal, routeAllows } from './privateRoute';
import type { PrivateRoute } from './privateRoute';

type Tiers = { readonly deep: string; readonly standard: string; readonly fast: string };

export interface SubagentModelInput {
  readonly label: string;
  /** What the Agent call asked for, and the agent file it names. */
  readonly spawn: { readonly model?: string; readonly agent?: { readonly model?: string; readonly privacy?: string; readonly role?: string } };
  /** Whether it is a team member with its own model line (its line wins over the role's model). */
  readonly teamMember: boolean;
  readonly request: {
    readonly model: string; readonly tiers: Tiers; readonly roleModels?: Record<string, string>; readonly availableModels?: string[];
    readonly modelCatalog?: PrivacyCandidate[]; readonly route?: PrivateRoute; readonly teeOnly?: boolean;
  };
  /** The models the run has written with so far (its main model and its writing members'); a writing member's model is added here. */
  readonly writing?: Set<string>;
  /** The route the checker's preview is decided on: the parent's, else the default one. */
  readonly route?: SessionRoute | undefined;
  readonly now?: number;
}

export interface SubagentModel {
  readonly model: string;
  readonly roleModel?: string;
  readonly modelNote?: string;
  /** For a checking role: the families on both sides, for its route and its records (74.1 D-23). */
  readonly checkFamilies?: { readonly author: readonly string[]; readonly checker: string };
}

/** The models a run has written with, kept per run request: its main model first, then each writing member's as it starts. */
const writingByRun = new WeakMap<object, Set<string>>();

/** The writing models of the run that `request` started (74.1-09). */
export function writingModelsOf(request: { readonly model: string }): Set<string> {
  let found = writingByRun.get(request);
  if (found === undefined) { found = new Set([request.model]); writingByRun.set(request, found); }
  return found;
}

/** The notice of a check that has no model of another family while your organization's model rules only report (74.1 D-18a, D-19). */
export function sameFamilyReportText(label: string, model: string): string {
  return `${label} runs on ${model}, and no approved model of another family than the work it checks is available here. This is allowed and recorded while your organization's model rules only report; under enforced rules it would not start.`;
}

/** Where the run's one client sends, for the gate's preview: NEAR AI Cloud's own endpoint, this computer, or another endpoint. */
function hostOf(route: PrivateRoute | undefined): { readonly clientRoute: 'near' | 'local' | undefined; readonly host: string } {
  if (route?.kind === 'local') return { clientRoute: 'local', host: 'http://127.0.0.1' };
  if (route?.kind === 'near' && route.attestation) return { clientRoute: 'near', host: DEFAULT_BASE_URL };
  return { clientRoute: route?.kind, host: 'https://endpoint.invalid' };
}

/**
 * A sub-agent's model: a team member's own model line wins; then the role's configured model; then the tier the workflow asked for. A model the call names
 * that is not on this key fails the call; a role, agent-file or tier model not on this key falls back to the chat's model with a note. A private member
 * runs on a private model or not at all. Then, for a checking role, the different-family rule.
 */
export function resolveSubagentModel(input: SubagentModelInput): SubagentModel {
  const { label, spawn, request } = input;
  const tiers = request.tiers;
  const roleModel = spawn.agent && !(input.teamMember && spawn.agent.model) ? roleModelFor(label, request.roleModels ?? {}) : undefined;
  const choice = agentModelFor({ roleModel, requested: spawn.model, agentModel: spawn.agent?.model, tiers, current: request.model, available: request.availableModels });
  if ('error' in choice && spawn.agent?.privacy !== 'private') throw new ToolError(choice.error);
  let model = 'error' in choice ? request.model : choice.model;
  let modelNote = 'error' in choice ? undefined : choice.note;
  // A member that must stay private runs on a TEE or local model, or not at all: it never falls back to a forwarded model.
  if (spawn.agent?.privacy === 'private') {
    const tier = tierOf(roleModel ?? spawn.model ?? spawn.agent.model);
    const offered = (request.modelCatalog ?? []).filter((candidate) => !request.availableModels || request.availableModels.includes(candidate.id) || candidate.id === request.model);
    // Fail closed on the route: every sub-agent is sent through this run's one client, so a model is eligible only if it is private on that client. A
    // local catalog entry is never sent to the NEAR client (NEAR would serve or forward it), and a TEE entry only goes to NEAR's own endpoint, where its
    // attestation can be checked; never to a local runtime or another endpoint claiming TEE.
    const candidates = offered.filter((candidate) => routeAllows(request.route, candidate));
    const chosen = privateModelFor(model, tier, tiers, candidates);
    if (!chosen || !routeAllows(request.route, candidates.find((candidate) => candidate.id === chosen))) throw new ToolError(privateRefusal(label, tier, request.route));
    if (chosen !== model || 'error' in choice) modelNote = `${label} must stay private, so it runs on the private model ${chosen}${'error' in choice ? ` (the requested ${spawn.model} is not a model on this key)` : ''}.`;
    model = chosen;
  }
  const base = { ...(roleModel === undefined ? {} : { roleModel }) };
  const role = checkingRoleOf(label, spawn.agent?.role);
  if (role === undefined || input.writing === undefined) {
    input.writing?.add(model);
    return { model, ...base, ...(modelNote === undefined ? {} : { modelNote }) };
  }
  // 74.1 D-19: a checker of none of the writers' families, allowed by the gate for a checking job and, for a private member or TEE-only, private.
  const now = input.now ?? Date.now();
  const route = input.route ?? defaultSessionRoute();
  let policyModels: ModelsSection | undefined;
  try { policyModels = route.routePolicy?.(now)?.models; } catch { policyModels = undefined; }
  const catalog = (request.modelCatalog ?? []).filter((candidate) => !request.availableModels || request.availableModels.includes(candidate.id));
  const preview = gateAllows({ route, catalog, ...hostOf(request.route), now });
  const strict = spawn.agent?.privacy === 'private' || request.teeOnly === true;
  const allows = (id: string): boolean => (!strict || routeAllows(request.route, catalog.find((candidate) => candidate.id === id))) && preview(id, 'safety');
  const western = [...AGENT_DEFAULTS.models.standard, ...AGENT_DEFAULTS.models.deep, ...AGENT_DEFAULTS.models.fast];
  const preference = [model, ...preferredModels(western, catalog, policyModels, now), ...catalog.map((candidate) => candidate.id)];
  const writers = [...input.writing];
  const checker = checkerForAuthors(role, writers.length > 0 ? writers : [request.model], preference, allows, { models: policyModels, now });
  if (!('model' in checker)) {
    // Under enforce the checker is not started. While your organization's model rules only report (D-18a), the check keeps its model and, when that
    // model is of a writer's family, says so; a model with no approval is already recorded as would-refuse by the passport step.
    if (policyModels?.mode === 'enforce') throw new ToolError(`${label} was not started. ${checker.reason}`);
    const own = familyOf(model, policyModels, now);
    const same = own !== undefined && checker.families.author.includes(own);
    return { model, ...base, ...(same ? { modelNote: sameFamilyReportText(label, model) } : modelNote === undefined ? {} : { modelNote }) };
  }
  const note = checker.model === model ? modelNote : `${label} checks work by the ${checker.families.author.join(' and ')} family, so it runs on ${checker.model} (${checker.families.checker} family).`;
  return { model: checker.model, ...base, ...(note === undefined ? {} : { modelNote: note }), checkFamilies: checker.families };
}
