import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { redactSecrets } from '../domain/redaction';
import { AuthMode, isSecureEndpoint } from '../domain/config';
import { ActiveProfileSelection, AUTH_PROFILE_VERSION, OrganizationProfile, ProfileValidation, ProjectCredentialScope, createProjectCredentialScope, isProfileId } from '../domain/auth';
import { AuthService } from './auth';
import { validateNearAiProvider } from './providerFactory';

export interface ProfileStoreFileSystem {
  mkdir(directory: string, options: { recursive: true }): Promise<void>;
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  writeFile(file: string, data: string, encoding: 'utf8'): Promise<void>;
}

const defaultFileSystem: ProfileStoreFileSystem = {
  mkdir: async (directory, options) => { await fs.mkdir(directory, options); },
  readFile: (file, encoding) => fs.readFile(file, encoding),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  writeFile: (file, data, encoding) => fs.writeFile(file, data, encoding)
};

const PROFILE_STORE_VERSION = 1 as const;
const MAX_PROFILES = 50;

export interface CreateOrganizationProfileInput {
  profileId: string;
  displayName: string;
  organization: string;
  baseUrl: string;
  authMode: AuthMode;
}

export interface UpdateOrganizationProfileInput {
  profileId: string;
  displayName?: string;
  organization?: string;
  baseUrl?: string;
  authMode?: AuthMode;
}

export interface ProfileValidationProbe {
  (profile: OrganizationProfile, scope: ProjectCredentialScope): Promise<void>;
}

export interface ProfileStoreOptions {
  clock?: () => string;
  fileSystem?: ProfileStoreFileSystem;
  projectIdentity?: string;
  validator?: ProfileValidationProbe;
}

export interface ProfileMetadataExport {
  version: typeof PROFILE_STORE_VERSION;
  projectId: string;
  profiles: OrganizationProfile[];
  activeProfileId?: string;
}

interface ProfileLedger {
  version: typeof PROFILE_STORE_VERSION;
  projectId: string;
  profiles: OrganizationProfile[];
  active?: ActiveProfileSelection;
}

export class ProfileStore {
  private readonly fileSystem: ProfileStoreFileSystem;
  private readonly clock: () => string;
  private readonly projectIdentity: string;
  private readonly projectId: string;
  private readonly validator?: ProfileValidationProbe;
  private ledger: ProfileLedger;
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  private readonly workspaceRoot: string;
  private readonly auth?: AuthService;

  public constructor(workspaceRoot: string, options?: ProfileStoreOptions);
  public constructor(workspaceRoot: string, auth: AuthService, options?: ProfileStoreOptions);
  public constructor(workspaceRoot: string, authOrOptions?: AuthService | ProfileStoreOptions, suppliedOptions: ProfileStoreOptions = {}) {
    this.workspaceRoot = workspaceRoot;
    const isAuth = authOrOptions instanceof AuthService;
    this.auth = isAuth ? authOrOptions : undefined;
    const options = isAuth ? suppliedOptions : (authOrOptions ?? {});
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.projectIdentity = options.projectIdentity ?? workspaceRoot;
    this.projectId = createProjectCredentialScope(this.projectIdentity, 'profile-placeholder').projectId;
    this.validator = options.validator;
    this.ledger = { version: PROFILE_STORE_VERSION, projectId: this.projectId, profiles: [] };
  }

  public get filePath(): string { return path.join(this.workspaceRoot, '.planning', '.near-ai', 'auth-profiles.json'); }
  public get projectScopeId(): string { return this.projectId; }

  public async list(): Promise<OrganizationProfile[]> {
    await this.load();
    return this.ledger.profiles.map(clone);
  }

  public async get(profileId: string): Promise<OrganizationProfile | undefined> {
    if (!isProfileId(profileId)) return undefined;
    await this.load();
    const profile = this.ledger.profiles.find((candidate) => candidate.profileId === profileId);
    return profile ? clone(profile) : undefined;
  }

  public getScope(profileId: string): ProjectCredentialScope {
    return createProjectCredentialScope(this.projectIdentity, profileId);
  }

  public async getActiveSelection(): Promise<ActiveProfileSelection | undefined> {
    await this.load();
    if (!this.ledger.active || !this.ledger.profiles.some((profile) => profile.profileId === this.ledger.active?.profileId)) return undefined;
    return clone(this.ledger.active);
  }

  public async getActiveProfile(): Promise<OrganizationProfile | undefined> {
    const active = await this.getActiveSelection();
    return active ? this.get(active.profileId) : undefined;
  }

  public async create(input: CreateOrganizationProfileInput): Promise<OrganizationProfile> {
    await this.load();
    if (!isProfileId(input.profileId)) throw new Error('Profile ID must start with profile- and contain only lowercase letters, numbers, and hyphens.');
    if (this.ledger.profiles.some((profile) => profile.profileId === input.profileId)) throw new Error('That profile ID already exists.');
    const now = this.clock();
    const profile = normalizeProfile({ version: AUTH_PROFILE_VERSION, ...input, provider: 'near-ai', createdAt: now, updatedAt: now, validation: { status: 'pending' } });
    if (!profile) throw new Error('Profile metadata is invalid.');
    this.ledger.profiles = [profile, ...this.ledger.profiles].slice(0, MAX_PROFILES);
    await this.persist();
    return clone(profile);
  }

  public async update(input: UpdateOrganizationProfileInput): Promise<OrganizationProfile> {
    await this.load();
    const current = this.ledger.profiles.find((profile) => profile.profileId === input.profileId);
    if (!current) throw new Error('The requested profile was not found.');
    const changedCredentialInputs = input.baseUrl !== undefined || input.authMode !== undefined;
    const updated = normalizeProfile({ ...current, ...input, provider: 'near-ai', updatedAt: this.clock(), validation: changedCredentialInputs ? { status: 'stale' } : current.validation });
    if (!updated) throw new Error('Profile metadata is invalid.');
    Object.assign(current, updated);
    await this.persist();
    return clone(current);
  }

  public async markValidationStale(profileId: string): Promise<OrganizationProfile> {
    return this.setValidation(profileId, { status: 'stale' });
  }

  public async saveProfileApiKey(profileId: string, apiKey: string): Promise<OrganizationProfile> {
    if (!this.auth) throw new Error('An authentication service is required to save a profile credential.');
    if (!await this.get(profileId)) throw new Error('The requested profile was not found.');
    await this.auth.saveScopedApiKey(this.getScope(profileId), apiKey);
    return this.markValidationStale(profileId);
  }

  public async saveProfileRefreshToken(profileId: string, refreshToken: string): Promise<OrganizationProfile> {
    if (!this.auth) throw new Error('An authentication service is required to save a profile credential.');
    if (!await this.get(profileId)) throw new Error('The requested profile was not found.');
    await this.auth.saveScopedRefreshToken(this.getScope(profileId), refreshToken);
    return this.markValidationStale(profileId);
  }

  public async select(profileId: string): Promise<ActiveProfileSelection> {
    await this.load();
    const profile = this.ledger.profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) throw new Error('The requested profile was not found.');
    if (profile.validation.status !== 'valid') throw new Error('The profile must pass provider validation before it can be selected.');
    const active: ActiveProfileSelection = { version: AUTH_PROFILE_VERSION, projectId: this.projectId, profileId, selectedAt: this.clock() };
    this.ledger.active = active;
    await this.persist();
    return clone(active);
  }

  public async remove(profileId: string): Promise<boolean> {
    await this.load();
    if (!isProfileId(profileId)) throw new Error('A stable profile ID is required.');
    const before = this.ledger.profiles.length;
    this.ledger.profiles = this.ledger.profiles.filter((profile) => profile.profileId !== profileId);
    if (before === this.ledger.profiles.length) return false;
    if (this.ledger.active?.profileId === profileId) this.ledger.active = undefined;
    if (this.auth) await this.auth.removeScopedCredentials(this.getScope(profileId));
    await this.persist();
    return true;
  }

  public async validate(profileId: string, validator?: ProfileValidationProbe): Promise<OrganizationProfile> {
    await this.load();
    const profile = this.ledger.profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) throw new Error('The requested profile was not found.');
    const probe = validator ?? this.validator ?? this.defaultValidator.bind(this);
    try {
      await probe(clone(profile), this.getScope(profileId));
      return this.setValidation(profileId, { status: 'valid', validatedAt: this.clock() });
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : 'Provider validation failed.').replace(/\s+/g, ' ').slice(0, 200) || 'Provider validation failed.';
      return this.setValidation(profileId, { status: 'invalid', error: message });
    }
  }

  public async importLegacy(profileId: string, confirmed: boolean): Promise<{ profile: OrganizationProfile; apiKeyImported: boolean; refreshTokenImported: boolean }> {
    if (!this.auth) throw new Error('An authentication service is required for legacy import.');
    await this.load();
    const profile = this.ledger.profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) throw new Error('The requested profile was not found.');
    const imported = await this.auth.importLegacyCredentials(this.getScope(profileId), confirmed);
    const pending = await this.setValidation(profileId, { status: 'pending' });
    return { profile: pending, ...imported };
  }

  public async exportMetadata(): Promise<ProfileMetadataExport> {
    await this.load();
    return { version: PROFILE_STORE_VERSION, projectId: this.projectId, profiles: this.ledger.profiles.map(clone), activeProfileId: this.ledger.active?.profileId };
  }

  private async defaultValidator(profile: OrganizationProfile, scope: ProjectCredentialScope): Promise<void> {
    if (!this.auth) throw new Error('An authentication service is required for provider validation.');
    await validateNearAiProvider({ auth: this.auth, profile, scope });
  }

  private async setValidation(profileId: string, validation: ProfileValidation): Promise<OrganizationProfile> {
    await this.load();
    const profile = this.ledger.profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) throw new Error('The requested profile was not found.');
    profile.validation = { ...validation };
    profile.updatedAt = this.clock();
    await this.persist();
    return clone(profile);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await this.fileSystem.readFile(this.filePath, 'utf8')) as Partial<ProfileLedger> & { profiles?: unknown[]; activeProfileId?: unknown };
      if (parsed.version !== PROFILE_STORE_VERSION && parsed.version !== 0 && parsed.version !== undefined) throw new Error('Unsupported profile ledger.');
      const profiles = (Array.isArray(parsed.profiles) ? parsed.profiles : []).map((value) => normalizeProfile(value)).filter((value): value is OrganizationProfile => Boolean(value)).slice(0, MAX_PROFILES);
      const activeProfileId = typeof parsed.activeProfileId === 'string' ? parsed.activeProfileId : (parsed.active?.profileId);
      const active = isProfileId(activeProfileId) && profiles.some((profile) => profile.profileId === activeProfileId) ? { version: AUTH_PROFILE_VERSION, projectId: this.projectId, profileId: activeProfileId, selectedAt: typeof parsed.active?.selectedAt === 'string' ? parsed.active.selectedAt : this.clock() } : undefined;
      this.ledger = { version: PROFILE_STORE_VERSION, projectId: this.projectId, profiles, active };
      if (parsed.version !== PROFILE_STORE_VERSION || parsed.projectId !== this.projectId) await this.persist();
    } catch {
      this.ledger = { version: PROFILE_STORE_VERSION, projectId: this.projectId, profiles: [] };
    }
  }

  private async persist(): Promise<void> {
    const payload = `${JSON.stringify(this.ledger)}\n`;
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    this.writeQueue = this.writeQueue.then(async () => {
      await this.fileSystem.mkdir(directory, { recursive: true });
      await this.fileSystem.writeFile(temporary, payload, 'utf8');
      await this.fileSystem.rename(temporary, this.filePath);
    });
    await this.writeQueue;
  }
}

function normalizeProfile(value: unknown): OrganizationProfile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Partial<OrganizationProfile> & { company?: unknown; validationStatus?: unknown };
  if (!isProfileId(source.profileId)) return undefined;
  const displayName = safeLabel(source.displayName, 80);
  const organization = safeLabel(source.organization ?? source.company, 120);
  const baseUrl = safeBaseUrl(source.baseUrl);
  if (!displayName || !organization || !baseUrl) return undefined;
  const authMode: AuthMode | undefined = source.authMode === 'nearAccount' ? 'nearAccount' : source.authMode === 'apiKey' ? 'apiKey' : undefined;
  if (!authMode) return undefined;
  const validation = normalizeValidation(source.validation ?? { status: source.validationStatus });
  if (!validation) return undefined;
  const now = new Date(0).toISOString();
  return { version: AUTH_PROFILE_VERSION, profileId: source.profileId, displayName, organization, provider: 'near-ai', baseUrl, authMode, createdAt: safeTimestamp(source.createdAt) ?? now, updatedAt: safeTimestamp(source.updatedAt) ?? now, validation };
}

function normalizeValidation(value: unknown): ProfileValidation | undefined {
  if (!value || typeof value !== 'object') return { status: 'pending' };
  const source = value as Partial<ProfileValidation>;
  const status = source.status === 'valid' || source.status === 'stale' || source.status === 'invalid' || source.status === 'pending' ? source.status : 'pending';
  const validation: ProfileValidation = { status };
  if (status === 'valid') {
    const timestamp = safeTimestamp(source.validatedAt);
    if (timestamp) validation.validatedAt = timestamp;
    else validation.status = 'stale';
  }
  if (status === 'invalid' && typeof source.error === 'string') validation.error = redactSecrets(source.error).replace(/\s+/g, ' ').slice(0, 200);
  return validation;
}

function safeLabel(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || /(?:api[_ -]?key|refresh[-_ ]?token|bearer\s|authorization\s*[:=]|private prompt|raw context|command\s*[:=]|[A-Za-z]:\\|^\/)/i.test(value)) return undefined;
  const normalized = value.replace(/[\r\n\t]+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function safeBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 300 || /(?:api[_ -]?key|token|secret|password)/i.test(value)) return undefined;
  try {
    const parsed = new URL(value.trim());
    return isSecureEndpoint(parsed.toString()) ? parsed.toString().replace(/\/$/, '') : undefined;
  } catch { return undefined; }
}

function safeTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 40 && !/[\r\n]/.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
