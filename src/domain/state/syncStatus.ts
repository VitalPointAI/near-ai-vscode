// What the chat panel's sync control says (D-16): one of five states, in plain words, with the one thing a click does. Pure: no vscode, no files, no clock
// of its own (the caller passes `now`). The sync itself, its triggers and the status it publishes are in services/syncFlows.ts; this only words that status.
import { redactSecrets } from '../redaction';
import type { SyncState, SyncStatus } from '../../services/syncFlows';

/** What one click on the control starts. 'none' while a sync is running. */
export type SyncControlAction = 'turn-on' | 'set-up-home' | 'show-details' | 'sync-now' | 'none';

export interface SyncControlModel {
  state: SyncState;
  /** The text on the button. */
  label: string;
  action: SyncControlAction;
  /** The accessible name: names the state, and for a problem the plain message. */
  ariaLabel: string;
  /** The tooltip: the message or the last sync time, and what a click does. */
  title: string;
  /** True while a sync runs (aria-busy). */
  busy: boolean;
  /** For 'attention' only: the plain sentence, shown as visible text under the control (D-16: the problem is shown on the control, not only in a tooltip). */
  detail?: string;
}

/** The invitation shown before sync is on (D-16). */
export const SYNC_PROMPT_TEXT = {
  line: 'Keep this project on your other machines',
  turnOn: 'Turn on sync',
  dismiss: 'Don\'t ask again'
} as const;

/** Used when a problem has no sentence of its own, so the control never shows just a bare state. */
const ATTENTION_FALLBACK = 'The last sync did not finish.';
const NO_HOME_FALLBACK = 'This project has no online home yet.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (value: number): string => String(value).padStart(2, '0');

/** A sync time as the control shows it: HH:MM in the person's time today, a short date and time otherwise. Empty for a time that is not valid. */
export function syncTimeText(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const clock = `${two(at.getHours())}:${two(at.getMinutes())}`;
  const today = new Date(now);
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate();
  return sameDay ? clock : `${MONTHS[at.getMonth()]} ${at.getDate()}, ${clock}`;
}

/** The control for a sync status. The message is shown as given; the host redacts it before it gets here (see syncStatusMessage). */
export function syncControlModel(status: SyncStatus, now: number): SyncControlModel {
  switch (status.state) {
    case 'syncing':
      return { state: 'syncing', label: 'Syncing…', action: 'none', ariaLabel: 'Project sync: syncing now', title: 'Syncing this project with your online home.', busy: true };
    case 'synced': {
      const time = syncTimeText(status.at, now);
      return {
        state: 'synced',
        label: time ? `Synced · ${time}` : 'Synced',
        action: 'sync-now',
        ariaLabel: `Project sync: synced${time ? ` at ${time}` : ''}. Choose to sync now.`,
        title: `${time ? `Last synced ${time}. ` : ''}Choose to sync now.`,
        busy: false
      };
    }
    case 'attention': {
      const message = status.message?.trim() || ATTENTION_FALLBACK;
      return { state: 'attention', label: 'Needs attention', action: 'show-details', ariaLabel: `Project sync needs attention: ${message} Choose to see what to do.`, title: message, busy: false, detail: message };
    }
    case 'no-home': {
      const message = status.message?.trim() || NO_HOME_FALLBACK;
      return { state: 'no-home', label: 'No online home · Set up', action: 'set-up-home', ariaLabel: `Project sync: no online home. ${message} Choose to set one up.`, title: message, busy: false };
    }
    default:
      return {
        state: 'off', label: 'Sync off · Turn on', action: 'turn-on',
        ariaLabel: 'Project sync: off. Choose to turn on.', title: 'Keep this project on your other machines. Choose to turn on project sync.', busy: false
      };
  }
}

/** The "Keep this project on your other machines" prompt shows only before sync is on and only until the person has dismissed it for this project. */
export function shouldShowSyncPrompt(input: { syncOn: boolean; dismissed: boolean }): boolean {
  return !input.syncOn && !input.dismissed;
}

/** What the host posts to the panel: the control and whether the invitation is wanted. */
export interface SyncStatusMessage {
  type: 'sync-status';
  model: SyncControlModel;
  prompt: boolean;
}

/**
 * The message the panel gets on open and on every status change. The status message is redacted first (`redact` defaults to the secret redaction, the
 * host passes one that also removes git credentials), so a problem shown on the control never carries a password or token.
 */
export function syncStatusMessage(status: SyncStatus, options: { now: number; dismissed: boolean; redact?: (text: string) => string }): SyncStatusMessage {
  const redact = options.redact ?? redactSecrets;
  const safe: SyncStatus = status.message === undefined ? status : { ...status, message: redact(status.message) };
  return { type: 'sync-status', model: syncControlModel(safe, options.now), prompt: shouldShowSyncPrompt({ syncOn: status.state !== 'off', dismissed: options.dismissed }) };
}
