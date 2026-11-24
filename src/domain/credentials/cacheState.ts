// The state of a person's verified credentials in a session or on a computer (Phase 71, D-18): fresh, stale or unavailable, as a pure transition.
// Nothing waits silently: each state has one sentence and, where the person can do something, an action.

export type CredentialCacheState = 'fresh' | 'stale' | 'unavailable';

export interface CredentialCache {
  readonly state: CredentialCacheState;
  /** When the last full check (with every needed list and log) succeeded, epoch milliseconds. */
  readonly refreshedAt?: number;
  /** The status time to live, milliseconds. */
  readonly ttlMs: number;
}

export type CacheEvent =
  | { readonly kind: 'refreshed'; readonly at: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'tick'; readonly now: number };

export const CACHE_STATE_TEXT: Readonly<Record<CredentialCacheState, { readonly text: string; readonly action?: 'retry' | 'connect' }>> = Object.freeze({
  fresh: Object.freeze({ text: 'Your credentials are checked and up to date.' }),
  stale: Object.freeze({ text: 'Your credentials have not been checked recently, so protected actions wait until they are. Try again to check them now.', action: 'retry' as const }),
  unavailable: Object.freeze({ text: 'Your credentials cannot be checked here right now, so protected actions are refused. Connect to your organization\'s server and try again.', action: 'connect' as const })
});

/** The starting state: nothing checked yet is unavailable, never fresh. */
export function initialCache(ttlMs: number): CredentialCache {
  return Object.freeze({ state: 'unavailable', ttlMs });
}

/** One transition: a successful refresh makes it fresh; a missing list or log makes it unavailable; time past the time to live makes fresh stale. */
export function cacheStateAt(current: CredentialCache, event: CacheEvent): CredentialCache {
  switch (event.kind) {
    case 'refreshed':
      return Number.isFinite(event.at) ? Object.freeze({ state: 'fresh', refreshedAt: event.at, ttlMs: current.ttlMs }) : current;
    case 'missing':
      return Object.freeze({ state: 'unavailable', ttlMs: current.ttlMs, ...(current.refreshedAt === undefined ? {} : { refreshedAt: current.refreshedAt }) });
    case 'tick':
      if (current.state !== 'fresh' || current.refreshedAt === undefined) return current;
      return !Number.isFinite(event.now) || event.now - current.refreshedAt >= current.ttlMs ? Object.freeze({ ...current, state: 'stale' }) : current;
    default:
      return current;
  }
}
