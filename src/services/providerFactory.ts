import { OrganizationProfile, ProjectCredentialScope, ResolvedProvider, isProjectCredentialScope } from '../domain/auth';
import { AuthService } from './auth';
import { NearAiClient } from './nearAiClient';

export interface CreateNearAiProviderOptions {
  auth: AuthService;
  profile: OrganizationProfile;
  scope: ProjectCredentialScope;
  fetchFn?: typeof fetch;
}

export async function createNearAiProvider(options: CreateNearAiProviderOptions): Promise<ResolvedProvider> {
  const { auth, profile, scope } = options;
  if (!isProjectCredentialScope(scope) || scope.profileId !== profile.profileId) {
    throw new Error('The provider scope does not match the selected profile.');
  }
  if (profile.validation.status !== 'valid') {
    throw new Error('The selected profile must pass provider validation before dispatch.');
  }
  if (profile.authMode !== 'apiKey') {
    throw new Error('NEAR account sign-in is pending provider token exchange.');
  }
  const apiKey = await auth.getScopedApiKey(scope);
  if (!apiKey) throw new Error('The selected profile has no configured credential.');
  return {
    profileId: profile.profileId,
    projectId: scope.projectId,
    provider: 'near-ai',
    baseUrl: profile.baseUrl,
    client: new NearAiClient({ baseUrl: profile.baseUrl, apiKey, fetchFn: options.fetchFn })
  };
}

export async function validateNearAiProvider(options: Omit<CreateNearAiProviderOptions, 'profile'> & { profile: OrganizationProfile; }): Promise<void> {
  const { auth, profile, scope, fetchFn } = options;
  if (!isProjectCredentialScope(scope) || scope.profileId !== profile.profileId) throw new Error('The provider scope does not match the selected profile.');
  if (profile.authMode !== 'apiKey') throw new Error('NEAR account sign-in is pending provider token exchange.');
  const apiKey = await auth.getScopedApiKey(scope);
  if (!apiKey) throw new Error('The selected profile has no configured credential.');
  await new NearAiClient({ baseUrl: profile.baseUrl, apiKey, fetchFn }).listModels();
}
