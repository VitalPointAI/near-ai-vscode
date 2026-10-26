import { ActionPolicy, ActionPolicyMode, defaultActionPolicy } from './policy';

export type AuthMode = 'apiKey' | 'nearAccount';

export interface NearAiSettings {
  baseUrl: string;
  authMode: AuthMode;
  defaultModel: string;
  actionPolicy: ActionPolicy;
}

export const DEFAULT_BASE_URL = 'https://cloud-api.near.ai/v1';

export function createDefaultSettings(): NearAiSettings {
  return {
    baseUrl: DEFAULT_BASE_URL,
    authMode: 'apiKey',
    defaultModel: '',
    actionPolicy: defaultActionPolicy()
  };
}

export function normalizePolicyMode(value: unknown): ActionPolicyMode {
  if (value === 'mostly-autonomous' || value === 'fully-autonomous') return value;
  return 'approve-risky';
}
