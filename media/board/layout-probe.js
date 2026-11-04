// Team Board layout probe (Phase 62 plan 16). TEST-ONLY: the host loads it after board.js only under NEAR_AI_E2E=1, .vscodeignore drops it from the
// package, and the release check fails if it is ever packaged. It answers only on a page the host marked with data-e2e="1".
// The extension-host tests send { type: 'e2e-layout', id, action, top, left, itemId } and get back one { type: 'e2e-layout-report', id, report }:
// the real board measured in CSS pixels of the page's own viewport, and a list of plain problems (sideways scroll, a see-through or covering toolbar,
// overlapping or spilling headers, lanes, cells and cards, a focused card hidden under the headers, no work on the first screen, unreadable cards).
// collect() only reads the page and returns plain numbers and strings; check(data) is pure, so every rule can be proven on hand-made measurements.
// Same page rules as the board: an IIFE, text nodes only, no markup, no network, no colour literal; it posts through window.NearAiBoard.post.
(function () {
  'use strict';
  if (!document.body || document.body.getAttribute('data-e2e') !== '1') return;
  const board = window.NearAiBoard;
  const TOL = 1;
  const WORD_CARDS = 60;
  const WORD_LIMIT = 40;
  const OUTSIDE_LIMIT = 10;
  const PER_RULE = 12;
  const SIDES = { top: 'above', bottom: 'below', left: 'to the left of', right: 'to the right of' };

  // ---- reading the page ------------------------------------------------------------------------------------------------------------------------
  const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : 0);
  const r0 = (v) => Math.round(v);
  const styleOf = (n) => {
    if (!n || typeof window.getComputedStyle !== 'function') return null;
    try { return window.getComputedStyle(n); } catch (error) { return null; }
  };
  const read = (s, key) => (s && typeof s[key] === 'string' ? s[key] : '');
  const size = (s) => { const v = parseFloat(read(s, 'fontSize')); return s && isFinite(v) ? v : null; };
  function rectOf(n) {
    const r = n && typeof n.getBoundingClientRect === 'function' ? n.getBoundingClientRect() : null;
    const left = r ? num(r.left) : 0;
    const top = r ? num(r.top) : 0;
    const right = r ? num(r.right) : 0;
    const bottom = r ? num(r.bottom) : 0;
    return { left, top, right, bottom, width: num(right - left), height: num(bottom - top) };
  }
  const textOf = (n) => (n ? String(n.textContent || '').trim() : '');
  const up = (n, selector) => (n && typeof n.closest === 'function' ? n.closest(selector) : null);
  const hasClass = (n, name) => !!n && String(n.className || '').split(/\s+/).indexOf(name) >= 0;
  const all = (scope, selector) => (scope ? Array.from(scope.querySelectorAll(selector)) : []);
  const isRendered = (n) => (typeof n.getClientRects === 'function' ? n.getClientRects().length > 0 : !up(n, '[hidden]'));
  function describe(n) {
    const classes = String(n.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return String(n.localName || n.tagName || 'node').toLowerCase() + (n.id ? '#' + n.id : '') + (classes.length ? '.' + classes.join('.') : '');
  }
  function themeOf() {
    const kind = document.body.getAttribute('data-vscode-theme-kind');
    if (kind) return kind.replace(/^vscode-/, '');
    const m = /\bvscode-(high-contrast-light|high-contrast|light|dark)\b/.exec(String(document.body.className || ''));
    return m ? m[1] : '';
  }
  function cardLabel(id, li) {
    const c = board && typeof board.cardData === 'function' ? board.cardData(id) : undefined;
    if (c && c.displayId) return c.kind === 'plan' ? 'plan ' + c.displayId : String(c.displayId);
    return textOf(li.querySelector('.did')) || id;
  }

  /**
   * The words of a title with where each starts. A hyphen-joined word counts as its parts, each keeping its hyphen ("two-lead" is "two-" and "lead"):
   * Chromium may end a line right after a hyphen, as the Unicode line breaking rules allow, and that keeps whole parts on each line (62-21).
   */
  function wordsIn(text) {
    const out = [];
    const pattern = /[^\s-]+-*|-+/g;
    let m;
    while ((m = pattern.exec(String(text))) !== null) out.push({ text: m[0], index: m.index });
    return out;
  }

  // Each word of a card title, measured with a Range: on how many lines it sits and how wide it is in total.
  function wordsOf(titleEl) {
    const out = [];
    if (!titleEl || typeof document.createRange !== 'function') return out;
    const node = titleEl.firstChild;
    if (!node || node.nodeType !== 3) return out;
    const value = String(node.nodeValue === undefined || node.nodeValue === null ? node.textContent : node.nodeValue);
    const range = document.createRange();
    for (const m of wordsIn(value).slice(0, WORD_LIMIT)) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m.text.length);
      const tops = [];
      let width = 0;
      for (const r of Array.from(range.getClientRects())) {
        if (!(r.width > 0)) continue;
        width += r.width;
        if (!tops.some((t) => Math.abs(t - r.top) < 2)) tops.push(r.top);
      }
      out.push({ text: m.text.slice(0, 40), lines: tops.length, width: num(width) });
    }
    if (typeof range.detach === 'function') range.detach();
    return out;
  }

  // True when an ancestor below body clips or scrolls sideways, so the node cannot widen the page.
  function contained(n) {
    for (let p = n.parentNode; p && p !== document.body && p !== document.documentElement && p.nodeType === 1; p = p.parentNode) {
      if (read(styleOf(p), 'overflowX') && read(styleOf(p), 'overflowX') !== 'visible') return true;
    }
    return false;
  }

  /** Reads the page as it is drawn now. Plain numbers and strings only. withWords false skips the per-word measuring (for quick rects). */
  function collect(withWords) {
    const doc = document.documentElement;
    const scroller = document.scrollingElement || doc;
    const rootEl = document.getElementById('root');
    const layout = (rootEl && rootEl.getAttribute('data-layout')) || (board && typeof board.layout === 'function' ? board.layout() : 'kanban');
    const kanban = layout === 'kanban';
    const width = num(window.innerWidth);
    const height = num(window.innerHeight);
    const page = { scrollWidth: num(scroller.scrollWidth), clientWidth: num(scroller.clientWidth || doc.clientWidth), scrollY: num(window.scrollY || scroller.scrollTop) };

    const tbEl = document.getElementById('toolbar');
    const tbStyle = styleOf(tbEl);
    const toolbar = tbEl ? Object.assign(rectOf(tbEl), { background: read(tbStyle, 'backgroundColor'), position: read(tbStyle, 'position') }) : null;
    const regionEl = kanban ? document.querySelector('.board-scroll') : document.getElementById('board');
    const region = regionEl ? Object.assign(rectOf(regionEl), { scrollTop: num(regionEl.scrollTop), scrollLeft: num(regionEl.scrollLeft) }) : null;
    const headRowEl = kanban && regionEl ? regionEl.querySelector('.colheads') : null;
    const headRowStyle = styleOf(headRowEl);
    const headRow = headRowEl ? Object.assign(rectOf(headRowEl), { background: read(headRowStyle, 'backgroundColor'), position: read(headRowStyle, 'position') }) : null;

    const outside = [];
    if (page.scrollWidth > page.clientWidth + TOL && typeof window.getComputedStyle === 'function') {
      for (const n of all(document.body, '*')) {
        if (outside.length >= OUTSIDE_LIMIT) break;
        if (kanban && regionEl && regionEl.contains(n)) continue;
        const r = rectOf(n);
        if ((r.width || r.height) && r.right > page.clientWidth + TOL && !contained(n)) outside.push({ what: describe(n), right: r.right });
      }
    }

    const columnLabels = {};
    const heads = all(headRowEl, '.column').map((h) => {
      const column = h.getAttribute('data-column') || '';
      const label = textOf(h.querySelector('.col-name')) || column;
      columnLabels[column] = label;
      const r = rectOf(h);
      let contentRight = r.left;
      let contentBottom = r.top;
      for (const n of all(h, '*')) {
        const c = rectOf(n);
        if (!c.width && !c.height) continue;
        contentRight = Math.max(contentRight, c.right);
        contentBottom = Math.max(contentBottom, c.bottom);
      }
      return Object.assign({ column, label }, r, { folded: hasClass(h, 'collapsed'), contentRight: num(contentRight), contentBottom: num(contentBottom) });
    });

    const laneLabels = {};
    const lanes = (kanban ? all(regionEl, '.lane') : []).map((l) => {
      const lane = l.getAttribute('data-lane') || '';
      const label = textOf(l.querySelector('.lane-label')) || lane;
      laneLabels[lane] = label;
      const grid = l.querySelector('.lane-grid');
      const parts = [['header', '.lane-title'], ['progress', '.lane-progress'], ['grid', '.lane-grid']]
        .map(([what, selector]) => [what, l.querySelector(selector)])
        .filter(([, n]) => n && isRendered(n))
        .map(([what, n]) => Object.assign({ what }, rectOf(n)));
      return Object.assign({ lane, label }, rectOf(l), { collapsed: !grid || grid.hidden === true || !isRendered(grid), parts });
    });

    const cells = (kanban ? all(regionEl, '.cell') : []).map((c) => {
      const lane = c.getAttribute('data-lane') || '';
      const column = c.getAttribute('data-column') || '';
      return Object.assign({ lane, laneLabel: laneLabels[lane] || lane, column, columnLabel: columnLabels[column] || column }, rectOf(c), { folded: hasClass(c, 'collapsed'), rendered: isRendered(c) });
    });

    let measured = 0;
    const cards = all(document.getElementById('board') || document.body, '.card').map((li) => {
      const id = li.getAttribute('data-id') || '';
      const laneNode = up(li, '[data-lane]');
      const s = styleOf(li);
      const titleEl = li.querySelector('.card-title');
      const mainEl = li.querySelector('.card-main');
      const titleStyle = styleOf(titleEl);
      const mainStyle = styleOf(mainEl);
      const rendered = isRendered(li);
      const r = rectOf(li);
      const t = rectOf(titleEl);
      const words = withWords !== false && rendered && measured < WORD_CARDS ? wordsOf(titleEl) : [];
      if (words.length) measured += 1;
      const overflow = (a, b) => (typeof li[a] === 'number' && typeof li[b] === 'number' ? num(li[a] - li[b]) : 0);
      return Object.assign({ id, label: cardLabel(id, li), column: li.getAttribute('data-column') || '', lane: laneNode ? laneNode.getAttribute('data-lane') || '' : '' }, r, {
        draggable: li.getAttribute('draggable') === 'true', rendered, inFoldedCell: !!up(li, '.cell.collapsed') || !!up(li, '.column.collapsed'),
        fontSize: size(s), overflowX: overflow('scrollWidth', 'clientWidth'), overflowY: overflow('scrollHeight', 'clientHeight'),
        color: read(s, 'color'), background: read(s, 'backgroundColor'),
        title: { width: t.width, height: t.height, fontSize: size(titleStyle) },
        main: { align: read(mainStyle, 'textAlign'), color: read(mainStyle, 'color'), background: read(mainStyle, 'backgroundColor') },
        words
      });
    });

    const active = document.activeElement;
    const focusedLi = up(active, '.card');
    const focused = focusedLi ? Object.assign({ id: focusedLi.getAttribute('data-id') || '', label: cardLabel(focusedLi.getAttribute('data-id') || '', focusedLi) }, rectOf(focusedLi)) : undefined;
    const model = board && typeof board.model === 'function' ? board.model() : undefined;
    const openWork = model && Array.isArray(model.cards) ? model.cards.filter((c) => c.column === 'backlog' || c.column === 'ready').length : 0;

    const data = { width, height, layout, theme: themeOf(), page, outside, toolbar, region, headRow, heads, lanes, cells, cards, openWork };
    if (focused) data.focused = focused;
    return data;
  }

  // ---- checking the measurements (pure) --------------------------------------------------------------------------------------------------------
  function alphaOf(colour) {
    const c = String(colour || '').trim().toLowerCase();
    if (!c || c === 'transparent') return 0;
    const inner = /\(([^)]*)\)/.exec(c);
    if (!inner) return 1;
    const share = (text) => { const t = text.trim(); const v = parseFloat(t); return isFinite(v) ? (/%$/.test(t) ? v / 100 : v) : 1; };
    const slash = inner[1].split('/');
    if (slash.length > 1) return share(slash[1]);
    const parts = inner[1].split(',');
    return parts.length === 4 ? share(parts[3]) : 1;
  }
  const same = (a, b) => String(a || '').replace(/\s+/g, '').toLowerCase() === String(b || '').replace(/\s+/g, '').toLowerCase();
  const span = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1);
  const overX = (a, b) => span(a.left, a.right, b.left, b.right);
  const overY = (a, b) => span(a.top, a.bottom, b.top, b.bottom);
  const boxed = (b) => !!b && (b.right - b.left) >= TOL && (b.bottom - b.top) >= TOL && (b.width === undefined || b.width >= TOL) && (b.height === undefined || b.height >= TOL);
  const shown = (c) => c.rendered !== false;
  const stuck = (b) => !!b && (b.position === 'sticky' || b.position === 'fixed');
  function spill(inner, outer) {
    const d = { top: outer.top - inner.top, bottom: inner.bottom - outer.bottom, left: outer.left - inner.left, right: inner.right - outer.right };
    let side = '';
    let by = TOL;
    for (const k of ['bottom', 'right', 'top', 'left']) if (d[k] > by) { side = k; by = d[k]; }
    return side ? { by: r0(by), where: SIDES[side] } : null;
  }
  const listNames = (names) => (names.length <= 1 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]);
  // Where the board's visible area starts and ends: below a toolbar that stays put and (in the kanban) below the column header row.
  function visibleArea(data) {
    const kanban = data.layout === 'kanban';
    const region = data.region;
    const toolbarBottom = data.toolbar && stuck(data.toolbar) ? data.toolbar.bottom : 0;
    const headBottom = kanban && data.headRow ? data.headRow.bottom : 0;
    return {
      top: Math.max(0, toolbarBottom, headBottom), toolbarBottom, headBottom,
      bottom: Math.min(data.height, region ? region.bottom : data.height),
      left: Math.max(0, region ? region.left : 0), right: Math.min(data.width, region ? region.right : data.width)
    };
  }
  function visibleCount(data) {
    const v = visibleArea(data);
    return (data.cards || []).filter((c) => shown(c) && boxed(c) && !c.inFoldedCell && c.top >= v.top - TOL && c.bottom <= v.bottom + TOL && c.left >= v.left - TOL && c.right <= v.right + TOL).length;
  }
  function focusProblem(data) {
    const f = data.focused;
    if (!f) return '';
    const v = visibleArea(data);
    if (f.top < v.top - TOL) return 'The focused card ' + f.label + ' is hidden under the ' + (v.headBottom > v.toolbarBottom ? 'column headers' : 'toolbar') + ' (' + r0(v.top - f.top) + ' px covered)';
    if (f.bottom > v.bottom + TOL || f.left < v.left - TOL || f.right > v.right + TOL) return 'The focused card ' + f.label + ' is not fully visible on the screen';
    return '';
  }

  /** Every broken rule as one plain sentence; an empty list for a clean board. */
  function check(data) {
    const problems = [];
    // One rule may name many things; after PER_RULE sentences the rest is counted, so a broken board gives a readable list.
    const rule = () => { let n = 0; let more = 0; return { add(text) { if (n < PER_RULE) { problems.push(text); n += 1; } else more += 1; }, end(what) { if (more) problems.push('And ' + more + ' more ' + what + '.'); } }; };
    const kanban = data.layout === 'kanban';
    const page = data.page || { scrollWidth: 0, clientWidth: 0, scrollY: 0 };
    const region = data.region;
    const cards = (data.cards || []).filter(shown);
    const sized = cards.filter(boxed);
    const headByColumn = {};
    for (const h of data.heads || []) headByColumn[h.column] = h;

    // The page itself never scrolls sideways: in the kanban only the board region may.
    const sideways = page.scrollWidth - page.clientWidth;
    if (sideways > TOL) {
      const where = kanban ? 'outside the board region' : 'in the list layout';
      const names = (data.outside || []).map((o) => o.what + ' ends at ' + r0(o.right) + ' px');
      problems.push('The page scrolls sideways by ' + r0(sideways) + ' px ' + where + (names.length ? ': ' + names.join(', ') : ''));
    }

    // The toolbar is opaque, covers nothing and leaves room for the board.
    const tb = data.toolbar;
    if (tb) {
      if (alphaOf(tb.background) < 1) problems.push('The toolbar background is not opaque (' + (tb.background || 'none') + ')');
      const regionCover = region && overX(tb, region) > TOL ? Math.max(0, overY(tb, region)) : 0;
      const covered = sized.filter((c) => {
        const seen = region ? { left: Math.max(c.left, region.left), right: Math.min(c.right, region.right), top: Math.max(c.top, region.top), bottom: Math.min(c.bottom, region.bottom) } : c;
        return seen.right - seen.left > TOL && seen.bottom - seen.top > TOL && overX(tb, seen) > TOL && overY(tb, seen) > TOL;
      }).map((c) => c.label);
      if (regionCover > TOL || covered.length) {
        const cardText = covered.length ? (covered.length === 1 ? 'card ' : 'the cards ') + listNames(covered.slice(0, 6)) + (covered.length > 6 ? ' and ' + (covered.length - 6) + ' more' : '') : '';
        problems.push('The toolbar covers ' + (regionCover > TOL ? r0(regionCover) + ' px of the board region' + (cardText ? ' and ' + cardText : '') : cardText));
      }
      if (data.height > 0 && tb.height > data.height * 0.4) problems.push('The toolbar is ' + r0(tb.height) + ' px tall, more than 40 percent of the ' + r0(data.height) + ' px page');
    }

    if (kanban) {
      const heads = (data.heads || []).slice().sort((a, b) => a.left - b.left);
      const spillRule = rule();
      for (const h of heads) {
        const by = Math.max(h.contentRight - h.right, h.contentBottom - h.bottom);
        if (by > TOL) spillRule.add('Column header ' + h.label + ' spills ' + r0(by) + ' px past its box');
      }
      spillRule.end('column headers spill');
      const headPairs = rule();
      for (let i = 0; i < heads.length; i += 1) for (let j = i + 1; j < heads.length; j += 1) {
        const x = overX(heads[i], heads[j]);
        if (x > TOL && overY(heads[i], heads[j]) > TOL) headPairs.add('Column headers ' + heads[i].label + ' and ' + heads[j].label + ' overlap by ' + r0(x) + ' px');
      }
      headPairs.end('column header overlaps');

      const lanes = (data.lanes || []).slice().sort((a, b) => a.top - b.top);
      const lanePairs = rule();
      for (let i = 0; i < lanes.length; i += 1) for (let j = i + 1; j < lanes.length; j += 1) {
        const y = overY(lanes[i], lanes[j]);
        if (y > TOL && overX(lanes[i], lanes[j]) > TOL) lanePairs.add('Lanes ' + lanes[i].label + ' and ' + lanes[j].label + ' overlap by ' + r0(y) + ' px');
      }
      lanePairs.end('lane overlaps');
      const partRule = rule();
      const laneByKey = {};
      for (const l of lanes) {
        laneByKey[l.lane] = l;
        for (const p of l.parts || []) { const s = spill(p, l); if (s) partRule.add('Lane ' + l.label + "'s " + p.what + ' spills ' + s.by + ' px ' + s.where + ' its lane'); }
      }
      partRule.end('lane parts spill');

      const cells = (data.cells || []).filter(shown);
      const lineRule = rule();
      const inLaneRule = rule();
      for (const c of cells) {
        const name = c.laneLabel + ' / ' + c.columnLabel;
        const h = headByColumn[c.column];
        if (h) {
          const off = Math.max(Math.abs(c.left - h.left), Math.abs(c.right - h.right));
          if (off > TOL) lineRule.add('Cell ' + name + ' does not line up under its column header (' + r0(off) + ' px off)');
        }
        const l = laneByKey[c.lane];
        const s = l ? spill(c, l) : null;
        if (s) inLaneRule.add('Cell ' + name + ' spills ' + s.by + ' px ' + s.where + ' its lane');
      }
      lineRule.end('cells off their headers');
      inLaneRule.end('cells outside their lanes');
      const cellPairs = rule();
      const byLane = {};
      for (const c of cells) (byLane[c.lane] = byLane[c.lane] || []).push(c);
      for (const key of Object.keys(byLane)) {
        const row = byLane[key].slice().sort((a, b) => a.left - b.left);
        for (let i = 0; i < row.length; i += 1) for (let j = i + 1; j < row.length; j += 1) {
          const x = overX(row[i], row[j]);
          if (x > TOL && overY(row[i], row[j]) > TOL) cellPairs.add('Cells ' + row[i].laneLabel + ' / ' + row[i].columnLabel + ' and ' + row[j].laneLabel + ' / ' + row[j].columnLabel + ' overlap by ' + r0(x) + ' px');
        }
      }
      cellPairs.end('cell overlaps');

      const cardCell = rule();
      const cellOf = {};
      for (const c of cells) cellOf[c.lane + '|' + c.column] = c;
      for (const c of sized) {
        const cell = cellOf[c.lane + '|' + c.column];
        const s = cell ? spill(c, cell) : null;
        if (s) cardCell.add('Card ' + c.label + ' spills ' + s.by + ' px out of its cell (' + s.where + ' it)');
      }
      cardCell.end('cards outside their cells');

      // After a vertical scroll the column header row stays at the top of the board region and hides what passes under it.
      const scrolled = (region && region.scrollTop > TOL) || page.scrollY > TOL;
      if (scrolled && data.headRow) {
        const v = visibleArea(Object.assign({}, data, { headRow: undefined }));
        const top = Math.max(region ? region.top : 0, v.toolbarBottom, 0);
        if (Math.abs(data.headRow.top - top) > TOL) problems.push('The column header row is not at the top of the board region after a scroll (it starts at ' + r0(data.headRow.top) + ' px, the region at ' + r0(top) + ' px)');
        if (alphaOf(data.headRow.background) < 1) problems.push('The column header row is not opaque after a scroll (' + (data.headRow.background || 'none') + ')');
      }
    }

    const cardPairs = rule();
    const byTop = sized.slice().sort((a, b) => a.top - b.top);
    for (let i = 0; i < byTop.length; i += 1) {
      for (let j = i + 1; j < byTop.length && byTop[j].top < byTop[i].bottom - TOL; j += 1) {
        const x = overX(byTop[i], byTop[j]);
        const y = overY(byTop[i], byTop[j]);
        if (x > TOL && y > TOL) cardPairs.add('Cards ' + byTop[i].label + ' and ' + byTop[j].label + ' overlap by ' + r0(x) + ' by ' + r0(y) + ' px');
      }
    }
    cardPairs.end('card overlaps');
    const wide = rule();
    const tall = rule();
    for (const c of sized) {
      if (c.overflowX > TOL) wide.add('Card ' + c.label + "'s content is " + r0(c.overflowX) + ' px wider than the card');
      if (c.overflowY > TOL) tall.add('Card ' + c.label + "'s content is " + r0(c.overflowY) + ' px taller than the card');
    }
    wide.end('cards too narrow for their content');
    tall.end('cards too short for their content');

    const focus = focusProblem(data);
    if (focus) problems.push(focus);
    const firstScreen = !(region && region.scrollTop > TOL) && !(page.scrollY > TOL);
    if (firstScreen && data.openWork > 0 && visibleCount(data) === 0) {
      problems.push('No card is fully visible on the first screen, but ' + data.openWork + (data.openWork === 1 ? ' Backlog or Ready card exists' : ' Backlog or Ready cards exist'));
    }

    // Readable cards (G-62-7): never inside a folded column, a real size and font size, whole words on a line, and card styling on the card button.
    const folded = rule();
    const empty = rule();
    const fonts = rule();
    const split = rule();
    const centred = rule();
    const painted = rule();
    for (const c of cards) {
      const columnLabel = headByColumn[c.column] ? headByColumn[c.column].label : c.column;
      if (c.inFoldedCell) folded.add('Card ' + c.label + ' is drawn inside the folded column ' + columnLabel);
      const hasSize = boxed(c);
      if (!hasSize) empty.add('Card ' + c.label + ' has no size');
      else if (c.title && !(c.title.width >= TOL && c.title.height >= TOL)) empty.add('Card ' + c.label + "'s title has no size");
      if (typeof c.fontSize === 'number' && c.fontSize <= 0) fonts.add('Card ' + c.label + ' has a zero font size');
      else if (c.title && typeof c.title.fontSize === 'number' && c.title.fontSize <= 0) fonts.add('Card ' + c.label + "'s title has a zero font size");
      const broken = c.title ? (c.words || []).find((w) => w.lines > 1 && w.width <= c.title.width + 0.5) : undefined;
      if (broken) split.add('Card ' + c.label + ' splits the word "' + broken.text + '" across ' + (broken.lines === 2 ? 'two' : broken.lines) + ' lines although it fits on one');
      if (c.main && /center/.test(String(c.main.align || ''))) centred.add('Card ' + c.label + "'s main button is centred");
      if (c.main && (!same(c.main.color, c.color) || (alphaOf(c.main.background) > 0 && !same(c.main.background, c.background)))) {
        painted.add('Card ' + c.label + "'s main button is painted with button colours instead of the card's own");
      }
    }
    folded.end('cards in folded columns');
    empty.end('cards without a size');
    fonts.end('cards with a zero font size');
    split.end('cards with split words');
    centred.end('centred card buttons');
    painted.end('card buttons in button colours');
    return problems;
  }

  // ---- the report and the host's questions -----------------------------------------------------------------------------------------------------
  function reportOf(data, problems) {
    const tb = data.toolbar;
    const rg = data.region;
    const out = {
      width: data.width, height: data.height, layout: data.layout, theme: data.theme, problems: problems.slice(),
      toolbar: { height: tb ? tb.height : 0, background: tb ? tb.background : '', position: tb ? tb.position : '' },
      region: { left: rg ? rg.left : 0, top: rg ? rg.top : 0, width: rg ? rg.width : 0, height: rg ? rg.height : 0, scrollTop: rg ? rg.scrollTop : 0, scrollLeft: rg ? rg.scrollLeft : 0 },
      heads: data.heads.map((h) => ({ column: h.column, left: h.left, right: h.right, folded: h.folded })),
      lanes: data.lanes.map((l) => ({ lane: l.lane, top: l.top, bottom: l.bottom, collapsed: l.collapsed })),
      cells: data.cells.map((c) => ({ lane: c.lane, column: c.column, left: c.left, top: c.top, width: c.width, height: c.height })),
      cards: data.cards.map((c) => ({ id: c.id, column: c.column, lane: c.lane, left: c.left, top: c.top, width: c.width, height: c.height, draggable: c.draggable })),
      visibleCards: visibleCount(data)
    };
    if (data.focused) out.focused = { id: data.focused.id, top: data.focused.top, bottom: data.focused.bottom, visible: !focusProblem(data) };
    return out;
  }

  // One animation frame, or 50 ms when the page is hidden and frames stop.
  function frame() {
    return new Promise((resolve) => {
      let done = false;
      let timer;
      const go = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      timer = setTimeout(go, 50);
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(go);
    });
  }

  function scrollBoard(top, left) {
    const kanban = (document.getElementById('root') || document.body).getAttribute('data-layout') !== 'list';
    const regionEl = kanban ? document.querySelector('.board-scroll') : document.getElementById('board');
    if (!regionEl) return;
    if (typeof top === 'number') {
      regionEl.scrollTop = top;
      // The board region is not a vertical scroller in every layout; then the page itself scrolls, as a person's wheel would.
      if (top > 0 && !(regionEl.scrollTop > 0)) { const s = document.scrollingElement || document.documentElement; s.scrollTop = top; }
    }
    if (typeof left === 'number') regionEl.scrollLeft = left;
  }

  /** Runs the asked action (scroll, focus, measure or rects), waits two frames, then measures. rects skips the rules and the word measuring. */
  function measure(action) {
    const a = typeof action === 'string' ? { action } : (action && typeof action === 'object' ? action : {});
    const kind = typeof a.action === 'string' ? a.action : 'measure';
    if (kind === 'scroll') scrollBoard(a.top, a.left);
    else if (kind === 'focus' && typeof a.itemId === 'string' && board && typeof board.focusCard === 'function') board.focusCard(a.itemId);
    return frame().then(frame).then(() => {
      const data = collect(kind !== 'rects');
      return reportOf(data, kind === 'rects' ? [] : check(data));
    });
  }

  window.NearAiBoardLayout = Object.freeze({ collect, check, measure, wordsIn });

  if (!board || typeof board.onMessage !== 'function' || typeof board.post !== 'function') return;
  board.onMessage('e2e-layout', (m) => {
    const id = typeof m.id === 'number' ? m.id : 0;
    let sent = false;
    const answer = (report) => { if (sent) return; sent = true; board.post({ type: 'e2e-layout-report', id, report }); };
    const failed = (error) => ({ width: 0, height: 0, layout: '', theme: '', problems: ['The layout probe failed: ' + String((error && error.message) || error)], toolbar: { height: 0, background: '', position: '' }, region: { left: 0, top: 0, width: 0, height: 0, scrollTop: 0, scrollLeft: 0 }, heads: [], lanes: [], cells: [], cards: [], visibleCards: 0 });
    try { measure(m).then(answer, (error) => answer(failed(error))); } catch (error) { answer(failed(error)); }
  });
})();
