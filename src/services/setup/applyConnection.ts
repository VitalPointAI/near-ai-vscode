import { deriveProfileId, type OrganizationProfile } from '../../domain/auth';
import { isNearCloudEndpoint, isSecureEndpoint } from '../../domain/config';
import { isLoopbackEndpointHost } from '../../domain/gate/endpoints';
import type { ViabilityResult } from '../../domain/setup/viability';
import type { ProfileStore } from '../profileStore';
import type { ApplyStep } from './apply';

export type ProfileSlice = Pick<ProfileStore, 'getActiveProfile' | 'list' | 'select' | 'configure'>;

export type ReviewedConnection =
  | { readonly provider: 'local'; readonly localBaseUrl: string }
  | { readonly provider: 'near-ai'; readonly nearBaseUrl: string }
  | { readonly provider: 'hybrid'; readonly localBaseUrl: string; readonly nearBaseUrl: string };

function normalizedBase(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !isSecureEndpoint(url.href)) return undefined;
    return url.href.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

export function isLoopbackConnection(value: string): boolean {
  const base = normalizedBase(value);
  return base !== undefined && isLoopbackEndpointHost(new URL(base).hostname);
}

export function supportsReviewedConnection(connection: ReviewedConnection): boolean {
  return (!('localBaseUrl' in connection) || isLoopbackConnection(connection.localBaseUrl)) &&
    (!('nearBaseUrl' in connection) || Boolean(connection.nearBaseUrl.trim()) && isNearCloudEndpoint(connection.nearBaseUrl));
}

/** Translate only the standard connection types the profile store can configure. */
export function profileFor(chosen: readonly ViabilityResult[]): ReviewedConnection | undefined {
  let localBaseUrl: string | undefined;
  let nearBaseUrl: string | undefined;
  for (const option of chosen) {
    const facts = option.routeFacts;
    if (option.state !== 'viable' || !facts) return undefined;
    const base = normalizedBase(facts.host);
    if (!base) return undefined;
    if ((option.kind === 'this-computer' || option.kind === 'org-server') && facts.clientRoute === 'local') {
      if (localBaseUrl && localBaseUrl !== base) return undefined;
      localBaseUrl = base;
    } else if ((option.kind === 'near-private' || option.kind === 'near-all') && facts.clientRoute === 'near') {
      if (nearBaseUrl && nearBaseUrl !== base) return undefined;
      nearBaseUrl = base;
    } else {
      return undefined;
    }
  }
  if (nearBaseUrl && localBaseUrl) return { provider: 'hybrid', nearBaseUrl, localBaseUrl };
  if (nearBaseUrl) return { provider: 'near-ai', nearBaseUrl };
  if (localBaseUrl) return { provider: 'local', localBaseUrl };
  return undefined;
}

function matches(profile: OrganizationProfile | undefined, desired: ReviewedConnection): boolean {
  if (!profile || profile.provider !== desired.provider || profile.validation.status !== 'valid') return false;
  if (desired.provider === 'local') return normalizedBase(profile.baseUrl) === desired.localBaseUrl;
  return normalizedBase(profile.baseUrl) === desired.nearBaseUrl &&
    (desired.provider === 'near-ai' || Boolean(profile.localBaseUrl && normalizedBase(profile.localBaseUrl) === desired.localBaseUrl));
}

export function connectionStep(input: {
  readonly root: string;
  readonly profiles: ProfileSlice;
  readonly chosen: readonly ViabilityResult[];
  readonly projectName: string;
  configureConnection(reviewed: ReviewedConnection): Promise<boolean>;
}): ApplyStep {
  const { root, profiles, chosen, projectName } = input;
  const desired = profileFor(chosen);
  const done = { id: 'connection', outcome: 'done' } as const;
  const waiting = { id: 'connection', outcome: 'waiting', message: 'Finish setting up the selected AI connection.' } as const;
  return {
    changeId: 'connection',
    async alreadyDone() { return desired !== undefined && matches(await profiles.getActiveProfile(), desired); },
    async run() {
      if (!desired) return waiting;
      const saved = await profiles.list();
      const existing = saved.find((profile) => matches(profile, desired));
      if (existing) {
        await profiles.select(existing.profileId);
        return done;
      }
      if (desired.provider === 'local') {
        const profileId = deriveProfileId(`${root}\n${desired.localBaseUrl}`, projectName);
        // A keyless Apply may create a profile. Changes to an existing profile use the normal connection flow.
        if (!saved.some((profile) => profile.profileId === profileId)) {
          const created = await profiles.configure({
            profileId, displayName: projectName, organization: projectName, provider: 'local',
            baseUrl: desired.localBaseUrl, authMode: 'apiKey'
          }, '');
          if (matches(created, desired)) return done;
          return waiting;
        }
      }
      return await input.configureConnection(desired) && matches(await profiles.getActiveProfile(), desired) ? done : waiting;
    }
  };
}
