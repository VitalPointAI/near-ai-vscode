// The sidebar Team section model (G-61-5): what is known about this project and this computer in, one heading, one plain status line and the buttons
// to show out, with exactly one primary next action. The page (media/chat/team.js) draws it; the host (61-21) feeds it and runs the commands through
// TEAM_ACTION_COMMANDS. Pure: no vscode, no I/O, no clock. Every label and sentence comes from teamSectionText.ts.
import {
  TEAM_ACTION_HINTS, TEAM_ACTION_LABELS, TEAM_SECTION_HEADING, TEAM_STATUS, managerStatus, teamHeading
} from './teamSectionText';
import type { Role } from './types';

export const TEAM_ACTION_IDS = ['turn-on', 'join', 'share', 'invite', 'members', 'board', 'link', 'check'] as const;
export type TeamActionId = (typeof TEAM_ACTION_IDS)[number];

export const TEAM_ACTION_COMMANDS: Readonly<Record<TeamActionId, string>> = Object.freeze({
  'turn-on': 'nearAi.team.enable',
  join: 'nearAi.team.join',
  share: 'nearAi.team.share',
  invite: 'nearAi.team.invite',
  members: 'nearAi.team.manageMembers',
  board: 'nearAi.team.openBoard',
  link: 'nearAi.team.linkNearOrganization',
  check: 'nearAi.team.verifyLog'
});

export function isTeamActionId(value: unknown): value is TeamActionId {
  return typeof value === 'string' && (TEAM_ACTION_IDS as readonly string[]).includes(value);
}

/** Filled by Phase 62's board fix; shown only when the host supplies it. */
export interface TeamBoardSummary { ready: number; blocked: number; mine: number }
export type SharedView = 'yes' | 'no' | 'not-reachable-by-teammates' | 'unknown';

export interface TeamSectionInput {
  folderOpen: boolean;
  team?: {
    /** Display-safe text, already passed through displayText by the host. */
    name: string;
    /** Undefined: this computer is not on the team. */
    myRole?: Role;
    /** Joined, waiting for a lead. */
    pendingRole?: Role;
    removed: boolean;
    /** Owner or lead. */
    canManage: boolean;
    /** memberAttention count, managers only. */
    waiting: number;
    /** Invitations not yet used. */
    pendingInvites: number;
    /** Joined people other than me. */
    otherMembers: number;
    /** Organization link in team.json. */
    linked: boolean;
    connection: 'live' | 'syncing' | 'offline' | 'paused';
    /** boardStatus text for offline or paused. */
    connectionText?: string;
    /** Managers only; undefined while not checked yet. */
    shared?: SharedView;
  };
  board?: TeamBoardSummary;
}

export interface TeamSectionAction { id: TeamActionId; label: string; primary: boolean; badge?: string; hint?: string }
export interface TeamSectionModel { heading: string; status: string; compact: boolean; actions: TeamSectionAction[]; board?: TeamBoardSummary & { text: string } }

/** Undefined when no folder is open. */
export function teamSectionModel(input: TeamSectionInput): TeamSectionModel | undefined {
  if (!input.folderOpen) return undefined;
  const team = input.team;
  if (team === undefined) {
    return { heading: TEAM_SECTION_HEADING, status: TEAM_STATUS.noTeam, compact: true, actions: ordered('turn-on', ['join']) };
  }
  const offered: TeamActionId[] = ['members', 'board'];
  if (!team.linked) offered.push('link');
  return { heading: teamHeading(team.name), status: managerStatus(team.name, team.otherMembers, team.pendingInvites), compact: false, actions: ordered('invite', offered) };
}

// The primary action first, then the others in the order of TEAM_ACTION_IDS, so the buttons never jump around between states.
function ordered(primary: TeamActionId, others: readonly TeamActionId[]): TeamSectionAction[] {
  const rest = TEAM_ACTION_IDS.filter((id) => id !== primary && others.includes(id));
  return [primary, ...rest].map((id) => ({ id, label: TEAM_ACTION_LABELS[id], primary: id === primary, hint: TEAM_ACTION_HINTS[id] }));
}

export interface TeamSetupStep { id: 'team.turn-on' | 'team.share' | 'team.invite' | 'team.link'; title: string; done: boolean; action: TeamActionId; optional: boolean }

export function teamSetupSteps(input: TeamSectionInput): TeamSetupStep[] {
  throw new Error(`not implemented ${String(input.folderOpen)}`);
}
