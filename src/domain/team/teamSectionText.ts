// Every sentence and label of the sidebar Team section (G-61-5), in one place so a reviewer can read the words it speaks and the plain-language test
// finds it by its *Text.ts name. Plain words, sentence case, no git words, no en or em dash; the paying account is "your organization". Team names
// arrive already made display-safe by the host. Pure: no I/O, no clock, no vscode.

export const TEAM_SECTION_HEADING = 'Team';

// The button labels, one per action id of teamSection.ts.
export const TEAM_ACTION_LABELS = Object.freeze({
  'turn-on': 'Turn on Team Mode',
  join: 'Join a team',
  share: 'Share',
  invite: 'Invite someone',
  members: 'Members',
  board: 'Open board',
  link: 'Link your organization',
  check: 'Check the team'
});

// A short explanation per button, shown as its tooltip.
export const TEAM_ACTION_HINTS = Object.freeze({
  'turn-on': 'Start a team for this project so other people can work on it with you.',
  join: 'Join a team with the invite someone sent you.',
  share: 'Put the team setup online so the people you invite can join.',
  invite: 'Make an invite for a person, with the role they will have.',
  members: 'See who is on the team and confirm the people who joined.',
  board: 'Open the team board in an editor tab.',
  link: 'Link your organization so it pays for the team\'s AI use.',
  check: 'Check the team record and try to reach the team again.'
});

// The setup step titles (SETUP-01 can register these later).
export const TEAM_SETUP_TITLES = Object.freeze({
  'team.turn-on': 'Turn on Team Mode',
  'team.share': 'Share the team setup',
  'team.invite': 'Invite someone',
  'team.link': 'Link your organization'
});

// Sentences that do not depend on the team.
export const TEAM_STATUS = Object.freeze({
  noTeam: 'Work on this project with other people. Turn on Team Mode to start a team, or join one with an invite.',
  removed: 'You were removed from this team. Ask the team owner or a lead if you need to join again.',
  offline: 'The team cannot be reached right now.',
  paused: 'Team updates are paused for now.'
});

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The heading of a project that has a team. */
export function teamHeading(name: string): string {
  return `Team: ${name}`;
}

/** This computer is not on the team the project has. */
export function notOnTeamStatus(name: string): string {
  return `This project has the team ${name}. Join it with the invite you were sent.`;
}

/** Joined, and a lead still has to confirm the person. */
export function waitingStatus(name: string): string {
  return `You joined ${name}. A lead confirms you before you can make changes, so there is nothing to do until then.`;
}

/** A confirmed member who does not run the team. */
export function memberStatus(name: string): string {
  return `You are on ${name}. Open the board to see the work.`;
}

/** The owner or a lead, while the team setup is not on the online home yet. */
export function notSharedStatus(name: string): string {
  return `The setup of ${name} is not shared yet, so invites will not work until it is. Choose Share to put it online.`;
}

/** The owner or a lead, while teammates cannot reach the project online. */
export function notReachableStatus(name: string): string {
  return `Your teammates cannot reach this project yet, so they cannot join ${name}. Choose Share to see what to do.`;
}

/** The owner or a lead of a team that is ready for people. */
export function managerStatus(name: string, otherMembers: number, pendingInvites: number): string {
  const who = otherMembers === 0
    ? `${name} is ready. Invite someone to work with you.`
    : `${name} has ${otherMembers} ${plural(otherMembers, 'other member', 'other members')}. Invite someone to add more.`;
  return pendingInvites === 0 ? who : `${who} ${pendingInvites} ${plural(pendingInvites, 'invite is', 'invites are')} not used yet.`;
}

/** The status when the team cannot be reached or updates are paused: the connection text, as one sentence. */
export function connectionStatus(connectionText: string | undefined, kind: 'offline' | 'paused'): string {
  const text = (connectionText ?? '').trim();
  if (text === '') return kind === 'paused' ? TEAM_STATUS.paused : TEAM_STATUS.offline;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The badge on Members while people wait for the owner or a lead. */
export function waitingBadge(count: number): string {
  return `${count} waiting`;
}

/** What a screen reader says for a button with a badge, for example "Members, 2 waiting". The page builds the same form. */
export function accessibleLabel(label: string, badge?: string): string {
  return badge === undefined || badge === '' ? label : `${label}, ${badge}`;
}

/** The one line the board summary shows in the section. */
export function boardSummaryText(ready: number, blocked: number, mine: number): string {
  return `On the board: ${ready} ready, ${blocked} blocked, ${mine} ${plural(mine, 'is', 'are')} yours.`;
}
