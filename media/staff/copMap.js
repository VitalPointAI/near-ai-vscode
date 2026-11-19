// The COP map component (design 10, 6.2; UX concept 5.10, 12 and 13; research note 11, section 6; WP-COP). One component for the threat picture, the
// COP, COA sketches, the wargame and brief thumbnails: the Staff Room embeds it, and it replaces the Staff Room's SVG map behind the same interface.
//
// The interface (window.nearCopMap), kept small on purpose:
//
//   const view = await nearCopMap.mount(container, {
//     resources: { maplibre, worker, milsymbol },  // webview URIs of media/vendor/... (src/staff/copMapWebview.ts copMapResources)
//     nonce,                                       // the page's script nonce: the lazy loads carry it, so the CSP needs no new script source
//     renderer: 'auto' | 'maplibre' | 'svg',       // auto: MapLibre when WebGL and the libraries load, else the SVG map, with the reason
//     projection: 'map' | 'globe',
//     clock: { now(), subscribe(fn) -> unsubscribe, set(t) },   // the Staff Room's shared clock; the slider moves it and follows it
//     mode: 'valid' | 'known',                     // "as happened" or "as known" replay (note 11, 4.4)
//     onSelect(feature | undefined)                // a symbol's card, already shown in the component
//   });
//   view.renderer, view.reason                     // which renderer runs, and why the SVG map if it does
//   view.setPicture(picture)                       // the host's CopPicture (src/domain/staff/cop/picture.ts), display data only
//   view.setTime(ms) / view.setMode(mode)          // also driven by the clock; redraws at most 10 times a second
//   view.setProjection('map' | 'globe') -> boolean // false on the SVG map, which is 2D only
//   view.setLayerVisible(id, on) / view.setEcoa(id | undefined) / view.select(id | undefined) / view.destroy()
//   view.highlight(names)                          // marks the features whose name, ECOA or ECOA role is listed (a PIR's NAIs, an adversary COA); [] clears
//   view.setColours(colours) / view.focus()        // the host page's theme (ocean, land, marsh, contour, river, road, line, label, halo); focus the map
//
// Mount options also take `colours` (the same keys as setColours) and `still: true`, which turns off MapLibre's label fades (the Staff Room's Calm and
// reduced motion).
//
// Labels. Symbol images never carry text: every name is a separate label, placed so labels do not cover each other or a symbol, and the symbol always
// stays. MapLibre places them with its own collision index: the symbols are the top symbol layer (icon-allow-overlap true, so never dropped, and
// icon-ignore-placement false, so they claim their room), and names follow in the layers below with text-allow-overlap false, text-optional true,
// variable anchors around the symbol and text padding: symbols first, then their names, then place names, then control measures. With
// no glyph server MapLibre draws the letters locally from the system's sans-serif font, so no request is made. The SVG map runs declutter() (media/staff/declutter.js): greedy
// placement in priority order, trying offsets around the anchor, then a shortened name, and a label that fits nowhere is hidden (its name stays in the
// feature's title, its card and Map as table).
//
// Offline: the page never asks for a tile, glyph, sprite or font. The ground is the picture's synthetic geography; symbols are drawn by the vendored
// milsymbol; text is drawn into symbol images or set as DOM text. The only requests are the vendored files from the extension. The page never decides
// anything and shows the host's latest state; every text goes in with textContent.
(function () {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const MAX_REDRAWS_PER_SECOND = 10;
  const COLOURS = { ocean: '#0e2a47', land: '#3d4a3a', marsh: '#4f6152', contour: '#8a9a7b', river: '#5aa0d8', road: '#c9b26b', friendly: '#80e0ff', hostile: '#ff8080', line: '#e8e8e8', adversary: '#ff8080', star: '#ffd23f', label: '#ffffff', halo: '#000000' };
  const ADVERSARY_KINDS = { 'axis-adversary': true };
  const LABEL_FONT = ['sans-serif'];

  // ---- Label placement (the SVG map; shared with the Staff Room's SVG map) -----------------------------------------------------------------

  /**
   * Label placement is the shared routine in media/staff/declutter.js (window.nearDeclutter), which the page loads first. Should it be missing, every
   * name label is hidden and its symbol stays, with the name in its title, its card and Map as table.
   */
  const declutter = (window.nearDeclutter && window.nearDeclutter.declutter) || function (labels) {
    const out = {};
    for (const label of labels) out[label.id] = { hidden: true };
    return out;
  };

  /** A label's anchor and priority for a drawn feature: symbols first, then decision points, then control measures; place names (2.2) go between. */
  function labelAnchor(feature) {
    const g = feature.geometry;
    const p = feature.properties;
    let at;
    if (g.type === 'Point') at = g.coordinates;
    else if (g.type === 'LineString') at = g.coordinates[Math.floor((g.coordinates.length - 1) / 2)];
    else if (g.type === 'Polygon') {
      const ring = g.coordinates[0].length > 1 ? g.coordinates[0].slice(0, -1) : g.coordinates[0];
      at = [ring.reduce(function (s, c) { return s + c[0]; }, 0) / ring.length, ring.reduce(function (s, c) { return s + c[1]; }, 0) / ring.length];
    }
    const prio = p.kind === 'symbol' || p.kind === 'track' ? 3 : p.kind === 'decision-point' ? 2.5 : 2;
    return at ? { at: at, prio: prio, point: g.type === 'Point' } : undefined;
  }

  function labelText(p) { return p.state === 'lost' ? p.name + ' (lost)' : p.name; }

  /** A label's width in pixels, estimated the same way everywhere (no layout pass needed, so the placement is the same in every window). */
  function labelWidth(text, size) { return Math.ceil(String(text).length * size * 0.64) + 2; }

  /** Whether a feature is one of the highlighted names: its name, its ECOA or its ECOA role, in any case. */
  function highlighted(feature, names) {
    if (!names || !names.length) return false;
    const p = feature.properties;
    const wanted = names.map(function (name) { return String(name).toLowerCase(); });
    return [p.name, p.ecoa, p.ecoaRole].some(function (value) { return value !== undefined && wanted.indexOf(String(value).toLowerCase()) >= 0; });
  }

  /** What is drawn at time t (same rule as src/domain/staff/cop/picture.ts visibleFeatures; a test holds them together). */
  function visibleFeatures(features, t, mode) {
    const shown = features.filter(function (feature) {
      const p = feature.properties;
      if (mode === 'valid') return (p.vf === undefined || p.vf <= t) && (p.vt === undefined || t < p.vt);
      return (p.ka === undefined || p.ka <= t) && (p.sup === undefined || t < p.sup);
    });
    const latest = new Map();
    const out = [];
    for (const feature of shown) {
      const p = feature.properties;
      if (p.track === undefined) { out.push(feature); continue; }
      const key = p.layer + '|' + p.track;
      const at = function (candidate) { return (mode === 'valid' ? candidate.properties.vf : candidate.properties.ka) || 0; };
      const known = latest.get(key);
      if (!known || at(feature) > at(known) || (at(feature) === at(known) && feature.id > known.id)) latest.set(key, feature);
    }
    return out.concat(Array.from(latest.values()).sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attributes) {
    const node = document.createElementNS(SVGNS, tag);
    for (const key of Object.keys(attributes || {})) node.setAttribute(key, String(attributes[key]));
    return node;
  }

  function loadScript(url, nonce) {
    return new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.nonce = nonce;
      script.src = url;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('could not load ' + url)); };
      document.head.appendChild(script);
    });
  }

  function hasWebGl() {
    try {
      const canvas = document.createElement('canvas');
      return Boolean(canvas.getContext && (canvas.getContext('webgl2') || canvas.getContext('webgl')));
    } catch (error) { return false; }
  }

  // ---- Shared state and chrome ------------------------------------------------------------------------------------------------------------

  function createChrome(container, state, view) {
    const root = el('div', 'cop-map');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Common operational picture');
    const bar = el('div', 'cop-map-bar');
    const marking = el('span', 'cop-map-marking');
    const projection = el('button', 'cop-map-button', 'Globe');
    projection.type = 'button';
    projection.setAttribute('aria-pressed', 'false');
    const mode = el('button', 'cop-map-button', 'As happened');
    mode.type = 'button';
    mode.title = 'Switch between what was true at the time and what the staff knew at the time';
    const ecoa = el('select', 'cop-map-select');
    ecoa.setAttribute('aria-label', 'Adversary course of action overlay');
    const budget = el('span', 'cop-map-budget');
    const sim = el('span', 'cop-map-sim', 'SIM');
    sim.hidden = true;
    sim.title = 'Simulated exercise data feeds at least one shown layer';
    const layers = el('div', 'cop-map-layers');
    bar.appendChild(marking); bar.appendChild(projection); bar.appendChild(mode); bar.appendChild(ecoa); bar.appendChild(sim); bar.appendChild(budget);
    const canvas = el('div', 'cop-map-canvas');
    const slider = el('div', 'cop-map-time');
    const range = el('input', 'cop-map-range');
    range.type = 'range';
    range.min = '0'; range.max = '1000'; range.step = '1';
    range.setAttribute('aria-label', 'Time');
    const timeText = el('output', 'cop-map-time-text');
    slider.appendChild(range); slider.appendChild(timeText);
    const card = el('div', 'cop-map-card');
    card.setAttribute('aria-live', 'polite');
    card.hidden = true;
    const notice = el('div', 'cop-map-notice');
    notice.hidden = true;
    root.appendChild(bar); root.appendChild(layers); root.appendChild(canvas); root.appendChild(slider); root.appendChild(card); root.appendChild(notice);
    container.appendChild(root);

    projection.addEventListener('click', function () { view.setProjection(state.projection === 'globe' ? 'map' : 'globe'); });
    mode.addEventListener('click', function () { view.setMode(state.mode === 'valid' ? 'known' : 'valid'); });
    ecoa.addEventListener('change', function () { view.setEcoa(ecoa.value || undefined); });
    range.addEventListener('input', function () {
      const span = state.picture && state.picture.time;
      if (!span) return;
      const t = span.min + (Number(range.value) / 1000) * (span.max - span.min);
      if (state.clock && state.clock.set) state.clock.set(t); else view.setTime(t);
    });

    return {
      root: root, canvas: canvas, card: card,
      render: function () {
        const picture = state.picture;
        marking.textContent = picture ? picture.marking : '';
        projection.textContent = state.projection === 'globe' ? 'Map' : 'Globe';
        projection.setAttribute('aria-pressed', state.projection === 'globe' ? 'true' : 'false');
        projection.disabled = view.renderer !== 'maplibre';
        if (view.renderer !== 'maplibre') projection.title = 'The globe needs the MapLibre map: ' + (view.reason || 'not loaded');
        mode.textContent = state.mode === 'valid' ? 'As happened' : 'As known';
        while (ecoa.firstChild) ecoa.removeChild(ecoa.firstChild);
        const none = el('option', '', 'Current assessment only');
        none.value = '';
        ecoa.appendChild(none);
        for (const entry of (picture && picture.ecoas) || []) {
          const option = el('option', '', entry.id + (entry.role ? ' (' + entry.role + ')' : ''));
          option.value = entry.id;
          if (state.ecoa === entry.id) option.selected = true;
          ecoa.appendChild(option);
        }
        ecoa.hidden = !(picture && picture.ecoas.length);
        const b = picture && picture.budget;
        budget.textContent = b ? 'Tracks ' + b.shown.toLocaleString('en-US') + ' / ' + b.limit.toLocaleString('en-US') + (b.note ? ' (cut)' : '') : '';
        budget.title = b && b.note ? b.note : 'At most ' + (b ? b.limit : 0) + ' tracks are drawn at once';
        sim.hidden = !(picture && picture.layers.some(function (layer) { return layer.simulated && state.visible[layer.id]; }));
        while (layers.firstChild) layers.removeChild(layers.firstChild);
        for (const layer of (picture && picture.layers) || []) {
          if (layer.kind === 'feed' && !layer.count) continue;
          const label = el('label', 'cop-map-layer' + (layer.separate ? ' cop-map-layer-separate' : ''));
          const box = el('input');
          box.type = 'checkbox';
          box.checked = Boolean(state.visible[layer.id]);
          box.addEventListener('change', function () { view.setLayerVisible(layer.id, box.checked); });
          label.appendChild(box);
          label.appendChild(el('span', '', layer.title + ' (' + layer.count + ')' + (layer.simulated ? ' SIM' : '')));
          label.title = (layer.owner ? 'By ' + layer.owner + '. ' : '') + layer.label + (layer.note ? '. ' + layer.note : '');
          layers.appendChild(label);
        }
        const span = picture && picture.time;
        slider.hidden = !span;
        if (span) {
          range.value = String(Math.round(span.max > span.min ? ((state.time - span.min) / (span.max - span.min)) * 1000 : 1000));
          timeText.textContent = new Date(state.time).toISOString().replace('.000Z', 'Z') + (state.mode === 'known' ? ' (as known)' : '');
        }
      },
      showCard: function (feature) {
        while (card.firstChild) card.removeChild(card.firstChild);
        card.hidden = !feature;
        if (!feature) return;
        card.appendChild(el('strong', '', feature.properties.name));
        for (const line of feature.properties.card || []) card.appendChild(el('div', '', line));
      },
      notice: function (text) { notice.hidden = !text; notice.textContent = text || ''; }
    };
  }

  function drawn(state) {
    const picture = state.picture;
    if (!picture) return [];
    const at = visibleFeatures(picture.features, state.time, state.mode);
    return at.filter(function (feature) {
      const p = feature.properties;
      if (!state.visible[p.layer]) return false;
      return p.ecoa === undefined || p.ecoa === state.ecoa;
    });
  }

  // ---- Symbols ----------------------------------------------------------------------------------------------------------------------------

  function symbolOptions(p) {
    // The standard light fills by affiliation (UX 5.10), also for civilian entities, which milsymbol would otherwise fill purple.
    // The name is a separate label (see Labels above), so a symbol image carries no text and labels can move out of each other's way.
    const options = { size: 28, civilianColor: false };
    if (p.state === 'stale') options.fillOpacity = 0.4;
    if (p.state === 'lost') options.fill = false;
    return options;
  }

  /** The part of the frame worth drawing: everything the picture places and every named place, with a margin; the whole frame when empty. */
  function extent(picture) {
    const frame = picture.frame ? picture.frame.bounds : [-1, -1, 1, 1];
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const take = function (c) { if (Array.isArray(c) && typeof c[0] === 'number') { box[0] = Math.min(box[0], c[0]); box[1] = Math.min(box[1], c[1]); box[2] = Math.max(box[2], c[0]); box[3] = Math.max(box[3], c[1]); } else if (Array.isArray(c)) c.forEach(take); };
    for (const feature of picture.features) take(feature.geometry.coordinates);
    for (const g of (picture.geography && picture.geography.features) || []) if (g.geometry.type === 'Point' && g.properties.name) take(g.geometry.coordinates);
    if (!(box[2] > box[0]) || !(box[3] > box[1])) return frame;
    const padX = Math.max((box[2] - box[0]) * 0.15, (frame[2] - frame[0]) * 0.03);
    const padY = Math.max((box[3] - box[1]) * 0.15, (frame[3] - frame[1]) * 0.03);
    return [Math.max(frame[0], box[0] - padX), Math.max(frame[1], box[1] - padY), Math.min(frame[2], box[2] + padX), Math.min(frame[3], box[3] + padY)];
  }

  // ---- SVG renderer (2D, no WebGL, no library needed) -------------------------------------------------------------------------------------

  function svgRenderer(chrome, state, ms) {
    const width = 1000, height = 700;
    const LABEL_SIZE = 12;
    const root = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, class: 'cop-map-svg', role: 'img', tabindex: '0' });
    const title = svg('title');
    title.textContent = 'Map of the exercise area';
    root.appendChild(title);
    chrome.canvas.appendChild(root);
    let project = function () { return [0, 0]; };
    const byId = new Map();
    const C = state.colours;

    function setup(picture) {
      const bounds = extent(picture);
      const midLat = ((bounds[1] + bounds[3]) / 2) * Math.PI / 180;
      const sx = width / ((bounds[2] - bounds[0]) * Math.cos(midLat));
      const sy = height / (bounds[3] - bounds[1]);
      const scale = Math.min(sx, sy);
      project = function (lonlat) { return [((lonlat[0] - bounds[0]) * Math.cos(midLat)) * scale, height - (lonlat[1] - bounds[1]) * scale]; };
    }

    function pathOf(coordinates, close) {
      return coordinates.map(function (c, i) { const p = project(c); return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ') + (close ? ' Z' : '');
    }

    function star(x, y, r) {
      const points = [];
      for (let i = 0; i < 10; i += 1) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const rr = i % 2 ? r / 2.5 : r; points.push((x + rr * Math.cos(a)).toFixed(1) + ',' + (y + rr * Math.sin(a)).toFixed(1)); }
      return svg('polygon', { points: points.join(' '), fill: COLOURS.star, stroke: '#000', 'stroke-width': 1 });
    }

    /** A plain frame by identity when milsymbol is not loaded: the shape carries the affiliation, so colour is never the only cue. */
    function plainFrame(x, y, sidc, anticipated) {
      const identity = sidc ? sidc[3] : '1';
      const dash = anticipated ? '4 3' : '';
      const common = { stroke: '#000', 'stroke-width': 1.5, 'stroke-dasharray': dash };
      if (identity === '3' || identity === '2') return svg('rect', Object.assign({ x: x - 12, y: y - 8, width: 24, height: 16, fill: COLOURS.friendly }, common));
      if (identity === '6' || identity === '5') return svg('polygon', Object.assign({ points: [x, y - 12, x + 12, y, x, y + 12, x - 12, y].join(' '), fill: COLOURS.hostile }, common));
      if (identity === '4') return svg('rect', Object.assign({ x: x - 10, y: y - 10, width: 20, height: 20, fill: '#aaffaa' }, common));
      return svg('circle', Object.assign({ cx: x, cy: y, r: 11, fill: '#ffff80' }, common));
    }

    function symbolNode(feature, x, y) {
      const p = feature.properties;
      if (ms && typeof DOMParser !== 'undefined' && p.sidc) {
        try {
          const symbol = new ms.Symbol(p.sidc, symbolOptions(p));
          const parsed = new DOMParser().parseFromString(symbol.asSVG(), 'image/svg+xml').documentElement;
          const anchor = symbol.getAnchor();
          const size = symbol.getSize();
          const group = svg('g', { transform: 'translate(' + (x - anchor.x).toFixed(1) + ' ' + (y - anchor.y).toFixed(1) + ')' });
          parsed.setAttribute('width', String(size.width)); parsed.setAttribute('height', String(size.height));
          group.appendChild(document.importNode(parsed, true));
          return group;
        } catch (error) { /* fall through to the plain frame */ }
      }
      const group = svg('g');
      group.appendChild(plainFrame(x, y, p.sidc, p.anticipated));
      return group;
    }

    /** Labels for the drawn features and the place names, decluttered so none covers another or a symbol. */
    function drawLabels(features, places) {
      const labels = [];
      const obstacles = [];
      for (const feature of features) {
        const anchor = labelAnchor(feature);
        if (!anchor || !feature.properties.name) continue;
        const xy = project(anchor.at);
        const text = labelText(feature.properties);
        const symbolic = anchor.point && (feature.properties.kind === 'symbol' || feature.properties.kind === 'track' || feature.properties.kind === 'decision-point');
        if (symbolic) obstacles.push({ x: xy[0] - 14, y: xy[1] - 14, w: 28, h: 28, owner: feature.id });
        labels.push({ id: feature.id, x: xy[0], y: xy[1], w: labelWidth(text, LABEL_SIZE), h: LABEL_SIZE * 1.4, gap: symbolic ? 16 : 6, prio: anchor.prio, text: text, size: LABEL_SIZE, rings: symbolic ? 1 : 2 });
      }
      places.forEach(function (place, index) {
        const xy = project(place.geometry.coordinates);
        labels.push({ id: '~place/' + index, x: xy[0], y: xy[1], w: labelWidth(place.properties.name, LABEL_SIZE), h: LABEL_SIZE * 1.4, gap: 6, prio: 2.2, text: place.properties.name, size: LABEL_SIZE, rings: 3 });
      });
      const placed = declutter(labels, obstacles);
      const layer = svg('g', { class: 'cop-map-labels' });
      for (const label of labels) {
        const at = placed[label.id];
        const node = byId.get(label.id);
        if (at.hidden) { if (node) node.setAttribute('data-label', 'hidden'); continue; }
        const text = svg('text', { x: at.x.toFixed(1), y: at.y.toFixed(1), 'text-anchor': at.anchor, class: label.id.indexOf('~place/') === 0 ? 'cop-map-svg-place' : 'cop-map-svg-text', 'data-for': label.id, fill: C.label, stroke: C.halo });
        text.textContent = at.text;
        layer.appendChild(text);
      }
      root.appendChild(layer);
      return placed;
    }

    function markHighlight() {
      byId.forEach(function (node, id) {
        const feature = state.picture && state.picture.features.find(function (candidate) { return candidate.id === id; });
        node.setAttribute('class', 'cop-map-feature' + (feature && highlighted(feature, state.highlight) ? ' cop-map-hilite' : ''));
      });
    }

    const renderer = {
      kind: 'svg',
      lastLabels: undefined,
      draw: function () {
        while (root.childNodes.length > 1) root.removeChild(root.lastChild);
        byId.clear();
        const picture = state.picture;
        if (!picture) return;
        setup(picture);
        root.appendChild(svg('rect', { x: 0, y: 0, width: width, height: height, fill: C.ocean }));
        const places = [];
        for (const g of (picture.geography && picture.geography.features) || []) {
          const k = g.properties.kind;
          if (g.geometry.type === 'Polygon') root.appendChild(svg('path', { d: pathOf(g.geometry.coordinates[0], true), fill: k === 'marsh' ? C.marsh : C.land, stroke: 'none' }));
          else if (g.geometry.type === 'LineString') root.appendChild(svg('path', { d: pathOf(g.geometry.coordinates, false), fill: 'none', stroke: C[k] || C.line, 'stroke-width': k === 'contour' ? 0.8 : 2 }));
          else if (g.geometry.type === 'Point' && g.properties.name) places.push(g);
        }
        const features = drawn(state);
        for (const feature of features) {
          const p = feature.properties;
          let node;
          if (feature.geometry.type === 'Point') {
            const xy = project(feature.geometry.coordinates);
            node = p.kind === 'decision-point' ? star(xy[0], xy[1], 10) : p.kind === 'symbol' || p.kind === 'track' ? symbolNode(feature, xy[0], xy[1]) : svg('circle', { cx: xy[0], cy: xy[1], r: 5, fill: 'none', stroke: C.line, 'stroke-width': 2 });
          } else {
            const area = feature.geometry.type === 'Polygon';
            node = svg('path', {
              d: pathOf(area ? feature.geometry.coordinates[0] : feature.geometry.coordinates, area), fill: 'none',
              stroke: ADVERSARY_KINDS[p.kind] ? COLOURS.adversary : C.line, 'stroke-width': p.kind === 'axis-main' ? 4 : 2,
              'stroke-dasharray': p.anticipated || ADVERSARY_KINDS[p.kind] || p.kind === 'nai' ? '8 5' : ''
            });
          }
          node.setAttribute('data-id', feature.id);
          node.setAttribute('class', 'cop-map-feature');
          const label = svg('title');
          label.textContent = labelText(p);
          node.appendChild(label);
          node.addEventListener('click', function () { state.select(feature.id); });
          byId.set(feature.id, node);
          root.appendChild(node);
        }
        renderer.lastLabels = drawLabels(features, places);
        markHighlight();
      },
      highlight: markHighlight,
      setColours: function () { renderer.draw(); },
      focus: function () { if (typeof root.focus === 'function') root.focus(); },
      setProjection: function () { return false; },
      destroy: function () { if (root.parentNode) root.parentNode.removeChild(root); }
    };
    return renderer;
  }

  // ---- MapLibre renderer (2D and globe, WebGL) --------------------------------------------------------------------------------------------

  async function loadMapLibre(options) {
    const injected = options.libraries || {};
    if (injected.maplibregl) return injected.maplibregl;
    // A dynamic import from this nonced script carries the nonce, so script-src needs no extension source; the worker is the vendored file fetched
    // from the extension (connect-src) and started from a blob (worker-src blob:), because a webview cannot start a worker from another origin.
    const module = await import(options.resources.maplibre);
    const text = await (await fetch(options.resources.worker)).text();
    module.setWorkerUrl(URL.createObjectURL(new Blob([text], { type: 'text/javascript' })));
    return module;
  }

  async function loadMilsymbol(options) {
    const injected = options.libraries || {};
    if (injected.ms) return injected.ms;
    if (window.ms) return window.ms;
    if (!options.resources || !options.resources.milsymbol) return undefined;
    await loadScript(options.resources.milsymbol, options.nonce);
    return window.ms;
  }

  function mapLibreRenderer(chrome, state, maplibregl, ms, options) {
    const empty = { type: 'FeatureCollection', features: [] };
    const C = state.colours;
    const none = ['literal', ['']];
    const textPaint = function () { return { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.5 }; };
    const map = new maplibregl.Map({
      container: chrome.canvas, attributionControl: false, renderWorldCopies: false, maxPitch: 0, fadeDuration: options.still ? 0 : 300,
      style: {
        version: 8, projection: { type: state.projection === 'globe' ? 'globe' : 'mercator' },
        sources: { ground: { type: 'geojson', data: empty }, cop: { type: 'geojson', data: empty } },
        layers: [
          { id: 'ocean', type: 'background', paint: { 'background-color': C.ocean } },
          { id: 'land', type: 'fill', source: 'ground', filter: ['==', ['get', 'kind'], 'land'], paint: { 'fill-color': C.land } },
          { id: 'marsh', type: 'fill', source: 'ground', filter: ['==', ['get', 'kind'], 'marsh'], paint: { 'fill-color': C.marsh } },
          { id: 'ground-lines', type: 'line', source: 'ground', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': ['match', ['get', 'kind'], 'river', C.river, 'road', C.road, C.contour], 'line-width': ['match', ['get', 'kind'], 'contour', 0.8, 2] } },
          { id: 'hilite-lines', type: 'line', source: 'cop', filter: ['in', ['get', 'fid'], none], paint: { 'line-color': COLOURS.star, 'line-width': 7, 'line-opacity': 0.55 } },
          { id: 'areas', type: 'line', source: 'cop', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': ['case', ['==', ['get', 'kind'], 'nai'], COLOURS.adversary, C.line], 'line-width': 2, 'line-dasharray': [3, 2] } },
          { id: 'lines', type: 'line', source: 'cop', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['!', ['to-boolean', ['get', 'anticipated']]], ['!=', ['get', 'kind'], 'axis-adversary']], paint: { 'line-color': C.line, 'line-width': ['case', ['==', ['get', 'kind'], 'axis-main'], 4, 2] } },
          { id: 'lines-dashed', type: 'line', source: 'cop', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['any', ['to-boolean', ['get', 'anticipated']], ['==', ['get', 'kind'], 'axis-adversary']]], paint: { 'line-color': ['case', ['==', ['get', 'kind'], 'axis-adversary'], COLOURS.adversary, C.line], 'line-width': 2, 'line-dasharray': [4, 3] } },
          { id: 'hilite-points', type: 'circle', source: 'cop', filter: ['all', ['==', ['geometry-type'], 'Point'], ['in', ['get', 'fid'], none]], paint: { 'circle-radius': 20, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': COLOURS.star, 'circle-stroke-width': 3 } },
          // Labels, lowest priority first: MapLibre places the layers on top first, so symbols win a crowded spot, then place names, then control measures.
          { id: 'area-labels', type: 'symbol', source: 'cop', filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['has', 'name']], layout: { 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 11, 'text-allow-overlap': false, 'text-padding': 3 }, paint: textPaint() },
          { id: 'line-labels', type: 'symbol', source: 'cop', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['has', 'name']], layout: { 'symbol-placement': 'line-center', 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 11, 'text-allow-overlap': false, 'text-padding': 3, 'text-max-angle': 35 }, paint: textPaint() },
          { id: 'place-labels', type: 'symbol', source: 'ground', filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'name']], layout: { 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 11, 'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.5, 'text-allow-overlap': false, 'text-padding': 3 }, paint: textPaint() },
          // A name tries eight places around its symbol and is dropped when none is free; the symbols (the layer above) are placed first, so a name
          // never covers a symbol, its own or another's.
          {
            id: 'point-labels', type: 'symbol', source: 'cop', filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'text']],
            layout: {
              'symbol-sort-key': ['get', 'order'], 'text-field': ['get', 'text'], 'text-font': LABEL_FONT, 'text-size': 12,
              'text-variable-anchor': ['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'], 'text-radial-offset': 2.1,
              'text-justify': 'auto', 'text-allow-overlap': false, 'text-ignore-placement': false, 'text-optional': true, 'text-padding': 3
            },
            paint: textPaint()
          },
          {
            id: 'points', type: 'symbol', source: 'cop', filter: ['==', ['geometry-type'], 'Point'],
            layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': false, 'icon-padding': 1, 'symbol-sort-key': ['get', 'order'] }
          }
        ]
      }
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: false }), 'top-right');

    function iconFor(p) {
      if (p.kind === 'decision-point') return 'dp-star';
      if (!p.sidc) return 'point';
      return 'sym|' + p.sidc + '|' + (p.state || 'live');
    }

    map.on('styleimagemissing', function (event) {
      const id = event.id;
      if (map.hasImage(id)) return;
      const canvas = document.createElement('canvas');
      if (id === 'dp-star' || id === 'point' || !ms) {
        canvas.width = 24; canvas.height = 24;
        const c = canvas.getContext('2d');
        c.beginPath();
        for (let i = 0; i < 10; i += 1) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const r = id === 'dp-star' ? (i % 2 ? 4.4 : 11) : 6; c.lineTo(12 + r * Math.cos(a), 12 + r * Math.sin(a)); }
        c.closePath(); c.fillStyle = id === 'dp-star' ? COLOURS.star : COLOURS.line; c.fill(); c.strokeStyle = '#000'; c.stroke();
        map.addImage(id, c.getImageData(0, 0, 24, 24));
        return;
      }
      const parts = id.split('|');
      const symbol = new ms.Symbol(parts[1], symbolOptions({ state: parts[2] }));
      const drawnCanvas = symbol.asCanvas(window.devicePixelRatio || 1);
      map.addImage(id, drawnCanvas.getContext('2d').getImageData(0, 0, drawnCanvas.width, drawnCanvas.height), { pixelRatio: window.devicePixelRatio || 1 });
    });

    map.on('click', function (event) {
      const hits = map.queryRenderedFeatures(event.point, { layers: ['points', 'lines', 'lines-dashed', 'areas'] });
      state.select(hits.length ? hits[0].properties.fid : undefined);
    });

    const ready = new Promise(function (resolve) { map.once('load', resolve); });
    let framed = false;
    let shown = [];

    function markHighlight() {
      ready.then(function () {
        const ids = shown.filter(function (feature) { return highlighted(feature, state.highlight); }).map(function (feature) { return feature.id; });
        const list = ['literal', ids.length ? ids : ['']];
        map.setFilter('hilite-lines', ['in', ['get', 'fid'], list]);
        map.setFilter('hilite-points', ['all', ['==', ['geometry-type'], 'Point'], ['in', ['get', 'fid'], list]]);
      });
    }

    const renderer = {
      kind: 'maplibre', map: map, ready: ready,
      draw: function () {
        ready.then(function () {
          const picture = state.picture;
          if (!picture) return;
          map.getSource('ground').setData(picture.geography || empty);
          shown = drawn(state);
          const features = shown.map(function (feature) {
            const p = feature.properties;
            const anchor = labelAnchor(feature);
            return { type: 'Feature', geometry: feature.geometry, properties: Object.assign({}, p, { fid: feature.id, icon: iconFor(p), text: labelText(p), order: anchor ? 10 - anchor.prio : 10, card: undefined }) };
          });
          map.getSource('cop').setData({ type: 'FeatureCollection', features: features });
          markHighlight();
          if (!framed && picture.frame) {
            framed = true;
            const b = extent(picture);
            map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 24, animate: false });
          }
        });
      },
      highlight: markHighlight,
      setColours: function () {
        ready.then(function () {
          map.setPaintProperty('ocean', 'background-color', C.ocean);
          map.setPaintProperty('land', 'fill-color', C.land);
          map.setPaintProperty('marsh', 'fill-color', C.marsh);
          map.setPaintProperty('ground-lines', 'line-color', ['match', ['get', 'kind'], 'river', C.river, 'road', C.road, C.contour]);
          map.setPaintProperty('lines', 'line-color', C.line);
          for (const id of ['place-labels', 'area-labels', 'line-labels', 'point-labels']) { map.setPaintProperty(id, 'text-color', C.label); map.setPaintProperty(id, 'text-halo-color', C.halo); }
        });
      },
      focus: function () { const canvas = map.getCanvas && map.getCanvas(); if (canvas && typeof canvas.focus === 'function') canvas.focus(); },
      setProjection: function (projection) {
        ready.then(function () { map.setProjection({ type: projection === 'globe' ? 'globe' : 'mercator' }); });
        return true;
      },
      destroy: function () { map.remove(); }
    };
    return renderer;
  }

  /** The theme colours a host page may set: only these keys, only colour words or hex, so a page cannot pass anything else into a style. */
  function themeColours(colours) {
    const out = {};
    for (const key of ['ocean', 'land', 'marsh', 'contour', 'river', 'road', 'line', 'label', 'halo']) {
      const value = colours && colours[key];
      if (typeof value === 'string' && /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9., %]+\)|[a-z]+)$/.test(value.trim())) out[key] = value.trim();
    }
    return out;
  }

  // ---- Mount ------------------------------------------------------------------------------------------------------------------------------

  async function mount(container, options) {
    options = options || {};
    const state = {
      picture: undefined, time: options.clock ? options.clock.now() : Date.now(), mode: options.mode === 'known' ? 'known' : 'valid',
      projection: options.projection === 'globe' ? 'globe' : 'map', ecoa: undefined, visible: {}, selected: undefined, clock: options.clock,
      colours: Object.assign({}, COLOURS, themeColours(options.colours)), highlight: []
    };
    const view = { renderer: 'svg', reason: undefined };
    const chrome = createChrome(container, state, view);
    let renderer;
    let ms;
    try { ms = await loadMilsymbol(options); } catch (error) { ms = undefined; }
    const wanted = options.renderer || 'auto';
    if (wanted !== 'svg') {
      if (!hasWebGl() && !(options.libraries && options.libraries.maplibregl)) {
        view.reason = 'WebGL is not available in this window';
      } else {
        try {
          const maplibregl = await loadMapLibre(options);
          renderer = mapLibreRenderer(chrome, state, maplibregl, ms, options);
          view.renderer = 'maplibre';
        } catch (error) {
          view.reason = 'the map library could not start (' + (error && error.message ? error.message : String(error)) + ')';
        }
      }
    }
    if (!renderer) {
      renderer = svgRenderer(chrome, state, ms);
      view.renderer = 'svg';
      if (wanted === 'svg') view.reason = 'the SVG map was asked for';
      if (view.reason && wanted !== 'svg') chrome.notice('Showing the 2D SVG map: ' + view.reason + '.');
    }

    let pending;
    let last = 0;
    function redraw() {
      const wait = Math.max(0, 1000 / MAX_REDRAWS_PER_SECOND - (Date.now() - last));
      if (pending) return;
      pending = setTimeout(function () { pending = undefined; last = Date.now(); chrome.render(); renderer.draw(); }, wait);
    }

    state.select = function (id) {
      state.selected = id;
      const feature = id && state.picture ? state.picture.features.find(function (candidate) { return candidate.id === id; }) : undefined;
      chrome.showCard(feature);
      if (options.onSelect) options.onSelect(feature);
    };

    view.setPicture = function (picture) {
      if (!picture || picture.version !== 1) throw new Error('nearCopMap: a picture of version 1 is required.');
      const first = !state.picture;
      state.picture = picture;
      for (const layer of picture.layers) if (!(layer.id in state.visible) || first) state.visible[layer.id] = layer.visible;
      if (state.ecoa && !picture.ecoas.some(function (entry) { return entry.id === state.ecoa; })) state.ecoa = undefined;
      redraw();
    };
    view.setTime = function (t) { if (typeof t === 'number' && isFinite(t)) { state.time = t; redraw(); } };
    view.setMode = function (mode) { state.mode = mode === 'known' ? 'known' : 'valid'; redraw(); };
    view.setProjection = function (projection) {
      const accepted = renderer.setProjection(projection === 'globe' ? 'globe' : 'map');
      if (accepted) state.projection = projection === 'globe' ? 'globe' : 'map';
      chrome.render();
      return accepted;
    };
    view.setLayerVisible = function (id, on) { state.visible[id] = Boolean(on); redraw(); };
    view.setEcoa = function (id) { state.ecoa = id || undefined; redraw(); };
    view.select = function (id) { state.select(id); };
    view.highlight = function (names) { state.highlight = Array.isArray(names) ? names.map(String) : []; renderer.highlight(); };
    view.setColours = function (colours) { Object.assign(state.colours, themeColours(colours)); renderer.setColours(); };
    view.focus = function () { renderer.focus(); };
    let unsubscribe;
    view.destroy = function () {
      if (pending) clearTimeout(pending);
      if (unsubscribe) unsubscribe();
      renderer.destroy();
      if (chrome.root.parentNode) chrome.root.parentNode.removeChild(chrome.root);
    };
    view.state = function () { return { time: state.time, mode: state.mode, projection: state.projection, ecoa: state.ecoa, visible: Object.assign({}, state.visible), drawn: drawn(state).map(function (feature) { return feature.id; }), labels: renderer.lastLabels }; };
    if (options.clock && options.clock.subscribe) unsubscribe = options.clock.subscribe(function (t) { view.setTime(t); });
    // Never wait forever for the map: after 15 seconds the view is returned and the map finishes loading behind it. When the map is ready first, the
    // 15-second timer is cleared, so nothing is left pending after the view is returned (or destroyed).
    if (renderer.kind === 'maplibre') {
      let giveUp;
      const timeout = new Promise(function (resolve) { giveUp = setTimeout(resolve, 15000); });
      try { await Promise.race([renderer.ready, timeout]); } finally { clearTimeout(giveUp); }
    }
    chrome.render();
    return view;
  }

  window.nearCopMap = { version: 1, mount: mount, visibleFeatures: visibleFeatures, declutter: declutter };
})();
