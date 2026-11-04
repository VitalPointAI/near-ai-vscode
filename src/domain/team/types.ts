// Team Mode contracts. Declared once here; every Phase 60 module and the later team phases import from this file.
// Constants and types only: this file holds no functions so it can be read without side effects.

export const ROLES = ['owner', 'lead', 'developer', 'reviewer', 'observer'] as const;
export type Role = typeof ROLES[number];
export const AVAILABILITIES = ['available', 'focus', 'away', 'offline'] as const;
export type Availability = typeof AVAILABILITIES[number];
export type ItemKind = 'milestone' | 'phase' | 'plan' | 'task' | 'chore' | 'bug' | 'spike' | 'review';
export type ItemState = 'backlog' | 'ready' | 'claimed' | 'in-progress' | 'in-review' | 'integrating' | 'done' | 'cancelled';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// Spec 5.2, all 57 types (spec order plus member.key-sealed, added in Phase 61, and item.assigned and item.unassigned, added in Phase 62 for G-62-5):
// roster(10) work(10) claims(9) leases(5) integration(7) budget(8) collaboration(4) control(4)
export const TEAM_EVENT_TYPES = ['team.created', 'member.invited', 'member.joined', 'member.role-changed', 'member.removed', 'device.added', 'device.revoked', 'member.availability', 'member.skills', 'member.key-sealed', 'item.imported', 'item.created', 'item.updated', 'item.estimated', 'item.blocked', 'item.unblocked', 'item.cancelled', 'item.reopened', 'item.assigned', 'item.unassigned', 'claim.offered', 'claim.accepted', 'claim.declined', 'claim.taken', 'claim.heartbeat', 'claim.released', 'claim.handed-off', 'claim.expired', 'claim.progress', 'lease.granted', 'lease.extended', 'lease.requested', 'lease.released', 'lease.expired', 'integration.queued', 'integration.started', 'integration.verified', 'integration.failed', 'review.requested', 'review.submitted', 'integration.merged', 'budget.set', 'allocation.granted', 'allocation.revoked', 'allocation.requested', 'allocation.decided', 'spend.summary', 'spend.reconciled', 'budget.alert', 'comment.added', 'mention', 'handoff.note', 'decision.recorded', 'team.stop', 'team.resume', 'policy.changed', 'snapshot.written'] as const;
export type TeamEventType = typeof TEAM_EVENT_TYPES[number];

export interface DeviceRef { fingerprint: string; publicKey: string }            // dev-<32 hex>, base64url of 32 raw bytes
export interface WorkingHours { tz: string; days: number[]; start: string; end: string }
export interface NearLink { organizationId: string; workspaceId: string }
export interface TeamCreatedBody { name: string; ownerId: string; ownerName: string; ownerEmailHashes: string[]; ownerDevice: DeviceRef; policy: TeamPolicy; near?: NearLink }
// Roles a lead can invite someone into. The owner is never invited: a team has exactly one owner, set at genesis.
export const INVITABLE_ROLES = ['lead', 'developer', 'reviewer', 'observer'] as const;
// The invitation id is the member id. invite.publicKey is the Ed25519 key derived from the single-use code; the code itself is never logged.
export interface MemberInvitedBody { memberId: string; name: string; emailHashes: string[]; role: Exclude<Role, 'owner'>; allocationNanoUsd: number; ttlSeconds: number; invite: { publicKey: string } }
// invite.sig and sealKey exist only on a join that follows an invitation. The owner's genesis join keeps its Phase 60 shape.
export interface MemberJoinedBody { memberId: string; name: string; emailHashes: string[]; role: Role; device: DeviceRef; invite?: { sig: string }; sealKey?: { publicKey: string } }
export interface MemberRoleChangedBody { memberId: string; role: Role }
export interface MemberRemovedBody { memberId: string }
// sealKey is the device's X25519 public key for key delivery; a device added without one cannot receive a sealed key (D-24).
export interface DeviceAddedBody { memberId: string; device: DeviceRef; sealKey?: { publicKey: string } }
export interface DeviceRevokedBody { memberId: string; fingerprint: string }
export interface MemberAvailabilityBody { availability: Availability; workingHours?: WorkingHours }
export interface MemberSkillsBody { memberId: string; skills: string[] }
// D-23: a NEAR API key sealed to one device. The log holds only the key id and the ciphertext, never the clear key.
export interface SealedEntryBody { device: string; ephemeral: { publicKey: string }; nonce: string; tag: string; ciphertext: string }
export interface MemberKeySealedBody { memberId: string; keyId: string; scheme: 'x25519-hkdf-sha256-aes-256-gcm-v1'; sealed: SealedEntryBody[] }
export interface PolicyChangedBody { changes: Partial<TeamPolicy> }
export interface SnapshotWrittenBody { coversThrough: string; lamport: number; stateHash: string; path: string }
// Work events (spec 5.2, D-04, D-10 to D-14). Ids are permanent: imported items use milestone:<version>, phase:<n>, plan:<phase>-<plan> and
// task:<phase>-<plan>-<index>; board items use item:<ulid>. Each body is exact-key and its shape is signed into the log for good.
export type ItemOrigin = 'import' | 'board';
export interface ItemEstimate { tokens: number; confidence?: 'low' | 'medium' | 'high' }
export interface ItemGsdRef { phase: string; plan?: string; wave?: number; file?: string }
export interface ItemImportedBody {
  id: string; kind: 'milestone' | 'phase' | 'plan' | 'task'; title: string; state: 'backlog' | 'done'; dependsOn: string[]; scope: string[]; requirements: string[]; mustHaves: string[]; tags: string[];
  parentId?: string; gsd?: ItemGsdRef; estimate?: ItemEstimate; summary?: true; active?: true; source?: string;
}
export interface ItemCreatedBody { id: string; kind: 'bug' | 'chore' | 'spike'; title: string; scope: string[]; requirements: string[]; mustHaves: string[]; description?: string; estimate?: ItemEstimate; tags?: string[] }
// hold and state are each the only key when present. state can only be the literal done (mark done); every other move has its own event.
export interface ItemChanges {
  title?: string; description?: string; scope?: string[]; requirements?: string[]; mustHaves?: string[]; dependsOn?: string[]; estimate?: ItemEstimate; gsd?: ItemGsdRef; tags?: string[];
  summary?: boolean; active?: boolean; source?: string; hold?: boolean; state?: 'done';
}
export interface ItemUpdatedBody { id: string; changes: ItemChanges }
export interface ItemEstimatedBody { id: string; estimate: ItemEstimate }
export interface ItemBlockedBody { id: string; reason: string }
export interface ItemUnblockedBody { id: string }
export interface ItemCancelledBody { id: string; reason: string }
export interface ItemReopenedBody { id: string }
// G-62-5: assignment is a pointer to a person, not a lock. memberId follows the member id rule; there is no reason, no time and no other key.
// Claims (item.claimId and the claim events, Phase 63) stay separate, and a later claim rule may read the assignee.
export interface ItemAssignedBody { id: string; memberId: string }
export interface ItemUnassignedBody { id: string }
export interface ImplementedEventBodies { 'team.created': TeamCreatedBody; 'member.invited': MemberInvitedBody; 'member.joined': MemberJoinedBody; 'member.role-changed': MemberRoleChangedBody; 'member.removed': MemberRemovedBody; 'device.added': DeviceAddedBody; 'device.revoked': DeviceRevokedBody; 'member.availability': MemberAvailabilityBody; 'member.skills': MemberSkillsBody; 'member.key-sealed': MemberKeySealedBody; 'item.imported': ItemImportedBody; 'item.created': ItemCreatedBody; 'item.updated': ItemUpdatedBody; 'item.estimated': ItemEstimatedBody; 'item.blocked': ItemBlockedBody; 'item.unblocked': ItemUnblockedBody; 'item.cancelled': ItemCancelledBody; 'item.reopened': ItemReopenedBody; 'item.assigned': ItemAssignedBody; 'item.unassigned': ItemUnassignedBody; 'policy.changed': PolicyChangedBody; 'snapshot.written': SnapshotWrittenBody }
export type ImplementedEventType = keyof ImplementedEventBodies;
// The 22 types this version reads: the 12 of Phases 60 and 61 plus the ten work events of Phase 62. The other 35 stay unsupported until their phase.
export const IMPLEMENTED_EVENT_TYPES: readonly ImplementedEventType[] = ['team.created', 'member.invited', 'member.joined', 'member.role-changed', 'member.removed', 'device.added', 'device.revoked', 'member.availability', 'member.skills', 'member.key-sealed', 'item.imported', 'item.created', 'item.updated', 'item.estimated', 'item.blocked', 'item.unblocked', 'item.cancelled', 'item.reopened', 'item.assigned', 'item.unassigned', 'policy.changed', 'snapshot.written'];
export type TeamEventBodyMap = ImplementedEventBodies & { [K in Exclude<TeamEventType, ImplementedEventType>]: JsonObject };
// prev is the id of the accepted log head the author built on ('' for team.created). A reader requires it to equal the head at this position.
export interface TeamEvent<T extends TeamEventType = TeamEventType> { v: 1; id: string; teamId: string; type: T; lamport: number; at: string; author: string; device: string; prev: string; body: TeamEventBodyMap[T]; sig: string }
export type UnsignedTeamEvent<T extends TeamEventType = TeamEventType> = Omit<TeamEvent<T>, 'sig'>;
export type ImplementedTeamEvent = { [T in ImplementedEventType]: TeamEvent<T> }[ImplementedEventType];
export type DispatchWeight = 'roleFit' | 'fileAffinity' | 'continuity' | 'capacity' | 'budgetHeadroom' | 'criticalPath';
export interface TeamPolicy {
  dispatchMode: 'suggest' | 'offer' | 'auto'; offerTimeoutMinutes: number; leaseTtlMinutes: number; heartbeatMinutes: number; enforceWip: boolean;
  sharedPaths: string[]; resources: string[]; verifyCommands: string[]; reviewPolicy: 'human' | 'agent' | 'agent-then-human';
  integrationMode: 'merge-train' | 'pull-request'; integrationBranch: string; budgetPeriod: 'monthly' | 'milestone'; unspentPolicy: 'rollover' | 'return-to-pool' | 'expire';
  safetyFactorBp: number; overrunFactorBp: number; reconcileToleranceBp: number; allowedModels: Record<Role, string[]>; teeOnly: boolean;
  peerMetricsVisible: boolean; requireLeadConfirmation: boolean; developerMayIntegrate: boolean; dispatchWeightsBp: Record<DispatchWeight, number>;
}
export interface DeviceKey { fingerprint: string; publicKey: string; addedBy: string; addedEvent: string; revokedEvent?: string; revokedBy?: string; sealKey?: string }
// The invitation keys on Member are optional and left out when absent, so a team with no invitations serialises exactly as in Phase 60.
// status is 'invited' only between member.invited and the join; pendingRole is the invited role until a lead confirms it.
export interface MemberInvite { publicKey: string; ttlSeconds: number; eventId: string; commitTime: number }
export interface Member {
  id: string; name: string; emailHashes: string[]; role: Role; devices: DeviceKey[]; skills: string[]; availability: Availability; workingHours?: WorkingHours;
  wipLimit: number; nearApiKeyId?: string; joinedAt: string; joinedEvent: string; removedAt?: string; removedEvent?: string;
  status?: 'invited'; invite?: MemberInvite; invitedEvent?: string; pendingRole?: Role; allocationNanoUsd?: number;
  // Key delivery (D-23, D-24). nearApiKeyId is the one current key; every earlier key id moves to retiredNearKeyIds so removal can revoke them all.
  // nearKeyDevices are the sorted fingerprints the current key was sealed to, and nearKeyEvent is the member.key-sealed event that delivered it.
  nearKeyDevices?: string[]; nearKeyEvent?: string; retiredNearKeyIds?: string[];
}

// Spec 7 shapes declared now for later phases (money is integer nano-USD):
export interface SpendSummary { inputTokens: number; cachedInputTokens: number; outputTokens: number; confirmedNanoUsd: number; pendingNanoUsd: number; estimatedNanoUsd: number; requests: number }
// The stored key set enters the state hash once items exist, so it is as permanent as the event bodies and a test pins it. Optional keys are
// left out when absent. stateSince is the display-only `at` of the event that last changed the stored state or the hold flag; it orders nothing.
// origin says who owns the content: import (the GSD importer) or board (created on the board by createdBy). hold, summary and active are only ever true.
// assignee is the member id a lead put on the card with item.assigned (G-62-5), left out when nobody is assigned so older states hash as before.
// assignedBy is the member id of the author of the item.assigned that set the current assignee (owner decision 2026-11-04, 62-26): present only
// while assignee is, so a state without assignments hashes as before. A member who is not the owner or a lead leaves only a card they assigned themselves.
export interface WorkItem {
  id: string; kind: ItemKind; title: string; parentId?: string; gsd?: ItemGsdRef; dependsOn: string[]; scope: string[]; requirements: string[]; mustHaves: string[];
  estimate?: { tokens: number; nanoUsd?: number; confidence?: 'low' | 'medium' | 'high' }; state: ItemState; blocked?: { reason: string; by: string; since: string };
  claimId?: string; tags: string[]; ringFenceNanoUsd?: number;
  origin: ItemOrigin; stateSince: string; createdBy?: string; description?: string; hold?: true; summary?: true; active?: true; source?: string;
  assignee?: string; assignedBy?: string;
}
export interface Claim { id: string; itemId: string; memberId: string; branch: string; base: string; leaseIds: string[]; startedAt: string; lastHeartbeatAt: string; status: 'active' | 'in-review' | 'integrating' | 'released' | 'expired' | 'handed-off' | 'merged'; spend: SpendSummary }
export interface Lease { id: string; claimId?: string; holder: string; kind: 'paths' | 'resource'; paths?: string[]; resource?: string; grantedAt: string; ttlMinutes: number; parentLeaseId?: string }
export interface Allocation { id: string; memberId: string; nanoUsd: number; scope?: { milestone?: string; phase?: string; itemId?: string }; period: string; grantedBy: string }
export interface LogHead { eventId: string; lamport: number }
export interface Rejection { eventId: string; reason: string }
export interface GenesisAnchor { teamId: string; eventId: string; ownerDevice: DeviceRef }
export interface SnapshotRef { path: string; coversThrough: string; lamport: number; stateHash: string; eventId: string }
export interface TeamState {
  team: { id: string; name: string; ownerId: string; policy: TeamPolicy; near?: NearLink };
  members: Map<string, Member>; deviceIndex: Map<string, string>;            // fingerprint -> memberId
  items: Map<string, WorkItem>; claims: Map<string, Claim>; leases: Map<string, Lease>; allocations: Allocation[];
  budget: { periodNanoUsd: number; period: string }; integrationQueue: string[]; stopped: boolean;
  head: LogHead; highLamport: number; accepted: number; seenEventIds: Set<string>;
  rejected: Rejection[]; snapshots: SnapshotRef[]; genesis: GenesisAnchor; refused?: string;
}
export interface TeamFile { version: 1; teamId: string; name: string; coordination: { transport: 'git'; ref: string; remote: string }; genesis: { eventId: string; ownerDevice: DeviceRef }; near?: NearLink; createdAt: string }

export type EntryKind = 'event' | 'snapshot' | 'genesis-copy' | 'anomaly';
// authorRole is the author's role at this log position, read before the event's own transition runs.
export type EntryVerdict = { accepted: true; event?: TeamEvent; authorRole?: Role } | { accepted: false; rejection: Rejection };
export interface CommittedEvent { commit: string; commitTime: number; path: string; blob: string; size: number; text: string; kind: EntryKind; anomaly?: string; verdict?: EntryVerdict }
// commitTime is the time the candidate would carry once committed, in seconds. It is 0 (unknown) when the caller has none.
export interface Materializer<S> { initial(): S; apply(state: S, entry: CommittedEvent): EntryVerdict; head(state: S): LogHead; check(state: S, events: TeamEvent[], commitTime?: number): Rejection | undefined }

export const TEAM_REJECTION_REASONS = {
  malformed: 'malformed event', notCanonical: 'event file is not canonical', tooLarge: 'event is larger than 16 KB',
  unsupported: 'unsupported event type for this version', invalidBody: 'invalid event body', fileName: 'file name does not match the event',
  wrongTeam: 'event belongs to another team', duplicate: 'duplicate event id', unboundDevice: 'device is not bound to the author',
  revokedDevice: 'device was revoked before this event', removedAuthor: 'author was removed before this event', badSignature: 'signature is not valid',
  lamportNotGreater: 'lamport is not greater than the highest seen', lamportJump: 'lamport jump too large',
  prevMismatch: 'prev does not name the log head',
  genesisOnly: 'team.created is only valid as the first event', ownerJoinOnly: 'only the owner joins at genesis in this version',
  notPermitted: 'not permitted', memberMissing: 'referenced member does not exist', memberRemoved: 'referenced member was removed',
  deviceTaken: 'device is already registered', deviceNotBound: 'referenced device is not bound to that member', deviceRevoked: 'device is already revoked',
  lastDevice: 'cannot revoke the last active device of a member', snapshotMismatch: 'snapshot does not match the replayed state',
  snapshotOrphan: 'snapshot file without a matching snapshot.written event', historyChanged: 'history changed an existing coordination file',
  mergeCommit: 'merge commit on the coordination branch', unexpectedPath: 'unexpected file on the coordination branch',
  notInvited: 'no unused invitation for this member', inviteProof: 'invite code proof is not valid', inviteExpired: 'the invitation expired before this join',
  inviteRole: 'joined role does not match the invitation', inviteEmail: 'joined email does not match the invitation',
  keyReused: 'this key was already delivered', keyDevices: "sealed devices do not match the member's active devices", noSealKey: 'a device has no key for sealed delivery',
  alreadyInvited: 'this email is already a member or invited', memberTaken: 'member id is already in use', notJoined: 'member has not joined yet',
  itemExists: 'item already exists', itemMissing: 'referenced item does not exist', itemParent: 'parent item does not exist or has the wrong kind',
  itemState: 'item cannot make that move from its current state', itemBlocked: 'item is blocked', itemNotBlocked: 'item is not blocked',
  itemTerminal: 'item is already done or cancelled', itemField: 'that change is not allowed on this item',
  itemNotAssignable: 'only plans, phases and board items can be assigned', assigneeNotEligible: 'that person cannot be assigned this item',
  itemAlreadyAssigned: 'item is already assigned to that person', itemNotAssigned: 'item is not assigned to anyone',
  logRefused: "This coordination log does not belong to this project's team",
  logRewritten: "The team's coordination log was rewritten on the remote; Team Mode is paused"
} as const;
