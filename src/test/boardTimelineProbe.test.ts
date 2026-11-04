// The layout probe's timeline section (62.1-07, D-11, D-13, D-14, 62.1-UI-SPEC "Real-window probe rules" 1 to 10 and the amendment's rules 11
// and 12). media/board/layout-probe.js is test-only page code; when the page shows the Timeline view it measures the drawn timeline and turns every
// broken rule into one plain sentence. check() is pure, so each rule is proven here on hand-made measurements: a clean timeline gives no problem
// and breaking one rule gives exactly that rule's sentence. The page tests prove the gating, the report's timeline section and the scroll and focus
// actions in the fake DOM (which has no layout, so they do not judge the problems there).
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBoardModel } from '../domain/team/board';
import { buildTimeline } from '../domain/team/timeline';
import { createBoardHarness } from './helpers/fakeDom';
import type { BoardHarness } from './helpers/fakeDom';
import { boardWorld, seedStandardBoard } from './helpers/teamBoardWorld';

const NOW = Date.parse('2026-03-05T12:00:00.000Z');

function page(e2e: boolean): BoardHarness {
  const h = createBoardHarness({ width: 1400 });
  if (e2e) h.document.body.setAttribute('data-e2e', '1');
  h.load(['board.js', 'timeline.js', 'layout-probe.js']);
  return h;
}

// check() runs inside the page's realm; its answers are copied to plain values before any assertion compares them.
const probeHarness = page(true);
const check = (data: unknown): string[] => [...(probeHarness.window.NearAiBoardLayout.check(JSON.parse(JSON.stringify(data))) as string[])].map(String);

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Point = { x: number; y: number };
const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const moved = (b: Box, dx: number, dy: number): Box => box(b.left + dx, b.top + dy, b.right + dx, b.bottom + dy);
const FG = 'rgb(204, 204, 204)';
const SOLID = 'rgb(30, 30, 30)';
const WIDGET = 'rgb(37, 37, 38)';
const MARK = 'rgb(55, 148, 255)';
const ACCENT = 'rgb(14, 112, 192)';
const noCut = () => ({ by: 0, ellipsis: false, title: false });

interface Dot {
  id: string; label: string; milestone: string; step: number; slot: number; state: string; rendered: boolean; box: Box;
  mark: { box: Box; color: string; glyph: { color: string; background: string } };
  chip?: { box: Box; text: string; color: string; background: string; fontSize: number };
  idLabel?: { box: Box; text: string; color: string; background: string; fontSize: number };
}
// A dot button box at 100 % zoom (52 by 28): the 20 px mark 4 px in from its left and top, then the initials chip 4 px after the mark.
function dot(id: string, label: string, milestone: string, step: number, slot: number, left: number, top: number): Dot {
  return {
    id, label, milestone, step, slot, state: 'ready', rendered: true, box: box(left, top, left + 52, top + 28),
    mark: { box: box(left + 4, top + 4, left + 24, top + 24), color: MARK, glyph: { color: FG, background: SOLID } },
    chip: { box: box(left + 28, top + 4, left + 48, top + 24), text: 'DA', color: FG, background: SOLID, fontSize: 12 }
  };
}
const rightMid = (b: Box): Point => ({ x: b.right, y: (b.top + b.bottom) / 2 });
const leftMid = (b: Box): Point => ({ x: b.left, y: (b.top + b.bottom) / 2 });

// A clean horizontal timeline at 1400 by 800 and 100 % zoom: the toolbar above the scroller, two milestone bands of five dots each (one step holds
// two), their headers and phase labels, two dependency lines attached to their marks, the band percents, the overall ring and the Now line and pill
// in the Now row of the second band. Everything keeps at least 4 px from its neighbours.
function clean() {
  const y0 = 268;
  const a = 24;
  const b = 472;
  const dots: Dot[] = [
    dot('plan:1-01', 'plan 1-01', 'm1', 0, 0, a, y0),
    dot('plan:1-02', 'plan 1-02', 'm1', 1, 0, a + 64, y0),
    dot('plan:1-03', 'plan 1-03', 'm1', 1, 1, a + 64, y0 + 40),
    dot('plan:1-04', 'plan 1-04', 'm1', 2, 0, a + 128, y0),
    dot('plan:1-05', 'plan 1-05', 'm1', 3, 0, a + 192, y0),
    dot('plan:2-01', 'plan 2-01', 'm2', 0, 0, b, y0),
    dot('plan:2-02', 'plan 2-02', 'm2', 1, 0, b + 64, y0),
    dot('plan:2-03', 'plan 2-03', 'm2', 2, 0, b + 128, y0),
    dot('plan:2-04', 'plan 2-04', 'm2', 2, 1, b + 128, y0 + 40),
    dot('plan:2-05', 'plan 2-05', 'm2', 3, 0, b + 192, y0)
  ];
  dots.forEach((d) => { if (d.milestone === 'm1') d.state = 'done'; });
  const byId = (id: string): Dot => dots.find((d) => d.id === id)!;
  const line = (from: string, to: string) => ({ from, to, start: rightMid(byId(from).mark.box), end: leftMid(byId(to).mark.box) });
  return {
    width: 1400, height: 800, layout: 'kanban', theme: 'dark',
    page: { scrollWidth: 1400, clientWidth: 1400, scrollHeight: 800, clientHeight: 800, scrollY: 0 },
    outside: [] as Array<{ what: string; right: number }>,
    toolbar: { ...box(0, 0, 1400, 100), background: SOLID, position: 'sticky' },
    region: null, headRow: null, heads: [], lanes: [], cells: [], cards: [], openWork: 10,
    timeline: {
      view: 'timeline', direction: 'horizontal', horizontalDisabled: false, zoom: 100, editorFontSize: 14,
      canvas: { box: box(0, 100, 1400, 700), background: SOLID },
      scroller: { rect: box(0, 100, 1400, 800), scrollTop: 0, scrollLeft: 0, scrollWidth: 1400, scrollHeight: 700, clientWidth: 1400, clientHeight: 700 },
      otherScrollers: [] as Array<{ what: string }>,
      dots,
      more: [] as Array<Box & { milestone: string; step: number; text: string }>,
      tiles: [] as Array<Box & { milestone: string }>,
      phaseLabels: [
        { id: 'phase:1', milestone: 'm1', box: box(a, 180, a + 244, 196), text: 'Phase 1: First · 100%', cut: noCut(), color: FG, background: SOLID, fontSize: 12, percent: true },
        { id: 'phase:2', milestone: 'm2', box: box(b, 180, b + 244, 196), text: 'Phase 2: Second · 40%', cut: noCut(), color: FG, background: SOLID, fontSize: 12, percent: true }
      ],
      headers: [
        { id: 'm1', title: 'v0.5', box: box(0, 116, 320, 172), sticky: true, alpha: 1, background: SOLID, cut: noCut() },
        { id: 'm2', title: 'v0.6', box: box(448, 116, 768, 172), sticky: true, alpha: 1, background: SOLID, cut: noCut() }
      ],
      percents: [
        { milestone: 'm1', what: 'band percent', box: box(200, 120, 240, 136), text: '100%', cut: noCut(), color: FG, background: SOLID, fontSize: 12 },
        { milestone: 'm1', what: 'band progress', box: box(110, 150, 300, 166), text: '5 of 5 cards finished', cut: noCut(), color: FG, background: SOLID, fontSize: 12 },
        { milestone: 'm2', what: 'band percent', box: box(648, 120, 688, 136), text: '40%', cut: noCut(), color: FG, background: SOLID, fontSize: 12 },
        { milestone: 'm2', what: 'band progress', box: box(558, 150, 748, 166), text: '2 of 5 cards finished', cut: noCut(), color: FG, background: SOLID, fontSize: 12 }
      ],
      lines: [line('plan:1-01', 'plan:1-02'), line('plan:1-02', 'plan:1-04'), line('plan:2-01', 'plan:2-02')],
      now: {
        milestone: 'm2', step: 2, line: box(593, 212, 595, 336), pill: box(504, 216, 824, 256), alpha: 1, background: WIDGET,
        text: 'Now: Phase 2, step 3 of 4 3 in progress, 2 ready · 40% of this milestone done', cut: noCut(), color: FG, fontSize: 12, lineColor: ACCENT
      } as Record<string, any> | null,
      overall: { box: box(900, 60, 1000, 80), text: '70% done', cut: noCut(), color: FG, background: SOLID, fontSize: 12 } as Record<string, any> | null,
      legend: null as null | { box: Box; alpha: number; background: string },
      preview: null as null | Record<string, any>,
      card: null as null | Record<string, any>,
      focusedDot: null as string | null,
      controls: {},
      firstScreen: { nowVisible: true, nowStepDotVisible: true }
    }
  };
}
type Data = ReturnType<typeof clean>;
const dotOf = (data: Data, id: string): Dot => data.timeline.dots.find((d) => d.id === id)!;

/** Moves a whole dot (box, mark, chip, ID label) and the ends of its lines, so only the rule under test breaks. */
function shift(data: Data, id: string, dx: number, dy: number): void {
  const d = dotOf(data, id);
  d.box = moved(d.box, dx, dy);
  d.mark.box = moved(d.mark.box, dx, dy);
  if (d.chip) d.chip.box = moved(d.chip.box, dx, dy);
  if (d.idLabel) d.idLabel.box = moved(d.idLabel.box, dx, dy);
  for (const l of data.timeline.lines) {
    if (l.from === id) l.start = { x: l.start.x + dx, y: l.start.y + dy };
    if (l.to === id) l.end = { x: l.end.x + dx, y: l.end.y + dy };
  }
}

/** Breaks one rule on a clean timeline and expects exactly one problem, matching the rule's sentence, with no dash in it. */
function expectOne(mutate: (data: Data) => void, pattern: RegExp, start: () => Data = clean): string {
  const data = start();
  mutate(data);
  const problems = check(data);
  assert.equal(problems.length, 1, `exactly one problem, got: ${problems.join(' | ') || 'none'}`);
  assert.match(problems[0], pattern);
  assert.ok(!/[–—]/.test(problems[0]), 'no dash characters in a problem');
  return problems[0];
}

// ---- Task 1: the tracer -------------------------------------------------------------------------------------------------------------------------

test('tracer: a clean timeline has no problem, and two dots that overlap by 6 px give exactly one plain sentence', () => {
  assert.deepEqual(check(clean()), [], 'a clean timeline is clean (the kanban first-screen rule does not apply to the timeline)');
  const text = expectOne((d) => { shift(d, 'plan:1-04', -18, 0); }, /^Dots plan 1-02 and plan 1-04 overlap by 6 px$/);
  assert.equal(text, 'Dots plan 1-02 and plan 1-04 overlap by 6 px');
});

test('rule 1: a dot and a phase label, two phase labels, a +n button and a dot, and two milestone headers may not overlap by more than 1 px', () => {
  assert.deepEqual(check((() => { const d = clean(); d.timeline.phaseLabels[0].box = box(24, 180, 70, 269); return d; })()), [], 'a 1 px overlap is within the tolerance');
  expectOne((d) => { d.timeline.phaseLabels[0].box = box(24, 180, 70, 271); }, /^Phase label "Phase 1: First · 100%" and dot plan 1-01 overlap by 3 px$/);
  expectOne((d) => { d.timeline.phaseLabels[1].box = box(260, 180, 716, 196); }, /^Phase labels "Phase 1: First · 100%" and "Phase 2: Second · 40%" overlap by 8 px$/);
  expectOne((d) => {
    d.timeline.more.push({ ...box(216, 292, 268, 320), milestone: 'm1', step: 3, text: '+3' });
  }, /^The \+3 button at step 4 and dot plan 1-05 overlap by 4 px$/);
  expectOne((d) => { d.timeline.headers[1].box = box(300, 116, 620, 172); }, /^Milestone headers v0\.5 and v0\.6 overlap by 20 px$/);
});

// ---- the page answer ----------------------------------------------------------------------------------------------------------------------------

// The probe waits two animation frames (each a fake timer) with a promise step between them, so time and the microtask queue take turns a few times.
async function settle(h: BoardHarness): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    h.advance(60);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
async function ask(h: BoardHarness, message: Record<string, unknown>): Promise<Array<Record<string, any>>> {
  const mark = h.posts.length;
  h.deliver({ type: 'e2e-layout', ...message });
  await settle(h);
  return h.posts.slice(mark).filter((p) => p.type === 'e2e-layout-report');
}

async function timelineModel() {
  const world = await boardWorld();
  seedStandardBoard(world);
  const model = buildBoardModel(world.state, { nowMs: NOW, status: { kind: 'live', text: 'Live' }, canWrite: true, viewerId: world.owner.memberId });
  model.timeline = buildTimeline(world.state, model, { viewerId: world.owner.memberId });
  return model;
}

test('the page answers with a timeline section in the Timeline view (view, direction, one entry per drawn dot), and none in Columns', async () => {
  const model = await timelineModel();
  const h = page(true);
  h.deliver({ type: 'state', model });

  // Columns: the kanban rules run as before and the report has no timeline section.
  const columns = await ask(h, { id: 1, action: 'measure' });
  assert.equal(columns.length, 1, 'exactly one answer');
  assert.equal(columns[0].report.layout, 'kanban');
  assert.equal(columns[0].report.timeline ?? null, null, 'no timeline section in Columns');
  assert.ok((columns[0].report.cards as unknown[]).length >= 3, 'the kanban cards are measured');

  h.$('#view-switch button[data-view="timeline"]')!.click();
  assert.equal(h.root.getAttribute('data-view'), 'timeline');
  const answers = await ask(h, { id: 2, action: 'measure' });
  assert.equal(answers.length, 1, 'exactly one answer');
  assert.equal(answers[0].id, 2);
  const report = answers[0].report as Record<string, any>;
  assert.ok(Array.isArray(report.problems));
  const tl = report.timeline as Record<string, any>;
  assert.ok(tl, 'the report has a timeline section');
  assert.equal(tl.view, 'timeline');
  assert.equal(tl.direction, 'horizontal');
  assert.equal(tl.horizontalDisabled, false);
  assert.equal(tl.zoom, 100);
  for (const key of ['scroller', 'dots', 'more', 'tiles', 'phaseLabels', 'headers', 'lines', 'now', 'overall', 'preview', 'card', 'focusedDot', 'controls', 'firstScreen']) {
    assert.ok(key in tl, `the timeline section has ${key}`);
  }
  assert.deepEqual(Object.keys(tl.scroller).filter((k) => ['rect', 'scrollTop', 'scrollLeft', 'scrollWidth', 'scrollHeight'].includes(k)).sort(), ['rect', 'scrollHeight', 'scrollLeft', 'scrollTop', 'scrollWidth']);
  const drawn = h.$$('button.tl-dot').map((b) => b.getAttribute('data-id'));
  assert.ok(drawn.length >= 3, 'the fake page draws the dots');
  assert.deepEqual((tl.dots as Array<Record<string, any>>).map((d) => d.id), drawn, 'one entry per drawn dot, in page order');
  const first = (tl.dots as Array<Record<string, any>>)[0];
  for (const key of ['id', 'step', 'slot', 'state', 'box', 'mark']) assert.ok(key in first, `a dot entry has ${key}`);
  assert.equal(first.step, Number(h.$$('button.tl-dot')[0].getAttribute('data-step')));
  assert.deepEqual(Object.keys(tl.firstScreen).sort(), ['nowStepDotVisible', 'nowVisible']);
  assert.equal(tl.focusedDot, null);

  // The scroll action scrolls the timeline scroller, and the focus action focuses the dot whose data-id matches.
  const scrolled = await ask(h, { id: 3, action: 'scroll', top: 40, left: 120 });
  assert.equal(scrolled.length, 1);
  assert.equal(h.$('.tl-scroll')!.scrollTop, 40);
  assert.equal(h.$('.tl-scroll')!.scrollLeft, 120);
  assert.equal(scrolled[0].report.timeline.scroller.scrollTop, 40);
  assert.equal(scrolled[0].report.timeline.scroller.scrollLeft, 120);
  const target = drawn[1]!;
  const focused = await ask(h, { id: 4, action: 'focus', itemId: target });
  assert.equal(focused.length, 1);
  assert.equal(h.focused().getAttribute('data-id'), target);
  assert.equal(focused[0].report.timeline.focusedDot, target);

  // Without data-e2e there is no probe and no answer.
  const plain = page(false);
  assert.equal(plain.window.NearAiBoardLayout, undefined, 'no probe without data-e2e');
  plain.deliver({ type: 'state', model });
  plain.$('#view-switch button[data-view="timeline"]')!.click();
  assert.equal((await ask(plain, { id: 5, action: 'measure' })).length, 0, 'no answer without data-e2e');
});
