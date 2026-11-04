// The sidebar Team section model (G-61-5, G-61-8): every state a person can be in gives one heading, one plain status and the buttons to show, with
// exactly one primary next action; a board slot for Phase 62 and the setup steps SETUP-01 can register later. With no team the section speaks of
// working with your agents and can be put away for the project (Just me for now), leaving one quiet line on the empty chat; a team that exists does
// not nag (61-UAT test 9, owner 2026-11-03). Pure, so these are plain table tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TEAM_ACTION_COMMANDS, TEAM_ACTION_IDS, isTeamActionId, teamSectionModel, teamSetupSteps } from '../domain/team/teamSection';
import type { TeamSectionInput, TeamSectionModel } from '../domain/team/teamSection';
import * as text from '../domain/team/teamSectionText';
import { bannedPattern } from './helpers/plainWords';

type Team = NonNullable<TeamSectionInput['team']>;

function lead(over: Partial<Team> = {}): Team {
  return {
    name: 'Harbor', myRole: 'lead', removed: false, canManage: true, waiting: 0, pendingInvites: 0, otherMembers: 1, linked: false,
    connection: 'live', shared: 'yes', ...over
  };
}

function developer(over: Partial<Team> = {}): Team {
  return lead({ myRole: 'developer', canManage: false, shared: undefined, ...over });
}

function model(input: TeamSectionInput): TeamSectionModel {
  const out = teamSectionModel(input);
  assert.ok(out !== undefined, 'a folder is open, so there is a model');
  return out;
}

const ids = (m: TeamSectionModel): string[] => m.actions.map((action) => action.id);
const primaries = (m: TeamSectionModel): string[] => m.actions.filter((action) => action.primary).map((action) => action.id);

// Ids as plain strings, so the table states the owner's list without leaning on the type it checks.
interface Case { name: string; input: TeamSectionInput; heading: string; status: string; primary?: string; actions: string[] }

const CASES: Case[] = [
  {
    name: 'no team', input: { folderOpen: true }, heading: 'Working with your agents', status: 'Want people to work with you too?',
    primary: 'invite', actions: ['invite', 'join', 'solo']
  },
  {
    name: 'a team this computer is not on', input: { folderOpen: true, team: lead({ myRole: undefined, canManage: false, shared: undefined }) },
    heading: text.teamHeading('Harbor'), status: text.notOnTeamStatus('Harbor'), primary: 'join', actions: ['join', 'board']
  },
  {
    name: 'joined and waiting for a lead', input: { folderOpen: true, team: developer({ myRole: undefined, pendingRole: 'developer' }) },
    heading: text.teamHeading('Harbor'), status: text.waitingStatus('Harbor'), primary: 'board', actions: ['board']
  },
  {
    name: 'a confirmed developer', input: { folderOpen: true, team: developer() },
    heading: text.teamHeading('Harbor'), status: text.memberStatus('Harbor'), primary: 'board', actions: ['board', 'members']
  },
  {
    name: 'an owner nobody else has joined yet', input: { folderOpen: true, team: lead({ myRole: 'owner', otherMembers: 0 }) },
    heading: text.teamHeading('Harbor'), status: 'Only you so far.', primary: 'invite', actions: ['invite', 'members', 'board']
  },
  {
    name: 'an owner with an invite not used yet', input: { folderOpen: true, team: lead({ myRole: 'owner', otherMembers: 0, pendingInvites: 1, linked: true }) },
    heading: text.teamHeading('Harbor'), status: text.onlyYouStatus(1), primary: 'invite', actions: ['invite', 'members', 'board']
  },
  {
    name: 'an owner nobody joined whose setup is not shared', input: { folderOpen: true, team: lead({ myRole: 'owner', otherMembers: 0, shared: 'no' }) },
    heading: text.teamHeading('Harbor'), status: text.notSharedStatus('Harbor'), primary: 'share', actions: ['share', 'invite', 'members', 'board']
  },
  {
    name: 'a lead with people whose setup is not shared', input: { folderOpen: true, team: lead({ shared: 'no' }) },
    heading: text.teamHeading('Harbor'), status: text.notSharedStatus('Harbor'), primary: 'share', actions: ['share', 'members', 'board']
  },
  {
    name: 'a lead whose teammates cannot reach the project', input: { folderOpen: true, team: lead({ shared: 'not-reachable-by-teammates' }) },
    heading: text.teamHeading('Harbor'), status: text.notReachableStatus('Harbor'), primary: 'share', actions: ['share', 'members', 'board']
  },
  {
    name: 'a lead with people whose share state is unknown', input: { folderOpen: true, team: lead({ shared: 'unknown' }) },
    heading: text.teamHeading('Harbor'), status: text.peopleStatus('Harbor', 1, 0), primary: 'members', actions: ['members', 'board']
  },
  {
    name: 'a lead with people whose share state is not checked yet', input: { folderOpen: true, team: lead({ shared: undefined }) },
    heading: text.teamHeading('Harbor'), status: text.peopleStatus('Harbor', 1, 0), primary: 'members', actions: ['members', 'board']
  },
  {
    name: 'a lead with a shared setup and 2 people waiting', input: { folderOpen: true, team: lead({ waiting: 2, otherMembers: 2 }) },
    heading: text.teamHeading('Harbor'), status: text.peopleStatus('Harbor', 2, 2), primary: 'members', actions: ['members', 'board']
  },
  {
    name: 'removed from the team', input: { folderOpen: true, team: developer({ removed: true }) },
    heading: text.teamHeading('Harbor'), status: text.TEAM_STATUS.removed, actions: []
  },
  {
    name: 'a lead with people while the team cannot be reached', input: { folderOpen: true, team: lead({ connection: 'offline', connectionText: 'Offline: no internet connection' }) },
    heading: text.teamHeading('Harbor'), status: 'Offline: no internet connection.', primary: 'check', actions: ['check', 'members', 'board']
  },
  {
    name: 'an owner nobody joined while the team cannot be reached', input: { folderOpen: true, team: lead({ otherMembers: 0, connection: 'offline' }) },
    heading: text.teamHeading('Harbor'), status: text.TEAM_STATUS.offline, primary: 'check', actions: ['check', 'invite', 'members', 'board']
  },
  {
    name: 'a developer while updates are paused', input: { folderOpen: true, team: developer({ connection: 'paused', connectionText: 'Paused: the team record was changed by hand.' }) },
    heading: text.teamHeading('Harbor'), status: 'Paused: the team record was changed by hand.', primary: 'check', actions: ['check', 'members', 'board']
  },
  {
    name: 'a lead while paused with no connection text', input: { folderOpen: true, team: lead({ connection: 'paused', shared: 'no' }) },
    heading: text.teamHeading('Harbor'), status: text.TEAM_STATUS.paused, primary: 'check', actions: ['check', 'share', 'members', 'board']
  }
];

test('no folder open gives no Team section', () => {
  assert.equal(teamSectionModel({ folderOpen: false }), undefined);
  assert.equal(teamSectionModel({ folderOpen: false, justMe: true }), undefined);
  assert.equal(teamSectionModel({ folderOpen: false, team: lead() }), undefined);
});

test('every state gives its heading, status, primary action and ordered actions', () => {
  for (const entry of CASES) {
    const m = model(entry.input);
    assert.equal(m.placement, 'section', `${entry.name}: drawn as the section`);
    assert.equal(m.heading, entry.heading, `${entry.name}: heading`);
    assert.equal(m.status, entry.status, `${entry.name}: status`);
    assert.deepEqual(ids(m), entry.actions, `${entry.name}: actions`);
    assert.deepEqual(primaries(m), entry.primary === undefined ? [] : [entry.primary], `${entry.name}: primary`);
  }
});

test('exactly one action is primary in every state that has actions, it comes first, and the rest keep the action id order', () => {
  for (const entry of CASES) {
    const m = model(entry.input);
    if (m.actions.length === 0) continue;
    assert.equal(primaries(m).length, 1, `${entry.name}: one primary`);
    assert.equal(m.actions[0].primary, true, `${entry.name}: primary first`);
    const rest = ids(m).slice(1).map((id) => (TEAM_ACTION_IDS as readonly string[]).indexOf(id));
    assert.deepEqual(rest, [...rest].sort((a, b) => a - b), `${entry.name}: stable order`);
  }
});

test('no state offers Link your organization or a way to turn anything on; the section does not nag once a team exists', () => {
  for (const entry of CASES) {
    const m = model(entry.input);
    assert.ok(!ids(m).includes('link'), `${entry.name}: no link button`);
    assert.ok(!ids(m).includes('turn-on'), `${entry.name}: no turn-on button`);
    if (entry.input.team !== undefined) assert.ok(!ids(m).includes('solo'), `${entry.name}: Just me for now is only for a project with no team`);
  }
  const joined = model({ folderOpen: true, team: lead({ otherMembers: 1 }) });
  assert.ok(!ids(joined).includes('invite'), 'once someone joined, inviting more people is in Members, not a button here');
});

test('with no team the section offers Invite someone, Join a team and Just me for now, with the words of the owner', () => {
  const m = model({ folderOpen: true });
  assert.equal(m.placement, 'section');
  assert.equal(m.compact, false, 'the heading is shown');
  assert.deepEqual(m.actions.map((action) => [action.id, action.label, action.primary]), [
    ['invite', 'Invite someone', true], ['join', 'Join a team', false], ['solo', 'Just me for now', false]
  ]);
});

test('Just me for now with no team leaves only the quiet empty-chat line, with Invite people and Join a team', () => {
  const m = model({ folderOpen: true, justMe: true });
  assert.equal(m.placement, 'empty-chat-line');
  assert.equal(m.heading, '', 'no heading');
  assert.equal(m.status, 'Working solo with your agents. Invite people any time.');
  assert.equal(m.status, text.TEAM_STATUS.justMe);
  assert.deepEqual(m.actions.map((action) => [action.id, action.label]), [['invite', 'Invite people'], ['join', 'Join a team']]);
  assert.deepEqual(primaries(m), ['invite']);
  assert.equal('board' in model({ folderOpen: true, justMe: true, board: { ready: 1, blocked: 0, mine: 0 } }), false, 'no board line');
  // Once the project has a team the choice no longer matters: the team's own section is drawn.
  const withTeam = model({ folderOpen: true, justMe: true, team: lead({ otherMembers: 0 }) });
  assert.equal(withTeam.placement, 'section');
  assert.deepEqual(ids(withTeam), ['invite', 'members', 'board']);
  assert.equal(model({ folderOpen: true, justMe: false }).placement, 'section');
});

test('the status sentences say the right thing in plain words', () => {
  assert.match(text.notOnTeamStatus('Harbor'), /Harbor/);
  assert.match(text.notOnTeamStatus('Harbor'), /invite/);
  assert.match(text.waitingStatus('Harbor'), /lead confirms you/);
  assert.match(text.notSharedStatus('Harbor'), /invites will not work until/);
  assert.match(text.notReachableStatus('Harbor'), /cannot reach this project yet/);
  assert.match(text.notReachableStatus('Harbor'), /Choose Share/);
  assert.match(text.TEAM_STATUS.removed, /removed/);
  assert.equal(text.onlyYouStatus(0), 'Only you so far.');
  assert.equal(text.onlyYouStatus(1), 'Only you so far. 1 person you invited has not joined yet.');
  assert.equal(text.onlyYouStatus(2), 'Only you so far. 2 people you invited have not joined yet.');
});

test('a lead with people waiting sees the count on Members, and only a manager does', () => {
  const m = model({ folderOpen: true, team: lead({ waiting: 2 }) });
  const members = m.actions.find((action) => action.id === 'members');
  assert.ok(members !== undefined);
  assert.equal(members.badge, '2 waiting');
  assert.equal(members.badge, text.waitingBadge(2));
  assert.equal(text.accessibleLabel(members.label, members.badge), 'Members, 2 waiting');
  assert.equal(model({ folderOpen: true, team: lead({ waiting: 0 }) }).actions.find((action) => action.id === 'members')?.badge, undefined);
  assert.equal(model({ folderOpen: true, team: developer({ waiting: 3 }) }).actions.find((action) => action.id === 'members')?.badge, undefined);
});

test('once someone joined the status names how many people are on the team and who waits in Members', () => {
  assert.equal(text.peopleStatus('Harbor', 1, 0), '2 people are on Harbor.');
  assert.equal(text.peopleStatus('Harbor', 1, 1), '2 people are on Harbor. 1 person is waiting for you in Members.');
  assert.equal(text.peopleStatus('Harbor', 3, 2), '4 people are on Harbor. 2 people are waiting for you in Members.');
  assert.equal(model({ folderOpen: true, team: lead({ waiting: 1 }) }).status, text.peopleStatus('Harbor', 1, 1));
  assert.equal(model({ folderOpen: true, team: lead({ waiting: 0 }) }).status, text.peopleStatus('Harbor', 1, 0));
});

test('the board slot is shown only when the host supplies it, and Open board is offered in every team state except removed', () => {
  const withBoard = model({ folderOpen: true, team: developer(), board: { ready: 3, blocked: 1, mine: 2 } });
  assert.deepEqual(withBoard.board, { ready: 3, blocked: 1, mine: 2, text: text.boardSummaryText(3, 1, 2) });
  assert.match(withBoard.board?.text ?? '', /3 ready/);
  assert.match(withBoard.board?.text ?? '', /1 blocked/);
  assert.match(withBoard.board?.text ?? '', /2 are yours/);
  assert.equal('board' in model({ folderOpen: true, team: developer() }), false, 'no board input, no board field');
  assert.equal('board' in model({ folderOpen: true, board: { ready: 1, blocked: 0, mine: 0 } }), false, 'no team, no board summary');
  assert.equal('board' in model({ folderOpen: true, team: developer({ removed: true }), board: { ready: 1, blocked: 0, mine: 0 } }), false, 'removed, no board summary');
  assert.equal(model({ folderOpen: true, team: lead(), board: { ready: 1, blocked: 0, mine: 0 } }).board?.text, text.boardSummaryText(1, 0, 0), 'a team with people shows the line');
  for (const entry of CASES) {
    if (entry.input.team === undefined) continue;
    const m = model(entry.input);
    assert.equal(ids(m).includes('board'), !entry.input.team.removed, `${entry.name}: Open board offered`);
  }
});

test('the setup steps: Invite people first and optional, then share and link; no turn-on step, and Just me for now skips them', () => {
  const none = teamSetupSteps({ folderOpen: true });
  assert.deepEqual(none.map((step) => [step.id, step.done, step.skipped]), [['team.invite', false, false], ['team.share', false, false], ['team.link', false, false]]);
  assert.equal(none[0].title, 'Invite people');
  assert.equal(none[0].optional, true);
  assert.equal(none[0].action, 'invite');
  const solo = teamSetupSteps({ folderOpen: true, justMe: true });
  assert.deepEqual(solo.map((step) => [step.id, step.done, step.skipped]), [['team.invite', false, true], ['team.share', false, true], ['team.link', false, true]]);
  const invited = teamSetupSteps({ folderOpen: true, team: lead({ shared: 'yes', pendingInvites: 1, otherMembers: 0, linked: false }) });
  assert.deepEqual(invited.map((step) => [step.id, step.done, step.skipped]), [['team.invite', true, false], ['team.share', true, false], ['team.link', false, false]]);
  assert.deepEqual(invited.map((step) => step.action), ['invite', 'share', 'link']);
  assert.deepEqual(invited.map((step) => step.optional), [true, false, true]);
  for (const step of invited) {
    assert.ok(isTeamActionId(step.action), `${step.id} names an action`);
    assert.equal(step.title, text.TEAM_SETUP_TITLES[step.id]);
  }
  const joined = teamSetupSteps({ folderOpen: true, justMe: true, team: lead({ shared: 'no', pendingInvites: 0, otherMembers: 2, linked: true }) });
  assert.deepEqual(joined.map((step) => [step.done, step.skipped]), [[true, false], [false, false], [true, false]], 'a team that exists is never skipped');
  const alone = teamSetupSteps({ folderOpen: true, team: lead({ otherMembers: 0, pendingInvites: 0 }) });
  assert.equal(alone[0].done, false, 'a team of one has not invited anyone yet');
  assert.ok(!(teamSetupSteps({ folderOpen: true }).map((step) => step.id) as string[]).includes('team.turn-on'));
});

test('every label and sentence comes from the text table, with no en or em dash, no developer word and not the old feature name', () => {
  const labels = new Set<string>([...Object.values(text.TEAM_ACTION_LABELS), ...Object.values(text.TEAM_SOLO_LINE_LABELS)]);
  const hints = new Set<string>(Object.values(text.TEAM_ACTION_HINTS));
  const inputs = [...CASES.map((entry) => ({ name: entry.name, input: entry.input })), { name: 'just me', input: { folderOpen: true, justMe: true } }];
  for (const entry of inputs) {
    const m = model(entry.input);
    for (const action of m.actions) {
      assert.ok(labels.has(action.label), `${entry.name}: ${action.id} label`);
      assert.ok(action.hint === undefined || hints.has(action.hint), `${entry.name}: ${action.id} hint`);
      assert.equal(action.hint, text.TEAM_ACTION_HINTS[action.id]);
    }
    for (const said of [m.heading, m.status, ...m.actions.flatMap((action) => [action.label, action.hint ?? '', action.badge ?? ''])]) {
      assert.ok(!/[–—]/.test(said), `${entry.name}: "${said}" has a dash`);
      assert.ok(!/team\s+mode/i.test(said), `${entry.name}: "${said}" names the old feature`);
      assert.ok(!bannedPattern.test(said), `${entry.name}: "${said}" has a developer word`);
    }
  }
  const table = JSON.stringify([text.TEAM_SECTION_HEADING, text.TEAM_ACTION_LABELS, text.TEAM_SOLO_LINE_LABELS, text.TEAM_ACTION_HINTS, text.TEAM_SETUP_TITLES, text.TEAM_STATUS]);
  assert.ok(!/[–—]/.test(table), 'the table has no dash');
  assert.ok(!/team\s+mode/i.test(table), 'the table does not name the old feature');
  assert.equal(text.TEAM_SECTION_HEADING, 'Working with your agents');
});

test('the action ids are a closed list; every one but Just me for now maps to an existing team command', () => {
  assert.deepEqual([...TEAM_ACTION_IDS], ['invite', 'join', 'ask', 'solo', 'share', 'members', 'board', 'link', 'check']);
  assert.deepEqual(Object.keys(TEAM_ACTION_COMMANDS).sort(), (TEAM_ACTION_IDS as readonly string[]).filter((id) => id !== 'solo').sort());
  assert.equal(TEAM_ACTION_COMMANDS.invite, 'nearAi.team.invite');
  assert.equal(TEAM_ACTION_COMMANDS.join, 'nearAi.team.join');
  assert.equal((TEAM_ACTION_COMMANDS as Readonly<Record<string, string>>).ask, 'nearAi.team.askToJoin', 'Ask to join runs only the Ask to Join a Team command (61-29)');
  assert.equal(TEAM_ACTION_COMMANDS.members, 'nearAi.team.manageMembers');
  assert.equal(TEAM_ACTION_COMMANDS.link, 'nearAi.team.linkNearOrganization');
  assert.equal(TEAM_ACTION_COMMANDS.check, 'nearAi.team.verifyLog');
  assert.equal('solo' in TEAM_ACTION_COMMANDS, false, 'Just me for now runs no command');
  assert.ok(!Object.values(TEAM_ACTION_COMMANDS).includes('nearAi.team.enable'), 'no button turns anything on');
  assert.ok(Object.isFrozen(TEAM_ACTION_COMMANDS));
  for (const bad of ['', 'turn-on', 'Solo', 'delete', 'nearAi.team.enable', undefined, null, 3, ['join'], { id: 'join' }]) assert.equal(isTeamActionId(bad), false);
  for (const id of TEAM_ACTION_IDS) assert.equal(isTeamActionId(id), true);
});

// ---- the Connect screen (61-30, G-61-9) -------------------------------------------------------------------------------------------------------
// While no profile works, the Connect screen offers the team way in too: a person can join a team (or ask to) without making a profile first.

const connectIds = (m: TeamSectionModel): string[] => (m.connect?.actions ?? []).map((action) => action.id);

test('tracer: with no team the Connect screen offers Join a team and Ask to join, with no status, and the fallback words of the Connect block', () => {
  const m = model({ folderOpen: true });
  assert.ok(m.connect !== undefined, 'the model has a connect part');
  assert.deepEqual(m.connect.actions.map((action) => [action.id, action.label]), [['join', 'Join a team'], ['ask', 'Ask to join']]);
  assert.equal(m.connect.status, undefined, 'nothing to explain yet');
  assert.deepEqual(m.connect.fallback, {
    title: 'Connect NEAR AI to start', body: text.TEAM_CONNECT_FALLBACK.body, setupLabel: 'Set up a new profile', savedLabel: 'Use a saved profile'
  });
  assert.ok(m.connect.fallback.body.length > 0 && !m.connect.fallback.body.includes('\n'), 'a one-line body');
  // Just me for now is about the Team section once a profile works; the Connect screen still offers the team way in.
  assert.deepEqual(connectIds(model({ folderOpen: true, justMe: true })), ['join', 'ask']);
  // The section itself with a working profile is unchanged (61-26).
  assert.deepEqual(ids(m), ['invite', 'join', 'solo']);
});
