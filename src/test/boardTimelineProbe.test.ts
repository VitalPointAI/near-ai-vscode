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
const plainJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;
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

// ---- Task 2: every other rule -------------------------------------------------------------------------------------------------------------------

// The clean timeline with the expanded card open on plan 2-05, placed below its dot (a step with nothing under it), and with the preview of plan 1-05.
function withCard(): Data {
  const d = clean();
  d.timeline.card = {
    box: box(664, 304, 984, 504), alpha: 1, background: WIDGET, dotId: 'plan:2-05', titleClamped: false,
    texts: [
      { text: 'Plan 2-05', box: box(680, 316, 800, 336), cut: noCut(), color: FG, background: WIDGET, fontSize: 13 },
      { text: 'Ready', box: box(680, 344, 760, 360), cut: noCut(), color: FG, background: WIDGET, fontSize: 12 }
    ],
    buttons: [{ name: 'Close card', width: 28, height: 28 }, { name: 'Move to...', width: 88, height: 28 }]
  };
  return d;
}
function withPreview(): Data {
  const d = clean();
  d.timeline.preview = {
    box: box(216, 304, 472, 404), alpha: 1, background: WIDGET, dotId: 'plan:1-05',
    texts: [{ text: 'Done plan 1-05', box: box(228, 312, 400, 328), cut: noCut(), color: FG, background: WIDGET, fontSize: 12 }], buttons: []
  };
  return d;
}
const GREY_2_1 = 'rgb(81, 81, 81)';
const GREY_3_9 = 'rgb(129, 129, 129)';

test('the clean timeline stays clean with the expanded card open and with the preview shown', () => {
  assert.deepEqual(check(withCard()), []);
  assert.deepEqual(check(withPreview()), []);
});

test('rule 2: a dot outside the canvas, and a phase label cut without an ellipsis and a title', () => {
  expectOne((d) => { shift(d, 'plan:1-05', 0, 410); }, /^Dot plan 1-05 spills 6 px below the canvas$/);
  expectOne((d) => { d.timeline.phaseLabels[0].cut = { by: 14, ellipsis: false, title: false }; }, /^Phase label "Phase 1: First · 100%" is cut by 14 px without an ellipsis and a title$/);
  expectOne((d) => { d.timeline.phaseLabels[0].cut = { by: 14, ellipsis: true, title: false }; }, /^Phase label "Phase 1: First · 100%" is cut by 14 px without an ellipsis and a title$/);
  assert.deepEqual(check((() => { const d = clean(); d.timeline.phaseLabels[0].cut = { by: 14, ellipsis: true, title: true }; return d; })()), [], 'a cut on purpose (ellipsis and title) is fine');
  expectOne((d) => { d.timeline.headers[0].cut = { by: 30, ellipsis: false, title: false }; }, /^The title of milestone header v0\.5 is cut by 30 px without an ellipsis and a title$/);
});

test('rule 3: the expanded card partly outside the visible timeline area, or under a header held at the edge', () => {
  expectOne((d) => { d.timeline.card!.box = box(664, 304, 984, 820); }, /^The expanded card spills 28 px below the visible timeline area$/, withCard);
  expectOne((d) => { d.timeline.scroller.scrollLeft = 10; d.timeline.card!.box = box(300, 110, 440, 176); }, /^The expanded card is under the milestone header v0\.5$/, withCard);
});

test('rule 3: the preview may not cover its own dot', () => {
  expectOne((d) => { d.timeline.preview!.box = box(216, 280, 472, 380); }, /^The preview covers its own dot plan 1-05$/, withPreview);
});

test('rule 3: the expanded card title is never clamped', () => {
  expectOne((d) => { d.timeline.card!.titleClamped = true; }, /^The expanded card title is clamped$/, withCard);
});

test('rule 3: no text line in the expanded card is cut, and its text is at least 0.85 of the editor font size', () => {
  expectOne((d) => { d.timeline.card!.texts[0].cut = { by: 9, ellipsis: false, title: false }; }, /^A line in the expanded card is cut by 9 px: "Plan 2-05"$/, withCard);
  expectOne((d) => { d.timeline.preview!.texts[0].fontSize = 10; }, /^Text "Done plan 1-05" in the preview is 10 px, less than 85 percent of the 14 px editor font$/, withPreview);
});

test('rule 3: every button in the expanded card is at least 24 by 24 px', () => {
  expectOne((d) => { d.timeline.card!.buttons[0].height = 20; }, /^The Close card button in the expanded card is 28 by 20 px, smaller than 24 by 24 px$/, withCard);
});

test('rule 4: milestone headers, the legend band, the preview and the expanded card are opaque, read from rgba and color(srgb) values', () => {
  expectOne((d) => { d.timeline.headers[0].alpha = 0.6; }, /^The milestone header v0\.5 is not opaque \(alpha 0\.6\)$/);
  expectOne((d) => { const h = d.timeline.headers[0] as Record<string, unknown>; delete h.alpha; h.background = 'color(srgb 0.1 0.1 0.1 / 0.6)'; }, /^The milestone header v0\.5 is not opaque \(alpha 0\.6\)$/);
  expectOne((d) => { d.timeline.legend = { box: box(0, 100, 1400, 140), alpha: 0.95, background: 'rgba(30, 30, 30, 0.95)' }; }, /^The legend band is not opaque \(alpha 0\.95\)$/);
  expectOne((d) => { d.timeline.preview!.alpha = 0.9; }, /^The preview is not opaque \(alpha 0\.9\)$/, withPreview);
  expectOne((d) => { d.timeline.card!.alpha = 0; }, /^The expanded card is not opaque \(alpha 0\)$/, withCard);
});

test('rule 5: the page never scrolls in the Timeline view; the timeline area is the only scroller', () => {
  expectOne((d) => { d.page.scrollWidth = 1500; }, /^The page scrolls sideways by 100 px; only the timeline area may scroll$/);
  expectOne((d) => { d.page.scrollHeight = 900; }, /^The page scrolls down by 100 px; only the timeline area may scroll$/);
  expectOne((d) => { d.timeline.otherScrollers.push({ what: 'div.tl-legend' }); }, /^div\.tl-legend scrolls on its own; only the timeline area may scroll$/);
});

test('rule 6: the focused dot is fully visible and not under a sticky milestone header', () => {
  assert.deepEqual(check((() => { const d = clean(); d.timeline.focusedDot = 'plan:1-02'; return d; })()), [], 'a visible focused dot is fine');
  expectOne((d) => { d.timeline.scroller.scrollLeft = 10; shift(d, 'plan:1-01', 0, -118); d.timeline.focusedDot = 'plan:1-01'; }, /^The focused dot plan 1-01 is hidden under the milestone header v0\.5 \(22 px covered\)$/);
  expectOne((d) => { d.timeline.scroller.clientWidth = 700; d.timeline.focusedDot = 'plan:2-05'; }, /^The focused dot plan 2-05 is not fully visible in the timeline area$/);
});

test('rule 8: each line starts and ends within 2 px of its dots\' marks, or of the +n button or tile that holds a hidden card', () => {
  expectOne((d) => { d.timeline.lines[0].end = { x: 87, y: 282 }; }, /^The line from plan 1-01 to plan 1-02 ends 5 px away from plan 1-02$/);
  expectOne((d) => { d.timeline.lines[0].start = { x: 51, y: 282 }; }, /^The line from plan 1-01 to plan 1-02 starts 3 px away from plan 1-01$/);
  assert.deepEqual(check((() => { const d = clean(); d.timeline.lines[0].end = { x: 93.5, y: 282 }; return d; })()), [], 'within 2 px is attached');
  // A line to a card hidden in a stack ends at that step's +n button.
  const toStack = (d: Data): void => {
    d.timeline.more.push({ ...box(216, 308, 268, 336), milestone: 'm1', step: 3, text: '+2' });
    (d.timeline.lines as Array<Record<string, unknown>>).push({ from: 'plan:1-04', to: 'plan:1-09', start: rightMid(dotOf(d, 'plan:1-04').mark.box), end: { x: 216, y: 322 }, toBox: box(216, 308, 268, 336) });
  };
  assert.deepEqual(check((() => { const d = clean(); toStack(d); return d; })()), [], 'a line ending at the +n button of a hidden card is attached');
  expectOne((d) => { toStack(d); (d.timeline.lines[3] as Record<string, unknown>).toBox = null; }, /^The line from plan 1-04 to plan:1-09 ends at no dot, \+n button or tile$/);
});

test('rule 9: dot marks and glyphs are at least 3 to 1 against the canvas, read from rgb and color(srgb) values', () => {
  expectOne((d) => { dotOf(d, 'plan:1-01').mark.color = GREY_2_1; }, /^Dot plan 1-01's mark has a contrast of 2\.1 to 1 against the canvas, below 3 to 1$/);
  expectOne((d) => { dotOf(d, 'plan:1-01').mark.color = 'color(srgb 0.318 0.318 0.318)'; }, /^Dot plan 1-01's mark has a contrast of 2\.1 to 1 against the canvas, below 3 to 1$/);
  expectOne((d) => { dotOf(d, 'plan:1-02').mark.glyph = { color: GREY_2_1, background: SOLID }; }, /^Dot plan 1-02's glyph has a contrast of 2\.1 to 1, below 3 to 1$/);
});

test('rule 9: initials, preview and card text are at least 4.5 to 1 against their own background', () => {
  expectOne((d) => { d.timeline.card!.texts[1].color = GREY_3_9; }, /^Text "Ready" in the expanded card has a contrast of 3\.9 to 1, below 4\.5 to 1$/, withCard);
  expectOne((d) => { d.timeline.preview!.texts[0].color = 'color(srgb 0.506 0.506 0.506 / 1)'; }, /^Text "Done plan 1-05" in the preview has a contrast of 3\.9 to 1, below 4\.5 to 1$/, (() => { const d = withPreview(); d.timeline.preview!.texts[0].background = WIDGET; return d; }));
  expectOne((d) => { dotOf(d, 'plan:2-01').chip!.color = GREY_3_9; dotOf(d, 'plan:2-01').chip!.background = WIDGET; }, /^Dot plan 2-01's initials have a contrast of 3\.9 to 1, below 4\.5 to 1$/);
});

test('rule 10: every dot, tile and +n is at least 24 by 24 px, and neighbouring hit boxes are at least 4 px apart', () => {
  expectOne((d) => { shift(d, 'plan:1-04', -10, 0); }, /^Dots plan 1-02 and plan 1-04 are 2 px apart, less than 4 px$/);
  expectOne((d) => { const x = dotOf(d, 'plan:1-05'); x.box = box(216, 268, 236, 296); x.mark.box = box(216, 272, 236, 292); delete x.chip; }, /^Dot plan 1-05 is 20 by 28 px, smaller than 24 by 24 px$/);
  expectOne((d) => { d.timeline.more.push({ ...box(216, 308, 268, 330), milestone: 'm1', step: 3, text: '+2' }); }, /^The \+2 button at step 4 is 52 by 22 px, smaller than 24 by 24 px$/);
});

test('rule 11: the Now line crosses no dot and no label', () => {
  expectOne((d) => { d.timeline.now!.line = box(560, 212, 562, 336); }, /^The Now line crosses dot plan 2-02$/);
  expectOne((d) => { d.timeline.now!.line = box(593, 176, 595, 336); }, /^The Now line crosses phase label "Phase 2: Second · 40%"$/);
});

test('rule 11: the Now pill overlaps no dot, label, header, preview or expanded card', () => {
  expectOne((d) => { d.timeline.card!.box = box(720, 200, 1040, 400); }, /^The Now pill overlaps the expanded card$/, withCard);
  expectOne((d) => { d.timeline.now!.pill = box(480, 240, 530, 280); }, /^The Now pill overlaps dot plan 2-01$/);
  expectAmong((d) => { d.timeline.now!.pill = box(504, 160, 824, 200); }, /^The Now pill overlaps milestone header v0\.6$/);
});

test('rule 11: the Now pill is opaque', () => {
  expectOne((d) => { d.timeline.now!.alpha = 0.9; }, /^The Now pill is not opaque \(alpha 0\.9\)$/);
});

test('rule 11: the Now pill text is not cut, at least 0.85 of the editor font size and 4.5 to 1, and the Now line is 3 to 1 against the canvas', () => {
  expectOne((d) => { d.timeline.now!.fontSize = 9.8; }, /^Text in the Now pill is 9\.8 px, less than 85 percent of the 14 px editor font$/);
  expectOne((d) => { d.timeline.now!.cut = { by: 6, ellipsis: false, title: false }; }, /^Text in the Now pill is cut by 6 px$/);
  expectOne((d) => { d.timeline.now!.color = GREY_3_9; }, /^Text in the Now pill has a contrast of 3\.9 to 1, below 4\.5 to 1$/);
  expectOne((d) => { d.timeline.now!.lineColor = GREY_2_1; }, /^The Now line has a contrast of 2\.1 to 1 against the canvas, below 3 to 1$/);
});

test('rule 12: the overall progress text is not cut', () => {
  expectOne((d) => { d.timeline.overall!.cut = { by: 6, ellipsis: false, title: false }; }, /^The project progress "70% done" is cut by 6 px$/);
});

test('rule 12: a band percent never overlaps a dot, the preview or the expanded card, and every percent is readable', () => {
  expectOne((d) => { d.timeline.percents[2].box = box(472, 270, 512, 286); }, /^The band percent "40%" overlaps dot plan 2-01$/);
  expectOne((d) => { d.timeline.preview!.box = box(216, 304, 472, 404); d.timeline.percents[1].box = box(300, 380, 400, 396); }, /^The band progress "5 of 5 cards finished" overlaps the preview$/, withPreview);
  expectOne((d) => { d.timeline.percents[0].fontSize = 10; }, /^The band percent "100%" is 10 px, less than 85 percent of the 14 px editor font$/);
  expectOne((d) => { d.timeline.percents[3].color = GREY_3_9; d.timeline.percents[3].background = WIDGET; }, /^The band progress "2 of 5 cards finished" has a contrast of 3\.9 to 1, below 4\.5 to 1$/);
  expectOne((d) => { d.timeline.phaseLabels[1].fontSize = 10; }, /^Phase label "Phase 2: Second · 40%" is 10 px, less than 85 percent of the 14 px editor font$/);
  expectOne((d) => { d.timeline.card!.box = box(472, 150, 792, 250); }, /^Phase label "Phase 2: Second · 40%" overlaps the expanded card$/, (() => { const d = withCard(); d.timeline.now = null; d.timeline.percents.splice(2, 2); return d; }));
});

test('a badly broken timeline lists at most 12 sentences per rule and then one "And N more" line', () => {
  const d = clean();
  for (let i = 0; i < 20; i += 1) {
    const x = dot(`plan:9-${String(i + 1).padStart(2, '0')}`, `plan 9-${String(i + 1).padStart(2, '0')}`, 'm2', 5, i, 24 + i * 60, 500);
    x.mark.color = GREY_2_1;
    d.timeline.dots.push(x);
  }
  const problems = check(d);
  assert.equal(problems.length, 13, problems.join(' | '));
  assert.ok(problems.slice(0, 12).every((p) => /mark has a contrast of 2\.1 to 1/.test(p)));
  assert.equal(problems[12], 'And 8 more dot marks with too little contrast.');
});

test('first-screen facts: the Now pill and a dot of the Now step inside the visible timeline area (not a standing rule)', () => {
  const firstScreen = (data: Data) => JSON.parse(JSON.stringify(probeHarness.window.NearAiBoardLayout.firstScreenOf(JSON.parse(JSON.stringify(data)))));
  assert.deepEqual(firstScreen(clean()), { nowVisible: true, nowStepDotVisible: true });
  const narrow = clean();
  narrow.timeline.scroller.clientWidth = 700;
  assert.deepEqual(firstScreen(narrow), { nowVisible: false, nowStepDotVisible: true }, 'the pill reaches past the right edge, the Now step dot is in view');
  narrow.timeline.scroller.clientWidth = 500;
  assert.deepEqual(firstScreen(narrow), { nowVisible: false, nowStepDotVisible: false });
  assert.deepEqual(check(narrow), [], 'scrolled away from now is not a problem');
  const none = clean();
  none.timeline.now = null;
  assert.deepEqual(firstScreen(none), { nowVisible: false, nowStepDotVisible: false });
});

/** Breaks a rule that cannot break alone and expects exactly one problem matching this rule's sentence among the rest. */
function expectAmong(mutate: (data: Data) => void, pattern: RegExp, start: () => Data = clean): string {
  const data = start();
  mutate(data);
  const problems = check(data);
  const hits = problems.filter((problem) => pattern.test(problem));
  assert.equal(hits.length, 1, `exactly one problem matching ${pattern}, got: ${problems.join(' | ') || 'none'}`);
  return hits[0];
}

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

test('on test pages the report carries NearAiTimeline.metrics when it exists, and card text is judged on the first opaque background up the tree', async () => {
  const model = await timelineModel();
  const h = page(true);
  h.deliver({ type: 'state', model });
  h.$('#view-switch button[data-view="timeline"]')!.click();
  // 62.1-06: on a test page the timeline offers its own metrics, and the report carries them.
  const real = (await ask(h, { id: 1, action: 'measure' }))[0].report.timeline as Record<string, any>;
  assert.ok(real.metrics && typeof real.metrics === 'object', 'the timeline\'s own metrics are carried');
  assert.equal(typeof real.metrics.frames.count, 'number');
  assert.ok(real.metrics.drawMs === null || typeof real.metrics.drawMs === 'number');

  const base = h.window.NearAiTimeline as Record<string, unknown>;
  const { metrics: _own, ...without } = base;
  void _own;
  h.window.NearAiTimeline = Object.freeze(without);
  const before = (await ask(h, { id: 4, action: 'measure' }))[0].report.timeline as Record<string, unknown>;
  assert.equal('metrics' in before, false, 'no metrics while the timeline offers none');

  h.window.NearAiTimeline = Object.freeze({ ...base, metrics: () => ({ drawMs: 42, frames: { count: 3, p95: 16 } }) });
  const withMetrics = (await ask(h, { id: 2, action: 'measure' }))[0].report.timeline as Record<string, unknown>;
  assert.deepEqual(withMetrics.metrics, { drawMs: 42, frames: { count: 3, p95: 16 } });

  // A computed style for the fake page: only the expanded card paints a background; its text elements are transparent.
  h.window.getComputedStyle = (n: { id?: string }) => ({
    backgroundColor: n.id === 'tl-card' ? WIDGET : 'rgba(0, 0, 0, 0)', color: FG, fontSize: '13px', position: 'static', visibility: 'visible', display: 'block',
    textOverflow: 'clip', overflowX: 'visible', overflowY: 'visible', getPropertyValue: (key: string) => (key === '--vscode-editor-font-size' ? '14px' : '')
  });
  const doc = h.document;
  const card = doc.createElement('section');
  card.id = 'tl-card';
  const title = doc.createElement('h2');
  title.id = 'tl-card-title';
  title.textContent = 'Alpha slice';
  const row = doc.createElement('div');
  const state = doc.createElement('span');
  state.textContent = 'Ready';
  row.appendChild(state);
  card.append(title, row);
  h.$('.tl-scroll')!.appendChild(card);
  const measured = (await ask(h, { id: 3, action: 'measure' }))[0].report.timeline as Record<string, any>;
  assert.equal(measured.editorFontSize, 14);
  assert.ok(measured.card, 'the open card is measured');
  assert.equal(measured.card.alpha, 1);
  assert.deepEqual((measured.card.texts as Array<Record<string, unknown>>).map((t) => [t.text, t.background, t.color, t.fontSize]), [['Alpha slice', WIDGET, FG, 13], ['Ready', WIDGET, FG, 13]]);
  assert.equal(measured.card.titleClamped, false);
});

// 62.1-08: the real-window test aims its first click at the View switch while the page is still in Columns, where the report keeps its 62-16 keys.
// A question that asks for the controls gets the toolbar's View, Direction, zoom, Jump to now and legend boxes in either view; one that does not,
// gets none in Columns.
test('a measure that asks for the controls carries the View switch, Direction and zoom boxes in Columns and in the Timeline view', async () => {
  const model = await timelineModel();
  const h = page(true);
  h.deliver({ type: 'state', model });
  const plain = (await ask(h, { id: 1, action: 'measure' }))[0].report as Record<string, any>;
  assert.equal('controls' in plain, false, 'a plain Columns report has no controls');
  const columns = (await ask(h, { id: 2, action: 'measure', controls: true }))[0].report as Record<string, any>;
  assert.ok(columns.controls && typeof columns.controls === 'object', 'the Columns report carries the controls when asked');
  for (const key of ['columns', 'timeline']) assert.ok(columns.controls.view[key] && typeof columns.controls.view[key].left === 'number', `the View switch's ${key} box`);
  assert.deepEqual(Object.keys(columns.controls).sort(), ['direction', 'fit', 'legend', 'now', 'view', 'zoomIn', 'zoomOut']);
  h.$('#view-switch button[data-view="timeline"]')!.click();
  const timeline = (await ask(h, { id: 3, action: 'measure', controls: true }))[0].report as Record<string, any>;
  assert.deepEqual(plainJson(timeline.controls), plainJson(timeline.timeline.controls), 'in the Timeline view the asked controls are the timeline section\'s');
});

// 62.1-08: the real-window test clicks Move to... inside the expanded card, so each button in the preview and the card is measured with its box.
test('each button in the expanded card is reported with its box, so a real click can aim at it', async () => {
  const model = await timelineModel();
  const h = page(true);
  h.deliver({ type: 'state', model });
  h.$('#view-switch button[data-view="timeline"]')!.click();
  const doc = h.document;
  const card = doc.createElement('section');
  card.id = 'tl-card';
  const move = doc.createElement('button');
  move.textContent = 'Move to...';
  card.appendChild(move);
  h.$('.tl-scroll')!.appendChild(card);
  const measured = (await ask(h, { id: 1, action: 'measure' }))[0].report.timeline as Record<string, any>;
  assert.ok(measured.card, 'the card is measured');
  const button = (measured.card.buttons as Array<Record<string, any>>).find((b) => b.name === 'Move to...');
  assert.ok(button, 'Move to... is listed');
  assert.ok(button.box && typeof button.box === 'object', 'Move to... has its box');
  assert.deepEqual(Object.keys(button.box).sort(), ['bottom', 'height', 'left', 'right', 'top', 'width']);
});

// 62.1-08: the frame budget is read over one set of actions only (a pan, four zooms and two direction switches), so a question can ask the page to
// clear the timeline's frame sample once the report has read it.
test('a measure that asks to reset the metrics reports the sample, then clears it with NearAiTimeline.metrics({ reset: true })', async () => {
  const model = await timelineModel();
  const h = page(true);
  h.deliver({ type: 'state', model });
  h.$('#view-switch button[data-view="timeline"]')!.click();
  const base = h.window.NearAiTimeline as Record<string, unknown>;
  const calls: unknown[] = [];
  let sample = { drawMs: 12, frames: { count: 5, p95: 20 } };
  h.window.NearAiTimeline = Object.freeze({ ...base, metrics: (options?: unknown) => {
    calls.push(options === undefined ? 'read' : JSON.parse(JSON.stringify(options)));
    const out = sample;
    if (options && (options as { reset?: boolean }).reset === true) sample = { drawMs: 12, frames: { count: 0, p95: null as unknown as number } };
    return out;
  } });
  const plain = (await ask(h, { id: 1, action: 'measure' }))[0].report.timeline as Record<string, any>;
  assert.deepEqual(plain.metrics, { drawMs: 12, frames: { count: 5, p95: 20 } });
  assert.deepEqual(calls, ['read'], 'a plain measure only reads');
  const reset = (await ask(h, { id: 2, action: 'measure', resetMetrics: true }))[0].report.timeline as Record<string, any>;
  assert.deepEqual(reset.metrics, { drawMs: 12, frames: { count: 5, p95: 20 } }, 'the report carries the sample read before the reset');
  assert.deepEqual(calls, ['read', 'read', { reset: true }], 'then the sample is cleared');
  const after = (await ask(h, { id: 3, action: 'measure' }))[0].report.timeline as Record<string, any>;
  assert.equal(after.metrics.frames.count, 0, 'the next reading starts a new sample');
});
