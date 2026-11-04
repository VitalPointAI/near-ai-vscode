// Drag and drop in the kanban (Phase 62 plan 11): media/board/drag.js run with media/board/board.js in node:vm against the fake DOM. Models come from the
// real buildBoardModel over a signed in-memory log. The page only sends a request; the host decides, so every test checks what is posted and what is shown.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { buildBoardModel } from '../domain/team/board';
import { REFUSALS } from '../domain/team/boardText';
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

function start(options: { width?: number; reducedMotion?: boolean; menu?: boolean } = {}): BoardHarness {
  const h = createBoardHarness({ width: options.width ?? 800, ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }) });
  h.load(options.menu === true ? ['board.js', 'menu.js', 'drag.js'] : ['board.js', 'drag.js']);
  return h;
}

async function ownerBoard(options: { width?: number; reducedMotion?: boolean; menu?: boolean } = {}): Promise<{ h: BoardHarness; model: BoardModel; world: BoardWorld }> {
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

// 0.6.3 re-test in code-server (debug session board-codeserver-cards-and-drag): on the owner's board every drawn card was a phase card, which has no
// move, and the developer is offered no move at all, so nothing could be picked up and a drag did nothing, with no word why. Every card of the kanban
// can now be picked up by a person who may change the board (owner, lead, developer); a card without moves offers no cell and its drop says why.
test('tracer: in the kanban every card can be picked up by the owner, a lead or a developer; the list, a reviewer, an observer and a board that is down have none', async () => {
  const { h, model, world } = await ownerBoard();
  assert.ok(cardOf(model, 'plan:90-01').moves.length > 0);
  assert.equal(card(h, 'plan:90-01').draggable, true);
  assert.equal(card(h, 'plan:90-01').getAttribute('draggable'), 'true');
  assert.deepEqual(cardOf(model, 'phase:91').moves, [], 'a phase card has no move');
  assert.equal(card(h, 'phase:91').getAttribute('draggable'), 'true', 'it can still be picked up, so the drop can say why it stays');

  const dev = start();
  const devModel = modelOf(world, world.dev.memberId);
  dev.deliver({ type: 'state', model: devModel });
  assert.ok(dev.$$('.card').length > 0);
  assert.deepEqual(devModel.cards.filter((c) => c.moves.length > 0).map((c) => c.id), [], 'the developer is offered no move');
  assert.equal(dev.$$('.card').filter((c) => c.getAttribute('draggable') === 'true').length, dev.$$('.card').length, 'and can still pick up every card to learn why');
  for (const who of ['reviewer', 'observer'] as const) {
    const look = start();
    look.deliver({ type: 'state', model: modelOf(world, world[who].memberId) });
    assert.ok(look.$$('.card').length > 0);
    assert.equal(look.$$('.card').filter((c) => c.draggable).length, 0, `a ${who} only looks at the board, so nothing is draggable`);
  }
  for (const kind of ['offline', 'paused', 'removed'] as const) {
    const down = start();
    down.deliver({ type: 'state', model: modelOf(world, world.owner.memberId, { kind }) });
    assert.equal(down.$$('.card').filter((c) => c.draggable).length, 0, `a board that is ${kind} has nothing draggable`);
  }

  const narrow = start({ width: 400 });
  narrow.deliver({ type: 'state', model });
  assert.ok(narrow.$$('.card').length > 0);
  assert.equal(narrow.$$('.card').filter((c) => c.draggable).length, 0, 'the list never drags');
  h.setWidth(400);
  assert.equal(h.$$('.card').filter((c) => c.draggable).length, 0, 'switching to the list takes dragging away');
  h.setWidth(800);
  assert.equal(card(h, 'plan:90-01').draggable, true, 'and switching back gives it again');
});

test('CR-01: with browser-shaped NodeLists every render runs to its end: one roving stop per lane, draggable set, and a second model updates both', async () => {
  const { h, model, world } = await ownerBoard({ menu: true });
  // The fake DOM's lists have the browser's members only (WR-05), so code that calls map or indexOf on them throws here as it does in Chromium.
  const list = h.document.querySelectorAll('.card') as unknown as Record<string, unknown>;
  assert.equal(['map', 'filter', 'find', 'indexOf', 'some'].filter((name) => typeof list[name] === 'function').length, 0, 'no Array methods on a NodeList');
  assert.equal(typeof list.forEach, 'function');
  assert.equal(typeof (h.root.children as unknown as Record<string, unknown>).forEach, 'undefined', 'an HTMLCollection has no forEach');
  const lanes = h.$$('.lane');
  assert.ok(lanes.length > 0 && h.$$('.card').length > 0, 'cards are drawn');
  const stopsPerLane = lanes.map((lane) => Array.from(lane.querySelectorAll('.card-main')).filter((b) => b.getAttribute('tabindex') === '0').length);
  assert.deepEqual(stopsPerLane, lanes.map(() => 1), 'applyRoving ran: one tab stop per lane');
  assert.equal(card(h, 'plan:90-01').getAttribute('draggable'), 'true', 'the render listeners ran: drag.js marked the card');

  // A second model (a teammate change) renders again through the same path.
  const blocked = JSON.parse(JSON.stringify(modelOf(world, world.owner.memberId))) as BoardModel;
  blocked.cards = blocked.cards.filter((c) => c.id !== 'plan:90-02');
  h.deliver({ type: 'state', model: blocked });
  assert.equal(h.$('.card[data-id="plan:90-02"]'), null, 'the removed card is gone');
  assert.equal(card(h, 'plan:90-01').getAttribute('draggable'), 'true');
  const main = card(h, 'plan:90-01').querySelector('.card-main')!;
  main.focus();
  h.press(main, 'm');
  assert.equal(h.$('#menu')!.hidden, false, 'the Move menu opens from the keyboard');
  assert.ok(h.$$('#menu [role="menuitem"]').length >= cardOf(model, 'plan:90-01').moves.length, 'it lists the offered moves');
  h.press(h.focused(), 'ArrowDown');
  assert.equal(h.focused().getAttribute('role'), 'menuitem', 'stepping through the menu works');
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

// ---- 62-23: what a real drag in a real window needs --------------------------------------------------------------------------------------------

test('62-23: a state that arrives during a drag never removes, moves or replaces the dragged card; the render after dragend draws it', async () => {
  const { h, world } = await ownerBoard();
  const li = card(h, 'plan:90-01');
  const dt = lift(h, 'plan:90-01');
  // A teammate puts the card on hold while this person is still dragging it.
  h.deliver({ type: 'state', model: await holdState(world) });
  assert.equal(card(h, 'plan:90-01'), li, 'the very same element is still the card');
  assert.equal(li.isConnected, true, 'it is still in the page');
  assert.ok(cell(h, 'ready').contains(li), 'it stays in Ready while the drag lasts');
  assert.ok(classes(li).includes('dragging'), 'and still looks dragged');
  h.fire(li, 'dragend', { dataTransfer: Object.assign(dt, { dropEffect: 'none' }) });
  assert.ok(cell(h, 'backlog').contains(card(h, 'plan:90-01')), 'the render after the drag draws it in Backlog');
  assert.equal(classes(card(h, 'plan:90-01')).includes('dragging'), false);
});

/** A board page the host marked for the extension-host tests (data-e2e), with the drag script. */
async function e2eBoard(): Promise<{ h: BoardHarness; model: BoardModel }> {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const h = createBoardHarness({ width: 800 });
  h.document.body.setAttribute('data-e2e', '1');
  h.load(['board.js', 'drag.js']);
  h.deliver({ type: 'state', model });
  return { h, model };
}
const factsOf = (h: BoardHarness, id: number): Record<string, any> => {
  h.deliver({ type: 'e2e-probe', id, action: 'facts' });
  const found = h.posts.find((p) => p.type === 'e2e-facts' && p.id === id);
  assert.ok(found, 'the page answers the probe');
  return found;
};

test('62-23: under data-e2e the facts carry a drag log of dragstart, dragenter per cell, the drop with its verdict and dragend', async () => {
  const { h } = await e2eBoard();
  const dt = lift(h, 'plan:90-01');
  h.fire(cell(h, 'claimed'), 'dragenter', { dataTransfer: dt });
  over(h, cell(h, 'claimed'), dt);
  h.fire(cell(h, 'backlog'), 'dragenter', { dataTransfer: dt });
  h.fire(cell(h, 'backlog'), 'dragenter', { dataTransfer: dt });
  over(h, cell(h, 'backlog'), dt);
  drop(h, cell(h, 'backlog'), dt);
  h.fire(card(h, 'plan:90-01'), 'dragend', { dataTransfer: Object.assign(dt, { dropEffect: 'move' }) });
  assert.deepEqual(factsOf(h, 7).dragLog, [
    { event: 'dragstart', column: 'ready', lane: 'unassigned', verdict: 'started' },
    { event: 'dragenter', column: 'claimed', lane: 'unassigned', verdict: 'no' },
    { event: 'dragenter', column: 'backlog', lane: 'unassigned', verdict: 'ok' },
    { event: 'drop', column: 'backlog', lane: 'unassigned', verdict: 'ok' },
    { event: 'dragend', column: 'ready', lane: 'unassigned', verdict: 'dropped' }
  ], 'one dragenter per cell entered, however often the browser repeats it');

  // A long drag keeps only the last 20 entries (plan:90-01 waits for the host now, so the Backlog card plan:90-02 is dragged).
  const dt2 = lift(h, 'plan:90-02');
  for (let i = 0; i < 30; i += 1) h.fire(cell(h, i % 2 ? 'claimed' : 'ready'), 'dragenter', { dataTransfer: dt2 });
  h.fire(card(h, 'plan:90-02'), 'dragend', { dataTransfer: Object.assign(dt2, { dropEffect: 'none' }) });
  const log = factsOf(h, 8).dragLog as Array<Record<string, string>>;
  assert.equal(log.length, 20, 'the last 20 entries');
  assert.deepEqual(log[log.length - 1], { event: 'dragend', column: 'backlog', lane: 'unassigned', verdict: 'cancelled' });
});

test('62-23: without data-e2e no drag log is kept', async () => {
  const { h } = await ownerBoard();
  const dt = lift(h, 'plan:90-01');
  h.fire(cell(h, 'backlog'), 'dragenter', { dataTransfer: dt });
  drop(h, cell(h, 'backlog'), dt);
  h.fire(card(h, 'plan:90-01'), 'dragend', { dataTransfer: dt });
  const api = h.window.NearAiBoard as { dragLog?: () => unknown[] };
  // The page's arrays belong to its own realm, so the log is copied out before comparing.
  assert.deepEqual(typeof api.dragLog === 'function' ? JSON.parse(JSON.stringify(api.dragLog())) : 'no dragLog in the board api', [], 'nothing is logged');
  h.deliver({ type: 'e2e-probe', id: 9, action: 'facts' });
  assert.equal(h.posts.filter((p) => p.type === 'e2e-facts').length, 0, 'and the page answers no probe');
});

test('62-23: only the board e2e launch opens a DevTools port, on a free port of this computer, and no shipped file mentions remote debugging', () => {
  const root = path.resolve(__dirname, '../..');
  const run = readFileSync(path.join(root, 'src/test/e2e/run.ts'), 'utf8');
  const board = run.indexOf("if (only.has('board'))");
  assert.ok(board > 0, 'run.ts has the board launch');
  const end = run.indexOf('\n  }\n', board);
  const uses = [...run.matchAll(/remote-debugging-port/g)].map((m) => m.index!);
  assert.ok(uses.length >= 1, 'the board launch passes --remote-debugging-port');
  assert.ok(uses.every((at) => at > board && at < end), 'and no other launch does');
  assert.match(run, /listen\(0, '127\.0\.0\.1'/, 'the port is a free one on 127.0.0.1');
  assert.match(run.slice(board, end), /NEAR_AI_E2E_CDP_PORT/, 'the suite is told the port');
  const shipped: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { if (full !== path.join(root, 'src/test')) walk(full); } else if (/\.(ts|js|json|css|html)$/.test(name)) shipped.push(full);
    }
  };
  walk(path.join(root, 'src'));
  walk(path.join(root, 'media'));
  shipped.push(path.join(root, 'package.json'));
  assert.deepEqual(shipped.filter((file) => /remote-debugging/.test(readFileSync(file, 'utf8'))).map((file) => path.relative(root, file)), [], 'no production file opens a DevTools port');
});

// ---- Task 2: snap back with reasons, other rows, cancel, foreign drops, the list and motion ---------------------------------------------------

const refusalLine = (h: BoardHarness, id: string): string => text(card(h, id).querySelector('.refusal-line'));
const caption = (c: FakeNode): FakeNode | null => c.querySelector('.drop-caption');
const NOT_MOVED = 'Nothing was moved.';
const radio = (h: BoardHarness, label: string): FakeNode => h.$$('[role="radio"]').find((r) => text(r) === label)!;
const cantMove = (h: BoardHarness): string[] => h.announcements.filter((a) => a.startsWith("Can't move"));

test('a drop on a claim or integration column posts nothing, leaves the card where it is, shows the reason on the card and announces it', async () => {
  const { h, model } = await ownerBoard();
  const ready = cardOf(model, 'plan:90-01');
  const expected: Array<[string, string, string]> = [
    ['claimed', 'Claimed', 'Claiming a plan arrives in a later update. Nothing was moved.'],
    ['in-progress', 'In progress', 'Starting work from the board arrives with claims in a later update. Nothing was moved.'],
    ['in-review', 'In review', 'Review arrives in a later update. Nothing was moved.'],
    ['integrating', 'Shipping', 'Adding finished work to the project arrives in a later update. Nothing was moved.']
  ];
  for (const [column, label, sentence] of expected) {
    assert.equal(ready.refusals[column as 'claimed'], sentence, 'the model carries the sentence the card shows');
    const dt = lift(h, 'plan:90-01');
    const accepted = over(h, cell(h, column), dt);
    assert.ok(accepted.defaultPrevented, 'a refused cell still accepts the drop so the reason can be given');
    drop(h, cell(h, column), dt);
    h.fire(card(h, 'plan:90-01'), 'dragend', { dataTransfer: dt });
    assert.deepEqual(moves(h), [], 'nothing is posted');
    assert.ok(cell(h, 'ready').contains(card(h, 'plan:90-01')), 'the card never leaves its cell');
    assert.equal(refusalLine(h, 'plan:90-01'), sentence);
    assert.equal(card(h, 'plan:90-01').getAttribute('aria-busy'), null);
    h.advance(150);
    assert.equal(h.announcements[h.announcements.length - 1], `Can't move plan 90-01 to ${label}. ${sentence}`);
    assert.deepEqual(marked(h, 'drop-ok'), []);
    assert.deepEqual(marked(h, 'drop-no'), []);
  }
});

test('0.6.3 re-test: a card with no move can be picked up; no cell is offered, every other cell says why, and the drop shows the reason on the card, announces it and posts nothing', async () => {
  const { h, model, world } = await ownerBoard();
  const phaseReason = REFUSALS.phaseCard;
  assert.equal(cardOf(model, 'phase:91').refusals.ready, phaseReason, 'the model carries the sentence');
  const dt = lift(h, 'phase:91');
  assert.equal(dt.getData(TYPE), 'phase:91', 'the drag starts under the board type');
  assert.ok(classes(card(h, 'phase:91')).includes('dragging'));
  assert.deepEqual(marked(h, 'drop-ok'), [], 'no cell is offered');
  const ready = cell(h, 'ready');
  assert.ok(over(h, ready, dt).defaultPrevented, 'a refused cell still accepts the drop so the reason can be given');
  assert.equal(text(caption(ready)), `Can't drop here: ${phaseReason}`);
  drop(h, ready, dt);
  h.fire(card(h, 'phase:91'), 'dragend', { dataTransfer: dt });
  assert.deepEqual(moves(h), [], 'nothing is posted');
  assert.ok(cell(h, 'backlog').contains(card(h, 'phase:91')), 'the card never leaves its cell');
  assert.equal(refusalLine(h, 'phase:91'), phaseReason);
  h.advance(150);
  assert.equal(h.announcements[h.announcements.length - 1], `Can't move Phase 91 to Ready. ${phaseReason}`);
  // In another person's row the card's own reason comes first: it cannot move anywhere, so the row sentence would point the wrong way.
  const other = h.$$('.cell[data-column="ready"]').find((c) => c.getAttribute('data-lane') !== 'unassigned');
  if (other) {
    const again = lift(h, 'phase:91');
    drop(h, other, again);
    assert.equal(refusalLine(h, 'phase:91'), phaseReason);
  }

  const dev = start();
  dev.deliver({ type: 'state', model: modelOf(world, world.dev.memberId) });
  const devDt = lift(dev, 'plan:90-01');
  assert.deepEqual(marked(dev, 'drop-ok'), []);
  drop(dev, cell(dev, 'backlog'), devDt);
  dev.fire(card(dev, 'plan:90-01'), 'dragend', { dataTransfer: devDt });
  assert.deepEqual(moves(dev), [], 'the developer posts nothing');
  assert.equal(refusalLine(dev, 'plan:90-01'), REFUSALS.notManager);
  dev.advance(150);
  assert.equal(dev.announcements[dev.announcements.length - 1], `Can't move plan 90-01 to Backlog. ${REFUSALS.notManager}`);
  // Its own cell takes the drop and says nothing, as for any card.
  dev.$('.card[data-id="plan:90-01"] .dismiss')!.click();
  const own = lift(dev, 'plan:90-01');
  drop(dev, cell(dev, 'ready'), own);
  assert.deepEqual(moves(dev), []);
  assert.equal(refusalLine(dev, 'plan:90-01'), '', 'nothing is said for the card\'s own cell');
});

test('hovering a refused cell shows the caption inside it, and the caption goes on leave and on drop', async () => {
  const { h } = await ownerBoard();
  const dt = lift(h, 'plan:90-01');
  const claimed = cell(h, 'claimed');
  h.fire(claimed, 'dragenter', { dataTransfer: dt });
  over(h, claimed, dt);
  const cap = caption(claimed);
  assert.ok(cap, 'the caption is inside the cell');
  assert.equal(text(cap), "Can't drop here: Claiming a plan arrives in a later update. Nothing was moved.");
  assert.equal(cap!.getAttribute('role'), 'presentation');
  assert.equal(h.$$('.drop-caption').length, 1);
  over(h, claimed, dt);
  assert.equal(h.$$('.drop-caption').length, 1, 'the caption is not added twice');
  h.fire(claimed, 'dragleave', { dataTransfer: dt });
  assert.equal(caption(claimed), null, 'removed when the pointer leaves');
  assert.deepEqual(marked(h, 'drop-no'), []);

  over(h, claimed, dt);
  assert.ok(caption(claimed));
  over(h, cell(h, 'backlog'), dt);
  assert.equal(caption(claimed), null, 'moving to an offered cell takes the caption away');
  over(h, cell(h, 'in-review'), dt);
  assert.ok(caption(cell(h, 'in-review')));
  drop(h, cell(h, 'in-review'), dt);
  assert.equal(h.$$('.drop-caption').length, 0, 'removed on drop');
});

test('a not-ready backlog card gets the model sentence on the Ready cell, and a done card gets the reopen sentence', async () => {
  const world = await standard();
  const beta = modelOf(world, world.owner.memberId);
  const h = start();
  h.deliver({ type: 'state', model: beta });
  assert.equal(card(h, 'plan:90-02').draggable, true);
  const sentence = cardOf(beta, 'plan:90-02').refusals.ready!;
  assert.match(sentence, /not ready yet/);
  const dt = lift(h, 'plan:90-02');
  drop(h, cell(h, 'ready'), dt);
  assert.deepEqual(moves(h), []);
  assert.equal(refusalLine(h, 'plan:90-02'), sentence);
  assert.ok(cell(h, 'backlog').contains(card(h, 'plan:90-02')));

  world.accept(world.owner, 'item.updated', { id: 'plan:90-01', changes: { state: 'done' } });
  const done = modelOf(world, world.owner.memberId);
  // Owner decision 2026-11-03 (G-62-3, plan 62-21): Done starts folded, so the person opens it to reach the done card.
  h.$('.column[data-column="done"] .col-btn')!.click();
  h.deliver({ type: 'state', model: done });
  assert.ok(cell(h, 'done').contains(card(h, 'plan:90-01')));
  assert.equal(card(h, 'plan:90-01').draggable, true, 'a done card can be reopened, so it is draggable');
  const dt2 = lift(h, 'plan:90-01');
  assert.deepEqual(marked(h, 'drop-ok'), ['backlog'], 'only Backlog is offered for a done card');
  drop(h, cell(h, 'ready'), dt2);
  assert.deepEqual(moves(h), []);
  assert.equal(refusalLine(h, 'plan:90-01'), REFUSALS.terminal);
  const dt3 = lift(h, 'plan:90-01');
  drop(h, cell(h, 'backlog'), dt3);
  assert.deepEqual(moves(h), [{ type: 'move', itemId: 'plan:90-01', target: 'reopen' }]);
  assert.equal(text(card(h, 'plan:90-01').querySelector('.pending-line')), 'Moving to Backlog...');
});

test('a drop in another row is refused with the row sentence; a drop on the card\'s own column does and says nothing', async () => {
  const { h } = await ownerBoard();
  radio(h, 'Phase').click();
  const lane = card(h, 'plan:90-01').closest('.cell')!.getAttribute('data-lane')!;
  assert.equal(lane, 'phase:90');
  const dt = lift(h, 'plan:90-01');
  assert.deepEqual(h.$$('.cell').filter((c) => classes(c).includes('drop-ok')).map((c) => c.getAttribute('data-lane')), [lane, lane, lane], 'only cells of its own row are offered');
  assert.deepEqual(h.$$('.lane').filter((l) => classes(l).includes('drag-active')).map((l) => l.getAttribute('data-lane')), [lane]);
  assert.deepEqual(h.$$('.column').filter((c) => classes(c).includes('drag-active')).map((c) => c.getAttribute('data-column')), ['backlog', 'done', 'cancelled']);
  const other = cell(h, 'backlog', 'board');
  over(h, other, dt);
  assert.equal(text(caption(other)), `Can't drop here: ${REFUSALS.differentRow}`);
  drop(h, other, dt);
  assert.deepEqual(moves(h), []);
  assert.equal(refusalLine(h, 'plan:90-01'), 'This card stays in its own row. Drop it in another column of the same row.');
  h.advance(150);
  assert.equal(h.announcements[h.announcements.length - 1], `Can't move plan 90-01 to Backlog. ${REFUSALS.differentRow}`);
  assert.equal(h.$$('.drop-caption').length, 0);
  assert.deepEqual(marked(h, 'drop-ok'), []);
  h.fire(card(h, 'plan:90-01'), 'dragend', { dataTransfer: dt });

  card(h, 'plan:90-01').querySelector('.dismiss')!.click();
  assert.equal(h.$$('.refusal-line').length, 0, 'the person dismissed the message');
  const before = h.announcements.length;
  const own = cell(h, 'ready', lane);
  const dt3 = lift(h, 'plan:90-01');
  over(h, own, dt3);
  assert.equal(caption(own), null, 'no caption on its own column');
  drop(h, own, dt3);
  h.advance(150);
  assert.deepEqual(moves(h), []);
  assert.equal(h.announcements.length, before, 'nothing is announced');
  assert.equal(h.$$('.refusal-line').length, 0, 'and no refusal line appears');
  assert.equal(card(h, 'plan:90-01').getAttribute('aria-busy'), null);
});

test('62-23: in Group by Member a drop in another person\'s row is refused with the way forward, Assign to in the Move to... menu; Group by Phase keeps the row sentence', async () => {
  const world = await standard();
  world.accept(world.lead, 'item.assigned', { id: 'plan:90-02', memberId: world.dev.memberId });
  const h = start();
  h.deliver({ type: 'state', model: modelOf(world, world.owner.memberId) });
  const devLane = world.dev.memberId;
  assert.equal(card(h, 'plan:90-02').closest('.cell')!.getAttribute('data-lane'), devLane, 'the assigned card has its own person row');
  const sentence = 'This card stays in its own row. To give it to someone else, use Assign to in its Move to... menu. Nothing was moved.';
  const dt = lift(h, 'plan:90-01');
  const other = cell(h, 'backlog', devLane);
  over(h, other, dt);
  assert.equal(text(caption(other)), `Can't drop here: ${sentence}`);
  drop(h, other, dt);
  h.fire(card(h, 'plan:90-01'), 'dragend', { dataTransfer: dt });
  assert.deepEqual(moves(h), [], 'nothing is posted');
  assert.ok(cell(h, 'ready').contains(card(h, 'plan:90-01')), 'the card stays where it was');
  assert.equal(refusalLine(h, 'plan:90-01'), sentence);
  h.advance(150);
  assert.equal(h.announcements[h.announcements.length - 1], `Can't move plan 90-01 to Backlog. ${sentence}`);

  // Grouped by phase, the rows are phases, so the sentence keeps to the row.
  card(h, 'plan:90-01').querySelector('.dismiss')!.click();
  radio(h, 'Phase').click();
  const dt2 = lift(h, 'plan:90-01');
  drop(h, cell(h, 'backlog', 'board'), dt2);
  h.fire(card(h, 'plan:90-01'), 'dragend', { dataTransfer: dt2 });
  assert.deepEqual(moves(h), []);
  assert.equal(refusalLine(h, 'plan:90-01'), 'This card stays in its own row. Drop it in another column of the same row.');
  assert.match(DRAG_JS, /use Assign to/);
});

test('62-23: a refused drop brings the card with its reason into view (nearest edge), and an offered drop does not scroll', async () => {
  const { h } = await ownerBoard();
  const li = card(h, 'plan:90-01');
  const scrolls: unknown[] = [];
  (li as unknown as { scrollIntoView: (o: unknown) => void }).scrollIntoView = (o) => { scrolls.push(JSON.parse(JSON.stringify(o))); };
  const dt = lift(h, 'plan:90-01');
  drop(h, cell(h, 'in-progress'), dt);
  h.fire(li, 'dragend', { dataTransfer: dt });
  assert.equal(refusalLine(h, 'plan:90-01'), REFUSALS['in-progress']);
  assert.deepEqual(scrolls, [{ block: 'nearest', inline: 'nearest' }], 'the reason is scrolled into view once');
  const dt2 = lift(h, 'plan:90-01');
  drop(h, cell(h, 'backlog'), dt2);
  h.fire(li, 'dragend', { dataTransfer: dt2 });
  assert.equal(scrolls.length, 1, 'an offered drop leaves the scroll alone');
});

test('Escape during a drag, or a drag that ends with no drop, clears the highlights and announces the cancel once', async () => {
  const { h } = await ownerBoard();
  let dt = lift(h, 'plan:90-01');
  assert.deepEqual(marked(h, 'drop-ok'), ['backlog', 'done', 'cancelled']);
  over(h, cell(h, 'claimed'), dt);
  h.fire(card(h, 'plan:90-01'), 'dragend', { dataTransfer: Object.assign(dt, { dropEffect: 'none' }) });
  assert.deepEqual(marked(h, 'drop-ok'), []);
  assert.equal(h.$$('.drop-caption').length, 0);
  assert.equal(classes(card(h, 'plan:90-01')).includes('dragging'), false);
  h.advance(150);
  assert.deepEqual(h.announcements, ['Move cancelled. The card is still in Ready.']);
  assert.deepEqual(moves(h), []);

  dt = lift(h, 'plan:90-01');
  const esc = h.fire(h.document, 'keydown', { key: 'Escape' });
  assert.equal(esc.defaultPrevented, false);
  assert.deepEqual(marked(h, 'drop-ok'), []);
  h.fire(card(h, 'plan:90-01'), 'dragend', { dataTransfer: dt });
  h.advance(150);
  assert.equal(h.announcements.filter((a) => a.startsWith('Move cancelled')).length, 2, 'one announcement per cancelled drag, none doubled by dragend');

  const quiet = h.announcements.length;
  h.fire(h.document, 'keydown', { key: 'Escape' });
  h.advance(150);
  assert.equal(h.announcements.length, quiet, 'Escape with no drag does nothing');
});

test('a drag that is dropped on an offered cell does not announce a cancel when it ends', async () => {
  const { h } = await ownerBoard();
  const dt = lift(h, 'plan:90-01');
  drop(h, cell(h, 'backlog'), dt);
  h.fire(card(h, 'plan:90-01'), 'dragend', { dataTransfer: dt });
  h.advance(150);
  assert.deepEqual(h.announcements.filter((a) => /cancelled/i.test(a)), []);
  assert.equal(moves(h).length, 1);
});

test('drops that do not carry the board type are ignored', async () => {
  const { h } = await ownerBoard();
  const foreign = h.dataTransfer();
  foreign.setData('text/plain', 'plan:90-01');
  h.advance(150); // the first load announcement lands
  const before = h.announcements.length;
  assert.equal(over(h, cell(h, 'backlog'), foreign).defaultPrevented, false, 'a foreign drag is not accepted');
  drop(h, cell(h, 'backlog'), foreign);
  drop(h, cell(h, 'claimed'), foreign);
  h.advance(150);
  assert.deepEqual(moves(h), []);
  assert.equal(h.announcements.length, before);
  assert.equal(h.$$('.refusal-line').length, 0);

  // Even in the middle of a real drag, a drop that is only text does nothing.
  const dt = lift(h, 'plan:90-01');
  const files = h.dataTransfer();
  files.setData('Files', '');
  assert.equal(drop(h, cell(h, 'backlog'), foreign).defaultPrevented, false);
  assert.equal(drop(h, cell(h, 'claimed'), files).defaultPrevented, false);
  assert.deepEqual(moves(h), []);
  assert.equal(h.$$('.refusal-line').length, 0);
  assert.deepEqual(marked(h, 'drop-ok'), ['backlog', 'done', 'cancelled'], 'the real drag is untouched');
  assert.ok(over(h, cell(h, 'backlog'), dt).defaultPrevented);
});

test('at 400 px nothing is draggable and drag events do nothing', async () => {
  const { h } = await ownerBoard({ width: 400 });
  assert.equal(h.$$('.card').filter((c) => c.draggable).length, 0);
  const dt = h.dataTransfer();
  const start = h.fire(card(h, 'plan:90-01'), 'dragstart', { dataTransfer: dt });
  assert.equal(dt.types.length, 0, 'no data is set');
  assert.equal(classes(card(h, 'plan:90-01')).includes('dragging'), false);
  assert.equal(start.defaultPrevented, false);
  h.fire(h.$('#board')!, 'drop', { dataTransfer: dt });
  assert.deepEqual(moves(h), []);
});

test('a drop sent by drag.js that the host refuses shows the reason once on that card, and the menu does not draw it again', async () => {
  const { h } = await ownerBoard({ menu: true });
  const dt = lift(h, 'plan:90-01');
  drop(h, cell(h, 'backlog'), dt);
  h.fire(card(h, 'plan:90-01'), 'dragend', { dataTransfer: Object.assign(dt, { dropEffect: 'move' }) });
  assert.equal(moves(h).length, 1);
  const stale = 'Dana already changed this card. The board now shows the latest. Nothing was moved.';
  h.deliver({ type: 'refused', itemId: 'plan:90-01', reason: stale });
  h.advance(150);
  assert.equal(refusalLine(h, 'plan:90-01'), stale);
  assert.equal(card(h, 'plan:90-01').getAttribute('aria-busy'), null);
  assert.deepEqual(cantMove(h), [`Can't move plan 90-01 to Backlog. ${stale}`], 'announced once');
  assert.equal(h.$$('.refusal-line').length, 1, 'and not drawn on any other card');
  h.deliver({ type: 'refused', itemId: 'plan:90-01', reason: stale });
  h.advance(150);
  assert.equal(cantMove(h).length, 1, 'a second reply for the same request is not announced again');
});

test('a refusal for a request the menu sent is left to the menu, and a dismissed drop prompt clears the pending line silently', async () => {
  const { h } = await ownerBoard({ menu: true });
  card(h, 'plan:90-01').querySelector('.card-main')!.focus();
  h.press(card(h, 'plan:90-01').querySelector('.card-main')!, 'm');
  const hold = h.$$('#menu [role="menuitem"]').find((i) => text(i) === 'Backlog (put on hold)')!;
  hold.focus();
  h.press(hold, 'Enter');
  assert.equal(moves(h).length, 1);
  const reason = 'The team could not be reached, so nothing was changed. Check your internet connection and try again.';
  h.deliver({ type: 'refused', itemId: 'plan:90-01', reason });
  h.advance(150);
  assert.deepEqual(cantMove(h), [`Can't move plan 90-01 to Backlog. ${reason}`], 'one announcement, from the menu');

  const dt = lift(h, 'plan:90-02');
  drop(h, cell(h, 'done'), dt);
  assert.equal(text(card(h, 'plan:90-02').querySelector('.pending-line')), 'Moving to Done...');
  h.deliver({ type: 'refused', itemId: 'plan:90-02', reason: '' });
  h.advance(150);
  assert.equal(card(h, 'plan:90-02').getAttribute('aria-busy'), null);
  assert.equal(h.$$('.refusal-line').filter((r) => card(h, 'plan:90-02').contains(r)).length, 0);
  assert.equal(cantMove(h).length, 1);
});

// Motion: FLIP with a transform set through the style object; skipped under reduced motion.
function stubRect(node: FakeNode, rect: { left: number; top: number }): void {
  node.getBoundingClientRect = () => ({ x: rect.left, y: rect.top, left: rect.left, top: rect.top, right: rect.left + 200, bottom: rect.top + 60, width: 200, height: 60 });
}
function watchTransform(node: FakeNode): string[] {
  const seen: string[] = [];
  const original = node.style.setProperty;
  node.style.setProperty = (name: string, value: string): void => { if (name === 'transform') seen.push(value); original(name, value); };
  return seen;
}
async function holdState(world: BoardWorld): Promise<BoardModel> {
  world.accept(world.owner, 'item.updated', { id: 'plan:90-01', changes: { hold: true } });
  return modelOf(world, world.owner.memberId);
}

test('after a confirmed drop the card relocates with a 150 ms transform transition that is cleared afterwards', async () => {
  const { h, world } = await ownerBoard({ reducedMotion: false });
  const li = card(h, 'plan:90-01');
  const where = { left: 100, top: 40 };
  stubRect(li, where);
  const seen = watchTransform(li);
  const dt = lift(h, 'plan:90-01');
  drop(h, cell(h, 'backlog'), dt);
  h.fire(li, 'dragend', { dataTransfer: Object.assign(dt, { dropEffect: 'move' }) });
  assert.deepEqual(seen, [], 'nothing moves until the host confirms');
  where.left = 300;
  where.top = 40;
  h.deliver({ type: 'state', model: await holdState(world) });
  assert.ok(cell(h, 'backlog').contains(card(h, 'plan:90-01')), 'the card is now in Backlog');
  assert.equal(seen[0], 'translate(-200px, 0px)', 'it starts where it was');
  assert.match(li.style.getPropertyValue('transition'), /150ms/);
  assert.equal(li.style.getPropertyValue('transform'), 'translate(0px, 0px)', 'and slides to its place');
  h.advance(200);
  assert.equal(li.style.getPropertyValue('transform'), '', 'the transform is cleared after 150 ms');
  assert.equal(li.style.getPropertyValue('transition'), '');
  h.advance(3100);
  assert.equal(classes(li).includes('changed'), false);
});

test('under reduced motion no transform is ever set, and the changed outline for a teammate move stays', async () => {
  const { h, world } = await ownerBoard({ reducedMotion: true });
  const li = card(h, 'plan:90-01');
  const where = { left: 100, top: 40 };
  stubRect(li, where);
  const seen = watchTransform(li);
  const other = card(h, 'plan:90-02');
  stubRect(other, { left: 100, top: 200 });
  const dt = lift(h, 'plan:90-01');
  drop(h, cell(h, 'backlog'), dt);
  h.fire(li, 'dragend', { dataTransfer: Object.assign(dt, { dropEffect: 'move' }) });
  where.left = 300;
  h.deliver({ type: 'state', model: await holdState(world) });
  assert.ok(cell(h, 'backlog').contains(card(h, 'plan:90-01')));
  h.advance(500);
  assert.deepEqual(seen, []);
  assert.equal(li.style.getPropertyValue('transform'), '');

  // A move made by someone else is outlined for 3 seconds whatever the motion setting.
  const w2 = await standard();
  const m1 = modelOf(w2, w2.owner.memberId);
  const h3 = start({ reducedMotion: true });
  h3.deliver({ type: 'state', model: m1 });
  w2.accept(w2.owner, 'item.updated', { id: 'plan:90-01', changes: { hold: true } });
  h3.deliver({ type: 'state', model: modelOf(w2, w2.owner.memberId) });
  assert.ok(classes(card(h3, 'plan:90-01')).includes('changed'));
  assert.equal(watchTransform(card(h3, 'plan:90-01')).length, 0);
  h3.advance(3100);
  assert.equal(classes(card(h3, 'plan:90-01')).includes('changed'), false);
});

test('drag.js reads the reduced motion setting, names the row sentence, and keeps every string free of em and en dashes', () => {
  assert.match(DRAG_JS, /prefers-reduced-motion/);
  assert.match(DRAG_JS, /This card stays in its own row/);
  assert.doesNotMatch(DRAG_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(DRAG_JS, /[\u2013\u2014]/);
  assert.doesNotMatch(DRAG_JS, /\.setAttribute\(\s*'style'|\.style\.cssText|\.style\.[a-z]+\s*=/, 'motion goes through style.setProperty only');
});
