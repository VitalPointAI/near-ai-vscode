// The board timeline brought to life (62.1-06, D-08, D-09, D-13, D-14, BOARD-02): live updates in place with the pulse, the gliding Now marker and the
// percent fills; zoom and pan; the first screen centred on now; Jump to now; every motion of the UI-SPEC with its reduced-motion alternative; and the
// test-only draw time and frame metrics. Every model comes from the real buildBoardModel and buildTimeline over a signed in-memory log; time is the
// harness's fake clock (an animation frame is a 16 ms timer), so every duration below is exact.
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
// Every message type the board page already posts (62.1-03): the timeline adds none (T-62.1-07).
const KNOWN_POSTS = new Set(['ready', 'visible', 'retry', 'import-plans', 'show-details', 'check-team', 'move', 'detail', 'assign', 'unassign', 'new-item', 'edit-item', 'choose-folders', 'draft', 'e2e-facts', 'e2e-layout']);
const RING = 2 * Math.PI * 7;

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

// milestone:v1 (active) has phase 1 with 1-01 (done) at step 1 and 1-02 (done) and 1-03 (in progress) after it at step 2, and phase 2 with 2-01 and
// 2-02 after both at step 3, then 2-03, 2-04 and 2-05 one after the other. The Now step is step 2 (1-03 is not finished yet).
// With withOld, a finished milestone:v0 (folded, 160 px) comes first, so the Version 1 band does not start at the canvas edge. With ahead, the work
// is further on: 1-03, 2-01, 2-02 and 2-03 are done (the Now step is step 5, 2-04) and 2-06, 2-07 and 2-08 follow 2-05, so the marker is in the
// middle of a band longer than the scroller.
async function liveWorld(options: { withOld?: boolean; ahead?: boolean } = {}): Promise<BoardWorld> {
  const world = await boardWorld();
  const { owner } = world;
  if (options.withOld === true) for (const body of [milestone('v0', 'Version 0'), phase('0', 'v0', 'Old work'), plan('0-01', { state: 'done' })]) world.accept(owner, 'item.imported', body);
  for (const body of [
    milestone('v1', 'Version 1', true), phase('1', 'v1', 'First work'), phase('2', 'v1', 'Second work'),
    plan('1-01', { state: 'done' }), plan('1-02', { state: 'done', dependsOn: ['plan:1-01'] }), plan('1-03', { dependsOn: ['plan:1-01'] }),
    plan('2-01', { dependsOn: ['plan:1-02', 'plan:1-03'] }), plan('2-02', { dependsOn: ['plan:1-02', 'plan:1-03'] }),
    plan('2-03', { dependsOn: ['plan:2-01'] }), plan('2-04', { dependsOn: ['plan:2-03'] }), plan('2-05', { dependsOn: ['plan:2-04'] })
  ]) world.accept(owner, 'item.imported', body);
  setState(world.state, 'plan:1-03', 'in-progress');
  if (options.ahead === true) {
    for (const body of [plan('2-06', { dependsOn: ['plan:2-05'] }), plan('2-07', { dependsOn: ['plan:2-06'] }), plan('2-08', { dependsOn: ['plan:2-07'] })]) world.accept(owner, 'item.imported', body);
    for (const id of ['plan:1-03', 'plan:2-01', 'plan:2-02', 'plan:2-03']) setState(world.state, id, 'done');
  }
  return world;
}

interface Start { width?: number; state?: unknown; reducedMotion?: boolean; e2e?: boolean; before?: (h: BoardHarness) => void }
function start(options: Start = {}): BoardHarness {
  const h = createBoardHarness({ width: options.width ?? 1400, ...(options.state === undefined ? {} : { state: options.state }), ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }) });
  if (options.e2e === true) h.document.body.setAttribute('data-e2e', '1');
  if (options.before) options.before(h);
  h.load([...BOARD_SCRIPTS]);
  return h;
}
/** Opens the board on this model and switches to the Timeline view, as a person does. */
function timelineOf(model: BoardModel, options: Start = {}): BoardHarness {
  const h = start(options);
  h.deliver({ type: 'state', model });
  const radio = h.$('#view-switch button[data-view="timeline"]');
  assert.ok(radio, 'the Timeline radio is drawn');
  radio.click();
  assert.equal(h.root.getAttribute('data-view'), 'timeline');
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
const plain = (v: unknown): any => JSON.parse(JSON.stringify(v));
const classes = (node: FakeNode | null): string[] => (node === null ? [] : node.className.split(/\s+/).filter(Boolean));
const has = (node: FakeNode | null, cls: string): boolean => classes(node).includes(cls);
const styleOf = (node: FakeNode, name: string): string => node.style.getPropertyValue(name);
const px = (node: FakeNode, name: string): number => Number(styleOf(node, name).replace('px', ''));
const dot = (h: BoardHarness, id: string): FakeNode => { const found = h.$(`button.tl-dot[data-id="${id}"]`); assert.ok(found, `the dot of ${id} is drawn`); return found; };
const scroller = (h: BoardHarness): FakeNode => { const s = h.$('div.tl-scroll'); assert.ok(s, 'the timeline scroller is drawn'); return s; };
const bandLi = (h: BoardHarness, id: string): FakeNode => { const li = h.$(`li.tl-milestone[data-milestone="${id}"]`); assert.ok(li, `the band of ${id} is drawn`); return li; };
const lastShade = (h: BoardHarness): FakeNode => { const all = h.$$('.tl-past'); assert.ok(all.length > 0, 'the past shade is drawn'); return all[all.length - 1]!; };
const zoomOf = (h: BoardHarness): number => (boardApi(h, 'uiState')() as { zoom: number }).zoom;
/** The geometry the page draws from, for this model and the page's saved choices. */
function geoOf(h: BoardHarness, model: BoardModel, extra: Record<string, unknown> = {}): any {
  const ui = plain(boardApi(h, 'uiState')());
  return plain(timelineApi(h, 'geometry')(model.timeline, { direction: boardApi(h, 'drawnDirection')(), zoom: ui.zoom, width: h.window.innerWidth, shown: ui.shown, ...extra }));
}
/** Lets every running animation and timer of the first open finish. */
const settle = (h: BoardHarness): void => { h.advance(4000); };
function onlyKnownPosts(h: BoardHarness): void {
  const types = [...new Set(h.posts.map((p) => String(p.type)))];
  assert.deepEqual(types.filter((t) => !KNOWN_POSTS.has(t)), [], 'no new message type');
}

// ---- Task 1: the tracer ---------------------------------------------------------------------------------------------------------------------------

test('tracer: a teammate finishes the last open plan of the Now step while a card is open; the timeline updates in place, the changed dots pulse and get the outline, the marker glides, the shade follows, the percents fill and the Now sentence is said once after the change summary', async () => {
  const world = await liveWorld();
  const first = modelOf(world, world.lead.memberId);
  assert.equal(first.timeline!.now!.step, 1, 'the Now step is step 2 at first');
  const h = timelineOf(first);
  settle(h);
  // An unrelated dot's card is open, the zoom is 150 % and the person scrolled.
  h.click(dot(h, 'plan:1-01'));
  const card = h.$('#tl-card')!;
  assert.ok(card, 'the card is open');
  boardApi(h, 'setUiState')({ zoom: 150 });
  boardApi(h, 'redraw')();
  settle(h);
  const s = scroller(h);
  s.scrollLeft = 120;
  s.scrollTop = 4;
  const focused = h.focused();
  assert.equal(focused, h.$('#tl-card-title'), 'focus is in the card');
  const before = geoOf(h, first);

  // A teammate: 1-03 is done (the Now step moves on to step 3) and 2-02 is in progress.
  setState(world.state, 'plan:1-03', 'done');
  setState(world.state, 'plan:2-02', 'in-progress');
  const second = modelOf(world, world.lead.memberId);
  assert.equal(second.timeline!.now!.step, 2, 'the Now step is step 3 now');
  h.announcements.length = 0;
  h.deliver({ type: 'state', model: second });
  const after = geoOf(h, second);

  // In place: the card, focus, zoom and scroll are where they were.
  assert.equal(h.$('#tl-card'), card, 'the card stays open');
  assert.equal(card.getAttribute('data-id'), 'plan:1-01');
  assert.equal(h.focused(), focused, 'focus stays in the card');
  assert.equal(zoomOf(h), 150, 'the zoom stays');
  assert.equal(h.$('#tl-zoom output')!.textContent, '150%');
  assert.deepEqual([s.scrollLeft, s.scrollTop], [120, 4], 'the scroll stays');
  assert.equal(dot(h, 'plan:1-03').getAttribute('data-state'), 'done', 'the new state is drawn');

  // The changed dots pulse for 600 ms and keep the board's 3 second outline (2-01 became Ready when what it waits for was done); the others do neither.
  assert.equal(dot(h, 'plan:2-01').getAttribute('data-state'), 'ready');
  for (const id of ['plan:1-03', 'plan:2-01', 'plan:2-02']) {
    assert.ok(has(dot(h, id), 'tl-pulse'), `${id} pulses`);
    assert.ok(has(dot(h, id), 'changed'), `${id} has the outline`);
  }
  for (const id of ['plan:1-01', 'plan:1-02']) assert.ok(!has(dot(h, id), 'tl-pulse') && !has(dot(h, id), 'changed'), `${id} did not change`);

  // The marker line and pill start at the old place (a transform from the new place) and glide 320 ms to the new one.
  const line = h.$('.tl-now-line')!;
  const pill = h.$('.tl-now-pill')!;
  const band = after.bands.find((b: any) => b.id === 'milestone:v1');
  assert.equal(px(line, 'left'), after.now.line.x - band.x, 'the line is placed at the geometry new place');
  assert.equal(px(pill, 'left'), after.now.pill.x - band.x, 'the pill too');
  const dx = before.now.line.x - after.now.line.x;
  assert.ok(dx < 0, 'the marker moves forward along the axis');
  assert.equal(styleOf(line, 'transform'), `translate(${dx}px, 0px)`, 'the line starts at its old place');
  assert.equal(styleOf(pill, 'transform'), `translate(${before.now.pill.x - after.now.pill.x}px, 0px)`, 'the pill starts at its old place');
  // The past shade grows to the new line from the band start.
  const shade = lastShade(h);
  assert.equal(px(shade, 'width'), after.now.line.x - band.x, 'the shade reaches the new line');
  const ratio = (before.now.line.x - band.x) / (after.now.line.x - band.x);
  assert.equal(styleOf(shade, 'transform'), `scaleX(${ratio})`, 'the shade starts at the old line');

  // The fills: the toolbar ring, the band bar and the phase 1 fill start at the old values and fill to the new ones.
  const ring = h.$('.tl-ring-fill')!;
  const p = second.timeline!.percent!.percent!;
  const p0 = first.timeline!.percent!.percent!;
  assert.notEqual(p, p0, 'the project percent changed');
  assert.equal(ring.getAttribute('stroke-dashoffset'), (RING * (1 - p / 100)).toFixed(2), 'the ring has the new value');
  assert.equal(styleOf(ring, 'stroke-dashoffset'), `${(RING * (1 - p0 / 100)).toFixed(2)}px`, 'and starts at the old one');
  const bandBar = bandLi(h, 'milestone:v1').querySelector('.tl-ms-head .bar')!;
  const bandPct = second.timeline!.milestones.find((m) => m.id === 'milestone:v1')!.percent!.percent!;
  const oldBandPct = first.timeline!.milestones.find((m) => m.id === 'milestone:v1')!.percent!.percent!;
  assert.equal(styleOf(bandBar, 'width'), `${bandPct}%`, 'the band bar has the new width');
  assert.equal(styleOf(bandBar, 'transform'), `scaleX(${oldBandPct / bandPct})`, 'and starts at the old width');
  const phaseFill = h.$('li.tl-phase[data-phase="phase:1"] .tl-phase-fill')!;
  const phasePct = second.timeline!.milestones[0]!.phases.find((x) => x.id === 'phase:1')!.percent!.percent!;
  const oldPhasePct = first.timeline!.milestones[0]!.phases.find((x) => x.id === 'phase:1')!.percent!.percent!;
  assert.equal(styleOf(phaseFill, 'transform'), `scaleX(${oldPhasePct / 100})`, 'the phase fill starts at the old value');
  assert.ok(!has(ring, 'tl-filling') && !has(phaseFill, 'tl-filling'), 'nothing moves before the start is drawn');

  // Two frames later every move runs (with will-change only while it runs), and the transforms are gone (the end state is the new place).
  h.advance(40);
  for (const n of [line, pill, shade]) {
    assert.ok(has(n, 'tl-glide'), `${n.className} glides`);
    assert.equal(styleOf(n, 'transform'), '', 'towards its own place');
    assert.equal(styleOf(n, 'will-change'), 'transform');
  }
  for (const n of [ring, bandBar, phaseFill]) assert.ok(has(n, 'tl-filling'), `${n.className} fills for 400 ms`);
  assert.equal(styleOf(bandBar, 'transform'), '', 'the band bar fills to its width');
  assert.equal(styleOf(ring, 'stroke-dashoffset'), '', 'the ring fills to its value');
  assert.equal(styleOf(phaseFill, 'transform'), `scaleX(${phasePct / 100})`, 'the phase fill fills to the new value');
  h.advance(330);
  for (const n of [line, pill, shade]) { assert.ok(!has(n, 'tl-glide'), 'the glide ends after 320 ms'); assert.equal(styleOf(n, 'will-change'), ''); }
  h.advance(100);
  for (const n of [ring, bandBar, phaseFill]) assert.ok(!has(n, 'tl-filling'), 'the fills end after 400 ms');
  h.advance(200);
  for (const id of ['plan:1-03', 'plan:2-02']) {
    assert.ok(!has(dot(h, id), 'tl-pulse'), `${id} pulsed once (600 ms)`);
    assert.ok(has(dot(h, id), 'changed'), `${id} keeps the outline`);
  }
  h.advance(2500);
  for (const id of ['plan:1-03', 'plan:2-02']) assert.ok(!has(dot(h, id), 'changed'), `${id} outline ends after 3 seconds`);

  // One batched announcement of the teammates' changes, then the Now sentence, once.
  const said = h.announcements.join(' | ');
  const sentence = second.timeline!.now!.sentence;
  const summary = h.announcements.find((a) => /from your team/.test(a));
  assert.ok(summary, `the board's change summary is said: ${said}`);
  assert.ok(summary!.startsWith('3 changes from your team: '), summary);
  assert.ok(summary!.endsWith(sentence), `the Now sentence follows the summary: ${summary}`);
  assert.equal(h.announcements.filter((a) => a.includes(sentence)).length, 1, 'once');
  assert.equal(said.split(sentence).length - 1, 1, 'said once in all');
  onlyKnownPosts(h);
});

test('D-08 reduced motion: the same update applies at once with no pulse, glide or fill, and the static outline still shows', async () => {
  const world = await liveWorld();
  const first = modelOf(world, world.lead.memberId);
  const h = timelineOf(first, { reducedMotion: true });
  settle(h);
  setState(world.state, 'plan:1-03', 'done');
  setState(world.state, 'plan:2-02', 'in-progress');
  const second = modelOf(world, world.lead.memberId);
  const motionClasses = ['tl-pulse', 'tl-glide', 'tl-filling', 'tl-appear', 'tl-moving'];
  const seen = new Set<string>();
  const look = (): void => { for (const n of h.$$('#root *')) for (const c of classes(n)) if (motionClasses.includes(c)) seen.add(c); };
  h.deliver({ type: 'state', model: second });
  look();
  const after = geoOf(h, second);
  const band = after.bands.find((b: any) => b.id === 'milestone:v1');
  const line = h.$('.tl-now-line')!;
  assert.equal(px(line, 'left'), after.now.line.x - band.x, 'the marker is at its new place');
  assert.equal(styleOf(line, 'transform'), '', 'with no transform: it jumps');
  assert.equal(styleOf(h.$('.tl-now-pill')!, 'transform'), '');
  assert.equal(styleOf(lastShade(h), 'transform'), '', 'the shade is there at once');
  const bandBar = bandLi(h, 'milestone:v1').querySelector('.tl-ms-head .bar')!;
  assert.equal(styleOf(bandBar, 'transform'), '', 'the band bar is at its value at once');
  for (const id of ['plan:1-03', 'plan:2-02']) assert.ok(has(dot(h, id), 'changed'), `${id} has the static outline`);
  for (const ms of [16, 16, 100, 300, 600]) { h.advance(ms); look(); }
  assert.deepEqual([...seen], [], 'no motion class is ever added');
  h.advance(3000);
  assert.ok(!has(dot(h, 'plan:1-03'), 'changed'), 'the outline still ends after 3 seconds');
});

test('BOARD-02: with the tab hidden nothing is drawn; on show the cached model draws in place, with no first-draw stagger', async () => {
  const world = await liveWorld();
  const h = timelineOf(modelOf(world, world.lead.memberId));
  settle(h);
  h.setVisible(false);
  setState(world.state, 'plan:1-03', 'done');
  h.deliver({ type: 'state', model: modelOf(world, world.lead.memberId) });
  assert.equal(dot(h, 'plan:1-03').getAttribute('data-state'), 'in-progress', 'nothing is drawn while hidden');
  h.setVisible(true);
  assert.equal(dot(h, 'plan:1-03').getAttribute('data-state'), 'done', 'on show the cached model draws');
  assert.deepEqual(h.$$('.tl-appear').map((n) => n.getAttribute('data-id')), [], 'no first-draw stagger the second time');
  assert.ok(has(dot(h, 'plan:1-03'), 'changed'), 'the change is outlined');
});

test('D-13: a model where the Now step did not change announces no Now sentence, and the marker does not move', async () => {
  const world = await liveWorld();
  const h = timelineOf(modelOf(world, world.lead.memberId));
  settle(h);
  setState(world.state, 'plan:1-03', 'in-review');
  const third = modelOf(world, world.lead.memberId);
  assert.equal(third.timeline!.now!.step, 1, 'the Now step is the same');
  h.announcements.length = 0;
  h.deliver({ type: 'state', model: third });
  assert.equal(styleOf(h.$('.tl-now-line')!, 'transform'), '', 'the marker stays still');
  assert.ok(has(dot(h, 'plan:1-03'), 'tl-pulse'), 'the changed dot pulses');
  h.advance(6000);
  assert.ok(h.announcements.some((a) => /1 change from your team/.test(a)), `the change is said: ${h.announcements.join(' | ')}`);
  assert.deepEqual(h.announcements.filter((a) => a.includes('Now:')), [], 'no Now sentence');
});

// milestone:v0 is finished (it starts folded); milestone:v1 (active) has 1-01 done and 1-02 not yet; milestone:v2 has 3-01.
async function foldWorld(): Promise<BoardWorld> {
  const world = await boardWorld();
  const { owner } = world;
  for (const body of [
    milestone('v0', 'Version 0'), phase('0', 'v0', 'Old work'), plan('0-01', { state: 'done' }),
    milestone('v1', 'Version 1', true), phase('1', 'v1', 'First work'), plan('1-01', { state: 'done' }), plan('1-02', { dependsOn: ['plan:1-01'] }),
    milestone('v2', 'Version 2'), phase('3', 'v2', 'Later work'), plan('3-01')
  ]) world.accept(owner, 'item.imported', body);
  return world;
}
const folded = (h: BoardHarness, id: string): boolean => bandLi(h, id).getAttribute('data-folded') === 'true';

test('D-09: a milestone that becomes finished while it is shown stays shown for the session and starts folded on the next open; one that stops being finished unfolds by itself and stays unfolded', async () => {
  const world = await foldWorld();
  const h = timelineOf(modelOf(world, world.lead.memberId));
  settle(h);
  assert.ok(folded(h, 'milestone:v0'), 'the finished milestone starts folded');
  assert.ok(!folded(h, 'milestone:v1'));
  // v1 is finished by a teammate: the Now marker moves on to v2, and v1 stays shown.
  setState(world.state, 'plan:1-02', 'done');
  const done = modelOf(world, world.lead.memberId);
  assert.equal(done.timeline!.milestones.find((m) => m.id === 'milestone:v1')!.finished, true);
  assert.equal(done.timeline!.now!.milestoneId, 'milestone:v2');
  h.deliver({ type: 'state', model: done });
  assert.ok(!folded(h, 'milestone:v1'), 'it stays shown in this session');
  boardApi(h, 'redraw')();
  assert.ok(!folded(h, 'milestone:v1'), 'also on the next draw');
  // The next open (a new page with the saved choices) starts it folded.
  const next = start({ state: h.state });
  next.deliver({ type: 'state', model: done });
  assert.equal(next.root.getAttribute('data-view'), 'timeline');
  assert.ok(folded(next, 'milestone:v1'), 'it starts folded on the next open');

  // v0 is reopened: it unfolds by itself; finished again, it stays unfolded.
  setState(world.state, 'plan:0-01', 'backlog');
  h.deliver({ type: 'state', model: modelOf(world, world.lead.memberId) });
  assert.ok(!folded(h, 'milestone:v0'), 'it unfolds by itself');
  setState(world.state, 'plan:0-01', 'done');
  h.deliver({ type: 'state', model: modelOf(world, world.lead.memberId) });
  assert.ok(!folded(h, 'milestone:v0'), 'and stays unfolded');
  assert.equal(plain(boardApi(h, 'uiState')()).shown['milestone:v0'], true, 'the choice is saved');
  const later = start({ state: h.state });
  later.deliver({ type: 'state', model: modelOf(world, world.lead.memberId) });
  assert.ok(!folded(later, 'milestone:v0'), 'also on the next open');
});

// ---- Task 2: zoom, pan, Fit milestone, the first screen, saved scroll and Jump to now --------------------------------------------------------------

/** Where the page scrolls to centre a point: the middle of the scroller on it, kept inside the canvas. */
const centre = (mid: number, size: number, total: number): number => Math.max(0, Math.min(Math.max(0, total - size), Math.round(mid - size / 2)));
const markOf = (geo: any, id: string): { x: number; y: number } => { const d = geo.dots.find((x: any) => x.id === id); assert.ok(d, `${id} has a box`); return { x: d.x + 14, y: d.cy }; };
const zoomButton = (h: BoardHarness, kind: string): FakeNode => { const b = h.$(`#tl-zoom button[data-zoom="${kind}"]`); assert.ok(b, `the ${kind} zoom button is drawn`); return b; };
const direction = (h: BoardHarness, d: string): void => { h.$(`#direction-switch button[data-direction="${d}"]`)!.click(); };
const savedScroll = (h: BoardHarness): any => (h.state as any).timeline.scroll;
/** A scroll the person makes: the scroller moves and says so, and the debounced save runs. */
function scrollTo(h: BoardHarness, left: number, top: number): void {
  const s = scroller(h);
  s.scrollLeft = left;
  s.scrollTop = top;
  h.fire(s, 'scroll', { bubbles: false });
  h.advance(400);
}

test('D-09 Zoom: Zoom out and Zoom in step through 50, 75, 100, 150 and 200, disabled at the ends, the output and its name follow, each change is said and saved, and only the spacing changes', async () => {
  const world = await liveWorld();
  const h = timelineOf(modelOf(world, world.lead.memberId));
  settle(h);
  const zin = zoomButton(h, 'in');
  const zout = zoomButton(h, 'out');
  const level = h.$('#tl-zoom output')!;
  const lefts = new Map<number, number>();
  const check = (want: number): void => {
    assert.equal(zoomOf(h), want, `zoom ${want}`);
    assert.equal(level.textContent, `${want}%`);
    assert.equal(level.getAttribute('aria-label'), `Zoom ${want}%`);
    assert.equal((h.state as any).timeline.zoom, want, 'the level is saved');
    h.advance(200);
    assert.ok(h.announcements.includes(`Zoom ${want}%.`), `said: ${h.announcements.join(' | ')}`);
    const geo = geoOf(h, modelOf(world, world.lead.memberId));
    for (const d of h.$$('button.tl-dot')) {
      assert.equal(styleOf(d, 'height'), '28px', 'a dot box is 28 px tall at every zoom');
      assert.equal(styleOf(d, 'width'), `${geo.box.w}px`, 'and as wide as its content');
      assert.equal(d.querySelector('svg.tl-mark')!.getAttribute('width'), '20', 'the mark stays 20 px');
    }
    assert.equal(styleOf(h.$('.tl-canvas')!, 'transform'), '', 'no scale on the canvas');
    lefts.set(want, px(dot(h, 'plan:2-05'), 'left'));
    settle(h);
  };
  for (const want of [150, 200]) { h.click(zin); check(want); }
  assert.equal(zin.getAttribute('aria-disabled'), 'true', 'Zoom in is disabled at 200 %');
  h.click(zin);
  assert.equal(zoomOf(h), 200, 'and does nothing there');
  for (const want of [150, 100, 75, 50]) { h.click(zout); check(want); }
  assert.equal(zout.getAttribute('aria-disabled'), 'true', 'Zoom out is disabled at 50 %');
  assert.equal(zin.getAttribute('aria-disabled'), null);
  h.click(zout);
  assert.equal(zoomOf(h), 50);
  assert.ok(lefts.get(200)! > lefts.get(100)! && lefts.get(100)! > lefts.get(50)!, 'the positions spread out with the zoom');
  onlyKnownPosts(h);
});

test('D-09 keys: with focus in the timeline + and = zoom in, - zooms out and 0 goes back to 100; with Ctrl or Cmd held they are left to VS Code', async () => {
  const world = await liveWorld();
  const h = timelineOf(modelOf(world, world.lead.memberId));
  settle(h);
  dot(h, 'plan:1-03').focus();
  const press = (k: string, init: Record<string, unknown> = {}): boolean => h.press(h.focused(), k, init).defaultPrevented;
  assert.ok(press('+', { shiftKey: true }), '+ is taken (typed with Shift)');
  assert.equal(zoomOf(h), 150);
  assert.ok(press('='));
  assert.equal(zoomOf(h), 200);
  assert.ok(press('-'));
  assert.equal(zoomOf(h), 150);
  assert.ok(press('0'));
  assert.equal(zoomOf(h), 100);
  assert.equal(h.focused(), dot(h, 'plan:1-03'), 'focus stays on the dot');
  assert.ok(!press('-', { ctrlKey: true }), 'Ctrl+- is VS Code\'s');
  assert.ok(!press('=', { metaKey: true }), 'Cmd+= is VS Code\'s');
  assert.equal(zoomOf(h), 100);
});

test('D-09 wheel: Ctrl plus wheel zooms one level per 100 units anchored at the pointer, a plain wheel is not taken, and in horizontal a vertical wheel with no vertical room pans along the axis', async () => {
  const world = await liveWorld();
  const model = modelOf(world, world.lead.memberId);
  const h = timelineOf(model, { width: 600 });
  settle(h);
  const s = scroller(h);
  scrollTo(h, 0, 0);
  const before = geoOf(h, model);
  const at = markOf(before, 'plan:2-04');
  const client = { clientX: at.x - s.scrollLeft, clientY: at.y - s.scrollTop };
  const wheel = (init: Record<string, unknown>): boolean => h.fire(dot(h, 'plan:2-04'), 'wheel', { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, ...client, ...init }).defaultPrevented;
  assert.ok(wheel({ ctrlKey: true, deltaY: -100 }), 'Ctrl plus wheel is taken');
  assert.equal(zoomOf(h), 150, 'one level in');
  const after = geoOf(h, model);
  const moved = markOf(after, 'plan:2-04');
  assert.equal(s.scrollLeft, centre(moved.x - client.clientX + 300, 600, after.width), 'the dot stays under the pointer along the axis');
  assert.equal(s.scrollTop, Math.max(0, Math.round(moved.y - client.clientY)), 'and across it');
  h.advance(200);
  assert.ok(h.announcements.includes('Zoom 150%.'));
  // A trackpad pinch arrives as small Ctrl wheel steps: one level per 100 units.
  settle(h);
  assert.ok(wheel({ ctrlKey: true, deltaY: 50 }));
  assert.equal(zoomOf(h), 150, 'half a step does nothing yet');
  assert.ok(wheel({ ctrlKey: true, deltaY: 50 }));
  assert.equal(zoomOf(h), 100, 'the second half zooms out one level');
  // A plain wheel is the browser's.
  settle(h);
  boardApi(h, 'setUiState')({ zoom: 200 });
  boardApi(h, 'redraw')();
  settle(h);
  scrollTo(h, 0, 0);
  const plainGeo = geoOf(h, model);
  assert.ok(plainGeo.width > 600 && plainGeo.height <= 600, 'the canvas is wider than the scroller and has no vertical room');
  assert.ok(!wheel({ deltaY: 120 }), 'a plain wheel is not prevented');
  assert.equal(zoomOf(h), 200, 'and does not zoom');
  assert.equal(s.scrollLeft, 120, 'with no vertical room it pans along the axis');
  assert.ok(!wheel({ deltaX: 30, deltaY: 0 }), 'a sideways wheel is native');
  assert.equal(s.scrollLeft, 120, 'and left to the browser');
});

test('D-09 pan: a drag on empty canvas pans after 4 px with the grabbing cursor, a press and release without moving closes the card, and a press on a dot never pans', async () => {
  const world = await liveWorld();
  const h = timelineOf(modelOf(world, world.lead.memberId), { width: 600 });
  settle(h);
  boardApi(h, 'setUiState')({ zoom: 200 });
  boardApi(h, 'redraw')();
  settle(h);
  const s = scroller(h);
  const canvas = h.$('.tl-canvas')!;
  scrollTo(h, 100, 0);
  h.click(dot(h, 'plan:1-03'));
  assert.ok(h.$('#tl-card'), 'a card is open');
  const down = h.fire(canvas, 'pointerdown', { clientX: 300, clientY: 300, button: 0, pointerId: 1, pointerType: 'mouse' });
  assert.ok(!down.defaultPrevented || true);
  h.fire(canvas, 'pointermove', { clientX: 297, clientY: 300, buttons: 1, pointerId: 1 });
  assert.equal(s.scrollLeft, 100, '3 px does nothing');
  assert.ok(!has(canvas, 'tl-grabbing'));
  h.fire(canvas, 'pointermove', { clientX: 295, clientY: 300, buttons: 1, pointerId: 1 });
  assert.equal(s.scrollLeft, 105, 'at 5 px the scroller pans by the move');
  assert.ok(has(canvas, 'tl-grabbing'), 'with the grabbing cursor');
  h.fire(canvas, 'pointermove', { clientX: 280, clientY: 300, buttons: 1, pointerId: 1 });
  assert.equal(s.scrollLeft, 120);
  h.fire(canvas, 'pointerup', { clientX: 280, clientY: 300, button: 0, pointerId: 1 });
  h.click(canvas);
  assert.ok(!has(canvas, 'tl-grabbing'), 'the cursor is back');
  assert.ok(h.$('#tl-card'), 'the click that ends a pan does not close the card');
  // A press and release without movement closes it.
  h.fire(canvas, 'pointerdown', { clientX: 300, clientY: 300, button: 0, pointerId: 1, pointerType: 'mouse' });
  h.fire(canvas, 'pointerup', { clientX: 300, clientY: 300, button: 0, pointerId: 1 });
  h.click(canvas);
  h.advance(200);
  assert.equal(h.$('#tl-card'), null, 'a press without movement closes the card');
  assert.equal(s.scrollLeft, 120);
  // A press on a dot never pans.
  const d = dot(h, 'plan:1-02');
  h.fire(d, 'pointerdown', { clientX: 300, clientY: 300, button: 0, pointerId: 1, pointerType: 'mouse' });
  h.fire(d, 'pointermove', { clientX: 260, clientY: 300, buttons: 1, pointerId: 1 });
  assert.equal(s.scrollLeft, 120, 'a press on a dot does not pan');
  assert.ok(!has(canvas, 'tl-grabbing'));
  h.fire(d, 'pointerup', { clientX: 260, clientY: 300, button: 0, pointerId: 1 });
});

test('D-09 Fit milestone: the largest level at which the Now band fits the scroller along the axis, at least 50, and the band centred', async () => {
  const world = await liveWorld({ withOld: true });
  const model = modelOf(world, world.lead.memberId);
  const h = timelineOf(model, { width: 600 });
  settle(h);
  const fit = zoomButton(h, 'fit');
  assert.equal(fit.textContent, 'Fit milestone');
  const lengths = new Map([50, 75, 100, 150, 200].map((z) => [z, geoOf(h, model, { zoom: z }).bands.find((b: any) => b.id === 'milestone:v1').w as number]));
  const best = [200, 150, 100, 75, 50].find((z) => lengths.get(z)! <= 600) ?? 50;
  assert.equal(best, 150, `the fixture fits at 150 (${[...lengths].join(' ')})`);
  h.announcements.length = 0;
  h.click(fit);
  assert.equal(zoomOf(h), 150, 'Fit milestone picks 150');
  const geo = geoOf(h, model);
  const band = geo.bands.find((b: any) => b.id === 'milestone:v1');
  assert.equal(scroller(h).scrollLeft, centre(band.x + band.w / 2, 600, geo.width), 'and centres the band');
  h.advance(200);
  assert.ok(h.announcements.includes('Zoom 150%.'), h.announcements.join(' | '));
  // A wide window fits it at 200 %; a band longer than the scroller at every level takes 50 %.
  const wide = timelineOf(model, { width: 1400 });
  settle(wide);
  wide.click(zoomButton(wide, 'fit'));
  assert.equal(zoomOf(wide), 200);
  const narrow = timelineOf(model, { width: 530 });
  settle(narrow);
  boardApi(narrow, 'setUiState')({ zoom: 200 });
  boardApi(narrow, 'redraw')();
  const longest = [50, 75, 100, 150, 200].map((z) => geoOf(narrow, model, { zoom: z }).bands.find((b: any) => b.id === 'milestone:v1').w as number);
  narrow.click(zoomButton(narrow, 'fit'));
  assert.equal(zoomOf(narrow), [200, 150, 100, 75, 50].find((z, i) => longest[4 - i]! <= 530) ?? 50, 'the largest that fits at 530 px');
});

test('D-09, D-13 first screen: the first open of a direction centres the Now marker along the axis at 0 across, later opens restore the saved scroll of that direction; no Now centres the active band', async () => {
  const world = await liveWorld({ withOld: true, ahead: true });
  const model = modelOf(world, world.lead.memberId);
  const h = timelineOf(model, { width: 600 });
  const s = scroller(h);
  let geo = geoOf(h, model);
  const mid = geo.now.line.x + geo.now.line.w / 2;
  assert.ok(mid - 300 > 0 && mid + 300 < geo.width, 'the fixture puts the marker where centring it is neither 0 nor the far end');
  assert.equal(s.scrollLeft, centre(mid, 600, geo.width), 'the Now line is in the middle along the axis');
  assert.equal(s.scrollTop, 0, 'across the axis 0');
  settle(h);
  scrollTo(h, 50, 0);
  assert.deepEqual(savedScroll(h).horizontal, { x: 50, y: 0 }, 'the scroll is saved for the direction');
  direction(h, 'vertical');
  geo = geoOf(h, model);
  assert.equal(geo.direction, 'vertical');
  assert.equal(s.scrollTop, centre(geo.now.line.y + geo.now.line.h / 2, 600, geo.height), 'the first vertical open centres the marker too');
  assert.equal(s.scrollLeft, 0);
  settle(h);
  scrollTo(h, 0, 40);
  direction(h, 'horizontal');
  assert.deepEqual([s.scrollLeft, s.scrollTop], [50, 0], 'back to horizontal: its saved scroll');
  assert.deepEqual(savedScroll(h).vertical, { x: 0, y: 40 }, 'the vertical scroll was saved on the way');
  settle(h);
  h.$('#view-switch button[data-view="columns"]')!.click();
  h.$('#view-switch button[data-view="timeline"]')!.click();
  assert.deepEqual([scroller(h).scrollLeft, scroller(h).scrollTop], [50, 0], 'a later open restores it');
  // The next page restores the saved scroll as well.
  const next = start({ width: 600, state: h.state });
  next.deliver({ type: 'state', model });
  assert.deepEqual([scroller(next).scrollLeft, scroller(next).scrollTop], [50, 0]);

  // With no Now in the model, the active milestone's band is centred.
  const none = plain(model) as BoardModel;
  delete none.timeline!.now;
  const q = timelineOf(none, { width: 600 });
  const g = geoOf(q, none);
  const band = g.bands.find((b: any) => b.id === 'milestone:v1');
  assert.equal(scroller(q).scrollLeft, centre(band.x + band.w / 2, 600, g.width), 'the active band is centred');
});

test('D-04, D-09: switching from Columns with a card selected focuses its dot and centres it, over the Now centring; a card opened in the timeline is the selected card in Columns', async () => {
  const world = await liveWorld({ withOld: true, ahead: true });
  const model = modelOf(world, world.lead.memberId);
  const h = start({ width: 600 });
  h.deliver({ type: 'state', model });
  boardApi(h, 'select')('plan:2-08');
  h.$('#view-switch button[data-view="timeline"]')!.click();
  assert.equal(h.focused(), dot(h, 'plan:2-08'), 'the selected card\'s dot has focus');
  const geo = geoOf(h, model);
  const at = markOf(geo, 'plan:2-08');
  assert.equal(scroller(h).scrollLeft, centre(at.x, 600, geo.width), 'and is centred');
  assert.notEqual(scroller(h).scrollLeft, centre(geo.now.line.x + geo.now.line.w / 2, 600, geo.width), 'which wins over the Now centring');
  settle(h);
  h.click(dot(h, 'plan:1-03'));
  h.$('#view-switch button[data-view="columns"]')!.click();
  assert.equal(boardApi(h, 'selected')(), 'plan:1-03', 'the expanded card is the selected card in Columns');
});

test('D-13 Jump to now and N: the Now line is centred with a smooth scroll (a jump under reduced motion), focus moves to the Now dot and the Now sentence is said', async () => {
  for (const reducedMotion of [false, true]) {
    const world = await liveWorld({ withOld: true, ahead: true });
    const model = modelOf(world, world.lead.memberId);
    const h = timelineOf(model, { width: 600, reducedMotion });
    settle(h);
    const s = scroller(h);
    const calls: Array<Record<string, unknown>> = [];
    s.scrollTo = (o: Record<string, unknown>): void => { calls.push(plain(o)); s.scrollLeft = Number(o.left); s.scrollTop = Number(o.top); };
    const geo = geoOf(h, model);
    const want = { left: centre(geo.now.line.x + geo.now.line.w / 2, 600, geo.width), top: 0, behavior: reducedMotion ? 'auto' : 'smooth' };
    scrollTo(h, 0, 0);
    dot(h, 'plan:2-08').focus();
    h.announcements.length = 0;
    const jump = h.$('#tl-now')!;
    assert.equal(jump.textContent, 'Jump to now');
    h.click(jump);
    assert.deepEqual(calls, [want], `Jump to now scrolls the marker to the middle (${reducedMotion ? 'reduced' : 'smooth'})`);
    assert.equal(h.focused(), dot(h, 'plan:2-04'), 'focus is on the first unfinished dot of the Now step');
    h.advance(200);
    assert.ok(h.announcements.includes(model.timeline!.now!.sentence), h.announcements.join(' | '));
    // N does the same from the keyboard.
    calls.length = 0;
    scrollTo(h, 0, 0);
    dot(h, 'plan:2-08').focus();
    h.press(h.focused(), 'n');
    assert.deepEqual(calls, [want], 'N centres the marker');
    assert.equal(h.focused(), dot(h, 'plan:2-04'));
  }
});
