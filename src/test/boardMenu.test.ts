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
const items = (h: BoardHarness): FakeNode[] => Array.from(menu(h).querySelectorAll('[role="menuitem"]'));
const isOpen = (h: BoardHarness): boolean => h.$('#menu') !== null && !menu(h).hidden;
const cardOf = (model: BoardModel, id: string): BoardCard => model.cards.find((c) => c.id === id)!;
const moves = (h: BoardHarness): Array<Record<string, any>> => h.posts.filter((p) => p.type === 'move');
// Owner decision 2026-11-03 (G-62-5, 62-20): after the moves the menu lists the card's assignment actions, so a menu holds the moves' labels and then these.
const ASSIGN_WORDS: Record<string, (c: BoardCard) => string> = {
  assign: () => 'Assign to...', unassign: (c) => `Unassign ${c.assignee?.name ?? ''}`, 'assign-me': () => 'Assign to me', 'unassign-me': () => 'Unassign me'
};
const offered = (c: BoardCard): string[] => [...c.moves.map((m) => m.label), ...c.assignActions.map((key) => ASSIGN_WORDS[key]!(c))];

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
  // Owner decision 2026-11-03 (62-20): the moves, then Assign to... after its own separator.
  assert.deepEqual(items(h).map((i) => text(i)), offered(ready));
  assert.equal(h.focused(), items(h)[0]);
  assert.equal(text(h.focused()), 'Done (mark as finished)');
  assert.deepEqual(menu(h).querySelectorAll('[role="separator"]').length, 2, 'one before Block... and one before the assignment items');
  const kids = Array.from(menu(h).children);
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
  // Owner decision 2026-11-03 (62-20): the assignment items follow the moves.
  assert.deepEqual(items(h).map((i) => text(i)), offered(cardOf(model, 'plan:90-01')));
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

// ---- Task 2: the full keyboard model, refusals, focus return and edge cases -------------------------------------------------------------------

const withCards = (model: BoardModel, edit: (cards: BoardCard[]) => void): BoardModel => {
  const copy = JSON.parse(JSON.stringify(model)) as BoardModel;
  edit(copy.cards);
  return copy;
};
const STALE = 'Dana already changed this card. The board now shows the latest. Nothing was moved.';

async function ownerBoard(width = 800): Promise<{ h: BoardHarness; model: BoardModel; world: BoardWorld }> {
  const world = await standard();
  const model = modelOf(world, world.owner.memberId);
  const h = start(width);
  h.deliver({ type: 'state', model });
  return { h, model, world };
}

function open(h: BoardHarness, id: string): void {
  main(h, id).focus();
  h.press(main(h, id), 'm');
  assert.ok(isOpen(h), `the menu opened on ${id}`);
}

test('Up wraps from the first to the last item; Home and End jump; a letter jumps to the next item starting with it', async () => {
  const { h, model } = await ownerBoard();
  const ready = cardOf(model, 'plan:90-01');
  open(h, 'plan:90-01');
  // Owner decision 2026-11-03 (62-20): the last item is now the assignment item after the moves.
  const all = offered(ready);
  assert.equal(all[all.length - 1], 'Assign to...');
  h.press(h.focused(), 'ArrowUp');
  assert.equal(text(h.focused()), all[all.length - 1], 'Up on the first wraps to the last');
  h.press(h.focused(), 'Home');
  assert.equal(text(h.focused()), ready.moves[0].label);
  h.press(h.focused(), 'End');
  assert.equal(text(h.focused()), all[all.length - 1]);
  h.press(h.focused(), 'c');
  assert.equal(text(h.focused()), 'Cancelled (cancel this item)...');
  h.press(h.focused(), 'B');
  assert.equal(text(h.focused()), 'Backlog (put on hold)', 'the first item starting with B after Cancelled');
  h.press(h.focused(), 'b');
  assert.equal(text(h.focused()), 'Block...', 'a second B moves on to the next one');
  h.press(h.focused(), 'b');
  assert.equal(text(h.focused()), 'Backlog (put on hold)', 'and wraps round');
  h.press(h.focused(), 'z');
  assert.equal(text(h.focused()), 'Backlog (put on hold)', 'a letter nothing starts with does nothing');
});

test('typing u on a blocked card jumps to Unblock, and Space runs the focused item', async () => {
  const world = await standard();
  world.accept(world.lead, 'item.blocked', { id: 'plan:90-01', reason: 'waiting for the vendor' });
  const model = modelOf(world, world.owner.memberId);
  const blocked = cardOf(model, 'plan:90-01');
  assert.deepEqual(blocked.moves.map((m) => m.key), ['cancel', 'unblock']);
  const h = start();
  h.deliver({ type: 'state', model });
  open(h, blocked.id);
  // Owner decision 2026-11-03 (62-20): a second separator comes before the assignment items.
  assert.equal(menu(h).querySelectorAll('[role="separator"]').length, 2, 'one separator comes before Unblock and one before Assign to...');
  assert.equal(text(Array.from(menu(h).children)[Array.from(menu(h).children).findIndex((k) => k.getAttribute('role') === 'separator') + 1]), 'Unblock');
  h.press(h.focused(), 'u');
  assert.equal(text(h.focused()), 'Unblock');
  h.press(h.focused(), ' ');
  assert.ok(!isOpen(h));
  assert.deepEqual(moves(h), [{ type: 'move', itemId: blocked.id, target: 'unblock' }]);
  assert.equal(text(card(h, blocked.id).querySelector('.pending-line')), 'Saving...', 'a move that stays in its column says Saving...');
  assert.equal(card(h, blocked.id).getAttribute('aria-busy'), 'true');
});

test('Escape closes and focuses the Move to... button; Tab closes and leaves the key to the page; a click outside closes', async () => {
  const { h } = await ownerBoard();
  open(h, 'plan:90-01');
  const escape = h.press(h.focused(), 'Escape');
  assert.ok(escape.defaultPrevented);
  assert.ok(!isOpen(h));
  assert.equal(moveBtn(h, 'plan:90-01').getAttribute('aria-expanded'), 'false');
  assert.equal(h.focused(), moveBtn(h, 'plan:90-01'));
  assert.deepEqual(moves(h), []);

  open(h, 'plan:90-01');
  const tab = h.press(h.focused(), 'Tab');
  assert.ok(!tab.defaultPrevented, 'Tab keeps its normal job so focus continues in page order');
  assert.ok(!isOpen(h));
  assert.equal(h.focused(), moveBtn(h, 'plan:90-01'), 'focus starts from the Move to... button, so the next Tab goes to the next element');

  open(h, 'plan:90-01');
  h.click(h.$('#toolbar')!);
  assert.ok(!isOpen(h), 'a click outside the menu closes it');
  assert.equal(moveBtn(h, 'plan:90-01').getAttribute('aria-expanded'), 'false');
  open(h, 'plan:90-01');
  h.click(menu(h));
  assert.ok(isOpen(h), 'a click inside the menu but not on an item keeps it open');
});

test('the Move to... button opens, and pressing it again closes; opening a second card closes the first', async () => {
  const { h, model } = await ownerBoard();
  const second = model.cards.find((c) => c.id !== 'plan:90-01' && c.moves.length > 0 && !moveBtn(h, c.id).hidden)!;
  moveBtn(h, 'plan:90-01').focus();
  h.press(moveBtn(h, 'plan:90-01'), 'Enter');
  assert.ok(isOpen(h));
  h.press(moveBtn(h, 'plan:90-01'), 'Enter');
  assert.ok(!isOpen(h), 'the same button closes it');

  h.press(moveBtn(h, 'plan:90-01'), 'Enter');
  assert.ok(isOpen(h));
  h.click(moveBtn(h, second.id));
  assert.equal(h.$$('#menu').length, 1, 'there is only ever one menu');
  assert.ok(isOpen(h));
  assert.equal(menu(h).getAttribute('aria-label'), 'Move ' + second.displayId + ' to');
  assert.equal(moveBtn(h, 'plan:90-01').getAttribute('aria-expanded'), 'false');
  assert.equal(moveBtn(h, second.id).getAttribute('aria-expanded'), 'true');
  // Owner decision 2026-11-03 (62-20): the second card's assignment items follow its moves.
  assert.deepEqual(items(h).map((i) => text(i)), offered(second));
});

test('a card with no moves has no Move to... button and M opens nothing; a read-only model has none; an offline model cannot open it', async () => {
  const { h, model, world } = await ownerBoard();
  // Owner decision 2026-11-03 (62-20): an assignment action alone also opens the menu, so a card with nothing in it has neither.
  const none = withCards(model, (cards) => { const c = cards.find((x) => x.id === 'plan:90-01')!; c.moves = []; c.assignActions = []; });
  h.deliver({ type: 'state', model: none });
  assert.ok(moveBtn(h, 'plan:90-01').hidden, 'no moves and no assignment, no button');
  main(h, 'plan:90-01').focus();
  const press = h.press(main(h, 'plan:90-01'), 'm');
  assert.ok(!press.defaultPrevented);
  assert.ok(!isOpen(h));
  h.press(main(h, 'plan:90-01'), 'F10', { shiftKey: true });
  h.press(main(h, 'plan:90-01'), 'ContextMenu');
  assert.ok(!isOpen(h));

  const looking = start();
  looking.deliver({ type: 'state', model: modelOf(world, world.observer.memberId) });
  assert.ok(looking.$$('.move-btn').every((b) => b.hidden), 'an observer sees no Move to... buttons');
  main(looking, 'plan:90-01').focus();
  looking.press(main(looking, 'plan:90-01'), 'm');
  assert.ok(!isOpen(looking));

  const offline = start();
  offline.deliver({ type: 'state', model: { ...model, status: { kind: 'offline', text: 'Offline', lastUpdated: '2026-03-05T11:55:00.000Z' } } });
  const button = moveBtn(offline, 'plan:90-01');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  offline.click(button);
  assert.ok(!isOpen(offline), 'an offline board does not open the menu from the button');
  main(offline, 'plan:90-01').focus();
  offline.press(main(offline, 'plan:90-01'), 'm');
  assert.ok(!isOpen(offline), 'nor from the keyboard');
  assert.deepEqual(moves(offline), []);
});

test('a refusal shows on the card with the error icon and Dismiss message, is announced once, and returns focus to the Move to... button', async () => {
  const { h } = await ownerBoard();
  open(h, 'plan:90-01');
  const hold = items(h).find((i) => text(i) === 'Backlog (put on hold)')!;
  hold.focus();
  h.press(hold, 'Enter');
  assert.equal(text(card(h, 'plan:90-01').querySelector('.pending-line')), 'Moving to Backlog...');
  h.focused().blur();
  assert.equal(h.focused(), h.document.body);

  h.deliver({ type: 'refused', itemId: 'plan:90-01', reason: STALE });
  const msg = card(h, 'plan:90-01').querySelector('.card-msg')!;
  assert.equal(text(msg.querySelector('.refusal-line')), STALE);
  assert.equal(msg.querySelectorAll('svg').length >= 1, true, 'the error icon is drawn');
  assert.equal(msg.querySelector('.pending-line'), null, 'the pending line is gone');
  assert.equal(card(h, 'plan:90-01').getAttribute('aria-busy'), null);
  const dismiss = msg.querySelector('.dismiss')!;
  assert.equal(dismiss.getAttribute('aria-label'), 'Dismiss message');
  h.advance(200);
  const said = h.announcements.filter((a) => a.startsWith("Can't move"));
  assert.deepEqual(said, [`Can't move plan 90-01 to Backlog. ${STALE}`]);
  assert.equal(h.focused(), moveBtn(h, 'plan:90-01'));
  assert.equal(moves(h).length, 1, 'a refusal posts nothing more');

  // A second delivery of the same refusal is not a second announcement: nothing is waiting for it any more.
  h.deliver({ type: 'refused', itemId: 'plan:90-01', reason: STALE });
  h.advance(200);
  assert.equal(h.announcements.filter((a) => a.startsWith("Can't move")).length, 1);

  h.click(card(h, 'plan:90-01').querySelector('.dismiss')!);
  assert.equal(card(h, 'plan:90-01').querySelector('.refusal-line'), null, 'Dismiss message removes the line');
});

test('a refusal of a block or unblock names no column; a refusal for an item the menu did not move is left to its owner', async () => {
  const { h } = await ownerBoard();
  open(h, 'plan:90-01');
  const block = items(h).find((i) => text(i) === 'Block...')!;
  block.focus();
  h.press(block, 'Enter');
  assert.deepEqual(moves(h), [{ type: 'move', itemId: 'plan:90-01', target: 'block' }]);
  h.deliver({ type: 'refused', itemId: 'plan:90-01', reason: 'Someone else blocked this card first. Nothing was moved.' });
  h.advance(200);
  assert.deepEqual(h.announcements.filter((a) => a.startsWith("Can't move")), ["Can't move plan 90-01. Someone else blocked this card first. Nothing was moved."]);

  // The form or the drag handler may refuse something for another card; the menu must not draw that on the card.
  h.deliver({ type: 'refused', itemId: 'plan:90-02', reason: 'You can edit only the items you added. Nothing was saved.' });
  const other = h.$('.card[data-id="plan:90-02"]');
  if (other !== null) assert.equal(other.querySelector('.refusal-line'), null);
});

test('a refusal with an empty reason (a dismissed prompt) clears the pending line and announces nothing', async () => {
  const { h } = await ownerBoard();
  open(h, 'plan:90-01');
  const done = items(h).find((i) => text(i) === 'Done (mark as finished)')!;
  done.focus();
  h.press(done, 'Enter');
  assert.equal(text(card(h, 'plan:90-01').querySelector('.pending-line')), 'Moving to Done...');
  h.advance(500);
  const before = h.announcements.length;
  h.deliver({ type: 'refused', itemId: 'plan:90-01', reason: '' });
  h.advance(500);
  assert.equal(card(h, 'plan:90-01').querySelector('.pending-line'), null);
  assert.equal(card(h, 'plan:90-01').querySelector('.refusal-line'), null);
  assert.equal(card(h, 'plan:90-01').getAttribute('aria-busy'), null);
  assert.equal(h.announcements.length, before, 'nothing is announced');
  // A late non-empty refusal for the same item is no longer ours either.
  h.deliver({ type: 'refused', itemId: 'plan:90-01', reason: STALE });
  assert.equal(card(h, 'plan:90-01').querySelector('.refusal-line'), null);
});

test('a state that confirms the move clears the pending line; the menu closes when the card changes under it', async () => {
  const { h, model } = await ownerBoard();
  open(h, 'plan:90-01');
  const hold = items(h).find((i) => text(i) === 'Backlog (put on hold)')!;
  hold.focus();
  h.press(hold, 'Enter');
  const moved = withCards(model, (cards) => { const c = cards.find((x) => x.id === 'plan:90-01')!; c.column = 'backlog'; c.held = true; c.stateLabel = 'Backlog'; });
  h.deliver({ type: 'state', model: moved });
  assert.equal(card(h, 'plan:90-01').querySelector('.pending-line'), null);
  assert.equal(card(h, 'plan:90-01').getAttribute('aria-busy'), null);

  // A teammate changes what the card may do while its menu is open: the menu does not offer stale moves.
  const again = cardOf(moved, 'plan:90-01');
  assert.ok(again.moves.length > 0);
  open(h, 'plan:90-01');
  h.deliver({ type: 'state', model: withCards(moved, (cards) => { cards.find((x) => x.id === 'plan:90-01')!.moves = cards.find((x) => x.id === 'plan:90-01')!.moves.slice(0, 1); }) });
  assert.ok(!isOpen(h), 'the menu closed because its list changed');
  h.deliver({ type: 'state', model: withCards(moved, (cards) => { cards.splice(cards.findIndex((x) => x.id === 'plan:90-01'), 1); }) });
  assert.equal(h.$('.card[data-id="plan:90-01"]'), null);
});

test('menu labels wrap inside 320 px and come only from the model plus the card id; no string in menu.js has an em or en dash', () => {
  assert.doesNotMatch(MENU_JS, /[—–]/);
  const css = readFileSync(path.resolve(__dirname, '../../media/board/board.css'), 'utf8');
  assert.match(css, /#menu \{[^}]*max-width: 320px/);
  const strings = [...MENU_JS.matchAll(/'([^'\\]*)'/g)].map((m) => m[1]);
  assert.ok(strings.includes('Move '));
});

// ---- 62-20: assignment in the Move to... menu (G-62-5, owner decision 2026-11-03) ------------------------------------------------------------

const assigns = (h: BoardHarness): Array<Record<string, any>> => h.posts.filter((p) => p.type === 'assign' || p.type === 'unassign');

test('tracer: a lead sees Assign to... after the moves and a separator; choosing it posts assign once and shows Choosing a person...', async () => {
  const { h, model } = await ownerBoard();
  const ready = cardOf(model, 'plan:90-01');
  assert.deepEqual(ready.assignActions, ['assign'], 'the owner may put a person on a ready plan');
  open(h, 'plan:90-01');
  // The moves first, exactly as offered, then a separator and the assignment item.
  assert.deepEqual(items(h).map((i) => text(i)), [...ready.moves.map((m) => m.label), 'Assign to...']);
  const kids = Array.from(menu(h).children);
  const at = kids.findIndex((k) => text(k) === 'Assign to...');
  assert.equal(kids[at - 1]!.getAttribute('role'), 'separator', 'a separator comes before the assignment items');

  const assign = items(h).find((i) => text(i) === 'Assign to...')!;
  assign.focus();
  h.press(assign, 'Enter');
  assert.ok(!isOpen(h), 'choosing closes the menu');
  assert.deepEqual(assigns(h), [{ type: 'assign', itemId: 'plan:90-01' }], 'one request, with only the card id');
  assert.deepEqual(moves(h), [], 'no move is posted');
  assert.equal(text(card(h, 'plan:90-01').querySelector('.pending-line')), 'Choosing a person...');
  assert.equal(card(h, 'plan:90-01').getAttribute('aria-busy'), 'true');
});

test('an assignment refusal is drawn on the card and announced once; an empty refusal (a closed list) clears the pending line silently', async () => {
  const { h } = await ownerBoard();
  const reason = 'Lee already changed this card. The board now shows the latest. Nothing was moved.';
  open(h, 'plan:90-01');
  items(h).find((i) => text(i) === 'Assign to...')!.click();
  h.deliver({ type: 'refused', itemId: 'plan:90-01', reason });
  assert.equal(text(card(h, 'plan:90-01').querySelector('.refusal-line')), reason);
  assert.equal(card(h, 'plan:90-01').querySelector('.pending-line'), null);
  h.advance(200);
  assert.deepEqual(h.announcements.filter((a) => a.startsWith("Can't")), [`Can't assign plan 90-01. ${reason}`]);
  assert.equal(h.focused(), moveBtn(h, 'plan:90-01'), 'focus is back on Move to...');

  open(h, 'plan:90-01');
  items(h).find((i) => text(i) === 'Assign to...')!.click();
  assert.equal(text(card(h, 'plan:90-01').querySelector('.pending-line')), 'Choosing a person...');
  const before = h.announcements.length;
  h.deliver({ type: 'refused', itemId: 'plan:90-01', reason: '' });
  h.advance(500);
  assert.equal(card(h, 'plan:90-01').querySelector('.pending-line'), null);
  assert.equal(card(h, 'plan:90-01').querySelector('.refusal-line'), null);
  assert.equal(h.announcements.length, before, 'nothing is announced');
});
