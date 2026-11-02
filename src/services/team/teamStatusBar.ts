// The Team status bar item (D-17, D-25, D-33): the ready and pending counts once the log has cards, "Team: <name>" before that, and a visible paused,
// untrusted or removed state with its own icon, background and click target. Every reason shown here passes redactGitMessage first, because git
// errors can carry URLs with credentials, and every teammate-authored text passes displayText.
import * as vscode from 'vscode';
import { TEAM_REJECTION_REASONS } from '../../domain/team/types';
import { redactGitMessage } from '../../team/runGit';
import { NO_ORG_NOTICE } from '../../team/join';
import { removedText } from '../../team/removedClient';
import { BRANCH_MISSING_REASON } from '../../team/transport';
import type { TransportStatus } from '../../team/transport';

export const PAUSED_UNREACHABLE_TEXT = 'Team sync paused: remote unreachable';
export const PAUSED_REWRITTEN_TEXT = 'Team sync paused: log rewritten';
export const PAUSED_MISSING_TEXT = 'Team sync paused: log missing on remote';
export const PAUSED_REFUSED_TEXT = 'Team log not trusted';
export const VERIFY_LOG_COMMAND = 'nearAi.team.verifyLog';

const MAX_REASON_LENGTH = 400;
const MAX_DISPLAY_LENGTH = 60;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u2028\u2029]+/g;

// One line, no control characters, no credentials, bounded length.
export function safeReason(reason: string): string {
  const flat = redactGitMessage(reason).replace(CONTROL_CHARACTERS, ' ').trim();
  return flat.length > MAX_REASON_LENGTH ? `${flat.slice(0, MAX_REASON_LENGTH)}...` : flat;
}

// A member name, a team name or a NEAR label from the log or from NEAR is untrusted display text: one flat line, bounded, with the icon syntax escaped
// ($(name) renders as an icon in the status bar), so it shows as typed (Pitfall 13, AD-14).
export function displayText(text: string, maxLength: number = MAX_DISPLAY_LENGTH): string {
  const flat = safeReason(text).replace(/\s+/g, ' ');
  const bounded = flat.length > maxLength ? `${flat.slice(0, maxLength)}...` : flat;
  return bounded.replaceAll('$(', '\\$(');
}

export const REMOVED_TEXT = 'Team: removed';
export const OPEN_BOARD_COMMAND = 'nearAi.team.openBoard';
const VERIFY_SENTENCE = 'Click to run Verify Team Log.';
const OPEN_BOARD_SENTENCE = 'Click to open the Team Board.';

// ready undefined means the log has no cards yet, so no count is shown.
export interface TeamStatusExtras { pending?: number; removed?: boolean; nearLabel?: string; nearLinked?: boolean; ready?: number }

export interface StatusView {
  /** What the status bar shows, with its $(icon). */
  text: string;
  /** The same words without icon syntax, for the output channel. */
  plain: string;
  tooltip: string;
  accessibilityLabel: string;
  /** The command a click runs; none for the removed state. */
  command?: string;
  tier: 'none' | 'warning' | 'error';
}

function nearLine(extras: TeamStatusExtras): string {
  if (extras.nearLabel !== undefined) return ` NEAR: signed in as ${displayText(extras.nearLabel)}.`;
  if (extras.nearLinked === false) return ` ${NO_ORG_NOTICE}`;
  return '';
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

// A paused or untrusted state: icon, plain words, tooltip, label with the action, and the Verify Team Log click target.
function paused(plain: string, icon: 'warning' | 'error', tooltip: string): StatusView {
  return { text: `$(${icon}) ${plain}`, plain, tooltip, accessibilityLabel: `${plain}. ${VERIFY_SENTENCE}`, command: VERIFY_LOG_COMMAND, tier: icon };
}

export function statusText(status: TransportStatus, teamName: string, extras: TeamStatusExtras = {}): StatusView {
  if (extras.removed === true) {
    return { text: `$(error) ${REMOVED_TEXT}`, plain: REMOVED_TEXT, tooltip: removedText(teamName), accessibilityLabel: REMOVED_TEXT, tier: 'error' };
  }
  if (status.state === 'ok') {
    const name = displayText(teamName);
    const pending = extras.pending ?? 0;
    if (extras.ready !== undefined) {
      const ready = extras.ready;
      const plain = `Team: ${ready} ready${pending > 0 ? ` \u00b7 ${pending} pending` : ''}`;
      const readyTip = ready === 0 ? 'No plans are ready to start.' : `${ready} ${plural(ready, 'plan is', 'plans are')} ready to start.`;
      const waitingTip = pending > 0 ? ` ${pending} ${plural(pending, 'member is', 'members are')} waiting for confirmation.` : '';
      const readyLabel = ready === 0 ? 'No plans ready.' : `${ready} ${plural(ready, 'plan', 'plans')} ready.`;
      const waitingLabel = pending > 0 ? ` ${pending} ${plural(pending, 'member', 'members')} waiting for confirmation.` : '';
      return {
        text: `$(organization) ${plain}`, plain,
        tooltip: `${name}: ${readyTip}${waitingTip} ${OPEN_BOARD_SENTENCE}${nearLine(extras)}`,
        accessibilityLabel: `Team Board. ${readyLabel}${waitingLabel} Open the Team Board.`,
        command: OPEN_BOARD_COMMAND, tier: 'none'
      };
    }
    const plain = `Team: ${name}${pending > 0 ? ` (${pending} pending)` : ''}`;
    const waitingLabel = pending > 0 ? ` ${pending} ${plural(pending, 'member', 'members')} waiting for confirmation.` : '';
    return {
      text: `$(organization) ${plain}`, plain,
      tooltip: `Team sync is working. ${OPEN_BOARD_SENTENCE}${nearLine(extras)}`,
      accessibilityLabel: `Team ${name}. Sync is working.${waitingLabel} Open the Team Board.`,
      command: OPEN_BOARD_COMMAND, tier: 'none'
    };
  }
  if (status.reason === TEAM_REJECTION_REASONS.logRewritten) {
    return paused(PAUSED_REWRITTEN_TEXT, 'warning', `${TEAM_REJECTION_REASONS.logRewritten}. ${VERIFY_SENTENCE}`);
  }
  if (status.reason === BRANCH_MISSING_REASON) {
    return paused(PAUSED_MISSING_TEXT, 'warning', `${BRANCH_MISSING_REASON} ${VERIFY_SENTENCE}`);
  }
  if (status.reason === TEAM_REJECTION_REASONS.logRefused) {
    return paused(PAUSED_REFUSED_TEXT, 'error', `The team log did not pass its checks, so the board is paused. ${TEAM_REJECTION_REASONS.logRefused}. Team events are being ignored. ${VERIFY_SENTENCE}`);
  }
  const reason = status.reason === undefined ? '' : safeReason(status.reason).replace(/\.+$/, '');
  const lead = reason === '' ? 'The team remote could not be reached.' : `The team remote could not be reached: ${reason}.`;
  return paused(
    PAUSED_UNREACHABLE_TEXT, 'warning',
    `${lead} NEAR AI keeps retrying, up to every 10 minutes, and right away when this window gets focus. The board shows the last update and cannot be changed until the connection returns. ${VERIFY_SENTENCE}`
  );
}

export interface TeamStatusBar {
  update(status: TransportStatus, teamName: string, extras?: TeamStatusExtras): void;
  dispose(): void;
}

export function createTeamStatusBar(): TeamStatusBar {
  const item = vscode.window.createStatusBarItem('nearAi.team', vscode.StatusBarAlignment.Left, 50);
  item.name = 'NEAR AI Team';
  item.show();
  return {
    update(status, teamName, extras): void {
      const shown = statusText(status, teamName, extras);
      item.text = shown.text;
      item.tooltip = shown.tooltip;
      item.accessibilityInformation = { label: shown.accessibilityLabel, role: 'button' };
      item.command = shown.command;
      item.backgroundColor = shown.tier === 'none' ? undefined : new vscode.ThemeColor(shown.tier === 'warning' ? 'statusBarItem.warningBackground' : 'statusBarItem.errorBackground');
    },
    dispose(): void {
      item.dispose();
    }
  };
}
