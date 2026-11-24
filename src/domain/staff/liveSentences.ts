// The words for the live connection of shared work (Phase 33, D-14, D-22, D-27, D-32, D-67, D-69; DESIGN 15.3 and 19). Pure: no I/O, no clock and
// no editor API. One short word, one plain sentence, one action and an accessible name for each of the nine sync states, and every finding of
// the server witness in your organization's words. The replicator keeps finding and refusal ids only; the screens read their words from here.
//
// Rules for every sentence (glossary sections 2 and 3): "your organization's server", "changes", and the lead word from term() in the mode of
// the shared work. Defence-edition text never calls a folder or shared work a project (D-69), so these sentences say "this shared work".
// The witness keeps its own sentences (hubWitness.ts HUB_FINDINGS) for logs and tests.
import { UPDATE_SENTENCE } from '../replica/features';
import type { HubFindingKind } from '../replica/hubWitness';
import { SYNC_STATES } from '../replica/syncMachine';
import type { SyncState } from '../replica/syncMachine';
import { term } from '../org/terms';
import type { ModeId } from '../org/modes';

/** The short word for each state, as a status entry shows it. */
export const SYNC_WORDS: Readonly<Record<SyncState, string>> = Object.freeze({
  'single-machine': 'This computer only',
  connecting: 'Connecting',
  authenticating: 'Connecting',
  'catching-up': 'Catching up',
  live: 'Synced',
  offline: 'Offline',
  refused: 'Not accepted',
  attention: 'Needs attention',
  'needs-update': 'Needs an update'
});

/** The one action offered in each state. readmit is offered only to a lead device, and only for a rolled-back or forked-view finding. */
export const SYNC_ACTIONS = ['share', 'sync-now', 'show-details', 'readmit', 'update-extension'] as const;
export type SyncAction = (typeof SYNC_ACTIONS)[number];

/** What your organization's server is being restored looks like on this computer (D-32): offline-like, never attention. */
export const RESTORING_TEXT = 'Your organization\'s server is being restored. Your changes are kept here.';

/** D-14: this device is held after an equivocation proof. {lead} is the lead word of the mode, from term(). */
export const QUARANTINE_TEXT = 'One of your computers signed two different histories. Your new work is held until the {lead} looks at it.';

/** Every witness finding in user words. N is the count; findingSentence fills it in. */
export const FINDING_TEXT: Readonly<Record<HubFindingKind, string>> = Object.freeze({
  withheld: 'Your organization\'s server has not delivered N changes that other people\'s work refers to.',
  delayed: 'Your organization\'s server has not confirmed your changes for N minutes.',
  'rolled-back': 'Your organization\'s server showed an older copy of this shared work than this computer has already seen.',
  'forked-view': 'Your organization\'s server showed two different versions of this shared work, so this computer no longer trusts it.',
  injected: 'Your organization\'s server sent a change nobody working on this shared work signed, and it was refused.',
  'corrupt-blob': 'Your organization\'s server sent an attachment that does not match its fingerprint, and it was refused.',
  'wrong-project': 'Your organization\'s server answered with data from other shared work, and it was refused.',
  replayed: 'Your organization\'s server sent changes this computer already had, so nothing changed.'
});

/** The refusals of a session or a change, in user words, each naming who to ask. {lead} is the lead word of the mode. */
const REFUSAL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'not-admitted': 'Your organization\'s server does not know this computer for this shared work. Ask the {lead} to give it access.',
  revoked: 'This computer no longer has access to this shared work. Ask the {lead} if you still need it.',
  'not-a-person-device': 'Only a person\'s computer can work on this shared work. Ask the {lead} for help.',
  'unknown-project': 'Your organization\'s server does not hold this shared work. Ask the {lead} to connect it.',
  // A person's session key past its certificate's end (Phase 33 D-62).
  'session-expired': 'Your session key has ended. Sign in again.'
});
const REFUSAL_OTHER = 'Your organization\'s server did not accept this computer. Ask the {lead} for help.';

/** What a sentence needs besides the state. */
export interface SentenceContext {
  /** The mode of the shared work; Corporate and software when absent. */
  mode?: ModeId;
  /** True when this device may write the roster (a lead or deputy device): the only one offered Re-admit. */
  isLeadDevice?: boolean;
  /** Changes still to exchange while catching up. */
  remaining?: number;
}

/** The status the sentences read: the replicator's LiveStatus has this shape. */
export interface SentenceStatus {
  state: SyncState;
  reason?: string;
  findings: readonly string[];
  lastSyncedAt?: number;
}

const leadWord = (mode?: ModeId): string => term('lead', mode).toLowerCase();
const withLead = (text: string, mode?: ModeId): string => text.replace('{lead}', leadWord(mode));
const isFinding = (id: string): id is HubFindingKind => Object.prototype.hasOwnProperty.call(FINDING_TEXT, id);

/** A finding id in user words, with the count filled in where the sentence has one ("1 change", "3 changes"; "some" without a count). */
export function findingSentence(id: string, count?: number): string {
  if (!isFinding(id)) return 'Your organization\'s server did something this computer could not check, so it stopped syncing. Ask the person who runs your organization\'s server.';
  const text = FINDING_TEXT[id];
  if (!/\bN /.test(text)) return text;
  if (count === undefined) return text.replace(/\bN /, 'some ');
  return text.replace(/\bN (\w+?)s\b/, (_match, word: string) => (count === 1 ? `1 ${word}` : `${count} ${word}s`));
}

/** A refusal in user words, naming who to ask with the lead word of the mode. quarantined gives D-14's sentence. */
export function refusalSentence(reason: string | undefined, mode?: ModeId): string {
  if (reason === 'quarantined') return withLead(QUARANTINE_TEXT, mode);
  return withLead((reason !== undefined && REFUSAL_TEXT[reason]) || REFUSAL_OTHER, mode);
}

/** The time of day a last sync shows, as HH:MM in UTC (the screen may show it in the person's own time). */
function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/** The one plain sentence for a state (DESIGN 19). */
export function syncSentence(status: SentenceStatus, context: SentenceContext = {}): string {
  switch (status.state) {
    case 'single-machine':
      return 'This shared work is kept on this computer only. Share it with people to work on it together.';
    case 'connecting':
    case 'authenticating':
      return 'Connecting to your organization\'s server.';
    case 'catching-up':
      return context.remaining === undefined ? 'Catching up with your organization\'s server.' : `Catching up with your organization's server: ${context.remaining === 1 ? '1 change' : `${context.remaining} changes`} to go.`;
    case 'live':
      return 'Synced with your organization\'s server.';
    case 'offline':
      if (status.reason === 'restoring') return RESTORING_TEXT;
      return `You are offline. Your changes are kept here and will sync when your organization's server is back. ${status.lastSyncedAt === undefined ? 'Not synced yet.' : `Last synced at ${clock(status.lastSyncedAt)}.`}`;
    case 'refused':
      return refusalSentence(status.reason, context.mode);
    case 'attention': {
      const id = status.findings.find(isFinding) ?? status.reason ?? '';
      return findingSentence(id);
    }
    case 'needs-update':
      return UPDATE_SENTENCE;
    default:
      return 'Connecting to your organization\'s server.';
  }
}

/** The one action of a state. */
export function syncAction(status: SentenceStatus, context: SentenceContext = {}): SyncAction {
  switch (status.state) {
    case 'single-machine':
      return 'share';
    case 'live':
    case 'offline':
      return 'sync-now';
    case 'attention': {
      const id = status.findings.find(isFinding) ?? status.reason;
      return context.isLeadDevice === true && (id === 'rolled-back' || id === 'forked-view') ? 'readmit' : 'show-details';
    }
    case 'needs-update':
      return 'update-extension';
    default:
      return 'show-details';
  }
}

/** The accessible name of the status: the word and the sentence, so the state never rests on colour or an icon alone. */
export function syncAccessibleName(status: SentenceStatus, context: SentenceContext = {}): string {
  return `Sync: ${SYNC_WORDS[status.state]}. ${syncSentence(status, context)}`;
}

/** What the people list shows for one person (D-21): live and what they work on, or when they were last seen. */
export interface PresenceLine { live: boolean; lastSeen: number; product?: string; runs?: number }

/**
 * The people list's hover text (D-21): "Working on {product}. Running {n} agents." while live in a product this device may see, "Live" otherwise,
 * and "Last seen HH:MM" once the person is gone. productTitle gives the product's shown name (its id when absent).
 */
export function presenceText(person: PresenceLine, productTitle: (product: string) => string = (product) => product): string {
  if (!person.live) return `Last seen ${clock(person.lastSeen)}`;
  if (person.product === undefined) return 'Live';
  const working = `Working on ${productTitle(person.product)}.`;
  if (person.runs === undefined || person.runs === 0) return working;
  return `${working} Running ${person.runs === 1 ? '1 agent' : `${person.runs} agents`}.`;
}

/** Every state has a word: a new state without words fails the sentences test. */
export const SENTENCE_STATES: readonly SyncState[] = SYNC_STATES;
