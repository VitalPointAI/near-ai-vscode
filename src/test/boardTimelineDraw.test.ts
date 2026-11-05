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
      assert.equal(styleOf(bar.querySelector('.tl-phase-fill')!, 'transform'), `scaleX(${(phaseModel.percent?.percent ?? 0) / 100})`, `${ph.id} fill`);
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

// ---- Task 2: lines, ghosts, tiles, stacks, states, the Now marker and the toolbar ------------------------------------------------------------

// milestone:v0 (finished: plan:0-01) folds to its tile; milestone:v1 (active) has plan:1-01 done, waiting for plan:0-01 across the milestones, and
// plan:1-02 and plan:1-03 both waiting for it, so Now is at step 2 of v1; milestone:v2 has plan:20-01, thirty plans that wait for it, and plan:20-32
// that waits for plan:20-30, which is hidden in the stack.
async function linesWorld(): Promise<BoardWorld> {
  const world = await boardWorld();
  const bodies: Body[] = [
    milestone('v0', 'Version 0'), phase('0', 'v0', 'Old work'), plan('0-01', { state: 'done' }),
    milestone('v1', 'Version 1', true), phase('1', 'v1', 'First work'),
    plan('1-01', { state: 'done', dependsOn: ['plan:0-01'] }), plan('1-02', { dependsOn: ['plan:1-01'] }), plan('1-03', { dependsOn: ['plan:1-01'] }),
    milestone('v2', 'Version 2'), phase('20', 'v2', 'Wide work'), plan('20-01')
  ];
  for (let i = 2; i <= 31; i += 1) bodies.push(plan(`20-${String(i).padStart(2, '0')}`, { dependsOn: ['plan:20-01'] }));
  bodies.push(plan('20-32', { dependsOn: ['plan:20-30'] }));
  bodies.push(milestone('v3', 'Version 3'));
  for (const body of bodies) world.accept(world.owner, 'item.imported', body);
  return world;
}
const numbers = (d: string): number[] => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const clampTo = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

test('lines: one path per dependency under the dots, straight in a row and curved across rows, ending at mark edges, the +n button of a hidden card and a folded milestone\'s tile', async () => {
  const world = await linesWorld();
  const model = modelOf(world, world.lead.memberId);
  const timeline = model.timeline!;
  const h = timelineOf(model);
  const g = geometryOf(h, timeline, { direction: 'horizontal', zoom: 100, width: 1400, shown: {}, openStacks: {} });
  const svg = h.$('.tl-canvas svg.tl-lines');
  assert.ok(svg, 'one line layer');
  assert.equal(h.$$('svg.tl-lines').length, 1);
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  const canvas = h.$('.tl-canvas')!;
  assert.ok(Array.from(canvas.children).indexOf(svg) < Array.from(canvas.children).indexOf(h.$('ol.tl-milestones')!), 'the lines are under the dots');
  const paths = Array.from(svg.querySelectorAll('path.tl-line'));
  assert.deepEqual(paths.map((p) => `${p.getAttribute('data-from')}>${p.getAttribute('data-to')}`).sort(), timeline.edges.map((e) => `${e.from}>${e.to}`).sort(), 'one path per dependency');

  const box = new Map(g.dots.map((d) => [d.id, d]));
  const dotOf = new Map(timeline.dots.map((d) => [d.cardId, d]));
  const half = g.pitch.along / 2;
  const pathOf = (from: string, to: string): number[] => numbers(paths.find((p) => p.getAttribute('data-from') === from && p.getAttribute('data-to') === to)!.getAttribute('d')!);
  // Same row: straight from the right edge of the source mark to the left edge of the target mark.
  const a = box.get('plan:1-01')!;
  const b = box.get('plan:1-02')!;
  assert.equal(dotOf.get('plan:1-02')!.slot, 0);
  assert.deepEqual(pathOf('plan:1-01', 'plan:1-02'), [a.x + 24, a.cy, b.x + 4, b.cy]);
  // Another row: a cubic curve, both control points half a step pitch along the axis from the ends.
  const c = box.get('plan:1-03')!;
  assert.notEqual(c.cy, a.cy);
  assert.deepEqual(pathOf('plan:1-01', 'plan:1-03'), [a.x + 24, a.cy, a.x + 24 + half, a.cy, c.x + 4 - half, c.cy, c.x + 4, c.cy]);
  // From the folded milestone: the tile's right edge.
  const tile = g.tiles.find((t) => t.milestoneId === 'milestone:v0')!.rect;
  const fromTile = pathOf('plan:0-01', 'plan:1-01');
  assert.deepEqual([fromTile[0], fromTile[1]], [tile.x + tile.w, clampTo(a.cy, tile.y, tile.y + tile.h)]);
  assert.deepEqual(fromTile.slice(-2), [a.x + 4, a.cy]);
  // From a card hidden in the stack: the +n button's right edge; to a hidden card: its left edge.
  const more = g.more.find((m) => m.milestoneId === 'milestone:v2')!.rect;
  const z = box.get('plan:20-32')!;
  const fromMore = pathOf('plan:20-30', 'plan:20-32');
  assert.deepEqual([fromMore[0], fromMore[1]], [more.x + more.w, clampTo(z.cy, more.y, more.y + more.h)]);
  const root = box.get('plan:20-01')!;
  const toMore = pathOf('plan:20-01', 'plan:20-25');
  assert.deepEqual(toMore.slice(-2), [more.x, clampTo(root.cy, more.y, more.y + more.h)]);
  for (const p of paths) assert.equal(p.getAttribute('class'), timeline.edges.find((e) => e.from === p.getAttribute('data-from') && e.to === p.getAttribute('data-to'))!.waiting ? 'tl-line waiting' : 'tl-line');
});

test('TD-14: filters keep every place; the rest become ghost rings that are not buttons, not listed and have no lines; nothing matching shows the board\'s band over the ghosts', async () => {
  const world = await statesWorld();
  const model = modelOf(world, world.dev.memberId);
  const timeline = model.timeline!;
  const h = timelineOf(model);
  const g = geometryOf(h, timeline, { direction: 'horizontal', zoom: 100, width: 1400, shown: {}, openStacks: {} });
  const before = ['left', 'top'].map((k) => styleOf(dot(h, 'plan:1-02'), k));
  assert.ok(h.$$('svg.tl-lines path').length > 0, 'lines without filters');
  boardApi(h, 'setFilter')('ready', true);
  const matching = new Set(model.cards.filter((c) => c.column === 'ready' && !c.blocked).map((c) => c.id));
  // plan:1-02 and plan:1-06 (whose summary is in, so it looks finished) are the Ready cards.
  assert.deepEqual([...matching].sort(), ['plan:1-02', 'plan:1-06']);
  assert.deepEqual(h.$$('button.tl-dot').map((b) => b.getAttribute('data-id')).sort(), [...matching].sort(), 'only the matching dots are buttons');
  assert.deepEqual(['left', 'top'].map((k) => styleOf(dot(h, 'plan:1-02'), k)), before, 'its place is unchanged');
  const ghosts = h.$('.tl-canvas .tl-ghosts')!;
  assert.ok(ghosts, 'the ghost layer is drawn');
  assert.equal(ghosts.getAttribute('aria-hidden'), 'true');
  const rings = Array.from(ghosts.querySelectorAll('.tl-ghost'));
  assert.deepEqual(rings.map((r) => r.getAttribute('data-id')).sort(), g.dots.map((d) => d.id).filter((id) => !matching.has(id)).sort(), 'every other drawn dot is a ghost');
  for (const ring of rings) {
    const d = g.dots.find((x) => x.id === ring.getAttribute('data-id'))!;
    assert.deepEqual(['left', 'top', 'width', 'height'].map((k) => styleOf(ring, k)), [px(d.x + 10), px(d.cy - 4), px(8), px(8)], `${d.id} ghost on its mark`);
    assert.equal(ring.textContent, '', 'a ghost carries no text');
    assert.notEqual(ring.localName, 'button');
  }
  assert.equal(h.$$('ol.tl-dots li').filter((li) => li.querySelector('.tl-dot') === null && !classes(li).includes('tl-now')).length, 0, 'ghosts are not in the list');
  assert.equal(h.$$('svg.tl-lines path').length, 0, 'a line needs two matching dots');
  assert.equal(h.$('.tl-filter-empty'), null);

  boardApi(h, 'setFilter')('blocked', true);
  const band = h.$('.tl-scroll .tl-filter-empty');
  assert.ok(band && visible(band), 'nothing matches: the board\'s empty filter band is at the top of the scroller');
  assert.equal(h.$('.tl-scroll')!.firstElementChild, band);
  assert.ok(band.textContent.includes('No cards match these filters'));
  assert.ok(band.textContent.includes('Clear the filters to see every card.'));
  assert.equal(h.$$('button.tl-dot').length, 0);
  assert.equal(h.$$('.tl-ghosts .tl-ghost').length, g.dots.length, 'every dot is a ghost below the band');
  const clear = Array.from(band.querySelectorAll('button')).find((x) => x.textContent === 'Clear filters');
  assert.ok(clear, 'Clear filters');
  clear.click();
  assert.equal(h.$('.tl-filter-empty'), null);
  assert.equal(h.$$('button.tl-dot').length, g.dots.length, 'every dot is back');
});

test('D-09: a finished milestone is a tile that says what it holds; a stack of 30 shows 8 dots and +22, then all and Show fewer; an empty milestone and a loop say so in their band', async () => {
  const world = await linesWorld();
  const model = modelOf(world, world.lead.memberId);
  const timeline = model.timeline!;
  const v0 = timeline.milestones.find((m) => m.id === 'milestone:v0')!;
  const h = timelineOf(model);
  const g = geometryOf(h, timeline, { direction: 'horizontal', zoom: 100, width: 1400, shown: {}, openStacks: {} });
  const li = h.$('li.tl-milestone[data-milestone="milestone:v0"]')!;
  const tile = li.querySelector('button.tl-folded');
  assert.ok(tile, 'the finished milestone is a tile');
  assert.equal(tile.getAttribute('aria-label'), v0.tileName);
  assert.equal(tile.getAttribute('aria-expanded'), 'false');
  for (const words of [v0.title, v0.tileText, '100%', 'Show milestone']) assert.ok(tile.textContent.includes(words), `the tile says ${words}`);
  const where = g.tiles.find((t) => t.milestoneId === 'milestone:v0')!.rect;
  const bandAt = g.bands.find((b) => b.id === 'milestone:v0')!;
  assert.deepEqual(['left', 'top', 'width', 'height'].map((k) => styleOf(tile, k)), [px(where.x - bandAt.x), px(where.y - bandAt.y), px(where.w), px(where.h)]);
  assert.equal(li.querySelector('h2')!.textContent, v0.heading, 'the folded band keeps its h2');
  assert.equal(li.querySelectorAll('.tl-dot').length, 0, 'its cards are not listed until it is shown');
  tile.click();
  assert.equal(h.$('li.tl-milestone[data-milestone="milestone:v0"] button.tl-folded'), null);
  assert.ok(dot(h, 'plan:0-01'));
  const fold = h.$('li.tl-milestone[data-milestone="milestone:v0"] button.tl-fold')!;
  assert.ok(fold, 'shown, it offers Fold milestone');
  fold.click();
  assert.ok(h.$('li.tl-milestone[data-milestone="milestone:v0"] button.tl-folded'), 'folded again');
  assert.equal((h.state as any).timeline.shown['milestone:v0'], false, 'the choice is saved');

  // The stack: step 2 of v2 holds 30 cards.
  const stackStep = timeline.dots.find((d) => d.cardId === 'plan:20-02')!.step;
  const more = h.$(`li.tl-milestone[data-milestone="milestone:v2"] button.tl-more[data-step="${stackStep}"]`);
  assert.ok(more, 'the +n button');
  assert.equal(more.textContent, '+22');
  assert.equal(more.getAttribute('aria-label'), `Show 22 more cards in step ${stackStep + 1}`);
  assert.equal(h.$$('li.tl-milestone[data-milestone="milestone:v2"] button.tl-dot').filter((b) => b.getAttribute('data-step') === String(stackStep)).length, 8);
  more.click();
  assert.equal(h.$$('li.tl-milestone[data-milestone="milestone:v2"] button.tl-dot').filter((b) => b.getAttribute('data-step') === String(stackStep)).length, 30, 'shown, the whole stack');
  const fewer = h.$(`button.tl-more[data-step="${stackStep}"]`)!;
  assert.equal(fewer.textContent, 'Show fewer');
  assert.equal(fewer.getAttribute('aria-label'), `Show fewer cards in step ${stackStep + 1}`);
  fewer.click();
  assert.equal(h.$(`button.tl-more[data-step="${stackStep}"]`)!.textContent, '+22');

  // The empty milestone.
  const v3 = timeline.milestones.find((m) => m.id === 'milestone:v3')!;
  const empty = h.$('li.tl-milestone[data-milestone="milestone:v3"] .tl-empty');
  assert.ok(empty, 'the empty band says so');
  assert.ok(v3.emptyText && empty.textContent.includes(v3.emptyText));
  assert.ok(v3.emptyNext && empty.textContent.includes(v3.emptyNext));

  // A loop: plan:1-02 and plan:1-03 wait for each other.
  world.state.items.get('plan:1-02')!.dependsOn = ['plan:1-01', 'plan:1-03'];
  world.state.items.get('plan:1-03')!.dependsOn = ['plan:1-01', 'plan:1-02'];
  const looped = modelOf(world, world.lead.memberId);
  const band = looped.timeline!.milestones.find((m) => m.id === 'milestone:v1')!;
  assert.equal(band.cycle, true);
  h.deliver({ type: 'state', model: looped });
  const note = h.$('li.tl-milestone[data-milestone="milestone:v1"] .tl-cycle');
  assert.ok(note, 'the loop band carries its notice');
  assert.ok(classes(note).includes('banner'), 'an opaque notice');
  assert.ok(note.textContent.includes(band.cycleNote!));
  const lg = geometryOf(h, looped.timeline!, { direction: 'horizontal', zoom: 100, width: 1400, shown: {}, openStacks: {} });
  const lb = lg.bands.find((b) => b.id === 'milestone:v1')!;
  assert.ok(lb.notice, 'the geometry keeps room for the notice');
  assert.deepEqual(['left', 'top', 'width'].map((k) => styleOf(note, k)), [px(lb.notice.x - lb.x), px(lb.notice.y - lb.y), px(lb.notice.w)]);
  for (const d of lg.dots) {
    const gap = Math.max(d.x - (lb.notice.x + lb.notice.w), lb.notice.x - (d.x + d.w), d.y - (lb.notice.y + lb.notice.h), lb.notice.y - (d.y + d.h));
    assert.ok(gap >= 4, `the notice is clear of ${d.id}`);
  }
  for (const p of lg.bands.flatMap((x) => x.phases)) {
    const r = p.label;
    if (r.hidden) continue;
    const gap = Math.max(r.x - (lb.notice.x + lb.notice.w), lb.notice.x - (r.x + r.w), r.y - (lb.notice.y + lb.notice.h), lb.notice.y - (r.y + r.h));
    assert.ok(gap >= 4, `the notice is clear of the ${p.id} label`);
  }
});

test('the timeline could not be drawn: no timeline or timelineProblem shows the heading, the body, Show columns and Draw the timeline again (the board\'s retry)', async () => {
  const world = await statesWorld();
  for (const broken of ['missing', 'problem'] as const) {
    const model = modelOf(world, world.dev.memberId);
    delete model.timeline;
    if (broken === 'problem') model.timelineProblem = true;
    const h = timelineOf(model);
    const box = h.$('.tl-scroll .tl-error');
    assert.ok(box, `${broken}: the error state`);
    assert.equal(box.getAttribute('role'), 'alert');
    assert.equal(box.querySelector('h2')!.textContent, 'The timeline could not be drawn');
    assert.equal(box.querySelector('p')!.textContent, 'Something went wrong while placing the cards. Nothing was changed. Switch to Columns to see every card, or try again.');
    const buttons = Array.from(box.querySelectorAll('button'));
    assert.deepEqual(buttons.map((b) => b.textContent), ['Show columns', 'Draw the timeline again']);
    assert.equal(h.$$('button.primary').filter((b) => h.$('.tl-scroll')!.contains(b)).length, 0, 'the timeline adds no primary button');
    buttons[1]!.click();
    assert.deepEqual(h.posts.at(-1), { type: 'retry' });
    buttons[0]!.click();
    assert.equal(h.root.getAttribute('data-view'), 'columns', 'Show columns switches the view');
  }
});

test('D-13: the Now line and pill at their geometry places, the screen reader item right before the Now step, the past shade, the all-done pill, and no marker without Now', async () => {
  const world = await linesWorld();
  const model = modelOf(world, world.lead.memberId);
  const timeline = model.timeline!;
  const now = timeline.now!;
  assert.equal(now.milestoneId, 'milestone:v1');
  const h = timelineOf(model);
  const g = geometryOf(h, timeline, { direction: 'horizontal', zoom: 100, width: 1400, shown: {}, openStacks: {} });
  const band = g.bands.find((b) => b.id === now.milestoneId)!;
  const line = h.$(`li.tl-milestone[data-milestone="${now.milestoneId}"] .tl-now-line`)!;
  const pill = h.$(`li.tl-milestone[data-milestone="${now.milestoneId}"] .tl-now-pill`)!;
  assert.ok(line && pill, 'the line and the pill are in the Now band');
  assert.deepEqual(['left', 'top', 'width', 'height'].map((k) => styleOf(line, k)), [px(g.now!.line.x - band.x), px(g.now!.line.y - band.y), px(g.now!.line.w), px(g.now!.line.h)]);
  assert.deepEqual(['left', 'top', 'width'].map((k) => styleOf(pill, k)), [px(g.now!.pill.x - band.x), px(g.now!.pill.y - band.y), px(g.now!.pill.w)]);
  assert.equal(pill.getAttribute('aria-hidden'), 'true');
  assert.equal(line.getAttribute('aria-hidden'), 'true');
  assert.deepEqual(Array.from(pill.children).map((n) => n.textContent), [now.title, now.detail]);
  const item = h.$('li.tl-now')!;
  assert.ok(item, 'the screen reader item');
  assert.equal(item.closest('li.tl-phase')!.getAttribute('data-phase'), now.phaseId);
  const next = item.nextSibling!;
  assert.equal(next.querySelector('.tl-dot')!.getAttribute('data-step'), String(now.step), 'right before the first dot of the Now step');
  assert.equal(next.querySelector('.tl-dot')!.getAttribute('data-id'), 'plan:1-02');
  assert.equal(item.querySelector('.sr-only')!.textContent, now.sentence);
  assert.equal(item.getAttribute('tabindex'), null);
  assert.equal(h.$$('li.tl-now [tabindex]').length, 0, 'not focusable');
  // The past shade: the folded milestone before the frontier band, and the frontier band up to the line.
  const shades = h.$$('.tl-canvas .tl-past').map((n) => ['left', 'top', 'width', 'height'].map((k) => styleOf(n, k)));
  const v0 = g.bands.find((b) => b.id === 'milestone:v0')!;
  assert.deepEqual(shades, [[px(v0.x), px(v0.y), px(v0.w), px(v0.h)], [px(band.x), px(band.y), px(g.now!.line.x - band.x), px(band.h)]]);
  assert.equal(h.$('.tl-past')!.parentNode!.getAttribute('aria-hidden'), 'true');

  // All done: the pill reads the all-done title after the last step.
  for (const id of ['plan:1-02', 'plan:1-03']) setState(world.state, id, 'done');
  for (let i = 1; i <= 32; i += 1) setState(world.state, `plan:20-${String(i).padStart(2, '0')}`, 'done');
  const finished = modelOf(world, world.lead.memberId);
  assert.equal(finished.timeline!.now!.allDone, true);
  h.deliver({ type: 'state', model: finished });
  assert.equal(h.$('.tl-now-pill')!.firstElementChild!.textContent, finished.timeline!.now!.title);
  assert.equal(h.$$('li.tl-now').length, 1);
  // No Now: no marker, no item, no shade.
  delete finished.timeline!.now;
  h.deliver({ type: 'state', model: finished });
  assert.equal(h.$('.tl-now-line'), null);
  assert.equal(h.$('.tl-now-pill'), null);
  assert.equal(h.$('li.tl-now'), null);
  assert.equal(h.$('.tl-past'), null);
});

test('D-14 and the toolbar: the overall ring with its percent, the zoom group, Jump to now and the legend toggle (saved), all in Timeline only', async () => {
  const world = await statesWorld();
  const model = modelOf(world, world.dev.memberId);
  const percent = model.timeline!.percent!;
  const h = timelineOf(model);
  const slot = h.$('#toolbar .tl-tools')!;
  assert.ok(visible(slot), 'the timeline controls show in Timeline');
  assert.deepEqual(Array.from(slot.children).map((n) => n.id), ['tl-overall', 'tl-zoom', 'tl-now', 'tl-legend-btn'], 'in the toolbar order');
  const overall = h.$('#tl-overall')!;
  assert.equal(overall.getAttribute('role'), 'progressbar');
  assert.deepEqual(['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-label', 'aria-valuetext'].map((k) => overall.getAttribute(k)), ['0', '100', String(percent.percent), 'Project progress', percent.label]);
  assert.equal(overall.textContent, percent.text);
  assert.ok(overall.querySelector('svg'), 'the ring');
  assert.equal(overall.getAttribute('tabindex'), null, 'not focusable');

  const zoom = h.$('#tl-zoom')!;
  assert.ok(classes(zoom).includes('zoom'));
  assert.deepEqual([zoom.getAttribute('role'), zoom.getAttribute('aria-label')], ['group', 'Zoom']);
  const out = zoom.querySelector('button[data-zoom="out"]')!;
  const inn = zoom.querySelector('button[data-zoom="in"]')!;
  const fit = zoom.querySelector('button[data-zoom="fit"]')!;
  const level = zoom.querySelector('output.zoom-level')!;
  assert.deepEqual(Array.from(zoom.children).map((n) => n.localName + (n.getAttribute('data-zoom') ?? '')), ['buttonout', 'output', 'buttonin', 'buttonfit']);
  assert.deepEqual([out.getAttribute('aria-label'), out.getAttribute('title'), inn.getAttribute('aria-label'), inn.getAttribute('title')], ['Zoom out', 'Zoom out', 'Zoom in', 'Zoom in']);
  assert.ok(classes(out).includes('icon') && classes(inn).includes('icon') && classes(fit).includes('secondary'));
  assert.deepEqual([level.textContent, level.getAttribute('aria-label')], ['100%', 'Zoom 100%']);
  assert.deepEqual([fit.textContent, fit.getAttribute('title'), fit.getAttribute('aria-label')], ['Fit milestone', 'Fit the current milestone to the window', 'Fit the current milestone to the window']);
  boardApi(h, 'setUiState')({ zoom: 50 });
  boardApi(h, 'redraw')();
  assert.deepEqual([level.textContent, level.getAttribute('aria-label'), out.getAttribute('aria-disabled'), inn.getAttribute('aria-disabled')], ['50%', 'Zoom 50%', 'true', null], 'the end of the range is aria-disabled');
  boardApi(h, 'setUiState')({ zoom: 200 });
  boardApi(h, 'redraw')();
  assert.deepEqual([out.getAttribute('aria-disabled'), inn.getAttribute('aria-disabled')], [null, 'true']);

  const jump = h.$('#tl-now')!;
  assert.deepEqual([jump.localName, jump.textContent, jump.getAttribute('title')], ['button', 'Jump to now', 'Show where the work is now']);
  assert.ok(classes(jump).includes('secondary'));

  const legendBtn = h.$('#tl-legend-btn')!;
  assert.deepEqual([legendBtn.textContent, legendBtn.getAttribute('aria-expanded'), legendBtn.getAttribute('aria-controls')], ['Show legend', 'false', 'tl-legend']);
  assert.ok(!visible(h.$('#tl-legend')), 'the legend starts closed');
  legendBtn.click();
  const legend = h.$('#tl-legend')!;
  assert.ok(visible(legend), 'the legend opens');
  assert.deepEqual([legend.getAttribute('role'), legend.getAttribute('aria-label')], ['group', 'What the dots mean']);
  assert.ok(h.$('#board')!.contains(legend) && !h.$('.tl-scroll')!.contains(legend), 'a band above the scroller, never over the canvas');
  assert.deepEqual(Array.from(legend.querySelectorAll('.tl-legend-item')).map((n) => n.textContent), [
    'Backlog', 'Ready', 'Claimed', 'In progress', 'In review', 'Shipping', 'Done', 'Cancelled', 'Blocked', 'On hold', 'Looks finished, please confirm',
    'Mine: filled initials', 'Square: a phase with no plans yet', 'Line: waits for', 'Dashed line: still waiting'
  ]);
  assert.equal(legend.querySelector('.tl-legend-hint')!.textContent, 'Hover or focus a dot to preview it. Click it or press Enter to open the card.');
  assert.equal(legend.querySelectorAll('button, [tabindex]').length, 0, 'no stops inside the legend');
  assert.deepEqual([legendBtn.textContent, legendBtn.getAttribute('aria-expanded')], ['Hide legend', 'true']);
  assert.equal((h.state as any).timeline.legendOpen, true, 'the choice is saved');
  legendBtn.click();
  assert.ok(!visible(h.$('#tl-legend')));
  assert.equal((h.state as any).timeline.legendOpen, false);

  h.$('#view-switch button[data-view="columns"]')!.click();
  for (const id of ['tl-overall', 'tl-zoom', 'tl-now', 'tl-legend-btn']) assert.ok(!visible(h.document.getElementById(id)), `${id} is not shown in Columns`);
  assert.ok(!visible(h.$('#tl-legend')), 'no legend in Columns');
});

// ---- Task 3: the timeline section of board.css ------------------------------------------------------------------------------------------------

interface Rule { selectors: string[]; decls: Array<[string, string]>; media: string }
/** The rules of a stylesheet (comments removed), each with the @media block it sits in ('' at the top level). */
function rulesOf(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const walk = (body: string, media: string): void => {
    let i = 0;
    while (i < body.length) {
      const open = body.indexOf('{', i);
      if (open < 0) break;
      const head = body.slice(i, open).trim();
      // Find the matching close brace.
      let depth = 1;
      let j = open + 1;
      while (j < body.length && depth > 0) { if (body[j] === '{') depth += 1; else if (body[j] === '}') depth -= 1; j += 1; }
      const inner = body.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(inner, head);
      else {
        const decls = inner.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const k = d.indexOf(':'); return [d.slice(0, k).trim(), d.slice(k + 1).trim().replace(/\s*!important$/, '')] as [string, string]; });
        out.push({ selectors: head.split(',').map((s) => s.trim().replace(/\s+/g, ' ')), decls, media });
      }
      i = j;
    }
  };
  walk(text, '');
  return out;
}
function timelineCss(): string {
  const css = readFileSync(path.join(ROOT, 'media', 'board', 'board.css'), 'utf8');
  const parts = css.split('/* timeline */');
  assert.equal(parts.length, 2, 'board.css has exactly one /* timeline */ section');
  return parts[1]!;
}
const declOf = (rules: Rule[], selector: string, prop: string, media = ''): string[] =>
  rules.filter((r) => r.media === media && r.selectors.includes(selector)).flatMap((r) => r.decls.filter(([k]) => k === prop).map(([, v]) => v));

const NAMED = /\b(black|white|red|green|blue|yellow|orange|purple|gray|grey|pink|brown|cyan|magenta|lime|navy|teal|silver|maroon|olive|aqua|fuchsia|gold|indigo|violet)\b/i;
const SYSTEM = /\b(CanvasText|Canvas|Highlight|HighlightText|ButtonText|ButtonFace|LinkText|GrayText)\b/;

test('D-12: the timeline section uses only --vscode-* variables and color-mix of them; system colours only under forced-colors; nothing timeline.js writes is a colour literal', () => {
  const section = timelineCss();
  const bare = section.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(bare), 'no hex colour');
  assert.ok(!/\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\s*\(/i.test(bare), 'no colour function');
  const rules = rulesOf(section);
  assert.ok(rules.length > 40, 'the section has its rules');
  for (const r of rules) {
    for (const [prop, value] of r.decls) {
      const at = `${r.selectors.join(', ')} { ${prop}: ${value} }`;
      for (const m of value.matchAll(/var\(\s*--([\w-]+)/g)) assert.ok(m[1]!.startsWith('vscode-'), `${at}: only theme variables`);
      for (const m of value.matchAll(/color-mix\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) assert.match(m[1]!, /^in srgb, var\(--vscode-[\w-]+(, var\(--vscode-[\w-]+\))?\) \d+%, (transparent|var\(--vscode-[\w-]+\))$/, `${at}: color-mix of theme variables`);
      assert.ok(!NAMED.test(value.replace(/var\([^)]*\)/g, '')), `${at}: no named colour`);
      if (SYSTEM.test(value)) assert.equal(r.media, '@media (forced-colors: active)', `${at}: system colours only under forced colours`);
    }
  }
  assert.ok(rules.some((r) => r.media === '@media (forced-colors: active)' && r.decls.some(([, v]) => /\bCanvasText\b/.test(v))), 'forced colours use CanvasText');
  assert.ok(rules.some((r) => r.media === '@media (forced-colors: active)' && r.decls.some(([, v]) => /\bCanvas\b/.test(v))), 'and Canvas');
  assert.ok(rules.some((r) => r.media === '@media (forced-colors: active)' && r.decls.some(([, v]) => /\bHighlight\b/.test(v))), 'and Highlight');
  const page = readFileSync(path.join(ROOT, 'media', 'board', 'timeline.js'), 'utf8');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(page), 'timeline.js writes no hex colour');
  assert.ok(!/\b(rgb|rgba|hsl|hsla)\s*\(/i.test(page), 'timeline.js writes no colour function');
  assert.ok(!/setProperty\(\s*'(color|background|background-color|fill|stroke|border-color)'/.test(page), 'timeline.js sets no colour property');
});

test('D-05: each state colour is the UI-SPEC variable, held is a dashed 4 2 ring, filled marks draw their glyph in the editor background, and the Mine ring is the foreground', () => {
  const rules = rulesOf(timelineCss());
  const BLUE = 'var(--vscode-charts-blue, var(--vscode-editorInfo-foreground))';
  const PURPLE = 'var(--vscode-charts-purple, var(--vscode-foreground))';
  const MUTED = 'var(--vscode-descriptionForeground)';
  const expected: Record<string, string> = {
    ready: BLUE, claimed: BLUE, 'in-progress': BLUE, 'in-review': PURPLE, integrating: PURPLE, done: 'var(--vscode-testing-iconPassed)',
    blocked: 'var(--vscode-editorWarning-foreground)', backlog: MUTED, cancelled: MUTED, held: MUTED
  };
  for (const [state, colour] of Object.entries(expected)) {
    assert.deepEqual(declOf(rules, `.tl-dot[data-state="${state}"] .tl-mark`, 'color'), [colour], `${state} dots`);
    assert.deepEqual(declOf(rules, `.tl-legend-item[data-state="${state}"] .tl-mark`, 'color'), [colour], `${state} in the legend`);
  }
  assert.deepEqual(declOf(rules, '.tl-mark .tl-body', 'stroke'), ['currentColor']);
  assert.deepEqual(declOf(rules, '.tl-mark .tl-body', 'stroke-width'), ['2']);
  assert.deepEqual(declOf(rules, '.tl-mark .tl-body', 'fill'), ['var(--vscode-editor-background)'], 'a hollow ring is filled with the canvas colour');
  assert.deepEqual(declOf(rules, '.tl-dot.dashed .tl-body', 'stroke-dasharray'), ['4 2'], 'On hold is a dashed ring, 4 px dash and 2 px gap');
  assert.deepEqual(declOf(rules, '.tl-dot.filled .tl-body', 'fill'), ['currentColor']);
  assert.deepEqual(declOf(rules, '.tl-dot.filled .tl-glyph', 'stroke'), ['var(--vscode-editor-background)']);
  assert.deepEqual(declOf(rules, '.tl-mark .tl-pip', 'fill'), ['var(--vscode-editorInfo-foreground)']);
  assert.deepEqual(declOf(rules, '.tl-mark .tl-pip', 'stroke'), ['var(--vscode-editor-background)'], 'the pip has its background gap ring');
  assert.deepEqual(declOf(rules, '.tl-mark.tl-ring', 'outline'), ['2px solid var(--vscode-foreground)']);
  assert.deepEqual(declOf(rules, '.tl-mark.tl-ring', 'outline-offset'), ['2px']);
  assert.deepEqual(declOf(rules, '.tl-initials.mine', 'background'), ['var(--vscode-foreground)']);
  assert.deepEqual(declOf(rules, '.tl-initials.mine', 'color'), ['var(--vscode-editor-background)']);
  assert.deepEqual(declOf(rules, '.tl-line', 'stroke'), ['color-mix(in srgb, var(--vscode-foreground) 30%, transparent)'], 'lines at rest are faint');
  assert.deepEqual(declOf(rules, '.tl-ghost', 'border'), ['1px solid var(--vscode-descriptionForeground)']);
  assert.deepEqual(declOf(rules, '.tl-past', 'background'), ['color-mix(in srgb, var(--vscode-descriptionForeground) 8%, transparent)']);
  assert.deepEqual(declOf(rules, '.tl-phase-fill', 'background'), ['var(--vscode-progressBar-background)']);
  assert.deepEqual(declOf(rules, '.tl-ring-fill', 'stroke'), ['var(--vscode-progressBar-background)']);
});

test('TD-15, TD-16: opaque headers, pill, legend, preview and card, the shadow on the floating two only, the 2 px dot focus ring, high contrast rings and borders, the Now line and the layer order', () => {
  const rules = rulesOf(timelineCss());
  for (const selector of ['.tl-ms-head', '.tl-now-pill', '#tl-legend', '#tl-preview', '#tl-card', '.tl-filter-empty', '.tl-folded']) {
    const backgrounds = declOf(rules, selector, 'background');
    assert.equal(backgrounds.length, 1, `${selector} sets one background`);
    assert.match(backgrounds[0]!, /^var\(--vscode-[\w-]+(, var\(--vscode-[\w-]+\))?\)$/, `${selector} has an opaque theme background`);
  }
  assert.deepEqual(declOf(rules, '.tl-ms-head', 'position'), ['sticky']);
  const shadows = rules.filter((r) => r.decls.some(([k]) => k === 'box-shadow'));
  assert.deepEqual(shadows.flatMap((r) => r.selectors).sort(), ['#tl-card', '#tl-preview'], 'only the preview and the card carry a shadow');
  for (const r of shadows) assert.ok(r.decls.some(([k, v]) => k === 'box-shadow' && v.includes('var(--vscode-widget-shadow)')));
  assert.deepEqual(declOf(rules, '.tl-dot:focus-visible', 'outline'), ['2px solid var(--vscode-focusBorder)']);
  assert.deepEqual(declOf(rules, '.tl-dot:focus-visible', 'outline-offset'), ['2px']);
  for (const theme of ['vscode-high-contrast', 'vscode-high-contrast-light']) {
    assert.ok(declOf(rules, `body.${theme} .tl-mark`, 'outline').includes('1px solid var(--vscode-contrastBorder)'), `${theme}: marks get the 1 px contrast ring`);
    for (const surface of ['.tl-ms-head', '.tl-now-pill', '#tl-legend', '.tl-folded', '.tl-more', '#tl-preview', '#tl-card', '.tl-filter-empty']) {
      assert.ok(declOf(rules, `body.${theme} ${surface}`, 'border').includes('1px solid var(--vscode-contrastBorder)'), `${theme}: ${surface} has its border`);
    }
    assert.deepEqual(declOf(rules, `body.${theme} .tl-now-line`, 'background'), ['var(--vscode-contrastActiveBorder)'], `${theme}: the Now line`);
  }
  assert.deepEqual(declOf(rules, '.tl-now-line', 'background'), ['var(--vscode-progressBar-background)']);
  assert.deepEqual(declOf(rules, '.tl-now-pill', 'border'), ['1px solid var(--vscode-progressBar-background)']);
  assert.deepEqual(declOf(rules, '.tl-ms-head', 'z-index'), ['3']);
  assert.deepEqual(declOf(rules, '#tl-card', 'z-index'), ['6']);
  assert.deepEqual(declOf(rules, '#tl-preview', 'z-index'), ['7']);
  assert.deepEqual(declOf(rules, '#tl-preview', 'pointer-events'), ['none']);
  assert.ok(rules.every((r) => r.decls.every(([k, v]) => k !== 'z-index' || Number(v) < 10)), 'everything stays under the Move to... menu (10)');
});

test('motion: only transform, opacity and stroke-dashoffset are animated, and prefers-reduced-motion removes every timeline transition and animation', () => {
  const rules = rulesOf(timelineCss());
  const REDUCED = '@media (prefers-reduced-motion: reduce)';
  const moving = rules.filter((r) => r.media !== REDUCED && r.decls.some(([k]) => k === 'transition' || k === 'animation' || k === 'transition-property'));
  assert.ok(moving.length >= 3, 'the timeline declares its transitions');
  for (const r of moving) {
    for (const [k, v] of r.decls.filter(([key]) => key === 'transition' || key === 'transition-property')) {
      for (const part of v.split(',')) assert.match(part.trim(), /^(transform|opacity|stroke-dashoffset)\b/, `${r.selectors.join(', ')} { ${k}: ${v} } animates only transform, opacity or stroke-dashoffset`);
    }
  }
  const stilled = rules.filter((r) => r.media === REDUCED);
  for (const r of moving) {
    for (const selector of r.selectors) {
      assert.ok(selector.includes('tl-'), `${selector} is a timeline selector`);
      const off = stilled.filter((s) => s.selectors.includes(selector));
      assert.ok(off.some((s) => s.decls.some(([k, v]) => k === 'transition' && v === 'none')), `${selector}: no transition under reduced motion`);
      assert.ok(off.some((s) => s.decls.some(([k, v]) => k === 'animation' && v === 'none')), `${selector}: no animation under reduced motion`);
    }
  }
});

// 62.1-08 (found in the real window): a shown finished milestone has Fold milestone in its header's second row, and in a short band the progress
// words were cut with an ellipsis but no title (probe rule 12: cut only on purpose, with the full words in title). The progress words always carry
// their full text in title, as the milestone title does.
test('62.1-08: the header\'s progress words carry their full text in title, so a cut in a short band is on purpose', async () => {
  const world = await statesWorld();
  const model = modelOf(world, world.dev.memberId);
  const h = timelineOf(model);
  boardApi(h, 'setUiState')({ shown: { 'milestone:v0': true } });
  boardApi(h, 'redraw')();
  for (const band of model.timeline!.milestones) {
    const words = h.$(`li.tl-milestone[data-milestone="${band.id}"] .tl-ms-head .progress-text`)!;
    assert.equal(words.getAttribute('title'), band.progressText, `${band.id}: the full progress words are in title`);
  }
});
