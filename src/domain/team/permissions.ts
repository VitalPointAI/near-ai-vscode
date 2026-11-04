// Role-by-action decisions for Team Mode (spec 6.3, D-12, D-30, D-32). Pure: no I/O, no vscode.
// The matrix is data so a reviewer can diff it against the spec row by row. The same decision runs when an
// event is written (refuse locally) and when it is read (reject at that log position).
import type { ImplementedTeamEvent, ItemKind, Role, TeamState } from './types';
import { isOwnDraft } from './work';

export type TeamActionKind = 'board.view' | 'metrics.view-own' | 'metrics.view-all' | 'member.invite' | 'member.remove' | 'member.change-role'
  | 'item.create' | 'item.edit' | 'item.estimate' | 'item.move' | 'item.move-own' | 'item.claim' | 'item.assign' | 'item.assign-self' | 'lease.manual' | 'review.submit'
  | 'merge.approve-out-of-scope' | 'lease.integrator' | 'budget.set' | 'allocation.grant' | 'allocation.revoke' | 'allocation.request'
  | 'team.stop' | 'team.resume' | 'policy.change' | 'device.add' | 'device.revoke' | 'member.availability' | 'member.skills' | 'snapshot.write' | 'member.key-deliver';

export type TeamAction =
  | { kind: 'board.view' | 'metrics.view-own' | 'metrics.view-all' | 'member.invite' | 'item.assign' | 'item.assign-self' | 'item.move' | 'item.move-own' | 'lease.manual' | 'merge.approve-out-of-scope' | 'lease.integrator' | 'allocation.request' | 'team.stop' | 'team.resume' | 'policy.change' | 'member.availability' | 'snapshot.write' }
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
  // Lifecycle moves (hold, release, mark done, block, unblock, cancel, reopen) and import: not in the spec 6.3 table, which has no transition row;
  // D-12 names the owner and leads for every move this phase, and the claimant joins in Phase 63.
  'item.move': MANAGERS,
  // Owner decision 2026-11-04 (G-62-5, 62-27): the card's current assignee, whoever assigned it, makes the board moves on that card (mark done,
  // block and unblock, hold and release, reopen from Done). Cancel and bringing back a cancelled card stay on item.move. actionForEvent picks it.
  'item.move-own': EVERYONE_ACTIVE,
  'item.claim': row(true, true, true, 'review-items', false),
  'item.assign': MANAGERS,
  // Owner decision 2026-11-03 (G-62-5, 62-25): any confirmed member who is not an observer puts themselves on an unassigned card and takes
  // themselves off their own card. A joined member still waiting for a lead is an observer until confirmed, so this row refuses them too.
  'item.assign-self': EVERYONE_ACTIVE,
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
  'item.move': 'moving items',
  'item.move-own': 'moving cards assigned to them',
  'item.claim': 'claiming items',
  'item.assign': 'assigning items to others',
  'item.assign-self': 'assigning items to themselves',
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
// The item events need the state to answer "is this the author's own draft"; callers that pass none get ownDraft false, which is only
// ever the stricter answer. Both the reader and prepareEvents pass the state as it stands before the event.
export function actionForEvent(event: ImplementedTeamEvent, state?: Pick<TeamState, 'items'>): TeamAction | undefined {
  const ownDraft = (itemId: string): boolean => state !== undefined && isOwnDraft(state, itemId, event.author);
  // The card's assignee before the event; null when there is no state to ask, so the self path is never taken without one.
  const assigneeBefore = (itemId: string): string | undefined | null => (state === undefined ? null : state.items.get(itemId)?.assignee);
  // A move on the card is the author's own when the author is its assignee before the event (62-27); without a state it is item.move, the stricter one.
  const moveBy = (itemId: string): TeamAction => {
    const assignee = state?.items.get(itemId)?.assignee;
    return { kind: assignee !== undefined && assignee === event.author ? 'item.move-own' : 'item.move' };
  };
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
    case 'item.imported': return { kind: 'item.create', ownDraft: false };
    case 'item.created': return { kind: 'item.create', ownDraft: true };
    case 'item.updated': {
      const changes = event.body.changes;
      const isMove = Object.prototype.hasOwnProperty.call(changes, 'hold') || Object.prototype.hasOwnProperty.call(changes, 'state');
      return isMove ? moveBy(event.body.id) : { kind: 'item.edit', ownDraft: ownDraft(event.body.id) };
    }
    case 'item.estimated': return { kind: 'item.estimate', ownDraft: ownDraft(event.body.id) };
    // Owner decision 2026-11-04 (62-27): the assignee's own moves are item.move-own. A cancel is always item.move, and so is a reopen of
    // anything but a finished card, so a cancelled card comes back only through the owner or a lead.
    case 'item.blocked':
    case 'item.unblocked':
      return moveBy(event.body.id);
    case 'item.cancelled':
      return { kind: 'item.move' };
    case 'item.reopened':
      return state?.items.get(event.body.id)?.state === 'done' ? moveBy(event.body.id) : { kind: 'item.move' };
    // G-62-5: putting a person on a card, or taking them off, is the spec 6.3 "assign or reassign others" row: owner and lead.
    // Owner decision 2026-11-03 (62-25): a member's own assignment is item.assign-self, but only when it takes nothing from a teammate. Assigning
    // yourself counts when the card has no assignee, or is already yours (the rules then refuse the repeat with itemAlreadyAssigned); taking
    // someone off counts when that someone is you (narrowed by 62-26 below to a card you also assigned yourself). Everything else, including taking a teammate's card, stays item.assign, so a teammate's card
    // changes hands only when they unassign themselves or a lead reassigns it. Without a state the answer is item.assign, the stricter one.
    case 'item.assigned': {
      const before = assigneeBefore(event.body.id);
      const own = before !== null && event.body.memberId === event.author && (before === undefined || before === event.author);
      return { kind: own ? 'item.assign-self' : 'item.assign' };
    }
    // Owner decision 2026-11-04 (62-26): taking yourself off counts as your own only when you are the card's assignee and also made that
    // assignment. A card the owner or a lead gave you stays on their row until one of them changes it.
    case 'item.unassigned': {
      const item = state?.items.get(event.body.id);
      return { kind: item !== undefined && item.assignee === event.author && item.assignedBy === event.author ? 'item.assign-self' : 'item.assign' };
    }
  }
}
