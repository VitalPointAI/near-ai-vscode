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
//   view.setColours(colours) / view.focus()        // the host page's theme (ocean, land, marsh, contour, river, road, line, label, halo, hillShadow,
//                                                  // hillLight, relief, space); focus the map
//   view.addTool(node) / view.fitFrame() / view.layers(open?)   // a host control over the map; back to the first view; open or close the layer drawer
//
// Mount options also take `colours` (the same keys as setColours), `still: true`, which turns off MapLibre's label fades (the Staff Room's Calm and
// reduced motion), `motion()`, the host's rule for whether anything may move (the drawer's slide, the globe's flight), and `onLayer(id, on)`, told when
// the person turns a layer on or off in the drawer.
//
// Layout (owner direction, D-48 of 0.4.34). The map fills the box and everything floats over it: the classification strip, the controls, the layer
// drawer (media/staff/layerDrawer.js, shared with the Staff Room's SVG map) and the time slider. The first view fits what is on the map (the land,
// the named places and the units, contentBounds) with a margin, inside the exercise frame, whose dashed line stays drawn; at that view units that would
// cover each other draw as one stacked symbol with a count, and symbols are smaller until the map is zoomed in. Globe flies out until the curve of the
// earth is plain, with the frame ringed in gold and a graticule; Map flies back to the same first view.
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
//
// Terrain and weather (WP-ENV). When the picture carries an environment pack (picture.environment, src/domain/staff/cop/environment.ts), the map
// draws its hillshade and contours over the land and its weather on top of the ground, each a layer the person toggles like any other (env-hillshade,
// env-contours, env-weather). The shared clock picks the weather frame with weatherFrameAt (the host's rule in src/domain/staff/env/weather.ts; a test
// holds the two together), and a line under the map says which forecast is shown, its run and lead time, or that there is none for this time, with
// the pack's attribution whenever one of its layers is on. All of it is GeoJSON the host sent: no raster, terrain tile or image is fetched.
(function () {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const MAX_REDRAWS_PER_SECOND = 10;
  const COLOURS = {
    ocean: '#0e2a47', land: '#3d4a3a', marsh: '#4f6152', contour: '#8a9a7b', river: '#5aa0d8', road: '#c9b26b', friendly: '#80e0ff', hostile: '#ff8080', line: '#e8e8e8',
    adversary: '#ff8080', star: '#ffd23f', label: '#ffffff', halo: '#000000', hillShadow: '#000000', hillLight: '#ffffff', relief: '#a3b48f', space: '#050b16'
  };
  /** How much stronger than the pack's own tones the hillshade is drawn, so the ground reads at the frame view in every theme (D-48 of 0.4.34). */
  const RELIEF = 1.8;
  /** Units closer than this many pixels are drawn as one stacked symbol with a count until the map is zoomed in past CLUSTER_MAX_ZOOM. */
  const CLUSTER_RADIUS = 30;
  const CLUSTER_MAX_ZOOM = 11;
  /** Below this zoom (the globe) units are not drawn; the frame's ring marks where they are. */
  const UNITS_MIN_ZOOM = 5;
  const THEME_KEYS = ['ocean', 'land', 'marsh', 'contour', 'river', 'road', 'line', 'label', 'halo', 'hillShadow', 'hillLight', 'relief', 'space'];
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

  // ---- Terrain and weather (WP-ENV) ------------------------------------------------------------------------------------------------------

  const ENV_LAYER_IDS = { hillshade: 'env-hillshade', contours: 'env-contours', weather: 'env-weather' };
  const WEATHER_COLOURS = { fog: '#d8d8d8', rain: '#4fa3ff', 'rough-sea': '#ff9f40', wind: '#f4f4f4' };

  /** The weather frame at time t (same rule as src/domain/staff/env/weather.ts weatherFrameAt; a test holds them together). */
  function weatherFrameAt(layer, t, mode) {
    if (!layer || !Array.isArray(layer.frames)) return undefined;
    if (mode === 'known' && t < layer.runAt) return undefined;
    return layer.frames.find(function (frame) { return frame.validFrom <= t && t < frame.validTo; });
  }

  /** A weather frame's shapes: a cell square for each marked cell, and an arrow downwind from each grid point, longer for stronger wind. */
  function weatherFeatures(layer, frame) {
    if (!layer || !frame) return [];
    const b = layer.bounds;
    const clampLon = function (v) { return Math.min(b[2], Math.max(b[0], v)); };
    const clampLat = function (v) { return Math.min(b[3], Math.max(b[1], v)); };
    const cosLat = Math.cos(((b[1] + b[3]) / 2) * Math.PI / 180);
    const out = [];
    for (const entry of frame.cells || []) {
      const at = layer.points[entry[0]];
      if (!at) continue;
      const w = clampLon(at[0] - layer.cell[0] / 2), e = clampLon(at[0] + layer.cell[0] / 2), s = clampLat(at[1] - layer.cell[1] / 2), n = clampLat(at[1] + layer.cell[1] / 2);
      out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }, properties: { kind: entry[1], opacity: entry[2] } });
    }
    const wind = frame.wind || [];
    for (let i = 0; i < layer.points.length && 2 * i + 1 < wind.length; i += 1) {
      const at = layer.points[i];
      const speed = wind[2 * i];
      const to = ((wind[2 * i + 1] + 180) % 360) * Math.PI / 180;
      const length = Math.min(1, Math.max(0.15, speed / 20)) * 0.4 * layer.cell[1];
      const dx = Math.sin(to) * length / cosLat, dy = Math.cos(to) * length;
      const tip = [clampLon(at[0] + dx / 2), clampLat(at[1] + dy / 2)];
      const wing = function (turn) { const a = to + Math.PI + turn; return [clampLon(tip[0] + Math.sin(a) * length * 0.35 / cosLat), clampLat(tip[1] + Math.cos(a) * length * 0.35)]; };
      out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[clampLon(at[0] - dx / 2), clampLat(at[1] - dy / 2)], tip, wing(0.5), tip, wing(-0.5)] }, properties: { kind: 'wind', speed: speed } });
    }
    return out;
  }

  /** What the environment layers draw now: the terrain features of the visible layers, the weather frame at the clock, and the words under the map. */
  function environmentNow(state) {
    const env = state.picture && state.picture.environment;
    const credits = baseCredits(state);
    if (!env) return { terrain: [], weather: [], line: credits.join(' ') };
    const terrain = [];
    // Over Imagery and Topographic with height tiles, the hillshade is MapLibre's own (from the relief heights); the pack's shaded shapes are for Plain.
    if (state.visible[ENV_LAYER_IDS.hillshade] && !state.rasterHillshade) terrain.push.apply(terrain, (env.hillshade && env.hillshade.features) || []);
    if (state.visible[ENV_LAYER_IDS.contours]) terrain.push.apply(terrain, (env.contours && env.contours.features) || []);
    let weather = [];
    const words = [];
    if (env.weather && state.visible[ENV_LAYER_IDS.weather]) {
      const frame = weatherFrameAt(env.weather, state.time, state.mode);
      weather = weatherFeatures(env.weather, frame);
      if (frame) words.push(frame.label + (state.mode === 'known' ? ' (as known)' : '') + '.');
      else {
        const first = env.weather.frames[0], last = env.weather.frames[env.weather.frames.length - 1];
        const iso = function (ms) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z'; };
        words.push(state.mode === 'known' && state.time < env.weather.runAt ? 'No weather: the forecast was run at ' + iso(env.weather.runAt) + ', after this time.' : 'No weather for this time: the forecast covers ' + (first ? iso(first.validFrom) + ' to ' + iso(last.validTo) : 'no time') + '.');
      }
    }
    const on = [ENV_LAYER_IDS.hillshade, ENV_LAYER_IDS.contours, ENV_LAYER_IDS.weather].some(function (id) { return state.visible[id]; });
    if (on && env.pack) words.push(env.pack.title + ': ' + (env.pack.attribution || []).join(' ') + (env.pack.licence ? ' Licence: ' + env.pack.licence + '.' : ''));
    return { terrain: terrain, weather: weather, line: credits.concat(words).join(' ') };
  }

  /** The credit lines of the base on show: the world imagery's, and the frame's own words that it is synthetic. Never a logo, never an endorsement. */
  function baseCredits(state) {
    const b = state.basemap;
    if (!b || state.base === 'plain') return [];
    const out = [];
    if (state.base === 'imagery') {
      if (b.globe.imagery && b.credit.imagery) out.push('Blue Marble: ' + b.credit.imagery + '.');
      if (b.frame.imagery) out.push(b.synthetic ? 'Synthetic imagery and terrain generated from a seed: not a real place.' : 'Imagery and terrain from the terrain pack.');
    } else if (state.base === 'topo') {
      if (b.globe.topo && b.credit.topo) out.push(b.credit.topo + '.');
      if (b.frame.relief) out.push(b.synthetic ? 'Synthetic terrain and land cover generated from a seed: not a real place.' : 'Terrain from the terrain pack.');
    }
    return out;
  }

  // ---- Base maps, 3D terrain, the grid and the margin ---------------------------------------------------------------------------------------
  //
  // The map draws on one of three bases (owner direction, 0.4.35: "the map and globe would already have 3d and topographic textures... those are
  // important layers"): Imagery (the world's Blue Marble on the globe and the pack's photo-like imagery in the frame, with 3D terrain), Topographic
  // (Natural Earth on the globe; colour relief, land cover, hillshade, contours, roads and the grid in the frame) and Plain (the flat land and sea).
  // Every tile comes from the extension, after the host checked it against its index (src/staff/mapTiles.ts); nothing is fetched from a server.
  //
  // The state machine (each transition has a page test in src/test/staffCopMapPage.test.ts):
  //   base       imagery | topo | plain       Imagery needs tiles; the SVG map offers Topographic and Plain. A switch only changes which style layers
  //                                           show (sources, images and the picture's layers stay), and sets the base's hillshade and contour defaults:
  //                                           off over Imagery (its light is baked in), on over Topographic.
  //   terrain    on | off | unavailable       Unavailable without height tiles or on the SVG map. Starts on, except on a software renderer (SwiftShader,
  //                                           llvmpipe), where it starts off with the reason shown; the person can still turn it on.
  //   projection map | globe
  //   spin       off | on                     Off until the person presses Spin; only on the globe, never while motion() is false (Calm, reduced
  //                                           motion), stopped by any input on the map, and when the page is hidden.
  const BASES = ['imagery', 'topo', 'plain'];
  const BASE_TITLES = { imagery: 'Imagery', topo: 'Topographic', plain: 'Plain' };
  const EXAGGERATION = { min: 1, max: 3, step: 0.25, start: 1.5 };
  const MAP_ITEMS = { terrain: 'map-terrain', grid: 'map-grid' };
  const BASE_LAYERS = {
    imagery: ['globe-imagery', 'frame-imagery', 'frame-imagery-detail'],
    topo: ['globe-topo', 'color-relief', 'landcover-fill', 'landcover-built-edge', 'landcover-tracks', 'landcover-roads-case', 'landcover-roads'],
    plain: ['land', 'marsh']
  };
  /** A topographic map's colours: land cover tints over colour relief, red roads, brown contours, a blue grid. */
  const TOPO = {
    sea: '#a9cce3', forest: '#a6cf8a', scrub: '#d8e4b2', farmland: '#f4f0d4', beach: '#f3e3b2', rock: '#d8d1c4', 'built-up': '#d9cbbd', marsh: '#bcdcd2',
    road: '#d9553a', roadCase: '#6f2617', track: '#7d5530', contour: '#9b6a3a', grid: '#2a67a8', coast: '#3b6f96'
  };
  const RELIEF_STOPS = [-80, '#4c83b6', -40, '#6b9dc9', -15, '#8fb9da', -4, '#b0d0e7', -0.01, '#c6e0ef', 0, '#c5dca9', 30, '#d5e2ad', 80, '#e7e3a9', 150, '#e8d39a', 220, '#d8b88a', 300, '#c39f7d', 380, '#ae8d72'];
  /** The deep-ocean colour under the world imagery, so the frame's sea and the globe's meet. */
  const IMAGERY_SEA = '#0c1e3a';
  /** How far the first 3D view leans back, in degrees. */
  const FIRST_PITCH = 50;
  const SKY = { 'sky-color': '#0b1d3a', 'horizon-color': '#9cc3e6', 'fog-color': '#c9dcef', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.4, 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] };

  /** One tile source the host sent, or undefined: a {z}/{x}/{y} template with no quote, space or angle bracket, and sane zooms and bounds. */
  function tileSource(value) {
    if (!value || typeof value !== 'object') return undefined;
    const t = value.tiles;
    if (typeof t !== 'string' || t.length > 2000 || !/\{z\}/.test(t) || !/\{x\}/.test(t) || !/\{y\}/.test(t) || /["'<>\s\\]/.test(t)) return undefined;
    const zoom = function (n) { return Number.isInteger(n) && n >= 0 && n <= 22; };
    const b = value.bounds;
    if (!zoom(value.minzoom) || !zoom(value.maxzoom) || value.minzoom > value.maxzoom) return undefined;
    if (!Array.isArray(b) || b.length !== 4 || !b.every(function (n) { return typeof n === 'number' && isFinite(n); })) return undefined;
    return { tiles: t, minzoom: value.minzoom, maxzoom: value.maxzoom, bounds: [b[0], b[1], b[2], b[3]] };
  }

  /** The host's basemap (src/staff/mapTiles.ts CopBasemap), keeping only well-formed sources. */
  function validBasemap(value) {
    if (!value || typeof value !== 'object') return undefined;
    const out = { globe: {}, frame: {}, credit: { imagery: '', topo: '' }, synthetic: true, problems: [] };
    const g = value.globe || {}, f = value.frame || {};
    out.globe.imagery = tileSource(g.imagery); out.globe.topo = tileSource(g.topo);
    if (g.credit && typeof g.credit === 'object') {
      if (typeof g.credit.imagery === 'string') out.credit.imagery = g.credit.imagery.slice(0, 120);
      if (typeof g.credit.topo === 'string') out.credit.topo = g.credit.topo.slice(0, 120);
    }
    out.frame.imagery = tileSource(f.imagery); out.frame.imageryDetail = tileSource(f.imageryDetail); out.frame.terrain = tileSource(f.terrain); out.frame.relief = tileSource(f.relief);
    if (typeof f.landcover === 'string' && f.landcover.length < 2000 && !/["'<>\s\\]/.test(f.landcover) && /\.geojson$/.test(f.landcover)) out.frame.landcover = f.landcover;
    out.synthetic = f.synthetic !== false;
    if (Array.isArray(value.problems)) out.problems = value.problems.filter(function (p) { return typeof p === 'string'; }).slice(0, 4).map(function (p) { return p.slice(0, 300); });
    return out;
  }

  /** The renderer's name when WebGL is drawn in software (SwiftShader, llvmpipe and the like), else ''. */
  function softwareRenderer(options) {
    const injected = options && options.libraries && options.libraries.renderer;
    const name = typeof injected === 'string' ? injected : (function () {
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
        if (!gl) return '';
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
      } catch (error) { return ''; }
    })();
    return /swiftshader|llvmpipe|softpipe|lavapipe|software/i.test(name) ? name : '';
  }

  /**
   * The frame's grid as GeoJSON: a line every square (1 km for KQ) and every ten, each with its two-digit number. The frame is linear in latitude and
   * longitude (src/domain/staff/obs/frame.ts), so the lines are straight between the frame's edges.
   */
  function gridFeatures(frame) {
    if (!frame || !Array.isArray(frame.bounds) || !Array.isArray(frame.squares)) return [];
    const b = frame.bounds, e = Math.min(500, Math.floor(frame.squares[0])), n = Math.min(500, Math.floor(frame.squares[1]));
    if (!(e > 0) || !(n > 0)) return [];
    const out = [];
    const two = function (i) { return String(i % 100).padStart(2, '0'); };
    for (let i = 0; i <= e; i += 1) {
      const lon = b[0] + (i / e) * (b[2] - b[0]);
      out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[lon, b[1]], [lon, b[3]]] }, properties: { ten: i % 10 === 0, label: two(i), axis: 'e' } });
    }
    for (let j = 0; j <= n; j += 1) {
      const lat = b[1] + (j / n) * (b[3] - b[1]);
      out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[b[0], lat], [b[2], lat]] }, properties: { ten: j % 10 === 0, label: two(j), axis: 'n' } });
    }
    return out;
  }

  /** The words for a declination: "17° E" or "4° W". */
  function declinationWords(degrees) { return Math.abs(degrees).toFixed(Math.abs(degrees) % 1 ? 1 : 0) + '° ' + (degrees >= 0 ? 'E' : 'W'); }

  /** The declination diagram: true north (a star), grid north (GN) and magnetic north (a half arrow) at its angle, drawn in DOM SVG. */
  function declinationDiagram(degrees) {
    const box = svg('svg', { viewBox: '0 0 44 52', width: 44, height: 52, class: 'cop-map-decl', 'aria-hidden': 'true', focusable: 'false' });
    const foot = [22, 48];
    const line = function (angle, length) { const a = (angle * Math.PI) / 180; return [foot[0] + Math.sin(a) * length, foot[1] - Math.cos(a) * length]; };
    const top = line(0, 40);
    box.appendChild(svg('line', { x1: foot[0], y1: foot[1], x2: top[0], y2: top[1], class: 'decl-true' }));
    box.appendChild(svg('text', { x: top[0], y: top[1] - 1, 'text-anchor': 'middle', class: 'decl-star' })).textContent = '★';
    const mag = line(Math.max(-60, Math.min(60, degrees)), 36);
    box.appendChild(svg('line', { x1: foot[0], y1: foot[1], x2: mag[0], y2: mag[1], class: 'decl-mag' }));
    box.appendChild(svg('text', { x: mag[0] + (degrees >= 0 ? 2 : -2), y: mag[1] + 3, 'text-anchor': degrees >= 0 ? 'start' : 'end', class: 'decl-label' })).textContent = 'MN';
    box.appendChild(svg('text', { x: foot[0] - 2, y: 18, 'text-anchor': 'end', class: 'decl-label' })).textContent = 'GN';
    return box;
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
  //
  // The map has the whole box (owner direction, D-48 of 0.4.34: maximize the map's room). Everything else floats over it: a slim strip top left
  // (the classification line, SIM and the track count), compact controls top right (Layers, Globe or Map, As happened or As known, the adversary COA
  // overlay, and any tool the host adds), the layer drawer sliding in from the right edge, and the time slider with the data's attribution along the
  // bottom.

  function createChrome(container, state, view, options) {
    const root = el('div', 'cop-map');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Common operational picture');
    const canvas = el('div', 'cop-map-canvas');
    const strip = el('div', 'cop-map-strip');
    const marking = el('span', 'cop-map-marking');
    const sim = el('span', 'cop-map-sim', 'SIM');
    sim.hidden = true;
    sim.title = 'Simulated exercise data feeds at least one shown layer';
    const budget = el('span', 'cop-map-budget');
    strip.appendChild(marking); strip.appendChild(sim); strip.appendChild(budget);
    const tools = el('div', 'cop-map-tools');
    tools.setAttribute('role', 'toolbar');
    tools.setAttribute('aria-label', 'Map controls');
    const projection = el('button', 'cop-map-button cop-map-projection', 'Globe');
    projection.type = 'button';
    projection.setAttribute('aria-pressed', 'false');
    projection.title = 'Fly out to the globe, with the exercise frame ringed; Map flies back to the frame';
    const mode = el('button', 'cop-map-button', 'As happened');
    mode.type = 'button';
    mode.title = 'Switch between what was true at the time and what the staff knew at the time';
    const ecoa = el('select', 'cop-map-select');
    ecoa.setAttribute('aria-label', 'Adversary course of action overlay');
    const drawerApi = window.nearLayerDrawer;
    const drawer = drawerApi ? drawerApi.create(root, {
      motion: state.motion, title: 'Map layers', footnote: 'Each layer has one writer. Plans stay apart from the current picture.',
      onToggle: function (id, on) {
        if (id === MAP_ITEMS.terrain) { view.setTerrain(on); return; }
        if (id === MAP_ITEMS.grid) { view.setGrid(on); return; }
        view.setLayerVisible(id, on); if (options.onLayer) options.onLayer(id, on);
      },
      onChoose: function (group, id) { if (group === 'base') view.setBase(id); },
      onSlide: function (id, value) { if (id === MAP_ITEMS.terrain) view.setExaggeration(value); }
    }) : undefined;
    if (drawer) tools.appendChild(drawer.button);
    // Spin (owner decision, 0.4.35): off until pressed; the globe also spins by dragging, with momentum.
    const spin = el('button', 'cop-map-button cop-map-spin', 'Spin');
    spin.type = 'button';
    spin.setAttribute('aria-pressed', 'false');
    spin.hidden = true;
    tools.appendChild(projection); tools.appendChild(spin); tools.appendChild(mode); tools.appendChild(ecoa);
    const foot = el('div', 'cop-map-foot');
    const slider = el('div', 'cop-map-time');
    const range = el('input', 'cop-map-range');
    range.type = 'range';
    range.min = '0'; range.max = '1000'; range.step = '1';
    range.setAttribute('aria-label', 'Time');
    const timeText = el('output', 'cop-map-time-text');
    slider.appendChild(range); slider.appendChild(timeText);
    // The pack's attribution and the weather frame: one line under the slider, whole on hover or focus.
    const envLine = el('div', 'cop-map-env');
    envLine.setAttribute('aria-live', 'polite');
    envLine.setAttribute('tabindex', '0');
    envLine.hidden = true;
    foot.appendChild(slider); foot.appendChild(envLine);
    const card = el('div', 'cop-map-card');
    card.setAttribute('aria-live', 'polite');
    card.hidden = true;
    const notice = el('div', 'cop-map-notice');
    notice.hidden = true;
    // The map's margin (military map conventions): datum, grid, contour interval and the declination diagram, in DOM so it reads at any zoom.
    const margin = el('div', 'cop-map-margin');
    margin.hidden = true;
    let marginKey;
    const top = el('div', 'cop-map-top');
    top.appendChild(strip); top.appendChild(tools);
    root.appendChild(canvas); root.appendChild(top); root.appendChild(foot); root.appendChild(card); root.appendChild(notice); root.appendChild(margin);
    if (drawer) root.appendChild(drawer.panel);
    container.appendChild(root);

    projection.addEventListener('click', function () { view.setProjection(state.projection === 'globe' ? 'map' : 'globe'); });
    spin.addEventListener('click', function () { view.spin(!state.spinning); });
    mode.addEventListener('click', function () { view.setMode(state.mode === 'valid' ? 'known' : 'valid'); });
    ecoa.addEventListener('change', function () { view.setEcoa(ecoa.value || undefined); });
    range.addEventListener('input', function () {
      const span = state.picture && state.picture.time;
      if (!span) return;
      const t = span.min + (Number(range.value) / 1000) * (span.max - span.min);
      if (state.clock && state.clock.set) state.clock.set(t); else view.setTime(t);
    });

    let layerKey = '';
    let ecoaKey;
    return {
      root: root, canvas: canvas, card: card, drawer: drawer,
      addTool: function (node) { tools.appendChild(node); },
      /** How much of the box the floating chrome covers at the top and the bottom, so a fitted view keeps the frame clear of it. */
      insets: function () { return { top: top.offsetHeight || 0, bottom: foot.hidden ? 0 : foot.offsetHeight || 0 }; },
      render: function () {
        const picture = state.picture;
        marking.textContent = picture ? picture.marking : '';
        projection.textContent = state.projection === 'globe' ? 'Map' : 'Globe';
        projection.setAttribute('aria-pressed', state.projection === 'globe' ? 'true' : 'false');
        projection.disabled = view.renderer !== 'maplibre';
        if (view.renderer !== 'maplibre') projection.title = 'The globe needs the MapLibre map: ' + (view.reason || 'not loaded');
        spin.hidden = !(view.renderer === 'maplibre' && state.projection === 'globe');
        spin.textContent = state.spinning ? 'Stop' : 'Spin';
        spin.setAttribute('aria-pressed', state.spinning ? 'true' : 'false');
        spin.disabled = !state.motion();
        spin.title = state.motion() ? (state.spinning ? 'Stop the globe (any touch on the map stops it too)' : 'Spin the globe slowly; drag it to spin it yourself') : 'Spin is off while motion is off (Calm or reduced motion)';
        const frameInfo = picture && picture.frame;
        const nextMargin = JSON.stringify([state.projection, frameInfo && frameInfo.grid, frameInfo && frameInfo.declination, state.base, Boolean(picture && picture.environment)]);
        if (nextMargin !== marginKey) {
          marginKey = nextMargin;
          while (margin.firstChild) margin.removeChild(margin.firstChild);
          margin.hidden = !frameInfo || state.projection === 'globe';
          if (frameInfo) {
            const words = el('div', 'cop-map-margin-words');
            words.appendChild(el('div', '', 'WGS 84 \u00b7 Grid ' + frameInfo.grid + ' 1 km' + (picture.environment ? ' \u00b7 Contours 20 m, index 100 m' : '')));
            const d = frameInfo.declination;
            if (d && typeof d.degreesEast === 'number') {
              words.appendChild(el('div', '', 'MN ' + declinationWords(d.degreesEast) + ' of GN (fictional)'));
              margin.appendChild(declinationDiagram(d.degreesEast));
              margin.title = String(d.note || '');
            }
            margin.appendChild(words);
          }
        }
        mode.textContent = state.mode === 'valid' ? 'As happened' : 'As known';
        mode.setAttribute('aria-pressed', state.mode === 'known' ? 'true' : 'false');
        // The overlay list and the layer list are rebuilt only when they changed, so a control keeps its focus while the clock moves the map.
        const nextEcoa = JSON.stringify([state.ecoa, ((picture && picture.ecoas) || []).map(function (entry) { return [entry.id, entry.role]; })]);
        if (nextEcoa !== ecoaKey) {
          ecoaKey = nextEcoa;
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
        }
        ecoa.hidden = !(picture && picture.ecoas.length);
        const b = picture && picture.budget;
        budget.textContent = b ? 'Tracks ' + b.shown.toLocaleString('en-US') + ' / ' + b.limit.toLocaleString('en-US') + (b.note ? ' (cut)' : '') : '';
        budget.title = b && b.note ? b.note : 'At most ' + (b ? b.limit : 0) + ' tracks are drawn at once';
        sim.hidden = !(picture && picture.layers.some(function (layer) { return layer.simulated && state.visible[layer.id]; }));
        const items = [];
        const ground = view.ground();
        if (ground.terrain !== 'none') {
          items.push({
            id: MAP_ITEMS.terrain, title: '3D terrain', count: '', on: ground.terrain === 'on', disabled: ground.terrain === 'unavailable', reason: ground.terrainReason || '', group: 'environment',
            note: 'Heights from the terrain pack, raised ' + state.exaggeration + ' times; drag with the right button or Ctrl to tilt.',
            slider: { min: EXAGGERATION.min, max: EXAGGERATION.max, step: EXAGGERATION.step, value: state.exaggeration, label: 'Height', prefix: '×' }
          });
        }
        for (const layer of (picture && picture.layers) || []) {
          if (layer.kind === 'feed' && !layer.count) continue;
          items.push({ id: layer.id, title: layer.title, count: layer.count, on: Boolean(state.visible[layer.id]), sim: Boolean(layer.simulated), owner: layer.owner || '', note: layer.label + (layer.note ? '. ' + layer.note : ''), separate: Boolean(layer.separate), group: drawerApi ? drawerApi.groupOf(layer) : 'picture' });
        }
        if (picture && picture.frame && view.renderer === 'maplibre') items.push({ id: MAP_ITEMS.grid, title: 'Grid (' + picture.frame.grid + ')', count: '', on: state.grid, group: 'environment', note: 'Grid lines every square and every ten, with their numbers.' });
        const groups = drawerApi ? drawerApi.grouped(items) : [];
        if (ground.bases.length > 1) {
          groups.unshift({ id: 'base', title: 'Base map', choice: true, items: BASES.map(function (id) {
            const available = ground.bases.indexOf(id) >= 0;
            return { id: id, title: BASE_TITLES[id], on: state.base === id, disabled: !available, reason: available ? '' : (id === 'imagery' ? 'Imagery needs the WebGL map' + (view.reason ? ': ' + view.reason : '') + '.' : 'Not available here.') };
          }) });
        }
        const nextLayers = JSON.stringify(groups);
        if (drawer && nextLayers !== layerKey) { layerKey = nextLayers; drawer.setGroups(groups); }
        const span = picture && picture.time;
        slider.hidden = !span;
        if (span) {
          range.value = String(Math.round(span.max > span.min ? ((state.time - span.min) / (span.max - span.min)) * 1000 : 1000));
          timeText.textContent = new Date(state.time).toISOString().replace('.000Z', 'Z') + (state.mode === 'known' ? ' (as known)' : '');
        }
        const envWords = environmentNow(state).line;
        envLine.hidden = !envWords;
        if (envLine.textContent !== envWords) envLine.textContent = envWords;
        envLine.title = envWords;
        foot.hidden = slider.hidden && envLine.hidden;
      },
      showCard: function (feature) {
        while (card.firstChild) card.removeChild(card.firstChild);
        card.hidden = !feature;
        if (!feature) return;
        card.appendChild(el('strong', '', feature.properties.name));
        for (const line of feature.properties.card || []) card.appendChild(el('div', '', line));
      },
      notice: function (text) { notice.hidden = !text; notice.textContent = text || ''; },
      destroy: function () { if (drawer) drawer.destroy(); }
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

  /**
   * What the first view fits (owner direction, 0.4.35): the land (the synthetic geography's land and marsh, the terrain pack's coastline), the named
   * places and the units (every point the picture places), with a margin of a tenth of the larger side (at least 3% of the frame) and kept inside the
   * exercise frame. The frame's own bounds when nothing is placed, so an empty scenario still opens on its frame.
   */
  function contentBounds(picture) {
    const frame = picture && picture.frame ? picture.frame.bounds : [-1, -1, 1, 1];
    if (!picture) return frame;
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const take = function (c) {
      if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
        if (!(c[0] >= frame[0] && c[0] <= frame[2] && c[1] >= frame[1] && c[1] <= frame[3])) return;
        box[0] = Math.min(box[0], c[0]); box[1] = Math.min(box[1], c[1]); box[2] = Math.max(box[2], c[0]); box[3] = Math.max(box[3], c[1]);
      } else if (Array.isArray(c)) c.forEach(take);
    };
    for (const g of (picture.geography && picture.geography.features) || []) {
      const p = g.properties || {};
      if (!g.geometry) continue;
      if (p.kind === 'land' || p.kind === 'marsh' || (g.geometry.type === 'Point' && p.name)) take(g.geometry.coordinates);
    }
    const contours = picture.environment && picture.environment.contours;
    for (const c of (contours && contours.features) || []) if (c.properties && c.properties.kind === 'coastline' && c.geometry) take(c.geometry.coordinates);
    for (const feature of picture.features || []) if (feature.geometry && feature.geometry.type === 'Point') take(feature.geometry.coordinates);
    if (!(box[2] > box[0]) || !(box[3] > box[1])) return frame;
    const side = Math.max(box[2] - box[0], box[3] - box[1]);
    const padX = Math.max(side * 0.1, (frame[2] - frame[0]) * 0.03);
    const padY = Math.max(side * 0.1, (frame[3] - frame[1]) * 0.03);
    return [Math.max(frame[0], box[0] - padX), Math.max(frame[1], box[1] - padY), Math.min(frame[2], box[2] + padX), Math.min(frame[3], box[3] + padY)];
  }
  /**
   * The part of the frame the SVG map draws: everything the picture places and every named place, with a margin; the whole frame when empty. Tighter
   * than contentBounds (no land): the SVG map has no zoom to come apart with, so it keeps its names readable this way.
   */
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
        const env = environmentNow(state);
        for (const g of env.terrain.concat(env.weather)) {
          const k = g.properties.kind;
          if (g.geometry.type === 'Polygon') {
            const fill = k === 'hillshade' ? (g.properties.tone === 'light' ? '#ffffff' : '#000000') : WEATHER_COLOURS[k] || C.line;
            root.appendChild(svg('path', { d: pathOf(g.geometry.coordinates[0], true), fill: fill, 'fill-opacity': g.properties.opacity || 0.3, stroke: k === 'rough-sea' ? WEATHER_COLOURS[k] : 'none', 'stroke-dasharray': k === 'rough-sea' ? '4 3' : '', class: 'cop-map-env-' + k }));
          } else root.appendChild(svg('path', { d: pathOf(g.geometry.coordinates, false), fill: 'none', stroke: k === 'wind' ? WEATHER_COLOURS.wind : k === 'coastline' ? C.line : C.contour, 'stroke-width': k === 'wind' ? 1.2 : g.properties.index ? 1.2 : 0.6, class: 'cop-map-env-' + k }));
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
      // The SVG map is 2D: no tiles, no 3D, no spin. Its Topographic base is the pack's hillshade and contours over the land.
      applyGround: function () { renderer.draw(); },
      applyTerrain: function () {},
      addBasemap: function () {},
      spin: function () { return false; },
      look: function () {},
      snapshot: function () { return Promise.resolve(''); },
      terrainHeight: function () { return undefined; },
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

  /** A symbol's affiliation from its SIDC's standard identity: friend, hostile, neutral or unknown (shape and colour of a stacked symbol). */
  function affiliation(sidc) {
    const identity = sidc ? String(sidc)[3] : '';
    if (identity === '5' || identity === '6') return 'H';
    if (identity === '2' || identity === '3') return 'F';
    if (identity === '4') return 'N';
    return 'U';
  }

  /** The exercise frame as a ring and its centre, for the frame line and the marker that rings it on the globe. */
  function frameFeatures(picture) {
    const frame = picture && picture.frame;
    if (!frame) return [];
    const b = frame.bounds;
    return [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]] }, properties: { kind: 'frame' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] }, properties: { kind: 'frame-centre' } }
    ];
  }

  /** Lines of latitude and longitude every 15 degrees: on the globe they show the curve, where the empty ocean alone would not. */
  function graticule() {
    const features = [];
    for (let lon = -180; lon < 180; lon += 15) {
      const line = [];
      for (let lat = -80; lat <= 80; lat += 5) line.push([lon, lat]);
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} });
    }
    for (let lat = -75; lat <= 75; lat += 15) {
      const line = [];
      for (let lon = -180; lon <= 180; lon += 5) line.push([lon, lat]);
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} });
    }
    return { type: 'FeatureCollection', features: features };
  }


  /** The tile sources of a basemap, for the style. */
  function basemapSources(B) {
    const out = {};
    if (!B) return out;
    const raster = function (src) { return { type: 'raster', tiles: [src.tiles], tileSize: 256, minzoom: src.minzoom, maxzoom: src.maxzoom, bounds: src.bounds }; };
    const dem = function (src) { return { type: 'raster-dem', tiles: [src.tiles], tileSize: 256, minzoom: src.minzoom, maxzoom: src.maxzoom, bounds: src.bounds, encoding: 'terrarium' }; };
    if (B.globe.imagery) out['globe-imagery'] = raster(B.globe.imagery);
    if (B.globe.topo) out['globe-topo'] = raster(B.globe.topo);
    if (B.frame.imagery) out['frame-imagery'] = raster(B.frame.imagery);
    if (B.frame.imageryDetail) out['frame-imagery-detail'] = raster(B.frame.imageryDetail);
    // Two height sources from two tile sets, as MapLibre's own 3D example does: the 3D surface (sea at 0 m) and the relief (sea floor included).
    if (B.frame.terrain) out['terrain-dem'] = dem(B.frame.terrain);
    if (B.frame.relief) out['relief-dem'] = dem(B.frame.relief);
    return out;
  }

  /** The tile layers that go just under the style layer `before`, for the sources the basemap has. */
  function rasterLayers(B, before, vis) {
    if (!B) return [];
    const all = [
      ['graticule', B.globe.imagery, { id: 'globe-imagery', type: 'raster', source: 'globe-imagery', paint: { 'raster-resampling': 'linear' } }],
      ['graticule', B.globe.topo, { id: 'globe-topo', type: 'raster', source: 'globe-topo' }],
      ['land', B.frame.imagery, { id: 'frame-imagery', type: 'raster', source: 'frame-imagery' }],
      ['land', B.frame.imageryDetail, { id: 'frame-imagery-detail', type: 'raster', source: 'frame-imagery-detail', minzoom: 10 }],
      ['land', B.frame.relief, { id: 'color-relief', type: 'color-relief', source: 'relief-dem', paint: { 'color-relief-color': ['interpolate', ['linear'], ['elevation']].concat(RELIEF_STOPS), 'color-relief-opacity': 1 } }],
      ['env-hillshade', B.frame.relief, { id: 'hillshade', type: 'hillshade', source: 'relief-dem', paint: { 'hillshade-method': 'multidirectional', 'hillshade-exaggeration': 0.55, 'hillshade-shadow-color': '#3d3324', 'hillshade-highlight-color': '#fffdf5' } }]
    ];
    return all.filter(function (entry) { return entry[0] === before && entry[1]; }).map(function (entry) { return Object.assign({}, entry[2], { layout: vis(entry[2].id) }); });
  }

  /** Which ground layers show for the base and the toggles: the one rule the style starts from and every switch applies. */
  function groundVisibility(state) {
    const out = {};
    for (const base of BASES) for (const id of BASE_LAYERS[base]) out[id] = state.base === base;
    out.hillshade = Boolean(state.visible[ENV_LAYER_IDS.hillshade]) && state.base !== 'plain';
    // The imagery has its rivers and roads in it; Topographic draws the pack's roads and tracks, and the rivers from the ground.
    out['ground-lines'] = state.base !== 'imagery';
    out['contour-labels'] = Boolean(state.visible[ENV_LAYER_IDS.contours]);
    for (const id of ['grid-10', 'grid-1', 'grid-labels-10', 'grid-labels-1']) out[id] = Boolean(state.grid);
    return out;
  }

  function groundLinesFilter(base) {
    return base === 'topo' ? ['all', ['==', ['geometry-type'], 'LineString'], ['!=', ['get', 'kind'], 'road']] : ['==', ['geometry-type'], 'LineString'];
  }

  function seaColour(state) { return state.base === 'imagery' ? IMAGERY_SEA : state.base === 'topo' ? TOPO.sea : state.colours.ocean; }
  function gridColour(state) { return state.base === 'topo' ? TOPO.grid : state.base === 'imagery' ? 'rgba(255,255,255,0.85)' : state.colours.line; }
  function contourLabelColour(state) { return state.base === 'imagery' ? '#ffe9c4' : state.base === 'topo' ? '#7a4f25' : state.colours.label; }

  function mapLibreRenderer(chrome, state, maplibregl, ms, options) {
    const empty = { type: 'FeatureCollection', features: [] };
    const C = state.colours;
    const none = ['literal', ['']];
    const textPaint = function () { return { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.5 }; };
    const hillPaint = function () { return ['match', ['get', 'tone'], 'light', C.hillLight, C.hillShadow]; };
    const contourPaint = function () {
      if (state.base === 'topo') return ['match', ['get', 'kind'], 'coastline', TOPO.coast, TOPO.contour];
      if (state.base === 'imagery') return ['match', ['get', 'kind'], 'coastline', 'rgba(255,255,255,0.55)', 'rgba(255,236,200,0.7)'];
      return ['match', ['get', 'kind'], 'coastline', C.line, C.relief];
    };
    const notCluster = ['!', ['has', 'point_count']];
    const B = state.basemap;
    // Whether a style layer shows for the current base and toggles (the same rule applyGround uses after a switch).
    const shows = function (id) { return groundVisibility(state)[id] !== false; };
    const vis = function (id) { return { visibility: shows(id) ? 'visible' : 'none' }; };
    const map = new maplibregl.Map({
      container: chrome.canvas, attributionControl: false, renderWorldCopies: false, maxPitch: 85, fadeDuration: options.still ? 0 : 300,
      style: {
        version: 8, projection: { type: state.projection === 'globe' ? 'globe' : 'mercator' },
        sky: SKY,
        ...(state.terrain === 'on' && B && B.frame.terrain ? { terrain: { source: 'terrain-dem', exaggeration: state.exaggeration } } : {}),
        sources: {
          ...basemapSources(B), grid: { type: 'geojson', data: empty },
          landcover: { type: 'geojson', data: B && B.frame.landcover ? B.frame.landcover : empty },
          ground: { type: 'geojson', data: empty }, cop: { type: 'geojson', data: empty }, terrain: { type: 'geojson', data: empty }, weather: { type: 'geojson', data: empty },
          // Point symbols on their own source, clustered: at the frame view, units that would cover each other draw as one stacked symbol with a count.
          units: {
            type: 'geojson', data: empty, cluster: true, clusterRadius: CLUSTER_RADIUS, clusterMaxZoom: CLUSTER_MAX_ZOOM,
            clusterProperties: { hostile: ['+', ['case', ['==', ['get', 'aff'], 'H'], 1, 0]], friend: ['+', ['case', ['==', ['get', 'aff'], 'F'], 1, 0]] }
          },
          frame: { type: 'geojson', data: empty }, graticule: { type: 'geojson', data: graticule() }
        },
        layers: [
          { id: 'ocean', type: 'background', paint: { 'background-color': seaColour(state) } },
          // The bases under everything else: the world imagery and the frame's on the Imagery base, the world's and the frame's topographic layers on
          // Topographic, the flat land and marsh on Plain. Only visibility changes when the person switches.
          ...rasterLayers(B, 'graticule', vis),
          { id: 'graticule', type: 'line', source: 'graticule', maxzoom: 6, paint: { 'line-color': C.line, 'line-opacity': 0.18, 'line-width': 0.6 } },
          ...rasterLayers(B, 'land', vis),
          { id: 'land', type: 'fill', source: 'ground', filter: ['==', ['get', 'kind'], 'land'], layout: vis('land'), paint: { 'fill-color': C.land } },
          { id: 'marsh', type: 'fill', source: 'ground', filter: ['==', ['get', 'kind'], 'marsh'], layout: vis('marsh'), paint: { 'fill-color': C.marsh } },
          { id: 'landcover-fill', type: 'fill', source: 'landcover', filter: ['==', ['geometry-type'], 'Polygon'], layout: vis('landcover-fill'), paint: { 'fill-color': ['match', ['get', 'kind'], 'forest', TOPO.forest, 'scrub', TOPO.scrub, 'farmland', TOPO.farmland, 'beach', TOPO.beach, 'rock', TOPO.rock, 'built-up', TOPO['built-up'], 'marsh', TOPO.marsh, TOPO.scrub], 'fill-opacity': ['match', ['get', 'kind'], 'farmland', 0.55, 'built-up', 0.9, 0.75] } },
          { id: 'landcover-built-edge', type: 'line', source: 'landcover', filter: ['==', ['get', 'kind'], 'built-up'], layout: vis('landcover-built-edge'), paint: { 'line-color': '#8c7b6a', 'line-width': 0.8 } },
          ...rasterLayers(B, 'env-hillshade', vis),
          { id: 'env-hillshade', type: 'fill', source: 'terrain', filter: ['==', ['get', 'kind'], 'hillshade'], paint: { 'fill-color': hillPaint(), 'fill-opacity': ['min', 0.85, ['*', RELIEF, ['get', 'opacity']]], 'fill-antialias': false } },
          { id: 'env-contours', type: 'line', source: 'terrain', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': contourPaint(), 'line-opacity': 0.9, 'line-width': ['case', ['==', ['get', 'kind'], 'coastline'], 1.4, ['to-boolean', ['get', 'index']], 1.4, 0.6] } },
          { id: 'ground-lines', type: 'line', source: 'ground', filter: groundLinesFilter(state.base), layout: vis('ground-lines'), paint: { 'line-color': ['match', ['get', 'kind'], 'river', C.river, 'road', C.road, C.contour], 'line-width': ['match', ['get', 'kind'], 'contour', 0.8, 2] } },
          { id: 'landcover-tracks', type: 'line', source: 'landcover', filter: ['==', ['get', 'kind'], 'track'], layout: vis('landcover-tracks'), paint: { 'line-color': TOPO.track, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 14, 1.6], 'line-dasharray': [3, 2] } },
          { id: 'landcover-roads-case', type: 'line', source: 'landcover', filter: ['==', ['get', 'kind'], 'road'], layout: Object.assign({ 'line-cap': 'round', 'line-join': 'round' }, vis('landcover-roads-case')), paint: { 'line-color': TOPO.roadCase, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.4, 14, ['case', ['to-boolean', ['get', 'minor']], 4.5, 6.5]] } },
          { id: 'landcover-roads', type: 'line', source: 'landcover', filter: ['==', ['get', 'kind'], 'road'], layout: Object.assign({ 'line-cap': 'round', 'line-join': 'round' }, vis('landcover-roads')), paint: { 'line-color': ['case', ['to-boolean', ['get', 'minor']], '#f2c14e', TOPO.road], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.8, 14, ['case', ['to-boolean', ['get', 'minor']], 3, 4.5]] } },
          // The grid (KQ): every ten squares from afar, every square close in, with two-digit numbers along the lines.
          { id: 'grid-10', type: 'line', source: 'grid', minzoom: 6, filter: ['==', ['get', 'ten'], true], layout: vis('grid-10'), paint: { 'line-color': gridColour(state), 'line-opacity': 0.75, 'line-width': 1.1 } },
          { id: 'grid-1', type: 'line', source: 'grid', minzoom: 10.5, filter: ['==', ['get', 'ten'], false], layout: vis('grid-1'), paint: { 'line-color': gridColour(state), 'line-opacity': 0.55, 'line-width': 0.6 } },
          { id: 'contour-labels', type: 'symbol', source: 'terrain', minzoom: 10, filter: ['all', ['==', ['get', 'kind'], 'contour'], ['to-boolean', ['get', 'index']]], layout: Object.assign({ 'symbol-placement': 'line', 'text-field': ['concat', ['to-string', ['get', 'height']], ' m'], 'text-font': LABEL_FONT, 'text-size': 10, 'text-max-angle': 25, 'symbol-spacing': 300, 'text-allow-overlap': false, 'text-padding': 2 }, vis('contour-labels')), paint: { 'text-color': contourLabelColour(state), 'text-halo-color': state.base === 'imagery' ? '#1a1a1a' : '#fbf7ee', 'text-halo-width': 1.2 } },
          { id: 'grid-labels-10', type: 'symbol', source: 'grid', minzoom: 7, maxzoom: 11, filter: ['==', ['get', 'ten'], true], layout: Object.assign({ 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-font': LABEL_FONT, 'text-size': 10, 'symbol-spacing': 420, 'text-allow-overlap': false, 'text-padding': 2 }, vis('grid-labels-10')), paint: { 'text-color': gridColour(state), 'text-halo-color': state.base === 'imagery' ? '#0b0b0b' : '#ffffff', 'text-halo-width': 1.4 } },
          { id: 'grid-labels-1', type: 'symbol', source: 'grid', minzoom: 11, layout: Object.assign({ 'symbol-placement': 'line', 'text-field': ['get', 'label'], 'text-font': LABEL_FONT, 'text-size': 10, 'symbol-spacing': 360, 'text-allow-overlap': false, 'text-padding': 2 }, vis('grid-labels-1')), paint: { 'text-color': gridColour(state), 'text-halo-color': state.base === 'imagery' ? '#0b0b0b' : '#ffffff', 'text-halo-width': 1.4 } },
          { id: 'env-weather-cells', type: 'fill', source: 'weather', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['match', ['get', 'kind'], 'fog', WEATHER_COLOURS.fog, 'rain', WEATHER_COLOURS.rain, WEATHER_COLOURS['rough-sea']], 'fill-opacity': ['get', 'opacity'] } },
          { id: 'env-weather-wind', type: 'line', source: 'weather', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': WEATHER_COLOURS.wind, 'line-width': 1.2 } },
          // The exercise frame: a quiet dashed box at the frame view, and on the globe a gold ring round it, so the eye finds it from orbit.
          { id: 'frame-line', type: 'line', source: 'frame', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': COLOURS.star, 'line-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.95, 7, 0.45], 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 2.5, 7, 1.2], 'line-dasharray': [4, 3] } },
          { id: 'frame-marker', type: 'circle', source: 'frame', maxzoom: 5.5, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 14, 'circle-color': 'rgba(255,210,63,0.18)', 'circle-stroke-color': COLOURS.star, 'circle-stroke-width': 3 } },
          { id: 'hilite-lines', type: 'line', source: 'cop', filter: ['in', ['get', 'fid'], none], paint: { 'line-color': COLOURS.star, 'line-width': 7, 'line-opacity': 0.55 } },
          { id: 'areas', type: 'line', source: 'cop', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': ['case', ['==', ['get', 'kind'], 'nai'], COLOURS.adversary, C.line], 'line-width': 2, 'line-dasharray': [3, 2] } },
          { id: 'lines', type: 'line', source: 'cop', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['!', ['to-boolean', ['get', 'anticipated']]], ['!=', ['get', 'kind'], 'axis-adversary']], paint: { 'line-color': C.line, 'line-width': ['case', ['==', ['get', 'kind'], 'axis-main'], 4, 2] } },
          { id: 'lines-dashed', type: 'line', source: 'cop', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['any', ['to-boolean', ['get', 'anticipated']], ['==', ['get', 'kind'], 'axis-adversary']]], paint: { 'line-color': ['case', ['==', ['get', 'kind'], 'axis-adversary'], COLOURS.adversary, C.line], 'line-width': 2, 'line-dasharray': [4, 3] } },
          { id: 'hilite-points', type: 'circle', source: 'units', filter: ['all', notCluster, ['in', ['get', 'fid'], none]], paint: { 'circle-radius': 20, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': COLOURS.star, 'circle-stroke-width': 3 } },
          // Labels, lowest priority first: MapLibre places the layers on top first, so symbols win a crowded spot, then place names, then control measures.
          { id: 'area-labels', type: 'symbol', source: 'cop', filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['has', 'name']], layout: { 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 11, 'text-allow-overlap': false, 'text-padding': 3 }, paint: textPaint() },
          { id: 'line-labels', type: 'symbol', source: 'cop', filter: ['all', ['==', ['geometry-type'], 'LineString'], ['has', 'name']], layout: { 'symbol-placement': 'line-center', 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 11, 'text-allow-overlap': false, 'text-padding': 3, 'text-max-angle': 35 }, paint: textPaint() },
          { id: 'place-labels', type: 'symbol', source: 'ground', minzoom: UNITS_MIN_ZOOM, filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'name']], layout: { 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 11, 'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.5, 'text-allow-overlap': false, 'text-padding': 3 }, paint: textPaint() },
          // A name tries eight places around its symbol and is dropped when none is free; the symbols (the layer above) are placed first, so a name
          // never covers a symbol, its own or another's. A stacked symbol has no name: its count is drawn into it, and its card lists the names.
          {
            id: 'point-labels', type: 'symbol', source: 'units', minzoom: UNITS_MIN_ZOOM, filter: ['all', notCluster, ['has', 'text']],
            layout: {
              'symbol-sort-key': ['get', 'order'], 'text-field': ['get', 'text'], 'text-font': LABEL_FONT, 'text-size': 12,
              'text-variable-anchor': ['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'], 'text-radial-offset': 2.1,
              'text-justify': 'auto', 'text-allow-overlap': false, 'text-ignore-placement': false, 'text-optional': true, 'text-padding': 3
            },
            paint: textPaint()
          },
          {
            // From orbit (the globe) the units give way to the frame's gold ring; they come back as the map closes in.
            id: 'clusters', type: 'symbol', source: 'units', minzoom: UNITS_MIN_ZOOM, filter: ['has', 'point_count'],
            layout: {
              'icon-image': ['concat', 'stack|', ['case', ['>', ['get', 'point_count'], 9], '9+', ['to-string', ['get', 'point_count']]], '|', ['case', ['all', ['>', ['get', 'hostile'], 0], ['>', ['get', 'friend'], 0]], 'M', ['>', ['get', 'hostile'], 0], 'H', ['>', ['get', 'friend'], 0], 'F', 'N']],
              'icon-allow-overlap': true, 'icon-ignore-placement': false, 'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.75, 10, 1]
            }
          },
          {
            id: 'points', type: 'symbol', source: 'units', minzoom: UNITS_MIN_ZOOM, filter: ['all', ['==', ['geometry-type'], 'Point'], notCluster],
            // Smaller at the frame view, full size close in, so the ground under the units stays readable.
            layout: { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': false, 'icon-padding': 1, 'symbol-sort-key': ['get', 'order'], 'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 9, 0.68, 11, 0.85, 13, 1] }
          }
        ]
      }
    });
    if (maplibregl.NavigationControl) map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'bottom-right');
    // Scale bars in kilometres and in nautical miles (the maritime picture), bottom left.
    if (maplibregl.ScaleControl) {
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'nautical' }), 'bottom-left');
    }

    function iconFor(p) {
      if (p.kind === 'decision-point') return 'dp-star';
      if (!p.sidc) return 'point';
      return 'sym|' + p.sidc + '|' + (p.state || 'live');
    }

    /** A stacked symbol: two frames of the cluster's affiliations, offset like a pile of cards, and the count in a badge. */
    function stackImage(id) {
      const parts = id.split('|');
      const count = parts[1];
      const kind = parts[2];
      const ratio = window.devicePixelRatio || 1;
      const size = 44;
      const canvas = document.createElement('canvas');
      canvas.width = size * ratio; canvas.height = size * ratio;
      const c = canvas.getContext('2d');
      c.scale(ratio, ratio);
      const frame = function (x, y, aff) {
        c.beginPath();
        if (aff === 'H') { c.moveTo(x, y - 11); c.lineTo(x + 11, y); c.lineTo(x, y + 11); c.lineTo(x - 11, y); c.closePath(); }
        else if (aff === 'F') { c.rect(x - 13, y - 9, 26, 18); }
        else { c.rect(x - 10, y - 10, 20, 20); }
        c.fillStyle = aff === 'H' ? COLOURS.hostile : aff === 'F' ? COLOURS.friendly : '#d8d8d8';
        c.fill(); c.lineWidth = 1.5; c.strokeStyle = '#000'; c.stroke();
      };
      const back = kind === 'M' ? 'H' : kind, front = kind === 'M' ? 'F' : kind;
      frame(19, 17, back); frame(15, 22, back); frame(21, 26, front);
      c.beginPath(); c.arc(33, 11, 9, 0, Math.PI * 2); c.fillStyle = '#111'; c.fill(); c.lineWidth = 1.5; c.strokeStyle = '#fff'; c.stroke();
      c.fillStyle = '#fff'; c.font = count.length > 1 ? '700 9px sans-serif' : '700 11px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(count, 33, 11.5);
      map.addImage(id, c.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio: ratio });
    }

    /**
     * Every image a symbol may need is added before its data is set: MapLibre asks for a missing image while it lays out a tile, and an image added
     * then can come too late for that tile, which then draws the name with no symbol (seen when zooming in, D-48 of 0.4.34). The stacked symbols are
     * a fixed set (2 to 9 and 9+, by affiliation mix), so they are added once.
     */
    let stacksAdded = false;
    function ensureImages(features) {
      if (!stacksAdded) {
        stacksAdded = true;
        for (const kind of ['H', 'F', 'M', 'N']) for (const count of ['2', '3', '4', '5', '6', '7', '8', '9', '9+']) addImage('stack|' + count + '|' + kind);
      }
      for (const feature of features) addImage(feature.properties.icon);
    }
    function addImage(id) {
      if (!id || (typeof map.hasImage === 'function' && map.hasImage(id))) return;
      try { makeImage(id); } catch (error) { /* MapLibre asks again through styleimagemissing */ }
    }

    map.on('styleimagemissing', function (event) { addImage(event.id); });

    function makeImage(id) {
      if (id.indexOf('stack|') === 0) { stackImage(id); return; }
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
    }

    /** Moves the camera: a flight when motion is allowed, a jump under reduced motion and Calm. */
    function move(camera) {
      if (state.motion() && typeof map.flyTo === 'function') map.flyTo(Object.assign({ duration: 1800, essential: true, curve: 1.5 }, camera));
      else if (typeof map.jumpTo === 'function') map.jumpTo(camera);
    }

    /** Fits the first view: the land, the places and the units with a margin (contentBounds), inside the frame, clear of the floating controls. */
    function fitFrame(animate) {
      const picture = state.picture;
      if (!picture || !picture.frame || typeof map.fitBounds !== 'function') return;
      const b = contentBounds(picture);
      const box = map.getContainer ? map.getContainer() : undefined;
      const side = box ? Math.min(box.clientWidth || 0, box.clientHeight || 0) : 0;
      const sea = Math.max(16, Math.round(side * 0.04));
      const insets = chrome.insets();
      const padding = { top: sea + insets.top, bottom: sea + insets.bottom, left: sea, right: sea };
      map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: padding, animate: Boolean(animate), duration: 1400, essential: true });
    }

    /** The zoom at which the whole globe fills most of the view, so its curve is plain. */
    function globeZoom() {
      const box = map.getContainer ? map.getContainer() : undefined;
      const side = box ? Math.min(box.clientWidth || 0, box.clientHeight || 0) : 0;
      if (!side) return 1.5;
      return Math.max(0.3, Math.min(3, Math.log2((0.85 * side * Math.PI) / 512)));
    }

    map.on('click', function (event) {
      const hits = map.queryRenderedFeatures(event.point, { layers: ['clusters', 'points', 'lines', 'lines-dashed', 'areas'] });
      const hit = hits[0];
      const clusterId = hit && hit.properties && hit.properties.cluster_id;
      if (clusterId === undefined || clusterId === null) { state.select(hit ? hit.properties.fid : undefined); return; }
      // A stacked symbol: its card names what is in it, and the map zooms in until the stack comes apart.
      const source = map.getSource('units');
      const centre = hit.geometry && hit.geometry.coordinates;
      if (source && typeof source.getClusterLeaves === 'function') {
        Promise.resolve(source.getClusterLeaves(clusterId, 50, 0)).then(function (leaves) {
          const names = (leaves || []).map(function (leaf) { return leaf.properties && leaf.properties.text; }).filter(Boolean);
          chrome.showCard({ properties: { name: names.length + ' symbols here', card: names.concat(['Zoom in to see each one.']) } });
        }, function () { /* the card stays as it was */ });
      }
      if (source && typeof source.getClusterExpansionZoom === 'function' && centre) {
        Promise.resolve(source.getClusterExpansionZoom(clusterId)).then(function (zoom) { move({ center: centre, zoom: Math.min(16, zoom + 0.3) }); }, function () { /* stays */ });
      }
    });

    const ready = new Promise(function (resolve) { map.once('load', resolve); });
    let framed = false;
    let lastGrid;
    let shown = [];

    function markHighlight() {
      ready.then(function () {
        const ids = shown.filter(function (feature) { return highlighted(feature, state.highlight); }).map(function (feature) { return feature.id; });
        const list = ['literal', ids.length ? ids : ['']];
        map.setFilter('hilite-lines', ['in', ['get', 'fid'], list]);
        map.setFilter('hilite-points', ['all', notCluster, ['in', ['get', 'fid'], list]]);
      });
    }

    const renderer = {
      kind: 'maplibre', map: map, ready: ready,
      draw: function () {
        ready.then(function () {
          const picture = state.picture;
          if (!picture) return;
          map.getSource('ground').setData(picture.geography || empty);
          const env = environmentNow(state);
          map.getSource('terrain').setData({ type: 'FeatureCollection', features: env.terrain });
          map.getSource('weather').setData({ type: 'FeatureCollection', features: env.weather });
          map.getSource('frame').setData({ type: 'FeatureCollection', features: frameFeatures(picture) });
          const gridKey = JSON.stringify(picture.frame || null);
          if (gridKey !== lastGrid && map.getSource('grid')) { lastGrid = gridKey; map.getSource('grid').setData({ type: 'FeatureCollection', features: gridFeatures(picture.frame) }); }
          shown = drawn(state);
          const points = [];
          const others = [];
          for (const feature of shown) {
            const p = feature.properties;
            const anchor = labelAnchor(feature);
            const out = { type: 'Feature', geometry: feature.geometry, properties: Object.assign({}, p, { fid: feature.id, icon: iconFor(p), text: labelText(p), order: anchor ? 10 - anchor.prio : 10, aff: affiliation(p.sidc), card: undefined }) };
            if (feature.geometry.type === 'Point') points.push(out); else others.push(out);
          }
          ensureImages(points);
          map.getSource('units').setData({ type: 'FeatureCollection', features: points });
          map.getSource('cop').setData({ type: 'FeatureCollection', features: others });
          markHighlight();
          if (!framed && picture.frame) {
            framed = true;
            if (state.projection === 'globe') move({ center: picture.frame.centre, zoom: globeZoom() });
            else {
              fitFrame(false);
              // With 3D terrain on, the first view leans back a little so the relief reads at once.
              if (state.terrain === 'on' && typeof map.jumpTo === 'function') map.jumpTo({ pitch: FIRST_PITCH });
            }
          }
        });
      },
      highlight: markHighlight,
      setColours: function () {
        ready.then(function () {
          map.setPaintProperty('ocean', 'background-color', seaColour(state));
          map.setPaintProperty('land', 'fill-color', C.land);
          map.setPaintProperty('marsh', 'fill-color', C.marsh);
          map.setPaintProperty('ground-lines', 'line-color', ['match', ['get', 'kind'], 'river', C.river, 'road', C.road, C.contour]);
          map.setPaintProperty('env-contours', 'line-color', contourPaint());
          map.setPaintProperty('env-hillshade', 'fill-color', hillPaint());
          map.setPaintProperty('graticule', 'line-color', C.line);
          map.setPaintProperty('lines', 'line-color', C.line);
          for (const id of ['place-labels', 'area-labels', 'line-labels', 'point-labels']) { map.setPaintProperty(id, 'text-color', C.label); map.setPaintProperty(id, 'text-halo-color', C.halo); }
          if (chrome.canvas.style) chrome.canvas.style.background = C.space;
        });
      },
      focus: function () { const canvas = map.getCanvas && map.getCanvas(); if (canvas && typeof canvas.focus === 'function') canvas.focus(); },
      // The globe flies out until the curve is plain, the frame ringed in gold; Map flies back to the frame. Under reduced motion and Calm, it jumps.
      setProjection: function (projection) {
        if (projection !== 'globe') stopSpin();
        ready.then(function () {
          map.setProjection({ type: projection === 'globe' ? 'globe' : 'mercator' });
          const picture = state.picture;
          if (!picture || !picture.frame) return;
          if (projection === 'globe') move({ center: picture.frame.centre, zoom: globeZoom() });
          else fitFrame(state.motion());
        });
        return true;
      },
      fitFrame: function () { ready.then(function () { fitFrame(state.motion()); }); },
      /** Shows the base's layers and applies the toggles (a switch changes visibility only), the sea colour, the grid and contour colours. */
      applyGround: function () {
        ready.then(function () {
          const shown = groundVisibility(state);
          for (const id of Object.keys(shown)) {
            if (typeof map.getLayer === 'function' && !map.getLayer(id)) continue;
            if (typeof map.setLayoutProperty === 'function') map.setLayoutProperty(id, 'visibility', shown[id] ? 'visible' : 'none');
          }
          map.setFilter('ground-lines', groundLinesFilter(state.base));
          map.setPaintProperty('ocean', 'background-color', seaColour(state));
          map.setPaintProperty('env-contours', 'line-color', contourPaint());
          for (const id of ['grid-10', 'grid-1']) map.setPaintProperty(id, 'line-color', gridColour(state));
          for (const id of ['grid-labels-10', 'grid-labels-1']) { map.setPaintProperty(id, 'text-color', gridColour(state)); map.setPaintProperty(id, 'text-halo-color', state.base === 'imagery' ? '#0b0b0b' : '#ffffff'); }
          map.setPaintProperty('contour-labels', 'text-color', contourLabelColour(state));
          map.setPaintProperty('contour-labels', 'text-halo-color', state.base === 'imagery' ? '#1a1a1a' : '#fbf7ee');
        });
      },
      /** Sets or clears the 3D surface. `lean` tilts the view when 3D comes on flat (or flattens it when 3D goes off), moving only when motion is allowed. */
      applyTerrain: function (lean) {
        ready.then(function () {
          const on = state.terrain === 'on' && state.basemap && state.basemap.frame.terrain;
          if (typeof map.setTerrain === 'function') map.setTerrain(on ? { source: 'terrain-dem', exaggeration: state.exaggeration } : null);
          if (!lean || typeof map.getPitch !== 'function') return;
          if (on && map.getPitch() < 10) move({ pitch: FIRST_PITCH });
          else if (!on && map.getPitch() > 0) move({ pitch: 0 });
        });
      },
      /** Starts or stops the globe's slow spin; true when it is spinning after the call. */
      spin: function (on) { if (on) startSpin(); else stopSpin(); return state.spinning; },
      /** Adds a basemap that came after the map started: its sources and layers, then the ground rules. */
      addBasemap: function () {
        ready.then(function () {
          const B = state.basemap;
          if (!B || typeof map.addSource !== 'function' || typeof map.addLayer !== 'function') return;
          const sources = basemapSources(B);
          for (const id of Object.keys(sources)) if (!map.getSource(id)) map.addSource(id, sources[id]);
          const vis = function (id) { return { visibility: groundVisibility(state)[id] !== false ? 'visible' : 'none' }; };
          for (const before of ['graticule', 'land', 'env-hillshade']) for (const layer of rasterLayers(B, before, vis)) if (!map.getLayer(layer.id)) map.addLayer(layer, before);
          if (B.frame.landcover && map.getSource('landcover')) map.getSource('landcover').setData(B.frame.landcover);
          renderer.applyGround();
          renderer.applyTerrain(false);
        });
      },
      /** Moves the camera to a view (centre, zoom, pitch, bearing), a flight when motion is allowed. */
      look: function (camera) { ready.then(function () { move(camera); }); },
      /** A PNG data URL of the map as drawn, taken in the next frame (the drawing buffer is only readable while it is drawn). For the e2e check. */
      snapshot: function () {
        return ready.then(function () {
          return new Promise(function (resolve) {
            map.once('render', function () { try { resolve(map.getCanvas().toDataURL('image/png')); } catch (error) { resolve(''); } });
            if (typeof map.triggerRepaint === 'function') map.triggerRepaint();
          });
        });
      },
      /** The 3D surface's height in metres at a [longitude, latitude], or undefined (no 3D, or not loaded there). For the e2e check. */
      terrainHeight: function (lngLat) {
        if (typeof map.queryTerrainElevation !== 'function' || !(typeof map.getTerrain === 'function' && map.getTerrain())) return undefined;
        const h = map.queryTerrainElevation(lngLat);
        return typeof h === 'number' && isFinite(h) ? h / (state.exaggeration || 1) : undefined;
      },
      destroy: function () { stopSpin(); if (typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', onHidden); map.remove(); }
    };

    // ---- Spin (owner decision, 0.4.35): off until the person presses Spin. One turn in about two minutes, by moving the centre each frame; never
    // while motion() is false; stopped by any input of the person's (our own jumpTo carries no originalEvent), by leaving the globe or zooming in,
    // and when the page is hidden. Dragging the globe spins it too, with MapLibre's own momentum.
    const SPIN_DEGREES_PER_SECOND = 3;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(function () { fn(Date.now()); }, 16); };
    const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
    let spinFrame, spinLast = 0;
    function spinStep(t) {
      spinFrame = undefined;
      if (!state.spinning) return;
      if (!state.motion() || state.projection !== 'globe' || (typeof document !== 'undefined' && document.hidden) || (typeof map.getZoom === 'function' && map.getZoom() > 4)) { stopSpin(); return; }
      const dt = spinLast ? Math.min(0.1, (t - spinLast) / 1000) : 0;
      spinLast = t;
      if (typeof map.getCenter === 'function') {
        const c = map.getCenter();
        map.jumpTo({ center: [((c.lng - SPIN_DEGREES_PER_SECOND * dt + 540) % 360) - 180, c.lat] });
      }
      spinFrame = raf(spinStep);
    }
    function startSpin() {
      if (state.spinning || !state.motion() || state.projection !== 'globe') return;
      state.spinning = true;
      spinLast = 0;
      spinFrame = raf(spinStep);
      chrome.render();
    }
    function stopSpin() {
      const was = state.spinning;
      state.spinning = false;
      if (spinFrame !== undefined) caf(spinFrame);
      spinFrame = undefined;
      if (was) chrome.render();
    }
    for (const type of ['mousedown', 'touchstart', 'wheel', 'dragstart', 'rotatestart', 'pitchstart', 'zoomstart']) map.on(type, function (event) { if (event && event.originalEvent) stopSpin(); });
    const canvasNode = map.getCanvas && map.getCanvas();
    if (canvasNode && typeof canvasNode.addEventListener === 'function') canvasNode.addEventListener('keydown', function () { stopSpin(); });
    const onHidden = function () { if (typeof document !== 'undefined' && document.hidden) stopSpin(); };
    if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onHidden);
    if (chrome.canvas.style) chrome.canvas.style.background = C.space;
    return renderer;
  }

  /** The theme colours a host page may set: only these keys, only colour words or hex, so a page cannot pass anything else into a style. */
  function themeColours(colours) {
    const out = {};
    for (const key of THEME_KEYS) {
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
      colours: Object.assign({}, COLOURS, themeColours(options.colours)), highlight: [],
      // The ground (see "Base maps" above): chosen from the person's saved settings when given, else from what the host's tiles allow.
      basemap: validBasemap(options.basemap), base: 'plain', terrain: 'off', terrainReason: '', exaggeration: EXAGGERATION.start, grid: true, spinning: false,
      rasterHillshade: false, chosen: false
    };
    const saved = options.mapSettings && typeof options.mapSettings === 'object' ? options.mapSettings : {};
    if (typeof saved.exaggeration === 'number' && isFinite(saved.exaggeration)) state.exaggeration = Math.max(EXAGGERATION.min, Math.min(EXAGGERATION.max, Math.round(saved.exaggeration / EXAGGERATION.step) * EXAGGERATION.step));
    if (typeof saved.grid === 'boolean') state.grid = saved.grid;
    // Whether anything may move (the drawer's slide, the globe's flight): the host's own rule when it gives one (the Staff Room's Calm), otherwise not
    // when the host asked for a still map and not under the system's reduced-motion setting.
    const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    state.motion = typeof options.motion === 'function' ? function () { try { return Boolean(options.motion()); } catch (error) { return false; } } : function () { return !options.still && !(reduced && reduced.matches); };
    const view = { renderer: 'svg', reason: undefined };
    const chrome = createChrome(container, state, view, options);
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
          // The ground is settled first, so the style starts on the right base with 3D already set.
          view.renderer = 'maplibre';
          settleGround();
          renderer = mapLibreRenderer(chrome, state, maplibregl, ms, options);
        } catch (error) {
          view.renderer = 'svg';
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

    /** The bases this map can draw now: Imagery needs MapLibre and imagery tiles; Topographic needs MapLibre with tiles, or a terrain pack. */
    function availableBases() {
      const B = state.basemap;
      const out = [];
      if (view.renderer === 'maplibre' && B && (B.globe.imagery || B.frame.imagery)) out.push('imagery');
      if ((view.renderer === 'maplibre' && B && (B.globe.topo || B.frame.relief)) || (state.picture && state.picture.environment)) out.push('topo');
      out.push('plain');
      return out;
    }
    /** The person's settings, for the host to keep (the Staff Room keeps them with the rest of the page's state). */
    function saveSettings() {
      if (options.onMapSettings) options.onMapSettings({ base: state.base, terrain: state.terrain === 'on', exaggeration: state.exaggeration, grid: state.grid });
    }
    /** Sets the hillshade and contour toggles to a base's defaults: off over Imagery, on over Topographic; Plain keeps the host's own. */
    function baseDefaults(base) {
      const picture = state.picture;
      if (!picture) return;
      for (const id of [ENV_LAYER_IDS.hillshade, ENV_LAYER_IDS.contours]) {
        const layer = picture.layers.find(function (entry) { return entry.id === id; });
        if (!layer) continue;
        state.visible[id] = base === 'topo' ? true : base === 'imagery' ? false : Boolean(layer.visible);
      }
    }
    /** Picks the base (and 3D) once tiles or a picture arrive, unless the person already chose. */
    function settleGround() {
      const bases = availableBases();
      const wantedBase = !state.chosen && typeof saved.base === 'string' && bases.indexOf(saved.base) >= 0 ? saved.base : undefined;
      const next = state.chosen && bases.indexOf(state.base) >= 0 ? state.base : wantedBase || bases[0];
      const changed = next !== state.base;
      state.base = next;
      if (changed) baseDefaults(next);
      const B = state.basemap;
      const canTerrain = view.renderer === 'maplibre' && B && B.frame.terrain;
      if (!canTerrain) { state.terrain = 'off'; state.terrainReason = view.renderer !== 'maplibre' && state.picture && state.picture.environment ? '3D terrain needs the WebGL map' + (view.reason ? ': ' + view.reason : '') + '.' : ''; }
      else if (!state.terrainSettled) {
        state.terrainSettled = true;
        const software = softwareRenderer(options);
        if (typeof saved.terrain === 'boolean') state.terrain = saved.terrain ? 'on' : 'off';
        else state.terrain = software ? 'off' : 'on';
        state.terrainReason = software && state.terrain === 'off' ? '3D terrain is off: this computer draws the map without a graphics card. Turn it on if the map stays smooth.' : '';
        state.renderer = software;
      }
      state.rasterHillshade = Boolean(view.renderer === 'maplibre' && B && B.frame.relief && state.base !== 'plain');
      return changed;
    }
    settleGround();

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
      if (first && state.base !== 'plain') baseDefaults(state.base);
      if (state.ecoa && !picture.ecoas.some(function (entry) { return entry.id === state.ecoa; })) state.ecoa = undefined;
      if (settleGround() || first) renderer.applyGround();
      redraw();
    };
    /** The host's checked tile addresses (src/staff/mapTiles.ts); a basemap that comes after the map started is added to it. */
    view.setBasemap = function (basemap) {
      const next = validBasemap(basemap);
      if (JSON.stringify(next) === JSON.stringify(state.basemap)) return;
      state.basemap = next;
      settleGround();
      renderer.addBasemap();
      renderer.applyGround();
      chrome.render();
      redraw();
    };
    /** Switches the base by layer visibility; false when this map cannot draw that base. */
    view.setBase = function (base) {
      if (BASES.indexOf(base) < 0 || availableBases().indexOf(base) < 0) return false;
      state.chosen = true;
      if (base !== state.base) { state.base = base; baseDefaults(base); }
      state.rasterHillshade = Boolean(view.renderer === 'maplibre' && state.basemap && state.basemap.frame.relief && base !== 'plain');
      renderer.applyGround();
      saveSettings();
      chrome.render();
      redraw();
      return true;
    };
    /** Turns 3D terrain on or off; false when there is no 3D here (no height tiles, or the SVG map). */
    view.setTerrain = function (on) {
      if (!(view.renderer === 'maplibre' && state.basemap && state.basemap.frame.terrain)) return false;
      state.terrain = on ? 'on' : 'off';
      state.terrainReason = '';
      renderer.applyTerrain(true);
      saveSettings();
      chrome.render();
      return true;
    };
    /** How many times the heights are raised in 3D: 1 to 3 in quarter steps. */
    view.setExaggeration = function (value) {
      if (typeof value !== 'number' || !isFinite(value)) return;
      state.exaggeration = Math.max(EXAGGERATION.min, Math.min(EXAGGERATION.max, Math.round(value / EXAGGERATION.step) * EXAGGERATION.step));
      renderer.applyTerrain(false);
      saveSettings();
    };
    view.setGrid = function (on) { state.grid = Boolean(on); renderer.applyGround(); saveSettings(); chrome.render(); };
    /** Starts or stops the globe's spin; true when spinning after the call (never on the map, never while motion is off). */
    view.spin = function (on) { const result = renderer.spin(Boolean(on)); chrome.render(); return result; };
    /** What the ground offers now, for the drawer: the bases this map can draw, and 3D on, off, unavailable (with why) or none at all. */
    view.ground = function () {
      const B = state.basemap;
      const terrain = view.renderer === 'maplibre' && B && B.frame.terrain ? state.terrain : (state.picture && state.picture.environment ? 'unavailable' : 'none');
      return { bases: availableBases(), terrain: terrain, terrainReason: state.terrainReason };
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
    /** Puts a host's control (the Staff Room's Map as table and Full map) with the map's own, over the map. */
    view.addTool = function (node) { chrome.addTool(node); };
    /** Back to the whole exercise frame (after the box changed size, for example). */
    view.fitFrame = function () { if (renderer.fitFrame) renderer.fitFrame(); };
    /** Opens or closes the layer drawer; true when it is open after the call. */
    view.layers = function (open) { if (!chrome.drawer) return false; if (open === true) chrome.drawer.open(); else if (open === false) chrome.drawer.close(true); return chrome.drawer.isOpen(); };
    let unsubscribe;
    view.destroy = function () {
      const at = live.indexOf(view);
      if (at >= 0) live.splice(at, 1);
      if (pending) clearTimeout(pending);
      if (unsubscribe) unsubscribe();
      chrome.destroy();
      renderer.destroy();
      if (chrome.root.parentNode) chrome.root.parentNode.removeChild(chrome.root);
    };
    view.state = function () { return { time: state.time, mode: state.mode, projection: state.projection, ecoa: state.ecoa, visible: Object.assign({}, state.visible), drawn: drawn(state).map(function (feature) { return feature.id; }), labels: renderer.lastLabels, base: state.base, terrain: state.terrain, terrainReason: state.terrainReason, exaggeration: state.exaggeration, grid: state.grid, spinning: state.spinning }; };
    /** Moves the camera: { center, zoom, pitch, bearing }, each optional and checked (the SVG map ignores it). */
    view.look = function (camera) {
      if (!camera || typeof camera !== 'object') return;
      const out = {};
      if (Array.isArray(camera.center) && camera.center.length === 2 && camera.center.every(function (n) { return typeof n === 'number' && isFinite(n); })) out.center = [camera.center[0], camera.center[1]];
      for (const key of ['zoom', 'pitch', 'bearing']) if (typeof camera[key] === 'number' && isFinite(camera[key])) out[key] = camera[key];
      renderer.look(out);
    };
    /** A picture of the map as drawn (a PNG data URL; '' on the SVG map), for the real-window check's screenshots. */
    view.snapshot = function () { return renderer.snapshot(); };
    /** For the real-window check (layout probe): the ground's state and the 3D height at a point. */
    view.inspect = function (lngLat) { return Object.assign(view.state(), { renderer: view.renderer, height: lngLat ? renderer.terrainHeight(lngLat) : undefined }); };
    if (options.clock && options.clock.subscribe) unsubscribe = options.clock.subscribe(function (t) { view.setTime(t); });
    // Never wait forever for the map: after 15 seconds the view is returned and the map finishes loading behind it. When the map is ready first, the
    // 15-second timer is cleared, so nothing is left pending after the view is returned (or destroyed).
    if (renderer.kind === 'maplibre') {
      let giveUp;
      const timeout = new Promise(function (resolve) { giveUp = setTimeout(resolve, 15000); });
      try { await Promise.race([renderer.ready, timeout]); } finally { clearTimeout(giveUp); }
    }
    live.push(view);
    chrome.render();
    return view;
  }

  /** The views mounted on this page, for the real-window check's probe (media/shared/layout-probe.js). */
  const live = [];

  window.nearCopMap = { version: 1, mount: mount, views: function () { return live.slice(); }, validBasemap: validBasemap, gridFeatures: gridFeatures, visibleFeatures: visibleFeatures, declutter: declutter, weatherFrameAt: weatherFrameAt, weatherFeatures: weatherFeatures, contentBounds: contentBounds };
})();
