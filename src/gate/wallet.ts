// A person's wallet of verified credentials (Phase 71, D-15, D-18, VCRD-05): kept in SecretStorage under one key, checked on the way in and every time it
// is read, and shown to decisions only as a verified view with one cache state. In a hosted session the secret store is OpenBao KV under the person's
// own prefix (46-07's rebinding); on a single computer it is the keyring. Only the person's own host reads it. A credential body is never logged.
//
// Every check here runs at the host's clock: the wallet is an enforcement point, not the fold. Each credential is checked with the same checker the fold
// uses (checkEvidence), citing the credential, its issuer's role credentials and the lists the trust source holds now.
import type { SecretStorageLike } from '../services/auth';
import type { Clearance } from '../domain/gate/labels';
import { CACHE_STATE_TEXT, cacheStateAt, initialCache } from '../domain/credentials/cacheState';
import type { CredentialCache, CredentialCacheState } from '../domain/credentials/cacheState';
import { clearanceFromCredentials } from '../domain/credentials/clearance';
import { checkEvidence } from '../domain/credentials/evidence';
import type { EvidenceCitation } from '../domain/credentials/evidence';
import type { IssuerPolicy } from '../domain/credentials/issuerAuthority';
import { factsFrom } from '../domain/credentials/mayRelease';
import type { CredentialFacts } from '../domain/credentials/mayRelease';
import { credentialHash, readCredential } from '../domain/credentials/profile';
import type { VerifiedCredential } from '../domain/credentials/profile';
import { listHash } from '../domain/credentials/statusList';
import type { WebvhState } from '../domain/did/didWebvh';

/** The one SecretStorage key of the wallet. */
export const WALLET_SECRET_KEY = 'near-ai.credentials';
/** The file a single computer receives a credential in (never confused with ~/.near-credentials, which holds NEAR account keys). */
export const WALLET_FILE_EXTENSION = '.near-vc';
const MAX_FILE_BYTES = 64 * 1024;
const MAX_ENTRIES = 256;

export const WALLET_NOT_A_CREDENTIAL_TEXT = 'This file is not a credential this version can read. Nothing was added.';
export const WALLET_DOES_NOT_VERIFY_TEXT = 'This credential does not verify: it was changed, or its signer had no authority to issue it. Nothing was added.';
export const WALLET_ENDED_TEXT = 'This credential has ended, or has been revoked or suspended. Nothing was added.';
export const WALLET_CANNOT_CHECK_TEXT = 'This credential cannot be checked here right now. Connect to your organization\'s server and try again. Nothing was added.';
export const WALLET_NOT_YOURS_TEXT = 'This credential is about someone else. Nothing was added.';
export const WALLET_NOT_SAVED_TEXT = 'Your credentials could not be saved in this computer\'s secret storage. Nothing was added.';

/** Where the wallet reads what it checks against. A hub-backed one comes with 71-13; tests hold everything in memory. */
export interface TrustSource {
  /** The credentials section and scales of your organization's policy in force, or undefined when none is. */
  policy(): IssuerPolicy | undefined;
  /** A verified did:webvh state. */
  didState(did: string): WebvhState | undefined;
  /** The newest signed status list held for an id, and when it was fetched (epoch milliseconds). */
  list(id: string): { readonly credential: unknown; readonly fetchedAt: number } | undefined;
  /** The role credentials an issuer holds (signed blobs). */
  roles(did: string): readonly unknown[];
  /** The device bindings and delegations this computer knows. */
  deviceBindings?(): readonly VerifiedCredential[];
}

export interface WalletEntry { readonly hash: string; readonly verified: VerifiedCredential }

export interface WalletView {
  readonly cache: CredentialCache;
  /** The credentials that checked, now. */
  readonly entries: readonly WalletEntry[];
  readonly facts: CredentialFacts;
  readonly clearances: readonly Clearance[];
}

export type ImportResult = { readonly ok: true; readonly hash: string } | { readonly ok: false; readonly sentence: string };

type CheckOutcome =
  | { readonly kind: 'ok'; readonly entry: WalletEntry; readonly fetchedAt: number }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'refused'; readonly sentence: string };

/** The state the view is in at `now`: fresh turns stale once the oldest list used is past the time to live. */
export function walletStateAt(view: WalletView, now: number): CredentialCacheState {
  return cacheStateAt(view.cache, { kind: 'tick', now }).state;
}

/** The sentence and action shown for a view at `now`. */
export function walletStateText(view: WalletView, now: number): { readonly text: string; readonly action?: 'retry' | 'connect' } {
  return CACHE_STATE_TEXT[walletStateAt(view, now)];
}

export class Wallet {
  private view: WalletView;
  private readonly listeners = new Set<(view: WalletView) => void>();

  public constructor(private readonly secrets: SecretStorageLike, private readonly trust: TrustSource, private readonly now: () => number, private readonly holder: string) {
    this.view = this.emptyView(initialCache(this.ttlMs()));
  }

  /** The last verified view, from memory: a decision never waits on I/O for it. */
  public verifiedView(): WalletView {
    return this.view;
  }

  public onDidChange(listener: (view: WalletView) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** Reads the stored credentials and checks every one now. A store that cannot be read gives an unavailable view. */
  public async load(): Promise<WalletView> {
    let stored: unknown[];
    try {
      stored = await this.readStored();
    } catch {
      // The secret store could not be read: nothing is relied on until it can.
      return this.publish(this.emptyView(cacheStateAt(this.view.cache, { kind: 'missing' })));
    }
    const policy = this.trust.policy();
    if (policy === undefined) return this.publish(this.emptyView(cacheStateAt(initialCache(this.ttlMs()), { kind: 'missing' })));
    const entries: WalletEntry[] = [];
    let oldest = Number.POSITIVE_INFINITY;
    let missing = false;
    for (const blob of stored) {
      const outcome = this.check(blob, policy);
      if (outcome.kind === 'ok') {
        entries.push(outcome.entry);
        oldest = Math.min(oldest, outcome.fetchedAt);
      } else if (outcome.kind === 'unavailable') {
        missing = true;
      }
    }
    const base = initialCache(policy.section.statusTtl * 1000);
    const cache = missing ? cacheStateAt(base, { kind: 'missing' }) : cacheStateAt(base, { kind: 'refreshed', at: Number.isFinite(oldest) ? oldest : this.now() });
    const facts = factsFrom(entries.map((entry) => ({ credential: entry.verified, status: 'clear' as const })));
    return this.publish(Object.freeze({ cache, entries: Object.freeze(entries), facts, clearances: clearanceFromCredentials(facts, policy.scales) }));
  }

  /** Adds a .near-vc file's credential after it checks now; on any refusal nothing is stored and one sentence says why. */
  public async importFile(text: string): Promise<ImportResult> {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return { ok: false, sentence: WALLET_NOT_A_CREDENTIAL_TEXT };
    let blob: unknown;
    try {
      blob = JSON.parse(text);
    } catch {
      return { ok: false, sentence: WALLET_NOT_A_CREDENTIAL_TEXT };
    }
    const policy = this.trust.policy();
    if (policy === undefined) return { ok: false, sentence: WALLET_CANNOT_CHECK_TEXT };
    const outcome = this.check(blob, policy);
    if (outcome.kind === 'unavailable') return { ok: false, sentence: WALLET_CANNOT_CHECK_TEXT };
    if (outcome.kind === 'refused') return { ok: false, sentence: outcome.sentence };
    let stored: unknown[];
    try {
      stored = await this.readStored();
      if (!stored.some((existing) => credentialHash(existing) === outcome.entry.hash)) {
        if (stored.length >= MAX_ENTRIES) return { ok: false, sentence: WALLET_NOT_SAVED_TEXT };
        await this.secrets.store(WALLET_SECRET_KEY, JSON.stringify([...stored, blob]));
      }
    } catch {
      return { ok: false, sentence: WALLET_NOT_SAVED_TEXT };
    }
    await this.load();
    return { ok: true, hash: outcome.entry.hash };
  }

  private ttlMs(): number {
    return (this.trust.policy()?.section.statusTtl ?? 900) * 1000;
  }

  private emptyView(cache: CredentialCache): WalletView {
    const facts = factsFrom([]);
    return Object.freeze({ cache, entries: Object.freeze([]), facts, clearances: Object.freeze([]) });
  }

  private publish(view: WalletView): WalletView {
    this.view = view;
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch {
        // A listener's failure never stops the wallet or the other listeners.
      }
    }
    return view;
  }

  private async readStored(): Promise<unknown[]> {
    const text = await this.secrets.get(WALLET_SECRET_KEY);
    if (text === undefined || text === '') return [];
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error('The stored credentials are not a list.');
    return value.slice(0, MAX_ENTRIES);
  }

  /** One credential checked now with the fold's checker, citing it, its issuer's roles and the lists held now. */
  private check(blob: unknown, policy: IssuerPolicy): CheckOutcome {
    let hash: string;
    try {
      hash = credentialHash(blob);
    } catch {
      return { kind: 'refused', sentence: WALLET_NOT_A_CREDENTIAL_TEXT };
    }
    const read = readCredential(blob, policy.scales, { signed: true });
    if (!read.ok) return { kind: 'refused', sentence: WALLET_NOT_A_CREDENTIAL_TEXT };
    if (read.value.claims.id !== this.holder) return { kind: 'refused', sentence: WALLET_NOT_YOURS_TEXT };
    const roleBlobs = this.trust.roles(read.value.issuer);
    const credentials: Record<string, unknown> = { [hash]: blob };
    const evidence = [hash];
    const listIds = new Set(read.value.status.map((entry) => entry.statusListCredential));
    const dids = new Set([read.value.issuer, this.holder, policy.section.root.did]);
    for (const role of roleBlobs) {
      const roleRead = readCredential(role, policy.scales, { signed: true });
      if (!roleRead.ok) continue;
      const roleHash = credentialHash(role);
      credentials[roleHash] = role;
      evidence.push(roleHash);
      for (const entry of roleRead.value.status) listIds.add(entry.statusListCredential);
      dids.add(roleRead.value.issuer);
    }
    const lists: Record<string, unknown> = {};
    const status: Array<EvidenceCitation['status'][number]> = [];
    let oldest = Number.POSITIVE_INFINITY;
    for (const id of listIds) {
      const held = this.trust.list(id);
      if (held === undefined) return { kind: 'unavailable' };
      const listRead = readCredential(held.credential, {}, { signed: true });
      if (!listRead.ok) return { kind: 'unavailable' };
      const heldHash = listHash(held.credential);
      lists[heldHash] = held.credential;
      status.push({ list: id, hash: heldHash, validFrom: listRead.value.validFrom });
      oldest = Math.min(oldest, held.fetchedAt);
    }
    const states: Record<string, WebvhState> = {};
    for (const did of dids) {
      const state = this.trust.didState(did);
      if (state !== undefined) states[did] = state;
    }
    const result = checkEvidence({ evidence, status }, {
      credentials, lists, policy, didState: { states, deviceBindings: this.trust.deviceBindings?.() ?? [] }, member: this.holder, signedAt: this.now()
    });
    if (result.ok) {
      const verified = result.credentials.find((credential) => credentialHash(credential.credential) === hash);
      if (verified === undefined) return { kind: 'refused', sentence: WALLET_DOES_NOT_VERIFY_TEXT };
      return { kind: 'ok', entry: Object.freeze({ hash, verified }), fetchedAt: oldest };
    }
    switch (result.reason) {
      case 'list-missing': case 'list-out-of-date': case 'issuer-key': return { kind: 'unavailable' };
      case 'credential-expired': case 'revoked': case 'suspended': return { kind: 'refused', sentence: WALLET_ENDED_TEXT };
      default: return { kind: 'refused', sentence: WALLET_DOES_NOT_VERIFY_TEXT };
    }
  }
}
