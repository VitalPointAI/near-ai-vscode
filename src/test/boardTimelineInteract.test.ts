// The board timeline's dots at work (62.1-05, D-06, D-07, D-10, D-13, D-01): the expanded card that springs from a dot with the board's own card face
// and Move to... menu, the hover and focus preview, line emphasis, the one placement function that keeps both on screen and off the Now pill, and
// the keyboard model. Every model comes from the real buildBoardModel and buildTimeline over a signed in-memory log, built for the same viewer, and
// every action must go through the board's existing menu, detail drawer and host messages (T-62.1-11).
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBoardModel } from '../domain/team/board';
import type { BoardModel } from '../domain/team/board';
import { buildTimeline } from '../domain/team/timeline';
import type { ItemState, TeamState } from '../domain/team/types';
import { boardWorld, importedBody } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';
import { createBoardHarness } from './helpers/fakeDom';
import type { BoardHarness, FakeNode } from './helpers/fakeDom';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const uninstall = installVscodeStub(createVscodeStub());
const { BOARD_SCRIPTS } = require('../services/team/boardView') as typeof import('../services/team/boardView');
test.after(() => { uninstall(); });

const NOW = Date.parse('2026-03-05T12:00:00.000Z');
// Every message type the board page already posts (62.1-03): the timeline adds none (T-62.1-07, T-62.1-11).
const KNOWN_POSTS = new Set(['ready', 'visible', 'retry', 'import-plans', 'show-details', 'check-team', 'move', 'detail', 'assign', 'unassign', 'new-item', 'edit-item', 'choose-folders', 'draft', 'e2e-facts', 'e2e-layout']);

type Body = ReturnType<typeof importedBody>;
const milestone = (key: string, title: string, active = false): Body => importedBody({ id: `milestone:${key}`, kind: 'milestone', title, ...(active ? { active: true as const } : {}) });
const phase = (number: string, key: string, title: string): Body => importedBody({ id: `phase:${number}`, kind: 'phase', title, parentId: `milestone:${key}` });
const plan = (id: string, extra: Partial<Body> = {}): Body =>
  importedBody({ id: `plan:${id}`, kind: 'plan', title: `Plan ${id}`, parentId: `phase:${id.slice(0, id.lastIndexOf('-'))}`, scope: [`src/${id}/**`], estimate: { tokens: 4000 }, ...extra });

function setState(state: TeamState, id: string, value: ItemState): void {
  const item = state.items.get(id);
  assert.ok(item, `${id} exists`);
  item.state = value;
}
function modelOf(world: BoardWorld, viewerId: string, canWrite = true): BoardModel {
  const model = buildBoardModel(world.state, { nowMs: NOW, status: { kind: 'live', text: 'Live' }, canWrite, viewerId });
  model.timeline = buildTimeline(world.state, model, { viewerId });
  return model;
}
const offlineOf = (model: BoardModel): BoardModel => ({ ...model, status: { kind: 'offline', text: 'Offline', lastUpdated: '2026-03-05T11:55:00.000Z' } });

// milestone:v1 (active): plan:1-01 is done, plan:1-02 is Ready and assigned to Dana, plan:1-07 waits for 1-02, plan:1-08 waits for 1-01 and is in
// progress for Lee, plan:1-09 waits for a plan that is not on the board and has a long title. Dana added a chore with no estimate that nobody is
// assigned to.
async function cardWorld(): Promise<BoardWorld> {
  const world = await boardWorld();
  const { owner, lead, dev } = world;
  for (const body of [
    milestone('v1', 'Version 1', true), phase('1', 'v1', 'First work'),
    plan('1-01', { state: 'done' }), plan('1-02', { title: 'Plan 1-02 with a title long enough to need more than three lines in a narrow preview, so the full card is the only place it is whole' }),
    plan('1-07', { dependsOn: ['plan:1-02'] }), plan('1-08', { dependsOn: ['plan:1-01'] }), plan('1-09', { dependsOn: ['plan:9-99'] })
  ]) world.accept(owner, 'item.imported', body);
  world.accept(lead, 'item.assigned', { id: 'plan:1-02', memberId: dev.memberId });
  world.accept(lead, 'item.assigned', { id: 'plan:1-08', memberId: lead.memberId });
  world.accept(dev, 'item.created', { id: `item:${'0'.repeat(22)}8D4N`, kind: 'chore', title: 'Tidy the notes', scope: [], requirements: [], mustHaves: [] });
  setState(world.state, 'plan:1-02', 'ready');
  setState(world.state, 'plan:1-08', 'in-progress');
  return world;
}
const CHORE = `item:${'0'.repeat(22)}8D4N`;

function start(options: { width?: number; state?: unknown } = {}): BoardHarness {
  const h = createBoardHarness({ width: 1400, ...options });
  h.load([...BOARD_SCRIPTS]);
  return h;
}
/** Opens the board in the Timeline view with this model. */
function timelineOf(model: BoardModel, options: { width?: number } = {}): BoardHarness {
  const h = start(options);
  h.deliver({ type: 'state', model });
  const radio = h.$('#view-switch button[data-view="timeline"]');
  assert.ok(radio, 'the Timeline radio is drawn');
  radio.click();
  assert.equal(h.root.getAttribute('data-view'), 'timeline');
  return h;
}
/** The same board in Columns, for comparing a dot's card with the kanban card. */
function columnsOf(model: BoardModel): BoardHarness {
  const h = start();
  h.deliver({ type: 'state', model });
  assert.equal(h.root.getAttribute('data-view'), 'columns');
  return h;
}
type Fn = (...args: any[]) => any;
function timelineApi(h: BoardHarness, name: string): Fn {
  const api = h.window.NearAiTimeline as Record<string, unknown> | undefined;
  assert.equal(typeof api?.[name], 'function', `timeline.js exports NearAiTimeline.${name}`);
  return api![name] as Fn;
}
function boardApi(h: BoardHarness, name: string): Fn {
  const api = h.window.NearAiBoard as Record<string, unknown> | undefined;
  assert.equal(typeof api?.[name], 'function', `the board offers ${name}()`);
  return api![name] as Fn;
}
const classes = (node: FakeNode | null): string[] => (node === null ? [] : node.className.split(/\s+/).filter(Boolean));
const visible = (node: FakeNode | null): boolean => { for (let n = node; n !== null && n.nodeType === 1; n = n.parentNode) if (n.hidden) return false; return node !== null; };
const dot = (h: BoardHarness, id: string): FakeNode => { const found = h.$(`button.tl-dot[data-id="${id}"]`); assert.ok(found, `the dot of ${id} is drawn`); return found; };
const card = (h: BoardHarness): FakeNode | null => { const c = h.$('#tl-card'); return c !== null && visible(c) ? c : null; };
const openCard = (h: BoardHarness): FakeNode => { const c = card(h); assert.ok(c, 'the expanded card is open'); return c; };
const isMenuOpen = (h: BoardHarness): boolean => h.$('#menu') !== null && !h.$('#menu')!.hidden;
/** The menu's items in order, with a bar for each separator. */
const menuItems = (h: BoardHarness): string[] => Array.from(h.$('#menu')!.children).map((n) => (n.getAttribute('role') === 'separator' ? '|' : `${n.getAttribute('data-key')}:${n.textContent}`));
/** The shape of a node for comparing two faces: its tag, classes and text, and its children's shapes (icons by tag only). */
function shape(node: FakeNode): unknown {
  if (node.localName === 'svg') return { tag: 'svg', cls: node.getAttribute('class') };
  return { tag: node.localName, cls: node.className, text: node.textContent, kids: Array.from(node.children).map(shape) };
}
/** The facts list of the expanded card as [term, description] pairs. */
function facts(c: FakeNode): Array<[string, string]> {
  const dl = c.querySelector('dl');
  assert.ok(dl, 'the card has its facts list');
  const out: Array<[string, string]> = [];
  for (const n of Array.from(dl.children)) {
    if (n.localName === 'dt') out.push([n.textContent, '']);
    else if (n.localName === 'dd') out[out.length - 1]![1] = n.textContent;
  }
  return out;
}
function onlyKnownPosts(h: BoardHarness): void {
  const types = [...new Set(h.posts.map((p) => String(p.type)))];
  assert.deepEqual(types.filter((t) => !KNOWN_POSTS.has(t)), [], 'no new message type');
}

// ---- Task 1: the tracer --------------------------------------------------------------------------------------------------------------------------

test('tracer: a click on a dot opens its expanded card next to it with the board card face, the timeline facts and the full title, focus on the title', async () => {
  const world = await cardWorld();
  const model = modelOf(world, world.lead.memberId);
  const h = timelineOf(model);
  const kanban = columnsOf(model);
  const tdot = model.timeline!.dots.find((d) => d.cardId === 'plan:1-02')!;
  const c = model.cards.find((x) => x.id === 'plan:1-02')!;

  assert.equal(card(h), null, 'no card is open at first');
  h.click(dot(h, 'plan:1-02'));
  const section = openCard(h);
  assert.equal(section.parentNode!.className, 'tl-canvas', 'the card is inside the canvas, so it moves with its dot');
  assert.equal(section.localName, 'section');
  assert.equal(section.getAttribute('role'), 'dialog');
  assert.equal(section.getAttribute('aria-modal'), 'false');
  assert.equal(section.getAttribute('aria-labelledby'), 'tl-card-title');
  assert.equal(section.getAttribute('data-id'), 'plan:1-02');
  const b = dot(h, 'plan:1-02');
  assert.equal(b.getAttribute('aria-expanded'), 'true');
  assert.equal(b.getAttribute('aria-controls'), 'tl-card');
  assert.ok(classes(b).includes('selected'), 'the open dot has the selected halo');
  const title = h.$('#tl-card-title')!;
  assert.equal(title.localName, 'h2');
  assert.equal(title.getAttribute('tabindex'), '-1');
  assert.equal(h.focused(), title, 'focus is on the card title');
  assert.equal(title.textContent, c.title, 'the whole title');
  assert.ok(title.querySelectorAll('.card-title').length === 0 && !classes(title).includes('card-title'), 'the title is not clamped');
  assert.equal(boardApi(h, 'selected')(), 'plan:1-02', 'the open card is the selected card, so Columns keeps it');

  // The face is the kanban card's own: state row with the ID, and the meta row with the chip, badges, estimate and age.
  const kanbanMain = kanban.$('li.card[data-id="plan:1-02"] .card-main')!;
  for (const part of ['.card-top', '.card-meta']) {
    assert.deepEqual(JSON.parse(JSON.stringify(shape(section.querySelector(part)!))), JSON.parse(JSON.stringify(shape(kanbanMain.querySelector(part)!))), `${part} is the board card's`);
  }
  // The timeline facts: Step, Waits for (Nothing), Needed by (1-07 as a link button); no Finished row on a card that is not done.
  assert.deepEqual(facts(section), [['Step', tdot.stepFact], ['Waits for', 'Nothing'], ['Needed by', tdot.neededByLinks.map((l) => l.label).join('')]]);
  assert.deepEqual(Array.from(section.querySelectorAll('dd button.link')).map((n) => n.textContent), tdot.neededByLinks.map((l) => l.label));
  // Close card and the actions row: exactly Move to... and Open details.
  const close = section.querySelector('button[aria-label="Close card"]');
  assert.ok(close, 'the card has its Close card button');
  assert.equal(close.getAttribute('title'), 'Close card');
  const actions = section.querySelector('.tl-card-actions')!;
  assert.deepEqual(Array.from(actions.children).filter((n) => visible(n)).map((n) => n.textContent), ['Move to...', 'Open details']);
  assert.equal(h.$$('.tl-scroll *').filter((n) => n.draggable || n.getAttribute('draggable') !== null).length, 0, 'nothing on the timeline can be dragged (T-62.1-12)');
  onlyKnownPosts(h);
});

test('D-01: the Finished row shows only on a done card the model gives a date; notes and the waits-for links are in the card, and No estimate is on the face', async () => {
  const world = await cardWorld();
  const model = modelOf(world, world.lead.memberId);
  model.cards.find((x) => x.id === 'plan:1-01')!.finishedText = '3 March 2026';
  const h = timelineOf(model);
  const dots = new Map(model.timeline!.dots.map((d) => [d.cardId, d]));

  h.click(dot(h, 'plan:1-01'));
  assert.deepEqual(facts(openCard(h)).map(([k]) => k), ['Step', 'Waits for', 'Needed by', 'Finished']);
  assert.deepEqual(facts(openCard(h))[3], ['Finished', '3 March 2026']);

  // A done card with no known finish time has no Finished row.
  const bare = modelOf(world, world.lead.memberId);
  const h2 = timelineOf(bare);
  h2.click(dot(h2, 'plan:1-01'));
  assert.ok(!facts(openCard(h2)).some(([k]) => k === 'Finished'), 'no Finished row without a date');

  // 1-07 waits for 1-02: a link button that names it. 1-09 waits for a plan that is not on the board: plain words and the note.
  h.click(dot(h, 'plan:1-07'));
  assert.equal(openCard(h).getAttribute('data-id'), 'plan:1-07', 'a click on another dot switches the card to it');
  assert.equal(dot(h, 'plan:1-01').getAttribute('aria-expanded'), null, 'the old dot is no longer expanded');
  assert.ok(!classes(dot(h, 'plan:1-01')).includes('selected'));
  assert.deepEqual(Array.from(openCard(h).querySelectorAll('dd button.link')).map((n) => n.textContent), dots.get('plan:1-07')!.waitsForLinks.map((l) => l.label));
  h.click(dot(h, 'plan:1-09'));
  const notes = Array.from(openCard(h).querySelectorAll('.tl-card-note')).map((n) => n.textContent);
  assert.deepEqual(notes, dots.get('plan:1-09')!.notes);
  assert.ok(notes.some((n) => n.includes('which is not on the board')), 'the missing dependency note');
  assert.equal(openCard(h).querySelectorAll('dd button.link').length, 0, 'a dependency that is not on the board is not a link');

  // The chore has no estimate: the board face says No estimate.
  h.click(dot(h, CHORE));
  assert.ok(Array.from(openCard(h).querySelectorAll('.card-meta .meta-item')).some((n) => n.textContent === 'No estimate'), 'No estimate on the face');
  onlyKnownPosts(h);
});

test('BOARD-03: Move to... in the card opens the board menu with exactly the kanban card items; Backlog posts one move, and the card and dot show it pending', async () => {
  const world = await cardWorld();
  const model = modelOf(world, world.lead.memberId);
  const kanban = columnsOf(model);
  kanban.click(kanban.$('li.card[data-id="plan:1-02"] .move-btn')!);
  assert.ok(isMenuOpen(kanban));
  const expected = menuItems(kanban);
  assert.ok(expected.includes('|'), 'the kanban menu has its separator before the assignment items');

  const h = timelineOf(model);
  h.click(dot(h, 'plan:1-02'));
  const mv = openCard(h).querySelector('.tl-card-actions .move-btn')!;
  assert.equal(mv.getAttribute('aria-haspopup'), 'menu');
  h.click(mv);
  assert.ok(isMenuOpen(h), 'the board menu opens');
  assert.deepEqual(menuItems(h), expected, 'the same items as the board card');
  assert.equal(mv.getAttribute('aria-expanded'), 'true');
  assert.ok(card(h), 'the card stays open under the menu');
  const hold = h.$('#menu [data-key="hold"]')!;
  h.posts.length = 0;
  h.click(hold);
  assert.deepEqual(h.posts, [{ type: 'move', itemId: 'plan:1-02', target: 'hold' }], 'one existing move request');
  assert.ok(!isMenuOpen(h));
  assert.ok(card(h), 'the card stays open after the choice');
  assert.equal(h.focused(), openCard(h).querySelector('.move-btn'), 'focus is back on Move to...');
  assert.ok(openCard(h).querySelector('.pending-line'), 'the card shows the pending line');
  assert.equal(openCard(h).querySelector('.pending-line')!.textContent, boardApi(h, 'pendingText')('plan:1-02'));
  assert.equal(dot(h, 'plan:1-02').getAttribute('aria-busy'), 'true');
  assert.ok(classes(dot(h, 'plan:1-02')).includes('pending'), 'the dot has the dashed pending outline');
  onlyKnownPosts(h);
});

test('T-62.1-11: an observer gets no Move to... in the card, and offline it is disabled with the board reason, as on a kanban card', async () => {
  const world = await cardWorld();
  const observer = modelOf(world, world.observer.memberId, false);
  const h = timelineOf(observer);
  h.click(dot(h, 'plan:1-02'));
  assert.ok(!visible(openCard(h).querySelector('.move-btn')), 'no Move to... for an observer');
  assert.equal(boardApi(h, 'hasMenu')(observer.cards.find((x) => x.id === 'plan:1-02')), false);
  h.press(dot(h, 'plan:1-02'), 'm');
  assert.ok(!isMenuOpen(h));

  const offline = offlineOf(modelOf(world, world.lead.memberId));
  const kanban = columnsOf(offline);
  const reason = kanban.$('li.card[data-id="plan:1-02"] .move-btn')!.getAttribute('title');
  const o = timelineOf(offline);
  o.click(dot(o, 'plan:1-02'));
  const mv = openCard(o).querySelector('.move-btn')!;
  assert.ok(visible(mv), 'Move to... is shown offline');
  assert.equal(mv.getAttribute('aria-disabled'), 'true');
  assert.equal(mv.getAttribute('title'), reason, 'with the board reason');
  o.click(mv);
  assert.ok(!isMenuOpen(o), 'a disabled Move to... does not open the menu');
  onlyKnownPosts(h);
  onlyKnownPosts(o);
});

test('D-06, D-10: Open details closes the card and opens the drawer, and closing it puts focus on the dot; Escape and Close card return focus to the dot', async () => {
  const world = await cardWorld();
  const model = modelOf(world, world.lead.memberId);
  const h = timelineOf(model);
  h.click(dot(h, 'plan:1-02'));
  const details = Array.from(openCard(h).querySelectorAll('.tl-card-actions button')).find((n) => n.textContent === 'Open details')!;
  h.posts.length = 0;
  h.click(details);
  assert.equal(card(h), null, 'the card closes');
  assert.equal(dot(h, 'plan:1-02').getAttribute('aria-expanded'), null);
  const drawer = h.$('#detail')!;
  assert.ok(!drawer.hidden, 'the detail drawer opens');
  assert.deepEqual(h.posts, [{ type: 'detail', itemId: 'plan:1-02' }]);
  h.click(drawer.querySelector('.detail-close')!);
  assert.ok(drawer.hidden);
  assert.equal(h.focused(), dot(h, 'plan:1-02'), 'closing the drawer puts focus on the dot');

  // Escape in the card closes it and focus returns to the dot.
  h.click(dot(h, 'plan:1-07'));
  assert.equal(h.focused(), h.$('#tl-card-title'));
  h.press(h.$('#tl-card-title')!, 'Escape');
  assert.equal(card(h), null);
  assert.equal(h.focused(), dot(h, 'plan:1-07'), 'Escape returns focus to the dot');
  // Close card does the same.
  h.click(dot(h, 'plan:1-07'));
  h.click(openCard(h).querySelector('button[aria-label="Close card"]')!);
  assert.equal(card(h), null);
  assert.equal(h.focused(), dot(h, 'plan:1-07'), 'Close card returns focus to the dot');
  // Escape with the menu open closes the menu first, and the card stays.
  h.click(dot(h, 'plan:1-02'));
  h.click(openCard(h).querySelector('.move-btn')!);
  assert.ok(isMenuOpen(h));
  h.press(h.focused(), 'Escape');
  assert.ok(!isMenuOpen(h), 'Escape closes the menu');
  assert.ok(card(h), 'and leaves the card open');
  onlyKnownPosts(h);
});

// ---- Task 2: the placement function, the preview, line emphasis, and the card following its dot ----------------------------------------------------

interface Box { left: number; top: number; width: number; height: number }
interface Placed extends Box { side: string; capped: boolean }
const H = { direction: 'horizontal', narrow: false };
const V = { direction: 'vertical', narrow: false };
const VIEW: Box = { left: 0, top: 0, width: 800, height: 600 };
const CARD = { width: 320, height: 200 };
const overlaps = (a: Box, b: Box): boolean => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
const inside = (r: Box, v: Box): boolean => r.left >= v.left && r.top >= v.top && r.left + r.width <= v.left + v.width && r.top + r.height <= v.top + v.height;
let placeHarness: BoardHarness | undefined;
/** NearAiTimeline.place, the one placement function of the preview and the card, called with plain values; the result never covers its dot. */
function place(anchor: Box, size: { width: number; height: number }, view: Box, obstacles: Box[], mode: { direction: string; narrow: boolean }): Placed {
  placeHarness = placeHarness ?? start();
  const fn = timelineApi(placeHarness, 'place');
  const out = JSON.parse(JSON.stringify(fn(...JSON.parse(JSON.stringify([anchor, size, view, obstacles, mode]))))) as Placed;
  assert.ok(!overlaps(out, anchor), `never over its own dot: ${JSON.stringify(out)}`);
  return out;
}

test('UI-SPEC Placement: horizontal tries below, above, right, left, with below and above at the dot left edge and right and left at its top, shifted to stay inside', () => {
  // A dot with room below: below, left edges together, 8 px under the dot.
  assert.deepEqual(place({ left: 100, top: 100, width: 52, height: 28 }, CARD, VIEW, [], H), { left: 100, top: 136, width: 320, height: 200, side: 'below', capped: false });
  // At the bottom edge: above.
  assert.deepEqual(place({ left: 100, top: 560, width: 52, height: 28 }, CARD, VIEW, [], H), { left: 100, top: 352, width: 320, height: 200, side: 'above', capped: false });
  // At the right edge: still below, shifted left to stay inside.
  assert.deepEqual(place({ left: 760, top: 100, width: 28, height: 28 }, CARD, VIEW, [], H), { left: 480, top: 136, width: 320, height: 200, side: 'below', capped: false });
  // At the left and top edges: below, flush with the view.
  assert.deepEqual(place({ left: 0, top: 0, width: 28, height: 28 }, CARD, VIEW, [], H), { left: 0, top: 36, width: 320, height: 200, side: 'below', capped: false });
  // A tall card with no room below or above: right of the dot, its top shifted up to stay inside; at the right edge, left of the dot.
  const TALL = { width: 320, height: 400 };
  assert.deepEqual(place({ left: 100, top: 280, width: 52, height: 28 }, TALL, VIEW, [], H), { left: 160, top: 200, width: 320, height: 400, side: 'right', capped: false });
  assert.deepEqual(place({ left: 700, top: 280, width: 28, height: 28 }, TALL, VIEW, [], H), { left: 372, top: 200, width: 320, height: 400, side: 'left', capped: false });
});

test('UI-SPEC Placement: vertical tries right, left, below, above; under 520 px only below and above at the full view width', () => {
  assert.deepEqual(place({ left: 100, top: 100, width: 52, height: 28 }, CARD, VIEW, [], V), { left: 160, top: 100, width: 320, height: 200, side: 'right', capped: false });
  // At the right edge: left of the dot.
  assert.deepEqual(place({ left: 600, top: 100, width: 52, height: 28 }, CARD, VIEW, [], V), { left: 272, top: 100, width: 320, height: 200, side: 'left', capped: false });
  // At the bottom edge: right of the dot, shifted up.
  assert.deepEqual(place({ left: 100, top: 560, width: 52, height: 28 }, CARD, VIEW, [], V), { left: 160, top: 400, width: 320, height: 200, side: 'right', capped: false });
  // At the top edge in a view too narrow for either side: below, shifted left to stay inside.
  assert.deepEqual(place({ left: 300, top: 0, width: 52, height: 28 }, CARD, { left: 0, top: 0, width: 500, height: 600 }, [], V), { left: 180, top: 36, width: 320, height: 200, side: 'below', capped: false });
  // At the left edge: right of the dot.
  assert.deepEqual(place({ left: 0, top: 300, width: 52, height: 28 }, CARD, VIEW, [], V), { left: 60, top: 300, width: 320, height: 200, side: 'right', capped: false });
  // Narrow: below at the view width, else above.
  const NARROW_VIEW = { left: 8, top: 8, width: 464, height: 584 };
  assert.deepEqual(place({ left: 100, top: 100, width: 52, height: 28 }, CARD, NARROW_VIEW, [], { direction: 'vertical', narrow: true }), { left: 8, top: 136, width: 464, height: 200, side: 'below', capped: false });
  assert.deepEqual(place({ left: 100, top: 520, width: 52, height: 28 }, CARD, NARROW_VIEW, [], { direction: 'vertical', narrow: true }), { left: 8, top: 312, width: 464, height: 200, side: 'above', capped: false });
});

test('D-13 amendment: the Now pill is never covered; with no whole fit a side with 160 px of room is capped to it; a view too small takes the most room and still misses the dot', () => {
  // The Now pill right under the dot: below would cover it, so above.
  const pill = { left: 100, top: 340, width: 320, height: 40 };
  const above = place({ left: 100, top: 300, width: 52, height: 28 }, CARD, VIEW, [pill], H);
  assert.equal(above.side, 'above');
  assert.ok(!overlaps(above, pill) && inside(above, VIEW));
  // The pill right after the dot: right is covered and left has no room, so a capped below with 314 px of room (at least 160) wins.
  const after = { left: 200, top: 120, width: 320, height: 40 };
  const capped = place({ left: 100, top: 150, width: 52, height: 28 }, { width: 320, height: 400 }, { left: 0, top: 0, width: 800, height: 500 }, [after], H);
  assert.deepEqual(capped, { left: 100, top: 186, width: 320, height: 314, side: 'below', capped: true });
  assert.ok(!overlaps(capped, after));
  // No side has 160 px: below is cut to 4 px by the pill, above has 142 px and the view is too narrow for right or left, so the side with the most
  // room that covers nothing wins, capped to it, and the pill stays uncovered.
  const under = { left: 100, top: 190, width: 320, height: 40 };
  const blocked = place({ left: 100, top: 150, width: 52, height: 28 }, { width: 320, height: 300 }, { left: 0, top: 0, width: 440, height: 400 }, [under], H);
  assert.deepEqual(blocked, { left: 100, top: 0, width: 320, height: 142, side: 'above', capped: true });
  assert.ok(!overlaps(blocked, under));
  // A view too small for any side: the side with the most room, capped (to at least a title row), never over the dot.
  const tiny = place({ left: 80, top: 40, width: 28, height: 28 }, CARD, { left: 0, top: 0, width: 200, height: 100 }, [], H);
  assert.equal(tiny.side, 'above');
  assert.equal(tiny.capped, true);
  assert.ok(tiny.height <= 100 && tiny.width <= 200);
});

const NOT_FINISHED = new Set(['backlog', 'ready', 'claimed', 'in-progress', 'in-review', 'integrating']);
const pathsOf = (h: BoardHarness): FakeNode[] => h.$$('svg.tl-lines path.tl-line');
const emphasised = (h: BoardHarness): string[] => pathsOf(h).filter((p) => classes(p).includes('emphasis')).map((p) => `${p.getAttribute('data-from')}>${p.getAttribute('data-to')}`).sort();
const linesOf = (model: BoardModel, id: string): string[] => model.timeline!.edges.filter((e) => e.from === id || e.to === id).map((e) => `${e.from}>${e.to}`).sort();
const preview = (h: BoardHarness): FakeNode | null => { const p = h.$('#tl-preview'); return p !== null && visible(p) ? p : null; };
const px = (node: FakeNode, name: string): number => Number(node.style.getPropertyValue(name).replace('px', ''));

test('D-06: hover opens the preview after 300 ms, with the state, ID, clamped title, badges, Nobody yet, the step and waits lines and the pointer hint; it closes 100 ms after leaving', async () => {
  const world = await cardWorld();
  const model = modelOf(world, world.lead.memberId);
  const h = timelineOf(model);
  const tdot = model.timeline!.dots.find((d) => d.cardId === 'plan:1-09')!;
  const c = model.cards.find((x) => x.id === 'plan:1-09')!;
  const b = dot(h, 'plan:1-09');

  h.fire(b, 'pointerenter');
  h.advance(299);
  assert.equal(preview(h), null, 'nothing before 300 ms');
  h.advance(1);
  const p = preview(h);
  assert.ok(p, 'the preview opens after 300 ms');
  assert.equal(p.parentNode!.className, 'tl-canvas');
  assert.equal(p.getAttribute('aria-hidden'), 'true');
  assert.equal(p.getAttribute('data-id'), 'plan:1-09');
  assert.equal(p.querySelector('.card-top')!.textContent, c.stateLabel + c.displayId, 'the state word and the display ID');
  assert.equal(p.querySelector('.tl-preview-title')!.textContent, c.title);
  assert.equal(p.querySelector('.tl-preview-who')!.textContent, 'Nobody yet', 'nobody is assigned: Nobody yet');
  assert.equal(tdot.whoText, 'Nobody yet');
  assert.equal(p.querySelector('.tl-preview-step')!.textContent, tdot.stepText + tdot.waitsText);
  assert.equal(p.querySelector('.tl-preview-hint')!.textContent, 'Click to open the card.');
  assert.equal(h.focused() === b, false, 'the preview never takes focus');
  // Placed by place() 8 px from the dot: below it in horizontal, the dot's left edge, never over it.
  const box = { left: px(b, 'left'), top: px(b, 'top'), width: px(b, 'width'), height: px(b, 'height') };
  const band = b.closest('li.tl-milestone')!;
  const at = { left: px(p, 'left') - px(band, 'left'), top: px(p, 'top') - px(band, 'top') };
  assert.equal(p.getAttribute('data-side'), 'below');
  assert.equal(at.left, box.left, 'left edges together');
  assert.equal(at.top, box.top + box.height + 8, '8 px under the dot');
  assert.equal(px(p, 'width'), 256);

  h.fire(b, 'pointerleave');
  h.advance(99);
  assert.ok(preview(h), 'still open at 99 ms');
  h.advance(1);
  assert.equal(preview(h), null, 'closed 100 ms after the pointer left');
  // Another dot within 600 ms of the close opens at once.
  h.advance(300);
  h.fire(dot(h, 'plan:1-07'), 'pointerenter');
  assert.equal(preview(h)?.getAttribute('data-id'), 'plan:1-07', 'no delay within 600 ms of a close');
  h.fire(dot(h, 'plan:1-07'), 'pointerleave');
  h.advance(100 + 600);
  h.fire(dot(h, 'plan:1-02'), 'pointerenter');
  assert.equal(preview(h), null, 'after 600 ms the delay is back');
  h.advance(300);
  assert.equal(preview(h)?.getAttribute('data-id'), 'plan:1-02');
  // A card's badges come from the board face: 1-02 has none, a blocked card shows Blocked.
  assert.equal(preview(h)!.querySelectorAll('.badge').length, 0);
  // Opening the card closes the preview.
  h.click(dot(h, 'plan:1-02'));
  assert.equal(preview(h), null, 'the card replaces the preview');
});

test('D-06, D-10: keyboard focus opens the preview at once with the keyboard hint; blur and Escape close it at once', async () => {
  const world = await cardWorld();
  const model = modelOf(world, world.lead.memberId);
  world.accept(world.owner, 'item.blocked', { id: 'plan:1-07', reason: 'Waiting on the design' });
  const blocked = modelOf(world, world.lead.memberId);
  const h = timelineOf(blocked);
  void model;
  const b = dot(h, 'plan:1-07');
  b.focus();
  const p = preview(h);
  assert.ok(p, 'focus opens it at once');
  assert.equal(p.querySelector('.tl-preview-hint')!.textContent, 'Press Enter to open the card.');
  assert.deepEqual(Array.from(p.querySelectorAll('.badge')).map((n) => n.textContent), ['Blocked'], 'the board face badges');
  assert.equal(h.focused(), b, 'focus stays on the dot');
  b.blur();
  assert.equal(preview(h), null, 'blur closes it at once');
  b.focus();
  assert.ok(preview(h));
  h.press(b, 'Escape');
  assert.equal(preview(h), null, 'Escape closes it at once');
  assert.equal(h.focused(), b);
});

test('D-07: hover, focus and an open card emphasise exactly that dot lines in and out, waiting lines stay dashed, and the emphasis survives a redraw', async () => {
  const world = await cardWorld();
  const model = modelOf(world, world.lead.memberId);
  const h = timelineOf(model);
  assert.deepEqual(emphasised(h), [], 'every line at rest');
  h.fire(dot(h, 'plan:1-02'), 'pointerenter');
  assert.deepEqual(emphasised(h), linesOf(model, 'plan:1-02'), 'hover emphasises at once');
  const cardOf = new Map(model.cards.map((x) => [x.id, x]));
  for (const p of pathsOf(h)) {
    const from = cardOf.get(p.getAttribute('data-from')!)!;
    assert.equal(classes(p).includes('waiting'), NOT_FINISHED.has(from.column), 'a line from an unfinished card is a waiting (dashed) line');
  }
  h.fire(dot(h, 'plan:1-02'), 'pointerleave');
  assert.deepEqual(emphasised(h), []);
  dot(h, 'plan:1-08').focus();
  assert.deepEqual(emphasised(h), linesOf(model, 'plan:1-08'), 'focus emphasises');
  h.click(dot(h, 'plan:1-07'));
  assert.deepEqual(emphasised(h), linesOf(model, 'plan:1-07'), 'the open card emphasises');
  h.deliver({ type: 'state', model: modelOf(world, world.lead.memberId) });
  assert.deepEqual(emphasised(h), linesOf(model, 'plan:1-07'), 'after a redraw too');
});

test('D-06: the card follows its dot when a live update moves it and when the width changes; a click away closes it, a click on another dot switches it', async () => {
  const world = await cardWorld();
  const h = timelineOf(modelOf(world, world.lead.memberId));
  h.click(dot(h, 'plan:1-07'));
  const c = openCard(h);
  const where = (): { left: number; top: number } => ({ left: px(c, 'left'), top: px(c, 'top') });
  const dotAt = (id: string): { left: number; top: number; height: number } => {
    const b = dot(h, id);
    const band = b.closest('li.tl-milestone')!;
    return { left: px(b, 'left') + px(band, 'left'), top: px(b, 'top') + px(band, 'top'), height: px(b, 'height') };
  };
  const before = dotAt('plan:1-07');
  assert.equal(c.getAttribute('data-side'), 'below');
  assert.deepEqual(where(), { left: before.left, top: before.top + before.height + 8 });
  // 1-07 no longer waits for 1-02: it moves to the first step, and the card follows it.
  world.state.items.get('plan:1-07')!.dependsOn = [];
  h.deliver({ type: 'state', model: modelOf(world, world.lead.memberId) });
  const after = dotAt('plan:1-07');
  assert.notDeepEqual(after, before, 'the dot moved');
  assert.ok(card(h), 'the card stays open');
  assert.deepEqual(where(), { left: after.left, top: after.top + after.height + 8 }, 'and is placed next to the new place');

  // A narrower window: the chore's card (in the band of cards added on the board) is shifted left to stay inside.
  h.click(dot(h, CHORE));
  const chore = dotAt(CHORE);
  assert.equal(px(c, 'left'), chore.left, 'at 1400 px the left edges are together');
  h.setWidth(560);
  assert.equal(px(c, 'left'), 560 - 8 - 320, 'at 560 px it is shifted left, 8 px from the edge');

  // A click on empty canvas closes it; a click on the milestone header too.
  h.click(h.$('.tl-canvas')!);
  assert.equal(card(h), null, 'a click away closes the card');
  h.click(dot(h, 'plan:1-02'));
  h.click(h.$('.tl-ms-head')!);
  assert.equal(card(h), null);
  // A click on another dot switches the card to it.
  h.click(dot(h, 'plan:1-02'));
  h.click(dot(h, 'plan:1-08'));
  assert.equal(openCard(h).getAttribute('data-id'), 'plan:1-08');
  assert.equal(h.focused(), h.$('#tl-card-title'), 'focus is in the new card');
  assert.deepEqual(h.$$('button.tl-dot[aria-expanded="true"]').map((n) => n.getAttribute('data-id')), ['plan:1-08'], 'one dot is expanded');
});

test('a refusal while the card is open shows in the card; after it closes the dot keeps the error pip until the refusal is dismissed or the card changes', async () => {
  const world = await cardWorld();
  const h = timelineOf(modelOf(world, world.lead.memberId));
  const reason = 'Someone else moved this card first. Nothing was moved.';
  const pipOf = (id: string): FakeNode | null => dot(h, id).querySelector('circle.tl-pip-error');
  const refuse = (): void => {
    h.click(dot(h, 'plan:1-02'));
    h.click(openCard(h).querySelector('.move-btn')!);
    h.click(h.$('#menu [data-key="hold"]')!);
    h.deliver({ type: 'refused', itemId: 'plan:1-02', reason });
  };
  refuse();
  assert.equal(openCard(h).querySelector('.refusal-line')!.textContent, reason, 'the refusal shows in the card');
  assert.equal(dot(h, 'plan:1-02').getAttribute('aria-busy'), null, 'no longer pending');
  assert.ok(classes(dot(h, 'plan:1-02')).includes('refused'));
  h.press(h.focused(), 'Escape');
  assert.equal(card(h), null);
  assert.ok(classes(dot(h, 'plan:1-02')).includes('refused'), 'the dot keeps the refusal after the card closes');
  assert.ok(pipOf('plan:1-02'), 'with the error pip on the mark');
  // Dismissing it in the card clears it.
  h.click(dot(h, 'plan:1-02'));
  h.click(openCard(h).querySelector('.dismiss')!);
  assert.equal(openCard(h).querySelector('.refusal-line'), null);
  assert.ok(!classes(dot(h, 'plan:1-02')).includes('refused'));
  assert.equal(pipOf('plan:1-02'), null);
  // A change to the card's data clears it too.
  h.press(h.$('#tl-card-title')!, 'Escape');
  refuse();
  h.press(h.focused(), 'Escape');
  assert.ok(pipOf('plan:1-02'));
  world.accept(world.lead, 'item.assigned', { id: 'plan:1-02', memberId: world.lead.memberId });
  h.deliver({ type: 'state', model: modelOf(world, world.lead.memberId) });
  assert.ok(!classes(dot(h, 'plan:1-02')).includes('refused'), 'the card changed: the refusal is gone');
  assert.equal(pipOf('plan:1-02'), null);
});

test('a Waits for link moves focus to that dot and opens its card', async () => {
  const world = await cardWorld();
  const h = timelineOf(modelOf(world, world.lead.memberId));
  h.click(dot(h, 'plan:1-07'));
  const link = openCard(h).querySelector('dd button.link')!;
  h.click(link);
  assert.equal(openCard(h).getAttribute('data-id'), 'plan:1-02', 'the card switches to the dependency');
  assert.equal(h.focused(), dot(h, 'plan:1-02'), 'focus is on its dot');
  assert.equal(dot(h, 'plan:1-02').getAttribute('aria-expanded'), 'true');
  assert.equal(preview(h), null, 'the open card is not previewed');
  onlyKnownPosts(h);
});
