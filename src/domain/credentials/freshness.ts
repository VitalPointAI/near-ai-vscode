// Freshness at the enforcement points (Phase 71, D-11, DCAC-04): the hub on append and serve, the wrap preparer and the session ask, at the moment of
// action, whether the lists an entry or a request cites are fresh enough. The fold never asks (it stays deterministic; evidence.ts). Pure: the caller
// passes `now` and what it knows of the newest lists.
//
// Three rules, from the cited policy's credentials@1 section:
// - superseded: a cited list older than the newest copy known by more than the grace (default: the status time to live);
// - at a connected site: the newest copy held was fetched longer ago than the time to live, so it must be fetched again;
// - at an edge: a cited list older than the level's maximum offline age (O6). A level the policy gives no offline age has none.
import type { CredentialsSection } from '../gate/credentialsSection';
import type { EvidenceCitation } from './evidence';
import { credentialTimeMs } from './types';

export type SiteKind = 'connected' | 'edge';

/** What the enforcement point knows of a list: the newest validFrom it holds, and when it fetched that copy (epoch milliseconds). */
export interface NewestList {
  readonly validFrom: string;
  readonly fetchedAt?: number;
}

// Each refusal: one sentence and what the person can do.
export const FRESHNESS_REFUSALS = {
  'superseded': { text: 'This relies on a status list that has since been replaced. Try again so the newest list is used.', action: 'retry' },
  'past-ttl': { text: 'The status lists here are older than your organization allows. Try again once they are refreshed.', action: 'retry' },
  'offline-too-long': { text: 'This computer has been away from your organization\'s server longer than this level allows. Connect to your organization\'s server to continue.', action: 'connect' },
  'unreadable': { text: 'The status list times could not be read. Try again.', action: 'retry' }
} as const;
export type FreshnessRefusal = keyof typeof FRESHNESS_REFUSALS;
export type FreshnessResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: FreshnessRefusal; readonly message: string; readonly action: 'retry' | 'connect' };

function refuse(reason: FreshnessRefusal): FreshnessResult {
  const found = FRESHNESS_REFUSALS[reason];
  return { ok: false, reason, message: found.text, action: found.action };
}

export interface FreshnessOptions {
  /** Grace in seconds; default the policy's status time to live. */
  readonly graceSeconds?: number;
}

/**
 * Whether the cited lists are fresh enough now. `newest` maps a list id to what this enforcement point holds; `level` is `scale/level` or undefined
 * for unmarked data (then only the superseded and time-to-live rules apply).
 */
export function checkFreshness(
  citation: EvidenceCitation, newest: Readonly<Record<string, NewestList>>, level: string | undefined, policy: CredentialsSection, now: number,
  siteKind: SiteKind, options: FreshnessOptions = {}
): FreshnessResult {
  if (!Number.isFinite(now)) return refuse('unreadable');
  const ttlMs = policy.statusTtl * 1000;
  const graceMs = (options.graceSeconds ?? policy.statusTtl) * 1000;
  const offlineAge = level !== undefined && Object.prototype.hasOwnProperty.call(policy.maxOfflineAge, level) ? policy.maxOfflineAge[level] : undefined;
  for (const cited of citation.status) {
    const from = credentialTimeMs(cited.validFrom);
    if (Number.isNaN(from)) return refuse('unreadable');
    const held = Object.prototype.hasOwnProperty.call(newest, cited.list) ? newest[cited.list] : undefined;
    const heldFrom = held === undefined ? from : credentialTimeMs(held.validFrom);
    if (Number.isNaN(heldFrom)) return refuse('unreadable');
    if (heldFrom - from > graceMs) return refuse('superseded');
    if (siteKind === 'connected') {
      const fetched = held?.fetchedAt ?? heldFrom;
      if (now - fetched > ttlMs) return refuse('past-ttl');
    } else if (level !== undefined && (offlineAge === undefined || now - from > offlineAge * 1000)) {
      return refuse('offline-too-long');
    }
  }
  return { ok: true };
}
