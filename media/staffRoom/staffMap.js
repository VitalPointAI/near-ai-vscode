// The Staff Room's map (UX concept 5.5 and 5.10; WP-ROOM): one map interface, NearAiStaffMap.create(container, options), that the page draws every
// workspace's picture through. This renderer draws the host's map model (src/domain/staff/staffRoomMap.ts) as SVG on the scenario's fictional grid. Drop
// 2's cop-map (MapLibre on the exercise frame) implements the same interface: create, render, setLayer, highlight, showTable, focusFirst, destroy.
//
// Symbols follow the frame shapes of MIL-STD-2525 and APP-6 with the standard light fills (friend 128,224,255; hostile 255,128,128; neutral 170,255,170;
// unknown 255,255,128), so affiliation is carried by shape as well as colour. Anticipated things (an adversary course of action, a reported position)
// are dashed. Motion: only transform, opacity and stroke-dashoffset animate, through the Web Animations API, and none at all under reduced motion or Calm.
// Every text goes in with textContent.
(function () {
  const SVG = 'http://www.w3.org/2000/svg';
  const EASE = { std: 'cubic-bezier(.2,0,0,1)', settle: 'cubic-bezier(.34,1.4,.64,1)' };
  const AFF_WORD = { F: 'Friendly', H: 'Hostile', N: 'Neutral', U: 'Unknown' };

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
  function symbol(unit, parent) {
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
    if (unit.grade) { const chip = sv('tspan', { class: 'grade', dx: 3 }, label); chip.textContent = unit.grade.code; }
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
    const layersButton = el('button', 'btn small', 'Layers');
    layersButton.type = 'button';
    layersButton.setAttribute('aria-expanded', 'false');
    tools.append(layersButton, tableButton);
    box.append(tools);
    const layerPanel = el('div', 'layerpanel');
    layerPanel.hidden = true;
    layerPanel.setAttribute('role', 'group');
    layerPanel.setAttribute('aria-label', 'Map layers, each with the one section that writes it');
    box.append(layerPanel);
    const table = el('div', 'listview');
    table.hidden = true;
    box.append(table);
    const empty = el('div', 'mapempty');
    empty.hidden = true;
    box.append(empty);
    container.append(box);

    let model;
    const seen = new Set();
    const hidden = new Set(options.hiddenLayers || []);
    const layerGroups = new Map();
    let ecoaGroups = new Map();
    let tableOn = false;
    let mode = 'war-room';

    tableButton.addEventListener('click', () => showTable(!tableOn));
    layersButton.addEventListener('click', () => {
      const open = layerPanel.hidden;
      layerPanel.hidden = !open;
      layersButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
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

    function renderLayers() {
      layerPanel.replaceChildren();
      layerPanel.append(el('p', 'kicker', 'Layers · one writer each'));
      for (const layer of model.layers) {
        const row = el('div', 'sw');
        const button = el('button');
        button.type = 'button';
        button.setAttribute('role', 'switch');
        button.setAttribute('aria-checked', hidden.has(layer.id) ? 'false' : 'true');
        const label = layer.title + ', written by ' + layer.owner.member + ' (' + layer.owner.section.toUpperCase() + ')';
        button.setAttribute('aria-label', label);
        button.addEventListener('click', () => setLayer(layer.id, hidden.has(layer.id)));
        const name = el('span', 'swname', layer.title);
        const owner = el('span', 'chip sec', layer.owner.section.toUpperCase());
        owner.title = 'Written only by ' + layer.owner.member;
        const count = el('span', 'faint mono', String(layer.drawn) + (layer.reported !== undefined ? ' · COP ' + layer.reported : ''));
        count.title = layer.reported !== undefined ? 'Drawn here, and the count the writer last reported through the COP' : 'Drawn here';
        row.append(button, name, owner, count);
        layerPanel.append(row);
      }
    }

    function setLayer(id, on) {
      if (on) hidden.delete(id); else hidden.add(id);
      const group = layerGroups.get(id);
      if (group) group.setAttribute('visibility', on ? 'visible' : 'hidden');
      if (id === 'cop-threat-layer') for (const g of ecoaGroups.values()) g.setAttribute('visibility', on ? 'visible' : 'hidden');
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
      if (model.land) { sv('path', { class: 'land-glow', d: model.land }, parent); sv('path', { class: 'land', d: model.land }, parent); }
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
      for (const label of model.seaLabels) text({ class: 'plab', x: label.at[0], y: label.at[1], 'text-anchor': 'middle' }, label.name.toUpperCase(), parent);
    }

    function drawFeature(feature, parent) {
      const g = sv('g', { class: 'feat k-' + feature.kind }, parent);
      const p = feature.points;
      const a = p[0];
      if (feature.kind === 'high-ground' && p.length >= 2) {
        const b = p[p.length - 1];
        const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, len = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2 + 12;
        const angle = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
        [[1, 'contour'], [0.68, 'contour'], [0.36, 'ridge']].forEach(([k, cls]) => sv('ellipse', { class: cls, cx: f(cx), cy: f(cy), rx: f(len * k), ry: f(Math.max(4, len * 0.28 * k)), transform: 'rotate(' + f(angle) + ' ' + f(cx) + ' ' + f(cy) + ')' }, g));
        text({ class: 'tlab ridge-lab', x: f(cx + 6), y: f(cy - 4), transform: 'rotate(' + f(angle) + ' ' + f(cx + 6) + ' ' + f(cy - 4) + ')' }, feature.name, g);
      } else if (feature.kind === 'river' && p.length >= 2) {
        sv('path', { class: 'river', d: smooth(p) }, g);
        text({ class: 'tlab river-lab', x: f(p[Math.floor(p.length / 2)][0] + 4), y: f(p[Math.floor(p.length / 2)][1] + 9) }, feature.name, g);
      } else if (feature.kind === 'route' && p.length >= 2) {
        sv('path', { class: 'road', d: smooth(p) }, g);
        text({ class: 'tlab road-lab', x: f(p[0][0] + 4), y: f(p[0][1] + 12) }, feature.name.toUpperCase(), g);
      } else if (feature.kind === 'beach' && p.length >= 1) {
        sv('path', { class: 'beach', d: p.length >= 2 ? smooth(p) : 'M' + f(a[0] - 8) + ',' + f(a[1]) + ' L' + f(a[0] + 8) + ',' + f(a[1]) }, g);
      } else if (feature.kind === 'marsh') {
        const c = p.length >= 2 ? [(a[0] + p[p.length - 1][0]) / 2, (a[1] + p[p.length - 1][1]) / 2] : a;
        const rx = p.length >= 2 ? Math.hypot(p[p.length - 1][0] - a[0], p[p.length - 1][1] - a[1]) / 2 + 6 : 10;
        sv('ellipse', { class: 'marsh', cx: f(c[0]), cy: f(c[1]), rx: f(rx), ry: 6 }, g);
      } else if (feature.kind === 'island') {
        sv('ellipse', { class: 'land', cx: a[0], cy: a[1], rx: 14, ry: 7 }, g);
        text({ class: 'tlab', x: f(a[0] - 10), y: f(a[1] - 10) }, feature.name, g);
      } else if (feature.kind === 'town' || feature.kind === 'port') {
        [[0, 0, 9, 6], [7, 4, 6, 5], [-5, 5, 5, 4]].forEach(([dx, dy, w, h]) => sv('rect', { class: 'town', x: f(a[0] + dx - 4), y: f(a[1] + dy - 3), width: w, height: h, rx: 1 }, g));
        text({ class: 'tlab', x: f(a[0] + 10), y: f(a[1] - 5) }, feature.name, g);
      } else if (feature.kind === 'crossing') {
        sv('path', { class: 'bridge', d: 'M' + f(a[0] - 4) + ',' + f(a[1] - 3) + ' L' + f(a[0] - 2) + ',' + f(a[1] - 1.5) + ' L' + f(a[0] + 2) + ',' + f(a[1] - 1.5) + ' L' + f(a[0] + 4) + ',' + f(a[1] - 3) + ' M' + f(a[0] - 4) + ',' + f(a[1] + 3) + ' L' + f(a[0] - 2) + ',' + f(a[1] + 1.5) + ' L' + f(a[0] + 2) + ',' + f(a[1] + 1.5) + ' L' + f(a[0] + 4) + ',' + f(a[1] + 3) }, g);
        text({ class: 'tlab', x: f(a[0] + 6), y: f(a[1] + 11) }, feature.name, g);
      } else {
        sv('circle', { class: 'town', cx: a[0], cy: a[1], r: 2.5 }, g);
        text({ class: 'tlab', x: f(a[0] + 5), y: f(a[1] - 4) }, feature.name, g);
      }
      const title = sv('title', null, g); title.textContent = feature.name + (feature.grid ? ', ' + feature.grid : '') + '. ' + feature.description;
    }

    function drawGraphic(graphic, parent, fresh) {
      const g = sv('g', { class: 'cmg k-' + graphic.kind, 'data-name': graphic.name }, parent);
      const p = graphic.points;
      const a = p[0];
      if (graphic.kind === 'phase-line' && p.length >= 2) {
        sv('path', { class: 'cm pl', d: 'M' + f(a[0]) + ',' + f(a[1]) + ' L' + f(p[p.length - 1][0]) + ',' + f(p[p.length - 1][1]) }, g);
        text({ class: 'cmlab', x: f(a[0] + 2), y: f(a[1] - 3) }, graphic.name, g);
        text({ class: 'cmlab', x: f(p[p.length - 1][0] - 2), y: f(p[p.length - 1][1] - 3), 'text-anchor': 'end' }, graphic.name, g);
      } else if (graphic.kind === 'nai') {
        const spans = p.slice(1);
        const rx = spans.length ? Math.min(32, Math.max(12, ...spans.map((s) => Math.abs(s[0] - a[0]) + 6))) : 14;
        const ry = spans.length ? Math.min(24, Math.max(8, ...spans.map((s) => Math.abs(s[1] - a[1]) + 5))) : 9;
        sv('ellipse', { class: 'cm nai', cx: f(a[0]), cy: f(a[1]), rx: f(rx), ry: f(ry) }, g);
        text({ class: 'cmlab', x: f(a[0] - rx + 2), y: f(a[1] - ry - 3) }, graphic.name, g);
        if (fresh) anim(g, [{ opacity: 0 }, { opacity: 1 }], { duration: 450 });
      } else if (graphic.kind === 'objective') {
        const r = 13;
        const pts = [];
        for (let i = 0; i < 7; i += 1) { const t = (i / 7) * Math.PI * 2; pts.push([a[0] + Math.cos(t) * r * (0.82 + 0.25 * ((i * 37) % 7) / 7), a[1] + Math.sin(t) * r * 0.75]); }
        sv('path', { class: 'cm obj', d: 'M' + pts.map((pt) => f(pt[0]) + ',' + f(pt[1])).join(' L') + ' Z' }, g);
        text({ class: 'cmlab', x: f(a[0] - 14), y: f(a[1] + r + 9) }, graphic.name, g);
      } else if (graphic.kind === 'assembly-area') {
        sv('rect', { class: 'cm obj', x: f(a[0] - 16), y: f(a[1] - 9), width: 32, height: 18, rx: 7 }, g);
        text({ class: 'cmlab', x: f(a[0] - 14), y: f(a[1] + 19) }, graphic.name, g);
      } else if (graphic.kind === 'landing-area') {
        const b = p[p.length - 1];
        const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
        sv('ellipse', { class: 'cm la', cx: f(cx), cy: f(cy), rx: f(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2 + 8), ry: 7 }, g);
        text({ class: 'cmlab', x: f(cx - 12), y: f(cy - 10) }, graphic.name, g);
      } else {
        sv('path', { class: 'cm', d: smooth(p.length >= 2 ? p : [a, [a[0] + 1, a[1]]]) }, g);
        text({ class: 'cmlab', x: f(a[0] + 3), y: f(a[1] - 3) }, graphic.name, g);
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

    function drop(unit, parent, delay) {
      const g = symbol(unit, parent);
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

    function render(next, opts) {
      opts = opts || {};
      model = next;
      mode = opts.mode || mode;
      box.className = 'mapbox mode-' + mode;
      svg.replaceChildren();
      layerGroups.clear();
      ecoaGroups = new Map();
      if (!model || !model.available) {
        empty.hidden = false;
        empty.replaceChildren(el('p', 'mapempty-t', 'No map yet'), el('p', 'faint', model ? model.reason || '' : ''));
        if (options.onEmptyAction && model) { const b = el('button', 'btn', 'Load a staff exercise scenario'); b.type = 'button'; b.addEventListener('click', options.onEmptyAction); empty.append(b); }
        layerPanel.replaceChildren();
        if (tableOn) renderTable();
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
      for (const feature of model.features) drawFeature(feature, layerGroups.get('cop-terrain-layer'));
      for (const graphic of model.graphics) {
        const fresh = !seen.has('g:' + graphic.id);
        seen.add('g:' + graphic.id);
        drawGraphic(graphic, layerGroups.get(graphic.layer) || layerGroups.get('cop-operations-layer'), fresh);
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
        drop(unit, layerGroups.get(unit.layer) || layerGroups.get('cop-threat-layer'), isNew && opts.stagger ? delay : 0);
        if (isNew && opts.stagger) delay += 45;
      }
      renderLayers();
      if (tableOn) renderTable();
    }

    /** Pulses the named graphics (NAIs a PIR's collection covers) or an adversary COA, so a row in a list points at its place on the map. */
    function highlight(names) {
      const wanted = new Set(names || []);
      const walk = (node) => {
        for (const child of node.children || []) {
          if (child.getAttribute && child.getAttribute('data-name') !== null && child.getAttribute('data-name') !== undefined) {
            const on = wanted.has(child.getAttribute('data-name'));
            child.classList.toggle('hilite', on);
            if (on) anim(child, [{ opacity: 0.4 }, { opacity: 1 }], { duration: 600, iterations: 2 });
          }
          if (child.getAttribute && child.getAttribute('data-id') && ecoaGroups.has(child.getAttribute('data-id'))) child.classList.toggle('hilite', wanted.has(child.getAttribute('data-id')));
          walk(child);
        }
      };
      walk(svg);
    }

    function focusFirst() {
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

    return {
      element: box,
      render, highlight, showTable, focusFirst,
      setLayer,
      tableShown: () => tableOn,
      hiddenLayers: () => [...hidden],
      destroy: () => box.remove()
    };
  }

  window.NearAiStaffMap = { create };
})();
