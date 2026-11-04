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
      assert.ok(h3!.className.split(' ').includes('tl-phase-label'));
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
