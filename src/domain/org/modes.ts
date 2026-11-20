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

export interface ModeWord {
  /** The word screens show for the concept in this mode. */
  readonly word: string;
  /** Other words the design lists for the same concept in this mode, for example a narrower or a command-level word. */
  readonly also?: readonly string[];
  /** False when the mode does not offer the concept at all; the word is then what a screen says when it explains that. */
  readonly offered?: false;
}

export interface ModeRow {
  /** The mode's own name, as the "How your organization works" choice shows it. */
  readonly name: string;
  readonly words: Readonly<Record<ConceptKey, ModeWord>>;
}

function words(table: Record<ConceptKey, ModeWord>): Readonly<Record<ConceptKey, ModeWord>> {
  for (const key of CONCEPT_KEYS) {
    const entry = table[key];
    if (entry.also !== undefined) Object.freeze(entry.also);
    Object.freeze(entry);
  }
  return Object.freeze(table);
}

const CORPORATE: ModeRow = Object.freeze({
  name: 'Corporate and software',
  words: words({
    position: { word: 'Position' },
    group: { word: 'Work team' },
    join: { word: 'Invitation' },
    joined: { word: 'Invited' },
    report: { word: 'Accept' },
    unable: { word: 'Decline' },
    tasker: { word: 'Work team admin' },
    delegate: { word: 'Make admin' },
    acting: { word: 'Acting', offered: false },
    temporary: { word: 'Guest' },
    dual: { word: 'Member of two work teams' },
    handover: { word: 'Hand over ownership' },
    relieved: { word: 'Removed' },
    lead: { word: 'Work team lead' },
    member: { word: 'Member' },
    people: { word: 'People' },
    decision: { word: 'Approved' }
  })
});

/** The mode table. Filled one row at a time; term() refuses a mode with no row. */
export const MODES: Readonly<Partial<Record<ModeId, ModeRow>>> = Object.freeze({ corporate: CORPORATE });
