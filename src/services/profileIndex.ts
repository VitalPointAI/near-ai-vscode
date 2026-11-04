import type { AuthMode } from '../domain/config';
import type { OrganizationProfile, ProfileValidation, ProviderKind } from '../domain/auth';

/** One profile set up in a project on this computer: metadata only, never a key. */
export interface SavedProfileEntry {
  projectId: string;
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

export function initProfileIndex(_memento: ProfileIndexMemento | undefined): void { /* declared only */ }
export async function recordProjectProfiles(_projectId: string, _projectLabel: string, _profiles: OrganizationProfile[]): Promise<void> { /* declared only */ }
export function listSavedProfiles(_excludeProjectId?: string): SavedProfileEntry[] { return []; }
