import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentCapability, AgentLocality, AgentRole } from '../domain/agents';
import { cloneTeam, isTeamRole, TEAM_STUDIO_VERSION, type CreateTeamInput, type MemberCapabilityContract, type ReusableAgentTeam, type TeamApprovalMode, type TeamAutonomy, type TeamBinding, type TeamPreview, type TeamPreviewMember, type TeamPrivacyBoundary, type TeamSkillId, type TeamStudioExport, type TeamToolCapability, type TeamVersion, type UpdateTeamInput } from '../domain/teamStudio';
import { ProjectInitialization } from './projectInitialization';
import type { MemoryScope } from '../domain/contextGraph';

export interface TeamStudioFileSystem {
  mkdir(directory: string, options: { recursive: true }): Promise<void>;
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  writeFile(file: string, data: string, encoding: 'utf8'): Promise<void>;
}

const defaultFileSystem: TeamStudioFileSystem = {
  mkdir: async (directory, options) => { await fs.mkdir(directory, options); },
  readFile: (file, encoding) => fs.readFile(file, encoding),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  writeFile: (file, data, encoding) => fs.writeFile(file, data, encoding)
};

const roles: AgentRole[] = ['planner', 'implementer', 'reviewer', 'security', 'tester', 'researcher'];
const skills: TeamSkillId[] = ['read', 'plan', 'write', 'test', 'review', 'security', 'network'];
const tools: TeamToolCapability[] = ['read', 'plan', 'workspaceWrite', 'shell', 'network', 'gitMutation', 'mediaGeneration', 'mediaPublication'];
const localities: AgentLocality[] = ['cloud', 'local', 'hybrid'];
const privacyBoundaries: TeamPrivacyBoundary[] = ['cloud', 'local', 'hybrid'];
const approvalModes: TeamApprovalMode[] = ['none', 'risky', 'every-action'];
const autonomyModes: TeamAutonomy[] = ['supervised', 'bounded', 'autonomous'];
const personalities = ['professional', 'warm', 'direct', 'playful'] as const;
const tones = ['quiet', 'concise', 'verbose'] as const;
const styles = ['structured', 'conversational', 'checklist'] as const;
const sensitive = /(?:api[_ -]?key|refresh[-_ ]?token|bearer\s|authorization\s*[:=]|secret|password|private prompt|raw context|raw media|command\s*[:=]|(?:^|[\s"'`])(?:\/|[A-Za-z]:\\))/i;
const ID = /^[a-z0-9][a-z0-9._-]{1,79}$/i;
const TEAM_ID = /^team-[a-f0-9]{12}$/;
const MEMBER_ID = /^member-[a-f0-9]{12}$/;
const VERSION_ID = /^team-[a-f0-9]{12}-v[1-9][0-9]{0,3}$/;
const BINDING_ID = /^binding-[a-f0-9]{16}$/;

const roleSkills: Record<AgentRole, readonly TeamSkillId[]> = {
  planner: ['read', 'plan'],
  implementer: ['read', 'plan', 'write'],
  reviewer: ['read', 'review'],
  security: ['read', 'security'],
  tester: ['read', 'test'],
  researcher: ['read', 'plan', 'network']
};

interface TeamLedger { version: typeof TEAM_STUDIO_VERSION; teams: ReusableAgentTeam[]; }
export interface TeamStudioStoreOptions { clock?: () => string; fileSystem?: TeamStudioFileSystem; maxTeams?: number; maxVersions?: number; }

export class TeamStudioStore {
  private readonly clock: () => string;
  private readonly fileSystem: TeamStudioFileSystem;
  private readonly maxTeams: number;
  private readonly maxVersions: number;
  private ledger: TeamLedger = { version: TEAM_STUDIO_VERSION, teams: [] };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly globalStorageRoot: string, options: TeamStudioStoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.maxTeams = clampInt(options.maxTeams ?? 50, 1, 100);
    this.maxVersions = clampInt(options.maxVersions ?? 20, 1, 50);
  }

  public get filePath(): string { return path.join(this.globalStorageRoot, 'team-studio.json'); }
  public async list(options: { includeArchived?: boolean; includeDeleted?: boolean } = {}): Promise<ReusableAgentTeam[]> {
    await this.load();
    return this.ledger.teams.filter((team) => (options.includeDeleted || !team.deletedAt) && (options.includeArchived || !team.archivedAt)).map(cloneTeam);
  }
  public async get(teamId: string, includeDeleted = false): Promise<ReusableAgentTeam | undefined> { await this.load(); const team = this.ledger.teams.find((row) => row.teamId === teamId && (includeDeleted || !row.deletedAt)); return team ? cloneTeam(team) : undefined; }
  public async create(input: CreateTeamInput): Promise<ReusableAgentTeam> {
    await this.load();
    const now = this.clock(); const teamId = `team-${hash(`${now}:${input.displayName}:${randomUUID()}`).slice(0, 12)}`;
    const team: ReusableAgentTeam = { version: TEAM_STUDIO_VERSION, teamId, displayName: safeText(input.displayName, 80, true), description: safeText(input.description ?? '', 240), createdAt: now, updatedAt: now, currentVersion: 1, versions: [this.createVersion(teamId, 1, input.members, now, input.note)] };
    this.ledger.teams = [team, ...this.ledger.teams].slice(0, this.maxTeams); await this.persist(); return cloneTeam(team);
  }
  public async update(teamId: string, input: UpdateTeamInput): Promise<ReusableAgentTeam> {
    await this.load(); const team = this.requireTeam(teamId); if (team.archivedAt) throw new Error('Archived teams must be restored before editing.');
    const now = this.clock(); const next = team.currentVersion + 1; if (next > this.maxVersions) throw new Error('Team version history limit reached.');
    team.displayName = input.displayName === undefined ? team.displayName : safeText(input.displayName, 80, true); team.description = input.description === undefined ? team.description : safeText(input.description, 240); team.currentVersion = next; team.updatedAt = now; team.versions.push(this.createVersion(teamId, next, input.members ?? team.versions[team.versions.length - 1].members, now, input.note, team.versions[team.versions.length - 1]?.versionId)); await this.persist(); return cloneTeam(team);
  }
  public async duplicate(teamId: string, displayName?: string): Promise<ReusableAgentTeam> { const source = await this.getVersion(teamId); return this.create({ displayName: safeText(displayName ?? `${source.team.displayName} Copy`, 80, true), description: source.team.description, members: source.version.members.map((member) => ({ ...cloneTeam(member), memberId: newMemberId() })), note: `Duplicated from ${teamId}` }).then(async (team) => { const stored = this.requireTeam(team.teamId); stored.duplicatedFromTeamId = teamId; await this.persist(); return cloneTeam(stored); }); }
  public async archive(teamId: string): Promise<ReusableAgentTeam> { await this.load(); const team = this.requireTeam(teamId); team.archivedAt = this.clock(); team.updatedAt = team.archivedAt; await this.persist(); return cloneTeam(team); }
  public async restore(teamId: string): Promise<ReusableAgentTeam> { await this.load(); const team = this.requireTeam(teamId, true); if (team.deletedAt) throw new Error('Deleted teams cannot be restored.'); delete team.archivedAt; team.updatedAt = this.clock(); await this.persist(); return cloneTeam(team); }
  public async delete(teamId: string): Promise<boolean> { await this.load(); const team = this.ledger.teams.find((row) => row.teamId === teamId && !row.deletedAt); if (!team) return false; team.deletedAt = this.clock(); team.archivedAt = team.deletedAt; team.updatedAt = team.deletedAt; await this.persist(); return true; }

  public async preview(teamId: string, teamVersion?: number): Promise<TeamPreview> { const selected = await this.getVersion(teamId, teamVersion); return previewFor(selected.team, selected.version); }
  public async exportPackage(teamId: string): Promise<TeamStudioExport> { const selected = await this.get(teamId); if (!selected) throw new Error('Unknown or deleted team.'); return { packageVersion: TEAM_STUDIO_VERSION, exportedAt: this.clock(), team: cloneTeam(selected), provenance: { source: 'near-ai-team-studio' } }; }
  public async export(teamId: string): Promise<string> { return JSON.stringify(await this.exportPackage(teamId)); }
  public async importPackage(payload: string | unknown): Promise<ReusableAgentTeam> {
    await this.load(); const value = typeof payload === 'string' ? parseJson(payload) : payload; const packageValue = validatePackage(value); const source = packageValue.team; const now = this.clock(); const teamId = TEAM_ID.test(source.teamId) && !this.ledger.teams.some((team) => team.teamId === source.teamId && !team.deletedAt) ? source.teamId : `team-${hash(`${now}:${source.teamId}:${randomUUID()}`).slice(0, 12)}`;
    const versions = source.versions.map((version) => this.createVersion(teamId, version.teamVersion, version.members, version.createdAt, version.note, version.sourceVersionId)).sort((a, b) => a.teamVersion - b.teamVersion).slice(0, this.maxVersions); if (!versions.length || versions.some((version, index) => version.teamVersion !== index + 1)) throw new Error('Malformed version history.');
    const team: ReusableAgentTeam = { version: TEAM_STUDIO_VERSION, teamId, displayName: source.displayName, description: source.description, createdAt: source.createdAt, updatedAt: now, currentVersion: Math.min(source.currentVersion, versions[versions.length - 1].teamVersion), versions, duplicatedFromTeamId: source.duplicatedFromTeamId };
    this.ledger.teams = [team, ...this.ledger.teams].slice(0, this.maxTeams); await this.persist(); return cloneTeam(team);
  }
  public import(payload: string | unknown): Promise<ReusableAgentTeam> { return this.importPackage(payload); }

  public collectiveMemoryScope(teamId: string): MemoryScope { if (!TEAM_ID.test(teamId)) throw new Error('Invalid reusable team identity for collective memory.'); return { kind: 'team-collective', id: teamId }; }

  public async bind(input: { teamId: string; version?: number; projectId: string; accepted?: boolean }): Promise<TeamBinding> {
    const selected = await this.getVersion(input.teamId, input.version); if (selected.team.archivedAt) throw new Error('Archived teams cannot be bound.'); if (!ID.test(input.projectId) || sensitive.test(input.projectId)) throw new Error('Project identity is invalid or sensitive.'); if (input.accepted === false) throw new Error('Accept or customize the project team before binding a reusable team.');
    const preview = previewFor(selected.team, selected.version); const bindingBase = { version: TEAM_STUDIO_VERSION as typeof TEAM_STUDIO_VERSION, bindingId: `binding-${hash(`${input.projectId}:${selected.version.versionId}:${this.clock()}`).slice(0, 16)}`, projectId: input.projectId, teamId: selected.team.teamId, teamVersion: selected.version.teamVersion, versionId: selected.version.versionId, teamDisplayName: selected.team.displayName, boundAt: this.clock(), privacyBoundary: preview.privacyBoundary, members: selected.version.members.map(cloneTeam), source: 'global-team-library' as const }; const binding: TeamBinding = { ...bindingBase, bindingFingerprint: fingerprintForBinding(bindingBase) };
    return binding;
  }
  public async invoke(input: { teamId: string; version?: number; projectId: string; privacyMode?: TeamPrivacyBoundary }): Promise<TeamBinding> { const binding = await this.bind(input); if (input.privacyMode && input.privacyMode !== binding.privacyBoundary && binding.privacyBoundary !== 'hybrid') throw new Error('Selected team privacy boundary cannot satisfy the project privacy mode.'); return binding; }
  public async bindProject(projectRoot: string, input: { teamId: string; version?: number; projectId: string; privacyMode?: TeamPrivacyBoundary }, initialization = new ProjectInitialization(projectRoot)): Promise<TeamBinding> { const binding = await this.invoke(input); return initialization.bindReusableTeam(binding); }

  private async getVersion(teamId: string, teamVersion?: number): Promise<{ team: ReusableAgentTeam; version: TeamVersion }> { await this.load(); const team = this.ledger.teams.find((row) => row.teamId === teamId && !row.deletedAt); if (!team) throw new Error('Unknown or deleted team.'); const version = team.versions.find((row) => row.teamVersion === (teamVersion ?? team.currentVersion)); if (!version) throw new Error('Unknown team version.'); return { team, version }; }
  private requireTeam(teamId: string, includeDeleted = false): ReusableAgentTeam { const team = this.ledger.teams.find((row) => row.teamId === teamId && (includeDeleted || !row.deletedAt)); if (!team) throw new Error('Unknown or deleted team.'); return team; }
  private createVersion(teamId: string, teamVersion: number, members: MemberCapabilityContract[], createdAt: string, note?: string, sourceVersionId?: string): TeamVersion { if (!Number.isInteger(teamVersion) || teamVersion < 1 || teamVersion > this.maxVersions) throw new Error('Team version is outside the supported bound.'); const normalized = normalizeMembers(members, true); return { version: TEAM_STUDIO_VERSION, teamVersion, versionId: `${teamId}-v${teamVersion}`, createdAt: safeTime(createdAt), note: note === undefined ? undefined : safeText(note, 160), members: normalized, sourceVersionId };
  }
  private async load(): Promise<void> { if (this.loaded) return; this.loaded = true; try { const parsed = parseJson(await this.fileSystem.readFile(this.filePath, 'utf8')) as Partial<TeamLedger>; if (parsed.version !== TEAM_STUDIO_VERSION || !Array.isArray(parsed.teams)) throw new Error('Unsupported team ledger.'); this.ledger = { version: TEAM_STUDIO_VERSION, teams: parsed.teams.map((value) => normalizeTeam(value, this.maxVersions)).filter((value): value is ReusableAgentTeam => Boolean(value)).slice(0, this.maxTeams) }; } catch { this.ledger = { version: TEAM_STUDIO_VERSION, teams: [] }; } }
  private async persist(): Promise<void> { const payload = `${JSON.stringify(this.ledger)}\n`; const directory = path.dirname(this.filePath); const temporary = `${this.filePath}.tmp-${process.pid}`; this.writeQueue = this.writeQueue.then(async () => { await this.fileSystem.mkdir(directory, { recursive: true }); await this.fileSystem.writeFile(temporary, payload, 'utf8'); await this.fileSystem.rename(temporary, this.filePath); }); await this.writeQueue; }
}

/** Validate an operational member contract without deriving or truncating authority. */
export function validateMemberContract(value: unknown): MemberCapabilityContract {
  return normalizeMember(value, true);
}

/** Validate a persisted binding and recompute its bounded privacy claim from its members. */
export function validateTeamBinding(value: unknown): TeamBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Reusable team binding is incomplete.');
  const row = value as Record<string, unknown>;
  const allowed = ['version', 'bindingId', 'projectId', 'teamId', 'teamVersion', 'versionId', 'teamDisplayName', 'boundAt', 'privacyBoundary', 'members', 'bindingFingerprint', 'source'];
  if (Object.keys(row).some((key) => !allowed.includes(key))) throw new Error('Reusable team binding contains an unknown field.');
  if (row.version !== TEAM_STUDIO_VERSION || typeof row.bindingId !== 'string' || !BINDING_ID.test(row.bindingId)) throw new Error('Reusable team binding identity is invalid.');
  if (typeof row.projectId !== 'string' || !ID.test(row.projectId) || sensitive.test(row.projectId)) throw new Error('Reusable team binding project identity is invalid.');
  if (typeof row.teamId !== 'string' || !TEAM_ID.test(row.teamId) || !Number.isInteger(row.teamVersion) || (row.teamVersion as number) < 1 || (row.teamVersion as number) > 50) throw new Error('Reusable team binding version is invalid.');
  if (row.versionId !== `${row.teamId}-v${row.teamVersion}` || !VERSION_ID.test(String(row.versionId))) throw new Error('Reusable team binding version identity is invalid.');
  if (typeof row.teamDisplayName !== 'string' || typeof row.boundAt !== 'string' || typeof row.source !== 'string' || row.source !== 'global-team-library' || typeof row.bindingFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.bindingFingerprint)) throw new Error('Reusable team binding metadata is invalid.');
  const teamDisplayName = safeText(row.teamDisplayName, 80, true);
  const boundAt = safeTime(row.boundAt);
  const members = normalizeMembers(row.members, true);
  const privacyBoundary = privacyForMembers(members);
  if (row.privacyBoundary !== privacyBoundary) throw new Error('Reusable team binding privacy boundary does not match its members.');
  const bindingBase = { version: TEAM_STUDIO_VERSION as typeof TEAM_STUDIO_VERSION, bindingId: row.bindingId, projectId: row.projectId, teamId: row.teamId, teamVersion: row.teamVersion as number, versionId: row.versionId, teamDisplayName, boundAt, privacyBoundary, members, source: 'global-team-library' as const };
  if (row.bindingFingerprint !== fingerprintForBinding(bindingBase)) throw new Error('Reusable team binding fingerprint does not match its immutable snapshot.');
  return { ...bindingBase, bindingFingerprint: row.bindingFingerprint };
}

function previewFor(team: ReusableAgentTeam, version: TeamVersion): TeamPreview { const members: TeamPreviewMember[] = version.members.map((member) => ({ memberId: member.memberId, role: member.role, responsibilities: [...member.responsibilities], skills: [...member.skillIds], tools: [...member.tools], route: { ...member.providerRoute }, personality: { personality: member.personality.personality, tone: member.personality.tone, style: member.personality.style }, autonomy: member.autonomy, approval: member.approval.mode, budget: { requestUsd: member.budget.requestUsd, sessionUsd: member.budget.sessionUsd, projectUsd: member.budget.projectUsd } })); const privacyBoundary = privacyForMembers(version.members); return { teamId: team.teamId, version: version.teamVersion, versionId: version.versionId, displayName: team.displayName, members, privacyBoundary, coordinationTradeoff: members.length > 3 ? 'More role handoffs improve coverage but increase coordination and cost.' : 'A compact team keeps coordination and cost lower.', estimatedRequestUsd: members.reduce((sum, member) => sum + member.budget.requestUsd, 0), estimatedProjectUsd: members.reduce((sum, member) => sum + member.budget.projectUsd, 0), bindingRequired: true };
}

function privacyForMembers(members: MemberCapabilityContract[]): TeamPrivacyBoundary { return members.some((member) => member.providerRoute.privacyBoundary === 'cloud') && members.some((member) => member.providerRoute.privacyBoundary === 'local') ? 'hybrid' : members[0]?.providerRoute.privacyBoundary ?? 'local'; }
function fingerprintForBinding(binding: Omit<TeamBinding, 'bindingFingerprint'>): string { return hash(JSON.stringify(binding)); }

function normalizeMembers(value: unknown, strict = false): MemberCapabilityContract[] { if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new Error('A team must contain between 1 and 20 members.'); const seen = new Set<string>(); return value.map((member) => { const normalized = normalizeMember(member, strict); if (seen.has(normalized.memberId)) throw new Error('Member IDs must be unique.'); seen.add(normalized.memberId); return normalized; }); }
function normalizeMember(value: unknown, strict = false): MemberCapabilityContract { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Member contract must be an object.'); const row = value as Record<string, unknown>; const allowed = ['memberId', 'profileId', 'role', 'responsibilities', 'skillIds', 'capabilities', 'tools', 'providerRoute', 'personality', 'autonomy', 'approval', 'budget']; if (strict && Object.keys(row).some((key) => !allowed.includes(key))) throw new Error('Member contract contains an unknown field.'); if (strict && (typeof row.memberId !== 'string' || !MEMBER_ID.test(row.memberId))) throw new Error('Invalid member ID.'); const memberId = typeof row.memberId === 'string' && MEMBER_ID.test(row.memberId) ? row.memberId : newMemberId(); const role = isTeamRole(row.role) ? row.role : strict ? fail('Invalid member role.') : 'researcher'; const responsibilityValues = Array.isArray(row.responsibilities) ? row.responsibilities : strict ? fail('Member responsibilities are required.') : ['Complete the assigned role within the accepted team.']; const responsibilities = boundedStrings(responsibilityValues, 5, 160, 'responsibility'); const suppliedSkills = Array.isArray(row.skillIds) ? row.skillIds : Array.isArray(row.capabilities) ? row.capabilities : ['read']; const skillIds = boundedEnum(suppliedSkills, skills, 8, 'skill'); const capabilityValues = Array.isArray(row.capabilities) ? row.capabilities : skillIds; const capabilities = boundedEnum(capabilityValues, skills, 8, 'capability'); if (capabilities.some((capability) => !skillIds.includes(capability))) throw new Error('Member capabilities cannot exceed declared skills.'); if (strict && skillIds.some((skill) => !roleSkills[role].includes(skill))) throw new Error('Member skills exceed the selected role authority.'); const memberTools = boundedEnum(Array.isArray(row.tools) ? row.tools : strict ? fail('Member tools are required.') : ['read'], tools, 8, 'tool'); const providerRoute = normalizeRoute(row.providerRoute, strict); const personality = normalizePersonality(row.personality, strict); const autonomy = enumValue(row.autonomy, autonomyModes, 'bounded', strict); const approval = normalizeApproval(row.approval, strict); if (approval.capabilities.some((capability) => !memberTools.includes(capability))) throw new Error('Approval capabilities cannot exceed member tools.'); const budget = normalizeBudget(row.budget, strict); const profileId = row.profileId === undefined ? undefined : safeId(row.profileId, 80, 'profile'); return { memberId, profileId, role, responsibilities, skillIds, capabilities, tools: memberTools, providerRoute, personality, autonomy, approval, budget }; }
function normalizeRoute(value: unknown, strict: boolean): MemberCapabilityContract['providerRoute'] { const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; if (strict && Object.keys(row).some((key) => !['provider', 'model', 'locality', 'privacyBoundary'].includes(key))) throw new Error('Provider route contains an unknown field.'); const provider = row.provider === undefined && !strict ? 'unspecified' : safeText(row.provider, 120, true); const locality = enumValue(row.locality, localities, 'hybrid', strict); const privacyBoundary = enumValue(row.privacyBoundary, privacyBoundaries, locality, strict); const model = row.model === undefined ? undefined : safeText(row.model, 160, true); return { provider, model, locality, privacyBoundary }; }
function normalizePersonality(value: unknown, strict: boolean): MemberCapabilityContract['personality'] { const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; if (strict && Object.keys(row).some((key) => !['personality', 'tone', 'style', 'displayGuidance'].includes(key))) throw new Error('Personality contains an unknown field.'); return { personality: enumValue(row.personality, personalities, 'professional', strict), tone: enumValue(row.tone, tones, 'concise', strict), style: enumValue(row.style, styles, 'structured', strict), displayGuidance: row.displayGuidance === undefined ? undefined : safeText(row.displayGuidance, 160) }; }
function normalizeApproval(value: unknown, strict: boolean): MemberCapabilityContract['approval'] { const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; if (strict && Object.keys(row).some((key) => !['mode', 'capabilities'].includes(key))) throw new Error('Approval contains an unknown field.'); if (strict && !Array.isArray(row.capabilities)) throw new Error('Approval capabilities are required.'); return { mode: enumValue(row.mode, approvalModes, 'risky', strict), capabilities: boundedEnum(Array.isArray(row.capabilities) ? row.capabilities : ['workspaceWrite', 'shell', 'network', 'gitMutation'], tools, 8, 'approval capability') }; }
function normalizeBudget(value: unknown, strict: boolean): MemberCapabilityContract['budget'] { const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; if (strict && Object.keys(row).some((key) => !['requestUsd', 'sessionUsd', 'projectUsd', 'maxDurationMs'].includes(key))) throw new Error('Budget contains an unknown field.'); const required = (candidate: unknown): unknown => candidate === undefined && strict ? fail('Member budget is required.') : candidate; return { requestUsd: boundedNumber(required(row.requestUsd) ?? 0, 0, 100, 'request budget'), sessionUsd: boundedNumber(required(row.sessionUsd) ?? 0, 0, 500, 'session budget'), projectUsd: boundedNumber(required(row.projectUsd) ?? 0, 0, 10000, 'project budget'), maxDurationMs: boundedNumber(required(row.maxDurationMs) ?? 3600000, 1000, 86400000, 'duration budget') }; }
function normalizeTeam(value: unknown, maxVersions: number): ReusableAgentTeam | undefined { try { if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined; const row = value as Record<string, unknown>; const allowed = ['version', 'teamId', 'displayName', 'description', 'createdAt', 'updatedAt', 'currentVersion', 'archivedAt', 'deletedAt', 'duplicatedFromTeamId', 'versions']; if (Object.keys(row).some((key) => !allowed.includes(key)) || (row.version !== undefined && row.version !== TEAM_STUDIO_VERSION)) return undefined; if (!TEAM_ID.test(String(row.teamId)) || typeof row.displayName !== 'string' || typeof row.description !== 'string' || !Array.isArray(row.versions) || row.versions.length < 1 || row.versions.length > maxVersions) return undefined; const teamId = row.teamId as string; const versions = row.versions.map((version) => { if (!version || typeof version !== 'object' || Array.isArray(version)) throw new Error(); const source = version as Record<string, unknown>; const versionAllowed = ['version', 'teamVersion', 'versionId', 'createdAt', 'note', 'members', 'sourceVersionId', 'importedAt']; if (Object.keys(source).some((key) => !versionAllowed.includes(key)) || (source.version !== undefined && source.version !== TEAM_STUDIO_VERSION)) throw new Error(); if (typeof source.teamVersion !== 'number' || !Number.isInteger(source.teamVersion) || source.teamVersion < 1 || source.teamVersion > maxVersions || !Array.isArray(source.members) || (source.versionId !== undefined && source.versionId !== `${teamId}-v${source.teamVersion}`)) throw new Error(); return { version: TEAM_STUDIO_VERSION, teamVersion: source.teamVersion, versionId: `${teamId}-v${source.teamVersion}`, createdAt: safeTime(source.createdAt), note: source.note === undefined ? undefined : safeText(source.note, 160), members: normalizeMembers(source.members, true), sourceVersionId: source.sourceVersionId === undefined ? undefined : safeText(source.sourceVersionId, 100), importedAt: source.importedAt === undefined ? undefined : safeTime(source.importedAt) }; }).sort((a, b) => a.teamVersion - b.teamVersion); if (!versions.length || versions.some((version, index) => version.teamVersion !== index + 1)) return undefined; if (typeof row.currentVersion !== 'number' || !Number.isInteger(row.currentVersion) || row.currentVersion < 1 || row.currentVersion > versions.length) return undefined; return { version: TEAM_STUDIO_VERSION, teamId, displayName: safeText(row.displayName, 80, true), description: safeText(row.description, 240), createdAt: safeTime(row.createdAt), updatedAt: safeTime(row.updatedAt), currentVersion: row.currentVersion, archivedAt: row.archivedAt === undefined ? undefined : safeTime(row.archivedAt), deletedAt: row.deletedAt === undefined ? undefined : safeTime(row.deletedAt), duplicatedFromTeamId: row.duplicatedFromTeamId === undefined ? undefined : (TEAM_ID.test(String(row.duplicatedFromTeamId)) ? String(row.duplicatedFromTeamId) : fail('Invalid duplicated team ID.')), versions }; } catch { return undefined; } }
function validatePackage(value: unknown): TeamStudioExport { if (!value || typeof value !== 'object') throw new Error('Team export must be an object.'); const row = value as Record<string, unknown>; if (Object.keys(row).some((key) => !['packageVersion', 'exportedAt', 'team', 'provenance'].includes(key)) || row.packageVersion !== TEAM_STUDIO_VERSION) throw new Error('Unsupported or unknown team export fields.'); if (!row.provenance || typeof row.provenance !== 'object' || Object.keys(row.provenance as object).some((key) => !['source', 'importedFrom'].includes(key)) || (row.provenance as Record<string, unknown>).source !== 'near-ai-team-studio') throw new Error('Team export provenance is invalid.'); const team = row.team; if (!team || typeof team !== 'object' || Array.isArray(team)) throw new Error('Team export is missing its team.'); const source = team as Record<string, unknown>; if (Object.keys(source).some((key) => !['version', 'teamId', 'displayName', 'description', 'createdAt', 'updatedAt', 'currentVersion', 'versions', 'duplicatedFromTeamId'].includes(key)) || (source.version !== undefined && source.version !== TEAM_STUDIO_VERSION)) throw new Error('Team export contains an unknown field.'); if (typeof source.displayName !== 'string' || typeof source.description !== 'string' || !Array.isArray(source.versions)) throw new Error('Malformed team export.'); const versions = source.versions.map((version) => { if (!version || typeof version !== 'object' || Array.isArray(version)) throw new Error('Malformed version history.'); const row = version as Record<string, unknown>; if (Object.keys(row).some((key) => !['version', 'teamVersion', 'versionId', 'createdAt', 'note', 'members', 'sourceVersionId', 'importedAt'].includes(key)) || (row.version !== undefined && row.version !== TEAM_STUDIO_VERSION)) throw new Error('Team version contains an unknown field.'); return { version: TEAM_STUDIO_VERSION, teamVersion: boundedNumber(row.teamVersion, 1, 50, 'team version'), versionId: typeof row.versionId === 'string' ? row.versionId : '', createdAt: safeTime(row.createdAt), note: row.note === undefined ? undefined : safeText(row.note, 160), members: normalizeMembers(row.members, true) }; }); return { packageVersion: TEAM_STUDIO_VERSION, exportedAt: safeTime(row.exportedAt), team: { teamId: typeof source.teamId === 'string' ? source.teamId : '', displayName: safeText(source.displayName, 80, true), description: safeText(source.description, 240), createdAt: safeTime(source.createdAt), updatedAt: safeTime(source.updatedAt), currentVersion: boundedNumber(source.currentVersion, 1, 50, 'current version'), versions }, provenance: { source: 'near-ai-team-studio', importedFrom: undefined } }; }
function safeText(value: unknown, max: number, required = false): string { if (typeof value !== 'string' || value.length > max || sensitive.test(value)) throw new Error(`Unsafe or oversized text in team contract.`); const normalized = value.replace(/[\r\n\t]+/g, ' ').trim(); if (required && !normalized) throw new Error('Required team text is empty.'); return normalized.slice(0, max); }
function safeId(value: unknown, max: number, label: string): string { if (typeof value !== 'string' || value.length > max || !ID.test(value) || sensitive.test(value)) throw new Error(`Invalid ${label} ID.`); return value; }
function boundedStrings(value: unknown[], maxItems: number, maxLength: number, label: string): string[] { if (value.length < 1 || value.length > maxItems) throw new Error(`${label} list is outside the supported bound.`); return [...new Set(value.map((item) => safeText(item, maxLength, true)))]; }
function boundedEnum<T extends string>(value: unknown[], allowed: readonly T[], maxItems: number, label: string): T[] { if (value.length < 1 || value.length > maxItems || value.some((item) => !allowed.includes(item as T))) throw new Error(`Invalid ${label} contract.`); return [...new Set(value as T[])]; }
function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T, strict: boolean): T { if (value === undefined && !strict) return fallback; if (!allowed.includes(value as T)) throw new Error('Invalid enum contract.'); return value as T; }
function boundedNumber(value: unknown, min: number, max: number, label: string): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} is outside the supported bound.`); return value; }
function safeTime(value: unknown): string { if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) throw new Error('Invalid timestamp.'); return value; }
function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { throw new Error('Team export is not valid JSON.'); } }
function newMemberId(): string { return `member-${hash(randomUUID()).slice(0, 12)}`; }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function clampInt(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Math.floor(value))); }
function fail(message: string): never { throw new Error(message); }
