// The sidebar Team section model (G-61-5, G-61-8): what is known about this project and this computer in, one heading, one plain status line and the
// buttons to show out, with exactly one primary next action. The page (media/chat/team.js) draws it; the host (61-21) feeds it and runs the commands
// through TEAM_ACTION_COMMANDS. With no team it speaks of working with your agents (even one person works with a team of agents) and offers Invite
// someone, Join a team and Just me for now; Just me for now puts it away for the project and leaves one quiet line on the empty chat. A team that
// exists does not nag. Pure: no vscode, no I/O, no clock. Every label and sentence comes from teamSectionText.ts.
import {
  TEAM_ACTION_HINTS, TEAM_ACTION_LABELS, TEAM_SECTION_HEADING, TEAM_SETUP_TITLES, TEAM_SOLO_LINE_LABELS, TEAM_STATUS, boardSummaryText, connectionStatus,
  memberStatus, notOnTeamStatus, notReachableStatus, notSharedStatus, onlyYouStatus, peopleStatus, teamHeading, waitingBadge, waitingStatus
} from './teamSectionText';
import type { Role } from './types';

// 'solo' is Just me for now: the host keeps it as a choice for this project and runs no command for it.
export const TEAM_ACTION_IDS = ['invite', 'join', 'solo', 'share', 'members', 'board', 'link', 'check'] as const;
export type TeamActionId = (typeof TEAM_ACTION_IDS)[number];

export const TEAM_ACTION_COMMANDS: Readonly<Record<Exclude<TeamActionId, 'solo'>, string>> = Object.freeze({
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
  /** Just me for now was chosen for this project (VS Code's workspace state); it matters only while the project has no team. */
  justMe?: boolean;
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
/**
 * The team part of the Connect screen (61-30, G-61-9), drawn by the page only while no profile works: the plain sentence for this person's
 * situation, if any, and the team buttons. fallback holds the words of the small Connect block the page draws when PR #7's panel is absent.
 */
export interface TeamConnect {
  status?: string;
  actions: TeamSectionAction[];
  fallback: { title: string; body: string; setupLabel: string; savedLabel: string };
}
export interface TeamSectionModel {
  /** empty-chat-line: the section is hidden and the status with its actions is one quiet line inside the empty chat's welcome. */
  placement: 'section' | 'empty-chat-line';
  heading: string;
  status: string;
  compact: boolean;
  actions: TeamSectionAction[];
  board?: TeamBoardSummary & { text: string };
  /** The team part of the Connect screen; absent when there is nothing to offer there (no folder, or removed from the team). */
  connect?: TeamConnect;
}

/** Undefined when no folder is open. */
export function teamSectionModel(input: TeamSectionInput): TeamSectionModel | undefined {
  if (!input.folderOpen) return undefined;
  const team = input.team;
  if (team === undefined) {
    if (input.justMe === true) {
      // Just me for now: no section, only the quiet line on the empty chat, with the same invite and Join a team (an invite says to choose it).
      const line = ordered('invite', ['join']).map((action) => ({ ...action, label: TEAM_SOLO_LINE_LABELS[action.id as 'invite' | 'join'] }));
      return { placement: 'empty-chat-line', heading: '', status: TEAM_STATUS.justMe, compact: true, actions: line };
    }
    return { placement: 'section', heading: TEAM_SECTION_HEADING, status: TEAM_STATUS.noTeam, compact: false, actions: ordered('invite', ['join', 'solo']) };
  }
  const heading = teamHeading(team.name);
  // Removed: only the plain sentence, no button and no board summary.
  if (team.removed) return { placement: 'section', heading, status: TEAM_STATUS.removed, compact: true, actions: [] };

  const plan = teamPlan(team);
  const unreachable = team.connection === 'offline' || team.connection === 'paused';
  // Offline or paused: Check the team becomes the next action and the status is the connection text; the rest stays offered.
  const primary: TeamActionId = unreachable ? 'check' : plan.primary;
  const others = unreachable ? [plan.primary, ...plan.others] : plan.others;
  const status = unreachable ? connectionStatus(team.connectionText, team.connection === 'paused' ? 'paused' : 'offline') : plan.status;
  const actions = ordered(primary, others).map((action) => (action.id === 'members' && team.canManage && team.waiting > 0 ? { ...action, badge: waitingBadge(team.waiting) } : action));
  const model: TeamSectionModel = { placement: 'section', heading, status, compact: plan.compact, actions };
  if (input.board !== undefined) {
    const { ready, blocked, mine } = input.board;
    model.board = { ready, blocked, mine, text: boardSummaryText(ready, blocked, mine) };
  }
  return model;
}

interface TeamPlan { status: string; primary: TeamActionId; others: TeamActionId[]; compact: boolean }

// What a live team offers this person, before the connection is taken into account.
function teamPlan(team: NonNullable<TeamSectionInput['team']>): TeamPlan {
  const { name } = team;
  if (team.myRole === undefined && team.pendingRole === undefined) return { status: notOnTeamStatus(name), primary: 'join', others: ['board'], compact: true };
  // Joined and waiting: nothing that changes the team, only the board to look at.
  if (team.pendingRole !== undefined && (team.myRole === undefined || !team.canManage)) return { status: waitingStatus(name), primary: 'board', others: [], compact: true };
  if (!team.canManage) return { status: memberStatus(name), primary: 'board', others: ['members'], compact: false };
  // The owner or a lead. Until someone else joins, inviting is the next step; once someone joined the section stays quiet (Members, with the
  // waiting badge, and the board), and inviting more people is the first row of Members. Linking the organization is offered by the invite and
  // in Members, not here.
  const alone = team.otherMembers === 0;
  const quiet: TeamActionId[] = alone ? ['invite', 'members', 'board'] : ['members', 'board'];
  // Share joins them, first, only while the team setup is not online for teammates; the invite itself also offers to share first.
  if (team.shared === 'no') return { status: notSharedStatus(name), primary: 'share', others: quiet, compact: false };
  if (team.shared === 'not-reachable-by-teammates') return { status: notReachableStatus(name), primary: 'share', others: quiet, compact: false };
  if (alone) return { status: onlyYouStatus(team.pendingInvites), primary: 'invite', others: quiet, compact: false };
  return { status: peopleStatus(name, team.otherMembers, team.waiting), primary: 'members', others: quiet, compact: false };
}

// The primary action first, then the others in the order of TEAM_ACTION_IDS, so the buttons never jump around between states.
function ordered(primary: TeamActionId, others: readonly TeamActionId[]): TeamSectionAction[] {
  const rest = TEAM_ACTION_IDS.filter((id) => id !== primary && others.includes(id));
  return [primary, ...rest].map((id) => ({ id, label: TEAM_ACTION_LABELS[id], primary: id === primary, hint: TEAM_ACTION_HINTS[id] }));
}

export interface TeamSetupStep { id: 'team.invite' | 'team.share' | 'team.link'; title: string; done: boolean; skipped: boolean; action: TeamActionId; optional: boolean }

/**
 * The team setup as plain steps with done and skipped flags and the action each runs, so the guided project setup (SETUP-01) can register them
 * without depending on this module's callers. Invite people comes first and sets the team up on the way, so there is no turn-on step; it is
 * optional (a person can work alone with their agents) and done once someone joined or an invite waits. Share and link follow it. Just me for now in
 * a project with no team skips all three; once the project has a team nothing is skipped.
 *
 * Merge note (main with PR #7 into Team Mode): register team.invite ('Invite people', running the invite action) with registerSetupStep right after
 * the project-team step, then team.share and team.link, each with the done and skipped flags from here.
 */
export function teamSetupSteps(input: TeamSectionInput): TeamSetupStep[] {
  const team = input.team !== undefined && !input.team.removed ? input.team : undefined;
  const skipped = team === undefined && input.justMe === true;
  const step = (id: TeamSetupStep['id'], action: TeamActionId, done: boolean, optional: boolean): TeamSetupStep => ({ id, title: TEAM_SETUP_TITLES[id], done, skipped, action, optional });
  return [
    step('team.invite', 'invite', team !== undefined && (team.pendingInvites > 0 || team.otherMembers > 0), true),
    step('team.share', 'share', team?.shared === 'yes', false),
    step('team.link', 'link', team?.linked === true, true)
  ];
}
