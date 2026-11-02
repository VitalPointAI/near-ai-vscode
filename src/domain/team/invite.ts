// Pure invite rules shared by the materialiser (read side) and the joiner and lead clients (write side): the bytes the code-derived key
// countersigns, the role a join must carry, the commit-time expiry rule and the status shown for an invitation. No I/O, no clock, no vscode.
import { canonicalBytes } from './canonical';
import type { DeviceRef, Member, Role, TeamPolicy, TeamState } from './types';

export const INVITE_PROOF_PURPOSE = 'near-ai.team.invite-join';
// Allowance added to the invitation lifetime when comparing two commit times. It absorbs clock differences between the two machines that
// made the commits; it is hygiene against stale bundles, not authentication (a code holder controls their own commit date).
export const INVITE_SKEW_SECONDS = 300;
// What the invite dialog offers: 24 hours, 3 days, 7 days (the default) and 14 days.
export const INVITE_TTL_CHOICES: readonly number[] = [86_400, 259_200, 604_800, 1_209_600];
export const DEFAULT_INVITE_TTL_SECONDS = 604_800;

// The bytes the invite-derived key signs. They bind team, member, the invitation event, the joining device and its key-delivery key, so a
// countersignature cannot be reused for another device, another invitation (a re-issue gets a new member id) or another team.
// sealKey is the device's X25519 public key, or an empty string when the join carries none.
export function joinProofBytes(teamId: string, memberId: string, inviteEventId: string, device: DeviceRef, sealKey: string): Buffer {
  return canonicalBytes({
    v: 1, purpose: INVITE_PROOF_PURPOSE, teamId, memberId, inviteEvent: inviteEventId,
    device: { fingerprint: device.fingerprint, publicKey: device.publicKey }, sealKey
  });
}

// D-15: the invited role is taken at once when it is observer or when the team does not require lead confirmation. Otherwise the member
// joins as observer and keeps the invited role as pendingRole until a lead confirms with member.role-changed.
export function expectedJoinRole(pendingRole: Role, policy: TeamPolicy): Role {
  return pendingRole === 'observer' || !policy.requireLeadConfirmation ? pendingRole : 'observer';
}

// D-08: both times are commit times carried by the transport, never a clock read. A time of 0 means unknown and skips the check, which
// keeps fixtures and candidate checks without a commit time valid.
export function inviteExpired(inviteCommitTime: number, ttlSeconds: number, joinCommitTime: number): boolean {
  if (inviteCommitTime === 0 || joinCommitTime === 0) return false;
  return joinCommitTime > inviteCommitTime + ttlSeconds + INVITE_SKEW_SECONDS;
}

export type InvitationStatus = 'pending' | 'expired' | 'used' | 'cancelled';

// Display only: nowSeconds comes from the caller's clock, so this never takes part in validation. A member who was never invited has no status.
export function invitationStatus(member: Member, nowSeconds: number): InvitationStatus | undefined {
  if (member.invitedEvent === undefined) return undefined;
  // A cancelled invitation keeps status invited (cancel only marks the member removed); a joined member has left that status.
  if (member.status !== 'invited') return 'used';
  if (member.removedEvent !== undefined) return 'cancelled';
  const invite = member.invite;
  if (invite === undefined) return undefined;
  return invite.commitTime !== 0 && nowSeconds > invite.commitTime + invite.ttlSeconds ? 'expired' : 'pending';
}

// ---- Key delivery (D-24) and the lead's attention list (D-16, D-25) ------------------------------------------------------------------

// The fingerprints of the devices that can receive a sealed key: not revoked and published with an X25519 key. Sorted, so two clients
// compare the same list. The sealed set of a member.key-sealed event must equal this list exactly.
export function sealCapableFingerprints(member: Member): string[] {
  return member.devices
    .filter((device) => device.revokedEvent === undefined && device.sealKey !== undefined)
    .map((device) => device.fingerprint)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

// D-24: a delivered key is only good for the devices it was sealed to. After a seal-capable device is added or a device is revoked the set
// no longer matches, and the key has to be created again and sealed to the new set (an existing key is never re-sealed).
export function keyNeedsRotation(member: Member): boolean {
  if (member.nearApiKeyId === undefined) return false;
  const sealedTo = member.nearKeyDevices ?? [];
  const wanted = sealCapableFingerprints(member);
  return sealedTo.length !== wanted.length || sealedTo.some((fingerprint, index) => fingerprint !== wanted[index]);
}

export type MemberAttentionKind = 'confirm' | 'deliver-key' | 'rotate-key';
export type MemberAttention = { memberId: string; kind: MemberAttentionKind };

// What a lead's client has to act on, one item per member in roster (insertion) order so every client shows the same list. A member waiting
// for confirmation is listed as confirm only: the key follows the confirmation (D-25). Invited and removed members and the owner never appear.
// Without a linked NEAR organization nothing is created or delivered, so only confirmations are listed (D-04).
export function memberAttention(state: Pick<TeamState, 'members' | 'team'>, nearLinked: boolean): MemberAttention[] {
  const items: MemberAttention[] = [];
  for (const member of state.members.values()) {
    if (member.status === 'invited' || member.removedEvent !== undefined || member.id === state.team.ownerId) continue;
    if (member.pendingRole !== undefined) {
      items.push({ memberId: member.id, kind: 'confirm' });
    } else if (nearLinked && member.nearApiKeyId === undefined && sealCapableFingerprints(member).length > 0) {
      items.push({ memberId: member.id, kind: 'deliver-key' });
    } else if (nearLinked && keyNeedsRotation(member)) {
      items.push({ memberId: member.id, kind: 'rotate-key' });
    }
  }
  return items;
}
