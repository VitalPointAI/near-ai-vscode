// The sidebar Team section page (media/chat/team.js, G-61-5): it draws the model the host sends as real buttons with text labels and posts only
// {type:'team-action', action} for a fixed list of ids. Run in the fake DOM, whose elements throw on any markup string.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { teamSectionModel } from '../domain/team/teamSection';
import type { TeamSectionInput, TeamSectionModel } from '../domain/team/teamSection';
import { createBoardHarness } from './helpers/fakeDom';
import type { BoardHarness, FakeNode } from './helpers/fakeDom';

const ROOT = path.resolve(__dirname, '..', '..');

function sidebar(): BoardHarness {
  const h = createBoardHarness({ scripts: 'chat', teamSection: true, nearChat: true });
  h.load(['team.js']);
  return h;
}

function team(over: Partial<NonNullable<TeamSectionInput['team']>> = {}): NonNullable<TeamSectionInput['team']> {
  return {
    name: 'Harbor', myRole: 'owner', removed: false, canManage: true, waiting: 0, pendingInvites: 0, otherMembers: 0, linked: false,
    connection: 'live', shared: 'yes', ...over
  };
}

function model(input: TeamSectionInput): TeamSectionModel {
  const out = teamSectionModel(input);
  assert.ok(out !== undefined, 'a folder is open, so there is a model');
  return out;
}

const buttons = (h: BoardHarness): FakeNode[] => h.$$('#team button');
const section = (h: BoardHarness): FakeNode => { const node = h.$('#team'); assert.ok(node !== null); return node; };

test('tracer: with no team the page draws Turn on Team Mode and Join a team as buttons, and a click posts one fixed team-action', () => {
  const h = sidebar();
  const noTeam = model({ folderOpen: true });
  h.deliver({ type: 'team-state', model: noTeam });
  assert.equal(section(h).hidden, false, 'the section is shown');
  assert.ok(section(h).textContent.includes(noTeam.status), 'the status line is drawn');
  const drawn = buttons(h);
  assert.deepEqual(drawn.map((button) => button.textContent), ['Turn on Team Mode', 'Join a team']);
  assert.deepEqual(drawn.map((button) => button.getAttribute('data-action')), ['turn-on', 'join']);
  assert.ok(drawn.every((button) => button.getAttribute('type') === 'button'));
  h.click(drawn[0]);
  assert.deepEqual(h.posts, [{ type: 'team-action', action: 'turn-on' }]);
});

test('the model gives no team a Team heading, a status inviting the person to work with others, and turn-on as the one primary action', () => {
  const noTeam = model({ folderOpen: true });
  assert.equal(noTeam.heading, 'Team');
  assert.match(noTeam.status, /other people/);
  assert.equal(noTeam.compact, true);
  assert.deepEqual(noTeam.actions.map((action) => [action.id, action.primary]), [['turn-on', true], ['join', false]]);
  assert.equal(teamSectionModel({ folderOpen: false }), undefined, 'no folder, no section');
});

test('an owner whose team setup is shared gets Invite someone as the only primary action, then Members, Open board and Link your organization', () => {
  const owner = model({ folderOpen: true, team: team() });
  assert.deepEqual(owner.actions.map((action) => action.id), ['invite', 'members', 'board', 'link']);
  assert.deepEqual(owner.actions.filter((action) => action.primary).map((action) => action.id), ['invite']);
  const h = sidebar();
  h.deliver({ type: 'team-state', model: owner });
  assert.deepEqual(buttons(h).map((button) => button.textContent), ['Invite someone', 'Members', 'Open board', 'Link your organization']);
  const primary = buttons(h)[0];
  assert.ok(primary.classList.contains('primary'), 'the primary button is marked');
  const describedBy = primary.getAttribute('aria-describedby');
  assert.ok(describedBy !== null && h.document.getElementById(describedBy)?.textContent === owner.status, 'the primary button is described by the status');
  h.click(buttons(h)[1]);
  assert.deepEqual(h.posts, [{ type: 'team-action', action: 'members' }]);
});

test('a null model empties and hides the section', () => {
  const h = sidebar();
  h.deliver({ type: 'team-state', model: model({ folderOpen: true }) });
  h.deliver({ type: 'team-state', model: null });
  assert.equal(section(h).hidden, true);
  assert.equal(section(h).children.length, 0);
  assert.equal(buttons(h).length, 0);
});

test('chat.js exposes its post function once as window.nearChat, right after acquireVsCodeApi', () => {
  const chat = readFileSync(path.join(ROOT, 'media', 'chat', 'chat.js'), 'utf8').split('\n');
  const lines = chat.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => line.includes('window.nearChat'));
  assert.equal(lines.length, 1, 'one window.nearChat line');
  assert.equal(lines[0].line, 'window.nearChat = Object.freeze({ post });');
  const api = chat.findIndex((line) => line.includes('acquireVsCodeApi()'));
  assert.equal(lines[0].index, api + 1, 'directly after acquireVsCodeApi');
});
