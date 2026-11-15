// The Team status bar item (D-25, D-33): "Team: <name>" while syncing, and a visible paused state when the remote cannot be reached or the
// coordination log was rewritten. Every reason shown here passes redactGitMessage first, because git errors can carry URLs with credentials.
import * as vscode from 'vscode';
import { TEAM_REJECTION_REASONS } from '../../domain/team/types';
import { redactGitMessage } from '../../team/runGit';
import { BRANCH_MISSING_REASON } from '../../team/transport';
import type { TransportStatus } from '../../team/transport';

export const PAUSED_UNREACHABLE_TEXT = 'Team sync paused: remote unreachable';
export const PAUSED_REWRITTEN_TEXT = 'Team sync paused: log rewritten';
export const PAUSED_MISSING_TEXT = 'Team sync paused: log missing on remote';
export const PAUSED_REFUSED_TEXT = 'Team log not trusted';
export const VERIFY_LOG_COMMAND = 'nearAi.team.verifyLog';

const MAX_REASON_LENGTH = 400;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u2028\u2029]+/g;

// One line, no control characters, no credentials, bounded length.
export function safeReason(reason: string): string {
  const flat = redactGitMessage(reason).replace(CONTROL_CHARACTERS, ' ').trim();
  return flat.length > MAX_REASON_LENGTH ? `${flat.slice(0, MAX_REASON_LENGTH)}...` : flat;
}

// The status bar renders $(name) as an icon, so a team name that contains it is escaped to show as typed.
function displayName(teamName: string): string {
  return teamName.replace(CONTROL_CHARACTERS, ' ').trim().replaceAll('$(', '\\$(');
}

export function statusText(status: TransportStatus, teamName: string): { text: string; tooltip: string } {
  if (status.state === 'ok') {
    return { text: `Team: ${displayName(teamName)}`, tooltip: 'Team sync is working. Click to run Verify Team Log.' };
  }
  if (status.reason === TEAM_REJECTION_REASONS.logRewritten) {
    return { text: PAUSED_REWRITTEN_TEXT, tooltip: TEAM_REJECTION_REASONS.logRewritten };
  }
  if (status.reason === BRANCH_MISSING_REASON) {
    return { text: PAUSED_MISSING_TEXT, tooltip: `${BRANCH_MISSING_REASON} Click to run Verify Team Log.` };
  }
  if (status.reason === TEAM_REJECTION_REASONS.logRefused) {
    return { text: PAUSED_REFUSED_TEXT, tooltip: `${TEAM_REJECTION_REASONS.logRefused}. Team events are being ignored. Click to run Verify Team Log.` };
  }
  const reason = status.reason === undefined ? '' : safeReason(status.reason).replace(/\.+$/, '');
  const lead = reason === '' ? 'The team remote could not be reached.' : `The team remote could not be reached: ${reason}.`;
  return {
    text: PAUSED_UNREACHABLE_TEXT,
    tooltip: `${lead} NEAR AI keeps retrying, up to every 10 minutes, and right away when this window gets focus.`
  };
}

export interface TeamStatusBar {
  update(status: TransportStatus, teamName: string): void;
  dispose(): void;
}

export function createTeamStatusBar(): TeamStatusBar {
  const item = vscode.window.createStatusBarItem('nearAi.team', vscode.StatusBarAlignment.Left, 50);
  item.name = 'NEAR AI Team';
  item.command = VERIFY_LOG_COMMAND;
  item.show();
  return {
    update(status, teamName): void {
      const shown = statusText(status, teamName);
      item.text = shown.text;
      item.tooltip = shown.tooltip;
      item.backgroundColor = status.state === 'ok' ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    },
    dispose(): void {
      item.dispose();
    }
  };
}
