// The one place the gate decides where a person's clearances come from (Phase 71, D-08, D-19, VCRD-07). labelPolicy (host.ts) and routePolicyFor
// (sessionMark.ts) both ask it.
// - Your organization's policy in force carries credentials@1: clearances come only from the verified wallet, and only while it is fresh. A stale or
//   unavailable wallet gives none (fail closed), with the wallet state's sentence. Declared clearances count for nothing here.
// - Otherwise (no organization, or one without credentials@1): the person's own declared clearances, on this computer only, shown as declared, not
//   verified. Nothing changes for a solo install.
import type { Clearance } from '../domain/gate/labels';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import { CACHE_STATE_TEXT } from '../domain/credentials/cacheState';
import type { CredentialCacheState } from '../domain/credentials/cacheState';

export const DECLARED_NOT_VERIFIED_TEXT =
  'Your clearances here are declared, not verified: they come from your own policy on this computer and count nowhere else.';

/** What the gate needs of the wallet at the moment of a decision: its state then and the clearances its checked credentials give. */
export interface ClearanceWalletView {
  readonly state: CredentialCacheState;
  readonly clearances: readonly Clearance[];
}

export interface ClearancesInForce {
  readonly clearances: readonly Clearance[];
  readonly source: 'credentials' | 'declared';
  readonly sentence: string;
}

/** The clearances decisions use now. `organization` is your organization's valid layer, if any; `effective` the composed policy. */
export function clearancesInForce(effective: PolicyDocument | undefined, organization: PolicyDocument | undefined, wallet: ClearanceWalletView | undefined): ClearancesInForce {
  if (organization?.credentials !== undefined) {
    const state = wallet?.state ?? 'unavailable';
    return Object.freeze({ clearances: state === 'fresh' && wallet !== undefined ? wallet.clearances : Object.freeze([]), source: 'credentials', sentence: CACHE_STATE_TEXT[state].text });
  }
  return Object.freeze({ clearances: effective?.people?.clearances ?? Object.freeze([]), source: 'declared', sentence: DECLARED_NOT_VERIFIED_TEXT });
}
