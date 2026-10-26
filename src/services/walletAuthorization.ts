import { randomUUID } from 'node:crypto';
import type { TransactionPreview, WalletSession, WalletTransactionOutcome } from '../domain/staking';
import { safeAccount, safeNetworkLabel, validYocto } from '../domain/staking';

export interface WalletAuthorizationCallback {
  state: string;
  accountId: string;
  networkId: string;
  authorizedAt: string;
  expiresAt: string;
}

export interface ExternalWalletAdapter {
  authorize(request: { state: string; expiresAt: string }): Promise<WalletAuthorizationCallback>;
  disconnect(session: WalletSession): Promise<void>;
  signAndSend(request: { preview: TransactionPreview; session: WalletSession }): Promise<WalletTransactionOutcome>;
}

export interface WalletAuthorizationPort {
  connect(): Promise<WalletSession>;
  disconnect(session: WalletSession): Promise<void>;
  signAndSend(preview: TransactionPreview, session: WalletSession): Promise<WalletTransactionOutcome>;
}

export class WalletAuthorizationError extends Error {}

/** External-wallet-only bridge. It has no filesystem or key-management API. */
export class ExternalWalletAuthorizationBridge implements WalletAuthorizationPort {
  private readonly pending = new Map<string, number>();
  private readonly ttlMs: number;

  public constructor(private readonly adapter: ExternalWalletAdapter, private readonly now: () => number = Date.now, ttlMs = 5 * 60_000) {
    this.ttlMs = Math.max(1_000, Math.min(ttlMs, 15 * 60_000));
  }

  public async connect(): Promise<WalletSession> {
    const state = `wallet-state-${randomUUID().replaceAll('-', '')}`;
    const expiresAt = new Date(this.now() + this.ttlMs).toISOString();
    this.pending.set(state, this.now() + this.ttlMs);
    try {
      const callback = await this.adapter.authorize({ state, expiresAt });
      return this.completeAuthorization(callback);
    } finally {
      this.pending.delete(state);
    }
  }

  public completeAuthorization(callback: WalletAuthorizationCallback): WalletSession {
    const expires = this.pending.get(callback.state);
    if (expires === undefined || expires <= this.now()) throw new WalletAuthorizationError('Wallet authorization callback is expired or unknown.');
    if (!safeAccount(callback.accountId) || !safeNetworkLabel(callback.networkId, 80) || Date.parse(callback.expiresAt) <= this.now()) {
      throw new WalletAuthorizationError('Wallet authorization callback is invalid.');
    }
    this.pending.delete(callback.state);
    return { version: 1, accountId: callback.accountId, networkId: callback.networkId, authorizedAt: new Date(this.now()).toISOString(), expiresAt: callback.expiresAt };
  }

  public async disconnect(session: WalletSession): Promise<void> {
    await this.adapter.disconnect(clone(session));
  }

  public async signAndSend(preview: TransactionPreview, session: WalletSession): Promise<WalletTransactionOutcome> {
    if (!safeAccount(session.accountId) || !safeNetworkLabel(session.networkId, 80)) throw new WalletAuthorizationError('Wallet session is invalid.');
    if (!isSafePreview(preview, session)) throw new WalletAuthorizationError('Wallet transaction preview is invalid.');
    const result = await this.adapter.signAndSend({ preview: clone(preview), session: clone(session) });
    if (!result || result.accountId !== session.accountId || result.networkId !== session.networkId) throw new WalletAuthorizationError('Wallet returned a mismatched transaction outcome.');
    return clone(result);
  }
}

function isSafePreview(preview: TransactionPreview, session: WalletSession): boolean {
  return preview.version === 1 && preview.signer === session.accountId && preview.networkId === session.networkId && safeAccount(preview.receiver) && safeAccount(preview.signer) && /^(?:stake|unstake|withdraw)$/.test(preview.operation) && /^[a-f0-9]{64}$/.test(preview.fingerprint) && /^stake-preview-[a-f0-9]{16}$/.test(preview.previewId) && validYocto(preview.amountYocto) && validYocto(preview.gasYocto) && validYocto(preview.attachedDepositYocto) && validYocto(preview.expectedFeeYocto) && /^[a-f0-9]{32,128}$/i.test(preview.configurationDigest) && preview.serializedArguments.length <= 4000 && !/(?:api[_ -]?key|refresh[-_ ]?token|bearer\s|seed phrase|private key|access key|project profile|private prompt|raw context|\.near-credentials)/i.test(preview.serializedArguments);
}

/** Default until an official, verified wallet contract is supplied. */
export class UnavailableWalletAuthorization implements WalletAuthorizationPort {
  public async connect(): Promise<WalletSession> { throw new WalletAuthorizationError('External wallet authorization is unavailable.'); }
  public async disconnect(_session: WalletSession): Promise<void> { return; }
  public async signAndSend(_preview: TransactionPreview, _session: WalletSession): Promise<WalletTransactionOutcome> { throw new WalletAuthorizationError('External wallet signing is disabled.'); }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
