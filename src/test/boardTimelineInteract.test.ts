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
