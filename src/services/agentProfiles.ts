import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AgentCapability, AgentIdentityPresentation, AgentLifecycle, AgentLocality, AgentOperationalFacts, AgentProfile, AgentRole, AgentRoutingParameters, AGENT_PROFILE_VERSION, ProfileExport } from '../domain/agents';

export interface AgentProfileFileSystem {
  mkdir(directory: string, options: { recursive: true }): Promise<void>;
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  writeFile(file: string, data: string, encoding: 'utf8'): Promise<void>;
  unlink?(file: string): Promise<void>;
}
const defaultFileSystem: AgentProfileFileSystem = {
  mkdir: async (directory, options) => { await fs.mkdir(directory, options); },
  readFile: (file, encoding) => fs.readFile(file, encoding),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  writeFile: (file, data, encoding) => fs.writeFile(file, data, encoding),
  unlink: (file) => fs.unlink(file)
};
const PROFILE_ID = /^agent-[a-f0-9]{12}$/;
const NAMES = ['Aster', 'Bramble', 'Cedar', 'Dahlia', 'Ember', 'Fable', 'Juniper', 'Lumen', 'Mica', 'Nori', 'Orchid', 'Pip'];
const ROLES: AgentRole[] = ['planner', 'implementer', 'reviewer', 'security', 'tester', 'researcher'];
const CAPABILITIES: AgentCapability[] = ['read', 'plan', 'write', 'test', 'review', 'security', 'network'];
const LOCALITIES: AgentLocality[] = ['cloud', 'local', 'hybrid'];

export interface AgentProfileStoreOptions { clock?: () => string; fileSystem?: AgentProfileFileSystem; maxProfiles?: number; }
export interface CreateAgentProfileInput { role: AgentRole; capabilities: AgentCapability[]; preferredProvider: string; locality: AgentLocality; preferredModel?: string; humorEnabled?: boolean; priority?: number; profileId?: string; }
interface ProfileLedger { version: typeof AGENT_PROFILE_VERSION; profiles: AgentProfile[]; }

export class AgentProfileStore {
  private readonly fileSystem: AgentProfileFileSystem;
  private readonly clock: () => string;
  private readonly maxProfiles: number;
  private ledger: ProfileLedger = { version: AGENT_PROFILE_VERSION, profiles: [] };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  public constructor(private readonly workspaceRoot: string, options: AgentProfileStoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.maxProfiles = Math.max(1, Math.min(100, options.maxProfiles ?? 30));
  }
  public get filePath(): string { return path.join(this.workspaceRoot, '.planning', '.near-ai', 'agent-profiles.json'); }
  public async list(): Promise<AgentProfile[]> { await this.load(); return this.ledger.profiles.map(clone); }
  public async get(profileId: string): Promise<AgentProfile | undefined> { await this.load(); const found = this.ledger.profiles.find((profile) => profile.identity.profileId === profileId); return found ? clone(found) : undefined; }
  public async create(input: CreateAgentProfileInput): Promise<AgentProfile> {
    await this.load();
    const now = this.clock();
    const profileId = input.profileId && PROFILE_ID.test(input.profileId) ? input.profileId : stableProfileId(input.role, input.preferredProvider, this.ledger.profiles.length);
    const name = memorableName(profileId, this.ledger.profiles.map((profile) => profile.identity.memorableName));
    const profile: AgentProfile = normalizeProfile({ version: AGENT_PROFILE_VERSION, identity: { profileId, memorableName: name, role: input.role, humorEnabled: input.humorEnabled !== false }, capabilities: input.capabilities, routing: { preferredProvider: input.preferredProvider, locality: input.locality, preferredModel: input.preferredModel, priority: input.priority ?? 50 }, lifecycle: 'ready', reputation: { evidenceCount: 0, reliability: 0.5, updatedAt: now }, createdAt: now, updatedAt: now });
    this.ledger.profiles = [profile, ...this.ledger.profiles.filter((candidate) => candidate.identity.profileId !== profileId)].slice(0, this.maxProfiles);
    await this.persist(); return clone(profile);
  }
  public async reset(profileId: string): Promise<AgentProfile | undefined> { await this.load(); const current = this.ledger.profiles.find((profile) => profile.identity.profileId === profileId); if (!current) return undefined; const now = this.clock(); current.lifecycle = 'ready'; current.reputation = { evidenceCount: 0, reliability: 0.5, updatedAt: now }; current.updatedAt = now; await this.persist(); return clone(current); }
  public async delete(profileId: string): Promise<boolean> { await this.load(); const before = this.ledger.profiles.length; this.ledger.profiles = this.ledger.profiles.filter((profile) => profile.identity.profileId !== profileId); if (before === this.ledger.profiles.length) return false; await this.persist(); return true; }
  public async export(): Promise<ProfileExport> { await this.load(); return { version: AGENT_PROFILE_VERSION, exportedAt: this.clock(), profiles: this.ledger.profiles.map(clone) }; }
  private async load(): Promise<void> {
    if (this.loaded) return; this.loaded = true;
    try {
      const parsed = JSON.parse(await this.fileSystem.readFile(this.filePath, 'utf8')) as Partial<ProfileLedger> & { profiles?: unknown[] };
      const rows = Array.isArray(parsed.profiles) ? parsed.profiles : [];
      const sourceVersion = parsed.version;
      this.ledger = { version: AGENT_PROFILE_VERSION, profiles: rows.map((value) => migrateProfile(value, this.clock())).filter((value): value is AgentProfile => Boolean(value)).slice(0, this.maxProfiles) };
      if (sourceVersion !== AGENT_PROFILE_VERSION) await this.persist();
    } catch { this.ledger = { version: AGENT_PROFILE_VERSION, profiles: [] }; }
  }
  private async persist(): Promise<void> {
    const payload = `${JSON.stringify(this.ledger)}\n`; const directory = path.dirname(this.filePath); const temporary = `${this.filePath}.tmp-${process.pid}`;
    this.writeQueue = this.writeQueue.then(async () => { await this.fileSystem.mkdir(directory, { recursive: true }); await this.fileSystem.writeFile(temporary, payload, 'utf8'); await this.fileSystem.rename(temporary, this.filePath); }); await this.writeQueue;
  }
}

export function memorableName(profileId: string, used: string[] = []): string { const seed = parseInt(createHash('sha256').update(profileId).digest('hex').slice(0, 8), 16); const base = NAMES[seed % NAMES.length]; if (!used.includes(base)) return base; let suffix = 2; while (used.includes(`${base} ${suffix}`)) suffix += 1; return `${base} ${suffix}`; }
export function formatAgentIdentity(profile: AgentProfile, facts: AgentOperationalFacts, quiet = false): AgentIdentityPresentation { const cost = facts.costUsd === undefined ? 'unpriced' : `$${facts.costUsd.toFixed(4)}`; const error = facts.error ? facts.error.slice(0, 200) : undefined; return { name: profile.identity.memorableName, role: facts.role, task: facts.task, model: facts.model, route: facts.route, status: facts.status, costUsd: facts.costUsd, error, copy: quiet || !profile.identity.humorEnabled ? `${profile.identity.memorableName} · ${facts.role}` : `${profile.identity.memorableName} is on it — ${facts.role} (${cost}).` }; }

function stableProfileId(role: AgentRole, provider: string, ordinal: number): string { return `agent-${createHash('sha256').update(`${role}:${provider}:${ordinal}:${randomUUID()}`).digest('hex').slice(0, 12)}`; }
function normalizeProfile(value: unknown): AgentProfile {
  const source = value as Partial<AgentProfile>; const identity = source.identity as Partial<AgentProfile['identity']> | undefined; const routing = source.routing as Partial<AgentRoutingParameters> | undefined; const reputation = source.reputation as Partial<AgentProfile['reputation']> | undefined;
  const role = roleValue(identity?.role); const now = typeof source.updatedAt === 'string' ? source.updatedAt : new Date(0).toISOString();
  return { version: AGENT_PROFILE_VERSION, identity: { profileId: PROFILE_ID.test(identity?.profileId ?? '') ? identity!.profileId! : stableProfileId(role, 'unknown', 0), memorableName: safeName(identity?.memorableName) ?? memorableName(identity?.profileId ?? role), role, humorEnabled: identity?.humorEnabled !== false }, capabilities: safeCapabilities(source.capabilities), routing: { preferredProvider: safeScalar(routing?.preferredProvider, 120) ?? 'unspecified', locality: localityValue(routing?.locality), preferredModel: safeScalar(routing?.preferredModel, 160), priority: safeNumber(routing?.priority, 0, 100) ?? 50 }, lifecycle: source.lifecycle === 'paused' || source.lifecycle === 'retired' ? source.lifecycle : 'ready', reputation: { evidenceCount: safeNumber(reputation?.evidenceCount, 0, 100000) ?? 0, reliability: safeNumber(reputation?.reliability, 0, 1) ?? 0.5, updatedAt: safeScalar(reputation?.updatedAt, 40) ?? now }, createdAt: safeScalar(source.createdAt, 40) ?? now, updatedAt: now };
}
function migrateProfile(value: unknown, now: string): AgentProfile | undefined { if (!value || typeof value !== 'object') return undefined; const source = value as Record<string, unknown>; if (source.version !== 1 && source.version !== 0 && source.version !== undefined) return undefined; try { return normalizeProfile({ ...source, updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : now }); } catch { return undefined; } }
function roleValue(value: unknown): AgentRole { return ROLES.includes(value as AgentRole) ? value as AgentRole : 'researcher'; }
function localityValue(value: unknown): AgentLocality { return LOCALITIES.includes(value as AgentLocality) ? value as AgentLocality : 'hybrid'; }
function safeCapabilities(value: unknown): AgentCapability[] { return Array.isArray(value) ? [...new Set(value.filter((item): item is AgentCapability => CAPABILITIES.includes(item as AgentCapability)))].slice(0, 10) : ['read']; }
function safeScalar(value: unknown, max: number): string | undefined { if (typeof value !== 'string' || /(?:api[_ -]?key|token|secret|password|private prompt|command\s*[:=]|[A-Za-z]:\\|^\/)/i.test(value)) return undefined; const normalized = value.replace(/[\r\n\t]+/g, ' ').trim(); return normalized ? normalized.slice(0, max) : undefined; }
function safeName(value: unknown): string | undefined { return safeScalar(value, 40); }
function safeNumber(value: unknown, min: number, max: number): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
