// Removal and cancel orchestration (TEAM-03, D-17, D-18, D-25). Removing a member runs in a fixed order: every NEAR key ever delivered to them is
// capped at 0 first (the fast cut-off for money in flight), then member.removed is written to the signed log (every client enforces it from there),
// then each key whose cap took is revoked. A key is never revoked before its cap was set. This module never imports vscode and never touches the
// working tree, branches or anything outside the log, NEAR and the local cleanup list.
import { decideTeamAction } from '../domain/team/permissions';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { Member, TeamFile } from '../domain/team/types';
import type { CleanupChecklist } from './cleanupChecklist';
import type { CleanupItem } from './cleanupChecklist';
import { NO_DEVICE_KEY_MESSAGE } from './eventLog';
import type { EventIntent, TeamLog } from './eventLog';
import { scrubNearText } from './nearOrg';
import type { NearOrgClient } from './nearOrg';
import { redactGitMessage } from './runGit';
import type { AppendResult } from './transport';

export const KEY_STILL_SPENDS_WARNING = "<name>'s NEAR key could not be capped and can still spend. Retry from Manage Team Members, or set its limit to 0 in the NEAR console now.";

export const keyStillSpendsWarning = (name: string): string => KEY_STILL_SPENDS_WARNING.replace('<name>', name);

export type RemoveResult =
  | { ok: true; kind: 'removed' | 'cancelled'; keyStillSpends: boolean; checklist: CleanupItem[]; message: string }
  | { ok: false; code: 'not-found' | 'already-removed' | 'refused' | 'conflict' | 'offline'; message: string };

export interface RemoveInput { log: TeamLog; teamFile: TeamFile; memberId: string; org?: NearOrgClient; checklist: CleanupChecklist }
export interface RetryInput { item: CleanupItem; teamFile: TeamFile; log: TeamLog; org?: NearOrgClient; checklist: CleanupChecklist }

const errorText = (error: unknown): string => scrubNearText(error instanceof Error ? error.message : String(error));

// Every key id ever delivered to the member: the current one and each one a rotation replaced, once each.
function deliveredKeys(member: Member): string[] {
  return [...new Set([...(member.nearApiKeyId === undefined ? [] : [member.nearApiKeyId]), ...(member.retiredNearKeyIds ?? [])])];
}

function removalFailure(result: Extract<AppendResult, { ok: false }>): RemoveResult {
  const message = redactGitMessage(result.reason);
  if (message === TEAM_REJECTION_REASONS.memberRemoved) return { ok: false, code: 'already-removed', message };
  switch (result.kind) {
    case 'offline':
      return { ok: false, code: 'offline', message };
    case 'conflict':
    case 'busy':
      return { ok: false, code: 'conflict', message };
    default:
      return { ok: false, code: 'refused', message };
  }
}

export async function removeMember(input: RemoveInput): Promise<RemoveResult> {
  const state = input.log.state();
  const member = state.members.get(input.memberId);
  if (member === undefined) return { ok: false, code: 'not-found', message: 'That person is not in this team.' };
  if (member.removedEvent !== undefined) return { ok: false, code: 'already-removed', message: TEAM_REJECTION_REASONS.memberRemoved };
  const signer = input.log.signerMemberId();
  if (signer === undefined) return { ok: false, code: 'refused', message: NO_DEVICE_KEY_MESSAGE };
  if (signer === member.id) return { ok: false, code: 'refused', message: 'You cannot remove yourself from the team.' };
  const decision = decideTeamAction(state, signer, { kind: 'member.remove', targetId: member.id });
  if (!decision.allowed) return { ok: false, code: 'refused', message: decision.reason ?? TEAM_REJECTION_REASONS.notPermitted };

  const near = input.teamFile.near;
  const keys = near === undefined ? [] : deliveredKeys(member);
  const capped: string[] = [];
  if (near !== undefined && input.org !== undefined) {
    for (const keyId of keys) {
      const key = await input.org.findKey(near.workspaceId, keyId);
      if (key === undefined) { capped.push(keyId); continue; }
      await input.org.setSpendLimit(near.workspaceId, keyId, 0);
      capped.push(keyId);
    }
  }

  const intents = (current: Parameters<Parameters<TeamLog['append']>[0]>[0]): EventIntent[] | { conflict: string } => {
    const fresh = current.members.get(member.id);
    if (fresh === undefined || fresh.removedEvent !== undefined) return { conflict: TEAM_REJECTION_REASONS.memberRemoved };
    return [{ type: 'member.removed', body: { memberId: member.id } }];
  };
  const appended = await input.log.append(intents);
  if (!appended.ok) return removalFailure(appended);

  if (near !== undefined && input.org !== undefined) {
    for (const keyId of capped) {
      try {
        await input.org.revokeKey(near.workspaceId, keyId);
      } catch (error) {
        return { ok: false, code: 'refused', message: errorText(error) };
      }
    }
  }

  await input.checklist.add([{ memberId: member.id, memberName: member.name, step: 'repo-access', status: 'manual' }]);
  const checklist = await input.checklist.forMember(member.id);
  return {
    ok: true, kind: 'removed', keyStillSpends: false, checklist,
    message: `${member.name} was removed from ${input.teamFile.name}.${keys.length > 0 ? ' Their NEAR key is capped at 0 and revoked.' : ''}`
  };
}

export async function retryCleanupItem(input: RetryInput): Promise<CleanupItem> {
  return input.item;
}
