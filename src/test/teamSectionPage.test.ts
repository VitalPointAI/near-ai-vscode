// The sidebar Team section page (media/chat/team.js, G-61-5): it draws the model the host sends as real buttons with text labels and posts only
// {type:'team-action', action} for a fixed list of ids. Run in the fake DOM, whose elements throw on any markup string.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { teamSectionModel } from '../domain/team/teamSection';
import * as text from '../domain/team/teamSectionText';
import type { TeamSectionInput, TeamSectionModel } from '../domain/team/teamSection';
import { createBoardHarness } from './helpers/fakeDom';
import type { BoardHarness, FakeNode } from './helpers/fakeDom';

const ROOT = path.resolve(__dirname, '..', '..');

type Status = 'pending' | 'valid' | 'stale' | 'invalid';

/** A profile-status value with one profile, active, whose key check has `status` (61-25: the Team section needs a working profile). */
function profileValue(status: Status, active = true): Record<string, unknown> {
  return {
    projectScope: 'project', activeProfileId: active ? 'mine' : undefined, configured: active,
    profiles: [{ profileId: 'mine', displayName: 'Mine', organization: 'Org', provider: 'near-ai', baseUrl: 'https://example.invalid', authMode: 'apiKey', validation: { status } }]
  };
}

const READY = { type: 'profile-status', value: profileValue('valid') };

/** The sidebar page with the readiness rule and the Team section loaded, a message box (#input) and no profile-status yet. */
function bare(): BoardHarness {
  const h = createBoardHarness({ scripts: 'chat', teamSection: true, nearChat: true });
  const input = h.document.createElement('textarea');
  input.id = 'input';
  // The empty chat's welcome, inside the transcript, as panelView.ts draws it; chat.js hides it during a conversation.
  const transcript = h.document.createElement('main');
  transcript.id = 'transcript';
  const welcome = h.document.createElement('section');
  welcome.id = 'welcome';
  const title = h.document.createElement('h2');
  title.textContent = 'Private AI for this project';
  const intro = h.document.createElement('p');
  intro.textContent = 'Ask anything about your code.';
  welcome.append(title, intro);
  transcript.append(welcome);
  h.document.body.append(transcript, input);
  h.load(['readiness.js', 'team.js']);
  return h;
}

/** The sidebar page once the project's profile works, so the Team section draws what the host sends. */
function sidebar(): BoardHarness {
  const h = bare();
  h.deliver(READY);
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

test('tracer: with no team the page draws Invite someone, Join a team and Just me for now, and Just me for now posts the solo action', () => {
  const h = sidebar();
  const noTeam = model({ folderOpen: true });
  h.deliver({ type: 'team-state', model: noTeam });
  assert.equal(section(h).hidden, false, 'the section is shown');
  assert.equal(h.$('#team .team-heading')?.textContent, 'Working with your agents');
  assert.equal(h.$('#team .team-heading')?.hidden, false, 'the heading is shown');
  assert.ok(section(h).textContent.includes('Want people to work with you too?'), 'the status line is drawn');
  const drawn = buttons(h);
  assert.deepEqual(drawn.map((button) => button.textContent), ['Invite someone', 'Join a team', 'Just me for now']);
  assert.deepEqual(drawn.map((button) => button.getAttribute('data-action')), ['invite', 'join', 'solo']);
  assert.ok(drawn.every((button) => button.getAttribute('type') === 'button'));
  assert.ok(!section(h).textContent.includes('Team Mode'), 'the old feature name is not on screen');
  h.click(drawn[2]);
  assert.deepEqual(h.posts, [{ type: 'team-action', action: 'solo' }]);
  h.posts.length = 0;
  h.click(drawn[0]);
  assert.deepEqual(h.posts, [{ type: 'team-action', action: 'invite' }]);
});

test('the model gives no team the working-with-your-agents heading, the invite question and Invite someone as the one primary action', () => {
  const noTeam = model({ folderOpen: true });
  assert.equal(noTeam.heading, 'Working with your agents');
  assert.equal(noTeam.status, 'Want people to work with you too?');
  assert.equal(noTeam.compact, false);
  assert.deepEqual(noTeam.actions.map((action) => [action.id, action.primary]), [['invite', true], ['join', false], ['solo', false]]);
  assert.equal(teamSectionModel({ folderOpen: false }), undefined, 'no folder, no section');
});

test('an owner nobody has joined yet gets Invite someone as the only primary action, then Members and Open board', () => {
  const owner = model({ folderOpen: true, team: team() });
  assert.deepEqual(owner.actions.map((action) => action.id), ['invite', 'members', 'board']);
  assert.deepEqual(owner.actions.filter((action) => action.primary).map((action) => action.id), ['invite']);
  const h = sidebar();
  h.deliver({ type: 'team-state', model: owner });
  assert.deepEqual(buttons(h).map((button) => button.textContent), ['Invite someone', 'Members', 'Open board']);
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

// ---- no Team section until a profile works (61-25, G-61-7) -----------------------------------------------------------------------------------

test('tracer: no Team section before a profile works; it appears by itself once the profile works and hides again when it stops', () => {
  const h = bare();
  const noTeam = model({ folderOpen: true });
  h.deliver({ type: 'team-state', model: noTeam });
  assert.equal(section(h).hidden, true, 'a model before any profile-status is not shown');
  assert.equal(buttons(h).length, 0, 'nothing is drawn');
  h.deliver({ type: 'profile-status', value: { projectScope: 'project', activeProfileId: undefined, configured: false, profiles: [] } });
  assert.equal(section(h).hidden, true, 'no saved profile keeps it hidden');
  h.deliver({ type: 'profile-status', value: profileValue('valid', false) });
  assert.equal(section(h).hidden, true, 'working profiles but none chosen keeps it hidden');
  h.deliver(READY);
  assert.equal(section(h).hidden, false, 'shown without another team-state');
  assert.deepEqual(buttons(h).map((button) => button.textContent), ['Invite someone', 'Join a team', 'Just me for now']);
  h.deliver({ type: 'profile-status', value: profileValue('stale') });
  assert.equal(section(h).hidden, true, 'a profile that needs checking hides it again');
  h.deliver({ type: 'profile-status', value: profileValue('valid') });
  assert.equal(section(h).hidden, false);
  h.click(buttons(h)[0]);
  assert.deepEqual(h.posts, [{ type: 'team-action', action: 'invite' }]);
});

test('when the section hides with focus on one of its buttons, focus moves to the message box; focus elsewhere is left alone', () => {
  const h = sidebar();
  h.deliver({ type: 'team-state', model: model({ folderOpen: true }) });
  buttons(h)[0].focus();
  assert.equal(h.focused().getAttribute('data-action'), 'invite');
  h.deliver({ type: 'profile-status', value: profileValue('pending') });
  assert.equal(section(h).hidden, true);
  assert.equal(h.focused().id, 'input', 'focus is in the message box');
  h.deliver(READY);
  const other = h.document.createElement('button');
  h.document.body.append(other);
  other.focus();
  h.deliver({ type: 'profile-status', value: profileValue('invalid') });
  assert.equal(h.focused(), other, 'focus outside the section stays where it is');
});

test('a team-state that arrives while the profile does not work is kept and drawn when it does', () => {
  const h = bare();
  h.deliver({ type: 'profile-status', value: profileValue('pending') });
  const owner = model({ folderOpen: true, team: team() });
  h.deliver({ type: 'team-state', model: owner });
  assert.equal(section(h).hidden, true);
  h.deliver(READY);
  assert.equal(section(h).hidden, false);
  assert.deepEqual(buttons(h).map((button) => button.getAttribute('data-action')), ['invite', 'members', 'board']);
  h.deliver({ type: 'team-state', model: null });
  h.deliver(READY);
  assert.equal(section(h).hidden, true, 'a null model stays hidden even with a working profile');
});

test('while hidden the probe reports hidden and the profile state, and a click probe is refused with hidden and posts no team-action', () => {
  const h = bare();
  h.deliver({ type: 'team-state', model: model({ folderOpen: true }) });
  h.deliver({ type: 'team-e2e', id: 1 });
  assert.deepEqual(h.posts, [{ type: 'team-e2e-facts', id: 1, heading: '', status: '', actions: [], hidden: true, profile: null, soloLine: null, connect: null }], 'nothing known yet');
  h.posts.length = 0;
  h.deliver({ type: 'profile-status', value: { projectScope: 'No workspace', activeProfileId: undefined, configured: false, profiles: [] } });
  h.deliver({ type: 'team-e2e', id: 2, click: 'invite' });
  // 61-30: with no profile the Connect screen offers the team way in, so the facts report it; Invite someone is not there, so it is refused.
  const connect = { status: '', actions: [{ id: 'join', label: 'Join a team' }, { id: 'ask', label: 'Ask to join' }], inPanel: false };
  assert.deepEqual(h.posts, [{ type: 'team-e2e-facts', id: 2, heading: '', status: '', actions: [], hidden: true, profile: 'connect', soloLine: null, connect, error: 'hidden' }]);
  h.posts.length = 0;
  h.deliver(READY);
  h.deliver({ type: 'team-e2e', id: 3 });
  assert.equal(h.posts.length, 1);
  const shown: Record<string, any> = h.posts[0];
  assert.equal(shown.hidden, false);
  assert.equal(shown.profile, 'ready');
  assert.deepEqual(shown.actions.map((action: { id: string }) => action.id), ['invite', 'join', 'solo']);
  assert.equal(shown.soloLine, null);
});

test('without the readiness module the section counts as not ready and stays hidden', () => {
  const h = createBoardHarness({ scripts: 'chat', teamSection: true, nearChat: true });
  h.load(['team.js']);
  h.deliver({ type: 'profile-status', value: profileValue('valid') });
  h.deliver({ type: 'team-state', model: model({ folderOpen: true }) });
  assert.equal(section(h).hidden, true);
});

test('team.js reads readiness only through window.nearReadiness', () => {
  assert.ok(readFileSync(path.join(ROOT, 'media', 'chat', 'team.js'), 'utf8').includes('window.nearReadiness'));
});

// ---- Just me for now: the quiet empty-chat line (61-26, G-61-8) ---------------------------------------------------------------------------------

const soloLines = (h: BoardHarness): FakeNode[] => h.$$('.team-solo');
const justMe = (): TeamSectionModel => model({ folderOpen: true, justMe: true });

test('an empty-chat-line model hides the section and draws one quiet line inside the empty chat, whose two links post invite and join', () => {
  const h = sidebar();
  h.deliver({ type: 'team-state', model: model({ folderOpen: true }) });
  assert.equal(section(h).hidden, false);
  h.deliver({ type: 'team-state', model: justMe() });
  assert.equal(section(h).hidden, true, 'the section is put away');
  assert.equal(buttons(h).length, 0, 'no section button can be clicked');
  const lines = soloLines(h);
  assert.equal(lines.length, 1, 'one line');
  const welcome = h.$('#welcome');
  assert.ok(welcome !== null && welcome.contains(lines[0]), 'the line is inside the empty chat welcome');
  assert.equal(lines[0].localName, 'p');
  assert.ok(lines[0].textContent.includes('Working solo with your agents. Invite people any time.'));
  const links = h.$$('.team-solo button');
  assert.deepEqual(links.map((link) => link.textContent), ['Invite people', 'Join a team']);
  assert.ok(links.every((link) => link.getAttribute('type') === 'button' && link.classList.contains('link')), 'link-styled buttons');
  h.click(links[0]);
  h.click(links[1]);
  assert.deepEqual(h.posts, [{ type: 'team-action', action: 'invite' }, { type: 'team-action', action: 'join' }]);
  h.deliver({ type: 'team-state', model: justMe() });
  assert.equal(soloLines(h).length, 1, 'drawn again in place, never twice');
  h.deliver({ type: 'team-state', model: model({ folderOpen: true, team: team() }) });
  assert.equal(soloLines(h).length, 0, 'a section model removes the line');
  assert.equal(section(h).hidden, false);
});

test('during a conversation the empty chat welcome is hidden, so the line is never shown there', () => {
  const h = sidebar();
  h.deliver({ type: 'team-state', model: justMe() });
  const welcome = h.$('#welcome');
  assert.ok(welcome !== null);
  welcome.hidden = true;
  const line = soloLines(h)[0];
  assert.ok(line !== undefined);
  let hiddenAncestor = false;
  for (let node: FakeNode | null = line; node !== null; node = node.parentNode) if (node.hidden) hiddenAncestor = true;
  assert.equal(hiddenAncestor, true, 'the line sits inside a hidden ancestor');
  h.deliver({ type: 'team-e2e', id: 4, click: 'join' });
  assert.deepEqual(h.posts.map((post) => post.type), ['team-e2e-facts'], 'a hidden line is not clicked');
  assert.equal(h.posts[0].error, 'hidden');
});

// The real-window invite e2e failed in about half of the full runs (debug session quiet-line-join-hidden): the two test windows share one hidden screen,
// one covers the other, and Chromium then reports the covered window's page as not visible (document.hidden). The walk up from the line reached the
// Document, whose hidden is that page visibility, not a hidden element, so the drawn line's Join a team was refused as 'hidden' for the whole run.
test('a page that is not visible (its window covered by another) still has a usable quiet line: only a hidden element puts the line away', () => {
  const h = sidebar();
  h.deliver({ type: 'team-state', model: justMe() });
  h.setVisible(false);
  assert.equal(h.document.hidden, true, 'the page reports itself not visible');
  h.deliver({ type: 'team-e2e', id: 8 });
  assert.deepEqual(h.posts[0]?.soloLine?.actions.map((action: { id: string }) => action.id), ['invite', 'join'], 'the facts report the line');
  h.posts.length = 0;
  h.deliver({ type: 'team-e2e', id: 9, click: 'join' });
  assert.deepEqual(h.posts.map((post) => [post.type, post.action ?? post.error]), [['team-action', 'join'], ['team-e2e-facts', undefined]], 'the join is clicked');
  // Boundary neighbour: a page that is not visible during a conversation still refuses, because the welcome itself is hidden.
  const welcome = h.$('#welcome');
  assert.ok(welcome !== null);
  welcome.hidden = true;
  h.posts.length = 0;
  h.deliver({ type: 'team-e2e', id: 10, click: 'join' });
  assert.deepEqual(h.posts.map((post) => [post.type, post.error]), [['team-e2e-facts', 'hidden']], 'a line in a hidden welcome is not clicked');
  // And the page becoming visible again changes nothing about the line itself.
  welcome.hidden = false;
  h.setVisible(true);
  h.posts.length = 0;
  h.deliver({ type: 'team-e2e', id: 11, click: 'invite' });
  assert.deepEqual(h.posts.map((post) => [post.type, post.action ?? post.error]), [['team-action', 'invite'], ['team-e2e-facts', undefined]]);
});

test('the facts report the quiet line exactly when a click on it is accepted: no line while a conversation hides the welcome, the line again once it is back', () => {
  const h = sidebar();
  h.deliver({ type: 'team-state', model: justMe() });
  const welcome = h.$('#welcome');
  assert.ok(welcome !== null);
  welcome.hidden = true;
  h.deliver({ type: 'team-e2e', id: 12 });
  const during = h.posts[0];
  assert.equal(during?.soloLine, null, 'a line nobody can see is not reported');
  assert.equal(soloLines(h).length, 1, 'it is still drawn, ready for the empty chat');
  welcome.hidden = false;
  h.posts.length = 0;
  h.deliver({ type: 'team-e2e', id: 13 });
  const after = h.posts[0];
  assert.deepEqual(after?.soloLine?.actions.map((action: { id: string }) => action.id), ['invite', 'join'], 'reported again once the welcome is back');
});

test('with the profile not working neither the section nor the line is drawn; the line appears once it works and goes when it stops', () => {
  const h = bare();
  h.deliver({ type: 'team-state', model: justMe() });
  assert.equal(soloLines(h).length, 0, 'no line before a profile works');
  assert.equal(section(h).hidden, true);
  h.deliver(READY);
  assert.equal(soloLines(h).length, 1, 'shown without another team-state');
  assert.equal(section(h).hidden, true);
  h.deliver({ type: 'profile-status', value: profileValue('stale') });
  assert.equal(soloLines(h).length, 0, 'removed when the profile stops working');
  h.deliver({ type: 'team-state', model: null });
  h.deliver(READY);
  assert.equal(soloLines(h).length, 0, 'a null model draws no line');
});

test('the probe reports the line and a click probe reaches an action in it', () => {
  const h = sidebar();
  h.deliver({ type: 'team-state', model: justMe() });
  h.deliver({ type: 'team-e2e', id: 5 });
  assert.deepEqual(h.posts, [{
    type: 'team-e2e-facts', id: 5, heading: '', status: '', actions: [], hidden: true, profile: 'ready', connect: null,
    soloLine: { text: 'Working solo with your agents. Invite people any time.', actions: [{ id: 'invite', label: 'Invite people' }, { id: 'join', label: 'Join a team' }] }
  }]);
  h.posts.length = 0;
  h.deliver({ type: 'team-e2e', id: 6, click: 'invite' });
  assert.equal(h.posts.length, 2);
  const posted: Array<Record<string, unknown>> = h.posts;
  assert.deepEqual(posted[0], { type: 'team-action', action: 'invite' });
  assert.equal(posted[1]?.error, undefined);
  posted.length = 0;
  h.deliver({ type: 'team-e2e', id: 7, click: 'members' });
  assert.deepEqual(posted.map((post) => [post.type, post.error]), [['team-e2e-facts', 'hidden']], 'an action that is in neither is refused');
});

test('without an empty chat welcome on the page the line is simply not drawn', () => {
  const h = createBoardHarness({ scripts: 'chat', teamSection: true, nearChat: true });
  h.load(['readiness.js', 'team.js']);
  h.deliver(READY);
  h.deliver({ type: 'team-state', model: justMe() });
  assert.equal(soloLines(h).length, 0);
  assert.equal(section(h).hidden, true);
});

// ---- page details (Task 3) -------------------------------------------------------------------------------------------------------------------

function leadWaiting(over: Partial<NonNullable<TeamSectionInput['team']>> = {}): TeamSectionModel {
  return model({ folderOpen: true, team: team({ myRole: 'lead', waiting: 2, otherMembers: 2, ...over }) });
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
  assert.equal(named(h, 'board').getAttribute('aria-label'), null, 'a button without a badge is named by its text');
  const drawn = buttons(h);
  assert.equal(drawn[0].getAttribute('data-action'), 'members');
  assert.ok(drawn[0].classList.contains('primary'));
  assert.ok(drawn.slice(1).every((button) => !button.classList.contains('primary')), 'only one primary button');
  assert.equal(named(h, 'members').getAttribute('title'), leadWaiting().actions[0].hint, 'the hint is the tooltip');
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
  assert.deepEqual(buttons(h).map((button) => button.getAttribute('data-action')), ['share', 'invite', 'members', 'board']);
});

test('a board summary is one line inside the section, and a later model without it removes the line', () => {
  const h = sidebar();
  const withBoard = model({ folderOpen: true, team: team({ myRole: 'developer', canManage: false, shared: undefined }), board: { ready: 3, blocked: 1, mine: 2 } });
  h.deliver({ type: 'team-state', model: withBoard });
  const lines = h.$$('#team .team-board');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].textContent, withBoard.board?.text);
  h.deliver({ type: 'team-e2e', id: 11 });
  const drawnFacts: Record<string, unknown> | undefined = h.posts.at(-1);
  assert.equal(drawnFacts?.board, withBoard.board?.text, 'the probe reports the board line while it is drawn');
  h.deliver({ type: 'team-state', model: model({ folderOpen: true, team: team({ myRole: 'developer', canManage: false, shared: undefined }) }) });
  assert.equal(h.$$('#team .team-board').length, 0);
  h.deliver({ type: 'team-e2e', id: 12 });
  const goneFacts: Record<string, unknown> = h.posts.at(-1) ?? {};
  assert.equal('board' in goneFacts, false, 'and nothing once it is gone');
});

test('compact draws the actions in one row under the status with the heading hidden; full also shows the heading', () => {
  const h = sidebar();
  const compact = model({ folderOpen: true, team: team({ myRole: undefined, canManage: false, shared: undefined }) });
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
    type: 'team-e2e-facts', id: 7, heading: lead.heading, status: lead.status, hidden: false, profile: 'ready', soloLine: null, connect: null,
    actions: [{ id: 'members', label: 'Members', badge: '2 waiting' }, { id: 'board', label: 'Open board' }]
  }]);
  h.posts.length = 0;
  h.deliver({ type: 'team-e2e', id: 8, click: 'members' });
  assert.equal(h.posts.length, 2);
  assert.deepEqual(h.posts[0], { type: 'team-action', action: 'members' });
  const clicked: Record<string, unknown> = h.posts[1];
  assert.equal(clicked.type, 'team-e2e-facts');
  assert.equal(clicked.id, 8);
  assert.equal(clicked.error, undefined);
  h.posts.length = 0;
  h.deliver({ type: 'team-e2e', id: 9, click: 'invite' });
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
  assert.deepEqual(buttons(h).map((button) => button.getAttribute('data-action')), ['invite', 'members', 'board']);
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

// ---- the Connect screen (61-30, G-61-9) -------------------------------------------------------------------------------------------------------
// While no profile works, team.js offers the team way in on the Connect screen. On this branch (no 0.4.14 Connect panel) it draws a small Connect
// block of its own inside the empty chat; once PR #7's panel (#welcome-connect) is on the page, it only adds a .team-connect group inside it.

const NO_PROFILE = { type: 'profile-status', value: { projectScope: 'project', activeProfileId: undefined, configured: false, profiles: [] } };

/** PR #7's Connect panel as panelView.ts (feat/setup-next-steps) draws it, with setup.js's 'connect' state applied: Choose a profile hidden. */
function withPanel(): BoardHarness {
  const h = createBoardHarness({ scripts: 'chat', teamSection: true, nearChat: true });
  const input = h.document.createElement('textarea');
  input.id = 'input';
  const transcript = h.document.createElement('main');
  transcript.id = 'transcript';
  const welcome = h.document.createElement('section');
  welcome.id = 'welcome';
  const panel = h.document.createElement('div');
  panel.id = 'welcome-connect';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-labelledby', 'welcome-connect-title');
  const make = (tag: string, id: string, value: string, hidden = false, className = ''): FakeNode => {
    const node = h.document.createElement(tag);
    node.id = id;
    node.textContent = value;
    if (className) node.className = className;
    if (tag === 'button') node.setAttribute('type', 'button');
    node.hidden = hidden;
    return node;
  };
  const row = h.document.createElement('div');
  row.className = 'welcome-connect-actions';
  row.append(
    make('button', 'welcome-new-profile', 'Set up a new profile', false, 'text-button primary'),
    make('button', 'welcome-choose-profile', 'Choose a profile', true, 'text-button'),
    make('button', 'welcome-open-folder', 'Open a folder', true, 'text-button primary')
  );
  panel.append(
    make('h2', 'welcome-connect-title', 'Connect NEAR AI to start'),
    make('p', 'welcome-connect-body', 'Connect NEAR AI to use private models in this project.'),
    make('p', 'welcome-connect-reason', '', true),
    row
  );
  const ready = h.document.createElement('div');
  ready.id = 'welcome-ready';
  ready.hidden = true;
  welcome.append(panel, ready);
  transcript.append(welcome);
  h.document.body.append(transcript, input);
  h.load(['readiness.js', 'team.js']);
  return h;
}

const PANEL_IDS = ['welcome-connect', 'welcome-connect-title', 'welcome-connect-body', 'welcome-connect-reason', 'welcome-new-profile', 'welcome-choose-profile', 'welcome-open-folder', 'welcome-ready'];

// Every attribute and the text of PR #7's own elements; the panel's text without the group team.js adds, and its own children in order.
function panelSnapshot(h: BoardHarness): unknown {
  return PANEL_IDS.map((id) => {
    const node = h.document.getElementById(id);
    assert.ok(node !== null, `${id} is on the page`);
    const own = Array.from(node.children).filter((child) => !child.classList.contains('team-connect'));
    return { id, tag: node.localName, attrs: [...node.attrs.entries()].sort(), text: own.map((child) => child.textContent).join('|'), kids: own.map((child) => child.id || child.className) };
  });
}

const connectBlock = (h: BoardHarness): FakeNode | null => h.$('#team-connect');
const connectButtons = (h: BoardHarness, scope: string): FakeNode[] => h.$$(`${scope} button`);

test('tracer: without PR #7\'s panel and with no profile, a Connect block in the empty chat offers a new profile, a saved profile, Join a team and Ask to join', () => {
  const h = bare();
  h.deliver(NO_PROFILE);
  h.deliver({ type: 'team-state', model: model({ folderOpen: true }) });
  const block = connectBlock(h);
  assert.ok(block !== null, 'the Connect block is drawn');
  assert.equal(block.localName, 'section');
  const welcome = h.$('#welcome');
  assert.ok(welcome !== null && welcome.contains(block), 'inside the empty chat welcome');
  assert.equal(h.$$('#team-connect').length, 1, 'one block');
  assert.equal(h.$('#team-connect h2')?.textContent, 'Connect NEAR AI to start');
  assert.ok(block.textContent.includes(text.TEAM_CONNECT_FALLBACK.body), 'the one-line body');
  const drawn = connectButtons(h, '#team-connect');
  assert.deepEqual(drawn.map((button) => button.textContent), ['Set up a new profile', 'Use a saved profile', 'Join a team', 'Ask to join']);
  assert.ok(drawn.every((button) => button.getAttribute('type') === 'button'), 'real buttons');
  for (const button of drawn) h.click(button);
  assert.deepEqual(h.posts, [{ type: 'open-setup' }, { type: 'select-profile' }, { type: 'team-action', action: 'join' }, { type: 'team-action', action: 'ask' }]);
  assert.equal(section(h).hidden, true, 'the Team section stays hidden');
  assert.equal(buttons(h).length, 0, 'no section button can be clicked');
  assert.equal(soloLines(h).length, 0, 'no empty-chat line');
  h.deliver({ type: 'team-state', model: model({ folderOpen: true }) });
  h.deliver(NO_PROFILE);
  assert.equal(h.$$('#team-connect').length, 1, 'drawn again in place, never twice');
});

test('inside PR #7\'s panel team.js adds one .team-connect group with Join a team, Ask to join and Use a saved profile, and changes nothing of the panel', () => {
  const h = withPanel();
  const before = panelSnapshot(h);
  h.deliver(NO_PROFILE);
  h.deliver({ type: 'team-state', model: model({ folderOpen: true }) });
  const groups = h.$$('#welcome-connect .team-connect');
  assert.equal(groups.length, 1, 'one group inside the panel');
  assert.equal(groups[0].localName, 'div');
  assert.equal(connectBlock(h), null, 'no Connect block of its own');
  assert.equal(h.$$('.team-connect').length, 1, 'and no group anywhere else');
  const drawn = connectButtons(h, '#welcome-connect .team-connect');
  assert.deepEqual(drawn.map((button) => button.textContent), ['Join a team', 'Ask to join', 'Use a saved profile']);
  assert.deepEqual(panelSnapshot(h), before, 'PR #7\'s own elements are unchanged');
  for (const button of drawn) h.click(button);
  assert.deepEqual(h.posts, [{ type: 'team-action', action: 'join' }, { type: 'team-action', action: 'ask' }, { type: 'select-profile' }]);
  // When the panel shows its own profile choice (setup.js's choose or select state), the group adds no second one.
  const choose = h.document.getElementById('welcome-choose-profile');
  assert.ok(choose !== null);
  choose.hidden = false;
  const shownChoice = panelSnapshot(h);
  h.deliver({ type: 'profile-status', value: profileValue('stale') });
  assert.deepEqual(connectButtons(h, '#welcome-connect .team-connect').map((button) => button.textContent), ['Join a team', 'Ask to join']);
  assert.deepEqual(panelSnapshot(h), shownChoice, 'still unchanged');
  assert.equal(h.$$('.team-connect').length, 1);
});

test('a working profile removes the Connect part and shows the Team section as before; a profile that stops working brings it back', () => {
  for (const make of [bare, withPanel]) {
    const h = make();
    h.deliver(NO_PROFILE);
    h.deliver({ type: 'team-state', model: model({ folderOpen: true }) });
    assert.equal(h.$$('.team-connect, #team-connect').length, 1, `${make.name}: drawn while no profile works`);
    h.deliver(READY);
    assert.equal(h.$$('.team-connect').length + h.$$('#team-connect').length, 0, `${make.name}: removed once the profile works`);
    assert.equal(section(h).hidden, false, `${make.name}: the section is shown`);
    assert.deepEqual(buttons(h).map((button) => button.getAttribute('data-action')), ['invite', 'join', 'solo'], `${make.name}: the 61-26 section`);
    h.deliver({ type: 'profile-status', value: profileValue('invalid') });
    assert.equal(h.$$('.team-connect').length + h.$$('#team-connect').length, 1, `${make.name}: back when it stops working`);
    assert.equal(section(h).hidden, true, `${make.name}: the section hides again`);
  }
});

test('the Connect part waits for the first profile-status, and is not drawn with no folder open or without a model', () => {
  const h = bare();
  h.deliver({ type: 'team-state', model: model({ folderOpen: true }) });
  assert.equal(connectBlock(h), null, 'nothing before the profile state is known');
  h.deliver({ type: 'profile-status', value: { noWorkspace: true, profiles: [] } });
  assert.equal(connectBlock(h), null, 'no folder open: nothing to join');
  h.deliver({ type: 'team-state', model: null });
  h.deliver(NO_PROFILE);
  assert.equal(connectBlock(h), null, 'no model, no Connect part');
});

test('the probe reports the Connect part and a click probe reaches a team action in it', () => {
  for (const [make, inPanel] of [[bare, false], [withPanel, true]] as const) {
    const h = make();
    h.deliver(NO_PROFILE);
    h.deliver({ type: 'team-state', model: model({ folderOpen: true }) });
    h.deliver({ type: 'team-e2e', id: 21 });
    const facts: Record<string, any> = h.posts[0];
    assert.deepEqual(facts.connect, { status: '', actions: [{ id: 'join', label: 'Join a team' }, { id: 'ask', label: 'Ask to join' }], inPanel });
    h.posts.length = 0;
    h.deliver({ type: 'team-e2e', id: 22, click: 'ask' });
    assert.deepEqual(h.posts.map((post) => [post.type, post.action ?? post.error]), [['team-action', 'ask'], ['team-e2e-facts', undefined]]);
    h.deliver(READY);
    h.posts.length = 0;
    h.deliver({ type: 'team-e2e', id: 23 });
    assert.equal(h.posts[0]?.connect, null, 'nothing reported once the profile works');
  }
});

test('when the Connect part goes away with focus on one of its buttons, focus moves to the message box', () => {
  const h = bare();
  h.deliver(NO_PROFILE);
  h.deliver({ type: 'team-state', model: model({ folderOpen: true }) });
  const join = h.$('#team-connect button[data-action="join"]');
  assert.ok(join !== null);
  join.focus();
  h.deliver(READY);
  assert.equal(h.focused().id, 'input');
});
