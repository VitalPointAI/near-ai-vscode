// Every authored sentence and label of the board timeline (62.1-UI-SPEC "Copywriting Contract" and the 2026-11-04 amendment: percent complete D-14,
// the Now indicator D-13, the accessible name of a dot D-05 and D-10). One table so a reviewer can read the words the timeline speaks, and so the
// plain-language and dash scans cover them (the scan finds every *Text.ts file). Plain words, sentence case, no em-dash or en-dash; the middle dot
// appears only where the UI-SPEC amendment puts it. Teammate text (titles, names, ids from the log) passes flattenName before it enters a sentence.
// Pure: no I/O, no clock, no vscode.
import { BOARD_LANE_LABEL, flattenName } from './boardText';

/** The title of the band of cards added on the board. */
export const BOARD_BAND_TITLE = BOARD_LANE_LABEL;
export const NO_CARDS_YET = 'No cards yet';
export const ALL_CANCELLED = 'Every card here was cancelled';

const TITLE_MAX = 200;

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function lowerFirst(text: string): string {
  return text === '' ? text : `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** A teammate-written title made safe for a sentence: one bounded line with no control or format characters. */
export function titleText(title: string): string {
  return flattenName(title, TITLE_MAX);
}

// ---- percent complete (D-14) -----------------------------------------------------------------------------------------------------------------

/** "26 of 42 cards finished" ("1 of 1 card finished"). */
export function cardsFinishedText(finished: number, counted: number): string {
  return `${finished} of ${counted} ${plural(counted, 'card', 'cards')} finished`;
}

/** "62% done". */
export function percentDoneText(percent: number): string {
  return `${percent}% done`;
}

/** "26 of 42 cards finished, 62%": the exact count that always goes with the percent. */
export function percentLabel(finished: number, counted: number, percent: number): string {
  return `${cardsFinishedText(finished, counted)}, ${percent}%`;
}

/** The text in place of a percent when nothing is counted: no cards at all, or only cancelled ones. */
export function noPercentText(anyCards: boolean): string {
  return anyCards ? ALL_CANCELLED : NO_CARDS_YET;
}

/** "62%" for a band header, or nothing when nothing is counted. */
export function percentShort(percent: number | undefined): string {
  return percent === undefined ? '' : `${percent}%`;
}

/** The band's h2: "v0.6.0 Team Mode, current milestone, 62% done"; with nothing counted the no-percent text follows the title. */
export function milestoneHeading(title: string, current: boolean, percent: number | undefined, noPercent: string): string {
  const parts = [titleText(title)];
  if (current) parts.push('current milestone');
  parts.push(percent === undefined ? lowerFirst(noPercent) : percentDoneText(percent));
  return parts.join(', ');
}

/** The folded tile's line: "Finished: 30 done", with ", 2 cancelled" only when some were cancelled. */
export function tileText(done: number, cancelled: number): string {
  return cancelled > 0 ? `Finished: ${done} done, ${cancelled} cancelled` : `Finished: ${done} done`;
}

/** The folded tile's accessible name: "Show v0.4.x line, finished, 32 cards". */
export function tileName(title: string, cards: number): string {
  return `Show ${titleText(title)}, finished, ${cards} ${plural(cards, 'card', 'cards')}`;
}

/** "Phase 62". */
export function phaseName(number: string): string {
  return `Phase ${flattenName(number)}`;
}

/**
 * A phase segment's labels, longest first, for the page to fit: "Phase 62: {title} · 62%", "Phase 62 · 62%", "62 · 62%". `label` is the board's
 * phase label ("Phase 62: {title}"). Without a percent the labels carry no number.
 */
export function phaseLabels(label: string, number: string, percent: number | undefined): string[] {
  const tail = percent === undefined ? '' : ` · ${percent}%`;
  return [`${titleText(label)}${tail}`, `${phaseName(number)}${tail}`, `${flattenName(number)}${tail}`];
}

/** The phase's h3 and the label's title: "Phase 62: {title}, 62% done, 17 of 27 cards finished", or the label and the no-percent text. */
export function phaseHeading(label: string, percent: number | undefined, finished: number, counted: number, noPercent: string): string {
  if (percent === undefined) return `${titleText(label)}, ${lowerFirst(noPercent)}`;
  return `${titleText(label)}, ${percentDoneText(percent)}, ${cardsFinishedText(finished, counted)}`;
}

// ---- the Now indicator (D-13) ----------------------------------------------------------------------------------------------------------------

export const NOW_ALL_DONE = 'Now: all the planned work is done';

/** Line 1 of the Now pill: "Now: Phase 62, step 4 of 9", or "Now: Added on the board, step 1 of 2" in the board band. */
export function nowTitle(phaseNumber: string | undefined, step: number, steps: number): string {
  return `Now: ${phaseNumber === undefined ? BOARD_BAND_TITLE : phaseName(phaseNumber)}, step ${step} of ${steps}`;
}

function nowShare(percent: number, board: boolean): string {
  return `${percent}% of ${board ? 'the cards added on the board' : 'this milestone'} done`;
}

/** Line 2 of the Now pill: "3 in progress, 2 ready · 62% of this milestone done". Zero counts are written as numbers. */
export function nowDetail(inProgress: number, ready: number, percent: number, board: boolean): string {
  return `${inProgress} in progress, ${ready} ready · ${nowShare(percent, board)}`;
}

/** The screen reader sentence: "Now: Phase 62, step 4 of 9. 3 in progress, 2 ready. 62% of this milestone done." */
export function nowSentence(title: string, inProgress: number, ready: number, percent: number, board: boolean): string {
  return `${title}. ${inProgress} in progress, ${ready} ready. ${nowShare(percent, board)}.`;
}

/** The sentence when every card is finished: "Now: all the planned work is done. 30 of 30 cards finished, 100%." */
export function nowAllDoneSentence(detail: string): string {
  return `${NOW_ALL_DONE}. ${detail}.`;
}
