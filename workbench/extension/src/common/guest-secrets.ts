/**
 * Removing ended guests' secrets (Phase 47 D-84, owner 2026-11-25; plan 47-34). A security officer sees how many ended guest accounts have
 * secrets past your organization's retention period, and removes them after a passkey step-up. The notice names how many, never who; the
 * list names a guest only by their account's internal id and end date. Nothing here imports Theia.
 */
import type { ServiceResult } from './service-result.js';

export const GUEST_SECRETS_PATH = '/services/sterling-guest-secrets';
export const GuestSecretsRpc = Symbol('GuestSecretsRpc');

/** The officers' notice the hourly check writes: a count and when it was counted. */
export interface GuestSecretsNotice {
  readonly count: number;
  readonly checkedAt: string;
}

/** One ended guest whose secrets may be removed: the end record's name, the end and the end of the retention period. */
export interface EndedGuest {
  readonly record: string;
  readonly endedAt: string;
  readonly removeAfter: string;
}

export interface GuestSecretsRpc {
  /** The notice, or null for someone who is not a security officer here (or when there is no notice yet). */
  notice(): Promise<ServiceResult<GuestSecretsNotice | null>>;
  /** The ended guests past retention whose secrets are still there. Needs a fresh step-up. */
  candidates(): Promise<ServiceResult<readonly EndedGuest[]>>;
  /** Removes one ended guest's secrets and records it. Needs a fresh step-up. */
  remove(record: string): Promise<ServiceResult<{ readonly removed: number }>>;
}

/** Every sentence of the feature (D-43 style): plain words, "your organization", no token, key or entity id. */
export const GUEST_SECRETS_TEXT = {
  command: "Remove ended guests' secrets",
  notice: (count: number): string => (count === 1
    ? "1 ended guest account has secrets past your organization's retention period. A security officer removes them."
    : `${count} ended guest accounts have secrets past your organization's retention period. A security officer removes them.`),
  stepUpNeeded: "Removing ended guests' secrets needs a fresh confirmation with your passkey or security key.",
  confirm: 'Confirm with your passkey or security key',
  notOfficer: "Only your organization's security officers can remove ended guests' secrets.",
  none: "No ended guest's secrets are waiting for removal.",
  notDue: "This guest's secrets are not past the retention period, the account is in use again, or they were removed already.",
  badRecord: 'This is not an ended guest record.',
  pick: 'Choose the ended guest whose secrets to remove',
  all: 'All of them',
  confirmTitle: "Remove ended guests' secrets",
  confirmText: (count: number): string => `Remove the secrets of ${count === 1 ? 'this ended guest' : `these ${count} ended guests`}? This cannot be undone. Your name is recorded with the removal.`,
  removed: (secrets: number, guests: number): string => `Removed ${secrets} secret${secrets === 1 ? '' : 's'} of ${guests} ended guest${guests === 1 ? '' : 's'}.`,
  local: 'This is only available in your organization\'s hosted workbench.',
  notReady: 'Your sign-in is not ready yet.',
  unreachable: "Your organization's secret store did not answer. Try again, or ask your administrator.",
} as const;
