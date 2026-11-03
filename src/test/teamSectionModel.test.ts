// The sidebar Team section model (G-61-5): every state a person can be in gives one heading, one plain status and the buttons to show, with exactly
// one primary next action; a board slot for Phase 62 and the setup steps SETUP-01 can register later. Pure, so these are plain table tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TEAM_ACTION_COMMANDS, TEAM_ACTION_IDS, isTeamActionId, teamSectionModel, teamSetupSteps } from '../domain/team/teamSection';
import type { TeamActionId, TeamSectionInput, TeamSectionModel } from '../domain/team/teamSection';
import * as text from '../domain/team/teamSectionText';

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

const ids = (m: TeamSectionModel): TeamActionId[] => m.actions.map((action) => action.id);
const primaries = (m: TeamSectionModel): TeamActionId[] => m.actions.filter((action) => action.primary).map((action) => action.id);

interface Case { name: string; input: TeamSectionInput; heading: string; status: string; primary?: TeamActionId; actions: TeamActionId[] }

const CASES: Case[] = [
  { name: 'no team', input: { folderOpen: true }, heading: 'Team', status: text.TEAM_STATUS.noTeam, primary: 'turn-on', actions: ['turn-on', 'join'] },
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
    name: 'a lead whose setup is not shared', input: { folderOpen: true, team: lead({ shared: 'no' }) },
    heading: text.teamHeading('Harbor'), status: text.notSharedStatus('Harbor'), primary: 'share', actions: ['share', 'members', 'board', 'link']
  },
  {
    name: 'a lead whose teammates cannot reach the project', input: { folderOpen: true, team: lead({ shared: 'not-reachable-by-teammates' }) },
    heading: text.teamHeading('Harbor'), status: text.notReachableStatus('Harbor'), primary: 'share', actions: ['share', 'members', 'board', 'link']
  },
  {
    name: 'a lead whose share state is unknown', input: { folderOpen: true, team: lead({ shared: 'unknown' }) },
    heading: text.teamHeading('Harbor'), status: text.managerStatus('Harbor', 1, 0), primary: 'invite', actions: ['invite', 'members', 'board', 'link']
  },
  {
    name: 'a lead whose share state is not checked yet', input: { folderOpen: true, team: lead({ shared: undefined }) },
    heading: text.teamHeading('Harbor'), status: text.managerStatus('Harbor', 1, 0), primary: 'invite', actions: ['invite', 'members', 'board', 'link']
  },
  {
    name: 'a lead with a shared setup and 2 people waiting', input: { folderOpen: true, team: lead({ waiting: 2 }) },
    heading: text.teamHeading('Harbor'), status: text.managerStatus('Harbor', 1, 0, 2), primary: 'invite', actions: ['invite', 'members', 'board', 'link']
  },
  {
    name: 'a linked lead', input: { folderOpen: true, team: lead({ linked: true, otherMembers: 0, pendingInvites: 2 }) },
    heading: text.teamHeading('Harbor'), status: text.managerStatus('Harbor', 0, 2), primary: 'invite', actions: ['invite', 'members', 'board']
  },
  {
    name: 'removed from the team', input: { folderOpen: true, team: developer({ removed: true }) },
    heading: text.teamHeading('Harbor'), status: text.TEAM_STATUS.removed, actions: []
  },
  {
    name: 'a lead while the team cannot be reached', input: { folderOpen: true, team: lead({ connection: 'offline', connectionText: 'Offline: no internet connection' }) },
    heading: text.teamHeading('Harbor'), status: 'Offline: no internet connection.', primary: 'check', actions: ['check', 'invite', 'members', 'board', 'link']
  },
  {
    name: 'a developer while updates are paused', input: { folderOpen: true, team: developer({ connection: 'paused', connectionText: 'Paused: the team record was changed by hand.' }) },
    heading: text.teamHeading('Harbor'), status: 'Paused: the team record was changed by hand.', primary: 'check', actions: ['check', 'members', 'board']
  },
  {
    name: 'a lead while paused with no connection text', input: { folderOpen: true, team: lead({ connection: 'paused', shared: 'no' }) },
    heading: text.teamHeading('Harbor'), status: text.TEAM_STATUS.paused, primary: 'check', actions: ['check', 'share', 'members', 'board', 'link']
  }
];

test('no folder open gives no Team section', () => {
  assert.equal(teamSectionModel({ folderOpen: false }), undefined);
  assert.equal(teamSectionModel({ folderOpen: false, team: lead() }), undefined);
});

test('every state gives its heading, status, primary action and ordered actions', () => {
  for (const entry of CASES) {
    const m = model(entry.input);
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
    const rest = ids(m).slice(1).map((id) => TEAM_ACTION_IDS.indexOf(id));
    assert.deepEqual(rest, [...rest].sort((a, b) => a - b), `${entry.name}: stable order`);
  }
});

test('the status sentences say the right thing in plain words', () => {
  assert.match(text.notOnTeamStatus('Harbor'), /Harbor/);
  assert.match(text.notOnTeamStatus('Harbor'), /invite/);
  assert.match(text.waitingStatus('Harbor'), /lead confirms you/);
  assert.match(text.notSharedStatus('Harbor'), /invites will not work until/);
  assert.match(text.notReachableStatus('Harbor'), /cannot reach this project yet/);
  assert.match(text.notReachableStatus('Harbor'), /Choose Share/);
  assert.match(text.TEAM_STATUS.removed, /removed/);
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

test('a lead with people waiting is also told so in the status, in plain words', () => {
  assert.equal(text.managerStatus('Harbor', 1, 0, 1), 'Harbor has 1 other member. Invite someone to add more. 1 person is waiting for you in Members.');
  assert.equal(text.managerStatus('Harbor', 2, 1, 2), 'Harbor has 2 other members. Invite someone to add more. 1 invite is not used yet. 2 people are waiting for you in Members.');
  assert.equal(model({ folderOpen: true, team: lead({ waiting: 1 }) }).status, text.managerStatus('Harbor', 1, 0, 1));
  assert.equal(model({ folderOpen: true, team: lead({ waiting: 0 }) }).status, text.managerStatus('Harbor', 1, 0));
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
  for (const entry of CASES) {
    if (entry.input.team === undefined) continue;
    const m = model(entry.input);
    assert.equal(ids(m).includes('board'), !entry.input.team.removed, `${entry.name}: Open board offered`);
  }
});

test('the setup steps: none done with no team, and a shared, invited, unlinked team has only the optional link left', () => {
  const none = teamSetupSteps({ folderOpen: true });
  assert.deepEqual(none.map((step) => [step.id, step.done]), [['team.turn-on', false], ['team.share', false], ['team.invite', false], ['team.link', false]]);
  const steps = teamSetupSteps({ folderOpen: true, team: lead({ shared: 'yes', pendingInvites: 1, otherMembers: 0, linked: false }) });
  assert.deepEqual(steps.map((step) => [step.id, step.done]), [['team.turn-on', true], ['team.share', true], ['team.invite', true], ['team.link', false]]);
  const link = steps.find((step) => step.id === 'team.link');
  assert.equal(link?.optional, true);
  assert.deepEqual(steps.map((step) => step.action), ['turn-on', 'share', 'invite', 'link']);
  for (const step of steps) {
    assert.ok(isTeamActionId(step.action), `${step.id} names an action`);
    assert.equal(step.title, text.TEAM_SETUP_TITLES[step.id]);
  }
  const joinedInvite = teamSetupSteps({ folderOpen: true, team: lead({ shared: 'no', pendingInvites: 0, otherMembers: 2, linked: true }) });
  assert.deepEqual(joinedInvite.map((step) => step.done), [true, false, true, true]);
});

test('every label and sentence comes from the text table and has no en or em dash', () => {
  const labels = new Set<string>(Object.values(text.TEAM_ACTION_LABELS));
  const hints = new Set<string>(Object.values(text.TEAM_ACTION_HINTS));
  for (const entry of CASES) {
    const m = model(entry.input);
    for (const action of m.actions) {
      assert.equal(action.label, text.TEAM_ACTION_LABELS[action.id], `${entry.name}: ${action.id} label`);
      assert.ok(labels.has(action.label));
      assert.ok(action.hint === undefined || hints.has(action.hint), `${entry.name}: ${action.id} hint`);
      assert.equal(action.hint, text.TEAM_ACTION_HINTS[action.id]);
    }
    for (const said of [m.heading, m.status, ...m.actions.flatMap((action) => [action.label, action.hint ?? '', action.badge ?? ''])]) {
      assert.ok(!/[–—]/.test(said), `${entry.name}: "${said}" has a dash`);
    }
  }
  const table = JSON.stringify([text.TEAM_SECTION_HEADING, text.TEAM_ACTION_LABELS, text.TEAM_ACTION_HINTS, text.TEAM_SETUP_TITLES, text.TEAM_STATUS]);
  assert.ok(!/[–—]/.test(table), 'the table has no dash');
});

test('the action ids are a closed list mapped to the existing team commands', () => {
  assert.deepEqual([...TEAM_ACTION_IDS], ['turn-on', 'join', 'share', 'invite', 'members', 'board', 'link', 'check']);
  assert.deepEqual(Object.keys(TEAM_ACTION_COMMANDS).sort(), [...TEAM_ACTION_IDS].sort());
  assert.equal(TEAM_ACTION_COMMANDS['turn-on'], 'nearAi.team.enable');
  assert.equal(TEAM_ACTION_COMMANDS.members, 'nearAi.team.manageMembers');
  assert.equal(TEAM_ACTION_COMMANDS.link, 'nearAi.team.linkNearOrganization');
  assert.equal(TEAM_ACTION_COMMANDS.check, 'nearAi.team.verifyLog');
  assert.ok(Object.isFrozen(TEAM_ACTION_COMMANDS));
  for (const bad of ['', 'Turn-on', 'delete', 'nearAi.team.enable', undefined, null, 3, ['join'], { id: 'join' }]) assert.equal(isTeamActionId(bad), false);
  for (const id of TEAM_ACTION_IDS) assert.equal(isTeamActionId(id), true);
});
