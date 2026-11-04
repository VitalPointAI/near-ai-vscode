// Team Board timeline (62.1-UI-SPEC, D-02, D-04): the board's second view, one timeline for the whole project. Milestones are bands, phases are
// segments inside them and every card is a dot in dependency order, from the host's model.timeline (src/domain/team/timeline.ts). This script plugs
// into board.js through window.NearAiBoard like menu.js and detail.js; the toolbar, banners, live region, Move to... menu and detail drawer stay the
// board's. Plain browser JavaScript in one strict IIFE: every text node is set with textContent and every attribute with setAttribute, positions only
// with style.setProperty, no markup strings and no network. The page never decides permissions and posts no message the board does not already post.
// What it draws here is the screen reader structure (ordered lists of milestones, phases and dots); 62.1-04 draws it on the canvas.
(function () {
  'use strict';
  // The page's own words (the timeline's sentences come from the model). The plain-language scan reads this file.
  const T = Object.freeze({
    region: 'Team Board timeline',
    milestones: 'Milestones',
    phasesIn: (title) => 'Phases in ' + title,
    cardsIn: (name) => 'Cards in ' + name + ', in order',
    phase: (number) => 'Phase ' + number
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
    canvasPad: 32, minBand: 368, barColumn: 8, minLabel: 24, narrow: 520
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
      const railTop = G.padAcross + G.head + G.gap;
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
          const base = y + G.head + G.padAlong;
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
            gutter: rect(gx, y + G.head, gutter, end + G.padAlong - y - G.head), axis: rect(slot0 + bh / 2 - 1, base, 2, end - base), phases,
            ticks: p.columns.map((col, s) => ({ step: s, at: top(s) + bh / 2 }))
          };
          if (nowGap) band.nowGap = nowGap;
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

  window.NearAiTimeline = Object.freeze({ geometry, sizes: G });

  const board = window.NearAiBoard;
  if (!board) return;

  // ---- small helpers -------------------------------------------------------------------------------------------------------------------------
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
  const attr = (n, k, v) => { if (v === null || v === undefined || v === false) { if (n.getAttribute(k) !== null) n.removeAttribute(k); } else if (n.getAttribute(k) !== String(v)) n.setAttribute(k, String(v)); };
  /** Puts exactly these nodes, in this order, into the parent. Nodes already there are kept (so focus survives), others are moved or removed. */
  function place(parent, nodes) {
    let i = 0;
    for (const n of nodes) { const cur = parent.children[i]; if (cur !== n) parent.insertBefore(n, cur || null); i += 1; }
    while (parent.children.length > nodes.length) parent.children[parent.children.length - 1].remove();
  }
  // The main appearance of a dot (UI-SPEC "State colours"): blocked, then on hold, then the column.
  const stateOf = (c) => (c.blocked ? 'blocked' : c.held ? 'held' : c.column);

  // ---- the screen reader structure (UI-SPEC "Screen Reader Structure") ------------------------------------------------------------------------
  const scroll = el('div', 'tl-scroll');
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', T.region);
  const list = el('ol', 'tl-milestones');
  list.setAttribute('aria-label', T.milestones);
  scroll.appendChild(list);
  const bandEls = new Map();
  const groupEls = new Map();
  const dotEls = new Map();

  function bandEl(band) {
    let b = bandEls.get(band.id);
    if (!b) {
      const li = el('li', 'tl-milestone');
      li.setAttribute('data-milestone', band.id);
      const head = el('div', 'tl-ms-head');
      const h2 = el('h2', 'tl-ms-title');
      head.appendChild(h2);
      const phases = el('ol', 'tl-phases');
      li.append(head, phases);
      b = { li, h2, phases };
      bandEls.set(band.id, b);
    }
    setText(b.h2, band.heading);
    attr(b.phases, 'aria-label', T.phasesIn(band.title));
    return b;
  }
  // A phase's list entry, or the entry of the dots with no phase in their band (the cards added on the board), named after the band.
  function groupEl(band, group) {
    const key = band.id + '|' + group.key;
    let g = groupEls.get(key);
    if (!g) {
      const li = el('li', 'tl-phase');
      li.setAttribute('data-phase', group.key);
      const h3 = el('h3', 'tl-phase-label');
      const dots = el('ol', 'tl-dots');
      li.append(h3, dots);
      g = { li, h3, dots };
      groupEls.set(key, g);
    }
    setText(g.h3, group.phase ? group.phase.heading : band.title);
    attr(g.dots, 'aria-label', T.cardsIn(group.phase ? T.phase(group.phase.number) : band.title));
    return g;
  }
  function dotEl(dot, card) {
    let d = dotEls.get(dot.cardId);
    if (!d) {
      const li = el('li');
      const b = el('button', 'tl-dot');
      b.setAttribute('type', 'button');
      b.setAttribute('data-id', dot.cardId);
      li.appendChild(b);
      d = { li, button: b };
      dotEls.set(dot.cardId, d);
    }
    attr(d.button, 'data-step', dot.step);
    attr(d.button, 'data-slot', dot.slot);
    attr(d.button, 'data-state', stateOf(card));
    attr(d.button, 'aria-label', dot.label);
    attr(d.button, 'aria-current', board.selected() === dot.cardId ? 'true' : null);
    return d;
  }
  // The phases of a band in the model's order (first step, then phase number), each with its dots in sequence order (step, then slot); dots whose
  // phase is not one of the band's go in one entry placed by its first step.
  function groupsOf(band, dots) {
    const groups = band.phases.map((phase) => ({ key: phase.id, phase, first: phase.firstStep, dots: [] }));
    const byId = new Map(groups.map((g) => [g.key, g]));
    let loose;
    for (const dot of dots) {
      const g = dot.phaseId !== undefined ? byId.get(dot.phaseId) : undefined;
      if (g) g.dots.push(dot);
      else { if (!loose) loose = { key: 'none', phase: undefined, first: dot.step, dots: [] }; loose.dots.push(dot); }
    }
    if (loose) {
      const at = groups.findIndex((g) => g.first > loose.first);
      groups.splice(at < 0 ? groups.length : at, 0, loose);
    }
    return groups;
  }

  function render(container, shown) {
    const model = board.model();
    const timeline = model && model.timeline;
    const cards = new Map((model ? model.cards : []).map((c) => [c.id, c]));
    const shownIds = new Set(shown.map((c) => c.id));
    const byBand = new Map();
    for (const dot of timeline ? timeline.dots : []) {
      if (!shownIds.has(dot.cardId) || !cards.has(dot.cardId)) continue;
      if (!byBand.has(dot.milestoneId)) byBand.set(dot.milestoneId, []);
      byBand.get(dot.milestoneId).push(dot);
    }
    const usedBands = new Set();
    const usedGroups = new Set();
    const usedDots = new Set();
    place(list, (timeline ? timeline.milestones : []).map((band) => {
      usedBands.add(band.id);
      const b = bandEl(band);
      place(b.phases, groupsOf(band, byBand.get(band.id) || []).map((group) => {
        usedGroups.add(band.id + '|' + group.key);
        const g = groupEl(band, group);
        place(g.dots, group.dots.map((dot) => { usedDots.add(dot.cardId); return dotEl(dot, cards.get(dot.cardId)).li; }));
        return g.li;
      }));
      return b.li;
    }));
    for (const [k] of bandEls) if (!usedBands.has(k)) bandEls.delete(k);
    for (const [k] of groupEls) if (!usedGroups.has(k)) groupEls.delete(k);
    for (const [k] of dotEls) if (!usedDots.has(k)) dotEls.delete(k);
    // One tab stop for the dots: the selected card's dot when it is shown, else the first (the arrow keys come with 62.1-05).
    const order = Array.from(list.querySelectorAll('button.tl-dot'));
    const stop = order.find((b) => b.getAttribute('data-id') === board.selected()) || order[0];
    for (const b of order) attr(b, 'tabindex', b === stop ? 0 : -1);
    place(container, [scroll]);
  }

  board.registerView('timeline', { render });
})();
