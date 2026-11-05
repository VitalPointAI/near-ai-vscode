// The board's Timeline view in the page (62.1-03, D-04, TD-2): the View switch, the Direction switch, the saved choices at version 3, the forced vertical
// drawing under 520 px, and the screen reader structure timeline.js draws from the host's model (62.1-UI-SPEC "Screen Reader Structure"). Every model
// comes from the real buildBoardModel and buildTimeline over a signed in-memory log, built for the same viewer, so the page and the model cannot drift.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBoardModel } from '../domain/team/board';
import type { BoardModel } from '../domain/team/board';
import { buildTimeline } from '../domain/team/timeline';
import { boardWorld, importedBody, seedStandardBoard } from './helpers/teamBoardWorld';
import type { BoardWorld } from './helpers/teamBoardWorld';
import { createBoardHarness } from './helpers/fakeDom';
import type { BoardHarness, FakeNode } from './helpers/fakeDom';
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';

const uninstall = installVscodeStub(createVscodeStub());
const { BOARD_SCRIPTS } = require('../services/team/boardView') as typeof import('../services/team/boardView');
test.after(() => { uninstall(); });

const NOW = Date.parse('2026-03-05T12:00:00.000Z');
// Every message type the board's page posted before this plan (board.js, menu.js, drag.js, detail.js, form.js and the e2e probe). The timeline adds
// none (T-62.1-07): a dot, a switch or a list never asks the host for anything new.
const KNOWN_POSTS = new Set(['ready', 'visible', 'retry', 'import-plans', 'show-details', 'check-team', 'move', 'detail', 'assign', 'unassign', 'new-item', 'edit-item', 'choose-folders', 'draft', 'e2e-facts', 'e2e-layout']);

function modelOf(world: BoardWorld, viewerId: string | undefined): BoardModel {
  const model = buildBoardModel(world.state, { nowMs: NOW, status: { kind: 'live', text: 'Live' }, canWrite: viewerId !== undefined, ...(viewerId === undefined ? {} : { viewerId }) });
  model.timeline = buildTimeline(world.state, model, viewerId === undefined ? {} : { viewerId });
  return model;
}

// The standard board (phase:90 with plan:90-02 waiting for plan:90-01, the planless phase:91, a chore added on the board) plus plan:90-03, which
// also waits for plan:90-01 and so runs in parallel with plan:90-02.
async function chainBoard(): Promise<BoardWorld> {
  const world = await boardWorld();
  seedStandardBoard(world);
  world.accept(world.owner, 'item.imported', importedBody({ id: 'plan:90-03', kind: 'plan', title: 'Gamma slice', parentId: 'phase:90', dependsOn: ['plan:90-01'], scope: ['src/c/**'], estimate: { tokens: 8000 } }));
  return world;
}

function start(options: { width?: number; state?: unknown } = {}): BoardHarness {
  const h = createBoardHarness({ width: 1400, ...options });
  h.load([...BOARD_SCRIPTS]);
  return h;
}

const viewRadio = (h: BoardHarness, view: string): FakeNode => {
  const found = h.$(`#view-switch button[data-view="${view}"]`);
  assert.ok(found, `the ${view} radio is drawn`);
  return found;
};
const children = (node: FakeNode): FakeNode[] => Array.from(node.children);
const dotIds = (scope: FakeNode): string[] => Array.from(scope.querySelectorAll('button.tl-dot')).map((dot) => dot.getAttribute('data-id') ?? '');

// ---- Task 1: the tracer -------------------------------------------------------------------------------------------------------------------------

test('tracer: a person chooses Timeline and the board shows the ordered list of milestones, phases and dots from the model, then Columns brings the kanban back', async () => {
  const world = await chainBoard();
  const model = modelOf(world, world.owner.memberId);
  const timeline = model.timeline!;
  const h = start();
  h.deliver({ type: 'state', model });

  // D-04, TD-2: the View switch is the first control of toolbar row 2, Columns chosen for a person who never chose.
  const row2 = h.$('#toolbar .controls')!;
  assert.equal(row2.firstElementChild?.id, 'view-switch', 'the View switch is the first control of row 2');
  const sw = h.$('#view-switch')!;
  assert.ok(sw.className.split(' ').includes('segmented'));
  assert.equal(sw.getAttribute('role'), 'radiogroup');
  assert.equal(sw.getAttribute('aria-label'), 'View');
  const radios = Array.from(sw.querySelectorAll('button[role="radio"]'));
  assert.deepEqual(radios.map((r) => r.getAttribute('data-view')), ['columns', 'timeline']);
  assert.deepEqual(radios.map((r) => r.textContent), ['Columns', 'Timeline']);
  assert.deepEqual(radios.map((r) => r.getAttribute('aria-checked')), ['true', 'false']);
  assert.equal(h.root.getAttribute('data-view'), 'columns');
  assert.ok(h.$('.board-scroll'), 'the kanban is drawn');

  // A card selected in Columns.
  h.$('.card[data-id="plan:90-02"] .card-main')!.click();
  assert.ok(h.$('.card[data-id="plan:90-02"]')!.className.split(' ').includes('selected'));

  h.advance(1000);
  h.announcements.length = 0;
  viewRadio(h, 'timeline').click();
  assert.equal(h.root.getAttribute('data-view'), 'timeline');
  assert.deepEqual(radios.map((r) => r.getAttribute('aria-checked')), ['false', 'true']);
  assert.equal(h.$('.board-scroll'), null, 'the kanban is not on the page in the Timeline view');
  const scroll = h.$('div.tl-scroll')!;
  assert.ok(scroll, 'the timeline scroller is drawn');
  assert.equal(scroll.getAttribute('role'), 'region');
  assert.equal(scroll.getAttribute('aria-label'), 'Team Board timeline');
  assert.ok(h.$('#board')!.contains(scroll), 'the timeline is in the board region, under the shared toolbar');
  const list = scroll.querySelector('ol.tl-milestones')!;
  assert.equal(list.getAttribute('aria-label'), 'Milestones');
  const bands = children(list);
  assert.deepEqual(bands.map((li) => li.getAttribute('data-milestone')), timeline.milestones.map((m) => m.id), 'one list entry per milestone, in the timeline order');
  assert.ok(bands.every((li) => li.localName === 'li' && li.className.split(' ').includes('tl-milestone')));
  for (const [index, band] of timeline.milestones.entries()) {
    const li = bands[index]!;
    assert.equal(li.querySelector('h2')!.textContent, band.heading, `${band.id} names itself with the model's heading`);
    const phases = li.querySelector('ol.tl-phases')!;
    assert.equal(phases.getAttribute('aria-label'), `Phases in ${band.title}`);
    for (const phaseLi of children(phases)) {
      assert.ok(phaseLi.className.split(' ').includes('tl-phase'));
      assert.ok(phaseLi.getAttribute('data-phase') !== null, 'every phase entry names its phase');
      const [h3, dots] = children(phaseLi);
      assert.equal(h3!.localName, 'h3');
      // 62.1-04: the h3 keeps the full heading for screen readers (tl-phase-head); the label the eye reads is the separate .tl-phase-label.
      assert.ok(h3!.className.split(' ').includes('tl-phase-head'));
      assert.equal(dots!.localName, 'ol');
      assert.ok(dots!.className.split(' ').includes('tl-dots'));
      const phaseId = phaseLi.getAttribute('data-phase');
      const phase = band.phases.find((p) => p.id === phaseId);
      if (phase) {
        assert.equal(h3!.textContent, phase.heading, `${phaseId} heading`);
        assert.equal(dots!.getAttribute('aria-label'), `Cards in Phase ${phase.number}, in order`);
      }
      // Inside a phase the dots follow the sequence: step, then slot.
      const expected = timeline.dots.filter((d) => d.milestoneId === band.id && (phase ? d.phaseId === phase.id : !band.phases.some((p) => p.id === d.phaseId))).map((d) => d.cardId);
      assert.deepEqual(dotIds(dots!), expected, `${band.id} ${phaseId} lists its dots in step then slot order`);
    }
  }
  // Every dot is drawn once, with its place and state, and its accessible name is the model's.
  assert.deepEqual([...dotIds(scroll)].sort(), timeline.dots.map((d) => d.cardId).sort(), 'every card is one dot');
  for (const dot of timeline.dots) {
    const button = h.$(`button.tl-dot[data-id="${dot.cardId}"]`)!;
    const card = model.cards.find((c) => c.id === dot.cardId)!;
    assert.equal(button.getAttribute('data-step'), String(dot.step));
    assert.equal(button.getAttribute('data-slot'), String(dot.slot));
    assert.equal(button.getAttribute('data-state'), card.blocked ? 'blocked' : card.held ? 'held' : card.column);
    assert.equal(button.getAttribute('aria-label'), dot.label);
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(button.closest('li')!.parentNode!.className, 'tl-dots');
  }
  // The chain and the parallel plan: plan:90-01 at step 0, plan:90-02 and plan:90-03 together at step 1.
  assert.deepEqual(['plan:90-01', 'plan:90-02', 'plan:90-03'].map((id) => h.$(`.tl-dot[data-id="${id}"]`)!.getAttribute('data-step')), ['0', '1', '1']);
  assert.deepEqual(['plan:90-02', 'plan:90-03'].map((id) => h.$(`.tl-dot[data-id="${id}"]`)!.getAttribute('data-slot')), ['0', '1']);
  assert.equal(h.$('.tl-dot[data-id="plan:90-02"]')!.getAttribute('aria-current'), 'true', 'the card selected in Columns is the current dot');
  h.advance(200);
  assert.ok(h.announcements.includes('Showing the timeline.'), `announced: ${h.announcements.join(' | ')}`);

  // T-62.1-12, UI-SPEC "Dots": nothing on the timeline can be dragged.
  assert.equal(h.$$('.tl-dot').filter((d) => d.getAttribute('draggable') !== null).length, 0, 'no dot has a draggable attribute');
  assert.equal(h.$$('.tl-scroll *').filter((n) => n.draggable).length, 0);

  h.announcements.length = 0;
  viewRadio(h, 'columns').click();
  assert.equal(h.root.getAttribute('data-view'), 'columns');
  assert.equal(h.$('.tl-scroll'), null, 'the timeline leaves the page');
  assert.ok(h.$('.board-scroll'), 'the kanban is back');
  assert.ok(h.$('.card[data-id="plan:90-02"]')!.className.split(' ').includes('selected'), 'the selected card stays selected');
  h.advance(200);
  assert.ok(h.announcements.includes('Showing columns.'), `announced: ${h.announcements.join(' | ')}`);

  // T-62.1-07: every message the page posted is one the board already posted.
  const types = [...new Set(h.posts.map((p) => String(p.type)))];
  assert.deepEqual(types.filter((t) => !KNOWN_POSTS.has(t)), [], 'no new message type');
});

test('the View switch moves with the arrow keys like Group by, and a model with no timeline still shows the region without throwing', async () => {
  const world = await chainBoard();
  const model = modelOf(world, world.owner.memberId);
  const h = start();
  h.deliver({ type: 'state', model });
  const columns = viewRadio(h, 'columns');
  columns.focus();
  h.press(columns, 'ArrowRight');
  assert.equal(h.root.getAttribute('data-view'), 'timeline');
  assert.equal(h.focused(), viewRadio(h, 'timeline'), 'focus follows the chosen option');
  assert.equal(viewRadio(h, 'timeline').getAttribute('tabindex'), '0');
  assert.equal(viewRadio(h, 'columns').getAttribute('tabindex'), '-1');
  h.press(viewRadio(h, 'timeline'), 'ArrowLeft');
  assert.equal(h.root.getAttribute('data-view'), 'columns');

  viewRadio(h, 'timeline').click();
  const bare = JSON.parse(JSON.stringify(model)) as BoardModel;
  delete bare.timeline;
  h.deliver({ type: 'state', model: bare });
  assert.ok(h.$('.tl-scroll'), 'the region stays');
  assert.equal(h.$$('.tl-dot').length, 0, 'no dots without a timeline');
});

// ---- Task 2: saved choices at version 3, the Direction switch, and the vertical drawing under 520 px ----------------------------------------------

// A new item's unsent draft in the shape form.js keeps (it drops any other shape when it loads).
const draftOf = (title: string): Record<string, unknown> => ({ mode: 'new', values: { type: 'chore', title, description: '', files: '', estimate: '' } });
const DEFAULTS = { direction: 'horizontal', zoom: 100, legendOpen: false, shown: {}, scroll: { horizontal: { x: 0, y: 0 }, vertical: { x: 0, y: 0 } } };
const saved = (h: BoardHarness): Record<string, any> => h.state as Record<string, any>;
/** The board's api for the timeline scripts (62.1-03 interfaces): each name must be a function before it is called. */
const boardApi = (h: BoardHarness, ...names: string[]): Record<string, any> => {
  const api = h.window.NearAiBoard as Record<string, any>;
  for (const name of names) assert.equal(typeof api[name], 'function', `the board offers ${name}()`);
  return api;
};
const dirRadio = (h: BoardHarness, direction: string): FakeNode => {
  const found = h.$(`#direction-switch button[data-direction="${direction}"]`);
  assert.ok(found, `the ${direction} radio is drawn`);
  return found;
};
/** True when the node and every ancestor are shown. */
const visible = (node: FakeNode | null): boolean => { for (let n = node; n !== null && n.nodeType === 1; n = n.parentNode) if (n.hidden) return false; return node !== null; };

test('TD-18: a version 2 state keeps every choice, opens in Columns with the timeline defaults, and the next save is version 3 with all of them', async () => {
  const world = await chainBoard();
  const model = modelOf(world, world.owner.memberId);
  const filters = { mine: false, ready: true, blocked: false, requirement: 'BOARD-01', phase: '' };
  const v2 = {
    version: 2, groupBy: 'phase', filters, collapsedColumns: { done: false, backlog: true }, collapsedLanes: { 'phase:phase:91': false }, openGroups: { done: true },
    selected: 'plan:90-01', milestone: 'all', filtersOpen: true, draft: draftOf('Half written')
  };
  const h = start({ state: v2 });
  h.deliver({ type: 'state', model });
  assert.equal(h.root.getAttribute('data-view'), 'columns', 'a version 2 state opens in Columns');
  assert.deepEqual(JSON.parse(JSON.stringify(boardApi(h, 'uiState').uiState())), DEFAULTS, 'the timeline starts at its defaults');
  const s = saved(h);
  assert.equal(s.version, 3);
  for (const key of ['groupBy', 'filters', 'collapsedColumns', 'collapsedLanes', 'openGroups', 'selected', 'milestone', 'filtersOpen', 'draft'] as const) {
    assert.deepEqual(s[key], (v2 as Record<string, unknown>)[key], `${key} is kept`);
  }
  assert.equal(s.view, 'columns');
  assert.deepEqual(s.timeline, DEFAULTS);
  // The kept choices still act: grouped by phase, the Ready filter on, Backlog folded.
  assert.equal(h.$('.group-by button[aria-checked="true"]')!.textContent, 'Phase');
  assert.equal(h.$('.column[data-column="backlog"] .col-btn')!.getAttribute('aria-expanded'), 'false');
  // The next choice is saved at version 3 with every field.
  viewRadio(h, 'timeline').click();
  assert.equal(saved(h).version, 3);
  assert.equal(saved(h).view, 'timeline');
  assert.equal(saved(h).groupBy, 'phase');
  assert.deepEqual(saved(h).draft, draftOf('Half written'));
  const again = start({ state: h.state });
  again.deliver({ type: 'state', model });
  assert.equal(again.root.getAttribute('data-view'), 'timeline', 'the view is remembered');
});

test('an unversioned state still follows the 62-21 rule: only the grouping, milestone, selection, filters toggle and draft are kept', async () => {
  const world = await chainBoard();
  const model = modelOf(world, world.owner.memberId);
  const older = { groupBy: 'phase', milestone: 'all', selected: 'plan:90-01', filtersOpen: true, draft: draftOf('Kept'), filters: { mine: true }, collapsedColumns: { backlog: true }, view: 'timeline' };
  const h = start({ state: older });
  h.deliver({ type: 'state', model });
  const s = saved(h);
  assert.equal(s.version, 3);
  assert.deepEqual([s.groupBy, s.milestone, s.selected, s.filtersOpen, s.draft], ['phase', 'all', 'plan:90-01', true, draftOf('Kept')]);
  assert.equal(s.filters.mine, false, 'the old filters are dropped');
  assert.deepEqual(s.collapsedColumns, {}, 'the old folds are dropped');
  assert.equal(s.view, 'columns', 'a view saved without a version is dropped too');
  assert.deepEqual(s.timeline, DEFAULTS);
});

test('T-62.1-08: a version 3 state with values off the allowed lists loads the default for each bad value and keeps the good ones', async () => {
  const world = await chainBoard();
  const model = modelOf(world, world.owner.memberId);
  const shown = JSON.parse('{"x": "yes", "milestone:v0.9.0": true, "board": false, "__proto__": true, "constructor": true}') as Record<string, unknown>;
  const hostile = {
    version: 3, groupBy: 'member', view: 'graph',
    timeline: { direction: 'diagonal', zoom: 300, legendOpen: true, shown, scroll: { horizontal: { x: -5, y: 'a' }, vertical: { x: 120, y: 48.5 } } }
  };
  const h = start({ state: hostile });
  h.deliver({ type: 'state', model });
  assert.equal(h.root.getAttribute('data-view'), 'columns', 'an unknown view falls back to Columns');
  const ui = JSON.parse(JSON.stringify(boardApi(h, 'uiState').uiState())) as Record<string, any>;
  assert.equal(ui.direction, 'horizontal');
  assert.equal(ui.zoom, 100);
  assert.equal(ui.legendOpen, true, 'a good value is kept');
  assert.deepEqual(ui.shown, { 'milestone:v0.9.0': true, board: false }, 'only true or false per milestone is kept');
  const kept = boardApi(h, 'uiState').uiState().shown as object;
  assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(kept)), null, 'a hostile key never changes the prototype of the object it lands in');
  assert.deepEqual(ui.scroll, { horizontal: { x: 0, y: 0 }, vertical: { x: 120, y: 48.5 } }, 'scroll positions are finite numbers of 0 or more');
  // Other hostile shapes in place of whole fields.
  for (const timeline of [null, 'vertical', [1, 2], { scroll: 'far', shown: [true] }]) {
    const other = start({ state: { version: 3, view: 'timeline', timeline } });
    other.deliver({ type: 'state', model });
    assert.deepEqual(JSON.parse(JSON.stringify(boardApi(other, 'uiState').uiState())), DEFAULTS, `defaults for ${JSON.stringify(timeline)}`);
    assert.equal(other.root.getAttribute('data-view'), 'timeline');
  }
  // setUiState checks a patch the same way before it is saved.
  boardApi(h, 'setUiState').setUiState({ zoom: 150, direction: 'up', legendOpen: 'no', shown: { 'milestone:v0.9.0': false, y: 3 }, scroll: { vertical: { x: 5, y: Infinity } } });
  assert.deepEqual(saved(h).timeline, { direction: 'horizontal', zoom: 150, legendOpen: true, shown: { 'milestone:v0.9.0': false, board: false }, scroll: { horizontal: { x: 0, y: 0 }, vertical: { x: 5, y: 48.5 } } });
});

test('in Timeline the Direction switch follows the View switch, the Milestone choice, its summary and Group by are hidden, and Vertical is remembered and said', async () => {
  const world = await chainBoard();
  const model = modelOf(world, world.owner.memberId);
  const h = start();
  h.deliver({ type: 'state', model });
  const sw = h.$('#direction-switch')!;
  assert.ok(sw, 'the Direction switch is on the page');
  assert.equal(visible(sw), false, 'Columns has no Direction switch');
  const msField = h.$('#ms-select')!.closest('.field')!;
  const msSummary = h.$('.ms-summary')!;
  const groupBy = h.$('.group-by')!;
  assert.ok(visible(msField) && visible(msSummary) && visible(groupBy), 'Columns shows the Milestone choice, its summary and Group by');

  viewRadio(h, 'timeline').click();
  const row2 = children(h.$('#toolbar .controls')!);
  assert.equal(row2[0]!.id, 'view-switch');
  assert.equal(row2[1]!.id, 'direction-switch', 'the Direction switch comes right after the View switch');
  assert.ok(visible(sw));
  assert.ok(sw.className.split(' ').includes('segmented'));
  assert.equal(sw.getAttribute('role'), 'radiogroup');
  assert.equal(sw.getAttribute('aria-label'), 'Direction');
  const radios = Array.from(sw.querySelectorAll('button[role="radio"]'));
  assert.deepEqual(radios.map((r) => [r.getAttribute('data-direction'), r.textContent, r.getAttribute('aria-checked')]), [['horizontal', 'Horizontal', 'true'], ['vertical', 'Vertical', 'false']]);
  assert.equal(h.root.getAttribute('data-direction'), 'horizontal');
  assert.equal(boardApi(h, 'toolbarSlot').toolbarSlot().previousSibling, sw, 'the timeline controls go right after the Direction switch');
  for (const [name, node] of [['Milestone', msField], ['milestone summary', msSummary], ['Group by', groupBy]] as const) {
    assert.equal(node.hidden, true, `${name} is hidden in Timeline`);
    assert.ok(node.isConnected, `${name} stays on the page`);
  }
  assert.ok(visible(h.$('.filters')), 'the filters stay');

  h.advance(1000);
  h.announcements.length = 0;
  dirRadio(h, 'vertical').click();
  assert.equal(h.root.getAttribute('data-direction'), 'vertical');
  assert.equal(boardApi(h, 'drawnDirection').drawnDirection(), 'vertical');
  assert.equal(saved(h).timeline.direction, 'vertical', 'the choice is saved');
  assert.deepEqual(radios.map((r) => r.getAttribute('aria-checked')), ['false', 'true']);
  h.advance(200);
  assert.deepEqual(h.announcements, ['Timeline shown top to bottom.']);
  h.announcements.length = 0;
  const vertical = dirRadio(h, 'vertical');
  vertical.focus();
  h.press(vertical, 'ArrowLeft');
  assert.equal(h.root.getAttribute('data-direction'), 'horizontal');
  assert.equal(h.focused(), dirRadio(h, 'horizontal'));
  h.advance(200);
  assert.deepEqual(h.announcements, ['Timeline shown left to right.']);

  viewRadio(h, 'columns').click();
  assert.equal(visible(sw), false);
  assert.ok(visible(msField) && visible(groupBy), 'Columns brings the Milestone choice and Group by back');
});

test('TD-11: under 520 px the timeline is drawn top to bottom whatever is saved, Horizontal says why it is off, and the saved choice comes back when wider', async () => {
  const world = await chainBoard();
  const model = modelOf(world, world.owner.memberId);
  const h = start();
  h.deliver({ type: 'state', model });
  viewRadio(h, 'timeline').click();
  h.advance(1000);
  h.announcements.length = 0;
  h.setWidth(480);
  assert.equal(h.root.getAttribute('data-direction'), 'vertical');
  assert.equal(boardApi(h, 'drawnDirection').drawnDirection(), 'vertical');
  const horizontal = dirRadio(h, 'horizontal');
  assert.equal(horizontal.getAttribute('aria-disabled'), 'true');
  assert.equal(horizontal.getAttribute('title'), 'Horizontal needs a wider window.');
  assert.equal(horizontal.getAttribute('aria-checked'), 'false');
  assert.equal(dirRadio(h, 'vertical').getAttribute('aria-checked'), 'true');
  assert.equal(saved(h).timeline.direction, 'horizontal', 'the saved choice is unchanged');
  assert.equal(h.$('#toolbar .controls')!.firstElementChild!.id, 'view-switch', 'the View switch keeps its place in the list layout');
  assert.ok(h.$('.tl-scroll'), 'the timeline stays the view');
  horizontal.click();
  h.setWidth(470);
  assert.equal(h.root.getAttribute('data-direction'), 'vertical', 'a click on the switched off Horizontal changes nothing');
  assert.equal(saved(h).timeline.direction, 'horizontal');
  h.advance(200);
  assert.deepEqual(h.announcements, ['The window is narrow, so the timeline is shown top to bottom.'], 'said once');

  h.setWidth(1400);
  assert.equal(h.root.getAttribute('data-direction'), 'horizontal', 'the saved direction comes back');
  assert.equal(dirRadio(h, 'horizontal').getAttribute('aria-disabled'), null);
  assert.equal(dirRadio(h, 'horizontal').getAttribute('title'), null);
  assert.equal(dirRadio(h, 'horizontal').getAttribute('aria-checked'), 'true');

  // The View switch is first in row 2 in the list layout in Columns too.
  viewRadio(h, 'columns').click();
  h.setWidth(400);
  assert.equal(h.root.getAttribute('data-layout'), 'list');
  assert.equal(h.$('#toolbar .controls')!.firstElementChild!.id, 'view-switch');
  assert.ok(visible(h.$('#view-switch')));
});

test('a first state with Timeline saved says the board\'s first sentence and the view; an empty board keeps the View switch; loading is the board\'s', async () => {
  const world = await chainBoard();
  const model = modelOf(world, world.owner.memberId);
  const h = start({ state: { version: 3, view: 'timeline' } });
  h.deliver({ type: 'state', model });
  h.advance(200);
  const ready = model.cards.filter((c) => c.column === 'ready').length;
  assert.deepEqual(h.announcements, [`Team Board loaded. ${model.cards.length} cards, ${ready} ready. Showing the timeline.`]);
  assert.ok(h.$('.tl-scroll'));

  // Loading and slow loading are the board's, unchanged, in Timeline too.
  const loading = start({ state: { version: 3, view: 'timeline' } });
  assert.equal(loading.$('.state-head')!.textContent, 'Loading the Team Board...');
  loading.advance(10500);
  assert.equal(loading.$('.state-head')!.textContent, 'This is taking longer than usual. The connection to your team may be slow.');
  assert.equal(loading.$('.tl-scroll'), null);

  // An empty board in Timeline: the board's own empty state with the role's words and button, and the View switch is still there.
  const empty = await boardWorld();
  const cases: Array<[string, string, string | undefined]> = [
    [empty.owner.memberId, 'Import your plans from the project roadmap, or add an item yourself.', 'Import plans'],
    [empty.dev.memberId, 'A lead has not imported the plans yet. You can add a bug, chore or experiment yourself.', 'New item'],
    [empty.observer.memberId, 'A lead has not imported the plans yet. Cards show up here when they do.', undefined]
  ];
  for (const [viewer, body, primary] of cases) {
    const e = start({ state: { version: 3, view: 'timeline' } });
    e.deliver({ type: 'state', model: modelOf(empty, viewer) });
    assert.equal(e.$('.state-head')!.textContent, 'No work on the board yet');
    assert.equal(e.$('.state-body')!.textContent, body);
    assert.deepEqual(e.$$('button.primary').filter((b) => visible(b)).map((b) => b.textContent), primary === undefined ? [] : [primary]);
    assert.ok(visible(e.$('#view-switch')), 'the View switch stays');
    assert.equal(viewRadio(e, 'timeline').getAttribute('aria-checked'), 'true', 'it says the board is in Timeline');
    assert.equal(e.$('.tl-scroll'), null);
    assert.equal(e.root.getAttribute('data-view'), 'timeline');
  }
});
