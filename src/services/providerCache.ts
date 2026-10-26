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
const cache = new Map<string, { provider: ResolvedProvider; models: Promise<ModelInfo[]>; loadedAt: number }>();

/**
 * The project's active, validated provider with its model catalog. Reused across turns so the
 * client keeps pricing (needed for estimates); a profile change (new key, re-validation) gets a
 * fresh entry because the key includes when the profile was last updated.
 * Returns undefined when the project has no validated active profile.
 */
export async function activeProvider(root: string, auth: AuthService): Promise<ActiveProvider | undefined> {
  const profiles = new ProfileStore(root, auth);
  const profile = await profiles.getActiveProfile();
  const selection = await profiles.getActiveSelection();
  if (!profile || !selection || profile.validation.status !== 'valid') return undefined;
  const key = `${root}\u0000${profile.profileId}\u0000${profile.updatedAt}`;
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.loadedAt > CATALOG_TTL_MS) {
    const provider = entry?.provider ?? await createNearAiProvider({ auth, profile, scope: profiles.getScope(selection.profileId) });
    const models = provider.client.listModelsWithPricing();
    entry = { provider, models, loadedAt: Date.now() };
    cache.set(key, entry);
    models.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  }
  return { profile, profiles, provider: entry.provider, models: await entry.models };
}

/** Drops cached providers, e.g. after a profile or key is removed. */
export function clearProviderCache(): void {
  cache.clear();
}
