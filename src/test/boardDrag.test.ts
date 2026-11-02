// Drag and drop in the kanban (Phase 62 plan 11): media/board/drag.js run with media/board/board.js in node:vm against the fake DOM. Models come from the
// real buildBoardModel over a signed in-memory log. The page only sends a request; the host decides, so every test checks what is posted and what is shown.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { buildBoardModel } from '../domain/team/board';
import type { BoardCard, BoardModel } from '../domain/team/board';
import { boardWorld, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';
import { createBoardHarness } from './helpers/fakeDom';
import type { BoardHarness, DataTransferStub, FakeNode } from './helpers/fakeDom';

const NOW = Date.parse('2026-03-05T12:00:00.000Z');
const DRAG_JS = readFileSync(path.resolve(__dirname, '../../media/board/drag.js'), 'utf8');
const TYPE = 'application/x-near-ai-card';

function modelOf(world: BoardWorld, viewerId: string | undefined, extra: Partial<BoardModel['status']> = {}): BoardModel {
  return buildBoardModel(world.state, { nowMs: NOW, status: { kind: 'live', text: 'Live', ...extra }, canWrite: viewerId !== undefined, ...(viewerId === undefined ? {} : { viewerId }) });
}

async function standard(): Promise<BoardWorld> {
  const world = await boardWorld();
  seedStandardBoard(world);
  return world;
}

function start(options: { width?: number; reducedMotion?: boolean } = {}): BoardHarness {
  const h = createBoardHarness({ width: options.width ?? 800, ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }) });
  h.load(['board.js', 'drag.js']);
  return h;
}

async function ownerBoard(options: { width?: number; reducedMotion?: boolean } = {}): Promise<{ h: BoardHarness; model: BoardModel; world: BoardWorld }> {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const h = start(options);
  h.deliver({ type: 'state', model });
  return { h, model, world };
}

const text = (n: FakeNode | null | undefined): string => n?.textContent ?? '';
const card = (h: BoardHarness, id: string): FakeNode => {
  const found = h.$(`.card[data-id="${id}"]`);
  assert.ok(found, `card ${id} is drawn`);
  return found;
};
const cell = (h: BoardHarness, column: string, lane = 'unassigned'): FakeNode => {
  const found = h.$(`.cell[data-column="${column}"][data-lane="${lane}"]`);
  assert.ok(found, `cell ${column} in lane ${lane} is drawn`);
  return found;
};
const cardOf = (model: BoardModel, id: string): BoardCard => model.cards.find((c) => c.id === id)!;
const moves = (h: BoardHarness): Array<Record<string, any>> => h.posts.filter((p) => p.type === 'move');
const classes = (n: FakeNode): string[] => n.className.split(/\s+/).filter(Boolean);
const marked = (h: BoardHarness, cls: string): string[] => h.$$('.cell').filter((c) => classes(c).includes(cls)).map((c) => c.getAttribute('data-column')!);

/** Starts a drag of a card the way the browser does and returns the transfer object the later events share. */
function lift(h: BoardHarness, id: string): DataTransferStub {
  const dt = h.dataTransfer();
  h.fire(card(h, id), 'dragstart', { dataTransfer: dt });
  return dt;
}
const over = (h: BoardHarness, target: FakeNode, dt: DataTransferStub): ReturnType<BoardHarness['fire']> => h.fire(target, 'dragover', { dataTransfer: dt });
const drop = (h: BoardHarness, target: FakeNode, dt: DataTransferStub): ReturnType<BoardHarness['fire']> => h.fire(target, 'drop', { dataTransfer: dt });

// ---- Task 1: the tracer ----------------------------------------------------------------------------------------------------------------------

test('tracer: in the kanban only a card with offered moves is draggable; the list and a model without moves have none', async () => {
  const { h, model, world } = await ownerBoard();
  assert.ok(cardOf(model, 'plan:90-01').moves.length > 0);
  assert.equal(card(h, 'plan:90-01').draggable, true);
  assert.equal(card(h, 'plan:90-01').getAttribute('draggable'), 'true');

  const dev = start();
  dev.deliver({ type: 'state', model: modelOf(world, world.dev.memberId) });
  assert.ok(dev.$$('.card').length > 0);
  assert.deepEqual(dev.$$('.card').filter((c) => c.draggable).length, 0, 'the developer is offered no moves, so nothing is draggable');

  const narrow = start({ width: 400 });
  narrow.deliver({ type: 'state', model });
  assert.ok(narrow.$$('.card').length > 0);
  assert.equal(narrow.$$('.card').filter((c) => c.draggable).length, 0, 'the list never drags');
  h.setWidth(400);
  assert.equal(h.$$('.card').filter((c) => c.draggable).length, 0, 'switching to the list takes dragging away');
  h.setWidth(800);
  assert.equal(card(h, 'plan:90-01').draggable, true, 'and switching back gives it again');
});

test('tracer: dragstart carries the id under the board type, marks the offered cells of its own lane, and a drop on Backlog posts the hold with the pending line', async () => {
  const { h, model } = await ownerBoard();
  const ready = cardOf(model, 'plan:90-01');
  const dt = h.dataTransfer();
  h.fire(card(h, 'plan:90-01'), 'dragstart', { dataTransfer: dt });
  assert.equal(dt.getData(TYPE), 'plan:90-01');
  assert.deepEqual(dt.types, [TYPE], 'nothing is set as text/plain, so dropping on an editor inserts nothing');
  assert.equal(dt.effectAllowed, 'move');
  assert.ok(classes(card(h, 'plan:90-01')).includes('dragging'));
  assert.deepEqual(marked(h, 'drop-ok'), ['backlog', 'done', 'cancelled'], 'only the columns the card may move to, in its own lane');
  assert.deepEqual(ready.moves.filter((m) => m.column !== undefined).map((m) => m.column).sort(), ['backlog', 'cancelled', 'done']);

  const backlog = cell(h, 'backlog');
  const accepted = over(h, backlog, dt);
  assert.ok(accepted.defaultPrevented, 'dragover on an offered cell is accepted');
  drop(h, backlog, dt);
  assert.deepEqual(moves(h), [{ type: 'move', itemId: 'plan:90-01', target: 'hold' }], 'exactly one request');
  assert.equal(card(h, 'plan:90-01').getAttribute('aria-busy'), 'true');
  assert.equal(text(card(h, 'plan:90-01').querySelector('.pending-line')), 'Moving to Backlog...');
  assert.deepEqual(marked(h, 'drop-ok'), [], 'every highlight is cleared');
  assert.ok(cell(h, 'ready').contains(card(h, 'plan:90-01')), 'the card stays in Ready until the next state arrives');
  h.fire(card(h, 'plan:90-01'), 'dragend', { dataTransfer: Object.assign(dt, { dropEffect: 'move' }) });
  assert.equal(classes(card(h, 'plan:90-01')).includes('dragging'), false);
  assert.deepEqual(h.announcements.filter((a) => /cancelled/i.test(a)), []);
});

test('drag.js has no markup sink and no em or en dash in it, and uses the board data type', () => {
  assert.doesNotMatch(DRAG_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(DRAG_JS, /[—–]/);
  assert.match(DRAG_JS, /application\/x-near-ai-card/);
});
