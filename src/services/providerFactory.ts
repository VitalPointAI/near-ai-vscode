import { OrganizationProfile, ProjectCredentialScope, ResolvedProvider, isProjectCredentialScope, localKeyScope } from '../domain/auth';
import { AuthService } from './auth';
import { NearAiClient } from './nearAiClient';
import { spendAccountFor } from './spendAccount';

export interface CreateNearAiProviderOptions {
  auth: AuthService;
  profile: OrganizationProfile;
  scope: ProjectCredentialScope;
  fetchFn?: typeof fetch;
}

/** Builds the clients for a profile: NEAR AI Cloud, a local runtime, or both (hybrid). */
async function clientsFor(options: CreateNearAiProviderOptions): Promise<{ client: NearAiClient; localClient?: NearAiClient }> {
  const { auth, profile, scope, fetchFn } = options;
  if (!isProjectCredentialScope(scope) || scope.profileId !== profile.profileId) throw new Error('The provider scope does not match the selected profile.');
  const apiKey = await auth.getScopedApiKeyFor(scope, profile.baseUrl) ?? '';
  if (!apiKey && profile.provider !== 'local') throw new Error('The selected profile has no configured credential.');
  // Every billable response of a NEAR AI Cloud key goes to that key's spend ledger; a local runtime bills nothing.
  const spend = profile.provider === 'local' ? undefined : spendAccountFor(profile.baseUrl, apiKey);
  const client = new NearAiClient({ baseUrl: profile.baseUrl, apiKey, fetchFn, ...(spend ? { spend, spendTag: { projectId: scope.projectId } } : {}) });
  if (profile.provider !== 'hybrid' || !profile.localBaseUrl) return { client };
  const localApiKey = await auth.getScopedApiKeyFor(localKeyScope(scope), profile.localBaseUrl) ?? '';
  return { client, localClient: new NearAiClient({ baseUrl: profile.localBaseUrl, apiKey: localApiKey, fetchFn }) };
}

export async function createNearAiProvider(options: CreateNearAiProviderOptions): Promise<ResolvedProvider> {
  if (options.profile.validation.status !== 'valid') throw new Error('The selected profile must pass provider validation before dispatch.');
  const { client, localClient } = await clientsFor(options);
  return {
    profileId: options.profile.profileId,
    projectId: options.scope.projectId,
    provider: options.profile.provider,
    baseUrl: options.profile.baseUrl,
    client,
    ...(localClient ? { localClient } : {})
  };
}

/** A profile is valid when every endpoint it uses answers with its model list. */
export async function validateNearAiProvider(options: CreateNearAiProviderOptions): Promise<void> {
  const { client, localClient } = await clientsFor(options);
  if (options.profile.provider === 'local') await client.listLocalModels();
  else await client.listModels();
  if (localClient) {
    try {
      await localClient.listLocalModels();
    } catch (error) {
      throw new Error(`NEAR AI answered, but the local runtime at ${options.profile.localBaseUrl} did not: ${(error as Error).message}`);
    }
  }
}
