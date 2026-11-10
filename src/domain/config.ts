import { ActionPolicy, ActionPolicyMode, defaultActionPolicy } from './policy';
import { SovereigntyMode } from './privacy';

export type AuthMode = 'apiKey' | 'nearAccount';


export interface NearAiSettings {
  baseUrl: string;
  authMode: AuthMode;
  defaultModel: string;
  actionPolicy: ActionPolicy;
  privacyMode: Extract<SovereigntyMode, 'standard' | 'tee-only'>;
  /** 0 means no limit. */
  dailySpendLimitUsd: number;
}

export const DEFAULT_BASE_URL = 'https://cloud-api.near.ai/v1';
export const DEFAULT_MODEL = 'z-ai/glm-5.3';

/**
 * Whether a base URL is NEAR AI Cloud's own endpoint, where a TEE model's attestation can be checked: https on NEAR's API host, default
 * port, with no path or /v1 (trailing slashes ignored), and no credentials, query, or fragment. An empty value is the default endpoint.
 */
export function isNearCloudEndpoint(baseUrl: string | undefined): boolean {
  const raw = (baseUrl ?? '').trim() || DEFAULT_BASE_URL;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  const near = new URL(DEFAULT_BASE_URL);
  const pathname = url.pathname.replace(/\/+$/, '');
  return url.protocol === 'https:' && url.hostname.toLowerCase() === near.hostname && (url.port === '' || url.port === '443') && !url.username && !url.password && !url.search && !url.hash && (pathname === '' || pathname === '/v1');
}

export function createDefaultSettings(): NearAiSettings {
  return {
    baseUrl: DEFAULT_BASE_URL,
    authMode: 'apiKey',
    defaultModel: DEFAULT_MODEL,
    actionPolicy: defaultActionPolicy(),
    privacyMode: 'standard',
    dailySpendLimitUsd: 0
  };
}

export function normalizePolicyMode(value: unknown): ActionPolicyMode {
  if (value === 'mostly-autonomous' || value === 'auto' || value === 'fully-autonomous') return value;
  return 'approve-risky';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Credentials only travel over HTTPS; plain HTTP is accepted solely for a runtime on this machine. */
export function isSecureEndpoint(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname));
  } catch {
    return false;
  }
}
