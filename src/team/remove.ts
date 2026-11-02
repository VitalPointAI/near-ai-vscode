// Removal and cancel orchestration (TEAM-03, D-10, D-17, D-18, D-22, D-25). Removing a member runs in a fixed order: every NEAR key ever delivered
// to them is capped at 0 first (the fast cut-off for money in flight), then member.removed is written to the signed log (every client enforces it
// from there), then each key whose cap took is revoked, then a lead leaves the NEAR organization. A key is never revoked before its cap was set.
//
// A NEAR step that fails or cannot run never blocks the log removal: it goes on the local cleanup list with Retry, and when a key could not be
// capped the lead is told in plain words that it can still spend. The organization member to remove is found by matching the email hash of each
// organization member against the removed member's hashes, never by an id taken from the log, and never the remover or an owner; when NEAR gives
// no email (the real server does not) the step becomes a manual item. This module never imports vscode and never touches the working tree,
// branches or anything outside the log, NEAR and the local cleanup list.
import { decideTeamAction } from '../domain/team/permissions';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { Member, NearLink, TeamFile, TeamState } from '../domain/team/types';
import type { CleanupChecklist, CleanupItem, CleanupPatch, NewCleanupItem } from './cleanupChecklist';
import { NO_DEVICE_KEY_MESSAGE } from './eventLog';
import type { EventIntent, TeamLog } from './eventLog';
import { emailHash } from './identity';
import { REMOVED_INVITEE_TEXT, closeInvitationSends } from './invite';
import { scrubNearText } from './nearOrg';
import type { NearOrgClient } from './nearOrg';
import { NearSessionError } from './nearSession';
import { redactGitMessage } from './runGit';
import { NearPinError, checkNearPin } from './teamFile';
import type { AppendResult } from './transport';

export const KEY_STILL_SPENDS_WARNING = "<name>'s NEAR key could not be capped and can still spend. Retry from Manage Team Members, or set its limit to 0 in the NEAR console now.";

export const keyStillSpendsWarning = (name: string): string => KEY_STILL_SPENDS_WARNING.replace('<name>', name);

export type RemoveResult =
  | { ok: true; kind: 'removed' | 'cancelled'; keyStillSpends: boolean; checklist: CleanupItem[]; message: string }
  | { ok: false; code: 'not-found' | 'already-removed' | 'refused' | 'conflict' | 'offline'; message: string };

export interface RemoveInput { log: TeamLog; teamFile: TeamFile; memberId: string; org?: NearOrgClient; checklist: CleanupChecklist }
export interface RetryInput { item: CleanupItem; teamFile: TeamFile; log: TeamLog; org?: NearOrgClient; checklist: CleanupChecklist }

// ---- how a NEAR step ended --------------------------------------------------------------------------------------------------------------

// done: finished (or nothing left to do). pending: not tried, it needs a NEAR sign-in. failed: tried and NEAR said no. manual: the extension
// has no safe way, so the text tells the lead what to do.
type StepState = { status: 'done' } | { status: 'pending' | 'failed' | 'manual'; text: string };
const DONE: StepState = { status: 'done' };

const SIGN_IN_TEXT = 'Sign in to NEAR to finish this step.';
const CAP_FIRST_TEXT = 'Set the limit to 0 first.';
const OTHER_COMMAND_TEXT = 'Retry this step from NEAR AI: Manage Team Members.';
const NO_LINK_TEXT = 'This team has no NEAR organization link, so do this step in the NEAR console.';
// CR-01: NEAR not listing a key in the linked workspace never proves the key is gone, because the workspace id comes from team.json.
const KEY_NOT_FOUND_CAP_TEXT = 'NEAR did not find this key in the linked workspace, so it may still be able to spend. Find it in the NEAR console and set its limit to 0.';
const KEY_NOT_FOUND_REVOKE_TEXT = 'NEAR did not find this key in the linked workspace, so it was not revoked here. Find it in the NEAR console and revoke it.';
const NO_LINK_KEY_TEXT = 'This computer has no NEAR organization link for this team, so the key was not capped. Find it in the NEAR console and set its limit to 0.';

const errorText = (error: unknown): string => scrubNearText(error instanceof Error ? error.message : String(error));

// A missing or expired sign-in is a step that has not been tried; anything else is NEAR refusing or being unreachable.
function problem(error: unknown): StepState {
  if (error instanceof NearSessionError && (error.code === 'signed-out' || error.code === 'expired')) return { status: 'pending', text: error.message };
  return { status: 'failed', text: errorText(error) };
}

const manualOrganizationText = (name: string): string => `Remove ${name} from the NEAR organization in the NEAR console. Their email address could not be matched to an organization member here.`;
const protectedMatchText = (name: string): string => `${name} matches an organization owner or you, so nothing was removed. If ${name} should leave the NEAR organization, remove them in the NEAR console.`;
const ambiguousMatchText = (name: string): string => `More than one organization member matches ${name}, so nothing was removed. Remove the right one in the NEAR console.`;
const noInvitationText = (name: string): string => `No pending NEAR invitation for ${name} was found. If they already accepted it, remove them from the NEAR organization in the NEAR console.`;

// Every key id ever delivered to the member: the current one and each one a rotation replaced, once each.
function deliveredKeys(member: Member): string[] {
  return [...new Set([...(member.nearApiKeyId === undefined ? [] : [member.nearApiKeyId]), ...(member.retiredNearKeyIds ?? [])])];
}

const isLead = (member: Member): boolean => member.role === 'lead' || member.pendingRole === 'lead';

// ---- which NEAR link the steps use (CR-01) ----------------------------------------------------------------------------------------------

// The link in team.json, checked against the one this computer pinned (teamFile.checkNearPin). A mismatch is a reason, and no NEAR call
// is made with either link: the lead is told to check with the team and to finish the step in the NEAR console.
type LinkCheck = { ok: true; near: NearLink | undefined } | { ok: false; text: string };

async function trustedLink(teamFile: TeamFile, checklist: CleanupChecklist): Promise<LinkCheck> {
  try {
    return { ok: true, near: await checkNearPin(checklist.storageDir, teamFile) };
  } catch (error) {
    if (error instanceof NearPinError) return { ok: false, text: error.message };
    return { ok: false, text: `The saved NEAR link for this team could not be checked, so no NEAR key was changed: ${errorText(error)}` };
  }
}

// ---- the NEAR steps ---------------------------------------------------------------------------------------------------------------------

// Step 1. The limit is set straight away: a key NEAR does not have in the linked workspace is a manual item, never done (CR-01).
async function capKey(org: NearOrgClient, near: NearLink, keyId: string): Promise<StepState> {
  try {
    const answer = await org.setSpendLimit(near.workspaceId, keyId, 0);
    return answer === 'missing' ? { status: 'manual', text: KEY_NOT_FOUND_CAP_TEXT } : DONE;
  } catch (error) {
    return problem(error);
  }
}

// Step 3. Only called for a key whose cap is done. NEAR answering "no such key" is a manual item, never done (CR-01).
async function revokeKey(org: NearOrgClient, near: NearLink, keyId: string): Promise<StepState> {
  try {
    const answer = await org.revokeKey(near.workspaceId, keyId);
    return answer === 'missing' ? { status: 'manual', text: KEY_NOT_FOUND_REVOKE_TEXT } : DONE;
  } catch (error) {
    return problem(error);
  }
}

// Step 4. The organization member is the one whose email hash is one of the removed member's. NEAR's member list carries no email on the real
// server, and then nobody can be matched safely, so the lead is told to do it in the NEAR console. Owners and the lead doing the removal are
// never removed, even when they match.
async function leaveOrganization(org: NearOrgClient, near: NearLink, teamId: string, member: Member): Promise<StepState> {
  try {
    const matches = (await org.listMembers(near.organizationId)).filter((candidate) => candidate.email !== undefined && member.emailHashes.includes(emailHash(teamId, candidate.email)));
    if (matches.length === 0) return { status: 'manual', text: manualOrganizationText(member.name) };
    if (matches.length > 1) return { status: 'manual', text: ambiguousMatchText(member.name) };
    const target = matches[0];
    if (target === undefined || target.role === 'owner') return { status: 'manual', text: protectedMatchText(member.name) };
    const remover = await org.currentUser();
    if (target.userId === remover.id) return { status: 'manual', text: protectedMatchText(member.name) };
    await org.removeMember(near.organizationId, target.userId);
    return DONE;
  } catch (error) {
    return problem(error);
  }
}

// Cancel of a lead's invitation: the pending NEAR invitation whose address hashes to the invited member's hash. When none is pending the
// person may already have accepted it, so the organization membership is tried the same way before the lead is asked to look.
async function cancelNearInvitation(org: NearOrgClient, near: NearLink, teamId: string, member: Member): Promise<StepState> {
  try {
    const pending = await org.listInvitations(near.organizationId, 'pending');
    const match = pending.find((invitation) => member.emailHashes.includes(emailHash(teamId, invitation.email)));
    if (match !== undefined) {
      await org.cancelInvitation(near.organizationId, match.id);
      return DONE;
    }
  } catch (error) {
    return problem(error);
  }
  const left = await leaveOrganization(org, near, teamId, member);
  return left.status === 'manual' ? { status: 'manual', text: noInvitationText(member.name) } : left;
}

// ---- the cleanup list -------------------------------------------------------------------------------------------------------------------

function itemOf(member: { id: string; name: string }, step: NewCleanupItem['step'], state: StepState, keyId?: string): NewCleanupItem {
  return {
    memberId: member.id, memberName: member.name, step, status: state.status,
    ...(keyId === undefined ? {} : { keyId }), ...(state.status === 'done' ? {} : { lastError: state.text })
  };
}

// The list keeps every finished and unfinished step when anything is left to do, so a retry can see what was already done; a removal where
// every NEAR step finished leaves nothing but the closing reminder.
function listToKeep(items: NewCleanupItem[]): NewCleanupItem[] {
  return items.some((item) => item.status !== 'done') ? items : [];
}

// Saves the items; a list that cannot be saved never undoes the removal, it becomes a sentence for the lead.
async function save(checklist: CleanupChecklist, memberId: string, items: NewCleanupItem[]): Promise<{ items: CleanupItem[]; notice?: string }> {
  try {
    if (items.length > 0) await checklist.add(items);
    return { items: await checklist.forMember(memberId) };
  } catch (error) {
    return { items: [], notice: `The cleanup list could not be saved: ${errorText(error)}` };
  }
}

const sentence = (parts: Array<string | undefined>): string => parts.filter((part): part is string => part !== undefined && part !== '').join(' ');

function appendFailure(result: Extract<AppendResult, { ok: false }>): { code: Extract<RemoveResult, { ok: false }>['code']; message: string } {
  const message = redactGitMessage(result.reason);
  if (message === TEAM_REJECTION_REASONS.memberRemoved) return { code: 'already-removed', message };
  switch (result.kind) {
    case 'offline':
      return { code: 'offline', message };
    case 'conflict':
    case 'busy':
      return { code: 'conflict', message };
    default:
      return { code: 'refused', message };
  }
}

// What the lead is told about a step that did not finish and is not a key.
function leftToDo(state: StepState, what: string): string | undefined {
  if (state.status === 'done') return undefined;
  if (state.status === 'manual') return state.text;
  return state.status === 'pending' ? `${what} It is on your cleanup list; sign in to NEAR and retry it.` : `${what} It is on your cleanup list.`;
}

// ---- removal and cancel -----------------------------------------------------------------------------------------------------------------

function removalIntents(memberId: string): (state: TeamState) => EventIntent[] | { conflict: string } {
  return (state) => {
    const fresh = state.members.get(memberId);
    if (fresh === undefined || fresh.removedEvent !== undefined) return { conflict: TEAM_REJECTION_REASONS.memberRemoved };
    return [{ type: 'member.removed', body: { memberId } }];
  };
}

export async function removeMember(input: RemoveInput): Promise<RemoveResult> {
  const state = input.log.state();
  const member = state.members.get(input.memberId);
  if (member === undefined) return { ok: false, code: 'not-found', message: 'That person is not in this team.' };
  if (member.removedEvent !== undefined) return { ok: false, code: 'already-removed', message: TEAM_REJECTION_REASONS.memberRemoved };
  // The permission question comes before any NEAR call, so a person who may not remove anyone cannot cap a key through this flow.
  const signer = input.log.signerMemberId();
  if (signer === undefined) return { ok: false, code: 'refused', message: NO_DEVICE_KEY_MESSAGE };
  if (signer === member.id) return { ok: false, code: 'refused', message: 'You cannot remove yourself from the team.' };
  const decision = decideTeamAction(state, signer, { kind: 'member.remove', targetId: member.id });
  if (!decision.allowed) return { ok: false, code: 'refused', message: decision.reason ?? TEAM_REJECTION_REASONS.notPermitted };
  return member.status === 'invited' ? cancelInvitationFor(input, member) : removeJoinedMember(input, member);
}

interface KeyStep { keyId: string; cap: StepState; revoke: StepState }

async function removeJoinedMember(input: RemoveInput, member: Member): Promise<RemoveResult> {
  const link = await trustedLink(input.teamFile, input.checklist);
  const near = link.ok ? link.near : undefined;
  // A key the log says was delivered is always a step, even when this computer has no link it trusts for it: then the step is manual and the
  // lead is warned the key can still spend, instead of the key being left out of the message.
  const unusable: StepState | undefined = !link.ok ? { status: 'manual', text: link.text } : near === undefined ? { status: 'manual', text: NO_LINK_KEY_TEXT } : undefined;
  const steps: KeyStep[] = deliveredKeys(member).map((keyId) => ({
    keyId, cap: unusable ?? { status: 'pending', text: SIGN_IN_TEXT }, revoke: { status: 'pending', text: CAP_FIRST_TEXT }
  }));

  // Step 1: cap every key at 0.
  if (near !== undefined && input.org !== undefined) {
    for (const step of steps) step.cap = await capKey(input.org, near, step.keyId);
  }

  // Step 2: the removal, written whatever happened above.
  const appended = await input.log.append(removalIntents(member.id));
  if (!appended.ok) {
    const failure = appendFailure(appended);
    const finished = steps.filter((step) => step.cap.status === 'done');
    const saved = await save(input.checklist, member.id, finished.map((step) => itemOf(member, 'zero-limit', DONE, step.keyId)));
    const message = failure.code === 'already-removed' || finished.length === 0
      ? failure.message
      : sentence([failure.message, `${member.name}'s NEAR key was capped at 0 here but the removal was not saved to the team, so try removing them again.`, saved.notice]);
    return { ok: false, code: failure.code, message };
  }

  // CR-02: a lead's NEAR invitation that never went out must not go out after the removal.
  const invitationNote = await closeInvitationSends(input.checklist, member.id, REMOVED_INVITEE_TEXT);

  // Step 3: revoke each key whose cap is done.
  for (const step of steps) {
    if (step.cap.status !== 'done') continue;
    step.revoke = near !== undefined && input.org !== undefined ? await revokeKey(input.org, near, step.keyId) : { status: 'pending', text: SIGN_IN_TEXT };
  }

  // Step 4: a lead (by role, or invited as lead and waiting for confirmation) also leaves the NEAR organization.
  const leaves = (near !== undefined || !link.ok) && isLead(member);
  let organization: StepState = DONE;
  if (!link.ok && leaves) organization = { status: 'manual', text: `${link.text} ${manualOrganizationText(member.name)}` };
  else if (near !== undefined && leaves) {
    organization = input.org === undefined ? { status: 'pending', text: SIGN_IN_TEXT } : await leaveOrganization(input.org, near, input.teamFile.teamId, member);
  }

  const items: NewCleanupItem[] = [];
  for (const step of steps) items.push(itemOf(member, 'zero-limit', step.cap, step.keyId), itemOf(member, 'revoke-key', step.revoke, step.keyId));
  if (leaves) items.push(itemOf(member, 'remove-org-member', organization));
  const kept = listToKeep(items);
  kept.push({ memberId: member.id, memberName: member.name, step: 'repo-access', status: 'manual' });
  const saved = await save(input.checklist, member.id, kept);

  const keyStillSpends = steps.some((step) => step.cap.status !== 'done');
  const plural = steps.length !== 1;
  const keyWords = plural ? `Their ${steps.length} NEAR keys` : 'Their NEAR key';
  // Why a cap could not be done here, once each (a pin mismatch or a key NEAR did not find).
  const capReasons = [...new Set(steps.flatMap((step) => (step.cap.status === 'manual' ? [step.cap.text] : [])))];
  let keyNote: string | undefined;
  if (steps.length > 0) {
    if (keyStillSpends) keyNote = sentence([keyStillSpendsWarning(member.name), ...capReasons]);
    else if (steps.some((step) => step.revoke.status !== 'done')) keyNote = `${keyWords} ${plural ? 'are' : 'is'} capped at 0 but could not be revoked yet. ${plural ? 'They are' : 'It is'} on your cleanup list.`;
    else keyNote = `${keyWords} ${plural ? 'are' : 'is'} capped at 0 and revoked.`;
  }
  return {
    ok: true, kind: 'removed', keyStillSpends, checklist: saved.items,
    message: sentence([
      `${member.name} was removed from ${input.teamFile.name}.`, keyNote, leftToDo(organization, `${member.name} is still in the NEAR organization.`),
      'Remove their repository access last; it is on your cleanup list.', saved.notice, invitationNote
    ])
  };
}

async function cancelInvitationFor(input: RemoveInput, member: Member): Promise<RemoveResult> {
  const link = await trustedLink(input.teamFile, input.checklist);
  const near = link.ok ? link.near : undefined;
  // An invitation that never reached NEAR (its send is still on the list) has nothing to cancel there.
  let neverSent: CleanupItem[] = [];
  let notice: string | undefined;
  try {
    neverSent = (await input.checklist.forMember(member.id)).filter((item) => item.step === 'send-invitation' && item.status !== 'done');
  } catch (error) {
    notice = `The cleanup list could not be read: ${errorText(error)}`;
  }

  const appended = await input.log.append(removalIntents(member.id));
  if (!appended.ok) return { ok: false, ...appendFailure(appended) };

  let nearState: StepState = DONE;
  if (!link.ok && isLead(member) && neverSent.length === 0) nearState = { status: 'manual', text: `${link.text} ${noInvitationText(member.name)}` };
  else if (near !== undefined && isLead(member) && neverSent.length === 0) {
    nearState = input.org === undefined ? { status: 'pending', text: SIGN_IN_TEXT } : await cancelNearInvitation(input.org, near, input.teamFile.teamId, member);
  }
  for (const item of neverSent) {
    try {
      await input.checklist.update(item.id, { status: 'done' });
    } catch (error) {
      notice = sentence([notice, `The cleanup list could not be updated: ${errorText(error)}`]);
    }
  }
  const saved = await save(input.checklist, member.id, nearState.status === 'done' ? [] : [itemOf(member, 'cancel-invitation', nearState)]);
  const open = saved.items.filter((item) => item.status !== 'done' && item.step === 'cancel-invitation');
  return {
    ok: true, kind: 'cancelled', keyStillSpends: false, checklist: open,
    message: sentence([`The invitation for ${member.name} was cancelled.`, leftToDo(nearState, 'Their NEAR invitation could not be cancelled yet.'), saved.notice, notice])
  };
}

// ---- retry ------------------------------------------------------------------------------------------------------------------------------

async function settleItem(checklist: CleanupChecklist, item: CleanupItem, state: StepState, attempted: boolean): Promise<CleanupItem> {
  const patch: CleanupPatch = state.status === 'done' ? { status: 'done', attempted } : { status: state.status, lastError: state.text, attempted };
  return (await checklist.update(item.id, patch)) ?? item;
}

// Says why nothing was tried, without counting it as an attempt.
async function leaveWithText(checklist: CleanupChecklist, item: CleanupItem, text: string, status?: CleanupItem['status']): Promise<CleanupItem> {
  return (await checklist.update(item.id, { lastError: text, ...(status === undefined ? {} : { status }) })) ?? item;
}

/**
 * Runs one cleanup item again. The cap comes before the revoke: a revoke is only tried when no cap item for the same key is still open. The
 * repository reminder is only ever finished by the person, and invitation and key delivery items are retried from the commands that made them.
 */
export async function retryCleanupItem(input: RetryInput): Promise<CleanupItem> {
  const stored = (await input.checklist.list()).find((candidate) => candidate.id === input.item.id) ?? input.item;
  if (stored.status === 'done') return stored;
  switch (stored.step) {
    case 'repo-access':
      return stored;
    case 'send-invitation':
    case 'deliver-key':
    case 'rotate-key':
      return leaveWithText(input.checklist, stored, OTHER_COMMAND_TEXT);
    default:
      break;
  }
  // Every step below calls NEAR, so only with a link this computer trusts (CR-01).
  const link = await trustedLink(input.teamFile, input.checklist);
  if (!link.ok) return leaveWithText(input.checklist, stored, link.text, 'manual');
  const near = link.near;
  switch (stored.step) {
    case 'zero-limit': {
      if (near === undefined || stored.keyId === undefined) return leaveWithText(input.checklist, stored, NO_LINK_TEXT, 'manual');
      if (input.org === undefined) return leaveWithText(input.checklist, stored, SIGN_IN_TEXT, 'pending');
      return settleItem(input.checklist, stored, await capKey(input.org, near, stored.keyId), true);
    }
    case 'revoke-key': {
      if (near === undefined || stored.keyId === undefined) return leaveWithText(input.checklist, stored, NO_LINK_TEXT, 'manual');
      const open = (await input.checklist.forMember(stored.memberId)).some((item) => item.step === 'zero-limit' && item.keyId === stored.keyId && item.status !== 'done');
      if (open) return leaveWithText(input.checklist, stored, CAP_FIRST_TEXT);
      if (input.org === undefined) return leaveWithText(input.checklist, stored, SIGN_IN_TEXT, 'pending');
      return settleItem(input.checklist, stored, await revokeKey(input.org, near, stored.keyId), true);
    }
    case 'remove-org-member':
    case 'cancel-invitation': {
      const member = input.log.state().members.get(stored.memberId);
      if (near === undefined || member === undefined) return leaveWithText(input.checklist, stored, NO_LINK_TEXT, 'manual');
      if (input.org === undefined) return leaveWithText(input.checklist, stored, SIGN_IN_TEXT, 'pending');
      const state = stored.step === 'remove-org-member'
        ? await leaveOrganization(input.org, near, input.teamFile.teamId, member)
        : await cancelNearInvitation(input.org, near, input.teamFile.teamId, member);
      return settleItem(input.checklist, stored, state, state.status !== 'manual');
    }
  }
}
