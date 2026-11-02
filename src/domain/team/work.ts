// Work items (spec 6.4, D-04, D-10 to D-14): id shapes and the one pure function that decides whether an item event may move an item.
// The same transitionProblem runs when an event is written (the transport replays the batch through the materialiser) and when it is read,
// so a refusal on one side is a rejection on the other. Pure: no I/O, no clock, no vscode.
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

// The rejection reason an item event earns at its log position, or undefined when it may apply. Events that are not item events pass.
// No rule here can put an item into claimed, in-progress, in-review or integrating (D-13): the only states these events set are
// backlog, done and cancelled, and every move that needs a claim or an integration waits for the phase that owns it.
export function transitionProblem(state: Pick<TeamState, 'items'>, event: ImplementedTeamEvent): string | undefined {
  switch (event.type) {
    case 'item.imported': return importProblem(state, event.body);
    case 'item.created': return state.items.has(event.body.id) ? R.itemExists : undefined;
    case 'item.updated': return withItem(state, event.body.id, (item) => updateProblem(item, event.body.changes));
    case 'item.estimated': return withItem(state, event.body.id, estimateProblem);
    case 'item.blocked': return withItem(state, event.body.id, blockProblem);
    case 'item.unblocked': return withItem(state, event.body.id, (item) => (item.blocked === undefined ? R.itemNotBlocked : undefined));
    case 'item.cancelled': return withItem(state, event.body.id, (item) => (isTerminal(item) ? R.itemTerminal : undefined));
    case 'item.reopened': return withItem(state, event.body.id, (item) => (isTerminal(item) ? undefined : R.itemState));
    default: return undefined;
  }
}
