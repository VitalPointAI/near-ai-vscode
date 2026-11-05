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
// 2-02 after both at step 3. The Now step is step 2 (1-03 is not finished yet).
async function liveWorld(): Promise<BoardWorld> {
  const world = await boardWorld();
  const { owner } = world;
  for (const body of [
    milestone('v1', 'Version 1', true), phase('1', 'v1', 'First work'), phase('2', 'v1', 'Second work'),
    plan('1-01', { state: 'done' }), plan('1-02', { state: 'done', dependsOn: ['plan:1-01'] }), plan('1-03', { dependsOn: ['plan:1-01'] }),
    plan('2-01', { dependsOn: ['plan:1-02', 'plan:1-03'] }), plan('2-02', { dependsOn: ['plan:1-02', 'plan:1-03'] })
  ]) world.accept(owner, 'item.imported', body);
  setState(world.state, 'plan:1-03', 'in-progress');
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

  // The changed dots pulse for 600 ms and keep the board's 3 second outline; the others do neither.
  for (const id of ['plan:1-03', 'plan:2-02']) {
    assert.ok(has(dot(h, id), 'tl-pulse'), `${id} pulses`);
    assert.ok(has(dot(h, id), 'changed'), `${id} has the outline`);
  }
  for (const id of ['plan:1-01', 'plan:1-02', 'plan:2-01']) assert.ok(!has(dot(h, id), 'tl-pulse') && !has(dot(h, id), 'changed'), `${id} did not change`);

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

  // The fills: the toolbar ring, the band bar and the phase 1 fill move to the new values.
  const ring = h.$('.tl-ring-fill')!;
  const p = second.timeline!.percent!.percent!;
  assert.equal(ring.getAttribute('stroke-dashoffset'), (RING * (1 - p / 100)).toFixed(2), 'the ring has the new value');
  const bandBar = bandLi(h, 'milestone:v1').querySelector('.tl-ms-head .bar')!;
  const bandPct = second.timeline!.milestones.find((m) => m.id === 'milestone:v1')!.percent!.percent!;
  const oldBandPct = first.timeline!.milestones.find((m) => m.id === 'milestone:v1')!.percent!.percent!;
  assert.equal(styleOf(bandBar, 'width'), `${bandPct}%`, 'the band bar has the new width');
  assert.equal(styleOf(bandBar, 'transform'), `scaleX(${oldBandPct / bandPct})`, 'and starts at the old width');
  const phaseFill = h.$('li.tl-phase[data-phase="phase:1"] .tl-phase-fill')!;
  const phasePct = second.timeline!.milestones[0]!.phases.find((x) => x.id === 'phase:1')!.percent!.percent!;
  assert.equal(styleOf(phaseFill, 'transform'), `scaleX(${phasePct / 100})`);
  assert.ok(has(ring, 'tl-filling') && has(phaseFill, 'tl-filling'), 'the ring and the phase fill animate to the new value');

  // Two frames later every move runs (with will-change only while it runs), and the transforms are gone (the end state is the new place).
  h.advance(40);
  for (const n of [line, pill, shade]) {
    assert.ok(has(n, 'tl-glide'), `${n.className} glides`);
    assert.equal(styleOf(n, 'transform'), '', 'towards its own place');
    assert.equal(styleOf(n, 'will-change'), 'transform');
  }
  assert.ok(has(bandBar, 'tl-filling'), 'the band bar fills');
  assert.equal(styleOf(bandBar, 'transform'), '');
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
  assert.ok(summary!.startsWith('2 changes from your team: '), summary);
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
  setState(world.state, 'plan:2-01', 'ready');
  const third = modelOf(world, world.lead.memberId);
  assert.equal(third.timeline!.now!.step, 1, 'the Now step is the same');
  h.announcements.length = 0;
  h.deliver({ type: 'state', model: third });
  assert.equal(styleOf(h.$('.tl-now-line')!, 'transform'), '', 'the marker stays still');
  assert.ok(has(dot(h, 'plan:2-01'), 'tl-pulse'), 'the changed dot pulses');
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
