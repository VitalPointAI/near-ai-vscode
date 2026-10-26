import { createHash } from 'node:crypto';
import type { ApprovalRequest, AuditEvent } from '../domain/approval';
import {
  type BalanceSnapshot,
  type CreditSnapshot,
  type EntitlementStatus,
  type OperationTransactionSpec,
  type StakeHistoryEntry,
  type StakingOperation,
  type TransactionPreview,
  type VerifiedStakingConfig,
  type WalletSession,
  type WalletTransactionOutcome,
  safeAccount,
  safeNetworkLabel,
  toEntitlementStatusView,
  toTransactionPreviewView,
  validYocto,
  validateVerifiedStakingConfig
} from '../domain/staking';
import { UnavailableWalletAuthorization, type WalletAuthorizationPort } from './walletAuthorization';

export interface NativeBalanceResponse { accountId: string; networkId: string; liquidYocto: string; }
export interface PoolBalanceResponse { accountId: string; networkId: string; validatorAccount: string; stakedYocto: string; unstakedYocto: string; }
export interface EntitlementReadResponse { accountId: string; networkId: string; validatorAccount: string; creditBalanceYocto?: string; creditRate?: string; source: string; }

export interface ReadOnlyStakingRpc {
  readNativeBalance(input: { accountId: string; networkId: string }): Promise<NativeBalanceResponse>;
  readPoolBalance(input: { accountId: string; networkId: string; validatorAccount: string }): Promise<PoolBalanceResponse>;
  readTransactionStatus?(input: { transactionId: string; accountId: string; networkId: string }): Promise<WalletTransactionOutcome>;
}
export interface EntitlementReader { read(input: { accountId: string; networkId: string; validatorAccount: string }): Promise<EntitlementReadResponse>; }
export interface StakingApprovalPort { preview(request: ApprovalRequest): Promise<{ previewId: string }>; dispatch(previewId: string): Promise<{ allowed: boolean; reason: string }>; }
export interface StakingAuditPort { append(event: AuditEvent): Promise<void> | void; list?(filter?: { type?: AuditEvent['type'] }): Promise<AuditEvent[]>; }
export interface StakingServiceOptions {
  config?: VerifiedStakingConfig;
  configProvider?: () => VerifiedStakingConfig | undefined;
  wallet: WalletAuthorizationPort;
  rpc: ReadOnlyStakingRpc;
  entitlement: EntitlementReader;
  approval?: StakingApprovalPort;
  audit?: StakingAuditPort;
  now?: () => number;
  freshnessTtlMs?: number;
  emergencyStop?: () => boolean;
}
export interface ConfirmationInput { fingerprint: string; explicit: true; }
export class StakingUnavailableError extends Error {}
export class StakingDeniedError extends Error {}

const MAX_HISTORY = 100;
const WALLET_PROJECT = 'wallet-staking';

export class StakingService {
  private readonly now: () => number;
  private readonly freshnessTtlMs: number;
  private readonly config?: VerifiedStakingConfig;
  private readonly configProvider?: () => VerifiedStakingConfig | undefined;
  private readonly previews = new Map<string, TransactionPreview>();
  private readonly sessions = new Map<string, WalletSession>();
  private readonly historyEntries: StakeHistoryEntry[] = [];
  private lastVerified?: EntitlementStatus;

  public constructor(private readonly options: StakingServiceOptions) {
    this.now = options.now ?? Date.now;
    this.freshnessTtlMs = Math.max(1_000, Math.min(options.freshnessTtlMs ?? 5 * 60_000, 60 * 60_000));
    this.config = options.config;
    this.configProvider = options.configProvider;
  }

  public static unavailable(options: Omit<StakingServiceOptions, 'config' | 'configProvider' | 'wallet' | 'rpc' | 'entitlement'> & Partial<Pick<StakingServiceOptions, 'audit' | 'now'>> = {}): StakingService {
    return new StakingService({ ...options, wallet: new UnavailableWalletAuthorization(), rpc: unavailableRpc, entitlement: unavailableEntitlement });
  }

  public getStatus(): ReturnType<typeof toEntitlementStatusView> {
    const config = this.verifiedConfig();
    if (!config.valid) return toEntitlementStatusView(this.unavailableStatus(config.reason));
    if (!this.lastVerified) return toEntitlementStatusView(this.unavailableStatus('Connect an external wallet to view verified NEAR AI entitlement status.'));
    const lastRefresh = Date.parse(this.lastVerified.lastRefreshAt ?? '');
    if (!Number.isFinite(lastRefresh) || this.now() - lastRefresh > this.freshnessTtlMs) return toEntitlementStatusView({ ...clone(this.lastVerified), freshness: 'stale', writesEnabled: false, message: 'The last verified wallet status is stale. Refresh before taking any action.' });
    return toEntitlementStatusView(clone(this.lastVerified));
  }

  public async connectWallet(): Promise<WalletSession> {
    const config = this.requireConfig();
    const session = await this.options.wallet.connect();
    if (!safeAccount(session.accountId) || session.networkId !== config.networkId || Date.parse(session.expiresAt) <= this.now()) throw new StakingUnavailableError('The external wallet returned an unverified account or network.');
    this.sessions.set(session.accountId, clone(session));
    return clone(session);
  }

  public async disconnectWallet(): Promise<void> {
    for (const session of this.sessions.values()) await this.options.wallet.disconnect(session);
    this.sessions.clear();
    this.lastVerified = undefined;
  }

  public async refreshStatus(accountId?: string): Promise<ReturnType<typeof toEntitlementStatusView>> {
    const config = this.verifiedConfig();
    if (!config.valid) return toEntitlementStatusView(this.unavailableStatus(config.reason));
    const session = this.session(accountId);
    if (!session) return toEntitlementStatusView(this.unavailableStatus('Connect an external wallet before refreshing entitlement status.'));
    if (session.networkId !== config.config.networkId || Date.parse(session.expiresAt) <= this.now()) return toEntitlementStatusView(this.staleOrUnavailable('The wallet session is expired or on the wrong network.'));
    try {
      const [native, pool, entitlement] = await Promise.all([
        this.options.rpc.readNativeBalance({ accountId: session.accountId, networkId: config.config.networkId }),
        this.options.rpc.readPoolBalance({ accountId: session.accountId, networkId: config.config.networkId, validatorAccount: config.config.validatorAccount }),
        this.options.entitlement.read({ accountId: session.accountId, networkId: config.config.networkId, validatorAccount: config.config.validatorAccount })
      ]);
      assertIdentity(native.accountId, native.networkId, session.accountId, config.config.networkId);
      assertIdentity(pool.accountId, pool.networkId, session.accountId, config.config.networkId);
      assertIdentity(pool.validatorAccount, config.config.networkId, config.config.validatorAccount, config.config.networkId);
      assertIdentity(entitlement.accountId, entitlement.networkId, session.accountId, config.config.networkId);
      assertIdentity(entitlement.validatorAccount, config.config.networkId, config.config.validatorAccount, config.config.networkId);
      const balances: BalanceSnapshot = { liquidYocto: requireYocto(native.liquidYocto, 'liquid balance'), stakedYocto: requireYocto(pool.stakedYocto, 'staked balance'), unstakedYocto: requireYocto(pool.unstakedYocto, 'unstaked balance') };
      const credit: CreditSnapshot = { balance: optionalYocto(entitlement.creditBalanceYocto), rate: safeRate(entitlement.creditRate), source: safeSource(entitlement.source) };
      const status: EntitlementStatus = { version: 1, freshness: 'fresh', accountId: session.accountId, networkId: config.config.networkId, validatorAccount: config.config.validatorAccount, balances, credit, lastRefreshAt: new Date(this.now()).toISOString(), source: safeSource(entitlement.source), message: 'Verified read-only wallet and entitlement status.', writesEnabled: true };
      this.lastVerified = clone(status);
      await this.appendHistory({ version: 1, accountId: session.accountId, networkId: config.config.networkId, validatorAccount: config.config.validatorAccount, operation: 'balance', timestamp: status.lastRefreshAt as string, status: 'observed', outcome: 'Verified balance and entitlement refresh.' });
      return toEntitlementStatusView(status);
    } catch (error) {
      return toEntitlementStatusView(this.staleOrUnavailable(error instanceof Error ? error.message : 'Verified entitlement refresh failed.'));
    }
  }

  public async createPreview(operation: StakingOperation, amountYocto: string, accountId?: string): Promise<ReturnType<typeof toTransactionPreviewView>> {
    const config = this.requireConfig();
    if (!validYocto(amountYocto) || amountYocto === '0') throw new StakingDeniedError('A positive exact yoctoNEAR amount is required.');
    const session = this.session(accountId);
    if (!session || session.networkId !== config.networkId || Date.parse(session.expiresAt) <= this.now()) throw new StakingDeniedError('A current external wallet session on the verified network is required.');
    const spec = config.operations[operation];
    if (!spec) throw new StakingUnavailableError(`Verified ${operation} method configuration is unavailable.`);
    const transaction = this.buildTransaction(config, spec, session, amountYocto);
    const canonical = stableStringify({ operation, signer: session.accountId, receiver: config.validatorAccount, networkId: config.networkId, validatorAccount: config.validatorAccount, configurationDigest: config.configurationDigest, amountYocto, ...transaction });
    const fingerprint = createHash('sha256').update(canonical).digest('hex');
    const previewId = `stake-preview-${fingerprint.slice(0, 16)}`;
    if (!this.options.approval) throw new StakingDeniedError('Fresh wallet approval is unavailable; staking writes remain disabled.');
    const approval = await this.options.approval.preview({ requestId: previewId, sessionId: `wallet-${session.accountId}`, projectId: WALLET_PROJECT, capability: 'network', action: `near-wallet-${operation}`, targetScope: `${config.networkId}:${config.validatorAccount}:fingerprint-${fingerprint}`, provider: 'external-wallet', providerBoundary: 'unknown', estimated: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, currency: 'USD' }, reversible: operation !== 'stake' });
    const preview: TransactionPreview = { version: 1, previewId, fingerprint, operation, signer: session.accountId, receiver: config.validatorAccount, method: transaction.method, serializedArguments: JSON.stringify(transaction.arguments), amountYocto, gasYocto: transaction.gasYocto, attachedDepositYocto: transaction.attachedDepositYocto, expectedFeeYocto: transaction.expectedFeeYocto, networkId: config.networkId, validatorAccount: config.validatorAccount, configurationDigest: config.configurationDigest, expiresAt: new Date(Math.min(Date.parse(config.expiresAt), this.now() + 5 * 60_000)).toISOString(), approvalPreviewId: approval.previewId, approvalState: 'pending' };
    this.previews.set(previewId, clone(preview));
    return toTransactionPreviewView(preview);
  }

  public async confirmPreview(previewId: string, confirmation: ConfirmationInput): Promise<WalletTransactionOutcome> {
    const preview = this.previews.get(previewId);
    if (!preview || confirmation.explicit !== true || confirmation.fingerprint !== preview.fingerprint) throw new StakingDeniedError('Exact preview confirmation is required; no wallet call was made.');
    if (Date.parse(preview.expiresAt) <= this.now()) throw new StakingDeniedError('The transaction preview is expired; no wallet call was made.');
    const config = this.requireConfig();
    if (config.configurationDigest !== preview.configurationDigest || config.validatorAccount !== preview.validatorAccount || config.networkId !== preview.networkId || this.options.emergencyStop?.()) throw new StakingDeniedError('Verified staking configuration changed or emergency stop is active; no wallet call was made.');
    const session = this.session(preview.signer);
    if (!session || session.networkId !== preview.networkId || Date.parse(session.expiresAt) <= this.now()) throw new StakingDeniedError('The wallet session is stale; no wallet call was made.');
    if (!this.options.approval) throw new StakingDeniedError('Fresh wallet approval is unavailable; no wallet call was made.');
    const approval = await this.options.approval.dispatch(preview.approvalPreviewId);
    if (!approval.allowed) throw new StakingDeniedError(`${approval.reason} No wallet call was made.`);
    try {
      const result = await this.options.wallet.signAndSend(clone(preview), clone(session));
      if (result.accountId !== preview.signer || result.networkId !== preview.networkId || result.validatorAccount !== preview.validatorAccount || result.operation !== preview.operation || result.amountYocto !== preview.amountYocto) throw new StakingDeniedError('Wallet returned a mismatched transaction outcome.');
      await this.appendHistory({ version: 1, accountId: result.accountId, networkId: result.networkId, validatorAccount: result.validatorAccount, operation: result.operation, amountYocto: result.amountYocto, transactionId: result.transactionId, timestamp: result.timestamp, status: result.status, outcome: result.outcome ?? 'External wallet returned an outcome.' });
      this.previews.delete(previewId);
      return clone(result);
    } catch (error) {
      if (error instanceof StakingDeniedError) throw error;
      throw new StakingDeniedError('The external wallet did not complete the transaction. No retry was attempted.');
    }
  }

  public async cancelPreview(previewId: string): Promise<void> {
    const preview = this.previews.get(previewId);
    if (!preview) return;
    this.previews.delete(previewId);
    await this.appendHistory({ version: 1, accountId: preview.signer, networkId: preview.networkId, validatorAccount: preview.validatorAccount, operation: preview.operation, amountYocto: preview.amountYocto, timestamp: new Date(this.now()).toISOString(), status: 'cancelled', outcome: 'User cancelled the exact transaction preview.' });
  }

  public async transactionStatus(transactionId: string, accountId?: string): Promise<WalletTransactionOutcome | undefined> {
    const config = this.verifiedConfig();
    const session = this.session(accountId);
    if (!config.valid || !session || !this.options.rpc.readTransactionStatus || !/^[A-Za-z0-9._:-]{1,160}$/.test(transactionId)) return undefined;
    const result = await this.options.rpc.readTransactionStatus({ transactionId, accountId: session.accountId, networkId: config.config.networkId });
    if (result.accountId !== session.accountId || result.networkId !== config.config.networkId || result.validatorAccount !== config.config.validatorAccount) throw new StakingDeniedError('Transaction status response did not match the verified wallet scope.');
    return clone(result);
  }

  public async history(accountId?: string, networkId?: string): Promise<StakeHistoryEntry[]> {
    const persisted = this.options.audit?.list ? await this.options.audit.list({ type: 'near-wallet' }) : [];
    const combined = [...this.historyEntries, ...persisted.map((event) => event.wallet).filter((entry): entry is StakeHistoryEntry => Boolean(entry))];
    const seen = new Set<string>();
    return combined.filter((entry) => (!accountId || entry.accountId === accountId) && (!networkId || entry.networkId === networkId)).filter((entry) => { const key = `${entry.timestamp}:${entry.operation}:${entry.transactionId ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(-MAX_HISTORY).map(clone);
  }

  private verifiedConfig(): { valid: true; config: VerifiedStakingConfig } | { valid: false; reason: string } { return validateVerifiedStakingConfig(this.configProvider?.() ?? this.config, this.now()); }
  private requireConfig(): VerifiedStakingConfig { const result = this.verifiedConfig(); if (!result.valid) throw new StakingUnavailableError(`${result.reason} Stake-changing actions are disabled.`); return result.config; }
  private session(accountId?: string): WalletSession | undefined { if (accountId) return this.sessions.get(accountId); return this.sessions.values().next().value as WalletSession | undefined; }

  private buildTransaction(config: VerifiedStakingConfig, spec: OperationTransactionSpec, session: WalletSession, amountYocto: string): { method: string; arguments: Record<string, unknown>; gasYocto: string; attachedDepositYocto: string; expectedFeeYocto: string } {
    let args: Record<string, unknown>;
    try { args = spec.buildArguments({ signerId: session.accountId, amountYocto }); } catch { throw new StakingUnavailableError('Verified transaction argument construction failed; no write is available.'); }
    if (!args || Array.isArray(args) || containsSensitive(JSON.stringify(args))) throw new StakingUnavailableError('Verified transaction arguments are unsafe; no write is available.');
    if (config.validatorAccount.length === 0) throw new StakingUnavailableError('Verified transaction scope is unavailable.');
    return { method: spec.method, arguments: args, gasYocto: spec.gasYocto, attachedDepositYocto: spec.attachedDepositYocto, expectedFeeYocto: spec.expectedFeeYocto };
  }
  private unavailableStatus(message: string): EntitlementStatus { return { version: 1, freshness: 'unavailable', message, writesEnabled: false }; }
  private staleOrUnavailable(message: string): EntitlementStatus { if (!this.lastVerified) return this.unavailableStatus(`Verified entitlement status unavailable: ${safeMessage(message)}`); return { ...clone(this.lastVerified), freshness: 'stale', writesEnabled: false, message: `Showing the last verified status. Refresh failed: ${safeMessage(message)}` }; }
  private async appendHistory(entry: StakeHistoryEntry): Promise<void> {
    this.historyEntries.push(clone(entry));
    this.historyEntries.splice(0, Math.max(0, this.historyEntries.length - MAX_HISTORY));
    try { await this.options.audit?.append({ version: 1, id: `wallet-${createHash('sha256').update(`${entry.timestamp}:${entry.operation}:${entry.accountId}`).digest('hex').slice(0, 16)}`, timestamp: entry.timestamp, type: 'near-wallet', wallet: clone(entry), outcome: safeMessage(entry.outcome) }); } catch { /* Outcome is never retried because audit persistence failed. */ }
  }
}

const unavailableRpc: ReadOnlyStakingRpc = { async readNativeBalance(): Promise<NativeBalanceResponse> { throw new Error('Verified read-only RPC is unavailable.'); }, async readPoolBalance(): Promise<PoolBalanceResponse> { throw new Error('Verified staking-pool RPC is unavailable.'); } };
const unavailableEntitlement: EntitlementReader = { async read(): Promise<EntitlementReadResponse> { throw new Error('Verified entitlement endpoint is unavailable.'); } };

function assertIdentity(actualLeft: string, actualRight: string, expectedLeft: string, expectedRight: string): void { if (actualLeft !== expectedLeft || actualRight !== expectedRight) throw new Error('Read-only response did not match the verified wallet scope.'); }
function requireYocto(value: unknown, label: string): string { if (!validYocto(value)) throw new Error(`Invalid ${label}; status is unavailable.`); return value; }
function optionalYocto(value: unknown): string | undefined { return value === undefined ? undefined : validYocto(value) ? value : undefined; }
function safeRate(value: unknown): string | undefined { return typeof value === 'string' && value.length <= 80 && /^[A-Za-z0-9._: /-]+$/.test(value) ? value : undefined; }
function safeSource(value: unknown): string { return typeof value === 'string' && value.length > 0 && value.length <= 120 && !containsSensitive(value) ? value : 'verified read-only source'; }
function safeMessage(value: string): string { return value.replace(/(?:api[_ -]?key|refresh[-_ ]?token|bearer|seed phrase|private key|password)\s*[:=]?\s*[^\s,;]*/gi, '[REDACTED]').replace(/[\u0000-\u001f]+/g, ' ').slice(0, 240); }
function containsSensitive(value: string): boolean { return /(?:api[_ -]?key|refresh[-_ ]?token|bearer\s|seed phrase|private key|access key|project profile|private prompt|raw context|command\s*[:=]|\.near-credentials)/i.test(value); }
function stableStringify(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`; return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
