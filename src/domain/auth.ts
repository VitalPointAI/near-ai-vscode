import type { NearAiClient } from '../services/nearAiClient';
import { createHash } from 'node:crypto';
import { AuthMode } from './config';

export const AUTH_PROFILE_VERSION = 1 as const;
export const PROJECT_SCOPE_VERSION = 1 as const;

export type ProfileValidationStatus = 'pending' | 'valid' | 'stale' | 'invalid';

export interface ProfileValidation {
  status: ProfileValidationStatus;
  validatedAt?: string;
  error?: string;
}

export interface OrganizationProfile {
  version: typeof AUTH_PROFILE_VERSION;
  profileId: string;
  displayName: string;
  organization: string;
  provider: 'near-ai';
  baseUrl: string;
  authMode: AuthMode;
  createdAt: string;
  updatedAt: string;
  validation: ProfileValidation;
}

export interface ProjectCredentialScope {
  version: typeof PROJECT_SCOPE_VERSION;
  projectId: string;
  profileId: string;
}

export interface ActiveProfileSelection {
  version: typeof AUTH_PROFILE_VERSION;
  projectId: string;
  profileId: string;
  selectedAt: string;
}

/** Host-only provider result. This type must never cross the webview boundary. */
export interface ResolvedProvider {
  profileId: string;
  projectId: string;
  provider: 'near-ai';
  baseUrl: string;
  client: NearAiClient;
}

export const PROFILE_ID_PATTERN = /^profile-[a-z0-9][a-z0-9-]{1,63}$/;
export const PROJECT_ID_PATTERN = /^project-[a-f0-9]{32}$/;

export function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_ID_PATTERN.test(value);
}

/**
 * Hash the canonical workspace identity before it is used in a secret name.
 * The path itself, display names, and credential material never enter storage keys.
 */
export function deriveProjectScopeId(projectIdentity: string): string {
  const canonical = projectIdentity.trim();
  if (!canonical || canonical.includes('\u0000')) throw new Error('A canonical project identity is required.');
  return `project-${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

export function createProjectCredentialScope(projectIdentity: string, profileId: string): ProjectCredentialScope {
  if (!isProfileId(profileId)) throw new Error('A stable profile ID is required.');
  return { version: PROJECT_SCOPE_VERSION, projectId: deriveProjectScopeId(projectIdentity), profileId };
}

export function isProjectCredentialScope(value: unknown): value is ProjectCredentialScope {
  if (!value || typeof value !== 'object') return false;
  const scope = value as Partial<ProjectCredentialScope>;
  return scope.version === PROJECT_SCOPE_VERSION && PROJECT_ID_PATTERN.test(scope.projectId ?? '') && isProfileId(scope.profileId);
}
