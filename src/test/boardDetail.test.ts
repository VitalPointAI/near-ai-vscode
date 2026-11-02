// The card detail (Phase 62 plan 12): media/board/detail.js run with media/board/board.js in node:vm against the fake DOM. The detail messages come from
// the real buildCardDetail over a signed in-memory log and its history, so the page and the host contract cannot drift. The page formats nothing it can
// take from the message, and writes every host string as text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { buildBoardModel, buildCardDetail } from '../domain/team/board';
import type { BoardModel, CardDetail } from '../domain/team/board';
import { ItemHistory } from '../domain/team/itemHistory';
import { CHORE_ID, boardWorld, importedBody, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';
import { createBoardHarness } from './helpers/fakeDom';
import type { BoardHarness, FakeNode } from './helpers/fakeDom';

const NOW = Date.parse('2026-03-05T12:00:00.000Z');
const DETAIL_JS = readFileSync(path.resolve(__dirname, '../../media/board/detail.js'), 'utf8');

type Viewer = 'owner' | 'lead' | 'dev' | 'observer';

function viewerId(world: BoardWorld, viewer: Viewer): string {
  return world[viewer].memberId;
}

function modelOf(world: BoardWorld, viewer: Viewer, extra: Partial<BoardModel['status']> = {}): BoardModel {
  return buildBoardModel(world.state, { nowMs: NOW, status: { kind: 'live', text: 'Live', ...extra }, canWrite: viewer !== 'observer', viewerId: viewerId(world, viewer) });
}

function detailOf(world: BoardWorld, id: string, viewer: Viewer = 'owner'): CardDetail {
  const history = new ItemHistory();
  history.record(world.entries);
  const detail = buildCardDetail(world.state, id, { viewerId: viewerId(world, viewer), nowMs: NOW, history: history.forItem(id) });
  assert.ok(detail, `a detail for ${id}`);
  return detail;
}

/** The message the host sends: the detail fields with the type and the item id at the top level. */
function messageOf(world: BoardWorld, id: string, viewer: Viewer = 'owner'): Record<string, any> {
  return { type: 'detail', ...detailOf(world, id, viewer) };
}

async function standard(): Promise<BoardWorld> {
  const world = await boardWorld();
  seedStandardBoard(world);
  return world;
}

function start(width = 800): BoardHarness {
  const h = createBoardHarness({ width });
  h.load(['board.js', 'menu.js', 'detail.js']);
  return h;
}

async function drawn(width = 800, viewer: Viewer = 'owner', world?: BoardWorld): Promise<{ h: BoardHarness; world: BoardWorld }> {
  const built = world ?? (await standard());
  const h = start(width);
  h.deliver({ type: 'state', model: modelOf(built, viewer) });
  return { h, world: built };
}

const api = (h: BoardHarness): Record<string, any> => h.window.NearAiBoard;
const text = (n: FakeNode | null | undefined): string => n?.textContent ?? '';
const card = (h: BoardHarness, id: string): FakeNode => {
  const found = h.$(`.card[data-id="${id}"]`);
  assert.ok(found, `card ${id} is drawn`);
  return found;
};
const main = (h: BoardHarness, id: string): FakeNode => card(h, id).querySelector('.card-main')!;
const drawer = (h: BoardHarness): FakeNode => h.$('#detail')!;
const isOpen = (h: BoardHarness): boolean => !drawer(h).hidden;
const headings = (h: BoardHarness): string[] => drawer(h).querySelectorAll('h3').map((n) => text(n));
const detailPosts = (h: BoardHarness): Array<Record<string, any>> => h.posts.filter((p) => p.type === 'detail');

/** Opens the detail of a card by keyboard, the way a person does, and delivers the host's answer. */
function openBy(h: BoardHarness, id: string, message?: Record<string, any>): FakeNode {
  const target = main(h, id);
  target.focus();
  h.press(target, 'Enter');
  if (message !== undefined) h.deliver(message);
  return target;
}

// ---- Task 1: the tracer ----------------------------------------------------------------------------------------------------------------------

test('tracer: Enter on a plan asks the host once, shows the title while waiting, then the tasks and history; Escape closes and lands on the card', async () => {
  const world = await standard();
  world.accept(world.lead, 'item.blocked', { id: 'plan:90-01', reason: 'waiting for the API key' });
  world.accept(world.lead, 'item.unblocked', { id: 'plan:90-01' });
  const { h } = await drawn(800, 'owner', world);
  assert.equal(isOpen(h), false, 'nothing is open before a card is opened');
  assert.equal(drawer(h).getAttribute('aria-label'), 'Card detail');

  const opener = openBy(h, 'plan:90-01');
  assert.deepEqual(detailPosts(h), [{ type: 'detail', itemId: 'plan:90-01' }], 'one request, for this card');
  assert.equal(isOpen(h), true);
  const heading = drawer(h).querySelector('h2')!;
  assert.equal(text(heading), 'Alpha slice', 'the title block shows while the host answers');
  assert.equal(h.focused(), heading, 'focus moves to the detail heading');
  assert.equal(opener.getAttribute('aria-current'), 'true', 'the opened card is the current one');

  h.deliver(messageOf(world, 'plan:90-01'));
  assert.equal(detailPosts(h).length, 1, 'the answer does not trigger another request');
  assert.equal(text(drawer(h).querySelector('h2')), 'Alpha slice');
  assert.equal(h.focused(), drawer(h).querySelector('h2'), 'the answer keeps focus on the heading');
  assert.deepEqual(headings(h), ['Facts', 'Must-haves', 'Requirements', 'Files', 'Tasks', 'History']);

  const tasks = drawer(h).querySelectorAll('section').find((s) => text(s.querySelector('h3')) === 'Tasks')!;
  assert.match(text(tasks), /0 of 2 tasks done/);
  const rows = tasks.querySelectorAll('li');
  assert.equal(rows.length, 2);
  assert.match(text(rows[0]), /^To do/);
  assert.match(text(rows[0]), /Write the test/);
  assert.match(text(rows[1]), /Write the code/);

  const history = drawer(h).querySelectorAll('section').find((s) => text(s.querySelector('h3')) === 'History')!;
  const entries = history.querySelectorAll('li');
  assert.deepEqual(entries.map((li) => text(li).replace(/^.*?(Lee|Import)/, '$1')), ['Lee unblocked this.', 'Lee blocked this: waiting for the API key.', 'Import added this to the board.']);
  for (const li of entries) {
    const time = li.querySelector('time')!;
    assert.ok(time, 'every row has a time element');
    assert.match(time.getAttribute('datetime') ?? '', /^2026-03-0\dT/);
    assert.notEqual(text(time), '');
  }

  h.press(h.focused(), 'Escape');
  assert.equal(isOpen(h), false, 'Escape closes the detail');
  assert.equal(h.focused(), opener, 'focus is back on the card that opened it');
  assert.equal(opener.getAttribute('aria-current'), null, 'the card is current only while its detail is open');
  assert.equal(detailPosts(h).length, 1);
});

test('a detail for another card is ignored, and nothing opens without a registered request', async () => {
  const { h, world } = await drawn();
  h.deliver(messageOf(world, 'plan:90-02'));
  assert.equal(isOpen(h), false, 'a detail nobody asked for opens nothing');

  openBy(h, 'plan:90-01');
  h.deliver(messageOf(world, 'plan:90-02'));
  assert.equal(text(drawer(h).querySelector('h2')), 'Alpha slice', 'the answer for another card is not drawn');
  assert.deepEqual(headings(h), [], 'only the title block shows until the right answer arrives');
  h.deliver(messageOf(world, 'plan:90-01'));
  assert.ok(headings(h).includes('Tasks'));
});

test('detail.js writes text only and registers through the client API', () => {
  assert.match(DETAIL_JS, /NearAiBoard\.registerDetail/);
  assert.doesNotMatch(DETAIL_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(DETAIL_JS, /[–—]/, 'no en or em dash in any string');
});

// ---- Task 2: every section, empty and overflow cases, imported versus board items, and the list drill-in ----------------------------------------

const CHORE_WITH_TEXT = `item:${'0'.repeat(22)}9H5N`;
const BLOCK_REASON = 'waiting for the API key';

/** The standard board plus: plan 90-04 (twelve files, a dependency off the board, a 600 character must-have, no tasks) and a chore with a description. */
async function fullWorld(): Promise<BoardWorld> {
  const world = await standard();
  world.accept(world.owner, 'item.imported', importedBody({
    id: 'plan:90-04', kind: 'plan', title: 'Delta slice', parentId: 'phase:90', dependsOn: ['plan:90-01', 'plan:61-09'], estimate: { tokens: 30000 }, requirements: ['BOARD-01', 'FIX-01'],
    scope: Array.from({ length: 12 }, (_, index) => `src/area/file${index + 1}.ts`), mustHaves: [('lorem ipsum '.repeat(60)).slice(0, 600)]
  }));
  world.accept(world.dev, 'item.created', { id: CHORE_WITH_TEXT, kind: 'chore', title: 'Tidy the sidebar', scope: ['src/side/**'], requirements: [], mustHaves: [], description: 'Clean up the sidebar spacing.' });
  return world;
}

const sectionOf = (h: BoardHarness, title: string): FakeNode => {
  const found = drawer(h).querySelectorAll('section').find((s) => text(s.querySelector('h3')) === title);
  assert.ok(found, `a ${title} section`);
  return found;
};
const hasSection = (h: BoardHarness, title: string): boolean => drawer(h).querySelectorAll('section').some((s) => text(s.querySelector('h3')) === title);
const buttonNamed = (root: FakeNode, name: string): FakeNode | undefined => root.querySelectorAll('button').find((b) => text(b) === name || b.getAttribute('aria-label') === name);

test('a blocked card shows who blocked it and why, with the time, right under the title block', async () => {
  const world = await fullWorld();
  world.accept(world.lead, 'item.blocked', { id: 'plan:90-01', reason: BLOCK_REASON });
  const { h } = await drawn(800, 'owner', world);
  openBy(h, 'plan:90-01', messageOf(world, 'plan:90-01'));
  const first = drawer(h).querySelector('.detail-body')!.children[0]!;
  assert.equal(first.className.includes('blocked-notice'), true);
  assert.match(text(first), /Blocked by Lee: waiting for the API key/);
  assert.ok(first.querySelector('time'), 'with its time');
  assert.equal(first.querySelector('time')!.getAttribute('datetime'), detailOf(world, 'plan:90-01').blocked!.since);
  assert.equal(hasSection(h, 'Why this is not ready'), false, 'a ready card has no such section');
});

test('a backlog card says in plain words why it is not ready', async () => {
  const world = await fullWorld();
  const { h } = await drawn(800, 'owner', world);
  const expected = detailOf(world, 'plan:90-04').notReady;
  assert.ok(expected.length > 0, 'the host has reasons for this card');
  openBy(h, 'plan:90-04', messageOf(world, 'plan:90-04'));
  assert.deepEqual(sectionOf(h, 'Why this is not ready').querySelectorAll('li').map((li) => text(li)), expected);
  assert.ok(headings(h).indexOf('Why this is not ready') < headings(h).indexOf('Facts'), 'it comes before the facts');
});

test('facts are a definition list; a board item shows its description and Edit, an imported item shows the project plans note instead', async () => {
  const world = await fullWorld();
  const { h } = await drawn(800, 'dev', world);
  const forms: string[] = [];
  api(h).registerForm((id: string) => forms.push(id));
  openBy(h, CHORE_WITH_TEXT, messageOf(world, CHORE_WITH_TEXT, 'dev'));
  const facts = sectionOf(h, 'Facts');
  assert.ok(facts.querySelector('dl'), 'facts are a dl');
  const pairs = facts.querySelectorAll('dt').map((dt, index) => [text(dt), text(facts.querySelectorAll('dd')[index])]);
  assert.deepEqual(pairs.find(([label]) => label === 'Created by'), ['Created by', 'Dana']);
  assert.deepEqual(pairs.find(([label]) => label === 'Source'), ['Source', 'Added on the board']);
  assert.match(text(sectionOf(h, 'Description')), /Clean up the sidebar spacing\./);
  const edit = buttonNamed(drawer(h), 'Edit')!;
  assert.ok(edit, 'the author may edit their own draft');
  edit.click();
  assert.deepEqual(forms, [CHORE_WITH_TEXT]);
  assert.doesNotMatch(text(drawer(h)), /This comes from the project plans/);

  h.press(h.focused(), 'Escape');
  openBy(h, 'plan:90-01', messageOf(world, 'plan:90-01', 'dev'));
  assert.match(text(drawer(h)), /This comes from the project plans\. Change the plan files and the board updates\./);
  assert.equal(buttonNamed(drawer(h), 'Edit'), undefined, 'imported items are not edited here');
  assert.equal(hasSection(h, 'Description'), false);

  const observer = await drawn(800, 'observer', world);
  openBy(observer.h, CHORE_WITH_TEXT, messageOf(world, CHORE_WITH_TEXT, 'observer'));
  assert.equal(buttonNamed(drawer(observer.h), 'Edit'), undefined, 'someone who may not edit sees no Edit');
});

test('requirement buttons apply the requirement filter and leave the detail open; a dependency on the board opens its detail, one off the board is plain text', async () => {
  const world = await fullWorld();
  const { h } = await drawn(800, 'owner', world);
  const opener = openBy(h, 'plan:90-04', messageOf(world, 'plan:90-04'));
  const filter = buttonNamed(sectionOf(h, 'Requirements'), 'Filter the board by FIX-01')!;
  assert.ok(filter);
  assert.equal(text(filter), 'FIX-01');
  filter.click();
  assert.equal((h.state as any).filters.requirement, 'FIX-01');
  assert.equal(isOpen(h), true, 'nothing else closes');

  const deps = sectionOf(h, 'Dependencies');
  const rows = deps.querySelectorAll('li');
  assert.equal(rows.length, 2);
  const onBoard = rows.find((li) => /90-01/.test(text(li)))!;
  assert.match(text(onBoard), /90-01 Alpha slice/);
  assert.match(text(onBoard), /Ready/);
  const link = onBoard.querySelector('button')!;
  assert.ok(link, 'a dependency on the board is a button');
  const missing = rows.find((li) => /61-09/.test(text(li)))!;
  assert.equal(text(missing).trim(), '61-09 (not on the board)');
  assert.equal(missing.querySelector('button'), null, 'plain text, not a button');

  link.click();
  assert.deepEqual(detailPosts(h).map((p) => p.itemId), ['plan:90-04', 'plan:90-01']);
  h.deliver(messageOf(world, 'plan:90-01'));
  assert.equal(text(drawer(h).querySelector('h2')), 'Alpha slice');
  assert.equal(main(h, 'plan:90-01').getAttribute('aria-current'), 'true');
  assert.equal(opener.getAttribute('aria-current'), null, 'only the open card is current');
  h.press(h.focused(), 'Escape');
  assert.equal(h.focused(), opener, 'closing lands back on the card that was opened first');
});

test('files show the first 8 then Show all N; the task list and history say so when they are empty', async () => {
  const world = await fullWorld();
  const { h } = await drawn(800, 'owner', world);
  openBy(h, 'plan:90-04', messageOf(world, 'plan:90-04'));
  const files = sectionOf(h, 'Files');
  assert.equal(files.querySelectorAll('li').length, 8);
  const more = buttonNamed(files, 'Show all 12')!;
  assert.ok(more);
  more.click();
  assert.equal(sectionOf(h, 'Files').querySelectorAll('li').length, 12);
  assert.equal(buttonNamed(sectionOf(h, 'Files'), 'Show all 12'), undefined);
  assert.match(text(sectionOf(h, 'Tasks')), /This plan has no tasks listed\./);

  const bare = { ...messageOf(world, 'plan:90-04'), history: [] as unknown[] };
  h.deliver(bare);
  assert.match(text(sectionOf(h, 'History')), /No changes recorded since this window opened\./);
});

test('history stops at 50 even when the host sends more, and says so', async () => {
  const world = await fullWorld();
  const { h } = await drawn(800, 'owner', world);
  const message = messageOf(world, 'plan:90-01');
  message.history = Array.from({ length: 60 }, (_, index) => ({ at: '2026-03-02T10:00:00.000Z', text: `Lee changed it ${index}.` }));
  openBy(h, 'plan:90-01', message);
  const history = sectionOf(h, 'History');
  assert.equal(history.querySelectorAll('li').length, 50);
  assert.match(text(history), /Lee changed it 0\./);
  assert.doesNotMatch(text(history), /Lee changed it 50\./);
  assert.match(text(history), /Showing the latest 50 changes\./);
});

test('Move to... in the detail opens the same menu as the card and is absent when the card has no moves', async () => {
  const world = await fullWorld();
  const { h } = await drawn(800, 'owner', world);
  openBy(h, 'plan:90-01', messageOf(world, 'plan:90-01'));
  const move = buttonNamed(drawer(h).querySelector('.detail-head')!, 'Move to...')!;
  assert.ok(move && !move.hidden, 'the owner can move a ready plan');
  move.click();
  const menu = h.$('#menu')!;
  assert.equal(menu.hidden, false);
  assert.deepEqual(menu.querySelectorAll('[role="menuitem"]').map((i) => text(i)), api(h).cardData('plan:90-01').moves.map((m: any) => m.label));
  h.press(h.focused(), 'Escape');
  assert.equal(h.$('#menu')!.hidden, true, 'the first Escape closes only the menu');
  assert.equal(isOpen(h), true);
  assert.equal(h.focused(), move, 'focus is back on the button that opened it');
  h.press(h.focused(), 'Escape');
  assert.equal(isOpen(h), false, 'the second Escape closes the detail');

  const dev = await drawn(800, 'dev', world);
  openBy(dev.h, 'plan:90-01', messageOf(world, 'plan:90-01', 'dev'));
  const none = buttonNamed(drawer(dev.h).querySelector('.detail-head')!, 'Move to...');
  assert.ok(none === undefined || none.hidden, 'a developer sees no Move to...');
});

test('a refusal for the open card is shown in the detail as well', async () => {
  const world = await fullWorld();
  const { h } = await drawn(800, 'owner', world);
  openBy(h, 'plan:90-01', messageOf(world, 'plan:90-01'));
  buttonNamed(drawer(h).querySelector('.detail-head')!, 'Move to...')!.click();
  const choice = h.$('#menu')!.querySelectorAll('[role="menuitem"]').find((i) => text(i).startsWith('Backlog'))!;
  choice.click();
  assert.equal(h.posts.filter((p) => p.type === 'move').length, 1);
  h.deliver({ type: 'refused', itemId: 'plan:90-01', reason: 'Lee already changed this card. The board now shows the latest. Nothing moved.' });
  assert.match(text(drawer(h)), /Lee already changed this card/);
});

test('a change to the open card asks the host again; a card that leaves the board closes the detail', async () => {
  const world = await fullWorld();
  const { h } = await drawn(800, 'owner', world);
  openBy(h, 'plan:90-01', messageOf(world, 'plan:90-01'));
  h.deliver({ type: 'state', model: modelOf(world, 'owner') });
  assert.equal(detailPosts(h).length, 1, 'an unchanged card does not ask again');
  world.accept(world.lead, 'item.blocked', { id: 'plan:90-01', reason: BLOCK_REASON });
  h.deliver({ type: 'state', model: modelOf(world, 'owner') });
  assert.equal(detailPosts(h).length, 2, 'a changed card asks again');
  h.deliver(messageOf(world, 'plan:90-01'));
  assert.match(text(drawer(h)), /Blocked by Lee: waiting for the API key/);

  const gone = modelOf(world, 'owner');
  gone.cards = gone.cards.filter((c) => c.id !== 'plan:90-01');
  h.deliver({ type: 'state', model: gone });
  assert.equal(isOpen(h), false);
  assert.ok(h.announcements.some((a) => /no longer on the board/.test(a)));
});

test('list layout: opening a row drills in with Back to list, which restores the list, its scroll position and focus on the row', async () => {
  const world = await fullWorld();
  const { h } = await drawn(400, 'owner', world);
  h.document.html.scrollTop = 120;
  const row = openBy(h, 'plan:90-01', messageOf(world, 'plan:90-01'));
  assert.equal(h.document.html.scrollTop, 0, 'the detail starts at the top');
  const back = buttonNamed(drawer(h), 'Back to list')!;
  assert.ok(back, 'the list has Back to list');
  assert.equal(buttonNamed(drawer(h), 'Close details'), undefined);
  back.click();
  assert.equal(isOpen(h), false);
  assert.equal(h.document.html.scrollTop, 120, 'the list scroll is kept');
  assert.equal(h.focused(), row, 'focus is on the row that opened it');

  h.setWidth(800);
  openBy(h, 'plan:90-01', messageOf(world, 'plan:90-01'));
  assert.ok(buttonNamed(drawer(h), 'Close details'), 'the kanban drawer has Close details');
  h.setWidth(400);
  assert.ok(buttonNamed(drawer(h), 'Back to list'), 'the label follows the layout');
});

test('hostile text is drawn as text and long must-haves wrap in full', async () => {
  const world = await fullWorld();
  const { h } = await drawn(800, 'owner', world);
  const message = messageOf(world, 'plan:90-04');
  message.title = '<img src=x onerror=alert(1)> $(trash) <b>bold</b>';
  message.mustHaves = ['<script>alert(1)</script>' + 'z'.repeat(576)];
  message.history = [{ at: '2026-03-02T10:00:00.000Z', text: '<i>Dana</i> blocked this: <a href="x">reason</a>.' }];
  message.blocked = { reason: '<u>why</u>', byName: '<b>Dana</b>', since: '2026-03-02T10:00:00.000Z' };
  openBy(h, 'plan:90-04', message);
  assert.equal(text(drawer(h).querySelector('h2')), '<img src=x onerror=alert(1)> $(trash) <b>bold</b>');
  assert.equal(text(sectionOf(h, 'Must-haves').querySelector('li')).length, 600);
  assert.equal(drawer(h).querySelectorAll('img, b, i, a, u, script').length, 0, 'no element was created from the text');
  assert.match(text(drawer(h)), /Blocked by <b>Dana<\/b>: <u>why<\/u>/);
});
