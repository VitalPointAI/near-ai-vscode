// Skeleton for the red step: every entry point exists and refuses to run, so the tests fail on their assertions, not on a missing module.
import type { TeamFile } from '../domain/team/types';
import type { CleanupChecklist } from './cleanupChecklist';
import type { TeamLog } from './eventLog';
import type { NearOrgClient } from './nearOrg';
import type { SecretStorageLike } from '../services/auth';
import type { FetchLike } from '../services/reportingSignIn';

export type DeliveryResult = { ok: true; keyId: string } | { ok: false; code: 'no-device' | 'not-linked' | 'near' | 'log' | 'signed-out'; message: string };
export type ConfirmResult = { ok: true; roleChanged: boolean; key: 'delivered' | 'queued' | 'not-applicable'; message: string } | { ok: false; code: 'not-pending' | 'refused' | 'conflict' | 'offline'; message: string };
export type InstallDeliveredResult = { status: 'installed'; keyId: string } | { status: 'none' | 'already-installed' | 'not-for-this-device' } | { status: 'failed'; message: string };

interface LeadInput { log: TeamLog; teamFile: TeamFile; memberId: string; org: NearOrgClient; checklist: CleanupChecklist }

export function teamKeyName(_teamName: string, _memberName: string, _fingerprint: string): string {
  throw new Error('not implemented');
}
export async function confirmMember(_input: Omit<LeadInput, 'org'> & { org?: NearOrgClient }): Promise<ConfirmResult> {
  throw new Error('not implemented');
}
export async function deliverMemberKey(_input: LeadInput): Promise<DeliveryResult> {
  throw new Error('not implemented');
}
export async function rotateMemberKey(_input: LeadInput): Promise<DeliveryResult> {
  throw new Error('not implemented');
}
export async function installDeliveredKey(_input: {
  projectRoot: string; globalStorageDir: string; teamFile: TeamFile; log: TeamLog; deviceFingerprint: string; secrets: SecretStorageLike; baseUrl: string;
  fetch?: FetchLike; sleep?: (ms: number) => Promise<void>;
}): Promise<InstallDeliveredResult> {
  throw new Error('not implemented');
}
