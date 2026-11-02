// Removal and cancel orchestration (TEAM-03, D-17, D-18, D-25). Placeholder for the failing-test commit; the real flow follows.
import type { TeamFile } from '../domain/team/types';
import type { CleanupChecklist, CleanupItem } from './cleanupChecklist';
import type { TeamLog } from './eventLog';
import type { NearOrgClient } from './nearOrg';

export const KEY_STILL_SPENDS_WARNING = "<name>'s NEAR key could not be capped and can still spend. Retry from Manage Team Members, or set its limit to 0 in the NEAR console now.";

export type RemoveResult =
  | { ok: true; kind: 'removed' | 'cancelled'; keyStillSpends: boolean; checklist: CleanupItem[]; message: string }
  | { ok: false; code: 'not-found' | 'already-removed' | 'refused' | 'conflict' | 'offline'; message: string };

export interface RemoveInput { log: TeamLog; teamFile: TeamFile; memberId: string; org?: NearOrgClient; checklist: CleanupChecklist }
export interface RetryInput { item: CleanupItem; teamFile: TeamFile; log: TeamLog; org?: NearOrgClient; checklist: CleanupChecklist }

export async function removeMember(_input: RemoveInput): Promise<RemoveResult> {
  return { ok: false, code: 'refused', message: 'not implemented' };
}

export async function retryCleanupItem(input: RetryInput): Promise<CleanupItem> {
  return input.item;
}
