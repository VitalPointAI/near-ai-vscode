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
import { boardWorld, importedBody, seedStandardBoard } from './helpers/teamBoardWorld';
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

void importedBody;
