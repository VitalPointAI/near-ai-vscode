// The Staff Room's map (UX concept 5.5 and 5.10; WP-ROOM, WP-COP): one map interface, NearAiStaffMap.create(container, options), that the page draws
// every workspace's picture through: create, render, setLayer, highlight, showTable, focusFirst, destroy, plus setPicture and setTheme for the COP map.
//
// Two renderers behind it. The COP map (media/staff/copMap.js, window.nearCopMap.mount: MapLibre on the exercise frame, globe and time slider) is used
// when the host has sent a COP picture with a frame, the script is loaded and WebGL works. Otherwise this file draws the host's map model
// (src/domain/staff/staffRoomMap.ts) as SVG on the scenario's fictional grid, and says why in a line on the map. Map as table, the keyboard flow and the
// highlights work the same with either.
//
// Labels on the SVG map never cover each other: after drawing, declutter() places every name label greedily by priority (units first, then the adversary
// axes and control measures, then places, then rivers, roads and sea names), trying its usual spot, then spots around its anchor, then a shortened name;
// a label that still fits nowhere is hidden and its symbol stays, with the name in the symbol's spoken label, its title and Map as table.
//
// Symbols follow the frame shapes of MIL-STD-2525 and APP-6 with the standard light fills (friend 128,224,255; hostile 255,128,128; neutral 170,255,170;
// unknown 255,255,128), so affiliation is carried by shape as well as colour. Anticipated things (an adversary course of action, a reported position)
// are dashed. Motion: only transform, opacity and stroke-dashoffset animate, through the Web Animations API, and none at all under reduced motion or Calm.
// Every text goes in with textContent.
(function () {
  const SVG = 'http://www.w3.org/2000/svg';
  const EASE = { std: 'cubic-bezier(.2,0,0,1)', settle: 'cubic-bezier(.34,1.4,.64,1)' };
  const AFF_WORD = { F: 'Friendly', H: 'Hostile', N: 'Neutral', U: 'Unknown' };
  /** The nonce of this script, which the COP map's lazy loads carry, so the page's policy needs no new script source. */
  const NONCE = typeof document !== 'undefined' && document.currentScript && document.currentScript.nonce ? document.currentScript.nonce : undefined;
  /** The theme's map colours the COP map takes, read from the page's CSS custom properties. */
  const THEME_VARS = {
    ocean: '--map-sea', land: '--map-land', marsh: '--map-ridge', contour: '--map-contour', river: '--map-river', road: '--map-road', line: '--map-ink', label: '--map-ink', halo: '--map-halo',
    hillShadow: '--map-hill-shadow', hillLight: '--map-hill-light', relief: '--map-relief', space: '--map-space'
  };
  /** The terrain pack's layers the SVG map draws (weather stays on the COP map, which has the time slider). */
  const ENV_DRAWN = { 'env-hillshade': true, 'env-contours': true };
  /** The host's earth radius (src/domain/staff/obs/frame.ts EARTH_RADIUS_M) and how much stronger than the pack's tones the hillshade is drawn (as copMap.js). */
  const EARTH_RADIUS_M = 6371008.8;
  const RELIEF = 1.8;

  // ---- Label placement (shared with media/staff/copMap.js) ------------------------------------------------------------------------------------

  /**
   * Label placement is the shared routine in media/staff/declutter.js (window.nearDeclutter), which the page loads first. Should it be missing, every
   * name label is hidden and its symbol stays, with the name in its title, its card and Map as table.
   */
  const declutter = (window.nearDeclutter && window.nearDeclutter.declutter) || function (labels) {
    const out = {};
    for (const label of labels) out[label.id] = { hidden: true };
    return out;
  };

  function sv(tag, attrs, parent) {
    const node = document.createElementNS(SVG, tag);
    if (attrs) for (const key of Object.keys(attrs)) if (attrs[key] !== undefined && attrs[key] !== null) node.setAttribute(key, String(attrs[key]));
    if (parent) parent.append(node);
    return node;
  }
  function text(attrs, value, parent) { const node = sv('text', attrs, parent); node.textContent = value; return node; }
  function el(tag, cls, value) { const node = document.createElement(tag); if (cls) node.className = cls; if (value !== undefined) node.textContent = value; return node; }
  const f = (n) => Number(n).toFixed(1);

  /** A smooth open path through points (Catmull-Rom). */
  function smooth(points) {
    if (!points.length) return '';
    let d = 'M' + f(points[0][0]) + ',' + f(points[0][1]);
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = points[i - 1] || points[i], p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
      d += ' C' + f(p1[0] + (p2[0] - p0[0]) / 6) + ',' + f(p1[1] + (p2[1] - p0[1]) / 6) + ' ' + f(p2[0] - (p3[0] - p1[0]) / 6) + ',' + f(p2[1] - (p3[1] - p1[1]) / 6) + ' ' + f(p2[0]) + ',' + f(p2[1]);
    }
    return d;
  }

  /** One unit symbol: the affiliation frame, the type icon, the echelon above, the designation (and grade) to the right. */
  function symbol(unit, parent, register) {
    const g = sv('g', { class: 'sym aff-' + unit.affiliation + (unit.anticipated ? ' planned' : ''), tabindex: '0', role: 'img', 'data-id': unit.id }, parent);
    g.setAttribute('aria-label', AFF_WORD[unit.affiliation] + ' ' + unit.kind + ', ' + unit.designation + (unit.grid ? ', at ' + unit.grid : '') + (unit.grade ? ', graded ' + unit.grade.code : ''));
    g.style.transform = 'translate(' + unit.at[0] + 'px, ' + unit.at[1] + 'px)';
    const body = sv('g', { class: 'sym-body' }, g);
    const a = unit.affiliation;
    let bx, by, top, right;
    if (a === 'F') { sv('rect', { class: 'fr', x: -9, y: -6, width: 18, height: 12 }, body); bx = 9; by = 6; top = -6; right = 9; }
    else if (a === 'H') { sv('path', { class: 'fr', d: 'M0,-8.5 L8.5,0 L0,8.5 L-8.5,0 Z' }, body); bx = 4.3; by = 4.3; top = -8.5; right = 8.5; }
    else if (a === 'U') { sv('path', { class: 'fr', d: 'M-3,-3 A4.3,4.3 0 1 1 3,-3 A4.3,4.3 0 1 1 3,3 A4.3,4.3 0 1 1 -3,3 A4.3,4.3 0 1 1 -3,-3 Z' }, body); bx = 3; by = 3; top = -7.5; right = 7.5; }
    else { sv('rect', { class: 'fr', x: -6, y: -6, width: 12, height: 12 }, body); bx = 6; by = 6; top = -6; right = 6; }
    const icon = unit.icon;
    if (icon === 'inf' || icon === 'mech') sv('path', { class: 'ic', d: 'M' + -bx + ',' + -by + ' L' + bx + ',' + by + ' M' + -bx + ',' + by + ' L' + bx + ',' + -by }, body);
    if (icon === 'arm' || icon === 'mech') sv('ellipse', { class: 'ic', cx: 0, cy: 0, rx: f(bx * (a === 'H' ? 1.05 : 0.62)), ry: f(by * 0.5) }, body);
    if (icon === 'arty') sv('circle', { class: 'ic solid', cx: 0, cy: 0, r: 1.8 }, body);
    if (icon === 'recce') sv('path', { class: 'ic', d: 'M' + -bx + ',' + by + ' L' + bx + ',' + -by }, body);
    if (icon === 'css') sv('path', { class: 'ic', d: 'M' + -bx + ',' + f(by * 0.4) + ' L' + bx + ',' + f(by * 0.4) }, body);
    if (icon === 'sea') sv('path', { class: 'ic', d: 'M-3.5,0.5 L3.5,0.5 L2.5,2.5 L-2.5,2.5 Z M0,0.5 L0,-3 M-1.5,-1.5 L1.5,-1.5' }, body);
    if (icon === 'air') sv('path', { class: 'ic', d: 'M-4,0 L4,0 M0,-3 L0,3 M-2,2.5 L2,2.5' }, body);
    if (icon === 'uas') sv('path', { class: 'ic', d: 'M-4,-1 L0,2 L4,-1' }, body);
    if (icon === 'ew') sv('path', { class: 'ic', d: 'M-4,1 L-1.5,-2 L1.5,2 L4,-1' }, body);
    if (icon === 'police') sv('path', { class: 'ic', d: 'M-3,-3 L3,3 M-3,3 L3,-3' }, body);
    if (unit.echelonMark) text({ class: 'ech', x: 0, y: f(top - 2) }, unit.echelonMark, body);
    if (unit.hq) sv('path', { class: 'staff', d: a === 'H' ? 'M-8.5,0 L-8.5,11' : 'M-9,6 L-9,15' }, body);
    const label = text({ class: 'des', x: f(right + 3), y: 2.5 }, unit.designation, body);
    const fill = () => { label.textContent = unit.designation; if (unit.grade) { const chip = sv('tspan', { class: 'grade', dx: 3 }, label); chip.textContent = unit.grade.code; } };
    fill();
    if (register) {
      register(label, {
        id: 'u:' + unit.id, x: unit.at[0], y: unit.at[1], first: [right + 3, 2.5, 'start'], gap: right + 2, prio: a === 'H' ? 4.5 : 4, size: 6.5,
        text: unit.designation + (unit.grade ? ' ' + unit.grade.code : ''), extra: unit.grade ? 3 : 0, origin: unit.at, restore: fill,
        obstacle: { x: unit.at[0] - right, y: unit.at[1] + top - (unit.echelonMark ? 6 : 0), w: right * 2, h: -top * 2 + (unit.echelonMark ? 6 : 0) }
      });
    }
    return g;
  }

  function create(container, options) {
    options = options || {};
    const motion = options.motion || (() => false);
    const anim = (node, frames, opts) => (motion() && node && typeof node.animate === 'function' ? node.animate(frames, Object.assign({ easing: EASE.std, fill: 'none' }, opts)) : null);
    const box = el('div', 'mapbox');
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Shared map');
    const svg = sv('svg', { class: 'map', role: 'group', 'aria-label': 'Map of the exercise area. Use Map as table for every unit and graphic in words.', preserveAspectRatio: 'xMidYMid meet' });
    box.append(svg);
    const hud = el('div', 'maphud');
    const cls = el('span', 'chip cls', 'UNCLAS // EX');
    const where = el('span', 'chip mono where', '');
    where.setAttribute('aria-hidden', 'true');
    hud.append(cls, where);
    box.append(hud);
    const tools = el('div', 'maptools');
    const tableButton = el('button', 'btn small', 'Map as table');
    tableButton.type = 'button';
    tableButton.setAttribute('aria-pressed', 'false');
    tableButton.setAttribute('aria-keyshortcuts', 'M');
    // Full map: the map fills the whole Staff Room panel; the button or Escape brings the room back (D-48 of 0.4.34).
    const fullButton = el('button', 'btn small map-full', 'Full map');
    fullButton.type = 'button';
    fullButton.setAttribute('aria-pressed', 'false');
    fullButton.title = 'Fill the Staff Room with the map (Escape returns)';
    // The layer drawer (media/staff/layerDrawer.js), the same one the COP map uses: it slides in from the map's right edge.
    const drawerApi = typeof window !== 'undefined' ? window.nearLayerDrawer : undefined;
    const drawer = drawerApi ? drawerApi.create(box, {
      motion, footnote: 'Each layer has one writer, named on its row.', onToggle: (id, on) => setLayer(id, on),
      // The 2D map's base: Topographic (the pack's land cover, hillshade and contours) or Plain; Imagery needs the WebGL map.
      onChoose: (group, id) => { if (group === 'base' && (id === 'topo' || id === 'plain') && id !== svgBase) { svgBase = id; if (options.onMapSettings) options.onMapSettings(Object.assign({}, options.mapSettings || {}, { base: id })); if (model) render(model); } }
    }) : undefined;
    let svgBase = options.mapSettings && options.mapSettings.base === 'plain' ? 'plain' : 'topo';
    /** The pack's land cover for the 2D Topographic base, fetched once from the address the host checked; undefined until it arrives. */
    let landcover;
    let landcoverFrom;
    if (drawer) { drawer.button.classList.add('layers-toggle'); tools.append(drawer.button); }
    tools.append(tableButton, fullButton);
    box.append(tools);
    const table = el('div', 'listview');
    table.hidden = true;
    box.append(table);
    const empty = el('div', 'mapempty');
    empty.hidden = true;
    box.append(empty);
    // The COP map's place, and the line that says why the SVG map is shown instead.
    const copSlot = el('div', 'copslot');
    copSlot.hidden = true;
    box.append(copSlot);
    const note = el('p', 'mapnote');
    note.hidden = true;
    note.setAttribute('role', 'status');
    box.append(note);
    container.append(box);

    let model;
    const seen = new Set();
    const hidden = new Set(options.hiddenLayers || []);
    const layerGroups = new Map();
    let ecoaGroups = new Map();
    let tableOn = false;
    let mode = 'war-room';
    let labelItems = [];
    let placement = {};
    let highlighted = [];
    // The COP map: idle (no usable picture yet), mounting, on (MapLibre runs), or off (it cannot run here; `copReason` says why).
    let copState = 'idle';
    let copView;
    let copReason;
    let picture;
    /** The host's checked tile addresses (src/staff/mapTiles.ts), for the COP map and the SVG map's land cover. */
    let basemap;
    let destroyed = false;
    const subscribers = new Set();
    const clock = {
      t: Date.now(), manual: false,
      now: () => clock.t,
      subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
      set: (t) => { clock.t = t; clock.manual = true; for (const fn of subscribers) fn(t); }
    };
    let full = false;
    let toolsMoved = false;

    tableButton.addEventListener('click', () => showTable(!tableOn));
    fullButton.addEventListener('click', () => setFull(!full));
    // Escape leaves the full map (a drawer open over it closes first, and stops the key there); Tab stays inside the full map while it covers the room.
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('keydown', (event) => {
        if (!full || destroyed) return;
        if (event.key === 'Escape') {
          if ((drawer && drawer.isOpen()) || (copView && copView.layers && copView.layers())) return;
          if (event.preventDefault) event.preventDefault();
          setFull(false);
          if (typeof fullButton.focus === 'function') fullButton.focus();
          return;
        }
        if (event.key === 'Tab' && drawerApi) {
          const list = drawerApi.focusables(box);
          if (!list.length) return;
          const active = document.activeElement;
          const first = list[0], last = list[list.length - 1];
          if (event.shiftKey && (active === first || !drawerApi.within(box, active))) { if (event.preventDefault) event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (active === last || !drawerApi.within(box, active))) { if (event.preventDefault) event.preventDefault(); first.focus(); }
        }
      });
    }

    /** The map over the whole Staff Room panel, or back in its place. Only opacity and transform animate, and not under reduced motion or Calm. */
    function setFull(on) {
      const next = Boolean(on);
      if (next === full) return;
      full = next;
      box.classList.toggle('full', full);
      fullButton.setAttribute('aria-pressed', full ? 'true' : 'false');
      fullButton.textContent = full ? 'Exit full map' : 'Full map';
      box.setAttribute('role', full ? 'dialog' : 'region');
      box.setAttribute('aria-modal', full ? 'true' : 'false');
      anim(box, [{ opacity: 0.55, transform: 'scale(.985)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 260 });
      if (options.onFull) options.onFull(full);
    }
    if (typeof svg.addEventListener === 'function') {
      svg.addEventListener('pointermove', (event) => {
        if (!model || !model.available || typeof svg.getScreenCTM !== 'function' || typeof svg.createSVGPoint !== 'function') return;
        const matrix = svg.getScreenCTM();
        if (!matrix) return;
        const point = svg.createSVGPoint();
        point.x = event.clientX; point.y = event.clientY;
        const local = point.matrixTransform(matrix.inverse());
        const easting = model.grid.originEasting + local.x * model.grid.unitMetres;
        const northing = model.grid.originNorthing - local.y * model.grid.unitMetres;
        const sq = model.grid.squareMetres;
        const pad = (value) => String(Math.max(0, Math.floor(value / (sq / 10)))).padStart(3, '0');
        where.textContent = model.grid.name + ' ' + pad(easting) + pad(northing);
      });
      svg.addEventListener('pointerleave', () => { where.textContent = ''; });
    }

    function showTable(on) {
      tableOn = Boolean(on);
      table.hidden = !tableOn;
      svg.setAttribute('aria-hidden', tableOn ? 'true' : 'false');
      copSlot.setAttribute('aria-hidden', tableOn ? 'true' : 'false');
      tableButton.setAttribute('aria-pressed', tableOn ? 'true' : 'false');
      if (options.onTable) options.onTable(tableOn);
      if (tableOn) renderTable();
    }

    function renderTable() {
      table.replaceChildren();
      if (!model || !model.available) { table.append(el('p', 'faint', model ? model.reason || 'No map.' : 'No map yet.')); return; }
      const section = (title, head, rows) => {
        table.append(el('h3', 'kicker', title));
        if (!rows.length) { table.append(el('p', 'faint', 'None.')); return; }
        const wrap = el('div', 'table-wrap');
        const t = el('table', 'grid-table stack-narrow');
        const thead = el('thead'); const hr = el('tr');
        for (const h of head) { const th = el('th', '', h); th.setAttribute('scope', 'col'); hr.append(th); }
        thead.append(hr);
        const tbody = el('tbody');
        for (const row of rows) { const tr = el('tr'); row.forEach((cell, i) => { const td = el('td', '', cell); td.dataset.label = head[i]; tr.append(td); }); tbody.append(tr); }
        t.append(thead, tbody); wrap.append(t); table.append(wrap);
      };
      section('Units', ['Affiliation', 'Designation', 'Type', 'Grid', 'Grade', 'Layer'], model.units.map((u) => [AFF_WORD[u.affiliation], u.designation, u.kind, u.grid || '', u.grade ? u.grade.code + ': ' + u.grade.words : 'Own-force data', layerTitle(u.layer)]));
      section('Graphics', ['Kind', 'Name', 'Where', 'Layer'], model.graphics.map((g) => [g.kind.replace(/-/g, ' '), g.name, g.description, layerTitle(g.layer)]));
      section('Adversary courses of action', ['Term', 'Statement', 'Likelihood', 'Confidence'], model.ecoas.map((e) => [e.term, e.statement, e.likelihood ? e.likelihood.term + ' (' + e.likelihood.range + ')' : 'Not stated', e.confidence || 'Not stated']));
      section('Not on the map', ['Affiliation', 'Designation', 'Location in words'], model.offMap.map((o) => [AFF_WORD[o.affiliation], o.designation, o.location]));
    }

    const layerTitle = (id) => { const layer = model && model.layers.find((entry) => entry.id === id); return layer ? layer.title : id; };

    /** The drawer's rows for the SVG map: each staff layer with its one writer, and the terrain pack's layers when the picture carries them. */
    function renderLayers() {
      if (!drawer || !drawerApi) return;
      const items = (model && model.available ? model.layers : []).map((layer) => ({
        id: layer.id, title: layer.title, count: layer.drawn, on: !hidden.has(layer.id), sim: false, owner: layer.owner.member + ' (' + layer.owner.section.toUpperCase() + ')',
        note: layer.reported !== undefined ? 'Drawn here: ' + layer.drawn + '. The writer last reported ' + layer.reported + ' through the COP.' : 'Drawn here: ' + layer.drawn + '.',
        group: layer.id === 'cop-terrain-layer' ? 'environment' : 'picture'
      }));
      const env = envPicture();
      if (env) {
        for (const layer of env.layers) {
          if (layer.kind !== 'environment' || !ENV_DRAWN[layer.id]) continue;
          items.push({ id: layer.id, title: layer.title, count: layer.count, on: !hidden.has(layer.id), sim: Boolean(layer.simulated), owner: layer.owner || '', note: layer.note || '', group: 'environment' });
        }
        items.unshift({ id: 'map-terrain', title: '3D terrain', count: '', on: false, disabled: true, reason: '3D terrain needs the WebGL map' + (copReason ? ': ' + copReason : '') + '.', group: 'environment' });
      }
      const groups = drawerApi.grouped(items);
      if (env && env.environment) {
        groups.unshift({ id: 'base', title: 'Base map', choice: true, items: [
          { id: 'imagery', title: 'Imagery', on: false, disabled: true, reason: 'Imagery needs the WebGL map' + (copReason ? ': ' + copReason : '') + '.' },
          { id: 'topo', title: 'Topographic', on: svgBase === 'topo' },
          { id: 'plain', title: 'Plain', on: svgBase === 'plain' }
        ] });
      }
      drawer.setGroups(groups);
    }

    function setLayer(id, on) {
      if (on) hidden.delete(id); else hidden.add(id);
      const group = layerGroups.get(id);
      if (group) group.setAttribute('visibility', on ? 'visible' : 'hidden');
      if (id === 'cop-threat-layer') for (const g of ecoaGroups.values()) g.setAttribute('visibility', on ? 'visible' : 'hidden');
      if (copView) copView.setLayerVisible(id, on);
      placeLabels();
      if (model) renderLayers();
      if (options.onLayers) options.onLayers([...hidden]);
    }

    function drawTerrain(parent) {
      const [x, y, w, h] = model.viewBox;
      const defs = sv('defs', null, parent);
      const grad = sv('linearGradient', { id: 'seaGrad', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      sv('stop', { offset: '0', class: 'sea2' }, grad); sv('stop', { offset: '1', class: 'sea1' }, grad);
      const hatch = sv('pattern', { id: 'marsh', width: 4, height: 4, patternUnits: 'userSpaceOnUse' }, defs);
      sv('path', { class: 'marshline', d: 'M0,3 L4,3 M1,1 L2,1' }, hatch);
      sv('rect', { x: f(x - w), y: f(y - h), width: f(w * 3), height: f(h * 3), fill: 'url(#seaGrad)' }, parent);
      for (let i = 0; i < 7; i += 1) sv('path', { class: 'swell', d: 'M' + f(x - w) + ',' + f(14 + i * 9) + ' C' + f(x + w * 0.3) + ',' + f(8 + i * 9) + ' ' + f(x + w * 0.6) + ',' + f(20 + i * 9) + ' ' + f(x + 2 * w) + ',' + f(12 + i * 9) }, parent);
      // The ground: the terrain pack's land, hillshade and contours when the picture carries them (the same ground the COP map draws), else the outline
      // the host drew round the scenario's places.
      if (!drawEnvironment(parent) && model.land) { sv('path', { class: 'land-glow', d: model.land }, parent); sv('path', { class: 'land', d: model.land }, parent); }
      // The grid: a line every 5 squares, labelled with its number.
      const step = 50;
      const startX = Math.ceil(x / step) * step;
      for (let gx = startX; gx < x + w; gx += step) {
        sv('line', { class: 'gridl', x1: gx, y1: y - h, x2: gx, y2: y + 2 * h }, parent);
        const e = Math.round((model.grid.originEasting + gx * model.grid.unitMetres) / model.grid.squareMetres);
        text({ class: 'glab', x: gx + 2, y: f(y + h - 3) }, model.grid.name + ' ' + String(e).padStart(2, '0'), parent);
      }
      for (let gy = step; gy < y + h; gy += step) {
        sv('line', { class: 'gridl', x1: x - w, y1: gy, x2: x + 2 * w, y2: gy }, parent);
        const n = Math.round((model.grid.originNorthing - gy * model.grid.unitMetres) / model.grid.squareMetres);
        text({ class: 'glab', x: f(x + 3), y: gy - 2 }, String(n).padStart(2, '0'), parent);
      }
      model.seaLabels.forEach((label, index) => {
        const node = text({ class: 'plab', x: label.at[0], y: label.at[1], 'text-anchor': 'middle' }, label.name.toUpperCase(), parent);
        register(node, { id: 's:' + index, x: label.at[0], y: label.at[1], first: [0, 0, 'middle'], gap: 8, prio: 0.5, size: 8, factor: 0.8, text: label.name.toUpperCase() });
      });
    }

    /** The land cover the host's checked address points at, fetched once (connect-src allows only the extension); redraws when it arrives. */
    function landcoverData() {
      const from = basemap && basemap.frame && typeof basemap.frame.landcover === 'string' && /\.geojson$/.test(basemap.frame.landcover) ? basemap.frame.landcover : undefined;
      if (!from || typeof fetch !== 'function') return undefined;
      if (landcoverFrom !== from) {
        landcoverFrom = from;
        landcover = undefined;
        fetch(from).then((r) => r.json()).then((json) => {
          if (landcoverFrom !== from || !json || json.type !== 'FeatureCollection' || !Array.isArray(json.features)) return;
          landcover = json;
          if (model && copState !== 'on') render(model);
        }, () => { /* the 2D map stays without land cover */ });
      }
      return landcover;
    }

    /** The picture whose terrain the SVG map draws: one with a frame, while the COP map is not the one on screen. */
    function envPicture() {
      return picture && picture.frame && Array.isArray(picture.frame.bounds) && copState !== 'on' && !copView ? picture : undefined;
    }

    /**
     * Draws the picture's synthetic land and the terrain pack's hillshade, contours and coastline in the SVG map's own units: longitude and latitude to
     * metres from the frame's origin (the host's rule, src/domain/staff/obs/frame.ts wgs84ToGrid), then to the map's grid. False when there is nothing.
     */
    function drawEnvironment(parent) {
      const env = envPicture();
      if (!env || !model.grid || !model.grid.unitMetres) return false;
      const b = env.frame.bounds;
      const cosC = Math.cos(((b[1] + b[3]) / 2) * Math.PI / 180);
      const k = (Math.PI / 180) * EARTH_RADIUS_M;
      const at = (c) => [((c[0] - b[0]) * k * cosC - model.grid.originEasting) / model.grid.unitMetres, (model.grid.originNorthing - (c[1] - b[1]) * k) / model.grid.unitMetres];
      const path = (ring, close) => ring.map((c, i) => { const p = at(c); return (i ? 'L' : 'M') + f(p[0]) + ',' + f(p[1]); }).join(' ') + (close ? ' Z' : '');
      const ground = (env.geography && env.geography.features) || [];
      const land = ground.filter((g) => g.properties && (g.properties.kind === 'land' || g.properties.kind === 'marsh') && g.geometry.type === 'Polygon');
      const terrain = env.environment;
      if (!land.length && !terrain) return false;
      for (const g of land) {
        const d = path(g.geometry.coordinates[0], true);
        if (g.properties.kind === 'land') sv('path', { class: 'land-glow', d }, parent);
        sv('path', { class: g.properties.kind === 'marsh' ? 'land env-marsh' : 'land', d }, parent);
      }
      if (!terrain) return land.length > 0;
      // Topographic: the pack's land cover in a topographic map's tints, under the hillshade and contours.
      const cover = svgBase === 'topo' ? landcoverData() : undefined;
      if (cover) {
        const fills = sv('g', { class: 'env-landcover' }, parent);
        for (const g of cover.features || []) {
          if (!g || !g.geometry || g.geometry.type !== 'Polygon' || !g.properties) continue;
          const kind = String(g.properties.kind);
          if (!/^(forest|scrub|farmland|beach|rock|built-up|marsh)$/.test(kind)) continue;
          sv('path', { class: 'lc lc-' + kind, d: g.geometry.coordinates.map((ring) => path(ring, true)).join(' '), 'fill-rule': 'evenodd' }, fills);
        }
        for (const g of cover.features || []) {
          if (!g || !g.geometry || g.geometry.type !== 'LineString' || !g.properties) continue;
          sv('path', { class: g.properties.kind === 'road' ? 'lc-road' : 'lc-track', d: path(g.geometry.coordinates, false), 'vector-effect': 'non-scaling-stroke' }, fills);
        }
      }
      const shade = sv('g', { class: 'layer env-hillshade', 'data-layer': 'env-hillshade' }, parent);
      for (const g of (terrain.hillshade && terrain.hillshade.features) || []) {
        if (!g.geometry || g.geometry.type !== 'Polygon') continue;
        const p = g.properties || {};
        sv('path', { class: 'env-hill ' + (p.tone === 'light' ? 'light' : 'shadow'), d: path(g.geometry.coordinates[0], true), 'fill-opacity': Math.min(0.85, RELIEF * (Number(p.opacity) || 0.2)).toFixed(2) }, shade);
      }
      const lines = sv('g', { class: 'layer env-contours', 'data-layer': 'env-contours' }, parent);
      for (const g of (terrain.contours && terrain.contours.features) || []) {
        if (!g.geometry || g.geometry.type !== 'LineString') continue;
        const p = g.properties || {};
        sv('path', { class: p.kind === 'coastline' ? 'env-coast' : 'env-contour' + (p.index ? ' index' : ''), d: path(g.geometry.coordinates, false), 'vector-effect': 'non-scaling-stroke' }, lines);
      }
      for (const [id, group] of [['env-hillshade', shade], ['env-contours', lines]]) {
        if (hidden.has(id)) group.setAttribute('visibility', 'hidden');
        layerGroups.set(id, group);
      }
      return true;
    }

    function drawFeature(feature, parent, index) {
      const g = sv('g', { class: 'feat k-' + feature.kind }, parent);
      const p = feature.points;
      const a = p[0];
      const id = 'f:' + index;
      const name = (node, at, first, extra) => register(node, Object.assign({ id, layer: 'cop-terrain-layer', x: at[0], y: at[1], first, gap: 6, prio: 2, size: 6.5, text: node.textContent, rings: 2 }, extra || {}));
      if (feature.kind === 'high-ground' && p.length >= 2) {
        const b = p[p.length - 1];
        const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, len = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2 + 12;
        const angle = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
        [[1, 'contour'], [0.68, 'contour'], [0.36, 'ridge']].forEach(([k, cls]) => sv('ellipse', { class: cls, cx: f(cx), cy: f(cy), rx: f(len * k), ry: f(Math.max(4, len * 0.28 * k)), transform: 'rotate(' + f(angle) + ' ' + f(cx) + ' ' + f(cy) + ')' }, g));
        // Level, so its box is the box the label placement checks.
        name(text({ class: 'tlab ridge-lab', x: f(cx + 6), y: f(cy - 4) }, feature.name, g), [cx, cy], [6, -4, 'start'], { gap: 8, prio: 1 });
      } else if (feature.kind === 'river' && p.length >= 2) {
        sv('path', { class: 'river', d: smooth(p) }, g);
        const m = p[Math.floor(p.length / 2)];
        name(text({ class: 'tlab river-lab', x: f(m[0] + 4), y: f(m[1] + 9) }, feature.name, g), m, [4, 9, 'start'], { prio: 1.2 });
      } else if (feature.kind === 'route' && p.length >= 2) {
        sv('path', { class: 'road', d: smooth(p) }, g);
        name(text({ class: 'tlab road-lab', x: f(p[0][0] + 4), y: f(p[0][1] + 12) }, feature.name.toUpperCase(), g), p[0], [4, 12, 'start'], { prio: 1.1 });
      } else if (feature.kind === 'beach' && p.length >= 1) {
        sv('path', { class: 'beach', d: p.length >= 2 ? smooth(p) : 'M' + f(a[0] - 8) + ',' + f(a[1]) + ' L' + f(a[0] + 8) + ',' + f(a[1]) }, g);
      } else if (feature.kind === 'marsh') {
        const c = p.length >= 2 ? [(a[0] + p[p.length - 1][0]) / 2, (a[1] + p[p.length - 1][1]) / 2] : a;
        const rx = p.length >= 2 ? Math.hypot(p[p.length - 1][0] - a[0], p[p.length - 1][1] - a[1]) / 2 + 6 : 10;
        sv('ellipse', { class: 'marsh', cx: f(c[0]), cy: f(c[1]), rx: f(rx), ry: 6 }, g);
      } else if (feature.kind === 'island') {
        sv('ellipse', { class: 'land', cx: a[0], cy: a[1], rx: 14, ry: 7 }, g);
        name(text({ class: 'tlab', x: f(a[0] - 10), y: f(a[1] - 10) }, feature.name, g), a, [-10, -10, 'start'], { gap: 10 });
      } else if (feature.kind === 'town' || feature.kind === 'port') {
        [[0, 0, 9, 6], [7, 4, 6, 5], [-5, 5, 5, 4]].forEach(([dx, dy, w, h]) => sv('rect', { class: 'town', x: f(a[0] + dx - 4), y: f(a[1] + dy - 3), width: w, height: h, rx: 1 }, g));
        name(text({ class: 'tlab', x: f(a[0] + 10), y: f(a[1] - 5) }, feature.name, g), a, [10, -5, 'start'], { gap: 10, prio: feature.kind === 'port' ? 2.4 : 2.2, obstacle: { x: a[0] - 9, y: a[1] - 3, w: 18, h: 9 } });
      } else if (feature.kind === 'crossing') {
        sv('path', { class: 'bridge', d: 'M' + f(a[0] - 4) + ',' + f(a[1] - 3) + ' L' + f(a[0] - 2) + ',' + f(a[1] - 1.5) + ' L' + f(a[0] + 2) + ',' + f(a[1] - 1.5) + ' L' + f(a[0] + 4) + ',' + f(a[1] - 3) + ' M' + f(a[0] - 4) + ',' + f(a[1] + 3) + ' L' + f(a[0] - 2) + ',' + f(a[1] + 1.5) + ' L' + f(a[0] + 2) + ',' + f(a[1] + 1.5) + ' L' + f(a[0] + 4) + ',' + f(a[1] + 3) }, g);
        name(text({ class: 'tlab', x: f(a[0] + 6), y: f(a[1] + 11) }, feature.name, g), a, [6, 11, 'start'], { obstacle: { x: a[0] - 4, y: a[1] - 3, w: 8, h: 6 } });
      } else {
        sv('circle', { class: 'town', cx: a[0], cy: a[1], r: 2.5 }, g);
        name(text({ class: 'tlab', x: f(a[0] + 5), y: f(a[1] - 4) }, feature.name, g), a, [5, -4, 'start'], { gap: 5, obstacle: { x: a[0] - 2.5, y: a[1] - 2.5, w: 5, h: 5 } });
      }
      const title = sv('title', null, g); title.textContent = feature.name + (feature.grid ? ', ' + feature.grid : '') + '. ' + feature.description;
    }

    function drawGraphic(graphic, parent, fresh, layer) {
      const g = sv('g', { class: 'cmg k-' + graphic.kind, 'data-name': graphic.name }, parent);
      const p = graphic.points;
      const a = p[0];
      const name = (node, at, first, extra) => register(node, Object.assign({ id: 'g:' + graphic.id, layer, x: at[0], y: at[1], first, gap: 6, prio: 3, size: 6.5, text: graphic.name, rings: 2 }, extra || {}));
      if (graphic.kind === 'phase-line' && p.length >= 2) {
        sv('path', { class: 'cm pl', d: 'M' + f(a[0]) + ',' + f(a[1]) + ' L' + f(p[p.length - 1][0]) + ',' + f(p[p.length - 1][1]) }, g);
        name(text({ class: 'cmlab', x: f(a[0] + 2), y: f(a[1] - 3) }, graphic.name, g), a, [2, -3, 'start'], { id: 'g:' + graphic.id + ':a', gap: 4 });
        const b = p[p.length - 1];
        name(text({ class: 'cmlab', x: f(b[0] - 2), y: f(b[1] - 3), 'text-anchor': 'end' }, graphic.name, g), b, [-2, -3, 'end'], { id: 'g:' + graphic.id + ':b', gap: 4 });
      } else if (graphic.kind === 'nai') {
        const spans = p.slice(1);
        const rx = spans.length ? Math.min(32, Math.max(12, ...spans.map((s) => Math.abs(s[0] - a[0]) + 6))) : 14;
        const ry = spans.length ? Math.min(24, Math.max(8, ...spans.map((s) => Math.abs(s[1] - a[1]) + 5))) : 9;
        sv('ellipse', { class: 'cm nai', cx: f(a[0]), cy: f(a[1]), rx: f(rx), ry: f(ry) }, g);
        name(text({ class: 'cmlab', x: f(a[0] - rx + 2), y: f(a[1] - ry - 3) }, graphic.name, g), a, [-rx + 2, -ry - 3, 'start'], { prio: 3.2 });
        if (fresh) anim(g, [{ opacity: 0 }, { opacity: 1 }], { duration: 450 });
      } else if (graphic.kind === 'objective') {
        const r = 13;
        const pts = [];
        for (let i = 0; i < 7; i += 1) { const t = (i / 7) * Math.PI * 2; pts.push([a[0] + Math.cos(t) * r * (0.82 + 0.25 * ((i * 37) % 7) / 7), a[1] + Math.sin(t) * r * 0.75]); }
        sv('path', { class: 'cm obj', d: 'M' + pts.map((pt) => f(pt[0]) + ',' + f(pt[1])).join(' L') + ' Z' }, g);
        name(text({ class: 'cmlab', x: f(a[0] - 14), y: f(a[1] + r + 9) }, graphic.name, g), a, [-14, r + 9, 'start'], { gap: 14 });
      } else if (graphic.kind === 'assembly-area') {
        sv('rect', { class: 'cm obj', x: f(a[0] - 16), y: f(a[1] - 9), width: 32, height: 18, rx: 7 }, g);
        name(text({ class: 'cmlab', x: f(a[0] - 14), y: f(a[1] + 19) }, graphic.name, g), a, [-14, 19, 'start'], { gap: 12 });
      } else if (graphic.kind === 'landing-area') {
        const b = p[p.length - 1];
        const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
        sv('ellipse', { class: 'cm la', cx: f(cx), cy: f(cy), rx: f(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2 + 8), ry: 7 }, g);
        name(text({ class: 'cmlab', x: f(cx - 12), y: f(cy - 10) }, graphic.name, g), [cx, cy], [-12, -10, 'start'], { gap: 10 });
      } else {
        sv('path', { class: 'cm', d: smooth(p.length >= 2 ? p : [a, [a[0] + 1, a[1]]]) }, g);
        name(text({ class: 'cmlab', x: f(a[0] + 3), y: f(a[1] - 3) }, graphic.name, g), a, [3, -3, 'start'], { gap: 4 });
      }
      const title = sv('title', null, g); title.textContent = graphic.name + ': ' + graphic.description;
      return g;
    }

    let maskSeq = 0;
    /** An adversary course of action as a dashed red axis that draws itself on, its head and label last. */
    function drawAxis(coa, parent, fresh) {
      const g = sv('g', { class: 'ax h ' + coa.id, 'data-id': coa.id }, parent);
      const p = coa.points;
      const n = p.length;
      const e = p[n - 1], q = p[n - 2];
      const len = Math.hypot(e[0] - q[0], e[1] - q[1]) || 1, ux = (e[0] - q[0]) / len, uy = (e[1] - q[1]) / len;
      const w = coa.id === 'mdcoa' ? 4.2 : 3;
      const hl = w * 2.8, hw = w * 1.9;
      const trimmed = p.slice(0, -1).concat([[e[0] - ux * hl * 0.6, e[1] - uy * hl * 0.6]]);
      const d = smooth(trimmed);
      const id = 'axm' + (++maskSeq);
      const [vx, vy, vw, vh] = model.viewBox;
      const mask = sv('mask', { id, maskUnits: 'userSpaceOnUse', x: vx - vw, y: vy - vh, width: vw * 3, height: vh * 3 }, g);
      const reveal = sv('path', { d, stroke: '#fff', 'stroke-width': w + 24, fill: 'none', pathLength: 1, 'stroke-dasharray': '1 1', 'stroke-linecap': 'round' }, mask);
      const bodyG = sv('g', { mask: 'url(#' + id + ')' }, g);
      sv('path', { class: 'ax-halo', d, 'stroke-width': w + 3 }, bodyG);
      sv('path', { class: 'ax-out', d, 'stroke-width': w }, bodyG);
      const bx = e[0] - ux * hl, by = e[1] - uy * hl;
      const head = sv('path', { class: 'head', d: 'M' + f(e[0]) + ',' + f(e[1]) + ' L' + f(bx - uy * hw) + ',' + f(by + ux * hw) + ' L' + f(bx + uy * hw) + ',' + f(by - ux * hw) + ' Z' }, g);
      const mid = p[Math.floor(n / 2)];
      const label = text({ class: 'axlab', x: f(mid[0] + 7), y: f(mid[1] - 5) }, coa.term, g);
      register(label, { id: 'e:' + coa.id, layer: 'cop-threat-layer', x: mid[0], y: mid[1], first: [7, -5, 'start'], gap: 7, prio: 3.5, size: 7, text: coa.term, rings: 2 });
      const title = sv('title', null, g); title.textContent = coa.term + ': ' + coa.statement;
      reveal.style.strokeDashoffset = '0';
      if (fresh) {
        const run = anim(reveal, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 1100 });
        if (run) {
          head.style.opacity = '0'; label.style.opacity = '0';
          run.onfinish = () => { head.style.opacity = '1'; label.style.opacity = '1'; anim(head, [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 200 }); anim(label, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 }); };
        }
      }
      return g;
    }

    function drop(unit, parent, delay, layer) {
      const g = symbol(unit, parent, (node, spec) => register(node, Object.assign({ layer }, spec)));
      g.addEventListener('click', () => { if (options.onSelect) options.onSelect(unit, g); });
      g.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (options.onSelect) options.onSelect(unit, g); } });
      if (!seen.has('u:' + unit.id)) {
        seen.add('u:' + unit.id);
        const body = g.children[0];
        anim(body, [{ opacity: 0, transform: 'translate(0px,-8px) scale(1.3)' }, { opacity: 1, transform: 'translate(0px,0px) scale(1)' }], { duration: 450, delay, easing: EASE.settle, fill: 'backwards' });
        if (motion()) {
          const ring = sv('circle', { class: 'ripple', cx: unit.at[0], cy: unit.at[1], r: 6 }, parent);
          ring.style.transformOrigin = unit.at[0] + 'px ' + unit.at[1] + 'px';
          ring.style.transformBox = 'view-box';
          ring.style.opacity = '0';
          const run = anim(ring, [{ opacity: 0.8, transform: 'scale(.5)' }, { opacity: 0, transform: 'scale(2.6)' }], { duration: 700, delay });
          if (run) run.onfinish = () => ring.remove(); else ring.remove();
        }
      }
      return g;
    }

    /** Notes a name label for the placement pass: its text node, its anchor and usual spot, and the symbol box it must not leave covered. */
    function register(node, spec) {
      const size = spec.size || 6.5;
      // Sized on the safe side of the browser's own text box (bold capitals, ascent and descent), so the estimate never undercounts.
      const h = size * 1.4;
      const item = Object.assign({ node, h, w: Math.ceil(String(spec.text).length * size * (spec.factor || 0.64)) + 2 + (spec.extra || 0), origin: [0, 0], shortened: false }, spec);
      item.size = size;
      if (spec.first) item.first = [spec.first[0], spec.first[1] - h * 0.32, spec.first[2]];
      labelItems.push(item);
    }

    /** Places every name label on a shown layer so none covers another or a symbol (declutter above); a label with no room is hidden. */
    function placeLabels() {
      const live = labelItems.filter((item) => !item.layer || !hidden.has(item.layer));
      const obstacles = live.filter((item) => item.obstacle).map((item) => Object.assign({ owner: item.id }, item.obstacle));
      const placed = declutter(live, obstacles);
      placement = {};
      for (const item of labelItems) {
        const at = placed[item.id];
        if (!at || at.hidden) {
          item.node.setAttribute('visibility', 'hidden');
          item.node.setAttribute('data-label', at ? 'hidden' : 'off');
          placement[item.id] = { id: item.id, layer: item.layer, hidden: true };
          continue;
        }
        item.node.setAttribute('visibility', 'visible');
        item.node.setAttribute('data-label', at.text === item.text ? 'placed' : 'short');
        item.node.setAttribute('x', f(at.x - item.origin[0]));
        item.node.setAttribute('y', f(at.y - item.origin[1]));
        item.node.setAttribute('text-anchor', at.anchor);
        if (at.text !== item.text) { item.node.textContent = at.text; item.shortened = true; }
        else if (item.shortened) { if (item.restore) item.restore(); else item.node.textContent = item.text; item.shortened = false; }
        const usual = Boolean(item.first) && at.text === item.text && at.anchor === item.first[2] && Math.abs(at.x - item.x - item.first[0]) < 0.01 && Math.abs(at.y - item.h * 0.32 - item.y - item.first[1]) < 0.01;
        placement[item.id] = { id: item.id, layer: item.layer, hidden: false, text: at.text, box: at.box, usual };
      }
    }

    function render(next, opts) {
      opts = opts || {};
      model = next;
      mode = opts.mode || mode;
      box.className = 'mapbox mode-' + mode + (copView ? ' has-cop' : copState === 'mounting' ? ' cop-mounting' : '') + (copView && toolsMoved ? ' cop-tools' : '') + (full ? ' full' : '');
      svg.replaceChildren();
      labelItems = [];
      layerGroups.clear();
      ecoaGroups = new Map();
      if (!model || !model.available) {
        empty.hidden = false;
        empty.replaceChildren(el('p', 'mapempty-t', 'No map yet'), el('p', 'faint', model ? model.reason || '' : ''));
        if (options.onEmptyAction && model) { const b = el('button', 'btn', 'Load a staff exercise scenario'); b.type = 'button'; b.addEventListener('click', options.onEmptyAction); empty.append(b); }
        renderLayers();
        if (tableOn) renderTable();
        placement = {};
        return;
      }
      empty.hidden = true;
      svg.setAttribute('viewBox', model.viewBox.join(' '));
      const terrain = sv('g', { class: 'terrain' }, svg);
      drawTerrain(terrain);
      const order = ['cop-terrain-layer', 'cop-operations-layer', 'cop-threat-layer', 'cop-logistics-layer', 'cop-plans-layer'];
      for (const id of order) {
        const g = sv('g', { class: 'layer ' + id, 'data-layer': id }, svg);
        if (hidden.has(id)) g.setAttribute('visibility', 'hidden');
        layerGroups.set(id, g);
      }
      model.features.forEach((feature, index) => drawFeature(feature, layerGroups.get('cop-terrain-layer'), index));
      for (const graphic of model.graphics) {
        const fresh = !seen.has('g:' + graphic.id);
        seen.add('g:' + graphic.id);
        const layer = layerGroups.has(graphic.layer) ? graphic.layer : 'cop-operations-layer';
        drawGraphic(graphic, layerGroups.get(layer), fresh, layer);
      }
      const axes = sv('g', { class: 'ecoas' }, layerGroups.get('cop-threat-layer'));
      for (const coa of model.ecoas) {
        if (coa.points.length < 2) continue;
        const key = 'e:' + coa.id + ':' + coa.points.map((pt) => pt.join(',')).join(';');
        const fresh = !seen.has(key);
        seen.add(key);
        ecoaGroups.set(coa.id, drawAxis(coa, axes, fresh));
      }
      let delay = 0;
      for (const unit of model.units) {
        const isNew = !seen.has('u:' + unit.id);
        const layer = layerGroups.has(unit.layer) ? unit.layer : 'cop-threat-layer';
        drop(unit, layerGroups.get(layer), isNew && opts.stagger ? delay : 0, layer);
        if (isNew && opts.stagger) delay += 45;
      }
      placeLabels();
      if (highlighted.length) highlight(highlighted, true);
      renderLayers();
      if (tableOn) renderTable();
    }

    /** Pulses the named graphics (NAIs a PIR's collection covers) or an adversary COA, so a row in a list points at its place on the map. */
    function highlight(names, quiet) {
      highlighted = (names || []).slice();
      if (copView && !quiet) copView.highlight(highlighted);
      const wanted = new Set(names || []);
      const walk = (node) => {
        for (const child of node.children || []) {
          if (child.getAttribute && child.getAttribute('data-name') !== null && child.getAttribute('data-name') !== undefined) {
            const on = wanted.has(child.getAttribute('data-name'));
            child.classList.toggle('hilite', on);
            if (on && !quiet) anim(child, [{ opacity: 0.4 }, { opacity: 1 }], { duration: 600, iterations: 2 });
          }
          if (child.getAttribute && child.getAttribute('data-id') && ecoaGroups.has(child.getAttribute('data-id'))) child.classList.toggle('hilite', wanted.has(child.getAttribute('data-id')));
          walk(child);
        }
      };
      walk(svg);
    }

    function focusFirst() {
      if (copView && !tableOn) { copView.focus(); return; }
      const first = svg.children && [...svg.children].length ? findSymbol(svg) : null;
      if (first && typeof first.focus === 'function') first.focus();
    }
    function findSymbol(node) {
      for (const child of node.children || []) {
        if (child.getAttribute && child.getAttribute('class') && String(child.getAttribute('class')).split(' ').includes('sym')) return child;
        const found = findSymbol(child);
        if (found) return found;
      }
      return null;
    }

    // ---- The COP map ------------------------------------------------------------------------------------------------------------------------

    function showNote(text) { note.hidden = !text; note.textContent = text || ''; }

    /** The SVG map stays, and says why: the COP map cannot run in this window. */
    function copOff(reason) {
      copState = 'off';
      copReason = reason;
      copView = undefined;
      copSlot.hidden = true;
      copSlot.replaceChildren();
      box.classList.remove('has-cop');
      box.classList.remove('cop-mounting');
      showNote('2D map: ' + reason + '.');
      // The SVG map now draws the picture's terrain too.
      if (model && model.available && envPicture()) render(model);
      if (options.onRenderer) options.onRenderer('svg', reason);
    }

    function themeColours() {
      if (typeof getComputedStyle !== 'function') return undefined;
      try {
        const style = getComputedStyle(box);
        const out = {};
        for (const key of Object.keys(THEME_VARS)) { const value = String(style.getPropertyValue(THEME_VARS[key]) || '').trim(); if (value) out[key] = value; }
        return out;
      } catch (error) { return undefined; }
    }

    function mountCop() {
      const api = typeof window !== 'undefined' ? window.nearCopMap : undefined;
      if (!api || typeof api.mount !== 'function') { copOff('the COP map script did not load'); return; }
      copState = 'mounting';
      // The map measures its box when it starts, so the slot has its full size (unseen) while it loads.
      copSlot.hidden = false;
      box.classList.add('cop-mounting');
      const cop = options.cop || {};
      let mounting;
      try {
        mounting = api.mount(copSlot, {
          resources: cop.resources, nonce: cop.nonce || NONCE, renderer: 'auto', projection: 'map', clock, still: true, motion, colours: themeColours(),
          basemap, mapSettings: options.mapSettings, onMapSettings: options.onMapSettings,
          // A layer turned on or off in the map's drawer is remembered like one turned in the SVG map's.
          onLayer: (id, on) => { if (on) hidden.delete(id); else hidden.add(id); if (options.onLayers) options.onLayers([...hidden]); }
        });
      } catch (error) { copOff('the COP map could not start (' + (error && error.message ? error.message : String(error)) + ')'); return; }
      Promise.resolve(mounting).then((view) => {
        if (destroyed) { if (view && view.destroy) view.destroy(); return; }
        if (!view || view.renderer !== 'maplibre') {
          const reason = (view && view.reason) || 'the map library did not start';
          try { if (view && view.destroy) view.destroy(); } catch (error) { /* already gone */ }
          copOff(reason);
          return;
        }
        copView = view;
        copState = 'on';
        copReason = undefined;
        showNote('');
        copSlot.hidden = false;
        copSlot.setAttribute('aria-hidden', tableOn ? 'true' : 'false');
        box.classList.remove('cop-mounting');
        box.classList.add('has-cop');
        if (drawer) drawer.close(false);
        // The room's own controls join the map's, over the map.
        if (typeof view.addTool === 'function') { view.addTool(tableButton); view.addTool(fullButton); toolsMoved = true; box.classList.add('cop-tools'); }
        try {
          view.setPicture(picture);
          for (const id of hidden) view.setLayerVisible(id, false);
          if (highlighted.length) view.highlight(highlighted);
        } catch (error) { /* the next picture tries again */ }
        if (options.onRenderer) options.onRenderer('maplibre');
      }, (error) => copOff('the COP map could not start (' + (error && error.message ? error.message : String(error)) + ')'));
    }

    /**
     * The host's COP picture (src/domain/staff/cop/picture.ts), already clamped to what the person may see, and the time the host's clock says. The
     * first picture with an exercise frame mounts the COP map; until then, and whenever it cannot run here, the SVG map is drawn.
     */
    function setPicture(next, info) {
      info = info || {};
      if (typeof info.now === 'number' && isFinite(info.now)) {
        const span = next && next.time;
        if (clock.manual && span && clock.t >= span.max) clock.manual = false;
        if (!clock.manual) { clock.t = info.now; for (const fn of subscribers) fn(info.now); }
      }
      if (!next) {
        if (copState !== 'on' && copState !== 'off') showNote(info.problem ? '2D map: ' + info.problem + '.' : '');
        return;
      }
      const groundBefore = picture ? JSON.stringify([picture.frame, picture.geography, picture.environment]) : '';
      picture = next;
      if (copView) { try { copView.setPicture(next); } catch (error) { /* a picture the map refuses leaves the last one */ } return; }
      if (copState === 'idle' && next.frame) { mountCop(); return; }
      // The SVG map redraws when the ground it takes from the picture changed.
      if (copState === 'off' && model && model.available && JSON.stringify([next.frame, next.geography, next.environment]) !== groundBefore) render(model);
    }

    /** The host's checked tile addresses: kept for the COP map's mount, and given to a running map. */
    function setBasemap(next) {
      basemap = next;
      if (copView && copView.setBasemap) { try { copView.setBasemap(next); } catch (error) { /* the map keeps what it had */ } }
      if (copState === 'off' && model && model.available) render(model);
    }

    /** The theme changed: the COP map takes the page's map colours (the SVG map follows the CSS by itself). */
    function setTheme() {
      const colours = themeColours();
      if (copView && colours) copView.setColours(colours);
    }

    return {
      element: box,
      render, highlight, showTable, focusFirst,
      setLayer, setPicture, setTheme, setBasemap,
      renderer: () => ({ kind: copView ? 'maplibre' : 'svg', state: copState, reason: copReason }),
      labels: () => Object.values(placement),
      tableShown: () => tableOn,
      hiddenLayers: () => [...hidden],
      setFull, fullShown: () => full, drawer: () => drawer,
      /** Fits the COP map to the exercise frame again once its box has its new size (the map moved to another workspace). */
      refit: () => { if (copView && copView.fitFrame) setTimeout(() => { if (copView) copView.fitFrame(); }, 120); },
      destroy: () => { destroyed = true; if (drawer) drawer.destroy(); if (copView) copView.destroy(); copView = undefined; box.remove(); }
    };
  }

  window.NearAiStaffMap = { create, declutter };
})();
