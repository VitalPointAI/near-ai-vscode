import { OrganizationProfile, ProjectCredentialScope, ResolvedProvider, isProjectCredentialScope, localKeyScope } from '../domain/auth';
import { isNearCloudEndpoint } from '../domain/config';
import { AuthService } from './auth';
import { NearConnectionBinding } from './connectionBinding';
import { NearAiClient } from './nearAiClient';
import { spendAccountFor } from './spendAccount';

export interface CreateNearAiProviderOptions {
  auth: Pick<AuthService, 'getScopedApiKeyFor'>;
  profile: OrganizationProfile;
  scope: ProjectCredentialScope;
  fetchFn?: typeof fetch;
}

/** Construct the scoped primary client. The caller decides whether and when to check its connection. */
export async function createProfilePrimaryClient(options: CreateNearAiProviderOptions): Promise<NearAiClient | undefined> {
  const { auth, profile, scope, fetchFn } = options;
  if (!isProjectCredentialScope(scope) || scope.profileId !== profile.profileId) throw new Error('The provider scope does not match the selected profile.');
  const apiKey = await auth.getScopedApiKeyFor(scope, profile.baseUrl) ?? '';
  if (!apiKey && profile.provider !== 'local') return undefined;
  // Every billable response of a NEAR AI Cloud key goes to that key's spend ledger; a local runtime bills nothing.
  const spend = profile.provider === 'local' ? undefined : spendAccountFor(profile.baseUrl, apiKey);
  // CLAS-06: each client says which route it is, so the route check judges the client a request really uses. A hybrid profile's NEAR client knows a local
  // model is there to use instead.
  const hybrid = profile.provider === 'hybrid' && Boolean(profile.localBaseUrl);
  const kind = profile.provider === 'local' ? 'local' : 'near';
  // CLAS-05 (D-50): only a NEAR client on NEAR AI Cloud's own endpoint gets a binding source, whose GET is this client's own and whose model is a private one
  // from this client's cached catalog. Every other client has none, so content at attested-cloud levels never goes through it.
  let client: NearAiClient | undefined;
  const binding = kind === 'near' && isNearCloudEndpoint(profile.baseUrl)
    ? new NearConnectionBinding({ get: (path, signal) => client!.getJson(path, signal), teeModel: () => client?.cachedTeeModel() })
    : undefined;
  client = new NearAiClient({ baseUrl: profile.baseUrl, apiKey, fetchFn, route: kind, ...(binding ? { binding } : {}), ...(hybrid ? { localModelAvailable: true } : {}), ...(spend ? { spend, spendTag: { projectId: scope.projectId } } : {}) });
  return client;
}

/** Builds the clients for a profile: NEAR AI Cloud, a local runtime, or both (hybrid). */
async function clientsFor(options: CreateNearAiProviderOptions): Promise<{ client: NearAiClient; localClient?: NearAiClient }> {
  const { auth, profile, scope, fetchFn } = options;
  const client = await createProfilePrimaryClient(options);
  if (!client) throw new Error('The selected profile has no configured credential.');
  // The first check starts now, in the background, so a labelled chat rarely meets a connection nobody has checked yet. Nothing waits for it.
  if (client.connectionBinding) client.refreshBinding();
  if (profile.provider !== 'hybrid' || !profile.localBaseUrl) return { client };
  const localApiKey = await auth.getScopedApiKeyFor(localKeyScope(scope), profile.localBaseUrl) ?? '';
  return { client, localClient: new NearAiClient({ baseUrl: profile.localBaseUrl, apiKey: localApiKey, fetchFn, route: 'local' }) };
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
