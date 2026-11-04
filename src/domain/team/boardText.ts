// Every authored string of the Team Board model, in one place so a reviewer can read the words the board speaks (62-UI-SPEC "Refusal copy",
// "Offered moves", "Kanban", "Card Face"). Plain language, sentence case, no em-dashes or en-dashes; a test greps every export. Teammate and plan
// text is never copy: names and reasons from the log pass flattenName before they reach a sentence. Pure: no I/O, no clock, no vscode.
import type { AssignAction, MoveKey } from './board';
import type { HistoryEntry } from './itemHistory';
import type { ItemOrigin } from './types';
import type { BoardColumn, NotReadyReason } from './work';

export const COLUMN_LABELS: Readonly<Record<BoardColumn, string>> = Object.freeze({
  backlog: 'Backlog', ready: 'Ready', claimed: 'Claimed', 'in-progress': 'In progress', 'in-review': 'In review', integrating: 'Shipping', done: 'Done', cancelled: 'Cancelled'
});

// The four columns that later phases own say so under their name; Done and Cancelled carry no caption.
export const COLUMN_CAPTIONS: Readonly<Partial<Record<BoardColumn, string>>> = Object.freeze({
  backlog: 'Waiting, on hold or not ready.', ready: 'Ready to be claimed.', claimed: 'Claiming arrives in a later update.',
  'in-progress': 'Starting work arrives with claims.', 'in-review': 'Review arrives in a later update.', integrating: 'Adding finished work to the project arrives in a later update.'
});

export const MOVE_LABELS: Readonly<Record<MoveKey, string>> = Object.freeze({
  done: 'Done (mark as finished)', cancel: 'Cancelled (cancel this item)...', hold: 'Backlog (put on hold)', release: 'Ready (release the hold)',
  reopen: 'Backlog (reopen)', block: 'Block...', unblock: 'Unblock'
});

const NOTHING_MOVED = 'Nothing was moved.';
const NOTHING_CHANGED = 'Nothing was changed.';

// G-62-5: the assignment actions (62-19). The owner and leads get Assign to... (the person list) and Unassign {name}; any other member who is not
// an observer gets Assign to me and Unassign me (owner decision 2026-11-03, 62-25).
export const ASSIGN_LABELS: Readonly<Record<AssignAction, string>> = Object.freeze({
  assign: 'Assign to...', unassign: 'Unassign', 'assign-me': 'Assign to me', 'unassign-me': 'Unassign me'
});

/** "Unassign Dana": the Unassign action with the name of the person on the card. */
export function unassignLabel(name: string): string {
  return `${ASSIGN_LABELS.unassign} ${flattenName(name)}`;
}

export const ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  owner: 'Owner', lead: 'Lead', developer: 'Developer', reviewer: 'Reviewer', observer: 'Observer'
});

// One sentence for each reason an assignment is refused. Each ends "Nothing was changed." because an assignment is not a move.
export const ASSIGN_REFUSALS = Object.freeze({
  missing: `This card is no longer on the board. ${NOTHING_CHANGED}`,
  notAssignable: `Only plans, phases and items added on the board can be assigned to a person. ${NOTHING_CHANGED}`,
  finished: `This card is already done or cancelled, so nobody can be put on it. ${NOTHING_CHANGED}`,
  notEligible: `This person cannot take cards. Only confirmed team members who are not observers can be assigned. ${NOTHING_CHANGED}`,
  alreadyAssigned: (name: string): string => `This card is already assigned to ${flattenName(name)}. ${NOTHING_CHANGED}`,
  notAssigned: `This card is not assigned to anyone. ${NOTHING_CHANGED}`,
  selfOnly: `You can assign a card only to yourself. A lead can assign it to someone else. ${NOTHING_CHANGED}`,
  takenBy: (name: string): string => `This card is assigned to ${flattenName(name)}. ${flattenName(name)} or a lead can change that. ${NOTHING_CHANGED}`,
  selfOffOnly: `You can only take yourself off a card. Ask a lead to change it. ${NOTHING_CHANGED}`,
  notWorker: `Only team members who work on cards can take one. A lead can change your role. ${NOTHING_CHANGED}`,
  notNow: `This card cannot be assigned right now. ${NOTHING_CHANGED}`
});

// The existing READ_ONLY_TEXT of the team session, repeated here because the domain may not import the host.
export const NO_DEVICE_KEY_TEXT = 'This computer is not yet approved to make changes for this team. You can look at the board. Ask your lead to approve this computer.';

export const REFUSALS = Object.freeze({
  claimed: 'Claiming a plan arrives in a later update. Nothing was moved.',
  'in-progress': 'Starting work from the board arrives with claims in a later update. Nothing was moved.',
  'in-review': 'Review arrives in a later update. Nothing was moved.',
  integrating: 'Adding finished work to the project arrives in a later update. Nothing was moved.',
  terminal: 'A finished or cancelled card can only be reopened. Use Move to... and choose Reopen. Nothing was moved.',
  notManager: 'Only the team owner or a lead can move cards. Nothing was moved.',
  noDeviceKey: NO_DEVICE_KEY_TEXT,
  removed: 'You were removed from this team. You can still look at the board but not change it.',
  differentRow: 'This card stays in its own row. Drop it in another column of the same row.',
  offline: 'The team could not be reached, so nothing was changed. Check your internet connection and try again.',
  secret: 'This text looks like a password or key, so it was not saved. Remove it and try again.',
  reasonInvalid: 'Enter a reason, up to 200 characters.',
  missing: `This card is no longer on the board. ${NOTHING_MOVED}`,
  alreadySettled: `This card is already done or cancelled. ${NOTHING_MOVED}`,
  doneBlocked: `This card is blocked, so it cannot be marked done. Unblock it first. ${NOTHING_MOVED}`,
  doneNotNow: `This card cannot be marked done from where it is. ${NOTHING_MOVED}`,
  alreadyHeld: `This card is already on hold. ${NOTHING_MOVED}`,
  notHeld: `This card is not on hold. ${NOTHING_MOVED}`,
  holdNotReady: `Only a card in Ready can be put on hold. ${NOTHING_MOVED}`,
  holdNotNow: `This card cannot be put on hold from where it is. ${NOTHING_MOVED}`,
  notTerminal: `This card is not done or cancelled, so there is nothing to reopen. ${NOTHING_MOVED}`,
  alreadyBlocked: `This card is already blocked. ${NOTHING_MOVED}`,
  notBlocked: `This card is not blocked. ${NOTHING_MOVED}`,
  blockNotNow: `This card cannot be blocked from where it is. ${NOTHING_MOVED}`,
  notNow: `This card cannot move there from where it is. ${NOTHING_MOVED}`,
  // G-62-3: a phase with no plans shows as a card (owner decision 2026-11-03), but only its plans move through the columns.
  phaseCard: `Plan this phase first. Its plans move on the board, not the phase. ${NOTHING_MOVED}`
});

export const READ_ONLY_BANNERS = Object.freeze({
  lookOnly: 'You can look at the board but not change it. A lead can change your role.',
  developer: 'You can add items and edit your own drafts. Leads and the owner move cards.'
});

export const BOARD_LANE_LABEL = 'Added on the board';
export const UNASSIGNED_LABEL = 'Unassigned';
// G-62-5: the viewer's own member lane says so after their name, "Dana (you)".
export const YOU_SUFFIX = ' (you)';
export const ALL_CARDS_LABEL = 'All cards';
export const NO_PLANS_TEXT = 'No plans yet';
// G-62-3: the detail's "Why this is not ready" line for a phase card, and the phrase its accessible name carries.
export const PHASE_NO_PLANS_DETAIL = 'This phase has no plans yet. Its plan cards show up here once its plans are written.';
export const PHASE_NO_PLANS_LABEL = 'This phase has no plans yet.';
export const SOURCE_IMPORT_TEXT = 'From the project plans';
export const SOURCE_BOARD_TEXT = 'Added on the board';
// J-02: the Backlog rule, said on the card face and in the New item form, so nobody wonders why an item never becomes Ready.
export const BACKLOG_RULE_CARD_TEXT = 'Stays in Backlog until it says which parts of the project it covers and roughly how big it is.';
export const HISTORY_LIMIT_TEXT = 'Showing the latest 50 changes.';
export const SOMEONE = 'Someone';
export const IMPORT_ACTOR = 'Import';

export const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  milestone: 'Milestone', phase: 'Phase', plan: 'Plan', task: 'Task', chore: 'Chore', bug: 'Bug', spike: 'Experiment', review: 'Review'
});

export function staleRefusal(name: string): string {
  return `${flattenName(name)} already changed this card. The board now shows the latest. ${NOTHING_MOVED}`;
}

// ---- flattening ------------------------------------------------------------------------------------------------------------------------------

const CONTROL_RUN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
// Invisible format characters that can reorder or hide text on screen ("Trojan Source"): bidi embeddings, overrides and isolates, the Arabic letter
// mark, zero-width spaces and joiners, directional marks and the byte order mark (IN-01). They are removed from text shown and written by the board.
const FORMAT_CONTROLS = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** The text without invisible format characters (IN-01). Everything else is kept, line breaks included. */
export function stripFormatControls(text: string): string {
  return text.replace(FORMAT_CONTROLS, '');
}

// One bounded line from teammate text: control characters (newlines and tabs included) become spaces, whitespace collapses, and anything longer
// than `max` characters is cut there and ends in three dots. Counts code points so a cut never splits a surrogate pair.
export function flattenName(text: string, max = 60): string {
  const line = stripFormatControls(text).replace(CONTROL_RUN, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(line);
  return points.length <= max ? line : `${points.slice(0, max).join('').trimEnd()}...`;
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// ---- not-ready wording ----------------------------------------------------------------------------------------------------------------------

const REASON_ORDER: readonly NotReadyReason[] = ['blocked', 'held', 'phase-held', 'no-estimate', 'no-scope', 'dependency-open', 'dependency-missing', 'phase-dependency-open', 'not-unclaimed'];

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function reasonPhrase(reason: NotReadyReason, waiting: number): string {
  switch (reason) {
    case 'blocked': return 'it is blocked';
    case 'held': return 'it is on hold';
    case 'phase-held': return 'its phase is on hold';
    case 'no-estimate': return 'it has no estimate';
    case 'no-scope': return 'it does not say which parts of the project it covers';
    case 'dependency-open': return `it waits for ${waiting} unfinished ${plural(waiting, 'plan', 'plans')}`;
    case 'dependency-missing': return 'a plan it depends on is not on the board';
    case 'phase-dependency-open': return 'its phase waits for an earlier phase';
    case 'not-unclaimed': return 'it has already been started';
  }
}

function ordered(reasons: readonly NotReadyReason[]): NotReadyReason[] {
  return REASON_ORDER.filter((reason) => reasons.includes(reason));
}

// "it has no estimate, it lists no files": the reason phrases joined with commas, in a fixed order. `waiting` is how many unfinished plans it waits for.
export function notReadyText(reasons: readonly NotReadyReason[], waiting: number): string {
  return ordered(reasons).map((reason) => reasonPhrase(reason, waiting)).join(', ');
}

// The refusal for dropping a card that is not computed ready into Ready.
export function notReadyRefusal(reasons: readonly NotReadyReason[], waiting: number, isPlan: boolean): string {
  return `This ${isPlan ? 'plan' : 'item'} is not ready yet: ${notReadyText(reasons, waiting)}. ${NOTHING_MOVED}`;
}

// The detail's "Why this is not ready" list: one plain sentence per reason.
export function notReadySentences(reasons: readonly NotReadyReason[], waiting: number): string[] {
  return ordered(reasons).map((reason) => {
    switch (reason) {
      case 'blocked': return 'It is blocked.';
      case 'held': return 'It is on hold.';
      case 'phase-held': return 'Its phase is on hold.';
      case 'no-estimate': return 'It has no estimate.';
      case 'no-scope': return 'It does not say which parts of the project it covers.';
      case 'dependency-open': return `It waits for ${waiting} unfinished ${plural(waiting, 'plan', 'plans')}.`;
      case 'dependency-missing': return 'A plan it depends on is not on the board.';
      case 'phase-dependency-open': return 'Its phase waits for an earlier phase.';
      case 'not-unclaimed': return 'It has already been started.';
    }
  });
}

// ---- estimate and age ------------------------------------------------------------------------------------------------------------------------

function trimmed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

function scaled(tokens: number): { value: string; unit: '' | 'k' | 'M' } {
  if (tokens < 1000) return { value: String(tokens), unit: '' };
  const thousands = Math.round(tokens / 100) / 10;
  if (thousands < 1000) return { value: trimmed(thousands), unit: 'k' };
  return { value: trimmed(Math.round(tokens / 100000) / 10), unit: 'M' };
}

// "800 tokens", "48k tokens", "1.2M tokens"; "No estimate" when there is none.
export function estimateText(tokens: number | undefined): string {
  if (tokens === undefined) return 'No estimate';
  const { value, unit } = scaled(tokens);
  return unit === '' ? `${value} ${plural(tokens, 'token', 'tokens')}` : `${value}${unit} tokens`;
}

// The same size in words for a screen reader: "48 thousand tokens".
export function estimateSpoken(tokens: number): string {
  const { value, unit } = scaled(tokens);
  if (unit === '') return `${value} ${plural(tokens, 'token', 'tokens')}`;
  return `${value} ${unit === 'k' ? 'thousand' : 'million'} tokens`;
}

const HOUR_MS = 3_600_000;

// "Under 1 hour", "5 hours", "1 day", "3 days", "2 months" from 60 days. Whole units, rounded down, from the injected clock and the display-only stateSince.
export function ageText(nowMs: number, sinceIso: string): string {
  const since = Date.parse(sinceIso);
  const hours = Number.isNaN(since) ? 0 : Math.floor((nowMs - since) / HOUR_MS);
  if (hours < 1) return 'Under 1 hour';
  if (hours < 24) return `${hours} ${plural(hours, 'hour', 'hours')}`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days} ${plural(days, 'day', 'days')}`;
  return `${Math.floor(days / 30)} months`;
}

function lowerFirst(text: string): string {
  return text === '' ? text : `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

// ---- accessible name -------------------------------------------------------------------------------------------------------------------------

export interface CardLabelFields {
  isPlan: boolean; displayId: string; title: string; stateLabel: string; blockedReason?: string; held: boolean; doneInGsd: boolean; cancelled: boolean;
  dependencyCount: number; estimateTokens?: number; age: string;
  /** G-62-5: the flattened name of the person on the card, said right after the state. */
  assigneeName?: string;
}

// "Plan 62-03, Board webview client. State: Ready. Blocked: no. 2 dependencies. Estimated 48 thousand tokens. In this state for 3 days."
// Variants say why a card is blocked, held, waiting for confirmation or cancelled. Plain text only: the host sets it with setAttribute.
export function cardLabel(fields: CardLabelFields): string {
  const parts = [
    `${fields.isPlan ? 'Plan ' : ''}${fields.displayId}, ${sentence(fields.title)}`,
    `State: ${fields.stateLabel}.`,
    ...(fields.assigneeName === undefined ? [] : [`Assigned to ${fields.assigneeName}.`]),
    fields.blockedReason === undefined ? 'Blocked: no.' : `Blocked: ${sentence(fields.blockedReason)}`
  ];
  if (fields.held) parts.push('On hold.');
  if (fields.doneInGsd) parts.push('The project plans say this is finished. Waiting for someone to confirm.');
  if (fields.cancelled) parts.push('Cancelled.');
  parts.push(fields.dependencyCount === 0 ? 'No dependencies.' : `${fields.dependencyCount} ${plural(fields.dependencyCount, 'dependency', 'dependencies')}.`);
  parts.push(fields.estimateTokens === undefined ? 'No estimate.' : `Estimated ${estimateSpoken(fields.estimateTokens)}.`);
  parts.push(`In this state for ${lowerFirst(fields.age)}.`);
  return parts.join(' ');
}

export interface PhaseCardLabelFields { title: string; stateLabel: string; assigneeName?: string; held: boolean; cancelled: boolean; dependencyCount: number; age: string }

// "Phase 63: Knowledge base. State: Backlog. This phase has no plans yet. 1 dependency. In this state for 4 days." The phase number is in the title,
// and there is no estimate or blocked flag to read out: a phase is sized by its plans and is never blocked.
export function phaseCardLabel(fields: PhaseCardLabelFields): string {
  const parts = [sentence(fields.title), `State: ${fields.stateLabel}.`];
  if (fields.assigneeName !== undefined) parts.push(`Assigned to ${fields.assigneeName}.`);
  if (fields.held) parts.push('On hold.');
  if (fields.cancelled) parts.push('Cancelled.');
  parts.push(PHASE_NO_PLANS_LABEL);
  parts.push(fields.dependencyCount === 0 ? 'No dependencies.' : `${fields.dependencyCount} ${plural(fields.dependencyCount, 'dependency', 'dependencies')}.`);
  parts.push(`In this state for ${lowerFirst(fields.age)}.`);
  return parts.join(' ');
}

// ---- history ---------------------------------------------------------------------------------------------------------------------------------

const CHANGE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  title: 'title', description: 'description', scope: 'parts of the project', requirements: 'requirements', mustHaves: 'checks for done', dependsOn: 'dependencies',
  estimate: 'estimate', gsd: 'plan details', tags: 'tags', summary: 'completion status', active: 'active milestone', source: 'source'
});

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] as string}`;
}

// assigneeName is the person an item.assigned put on the card or an item.unassigned took off ('' or absent when unknown: "Someone").
function personName(name: string | undefined): string {
  return name === undefined || name === '' ? SOMEONE : flattenName(name);
}

export interface HistoryContext { origin: ItemOrigin; hold?: 'on' | 'off'; assigneeName?: string }

// One plain sentence for a history row: "Dana blocked this: waiting for the API key." Imported items are changed by the importer, so their content
// edits read "Import updated the estimate." The hold direction is not stored on an entry, so the caller works it out and passes it in.
export function historySentence(entry: HistoryEntry, authorName: string, context: HistoryContext): string {
  const name = authorName === '' ? SOMEONE : flattenName(authorName);
  const reason = entry.reason === undefined ? '' : flattenName(entry.reason, 200);
  switch (entry.type) {
    case 'item.imported': return `${IMPORT_ACTOR} added this to the board.`;
    case 'item.created': return `${name} added this to the board.`;
    case 'item.estimated': return `${name} set the estimate.`;
    case 'item.blocked': return reason === '' ? `${name} blocked this.` : `${name} blocked this: ${sentence(reason)}`;
    case 'item.unblocked': return `${name} unblocked this.`;
    case 'item.cancelled': return reason === '' ? `${name} cancelled this.` : `${name} cancelled this: ${sentence(reason)}`;
    case 'item.reopened': return `${name} reopened this.`;
    // G-62-5: who was put on the card or taken off it, from HistoryEntry.memberId (62-15); a person doing it to themselves says so.
    case 'item.assigned': return entry.memberId !== undefined && entry.memberId === entry.author ? `${name} assigned this to themselves.` : `${name} assigned this to ${personName(context.assigneeName)}.`;
    case 'item.unassigned': return entry.memberId !== undefined && entry.memberId === entry.author ? `${name} unassigned themselves.` : `${name} unassigned ${personName(context.assigneeName)}.`;
    case 'item.updated': {
      const changed = entry.changed ?? [];
      if (changed.includes('state')) return `${name} marked this done.`;
      if (changed.includes('hold')) {
        if (context.hold === 'on') return `${name} put this on hold.`;
        return context.hold === 'off' ? `${name} released the hold.` : `${name} changed the hold.`;
      }
      const words = changed.map((key) => CHANGE_WORDS[key] ?? 'details');
      const what = words.length === 0 ? 'details' : joinWords([...new Set(words)]);
      return context.origin === 'import' ? `${IMPORT_ACTOR} updated the ${what}.` : `${name} changed the ${what}.`;
    }
    default: return `${name} changed this.`;
  }
}
