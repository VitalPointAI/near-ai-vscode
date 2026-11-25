/**
 * The sync word on Sterling's status bar (Phase 33 D-57; superseded 33-20's D-22). While a shared project is open, one entry, sterling.staffSync,
 * shows the state's one word, its sentence as the tooltip, and runs Sync Now when clicked. With no shared project open the entry is absent. If a
 * Sterling status item already exists (32.1 native binds SterlingStatusItem), the word joins that item and no entry is added, so Phase 33 adds at
 * most one status item.
 *
 *   rows from the status service (33-24)   -> the most urgent row decides the word, its sentence the tooltip
 *   refused, attention, needs-update       -> the warning look (a person must act, T-33-77)
 *   no row                                  -> the entry is removed, or the word leaves the Sterling item
 *
 * Only the state's word and the backend's sentence are shown: never a name, a product, an address, a pin or a folder (T-33-76). The words are
 * liveSentences.ts SYNC_WORDS, which the browser cannot import (D-51); the workbench test checks this copy against it. Nothing here imports Theia
 * at run time, so the test drives it with a fake status bar.
 */
import { STAFF_STATUS_TEXT, type StaffStatusRow } from '../../common/staff-live.js';

export const STAFF_SYNC_ENTRY = 'sterling.staffSync';
export const STAFF_SYNC_COMMAND = 'sterling.staffSync.syncNow';

/** The word of each of the nine sync states (src/domain/staff/liveSentences.ts SYNC_WORDS, word for word). */
export const STAFF_SYNC_WORDS: Readonly<Record<string, string>> = Object.freeze({
  'single-machine': 'This computer only',
  connecting: 'Connecting',
  authenticating: 'Connecting',
  'catching-up': 'Catching up',
  live: 'Synced',
  offline: 'Offline',
  refused: 'Not accepted',
  attention: 'Needs attention',
  'needs-update': 'Needs an update',
});

/** The states that need a person: they get the warning look and win over every calm state. */
export const STAFF_SYNC_WARNING_STATES: ReadonlySet<string> = new Set(['refused', 'attention', 'needs-update']);

/** A state this build does not know (a newer engine) is shown as needing attention, never as calm. */
const UNKNOWN_WORD = STAFF_SYNC_WORDS.attention;
const UNKNOWN_SENTENCE = STAFF_STATUS_TEXT.unknownState;

/** Which row the one entry shows when several shared projects are open: a state that needs a person first, then one still on its way. */
const URGENCY: Readonly<Record<string, number>> = Object.freeze({
  'needs-update': 0, refused: 1, attention: 2, offline: 3, connecting: 4, authenticating: 4, 'catching-up': 5, 'single-machine': 6, live: 7,
});

/** What the status bar shows for the open shared projects. */
export interface StaffSyncShown {
  readonly project: string;
  readonly word: string;
  readonly tooltip: string;
  readonly warning: boolean;
  /** The word and the sentence together, so the state never rests on colour or an icon alone. */
  readonly accessibleName: string;
}

const known = (state: string): boolean => Object.prototype.hasOwnProperty.call(STAFF_SYNC_WORDS, state);

/** The word, tooltip and look for the rows, or undefined when no shared project is open. */
export function staffSyncShown(rows: Iterable<StaffStatusRow>): StaffSyncShown | undefined {
  let chosen: StaffStatusRow | undefined;
  let rank = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const value = known(row.state) ? URGENCY[row.state] : -1;
    if (value < rank) {
      chosen = row;
      rank = value;
    }
  }
  if (chosen === undefined) return undefined;
  const word = known(chosen.state) ? STAFF_SYNC_WORDS[chosen.state] : UNKNOWN_WORD;
  const tooltip = known(chosen.state) ? chosen.sentence : UNKNOWN_SENTENCE;
  const warning = !known(chosen.state) || STAFF_SYNC_WARNING_STATES.has(chosen.state);
  return { project: chosen.project, word, tooltip, warning, accessibleName: `Sync: ${word}. ${tooltip}` };
}

/** The status bar as this file uses it (Theia's StatusBar: setElement and removeElement). */
export interface StaffSyncBar {
  setElement(id: string, entry: StaffSyncEntry): Promise<void>;
  removeElement(id: string): Promise<void>;
}

/** The entry as Theia's StatusBarEntry takes it; the part adds the alignment and priority. */
export interface StaffSyncEntry {
  readonly name: string;
  readonly text: string;
  readonly tooltip: string;
  readonly command: string;
  readonly backgroundColor?: string;
  readonly color?: string;
  readonly accessibilityInformation: { readonly label: string; readonly role: string };
}

/** A Sterling status item made before this phase (32.1 native): the sync word joins it instead of a new entry. */
export const SterlingStatusItem = Symbol('SterlingStatusItem');
export interface SterlingStatusItem {
  /** Shows the sync part (its word after the item's own text, its sentence in the tooltip), or removes it when undefined. */
  setSyncPart(part: StaffSyncShown | undefined): void;
}

/** The entry for what is shown: a codicon and the word, the sentence as tooltip, Sync Now as the command, and Theia's warning colours when needed. */
export function staffSyncEntry(shown: StaffSyncShown): StaffSyncEntry {
  return {
    name: 'SovAI sync',
    text: `$(${shown.warning ? 'warning' : 'sync'}) ${shown.word}`,
    tooltip: shown.tooltip,
    command: STAFF_SYNC_COMMAND,
    ...(shown.warning ? { backgroundColor: 'var(--theia-statusBarItem-warningBackground)', color: 'var(--theia-statusBarItem-warningForeground)' } : {}),
    accessibilityInformation: { label: shown.accessibleName, role: 'button' },
  };
}

/**
 * Keeps the status bar in step with the rows: one row per open shared project, replaced as each new status arrives. Renders only when what is
 * shown changes, so a burst of rows with the same state writes the bar once.
 */
export class StaffSyncStatus {
  private readonly rows = new Map<string, StaffStatusRow>();
  private last: string | undefined;

  constructor(private readonly bar: StaffSyncBar, private readonly item?: SterlingStatusItem) {}

  /** Every current row, as the backend's rows() answers (on start); rows not in the list are dropped. */
  public reset(rows: readonly StaffStatusRow[]): Promise<void> {
    this.rows.clear();
    for (const row of rows) this.rows.set(row.project, row);
    return this.render();
  }

  /** One project's new status. */
  public update(row: StaffStatusRow): Promise<void> {
    this.rows.set(row.project, row);
    return this.render();
  }

  /** The project Sync Now runs for: the one whose word is shown. */
  public get shownProject(): string | undefined {
    return staffSyncShown(this.rows.values())?.project;
  }

  private async render(): Promise<void> {
    const shown = staffSyncShown(this.rows.values());
    const key = shown === undefined ? '' : JSON.stringify(shown);
    if (key === this.last) return;
    this.last = key;
    if (this.item !== undefined) {
      this.item.setSyncPart(shown);
      return;
    }
    if (shown === undefined) await this.bar.removeElement(STAFF_SYNC_ENTRY);
    else await this.bar.setElement(STAFF_SYNC_ENTRY, staffSyncEntry(shown));
  }
}
