// The timeline's pure geometry (62.1-03 Task 3, 62.1-UI-SPEC "Timeline geometry", "Pitches by zoom", "Horizontal", "Vertical", "Stacks taller than
// the cap", "Folded finished milestones" and the amendment's Now row and Now gap): window.NearAiTimeline.geometry, run in the fake DOM's vm, places
// every band, phase label, dot, +{n} box, folded tile, empty band and the Now marker with fixed pitches, and these tests prove that nothing touches
// at every zoom level, in both directions and at three widths, without a browser.
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createBoardHarness } from './helpers/fakeDom';

interface Rect { x: number; y: number; w: number; h: number }
interface Geometry {
  width: number; height: number; direction: string; zoom: number;
  bands: Array<Rect & { id: string; folded: boolean; empty: boolean; header: Rect; nowRow?: Rect; nowGap?: Rect; gutter?: Rect; emptyBox?: Rect; notice?: Rect; phases: Array<{ id: string; bar: Rect; label: Rect & { hidden?: boolean }; row: number }> }>;
  dots: Array<Rect & { id: string; cx: number; cy: number }>;
  more: Array<{ milestoneId: string; step: number; slot: number; rect: Rect; hidden: number }>;
  tiles: Array<{ milestoneId: string; rect: Rect }>;
  now?: { line: Rect; pill: Rect };
}
type Options = { direction: string; zoom: number; width: number; shown?: Record<string, boolean>; openStacks?: Record<string, boolean> };

// ---- hand-made timelines (the shape of model.timeline that the geometry reads) -----------------------------------------------------------------

interface Dot { cardId: string; milestoneId: string; phaseId?: string; step: number; slot: number }
interface Band { id: string; title: string; finished: boolean; foldedByDefault: boolean; steps: number; cardCount: number; cycle: boolean; phases: Array<{ id: string; number: string; firstStep: number; lastStep: number }> }
interface Timeline { milestones: Band[]; dots: Dot[]; now?: { milestoneId: string; step: number; stepCount: number; allDone: boolean } }

/** A band from cells of [phase number or '' for no phase, step, number of cards]; slots follow the cell order inside each step. */
function band(id: string, cells: Array<[string, number, number]>, extra: Partial<Band> = {}): { band: Band; dots: Dot[] } {
  const dots: Dot[] = [];
  const slots = new Map<number, number>();
  const spans = new Map<string, { first: number; last: number }>();
  let n = 0;
  for (const [phase, step, count] of [...cells].sort((a, b) => a[1] - b[1])) {
    for (let i = 0; i < count; i += 1) {
      const slot = slots.get(step) ?? 0;
      slots.set(step, slot + 1);
      n += 1;
      dots.push({ cardId: `${id}/${phase || 'x'}/${step}/${slot}/${n}`, milestoneId: id, ...(phase ? { phaseId: `phase:${phase}` } : {}), step, slot });
    }
    if (phase) {
      const span = spans.get(phase);
      if (span === undefined) spans.set(phase, { first: step, last: step }); else { span.first = Math.min(span.first, step); span.last = Math.max(span.last, step); }
    }
  }
  const phases = [...spans.entries()].map(([number, span]) => ({ id: `phase:${number}`, number, firstStep: span.first, lastStep: span.last })).sort((a, b) => a.firstStep - b.firstStep || Number(a.number) - Number(b.number));
  const steps = dots.length === 0 ? 0 : Math.max(...dots.map((d) => d.step)) + 1;
  return { band: { id, title: id, finished: false, foldedByDefault: false, steps, cardCount: dots.length, cycle: false, phases, ...extra }, dots };
}
function timelineOf(parts: Array<{ band: Band; dots: Dot[] }>, now?: Timeline['now']): Timeline {
  return { milestones: parts.map((p) => p.band), dots: parts.flatMap((p) => p.dots), ...(now ? { now } : {}) };
}

const chain = (id: string, length: number, phase = '1'): { band: Band; dots: Dot[] } => band(id, Array.from({ length }, (_, s) => [phase, s, 1] as [string, number, number]));
// A step with 30 parallel cards between two single steps.
const wide = (id: string): { band: Band; dots: Dot[] } => band(id, [['2', 0, 1], ['2', 1, 30], ['2', 2, 1]]);
// Phase 3 runs steps 0 to 3 and phase 4 steps 1 to 2, so their spans interleave; phase 5 follows them.
const interleaved = (id: string): { band: Band; dots: Dot[] } => band(id, [['3', 0, 1], ['3', 1, 1], ['4', 1, 2], ['4', 2, 1], ['3', 3, 2], ['5', 4, 1], ['5', 5, 3]]);
const loop = (id: string): { band: Band; dots: Dot[] } => { const b = band(id, [['6', 0, 1], ['6', 1, 1], ['6', 2, 1], ['7', 2, 1]]); b.band.cycle = true; return b; };
const finished = (id: string): { band: Band; dots: Dot[] } => { const b = band(id, [['8', 0, 2], ['8', 1, 3]]); b.band.finished = true; b.band.foldedByDefault = true; return b; };
const empty = (id: string): { band: Band; dots: Dot[] } => band(id, []);
const boardBand = (): { band: Band; dots: Dot[] } => band('board', [['', 0, 2], ['', 1, 1]]);

// The mixed project: a folded finished milestone, the interleaved phases (Now in its middle), a loop, an empty milestone, the 30-card stack, then the
// cards added on the board.
function mixed(): Timeline {
  const parts = [finished('m:old'), interleaved('m:now'), loop('m:loop'), empty('m:empty'), wide('m:wide'), boardBand()];
  return timelineOf(parts, { milestoneId: 'm:now', step: 2, stepCount: parts[1]!.band.steps, allDone: false });
}
function chainOnly(): Timeline { const c = chain('m:chain', 20); return timelineOf([c], { milestoneId: 'm:chain', step: 0, stepCount: 20, allDone: false }); }
function allDone(): Timeline {
  const a = finished('m:a');
  const b = chain('m:b', 6, '9');
  b.band.finished = true; b.band.foldedByDefault = true;
  return timelineOf([a, b], { milestoneId: 'm:b', step: 6, stepCount: 6, allDone: true });
}

// ---- the page's geometry in the vm --------------------------------------------------------------------------------------------------------

const harness = createBoardHarness({ width: 1400 });
harness.load(['board.js', 'timeline.js']);
/** The page's geometry function, checked to exist before it is called. */
function geometryFn(): (t: unknown, o: unknown) => any {
  const api = harness.window.NearAiTimeline as { geometry?: (t: unknown, o: unknown) => unknown } | undefined;
  assert.equal(typeof api?.geometry, 'function', 'timeline.js exports NearAiTimeline.geometry');
  return api!.geometry! as (t: unknown, o: unknown) => any;
}
function geometry(timeline: Timeline, options: Options): Geometry {
  // Plain objects on both sides, so the comparisons below never meet the vm's own prototypes.
  return JSON.parse(JSON.stringify(geometryFn()(JSON.parse(JSON.stringify(timeline)), JSON.parse(JSON.stringify(options))))) as Geometry;
}

const ZOOMS = [50, 75, 100, 150, 200] as const;
const BOX: Record<number, [number, number]> = { 50: [28, 28], 75: [28, 28], 100: [52, 28], 150: [52, 28], 200: [96, 28] };
// [step pitch along the axis, stack pitch across it]
const PITCH: Record<string, Record<number, [number, number]>> = {
  horizontal: { 50: [32, 32], 75: [48, 40], 100: [64, 40], 150: [96, 40], 200: [128, 40] },
  vertical: { 50: [32, 32], 75: [32, 48], 100: [40, 64], 150: [60, 96], 200: [80, 128] }
};
const WIDTHS = [480, 900, 1400] as const;
const gutterFor = (width: number): number => (width >= 900 ? 160 : width >= 520 ? 120 : 64);

/** The distance between two boxes: negative when they overlap, 0 when they touch. */
const gap = (a: Rect, b: Rect): number => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
const right = (r: Rect): number => r.x + r.w;
const bottom = (r: Rect): number => r.y + r.h;
const label = (where: string, r: Rect): string => `${where} ${JSON.stringify(r)}`;

/** Every rule of the UI-SPEC geometry that holds for any timeline, for one zoom, direction and width. */
function checkLayout(name: string, timeline: Timeline, options: Options, g: Geometry): void {
  const at = `${name} ${options.direction} ${options.zoom}% ${options.width}px`;
  const direction = options.width < 520 ? 'vertical' : options.direction;
  assert.equal(g.direction, direction, `${at}: drawn direction`);
  const [bw, bh] = BOX[options.zoom]!;
  const [along, across] = PITCH[direction]![options.zoom]!;
  const horizontal = direction === 'horizontal';
  // Dot boxes: at least 28 by 28, exactly the zoom's size (zoom changes spacing only).
  for (const d of g.dots) {
    assert.ok(d.w >= 28 && d.h >= 28, `${at}: dot ${d.id} is at least 28 by 28`);
    assert.deepEqual([d.w, d.h], [bw, bh], `${at}: dot ${d.id} size`);
    assert.equal(d.cx, d.x + d.w / 2, `${at}: centre x`);
    assert.equal(d.cy, d.y + d.h / 2, `${at}: centre y`);
  }
  for (const m of g.more) assert.deepEqual([m.rect.w, m.rect.h], [bw, bh], `${at}: the +n box is a dot box`);
  // No two dot boxes (with the +n boxes), no two shown phase labels, and no label and dot box come closer than 4 px.
  const dotBoxes: Array<[string, Rect]> = [...g.dots.map((d) => [`dot ${d.id}`, d] as [string, Rect]), ...g.more.map((m) => [`more ${m.milestoneId}:${m.step}`, m.rect] as [string, Rect])];
  const labels: Array<[string, Rect]> = g.bands.flatMap((b) => b.phases.filter((p) => !p.label.hidden).map((p) => [`label ${b.id} ${p.id}`, p.label] as [string, Rect]));
  const all = [...dotBoxes, ...labels];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const [na, a] = all[i]!;
      const [nb, b] = all[j]!;
      assert.ok(gap(a, b) >= 4, `${at}: ${label(na, a)} and ${label(nb, b)} are ${gap(a, b)} px apart`);
    }
  }
  // Every box inside the canvas, 32 px from the far edges.
  const content: Array<[string, Rect]> = [...all, ...g.tiles.map((t) => [`tile ${t.milestoneId}`, t.rect] as [string, Rect]), ...g.bands.filter((b) => b.emptyBox).map((b) => [`empty ${b.id}`, b.emptyBox!] as [string, Rect])];
  if (g.now) content.push(['pill', g.now.pill], ['now line', g.now.line]);
  for (const [n, r] of content) {
    assert.ok(r.x >= 0 && r.y >= 0, `${at}: ${label(n, r)} starts inside the canvas`);
    assert.ok(right(r) <= g.width - 32 && bottom(r) <= g.height - 32, `${at}: ${label(n, r)} keeps 32 px from the far edges of ${g.width} by ${g.height}`);
  }
  for (const b of g.bands) {
    assert.ok(b.x >= 0 && b.y >= 0 && right(b) <= g.width && bottom(b) <= g.height, `${at}: band ${b.id} inside the canvas`);
    assert.ok(right(b.header) <= right(b) && bottom(b.header) <= bottom(b), `${at}: band ${b.id} header inside its band`);
  }
  // Bands follow each other 48 px apart, in the timeline's order.
  assert.deepEqual(g.bands.map((b) => b.id), timeline.milestones.map((m) => m.id), `${at}: one band per milestone, in order`);
  for (let i = 1; i < g.bands.length; i += 1) {
    const [a, b] = [g.bands[i - 1]!, g.bands[i]!];
    assert.equal(horizontal ? b.x - right(a) : b.y - bottom(a), 48, `${at}: ${a.id} and ${b.id} are 48 px apart`);
  }
  // Dot centres follow the pitch table exactly: along the axis by step (plus the vertical Now gap), across it by slot.
  const dotsOf = new Map(timeline.dots.map((d) => [d.cardId, d]));
  for (const b of g.bands) {
    const mine = g.dots.filter((d) => dotsOf.get(d.id)!.milestoneId === b.id);
    if (mine.length === 0) continue;
    const first = mine[0]!;
    const f = dotsOf.get(first.id)!;
    const nowGap = !horizontal && timeline.now !== undefined && timeline.now.milestoneId === b.id ? timeline.now.step : Infinity;
    const offset = (step: number): number => step * along + (step >= nowGap ? 56 : 0);
    for (const d of mine) {
      const m = dotsOf.get(d.id)!;
      const alongDelta = horizontal ? d.cx - first.cx : d.cy - first.cy;
      const acrossDelta = horizontal ? d.cy - first.cy : d.cx - first.cx;
      assert.equal(alongDelta, offset(m.step) - offset(f.step), `${at}: ${d.id} along the axis`);
      assert.equal(acrossDelta, (m.slot - f.slot) * across, `${at}: ${d.id} across the axis`);
    }
    // The first step starts after the band's 24 px padding.
    if (horizontal) assert.equal(Math.min(...mine.map((d) => d.x)), b.x + 24, `${at}: ${b.id} starts 24 px in`);
    // 62.1-04: a band with a loop keeps an 80 px row for its notice under the header.
    else assert.equal(Math.min(...mine.map((d) => d.y)), b.y + 56 + (b.notice ? 80 : 0) + 24 + (nowGap === 0 ? 56 : 0), `${at}: ${b.id} starts under its header and 24 px in`);
  }
  // 62.1-04: the loop notice is in its band, exactly for a drawn band with a loop, and touches no dot box or label.
  for (const b of g.bands) {
    const cycle = timeline.milestones.find((m) => m.id === b.id)!.cycle === true && !b.folded && !b.empty;
    assert.equal(!!b.notice, cycle, `${at}: ${b.id} has a notice exactly when it is a drawn band with a loop`);
    if (!b.notice) continue;
    assert.ok(b.notice.x >= b.x && right(b.notice) <= right(b) && b.notice.y >= b.y && bottom(b.notice) <= bottom(b), `${at}: ${b.id} notice inside its band`);
    assert.ok(right(b.notice) <= g.width - 32, `${at}: ${b.id} notice keeps 32 px from the far edge`);
    for (const [n, r] of all) assert.ok(gap(b.notice, r) >= 4, `${at}: ${b.id} notice touches no ${label(n, r)}`);
    if (g.now) assert.ok(gap(b.notice, g.now.pill) >= 4 && gap(b.notice, g.now.line) > 0, `${at}: ${b.id} notice is clear of the Now marker`);
  }
  // Folded tiles and empty bands.
  for (const b of g.bands) {
    const tile = g.tiles.find((t) => t.milestoneId === b.id);
    assert.equal(!!tile, b.folded, `${at}: ${b.id} has a tile exactly when folded`);
    if (tile) {
      if (horizontal) assert.equal(tile.rect.w, 160, `${at}: a folded tile is 160 px along the axis`);
      else { assert.equal(tile.rect.h, 56, `${at}: a folded tile is 56 px tall`); assert.equal(tile.rect.w, g.width - 48, `${at}: and spans the band`); }
      assert.equal(g.dots.some((d) => dotsOf.get(d.id)!.milestoneId === b.id), false, `${at}: a folded band draws no dots`);
    }
    if (b.empty) {
      assert.ok(b.emptyBox, `${at}: ${b.id} holds its No plans yet box`);
      if (horizontal) assert.equal(b.w, 160, `${at}: an empty band is 160 px along the axis`);
      else assert.equal(b.emptyBox!.h, 56, `${at}: an empty band's line is 56 px tall`);
    }
    if (!horizontal && !b.folded && !b.empty) assert.equal(b.gutter?.w, gutterFor(options.width), `${at}: ${b.id} gutter`);
  }
  // The Now row (horizontal, every drawn band) or the Now gap (vertical, the frontier band only), and the marker.
  const drawn = g.bands.filter((b) => !b.folded && !b.empty);
  if (horizontal) {
    for (const b of drawn) {
      assert.ok(b.nowRow, `${at}: ${b.id} has its Now row`);
      assert.equal(b.nowRow!.h, 48);
      const rail = b.phases.map((p) => bottom(p.bar));
      assert.ok(rail.every((y) => y + 8 <= b.nowRow!.y), `${at}: ${b.id} Now row is 8 px under the rail`);
      const top = Math.min(...g.dots.filter((d) => dotsOf.get(d.id)!.milestoneId === b.id).map((d) => d.y));
      assert.equal(top - bottom(b.nowRow!), 8, `${at}: ${b.id} Now row is 8 px over the first row of dots`);
      assert.equal(b.nowGap, undefined);
    }
  } else {
    for (const b of g.bands) assert.equal(b.nowRow, undefined, `${at}: no Now row in vertical`);
    for (const b of g.bands.filter((x) => x.id !== timeline.now?.milestoneId)) assert.equal(b.nowGap, undefined, `${at}: only the frontier band has the Now gap`);
  }
  if (timeline.now === undefined) { assert.equal(g.now, undefined); return; }
  const now = timeline.now;
  const nb = g.bands.find((b) => b.id === now.milestoneId)!;
  assert.ok(g.now, `${at}: the Now marker is placed`);
  const { line, pill } = g.now!;
  assert.deepEqual([pill.w, pill.h], [320, 40], `${at}: the pill box is 320 by 40`);
  assert.ok(pill.x >= nb.x && right(pill) <= right(nb) && pill.y >= nb.y && bottom(pill) <= bottom(nb), `${at}: the pill is inside its band`);
  for (const [n, r] of dotBoxes) {
    assert.ok(gap(line, r) > 0, `${at}: the Now line crosses no ${label(n, r)}`);
    assert.ok(gap(pill, r) >= 4, `${at}: the pill ${JSON.stringify(pill)} touches no ${label(n, r)}`);
  }
  for (const [n, r] of labels) assert.ok(gap(pill, r) >= 4, `${at}: the pill touches no ${label(n, r)}`);
  for (const b of g.bands) assert.ok(gap(pill, b.header) >= 4 || b.folded, `${at}: the pill is clear of ${b.id}'s header`);
  const bandDots = g.dots.filter((d) => dotsOf.get(d.id)!.milestoneId === nb.id);
  const before = bandDots.filter((d) => dotsOf.get(d.id)!.step < now.step);
  const after = bandDots.filter((d) => dotsOf.get(d.id)!.step >= now.step);
  if (horizontal) {
    assert.equal(line.w, 2);
    assert.ok(pill.x >= nb.nowRow!.x && pill.y >= nb.nowRow!.y && bottom(pill) <= bottom(nb.nowRow!), `${at}: the pill sits in the Now row`);
    assert.ok(pill.x <= line.x, `${at}: the pill starts on the line or left of it`);
    assert.equal(line.y, nb.nowRow!.y, `${at}: the line starts at the top of the Now row`);
    assert.equal(bottom(line), Math.max(...bandDots.map((d) => bottom(d)), ...g.more.filter((m) => m.milestoneId === nb.id).map((m) => bottom(m.rect))), `${at}: and ends under the tallest stack`);
    if (before.length) assert.ok(line.x > Math.max(...before.map(right)), `${at}: the line is after the step before Now`);
    if (after.length) assert.ok(right(line) < Math.min(...after.map((d) => d.x)), `${at}: the line is before the Now step`);
    if (!now.allDone) {
      const nowStep = bandDots.filter((d) => dotsOf.get(d.id)!.step === now.step);
      const prev = bandDots.filter((d) => dotsOf.get(d.id)!.step === now.step - 1);
      const mid = prev.length ? (Math.max(...prev.map(right)) + Math.min(...nowStep.map((d) => d.x))) / 2 : nb.x + 12;
      assert.equal(line.x + 1, mid, `${at}: the line is half a step pitch before the Now step's centre`);
    }
  } else {
    assert.ok(nb.nowGap, `${at}: the frontier band has its Now gap`);
    assert.equal(nb.nowGap!.h, 56);
    assert.equal(line.h, 2);
    assert.equal(line.y + 1, nb.nowGap!.y + 28, `${at}: the line runs through the middle of the Now gap`);
    assert.equal(line.x, (nb.gutter?.x ?? 16) + (nb.gutter?.w ?? gutterFor(options.width)), `${at}: from the gutter's edge`);
    assert.equal(right(line), g.width - 32, `${at}: across the band`);
    assert.ok(pill.y >= nb.nowGap!.y && bottom(pill) <= bottom(nb.nowGap!), `${at}: the pill is in the Now gap`);
    if (before.length) assert.ok(nb.nowGap!.y >= Math.max(...before.map(bottom)), `${at}: the gap is after the step before Now`);
    if (after.length) assert.ok(bottom(nb.nowGap!) <= Math.min(...after.map((d) => d.y)), `${at}: the gap is before the Now step`);
    const axisX = Math.min(...g.dots.map((d) => d.x)) + 14;
    assert.equal(pill.x, axisX - 14, `${at}: the pill's left edge is at the axis minus 14 px`);
  }
}

function sweep(name: string, make: () => Timeline, extra: Partial<Options> = {}): void {
  const timeline = make();
  for (const direction of ['horizontal', 'vertical']) {
    for (const zoom of ZOOMS) {
      for (const width of WIDTHS) {
        const options = { direction, zoom, width, ...extra };
        checkLayout(name, timeline, options, geometry(timeline, options));
      }
    }
  }
}

// ---- the tests -----------------------------------------------------------------------------------------------------------------------------------

test('a 20-step chain: one dot per step along one axis, at every zoom, direction and width, with nothing touching', () => {
  sweep('chain', chainOnly);
  const g = geometry(chainOnly(), { direction: 'horizontal', zoom: 100, width: 1400 });
  assert.equal(g.dots.length, 20);
  assert.deepEqual([...new Set(g.dots.map((d) => d.cy))].length, 1, 'every dot of a chain is on the axis row');
  const v = geometry(chainOnly(), { direction: 'vertical', zoom: 100, width: 1400 });
  assert.deepEqual([...new Set(v.dots.map((d) => d.cx))].length, 1, 'and on the axis column in vertical');
});

test('a step of 30 parallel cards shows 8 dots and a +22 box in the 9th slot; opened, all 30 and Show fewer in the last slot', () => {
  const t = timelineOf([wide('m:wide')]);
  sweep('stack', () => t);
  sweep('stack opened', () => t, { openStacks: { 'm:wide:1': true } });
  for (const direction of ['horizontal', 'vertical']) {
    const closed = geometry(t, { direction, zoom: 100, width: 1400 });
    assert.equal(closed.dots.filter((d) => d.id.includes('/1/')).length, 8, `${direction}: 8 dots shown`);
    assert.deepEqual(closed.more.map((m) => [m.milestoneId, m.step, m.slot, m.hidden]), [['m:wide', 1, 8, 22]], `${direction}: +22 in the 9th slot`);
    const open = geometry(t, { direction, zoom: 100, width: 1400, openStacks: { 'm:wide:1': true } });
    assert.equal(open.dots.filter((d) => d.id.includes('/1/')).length, 30, `${direction}: all 30 shown`);
    assert.deepEqual(open.more.map((m) => [m.milestoneId, m.step, m.slot, m.hidden]), [['m:wide', 1, 30, 0]], `${direction}: Show fewer in the last slot`);
    assert.ok(direction === 'horizontal' ? open.height > closed.height : open.width >= closed.width, `${direction}: the canvas grows`);
  }
});

test('phases whose steps interleave go on two rail rows in horizontal and two bar columns in vertical, and their labels never collide', () => {
  const t = timelineOf([interleaved('m:i')]);
  sweep('interleaved', () => t);
  const h = geometry(t, { direction: 'horizontal', zoom: 100, width: 1400 });
  const rows = Object.fromEntries(h.bands[0]!.phases.map((p) => [p.id, p.row]));
  assert.deepEqual(rows, { 'phase:3': 0, 'phase:4': 1, 'phase:5': 0 }, 'phase 5 fits on the first row after phase 3 ends');
  for (const p of h.bands[0]!.phases) {
    assert.equal(p.label.x, p.bar.x, 'the label is left-aligned over its bar');
    assert.ok(bottom(p.label) <= p.bar.y, 'the label sits above its bar');
  }
  const v = geometry(t, { direction: 'vertical', zoom: 100, width: 1400 });
  const columns = new Set(v.bands[0]!.phases.map((p) => p.bar.x));
  assert.equal(columns.size, 2, 'two bar columns in the gutter');
  const nearest = Math.max(...columns);
  assert.equal(v.bands[0]!.phases.find((p) => p.id === 'phase:3')!.bar.x, nearest, 'the first phase takes the column nearest the axis');
});

test('two phases that start on the same step: in vertical the later label moves down a line inside its own segment, or shows nothing when there is no room', () => {
  // Phase 10 runs steps 0 to 3, phase 11 steps 0 to 2, phase 12 only step 0.
  const t = timelineOf([band('m:same', [['10', 0, 1], ['11', 0, 1], ['12', 0, 1], ['10', 1, 1], ['11', 2, 1], ['10', 3, 1]])]);
  sweep('same start', () => t);
  const v = geometry(t, { direction: 'vertical', zoom: 100, width: 1400 });
  const byId = Object.fromEntries(v.bands[0]!.phases.map((p) => [p.id, p]));
  const [ten, eleven, twelve] = [byId['phase:10']!, byId['phase:11']!, byId['phase:12']!];
  assert.equal(ten.label.y, ten.bar.y, 'the first label is at the top of its segment');
  assert.equal(eleven.label.y, bottom(ten.label) + 4, 'the next one moves down to the next free line');
  assert.ok(bottom(eleven.label) <= bottom(eleven.bar), 'inside its own segment');
  assert.equal(twelve.label.hidden, true, 'a one-step segment with no free line shows no label');
  assert.equal(new Set([ten.bar.x, eleven.bar.x, twelve.bar.x]).size, 3, 'three overlapping spans, three bar columns');
  const h = geometry(t, { direction: 'horizontal', zoom: 100, width: 1400 });
  assert.deepEqual(h.bands[0]!.phases.map((p) => p.row).sort(), [0, 1, 2], 'and three rail rows in horizontal');
});

test('a band with a loop, a folded finished milestone, an empty milestone and the board band last, in one project', () => {
  sweep('mixed', mixed);
  const h = geometry(mixed(), { direction: 'horizontal', zoom: 100, width: 1400 });
  assert.deepEqual(h.bands.map((b) => [b.id, b.folded, b.empty]), [['m:old', true, false], ['m:now', false, false], ['m:loop', false, false], ['m:empty', false, true], ['m:wide', false, false], ['board', false, false]]);
  assert.equal(h.bands.at(-1)!.id, 'board', 'the cards added on the board are last');
  assert.ok(h.bands.every((b, i) => i === 0 || b.x > h.bands[i - 1]!.x), 'bands go left to right');
  assert.equal(h.tiles.length, 1);
  // A person who shows the finished milestone gets its dots back, and folding it again hides them.
  const shown = geometry(mixed(), { direction: 'horizontal', zoom: 100, width: 1400, shown: { 'm:old': true } });
  assert.equal(shown.tiles.length, 0);
  assert.equal(shown.dots.filter((d) => d.id.startsWith('m:old/')).length, 5);
  sweep('mixed shown', mixed, { shown: { 'm:old': true } });
  // An unfinished milestone never folds, whatever was saved.
  const forced = geometry(mixed(), { direction: 'vertical', zoom: 100, width: 1400, shown: { 'm:now': false } });
  assert.equal(forced.bands.find((b) => b.id === 'm:now')!.folded, false);
});

test('the Now marker in the middle of the second band: the Now row in every horizontal band, the Now gap only in the frontier band in vertical', () => {
  const t = mixed();
  const h = geometry(t, { direction: 'horizontal', zoom: 100, width: 1400 });
  const rows = h.bands.filter((b) => b.nowRow).map((b) => b.nowRow!.y);
  assert.equal(new Set(rows).size, 1, 'one Now row height across every band, so the axis is one line');
  const v = geometry(t, { direction: 'vertical', zoom: 100, width: 1400 });
  assert.deepEqual(v.bands.filter((b) => b.nowGap).map((b) => b.id), ['m:now']);
  // Moving Now to the first step of the band, or to another band, keeps every check.
  for (const step of [0, 1, 5]) sweep(`now at ${step}`, () => ({ ...mixed(), now: { milestoneId: 'm:now', step, stepCount: 6, allDone: false } }));
  sweep('now in the board band', () => ({ ...mixed(), now: { milestoneId: 'board', step: 1, stepCount: 2, allDone: false } }));
  sweep('no now', () => { const x = mixed(); delete x.now; return x; });
});

test('Now with everything done stands after the last step of the last band, and that band stays open for it', () => {
  sweep('all done', allDone);
  for (const direction of ['horizontal', 'vertical']) {
    const g = geometry(allDone(), { direction, zoom: 100, width: 1400 });
    const last = g.bands.find((b) => b.id === 'm:b')!;
    assert.equal(last.folded, false, `${direction}: the band with the marker is open`);
    assert.equal(g.bands.find((b) => b.id === 'm:a')!.folded, true, `${direction}: the other finished band folds`);
    const lastDot = g.dots.filter((d) => d.id.startsWith('m:b/')).sort((a, b) => (direction === 'horizontal' ? b.x - a.x : b.y - a.y))[0]!;
    if (direction === 'horizontal') assert.ok(g.now!.line.x > right(lastDot), 'the line is after the last step');
    else assert.ok(last.nowGap!.y >= bottom(lastDot), 'the gap is after the last step');
  }
});

test('zoom changes spacing only: dot boxes are 28 by 28 at 50 and 75, 52 by 28 at 100 and 150, 96 by 28 at 200; under 520 px the drawing is vertical with a 64 px gutter', () => {
  for (const zoom of ZOOMS) {
    for (const direction of ['horizontal', 'vertical']) {
      const g = geometry(chainOnly(), { direction, zoom, width: 1400 });
      assert.deepEqual([...new Set(g.dots.map((d) => `${d.w}x${d.h}`))], [`${BOX[zoom]![0]}x${BOX[zoom]![1]}`], `${direction} ${zoom}%`);
      assert.equal(g.zoom, zoom);
    }
  }
  for (const [width, gutter] of [[480, 64], [700, 120], [900, 160], [1400, 160]] as const) {
    const g = geometry(mixed(), { direction: 'vertical', zoom: 100, width });
    const drawn = g.bands.find((b) => b.id === 'm:now')!;
    assert.equal(drawn.gutter!.w, gutter, `${width} px: ${gutter} px gutter`);
    assert.equal(Math.min(...g.dots.map((d) => d.x)), drawn.gutter!.x + gutter + 8, `${width} px: the first slot starts 8 px after the gutter`);
  }
  const narrow = geometry(mixed(), { direction: 'horizontal', zoom: 100, width: 480 });
  assert.equal(narrow.direction, 'vertical', 'under 520 px the geometry draws top to bottom whatever was asked');
  assert.equal(narrow.bands[1]!.gutter!.w, 64);
  // Values off the lists fall back: zoom 100, direction horizontal.
  const odd = geometry(chainOnly(), { direction: 'diagonal', zoom: 300, width: 1400 });
  assert.deepEqual([odd.direction, odd.zoom], ['horizontal', 100]);
});

test('the geometry is pure: the same timeline and options give the same numbers, the timeline is not changed, and nothing is read from the page', () => {
  const t = mixed();
  const before = JSON.stringify(t);
  const api = { geometry: geometryFn() };
  const a = JSON.stringify(api.geometry(t, { direction: 'horizontal', zoom: 150, width: 900 }));
  // A page that throws on every read still gets the same answer.
  const doc = harness.document as unknown as Record<string, unknown>;
  const saved = { getElementById: doc.getElementById, querySelector: doc.querySelector, querySelectorAll: doc.querySelectorAll };
  try {
    for (const k of Object.keys(saved)) doc[k] = () => { throw new Error('the geometry read the page'); };
    assert.equal(JSON.stringify(api.geometry(t, { direction: 'horizontal', zoom: 150, width: 900 })), a);
  } finally {
    Object.assign(doc, saved);
  }
  assert.equal(JSON.stringify(t), before, 'the timeline is unchanged');
  assert.equal(JSON.stringify(api.geometry(t, { direction: 'horizontal', zoom: 150, width: 900 })), a, 'deterministic');
  // Hostile shapes do not throw.
  for (const bad of [undefined, null, {}, { milestones: 'x', dots: 3 }, { milestones: [{ id: 'm', steps: -4, phases: [{ id: 'p', number: '1', firstStep: 9, lastStep: -1 }] }], dots: [{ cardId: 'a', milestoneId: 'm', step: -1, slot: 0 }, { cardId: 'b', milestoneId: 'zzz', step: 0, slot: 0 }] }]) {
    const g = api.geometry(bad, { direction: 'vertical', zoom: 50, width: 900 }) as { dots: unknown[] };
    assert.ok(Array.isArray(g.dots), `no throw for ${JSON.stringify(bad)}`);
  }
});

test('a 2000-dot timeline in 40 phases is placed in under 100 ms in the vm', () => {
  const parts = [];
  for (let m = 0; m < 4; m += 1) {
    const cells: Array<[string, number, number]> = [];
    for (let p = 0; p < 10; p += 1) for (let s = 0; s < 10; s += 1) cells.push([String(m * 10 + p + 1), p * 5 + Math.floor(s / 2), 5]);
    parts.push(band(`m:${m}`, cells));
  }
  const t = timelineOf(parts, { milestoneId: 'm:1', step: 7, stepCount: 50, allDone: false });
  assert.equal(t.dots.length, 2000);
  const api = { geometry: geometryFn() };
  for (const direction of ['horizontal', 'vertical']) {
    const started = performance.now();
    const g = api.geometry(t, { direction, zoom: 100, width: 1400, openStacks: {} });
    const took = performance.now() - started;
    assert.ok(took < 100, `${direction}: placed in ${took.toFixed(1)} ms`);
    assert.ok(g.dots.length > 1000);
  }
});
