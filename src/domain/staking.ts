export type StakingOperation = 'stake' | 'unstake' | 'withdraw';
export type Freshness = 'fresh' | 'stale' | 'unavailable';
export type WalletTransactionStatus = 'submitted' | 'pending' | 'confirmed' | 'failed' | 'cancelled';

export interface OperationTransactionSpec {
  method: string;
  gasYocto: string;
  attachedDepositYocto: string;
  expectedFeeYocto: string;
  buildArguments: (input: { signerId: string; amountYocto: string }) => Record<string, unknown>;
}

/**
 * This is an injected release configuration, never webview input. The project
 * intentionally ships no concrete NEAR AI staking values until NEAR publishes
 * an extension-facing contract that can be verified independently.
 */
export interface VerifiedStakingConfig {
  version: 1;
  networkId: string;
  rpcEndpoint: string;
  validatorAccount: string;
  entitlementEndpoint: string;
  configurationDigest: string;
  source: 'official-release' | 'verified-injected';
  expiresAt: string;
  operations: Partial<Record<StakingOperation, OperationTransactionSpec>>;
}

export interface WalletSession {
  version: 1;
  accountId: string;
  networkId: string;
  authorizedAt: string;
  expiresAt: string;
}

export interface BalanceSnapshot {
  liquidYocto: string;
  stakedYocto: string;
  unstakedYocto: string;
}

export interface CreditSnapshot {
  balance?: string;
  rate?: string;
  source: string;
}

export interface EntitlementStatus {
  version: 1;
  freshness: Freshness;
  accountId?: string;
  networkId?: string;
  validatorAccount?: string;
  balances?: BalanceSnapshot;
  credit?: CreditSnapshot;
  lastRefreshAt?: string;
  source?: string;
  message: string;
  writesEnabled: boolean;
}

export interface TransactionPreview {
  version: 1;
  previewId: string;
  fingerprint: string;
  operation: StakingOperation;
  signer: string;
  receiver: string;
  method: string;
  serializedArguments: string;
  amountYocto: string;
  gasYocto: string;
  attachedDepositYocto: string;
  expectedFeeYocto: string;
  networkId: string;
  validatorAccount: string;
  configurationDigest: string;
  expiresAt: string;
  approvalPreviewId: string;
  approvalState: 'pending' | 'approved' | 'denied' | 'expired';
}

export interface WalletTransactionOutcome {
  status: WalletTransactionStatus;
  accountId: string;
  networkId: string;
  validatorAccount: string;
  operation: StakingOperation;
  amountYocto: string;
  transactionId?: string;
  timestamp: string;
  outcome?: string;
}

export interface StakeHistoryEntry {
  version: 1;
  accountId: string;
  networkId: string;
  validatorAccount: string;
  operation: StakingOperation | 'credit' | 'balance';
  amountYocto?: string;
  transactionId?: string;
  timestamp: string;
  status: WalletTransactionStatus | 'observed' | 'unavailable';
  outcome: string;
}

export interface EntitlementStatusView extends EntitlementStatus {
  accountLabel: string;
}

export interface TransactionPreviewView extends TransactionPreview {
  confirmationRequired: true;
}

export function validateVerifiedStakingConfig(value: VerifiedStakingConfig | undefined, now = Date.now()): { valid: true; config: VerifiedStakingConfig } | { valid: false; reason: string } {
  if (!value || value.version !== 1) return { valid: false, reason: 'Verified staking configuration is unavailable.' };
  if (value.source !== 'official-release' && value.source !== 'verified-injected') return { valid: false, reason: 'Verified staking configuration provenance is not trusted.' };
  if (!safeNetworkLabel(value.networkId, 80) || !safeAccount(value.validatorAccount)) return { valid: false, reason: 'Verified network or validator configuration is unavailable.' };
  if (!safeEndpoint(value.rpcEndpoint) || !safeEndpoint(value.entitlementEndpoint)) return { valid: false, reason: 'Verified staking read endpoints are unavailable.' };
  if (!/^[a-f0-9]{32,128}$/i.test(value.configurationDigest)) return { valid: false, reason: 'Verified staking configuration digest is unavailable.' };
  if (!validFutureExpiry(value.expiresAt, now)) return { valid: false, reason: 'Verified staking configuration is expired.' };
  for (const operation of ['stake', 'unstake', 'withdraw'] as const) {
    const spec = value.operations[operation];
    if (!spec || !safeMethod(spec.method) || !validYocto(spec.gasYocto) || !validYocto(spec.attachedDepositYocto) || !validYocto(spec.expectedFeeYocto) || typeof spec.buildArguments !== 'function') {
      return { valid: false, reason: `Verified ${operation} method configuration is unavailable.` };
    }
  }
  return { valid: true, config: value };
}

export function safeAccount(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

export function validYocto(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,47})$/.test(value);
}

export function safeNetworkLabel(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9._:-]+$/.test(value);
}

export function toEntitlementStatusView(status: EntitlementStatus): EntitlementStatusView {
  return { ...clone(status), accountLabel: status.accountId ?? 'External wallet not connected' };
}

export function toTransactionPreviewView(preview: TransactionPreview): TransactionPreviewView {
  return { ...clone(preview), confirmationRequired: true };
}

function safeEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 300 || /(?:api[_ -]?key|token|secret|password|private prompt|raw context)/i.test(value)) return false;
  try { const parsed = new URL(value); return parsed.protocol === 'https:'; } catch { return false; }
}

function safeMethod(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-zA-Z0-9._-]{0,79}$/.test(value);
}

function validFutureExpiry(value: unknown, now: number): value is string {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > now;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
