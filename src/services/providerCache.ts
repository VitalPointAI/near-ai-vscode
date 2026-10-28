import type { OrganizationProfile, ResolvedProvider } from '../domain/auth';
import { AuthService } from './auth';
import type { ModelInfo } from './nearAiClient';
import { ProfileStore } from './profileStore';
import { createNearAiProvider } from './providerFactory';

export interface ActiveProvider {
  profile: OrganizationProfile;
  profiles: ProfileStore;
  provider: ResolvedProvider;
  /** The catalog with pricing and privacy, also loaded into `provider.client` so estimates work. */
  models: ModelInfo[];
}

const CATALOG_TTL_MS = 10 * 60_000;
/** After a failed refresh, the last good catalog is served and the refresh is tried again this much later. */
const CATALOG_RETRY_AFTER_FAILURE_MS = 60_000;
const cache = new Map<string, { provider: ResolvedProvider; models: Promise<ModelInfo[]>; loadedAt: number; last?: ModelInfo[] }>();

/**
 * The project's active, validated provider with its model catalog. Reused across turns so the
 * client keeps pricing (needed for estimates); a profile change (new key, re-validation) gets a
 * fresh entry because the key includes when the profile was last updated. A refresh that fails
 * (NEAR rate limiting, a network blip) keeps serving the last good catalog; only a first load
 * that fails is dropped, so the next call tries again.
 * Returns undefined when the project has no validated active profile.
 */
export async function activeProvider(root: string, auth: AuthService, options: { now?: () => number } = {}): Promise<ActiveProvider | undefined> {
  const now = options.now ?? Date.now;
  const profiles = new ProfileStore(root, auth);
  const profile = await profiles.getActiveProfile();
  const selection = await profiles.getActiveSelection();
  if (!profile || !selection || profile.validation.status !== 'valid') return undefined;
  const key = `${root}\u0000${profile.profileId}\u0000${profile.updatedAt}`;
  let entry = cache.get(key);
  if (!entry || now() - entry.loadedAt > CATALOG_TTL_MS) {
    const previous = entry;
    const provider = previous?.provider ?? await createNearAiProvider({ auth, profile, scope: profiles.getScope(selection.profileId) });
    // A local runtime has no NEAR catalog, pricing, or billing; its models run on this machine.
    const fresh = provider.provider === 'local'
      ? provider.client.listLocalModels()
      : provider.localClient
        ? Promise.all([provider.client.listModelsWithPricing(), provider.localClient.listLocalModels()]).then(([cloud, local]) => [...local, ...cloud])
        : provider.client.listModelsWithPricing();
    const last = previous?.last;
    const created: NonNullable<typeof entry> = { provider, models: last ? fresh.catch(() => last) : fresh, loadedAt: now(), last };
    entry = created;
    cache.set(key, created);
    fresh.then((models) => { created.last = models; }, () => {
      if (cache.get(key) !== created) return;
      if (created.last) created.loadedAt = now() - CATALOG_TTL_MS + CATALOG_RETRY_AFTER_FAILURE_MS;
      else cache.delete(key);
    });
  }
  return { profile, profiles, provider: entry.provider, models: await entry.models };
}

/** The client that serves `model`: the local runtime for local models, NEAR AI Cloud otherwise. */
export function clientFor(active: ActiveProvider, model: string): { client: ResolvedProvider['client']; local: boolean } {
  const info = active.models.find((candidate) => candidate.id === model);
  const local = info?.privacyBoundary === 'local' || active.provider.provider === 'local';
  return { client: local && active.provider.localClient ? active.provider.localClient : active.provider.client, local };
}

/** Drops cached providers, e.g. after a profile or key is removed. */
export function clearProviderCache(): void {
  cache.clear();
}
