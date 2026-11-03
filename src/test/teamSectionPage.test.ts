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

// ---- page details (Task 3) -------------------------------------------------------------------------------------------------------------------

function leadWaiting(over: Partial<NonNullable<TeamSectionInput['team']>> = {}): TeamSectionModel {
  return model({ folderOpen: true, team: team({ myRole: 'lead', waiting: 2, ...over }) });
}

const named = (h: BoardHarness, id: string): FakeNode => { const node = h.$(`#team button[data-action="${id}"]`); assert.ok(node !== null, `${id} is drawn`); return node; };

test('Members with a waiting count shows the badge in its own element and says it in the accessible name; the primary button comes first', () => {
  const h = sidebar();
  h.deliver({ type: 'team-state', model: leadWaiting() });
  const members = named(h, 'members');
  const badge = members.querySelector('.team-badge');
  assert.ok(badge !== null, 'the badge is a separate element');
  assert.equal(badge.textContent, '2 waiting');
  assert.ok(members.textContent.includes('Members') && members.textContent.includes('2 waiting'));
  assert.equal(members.getAttribute('aria-label'), 'Members, 2 waiting');
  assert.equal(named(h, 'invite').getAttribute('aria-label'), null, 'a button without a badge is named by its text');
  const drawn = buttons(h);
  assert.equal(drawn[0].getAttribute('data-action'), 'invite');
  assert.ok(drawn[0].classList.contains('primary'));
  assert.ok(drawn.slice(1).every((button) => !button.classList.contains('primary')), 'only one primary button');
  assert.equal(named(h, 'invite').getAttribute('title'), leadWaiting().actions[0].hint, 'the hint is the tooltip');
});

test('the status line is a polite live region that changes its text in place, and focus stays on a button that is drawn again', () => {
  const h = sidebar();
  h.deliver({ type: 'team-state', model: leadWaiting() });
  const status = h.$('#team .team-status');
  assert.ok(status !== null);
  assert.equal(status.getAttribute('aria-live'), 'polite');
  named(h, 'members').focus();
  const next = leadWaiting({ otherMembers: 4 });
  h.deliver({ type: 'team-state', model: next });
  assert.equal(h.$('#team .team-status'), status, 'the same element');
  assert.equal(status.textContent, next.status);
  assert.equal(h.focused().getAttribute('data-action'), 'members', 'focus is not lost by an update');
  h.deliver({ type: 'team-state', model: model({ folderOpen: true, team: team({ shared: 'no' }) }) });
  assert.equal(h.$('#team .team-status'), status, 'still the same element when the buttons change');
  assert.deepEqual(buttons(h).map((button) => button.getAttribute('data-action')), ['share', 'members', 'board', 'link']);
});

test('a board summary is one line inside the section, and a later model without it removes the line', () => {
  const h = sidebar();
  const withBoard = model({ folderOpen: true, team: team({ myRole: 'developer', canManage: false, shared: undefined }), board: { ready: 3, blocked: 1, mine: 2 } });
  h.deliver({ type: 'team-state', model: withBoard });
  const lines = h.$$('#team .team-board');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].textContent, withBoard.board?.text);
  h.deliver({ type: 'team-state', model: model({ folderOpen: true, team: team({ myRole: 'developer', canManage: false, shared: undefined }) }) });
  assert.equal(h.$$('#team .team-board').length, 0);
});

test('compact draws the actions in one row under the status with the heading hidden; full also shows the heading', () => {
  const h = sidebar();
  const compact = model({ folderOpen: true });
  assert.equal(compact.compact, true);
  h.deliver({ type: 'team-state', model: compact });
  assert.ok(section(h).classList.contains('compact'));
  const heading = h.$('#team .team-heading');
  assert.ok(heading !== null);
  assert.equal(heading.hidden, true, 'compact hides the heading; the region is still named Team');
  assert.equal(h.$$('#team .team-actions').length, 1, 'one row of actions');
  const kids = Array.from(section(h).children);
  assert.ok(kids.indexOf(h.$('#team .team-status') as FakeNode) < kids.indexOf(h.$('#team .team-actions') as FakeNode), 'status above the actions');
  const full = model({ folderOpen: true, team: team({ myRole: 'developer', canManage: false, shared: undefined }) });
  assert.equal(full.compact, false);
  h.deliver({ type: 'team-state', model: full });
  assert.ok(!section(h).classList.contains('compact'));
  assert.equal(h.$('#team .team-heading')?.hidden, false);
  assert.equal(h.$('#team .team-heading')?.textContent, full.heading);
});

test('the e2e probe answers what is drawn, clicks a drawn button through the normal handler, and refuses an action that is not drawn', () => {
  const h = sidebar();
  const lead = leadWaiting();
  h.deliver({ type: 'team-state', model: lead });
  h.deliver({ type: 'team-e2e', id: 7 });
  assert.deepEqual(h.posts, [{
    type: 'team-e2e-facts', id: 7, heading: lead.heading, status: lead.status,
    actions: [{ id: 'invite', label: 'Invite someone' }, { id: 'members', label: 'Members', badge: '2 waiting' }, { id: 'board', label: 'Open board' }, { id: 'link', label: 'Link your organization' }]
  }]);
  h.posts.length = 0;
  h.deliver({ type: 'team-e2e', id: 8, click: 'invite' });
  assert.equal(h.posts.length, 2);
  assert.deepEqual(h.posts[0], { type: 'team-action', action: 'invite' });
  const clicked: Record<string, unknown> = h.posts[1];
  assert.equal(clicked.type, 'team-e2e-facts');
  assert.equal(clicked.id, 8);
  assert.equal(clicked.error, undefined);
  h.posts.length = 0;
  h.deliver({ type: 'team-e2e', id: 9, click: 'turn-on' });
  assert.equal(h.posts.length, 1, 'nothing but the answer');
  const refused: Record<string, unknown> = h.posts[0];
  assert.equal(refused.type, 'team-e2e-facts');
  assert.equal(refused.id, 9);
  assert.equal(typeof refused.error, 'string');
  assert.ok(String(refused.error).length > 0);
  h.posts.length = 0;
  h.deliver({ type: 'team-e2e', id: 'x' });
  assert.deepEqual(h.posts, [], 'a probe without a numeric id is ignored');
});

test('a click posts the id bound when the button was drawn, even if the DOM is altered, and an unknown action id is never drawn', () => {
  const h = sidebar();
  const owner = model({ folderOpen: true, team: team() });
  h.deliver({ type: 'team-state', model: { ...owner, actions: [...owner.actions, { id: 'delete-everything', label: 'Delete', primary: false }] } });
  assert.deepEqual(buttons(h).map((button) => button.getAttribute('data-action')), ['invite', 'members', 'board', 'link']);
  const invite = named(h, 'invite');
  invite.setAttribute('data-action', 'delete-everything');
  invite.dataset.action = 'nearAi.something';
  h.click(invite);
  assert.deepEqual(h.posts, [{ type: 'team-action', action: 'invite' }]);
});

test('a team name that looks like markup is drawn as text', () => {
  const h = sidebar();
  h.deliver({ type: 'team-state', model: model({ folderOpen: true, team: team({ myRole: 'developer', canManage: false, name: '<img src=x onerror=alert(1)>' }) }) });
  assert.ok((h.$('#team .team-heading')?.textContent ?? '').includes('<img src=x onerror=alert(1)>'));
  assert.equal(h.$$('#team img').length, 0);
});

// ---- asset safety (mirrors teamBoardAssets.test.ts) ------------------------------------------------------------------------------------------

const teamJs = (): string => readFileSync(path.join(ROOT, 'media', 'chat', 'team.js'), 'utf8');

test('team.js builds no markup from a string, evaluates no code, reaches no network and never stores page state', () => {
  const sinks = [/\.innerHTML\b/, /\.outerHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write\b/, /\bsrcdoc\b/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\bimportScripts\b/, /\bsetState\b/, /\bacquireVsCodeApi\b/];
  const source = teamJs();
  for (const sink of sinks) assert.ok(!sink.test(source), `team.js uses ${sink}`);
});

test('team.js has no en or em dash and no colour literal, and is one strict-mode IIFE', () => {
  const source = teamJs();
  assert.ok(!/[–—]/.test(source), 'no dash character');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(source), 'no hex colour');
  assert.ok(!/\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\s*\(/i.test(source), 'no colour function');
  const code = source.split('\n').filter((line) => !/^\s*(\/\/.*)?$/.test(line));
  assert.match(code[0] ?? '', /^\(function \(\) \{$/);
  assert.equal(code[1]?.trim(), "'use strict';");
  assert.match(code[code.length - 1] ?? '', /^\}\)?\(\)\)?;$/);
});

test('team.js posts only the action ids of TEAM_ACTION_IDS', () => {
  const { TEAM_ACTION_IDS } = require('../domain/team/teamSection') as typeof import('../domain/team/teamSection');
  const list = /const ACTIONS = Object\.freeze\(\[([^\]]*)\]\)/.exec(teamJs())?.[1] ?? '';
  assert.deepEqual([...list.matchAll(/'([^']+)'/g)].map((match) => match[1]), [...TEAM_ACTION_IDS]);
});

test('the Team section styles use only theme colours, and team.js is on the release content list', () => {
  const css = readFileSync(path.join(ROOT, 'media', 'chat', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((match) => match[1].includes('#team'));
  assert.ok(rules.length >= 3, 'the section has its styles');
  for (const [, selector, body] of rules) {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(body), `${selector.trim()} has a hex colour`);
    assert.ok(!/\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\s*\(/i.test(body), `${selector.trim()} has a colour function`);
    for (const declaration of body.split(';')) {
      if (/^\s*(color|background|background-color|border|border-[a-z-]*|outline|outline-color)\s*:/.test(declaration) && /\b(solid|dashed|dotted)\b|color|background/.test(declaration)) {
        const value = declaration.split(':').slice(1).join(':');
        if (/\b(none|transparent|0|inherit|currentColor)\b/.test(value) && !/var\(/.test(value)) continue;
        assert.ok(/var\(--vscode-/.test(value), `${selector.trim()}: ${declaration.trim()} takes its colour from the theme`);
      }
    }
  }
  const release = readFileSync(path.join(ROOT, 'scripts', 'verify-release-content.mjs'), 'utf8');
  assert.ok(release.includes("'extension/media/chat/team.js'"));
  for (const file of ['chat.js', 'chat.css', 'markdown.js', 'pending.js', 'composer.js', 'team.js']) {
    assert.ok(release.includes(`'extension/media/chat/${file}'`), `${file} is on the release list`);
  }
});
