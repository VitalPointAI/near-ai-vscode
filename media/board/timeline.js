// Team Board timeline (62.1-UI-SPEC, D-02, D-04): the board's second view, one timeline for the whole project. Milestones are bands, phases are
// segments inside them and every card is a dot in dependency order, from the host's model.timeline (src/domain/team/timeline.ts). This script plugs
// into board.js through window.NearAiBoard like menu.js and detail.js; the toolbar, banners, live region, Move to... menu and detail drawer stay the
// board's. Plain browser JavaScript in one strict IIFE: every text node is set with textContent and every attribute with setAttribute, positions only
// with style.setProperty, no markup strings and no network. The page never decides permissions and posts no message the board does not already post.
// The lists are the screen reader structure (milestones, phases, dots in sequence); the same nodes are placed on the canvas from the pure geometry
// below, so what is read and what is seen cannot drift apart (62.1-04).
(function () {
  'use strict';
  // The page's own words (the timeline's sentences come from the model). The plain-language scan reads this file.
  const T = Object.freeze({
    region: 'Team Board timeline',
    milestones: 'Milestones',
    phasesIn: (title) => 'Phases in ' + title,
    cardsIn: (name) => 'Cards in ' + name + ', in order',
    phase: (number) => 'Phase ' + number,
    current: 'Current',
    fold: 'Fold milestone',
    foldName: (title) => 'Fold ' + title,
    progressName: (title) => title + ' progress',
    hintMove: 'Use the arrow keys to move along the timeline. Press Enter to open the card. Press M to move it. Press N to jump to now.',
    hintOpen: 'Use the arrow keys to move along the timeline. Press Enter to open the card. Press N to jump to now.',
    showMilestone: 'Show milestone',
    more: (n) => '+' + n,
    moreName: (n, step) => 'Show ' + n + ' more cards in step ' + step,
    fewer: 'Show fewer',
    fewerName: (step) => 'Show fewer cards in step ' + step,
    errorHead: 'The timeline could not be drawn',
    errorBody: 'Something went wrong while placing the cards. Nothing was changed. Switch to Columns to see every card, or try again.',
    showColumns: 'Show columns',
    drawAgain: 'Draw the timeline again',
    overall: 'Project progress',
    zoom: 'Zoom',
    zoomOut: 'Zoom out',
    zoomIn: 'Zoom in',
    zoomLevel: (n) => n + '%',
    zoomName: (n) => 'Zoom ' + n + '%',
    fit: 'Fit milestone',
    fitName: 'Fit the current milestone to the window',
    jumpNow: 'Jump to now',
    jumpNowTitle: 'Show where the work is now',
    showLegend: 'Show legend',
    hideLegend: 'Hide legend',
    legendName: 'What the dots mean',
    legend: [
      ['backlog', 'Backlog'], ['ready', 'Ready'], ['claimed', 'Claimed'], ['in-progress', 'In progress'], ['in-review', 'In review'], ['integrating', 'Shipping'],
      ['done', 'Done'], ['cancelled', 'Cancelled'], ['blocked', 'Blocked'], ['held', 'On hold'], ['finished', 'Looks finished, please confirm'],
      ['mine', 'Mine: filled initials'], ['square', 'Square: a phase with no plans yet'], ['line', 'Line: waits for'], ['waiting', 'Dashed line: still waiting']
    ],
    legendHint: 'Hover or focus a dot to preview it. Click it or press Enter to open the card.',
    // The expanded card (62.1-05, UI-SPEC "Expanded card"); the face, Move to... and the pending and refusal lines are the board's own words.
    closeCard: 'Close card',
    openDetails: 'Open details',
    factStep: 'Step',
    factWaits: 'Waits for',
    factNeeded: 'Needed by',
    factFinished: 'Finished',
    nothing: 'Nothing',
    gone: 'That card is no longer on the board.',
    // The preview's last line (UI-SPEC "Preview"): the pointer opened it, or the keyboard did.
    previewPointer: 'Click to open the card.',
    previewKeyboard: 'Press Enter to open the card.'
  });

  // ---- the pure geometry (UI-SPEC "Timeline geometry", "Pitches by zoom", "Horizontal", "Vertical", "Stacks taller than the cap", "Folded finished
  // milestones" and the amendment's Now row and Now gap) ---------------------------------------------------------------------------------------
  // One function places every band, phase label and bar, dot box, +{n} box, folded tile, empty band and the Now marker from the timeline and the
  // person's choices, as plain numbers in canvas pixels. It reads nothing from the page, so the vm tests prove that nothing touches without a browser.
  const ZOOMS = [50, 75, 100, 150, 200];
  // The dot button box by zoom: the mark, then the initials chip from 100 %, then the display ID at 200 %. Zoom never changes a size, only spacing.
  const BOX = { 50: [28, 28], 75: [28, 28], 100: [52, 28], 150: [52, 28], 200: [96, 28] };
  // Centre to centre: [step pitch along the axis, stack pitch across it]. Always at least the box plus 4 px, so two dots never touch.
  const PITCH = {
    horizontal: { 50: [32, 32], 75: [48, 40], 100: [64, 40], 150: [96, 40], 200: [128, 40] },
    vertical: { 50: [32, 32], 75: [32, 48], 100: [40, 64], 150: [60, 96], 200: [80, 128] }
  };
  const G = Object.freeze({
    bandGap: 48, padAlong: 24, padAcross: 16, head: 56, headMax: 320, gap: 8, railRow: 24, labelLine: 16, barOffset: 18, bar: 4, apart: 4,
    nowRow: 48, nowGap: 56, pillW: 320, pillH: 40, cap: 8, tile: 160, tileHeight: 112, emptyAlong: 160, emptyHeight: 96, emptyLine: 56,
    canvasPad: 32, minBand: 368, barColumn: 8, minLabel: 24, narrow: 520, notice: 80
  });
  const gutterFor = (width) => (width >= 900 ? 160 : width >= G.narrow ? 120 : 64);
  const rect = (x, y, w, h) => ({ x, y, w, h });
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const step0 = (v) => typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v;
  const whole = (v) => { const n = Number(v); return isFinite(n) ? Math.floor(n) : 0; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // Phase numbers like 62 and 62.1 in number order.
  function compareNumbers(a, b) {
    const x = String(a).split('.');
    const y = String(b).split('.');
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
      const p = Number(x[i] || 0);
      const q = Number(y[i] || 0);
      if (isFinite(p) && isFinite(q) && p !== q) return p - q;
      if (!(isFinite(p) && isFinite(q)) && x[i] !== y[i]) return String(x[i]) < String(y[i]) ? -1 : 1;
    }
    return 0;
  }

  /** The phases of a drawn band on the fewest rail rows (horizontal) or bar columns (vertical): by first step, then phase number, each on the first
   * row whose last span ends at least 4 px before it starts. start and end are along the axis, from the band's first step. */
  function pack(plan, alongAt, boxAlong) {
    const ends = [];
    const phases = (Array.isArray(plan.m.phases) ? plan.m.phases.filter(isObj) : []).map((p) => {
      const first = clamp(whole(p.firstStep), 0, plan.count - 1);
      const last = clamp(whole(p.lastStep), first, plan.count - 1);
      return { id: String(p.id), number: String(p.number === undefined ? '' : p.number), start: alongAt(first), end: alongAt(last) + boxAlong, row: 0 };
    }).sort((a, b) => a.start - b.start || compareNumbers(a.number, b.number));
    for (const p of phases) {
      let row = ends.findIndex((end) => p.start >= end + G.apart);
      if (row < 0) { row = ends.length; ends.push(p.end); } else ends[row] = p.end;
      p.row = row;
    }
    return { phases, rows: ends.length };
  }

  /**
   * Where everything on the timeline goes. timeline is model.timeline; options { direction, zoom, width (the scroller's), shown: { [milestoneId]:
   * boolean }, openStacks: { [milestoneId + ':' + step]: true } }. Under 520 px the drawing is vertical whatever is asked (TD-11). A finished milestone
   * folds to its tile unless the person showed it, except the band holding the Now marker, which always stays open so the marker has its place.
   * Returns { width, height, direction, zoom, box, pitch, bands, dots, more, tiles, now? }; every rect is { x, y, w, h } in canvas pixels, and a dot's
   * cx and cy are the centre of its box.
   */
  function geometry(timeline, options) {
    const o = isObj(options) ? options : {};
    const width = typeof o.width === 'number' && isFinite(o.width) && o.width > 0 ? o.width : 800;
    const direction = width < G.narrow ? 'vertical' : o.direction === 'vertical' ? 'vertical' : 'horizontal';
    const horizontal = direction === 'horizontal';
    const zoom = ZOOMS.indexOf(o.zoom) >= 0 ? o.zoom : 100;
    const shown = isObj(o.shown) ? o.shown : {};
    const openStacks = isObj(o.openStacks) ? o.openStacks : {};
    const bw = BOX[zoom][0];
    const bh = BOX[zoom][1];
    const along = PITCH[direction][zoom][0];
    const across = PITCH[direction][zoom][1];
    const t = isObj(timeline) ? timeline : {};
    const milestones = Array.isArray(t.milestones) ? t.milestones.filter(isObj) : [];
    const now = isObj(t.now) && step0(t.now.step) && milestones.some((m) => m.id === t.now.milestoneId) ? t.now : undefined;

    // The dots of each band by step, in slot order.
    const byBand = new Map();
    for (const d of Array.isArray(t.dots) ? t.dots : []) {
      if (!isObj(d) || typeof d.cardId !== 'string' || !step0(d.step) || !step0(d.slot)) continue;
      let steps = byBand.get(d.milestoneId);
      if (!steps) { steps = new Map(); byBand.set(d.milestoneId, steps); }
      let list = steps.get(d.step);
      if (!list) { list = []; steps.set(d.step, list); }
      list.push(d);
    }
    const plans = milestones.map((m) => {
      const steps = byBand.get(m.id) || new Map();
      let count = 0;
      for (const [s, list] of steps) { list.sort((a, b) => a.slot - b.slot); count = Math.max(count, s + 1); }
      const holdsNow = !!now && now.milestoneId === m.id;
      const wantsFolded = own(shown, m.id) && typeof shown[m.id] === 'boolean' ? !shown[m.id] : m.foldedByDefault === true;
      const folded = m.finished === true && count > 0 && !holdsNow && wantsFolded;
      const empty = !folded && count === 0;
      // A step taller than the cap shows 8 dots and the +{n} box in the 9th slot, or, opened, every dot and Show fewer in the last slot.
      const columns = [];
      let slots = 0;
      for (let s = 0; s < count; s += 1) {
        const list = steps.get(s) || [];
        let visible = list;
        let more;
        if (list.length > G.cap) {
          if (openStacks[m.id + ':' + s] === true) more = { slot: list.length, hidden: 0 };
          else { visible = list.slice(0, G.cap); more = { slot: G.cap, hidden: list.length - G.cap }; }
        }
        columns.push({ visible, more });
        slots = Math.max(slots, visible.length + (more ? 1 : 0));
      }
      return { m, id: String(m.id), folded, empty, count, columns, slots, holdsNow: holdsNow && count > 0, gapAt: holdsNow ? Math.min(now.step, count) : -1 };
    });

    const out = { width: 0, height: 0, direction, zoom, box: { w: bw, h: bh }, pitch: { along, across }, bands: [], dots: [], more: [], tiles: [] };
    let maxRight = 0;
    let maxBottom = 0;
    const grow = (r) => { maxRight = Math.max(maxRight, r.x + r.w); maxBottom = Math.max(maxBottom, r.y + r.h); return r; };
    const addDot = (d, r) => { grow(r); out.dots.push({ id: d.cardId, x: r.x, y: r.y, w: r.w, h: r.h, cx: r.x + r.w / 2, cy: r.y + r.h / 2 }); };

    if (horizontal) {
      // One rail height, Now row and axis for every band, so the axis is one straight line across the project.
      const packed = plans.map((p) => (p.folded || p.empty ? { phases: [], rows: 0 } : pack(p, (s) => s * along, bw)));
      const rows = Math.max(0, ...packed.map((k) => k.rows));
      // A band whose cards wait for each other in a loop carries a notice at its start (UI-SPEC "States"); its row is kept in every band, like the
      // Now row, so the axis stays one line.
      const noticeTop = G.padAcross + G.head + G.gap;
      const noticeRow = plans.some((p) => !p.folded && !p.empty && p.m.cycle === true) ? G.notice : 0;
      const railTop = noticeTop + noticeRow;
      const nowTop = railTop + rows * G.railRow + G.gap;
      const y0 = nowTop + G.nowRow + G.gap;
      let x = 0;
      plans.forEach((p, i) => {
        let band;
        if (p.folded) {
          const tile = grow(rect(x, G.padAcross, G.tile, G.tileHeight));
          out.tiles.push({ milestoneId: p.id, rect: tile });
          band = { id: p.id, x, y: 0, w: G.tile, h: G.padAcross * 2 + G.tileHeight, folded: true, empty: false, header: tile, phases: [] };
        } else if (p.empty) {
          const emptyBox = grow(rect(x + G.padAcross, railTop, G.emptyAlong - 2 * G.padAcross, G.emptyHeight));
          band = { id: p.id, x, y: 0, w: G.emptyAlong, h: railTop + G.emptyHeight + G.padAcross, folded: false, empty: true, header: rect(x, G.padAcross, G.emptyAlong, G.head), emptyBox, phases: [] };
        } else {
          const w = Math.max(G.padAlong + (p.count - 1) * along + bw + G.padAlong, G.minBand);
          const start = x + G.padAlong;
          const phases = packed[i].phases.map((ph) => {
            const top = railTop + ph.row * G.railRow;
            return { id: ph.id, row: ph.row, label: grow(rect(start + ph.start, top, ph.end - ph.start, G.labelLine)), bar: rect(start + ph.start, top + G.barOffset, ph.end - ph.start, G.bar) };
          });
          let bottom = y0 + bh;
          p.columns.forEach((col, s) => {
            const bx = start + s * along;
            col.visible.forEach((d, k) => { const r = rect(bx, y0 + k * across, bw, bh); addDot(d, r); bottom = Math.max(bottom, r.y + r.h); });
            if (col.more) {
              const r = grow(rect(bx, y0 + col.more.slot * across, bw, bh));
              out.more.push({ milestoneId: p.id, step: s, slot: col.more.slot, rect: r, hidden: col.more.hidden });
              bottom = Math.max(bottom, r.y + r.h);
            }
          });
          band = {
            id: p.id, x, y: 0, w, h: bottom + G.padAcross, folded: false, empty: false, header: rect(x, G.padAcross, Math.min(G.headMax, w), G.head),
            nowRow: rect(x, nowTop, w, G.nowRow), axis: rect(x, y0 + bh / 2 - 1, w, 2), phases,
            ticks: p.columns.map((col, s) => ({ step: s, at: start + s * along + bw / 2 }))
          };
          if (p.m.cycle === true) band.notice = grow(rect(x + G.padAcross, noticeTop, w - 2 * G.padAcross, G.notice - G.gap));
          if (p.holdsNow) {
            // The line sits in the gap before the Now step, half a step pitch before its centre (after the last step when all is done), from the top of
            // the Now row to the bottom of the tallest stack; the pill's left edge is on the line, moved left to stay inside the band.
            const n = p.gapAt;
            const mid = n === 0 ? x + G.padAlong / 2 : start + (n - 1) * along + bw + (along - bw) / 2;
            const line = grow(rect(mid - 1, nowTop, 2, bottom - nowTop));
            const pill = grow(rect(Math.min(mid - 1, x + w - G.padAlong - G.pillW), nowTop + (G.nowRow - G.pillH) / 2, G.pillW, G.pillH));
            out.now = { milestoneId: p.id, step: n, line, pill };
          }
        }
        out.bands.push(band);
        x += band.w + G.bandGap;
      });
    } else {
      const alongAtOf = (p) => (s) => s * along + (p.gapAt >= 0 && s >= p.gapAt ? G.nowGap : 0);
      const packed = plans.map((p) => (p.folded || p.empty ? { phases: [], rows: 0 } : pack(p, alongAtOf(p), bh)));
      const columnsMax = Math.max(1, ...packed.map((k) => k.rows));
      // The gutter by width; it grows only when so many phases overlap that their bars would leave labels less than 24 px.
      const gutter = Math.max(gutterFor(width), columnsMax * G.barColumn + G.minLabel);
      const gx = G.padAcross;
      const slot0 = gx + gutter + G.gap;
      let contentRight = 0;
      for (const p of plans) if (!p.folded && !p.empty) contentRight = Math.max(contentRight, slot0 + (p.slots - 1) * across + bw);
      const W = Math.max(width, G.minBand, contentRight + G.canvasPad, plans.some((p) => p.holdsNow) ? slot0 + G.pillW + G.canvasPad : 0);
      let y = 0;
      plans.forEach((p, i) => {
        let band;
        if (p.folded) {
          const tile = grow(rect(gx, y, W - gx - G.canvasPad, G.emptyLine));
          out.tiles.push({ milestoneId: p.id, rect: tile });
          band = { id: p.id, x: 0, y, w: W, h: G.emptyLine, folded: true, empty: false, header: tile, phases: [] };
        } else if (p.empty) {
          const emptyBox = grow(rect(gx, y + G.head, W - gx - G.canvasPad, G.emptyLine));
          band = { id: p.id, x: 0, y, w: W, h: G.head + G.emptyLine, folded: false, empty: true, header: rect(0, y, W, G.head), emptyBox, phases: [] };
        } else {
          // The loop notice takes a row under the header of its own band.
          const noticeH = p.m.cycle === true ? G.notice : 0;
          const base = y + G.head + noticeH + G.padAlong;
          const alongAt = alongAtOf(p);
          const top = (s) => base + alongAt(s);
          const labelW = gutter - Math.max(1, packed[i].rows) * G.barColumn;
          // Labels sit at the top of their segment; one that would touch the label above moves down to the next free line inside its own segment, or
          // shows nothing when there is none (the full name stays in the h3, the preview and the card).
          let lastLabel = -Infinity;
          const phases = packed[i].phases.map((ph) => {
            const segTop = base + ph.start;
            const segBottom = base + ph.end;
            const ly = Math.max(segTop, lastLabel + G.apart);
            let label;
            if (ly + G.labelLine <= segBottom) { label = grow(rect(gx, ly, labelW, G.labelLine)); lastLabel = ly + G.labelLine; } else label = { x: gx, y: segTop, w: 0, h: 0, hidden: true };
            return { id: ph.id, row: ph.row, label, bar: rect(gx + gutter - G.bar - ph.row * G.barColumn, segTop, G.bar, segBottom - segTop) };
          });
          let end = base;
          p.columns.forEach((col, s) => {
            const by = top(s);
            col.visible.forEach((d, k) => { const r = rect(slot0 + k * across, by, bw, bh); addDot(d, r); end = Math.max(end, r.y + r.h); });
            if (col.more) {
              const r = grow(rect(slot0 + col.more.slot * across, by, bw, bh));
              out.more.push({ milestoneId: p.id, step: s, slot: col.more.slot, rect: r, hidden: col.more.hidden });
              end = Math.max(end, r.y + r.h);
            }
          });
          let nowGap;
          if (p.holdsNow) {
            // The 56 px Now gap goes before the Now step (after the last step when all is done), with the space a step gap or the band padding gives
            // split evenly around it; the line runs across the band through its middle, and the pill's left edge is at the axis minus 14 px.
            const n = p.gapAt;
            const before = n === 0 ? G.padAlong : along - bh;
            const gapTop = (n === 0 ? base - G.padAlong : top(n - 1) + bh) + before / 2;
            nowGap = rect(0, gapTop, W, G.nowGap);
            const mid = gapTop + G.nowGap / 2;
            const line = grow(rect(gx + gutter, mid - 1, W - G.canvasPad - (gx + gutter), 2));
            const pill = grow(rect(slot0, mid - G.pillH / 2, G.pillW, G.pillH));
            end = Math.max(end, gapTop + G.nowGap);
            out.now = { milestoneId: p.id, step: n, line, pill };
          }
          band = {
            id: p.id, x: 0, y, w: W, h: end + G.padAlong - y, folded: false, empty: false, header: rect(0, y, W, G.head),
            gutter: rect(gx, y + G.head + noticeH, gutter, end + G.padAlong - y - G.head - noticeH), axis: rect(slot0 + bh / 2 - 1, base, 2, end - base), phases,
            ticks: p.columns.map((col, s) => ({ step: s, at: top(s) + bh / 2 }))
          };
          if (nowGap) band.nowGap = nowGap;
          if (noticeH) band.notice = grow(rect(gx, y + G.head + G.gap, W - gx - G.canvasPad, G.notice - G.gap));
        }
        out.bands.push(band);
        y += band.h + G.bandGap;
      });
    }
    const last = out.bands[out.bands.length - 1];
    out.width = Math.max(maxRight + G.canvasPad, last ? last.x + last.w : 0);
    out.height = Math.max(maxBottom + G.canvasPad, ...out.bands.map((b) => b.y + b.h));
    if (out.dots.length === 0 && out.bands.length === 0) { out.width = 0; out.height = 0; }
    return out;
  }

  /** The longest of the labels (longest first) whose measured width fits the room, or '' when none does (UI-SPEC "Typography": the label falls back
   * to the number, then to nothing; the full name stays in the h3, the preview and the card). measure(text) gives the drawn width in pixels. */
  function pickLabel(labels, room, measure) {
    if (!Array.isArray(labels) || !(room > 0) || typeof measure !== 'function') return '';
    for (const text of labels) {
      if (typeof text !== 'string' || text === '') continue;
      const w = measure(text);
      if (typeof w === 'number' && isFinite(w) && w <= room) return text;
    }
    return '';
  }

  // ---- the placement of the preview and the expanded card (UI-SPEC "Placement", the D-13 amendment) ------------------------------------------
  // One pure function for both layers. Everything is in canvas pixels: anchor is the dot's hit box, obstacles what the layer must not cover (the Now
  // pill, the sticky milestone headers and the percent labels), view the scroller's visible rectangle less its 8 px edge margin.
  const LAYER = Object.freeze({ gap: 8, room: 160, min: 48 });
  const boxOf = (b) => ({ left: Number(b && b.left) || 0, top: Number(b && b.top) || 0, width: Math.max(0, Number(b && b.width) || 0), height: Math.max(0, Number(b && b.height) || 0) });
  const overlaps = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
  /**
   * Where a layer of this size goes next to its dot. The sides are tried in the direction's order (horizontal: below, above, right, left; vertical:
   * right, left, below, above; narrow: below, above at the full view width). The first side where the whole layer fits inside the view and covers
   * neither the dot nor an obstacle wins. Otherwise a side with at least 160 px of room that covers neither wins, its height capped to that room. Otherwise
   * the side with the most room that covers nothing, else the side with the most room, capped. Below and above put the layer's left edge at the dot's
   * left edge, right and left its top at the dot's top, each shifted to stay inside the view. The layer is never over its own dot.
   * Returns { left, top, width, height, side, capped }.
   */
  function placeLayer(anchor, size, view, obstacles, mode) {
    const a = boxOf(anchor);
    const v = boxOf(view);
    const s = boxOf({ width: size && size.width, height: size && size.height });
    const m = isObj(mode) ? mode : {};
    const narrow = m.narrow === true;
    const sides = narrow ? ['below', 'above'] : m.direction === 'vertical' ? ['right', 'left', 'below', 'above'] : ['below', 'above', 'right', 'left'];
    const obs = (Array.isArray(obstacles) ? obstacles : []).filter(isObj).map(boxOf).filter((o) => o.width > 0 && o.height > 0);
    const w = narrow ? v.width : Math.min(s.width, v.width);
    const h = s.height;
    const gap = LAYER.gap;
    const right = v.left + v.width;
    const bottom = v.top + v.height;
    const alongX = () => clamp(a.left, v.left, Math.max(v.left, right - w));
    const alongY = (hh) => clamp(a.top, v.top, Math.max(v.top, bottom - hh));
    const vertical = (side) => side === 'below' || side === 'above';
    function at(side, hh) {
      if (side === 'below') return { left: alongX(), top: a.top + a.height + gap, width: w, height: hh };
      if (side === 'above') return { left: alongX(), top: a.top - gap - hh, width: w, height: hh };
      if (side === 'right') return { left: a.left + a.width + gap, top: alongY(hh), width: w, height: hh };
      return { left: a.left - gap - w, top: alongY(hh), width: w, height: hh };
    }
    const within = (r) => r.left >= v.left && r.top >= v.top && r.left + r.width <= right && r.top + r.height <= bottom;
    const clear = (r) => !overlaps(r, a) && obs.every((o) => !overlaps(r, o));
    /** The height the layer has on a side: up to the view edge, and, when aware, up to the first obstacle in its way. -Infinity when the layer's
     * width does not fit beside the dot (right and left cannot be squeezed: the card keeps its readable width). */
    function roomOf(side, aware) {
      if (vertical(side)) {
        const x0 = alongX();
        const x1 = x0 + w;
        const start = a.top + a.height + gap;
        const end = a.top - gap;
        let free = side === 'below' ? bottom - start : end - v.top;
        if (aware) {
          for (const o of obs) {
            if (!(o.left < x1 && x0 < o.left + o.width)) continue;
            if (side === 'below' && o.top + o.height > start) free = Math.min(free, o.top - start);
            if (side === 'above' && o.top < end) free = Math.min(free, end - (o.top + o.height));
          }
        }
        return free;
      }
      const across = side === 'right' ? right - (a.left + a.width + gap) : a.left - gap - v.left;
      if (across < w) return -Infinity;
      const hh = Math.min(h, v.height);
      return aware && !clear(at(side, hh)) ? -Infinity : hh;
    }
    const done = (r, side) => ({ left: r.left, top: r.top, width: r.width, height: r.height, side, capped: r.height < h || r.width < s.width && !narrow });
    for (const side of sides) { const r = at(side, h); if (within(r) && clear(r)) return done(r, side); }
    for (const side of sides) {
      const free = roomOf(side, true);
      if (free < LAYER.room) continue;
      const r = at(side, Math.min(h, free));
      if (within(r) && clear(r)) return done(r, side);
    }
    let best;
    let most = -Infinity;
    for (const side of sides) { const free = roomOf(side, true); if (free > most) { most = free; best = side; } }
    if (most < LAYER.min) {
      most = -Infinity;
      for (const side of sides) { const free = roomOf(side, false); if (free > most) { most = free; best = side; } }
    }
    if (best === undefined || most === -Infinity) { best = sides[0]; most = roomOf(best, false); }
    return done(at(best, Math.min(h, Math.max(most, LAYER.min))), best);
  }

  window.NearAiTimeline = Object.freeze({ geometry, pickLabel, place: placeLayer, sizes: G });

  const board = window.NearAiBoard;
  if (!board) return;

  // ---- small helpers -------------------------------------------------------------------------------------------------------------------------
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const svgEl = (tag, attrs) => { const n = document.createElementNS(SVG_NS, tag); for (const k of Object.keys(attrs || {})) n.setAttribute(k, String(attrs[k])); return n; };
  const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
  const attr = (n, k, v) => { if (v === null || v === undefined || v === false) { if (n.getAttribute(k) !== null) n.removeAttribute(k); } else if (n.getAttribute(k) !== String(v)) n.setAttribute(k, String(v)); };
  const setStyle = (n, k, v) => { if (n.style.getPropertyValue(k) !== v) n.style.setProperty(k, v); };
  const px = (v) => v + 'px';
  /** Places a node on a rect given in canvas pixels, relative to the box (ox, oy) it is positioned in. Only style.setProperty (the CSP). */
  function put(n, r, ox, oy) {
    setStyle(n, 'left', px(r.x - (ox || 0)));
    setStyle(n, 'top', px(r.y - (oy || 0)));
    setStyle(n, 'width', px(r.w));
    setStyle(n, 'height', px(r.h));
  }
  const setClass = (n, cls) => { if (n.className !== cls) n.className = cls; };
  /** Puts exactly these nodes, in this order, into the parent. Nodes already there are kept (so focus survives), others are moved or removed. */
  function place(parent, nodes) {
    let i = 0;
    for (const n of nodes) { const cur = parent.children[i]; if (cur !== n) parent.insertBefore(n, cur || null); i += 1; }
    while (parent.children.length > nodes.length) parent.children[parent.children.length - 1].remove();
  }
  const hide = (n, hidden) => { if (n.hidden !== !!hidden) n.hidden = !!hidden; };

  // ---- dots: state by colour, shape and glyph (UI-SPEC "State colours", D-05) ------------------------------------------------------------------
  // The main appearance of a dot: blocked, then on hold, then the column.
  const stateOf = (c) => (c.blocked ? 'blocked' : c.held ? 'held' : c.column);
  const SHAPES = { 'in-progress': 'filled', 'in-review': 'filled', integrating: 'filled', done: 'filled', held: 'dashed' };
  const shapeOf = (state) => SHAPES[state] || 'hollow';
  // The glyph of each state from the board's ICONS: the icon's name and the one path of it the glyph uses (all of them when no index is given).
  const GLYPHS = { ready: ['play-circle', 1], claimed: ['person'], 'in-progress': ['sync'], 'in-review': ['eye'], integrating: ['check-all'], done: ['pass', 1], cancelled: ['circle-slash', 1], blocked: ['lock'], held: ['debug-pause'] };
  const glyphCache = {};
  function glyphPaths(state) {
    if (!own(GLYPHS, state)) return [];
    if (!glyphCache[state]) {
      const [name, index] = GLYPHS[state];
      const paths = Array.from(board.icon(name).querySelectorAll('path')).map((p) => p.getAttribute('d') || '');
      glyphCache[state] = index === undefined ? paths : paths.slice(index, index + 1);
    }
    return glyphCache[state];
  }
  /** The 20 px mark: its body (a circle, or a rounded square for a phase card), the 12 px glyph and the info pip for a plan that looks finished. */
  function buildMark(state, square, pip, refused) {
    const svg = svgEl('svg', { class: 'tl-mark', viewBox: '0 0 20 20', width: 20, height: 20, 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(square ? svgEl('rect', { class: 'tl-body', x: 1, y: 1, width: 18, height: 18, rx: 4 }) : svgEl('circle', { class: 'tl-body', cx: 10, cy: 10, r: 9 }));
    const paths = glyphPaths(state);
    if (paths.length) {
      const g = svgEl('g', { class: 'tl-glyph', transform: 'translate(4 4) scale(0.75)' });
      for (const d of paths) g.appendChild(svgEl('path', { d }));
      svg.appendChild(g);
    }
    // A refusal on the card wins over the info pip (UI-SPEC "State colours").
    if (refused) svg.appendChild(svgEl('circle', { class: 'tl-pip tl-pip-error', cx: 17, cy: 3, r: 4 }));
    else if (pip) svg.appendChild(svgEl('circle', { class: 'tl-pip', cx: 17, cy: 3, r: 4 }));
    return svg;
  }

  // ---- the page's own nodes ----------------------------------------------------------------------------------------------------------------------
  const scroll = el('div', 'tl-scroll');
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', T.region);
  const canvas = el('div', 'tl-canvas');
  // Under everything: the past shade, then one SVG for every dependency line, then the ghost rings of the dots a filter leaves out (TD-14).
  const shades = el('div', 'tl-shades');
  shades.setAttribute('aria-hidden', 'true');
  const lines = svgEl('svg', { class: 'tl-lines', 'aria-hidden': 'true', focusable: 'false' });
  const ghosts = el('div', 'tl-ghosts');
  ghosts.setAttribute('aria-hidden', 'true');
  const list = el('ol', 'tl-milestones');
  list.setAttribute('aria-label', T.milestones);
  // The hidden hints the dots point at (aria-describedby reads hidden text).
  const hints = el('div', 'tl-hints');
  hints.hidden = true;
  const hintMove = el('span', '', T.hintMove); hintMove.id = 'tl-hint-move';
  const hintOpen = el('span', '', T.hintOpen); hintOpen.id = 'tl-hint-open';
  hints.append(hintMove, hintOpen);
  // The expanded card (62.1-05, D-06): a non-modal dialog anchored to its dot inside the canvas, so it moves with its dot when the person pans. It
  // follows the dots in the DOM, so Tab from the dot reaches it. Its face is the board card's own (board.cardFace), so the two views cannot drift.
  const cardBox = el('section');
  cardBox.id = 'tl-card';
  cardBox.setAttribute('role', 'dialog');
  cardBox.setAttribute('aria-modal', 'false');
  cardBox.setAttribute('aria-labelledby', 'tl-card-title');
  const cardHead = el('div', 'tl-card-head');
  const cardTitle = el('h2', 'tl-card-title');
  cardTitle.id = 'tl-card-title';
  cardTitle.setAttribute('tabindex', '-1');
  const cardClose = el('button', 'icon tl-card-close');
  cardClose.setAttribute('type', 'button');
  cardClose.setAttribute('aria-label', T.closeCard);
  cardClose.setAttribute('title', T.closeCard);
  cardClose.appendChild(board.icon('close'));
  cardHead.append(cardTitle, cardClose);
  const cardFaceBox = el('div', 'tl-card-face');
  const cardFacts = el('dl', 'tl-card-facts');
  const cardNotes = el('div', 'tl-card-notes');
  const cardMsg = el('div', 'card-msg tl-card-msg');
  const cardActions = el('div', 'tl-card-actions');
  const cardMove = el('button', 'secondary move-btn');
  cardMove.setAttribute('type', 'button');
  cardMove.setAttribute('aria-haspopup', 'menu');
  cardMove.setAttribute('aria-controls', 'menu');
  cardMove.setAttribute('aria-expanded', 'false');
  const cardDetails = el('button', 'secondary tl-card-details', T.openDetails);
  cardDetails.setAttribute('type', 'button');
  cardActions.append(cardMove, cardDetails);
  cardBox.append(cardHead, cardFaceBox, cardFacts, cardNotes, cardMsg, cardActions);
  // The preview (D-06): visual only, the dot's name already says everything, so it is hidden from screen readers and never takes the pointer.
  const previewBox = el('div');
  previewBox.id = 'tl-preview';
  previewBox.setAttribute('aria-hidden', 'true');
  // Both layers are on the page only while they are shown, after the dots in the DOM: the preview, then the card.
  canvas.append(shades, lines, ghosts, list);
  function showLayer(node, on) {
    if (!on) { if (node.parentNode) node.remove(); return; }
    if (node === previewBox) { if (node.parentNode !== canvas) canvas.insertBefore(node, cardBox.parentNode === canvas ? cardBox : null); }
    else if (node.parentNode !== canvas) canvas.appendChild(node);
  }
  scroll.append(canvas, hints);
  // The board's empty filter state, in an opaque band at the top of the scroller, the ghosts below it (UI-SPEC "Filters").
  const filterBand = el('div', 'tl-filter-empty');
  // The layout failure (UI-SPEC "States"): the retry posts the board's existing message.
  const errorBox = el('div', 'state-box tl-error');
  errorBox.setAttribute('role', 'alert');
  (function () {
    const show = el('button', 'secondary', T.showColumns); show.setAttribute('type', 'button');
    show.addEventListener('click', () => board.setView('columns'));
    const again = el('button', 'secondary', T.drawAgain); again.setAttribute('type', 'button');
    again.addEventListener('click', () => board.post({ type: 'retry' }));
    errorBox.append(el('h2', 'state-head', T.errorHead), el('p', 'state-body', T.errorBody), show, again);
  })();

  // ---- the toolbar's timeline controls (in board.toolbarSlot(), after the Direction switch) and the legend band ------------------------------
  const RING = 2 * Math.PI * 7;
  const overall = el('div');
  overall.id = 'tl-overall';
  overall.setAttribute('role', 'progressbar');
  overall.setAttribute('aria-valuemin', '0');
  overall.setAttribute('aria-valuemax', '100');
  overall.setAttribute('aria-label', T.overall);
  const ringSvg = svgEl('svg', { class: 'tl-overall-ring', viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false' });
  const ringFill = svgEl('circle', { class: 'tl-ring-fill', cx: 8, cy: 8, r: 7, transform: 'rotate(-90 8 8)', 'stroke-dasharray': RING.toFixed(2), 'stroke-dashoffset': RING.toFixed(2) });
  ringSvg.append(svgEl('circle', { class: 'tl-ring-track', cx: 8, cy: 8, r: 7 }), ringFill);
  const overallText = el('span', 'tl-overall-text');
  overall.append(ringSvg, overallText);
  function zoomButton(kind, cls, label, iconName, words) {
    const b = el('button', cls);
    b.setAttribute('type', 'button');
    b.setAttribute('data-zoom', kind);
    b.setAttribute('aria-label', label);
    b.setAttribute('title', label);
    b.appendChild(board.icon(iconName));
    if (words) b.appendChild(el('span', 'label', words));
    return b;
  }
  // What the zoom buttons and Jump to now do comes with 62.1-06; here they are drawn and kept in step with the saved zoom.
  const zoomGroup = el('div', 'zoom');
  zoomGroup.id = 'tl-zoom';
  zoomGroup.setAttribute('role', 'group');
  zoomGroup.setAttribute('aria-label', T.zoom);
  const zoomOut = zoomButton('out', 'icon', T.zoomOut, 'remove');
  const zoomLevel = el('output', 'zoom-level');
  const zoomIn = zoomButton('in', 'icon', T.zoomIn, 'add');
  const zoomFit = zoomButton('fit', 'secondary', T.fitName, 'screen-full', T.fit);
  zoomGroup.append(zoomOut, zoomLevel, zoomIn, zoomFit);
  const nowBtn = el('button', 'secondary', T.jumpNow);
  nowBtn.id = 'tl-now';
  nowBtn.setAttribute('type', 'button');
  nowBtn.setAttribute('title', T.jumpNowTitle);
  const legendBtn = el('button', 'secondary', T.showLegend);
  legendBtn.id = 'tl-legend-btn';
  legendBtn.setAttribute('type', 'button');
  legendBtn.setAttribute('aria-controls', 'tl-legend');
  legendBtn.setAttribute('aria-expanded', 'false');
  const legend = el('div');
  legend.id = 'tl-legend';
  legend.setAttribute('role', 'group');
  legend.setAttribute('aria-label', T.legendName);
  legend.hidden = true;
  (function () {
    const items = el('div', 'tl-legend-items');
    for (const [key, word] of T.legend) {
      const item = el('span', 'tl-legend-item');
      let sign;
      if (key === 'mine') { sign = el('span', 'tl-initials mine'); sign.setAttribute('aria-hidden', 'true'); sign.appendChild(board.icon('person')); }
      else if (key === 'line' || key === 'waiting') {
        sign = svgEl('svg', { class: 'tl-legend-line', viewBox: '0 0 20 20', width: 20, height: 20, 'aria-hidden': 'true', focusable: 'false' });
        sign.appendChild(svgEl('path', { class: 'tl-line emphasis' + (key === 'waiting' ? ' waiting' : ''), d: 'M2 10L18 10' }));
      } else {
        const state = key === 'finished' || key === 'square' ? 'backlog' : key;
        item.setAttribute('data-state', state);
        sign = buildMark(state, key === 'square', key === 'finished');
        attr(sign, 'class', 'tl-mark ' + shapeOf(state));
      }
      item.append(sign, el('span', 'label', word));
      items.appendChild(item);
    }
    legend.append(items, el('p', 'tl-legend-hint', T.legendHint));
  })();
  function drawLegend(open) {
    hide(legend, !open);
    setText(legendBtn, open ? T.hideLegend : T.showLegend);
    attr(legendBtn, 'aria-expanded', open ? 'true' : 'false');
  }
  legendBtn.addEventListener('click', () => drawLegend(board.setUiState({ legendOpen: !board.uiState().legendOpen }).legendOpen));
  place(board.toolbarSlot(), [overall, zoomGroup, nowBtn, legendBtn]);
  /** The overall ring and words (D-14) and the zoom level, from the model and the saved choices. */
  function drawToolbar(timeline, saved) {
    const p = timeline && timeline.percent;
    hide(overall, !p);
    const pct = p && typeof p.percent === 'number' ? p.percent : undefined;
    attr(overall, 'aria-valuenow', pct === undefined ? null : pct);
    attr(overall, 'aria-valuetext', p ? p.label : null);
    setText(overallText, p ? p.text : '');
    attr(ringFill, 'stroke-dashoffset', (RING * (1 - (pct || 0) / 100)).toFixed(2));
    setText(zoomLevel, T.zoomLevel(saved.zoom));
    attr(zoomLevel, 'aria-label', T.zoomName(saved.zoom));
    attr(zoomOut, 'aria-disabled', saved.zoom === ZOOMS[0] ? 'true' : null);
    attr(zoomIn, 'aria-disabled', saved.zoom === ZOOMS[ZOOMS.length - 1] ? 'true' : null);
    drawLegend(saved.legendOpen === true);
  }

  // ---- bands, phases and dots ------------------------------------------------------------------------------------------------------------------
  const bandEls = new Map();
  const groupEls = new Map();
  const dotEls = new Map();
  const moreEls = new Map();
  // The stacks the person opened in this session (a key of milestone and step); folded milestones are saved, stacks are not.
  const openStacks = {};

  function bandEl(band) {
    let b = bandEls.get(band.id);
    if (!b) {
      const li = el('li', 'tl-milestone');
      li.setAttribute('data-milestone', band.id);
      const head = el('div', 'tl-ms-head');
      const row1 = el('div', 'tl-ms-row');
      const h2 = el('h2', 'sr-only');
      const title = el('span', 'tl-ms-title'); title.setAttribute('aria-hidden', 'true');
      const badge = el('span', 'badge', T.current); badge.setAttribute('aria-hidden', 'true');
      const percent = el('span', 'tl-ms-percent'); percent.setAttribute('aria-hidden', 'true');
      row1.append(h2, title);
      const row2 = el('div', 'tl-ms-row');
      const bar = el('div', 'progress'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
      const fill = el('span', 'bar');
      bar.appendChild(fill);
      const progress = el('span', 'progress-text');
      const fold = el('button', 'secondary tl-fold', T.fold); fold.setAttribute('type', 'button'); fold.setAttribute('aria-expanded', 'true');
      fold.addEventListener('click', () => { foldBand(b.id, false); const t = bandEls.get(b.id); if (t && t.tile.isConnected) t.tile.focus(); });
      row2.append(bar, progress);
      head.append(row1, row2);
      const axis = el('div', 'tl-axis');
      axis.setAttribute('aria-hidden', 'true');
      const ticks = el('div', 'tl-ticks');
      ticks.setAttribute('aria-hidden', 'true');
      const phases = el('ol', 'tl-phases');
      // The folded tile (D-09): the whole tile is the button that shows the milestone.
      const tile = el('button', 'tl-folded'); tile.setAttribute('type', 'button'); tile.setAttribute('aria-expanded', 'false');
      const tileTitle = el('span', 'tl-tile-title');
      const tileLine = el('span', 'tl-tile-line');
      const tilePercent = el('span', 'tl-tile-percent');
      tile.append(tileTitle, tileLine, tilePercent, el('span', 'tl-tile-action', T.showMilestone));
      tile.addEventListener('click', () => {
        foldBand(b.id, true);
        const shownBand = bandEls.get(b.id);
        const first = shownBand ? shownBand.li.querySelector('button.tl-dot') : null;
        if (first) first.focus();
      });
      const empty = el('div', 'tl-empty');
      const emptyText = el('p', 'tl-empty-text');
      const emptyNext = el('p', 'tl-empty-next');
      empty.append(emptyText, emptyNext);
      const notice = el('div', 'banner banner-notice tl-cycle');
      notice.setAttribute('role', 'note');
      const noticeText = el('span', 'banner-text');
      notice.append(board.icon('info'), noticeText);
      li.append(head, phases);
      b = { id: band.id, li, head, row1, row2, h2, title, badge, percent, bar, fill, progress, fold, axis, ticks, phases, tile, tileTitle, tileLine, tilePercent, empty, emptyText, emptyNext, notice, noticeText };
      bandEls.set(band.id, b);
    }
    return b;
  }
  /** The header's words from the model (D-14): the h2 is the model's heading, the rest is what the eye reads. */
  function drawHead(b, band, where, canFold) {
    setText(b.h2, band.heading);
    setText(b.title, band.title);
    attr(b.title, 'title', band.title);
    setText(b.percent, band.percentText || '');
    place(b.row1, [b.h2, b.title, ...(band.active ? [b.badge] : []), ...(band.percentText ? [b.percent] : [])]);
    place(b.row2, [b.bar, b.progress, ...(canFold ? [b.fold] : [])]);
    attr(b.phases, 'aria-label', T.phasesIn(band.title));
    const pct = band.percent && typeof band.percent.percent === 'number' ? band.percent.percent : undefined;
    attr(b.bar, 'aria-valuenow', pct === undefined ? null : pct);
    attr(b.bar, 'aria-label', T.progressName(band.title));
    setStyle(b.fill, 'width', (pct || 0) + '%');
    setText(b.progress, band.progressText || '');
    attr(b.fold, 'aria-label', T.foldName(band.title));
    // The header is in the band's flow so it can stick (left edge in horizontal, top edge in vertical); its size and offset come from the geometry.
    setStyle(b.head, 'margin-left', px(where.header.x - where.x));
    setStyle(b.head, 'margin-top', px(where.header.y - where.y));
    setStyle(b.head, 'width', px(where.header.w));
    setStyle(b.head, 'height', px(where.header.h));
  }
  /** A folded milestone: its h2 for screen readers and the tile that says what it holds. */
  function drawTile(b, band, rect, ox, oy) {
    setText(b.h2, band.heading);
    setText(b.tileTitle, band.title);
    attr(b.tileTitle, 'title', band.title);
    setText(b.tileLine, band.tileText || '');
    setText(b.tilePercent, band.percentText || '');
    attr(b.tile, 'aria-label', band.tileName);
    put(b.tile, rect, ox, oy);
  }
  // A phase's list entry, or the entry of the dots with no phase in their band (the cards added on the board), named after the band.
  function groupEl(band, group) {
    const key = band.id + '|' + group.key;
    let g = groupEls.get(key);
    if (!g) {
      const li = el('li', 'tl-phase');
      li.setAttribute('data-phase', group.key);
      const h3 = el('h3', 'tl-phase-head sr-only');
      const dots = el('ol', 'tl-dots');
      const label = el('span', 'tl-phase-label'); label.setAttribute('aria-hidden', 'true');
      const bar = el('div', 'tl-phase-bar'); bar.setAttribute('aria-hidden', 'true');
      const fill = el('span', 'tl-phase-fill');
      bar.appendChild(fill);
      g = { li, h3, dots, label, bar, fill };
      groupEls.set(key, g);
    }
    setText(g.h3, group.phase ? group.phase.heading : band.title);
    attr(g.dots, 'aria-label', T.cardsIn(group.phase ? T.phase(group.phase.number) : band.title));
    return g;
  }
  function dotEl(dot, card, box, ox, oy, zoom) {
    let d = dotEls.get(dot.cardId);
    if (!d) {
      const li = el('li');
      const b = el('button', 'tl-dot');
      b.setAttribute('type', 'button');
      b.setAttribute('data-id', dot.cardId);
      const id = dot.cardId;
      // The preview and the line emphasis (62.1-05, D-06, D-07).
      b.addEventListener('pointerenter', () => pointerIn(id));
      b.addEventListener('pointerleave', () => pointerOut(id));
      b.addEventListener('focus', () => focusIn(id));
      b.addEventListener('blur', () => focusOut(id));
      li.appendChild(b);
      d = { li, button: b, markKey: '', mark: null, chip: el('span', 'tl-initials'), chipKey: '', idLabel: el('span', 'tl-id') };
      d.chip.setAttribute('aria-hidden', 'true');
      d.idLabel.setAttribute('aria-hidden', 'true');
      dotEls.set(dot.cardId, d);
    }
    const state = stateOf(card);
    const square = card.kind === 'phase';
    const b = d.button;
    d.base = 'tl-dot ' + shapeOf(state) + (square ? ' tl-square' : '') + (card.mine ? ' mine' : '');
    decorate(d, dot.cardId);
    attr(b, 'data-step', dot.step);
    attr(b, 'data-slot', dot.slot);
    attr(b, 'data-state', state);
    attr(b, 'aria-label', dot.label);
    attr(b, 'aria-describedby', board.hasMenu(card) ? hintMove.id : hintOpen.id);
    attr(b, 'aria-current', board.selected() === dot.cardId ? 'true' : null);
    put(b, box, ox, oy);
    const refused = board.pendingText(dot.cardId) === '' && board.refusalText(dot.cardId) !== '';
    const markKey = state + '|' + square + '|' + card.doneInGsd + '|' + refused;
    if (d.markKey !== markKey) { d.mark = buildMark(state, square, card.doneInGsd, refused); d.markKey = markKey; }
    // Mine (D-05): a filled chip from 100 %, an outer ring on the mark at 50 and 75 % where there is no chip.
    const chipped = zoom >= 100;
    attr(d.mark, 'class', 'tl-mark' + (card.mine && !chipped ? ' tl-ring' : ''));
    const parts = [d.mark];
    if (chipped && (card.assignee || card.mine)) {
      setClass(d.chip, 'tl-initials' + (card.mine ? ' mine' : ''));
      const chipKey = card.assignee ? 'i:' + card.assignee.initials : 'me';
      if (d.chipKey !== chipKey) {
        if (card.assignee) d.chip.textContent = card.assignee.initials;
        else d.chip.replaceChildren(board.icon('person'));
        d.chipKey = chipKey;
      }
      parts.push(d.chip);
    }
    if (zoom >= 200) { setText(d.idLabel, card.displayId); parts.push(d.idLabel); }
    place(b, parts);
    return d;
  }
  /** The +{n} button of a step taller than the cap, or Show fewer once the stack is open. */
  function moreEl(band, m, ox, oy) {
    const key = band.id + ':' + m.step;
    let x = moreEls.get(key);
    if (!x) {
      const li = el('li');
      const b = el('button', 'tl-more');
      b.setAttribute('type', 'button');
      b.setAttribute('data-step', m.step);
      b.addEventListener('click', () => {
        openStacks[key] = !openStacks[key];
        board.redraw();
        if (b.isConnected) b.focus();
      });
      li.appendChild(b);
      x = { li, button: b };
      moreEls.set(key, x);
    }
    const step = m.step + 1;
    const name = m.hidden > 0 ? T.moreName(m.hidden, step) : T.fewerName(step);
    setText(x.button, m.hidden > 0 ? T.more(m.hidden) : T.fewer);
    attr(x.button, 'aria-label', name);
    // Show fewer is wider than a 28 px box at 50 and 75 %: a cut label is on purpose, with the whole name in title.
    attr(x.button, 'title', name);
    put(x.button, m.rect, ox, oy);
    return x;
  }
  // The phases of a band in the model's order (first step, then phase number), each with its dots in sequence order (step, then slot); dots whose
  // phase is not one of the band's go in one entry placed by its first step.
  function groupsOf(band, dots, needLoose) {
    const groups = band.phases.map((phase) => ({ key: phase.id, phase, first: phase.firstStep, dots: [] }));
    const byId = new Map(groups.map((g) => [g.key, g]));
    let loose;
    for (const dot of dots) {
      const g = dot.phaseId !== undefined ? byId.get(dot.phaseId) : undefined;
      if (g) g.dots.push(dot);
      else { if (!loose) loose = { key: 'none', phase: undefined, first: dot.step, dots: [] }; loose.dots.push(dot); }
    }
    if (!loose && needLoose) loose = { key: 'none', phase: undefined, first: 0, dots: [] };
    if (loose) {
      const at = groups.findIndex((g) => g.first > loose.first);
      groups.splice(at < 0 ? groups.length : at, 0, loose);
    }
    return groups;
  }
  // The label's drawn width (scrollWidth in a browser); without layout (the vm) an estimate of 7 px per character.
  function measureIn(node) {
    return (text) => {
      setText(node, text);
      const w = node.scrollWidth;
      return typeof w === 'number' && isFinite(w) && node.clientWidth > 0 ? w : text.length * 7;
    };
  }
  /** The phase rail: the label with the longest variant that fits its segment, and the bar filled to the phase's percent. */
  function drawRail(g, group, where, ox, oy, horizontal) {
    put(g.label, where.label, ox, oy);
    attr(g.label, 'title', group.phase.heading);
    put(g.bar, where.bar, ox, oy);
    const pct = group.phase.percent && typeof group.phase.percent.percent === 'number' ? group.phase.percent.percent : 0;
    setStyle(g.fill, 'transform', (horizontal ? 'scaleX(' : 'scaleY(') + pct / 100 + ')');
    hide(g.label, !!where.label.hidden);
    if (where.label.hidden) setText(g.label, '');
    else setText(g.label, pickLabel(group.phase.labels, where.label.w, measureIn(g.label)));
  }

  // ---- the Now marker (D-13) -----------------------------------------------------------------------------------------------------------------
  const nowItem = el('li', 'tl-now');
  const nowLine = el('div', 'tl-now-line');
  nowLine.setAttribute('aria-hidden', 'true');
  const nowPill = el('div', 'tl-now-pill');
  nowPill.setAttribute('aria-hidden', 'true');
  const nowTitle = el('span', 'tl-now-title');
  const nowDetail = el('span', 'tl-now-detail');
  nowPill.append(nowTitle, nowDetail);
  const nowSentence = el('span', 'sr-only');
  nowItem.append(nowLine, nowPill, nowSentence);
  function drawNow(now, at, ox, oy) {
    put(nowLine, at.line, ox, oy);
    setStyle(nowPill, 'left', px(at.pill.x - ox));
    setStyle(nowPill, 'top', px(at.pill.y - oy));
    setStyle(nowPill, 'width', px(at.pill.w));
    setStyle(nowPill, 'min-height', px(at.pill.h));
    setText(nowTitle, now.title);
    setText(nowDetail, now.detail);
    setText(nowSentence, now.sentence);
  }
  /** The past shade: every band before the frontier band, and the frontier band up to the line. */
  function drawShades(geo) {
    const out = [];
    const at = geo.now ? geo.bands.findIndex((b) => b.id === geo.now.milestoneId) : -1;
    if (at >= 0) {
      for (let i = 0; i < at; i += 1) out.push(geo.bands[i]);
      const b = geo.bands[at];
      const line = geo.now.line;
      out.push(geo.direction === 'horizontal' ? rect(b.x, b.y, line.x - b.x, b.h) : rect(b.x, b.y, b.w, line.y - b.y));
    }
    place(shades, out.map((r, i) => { const n = shades.children[i] || el('div', 'tl-past'); put(n, r); return n; }));
  }

  // ---- dependency lines (D-07) ---------------------------------------------------------------------------------------------------------------
  // Where a line ends: the mark of a drawn dot (its mark is the first 28 px of the box, the 20 px circle 4 px in), else the +{n} button of its step,
  // else its folded milestone's tile. Lines leave along the direction of travel and arrive the same way.
  function endOf(anchor, out, toward, horizontal) {
    if (anchor.dot) {
      const d = anchor.dot;
      return horizontal ? { x: d.x + (out ? 24 : 4), y: d.cy } : { x: d.x + 14, y: d.y + (out ? 24 : 4) };
    }
    const r = anchor.rect;
    return horizontal ? { x: out ? r.x + r.w : r.x, y: clamp(toward.y, r.y, r.y + r.h) } : { x: clamp(toward.x, r.x, r.x + r.w), y: out ? r.y + r.h : r.y };
  }
  const centreOf = (anchor) => (anchor.dot ? { x: anchor.dot.x + 14, y: anchor.dot.cy } : { x: anchor.rect.x + anchor.rect.w / 2, y: anchor.rect.y + anchor.rect.h / 2 });
  function drawLines(timeline, geo, anchors) {
    const horizontal = geo.direction === 'horizontal';
    const h = geo.pitch.along / 2;
    attr(lines, 'width', geo.width);
    attr(lines, 'height', geo.height);
    const paths = [];
    for (const e of Array.isArray(timeline.edges) ? timeline.edges : []) {
      const from = anchors.get(e.from);
      const to = anchors.get(e.to);
      if (!from || !to || (from.rect && from.rect === to.rect)) continue;
      const a = endOf(from, true, centreOf(to), horizontal);
      const b = endOf(to, false, centreOf(from), horizontal);
      const straight = horizontal ? a.y === b.y : a.x === b.x;
      const d = straight ? 'M' + a.x + ' ' + a.y + ' L' + b.x + ' ' + b.y
        : horizontal ? 'M' + a.x + ' ' + a.y + ' C' + (a.x + h) + ' ' + a.y + ' ' + (b.x - h) + ' ' + b.y + ' ' + b.x + ' ' + b.y
          : 'M' + a.x + ' ' + a.y + ' C' + a.x + ' ' + (a.y + h) + ' ' + b.x + ' ' + (b.y - h) + ' ' + b.x + ' ' + b.y;
      paths.push(svgEl('path', { class: 'tl-line' + (e.waiting ? ' waiting' : ''), 'data-from': e.from, 'data-to': e.to, d }));
    }
    lines.replaceChildren(...paths);
  }

  /** Shows or folds a finished milestone (the person's choice is saved), then draws again. */
  function foldBand(id, show) {
    board.setUiState({ shown: { [id]: show } });
    board.redraw();
  }
  function forget() { bandEls.clear(); groupEls.clear(); dotEls.clear(); moreEls.clear(); }

  function render(container, shown) {
    // Coming back to the timeline from Columns starts with no card open (the selected card stays selected).
    if (!scroll.isConnected) dropLayers();
    const model = board.model();
    const timeline = model && model.timeline;
    const saved = board.uiState();
    drawToolbar(timeline, saved);
    place(container, [legend, scroll]);
    if (!model || !timeline || model.timelineProblem === true || !Array.isArray(timeline.milestones) || !Array.isArray(timeline.dots)) {
      place(scroll, [errorBox]);
      forget();
      dropLayers();
      return;
    }
    try {
      draw(model, timeline, saved, shown);
    } catch (error) {
      // The layout function threw: the error state, and Columns keeps working.
      place(scroll, [errorBox]);
      forget();
      dropLayers();
    }
  }

  function draw(model, timeline, saved, shown) {
    const nothing = model.cards.length > 0 && shown.length === 0;
    place(scroll, nothing ? [filterBand, canvas, hints] : [canvas, hints]);
    if (nothing) place(filterBand, [board.filterEmptyState()]);
    const width = scroll.clientWidth > 0 ? scroll.clientWidth : window.innerWidth || 800;
    const geo = geometry(timeline, { direction: board.drawnDirection(), zoom: saved.zoom, width, shown: saved.shown, openStacks });
    const horizontal = geo.direction === 'horizontal';
    setStyle(canvas, 'width', px(geo.width));
    setStyle(canvas, 'height', px(geo.height));
    attr(canvas, 'data-zoom', geo.zoom);
    const cards = new Map(model.cards.map((c) => [c.id, c]));
    const matching = (id) => cards.has(id) && board.matches(cards.get(id));
    const places = new Map(geo.bands.map((b) => [b.id, b]));
    const boxes = new Map(geo.dots.map((d) => [d.id, d]));
    const dotOf = new Map(timeline.dots.map((d) => [d.cardId, d]));
    // Every card's line end: its dot when it is drawn, else the +{n} of its step, else its milestone's tile. A card the filters leave out has none.
    const anchors = new Map();
    const moreAt = new Map(geo.more.map((m) => [m.milestoneId + ':' + m.step, m]));
    const tileAt = new Map(geo.tiles.map((t) => [t.milestoneId, t.rect]));
    for (const d of timeline.dots) {
      if (!matching(d.cardId)) continue;
      const box = boxes.get(d.cardId);
      const m = moreAt.get(d.milestoneId + ':' + d.step);
      if (box) anchors.set(d.cardId, { dot: box });
      else if (m && m.hidden > 0) anchors.set(d.cardId, { rect: m.rect });
      else if (tileAt.has(d.milestoneId)) anchors.set(d.cardId, { rect: tileAt.get(d.milestoneId) });
    }
    drawShades(geo);
    drawLines(timeline, geo, anchors);
    // Ghosts: the dots a filter leaves out stay at their place as 8 px rings on their mark, with no text, no button and no list entry (TD-14).
    const ghostDots = geo.dots.filter((d) => !matching(d.id));
    place(ghosts, ghostDots.map((d, i) => {
      const n = ghosts.children[i] || el('span', 'tl-ghost');
      attr(n, 'data-id', d.id);
      put(n, rect(d.x + 10, d.cy - 4, 8, 8));
      return n;
    }));

    const byBand = new Map();
    for (const dot of timeline.dots) {
      if (!boxes.has(dot.cardId) || !matching(dot.cardId)) continue;
      if (!byBand.has(dot.milestoneId)) byBand.set(dot.milestoneId, []);
      byBand.get(dot.milestoneId).push(dot);
    }
    const now = timeline.now && geo.now && geo.now.milestoneId === timeline.now.milestoneId ? timeline.now : undefined;
    const used = { bands: new Set(), groups: new Set(), dots: new Set(), more: new Set() };
    const labels = [];
    let nowPlaced = false;
    place(list, timeline.milestones.filter((band) => places.has(band.id)).map((band) => {
      used.bands.add(band.id);
      const where = places.get(band.id);
      const b = bandEl(band);
      put(b.li, where);
      const ox = where.x;
      const oy = where.y;
      attr(b.li, 'data-folded', where.folded ? 'true' : null);
      if (where.folded) {
        drawTile(b, band, tileAt.get(band.id) || where.header, ox, oy);
        place(b.li, [b.h2, b.tile]);
        return b.li;
      }
      drawHead(b, band, where, band.finished === true && !(timeline.now && timeline.now.milestoneId === band.id));
      const parts = [b.head];
      if (where.notice && band.cycleNote) {
        setText(b.noticeText, band.cycleNote);
        // The notice keeps its words whole: the geometry's row is its smallest height, never a clip.
        setStyle(b.notice, 'left', px(where.notice.x - ox));
        setStyle(b.notice, 'top', px(where.notice.y - oy));
        setStyle(b.notice, 'width', px(where.notice.w));
        setStyle(b.notice, 'min-height', px(where.notice.h));
        parts.push(b.notice);
      }
      if (where.empty && where.emptyBox) {
        setText(b.emptyText, band.emptyText || '');
        setText(b.emptyNext, band.emptyNext || '');
        place(b.empty, band.emptyNext ? [b.emptyText, b.emptyNext] : [b.emptyText]);
        put(b.empty, where.emptyBox, ox, oy);
        parts.push(b.empty);
      }
      if (where.axis) {
        put(b.axis, where.axis, ox, oy);
        place(b.ticks, (where.ticks || []).map((t, i) => {
          const tick = b.ticks.children[i] || el('span', 'tl-tick');
          // A tick crosses the axis through the mark's centre, 14 px into the dot box.
          const at = horizontal ? t.at - geo.box.w / 2 + 14 : t.at;
          put(tick, horizontal ? rect(at, where.axis.y - 3, 1, 8) : rect(where.axis.x - 3, at, 8, 1), ox, oy);
          return tick;
        }));
        parts.push(b.axis, b.ticks);
      }
      const holdsNow = !!now && now.milestoneId === band.id;
      const groups = groupsOf(band, byBand.get(band.id) || [], holdsNow && band.phases.length === 0);
      // The +{n} of a step goes in the phase entry of the last dot that step draws, after it; the Now item in the named phase's entry (else the last
      // entry), right before the first dot of the Now step.
      const moreGroup = new Map();
      for (const m of geo.more.filter((x) => x.milestoneId === band.id)) {
        const inStep = timeline.dots.filter((d) => d.milestoneId === band.id && d.step === m.step && boxes.has(d.cardId)).sort((x, y) => x.slot - y.slot);
        const last = inStep[inStep.length - 1];
        const key = last && last.phaseId !== undefined && band.phases.some((p) => p.id === last.phaseId) ? last.phaseId : 'none';
        const target = groups.find((g) => g.key === key) || groups[groups.length - 1];
        if (!target) continue;
        if (!moreGroup.has(target.key)) moreGroup.set(target.key, []);
        moreGroup.get(target.key).push(m);
      }
      const nowGroup = holdsNow ? (groups.find((g) => now.phaseId !== undefined && g.key === now.phaseId) || groups[groups.length - 1]) : undefined;
      const rail = new Map(where.phases.map((p) => [p.id, p]));
      place(b.phases, groups.map((group) => {
        used.groups.add(band.id + '|' + group.key);
        const g = groupEl(band, group);
        const items = group.dots.map((dot) => ({ step: dot.step, slot: dot.slot, node: () => { used.dots.add(dot.cardId); return dotEl(dot, cards.get(dot.cardId), boxes.get(dot.cardId), ox, oy, geo.zoom).li; } }));
        for (const m of moreGroup.get(group.key) || []) items.push({ step: m.step, slot: m.slot, node: () => { used.more.add(band.id + ':' + m.step); return moreEl(band, m, ox, oy).li; } });
        if (group === nowGroup) { nowPlaced = true; items.push({ step: now.step, slot: -1, node: () => { drawNow(now, geo.now, ox, oy); return nowItem; } }); }
        items.sort((x, y) => x.step - y.step || x.slot - y.slot);
        place(g.dots, items.map((item) => item.node()));
        const at = group.phase ? rail.get(group.phase.id) : undefined;
        if (at) labels.push([g, group, at, ox, oy]);
        place(g.li, at ? [g.h3, g.dots, g.label, g.bar] : [g.h3, g.dots]);
        return g.li;
      }));
      parts.push(b.phases);
      place(b.li, parts);
      return b.li;
    }));
    if (!nowPlaced && nowItem.parentNode) nowItem.remove();
    for (const [k] of bandEls) if (!used.bands.has(k)) bandEls.delete(k);
    for (const [k] of groupEls) if (!used.groups.has(k)) groupEls.delete(k);
    for (const [k] of dotEls) if (!used.dots.has(k)) dotEls.delete(k);
    for (const [k] of moreEls) if (!used.more.has(k)) moreEls.delete(k);
    // Labels are measured once every box is on the page.
    for (const [g, group, at, ox, oy] of labels) drawRail(g, group, at, ox, oy, horizontal);
    // One tab stop for the dots, tiles and +{n} buttons: the selected card's dot when it is shown, else the first dot, else the first stop (the
    // arrow keys come with 62.1-05).
    const order = Array.from(list.querySelectorAll('button.tl-dot, button.tl-folded, button.tl-more'));
    const stop = order.find((b) => b.getAttribute('data-id') === board.selected()) || order.find((b) => b.classList.contains('tl-dot')) || order[0];
    for (const b of order) attr(b, 'tabindex', b === stop ? 0 : -1);
    drawn = { timeline, geo, cards, boxes, dotOf, matching };
    followCard();
    followPreview();
    applyEmphasis();
  }

  // ---- the expanded card (62.1-05, D-06, D-01, UI-SPEC "Expanded card") -----------------------------------------------------------------------
  // What the last draw put on the page: the model's timeline and cards, the geometry, the dot boxes and the filter rule, for the card and keys.
  let drawn;
  let open; // { id, faceSig, factsSig, at }
  /** The dot's classes and attributes that follow the card: the selected halo and aria-expanded while its card is open, the dashed pending outline
   * with aria-busy while a request waits, and the refusal mark until the refusal is dismissed or the card changes. */
  function decorate(d, id) {
    const expanded = !!open && open.id === id;
    const busy = board.pendingText(id) !== '';
    const refused = !busy && board.refusalText(id) !== '';
    setClass(d.button, d.base + (expanded ? ' selected' : '') + (busy ? ' pending' : '') + (refused ? ' refused' : ''));
    attr(d.button, 'aria-expanded', expanded ? 'true' : null);
    attr(d.button, 'aria-controls', expanded ? 'tl-card' : null);
    attr(d.button, 'aria-busy', busy ? 'true' : null);
  }
  function redecorate(id) { const d = dotEls.get(id); if (d) decorate(d, id); }
  const dotButton = (id) => { const d = dotEls.get(id); return d && d.button.isConnected ? d.button : null; };
  /** Focus on a dot without opening its preview (focus coming back from the card, the menu or the drawer). */
  let quiet = false;
  function focusDot(id) {
    const b = dotButton(id);
    if (!b) return false;
    quiet = true;
    try { b.focus(); } finally { quiet = false; }
    return document.activeElement === b;
  }

  /** A Waits for or Needed by entry: a link button to a dot that is on the timeline and matches the filters, else the plain name. */
  function linkNode(link) {
    if (!drawn || !drawn.dotOf.has(link.id) || !drawn.matching(link.id)) return el('span', 'tl-card-name', link.label);
    const b = el('button', 'link', link.label);
    b.setAttribute('type', 'button');
    b.addEventListener('click', () => goTo(link.id));
    return b;
  }
  function factRow(term, nodes) {
    const dd = el('dd');
    dd.append(...nodes);
    return [el('dt', '', term), dd];
  }
  /** Fills the card from the model: the board face, the timeline facts, the notes, the pending or refusal line and Move to... (as on the board). */
  function fillCard(c, dot) {
    const face = board.cardFace(c, { clampTitle: false });
    const faceSig = JSON.stringify([c, board.pendingText(c.id), board.refusalText(c.id), face.move]);
    if (open.faceSig !== faceSig) {
      open.faceSig = faceSig;
      cardTitle.replaceChildren(face.title);
      cardFaceBox.replaceChildren(...[face.top, face.meta].concat(face.rule ? [face.rule] : []));
      cardMsg.replaceChildren(...face.msg);
      hide(cardMsg, face.msg.length === 0);
      hide(cardMove, !face.move.visible);
      if (cardMove.textContent !== face.move.label) cardMove.replaceChildren(board.icon('arrow-swap'), el('span', 'label', face.move.label));
      attr(cardMove, 'aria-label', face.move.name);
      attr(cardMove, 'aria-disabled', face.move.disabled ? 'true' : null);
      attr(cardMove, 'title', face.move.title);
    }
    const finished = c.column === 'done' && typeof c.finishedText === 'string' && c.finishedText !== '' ? c.finishedText : '';
    const factsSig = JSON.stringify([dot, finished, drawn.timeline.dots.length, drawn.matching(c.id)]);
    if (open.factsSig !== factsSig) {
      open.factsSig = factsSig;
      const waits = Array.isArray(dot.waitsForLinks) ? dot.waitsForLinks : [];
      const needed = Array.isArray(dot.neededByLinks) ? dot.neededByLinks : [];
      // D-01: the Finished row is the only place a time appears, and only when the model gives it.
      cardFacts.replaceChildren(
        ...factRow(T.factStep, [document.createTextNode(dot.stepFact || '')]),
        ...factRow(T.factWaits, waits.length ? waits.map(linkNode) : [document.createTextNode(T.nothing)]),
        ...(needed.length ? factRow(T.factNeeded, needed.map(linkNode)) : []),
        ...(finished ? factRow(T.factFinished, [document.createTextNode(finished)]) : [])
      );
      const notes = Array.isArray(dot.notes) ? dot.notes : [];
      cardNotes.replaceChildren(...notes.map((n) => el('p', 'tl-card-note', n)));
      hide(cardNotes, notes.length === 0);
    }
  }
  // ---- placing the two layers (UI-SPEC "Placement") -------------------------------------------------------------------------------------------
  const scrollerSize = () => ({ width: scroll.clientWidth > 0 ? scroll.clientWidth : window.innerWidth || 800, height: scroll.clientHeight > 0 ? scroll.clientHeight : window.innerHeight || 600 });
  /** The scroller's visible rectangle in canvas pixels, less the 8 px edge margin. */
  function viewOf() {
    const size = scrollerSize();
    return { left: (scroll.scrollLeft || 0) + LAYER.gap, top: (scroll.scrollTop || 0) + LAYER.gap, width: Math.max(0, size.width - 2 * LAYER.gap), height: Math.max(0, size.height - 2 * LAYER.gap) };
  }
  const asBox = (r) => ({ left: r.x, top: r.y, width: r.w, height: r.h });
  /** What a layer must never cover: the Now pill, every milestone header where it sticks now (with the 8 px margin under it), whose percent and
   * progress words are in it, and every phase label on the rail, which carries the phase percent (probe rules 11 and 12). */
  function obstaclesOf(geo) {
    const out = [];
    if (geo.now) out.push(asBox(geo.now.pill));
    const sl = scroll.scrollLeft || 0;
    const st = scroll.scrollTop || 0;
    for (const b of geo.bands) {
      if (b.folded || !b.header) continue;
      const head = { x: b.header.x, y: b.header.y, w: b.header.w, h: b.header.h + LAYER.gap };
      if (geo.direction === 'horizontal' && b.x <= sl && sl < b.x + b.w) head.x = clamp(sl, b.header.x, b.x + b.w - b.header.w);
      if (geo.direction === 'vertical' && b.y <= st && st < b.y + b.h) head.y = clamp(st, b.y, b.y + b.h - b.header.h);
      out.push(asBox(head));
      for (const ph of b.phases || []) if (ph.label && !ph.label.hidden && ph.label.w > 0) out.push(asBox(ph.label));
    }
    return out;
  }
  /** The drawn height of a layer at its width, or an estimate where nothing is laid out (the vm). */
  function heightOf(node, fallback) {
    const hgt = node.scrollHeight || node.offsetHeight;
    return typeof hgt === 'number' && isFinite(hgt) && hgt > 0 ? hgt : fallback;
  }
  /** Places a layer (the preview or the card) next to the dot's box with the one placement function, and writes where it went. */
  function putLayer(node, box, width, maxHeight, fallback) {
    const view = viewOf();
    const narrow = scrollerSize().width < G.narrow;
    setStyle(node, 'width', px(narrow ? view.width : Math.min(width, view.width)));
    node.style.removeProperty('max-height');
    const size = { width, height: Math.min(heightOf(node, fallback), maxHeight(view)) };
    const r = placeLayer(asBox(box), size, view, obstaclesOf(drawn.geo), { direction: drawn.geo.direction, narrow });
    setStyle(node, 'left', px(r.left));
    setStyle(node, 'top', px(r.top));
    setStyle(node, 'width', px(r.width));
    if (r.capped) setStyle(node, 'max-height', px(r.height));
    attr(node, 'data-side', r.side);
    return r;
  }
  // The expanded card is 320 px wide (the view width under 520 px), its height its content's, at most the scroller less 16 px.
  const CARD = Object.freeze({ width: 320, estimate: 240 });
  /** Places the card next to its dot, again only when the dot moved or the window or the drawing changed (UI-SPEC "Placement"): panning keeps it where
   * it is, beside its dot. */
  function placeCard(box) {
    const size = scrollerSize();
    const at = JSON.stringify([box.x, box.y, box.w, box.h, drawn.geo.direction, drawn.geo.zoom, size.width, size.height]);
    if (open.at === at) return;
    open.at = at;
    putLayer(cardBox, box, CARD.width, (view) => view.height, CARD.estimate);
  }
  function openCard(id, options) {
    const c = board.cardData(id);
    const dot = drawn && drawn.dotOf.get(id);
    if (!c || !dot || !drawn.boxes.has(id) || !dotButton(id)) return;
    hidePreview();
    const was = open ? open.id : undefined;
    open = { id, faceSig: '', factsSig: '', at: '' };
    attr(cardBox, 'data-id', id);
    board.select(id);
    fillCard(c, dot);
    showLayer(cardBox, true);
    placeCard(drawn.boxes.get(id));
    if (was !== undefined && was !== id) redecorate(was);
    redecorate(id);
    applyEmphasis();
    if (!options || options.focus !== false) cardTitle.focus();
  }
  /** Closes the card. With restore, focus goes back to the dot when it was inside the card (or nowhere). */
  function closeCard(restore) {
    if (!open) return;
    const id = open.id;
    const a = document.activeElement;
    const inside = !a || a === document.body || !a.isConnected || cardBox.contains(a);
    open = undefined;
    showLayer(cardBox, false);
    attr(cardBox, 'data-id', null);
    redecorate(id);
    applyEmphasis();
    if (restore && inside) focusDot(id);
  }
  /** After a draw: the card follows its dot, takes the new model's words, and closes when its card left the board or its dot is not drawn. */
  function followCard() {
    if (!open) return;
    const c = board.cardData(open.id);
    const dot = drawn.dotOf.get(open.id);
    if (!c || !dot || !drawn.boxes.has(open.id) || !drawn.matching(open.id) || !dotButton(open.id)) {
      const left = !c;
      closeCard(false);
      if (left) board.announce(T.gone);
      return;
    }
    fillCard(c, dot);
    placeCard(drawn.boxes.get(open.id));
  }
  /** The timeline is gone from the page or could not be drawn: no card, no preview and no emphasis survive it. */
  function dropLayers() {
    open = undefined;
    showLayer(cardBox, false);
    hidePreview();
    hoverId = undefined;
    focusId = undefined;
  }
  /** A Waits for or Needed by link: focus moves to that dot and its card opens beside it. */
  function goTo(id) {
    if (!dotButton(id)) return;
    openCard(id, { focus: false });
    focusDot(id);
  }

  // ---- the preview and the line emphasis (62.1-05, D-06, D-07, UI-SPEC "Preview") ----------------------------------------------------------------
  let shownPreview; // { id, how: 'pointer' | 'keyboard' }
  let hoverId;
  let focusId;
  let hoverTimer;
  let leaveTimer;
  let warmTimer;
  let warm = false;
  const PREVIEW = Object.freeze({ delay: 300, linger: 100, warm: 600, width: 256, estimate: 160 });
  /** The preview's words: the state and display ID and the badges from the board face, the title (clamped to 3 lines by the stylesheet), who, the
   * step, what it waits for and how to open the card. */
  function fillPreview(c, dot, how) {
    const face = board.cardFace(c);
    const badges = Array.from(face.meta.children).filter((n) => n.classList.contains('badge'));
    const parts = [face.top, el('p', 'tl-preview-title', c.title)];
    if (badges.length) { const row = el('div', 'tl-preview-badges'); row.append(...badges); parts.push(row); }
    const step = el('p', 'tl-preview-step');
    step.append(el('span', '', dot.stepText || ''), el('span', '', dot.waitsText || ''));
    parts.push(el('p', 'tl-preview-who', dot.whoText || ''), step, el('p', 'tl-preview-hint', how === 'pointer' ? T.previewPointer : T.previewKeyboard));
    previewBox.replaceChildren(...parts);
  }
  function showPreview(id, how) {
    clearTimeout(hoverTimer); hoverTimer = undefined;
    clearTimeout(leaveTimer); leaveTimer = undefined;
    const c = board.cardData(id);
    const dot = drawn && drawn.dotOf.get(id);
    if (!c || !dot || !drawn.boxes.has(id) || (open && open.id === id)) return;
    shownPreview = { id, how };
    attr(previewBox, 'data-id', id);
    fillPreview(c, dot, how);
    showLayer(previewBox, true);
    putLayer(previewBox, drawn.boxes.get(id), PREVIEW.width, (view) => (view.height + 2 * LAYER.gap) / 2, PREVIEW.estimate);
  }
  /** Closes the preview; for 600 ms after, the next dot's preview opens with no delay. */
  function hidePreview() {
    clearTimeout(hoverTimer); hoverTimer = undefined;
    clearTimeout(leaveTimer); leaveTimer = undefined;
    if (!shownPreview) return;
    shownPreview = undefined;
    showLayer(previewBox, false);
    attr(previewBox, 'data-id', null);
    warm = true;
    clearTimeout(warmTimer);
    warmTimer = setTimeout(() => { warm = false; warmTimer = undefined; }, PREVIEW.warm);
  }
  /** After a draw the preview follows its dot, or closes when its dot is gone. */
  function followPreview() {
    if (!shownPreview) return;
    const id = shownPreview.id;
    if (!drawn.boxes.has(id) || !drawn.matching(id) || !dotButton(id) || (open && open.id === id)) { hidePreview(); return; }
    const c = board.cardData(id);
    fillPreview(c, drawn.dotOf.get(id), shownPreview.how);
    putLayer(previewBox, drawn.boxes.get(id), PREVIEW.width, (view) => (view.height + 2 * LAYER.gap) / 2, PREVIEW.estimate);
  }
  function pointerIn(id) {
    hoverId = id;
    clearTimeout(leaveTimer); leaveTimer = undefined;
    applyEmphasis();
    if ((open && open.id === id) || (shownPreview && shownPreview.id === id)) return;
    clearTimeout(hoverTimer); hoverTimer = undefined;
    if (shownPreview || warm) showPreview(id, 'pointer');
    else hoverTimer = setTimeout(() => { hoverTimer = undefined; if (hoverId === id) showPreview(id, 'pointer'); }, PREVIEW.delay);
  }
  function pointerOut(id) {
    if (hoverId === id) hoverId = undefined;
    clearTimeout(hoverTimer); hoverTimer = undefined;
    applyEmphasis();
    if (shownPreview && shownPreview.id === id && shownPreview.how === 'pointer') {
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => { leaveTimer = undefined; hidePreview(); }, PREVIEW.linger);
    }
  }
  function focusIn(id) {
    focusId = id;
    applyEmphasis();
    // Focus coming back from the card, the menu or the drawer does not pop the preview up again.
    if (quiet || (open && open.id === id)) return;
    showPreview(id, 'keyboard');
  }
  function focusOut(id) {
    if (focusId === id) focusId = undefined;
    applyEmphasis();
    if (shownPreview && shownPreview.id === id) hidePreview();
  }
  /** Emphasises the in and out lines of one card: the hovered dot, else the focused dot, else the open card (D-07). Other lines stay at rest. */
  function applyEmphasis() {
    const id = hoverId || (focusId && dotButton(focusId) ? focusId : undefined) || (open ? open.id : undefined);
    for (const p of Array.from(lines.children)) {
      const on = id !== undefined && (p.getAttribute('data-from') === id || p.getAttribute('data-to') === id);
      if (p.classList.contains('emphasis') !== on) p.classList.toggle('emphasis', on);
    }
  }
  // Escape on a dot backs out one level: the card, else the preview (the menu takes its own Escape).
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (!e.target || !e.target.closest || !e.target.closest('button.tl-dot, button.tl-folded, button.tl-more')) return;
    if (open) { e.preventDefault(); closeCard(false); return; }
    if (shownPreview) { e.preventDefault(); hidePreview(); }
  });
  // A width change re-places the card and the preview (the drawing itself redraws on the board's breakpoint).
  if (typeof window.ResizeObserver === 'function') {
    new window.ResizeObserver(() => {
      if (!drawn || !scroll.isConnected) return;
      if (open && drawn.boxes.has(open.id)) placeCard(drawn.boxes.get(open.id));
      if (shownPreview && drawn.boxes.has(shownPreview.id)) putLayer(previewBox, drawn.boxes.get(shownPreview.id), PREVIEW.width, (view) => (view.height + 2 * LAYER.gap) / 2, PREVIEW.estimate);
    }).observe(scroll);
  }
  list.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button.tl-dot') : null;
    if (!b || !list.contains(b)) return;
    const id = b.getAttribute('data-id');
    if (open && open.id === id) { cardTitle.focus(); return; }
    openCard(id);
  });
  cardClose.addEventListener('click', () => closeCard(true));
  cardMove.addEventListener('click', () => { if (open && cardMove.getAttribute('aria-disabled') !== 'true') board.openMenu(open.id, cardMove); });
  cardDetails.addEventListener('click', () => {
    if (!open) return;
    const id = open.id;
    const opener = dotButton(id);
    closeCard(false);
    board.openDetail(id, opener);
  });
  cardBox.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    closeCard(true);
  });
  // A click or tap anywhere outside the card and the menu closes it; a click on another dot switches it (the list's handler).
  document.addEventListener('click', (e) => {
    if (!open) return;
    const t = e.target;
    // A menu item that just closed its menu is no longer on the page.
    if (!t || !t.isConnected || cardBox.contains(t)) return;
    const menu = document.getElementById('menu');
    if (menu && menu.contains(t)) return;
    const b = t.closest ? t.closest('button.tl-dot') : null;
    if (b && list.contains(b)) return;
    closeCard(true);
  });

  board.registerView('timeline', {
    render,
    /** The board changed a card's pending or refusal line: draw again so the dot and the card show it. */
    refresh: () => board.redraw(),
    /** The board gives focus back to a card (after the menu or the drawer): its dot. */
    focus: (id) => focusDot(id)
  });
})();
