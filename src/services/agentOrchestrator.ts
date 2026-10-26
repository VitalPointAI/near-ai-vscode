import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentCapability, AgentLocality, AgentProfile, AgentRole, AcceptedAgentTeam } from '../domain/agents';
import type { TeamBinding, MemberCapabilityContract } from '../domain/teamStudio';
import type { ActionCapability } from '../domain/policy';
import type { AgentLifecycleEvent, AgentLimits, AgentLifecycleStatus, RouteCandidate, RouteSelection, RoutingExplanation, RoutingRequest } from '../domain/routing';
import type { CapabilityPrivacyBoundary } from '../domain/capabilities';
import type { MemoryScope, MemorySlice } from '../domain/contextGraph';
import { AgentProfileStore } from './agentProfiles';
import { ProjectInitialization } from './projectInitialization';
import { ReputationStore } from './reputation';
import { PolicyGate } from './policyGate';
import { CapabilityRouter } from './capabilityRouter';
import { ContextGraphMemory } from './contextGraphMemory';
import { TeamStudioStore, validateTeamBinding } from './teamStudio';
import { defaultActionPolicy } from '../domain/policy';
import { PrivacyPreflight } from './privacyPreflight';

export interface AgentOrchestratorOptions {
  clock?: () => string;
  limits?: Partial<AgentLimits>;
  profiles?: AgentProfileStore;
  team?: ProjectInitialization;
  reputation?: ReputationStore;
  policyGate?: PolicyGate;
  teamBinding?: TeamBinding;
  requireBoundTeam?: boolean;
  capabilityRouter?: CapabilityRouter;
  contextMemory?: ContextGraphMemory;
  contextGraphMemory?: ContextGraphMemory;
}
export interface DeployRequest extends RoutingRequest { profileId?: string; model?: string; actionCapability?: ActionCapability; providerBoundary?: 'local' | 'cloud' | 'tee' | 'unknown'; estimatedCostUsd?: number; teamId?: string; teamVersion?: number; projectId?: string; organizationProfileId?: string; }
export interface OrchestratedAgent { id: string; profileId: string; role: AgentRole; task: string; model: string; route: string; status: AgentLifecycleStatus; startedAt: string; updatedAt: string; costUsd: number; durationMs: number; events: AgentLifecycleEvent[]; explanation: RoutingExplanation; memorySlice?: Pick<MemorySlice, 'sliceId' | 'scopes' | 'graphVersions' | 'nodeIds' | 'edgeIds' | 'factIds' | 'privacy'>; projectId?: string; organizationProfileId?: string; capabilityRequirementId?: string; capabilitySnapshotId?: string; routeSnapshot?: { provider: string; model?: string; locality: AgentLocality; privacyBoundary?: string; capturedAt: string }; }
export interface FleetSnapshot { agents: OrchestratedAgent[]; counts: Record<AgentLifecycleStatus, number>; spendUsd: number; active: number; }
export interface HostTeamInvocationRequest { teamId: string; version: number; role: AgentRole; task: string; requiredCapabilities: AgentCapability[]; actionCapability?: ActionCapability; }

const roleCapabilities: Record<AgentRole, AgentCapability[]> = { planner: ['read', 'plan'], implementer: ['read', 'plan', 'write'], reviewer: ['read', 'review'], security: ['read', 'security'], tester: ['read', 'test'], researcher: ['read', 'plan', 'network'] };
const terminal = new Set<AgentLifecycleStatus>(['completed', 'failed', 'cancelled', 'limit-blocked']);
const transitions: Record<AgentLifecycleStatus, AgentLifecycleStatus[]> = { queued: ['running', 'cancelled', 'limit-blocked'], running: ['waiting', 'paused', 'completed', 'failed', 'cancelled'], waiting: ['running', 'paused', 'cancelled', 'failed'], paused: ['running', 'cancelled'], completed: [], failed: [], cancelled: [], 'limit-blocked': [] };

export class AgentOrchestrator {
  private readonly workspaceRoot: string;
  private readonly clock: () => string;
  private readonly limits: AgentLimits;
  private readonly profiles: AgentProfileStore;
  private readonly team?: ProjectInitialization;
  private readonly reputation: ReputationStore;
  private readonly policyGate?: PolicyGate;
  private readonly teamBinding?: TeamBinding;
  private readonly requireBoundTeam: boolean;
  private readonly capabilityRouter: CapabilityRouter;
  private readonly contextMemory?: ContextGraphMemory;
  private readonly agents = new Map<string, OrchestratedAgent>();
  private readonly events: AgentLifecycleEvent[] = [];
  private loaded = false;
  private loading: Promise<void> | undefined;
  public constructor(workspaceRoot: string, options: AgentOrchestratorOptions = {}) {
    this.workspaceRoot = workspaceRoot;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.limits = { maxConcurrent: positive(options.limits?.maxConcurrent, 3), maxSpendUsd: nonNegative(options.limits?.maxSpendUsd, 10), maxDurationMs: positive(options.limits?.maxDurationMs, 60 * 60 * 1000) };
    this.profiles = options.profiles ?? new AgentProfileStore(workspaceRoot);
    this.team = options.team;
    this.reputation = options.reputation ?? new ReputationStore(workspaceRoot, { clock: this.clock });
    this.policyGate = options.policyGate;
    this.teamBinding = options.teamBinding;
    this.requireBoundTeam = options.requireBoundTeam === true;
    this.capabilityRouter = options.capabilityRouter ?? new CapabilityRouter({ clock: this.clock });
    this.contextMemory = options.contextMemory ?? options.contextGraphMemory;
  }
  public async route(request: RoutingRequest): Promise<RouteSelection> {
    await this.rehydrate();
    const binding = this.validatedTeamBinding();
    const profiles = await this.profiles.list();
    if (this.requireBoundTeam && !binding) throw new Error('Bind a reusable team version to this project before invocation.');
    const team = this.team ? await this.team.requireAccepted() : undefined;
    const memorySlice = this.contextMemory && request.memory ? await this.contextMemory.slice({ ...request.memory, task: request.task, scopes: request.memory.scopes ?? derivedScopes(request.memory), providerBoundary: request.memory.providerBoundary ?? (request.locality === 'local' ? 'local' : 'local') }) : undefined;
    const boundMembers = binding?.members.filter((member) => member.role === request.role) ?? [];
    if (this.requireBoundTeam && !boundMembers.length) throw new Error(`The bound team has no ${request.role} member.`);
    const assigned = boundMembers.length ? boundMembers.map((row) => row.profileId).filter((value): value is string => Boolean(value)) : team?.roles.filter((row) => row.role === request.role).map((row) => row.profileId) ?? [];
    const scores = await this.reputation.scores(profiles, request.role, request.now ?? this.clock());
    const requirement = request.capabilityRequirement ?? request.capability;
    const candidates: RouteCandidate[] = await Promise.all(profiles.filter((profile) => !assigned.length || assigned.includes(profile.identity.profileId)).map(async (profile) => {
      const member = boundMembers.find((candidate) => !candidate.profileId || candidate.profileId === profile.identity.profileId);
      const score = scores.find((row) => row.profileId === profile.identity.profileId)!;
      const exclusions: string[] = [];
      const provider = member?.providerRoute.provider ?? request.provider ?? profile.routing.preferredProvider;
      const locality = member?.providerRoute.locality ?? request.locality ?? profile.routing.locality;
      const model = request.model ?? member?.providerRoute.model ?? profile.routing.preferredModel;
      const privacyBoundary = member?.providerRoute.privacyBoundary ?? request.privacyBoundary;
      if (profile.lifecycle !== 'ready') exclusions.push(`profile lifecycle is ${profile.lifecycle}`);
      if (score.optedOut) exclusions.push('profile opted out of reputation routing');
      if (profile.identity.role !== request.role) exclusions.push(`role is ${profile.identity.role}`);
      for (const capability of request.requiredCapabilities) if (!profile.capabilities.includes(capability)) exclusions.push(`missing capability ${capability}`);
      if (request.provider && provider !== request.provider) exclusions.push(`provider preference differs from ${request.provider}`);
      if (request.locality && locality !== request.locality && locality !== 'hybrid') exclusions.push(`locality cannot satisfy ${request.locality}`);
      if (request.privacyBoundary === 'local' && locality === 'cloud') exclusions.push('privacy boundary requires local inference');
      if (member && !request.requiredCapabilities.every((capability) => member.capabilities.includes(capability))) exclusions.push('bound member contract does not allow every requested skill');
      if (member && request.provider && member.providerRoute.provider !== request.provider) exclusions.push('bound member provider route differs from request');
      if (member && request.locality && member.providerRoute.locality !== request.locality && member.providerRoute.locality !== 'hybrid') exclusions.push(`bound member locality cannot satisfy ${request.locality}`);
      const capability = requirement ? await this.capabilityRouter.evaluate({ profileId: profile.identity.profileId, provider, model, locality, privacyBoundary: privacyBoundary === 'hybrid' ? 'hybrid' : privacyBoundary, memberSkills: undefined, estimatedCostUsd: (request as DeployRequest).estimatedCostUsd }, requirement) : undefined;
      if (capability && !capability.compatible) exclusions.push(...capability.reasons.map((reason) => `capability ${reason}`));
      return { profile, role: request.role, capabilities: profile.capabilities, provider, locality, model, privacyBoundary, reputation: score, capability, eligible: exclusions.length === 0 && score.score >= this.reputation.getConfig().minimumEligibility, exclusions };
    }));
    const eligible = candidates.filter((candidate) => candidate.eligible);
    if (!eligible.length) throw new Error(`No eligible ${request.role} agent satisfies the requested capabilities and privacy/provider constraints.`);
    const config = this.reputation.getConfig();
    const explore = eligible.length > 1 && config.explorationRate > 0 && this.explorationDue(request);
    const ordered = [...eligible].sort((a, b) => b.reputation.score - a.reputation.score || a.profile.identity.profileId.localeCompare(b.profile.identity.profileId));
    const selected = explore ? ordered[ordered.length - 1] : ordered[0];
    const explanation: RoutingExplanation = { role: request.role, task: safeText(request.task, 200), candidatesConsidered: candidates.map((candidate) => ({ profileId: candidate.profile.identity.profileId, name: candidate.profile.identity.memorableName, eligible: candidate.eligible, score: candidate.reputation.score, exclusions: candidate.exclusions, capability: candidate.capability ? { status: candidate.capability.status, reasons: candidate.capability.reasons, snapshotId: candidate.capability.snapshot?.snapshotId, freshness: candidate.capability.snapshot?.freshness } : undefined })), constraints: [...request.requiredCapabilities.map((capability) => `requires ${capability}`), requirement ? `capability requirement ${requirement.requirementId}` : 'generic text route', request.provider ? `provider ${request.provider}` : 'provider preference allowed', request.locality ? `locality ${request.locality}` : 'locality preference allowed', request.privacyBoundary ? `privacy boundary ${request.privacyBoundary}` : 'privacy boundary not further restricted'], scoreComponents: selected.reputation.components, decayTimestamp: selected.reputation.decayedAt, exploration: { applied: explore, rate: config.explorationRate, reason: explore ? 'lower-scoring eligible candidate selected to prevent a permanent routing loop' : 'highest explainable eligible score selected' }, selectedProfileId: selected.profile.identity.profileId, selectedRoute: { provider: selected.provider, locality: selected.locality, model: selected.model }, capabilityRequirementId: selected.capability?.requirementId, capabilitySnapshotId: selected.capability?.snapshot?.snapshotId, capabilityFreshness: selected.capability?.snapshot?.freshness, reason: explore ? 'Exploration allowance kept an eligible lower-scoring profile in rotation after capability and policy checks.' : 'Selected the highest-scoring eligible profile after capability and policy constraints.' };
    if (memorySlice) { explanation.memory = memoryMetadata(memorySlice); explanation.constraints.push(`memory slice ${memorySlice.sliceId} · ${memorySlice.scopes.map((scope) => `${scope.kind}:${scope.id}`).join(', ')} · ${memorySlice.factIds.length} facts`); }
    return { candidate: selected, explanation };
  }
  public selectRoute(request: RoutingRequest): Promise<RouteSelection> { return this.route(request); }
  public async deploy(request: DeployRequest): Promise<OrchestratedAgent> {
    const binding = this.validatedTeamBinding();
    await this.rehydrate();
    if (this.requireBoundTeam && !binding) throw new Error('Bind a reusable team version to this project before invocation.');
    if (binding && (request.teamId !== undefined && request.teamId !== binding.teamId || request.teamVersion !== undefined && request.teamVersion !== binding.teamVersion)) throw new Error('The requested team version does not match the bound project version.');
    const route = await this.route(request.memory && request.providerBoundary ? { ...request, memory: { ...request.memory, providerBoundary: request.memory.providerBoundary ?? request.providerBoundary } } : request);
    const member = this.memberFor(route.candidate.profile.identity.profileId, request.role, binding);
    if (this.requireBoundTeam && !member) throw new Error('The selected route is outside the bound team member contract.');
    if (request.profileId && request.profileId !== route.candidate.profile.identity.profileId) throw new Error('Requested profile is not the selected eligible route.');
    if (this.activeCount() >= this.limits.maxConcurrent) throw new Error('Agent concurrency limit reached.');
    const estimated = request.estimatedCostUsd ?? 0;
    if (this.totalSpend() + estimated > this.limits.maxSpendUsd) throw new Error('Agent spend limit reached.');
    if (member && estimated > member.budget.requestUsd) throw new Error('Agent request exceeds the bound member budget.');
    if (member && request.actionCapability && !member.tools.includes(request.actionCapability)) throw new Error('Requested action is outside the bound member tool contract.');
    if (this.policyGate) { const decision = this.policyGate.decideAction(request.actionCapability ?? 'plan', { provider: route.candidate.provider, providerBoundary: request.providerBoundary ?? (route.candidate.locality === 'local' ? 'local' : 'cloud'), capability: request.actionCapability === 'network' ? 'network' : undefined, context: memoryPolicyContext(route.explanation.memory) }); if (!decision.allowed) throw new Error(`Policy-gated dispatch denied: ${decision.reason}`); }
    const now = this.clock(); const capabilityRequirement = request.capabilityRequirement ?? request.capability; const routeSnapshot = { provider: route.candidate.provider, model: route.candidate.model, locality: route.candidate.locality, privacyBoundary: route.candidate.privacyBoundary, capturedAt: now }; const agent: OrchestratedAgent = { id: `agent-run-${randomUUID().replace(/-/g, '').slice(0, 16)}`, profileId: route.candidate.profile.identity.profileId, role: request.role, task: safeText(request.task, 240), model: safeText(request.model ?? route.candidate.model ?? 'default', 160), route: safeText(`${route.candidate.locality}:${route.candidate.provider}`, 180), status: 'running', startedAt: now, updatedAt: now, costUsd: estimated, durationMs: 0, events: [], explanation: route.explanation, memorySlice: route.explanation.memory, projectId: request.projectId, organizationProfileId: request.organizationProfileId, capabilityRequirementId: capabilityRequirement?.requirementId, capabilitySnapshotId: route.candidate.capability?.snapshot?.snapshotId, routeSnapshot };
    this.agents.set(agent.id, agent); this.appendEvent(agent, 'running', { costUsd: estimated }); await this.persist(); return clone(agent);
  }
  public inspect(agentId: string): OrchestratedAgent | undefined { const agent = this.agents.get(agentId); return agent ? clone(agent) : undefined; }
  public list(): OrchestratedAgent[] { return [...this.agents.values()].map(clone); }
  public async transition(agentId: string, status: AgentLifecycleStatus, details: { costUsd?: number; durationMs?: number; error?: string; outcome?: 'success' | 'failure' | 'partial'; feedback?: number } = {}): Promise<OrchestratedAgent> {
    await this.rehydrate();
    const agent = this.agents.get(agentId); if (!agent) throw new Error('Unknown agent.');
    if (!transitions[agent.status].includes(status)) throw new Error(`Invalid agent transition ${agent.status} -> ${status}.`);
    const duration = details.durationMs ?? (status === 'completed' || terminal.has(status) ? Math.max(0, Date.parse(this.clock()) - Date.parse(agent.startedAt)) : agent.durationMs);
    if (duration > this.limits.maxDurationMs && !terminal.has(agent.status)) { status = 'limit-blocked'; details.error = 'Agent duration limit reached.'; }
    if (details.costUsd !== undefined && this.totalSpend() - agent.costUsd + details.costUsd > this.limits.maxSpendUsd) { status = 'limit-blocked'; details.error = 'Agent spend limit reached.'; }
    agent.status = status; agent.updatedAt = this.clock(); agent.durationMs = duration; if (details.costUsd !== undefined) agent.costUsd = clamp(details.costUsd, 0, this.limits.maxSpendUsd); if (details.error) agent.events.push(this.event(agent, status, { error: safeText(details.error, 200) })); else this.appendEvent(agent, status, { costUsd: agent.costUsd, durationMs: duration, outcome: details.outcome });
    if (details.outcome && (status === 'completed' || status === 'failed')) await this.recordOutcome(agent, details.outcome, details.feedback);
    await this.persist();
    return clone(agent);
  }
  public pause(agentId: string): Promise<OrchestratedAgent> { return this.transition(agentId, 'paused'); }
  public async resume(agentId: string): Promise<OrchestratedAgent> { await this.rehydrate(); const agent = this.agents.get(agentId); if (!agent) throw new Error('Unknown agent.'); if (agent.status !== 'paused' && agent.status !== 'waiting') throw new Error('Only paused or waiting agents can resume.'); if (this.policyGate) { const decision = this.policyGate.decideAction('plan', { provider: agent.route.split(':').slice(1).join(':'), providerBoundary: agent.route.startsWith('local:') ? 'local' : 'cloud', context: agent.task }); if (!decision.allowed) throw new Error(`Policy-gated resume denied: ${decision.reason}`); } return this.transition(agentId, 'running'); }
  public cancel(agentId: string): Promise<OrchestratedAgent> { return this.transition(agentId, 'cancelled', { outcome: 'failure' }); }
  public async recordOutcome(agent: OrchestratedAgent, outcome: 'success' | 'failure' | 'partial', feedback?: number): Promise<void> { const base = `${agent.id}:${outcome}`; const capability = { capabilityRequirementId: agent.capabilityRequirementId, capabilitySnapshotId: agent.capabilitySnapshotId }; await this.reputation.record({ evidenceId: this.reputation.evidenceId(`${base}:outcome`), profileId: agent.profileId, role: agent.role, kind: 'verifiedOutcome', value: outcome === 'success' ? 1 : outcome === 'partial' ? 0.2 : -1, recordedAt: agent.updatedAt, source: 'runtime', outcome, ...capability }); if (agent.durationMs > this.limits.maxDurationMs / 2) await this.reputation.record({ evidenceId: this.reputation.evidenceId(`${base}:latency`), profileId: agent.profileId, role: agent.role, kind: 'latency', value: -0.2, recordedAt: agent.updatedAt, source: 'runtime', outcome, ...capability }); if (feedback !== undefined) await this.reputation.record({ evidenceId: this.reputation.evidenceId(`${base}:feedback`), profileId: agent.profileId, role: agent.role, kind: 'userFeedback', value: clamp(feedback, -1, 1), recordedAt: agent.updatedAt, source: 'user', outcome, ...capability }); }
  public snapshot(): FleetSnapshot { const agents = this.list(); const counts = Object.fromEntries(['queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled', 'limit-blocked'].map((status) => [status, agents.filter((agent) => agent.status === status).length])) as Record<AgentLifecycleStatus, number>; return { agents, counts, spendUsd: this.totalSpend(), active: this.activeCount() }; }
  public getEvents(): AgentLifecycleEvent[] { return this.events.map(clone); }
  public getTeamBinding(): TeamBinding | undefined { const binding = this.validatedTeamBinding(); return binding ? clone(binding) : undefined; }
  public async rehydrate(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      this.loaded = true;
      try {
        const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as { agents?: unknown[] };
        if (!Array.isArray(parsed.agents)) return;
        for (const value of parsed.agents.slice(0, 50)) {
          const agent = normalizeAgent(value);
          if (!agent) continue;
          if (agent.status === 'running' || agent.status === 'waiting') agent.status = 'paused';
          this.agents.set(agent.id, agent);
          this.events.push(...agent.events);
        }
      } catch { /* A missing ledger is a first-run state. */ }
    })();
    await this.loading;
  }
  private appendEvent(agent: OrchestratedAgent, status: AgentLifecycleStatus, details: { costUsd?: number; durationMs?: number; outcome?: 'success' | 'failure' | 'partial' } = {}): void { const event = this.event(agent, status, details); agent.events.push(event); this.events.push(event); }
  private event(agent: OrchestratedAgent, status: AgentLifecycleStatus, details: { costUsd?: number; durationMs?: number; error?: string; outcome?: 'success' | 'failure' | 'partial' }): AgentLifecycleEvent { return { version: 1, id: `event-${randomUUID().replace(/-/g, '').slice(0, 16)}`, timestamp: this.clock(), agentId: agent.id, profileId: agent.profileId, role: agent.role, task: safeText(agent.task, 240), model: safeText(agent.model, 160), route: safeText(agent.route, 180), status, costUsd: details.costUsd, durationMs: details.durationMs, approvalRequired: false, error: details.error, outcome: details.outcome, projectId: agent.projectId, organizationProfileId: agent.organizationProfileId, capabilityRequirementId: agent.capabilityRequirementId, capabilitySnapshotId: agent.capabilitySnapshotId, routeSnapshot: agent.routeSnapshot }; }
  private activeCount(): number { return [...this.agents.values()].filter((agent) => ['running', 'waiting', 'paused'].includes(agent.status)).length; }
  private totalSpend(): number { return [...this.agents.values()].reduce((sum, agent) => sum + agent.costUsd, 0); }
  private explorationDue(request: RoutingRequest): boolean { const hour = Number((Date.parse(request.now ?? this.clock()) / 3600000).toFixed(0)); return hour % 5 === 0; }
  private memberFor(profileId: string, role: AgentRole, binding = this.validatedTeamBinding()): MemberCapabilityContract | undefined { return binding?.members.find((member) => member.role === role && (!member.profileId || member.profileId === profileId)); }
  private validatedTeamBinding(): TeamBinding | undefined { return this.teamBinding ? validateTeamBinding(this.teamBinding) : undefined; }
  private get filePath(): string { return path.join(this.workspaceRoot, '.planning', '.near-ai', 'agent-orchestrator.json'); }
  private async persist(): Promise<void> { const file = this.filePath; const rows = [...this.agents.values()].slice(-50).map((agent) => ({ ...agent, task: safeText(agent.task, 240), events: agent.events.slice(-20) })); try { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify({ version: 1, agents: rows })}\n`, 'utf8'); } catch { /* Durable persistence is best effort; dispatch remains in-memory safe. */ } }
}

/**
 * Host-only entry point for the production team invocation seam. The caller supplies
 * only stable IDs and bounded task intent; project identity, binding integrity, profile
 * selection, policy, and routing facts are resolved here before deployment.
 */
export async function invokeBoundTeam(workspaceRoot: string, teams: TeamStudioStore, request: HostTeamInvocationRequest): Promise<OrchestratedAgent> {
  const projectId = `project-${createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 32)}`;
  const initialization = new ProjectInitialization(workspaceRoot);
  const accepted = await initialization.requireAccepted();
  if (!accepted.accepted) throw new Error('Accept or customize the project team before invoking a reusable team.');
  const team = await teams.get(request.teamId);
  if (!team) throw new Error('Unknown or deleted team.');
  if (team.archivedAt) throw new Error('Archived teams must be restored before invocation.');
  await teams.preview(request.teamId, request.version);
  const existing = await initialization.getReusableBinding();
  if (existing && (existing.teamId !== request.teamId || existing.teamVersion !== request.version)) throw new Error('The requested team version does not match the bound project version.');
  const binding = existing ?? await teams.bindProject(workspaceRoot, { teamId: request.teamId, version: request.version, projectId }, initialization);
  const validatedBinding = validateTeamBinding(await initialization.requireReusableBinding());
  if (validatedBinding.teamId !== request.teamId || validatedBinding.teamVersion !== request.version || validatedBinding.projectId !== projectId) throw new Error('The persisted team binding does not match the requested exact project version.');
  const orchestrator = new AgentOrchestrator(workspaceRoot, {
    profiles: new AgentProfileStore(workspaceRoot),
    team: initialization,
    teamBinding: binding,
    requireBoundTeam: true,
    capabilityRouter: new CapabilityRouter({ catalog: [] }),
    policyGate: new PolicyGate(defaultActionPolicy(), new PrivacyPreflight())
  });
  return orchestrator.deploy({ role: request.role, task: request.task, requiredCapabilities: request.requiredCapabilities, actionCapability: request.actionCapability ?? 'plan', teamId: request.teamId, teamVersion: request.version, projectId });
}
function positive(value: number | undefined, fallback: number): number { return Math.max(1, Math.floor(value ?? fallback)); }
function nonNegative(value: number | undefined, fallback: number): number { return Math.max(0, value ?? fallback); }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function safeText(value: string, max: number): string { return value.replace(/[\r\n\t]+/g, ' ').replace(/(?:api[_ -]?key|token|secret|password|private prompt|command\s*[:=]|[A-Za-z]:\\|^\/)[^ ]*/gi, '[redacted]').trim().slice(0, max); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function normalizeAgent(value: unknown): OrchestratedAgent | undefined { if (!value || typeof value !== 'object') return undefined; const row = value as Partial<OrchestratedAgent>; if (typeof row.id !== 'string' || typeof row.profileId !== 'string' || typeof row.task !== 'string' || typeof row.role !== 'string' || typeof row.model !== 'string' || typeof row.route !== 'string' || !row.startedAt || !row.updatedAt || !row.explanation) return undefined; const statuses: AgentLifecycleStatus[] = ['queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled', 'limit-blocked']; if (!statuses.includes(row.status as AgentLifecycleStatus)) return undefined; return { id: safeText(row.id, 80), profileId: safeText(row.profileId, 80), role: row.role as AgentRole, task: safeText(row.task, 240), model: safeText(row.model, 160), route: safeText(row.route, 180), status: row.status as AgentLifecycleStatus, startedAt: String(row.startedAt).slice(0, 40), updatedAt: String(row.updatedAt).slice(0, 40), costUsd: typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) ? Math.max(0, row.costUsd) : 0, durationMs: typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) ? Math.max(0, row.durationMs) : 0, events: Array.isArray(row.events) ? row.events.slice(-20) as AgentLifecycleEvent[] : [], explanation: row.explanation as RoutingExplanation, memorySlice: row.memorySlice ? clone(row.memorySlice) : undefined, projectId: typeof row.projectId === 'string' ? safeText(row.projectId, 120) : undefined, organizationProfileId: typeof row.organizationProfileId === 'string' ? safeText(row.organizationProfileId, 120) : undefined, capabilityRequirementId: typeof row.capabilityRequirementId === 'string' ? safeText(row.capabilityRequirementId, 120) : undefined, capabilitySnapshotId: typeof row.capabilitySnapshotId === 'string' ? safeText(row.capabilitySnapshotId, 160) : undefined, routeSnapshot: row.routeSnapshot ? { provider: safeText(row.routeSnapshot.provider, 120), model: row.routeSnapshot.model ? safeText(row.routeSnapshot.model, 160) : undefined, locality: row.routeSnapshot.locality, privacyBoundary: row.routeSnapshot.privacyBoundary, capturedAt: String(row.routeSnapshot.capturedAt).slice(0, 40) } : undefined }; }

function derivedScopes(memory: RoutingRequest['memory']): MemoryScope[] { const scopes: MemoryScope[] = []; if (memory?.agentId) scopes.push({ kind: 'private-agent', id: memory.agentId }); if (memory?.teamId) scopes.push({ kind: 'team-collective', id: memory.teamId }); if (memory?.projectId) scopes.push({ kind: 'project', id: memory.projectId }); if (memory?.sharedId) scopes.push({ kind: 'shared', id: memory.sharedId }); return scopes; }
function memoryMetadata(slice: MemorySlice): NonNullable<RoutingExplanation['memory']> { return { sliceId: slice.sliceId, scopes: slice.scopes, graphVersions: slice.graphVersions, nodeIds: slice.nodeIds, edgeIds: slice.edgeIds, factIds: slice.factIds, privacy: slice.privacy }; }
function memoryPolicyContext(memory: RoutingExplanation['memory']): string { return memory ? `Approved bounded memory slice ${memory.sliceId}; scopes ${memory.scopes.map((scope) => `${scope.kind}:${scope.id}`).join(', ')}; facts ${memory.factIds.length}; boundary ${memory.privacy.providerBoundary}; local-only ${memory.privacy.localOnly}` : 'No graph memory supplied.'; }
