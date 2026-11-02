// The Team Board client core (Phase 62 plan 09): media/board/board.js run in node:vm against the fake DOM. Every model comes from the real
// buildBoardModel over a signed in-memory log, so the client and the model contract cannot drift. The text-only rule is checked twice: the fake
// elements throw on markup, and the script is searched for markup sinks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { buildBoardModel } from '../domain/team/board';
import type { BoardCard, BoardModel } from '../domain/team/board';
import { CHORE_ID, boardWorld, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';
import { createBoardHarness } from './helpers/fakeDom';
import type { BoardHarness, FakeNode } from './helpers/fakeDom';

const NOW = Date.parse('2026-03-05T12:00:00.000Z');
const MEDIA = path.resolve(__dirname, '../../media/board');
const BOARD_JS = readFileSync(path.join(MEDIA, 'board.js'), 'utf8');

function modelOf(world: BoardWorld, viewerId: string | undefined, extra: Partial<BoardModel['status']> = {}): BoardModel {
  return buildBoardModel(world.state, { nowMs: NOW, status: { kind: 'live', text: 'Live', ...extra }, canWrite: viewerId !== undefined, ...(viewerId === undefined ? {} : { viewerId }) });
}

async function standard(): Promise<BoardWorld> {
  const world = await boardWorld();
  seedStandardBoard(world);
  return world;
}

function start(options: { width?: number; state?: unknown; reducedMotion?: boolean } = {}): BoardHarness {
  const h = createBoardHarness({ width: 800, ...options });
  h.load(['board.js']);
  return h;
}

const api = (h: BoardHarness): Record<string, any> => h.window.NearAiBoard;
const card = (h: BoardHarness, id: string): FakeNode => {
  const found = h.$(`.card[data-id="${id}"]`);
  assert.ok(found, `card ${id} is drawn`);
  return found;
};
const main = (h: BoardHarness, id: string): FakeNode => card(h, id).querySelector('.card-main')!;
const buttonNamed = (h: BoardHarness, text: string): FakeNode | undefined => h.$$('button').find((b) => b.textContent === text && !b.hidden);
const withCards = (model: BoardModel, edit: (cards: BoardCard[]) => void): BoardModel => {
  const copy = JSON.parse(JSON.stringify(model)) as BoardModel;
  edit(copy.cards);
  return copy;
};

// ---- Task 1: the tracer ----------------------------------------------------------------------------------------------------------------------

test('tracer: a real model draws as the kanban at 800 px, the list at 400 px, and a click and a host request reach the host', async () => {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const h = start();
  assert.deepEqual(h.posts, [{ type: 'ready' }]);

  h.deliver({ type: 'state', model });
  assert.deepEqual(h.$$('.column[data-column]').map((c) => c.getAttribute('data-column')), ['backlog', 'ready', 'claimed', 'in-progress', 'in-review', 'integrating', 'done', 'cancelled']);
  const ready = h.$('.cell[data-column="ready"][data-lane="unassigned"]')!;
  assert.ok(ready.contains(card(h, 'plan:90-01')), 'plan 90-01 sits in the Ready cell of the Unassigned lane');
  const readyCard = model.cards.find((c) => c.id === 'plan:90-01')!;
  assert.equal(main(h, 'plan:90-01').getAttribute('aria-label'), readyCard.a11yLabel);
  assert.equal(card(h, 'plan:90-01').querySelector('.card-title')!.textContent, 'Alpha slice');
  assert.equal(h.$$('.group[data-column]').length, 0, 'the kanban draws no list groups');

  h.setWidth(400);
  assert.deepEqual(h.$$('.group[data-column]').map((g) => g.getAttribute('data-column')), ['backlog', 'ready', 'claimed', 'in-progress', 'in-review', 'integrating', 'done', 'cancelled']);
  const open = h.$$('.group[data-column]').filter((g) => g.querySelector('.group-head')!.getAttribute('aria-expanded') === 'true').map((g) => g.getAttribute('data-column'));
  assert.deepEqual(open, ['backlog', 'ready']);
  assert.ok(h.$('.group[data-column="ready"]')!.contains(card(h, 'plan:90-01')));
  assert.equal(h.$$('.column[data-column]').length, 0);
  assert.equal(h.$$('*').filter((n) => n.draggable).length, 0, 'the list has nothing draggable');

  h.setWidth(800);
  buttonNamed(h, 'Import plans')!.click();
  assert.deepEqual(h.posts.at(-1), { type: 'import-plans' });
  h.deliver({ type: 'host-request', payload: { type: 'retry' } });
  assert.deepEqual(h.posts.at(-1), { type: 'retry' });
});

test('a title with markup and icon syntax is drawn as that exact text and creates no element', async () => {
  const world = await standard();
  const hostile = '<img src=x onerror=alert(1)> $(alert) <b>bold</b>';
  world.accept(world.dev, 'item.created', { id: `item:${'0'.repeat(22)}AB12`, kind: 'bug', title: hostile, scope: [], requirements: [], mustHaves: [] });
  const model = modelOf(world, world.owner.memberId);
  const id = model.cards.find((c) => c.title.includes('onerror'))!.id;
  const h = start();
  h.deliver({ type: 'state', model });
  assert.equal(card(h, id).querySelector('.card-title')!.textContent, hostile);
  assert.equal(card(h, id).querySelector('.card-title')!.children.length, 0);
  assert.equal(h.$$('img').length + h.$$('b').length, 0);
  assert.throws(() => { (h.root as any).innerHTML = '<p>x</p>'; }, /markup/);
});

test('the script has no markup sink, no remote address and no em or en dash in it', () => {
  assert.doesNotMatch(BOARD_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(BOARD_JS, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  assert.doesNotMatch(BOARD_JS, /[—–]/);
  assert.match(BOARD_JS, /acquireVsCodeApi/);
  void CHORE_ID;
});
