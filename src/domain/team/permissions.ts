// Role-by-action decisions for Team Mode (spec 6.3, D-12, D-30, D-32). Pure: no I/O, no vscode.
// The matrix is data so a reviewer can diff it against the spec row by row. The same decision runs when an
// event is written (refuse locally) and when it is read (reject at that log position).
import type { ImplementedTeamEvent, ItemKind, Role, TeamState } from './types';

export type TeamActionKind = 'board.view' | 'metrics.view-own' | 'metrics.view-all' | 'member.invite' | 'member.remove' | 'member.change-role'
  | 'item.create' | 'item.edit' | 'item.estimate' | 'item.claim' | 'item.assign' | 'lease.manual' | 'review.submit'
  | 'merge.approve-out-of-scope' | 'lease.integrator' | 'budget.set' | 'allocation.grant' | 'allocation.revoke' | 'allocation.request'
  | 'team.stop' | 'team.resume' | 'policy.change' | 'device.add' | 'device.revoke' | 'member.availability' | 'member.skills' | 'snapshot.write' | 'member.key-deliver';

export type TeamAction =
  | { kind: 'board.view' | 'metrics.view-own' | 'metrics.view-all' | 'member.invite' | 'item.assign' | 'lease.manual' | 'merge.approve-out-of-scope' | 'lease.integrator' | 'allocation.request' | 'team.stop' | 'team.resume' | 'policy.change' | 'member.availability' | 'snapshot.write' }
  | { kind: 'member.remove'; targetId: string }
  | { kind: 'member.key-deliver'; targetId: string }
  | { kind: 'member.change-role'; targetId: string; role: Role }
  | { kind: 'item.create' | 'item.edit' | 'item.estimate'; ownDraft: boolean }
  | { kind: 'item.claim'; itemKind: ItemKind }
  | { kind: 'review.submit'; ownWork: boolean }
  | { kind: 'budget.set' | 'allocation.grant' | 'allocation.revoke'; withinTeamBudget: boolean }
  | { kind: 'device.add' | 'device.revoke'; memberId: string }
  | { kind: 'member.skills'; memberId: string };

export type PermissionRule = boolean | 'policy:peerMetricsVisible' | 'policy:developerMayIntegrate' | 'own-draft' | 'review-items' | 'not-own-work' | 'within-team-budget' | 'self' | 'self-or-manager';
export type PermissionView = Pick<TeamState, 'team' | 'members'>;
export interface TeamDecision { allowed: boolean; reason?: string }

type Row = Readonly<Record<Role, PermissionRule>>;

// Column order is owner, lead, developer, reviewer, observer, exactly as in spec 6.3.
function row(owner: PermissionRule, lead: PermissionRule, developer: PermissionRule, reviewer: PermissionRule, observer: PermissionRule): Row {
  return Object.freeze({ owner, lead, developer, reviewer, observer });
}

const MANAGERS = row(true, true, false, false, false);
const EVERYONE_ACTIVE = row(true, true, true, true, false);

export const PERMISSION_MATRIX: Readonly<Record<TeamActionKind, Row>> = Object.freeze({
  'board.view': row(true, true, true, true, true),
  'metrics.view-own': row(true, true, true, true, true),
  'metrics.view-all': row(true, true, 'policy:peerMetricsVisible', 'policy:peerMetricsVisible', false),
  'member.invite': MANAGERS,
  'member.remove': MANAGERS,
  'member.change-role': MANAGERS,
  'item.create': row(true, true, 'own-draft', false, false),
  'item.edit': row(true, true, 'own-draft', false, false),
  'item.estimate': row(true, true, 'own-draft', false, false),
  'item.claim': row(true, true, true, 'review-items', false),
  'item.assign': MANAGERS,
  'lease.manual': MANAGERS,
  'review.submit': row(true, true, 'not-own-work', 'not-own-work', false),
  'merge.approve-out-of-scope': MANAGERS,
  'lease.integrator': row(true, true, 'policy:developerMayIntegrate', false, false),
  'budget.set': row(true, 'within-team-budget', false, false, false),
  'allocation.grant': row(true, 'within-team-budget', false, false, false),
  'allocation.revoke': row(true, 'within-team-budget', false, false, false),
  'allocation.request': EVERYONE_ACTIVE,
  'team.stop': EVERYONE_ACTIVE,
  'team.resume': MANAGERS,
  'policy.change': row(true, false, false, false, false),
  'device.add': row(true, true, 'self', 'self', 'self'),
  'device.revoke': row(true, true, 'self', 'self', 'self'),
  'member.availability': row(true, true, true, true, true),
  'member.skills': row('self-or-manager', 'self-or-manager', 'self-or-manager', 'self-or-manager', 'self-or-manager'),
  'snapshot.write': MANAGERS,
  'member.key-deliver': MANAGERS
});

export const ACTION_LABELS: Readonly<Record<TeamActionKind, string>> = Object.freeze({
  'board.view': 'viewing the board',
  'metrics.view-own': 'viewing your own metrics',
  'metrics.view-all': "viewing everyone's metrics",
  'member.invite': 'inviting members',
  'member.remove': 'removing members',
  'member.change-role': 'changing roles',
  'item.create': 'creating items',
  'item.edit': 'editing items',
  'item.estimate': 'estimating items',
  'item.claim': 'claiming items',
  'item.assign': 'assigning items to others',
  'lease.manual': 'granting or revoking leases',
  'review.submit': 'submitting reviews',
  'merge.approve-out-of-scope': 'approving out-of-scope merges',
  'lease.integrator': 'holding the integrator lease',
  'budget.set': 'setting budgets',
  'allocation.grant': 'granting allocations',
  'allocation.revoke': 'revoking allocations',
  'allocation.request': 'requesting allocations',
  'team.stop': 'stopping the team',
  'team.resume': 'resuming the team',
  'policy.change': 'changing team policy',
  'device.add': 'adding devices',
  'device.revoke': 'revoking devices',
  'member.availability': 'setting availability',
  'member.skills': 'editing skills',
  'snapshot.write': 'writing snapshots',
  'member.key-deliver': 'delivering team API keys'
});

export const PERMISSION_REASONS = {
  notMember: 'the author is not a member of this team',
  removed: 'the author was removed from this team',
  singleOwner: 'a team has exactly one owner and ownership cannot be transferred',
  ownRole: 'nobody can change their own role',
  leadOnOwner: 'a lead cannot act on the owner',
  ownerCannotBeRemoved: 'the owner cannot be removed',
  leadOnOwnerDevice: 'a lead cannot add or revoke a device of the owner',
  policyOwnerOnly: 'only the owner can change team policy',
  ownerKey: "the owner's NEAR key is not delivered through the team log"
} as const;

// Added after the role and action label to explain why a conditional cell said no.
const RULE_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  'policy:peerMetricsVisible': ' under the current team policy',
  'policy:developerMayIntegrate': ' under the current team policy',
  'own-draft': ' unless it is your own draft',
  'review-items': ' unless it is a review item',
  'not-own-work': ' on your own work',
  'within-team-budget': ' beyond the team budget',
  'self': ' for another member',
  'self-or-manager': ' for another member'
});

function deny(reason: string): TeamDecision { return { allowed: false, reason }; }

function cellAllows(rule: PermissionRule, state: PermissionView, role: Role, actorId: string, action: TeamAction): boolean {
  if (typeof rule === 'boolean') { return rule; }
  switch (rule) {
    case 'policy:peerMetricsVisible': return state.team.policy.peerMetricsVisible;
    case 'policy:developerMayIntegrate': return state.team.policy.developerMayIntegrate;
    case 'own-draft': return 'ownDraft' in action && action.ownDraft;
    case 'review-items': return 'itemKind' in action && action.itemKind === 'review';
    case 'not-own-work': return 'ownWork' in action && !action.ownWork;
    case 'within-team-budget': return 'withinTeamBudget' in action && action.withinTeamBudget;
    case 'self': return 'memberId' in action && action.memberId === actorId;
    case 'self-or-manager': return role === 'owner' || role === 'lead' || ('memberId' in action && action.memberId === actorId);
  }
}

// Rules that hold whatever the cell says (D-12, D-32). Only reached when the cell allowed the action.
function overrideDenial(state: PermissionView, role: Role, actorId: string, action: TeamAction): string | undefined {
  const ownerId = state.team.ownerId;
  switch (action.kind) {
    case 'member.change-role':
      if (action.role === 'owner') { return PERMISSION_REASONS.singleOwner; }
      if (action.targetId === actorId) { return PERMISSION_REASONS.ownRole; }
      if (action.targetId === ownerId && role === 'lead') { return PERMISSION_REASONS.leadOnOwner; }
      return undefined;
    case 'member.remove':
      if (action.targetId !== ownerId) { return undefined; }
      return role === 'lead' ? PERMISSION_REASONS.leadOnOwner : PERMISSION_REASONS.ownerCannotBeRemoved;
    case 'member.key-deliver':
      return action.targetId === ownerId ? PERMISSION_REASONS.ownerKey : undefined;
    case 'device.add':
    case 'device.revoke':
      return action.memberId === ownerId && role === 'lead' ? PERMISSION_REASONS.leadOnOwnerDevice : undefined;
    default:
      return undefined;
  }
}

export function decideTeamAction(state: PermissionView, actorId: string, action: TeamAction): TeamDecision {
  const actor = state.members.get(actorId);
  if (!actor) { return deny(PERMISSION_REASONS.notMember); }
  if (actor.removedEvent !== undefined) { return deny(PERMISSION_REASONS.removed); }
  const rule = PERMISSION_MATRIX[action.kind][actor.role];
  if (!cellAllows(rule, state, actor.role, actorId, action)) {
    if (action.kind === 'policy.change') { return deny(PERMISSION_REASONS.policyOwnerOnly); }
    const suffix = typeof rule === 'string' ? (RULE_SUFFIX[rule] ?? '') : '';
    return deny(`the ${actor.role} role does not allow ${ACTION_LABELS[action.kind]}${suffix}`);
  }
  const override = overrideDenial(state, actor.role, actorId, action);
  return override === undefined ? { allowed: true } : deny(override);
}

// Maps an accepted event to the matrix action, so the read path asks the same question the write path asked.
// Genesis events (team.created, member.joined) are validated by the materializer's genesis rules instead.
export function actionForEvent(event: ImplementedTeamEvent): TeamAction | undefined {
  switch (event.type) {
    case 'team.created':
    case 'member.joined':
      return undefined;
    case 'member.invited': return { kind: 'member.invite' };
    case 'member.role-changed': return { kind: 'member.change-role', targetId: event.body.memberId, role: event.body.role };
    case 'member.removed': return { kind: 'member.remove', targetId: event.body.memberId };
    case 'device.added': return { kind: 'device.add', memberId: event.body.memberId };
    case 'device.revoked': return { kind: 'device.revoke', memberId: event.body.memberId };
    case 'member.availability': return { kind: 'member.availability' };
    case 'member.skills': return { kind: 'member.skills', memberId: event.body.memberId };
    case 'policy.changed': return { kind: 'policy.change' };
    case 'snapshot.written': return { kind: 'snapshot.write' };
    case 'member.key-sealed': return { kind: 'member.key-deliver', targetId: event.body.memberId };
  }
}
