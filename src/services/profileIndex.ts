import type { AuthMode } from '../domain/config';
import { isProfileId, PROJECT_ID_PATTERN } from '../domain/auth';
import { redactSecrets } from '../domain/redaction';
import type { OrganizationProfile, ProfileValidation, ProviderKind } from '../domain/auth';

// The list of NEAR AI profiles set up in projects on this computer, kept in VS Code's global state so another project can reuse one
// (G-61-9). Metadata only: no key, token or folder path is ever written here. Keys stay in SecretStorage under the scope they were
// saved with; a project that reuses a profile reads that key by reference. No Team Mode import: team key profiles are left out by their
// id prefix alone, because their spending limit belongs to that team's project.

/** One profile set up in a project on this computer: metadata only, never a key. */
export interface SavedProfileEntry {
  /** The scope id of the project it was set up in (a hash, not a path). */
  projectId: string;
  /** The project's folder name only. */
  projectLabel: string;
  profileId: string;
  displayName: string;
  organization: string;
  provider: ProviderKind;
  baseUrl: string;
  localBaseUrl?: string;
  authMode: AuthMode;
  validation: ProfileValidation['status'];
  updatedAt: string;
}

export interface ProfileIndexMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** A project that reuses a profile: recorded only when the person chose it through useSavedProfile. */
interface CopyLink { projectId: string; profileId: string; sourceProjectId: string }

interface IndexState { version: 1; entries: SavedProfileEntry[]; links: CopyLink[] }

const INDEX_KEY = 'nearAi.savedProfiles';
const MAX_ENTRIES = 50;
const MAX_LINKS = 50;
const TEAM_PROFILE_ID_PREFIX = 'profile-team-';

let memento: ProfileIndexMemento | undefined;

/** Called once at activation with context.globalState. Until then every function here does nothing. */
export function initProfileIndex(store: ProfileIndexMemento | undefined): void {
  memento = store;
}

export function isTeamProfileId(profileId: string): boolean {
  return profileId.startsWith(TEAM_PROFILE_ID_PREFIX);
}

/**
 * Replaces this project's entries with its current profiles. Team key profiles and profiles reused from another project are left out.
 * Written only when something changed.
 */
export async function recordProjectProfiles(projectId: string, projectLabel: string, profiles: OrganizationProfile[]): Promise<void> {
  if (!memento || !PROJECT_ID_PATTERN.test(projectId)) return;
  const state = readState();
  const label = safeProjectLabel(projectLabel);
  const own = profiles.filter((profile) => !profile.keySource && !isTeamProfileId(profile.profileId)).map((profile) => normalizeEntry({
    projectId,
    projectLabel: label,
    profileId: profile.profileId,
    displayName: profile.displayName,
    organization: profile.organization,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    ...(profile.localBaseUrl ? { localBaseUrl: profile.localBaseUrl } : {}),
    authMode: profile.authMode,
    validation: profile.validation.status,
    updatedAt: profile.updatedAt
  })).filter((entry): entry is SavedProfileEntry => Boolean(entry));
  const entries = newestFirst([...own, ...state.entries.filter((entry) => entry.projectId !== projectId)]).slice(0, MAX_ENTRIES);
  await writeState({ ...state, entries });
}

/** Saved profiles of other projects, newest first. Never a team key profile and never a reused copy. */
export function listSavedProfiles(excludeProjectId?: string): SavedProfileEntry[] {
  if (!memento) return [];
  return newestFirst(readState().entries.filter((entry) => entry.projectId !== excludeProjectId)).map((entry) => ({ ...entry }));
}

/** The listed entry for a project's profile, if the list still has it. */
export function findSavedProfile(projectId: string, profileId: string): SavedProfileEntry | undefined {
  if (!memento) return undefined;
  const entry = readState().entries.find((candidate) => candidate.projectId === projectId && candidate.profileId === profileId);
  return entry ? { ...entry } : undefined;
}

/** Records that this project's profile reuses the key of the same profile in sourceProjectId, because the person chose it. */
export async function recordCopyLink(projectId: string, profileId: string, sourceProjectId: string): Promise<void> {
  if (!memento) return;
  const link = normalizeLink({ projectId, profileId, sourceProjectId });
  if (!link) return;
  const state = readState();
  const links = [link, ...state.links.filter((candidate) => !(candidate.projectId === projectId && candidate.profileId === profileId))].slice(0, MAX_LINKS);
  await writeState({ ...state, links });
}

export async function dropCopyLink(projectId: string, profileId: string): Promise<void> {
  if (!memento) return;
  const state = readState();
  await writeState({ ...state, links: state.links.filter((candidate) => !(candidate.projectId === projectId && candidate.profileId === profileId)) });
}

/**
 * True only when the person chose this copy through useSavedProfile on this computer. A reference written into a project's profile
 * file by hand (or shipped in a cloned repository) is not followed.
 */
export function isLinkedCopy(projectId: string, profileId: string, sourceProjectId: string): boolean {
  if (!memento) return false;
  return readState().links.some((link) => link.projectId === projectId && link.profileId === profileId && link.sourceProjectId === sourceProjectId);
}

export interface SavedProfileUi {
  pick<T extends { label: string; description: string; detail: string }>(items: T[], options: { title: string; placeHolder: string }): Promise<T | undefined>;
  progress<T>(title: string, task: () => Promise<T>): Promise<T>;
  info(message: string, ...actions: string[]): Promise<string | undefined>;
  error(message: string, ...actions: string[]): Promise<string | undefined>;
}

export interface UseSavedProfileDeps {
  projectId: string;
  use(entry: SavedProfileEntry): Promise<OrganizationProfile>;
  setUpNew(): Promise<void>;
  refresh(): Promise<void>;
}

const SET_UP_NEW = 'Set up a new profile';
const CHOOSE_ANOTHER = 'Choose another';

/**
 * Use a profile from another project: pick one by its name and folder, check its key where it is stored, and make it this project's
 * profile. The key is never shown; with nothing saved yet, or when the check fails, the person is offered Set up a new profile.
 */
export async function runUseSavedProfile(ui: SavedProfileUi, deps: UseSavedProfileDeps): Promise<'ready' | 'failed' | 'cancelled' | 'none'> {
  const entries = listSavedProfiles(deps.projectId);
  if (!entries.length) {
    const next = await ui.info('There are no saved profiles from other projects yet. A profile you set up in a project is offered here in your other projects.', SET_UP_NEW);
    if (next === SET_UP_NEW) await deps.setUpNew();
    return 'none';
  }
  const picked = await ui.pick(entries.map((entry) => ({ label: entry.displayName, description: `from ${entry.projectLabel}`, detail: checkText(entry), entry })), {
    title: 'Use a profile from another project',
    placeHolder: 'Choose a saved profile. Its key stays where it was saved and is not shown.'
  });
  if (!picked) return 'cancelled';
  let profile: OrganizationProfile | undefined;
  let reason: string;
  try {
    profile = await ui.progress('Checking your NEAR AI key', () => deps.use(picked.entry));
    reason = profile.validation.error ?? 'The key did not pass its check.';
  } catch (error) {
    reason = redactSecrets(error instanceof Error ? error.message : String(error));
  }
  await deps.refresh();
  if (profile?.validation.status === 'valid') {
    await ui.info(`${profile.displayName} is ready for this project.`);
    return 'ready';
  }
  const next = await ui.error(`${picked.entry.displayName} could not be used: ${reason}`, SET_UP_NEW, ...(entries.length > 1 ? [CHOOSE_ANOTHER] : []));
  if (next === SET_UP_NEW) await deps.setUpNew();
  if (next === CHOOSE_ANOTHER) await runUseSavedProfile(ui, deps);
  return 'failed';
}

function checkText(entry: SavedProfileEntry): string {
  if (entry.validation === 'valid') return `${entry.organization}. Key checked.`;
  if (entry.validation === 'invalid') return `${entry.organization}. Its key did not pass the last check.`;
  return `${entry.organization}. Its key is checked when you choose it.`;
}

function readState(): IndexState {
  const raw = memento?.get<unknown>(INDEX_KEY);
  const source = raw && typeof raw === 'object' ? raw as { entries?: unknown; links?: unknown } : {};
  const entries = (Array.isArray(source.entries) ? source.entries : []).map(normalizeEntry).filter((entry): entry is SavedProfileEntry => Boolean(entry)).slice(0, MAX_ENTRIES);
  const links = (Array.isArray(source.links) ? source.links : []).map(normalizeLink).filter((link): link is CopyLink => Boolean(link)).slice(0, MAX_LINKS);
  return { version: 1, entries, links };
}

async function writeState(next: IndexState): Promise<void> {
  if (!memento) return;
  const current = memento.get<unknown>(INDEX_KEY);
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  await memento.update(INDEX_KEY, next);
}

function newestFirst(entries: SavedProfileEntry[]): SavedProfileEntry[] {
  return [...entries].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}

function normalizeEntry(value: unknown): SavedProfileEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Partial<SavedProfileEntry>;
  if (typeof source.projectId !== 'string' || !PROJECT_ID_PATTERN.test(source.projectId)) return undefined;
  if (!isProfileId(source.profileId) || isTeamProfileId(source.profileId)) return undefined;
  const displayName = text(source.displayName, 80);
  const organization = text(source.organization, 120);
  const baseUrl = url(source.baseUrl);
  if (!displayName || !organization || !baseUrl) return undefined;
  const provider: ProviderKind = source.provider === 'local' || source.provider === 'hybrid' ? source.provider : 'near-ai';
  const localBaseUrl = provider === 'hybrid' ? url(source.localBaseUrl) : undefined;
  if (provider === 'hybrid' && !localBaseUrl) return undefined;
  const authMode: AuthMode | undefined = source.authMode === 'nearAccount' || source.authMode === 'apiKey' ? source.authMode : undefined;
  if (!authMode) return undefined;
  const validation = source.validation === 'valid' || source.validation === 'stale' || source.validation === 'invalid' ? source.validation : 'pending';
  const updatedAt = typeof source.updatedAt === 'string' && source.updatedAt.length <= 40 && !Number.isNaN(Date.parse(source.updatedAt)) ? source.updatedAt : new Date(0).toISOString();
  return { projectId: source.projectId, projectLabel: safeProjectLabel(source.projectLabel), profileId: source.profileId, displayName, organization, provider, baseUrl, ...(localBaseUrl ? { localBaseUrl } : {}), authMode, validation, updatedAt };
}

function normalizeLink(value: unknown): CopyLink | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Partial<CopyLink>;
  if (typeof source.projectId !== 'string' || !PROJECT_ID_PATTERN.test(source.projectId)) return undefined;
  if (typeof source.sourceProjectId !== 'string' || !PROJECT_ID_PATTERN.test(source.sourceProjectId) || source.sourceProjectId === source.projectId) return undefined;
  if (!isProfileId(source.profileId) || isTeamProfileId(source.profileId)) return undefined;
  return { projectId: source.projectId, profileId: source.profileId, sourceProjectId: source.sourceProjectId };
}

/** The folder name only: never a path, never control characters. */
function safeProjectLabel(value: unknown): string {
  const name = typeof value === 'string' ? value.split(/[\\/]/).filter(Boolean).pop() ?? '' : '';
  return text(name, 80) ?? 'another project';
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function url(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 300) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? value : undefined;
  } catch { return undefined; }
}
