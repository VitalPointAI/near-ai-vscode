// Work items (spec 6.4, D-04, D-10 to D-14): id shapes and the one pure function that decides whether an item event may move an item.
// The same transitionProblem runs when an event is written (the transport replays the batch through the materialiser) and when it is read,
// so a refusal on one side is a rejection on the other. Pure: no I/O, no clock, no vscode.
// permissions.ts imports isOwnDraft from here and this file asks it the item.claim question. Both modules only call each other at run time,
// never while loading, so the cycle is safe in either load order.
import { decideTeamAction } from './permissions';
import { TEAM_REJECTION_REASONS } from './types';
import type { ImplementedTeamEvent, ItemChanges, ItemKind, TeamState, WorkItem } from './types';

export const GSD_ITEM_ID_PATTERN = /^(milestone|phase|plan|task):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const BOARD_ITEM_ID_PATTERN = /^item:[0-9A-HJKMNP-TV-Z]{26}$/;

const R = TEAM_REJECTION_REASONS;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u2028\u2029]/;
const MAX_SCOPE_LENGTH = 200;
const GSD_KINDS: readonly string[] = ['milestone', 'phase', 'plan', 'task'];

// The kind an imported id names, or undefined for a board id or anything else.
export function itemKindOf(id: string): ItemKind | undefined {
  if (!GSD_ITEM_ID_PATTERN.test(id)) return undefined;
  const prefix = id.slice(0, id.indexOf(':'));
  return GSD_KINDS.includes(prefix) ? (prefix as ItemKind) : undefined;
}

// A scope entry is a relative POSIX path or glob (the rule policy.ts applies to shared paths), capped at 200 characters.
export function isScopePattern(value: string): boolean {
  if (value.length < 1 || value.length > MAX_SCOPE_LENGTH || CONTROL_CHARACTERS.test(value) || value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  return !value.split('/').includes('..');
}

// Stored backlog and stored ready are the same unclaimed set: ready is computed, and a removed member's released claim stores ready (Phase 61).
export function isUnclaimed(item: WorkItem): boolean {
  return item.state === 'backlog' || item.state === 'ready';
}

function isTerminal(item: WorkItem): boolean {
  return item.state === 'done' || item.state === 'cancelled';
}

// A developer may edit or estimate only a board item they created that nobody has claimed (spec 6.3 "own draft").
export function isOwnDraft(state: Pick<TeamState, 'items'>, itemId: string, authorId: string): boolean {
  const item = state.items.get(itemId);
  return item !== undefined && item.origin === 'board' && item.createdBy === authorId && isUnclaimed(item) && item.claimId === undefined;
}

// Only plans and board items move through states (D-08); milestones, phases and tasks are graph nodes.
function movesThroughStates(item: WorkItem): boolean {
  return item.kind === 'plan' || item.origin === 'board';
}

// A held phase is a frozen phase, so a phase can be held although it never moves through the other states.
function canBeHeld(item: WorkItem): boolean {
  return item.kind === 'plan' || item.kind === 'phase' || item.origin === 'board';
}

const PARENT_KIND: Readonly<Record<string, ItemKind>> = { phase: 'milestone', plan: 'phase', task: 'plan' };

function importProblem(state: Pick<TeamState, 'items'>, body: { id: string; kind: string; parentId?: string }): string | undefined {
  if (state.items.has(body.id)) return R.itemExists;
  const wanted = PARENT_KIND[body.kind];
  if (wanted === undefined) return undefined;
  const parent = body.parentId === undefined ? undefined : state.items.get(body.parentId);
  return parent !== undefined && parent.kind === wanted ? undefined : R.itemParent;
}

const BOARD_EDITABLE: readonly string[] = ['title', 'description', 'scope', 'tags'];
const IMPORT_EDITABLE: readonly string[] = ['title', 'dependsOn', 'scope', 'requirements', 'mustHaves', 'estimate', 'gsd', 'tags', 'summary', 'active', 'source'];

function hasOwn(changes: ItemChanges, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(changes, key);
}

// summary is for plans and active and source for milestones, whatever the origin rule says.
function importedKeyAllowed(item: WorkItem, key: string): boolean {
  if (!IMPORT_EDITABLE.includes(key)) return false;
  if (key === 'summary') return item.kind === 'plan';
  if (key === 'active' || key === 'source') return item.kind === 'milestone';
  return true;
}

function contentProblem(item: WorkItem, changes: ItemChanges): string | undefined {
  const allowed = item.origin === 'board'
    ? (key: string): boolean => BOARD_EDITABLE.includes(key)
    : (key: string): boolean => importedKeyAllowed(item, key);
  return Object.keys(changes).every(allowed) ? undefined : R.itemField;
}

function holdProblem(item: WorkItem, hold: boolean): string | undefined {
  if (!hold) return item.hold === true ? undefined : R.itemState;
  if (isTerminal(item)) return R.itemTerminal;
  return canBeHeld(item) && isUnclaimed(item) && item.hold !== true ? undefined : R.itemState;
}

function markDoneProblem(item: WorkItem): string | undefined {
  if (isTerminal(item)) return R.itemTerminal;
  if (!movesThroughStates(item) || !isUnclaimed(item)) return R.itemState;
  return item.blocked === undefined ? undefined : R.itemBlocked;
}

function updateProblem(item: WorkItem, changes: ItemChanges): string | undefined {
  if (hasOwn(changes, 'hold')) return holdProblem(item, changes.hold === true);
  if (hasOwn(changes, 'state')) return markDoneProblem(item);
  return contentProblem(item, changes);
}

function blockProblem(item: WorkItem): string | undefined {
  if (isTerminal(item)) return R.itemTerminal;
  if (!movesThroughStates(item)) return R.itemState;
  return item.blocked === undefined ? undefined : R.itemBlocked;
}

function withItem(state: Pick<TeamState, 'items'>, id: string, problem: (item: WorkItem) => string | undefined): string | undefined {
  const item = state.items.get(id);
  return item === undefined ? R.itemMissing : problem(item);
}

function estimateProblem(item: WorkItem): string | undefined {
  if (item.origin !== 'board') return R.itemField;
  return isTerminal(item) ? R.itemTerminal : undefined;
}

// G-62-5: the kinds a person can be put on. Plans and phases come from the import, bugs, chores and spikes from the board; milestones and
// tasks are graph nodes nobody works on directly, and review items wait for the phase that makes them.
const ASSIGNABLE_KINDS: readonly ItemKind[] = ['plan', 'phase', 'bug', 'chore', 'spike'];

export type AssignmentView = Pick<TeamState, 'items' | 'members' | 'team'>;

// A current, confirmed member who may claim this kind of item: not removed, not an unused invitation, not waiting for a lead to confirm a role,
// and allowed the item.claim decision for the kind (owner, lead or developer for every assignable kind today). It follows the claim row, so a
// change there changes who can be assigned.
export function mayBeAssigned(state: Pick<TeamState, 'members' | 'team'>, memberId: string, itemKind: ItemKind): boolean {
  const member = state.members.get(memberId);
  if (member === undefined || member.removedEvent !== undefined || member.status === 'invited' || member.pendingRole !== undefined) return false;
  return decideTeamAction(state, memberId, { kind: 'item.claim', itemKind }).allowed;
}

// The order is fixed so every client gives the same reason: the item, its kind, its state, the person, then a repeat of the same person (refused
// so the log never carries a no-op). Assignment is not a state change, so a held or blocked card can be assigned.
function assignProblem(state: AssignmentView, item: WorkItem, memberId: string): string | undefined {
  if (!ASSIGNABLE_KINDS.includes(item.kind)) return R.itemNotAssignable;
  if (isTerminal(item)) return R.itemTerminal;
  if (!mayBeAssigned(state, memberId, item.kind)) return R.assigneeNotEligible;
  return item.assignee === memberId ? R.itemAlreadyAssigned : undefined;
}

// The rejection reason an item event earns at its log position, or undefined when it may apply. Events that are not item events pass.
// No rule here can put an item into claimed, in-progress, in-review or integrating (D-13): the only states these events set are
// backlog, done and cancelled, and every move that needs a claim or an integration waits for the phase that owns it.
// The state carries the members and the team as well as the items, because an assignment names a person (G-62-5); both callers hold a full state.
export function transitionProblem(state: AssignmentView, event: ImplementedTeamEvent): string | undefined {
  switch (event.type) {
    case 'item.imported': return importProblem(state, event.body);
    case 'item.created': return state.items.has(event.body.id) ? R.itemExists : undefined;
    case 'item.updated': return withItem(state, event.body.id, (item) => updateProblem(item, event.body.changes));
    case 'item.estimated': return withItem(state, event.body.id, estimateProblem);
    case 'item.blocked': return withItem(state, event.body.id, blockProblem);
    case 'item.unblocked': return withItem(state, event.body.id, (item) => (item.blocked === undefined ? R.itemNotBlocked : undefined));
    case 'item.cancelled': return withItem(state, event.body.id, (item) => (isTerminal(item) ? R.itemTerminal : undefined));
    case 'item.reopened': return withItem(state, event.body.id, (item) => (isTerminal(item) ? undefined : R.itemState));
    case 'item.assigned': return withItem(state, event.body.id, (item) => assignProblem(state, item, event.body.memberId));
    // Taking a person off is allowed in any state, so a finished or cancelled card can still be cleared.
    case 'item.unassigned': return withItem(state, event.body.id, (item) => (item.assignee === undefined ? R.itemNotAssigned : undefined));
    default: return undefined;
  }
}

// ---- Board model (D-08, D-10, D-11, D-17) ------------------------------------------------------------------------------------------------
// Everything below is derived from the items alone: pure, no clock, no I/O, so every client that replays the same log shows the same board.
export const BOARD_COLUMNS = ['backlog', 'ready', 'claimed', 'in-progress', 'in-review', 'integrating', 'done', 'cancelled'] as const;
export type BoardColumn = typeof BOARD_COLUMNS[number];
export type NotReadyReason = 'not-unclaimed' | 'held' | 'blocked' | 'no-estimate' | 'no-scope' | 'dependency-open' | 'dependency-missing' | 'phase-held' | 'phase-dependency-open';

type Items = ReadonlyMap<string, WorkItem>;

// Cards are what moves through the columns: plans and anything created on the board. Milestones, phases and tasks are graph nodes (D-08).
export function isCard(item: WorkItem): boolean {
  return item.kind === 'plan' || item.origin === 'board';
}

// The plans under each phase, built once per call so a scan of the whole board stays linear.
function plansByPhase(items: Items): Map<string, WorkItem[]> {
  const byPhase = new Map<string, WorkItem[]>();
  for (const item of items.values()) {
    if (item.kind !== 'plan' || item.parentId === undefined) continue;
    const plans = byPhase.get(item.parentId);
    if (plans === undefined) byPhase.set(item.parentId, [item]);
    else plans.push(item);
  }
  return byPhase;
}

// A phase is complete when every non-cancelled plan under it is done. The 62-04 rule stays for a phase that was never planned: it has nothing to prove
// it, so it is complete only when it is itself stored done, and it never releases the phases that wait on it. A phase that had plans and saw every one
// of them cancelled has nothing left to do, so it counts as complete (IN-02): without this no event could ever release the phases that wait on it,
// because a phase does not move through states. A cancelled plan dependency still keeps its own dependents waiting.
function phaseComplete(phase: WorkItem, byPhase: ReadonlyMap<string, WorkItem[]>): boolean {
  const plans = byPhase.get(phase.id) ?? [];
  const live = plans.filter((plan) => plan.state !== 'cancelled');
  if (live.length > 0) return live.every((plan) => plan.state === 'done');
  return plans.length > 0 || phase.state === 'done';
}

function dependencyProblem(items: Items, byPhase: ReadonlyMap<string, WorkItem[]>, id: string): 'dependency-open' | 'dependency-missing' | undefined {
  const dependency = items.get(id);
  if (dependency === undefined) return 'dependency-missing';
  const complete = dependency.kind === 'phase' ? phaseComplete(dependency, byPhase) : dependency.state === 'done';
  return complete ? undefined : 'dependency-open';
}

function readinessOf(items: Items, byPhase: ReadonlyMap<string, WorkItem[]>, item: WorkItem): { ready: boolean; reasons: NotReadyReason[] } {
  if (!isCard(item)) return { ready: false, reasons: [] };
  const reasons = new Set<NotReadyReason>();
  if (!isUnclaimed(item)) reasons.add('not-unclaimed');
  if (item.hold === true) reasons.add('held');
  if (item.blocked !== undefined) reasons.add('blocked');
  if (item.estimate === undefined) reasons.add('no-estimate');
  if (item.scope.length === 0) reasons.add('no-scope');
  for (const id of item.dependsOn) {
    const problem = dependencyProblem(items, byPhase, id);
    if (problem !== undefined) reasons.add(problem);
  }
  const phase = item.parentId === undefined ? undefined : items.get(item.parentId);
  if (phase !== undefined && phase.kind === 'phase') {
    if (phase.hold === true) reasons.add('phase-held');
    for (const id of phase.dependsOn) {
      const dependency = items.get(id);
      if (dependency === undefined) reasons.add('dependency-missing');
      else if (!phaseComplete(dependency, byPhase)) reasons.add('phase-dependency-open');
    }
  }
  return { ready: reasons.size === 0, reasons: [...reasons].sort() };
}

// D-11 and open question 4: ready is computed, never moved. An id that is not on the board, or is not a card, is not ready and has no reasons.
export function readiness(items: Items, id: string): { ready: boolean; reasons: NotReadyReason[] } {
  const item = items.get(id);
  return item === undefined ? { ready: false, reasons: [] } : readinessOf(items, plansByPhase(items), item);
}

function columnOf(items: Items, byPhase: ReadonlyMap<string, WorkItem[]>, item: WorkItem): BoardColumn {
  if (item.state !== 'backlog' && item.state !== 'ready') return item.state;
  return readinessOf(items, byPhase, item).ready ? 'ready' : 'backlog';
}

// Blocked is a flag, never a column (D-10), and a stored ready that is held or otherwise not ready shows in the backlog (D-11).
export function effectiveColumn(items: Items, item: WorkItem): BoardColumn {
  return columnOf(items, plansByPhase(items), item);
}

// The live plans of a phase, or of every phase under a milestone. Cancelled plans count on neither side.
function plansOf(items: Items, byPhase: ReadonlyMap<string, WorkItem[]>, groupId: string): WorkItem[] {
  const group = items.get(groupId);
  if (group === undefined) return [];
  const phases = group.kind === 'milestone' ? [...items.values()].filter((item) => item.kind === 'phase' && item.parentId === groupId) : group.kind === 'phase' ? [group] : [];
  return phases.flatMap((phase) => byPhase.get(phase.id) ?? []).filter((plan) => plan.state !== 'cancelled');
}

// D-08: the done share of estimate tokens, as an integer percent rounded down; counts when no plan has an estimate. done and total are always
// plan counts. BigInt keeps the sum and the multiplication exact however large the estimates are.
export function progressOf(items: Items, groupId: string): { percent: number; done: number; total: number } {
  const plans = plansOf(items, plansByPhase(items), groupId);
  const done = plans.filter((plan) => plan.state === 'done');
  if (plans.length === 0) return { percent: 0, done: 0, total: 0 };
  const weighted = plans.some((plan) => plan.estimate !== undefined);
  const weight = (plan: WorkItem): bigint => (weighted ? BigInt(plan.estimate?.tokens ?? 0) : 1n);
  const whole = plans.reduce((sum, plan) => sum + weight(plan), 0n);
  const finished = done.reduce((sum, plan) => sum + weight(plan), 0n);
  const percent = whole === 0n ? 0 : Number((finished * 100n) / whole);
  return { percent, done: done.length, total: plans.length };
}

// D-17: the N of the status bar line.
export function countReady(items: Items): number {
  const byPhase = plansByPhase(items);
  let ready = 0;
  for (const item of items.values()) if (isCard(item) && columnOf(items, byPhase, item) === 'ready') ready += 1;
  return ready;
}
