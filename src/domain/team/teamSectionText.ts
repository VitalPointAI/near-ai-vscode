// Every sentence and label of the sidebar Team section (G-61-5), in one place so a reviewer can read the words it speaks and the plain-language test
// finds it by its *Text.ts name. Plain words, sentence case, no git words, no en or em dash; the paying account is "your organization". Team names
// arrive already made display-safe by the host. Pure: no I/O, no clock, no vscode.

// The heading with no team (G-61-8): even one person works with a team of agents, so the section speaks of that, not of turning a feature on.
export const TEAM_SECTION_HEADING = 'Working with your agents';

// The button labels, one per action id of teamSection.ts.
export const TEAM_ACTION_LABELS = Object.freeze({
  invite: 'Invite someone',
  join: 'Join a team',
  ask: 'Ask to join',
  solo: 'Just me for now',
  share: 'Share',
  members: 'Members',
  board: 'Open board',
  link: 'Link your organization',
  check: 'Check the team'
});

// The two links of the quiet line on the empty chat after Just me for now. Join a team stays, because an invite tells the person to choose it.
export const TEAM_SOLO_LINE_LABELS = Object.freeze({
  invite: 'Invite people',
  join: 'Join a team'
});

// A short explanation per button, shown as its tooltip.
export const TEAM_ACTION_HINTS = Object.freeze({
  invite: 'Invite a person to work on this project with you. If the project has no team yet, it is set up on the way.',
  join: 'Join a team with the invite someone sent you.',
  ask: 'No invite yet? Send the team owner or a lead a request to join, and this computer joins by itself once they accept it.',
  solo: 'Put this away for this project. You can still invite people any time from the empty chat.',
  share: 'Put the team setup online so the people you invite can join.',
  members: 'See who is on the team, invite more people and confirm the people who joined.',
  board: 'Open the team board in an editor tab.',
  link: 'Link your organization so it pays for the team\'s AI use.',
  check: 'Check the team record and try to reach the team again.'
});

// The setup step titles (SETUP-01 registers these once main is merged in). Inviting sets the team up, so there is no separate turn-on step.
export const TEAM_SETUP_TITLES = Object.freeze({
  'team.invite': 'Invite people',
  'team.share': 'Share the team setup',
  'team.link': 'Link your organization'
});

// Sentences that do not depend on the team.
export const TEAM_STATUS = Object.freeze({
  noTeam: 'Want people to work with you too?',
  justMe: 'Working solo with your agents. Invite people any time.',
  onlyYou: 'Only you so far.',
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

/** The owner or a lead of a team nobody else has joined yet: only them, and the people invited who have not joined. */
export function onlyYouStatus(pendingInvites: number): string {
  if (pendingInvites === 0) return TEAM_STATUS.onlyYou;
  return `${TEAM_STATUS.onlyYou} ${pendingInvites} ${plural(pendingInvites, 'person you invited has', 'people you invited have')} not joined yet.`;
}

/** The owner or a lead once someone joined: how many people are on the team, and how many wait for them in Members (to confirm, or for a key). */
export function peopleStatus(name: string, otherMembers: number, waiting: number): string {
  const people = otherMembers + 1;
  const who = `${people} ${plural(people, 'person is', 'people are')} on ${name}.`;
  return waiting === 0 ? who : `${who} ${waiting} ${plural(waiting, 'person is', 'people are')} waiting for you in Members.`;
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

// The small Connect block the sidebar draws while no profile works and PR #7's Connect panel is not on the page (61-30): its title, one line and
// the two profile buttons, next to the team buttons.
export const TEAM_CONNECT_FALLBACK = Object.freeze({
  title: 'Connect NEAR AI to start',
  body: 'Set up a profile with your own key, use one you saved, or join a team that already has one.',
  setupLabel: 'Set up a new profile',
  savedLabel: 'Use a saved profile'
});

// The team buttons of the Connect screen whose words differ from the Team section's: a request that waits, and looking for the team key again.
export const TEAM_CONNECT_LABELS = Object.freeze({
  askPending: 'Show my request',
  check: 'Check again'
});

export const TEAM_CONNECT_HINTS = Object.freeze({
  askPending: 'See your request to join again, copy it or cancel it.',
  check: 'Look for your team key again now.'
});

/** The Connect screen in a project whose team this computer is not on. */
export function connectNotOnTeamStatus(name: string): string {
  return `This project has the team ${name}. Join it with the invite you were sent, or ask to join.`;
}

/** This computer asked to join and the request waits. */
export function requestWaitingStatus(name: string): string {
  return `Your request to join ${name} is waiting for a lead. This computer joins by itself once they accept it.`;
}

/** Joined a team that pays through its organization; the team key is not here yet. confirmed: a lead confirmed the person already. */
export function awaitingKeyStatus(name: string, confirmed: boolean): string {
  return confirmed
    ? `You are on ${name}. Your team key arrives once a lead sends it, and NEAR AI then uses it here.`
    : `You joined ${name}. Your team key arrives once a lead confirms you, and NEAR AI then uses it here.`;
}

/** On a team without an organization: each person brings their own key. */
export function ownKeyStatus(name: string): string {
  return `${name} has no organization linked, so each person uses their own key. Set up a new profile with your key or use a saved profile.`;
}
