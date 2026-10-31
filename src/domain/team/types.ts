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

// Spec 5.2, all 54 types in spec order: roster(9) work(8) claims(9) leases(5) integration(7) budget(8) collaboration(4) control(4)
export const TEAM_EVENT_TYPES = ['team.created', 'member.invited', 'member.joined', 'member.role-changed', 'member.removed', 'device.added', 'device.revoked', 'member.availability', 'member.skills', 'item.imported', 'item.created', 'item.updated', 'item.estimated', 'item.blocked', 'item.unblocked', 'item.cancelled', 'item.reopened', 'claim.offered', 'claim.accepted', 'claim.declined', 'claim.taken', 'claim.heartbeat', 'claim.released', 'claim.handed-off', 'claim.expired', 'claim.progress', 'lease.granted', 'lease.extended', 'lease.requested', 'lease.released', 'lease.expired', 'integration.queued', 'integration.started', 'integration.verified', 'integration.failed', 'review.requested', 'review.submitted', 'integration.merged', 'budget.set', 'allocation.granted', 'allocation.revoked', 'allocation.requested', 'allocation.decided', 'spend.summary', 'spend.reconciled', 'budget.alert', 'comment.added', 'mention', 'handoff.note', 'decision.recorded', 'team.stop', 'team.resume', 'policy.changed', 'snapshot.written'] as const;
export type TeamEventType = typeof TEAM_EVENT_TYPES[number];

export interface DeviceRef { fingerprint: string; publicKey: string }            // dev-<32 hex>, base64url of 32 raw bytes
export interface WorkingHours { tz: string; days: number[]; start: string; end: string }
export interface NearLink { organizationId: string; workspaceId: string }
export interface TeamCreatedBody { name: string; ownerId: string; ownerName: string; ownerEmailHashes: string[]; ownerDevice: DeviceRef; policy: TeamPolicy; near?: NearLink }
export interface MemberJoinedBody { memberId: string; name: string; emailHashes: string[]; role: Role; device: DeviceRef }
export interface MemberRoleChangedBody { memberId: string; role: Role }
export interface MemberRemovedBody { memberId: string }
export interface DeviceAddedBody { memberId: string; device: DeviceRef }
export interface DeviceRevokedBody { memberId: string; fingerprint: string }
export interface MemberAvailabilityBody { availability: Availability; workingHours?: WorkingHours }
export interface MemberSkillsBody { memberId: string; skills: string[] }
export interface PolicyChangedBody { changes: Partial<TeamPolicy> }
export interface SnapshotWrittenBody { coversThrough: string; lamport: number; stateHash: string; path: string }
export interface ImplementedEventBodies { 'team.created': TeamCreatedBody; 'member.joined': MemberJoinedBody; 'member.role-changed': MemberRoleChangedBody; 'member.removed': MemberRemovedBody; 'device.added': DeviceAddedBody; 'device.revoked': DeviceRevokedBody; 'member.availability': MemberAvailabilityBody; 'member.skills': MemberSkillsBody; 'policy.changed': PolicyChangedBody; 'snapshot.written': SnapshotWrittenBody }
export type ImplementedEventType = keyof ImplementedEventBodies;
export const IMPLEMENTED_EVENT_TYPES: readonly ImplementedEventType[] = ['team.created', 'member.joined', 'member.role-changed', 'member.removed', 'device.added', 'device.revoked', 'member.availability', 'member.skills', 'policy.changed', 'snapshot.written'];
export type TeamEventBodyMap = ImplementedEventBodies & { [K in Exclude<TeamEventType, ImplementedEventType>]: JsonObject };
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
export interface DeviceKey { fingerprint: string; publicKey: string; addedBy: string; addedEvent: string; revokedEvent?: string; revokedBy?: string }
export interface Member { id: string; name: string; emailHashes: string[]; role: Role; devices: DeviceKey[]; skills: string[]; availability: Availability; workingHours?: WorkingHours; wipLimit: number; nearApiKeyId?: string; joinedAt: string; joinedEvent: string; removedAt?: string; removedEvent?: string }

// Spec 7 shapes declared now for later phases (money is integer nano-USD):
export interface SpendSummary { inputTokens: number; cachedInputTokens: number; outputTokens: number; confirmedNanoUsd: number; pendingNanoUsd: number; estimatedNanoUsd: number; requests: number }
export interface WorkItem { id: string; kind: ItemKind; title: string; parentId?: string; gsd?: { phase: string; plan?: string; wave?: number; file?: string }; dependsOn: string[]; scope: string[]; requirements: string[]; mustHaves: string[]; estimate?: { tokens: number; nanoUsd?: number; confidence?: 'low' | 'medium' | 'high' }; state: ItemState; blocked?: { reason: string; by: string; since: string }; claimId?: string; tags: string[]; ringFenceNanoUsd?: number }
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
export type EntryVerdict = { accepted: true; event?: TeamEvent } | { accepted: false; rejection: Rejection };
export interface CommittedEvent { commit: string; commitTime: number; path: string; blob: string; size: number; text: string; kind: EntryKind; anomaly?: string; verdict?: EntryVerdict }
export interface Materializer<S> { initial(): S; apply(state: S, entry: CommittedEvent): EntryVerdict; head(state: S): LogHead; check(state: S, events: TeamEvent[]): Rejection | undefined }

export const TEAM_REJECTION_REASONS = {
  malformed: 'malformed event', notCanonical: 'event file is not canonical', tooLarge: 'event is larger than 16 KB',
  unsupported: 'unsupported event type for this version', invalidBody: 'invalid event body', fileName: 'file name does not match the event',
  wrongTeam: 'event belongs to another team', duplicate: 'duplicate event id', unboundDevice: 'device is not bound to the author',
  revokedDevice: 'device was revoked before this event', removedAuthor: 'author was removed before this event', badSignature: 'signature is not valid',
  lamportNotGreater: 'lamport is not greater than the highest seen', lamportJump: 'lamport jump too large',
  genesisOnly: 'team.created is only valid as the first event', ownerJoinOnly: 'only the owner joins at genesis in this version',
  notPermitted: 'not permitted', memberMissing: 'referenced member does not exist', memberRemoved: 'referenced member was removed',
  deviceTaken: 'device is already registered', deviceNotBound: 'referenced device is not bound to that member', deviceRevoked: 'device is already revoked',
  lastDevice: 'cannot revoke the last active device of a member', snapshotMismatch: 'snapshot does not match the replayed state',
  snapshotOrphan: 'snapshot file without a matching snapshot.written event', historyChanged: 'history changed an existing coordination file',
  mergeCommit: 'merge commit on the coordination branch', unexpectedPath: 'unexpected file on the coordination branch',
  logRefused: "This coordination log does not belong to this project's team",
  logRewritten: "The team's coordination log was rewritten on the remote; Team Mode is paused"
} as const;
