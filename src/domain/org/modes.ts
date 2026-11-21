// How your organization works: the one mode table (FND-07, Phase 41 D-39, D-40; portfolio design 5.1 to 5.3). Pure: no I/O, no clock, no vscode, no package.
//
// A mode bundles the words on every screen with the joining behaviour behind them, so the two cannot drift apart: a screen that says "posted" while
// the code allows declining would be a lie, so both come from one row of this table. Every mode word lives in this one file, like the doctrine terms in
// src/domain/staff/doctrine.ts; code asks term() in terms.ts for a concept and never spells a mode word of its own. Mode ids are written into signed
// policies, so an id never changes in place: a rename needs a new section version that maps the old ids.

/** The four modes, in the order every list shows them. */
export const MODE_IDS = ['military', 'public-service', 'corporate', 'capital'] as const;
export type ModeId = (typeof MODE_IDS)[number];

/**
 * The concepts a mode names (portfolio design 5.2's fifteen, plus `people`, the signed list of people, and `decision`, what a person may approve, from the
 * glossary's section 2). The portfolio rolls up by these keys, which is what lets units of different modes add up.
 */
export const CONCEPT_KEYS = [
  'position', 'group', 'join', 'joined', 'report', 'unable', 'tasker', 'delegate', 'acting', 'temporary', 'dual', 'handover', 'relieved', 'lead',
  'member', 'people', 'decision'
] as const;
export type ConceptKey = (typeof CONCEPT_KEYS)[number];

/** A project without a mode, which is every project made before modes, behaves as Corporate and software for joining (portfolio D12). */
export const DEFAULT_MODE: ModeId = 'corporate';

/** How far a military or public service word is confirmed: the status key of the doctrine terms register. */
export const SOURCE_STATUSES = ['confirmed', 'confirmed-by-owner', 'best-guess'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/**
 * Where a word comes from. `confirmed` names a public source by title and edition; `confirmed-by-owner` names the owner's decision; `best-guess` says what
 * would confirm it. A note never quotes a restricted publication and never cites a source that was not read.
 */
export interface WordSource {
  readonly status: SourceStatus;
  readonly note: string;
}

export interface ModeWord {
  /** The word screens show for the concept in this mode. */
  readonly word: string;
  /** Other words the design lists for the same concept in this mode, for example a narrower or a command-level word. */
  readonly also?: readonly string[];
  /** False when the mode does not offer the concept at all; the word is then what a screen says when it explains that. */
  readonly offered?: false;
  /** Military and public service words only. Capital words are the capital pack's neutral labels, renamed by your directive; Corporate words are the product's own. */
  readonly source?: WordSource;
}

/** The behaviour behind a mode's words (portfolio design 5.3), one field per row. Decision wording is the `decision` concept word, not a field here. */
export interface ModeBehaviour {
  /** How a person joins: posted or assigned, invited, or appointed. */
  readonly joiningModel: 'assignment' | 'invitation' | 'appointment';
  /** Whether the person may decline. False means they can only report unable; a decline is refused, not just hidden. */
  readonly mayDecline: boolean;
  /** Days after which an unanswered invitation cancels the join; absent where only the device secret expires. */
  readonly invitationExpiryDays?: number;
  readonly whoMayPost: 'lead-and-delegates' | 'lead-and-deputy' | 'appointing-authority-and-delegates';
  /** Whether the order must cite an instrument (for example an appointment letter). */
  readonly instrumentRequired: boolean;
  readonly acting: boolean;
  /** Temporary joining: offered, only as a guest, or (only ever after your organization's settings turn it off) not offered. */
  readonly temporary: 'yes' | 'guest-only' | 'no';
  readonly dualHatting: boolean;
  /** Whether replacing a holder needs a handover (never empty, never two). */
  readonly handoverRequired: boolean;
  readonly positionsPersist: 'yes' | 'optional';
  /** Guests by invitation (liaison, adviser, observer). */
  readonly guests: 'if-policy-allows' | 'allowed' | 'always';
  /** The planning words a project in this mode uses by default; Military may choose another doctrine profile. */
  readonly planningProfile: 'nato-ca' | 'none' | 'capital-pack';
}

export interface ModeRow {
  /** The mode's own name, as the "How your organization works" choice shows it. */
  readonly name: string;
  readonly words: Readonly<Record<ConceptKey, ModeWord>>;
  readonly behaviour: ModeBehaviour;
}

/** One table entry, frozen with its `also` list and source. */
function word(text: string, extra: { also?: readonly string[]; offered?: false; source?: WordSource } = {}): ModeWord {
  const out: { word: string; also?: readonly string[]; offered?: false; source?: WordSource } = { word: text };
  if (extra.also !== undefined) out.also = Object.freeze([...extra.also]);
  if (extra.offered !== undefined) out.offered = extra.offered;
  if (extra.source !== undefined) out.source = Object.freeze({ status: extra.source.status, note: extra.source.note });
  return Object.freeze(out);
}

function guess(note: string): WordSource {
  return { status: 'best-guess', note };
}

// What would confirm a best-guess word: public sources only, by title. None of them was read for this table, so none is cited as confirming a word.
const PUBLIC_SERVICE_STAFFING = 'Confirm against the Public Service Employment Act and the current public Treasury Board staffing and people management policies.';
const PUBLIC_SERVICE_ORGANIZATION = 'Confirm against the current public organization charts and delegation instruments of a federal department.';

// Owner decision 2026-11-21: every Military word below is confirmed (position is Position; member is Staff officer, also Staff member or Defence team member).
const ownerMilitary: WordSource = { status: 'confirmed-by-owner', note: 'Owner decision 2026-11-21: confirmed for Military mode.' };

const MILITARY: ModeRow = Object.freeze({
  name: 'Military',
  words: Object.freeze({
    position: word('Position', { source: ownerMilitary }),
    group: word('Section', { also: ['Staff', 'Unit'], source: ownerMilitary }),
    join: word('Posting', { source: ownerMilitary }),
    joined: word('Posted', { source: ownerMilitary }),
    report: word('Report for duty', { source: ownerMilitary }),
    unable: word('Report unable', { source: ownerMilitary }),
    tasker: word('Tasking authority', { source: ownerMilitary }),
    delegate: word('Delegate tasking authority', { source: ownerMilitary }),
    acting: word('Acting', { also: ['Acting while so employed'], source: ownerMilitary }),
    temporary: word('Temporary duty', { also: ['Attached posting'], source: ownerMilitary }),
    dual: word('Dual-hatted', { source: ownerMilitary }),
    handover: word('Handover', {
      also: ['Relief in place', 'Transfer of authority'],
      source: { status: 'confirmed-by-owner', note: 'Owner decision 2026-11-20 (portfolio design D11): handover for one position, relief in place for a whole unit or watch, transfer of authority for command.' }
    }),
    relieved: word('Relieved', { source: ownerMilitary }),
    lead: word('Staff lead', { source: ownerMilitary }),
    member: word('Staff officer', { also: ['Staff member', 'Defence team member'], source: ownerMilitary }),
    people: word('Roster', { source: ownerMilitary }),
    decision: word('Commander\'s decision', { source: ownerMilitary })
  }),
  behaviour: Object.freeze({
    joiningModel: 'assignment', mayDecline: false, whoMayPost: 'lead-and-delegates', instrumentRequired: false, acting: true, temporary: 'yes',
    dualHatting: true, handoverRequired: true, positionsPersist: 'yes', guests: 'if-policy-allows', planningProfile: 'nato-ca'
  })
});

const PUBLIC_SERVICE: ModeRow = Object.freeze({
  name: 'Public service',
  words: Object.freeze({
    position: word('Position', { source: guess(`The usual federal word for an established position. ${PUBLIC_SERVICE_STAFFING}`) }),
    group: word('Directorate', { also: ['Branch', 'Unit'], source: guess(`Usual federal names for organization units. ${PUBLIC_SERVICE_ORGANIZATION}`) }),
    join: word('Assignment', { source: guess(`Usual federal word for placing an employee in a position for a time. ${PUBLIC_SERVICE_STAFFING}`) }),
    joined: word('Assigned', { source: guess(`Follows from assignment. ${PUBLIC_SERVICE_STAFFING}`) }),
    report: word('Report to the position', { source: guess(`Product wording for taking up an assignment. Confirm the phrase with the owner. ${PUBLIC_SERVICE_STAFFING}`) }),
    unable: word('Report unable', { source: guess(`Product wording: an assigned employee cannot decline, only report why they cannot report. Confirm the phrase with the owner. ${PUBLIC_SERVICE_STAFFING}`) }),
    tasker: word('Delegated manager', { source: guess(`Usual federal word for a manager holding delegated authority. ${PUBLIC_SERVICE_ORGANIZATION}`) }),
    delegate: word('Delegate authority', { source: guess(`Usual federal usage for passing on an authority. ${PUBLIC_SERVICE_ORGANIZATION}`) }),
    acting: word('Acting appointment', { source: guess(`Federal staffing term for holding a higher position for a time. ${PUBLIC_SERVICE_STAFFING}`) }),
    temporary: word('Temporary assignment', { source: guess(`Usual federal usage for a time-limited assignment. ${PUBLIC_SERVICE_STAFFING}`) }),
    dual: word('Concurrent responsibilities', { source: guess(`Plain federal usage for one person holding two positions. ${PUBLIC_SERVICE_STAFFING}`) }),
    handover: word('Handover', { source: guess(`Plain usage for passing a position on. ${PUBLIC_SERVICE_ORGANIZATION}`) }),
    relieved: word('Assignment ended', { source: guess(`Follows from assignment. ${PUBLIC_SERVICE_STAFFING}`) }),
    lead: word('Responsible manager', { source: guess(`Usual federal word for the manager accountable for a unit. ${PUBLIC_SERVICE_ORGANIZATION}`) }),
    member: word('Employee', { also: ['Defence team member'], source: { status: 'confirmed-by-owner', note: 'Owner decision 2026-11-21: Employee, also Defence team member.' } }),
    people: word('People', { source: guess(`Plain word for the signed list of people (glossary section 2). ${PUBLIC_SERVICE_ORGANIZATION}`) }),
    decision: word('Approved by the delegated authority', { source: guess(`Usual federal wording for an approval under delegation. ${PUBLIC_SERVICE_ORGANIZATION}`) })
  }),
  behaviour: Object.freeze({
    joiningModel: 'assignment', mayDecline: false, whoMayPost: 'lead-and-delegates', instrumentRequired: false, acting: true, temporary: 'yes',
    dualHatting: true, handoverRequired: true, positionsPersist: 'yes', guests: 'allowed', planningProfile: 'none'
  })
});

// Owner decision 2026-11-20 (portfolio O1): a group of people in Corporate mode is a work team, never the bare word; agents are an agent team in every mode.
const CORPORATE: ModeRow = Object.freeze({
  name: 'Corporate and software',
  words: Object.freeze({
    position: word('Position'),
    group: word('Work team'),
    join: word('Invitation'),
    joined: word('Invited'),
    report: word('Accept'),
    unable: word('Decline'),
    tasker: word('Work team admin'),
    delegate: word('Make admin'),
    acting: word('Acting', { offered: false }),
    temporary: word('Guest'),
    dual: word('Member of two work teams'),
    handover: word('Hand over ownership'),
    relieved: word('Removed'),
    lead: word('Work team lead'),
    member: word('Member'),
    people: word('People'),
    decision: word('Approved')
  }),
  behaviour: Object.freeze({
    joiningModel: 'invitation', mayDecline: true, invitationExpiryDays: 7, whoMayPost: 'lead-and-deputy', instrumentRequired: false, acting: false,
    temporary: 'guest-only', dualHatting: false, handoverRequired: false, positionsPersist: 'optional', guests: 'always', planningProfile: 'none'
  })
});

// The capital pack's neutral labels (portfolio design 5.2); your directive renames them as it renames every capital slot.
const CAPITAL: ModeRow = Object.freeze({
  name: 'Capital projects',
  words: Object.freeze({
    position: word('Role'),
    group: word('Project office'),
    join: word('Appointment'),
    joined: word('Appointed'),
    report: word('Take up the appointment'),
    unable: word('Report unable'),
    tasker: word('Appointing authority'),
    delegate: word('Delegation of authority'),
    acting: word('Acting'),
    temporary: word('Temporary appointment'),
    dual: word('Dual role'),
    handover: word('Handover of the appointment'),
    relieved: word('Appointment ended'),
    lead: word('Project leader'),
    member: word('Project team member'),
    people: word('People'),
    decision: word('Endorse or approve')
  }),
  behaviour: Object.freeze({
    joiningModel: 'appointment', mayDecline: false, whoMayPost: 'appointing-authority-and-delegates', instrumentRequired: true, acting: true,
    temporary: 'yes', dualHatting: true, handoverRequired: true, positionsPersist: 'yes', guests: 'allowed', planningProfile: 'capital-pack'
  })
});

/** The mode table, in MODE_IDS order: every mode word and every behaviour, once. */
export const MODES: Readonly<Record<ModeId, ModeRow>> = Object.freeze({
  military: MILITARY,
  'public-service': PUBLIC_SERVICE,
  corporate: CORPORATE,
  capital: CAPITAL
});

/** The settings people.organization may hold (D-40), sorted. Each one may only tighten what every allowed mode offers. */
export const ORGANIZATION_SETTING_KEYS = ['acting', 'dualHatting', 'enrolAtReport', 'guests', 'maxDelegationDepth', 'mayDecline', 'overdueDays', 'temporary'] as const;
export type OrganizationSettingKey = (typeof ORGANIZATION_SETTING_KEYS)[number];

/** How many times posting authority may be passed on, at most (portfolio O2). */
export const MAX_DELEGATION_DEPTH = 2;
/** By default delegates may not delegate again (portfolio D2 and O2). */
export const DEFAULT_MAX_DELEGATION_DEPTH = 0;
/** Days after the start date before an unreported posting is overdue (portfolio D4), and the range a policy may set. */
export const DEFAULT_OVERDUE_DAYS = 2;
export const MIN_OVERDUE_DAYS = 1;
export const MAX_OVERDUE_DAYS = 30;

/** Your organization's settings for how people join (D-40). Every key is optional; a boolean not written leaves the mode's own behaviour. */
export interface OrganizationSettings {
  /** False turns acting off. True is allowed only where every allowed mode offers acting. */
  readonly acting?: boolean;
  /** False turns dual-hatting off. True is allowed only where every allowed mode offers it. */
  readonly dualHatting?: boolean;
  /** True means a person reads in only once they report (portfolio D3); false (the default) allows it from enrolment. */
  readonly enrolAtReport?: boolean;
  /** False means guests come only if the policy allows them. */
  readonly guests?: boolean;
  readonly maxDelegationDepth?: number;
  /** False turns declining off. True is allowed only where every allowed mode lets people decline: never in an assignment or appointment mode. */
  readonly mayDecline?: boolean;
  readonly overdueDays?: number;
  /** False turns temporary joining off. */
  readonly temporary?: boolean;
}

/** A mode's behaviour after your organization's settings, plus the one duty a setting adds. */
export interface EffectiveBehaviour extends ModeBehaviour {
  readonly enrolAtReport: boolean;
}

/**
 * The behaviour a project in `mode` has under `settings`. It starts from the mode's row and only ever turns a permission off or a duty on, so a stored
 * setting can never widen a mode: declining stays impossible in an assignment or appointment mode whatever the settings say (T-41-60, defence in depth
 * behind the parser's refusal). Only an explicit `false` turns a permission off and only an explicit `true` turns the duty on.
 */
export function effectiveBehaviour(mode: ModeId, settings: OrganizationSettings): EffectiveBehaviour {
  // A programming error, never user input: parsed policies only ever carry known mode ids.
  if (!(MODE_IDS as readonly string[]).includes(mode)) throw new TypeError(`No mode row for ${String(mode).slice(0, 40)}.`);
  const row = MODES[mode].behaviour;
  const off = (value: unknown): boolean => value === false;
  const out: EffectiveBehaviour = {
    joiningModel: row.joiningModel,
    mayDecline: row.mayDecline && !off(settings.mayDecline),
    whoMayPost: row.whoMayPost,
    instrumentRequired: row.instrumentRequired,
    acting: row.acting && !off(settings.acting),
    temporary: off(settings.temporary) ? 'no' : row.temporary,
    dualHatting: row.dualHatting && !off(settings.dualHatting),
    handoverRequired: row.handoverRequired,
    positionsPersist: row.positionsPersist,
    guests: off(settings.guests) ? 'if-policy-allows' : row.guests,
    planningProfile: row.planningProfile,
    enrolAtReport: settings.enrolAtReport === true,
    ...(row.invitationExpiryDays === undefined ? {} : { invitationExpiryDays: row.invitationExpiryDays })
  };
  return Object.freeze(out);
}
