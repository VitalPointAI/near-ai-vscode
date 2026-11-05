// Team Board layout probe (Phase 62 plan 16). TEST-ONLY: the host loads it after board.js only under NEAR_AI_E2E=1, .vscodeignore drops it from the
// package, and the release check fails if it is ever packaged. It answers only on a page the host marked with data-e2e="1".
// The extension-host tests send { type: 'e2e-layout', id, action, top, left, itemId } and get back one { type: 'e2e-layout-report', id, report }:
// the real board measured in CSS pixels of the page's own viewport, and a list of plain problems (sideways scroll, a see-through or covering toolbar,
// overlapping or spilling headers, lanes, cells and cards, a focused card hidden under the headers, no work on the first screen, unreadable cards).
// collect() only reads the page and returns plain numbers and strings; check(data) is pure, so every rule can be proven on hand-made measurements.
// Same page rules as the board: an IIFE, text nodes only, no markup, no network, no colour literal; it posts through window.NearAiBoard.post.
// 62.1-07: when #root shows the Timeline view, the report also has a timeline section (dots, labels, headers, lines, the Now marker, percents, the
// preview, the card, focus, the toolbar controls, first-screen facts and, on test pages, NearAiTimeline.metrics) and check() judges it with the
// 62.1-UI-SPEC probe rules 1 to 10 and the amendment's rules 11 and 12. It only reads and measures: it makes no event inside the page.
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
    const page = { scrollWidth: num(scroller.scrollWidth), clientWidth: num(scroller.clientWidth || doc.clientWidth), scrollHeight: num(scroller.scrollHeight), clientHeight: num(scroller.clientHeight || doc.clientHeight), scrollY: num(window.scrollY || scroller.scrollTop) };

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
    if (rootEl && rootEl.getAttribute('data-view') === 'timeline') data.timeline = collectTimeline(data);
    return data;
  }

  // ---- reading the timeline (62.1-07, 62.1-UI-SPEC "Selectors and data attributes for tests") ------------------------------------------------
  // Every element is found by the spec's fixed selectors; a dot, a milestone or a +n is matched by comparing its data attributes, never by a
  // selector built from the host's text. Parts that are not drawn yet are null or empty lists, so the report always has the same shape.
  const intAttr = (n, name) => { const v = Number(n.getAttribute(name)); return isFinite(v) ? v : -1; };
  const one = (scope, selector) => (scope && typeof scope.querySelector === 'function' ? scope.querySelector(selector) : null);
  const visibleEl = (n) => !!n && n.hidden !== true && !up(n, '[hidden]') && isRendered(n) && read(styleOf(n), 'visibility') !== 'hidden' && read(styleOf(n), 'display') !== 'none';
  function editorFontSize() {
    const s = styleOf(document.documentElement);
    const v = s && typeof s.getPropertyValue === 'function' ? parseFloat(s.getPropertyValue('--vscode-editor-font-size')) : NaN;
    if (isFinite(v) && v > 0) return v;
    const b = size(styleOf(document.body));
    return b && b > 0 ? b : null;
  }
  // The first background up the tree that is fully opaque: the colour the text is really drawn on. Empty when the page reports none.
  function backdrop(n) {
    for (let p = n; p && p.nodeType === 1; p = p.parentNode) {
      const bg = read(styleOf(p), 'backgroundColor');
      if (bg && alphaOf(bg) >= 1) return bg;
    }
    return '';
  }
  // How far a text box's content is wider than the box, and whether the cut is intentional (an ellipsis and a title with the full text).
  function cutOf(n) {
    const by = n && typeof n.scrollWidth === 'number' && typeof n.clientWidth === 'number' && n.clientWidth > 0 ? num(n.scrollWidth - n.clientWidth) : 0;
    return { by: Math.max(0, by), ellipsis: read(styleOf(n), 'textOverflow') === 'ellipsis', title: !!(n && typeof n.getAttribute === 'function' && n.getAttribute('title')) };
  }
  function textItem(n) {
    const s = styleOf(n);
    return { box: rectOf(n), text: textOf(n).slice(0, 80), cut: cutOf(n), color: read(s, 'color'), background: backdrop(n), fontSize: size(s) };
  }
  // The elements inside a container that hold text of their own (not inside an icon), each measured as a text item.
  function leafTexts(container) {
    if (!container) return [];
    return all(container, '*').filter((n) => !up(n, 'svg') && visibleEl(n) && Array.from(n.childNodes || []).some((c) => c.nodeType === 3 && String(c.textContent || '').trim() !== '')).slice(0, 40).map(textItem);
  }
  function buttonsIn(container) {
    return all(container, 'button').filter(visibleEl).slice(0, 20).map((b) => { const r = rectOf(b); return { name: b.getAttribute('aria-label') || textOf(b).slice(0, 40) || describe(b), width: r.width, height: r.height, box: r }; });
  }
  // The paint of an icon shape: its colour, or empty when it paints nothing.
  const paintOf = (n, key) => { const v = read(styleOf(n), key); return v && v !== 'none' && alphaOf(v) > 0 ? v : ''; };
  // A dot's mark: its box, the colour of its main shape (stroke for a ring, fill for a filled mark) and its glyph's colour on what it sits on.
  function markOf(svg, canvasBg) {
    if (!svg) return null;
    const shapes = all(svg, 'circle, rect, ellipse, path, polygon, polyline, line');
    const body = shapes[0];
    const stroke = body ? paintOf(body, 'stroke') : '';
    const fill = body ? paintOf(body, 'fill') : '';
    const out = { box: rectOf(svg), color: stroke || fill };
    const glyphEl = one(svg, '.tl-glyph') || (shapes.length > 1 ? shapes[shapes.length - 1] : null);
    if (glyphEl && glyphEl !== body) {
      const g = paintOf(glyphEl, 'fill') || paintOf(glyphEl, 'stroke');
      if (g) out.glyph = { color: g, background: fill && alphaOf(fill) >= 1 ? fill : canvasBg };
    }
    return out;
  }
  function dotLabel(id) {
    const c = board && typeof board.cardData === 'function' ? board.cardData(id) : undefined;
    if (c && c.displayId) return c.kind === 'plan' ? 'plan ' + c.displayId : String(c.displayId);
    return id;
  }
  const milestoneOf = (n) => { const m = up(n, '.tl-milestone'); return m ? m.getAttribute('data-milestone') || '' : ''; };
  // A path's two ends in page pixels (through its screen matrix), or null where the browser cannot say.
  function endsOf(path) {
    if (typeof path.getTotalLength !== 'function' || typeof path.getPointAtLength !== 'function') return null;
    const total = path.getTotalLength();
    const m = typeof path.getScreenCTM === 'function' ? path.getScreenCTM() : null;
    const at = (len) => { const p = path.getPointAtLength(len); return m ? { x: num(m.a * p.x + m.c * p.y + m.e), y: num(m.b * p.x + m.d * p.y + m.f) } : { x: num(p.x), y: num(p.y) }; };
    return { start: at(0), end: at(total) };
  }

  /** The timeline as drawn now: plain numbers and strings in page pixels (62.1-UI-SPEC "Real-window probe rules"). */
  function collectTimeline(data) {
    const rootEl = document.getElementById('root');
    const scrollEl = one(document.getElementById('board'), '.tl-scroll');
    const canvasEl = one(scrollEl, '.tl-canvas');
    const canvasBg = backdrop(canvasEl || scrollEl);
    const model = board && typeof board.model === 'function' ? board.model() : undefined;
    const tlModel = model && model.timeline ? model.timeline : undefined;
    const saved = board && typeof board.uiState === 'function' ? board.uiState() : undefined;
    const zoomText = parseFloat(textOf(one(document.getElementById('tl-zoom'), 'output')));
    const horizontalRadio = one(document.getElementById('direction-switch'), 'button[data-direction="horizontal"]');

    const dots = all(scrollEl, 'button.tl-dot').map((b) => {
      const id = b.getAttribute('data-id') || '';
      const chipEl = one(b, '.tl-initials');
      const idEl = one(b, '.tl-id');
      const out = { id, label: dotLabel(id), milestone: milestoneOf(b), step: intAttr(b, 'data-step'), slot: intAttr(b, 'data-slot'), state: b.getAttribute('data-state') || '', rendered: isRendered(b), box: rectOf(b), mark: markOf(one(b, '.tl-mark'), canvasBg) };
      if (chipEl && visibleEl(chipEl)) out.chip = textItem(chipEl);
      if (idEl && visibleEl(idEl)) out.idLabel = textItem(idEl);
      return out;
    });
    const drawn = {};
    for (const d of dots) drawn[d.id] = d;
    const more = all(scrollEl, '.tl-more').filter(visibleEl).map((n) => Object.assign(rectOf(n), { milestone: milestoneOf(n), step: intAttr(n, 'data-step'), text: textOf(n).slice(0, 20) }));
    const tiles = all(scrollEl, '.tl-folded').filter(visibleEl).map((n) => Object.assign(rectOf(n), { milestone: milestoneOf(n), text: textOf(n).slice(0, 80), cut: cutOf(n) }));
    const phaseLabels = all(scrollEl, '.tl-phase-label').filter((n) => visibleEl(n) && textOf(n) !== '').map((n) => {
      const ph = up(n, '.tl-phase');
      const item = textItem(n);
      return Object.assign({ id: ph ? ph.getAttribute('data-phase') || '' : '', milestone: milestoneOf(n) }, item, { percent: /%/.test(item.text) });
    });
    const headers = [];
    const percents = [];
    for (const h of all(scrollEl, '.tl-ms-head').filter(visibleEl)) {
      const s = styleOf(h);
      const titleEl = one(h, '.tl-ms-title') || one(h, 'h2');
      const background = read(s, 'backgroundColor');
      const milestone = milestoneOf(h);
      headers.push({ id: milestone, title: textOf(titleEl).slice(0, 60), box: rectOf(h), sticky: read(s, 'position') === 'sticky', alpha: alphaOf(background), background, cut: cutOf(titleEl) });
      for (const [what, selector] of [['band percent', '.tl-ms-percent'], ['band progress', '.progress-text']]) {
        const n = one(h, selector);
        if (n && visibleEl(n)) percents.push(Object.assign({ milestone, what }, textItem(n)));
      }
    }
    // Where a line ends when its card is not drawn as a dot: the +n button of its step, or its milestone's folded tile.
    const modelDots = {};
    for (const d of tlModel && Array.isArray(tlModel.dots) ? tlModel.dots : []) modelDots[d.cardId] = d;
    function anchorOf(id) {
      const d = modelDots[id];
      if (!d) return null;
      const band = all(scrollEl, '.tl-milestone').find((m) => m.getAttribute('data-milestone') === String(d.milestoneId));
      if (!band) return null;
      const stack = all(band, '.tl-more').find((m) => intAttr(m, 'data-step') === d.step && visibleEl(m));
      const tile = one(band, '.tl-folded');
      return stack ? rectOf(stack) : tile && visibleEl(tile) ? rectOf(tile) : null;
    }
    const lines = all(one(scrollEl, 'svg.tl-lines'), 'path[data-from][data-to]').map((p) => {
      const from = p.getAttribute('data-from') || '';
      const to = p.getAttribute('data-to') || '';
      const ends = endsOf(p);
      const out = { from, to, fromLabel: dotLabel(from), toLabel: dotLabel(to), start: ends ? ends.start : null, end: ends ? ends.end : null };
      if (!drawn[from]) out.fromBox = anchorOf(from);
      if (!drawn[to]) out.toBox = anchorOf(to);
      return out;
    });

    const lineEl = one(scrollEl, '.tl-now-line');
    const pillEl = one(scrollEl, '.tl-now-pill');
    let now = null;
    if ((lineEl && visibleEl(lineEl)) || (pillEl && visibleEl(pillEl))) {
      const pillBg = read(styleOf(pillEl), 'backgroundColor');
      const texts = leafTexts(pillEl);
      now = {
        milestone: tlModel && tlModel.now ? String(tlModel.now.milestoneId) : '', step: tlModel && tlModel.now ? tlModel.now.step : -1,
        line: lineEl && visibleEl(lineEl) ? rectOf(lineEl) : null, pill: pillEl && visibleEl(pillEl) ? rectOf(pillEl) : null,
        alpha: alphaOf(pillBg), background: pillBg, text: textOf(pillEl).slice(0, 160), texts,
        lineColor: paintOf(lineEl, 'backgroundColor') || paintOf(lineEl, 'stroke') || paintOf(lineEl, 'borderLeftColor') || paintOf(lineEl, 'borderTopColor')
      };
    }
    const overallEl = document.getElementById('tl-overall');
    const overall = overallEl && visibleEl(overallEl) ? { box: rectOf(overallEl), text: textOf(overallEl).slice(0, 40), texts: leafTexts(overallEl), ring: rectOf(one(overallEl, 'svg')) } : null;
    const legendEl = document.getElementById('tl-legend');
    const legend = legendEl && visibleEl(legendEl) ? { box: rectOf(legendEl), alpha: alphaOf(read(styleOf(legendEl), 'backgroundColor')), background: read(styleOf(legendEl), 'backgroundColor') } : null;
    const expanded = dots.find((d) => { const b = all(scrollEl, 'button.tl-dot').find((n) => n.getAttribute('data-id') === d.id); return b && b.getAttribute('aria-expanded') === 'true'; });
    const active = document.activeElement;
    const focusedBtn = up(active, 'button.tl-dot');
    const focusedDot = focusedBtn ? focusedBtn.getAttribute('data-id') || null : null;
    let hovered = null;
    try { const n = one(scrollEl, 'button.tl-dot:hover'); hovered = n ? n.getAttribute('data-id') : null; } catch (error) { hovered = null; }
    function layer(n, dotId) {
      if (!n || !visibleEl(n)) return null;
      const background = read(styleOf(n), 'backgroundColor');
      return { box: rectOf(n), alpha: alphaOf(background), background, dotId: n.getAttribute('data-id') || dotId || null, texts: leafTexts(n), buttons: buttonsIn(n) };
    }
    const preview = layer(document.getElementById('tl-preview'), hovered || focusedDot);
    const card = layer(document.getElementById('tl-card'), expanded ? expanded.id : null);
    if (card) {
      const t = document.getElementById('tl-card-title');
      const ts = styleOf(t);
      const clamp = read(ts, 'webkitLineClamp') || read(ts, 'WebkitLineClamp');
      card.titleClamped = !!t && ((clamp !== '' && clamp !== 'none' && clamp !== '0') || (typeof t.scrollHeight === 'number' && typeof t.clientHeight === 'number' && t.clientHeight > 0 && t.scrollHeight > t.clientHeight + TOL));
    }
    const controls = controlsOf();
    // Other elements in the board region that scroll on their own (the expanded card may: it is capped and scrolls inside).
    const otherScrollers = [];
    const boardEl = document.getElementById('board');
    if (typeof window.getComputedStyle === 'function') {
      for (const n of all(boardEl, '*')) {
        if (otherScrollers.length >= OUTSIDE_LIMIT) break;
        if (n === scrollEl || up(n, '#tl-card')) continue;
        const s = styleOf(n);
        const scrolls = (k) => /auto|scroll/.test(read(s, k));
        if ((scrolls('overflowX') && n.scrollWidth > n.clientWidth + TOL) || (scrolls('overflowY') && n.scrollHeight > n.clientHeight + TOL)) otherScrollers.push({ what: describe(n) });
      }
    }

    const t = {
      view: 'timeline', direction: (rootEl && rootEl.getAttribute('data-direction')) || 'horizontal',
      horizontalDisabled: !!horizontalRadio && horizontalRadio.getAttribute('aria-disabled') === 'true',
      zoom: saved && typeof saved.zoom === 'number' ? saved.zoom : isFinite(zoomText) ? zoomText : 100,
      editorFontSize: editorFontSize(),
      canvas: { box: canvasEl ? rectOf(canvasEl) : null, background: canvasBg },
      scroller: scrollEl
        ? { rect: rectOf(scrollEl), scrollTop: num(scrollEl.scrollTop), scrollLeft: num(scrollEl.scrollLeft), scrollWidth: num(scrollEl.scrollWidth), scrollHeight: num(scrollEl.scrollHeight), clientWidth: num(scrollEl.clientWidth), clientHeight: num(scrollEl.clientHeight) }
        : null,
      otherScrollers, dots, more, tiles, phaseLabels, headers, percents, lines, now, overall, legend, preview, card, focusedDot, controls
    };
    t.firstScreen = firstScreenOf(Object.assign({}, data, { timeline: t }));
    // 62.1-06 adds NearAiTimeline.metrics on test pages (draw time and frame timing); it is reported as given, and absent when there is none.
    const tlApi = window.NearAiTimeline;
    if (tlApi && typeof tlApi.metrics === 'function') {
      try { const m = tlApi.metrics(); if (m && typeof m === 'object') t.metrics = JSON.parse(JSON.stringify(m)); } catch (error) { t.metrics = { error: String((error && error.message) || error) }; }
    }
    return t;
  }

  // The toolbar's controls as boxes (null when not shown): the View switch, the Direction switch, the zoom group, Jump to now and Show legend.
  // In the Timeline view they are part of the timeline section; a question that asks for them (62.1-08) gets them in Columns too.
  function controlsOf() {
    const q = (scope, selector) => { const n = one(scope, selector); return n && visibleEl(n) ? rectOf(n) : null; };
    const viewSw = document.getElementById('view-switch');
    const dirSw = document.getElementById('direction-switch');
    const zoomEl = document.getElementById('tl-zoom');
    return {
      view: { columns: q(viewSw, 'button[data-view="columns"]'), timeline: q(viewSw, 'button[data-view="timeline"]') },
      direction: { horizontal: q(dirSw, 'button[data-direction="horizontal"]'), vertical: q(dirSw, 'button[data-direction="vertical"]') },
      zoomOut: q(zoomEl, '[data-zoom="out"]'), zoomIn: q(zoomEl, '[data-zoom="in"]'), fit: q(zoomEl, '[data-zoom="fit"]'),
      now: q(document, '#tl-now'), legend: q(document, '#tl-legend-btn')
    };
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

  // One rule may name many things; after PER_RULE sentences the rest is counted, so a broken page gives a readable list.
  const ruleOf = (problems) => () => { let n = 0; let more = 0; return { add(text) { if (n < PER_RULE) { problems.push(text); n += 1; } else more += 1; }, end(what) { if (more) problems.push('And ' + more + ' more ' + what + '.'); } }; };

  // ---- checking the timeline (pure; 62.1-UI-SPEC "Real-window probe rules" 1 to 10, amendment rules 11 and 12) -------------------------------
  const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);
  const penetration = (a, b) => Math.min(overX(a, b), overY(a, b));
  const hasBox = (b) => !!b && typeof b.left === 'number' && typeof b.top === 'number' && b.right - b.left >= TOL && b.bottom - b.top >= TOL;
  const EDGE = 8;
  const FONT_SHARE = 0.85;
  const TARGET = 24;
  const APART = 4;
  const LINE_GAP = 2;
  const r1 = (v) => Math.round(v * 10) / 10;
  // How far a point is from a rectangle's edge: outside it, the distance to the rectangle; inside it, the distance to the nearest edge.
  function edgeDistance(p, b) {
    const dx = Math.max(b.left - p.x, 0, p.x - b.right);
    const dy = Math.max(b.top - p.y, 0, p.y - b.bottom);
    if (dx > 0 || dy > 0) return Math.sqrt(dx * dx + dy * dy);
    return Math.min(p.x - b.left, b.right - p.x, p.y - b.top, b.bottom - p.y);
  }
  // A computed colour as red, green and blue from 0 to 255 and an alpha: the legacy comma form, the space form with a slash, and the
  // color(srgb r g b / a) form Chromium reports for color-mix. Null for anything else, so an unknown colour is never judged.
  function rgbaOf(colour) {
    const m = /^([a-z]+)\((.*)\)$/.exec(String(colour || '').trim().toLowerCase());
    if (!m) return null;
    const halves = m[2].split('/');
    let parts = halves[0].split(/[\s,]+/).filter(Boolean);
    let alphaPart = halves[1];
    let channel;
    if (m[1] === 'color') {
      if (parts[0] !== 'srgb') return null;
      parts = parts.slice(1);
      channel = (p) => (/%$/.test(p) ? parseFloat(p) / 100 : parseFloat(p)) * 255;
    } else if (m[1] === 'rgb' || m[1] === 'rgba') {
      if (parts.length === 4 && alphaPart === undefined) alphaPart = parts[3];
      channel = (p) => (/%$/.test(p) ? parseFloat(p) * 2.55 : parseFloat(p));
    } else return null;
    if (parts.length < 3) return null;
    const [r, g, b] = parts.slice(0, 3).map(channel);
    const a = alphaPart === undefined ? 1 : (/%$/.test(alphaPart.trim()) ? parseFloat(alphaPart) / 100 : parseFloat(alphaPart));
    return [r, g, b, a].every((v) => isFinite(v)) ? { r, g, b, a } : null;
  }
  const luminance = (c) => {
    const lin = (v) => { const s = Math.max(0, Math.min(255, v)) / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  };
  /** The WCAG contrast ratio of a colour on an opaque background (a see-through colour is blended over it); null when either is unknown. */
  function contrastOf(fg, bg) {
    const f = rgbaOf(fg);
    const b = rgbaOf(bg);
    if (!f || !b || b.a < 1 - 0.001) return null;
    const a = Math.max(0, Math.min(1, f.a));
    const mix = { r: f.r * a + b.r * (1 - a), g: f.g * a + b.g * (1 - a), b: f.b * a + b.b * (1 - a) };
    const x = luminance(mix);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  // Rounded down to one decimal, so a ratio just under a limit never reads as the limit.
  const ratioWord = (ratio) => (Math.floor(ratio * 10) / 10).toFixed(1);
  // The text parts of a measured element: its own leaf texts when the page gave them, else the element's own fields.
  const textsOf = (x) => (Array.isArray(x.texts) && x.texts.length ? x.texts : [x]);
  // The scroller's visible rectangle (its client area) below a toolbar that stays put, in page pixels.
  function timelineView(data) {
    const t = data.timeline;
    const s = t && t.scroller;
    const r = s && s.rect ? s.rect : { left: 0, top: 0, right: data.width, bottom: data.height };
    const w = s && s.clientWidth > 0 ? s.clientWidth : r.right - r.left;
    const h = s && s.clientHeight > 0 ? s.clientHeight : r.bottom - r.top;
    const toolbarBottom = data.toolbar && stuck(data.toolbar) ? data.toolbar.bottom : 0;
    return { left: Math.max(0, r.left), top: Math.max(0, r.top, toolbarBottom), right: Math.min(data.width || Infinity, r.left + w), bottom: Math.min(data.height || Infinity, r.top + h) };
  }
  // A sticky milestone header that is held at the scroller's edge right now: it hides on purpose what passes under it.
  function pinned(data, h) {
    const t = data.timeline;
    const s = t && t.scroller;
    if (!h.sticky || !s || !hasBox(h.box)) return false;
    const v = timelineView(data);
    return (s.scrollTop > TOL && Math.abs(h.box.top - v.top) <= TOL) || (s.scrollLeft > TOL && Math.abs(h.box.left - v.left) <= TOL);
  }
  const inside = (b, v, margin) => hasBox(b) && b.left >= v.left + margin - TOL && b.top >= v.top + margin - TOL && b.right <= v.right - margin + TOL && b.bottom <= v.bottom - margin + TOL;
  /** First-screen facts (62.1-UI-SPEC amendment, probe rule 7): the Now pill and a dot of the Now step lie fully in the visible scroller. */
  function firstScreenOf(data) {
    const t = data.timeline || {};
    const v = timelineView(data);
    const now = t.now;
    return {
      nowVisible: !!(now && now.pill && inside(now.pill, v, 0)),
      nowStepDotVisible: !!now && (t.dots || []).some((d) => d.milestone === now.milestone && d.step === now.step && d.rendered !== false && inside(d.box, v, 0))
    };
  }

  /** Every broken timeline rule as one plain sentence, added to problems. */
  function checkTimeline(data, problems) {
    const t = data.timeline;
    const rule = ruleOf(problems);
    const dots = (t.dots || []).filter((d) => d.rendered !== false && hasBox(d.box));
    const headers = t.headers || [];
    const phaseLabels = (t.phaseLabels || []).filter((p) => hasBox(p.box));
    const more = (t.more || []).filter(hasBox);

    // Rule 1, no overlap: dot hit boxes, initials chips, display ID labels, phase labels, +n buttons and milestone headers. A dot's own chip and
    // label sit inside its box, and a header held at the scroller's edge covers what scrolls under it on purpose (rule 6 guards the focused dot).
    const ORDER = ['head', 'phase', 'more', 'chip', 'idLabel', 'dot'];
    const items = [];
    for (const h of headers) if (hasBox(h.box)) items.push({ owner: 'head:' + h.id, kind: 'head', name: 'milestone header ' + h.title, short: h.title, box: h.box, pinned: pinned(data, h) });
    for (const p of phaseLabels) items.push({ owner: 'phase:' + p.id, kind: 'phase', name: 'phase label "' + p.text + '"', short: '"' + p.text + '"', box: p.box });
    for (const m of more) items.push({ owner: 'more:' + m.milestone + ':' + m.step, kind: 'more', name: 'the ' + m.text + ' button at step ' + (m.step + 1), box: m });
    // A chip or ID label inside its own dot box is judged with that box; one that sticks out of it is judged on its own.
    const within = (b, o) => b.left >= o.left - TOL && b.top >= o.top - TOL && b.right <= o.right + TOL && b.bottom <= o.bottom + TOL;
    for (const d of dots) {
      if (d.chip && hasBox(d.chip.box) && !within(d.chip.box, d.box)) items.push({ owner: 'dot:' + d.id, kind: 'chip', name: 'the initials of ' + d.label, box: d.chip.box });
      if (d.idLabel && hasBox(d.idLabel.box) && !within(d.idLabel.box, d.box)) items.push({ owner: 'dot:' + d.id, kind: 'idLabel', name: 'the ID label of ' + d.label, box: d.idLabel.box });
      items.push({ owner: 'dot:' + d.id, kind: 'dot', name: 'dot ' + d.label, short: d.label, box: d.box });
    }
    const PLURAL = { head: 'Milestone headers', phase: 'Phase labels', dot: 'Dots' };
    const overlaps = rule();
    for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (a.owner === b.owner || ((a.pinned || b.pinned) && a.kind !== b.kind)) continue;
      const by = penetration(a.box, b.box);
      if (!(by > TOL)) continue;
      const [x, y] = ORDER.indexOf(a.kind) <= ORDER.indexOf(b.kind) ? [a, b] : [b, a];
      overlaps.add(x.kind === y.kind && PLURAL[x.kind] ? PLURAL[x.kind] + ' ' + x.short + ' and ' + y.short + ' overlap by ' + r0(by) + ' px' : cap(x.name) + ' and ' + y.name + ' overlap by ' + r0(by) + ' px');
    }
    overlaps.end('overlaps on the timeline');

    const view = timelineView(data);
    const inset = { left: view.left + EDGE, top: view.top + EDGE, right: view.right - EDGE, bottom: view.bottom - EDGE };
    const canvasBox = t.canvas && hasBox(t.canvas.box) ? t.canvas.box : null;
    const canvasBg = t.canvas ? t.canvas.background : '';
    const editor = typeof t.editorFontSize === 'number' && t.editorFontSize > 0 ? t.editorFontSize : null;
    const dotById = {};
    for (const d of t.dots || []) dotById[d.id] = d;
    const held = headers.filter((h) => pinned(data, h));
    const hits = dots.map((d) => ({ kind: 'dot', name: 'dot ' + d.label, short: d.label, box: d.box }))
      .concat(more.map((m) => ({ kind: 'more', name: 'the ' + m.text + ' button at step ' + (m.step + 1), box: m })))
      .concat((t.tiles || []).filter(hasBox).map((m) => ({ kind: 'tile', name: 'the folded milestone "' + String(m.text || m.milestone).slice(0, 40) + '"', box: m })));
    const layers = [['preview', t.preview], ['expanded card', t.card]].filter(([, l]) => l && hasBox(l.box));
    const small = (px) => editor !== null && typeof px === 'number' && px > 0 && px < editor * FONT_SHARE - 0.05;
    const fontText = (px) => r1(px) + ' px, less than 85 percent of the ' + r1(editor) + ' px editor font';

    // Rule 2, nothing clipped: every dot, label, header, +n and tile inside the canvas; a text wider than its box is cut only on purpose.
    const outRule = rule();
    if (canvasBox) {
      const parts = dots.map((d) => ['dot ' + d.label, d.box]).concat(phaseLabels.map((p) => ['phase label "' + p.text + '"', p.box]), headers.filter((h) => hasBox(h.box)).map((h) => ['milestone header ' + h.title, h.box]), hits.filter((h) => h.kind !== 'dot').map((h) => [h.name, h.box]));
      for (const [name, b] of parts) { const s = spill(b, canvasBox); if (s) outRule.add(cap(name) + ' spills ' + s.by + ' px ' + s.where + ' the canvas'); }
    }
    outRule.end('things outside the canvas');
    const cutRule = rule();
    const unmarked = (c) => !!c && c.by > TOL && !(c.ellipsis && c.title);
    for (const p of phaseLabels) if (unmarked(p.cut)) cutRule.add('Phase label "' + p.text + '" is cut by ' + r0(p.cut.by) + ' px without an ellipsis and a title');
    for (const h of headers) if (unmarked(h.cut)) cutRule.add('The title of milestone header ' + h.title + ' is cut by ' + r0(h.cut.by) + ' px without an ellipsis and a title');
    for (const m of t.tiles || []) if (unmarked(m.cut)) cutRule.add('The folded milestone "' + String(m.text || m.milestone).slice(0, 40) + '" is cut by ' + r0(m.cut.by) + ' px without an ellipsis and a title');
    cutRule.end('cut labels');

    // Rule 3, a readable preview and card: inside the visible area less 8 px and below a header held at the edge, off its own dot, no cut line,
    // the card title not clamped, text at least 0.85 of the editor font and buttons at least 24 by 24 px.
    const readRule = rule();
    for (const [name, l] of layers) {
      const s = spill(l.box, inset);
      if (s) readRule.add('The ' + name + ' spills ' + s.by + ' px ' + s.where + ' the visible timeline area');
      for (const h of held) if (penetration(l.box, h.box) > TOL) readRule.add('The ' + name + ' is under the milestone header ' + h.title);
      const own = l.dotId ? dotById[l.dotId] : undefined;
      if (own && hasBox(own.box) && penetration(l.box, own.box) > TOL) readRule.add('The ' + name + ' covers its own dot ' + own.label);
      for (const x of l.texts || []) {
        if (x.cut && x.cut.by > TOL) readRule.add('A line in the ' + name + ' is cut by ' + r0(x.cut.by) + ' px: "' + x.text + '"');
        if (small(x.fontSize)) readRule.add('Text "' + x.text + '" in the ' + name + ' is ' + fontText(x.fontSize));
      }
      if (l.titleClamped === true) readRule.add('The ' + name + ' title is clamped');
      for (const b of l.buttons || []) if (b.width < TARGET - TOL || b.height < TARGET - TOL) readRule.add('The ' + b.name + ' button in the ' + name + ' is ' + r0(b.width) + ' by ' + r0(b.height) + ' px, smaller than 24 by 24 px');
    }
    readRule.end('problems in the preview and the card');

    // Rule 4, opaque layers (the toolbar's own rule is the board's): milestone headers, the legend band, the preview and the card.
    const opaqueRule = rule();
    const alpha = (x) => (typeof x.alpha === 'number' ? x.alpha : alphaOf(x.background));
    const seeThrough = (x) => alpha(x) < 1 - 0.001;
    const alphaText = (x) => ' is not opaque (alpha ' + Math.round(alpha(x) * 100) / 100 + ')';
    for (const h of headers) if (seeThrough(h)) opaqueRule.add('The milestone header ' + h.title + alphaText(h));
    if (t.legend && seeThrough(t.legend)) opaqueRule.add('The legend band' + alphaText(t.legend));
    for (const [name, l] of layers) if (seeThrough(l)) opaqueRule.add('The ' + name + alphaText(l));
    opaqueRule.end('see-through layers');

    // Rule 5, one scroller: the page itself never scrolls in the Timeline view; the timeline area is the only scrolling element.
    const page = data.page || {};
    const ONLY = '; only the timeline area may scroll';
    if (page.scrollWidth - page.clientWidth > TOL) problems.push('The page scrolls sideways by ' + r0(page.scrollWidth - page.clientWidth) + ' px' + ONLY);
    if (page.clientHeight > 0 && page.scrollHeight - page.clientHeight > TOL) problems.push('The page scrolls down by ' + r0(page.scrollHeight - page.clientHeight) + ' px' + ONLY);
    const scrollRule = rule();
    for (const o of t.otherScrollers || []) scrollRule.add(o.what + ' scrolls on its own' + ONLY);
    scrollRule.end('other scrolling elements');

    // Rule 6, focus visible: the focused dot is fully in the visible area and not under a header held at the edge.
    const focused = t.focusedDot ? dotById[t.focusedDot] : undefined;
    if (focused && hasBox(focused.box)) {
      const over = held.find((h) => penetration(focused.box, h.box) > TOL);
      if (over) problems.push('The focused dot ' + focused.label + ' is hidden under the milestone header ' + over.title + ' (' + r0(penetration(focused.box, over.box)) + ' px covered)');
      else if (!inside(focused.box, view, 0)) problems.push('The focused dot ' + focused.label + ' is not fully visible in the timeline area');
    }

    // Rule 8, lines attached: each end within 2 px of its dot's mark edge, or of the +n button or tile that holds a hidden card.
    const lineRule = rule();
    const labelOf = (id, given) => (dotById[id] ? dotById[id].label : given && given !== id ? given : id);
    const anchor = (id, given) => { const d = dotById[id]; return d && d.rendered !== false ? (d.mark && hasBox(d.mark.box) ? d.mark.box : d.box) : given && hasBox(given) ? given : null; };
    for (const l of t.lines || []) {
      if (!l.start || !l.end) continue;
      const from = labelOf(l.from, l.fromLabel);
      const to = labelOf(l.to, l.toLabel);
      const name = 'The line from ' + from + ' to ' + to;
      for (const [end, id, given, word] of [[l.start, l.from, l.fromBox, 'starts'], [l.end, l.to, l.toBox, 'ends']]) {
        const b = anchor(id, given);
        if (!b) { lineRule.add(name + (word === 'starts' ? ' starts at' : ' ends at') + ' no dot, +n button or tile'); continue; }
        const away = edgeDistance(end, b);
        if (away > LINE_GAP + 0.05) lineRule.add(name + ' ' + word + ' ' + r0(away) + ' px away from ' + (word === 'starts' ? from : to));
      }
    }
    lineRule.end('lines off their dots');

    // Rule 9, contrast: marks and glyphs at least 3 to 1 against the canvas (a glyph on a filled mark against that fill); initials, preview and
    // card text at least 4.5 to 1 against their own background.
    const markRule = rule();
    const textRule = rule();
    const below = (ratio, min) => ratio !== null && ratio < min - 0.0001;
    const ratioText = (ratio, min) => ratioWord(ratio) + ' to 1, below ' + min + ' to 1';
    for (const d of dots) {
      const m = d.mark;
      if (m && m.color) { const r = contrastOf(m.color, canvasBg); if (below(r, 3)) markRule.add('Dot ' + d.label + "'s mark has a contrast of " + ratioWord(r) + ' to 1 against the canvas, below 3 to 1'); }
      if (m && m.glyph && m.glyph.color) { const r = contrastOf(m.glyph.color, m.glyph.background || canvasBg); if (below(r, 3)) markRule.add('Dot ' + d.label + "'s glyph has a contrast of " + ratioText(r, 3)); }
      for (const [part, x, verb] of [['initials', d.chip, 'have'], ['ID label', d.idLabel, 'has']]) {
        if (!x || !x.color) continue;
        const r = contrastOf(x.color, x.background || canvasBg);
        if (below(r, 4.5)) textRule.add('Dot ' + d.label + "'s " + part + ' ' + verb + ' a contrast of ' + ratioText(r, 4.5));
      }
    }
    markRule.end('dot marks with too little contrast');
    for (const [name, l] of layers) {
      for (const x of l.texts || []) { const r = contrastOf(x.color, x.background || l.background); if (below(r, 4.5)) textRule.add('Text "' + x.text + '" in the ' + name + ' has a contrast of ' + ratioText(r, 4.5)); }
    }
    textRule.end('texts with too little contrast');

    // Rule 10, hit targets: every dot, tile and +n at least 24 by 24 px, and neighbouring hit boxes at least 4 px apart (overlaps are rule 1).
    const sizeRule = rule();
    for (const h of hits) if (h.box.width < TARGET - TOL || h.box.height < TARGET - TOL) sizeRule.add(cap(h.name) + ' is ' + r0(h.box.width) + ' by ' + r0(h.box.height) + ' px, smaller than 24 by 24 px');
    sizeRule.end('hit targets that are too small');
    const apartRule = rule();
    for (let i = 0; i < hits.length; i += 1) for (let j = i + 1; j < hits.length; j += 1) {
      const a = hits[i];
      const b = hits[j];
      if (penetration(a.box, b.box) > TOL) continue;
      const gap = Math.max(-overX(a.box, b.box), -overY(a.box, b.box));
      if (gap >= APART - 0.05) continue;
      const text = Math.max(0, r0(gap)) + ' px apart, less than 4 px';
      apartRule.add(a.kind === 'dot' && b.kind === 'dot' ? 'Dots ' + a.short + ' and ' + b.short + ' are ' + text : cap(a.name) + ' and ' + b.name + ' are ' + text);
    }
    apartRule.end('hit targets too close together');

    // Rule 11, the Now marker: the line crosses no dot or label; the pill overlaps none of those, no header (one held at the edge covers it on
    // purpose), the preview or the card; the pill is opaque, its text whole, large enough and 4.5 to 1; the line 3 to 1 against the canvas.
    const now = t.now;
    if (now) {
      const marks = items.filter((x) => x.kind !== 'head' && x.kind !== 'more');
      const nowRule = rule();
      if (now.line && hasBox(now.line)) for (const x of marks) if (penetration(now.line, x.box) > 0.5) nowRule.add('The Now line crosses ' + x.name);
      if (now.pill && hasBox(now.pill)) {
        const others = marks.concat(items.filter((x) => x.kind === 'head' && !x.pinned), layers.map(([name, l]) => ({ name: 'the ' + name, box: l.box })));
        for (const x of others) if (penetration(now.pill, x.box) > TOL) nowRule.add('The Now pill overlaps ' + x.name);
      }
      if (seeThrough(now)) nowRule.add('The Now pill' + alphaText(now));
      for (const x of textsOf(now)) {
        if (x.cut && x.cut.by > TOL) nowRule.add('Text in the Now pill is cut by ' + r0(x.cut.by) + ' px');
        if (small(x.fontSize)) nowRule.add('Text in the Now pill is ' + fontText(x.fontSize));
        const r = x.color ? contrastOf(x.color, x.background || now.background) : null;
        if (below(r, 4.5)) nowRule.add('Text in the Now pill has a contrast of ' + ratioText(r, 4.5));
      }
      if (now.lineColor) { const r = contrastOf(now.lineColor, canvasBg); if (below(r, 3)) nowRule.add('The Now line has a contrast of ' + ratioWord(r) + ' to 1 against the canvas, below 3 to 1'); }
      nowRule.end('problems with the Now marker');
    }

    // Rule 12, percent labels: the project progress, each band's percent and progress text, and phase labels with a percent are whole (or cut
    // on purpose), at least 0.85 of the editor font and 4.5 to 1, and never on a dot, the preview or the card. (A phase label's cut and its
    // overlap with a dot are rules 2 and 1.)
    const percentRule = rule();
    const labels = (t.overall ? textsOf(t.overall).map((x) => Object.assign({ name: 'the project progress "' + x.text + '"', own: true }, x)) : [])
      .concat((t.percents || []).map((x) => Object.assign({ name: 'the ' + x.what + ' "' + x.text + '"', own: true }, x)))
      .concat(phaseLabels.filter((p) => p.percent).map((p) => Object.assign({ name: 'phase label "' + p.text + '"', own: false }, p)));
    for (const x of labels) {
      if (x.own && unmarked(x.cut)) percentRule.add(cap(x.name) + ' is cut by ' + r0(x.cut.by) + ' px');
      if (small(x.fontSize)) percentRule.add(cap(x.name) + ' is ' + fontText(x.fontSize));
      const r = x.color ? contrastOf(x.color, x.background || canvasBg) : null;
      if (below(r, 4.5)) percentRule.add(cap(x.name) + ' has a contrast of ' + ratioText(r, 4.5));
      if (!hasBox(x.box)) continue;
      if (x.own) for (const d of dots) if (penetration(x.box, d.box) > TOL) percentRule.add(cap(x.name) + ' overlaps dot ' + d.label);
      for (const [name, l] of layers) if (penetration(x.box, l.box) > TOL) percentRule.add(cap(x.name) + ' overlaps the ' + name);
    }
    percentRule.end('problems with the percent labels');
  }

  /** Every broken rule as one plain sentence; an empty list for a clean board. */
  function check(data) {
    const problems = [];
    const rule = ruleOf(problems);
    const kanban = data.layout === 'kanban';
    const page = data.page || { scrollWidth: 0, clientWidth: 0, scrollY: 0 };
    const region = data.region;
    const cards = (data.cards || []).filter(shown);
    const sized = cards.filter(boxed);
    const headByColumn = {};
    for (const h of data.heads || []) headByColumn[h.column] = h;

    // The page itself never scrolls sideways: in the kanban only the board region may.
    const sideways = page.scrollWidth - page.clientWidth;
    // In the Timeline view the timeline's own rule 5 says this (one sentence per problem).
    if (sideways > TOL && !data.timeline) {
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
    // In the Timeline view there are no card boxes; the timeline's first-screen facts are in its own report (62.1-UI-SPEC probe rule 7).
    const firstScreen = !data.timeline && !(region && region.scrollTop > TOL) && !(page.scrollY > TOL);
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
    if (data.timeline) checkTimeline(data, problems);
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
      // 62-24: where the sticky header row is (null in the list), so a real drag aims below what it hides.
      headRow: data.headRow ? { top: data.headRow.top, bottom: data.headRow.bottom } : null,
      heads: data.heads.map((h) => ({ column: h.column, left: h.left, right: h.right, folded: h.folded })),
      lanes: data.lanes.map((l) => ({ lane: l.lane, top: l.top, bottom: l.bottom, collapsed: l.collapsed })),
      cells: data.cells.map((c) => ({ lane: c.lane, column: c.column, left: c.left, top: c.top, width: c.width, height: c.height })),
      cards: data.cards.map((c) => ({ id: c.id, column: c.column, lane: c.lane, left: c.left, top: c.top, width: c.width, height: c.height, draggable: c.draggable })),
      visibleCards: visibleCount(data)
    };
    if (data.focused) out.focused = { id: data.focused.id, top: data.focused.top, bottom: data.focused.bottom, visible: !focusProblem(data) };
    // 62.1-07: what the real-window timeline tests aim with and assert. Only in the Timeline view; in Columns the report keeps its 62-16 keys.
    if (data.timeline) out.timeline = JSON.parse(JSON.stringify(data.timeline));
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
    const tl = one(document.getElementById('board'), '.tl-scroll');
    if (tl && (document.getElementById('root') || document.body).getAttribute('data-view') === 'timeline') {
      if (typeof top === 'number') tl.scrollTop = top;
      if (typeof left === 'number') tl.scrollLeft = left;
      return;
    }
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

  const timelineShown = () => (document.getElementById('root') || document.body).getAttribute('data-view') === 'timeline';
  /** Runs the asked action (scroll, focus, measure or rects), waits two frames, then measures. rects skips the rules and the word measuring. */
  function measure(action) {
    const a = typeof action === 'string' ? { action } : (action && typeof action === 'object' ? action : {});
    const kind = typeof a.action === 'string' ? a.action : 'measure';
    if (kind === 'scroll') scrollBoard(a.top, a.left);
    else if (kind === 'focus' && typeof a.itemId === 'string' && timelineShown()) { const b = all(document.getElementById('board'), 'button.tl-dot').find((n) => n.getAttribute('data-id') === a.itemId); if (b) b.focus(); }
    else if (kind === 'focus' && typeof a.itemId === 'string' && board && typeof board.focusCard === 'function') board.focusCard(a.itemId);
    return frame().then(frame).then(() => {
      const data = collect(kind !== 'rects');
      const out = reportOf(data, kind === 'rects' ? [] : check(data));
      if (a.controls === true) out.controls = JSON.parse(JSON.stringify(controlsOf()));
      // 62.1-08: the frame budget is read over one set of actions, so a question may clear the sample once this report has read it.
      const tlApi = window.NearAiTimeline;
      if (a.resetMetrics === true && tlApi && typeof tlApi.metrics === 'function') { try { tlApi.metrics({ reset: true }); } catch (error) { /* the report already says what metrics gave */ } }
      return out;
    });
  }

  window.NearAiBoardLayout = Object.freeze({ collect, check, measure, wordsIn, firstScreenOf });

  if (!board || typeof board.onMessage !== 'function' || typeof board.post !== 'function') return;
  board.onMessage('e2e-layout', (m) => {
    const id = typeof m.id === 'number' ? m.id : 0;
    let sent = false;
    const answer = (report) => { if (sent) return; sent = true; board.post({ type: 'e2e-layout-report', id, report }); };
    const failed = (error) => ({ width: 0, height: 0, layout: '', theme: '', problems: ['The layout probe failed: ' + String((error && error.message) || error)], toolbar: { height: 0, background: '', position: '' }, region: { left: 0, top: 0, width: 0, height: 0, scrollTop: 0, scrollLeft: 0 }, heads: [], lanes: [], cells: [], cards: [], visibleCards: 0 });
    try { measure(m).then(answer, (error) => answer(failed(error))); } catch (error) { answer(failed(error)); }
  });
})();
