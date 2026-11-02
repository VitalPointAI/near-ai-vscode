// The Move to... menu (Phase 62 plan 10): media/board/menu.js run with media/board/board.js in node:vm against the fake DOM. Models come from the real
// buildBoardModel over a signed in-memory log. The page only sends a request; the host decides, so every test checks what is posted and what is shown.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { buildBoardModel } from '../domain/team/board';
import type { BoardCard, BoardModel } from '../domain/team/board';
import { boardWorld, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';
import { createBoardHarness } from './helpers/fakeDom';
import type { BoardHarness, FakeNode } from './helpers/fakeDom';

const NOW = Date.parse('2026-03-05T12:00:00.000Z');
const MENU_JS = readFileSync(path.resolve(__dirname, '../../media/board/menu.js'), 'utf8');

function modelOf(world: BoardWorld, viewerId: string | undefined, extra: Partial<BoardModel['status']> = {}): BoardModel {
  return buildBoardModel(world.state, { nowMs: NOW, status: { kind: 'live', text: 'Live', ...extra }, canWrite: viewerId !== undefined, ...(viewerId === undefined ? {} : { viewerId }) });
}

async function standard(): Promise<BoardWorld> {
  const world = await boardWorld();
  seedStandardBoard(world);
  return world;
}

function start(width = 800): BoardHarness {
  const h = createBoardHarness({ width });
  h.load(['board.js', 'menu.js']);
  return h;
}

const text = (n: FakeNode | null | undefined): string => n?.textContent ?? '';
const card = (h: BoardHarness, id: string): FakeNode => {
  const found = h.$(`.card[data-id="${id}"]`);
  assert.ok(found, `card ${id} is drawn`);
  return found;
};
const main = (h: BoardHarness, id: string): FakeNode => card(h, id).querySelector('.card-main')!;
const moveBtn = (h: BoardHarness, id: string): FakeNode => card(h, id).querySelector('.move-btn')!;
const menu = (h: BoardHarness): FakeNode => h.$('#menu')!;
const items = (h: BoardHarness): FakeNode[] => menu(h).querySelectorAll('[role="menuitem"]');
const isOpen = (h: BoardHarness): boolean => h.$('#menu') !== null && !menu(h).hidden;
const cardOf = (model: BoardModel, id: string): BoardCard => model.cards.find((c) => c.id === id)!;
const moves = (h: BoardHarness): Array<Record<string, any>> => h.posts.filter((p) => p.type === 'move');

// ---- Task 1: the tracer ----------------------------------------------------------------------------------------------------------------------

test('tracer: M opens the menu on a ready card, Down and Enter choose Backlog (put on hold), and one move request is posted with the pending line shown', async () => {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const ready = cardOf(model, 'plan:90-01');
  const h = start();
  h.deliver({ type: 'state', model });
  assert.ok(ready.moves.length >= 3, 'the owner is offered moves on a ready plan');

  main(h, 'plan:90-01').focus();
  const press = h.press(main(h, 'plan:90-01'), 'm');
  assert.ok(press.defaultPrevented);
  assert.ok(isOpen(h), 'the menu is open');
  assert.equal(menu(h).getAttribute('role'), 'menu');
  assert.equal(menu(h).getAttribute('aria-label'), 'Move 90-01 to');
  assert.equal(moveBtn(h, 'plan:90-01').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(items(h).map((i) => text(i)), ready.moves.map((m) => m.label));
  assert.equal(h.focused(), items(h)[0]);
  assert.equal(text(h.focused()), 'Done (mark as finished)');
  assert.deepEqual(menu(h).querySelectorAll('[role="separator"]').length, 1);
  const kids = menu(h).children;
  assert.equal(kids[kids.findIndex((k) => k.getAttribute('role') === 'separator') + 1]!.textContent, 'Block...');

  // Down moves along, and Down on the last wraps to the first.
  h.press(h.focused(), 'ArrowDown');
  assert.equal(text(h.focused()), ready.moves[1].label);
  h.press(h.focused(), 'ArrowDown');
  assert.equal(text(h.focused()), 'Backlog (put on hold)');
  const last = items(h)[items(h).length - 1];
  last.focus();
  h.press(last, 'ArrowDown');
  assert.equal(h.focused(), items(h)[0]);

  const hold = items(h).find((i) => text(i) === 'Backlog (put on hold)')!;
  hold.focus();
  h.press(hold, 'Enter');
  assert.ok(!isOpen(h), 'choosing closes the menu');
  assert.equal(moveBtn(h, 'plan:90-01').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(moves(h), [{ type: 'move', itemId: 'plan:90-01', target: 'hold' }]);
  assert.equal(card(h, 'plan:90-01').getAttribute('aria-busy'), 'true');
  assert.equal(text(card(h, 'plan:90-01').querySelector('.pending-line')), 'Moving to Backlog...');
});

test('tracer: in the list layout the row Move to... button opens the same menu with Enter', async () => {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const h = start(400);
  h.deliver({ type: 'state', model });
  // The Ready group starts open in the list.
  const button = moveBtn(h, 'plan:90-01');
  assert.ok(!button.hidden, 'the row has a Move to... button');
  button.focus();
  h.press(button, 'Enter');
  assert.ok(isOpen(h));
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(menu(h).getAttribute('aria-label'), 'Move 90-01 to');
  assert.deepEqual(items(h).map((i) => text(i)), cardOf(model, 'plan:90-01').moves.map((m) => m.label));
  const hold = items(h).find((i) => text(i) === 'Backlog (put on hold)')!;
  hold.focus();
  h.press(hold, 'Enter');
  assert.deepEqual(moves(h), [{ type: 'move', itemId: 'plan:90-01', target: 'hold' }]);
  assert.equal(text(card(h, 'plan:90-01').querySelector('.pending-line')), 'Moving to Backlog...');
});

test('menu.js has no markup sink and no em or en dash in it', () => {
  assert.doesNotMatch(MENU_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(MENU_JS, /[—–]/);
  assert.match(MENU_JS, /NearAiBoard\.registerMenu/);
});
