// The board timeline drawn in the page (62.1-04, D-02, D-05, D-07, D-09, D-13, D-14, TD-14): bands with their opaque headers and percents, the phase
// rail, every card a dot at its geometry place with its state told by shape, glyph and words, the dependency lines, ghosts for filters, folded tiles,
// stacks, the empty, cycle, filter and error states, the Now marker and the toolbar's timeline controls. Every model comes from the real
// buildBoardModel and buildTimeline over a signed in-memory log, built for the same viewer, and every place comes from the page's own geometry.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { buildBoardModel } from '../domain/team/board';
import type { BoardModel } from '../domain/team/board';
import { buildTimeline } from '../domain/team/timeline';
import type { BoardTimeline } from '../domain/team/timeline';
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
const ROOT = path.resolve(__dirname, '..', '..');

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
function modelOf(world: BoardWorld, viewerId: string): BoardModel {
  const model = buildBoardModel(world.state, { nowMs: NOW, status: { kind: 'live', text: 'Live' }, canWrite: true, viewerId });
  model.timeline = buildTimeline(world.state, model, { viewerId });
  return model;
}

// milestone:v0 is finished (one done plan); milestone:v1 (active) holds one card in every state the dot tells apart, Dana is assigned to two of them
// and Lee to one, and phase:2 has no plans, so it is a phase card. Dana also added a chore on the board that nobody is assigned to.
async function statesWorld(): Promise<BoardWorld> {
  const world = await boardWorld();
  const { owner, lead, dev } = world;
  for (const body of [
    milestone('v0', 'Version 0'), phase('0', 'v0', 'Old work'), plan('0-01', { state: 'done' }),
    milestone('v1', 'Version 1', true), phase('1', 'v1', 'First work'), phase('2', 'v1', 'Second work'),
    plan('1-01', { state: 'done' }), plan('1-02'), plan('1-03'), plan('1-04'), plan('1-05'), plan('1-06', { summary: true }),
    plan('1-07', { dependsOn: ['plan:1-02'] }), plan('1-08', { dependsOn: ['plan:1-01'] })
  ]) world.accept(owner, 'item.imported', body);
  world.accept(lead, 'item.assigned', { id: 'plan:1-02', memberId: dev.memberId });
  world.accept(lead, 'item.assigned', { id: 'plan:1-07', memberId: dev.memberId });
  world.accept(lead, 'item.assigned', { id: 'plan:1-08', memberId: lead.memberId });
  world.accept(owner, 'item.cancelled', { id: 'plan:1-03', reason: 'Not needed any more' });
  world.accept(owner, 'item.blocked', { id: 'plan:1-04', reason: 'Waiting on the design' });
  world.accept(dev, 'item.created', { id: `item:${'0'.repeat(22)}8D4N`, kind: 'chore', title: 'Tidy the notes', scope: [], requirements: [], mustHaves: [] });
  setState(world.state, 'plan:1-02', 'ready');
  setState(world.state, 'plan:1-08', 'in-progress');
  world.state.items.get('plan:1-05')!.hold = true;
  return world;
}

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
type Fn = (...args: any[]) => any;
/** A function of window.NearAiBoard, checked to exist first, so a missing one is an assertion failure. */
function boardApi(h: BoardHarness, name: string): Fn {
  const api = h.window.NearAiBoard as Record<string, unknown> | undefined;
  assert.equal(typeof api?.[name], 'function', `the board offers ${name}()`);
  return api![name] as Fn;
}
/** A function of window.NearAiTimeline, checked to exist first. */
function timelineApi(h: BoardHarness, name: string): Fn {
  const api = h.window.NearAiTimeline as Record<string, unknown> | undefined;
  assert.equal(typeof api?.[name], 'function', `timeline.js exports NearAiTimeline.${name}`);
  return api![name] as Fn;
}
interface Rect { x: number; y: number; w: number; h: number }
interface Geometry {
  width: number; height: number; direction: string; zoom: number; box: { w: number; h: number }; pitch: { along: number; across: number };
  bands: Array<Rect & { id: string; folded: boolean; empty: boolean; header: Rect; phases: Array<{ id: string; row: number; label: Rect & { hidden?: boolean }; bar: Rect }>; axis?: Rect; ticks?: Array<{ step: number; at: number }>; nowRow?: Rect; nowGap?: Rect; emptyBox?: Rect; notice?: Rect }>;
  dots: Array<Rect & { id: string; cx: number; cy: number }>;
  more: Array<{ milestoneId: string; step: number; slot: number; rect: Rect; hidden: number }>;
  tiles: Array<{ milestoneId: string; rect: Rect }>;
  now?: { milestoneId: string; step: number; line: Rect; pill: Rect };
}
/** The page's geometry for this timeline, as plain numbers. */
function geometryOf(h: BoardHarness, timeline: BoardTimeline, options: Record<string, unknown>): Geometry {
  const fn = timelineApi(h, 'geometry');
  return JSON.parse(JSON.stringify(fn(JSON.parse(JSON.stringify(timeline)), JSON.parse(JSON.stringify(options))))) as Geometry;
}
const px = (n: number): string => `${n}px`;
const styleOf = (node: FakeNode, name: string): string => node.style.getPropertyValue(name);
const classes = (node: FakeNode | null): string[] => (node === null ? [] : node.className.split(/\s+/).filter(Boolean));
const visible = (node: FakeNode | null): boolean => { for (let n = node; n !== null && n.nodeType === 1; n = n.parentNode) if (n.hidden) return false; return node !== null; };
const dot = (h: BoardHarness, id: string): FakeNode => { const found = h.$(`button.tl-dot[data-id="${id}"]`); assert.ok(found, `the dot of ${id} is drawn`); return found; };
const iconPaths = (h: BoardHarness, name: string): string[] => Array.from((boardApi(h, 'icon')(name) as FakeNode).children).map((p) => p.getAttribute('d') ?? '');

// The UI-SPEC state table: the main appearance (blocked, then on hold, then the column), its shape and its glyph from ICONS (name, and the one path
// of it the glyph uses, or all of them).
const SHAPE: Record<string, string> = {
  backlog: 'hollow', ready: 'hollow', claimed: 'hollow', cancelled: 'hollow', blocked: 'hollow', held: 'dashed',
  'in-progress': 'filled', 'in-review': 'filled', integrating: 'filled', done: 'filled'
};
const GLYPH: Record<string, [string, number?] | undefined> = {
  backlog: undefined, ready: ['play-circle', 1], claimed: ['person'], 'in-progress': ['sync'], 'in-review': ['eye'], integrating: ['check-all'],
  done: ['pass', 1], cancelled: ['circle-slash', 1], blocked: ['lock'], held: ['debug-pause']
};
const HINT_MOVE = 'Use the arrow keys to move along the timeline. Press Enter to open the card. Press M to move it. Press N to jump to now.';
const HINT_OPEN = 'Use the arrow keys to move along the timeline. Press Enter to open the card. Press N to jump to now.';

// ---- Task 1: the tracer ---------------------------------------------------------------------------------------------------------------------

test('tracer: the bands and dots are drawn at their geometry places, and each dot tells its state by data-state, shape, glyph and words', async () => {
  const world = await statesWorld();
  const model = modelOf(world, world.dev.memberId);
  const timeline = model.timeline!;
  const h = timelineOf(model);
  const g = geometryOf(h, timeline, { direction: 'horizontal', zoom: 100, width: 1400, shown: {}, openStacks: {} });

  // The canvas is the geometry's size, inside the one scroller.
  const canvas = h.$('.tl-scroll .tl-canvas');
  assert.ok(canvas, 'the canvas is drawn in the scroller');
  assert.deepEqual([styleOf(canvas, 'width'), styleOf(canvas, 'height')], [px(g.width), px(g.height)], 'the canvas has the geometry size');

  // Every band is a positioned box at its geometry place.
  for (const band of g.bands) {
    const li = h.$(`li.tl-milestone[data-milestone="${band.id}"]`);
    assert.ok(li, `${band.id} is drawn`);
    assert.deepEqual(['left', 'top', 'width', 'height'].map((k) => styleOf(li, k)), [px(band.x), px(band.y), px(band.w), px(band.h)], `${band.id} sits at its geometry place`);
  }

  // Every drawn dot sits at its geometry place inside its band, and its state reads without colour.
  const cards = new Map(model.cards.map((c) => [c.id, c]));
  const bandOf = new Map(timeline.dots.map((d) => [d.cardId, d.milestoneId]));
  assert.ok(g.dots.length >= 10, 'the states board draws its dots');
  for (const d of g.dots) {
    const button = dot(h, d.id);
    const band = g.bands.find((b) => b.id === bandOf.get(d.id))!;
    assert.deepEqual(['left', 'top', 'width', 'height'].map((k) => styleOf(button, k)), [px(d.x - band.x), px(d.y - band.y), px(d.w), px(d.h)], `${d.id} at its geometry place`);
    const card = cards.get(d.id)!;
    const state = card.blocked ? 'blocked' : card.held ? 'held' : card.column;
    assert.equal(button.getAttribute('data-state'), state, `${d.id} data-state`);
    assert.ok(classes(button).includes(SHAPE[state]!), `${d.id} is ${SHAPE[state]} (${button.className})`);
    assert.equal(classes(button).includes('tl-square'), card.kind === 'phase', `${d.id} is a rounded square exactly when it is a phase card`);
    const mark = button.querySelector('svg.tl-mark');
    assert.ok(mark, `${d.id} has its mark`);
    assert.equal(mark.getAttribute('aria-hidden'), 'true');
    const body = mark.firstElementChild!;
    assert.equal(body.localName, card.kind === 'phase' ? 'rect' : 'circle', `${d.id} mark body`);
    const glyph = GLYPH[state];
    const drawn = Array.from(mark.querySelectorAll('.tl-glyph path')).map((p) => p.getAttribute('d'));
    if (glyph === undefined) assert.deepEqual(drawn, [], `${d.id} (${state}) has no glyph`);
    else {
      const paths = iconPaths(h, glyph[0]);
      assert.deepEqual(drawn, glyph[1] === undefined ? paths : [paths[glyph[1]]], `${d.id} (${state}) draws the ${glyph[0]} glyph`);
    }
    assert.equal(button.getAttribute('aria-label'), timeline.dots.find((x) => x.cardId === d.id)!.label, `${d.id} is named by the model`);
    const hint = h.document.getElementById(button.getAttribute('aria-describedby') ?? '');
    assert.ok(hint, `${d.id} points at the hidden hint`);
    assert.ok([HINT_MOVE, HINT_OPEN].includes(hint.textContent), `${d.id} hint text: ${hint.textContent}`);
  }
  // The pip for a plan that looks finished, and the states this board holds.
  assert.ok(dot(h, 'plan:1-06').querySelector('svg.tl-mark .tl-pip'), 'the looks finished plan carries the info pip');
  assert.equal(dot(h, 'plan:1-02').querySelector('.tl-pip'), null);
  assert.deepEqual(['plan:1-01', 'plan:1-02', 'plan:1-03', 'plan:1-04', 'plan:1-05', 'plan:1-07', 'plan:1-08', 'phase:2'].map((id) => dot(h, id).getAttribute('data-state')),
    ['done', 'ready', 'cancelled', 'blocked', 'held', 'backlog', 'in-progress', 'backlog']);
  assert.equal(h.$$('button.tl-dot').filter((b) => b.getAttribute('tabindex') === '0').length, 1, 'one tab stop for every dot');
});

test('initials: Dana sees her cards with a filled chip, Lee\'s with a hollow one and none on an unassigned card; at 50 and 75 her marks carry the Mine ring; at 200 the display ID shows', async () => {
  const world = await statesWorld();
  const model = modelOf(world, world.dev.memberId);
  const h = timelineOf(model);
  const chore = model.cards.find((c) => c.kind === 'chore')!;
  const chip = (id: string): FakeNode | null => dot(h, id).querySelector('.tl-initials');
  for (const id of ['plan:1-02', 'plan:1-07']) {
    assert.ok(chip(id), `${id} has a chip`);
    assert.ok(classes(chip(id)).includes('mine'), `${id} has a filled chip`);
    assert.equal(chip(id)!.textContent, 'D');
    assert.equal(chip(id)!.getAttribute('aria-hidden'), 'true');
  }
  assert.ok(chip('plan:1-08') && !classes(chip('plan:1-08')).includes('mine'), 'Lee\'s card has a hollow chip');
  assert.equal(chip('plan:1-08')!.textContent, 'L');
  assert.equal(chip('plan:1-04'), null, 'nobody is assigned and it is not Dana\'s: no chip');
  // Dana added the chore and nobody is assigned: the filled chip shows the person glyph instead of letters.
  assert.ok(classes(chip(chore.id)).includes('mine'), 'Dana\'s own chore has the filled chip');
  assert.equal(chip(chore.id)!.textContent, '');
  assert.ok(chip(chore.id)!.querySelector('svg'), 'with the person glyph');
  assert.equal(h.$$('.tl-id').length, 0, 'no display ID below 200%');

  for (const zoom of [50, 75]) {
    boardApi(h, 'setUiState')({ zoom });
    boardApi(h, 'redraw')();
    assert.equal(h.$$('.tl-dot .tl-initials').length, 0, `${zoom}%: no chip`);
    for (const id of ['plan:1-02', 'plan:1-07', chore.id]) assert.ok(classes(dot(h, id).querySelector('svg.tl-mark')).includes('tl-ring'), `${zoom}%: ${id} carries the Mine ring`);
    assert.ok(!classes(dot(h, 'plan:1-08').querySelector('svg.tl-mark')).includes('tl-ring'), `${zoom}%: Lee's card has no ring`);
  }
  boardApi(h, 'setUiState')({ zoom: 200 });
  boardApi(h, 'redraw')();
  for (const c of model.cards.filter((card) => card.milestoneId !== 'milestone:v0')) {
    const idLabel = dot(h, c.id).querySelector('.tl-id');
    assert.ok(idLabel, `200%: ${c.id} shows its display ID`);
    assert.equal(idLabel.textContent, c.displayId);
    assert.equal(idLabel.getAttribute('aria-hidden'), 'true');
  }
  assert.ok(chip('plan:1-02'), '200%: the chips are back');
  assert.ok(!classes(dot(h, 'plan:1-02').querySelector('svg.tl-mark')).includes('tl-ring'), '200%: the chip says Mine, so no ring');
});

test('headers: the h2 is the model\'s heading, the Current badge, the band percent, the progress bar and its words; a finished milestone that is shown offers Fold milestone', async () => {
  const world = await statesWorld();
  const model = modelOf(world, world.dev.memberId);
  const timeline = model.timeline!;
  const h = timelineOf(model);
  boardApi(h, 'setUiState')({ shown: { 'milestone:v0': true } });
  boardApi(h, 'redraw')();
  for (const band of timeline.milestones) {
    const li = h.$(`li.tl-milestone[data-milestone="${band.id}"]`)!;
    const head = li.querySelector('.tl-ms-head');
    assert.ok(head && visible(head), `${band.id} has its header`);
    assert.equal(li.querySelector('h2')!.textContent, band.heading, `${band.id} h2 reads the model's heading`);
    const title = head.querySelector('.tl-ms-title')!;
    assert.equal(title.textContent, band.title, `${band.id} visible title`);
    assert.equal(title.getAttribute('title'), band.title, 'the full title is in title, so a cut title is on purpose');
    assert.deepEqual(head.querySelectorAll('.badge').length, band.active ? 1 : 0, `${band.id} Current badge`);
    if (band.active) assert.equal(head.querySelector('.badge')!.textContent, 'Current');
    assert.equal(head.querySelector('.tl-ms-percent')!.textContent, band.percentText, `${band.id} percent`);
    const bar = head.querySelector('.progress')!;
    assert.equal(bar.getAttribute('role'), 'progressbar');
    assert.equal(bar.getAttribute('aria-valuenow'), band.percent?.percent === undefined ? null : String(band.percent.percent), `${band.id} aria-valuenow`);
    assert.equal(bar.getAttribute('aria-label'), `${band.title} progress`);
    assert.equal(styleOf(bar.querySelector('.bar')!, 'width'), `${band.percent?.percent ?? 0}%`);
    assert.equal(head.querySelector('.progress-text')!.textContent, band.progressText);
    const fold = head.querySelector('button.tl-fold');
    if (band.id === 'milestone:v0') {
      assert.ok(fold, 'the shown finished milestone offers Fold milestone');
      assert.equal(fold.textContent, 'Fold milestone');
      assert.equal(fold.getAttribute('aria-label'), 'Fold Version 0');
      assert.equal(fold.getAttribute('aria-expanded'), 'true');
    } else assert.equal(fold, null, `${band.id} is not finished, or holds Now: no Fold milestone`);
  }
});

test('phase labels: pickLabel takes the longest label that fits its room, and the page shows that label with the heading in title, the full heading in the h3 and the bar filled to the percent', async () => {
  const world = await statesWorld();
  const model = modelOf(world, world.dev.memberId);
  const timeline = model.timeline!;
  const h = timelineOf(model);
  const pickLabel = timelineApi(h, 'pickLabel');
  const labels = ['Phase 62: Board work · 62%', 'Phase 62 · 62%', '62 · 62%'];
  const seven = (text: string): number => text.length * 7;
  assert.equal(pickLabel(labels, 24 * 7, seven), 'Phase 62 · 62%');
  assert.equal(pickLabel(labels, 9 * 7, seven), '62 · 62%');
  assert.equal(pickLabel(labels, 4 * 7, seven), '');
  assert.equal(pickLabel(labels, 400, seven), labels[0]);
  assert.equal(pickLabel([], 400, seven), '');

  const g = geometryOf(h, timeline, { direction: 'horizontal', zoom: 100, width: 1400, shown: {}, openStacks: {} });
  let checked = 0;
  for (const band of g.bands) {
    const mb = timeline.milestones.find((m) => m.id === band.id)!;
    for (const ph of band.phases) {
      const phaseModel = mb.phases.find((p) => p.id === ph.id)!;
      const li = h.$(`li.tl-milestone[data-milestone="${band.id}"] li.tl-phase[data-phase="${ph.id}"]`)!;
      assert.ok(li, `${ph.id} is listed`);
      const h3 = li.querySelector('h3')!;
      assert.equal(h3.textContent, phaseModel.heading, `${ph.id} h3 keeps the full heading`);
      const label = li.querySelector('.tl-phase-label')!;
      assert.equal(label.getAttribute('aria-hidden'), 'true', 'the visible label is not read twice');
      const chosen = pickLabel(phaseModel.labels, ph.label.w, seven);
      assert.equal(label.textContent, ph.label.hidden ? '' : chosen, `${ph.id} label`);
      assert.equal(label.getAttribute('title'), phaseModel.heading);
      assert.deepEqual(['left', 'top', 'width'].map((k) => styleOf(label, k)), [px(ph.label.x - band.x), px(ph.label.y - band.y), px(ph.label.w)], `${ph.id} label place`);
      const bar = li.querySelector('.tl-phase-bar')!;
      assert.equal(bar.getAttribute('aria-hidden'), 'true');
      assert.deepEqual(['left', 'top', 'width', 'height'].map((k) => styleOf(bar, k)), [px(ph.bar.x - band.x), px(ph.bar.y - band.y), px(ph.bar.w), px(ph.bar.h)], `${ph.id} bar place`);
      assert.equal(styleOf(bar.querySelector('.tl-phase-fill')!, '--fill'), String((phaseModel.percent?.percent ?? 0) / 100), `${ph.id} fill`);
      checked += 1;
    }
  }
  assert.ok(checked >= 2, 'the phases were checked');
});

test('T-62.1-09: a card and a phase titled with markup, a format control and a script tag show their text literally and create no element', async () => {
  const world = await statesWorld();
  const hostile = '<img src=x onerror="alert(1)">‮Bad<script>alert(1)</script>';
  world.state.items.get('plan:1-02')!.title = hostile;
  world.state.items.get('phase:1')!.title = '<b>Bold</b> work';
  const model = modelOf(world, world.dev.memberId);
  const timeline = model.timeline!;
  const h = timelineOf(model);
  for (const tag of ['img', 'script', 'b', 'iframe']) assert.equal(h.$$(tag).length, 0, `no ${tag} element was made`);
  const label = dot(h, 'plan:1-02').getAttribute('aria-label') ?? '';
  assert.equal(label, timeline.dots.find((d) => d.cardId === 'plan:1-02')!.label);
  assert.ok(label.includes('<script>alert(1)</script>'), 'the markup is plain text in the name');
  assert.ok(!label.includes('‮'), 'the format control is gone');
  const heading = timeline.milestones.find((m) => m.id === 'milestone:v1')!.phases.find((p) => p.id === 'phase:1')!.heading;
  assert.ok(heading.includes('<b>Bold</b>'));
  assert.equal(h.$('li.tl-phase[data-phase="phase:1"] h3')!.textContent, heading);
  assert.equal(h.$('li.tl-phase[data-phase="phase:1"] .tl-phase-label')!.getAttribute('title'), heading);
});
